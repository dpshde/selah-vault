> **Canonical copy:** shared selah.tools ADR log in the Cursor Project Agent Store at `/cursor/stores/self/docs/adrs/0008-vault-srs-progress-records.md`. This file is a readable mirror for GitHub reviewers; edit the store copy when the decision changes.

# Sync spaced-repetition progress as append-only vault records

- **Status:** Accepted
- **Date:** 2026-11-09
- **Apps affected:** selah-vault (SPEC), proofs, any future SRS clients (margin-bible, hidden-arrow, etc.)

## Context

Proofs (and later other apps) need cross-device review history and FSRS scheduling state.
Per-device FSRS alone diverges. An earlier sketch used a Proofs-only `kind: "x-proofs"`
and HMAC keys on the client; that would fork naming and skip the vault's shared record
rules (item ids from `kind` + `ref`, E2E blobs, one merge rule, grant scopes).

The vault already allows experimental kinds (`x-…`), preserves unknown fields, encrypts
every item the same way (ADR-0002), and merges by last-writer-wins on each `kind`+`ref`
identity (SPEC §3). Library caps are about 20,000 items / 8,000,000 blob characters
(SPEC §5.5). JSON per record SHOULD stay under 16 KiB (SPEC §5.3).

## Decision

1. **Source of truth is an append-only review log**, not the FSRS card object. Each review
   is an immutable event (`id`, `reviewedAt`, `rating`, `unit`, `client` / `device`,
   schema `v`). History merge is **set union deduped by event `id`** (grow-only). Do not
   LWW-replace the event list as if it were a single scalar field.

2. **Stay inside the vault merge rule.** Bucket events into records whose identity is
   stable (`x-srs-log` + `ref` = `{passage}#{unit}/{yyyy-mm}` UTC). When two live versions
   of the same bucket meet, clients **MUST** union `events` by `id`, then write one new
   version with a fresh `updated` (SPEC §3 already allows combining concurrent edits).
   Wire LWW still picks a single blob; the union step is what makes history grow-only.

3. **FSRS state is a disposable derived cache** (`x-srs-state`, one per card). Tag it with
   algorithm id/version (e.g. `fsrs-6`) and a parameters hash. On mismatch, replay the
   log deterministically and rewrite the cache. Cache conflicts may use ordinary LWW.

4. **Card identity is passage + unit**, not a highlight id: `passage` is a USFM ref
   (ADR-0004 / SPEC §1.1), `unit` is a short token (`verse`, `passage`, …). Per-app fields
   (e.g. Proofs rung) live under a namespaced `apps.<appId>` object. Naming is app-neutral
   (`x-srs-*`); a later 1.x may promote to first-class `srs-*` kinds without changing
   meaning. Do not ship `x-proofs` as the shared shape.

5. **Caps:** prefer monthly buckets; compact older months into fewer live log records and
   tombstone the rest; split a bucket before it exceeds the 16 KiB SHOULD. Budget SRS
   items so highlights still fit under §5.5.

6. **Grants:** add client-facing scope `srs:write` for writing `x-srs-*` (and later
   `srs-*`) records. `read` continues to cover all kinds. `highlights:write` stays
   highlight-only. Highlight records and the highlights API are unchanged. Same E2E
   privacy as every other record (ADR-0002). Server epoch refill (SPEC §5.6) applies
   unchanged.

7. **Conformance:** publish shared vectors (fixed log → expected FSRS state) for TypeScript
   and Swift clients; pin the same FSRS implementation version per platform.

Record shapes, reset/tombstone rules, and size notes live in selah-vault `SPEC.md`
(experimental §1.6). This ADR binds the cross-app model; vault-only wording stays in the
SPEC PR.


## Update 2026-11-09 — card ids from outliner blocks

When a flashcard is created on an outliner block (ADR-0009), the stable SRS card
key is that block's `card.id`, not `passage#unit`. Review-log buckets and
`x-srs-state` refs use `{cardId}` / `{cardId}/{yyyy-mm}`. `passage` and `unit`
MAY still appear as metadata for display or for non-outliner cards. Text edits
to the block MUST NOT change `card.id`.

## Consequences

- Proofs (and peers) sync progress through `/connect` or the sync key like any vault
  client—no second store and no Proofs-private kind.
- Implementers must union log events on sync; treating a bucket as opaque LWW will drop
  concurrent reviews.
- Heavy review volume needs compaction discipline or the library hits §5.5.
- Promoting `x-srs-*` to first-class kinds is a compatible 1.x change when the shape is
  proven.

## Sources

- Project handoff `internal/handoff-vault-srs-spec.md` (approved direction)
- `dpshde/selah-vault` `SPEC.md` §§1, 3, 4.2, 5.3, 5.5, 5.6, 9, 11
- Shared ADRs 0001 (connect), 0002 (E2E), 0004 (USFM refs)
