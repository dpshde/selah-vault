# Notes import mapping (Margin Bible)

Companion to SPEC §1.3. The Margin `margin.library-snapshot` v1 / MCP note shapes are
defined by margin-bible; this file only maps them into vault `block` records.

OSIS codes map to USFM refs as in SPEC §1.1 (for example `JHN.3.16`).

## Deterministic ids

Vault `ref` values MUST be derived so re-import and multi-device migration converge:

`b_` + first 22 characters of base64url(SHA-256(UTF-8 of source))

| Source | Source string |
|---|---|
| Legacy vault `note` | `legacy-note:` + note `ref` |
| Margin note (root) | `margin-note:` + Margin `slug` |
| Margin block | `margin-block:` + Margin `slug` + `:` + Margin block `id` |

Do not use a raw Margin block `id` as `ref`: those ids are unique per note, not per library.

## Mapping

| Margin | Vault |
|---|---|
| One note (`osis`, `slug`, …) | Root `block`: `ref` from `margin-note:…`, `outline` = that `ref`, `parent` = `null`, `passage` = USFM(`osis`), `rank` = `"a0"` (space ranks if several roots) |
| Each `blocks[]` entry | Child `block`: `ref` from `margin-block:…`, `outline` = root `ref`, `parent` from the indent tree (previous shallower block), increasing `rank` among siblings, `passage` copied from the root, `text` from Margin `text` |
| `attachments`, `bookmarked`, `source`, `agent_*` | `apps.margin.*` on the root (or the block that carried them) |
| Empty / bookmark-only notes | Root with empty `text` and `apps.margin.bookmarked` as needed |

Export MAY rebuild Margin `blocks[]` by walking children depth-first and setting `indent` from depth. Overlapping Margin notes (verse vs range) stay separate roots: compose, don't absorb.

## Legacy vault `note`

Create one root as above from `legacy-note:` + `ref`. Do **not** tombstone the legacy `note` during SPEC 1.x.
