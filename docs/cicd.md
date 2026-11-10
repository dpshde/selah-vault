# CI/CD & Task Runner Architecture

Selah Vault uses [`mise`](https://mise.jdx.dev/) ([`mise.toml`](../mise.toml)) as the single task runner across developer machines and GitHub Actions. Pinning `bun = "1.4.2"`, `node = "22.23.3"`, and `"npm:cf" = "1.0.0-beta.12"` in `mise.toml` guarantees identical tool versions locally and in CI.

## 1. Unified `mise` Tasks

| Command | Action |
|---|---|
| `mise run install` | `bun install --frozen-lockfile` |
| `mise run hygiene` | Runs `scripts/verify-repo.ts` (D1 id not placeholder / not live v1 prod id, zero legacy identifiers, `SCOPES` SVG icons in `connect.js`, valid JSON manifests/schemas, complete ADR index) |
| `mise run typecheck` | Runs both `tsrs --noEmit -p tsconfig.json` and `tsc --noEmit` |
| `mise run test` | Executes the full Bun test suite (`bun test` across `LibraryDO`, projector, OAuth 2.1, WebAuthn, MCP, CSP/look, and client SDK) |
| `mise run dry-run` | Bundles and validates `selah-vault` + `./public` assets via `cf deploy --dry-run` |
| `mise run jev:dry-run` | Bundles and validates `workers/selah-jev` via `wrangler deploy --dry-run` |
| `mise run check` | Runs `hygiene`, `typecheck`, `test`, `dry-run`, and `jev:dry-run` in sequence |
| `mise run db:migrate:local` | Applies `migrations/` to local `.wrangler/state` via `scripts/d1-local.sh` |
| `mise run db:migrate:prod` | Applies `migrations/` via `scripts/d1-migrate-prod.sh` using the D1 **id** from `src/d1-ids.ts` (`cf` requires id; no `--remote`) |
| `mise run verify` | Runs `scripts/verify-assets.ts https://vault.selah.tools` to confirm live asset hashes and security headers |
| `mise run deploy` | Runs `check` -> `db:migrate:prod` -> `cf deploy` -> `verify` |

## 2. Continuous Integration (`.github/workflows/ci.yml`)

Triggered on every `push` to `main` and every `pull_request` (with per-branch concurrency cancellation so stale PR runs stop immediately). Requires **zero secrets**:

1. Installs `bun`, `node`, and `cf` via `jdx/mise-action@v2` with tool and `~/.bun/install/cache` caching.
2. Runs `mise run install`.
3. Executes all five verification gates explicitly so GitHub checks pinpoint any failure step:
   - `mise run hygiene`
   - `mise run typecheck`
   - `mise run test`
   - `mise run dry-run`
   - `mise run jev:dry-run`

## 3. Production Deployment (`.github/workflows/deploy.yml`)

Triggered manually via `workflow_dispatch`, or automatically on `push` to `main` when the repository or environment variable `ENABLE_AUTO_DEPLOY` is set to `'true'`. Concurrent production deploys queue without cancelling in-flight runs (`cancel-in-progress: false`).

### GitHub Environment Setup (`production`)

1. In GitHub -> **Settings -> Environments**, create an environment named **`production`** (optionally add required reviewers and restrict deployment branches to `main`).
2. Add two Environment Secrets to `production`:
   - `CLOUDFLARE_ACCOUNT_ID`: Cloudflare account ID (`91ff2c2b757414041aeaa00896a8a43f`)
   - `CLOUDFLARE_API_TOKEN`: Scoped Cloudflare API token (below)
3. *(Optional)* Add Environment Variable `ENABLE_AUTO_DEPLOY` = `true` to deploy automatically on merges to `main`, or leave unset to require manual **Actions -> Deploy -> Run workflow**.

### Minimal-Privilege Cloudflare API Token

Create a custom API token in Cloudflare Dashboard -> **My Profile -> API Tokens -> Create Custom Token** restricted to the target account with only these four permissions:

- **Account -> Workers Scripts -> Edit** (upload `selah-vault` Worker, Static Assets, and `LibraryDO` bindings)
- **Account -> D1 -> Edit** (apply `migrations/` to `selah-vault-auth`)
- **Account -> Account Settings -> Read** (account resolution during `cf` / `wrangler` deploy)

### Deployment Execution Order

1. `mise run install` — deterministic dependency install from `bun.lock`
2. `mise run check` — full pre-deploy gate (`hygiene`, `typecheck`, `test`, `dry-run`, `jev:dry-run`)
3. `mise run db:migrate:prod` — idempotent forward SQL migrations on `selah-vault-auth`
4. `cf deploy` — atomic Worker + Durable Object + Static Assets rollout
5. `mise run verify` — post-deploy HTTP verification of `https://vault.selah.tools` assets and headers
