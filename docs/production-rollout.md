# Production Rollout Runbook: Cutover to Selah Vault v2

Step-by-step operational runbook for cutting over `vault.selah.tools` and `sync.selah.tools` from the legacy v1 deployment to the `selah-vault` v2 Worker (`LibraryDO` + `selah-vault-auth` D1 + `selah-vault-snapshots` R2) with zero data loss and a <30-second rollback path.

---

## Phase 0: Pre-Cutover Backup & v2 `.jsonl` Conversion

Before changing any DNS or custom-domain routing, export a full `.jsonl` backup from the open v1 browser session (**Menu -> Sync -> Export `.jsonl`**) and convert its record-shaped lines (`kind: "highlight" | "note" | "color" | "passage" | "library"`) into clean v2 `VaultEvent` lines:

```sh
bun scripts/convert-v1-backup.ts ~/Downloads/vault-v1-backup.jsonl /tmp/vault-v2-ready.jsonl
head -n 3 /tmp/vault-v2-ready.jsonl
```

Verify line 1 contains `{"selah-vault":2,...}` and subsequent lines contain `ev_...` IDs (`highlight.set`, `color.set`, `note.block.set`, `library.renamed`). Keep both `vault-v1-backup.jsonl` and `/tmp/vault-v2-ready.jsonl` until Phase 4 completes (`Library.merge()` also accepts unconverted record lines directly if imported through the UI).

---

## Phase 1: Provision Infrastructure & Staging Smoke Test (`workers.dev`)

Provision v2 resources alongside the live v1 Worker without touching `vault.selah.tools`:

```sh
# 1. Create D1 auth directory & R2 snapshot bucket (skip if already created)
cf d1 create selah-vault-auth
# Confirm database id in cloudflare.config.ts matches, then migrate:
mise run db:migrate:prod
cf r2 bucket create selah-vault-snapshots

# 2. Configure production secrets on selah-vault
mise exec -- wrangler secret put RESEND_API_KEY --name selah-vault
mise exec -- wrangler secret put APPLE_CLIENT_ID --name selah-vault
mise exec -- wrangler secret put YVP_PUBLIC_APP_KEY --name selah-vault

# 3. Validate all gates and deploy to selah-vault.<subdomain>.workers.dev
mise run check
cf deploy
```

Run staging smoke tests against `https://selah-vault.dpshade.workers.dev`:

```sh
bun scripts/verify-assets.ts https://selah-vault.dpshade.workers.dev
curl -sf https://selah-vault.dpshade.workers.dev/.well-known/oauth-authorization-server | jq .
```

Open `https://selah-vault.dpshade.workers.dev/unlock.html` in a private window, register a test passkey or request an Email OTP code, create a test highlight, refresh to confirm `GET /v2/bootstrap` hydration, then erase the staging test library from **Menu -> Sync -> Erase library**.

---

## Phase 2: Custom Domain Cutover & Backup Import

Move custom domains from the legacy v1 Worker to `selah-vault`:

1. In Cloudflare Dashboard -> **Workers & Pages -> `<legacy-v1-worker>` -> Settings -> Domains & Routes**, detach `vault.selah.tools` and `sync.selah.tools`.
2. Immediately attach both `vault.selah.tools` and `sync.selah.tools` under **Workers & Pages -> `selah-vault` -> Settings -> Domains & Routes -> Add -> Custom Domain**.
3. Verify live assets, CSP, and OAuth metadata on the production domain:

```sh
mise run verify
curl -sf https://vault.selah.tools/.well-known/oauth-authorization-server | jq .
```

4. Sign in at `https://vault.selah.tools/unlock.html` (registering primary WebAuthn passkeys on macOS/iOS plus Apple/Email recovery), then import `/tmp/vault-v2-ready.jsonl` via **Menu -> Sync -> Import `.jsonl`** (or `POST /v2/import` with your session token) and confirm highlight, color, and note counts match Phase 0.

---

## Phase 3: Connected App Rollout (`Proofs` Web, `Proofs` iOS, `route.bible`)

All allowlisted client origins and custom schemes are pre-configured in `public/grants.js` and `src/clients.ts`:

1. **`Proofs` Web (`https://proofs.selah.tools` & `https://proofs.dpshade.workers.dev`):**
   - Deploy the OAuth 2.1 + PKCE `GrantClient` build (`scope: "read passages:write notes:write srs:write"`).
   - Click **Connect Selah Vault**, approve on `https://vault.selah.tools/connect`, and verify `GET /v2/bootstrap`, `POST /v2/events` (`srs.reviewed`), and `/v2/ws` real-time pokes.
2. **`Proofs` iOS (TestFlight):**
   - Ship the TestFlight build using `ASWebAuthenticationSession` with `client_id=proofs-ios` and `redirect_uri=proofs://oauth/callback`.
   - Complete PKCE `S256` code exchange against `POST https://vault.selah.tools/oauth/token` and verify offline review sync into `LibraryDO`.
3. **`route.bible` (`https://route.bible` & preview Worker):**
   - Deploy the updated `GrantClient` (`client_id=route.bible`, `scope: "read highlights:write"`).
   - Connect once via `/oauth/authorize` and verify highlight overlays and range writes (`highlight.set` / `highlight.removed`) sync live between `route.bible` and `vault.selah.tools`.

---

## Phase 4: 14-Day Soak, Legacy Retirement & Rollback Plan

### Emergency Rollback (<30 seconds)

During the 14-day soak window, `<legacy-v1-worker>` and its D1 database remain untouched in Cloudflare:

1. In Cloudflare Dashboard -> **Workers & Pages**, detach `vault.selah.tools` and `sync.selah.tools` from `selah-vault` and re-attach them to `<legacy-v1-worker>` (propagate time: <30 seconds at the Cloudflare edge).
2. Revert connected app deployments if needed; local browser state and Phase 0 `.jsonl` backups remain intact.

### Decommissioning After 14 Days

Once `selah-vault`, `Proofs`, and `route.bible` have run cleanly in production for 14 days with zero issues in Cloudflare Workers Observability:

```sh
# Export one final archival snapshot of legacy D1 if desired, then delete legacy resources:
cf d1 export <legacy-v1-db> --remote --output ~/Backups/legacy-v1-final.sql
mise exec -- wrangler delete --name <legacy-v1-worker>
cf d1 delete <legacy-v1-db>
```

