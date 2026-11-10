# Model the library as an append-only event log

Date: 2026-11-10

## Status

Accepted

## Context

Selah Vault syncs saved passages, per-verse highlights, custom colors, hierarchical outliner note blocks, and spaced-repetition card reviews (`srs.reviewed`, `srs.card`) across offline-capable browsers, native iOS apps, and OAuth clients. Overwriting mutable blobs loses review history, makes partial updates overwrite concurrent fields, and forces brand-new devices to replay or merge whole tables on startup.

## Decision

Model every library mutation as an immutable `VaultEvent` appended to `/v2/events`:

1. **Event envelope & idempotency:** Clients generate unique `ev_<16..32 base64url>` IDs and millisecond timestamps (`ts`). `LibraryDO` assigns a 1-indexed `seq` on commit and deduplicates retries via `INSERT OR IGNORE` on `id`.
2. **Automatic query tags:** On ingest, both server and client index `book:<BOOK>` when `ref` starts with a USFM book code and `card:<cardKey>` when `data.cardKey` is present, enabling filtered incremental pulls (`GET /v2/events?after=<seq>&tag=...`).
3. **Deterministic `(ts, id)` convergence:** Stateful entities (`passages`, `highlights`, `colors`, `blocks`, `library_name`) store the winning `(ts, id)` order pair; an incoming event updates the materialized row only when its `(ts, id)` is strictly greater (numeric `ts`, ASCII `id` tie-breaker). Spaced-repetition cards (`srs_cards`) replay `srs.reviewed` and `srs.card` events in `(ts, id)` order, computing `pausedByPassage` when a passage's `removedTs >= lastActiveTs`.
4. **Symmetric server and client projectors (`src/projector.ts`, `public/sync.js`):** `LibraryDO` updates SQLite materialized tables and the `blocks_fts` (`FTS5`) virtual table synchronously inside `POST /v2/events`, serving instant `GET /v2/bootstrap` snapshots (`seq === 0`) and `GET /v2/search?q=...` queries while offline clients project optimistic outbox events with the identical `(ts, id)` rules.

## Consequences

- Multi-device offline edits converge to identical state regardless of network arrival order, with zero lost SRS review history.
- Cold devices hydrate in one `GET /v2/bootstrap` round-trip and catch up via `GET /v2/events?after=<seq>` plus `/v2/ws` pokes.
- Adding a new domain capability requires only a new `event.kind` and projector clause without migrating existing event rows.
