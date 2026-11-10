# Selah Vault

Bible passages, highlights, outliner notes, and spaced-repetition progress that follow you across devices and apps.

The hosted app and server live at **https://vault.selah.tools** (`sync.selah.tools` routes to the same Worker as an alias).

## Architecture (v2)

- **Per-user SQLite Durable Objects (`LibraryDO`):** Each account owns an isolated SQLite Durable Object holding an append-only event log (`events`), deterministic `(ts, id)` materialized tables (`passages`, `highlights`, `colors`, `blocks`, `srs_cards`), SQLite `FTS5` note search, active grant tokens, and hibernating WebSockets (`/v2/ws`).
- **Zero-hop token routing:** Session and OAuth tokens share the `sv2.<userId>.<secret>` format, routing `/v2/*` and `/mcp` requests straight to `LibraryDO` with zero D1 round-trips.
- **Standard first-party sign-in:** Login on `/unlock.html`, `/connect`, and `/` uses discoverable P-256 WebAuthn passkeys, Sign in with Apple, or a 6-digit email code backed by the `selah-vault-auth` D1 directory.
- **OAuth 2.1 + PKCE (`S256`):** Connected apps (`route.bible`, `Proofs` Web & iOS, and MCP assistants) request scoped 90-day tokens (`read`, `passages:write`, `highlights:write`, `notes:write`, `srs:write`) via `/oauth/authorize` (`/connect`) and `/oauth/token`.

## Documentation & Key Files

- [SPEC.md](SPEC.md): Selah Vault v2 protocol specification, event envelope, and projector rules.
- [docs/quickstart.md](docs/quickstart.md): Build a v2 client against `/v2/bootstrap`, `/v2/events`, and `/v2/ws`.
- [docs/connect.md](docs/connect.md): Connect an app via OAuth 2.1 + PKCE using `public/grant-client.js`.
- [docs/infrastructure.md](docs/infrastructure.md): Cloudflare resource map (`LibraryDO`, D1, R2, Static Assets, `selah-jev`) and fresh-account bootstrap.
- [docs/cicd.md](docs/cicd.md): `mise.toml` task runner, CI verification gates, and GitHub Actions `production` deployment setup.
- [docs/production-rollout.md](docs/production-rollout.md): Phased v2 cutover runbook, `.jsonl` backup conversion, connected-app rollout, and rollback plan.
- [docs/observability.md](docs/observability.md): Redacted Workers Logs, Traces, Issues, and browser error reporting.
- [decisions/README.md](decisions/README.md): Architecture decision records (Nygard format).
- `public/sync.js`: Local-first `Library` SDK (event outbox, `(ts, id)` projector, `/v2/bootstrap` hydration, incremental `/v2/events`, live `/v2/ws` pokes, `.jsonl` backups).
- `public/grant-client.js` & `public/grants.js`: OAuth 2.1 + PKCE client SDK and scope definitions.
- `public/passage.js`, `public/refs.js`, `public/ranges.js`: Reference parsing ([grab-bcv](https://github.com/dpshde/grab-bcv)), canonical USFM ordering, and contiguous highlight range grouping.
- `src/`: Cloudflare Worker (`selah-vault`), D1 auth directory, `LibraryDO` SQLite engine, and `/mcp` Streamable HTTP server.

## Connect an AI Assistant (MCP)

Selah Vault serves a remote MCP server (Streamable HTTP) at `https://vault.selah.tools/mcp` authenticated with standard OAuth 2.1 Bearer tokens (`sv2.<userId>.<secret>`). Unauthenticated requests return `401` with `WWW-Authenticate` pointing to `/.well-known/oauth-authorization-server` so OAuth-capable MCP clients discover authorization automatically.

```json
{
  "mcpServers": {
    "selah-vault": {
      "url": "https://vault.selah.tools/mcp",
      "headers": { "Authorization": "Bearer sv2.u_xxxx.yyyy" }
    }
  }
}
```

Tools include `list_highlights`, `find_highlights`, `add_highlight`, `set_highlight_color`, `delete_highlight`, `list_passages`, `save_passage`, `remove_passage`, `search_notes`, `list_colors`, `get_library_info`, and `get_passage_link`.

## Develop, Check & Deploy

All local and CI workflows run through [`mise`](https://mise.jdx.dev/) (`mise.toml`):

```sh
mise install            # install pinned bun, node, and cf
mise run install        # bun install --frozen-lockfile
mise run dev            # migrate local D1 + start cf dev at http://localhost:8787
mise run check          # hygiene + typecheck (tsrs & tsc) + test + Worker dry-runs
mise run deploy         # check -> db:migrate:prod -> cf deploy -> verify live assets
```
