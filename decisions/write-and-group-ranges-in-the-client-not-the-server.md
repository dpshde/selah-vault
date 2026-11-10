# Write and group ranges in the client, not the server

Date: 2026-11-04

## Status

Accepted

## Context

People think in passage ranges ("highlight Romans 5:3-5 in green"), yet storing multi-verse ranges as single rows creates overlapping or half-deleted ranges when someone later unhighlights or recolors verse 4 on another device. Conversely, storing one highlight per verse keeps concurrent verse edits conflict-free, provided clients expand ranges on write and group contiguous same-color verses on read.

## Decision

Keep storage strictly one verse per `highlight.set` / `highlight.removed` event (`SPEC.md` section 3.3), and implement range expansion and grouping once in shared client modules:

- `public/ranges.js` defines `expandRange` and `rangeWrites` (expanding a canonical same-chapter range of up to 100 verses into per-verse writes while skipping verses already in that color) and `listRanges` (grouping contiguous same-color verses within a chapter). `test/ranges-vectors.json` verifies identical behavior across Selah Vault and `route.bible`.
- `public/sync.js` exposes `Library.highlightRange(ref, color)` and `Library.highlights({ group: "ranges" })`, sending up to 500 per-verse events atomically in a single `POST /v2/events` transaction.
- `public/grant-client.js` exposes `changes(since)` (hydrating from `GET /v2/bootstrap` when `since === null` and pulling `GET /v2/events?after=<seq>` thereafter) alongside `highlightRange` and grouped reads for OAuth 2.1 clients.
- The `/mcp` server (`src/mcp/index.ts`) imports `public/ranges.js` directly so `add_highlight`, `list_highlights`, and `find_highlights` expand and group ranges with the exact same rules.

## Consequences

- Recoloring or deleting a single verse inside a highlighted passage splits or trims the range cleanly across all devices with zero overlapping-range edge cases.
- Web, OAuth apps (`route.bible`, `Proofs`), and `/mcp` share one tested range implementation and test-vector suite.
