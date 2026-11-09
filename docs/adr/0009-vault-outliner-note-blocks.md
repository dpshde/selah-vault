> **Canonical copy:** shared selah.tools ADR log in the Cursor Project Agent Store at `/cursor/stores/self/docs/adrs/0009-vault-outliner-note-blocks.md`. This file is a readable mirror for GitHub reviewers; edit the store copy when the decision changes.

# Notes are outliner blocks, one vault record per block

- **Status:** Accepted
- **Date:** 2026-11-09
- **Apps affected:** selah-vault (SPEC), margin-bible, proofs, route.bible, vault.selah.tools UI, any grant client that reads/writes notes

## Context

Notes need to sync across margin.bible (outliner with `blocks[]` + indent), Proofs,
route.bible, and the vault app. A single `note` blob with a plain `body` (SPEC ≤1.2)
cannot merge concurrent bullet edits, attach per-bullet passage/highlight links, or
opt one bullet into RemNote-style SRS without rewriting the whole note.

Dotflowy stores a flat node list (`id`, `parentId`, `prevSiblingId`, `text`,
`collapsed`, …) and repairs sibling chains with atomic multi-node writes. The vault
is a dumb E2E blob store with **per-record LWW** (SPEC §3) and no multi-item
transactions beyond “same POST arrives together”—sibling-pointer chains would fan
or dangle across devices. Margin keeps blocks inside one note row ordered by array
index + indent (not portable as separate encrypted items).

## Decision

1. **First-class `block` records** are the note model. A “note” is the tree of live
   blocks under passage-anchored root(s). Each block is its own vault item:
   `kind: "block"`, `ref` = stable block id (`b_…`), plus `parent`, fractional
   **`rank`** (lexicographic sibling order), `text`, optional `passage`, optional
   `highlight` (soft link to a highlight verse ref), `collapsed`, schema `v`, and
   preserve-unknown-fields (SPEC §1).

2. **Fractional / lex ranks, not `prevSiblingId`.** Concurrent inserts under one
   parent mint distinct ranks without rewriting neighbors. Display order: `rank`
   ascending, then `ref` on collision. Justify vs Dotflowy’s chain: vault merge
   cannot atomically repoint followers.

3. **Merge.** Different blocks never conflict. Same block: ordinary §3 LWW on the
   whole record (concurrent text edits can lose one side—apps MAY write a conflict
   sibling copy). Moves/reparents are field updates on that block; cycles MUST be
   broken by the reader (treat as `parent: null`). If a parent is tombstoned,
   children stay live as orphans until reparented—do not cascade-delete.

4. **Body format:** plain Unicode text per block (Margin parity). Not markdown
   documents. Inline markers for cloze (`{{cN::…}}`) live inside `text`. Richer
   markup MAY appear later as optional fields; unknown fields are preserved.

5. **SRS opt-in on a block** via `card` (`id` stable forever, `type` `basic`|
   `cloze`). That `card.id` is the SRS card key for ADR-0008 logs/state. Text
   edits must not mint a new `card.id`. Clearing `card` stops scheduling; history
   remains.

6. **Caps:** each block JSON SHOULD stay under 16 KiB; `text` SHOULD stay ≤ 4 KiB.
   Large outlines cost **one library item per block** against ~20k / 8 MB (SPEC
   §5.5)—clients MUST budget and tombstone emptied blocks. Prefer many small
   blocks over one huge note.

7. **Grants:** `notes:write` writes `block` (and legacy `note`) records.
   `highlights:write` unchanged. Highlight contract unchanged. E2E as ADR-0002.

8. **Margin import:** one root `block` per Margin note (`passage` ← OSIS/USFM);
   each Margin block → vault block, parent from indent tree, keep `b_…` ids when
   valid; stash Margin-only fields under `apps.margin` (slug, attachments,
   bookmarked, agent_*). Legacy vault `note`+`body` → one root block with that
   text.

Shapes and conflict/orphan rules live in selah-vault `SPEC.md` §1.3.

## Consequences

- Concurrent edits to different bullets merge cleanly; same-bullet text still LWW.
- Outlines can approach the library item cap; clients need GC and import chunking
  (≤100 items/POST).
- Margin, Proofs, route.bible, and vault share one tree; app-specific data stays
  namespaced.
- Dotflowy-style sibling chains are explicitly out of scope for vault sync.

## Sources

- Dylan direction on PR #37 (RemNote / Dotflowy / Margin outliner)
- `cameronapak/dotflowy` `src/data/wire-schema.ts`, `tree.ts`, ADR 0009 (atomic
  structural writes)—studied, not copied
- `dpshde/margin-bible` `src/notes.ts` (`Block`, `MAX_NOTE_CHARS`),
  `margin.library-snapshot` v1 / MCP export
- Shared ADRs 0001, 0002, 0004, 0008; selah-vault `SPEC.md` §§1, 3, 5.3, 5.5
