# Cloudflare Infrastructure & Bootstrap Guide

Selah Vault v2 runs entirely on Cloudflare Workers, SQLite Durable Objects, D1, and Workers Static Assets, declared in [`cloudflare.config.ts`](../cloudflare.config.ts) and [`wrangler.config.ts`](../wrangler.config.ts).

## 1. Resource Map

| Resource | Name / Binding | Purpose |
|---|---|---|
| Worker | `selah-vault` (`src/worker.ts`) | Edge HTTP router (`/auth/*`, `/oauth/*`, `/v2/*`, `/mcp`, `/yv/*`, `/api/client-error`, `/config.json`) |
| Durable Object | `env.LIBRARY` (`LibraryDO`, SQLite storage) | One isolated SQLite instance per user (`idFromName(userId)`): `events`, materialized tables, `FTS5` search, grant tokens, hibernating `/v2/ws` sockets |
| D1 Database | `env.DB` (`selah-vault-auth`) | Global identity directory (`users`, `passkeys`, `auth_challenges`, `oauth_codes`, `rate_limits` from `migrations/`) |
| Static Assets | `env.ASSETS` (`./public`) | Framework-free PWA (`index.html`, `unlock.html`, `connect.html`, `sync.js`, `grant-client.js`, self-hosted fonts, `_headers`) |
| Companion Worker | `selah-jev` (`workers/selah-jev/`) | Optional passage lookup proxy backed by KV namespace `CAPS` (`selah-jev-caps`) and secret `TYPESAFE_API_KEY` |

`cloudflare.config.ts` owns all Worker bindings, observability settings, and `runWorkerFirst` route patterns. When `cf dev` or `cf deploy` builds the bundle, Wrangler reads `wrangler.config.ts` to package `./public` into `env.ASSETS`.

The D1 id lives in [`src/d1-ids.ts`](../src/d1-ids.ts). Hygiene fails if that id is still the unmet placeholder or the forbidden live v1 prod id. `mise run db:migrate:prod` applies migrations with that **id** (`cf d1 migrations apply` no longer accepts a database name or `--remote`).

## 2. Fresh Cloudflare Account Bootstrap

Install the pinned toolchain first (`bun`, `node`, and `cf` `1.0.0-beta.12`):

```sh
mise install
mise run install
cf login
```

### Step 1: Provision the `selah-vault-auth` D1 Database

```sh
cf d1 create selah-vault-auth
```

Copy the returned `uuid` into both `src/d1-ids.ts` and `cloudflare.config.ts` as `SELAH_VAULT_AUTH_D1_ID` (replace the placeholder in each). Confirm `accountId` in `cloudflare.config.ts`, then apply migrations remotely **by that id**:

```sh
mise run db:migrate:prod
```

### Step 2: Configure Worker Secrets

Secrets are stored encrypted in Cloudflare and never committed to git:

| Secret | Required | Used By |
|---|---|---|
| `RESEND_API_KEY` | Production Email OTP | `POST /auth/email/send` sends 6-digit codes via `https://api.resend.com/emails` (`from: Selah Vault <auth@selah.tools>`) |
| `APPLE_CLIENT_ID` | Sign in with Apple | `POST /auth/apple` verifies the `aud` claim on Apple RS256 OIDC `id_token` JWTs (sign-in is disabled when unset) |
| `YVP_PUBLIC_APP_KEY` | Optional BSB reader | Served at `GET /config.json` and injected by `GET /yv/*` YouVersion passage proxy |

Set each secret interactively via Wrangler:

```sh
mise exec -- wrangler secret put RESEND_API_KEY --name selah-vault
mise exec -- wrangler secret put APPLE_CLIENT_ID --name selah-vault
mise exec -- wrangler secret put YVP_PUBLIC_APP_KEY --name selah-vault
```

### Step 3: Deploy Worker & Attach Custom Domains

Deploy `selah-vault` (which automatically creates the SQLite `LibraryDO` Durable Object migration on first deploy) to `workers.dev` first. Attach custom domains only after `route.bible` and MCP clients work on v2 — see [`production-rollout.md`](./production-rollout.md).

```sh
mise run check
cf deploy
```

Attach custom domains on the `selah.tools` Cloudflare zone (Cloudflare Dashboard -> Workers & Pages -> `selah-vault` -> Settings -> Domains & Routes -> Add -> Custom Domain, or via `cf`):

- `vault.selah.tools` — primary web app, OAuth 2.1 authorization server (`/connect`, `/oauth/*`), `/v2/*`, and `/mcp`
- `sync.selah.tools` — alias domain routed to `selah-vault` for API/WebSocket clients

Verify asset hashes, CSP, and security headers once DNS and edge certificates are active:

```sh
mise run verify
```

## 3. Local Development (`mise run dev`)

Local development requires zero cloud credentials:

```sh
mise run dev
```

`mise run dev` runs `scripts/d1-local.sh` (applying `migrations/` into `.wrangler/state` by the D1 id from `src/d1-ids.ts`) and starts `cf dev` at `http://localhost:8787` with local SQLite `LibraryDO`, local D1, and static assets. Optional local secrets go in `.dev.vars` (gitignored):

```ini
YVP_PUBLIC_APP_KEY=your_youversion_key
APPLE_CLIENT_ID=tools.selah.vault
RESEND_API_KEY=re_...
```

## 4. Companion Worker: `selah-jev`

`workers/selah-jev` is a standalone Worker that proxies passage lookups with daily spend and rate caps stored in Workers KV:

```sh
mise exec -- wrangler kv namespace create selah-jev-caps
# Update id and preview_id in workers/selah-jev/wrangler.toml
mise exec -- wrangler secret put TYPESAFE_API_KEY -c workers/selah-jev/wrangler.toml
mise exec -- wrangler deploy -c workers/selah-jev/wrangler.toml
```
