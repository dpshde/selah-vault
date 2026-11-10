# Isolate each library in a SQLite Durable Object

Date: 2026-11-10

## Status

Accepted

## Context

A shared Bible library serves one person's devices and connected apps (`route.bible`, `Proofs`, and MCP tools). Storing every user's items, notes, and spaced-repetition logs in a single multi-tenant D1 database couples unrelated users' traffic, serializes writes through one global SQLite instance, prevents per-user full-text search indexes without tenant-id filter risk, and cannot hold live WebSocket connections next to the data they watch.

At the same time, sign-in challenges, WebAuthn credential lookup by `credential_id`, email lookup, and short-lived OAuth authorization codes are cross-user directory queries before a `userId` is known.

## Decision

Split storage along the tenant boundary:

1. **One SQLite Durable Object per user (`LibraryDO`):** Each `userId` (`u_<22 base64url chars>`) maps deterministically to `env.LIBRARY.idFromName(userId)`. `LibraryDO` stores that user's append-only `events` table, `event_tags`, materialized views (`passages`, `highlights`, `colors`, `blocks`, `srs_cards`, `srs_daily_stats`), SQLite `FTS5` note index (`blocks_fts`), active session/OAuth `tokens`, and hibernating WebSockets (`/v2/ws`).
2. **Portable `SqlAdapter` engine (`src/library.ts`, `src/projector.ts`):** `LibraryEngine` talks to a synchronous SQLite interface so Cloudflare `ctx.storage.sql` in production and `bun:sqlite` in tests execute the exact same SQL schema and transactions.
3. **Global D1 auth directory (`selah-vault-auth`):** D1 holds only cross-user identity tables (`users`, `passkeys`, `auth_challenges`, `oauth_codes`, `rate_limits`) defined in `migrations/`. No unused R2 snapshot binding is declared until a concrete backup pipeline needs it.

## Consequences

- Each user's reads, writes, `FTS5` queries, and `/v2/ws` broadcast pokes execute in-memory against local SQLite inside their single-threaded `LibraryDO`, with strict physical tenant isolation.
- Deleting an account (`DELETE /v2/library`) wipes `LibraryDO` via `ctx.storage.deleteAll()` and removes the user's rows from `selah-vault-auth` in one D1 batch.
- Idle libraries consume zero compute thanks to Durable Object WebSocket hibernation and SQLite-backed storage.
