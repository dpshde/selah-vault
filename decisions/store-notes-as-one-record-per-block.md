# Store notes as one record per block

Date: 2026-11-09

## Status

Accepted. Experimental in SPEC 1.3 (section 11). Shared with other selah.tools apps: filed in the shared ADR log as 0009.

## Context

A note was one `note` record with a `body`. Two devices editing different bullets lost one side, a single bullet couldn't carry its own passage, and one bullet couldn't become a flashcard. Dotflowy orders siblings with `prevSiblingId` chains, which need several records to change together, and the merge rule (SPEC.md 3) settles each record alone. Margin keeps a note's blocks inside one row.

## Decision

- A note is a tree of `block` records (SPEC.md 1.3): `ref` (`b_…`), required `outline`, `parent`, `rank`, plain `text`, optional `passage` and `card`.
- Notes are an extension of a saved passage (see [Keep a record for each saved passage](keep-a-record-for-each-saved-passage.md)): a block's `passage` is the passage's ref. There is no field pointing at a highlight.
- Siblings order by fractional `rank`, up to 128 characters. A writer never mints a rank ending in `0`, so there is always room between two ranks. When there is none, it moves one neighbor. No whole-parent rebalance, because every rewritten block would beat an offline text edit.
- Each block merges on its own. A conflict copy carries `conflictOf` and never the original's `card.id`. A cycle breaks at its smallest `ref`. A missing parent makes an orphan. Readers don't cascade deletes; a writer deleting a bullet tombstones its subtree.
- Migration and import derive ids: `b_` + base64url(SHA-256(source))[:22], with vectors in SPEC.md section 10.
- A legacy note is hidden once its block exists, live or deleted, and is migrated again when its `updated` is the larger. The note itself is never tombstoned by a migrating app.
- A `basic` card is one card keyed by `card.id`. A `cloze` block is one card per hole, keyed `card.id#cN`.
- A card is paused with a `suspend` event in the review log, not a field on the block, so there is one way to pause.
- Collapsed state stays on the device.

## Consequences

- Edits to different bullets always merge. Two edits to one bullet's text still lose one side, unless the app writes a conflict copy.
- A large outline costs one item per block.
- Deleting a note in a 1.2 app doesn't delete its block.
- Nothing implements this yet. `docs/reference-gaps.md` lists what has to exist before the experimental label comes off.
