# Notes import mapping (Margin Bible)

Companion to SPEC §1.3. The Margin `margin.library-snapshot` v1 / MCP note shapes are
defined by margin-bible; this file only maps them into vault `block` records.

OSIS codes map to USFM refs as in SPEC §1.1 (for example `JHN.3.16`).

## Deterministic ids

Vault `ref` values MUST be derived so re-import and multi-device migration converge:

`b_` + first 22 characters of base64url(SHA-256(UTF-8 of source)). SPEC §10 has vectors.

| Source | Source string |
|---|---|
| Legacy vault `note` | `legacy-note:` + note `ref` |
| Margin note (root) | `margin-note:` + Margin `slug` |
| Margin block | `margin-block:` + Margin `slug` + `:` + Margin block `id` |

Do not use a raw Margin block `id` as `ref`: those ids are unique per note, not per library.

## Mapping

| Margin | Vault |
|---|---|
| One note (`osis`, `slug`, …) | Root `block`: `ref` from `margin-note:…`, `outline` = that `ref`, `parent` = `null`, `passage` = USFM(`osis`), `rank` = `"a1"` |
| Each `blocks[]` entry | Child `block`: `ref` from `margin-block:…`, `outline` = root `ref`, `parent` from the indent tree (the nearest earlier block with a smaller indent, else the root), `rank` from the fixed sequence below, `passage` copied from the root, `text` from Margin `text` |
| `attachments`, `bookmarked`, `source`, `agent_*` | `apps.margin.*` on the root (or the block that carried them) |
| Empty / bookmark-only notes | Root with empty `text` and `apps.margin.bookmarked` as needed |

Export MAY rebuild Margin `blocks[]` by walking children depth-first and setting `indent` from depth. Overlapping Margin notes (verse vs range) stay separate roots: compose, don't absorb.

## The same records on every device

Two devices that import the same Margin note MUST write byte-for-byte the same fields, so the merge rule (SPEC §3) has nothing to choose between and siblings from two imports can't interleave:

- **Ranks.** The root's `rank` is `a1`. The `k`-th child of a parent, counting from 0 in Margin's order, gets `a` + `k` as five decimal digits + `V`: `a00000V`, `a00001V`, `a00002V`, … These sort in order, never end in `0`, and leave room between any two for a later insert. Importers MUST use exactly these.
- **Times.** Every block of a note gets `updated` = the note's `updated_at` and `created` = its `created_at`, each as whole Unix seconds, rounded down. Importers MUST NOT use the time of the import.
- **Nothing else varies.** The root's `text` is empty unless the mapping above says otherwise, and `v` is `1`.

A later import of a note that changed in Margin has a larger `updated`, so its blocks win one by one. A block that the newer note no longer has is left as it was; the importer SHOULD delete it (SPEC §1.3, "Subtree delete").

SPEC §10 has the records for one note of three blocks, and `conformance/fixtures.json` (`marginImport`) has them in full.

## Legacy vault `note`

Create one root from `legacy-note:` + `ref`, copying the note's `created` and `updated`. Do **not** tombstone or rewrite the legacy `note` during SPEC 1.x.

SPEC §1.3, "Legacy `note` records", says which copy counts afterwards: hide the note once its block exists (live or deleted), and write the block's `text` again when the note's `updated` is the larger.

## Saved passages

A Margin note is about a passage, so an import also saves it: write a `passage` record (SPEC §1.6) for each root's `passage` that the library doesn't already hold, in the same POST as the root. Importing notes writes no review events, so it puts nothing in a deck.
