# Sync the library's name as a record

Date: 2026-11-03

## Status

Accepted

## Context

When a library's display name lived only in per-device `localStorage`, signing in on a second device or connecting an app showed a generic fallback name, and renaming the library on one device never propagated elsewhere.

## Decision

Sync the library's display name through the append-only event log (`SPEC.md` section 3.3):

- Renaming appends a `library.renamed` event (`{"kind":"library.renamed","ref":null,"data":{"name":"..."}}`).
- Both `LibraryDO` and `public/sync.js` apply deterministic `(ts, id)` ordering so the latest rename wins across every device.
- When a newly created library has no `library.renamed` event yet, `Library.adoptName()` emits an initial `library.renamed` event at `ts: 1` once initial sync completes, ensuring any explicit user rename (`ts > 1`) always supersedes it.
- `GET /v2/bootstrap`, `.jsonl` export headers (`{"selah-vault":2,"name":...}`), `GET /auth/me`, and `/mcp` (`get_library_info`) all return the synced library name.

## Consequences

- Renaming a library on one device updates every synced browser, connected OAuth app, and MCP tool session automatically.
- Concurrent offline renames settle deterministically by `(ts, id)` without conflict dialogs.
