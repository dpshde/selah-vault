> **Canonical copy:** shared selah.tools ADR log in the Cursor Project Agent Store at `/cursor/stores/self/docs/adrs/0008-vault-srs-progress-records.md`. This file is a readable mirror for GitHub reviewers; edit the store copy when the decision changes.

# Sync spaced-repetition progress as append-only vault records

- **Status:** Accepted
- **Date:** 2026-11-09
- **Apps affected:** selah-vault (SPEC), proofs, any future SRS clients (margin-bible, hidden-arrow, etc.)

## Context

Proofs (and later other apps) need cross-device review history. Per-device FSRS alone
diverges. Per-card month buckets under a shared ref need a set-union merge that §3 LWW
and unaware clients (vault web, 1.2 apps) will not honor, and they blow the ~20k item /
8 MB library caps. Renaming `x-srs-*` later would change HMAC item ids (`kind` + `ref`).

## Decision

1. **Append-only `srs-log` is the source of truth.** Final kind name now (experimental
   under SPEC §11)—no later `x-` rename. Events carry `type` `review` or `reset`,
   `cardId`, `reviewedAt`, unique `id`. Replay orders by `(reviewedAt, id)`; a `reset`
   cuts off earlier events for that card.

2. **Single-writer device-month buckets.** `ref` = `{deviceId}/{yyyy-mm}` or
   `{deviceId}/{yyyy-mm}/{n}` when split (~16 KiB). Many cards share a bucket. Only that
   device writes that ref → plain LWW is safe. Readers union events across devices by
   `cardId` + event `id` when replaying. Month from `reviewedAt` UTC. Compact only own
   buckets older than 90 days.

3. **FSRS state stays local** (not a synced vault kind). Avoids paramsHash rewrite loops
   and saves items. If a hash is needed for tests, use SHA-256 of RFC 8785-ish canonical
   JSON of the params object. Durable settings (Proofs rung) live on the flashcard
   block's `apps.<appId>` or optional synced `srs-card`, never on a disposable cache.

4. **Card keys:** block `card.id` (stable across text edits) or `passage#unit`. Not
   highlight ids.

5. **Grants:** `srs:write`; any write scope mints `mk`; consent warns honor-system kinds.
   Highlights unchanged. E2E as ADR-0002.

6. **Conformance:** shared vectors; pin FSRS impl version per platform.

Record shapes: selah-vault `SPEC.md` §1.6. Reference code gaps: `docs/reference-gaps.md`.

## Consequences

- Unaware clients cannot erase another device's reviews by LWW-pushing a stale shared bucket.
- Item use stays small (~tens of log items per device per year after splits).
- Clients must replay across devices; local FSRS caches are not shared.

## Sources

- Independent review of PR #37 (device-month buckets, final kind names, local state)
- `dpshde/selah-vault` `SPEC.md` §§1.6, 3, 4.2, 5.3, 5.5, 11
- Shared ADRs 0001, 0002, 0004, 0009
