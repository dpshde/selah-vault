> **Canonical copy:** shared selah.tools ADR log in the Cursor Project Agent Store at `/cursor/stores/self/docs/adrs/0009-vault-outliner-note-blocks.md`. This file is a readable mirror for GitHub reviewers; edit the store copy when the decision changes.

# Notes are outliner blocks, one vault record per block

- **Status:** Accepted
- **Date:** 2026-11-09
- **Apps affected:** selah-vault (SPEC), margin-bible, proofs, route.bible, vault.selah.tools UI, any grant client that reads/writes notes

## Context

A single `note` blob cannot merge concurrent bullets, attach per-bullet anchors, or opt
one bullet into RemNote-style SRS. Dotflowy sibling chains need atomic multi-node writes
the vault LWW store cannot guarantee. Margin keeps blocks inside one row. Migration and
import must not mint divergent ids on two devices.

## Decision

1. **First-class `block` records:** `ref` (`b_…`), required `outline`, `parent`,
   fractional `rank`, plain `text`, optional `passage` / `highlight`, RemNote-style
   `card`, schema `v`, preserve-unknown-fields. No synced `collapsed` (device-local UI).

2. **Fractional ranks, not `prevSiblingId`.** Rebalance siblings in one POST before rank
   length would exceed 32. Accept any `[0-9A-Za-z]` rank from peers.

3. **Merge / structure:** per-block LWW; conflict copies use top-level `conflictOf` and
   MUST drop or remint `card.id`. Deterministic cycle break at smallest `ref` in the
   cycle. Missing parent → orphan. Readers do not cascade-delete; writers deleting a
   bullet MUST tombstone the whole live subtree in one POST when it fits. Every block
   carries `outline` (and SHOULD carry `passage`) so orphans remain findable after a
   parent tombstone.

4. **Deterministic ids** for legacy-note migration and Margin import:
   `b_` + base64url(SHA-256(source))[:22]. See `docs/notes-import.md`. MUST NOT
   tombstone legacy `note` during 1.x.

5. **SRS opt-in:** `card.id` stable; `suspended` to pause; feeds ADR-0008. Durable app
   fields (rung) on `apps.<appId>` or `srs-card`.

6. **Grants:** `notes:write`; any write scope mints `mk`; consent honor-system warning.
   Highlights unchanged.

Shapes: `SPEC.md` §1.3. Import: `docs/notes-import.md`. Gaps: `docs/reference-gaps.md`.

## Consequences

- Concurrent edits to different bullets merge cleanly; same-bullet text can still lose
  under LWW (optional conflict copy).
- Large outlines cost one item per block; clients need GC and ≤100-item POSTs.
- Same-release reference updates required before production writers (checkRecord, scopes).

## Sources

- Independent review of PR #37; Dylan direction (RemNote / Dotflowy / Margin)
- `cameronapak/dotflowy` wire-schema / structural ADR (studied, not copied)
- `dpshde/margin-bible` notes + library-snapshot
- Shared ADRs 0001, 0002, 0004, 0008
