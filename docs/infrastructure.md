# Cloudflare Infrastructure & Bootstrap Guide

Selah Vault v2 runs entirely on Cloudflare Workers, SQLite Durable Objects, D1, R2, and Workers Static Assets, declared in [`cloudflare.config.ts`](../cloudflare.config.ts) and [`wrangler.config.ts`](../wrangler.config.ts).

## 1. Resource Map

| Resource | Name / Binding | Purpose |
|---|---|---|
| Worker | `selah-vault` (`src/worker.ts`) | Edge HTTP router (`/auth/*`, `/oauth/*`, `/v2/*`, `/mcp`, `/yv/*`, `/api/client-error`, `/config.json`) |
| Durable Object | `env.LIBRARY` (`LibraryDO`, SQLite storage) | One isolated SQLite instance per user (`idFromName(userId)`): `events`, materialized tables, `FTS5` search, grant tokens, hibernating `/v2/ws` sockets |
| D1 Database | `env.DB` (`selah-vault-auth`) | Global identity directory (`users`, `passkeys`, `auth_challenges`, `oauth_codes` from `migrations/0001_auth.sql`) |
| R2 Bucket | `env.SNAPSHOTS` (`selah-vault-snapshots`) | Off-DO `.jsonl` library snapshots and disaster recovery exports |
| Static Assets | `env.ASSETS` (`./public`) | Framework-free PWA (`index.html`, `unlock.html`, `connect.html`, `sync.js`, `grant-client.js`, self-hosted fonts, `_headers`) |
| Companion Worker | `selah-jev` (`workers/selah-jev/`) | Optional passage lookup proxy backed by KV namespace `CAPS` (`selah-jev-caps`) and secret `TYPESAFE_API_KEY` |

`cloudflare.config.ts` owns all Worker bindings, observability settings, and `runWorkerFirst` route patterns. When `cf dev` or `cf deploy` builds the bundle, Wrangler reads `wrangler.config.ts` to package `./public` into `env.ASSETS`.

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

Copy the returned `uuid` and `accountId` into `cloudflare.config.ts` (`accountId` and `worker.env.DB`), then apply `migrations/0001_auth.sql` remotely:

```sh
mise run db:migrate:prod
```

### Step 2: Provision the `selah-vault-snapshots` R2 Bucket

```sh
cf r2 bucket create selah-vault-snapshots
```

### Step 3: Configure Worker Secrets

Secrets are stored encrypted in Cloudflare and never committed to git:

| Secret | Required | Used By |
|---|---|---|
| `RESEND_API_KEY` | Production Email OTP | `POST /auth/email/send` sends 6-digit codes via `https://api.resend.com/emails` (`from: Selah Vault <auth@selah.tools>`) |
| `APPLE_CLIENT_ID` | Sign in with Apple | `POST /auth/apple` verifies the `aud` claim on Apple RS256 OIDC `id_token` JWTs |
| `YVP_PUBLIC_APP_KEY` | Optional BSB reader | Served at `GET /config.json` and injected by `GET /yv/*` YouVersion passage proxy |

Set each secret interactively via Wrangler:

```sh
mise exec -- wrangler secret put RESEND_API_KEY --name selah-vault
mise exec -- wrangler secret put APPLE_CLIENT_ID --name selah-vault
mise exec -- wrangler secret put YVP_PUBLIC_APP_KEY --name selah-vault
```

### Step 4: Deploy Worker & Attach Custom Domains

Deploy `selah-vault` (which automatically creates the SQLite `LibraryDO` Durable Object migration on first deploy):

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

`mise run dev` runs `scripts/d1-local.sh` (applying `migrations/0001_auth.sql` into `.wrangler/state`) and starts `cf dev` at `http://localhost:8787` with local SQLite `LibraryDO`, local D1, local R2, and static assets. Optional local secrets go in `.dev.vars` (gitignored):

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

