# Production Rollout Runbook: Cutover to Selah Vault v2

Step-by-step operational runbook for cutting over `vault.selah.tools` and `sync.selah.tools` from the legacy v1 deployment to the `selah-vault` v2 Worker (`LibraryDO` + `selah-vault-auth` D1) with zero data loss and a <30-second rollback path.

**Do not move custom domains in Phase 2.** Domains stay on the legacy v1 Worker (including `sync.selah.tools` `/v1` sync) until `route.bible` and MCP clients work against v2 on `workers.dev`.

---

## Phase 0: Pre-Cutover Backup & v2 `.jsonl` Conversion

Before changing any DNS or custom-domain routing, export a full `.jsonl` backup from the open v1 browser session (**Menu -> Sync -> Export `.jsonl`**) and convert its record-shaped lines (`kind: "highlight" | "note" | "color" | "passage" | "library"`) into clean v2 `VaultEvent` lines:

```sh
bun scripts/convert-v1-backup.ts ~/Downloads/vault-v1-backup.jsonl /tmp/vault-v2-ready.jsonl
head -n 3 /tmp/vault-v2-ready.jsonl
```

Verify line 1 contains `{"selah-vault":2,...}` and subsequent lines contain `ev_...` IDs (`highlight.set`, `color.set`, `note.block.set`, `library.renamed`). Keep both `vault-v1-backup.jsonl` and `/tmp/vault-v2-ready.jsonl` until Phase 5 completes (`Library.merge()` also accepts unconverted record lines directly if imported through the UI).

**Conversion loss:** v2 stores one highlight color per verse. If a v1 verse has multiple `highlights[]` colors, only the newest color is kept; older colors on that verse are dropped (quotes are still concatenated).

---

## Phase 1: Provision Infrastructure & Staging Smoke Test (`workers.dev`)

Provision v2 resources alongside the live v1 Worker without touching `vault.selah.tools` or `sync.selah.tools`:

```sh
# 1. Create D1 auth directory (skip if already created)
cf d1 create selah-vault-auth
# Put the returned uuid into src/d1-ids.ts AND cloudflare.config.ts (SELAH_VAULT_AUTH_D1_ID), then:
mise run hygiene   # must pass once the real id replaces the placeholder
mise run db:migrate:prod   # targets selah-vault-auth by name, never by uuid

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

## Phase 2: Client Soak on `workers.dev` (Domains Stay on Legacy)

**Domains do not move in this phase.** The legacy v1 Worker continues to serve `vault.selah.tools` and `sync.selah.tools` (including `sync.selah.tools/v1`) for the entire soak while clients prove they work against v2.

1. Sign in at `https://selah-vault.dpshade.workers.dev/unlock.html`, then import `/tmp/vault-v2-ready.jsonl` via **Menu -> Sync -> Import `.jsonl`** (or `POST /v2/import` with a bearer token) and confirm highlight, color, and note counts match Phase 0.
2. Point staging / preview builds of connected apps at the v2 `workers.dev` origin:
   - **`route.bible`** preview: connect via OAuth (`client_id=route.bible`, `scope: "read highlights:write"`) against `https://selah-vault.dpshade.workers.dev` and verify highlight overlays + range writes.
   - **MCP clients**: authorize against the v2 OAuth metadata on `workers.dev` and exercise `/mcp` tools against the imported library.
   - **`Proofs` Web / iOS** (optional in this phase): same OAuth 2.1 + PKCE flow against `workers.dev`.
3. Keep the legacy v1 Worker on `sync.selah.tools` so existing `/v1` clients stay healthy while v2 soaks on `workers.dev`.
4. Do **not** detach or re-attach `vault.selah.tools` / `sync.selah.tools` until Phase 4.

---

## Phase 3: Connected App Sign-Off Checklist

All allowlisted client origins and custom schemes are pre-configured in `public/grants.js` and `src/clients.ts`. Confirm each path works on v2 (`workers.dev` first, then production after Phase 4):

1. **`Proofs` Web (`https://proofs.selah.tools` & `https://proofs.dpshade.workers.dev`):**
   - Deploy the OAuth 2.1 + PKCE `GrantClient` build (`scope: "read passages:write notes:write srs:write"`).
   - Click **Connect Selah Vault**, approve on `/connect`, and verify `GET /v2/bootstrap`, `POST /v2/events` (`srs.reviewed`), and `/v2/ws` real-time pokes.
2. **`Proofs` iOS (TestFlight):**
   - Ship the TestFlight build using `ASWebAuthenticationSession` with `client_id=proofs-ios` and `redirect_uri=proofs://oauth/callback`.
   - Complete PKCE `S256` code exchange against `POST …/oauth/token` and verify offline review sync into `LibraryDO`.
3. **`route.bible` (`https://route.bible` & preview Worker):**
   - Deploy the updated `GrantClient` (`client_id=route.bible`, `scope: "read highlights:write"`).
   - Connect once via `/oauth/authorize` and verify highlight overlays and range writes (`highlight.set` / `highlight.removed`) sync live with Vault.

Phase 4 (domain cutover) is blocked until `route.bible` and MCP clients pass this checklist against v2.

---

## Phase 4: Custom Domain Cutover

Only after Phase 2–3 succeed on `workers.dev`:

1. In Cloudflare Dashboard -> **Workers & Pages -> `<legacy-v1-worker>` -> Settings -> Domains & Routes**, detach `vault.selah.tools` and `sync.selah.tools`.
2. Immediately attach both under **Workers & Pages -> `selah-vault` -> Settings -> Domains & Routes -> Add -> Custom Domain**.
3. Verify live assets, CSP, and OAuth metadata on the production domain:

```sh
mise run verify
curl -sf https://vault.selah.tools/.well-known/oauth-authorization-server | jq .
```

4. Re-check `route.bible` and MCP against `https://vault.selah.tools` (not `workers.dev`).

---

## Phase 5: 14-Day Soak, Legacy Retirement & Rollback Plan

### Emergency Rollback (<30 seconds)

During the 14-day soak window, `<legacy-v1-worker>` and its D1 database remain untouched in Cloudflare:

1. In Cloudflare Dashboard -> **Workers & Pages**, detach `vault.selah.tools` and `sync.selah.tools` from `selah-vault` and re-attach them to `<legacy-v1-worker>` (propagate time: <30 seconds at the Cloudflare edge).
2. Revert connected app deployments if needed; local browser state and Phase 0 `.jsonl` backups remain intact.

### Decommissioning After 14 Days

Once `selah-vault`, `Proofs`, and `route.bible` have run cleanly in production for 14 days with zero issues in Cloudflare Workers Observability:

```sh
# Export one final archival snapshot of the legacy v1 D1, then delete ONLY that database
# and the legacy Worker. Never delete selah-vault-auth (the v2 auth directory).
#
# The live v1 prod D1 id (forbidden as a v2 binding) is the only allowed delete target:
cf d1 export 4e60d989-d13b-4884-ad5c-1366f4c73f00 --remote --output ~/Backups/legacy-v1-final.sql
mise exec -- wrangler delete --name <legacy-v1-worker>
cf d1 delete 4e60d989-d13b-4884-ad5c-1366f4c73f00
# DO NOT run: cf d1 delete selah-vault-auth
```
