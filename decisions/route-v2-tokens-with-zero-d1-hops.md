# Route v2 tokens with zero D1 hops

Date: 2026-11-10

## Status

Accepted

## Context

Every `/v2/*` sync call, `/v2/ws` WebSocket upgrade, and `/mcp` tool invocation targets one user's `LibraryDO`. If session cookies and OAuth bearer tokens were opaque random strings stored in the global `selah-vault-auth` D1 database, every single API call would pay an extra cross-network D1 query just to resolve `token -> userId` before forwarding to `LibraryDO`, adding latency and making D1 a hot-path availability dependency for already-authenticated devices.

## Decision

Encode the target `userId` directly into every session and OAuth token (`src/clients.ts`):

```
sv2.<userId>.<secret>
```

- `userId` (`^u_[A-Za-z0-9_-]{22}$`) identifies the user's Durable Object (`env.LIBRARY.idFromName(userId)`).
- `secret` (`^[A-Za-z0-9_-]{43}$`) holds 32 cryptographically random bytes.
- First-party browsers send `sv2.<userId>.<secret>` in the `HttpOnly; SameSite=Lax` `selah_session` cookie; OAuth and MCP clients send `Authorization: Bearer sv2.<userId>.<secret>` (or `Sec-WebSocket-Protocol: selah-v2, token.<sv2...>` on `/v2/ws`).
- On `/v2/*` and `/mcp`, the Worker validates the `sv2.` grammar, extracts `userId`, and forwards the request straight to `LibraryDO` without touching D1. `LibraryDO` hashes `<secret>` with SHA-256 and verifies `secret_hash`, `expires_at`, and `scopes` against its local SQLite `tokens` table.

## Consequences

- Hot-path `/v2/*`, `/v2/ws`, and `/mcp` requests perform zero D1 queries; D1 is touched only during sign-in, OAuth code exchange, and account deletion.
- Token verification and scope checks happen in-process inside the same SQLite Durable Object that serves the library data, while raw secrets are never persisted.
