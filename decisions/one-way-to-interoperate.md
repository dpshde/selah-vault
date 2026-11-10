# One way to interoperate

Date: 2026-11-04

## Status

Accepted

## Context

Companion apps (`route.bible`, `Proofs` Web & iOS, and custom tools) need to read and write a person's library without ever handling first-party credentials and without maintaining divergent sync protocols. One narrow, standard authorization and sync contract is far easier to audit, adopt, and evolve than multiple ad-hoc flows.

## Decision

External apps interoperate with Selah Vault one way: **OAuth 2.1 Authorization Code + PKCE (`S256`)** via `/oauth/authorize` (`/connect`) and `/oauth/token` ([SPEC 2](../SPEC.md#2-connecting-an-app-oauth-21--pkce)), paired with the `/v2` event stream (`public/grant-client.js`, [docs/connect.md](../docs/connect.md)):

- `LibraryDO` enforces explicit scopes per event kind (`read`, `passages:write`, `highlights:write`, `notes:write`, `srs:write`) on 90-day revocable `sv2.<userId>.<secret>` tokens.
- `GrantClient` hydrates cold clients from `GET /v2/bootstrap`, pulls incremental updates from `GET /v2/events?after=<seq>`, appends scoped events to `POST /v2/events`, and subscribes to live `poke` notifications over `/v2/ws`.
- `.jsonl` export and import (`/v2/export`, `/v2/import`, `Library.toFile()`) are for user-controlled backup and restore, not app-to-app integration.
- `/save` GET links and in-page WebMCP tools act inside the user's own signed-in browser session as direct user conveniences.

## Consequences

- Every connected web, native iOS, and MCP client shares one standard OAuth 2.1 PKCE handshake and one `/v2` event contract.
- Grants expire automatically after 90 days, cannot erase a library or inspect other grants, and can be revoked immediately by either the app (`POST /oauth/revoke`) or the user (`DELETE /v2/grants/:id`).
