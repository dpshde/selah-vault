# Selah Vault, version 1.3

> Thy word have I hid in mine heart, that I might not sin against thee. (Psalm 119:11)

Selah Vault (formerly Hidden Word) is a small format for the Bible passages a person saves, with their highlights, notes and review history, kept in step across a person's devices by a server that can't read them.

There is one way for another app to work with a library: **connect** (section 4). The person approves a grant on `/connect`, and the app reads and writes with it over HTTPS.

1. **Records**: what a highlight, a saved passage, a note, a review log, a color or the library's name looks like as JSON.
2. **Backup files**: a library as one readable JSON Lines file, to save and restore.
3. **Merging**: one rule that decides which version of a record wins, everywhere.
4. **Connecting an app**: a grant, its scopes, and the highlights API.
5. **Server sync**: how the vault's own devices sync: a sync key, end-to-end encryption, three HTTPS routes.
6. **Unlocking**: password managers and passkeys.

A connected app needs HTTPS, JSON, HMAC-SHA256 and AES-256-GCM, or just the reference grant client.

The key words MUST, SHOULD and MAY are used as in RFC 2119. Section 11 says what stays stable.

## 1. Records

A record is a JSON object. Every record has:

| Field | Type | Meaning |
|---|---|---|
| `kind` | string | `highlight`, `passage`, `block`, `note` (legacy), `srs-log`, `color`, `library`, or an app's own kind starting with `x-` |
| `ref` | string | What the record is about: a canonical reference (1.1), for `block` a block id (1.3), for `srs-log` a device and day (1.7), for `color` a color id, for `library` the setting's name |
| `v` | integer | Optional on older records. Schema version for this kind (1.3+). Readers that do not know a newer `v` MUST keep the record and show it best-effort. Writers MUST NOT lower `v` when editing a record that already has one |
| `updated` | integer | When the record last changed, in Unix seconds (see section 3) |
| `deleted` | `true` | Optional. The record was deleted |

A record's identity is its `kind` and `ref`. A library holds one version of each identity; section 3 says which.

Apps MUST keep records and fields they don't understand. When an app changes a record, it copies it, changes what it needs, and writes the whole record back. Field and kind names an app invents SHOULD start with `x-`.

A deleted record is `{"kind": …, "ref": …, "updated": …, "deleted": true}`. Readers MUST treat it as absent, and MUST keep it, so the deletion reaches every device.

**How the kinds fit together.** A library is built around the passages a person saves. The `passage` record is the core, and everything else attaches to it (1.6, "Extending a passage"):

| Kind | What it is | Tied to a passage by |
|---|---|---|
| `passage` (1.6) | A verse or range the person saved. The core | Its `ref`, a canonical reference |
| `block` (1.3) | An extension: one bullet of a note | Its `passage` field |
| `srs-log` (1.7) | An extension: a device's review events | Card keys that start with the passage's `ref` |
| `x-<appId>…` | An app's own extension | Either of those two ways |
| `highlight` (1.2) | Color on one verse's text | Nothing stored: the same verses |
| `color` (1.4), `library` (1.5) | Library-wide settings | Not tied to one |

Every link is a reference or an id held in a field, never a requirement: each record still reads on its own when the one it names is missing or deleted.

### 1.1 References

A reference is a USFM book code, a chapter, and optionally a verse or a range of verses in that chapter:

```
JHN.3        John 3
JHN.3.16     John 3:16
JHN.3.16-18  John 3:16–18
```

- Book codes are the 66 books of the Protestant canon: `GEN EXO LEV NUM DEU JOS JDG RUT 1SA 2SA 1KI 2KI 1CH 2CH EZR NEH EST JOB PSA PRO ECC SNG ISA JER LAM EZK DAN HOS JOL AMO OBA JON MIC NAM HAB ZEP HAG ZEC MAL MAT MRK LUK JHN ACT ROM 1CO 2CO GAL EPH PHP COL 1TH 2TH 1TI 2TI TIT PHM HEB JAS 1PE 2PE 1JN 2JN 3JN JUD REV`.
- Numbers follow the KJV versification, in decimal without leading zeros. An app whose translation numbers verses differently maps them to KJV numbers before writing.
- A range's end is greater than its start. A single verse is never written as a range.
- Books with one chapter still have chapter 1: Jude 3 is `JUD.1.3`.

### 1.2 Highlights

A highlight record covers exactly one verse. It holds one or more colored parts of it:

```json
{"kind":"highlight","ref":"JHN.3.16","updated":1793000000,"highlights":[
  {"color":"yellow","created":1792000000},
  {"color":"blue","start":4,"end":18,"quote":"God so loved","created":1792500000,"edited":1792600000}
]}
```

| Field | Type | Meaning |
|---|---|---|
| `color` | string | A color id (1.4). Show an id the library doesn't define as `yellow`. |
| `start` | integer | Optional, default 0. The first character covered, counted in Unicode scalar values of the verse's text. |
| `end` | integer | Optional. The character after the last one covered. Absent means to the end of the verse. |
| `quote` | string | Optional, recommended for part of a verse. The words covered when it was made. |
| `created` | integer | Optional. When this part was first made (Unix seconds). |
| `edited` | integer | Optional. When this part was last colored (Unix seconds). |

A part with no `start` and no `end` covers the whole verse, in every translation.

Offsets only mean something in the text they were counted in. To show a partial highlight in another translation, find `quote` in the verse, choosing the occurrence nearest `start`. If the verse doesn't contain it, highlight the whole verse, so a highlight never disappears. Where parts overlap, the most recently colored (largest `edited`, else `created`) is on top. A highlight across several verses is one record per verse.

There are no bookmarks: a highlight in a color named "Bookmarks" does the same job.

#### Ranges in apps

Storage stays one record per verse; ranges are how apps write and show them. The server never sees them, because it can't read refs or colors (section 9). The reference client (`public/ranges.js`, used by `public/sync.js`) defines both directions, and `test/ranges-vectors.json` holds cases for each:

- **Writing a range.** `ROM.5.3-5` in one color means a highlight record for each of `ROM.5.3`, `ROM.5.4` and `ROM.5.5`. A verse already highlighted whole in that color is left as it is, so writing the same range twice changes nothing. Any other verse takes the color as a one-verse edit does: one whole-verse part, keeping the earliest `created`, with `edited` set. A range is in one chapter and runs forwards; the reference client writes at most 100 verses at once (one POST, section 5.4) and sends them in one POST, so a server keeps all of them or none.
- **Showing ranges.** Live single-verse highlights, in canonical order, join when they are back-to-back verses of one chapter and show the same color (the newest part's, unknown ids counting as `yellow`). A gap, a new chapter or a different color starts a new range. Each range lists its verses' refs, so an app can still recolor or delete one verse.

### 1.3 Notes (outliner blocks)

A note is an outline: a tree of **blocks**. Each block is its own record, so two devices editing different bullets never clobber each other, a block can name the passage it is about, and a single bullet can opt into spaced repetition (1.7) without rewriting a whole document.

`block` records are **experimental** for 1.x (section 11). Legacy `note` records, at the end of this subsection, are not.

This follows Margin Bible's outliner and RemNote-style flashcards. Sibling order uses fractional ranks, not Dotflowy-style `prevSiblingId` chains, because the vault merge rule (3) cannot atomically repair multi-node pointer tears.

#### Block records

```json
{"kind":"block","ref":"b_01JEXAMPLE000000000002","v":1,"updated":1793000000,"created":1792000000,
 "outline":"b_01JEXAMPLEROOT00000001","parent":"b_01JEXAMPLEROOT00000001","rank":"a1",
 "text":"God so loved the world","passage":"JHN.3.16",
 "card":{"id":"c_01JEXAMPLECARD000000001","type":"basic"},
 "apps":{"margin":{"slug":"jhn.3.16","bookmarked":false}}}
```

| Field | Type | Meaning |
|---|---|---|
| `ref` | string | Stable block id: `b_` plus 1–40 letters, digits, `_` or `-`. Identity for merge and item ids (5.3). Never reuse a deleted id for a different block |
| `v` | integer | Record schema version (see section 1). Current writers use `1` |
| `outline` | string | Id of the outline this block belongs to: the root block's `ref`. **Required** on every live block so orphans stay findable after a parent is tombstoned |
| `parent` | string or `null` | Parent block's `ref`, or `null` for a root |
| `rank` | string | Fractional / lexicographic sort key among siblings (see Order) |
| `text` | string | Plain Unicode text for this bullet (not a markdown document). Empty string is allowed |
| `passage` | string | Optional. The `ref` of the saved passage (1.6) this block is about. Every block in a passage's outline SHOULD carry the same `passage`, not only the root |
| `created` | integer | Optional. When the block was first created (Unix seconds) |
| `card` | object | Optional. SRS opt-in for this bullet (see Flashcards) |
| `conflictOf` | string | Optional. When this block is a conflict copy, the `ref` of the block it was copied from |
| `apps` | object | Optional. Namespaced per-app extras (`apps.<appId>`); other apps preserve them |

Do **not** sync UI-only state such as whether a bullet is collapsed; keep that on the device.

**Attaching to a passage.** `passage` is how a note belongs to a saved verse or range. A writer that attaches a block to a passage the library hasn't saved SHOULD write the `passage` record (1.6) in the same POST. Readers MUST still show a block whose `passage` has no live record: removing a saved passage never hides or deletes its notes. A block does not point at a highlight; a highlight on the same verses is found by reference.

**Body format.** Plain text per block, matching Margin's `Block.text`. Cloze markup is inline in `text` (see Flashcards). Apps MUST NOT require markdown parsing to show a block.

**Deterministic ids.** When migrating or importing, derive `ref` so two devices produce the same id: `b_` + the first 22 characters of base64url(SHA-256(UTF-8 of a stable source string)). Source strings: `legacy-note:` + the old note's `ref`; `margin-note:` + Margin note slug; `margin-block:` + Margin note slug + `:` + Margin block id. Section 10 has vectors.

#### Order (fractional ranks)

`rank` orders siblings under the same `parent`. It is 1–128 characters of `[0-9A-Za-z]`. Compare ranks as UTF-8 byte strings, ascending, so `0` is the lowest character. When two live siblings share a rank, order by `ref` ascending.

- **Minting.** A writer mints a rank strictly between its two neighbors (or after the last, or before the first), so concurrent inserts under one parent rarely collide. A minted rank MUST NOT end in `0`. Between any two different ranks that don't end in `0` there is always another: between `a` and `a1` sits `a0V`.
- **Reading.** Readers MUST order by any rank of the right characters and length, including one that ends in `0` or that a particular fractional-indexing library would reject.
- **No room.** When nothing sorts between two neighbors (equal ranks, or `a` and `a0` from another writer), or the new rank would pass 128 characters, the writer first moves the later neighbor to a new rank between itself and the sibling after it, then inserts into the room that leaves. That rewrites one sibling. Writers MUST NOT re-rank a whole parent as routine: every rewritten block takes a fresh `updated` and would beat a text edit made to it offline.

Ranks grow by about one character every six inserts between the same two neighbors, so 128 characters is several hundred of them. Do not store sibling linked lists.

#### Building the tree

Live blocks (not deleted) form a forest. Children of `P` are live blocks whose `parent` is `P`'s `ref`, ordered as above. An outline is every live block with the same `outline` id. A passage's notes are the live blocks with that `passage`, found by filter and not by walking a tree.

#### Merging blocks

Section 3 still picks one version of each `kind`+`ref` by `updated` (then JSON size).

- Edits to **different** blocks never conflict.
- **Same block:** LWW on the whole record. Concurrent text edits can lose one side. An app that wants to keep both MAY write the losing text as a **conflict copy**: a new block (`ref` freshly minted, **no** `card`, or a newly minted `card.id` if it must be a card), same `outline` and `parent`, a `rank` beside the winner, and `conflictOf` set to the original `ref`. Prefer small, frequent writes.
- **Moves / reparent:** changing `parent` and/or `rank` is an ordinary edit. Concurrent moves: LWW.
- **Cycles:** if following `parent` links from a block returns to itself, break the cycle at the live block in the cycle whose `ref` is smallest (UTF-8 byte order): treat that block's `parent` as `null` for display and SHOULD write a repair with `parent: null` and a fresh `updated`. If `parent` points at a missing or deleted ref, treat the block as an orphan under its `outline` (parent null for display) and SHOULD heal the same way.
- **Orphans:** when a parent is deleted, children stay live (`outline` and `passage` on every block keep them findable). Readers MUST still show them. Clients SHOULD heal by setting `parent` to the nearest live ancestor in the same `outline`, or to `null`. Readers MUST NOT cascade-delete children when a parent is tombstoned.
- **Subtree delete:** when a person deletes a bullet, the writer MUST tombstone that block **and every live descendant** in the same `outline` (one POST when they fit, ≤100 items). That is a writer duty; it is separate from the reader no-cascade rule.
- **Structural batches:** indent/outdent/move that touch several blocks SHOULD go in one POST when they fit.

#### Flashcards (RemNote-style → SRS)

A block opts into scheduling with `card`:

| Field | Type | Meaning |
|---|---|---|
| `id` | string | Stable card id: `c_` plus 1–40 letters, digits, `_` or `-`. Assigned once when the card is created; **never** change it when `text` or children change |
| `type` | string | `basic` or `cloze` |

- **`basic`:** front is this block's `text`; back is the plain text of its direct live children (in order), or empty if none. One card, with card key `card.id` (1.7).
- **`cloze`:** cloze holes are `{{cN::answer}}` or `{{cN::answer::hint}}` in `text` (`N` ≥ 1). A literal `{{` is written as `\{{`. Each distinct `N` is its own card, with card key `card.id` + `#c` + `N` (for example `c_01JEXAMPLECARD000000001#c2`), scheduled on its own. Holes that share an `N` are hidden together. Nothing about which hole comes next is stored: each has its own history.

Conflict copies MUST drop `card` or mint a new `card.id` (never copy the original id). To pause a card without losing its history, write a `suspend` event for its card key (1.7), one for each hole of a cloze block; nothing on the block changes. Clearing `card` means the bullet is no longer a flashcard; the review history for its card keys stays in the log.

#### Size and library caps

A block's JSON text SHOULD stay under 16 KiB (5.3). `text` SHOULD stay ≤ 4 KiB. Prefer child blocks over one huge `text`.

Each block is one library item against about 20,000 items / 8,000,000 blob characters (5.5). Clients MUST tombstone deleted blocks, chunk imports into POSTs of ≤100, and refuse new blocks when near the cap.

#### Deletion

Delete with a deleted record (section 1). Same tombstone shape as highlights. For subtree deletes, see above.

#### Legacy `note` records

1.2-era monolithic notes remain readable and writable for the rest of 1.x:

```json
{"kind":"note","ref":"JHN.3.16-18","updated":1793000000,"created":1792000000,"body":"Plain text."}
```

`ref` is a passage; `body` is plain text; one such record per passage. New writers SHOULD create `block` trees instead. Grant scope `notes:write` covers both `block` and legacy `note`.

A note and its migrated block are two records for one piece of writing, so these rules say which one counts:

- **Migrating.** Create one root block with the deterministic `ref` from `legacy-note:` + the note's `ref`, with `outline` = that `ref`, `parent` = `null`, `passage` = the note's `ref`, `text` = `body`, and `created` and `updated` copied from the note. Two devices that migrate the same note write the same record.
- **Showing.** When a record with that deterministic `ref` exists, live or deleted, an app that reads blocks MUST NOT show the legacy note. A deleted block means the person deleted the note.
- **Re-migrating.** A 1.2 app may still edit the note. When a live note's `updated` is larger than its block's, the note is the newer writing: the app writes the block again with `text` = `body` (section 3, Writing). The block's children stay. A deleted block is not brought back this way.
- **Keeping.** Writers MUST NOT tombstone or rewrite the legacy `note` when migrating: older apps still read it. A note deleted by a 1.2 app leaves its block alone.

#### Margin Bible import

Normative mapping lives in [docs/notes-import.md](docs/notes-import.md) (Margin `library-snapshot` / MCP shapes are external). Summary: one root block per Margin note; children from the indent tree; always derive vault `ref` with the deterministic hash rule above (do not assume Margin block ids are library-unique); stash Margin-only fields under `apps.margin`.

### 1.4 Colors

Colors double as categories. Six are built in: `yellow`, `green`, `blue`, `pink`, `purple`, `orange`. A library may name them, and may add its own:

```json
{"kind":"color","ref":"yellow","updated":1793000000,"name":"Promises"}
{"kind":"color","ref":"c-7f3a9b","updated":1793000000,"name":"Prayer","hex":"#3a7bd5","created":1793000000}
```

| Field | Type | Meaning |
|---|---|---|
| `ref` | string | The color id: lowercase letters, digits and `-`, up to 32 characters, starting with a letter or digit |
| `name` | string | Optional. What the color means to this person |
| `hex` | string | `#RRGGBB`. Required for a color that isn't built in. Apps MAY ignore it for built-in colors |
| `created` | integer | Optional. Apps list a library's own colors after the built-in ones, in `created` order |

New ids SHOULD be random (`c-` and a few random characters) so two devices never pick the same one. A highlight whose color is unknown or deleted shows as yellow. An app that deletes a color SHOULD first recolor its highlights.

### 1.5 The library's name

A library's name for people ("Personal", "Family devotions") is a record too, so it reaches every device and app like everything else, encrypted on a server like everything else:

```json
{"kind":"library","ref":"name","updated":1793000000,"name":"Family devotions"}
```

| Field | Type | Meaning |
|---|---|---|
| `ref` | string | `name`. Other refs are reserved for later library-wide settings |
| `name` | string | The library's name: not empty, not only spaces |

- Show this name when the library has it. Renaming the library writes this record (section 3, Writing).
- Until it arrives, an app may show a name of its own, such as the one typed to unlock (7.1) or kept in a passkey's slot (7.2). That name is only a label: it MUST NOT be written as a newer `library` record, or unlocking on a new device would rename the library.
- An app that has a name for a library with no `library name` record MAY write one with `updated` 0, after it has synced with its server, so the record from any other device has had the chance to arrive. Any rename beats it, and two such records settle by the tie rule.
- Apps that don't show names keep the record like any other (section 1), and never show it as a highlight or note.

### 1.6 Saved passages (experimental)

A saved passage says "this verse, or this range, is one of mine". It is the core of a library: small, portable, and readable by any app. Everything a person then does with a passage (annotating it, memorizing it, whatever an app invents next) is an **extension** that attaches to it from its own records. This subsection is **experimental** for 1.x (section 11). The kind name `passage` is final.

```json
{"kind":"passage","ref":"JHN.3.16-18","v":1,"updated":1793000000,"created":1792000000}
```

| Field | Type | Meaning |
|---|---|---|
| `ref` | string | The passage: a canonical reference (1.1), so a chapter, a verse or a range |
| `v` | integer | Record schema version. Current writers use `1` |
| `created` | integer | Optional. When the passage was first saved (Unix seconds). An edit keeps the earliest `created` it knows |
| `apps` | object | Optional. Namespaced per-app settings (`apps.<appId>`); other apps preserve them. See "Extending a passage" for what belongs here |

- **Identity is the reference.** Nothing is minted. Two devices that save `JHN.3.16` while apart write the same `kind` and `ref`, and section 3 leaves one record. Anything keyed by the reference is likewise the same on every device.
- **Saving** writes the record. Saving a passage that is already saved changes nothing.
- **A library's passages** are its live `passage` records, and only those. Saved means the person chose it: an app MUST NOT save a passage because a curriculum or a reading plan contains it.
- **Overlap.** `JHN.3.16` and `JHN.3.16-18` are two passages, each saved in its own right. Apps MUST NOT merge, split or absorb them on a person's behalf.
- **Removing** a passage is a deleted record (section 1). Nothing attached to it is deleted with it. Saving it again finds everything where it was.
- **Highlights are separate.** A highlight colors a verse's text (1.2) and a saved passage keeps a verse or range; neither needs the other. An app that offers highlighted ranges as things to keep writes the `passage` record when the person takes one up.

#### Extending a passage

The `passage` record stays this small on purpose. An extension is anything that adds to what a person can do with a saved passage. Notes (1.3) and review history (1.7) are the two this spec defines, and an app adds its own the same way, without a change here. Every extension, this spec's or an app's, follows these rules:

1. **Attach, don't embed.** An extension keeps its data in its own records and points at the passage. It does not grow the `passage` record. Two apps that each wrote their state into one record would overwrite each other, because section 3 keeps one whole version.
2. **Point by reference.** A record that is about a passage names it in a `passage` field holding the passage's `ref`. A key that is about a passage starts with the `ref` (`JHN.3.16-18#text`). Nothing else links them.
3. **Stand alone.** An extension's records MUST still read when the passage they name is not saved, was removed, or never existed. An extension MAY hold data about a passage nobody saved, such as reviews of a verse a catechism assigned. It MUST NOT delete its data because a passage was removed.
4. **Use one of three shapes.**

   | Shape | For | Merges by | Defined by |
   |---|---|---|---|
   | One record per thing | Things a person makes and edits: a note's bullet, a tag, a collection | Section 3, each record on its own | `block` (1.3) |
   | A log per device | Things that happen: a review, a reading, a prayer | Never: one writer per record | `srs-log` (1.7), "Log buckets" |
   | A field on the passage | A small setting that is rarely written | Section 3, the whole `passage` record | `apps.<appId>` above |

5. **Derive what follows from history.** State that events produce (a schedule, a streak, how far up a ladder a passage has got) is worked out by replaying a log, never stored in a field two devices both write.
6. **Name it.** An app's own kinds start with `x-<appId>`, and so do its units, columns and card keys (1.7). A kind name is for good: item ids derive from it (5.3).

A reader that doesn't know an extension keeps its records (section 1) and shows the passage without it.

### 1.7 Review history (experimental)

Apps that schedule reviews (Proofs and peers) MAY keep an append-only review log in the library. This subsection is **experimental** for 1.x (section 11). The kind name `srs-log` is final.

**The log is the truth.** Scheduler (FSRS) state is a cache each device rebuilds by replaying the log, and is never synced: it depends on the scheduler's parameters, and two clients with different parameters would rewrite each other's records forever. Which cards are in a person's deck is worked out from the log too.

This spec defines the log, the card keys and the events every scheduling app must agree on. What an app asks, how it grades an answer and what else it records about a review are the app's own, carried in its own columns.

#### Cards and units

A **card key** names one thing that is scheduled:

| Card | Card key | Example |
|---|---|---|
| A unit of a passage (1.6) | `ref` + `#` + unit | `JHN.3.16-18#text` |
| A `basic` flashcard block (1.3) | the block's `card.id` | `c_01JEXAMPLECARD000000001` |
| One hole of a `cloze` block (1.3) | `card.id` + `#c` + `N` | `c_01JEXAMPLECARD000000001#c2` |
| An app's own card | `x-<appId>:` + the app's id for it | `x-proofs:q1-s1` |

A card key is at most 96 characters. A passage card needs no `passage` record (1.6, rule 3). An app's own card is for something that is not a passage or a block, such as a catechism answer; only that app can show it, and every app keeps its events.

A **unit** is one thing to know about a passage, scheduled apart from the others. It is 1–32 lowercase letters, digits or `-`:

| Unit | Knowing it means |
|---|---|
| `text` | Given the reference, recalling the words |
| `ref` | Given the words, recalling the reference |
| `x-<appId>-<name>` | An app's own |

How a review was asked (multiple choice, cloze, first letters, typed, how much help) is not a unit. It is detail about one review and goes in a column. An app schedules the units it knows, and keeps events for units it doesn't.

#### Log buckets

Each **device** owns its buckets, and one bucket holds one day of that device's events for many cards. This is the log shape of 1.6; an app's own log (`x-<appId>-log`, say) follows everything under this heading except the meaning of `what`.

```json
{"kind":"srs-log","ref":"q8Zr0aXv5Tg/2026-11-09","v":1,"updated":1793000100,"client":"proofs-web","tz":-360,
 "cards":["JHN.3.16-18#text","x-proofs:q1-s1"],
 "cols":["x-proofs-rung","x-proofs-hints"],
 "events":[
   [0,1792999000,"add"],
   [0,1792999010,3],
   [0,1792999400,2,"R2b",1],
   [1,1793000000,1],
   [0,1793000100,"reset"]
 ]}
```

| Field | Type | Meaning |
|---|---|---|
| `ref` | string | `{deviceId}/{yyyy-mm-dd}`, then `{deviceId}/{yyyy-mm-dd}/{n}` (`n` from 1) if that fills. The date is the device's local date when the bucket was started |
| `v` | integer | Record schema version. Current writers use `1`. It covers the events too |
| `client` | string | Optional. The app id of the app that owns this device id |
| `tz` | integer | Optional. The device's offset from UTC, in minutes east, when the bucket was started. With `ref`'s date it says which day the person lived these events in, for streaks and daily counts |
| `cards` | array | The card keys this bucket's events refer to, each once |
| `cols` | array | Optional. Names of the columns events carry after `what` |
| `events` | array | The events, oldest first |

Each event is an array, `[card, time, what]`, followed by one value for each name in `cols`:

| Position | Type | Meaning |
|---|---|---|
| `card` | integer | Index into `cards` |
| `time` | integer | When it happened, in whole Unix seconds |
| `what` | integer or string | An integer `1`–`4` is a review, rated as FSRS does (again, hard, good, easy). A string is one of the events below |
| columns | any | Position 3 holds the value for `cols[0]`, position 4 for `cols[1]`, and so on. An event MAY stop early; a missing or `null` value means none |

A column name is `x-<appId>-<name>`: this version defines none of its own. Columns hold what an app records about a review, such as the form it asked in, hints used or accuracy. They are what an app's statistics are built from, and what it replays to derive its own state. Keep values short: every byte is paid on every event.

Readers MUST skip an event whose `what` they don't know, MUST ignore columns they don't know, and MUST keep both.

**Device ids.** A device id is 1–32 letters, digits, `-` or `_`. Each install of each app mints its own from at least 9 random bytes, as the reference client does for a backup file's `device` (2). An app connected with a grant mints its own too: it never borrows the vault app's. Only the install that minted an id writes buckets under it, so the one merge rule (3) is always right for a bucket, and a 1.2 client that pushes back a stale copy of some other record can't lose anyone's reviews.

**Appending.** A bucket only grows. A writer adds to the end of `cards`, `cols` and `events`, and never edits, reorders or removes anything in them. That makes an event's id its bucket's `ref` + `:` + its index in `events` (`q8Zr0aXv5Tg/2026-11-09:3`), with no id stored.

**Open and closed.** A writer appends to the bucket for its current local date, or to that date's highest split. Every earlier bucket of its own is **closed**: it never changes again. If the clock gives a date earlier than the writer's newest bucket, it keeps appending to the newest.

**Pushing.** A writer saves each event on the device at once (section 6) and SHOULD push a bucket when a session ends or pauses, not after every event. Each push sends the whole bucket again, and tells the server that the person just studied (9).

**Time.** A writer rounds an event's time down to the second, and feeds its own scheduler that stored value, not the clock reading it came from. Then a device that replays the log computes exactly what the device that wrote it did.

**Splitting.** Before a bucket's JSON would pass 16 KiB (5.3), start `{deviceId}/{yyyy-mm-dd}/1`, then `/2`.

**A copied device id.** Restoring a device from a backup, or moving a phone, can leave two installs with one device id, or one install with an old copy of its own bucket. Before appending, a writer MUST start from the version of the bucket that wins by section 3, and then append any events it holds that the winner lacks (matched by card key, `time` and `what`), after the winner's own. An install that receives a version of its bucket holding events it never wrote has been copied: it MUST mint a new device id for what it writes next.

#### Events and a card's state

| `what` | Meaning |
|---|---|
| `1`–`4` | A review with that rating |
| `"add"` | The person put this card in their deck |
| `"suspend"` | Stop scheduling it for now |
| `"resume"` | Schedule it again |
| `"drop"` | The person took it out of their deck |
| `"reset"` | The person cleared its progress |

**Replay.** To rebuild one card, take every event for its card key from every live bucket, from every device. Order them by `time`, then bucket `ref` (UTF-8 bytes), then index, and apply them in that order:

| State | Event | Next state |
|---|---|---|
| absent | `add`, or a review | active |
| active | `suspend` | suspended |
| suspended | `resume`, `add`, or a review | active |
| active or suspended | `drop` | dropped |
| dropped | `add`, or a review | active |
| any | `reset` | unchanged, and every earlier review of the card is discarded |

Any other pairing leaves the state as it is. The reviews after the last `reset` feed the scheduler, in order. The **deck** is the cards that are active. A card that is dropped or suspended keeps its history.

An app derives its own history-dependent state the same way, from the same events and its own columns.

#### Budget

A day's bucket is one item, and it costs what it holds. Measured with the encoding above: 50 reviews in a day, each of a different card, is about 1.8 KB of JSON, or 2,800 blob characters, so about 1,000,000 characters a year. Two short columns on every review add about a tenth. A library's minimum of 8,000,000 characters (5.5) holds everything a person keeps, so a log allowed half of it holds about four years at that pace, and three times that pace fills the same half in under a year and a half.

Clients SHOULD show how full a library is, and MUST refuse to start a bucket that would pass the limit instead of dropping events or other records. This version defines no way to replace old events with a summary. The limits in 5.5 are minimums, and a server MAY give a library more room.

#### Local scheduler cache (not synced)

Clients keep FSRS (or other) card state on the device only, and rebuild it by replay. If two platforms need a comparable hash of scheduler parameters for tests, `paramsHash` is the lowercase hex SHA-256 of the parameter object as canonical JSON (RFC 8785).

**Privacy and grants.** `srs-log` and `passage` records are encrypted like any other item (5.3, 9). Grant scope `read` covers them. Writing `srs-log` needs `srs:write` and writing `passage` needs `passages:write` (4.2). Sync-key holders write any kind.

**Conformance.** Shared vectors (a fixed log, a pinned scheduler version and parameters, and the expected state) SHOULD back every implementation, so TypeScript and Swift clients replay to the same schedule.

## 2. Backup files

A library file is UTF-8 JSON Lines (`.jsonl`, media type `application/x-ndjson`), one JSON object per line, readable by people and by any JSON parser. Blank lines are ignored.

The first line MAY be a header, which has no `kind`:

```json
{"hidden-word":2,"library":"2f4856b70a85a635e64ca60c047e27fb","device":"q8Zr0aXv5Tg","name":"Personal"}
```

`library` is the library id (5.2), `device` names the device that wrote the file, and `name` is the library's name for people: its `library name` record (1.5) when it has one. Every other line is a record, the `library name` record included, so an import brings the name with it. Readers skip lines that aren't records.

Files are a person's own backup: export to save a copy, import to restore it. They aren't a way for apps to exchange highlights; apps connect (section 4). When importing a file, each record is merged into the library by the rule in section 3, as if it had arrived from another device. Within one file, a later line with the same identity replaces an earlier one. A record without `updated` is treated as written at the moment of import.

## 3. Merging

Every device, connected app, server and file follows one rule, so a library ends up the same everywhere whatever order changes arrive in, and however long a device was offline.

**Which version wins.** Of two versions of a record, the one with the larger `updated` wins. If `updated` is equal, the one whose JSON text is larger as a sequence of UTF-8 bytes wins (compare bytes, not UTF-16 code units). A missing `updated`, or one that isn't an integer from −(2^53−1) to 2^53−1, counts as 0. The JSON text is the record exactly as its writer serialized it: the line in a file, or the plaintext of an encrypted item without its padding.

**Writing.** When an app changes a record, it sets `updated` to the current time, or to one more than the `updated` of the version it is replacing, whichever is larger. An edit therefore always beats what it was made from, even on a device whose clock is behind.

**Receiving.** A device keeps an incoming version only if it wins against the device's own. A device never deletes or replaces a record for any other reason.

Two devices that change the same record while apart keep the later change. Changes to different records never conflict. An app that wants to keep both versions' highlight parts MAY combine them into a new version, which then wins like any edit.

## 4. Connecting an app

An app reads and saves a person's library records with a **grant**: a limited, expiring token the person approves. The app never holds the sync key. Scopes limit which kinds the app is *meant* to write; the server only sees methods (9). [docs/connect.md](docs/connect.md) walks through it with the reference grant client, `public/grant-client.js`.

### 4.1 The grant

The app sends the person to `https://<site>/connect?return=<url>&state=<random>&scope=<scopes>`. `return` MUST be an origin the site allows (the reference site's list is `CLIENTS` in `public/grants.js`) or `http://localhost:<port>`. The site has the person unlock a library and approve, then sends the browser to `return` with a fragment, which never reaches a server:

```
#vault=<site>&lib=<library id>&rt=g1.<token>&ek=<64 hex>&exp=<unix seconds>&name=<library name>&scope=<scopes>&state=<state>[&mk=<64 hex>]
```

`rt` is the bearer token for `/v1/lib/{lib}` (5.4). `ek` is the library's `enc` key and `mk` its `mac` key (5.2), so the app decrypts items and makes item ids (5.3) itself. Cancel sends `#error=access_denied&state=…`. Apps check `state`, and keep the fields like a password. A grant lasts 90 days. The app revokes its own with `DELETE /v1/grant/{lib}` and its token; the library's own token lists grants with `GET` there and revokes one with `DELETE ?id=`.

### 4.2 Scopes

| Scope | Lets the token | Comes with |
|---|---|---|
| `read` | `GET /v1/lib/{lib}` | `ek` |
| `highlights:write` | `POST /v1/lib/{lib}` | `mk` |
| `passages:write` | `POST /v1/lib/{lib}` | `mk` |
| `notes:write` | `POST /v1/lib/{lib}` | `mk` |
| `srs:write` | `POST /v1/lib/{lib}` | `mk` |

No grant can delete a library, touch passkey slots or make grants. The server can't see what a record is (9), so it enforces methods only. **Any write scope** MUST mint `mk` in the `/connect` fragment so the app can form item ids (5.3). Consent copy MUST say that a write grant can change encrypted library items the server cannot filter by kind—not only the named intent—and that the app is trusted to honor the scope. By convention: `highlights:write` writes only `highlight` records; `passages:write` only `passage`; `notes:write` only `block` and legacy `note`; `srs:write` only `srs-log`. A connect request MAY ask for more than one write scope, and an app that saves a passage as it attaches a note or schedules a review asks for both.

**Client fallback.** A site that does not yet know `passages:write`, `notes:write` or `srs:write` rejects the scope list at `/connect`. Apps SHOULD detect that and fall back (for example sync-key unlock for the person's own devices, or ask only for scopes the site advertises). [docs/reference-gaps.md](docs/reference-gaps.md) lists what the reference site and grant client don't do yet.

### 4.3 The highlights API

The reference grant client does each of these in the app, where the plaintext is. An app without it does the same over the routes in 5.4, with items as in 5.3 and versions chosen by the merge rule (3).

| Operation | Grant client | Underneath | Scope |
|---|---|---|---|
| Changes since | `changes(cursor)` → `{ upserts, deletions, colors, next, reset }` | `GET ?after={seq}` until `more` is false. Keep `next` as the cursor. `reset` means replace everything (first call, or the server lost data, 5.6) | `read` |
| List, find | `highlights()`, `find(ref)` | One record per verse, in canonical order | `read` |
| Grouped read | `highlights({ group: "ranges" })` | Ranges as in 1.2, "Ranges in apps". Each lists its verses | `read` |
| Add a verse or range | `highlightRange("ROM.5.3-5", color)` | One record per verse, one POST: all or none. At most 100 verses, in one chapter | `highlights:write` |
| Recolor | `highlightRange(ref, newColor)` | Each verse keeps its earliest `created` | `highlights:write` |
| Delete | `remove(refs)` | Deleted records (1), one POST | `highlights:write` |

Call `changes` before writing, so each write's `updated` beats the version it replaces (3, Writing). Poll it while the app is visible.

## 5. Server sync

A person's own devices sync a library through a server that only stores encrypted blobs under random-looking ids. It has no accounts, no email addresses and no passwords. Holding the sync key is the only access control.

### 5.1 The sync key

A sync key is 16 random bytes from a cryptographically secure generator. People see it as text:

1. Append one check byte: the first byte of SHA-256 of the 16 key bytes.
2. Encode the 17 bytes (136 bits) in Crockford base32 (`0123456789ABCDEFGHJKMNPQRSTVWXYZ`), most significant bit first, padding the last group with zero bits: 28 characters.
3. Write them in groups of 4 joined by `-`: `000G-40R4-0M30-E209-185G-R38E-1YZ0`.

When parsing, accept any case, ignore spaces and dashes, read `O` as `0` and `I` or `L` as `1`, and reject a key that isn't 28 characters, has nonzero padding bits, or fails the check byte. A rejected key is a typo; say so.

### 5.2 Derived values

HKDF-SHA256 with an empty salt, from the 16 key bytes:

| Name | HKDF info | Length | Used as |
|---|---|---|---|
| `lib` | `hidden-word/v1/lib` | 16 bytes | Library id: lowercase hex, 32 characters |
| `auth` | `hidden-word/v1/auth` | 32 bytes | Bearer token: base64url without padding, 43 characters |
| `enc` | `hidden-word/v1/enc` | 32 bytes | AES-256-GCM key |
| `mac` | `hidden-word/v1/mac` | 32 bytes | HMAC-SHA256 key |

### 5.3 Items

Each record is stored as one item, `{id, blob}`.

- **id**: base64url (no padding) of HMAC-SHA256(`mac`, UTF-8 of `kind + " " + ref`), cut to 22 characters. Versions of one record share an id, and the server can't tell which verse it is.
- **blob**: base64url (no padding) of `nonce ‖ ciphertext`. The plaintext is the record's JSON text in UTF-8, padded with spaces (0x20) to a multiple of 256 bytes (at least 256). `nonce` is 12 fresh random bytes. `ciphertext` is AES-256-GCM(`enc`, nonce, plaintext) with the ASCII id as additional authenticated data, including the 16-byte tag.

A reader removes the trailing spaces, parses the JSON, and MUST check that `id` is the item id of the record's `kind` and `ref`, skipping it if not. A record's JSON text SHOULD stay under 16 KiB.

### 5.4 Routes

All bodies are JSON. Every route needs `Authorization: Bearer <token>`. Servers MUST send `Access-Control-Allow-Origin: *` and answer `OPTIONS` preflights, allowing at least the `Authorization` and `Content-Type` headers and the methods below. Responses SHOULD be `Cache-Control: no-store`.

**`GET /v1/lib/{lib}?after={seq}`** returns items written after `seq` (default 0), oldest first, at most 500 a page:

```json
{"items":[{"seq":41,"id":"cq_pOilWI_5HRaH6ll9W2d","blob":"AAEC…"}],"more":false,"seq":57,"epoch":"9c1f0e…"}
```

An `after` that isn't a non-negative integer is a 400. An optional `limit` (1–500, default 500) caps the page for clients with small memory, such as watches. Servers clamp it to that range and treat a value that isn't a number as 500. When `more` is true, ask again with `after` set to the last item's `seq`. `seq` is the library's latest sequence number. `epoch` is a random id the server chose when the library was first written, or `null` when the server has no such library.

**`POST /v1/lib/{lib}`** with `{"items":[{"id":…,"blob":…}]}`, 1 to 100 items, returns `{"seq": n, "epoch": "…"}`.

The first write claims a library: the server stores the SHA-256 of the token and refuses other tokens afterward (401). Each item replaces the server's item with the same id, whatever it held, and gets a new `seq` higher than every earlier one. If one POST names an id twice, the later one is kept, as if sent separately; the items take one `seq` each per distinct id. The server can't read blobs, so it never applies the merge rule; clients do. Readers never see a `seq` before every lower one is visible.

**`DELETE /v1/lib/{lib}`** deletes the library and its items, and releases the claim. Returns 204. The next write starts a new epoch.

Errors are `{"error": "message"}` with status 400, 401, 404, 405, 413 or 500.

### 5.5 Limits

A server SHOULD accept at least: 100 items per POST; blobs of 379 to 21,900 characters; 8,000,000 blob characters per library (about 20,000 items); 2.4 MB request bodies; 2,000-character key slots. Pages hold 500 items.

### 5.6 Syncing with a server

A client keeps, per server: the cursor (the last `seq` it read), the latest `seq` and the `epoch` it has seen, and which of its records the server doesn't have yet.

1. **Push** every record changed on this device since the last push, in POSTs of up to 100. Records saved by one edit (a range, say) SHOULD go in the same POST when they fit, so the server takes all of them or none. Records that came from this server are not sent back to it.
2. **Pull** pages from the cursor until `more` is false. A client MAY skip this after a push when the POST's answer shows nobody else wrote: if `seq` minus the number of distinct ids sent equals the cursor, those were the client's own items, so it can set the cursor to `seq` without reading them back. Merge each item (section 3). If this device's version wins against the server's, send this device's version again on the next push. That repairs a server that went back to an old version, or received one late.
3. **Refill a server that lost data.** If an answer has a different `epoch` from the one remembered, or a `seq` lower than the latest seen, the server was erased, replaced or restored from a backup. Reset the cursor to 0, send every record (including deleted ones), and pull again.

Sync after changes, on start, when the network returns, and every 30 seconds or so while visible. Syncing runs in the background and needn't be shown: apps SHOULD speak up only when changes are waiting and can't be sent, or when sync keeps failing.

## 6. Rules that protect people's data

These keep a library safe from a server going wrong:

- The copy on the device is the library. Every read and write goes to it first, and the app never waits on the network to show or save a change.
- An app MUST NOT delete local records because a server doesn't have them, answers with nothing, or fails. Only a newer deleted version (section 3) removes a record.
- Changes made offline are kept across restarts until the server has them.
- Network requests time out, and a failed sync is tried again later (on the next change, when the network returns, or on a timer).
- Export to a backup file (section 2) is always available, with or without sync.

Erasing a library removes it from the server and the device doing the erasing. Any other device that still holds it will put it back the next time it syncs, by design: a server can't take a library away from a device.

## 7. Unlocking

### 7.1 Password managers

The sync key is a password, and the library name is its username. When an app creates a library it MUST offer to save the key in the person's password manager before going on:

- On the web, show a real `<form>` with the name and key, and have the person submit it:

```html
<input name="username" autocomplete="username" value="Personal">
<input name="password" type="password" autocomplete="new-password">     <!-- creating -->
<input name="password" type="password" autocomplete="current-password"> <!-- unlocking -->
```

  Password managers offer to save a sign-up when they see the fields filled in and the form submitted with a page load after it. So:
  - Show the generated key as text with a Copy button, and have the person paste it into the empty password field. Password managers, Safari and iOS among them, offer to save only a password the person entered: a key the page filled in, even with `input` and `change` events dispatched, got no offer in testing. Refuse a pasted key that doesn't match, which also proves it was copied.
  - Let the submission navigate (for example a `GET` to the app's own page) instead of cancelling it. The key MUST NOT leave the device: remove every entry in the form's `formdata` event, so the request carries nothing. Keep what the new page needs to open the library in local storage.
- Native apps use the platform equivalents (Associated Domains with `textContentType` `.username` / `.newPassword` / `.password` on Apple platforms, `autofillHints` on Android).

The library name is only a label: it is not part of the key, and two people may both call theirs "Personal".

### 7.2 Passkeys

A passkey with the WebAuthn PRF extension can unlock a library without typing the key. This works with 1Password, iCloud Keychain and Google Password Manager passkeys, and with security keys that support `hmac-secret`.

- The PRF input (`eval.first`) is SHA-256 of the ASCII string `hidden-word/v1/prf`.
- From the 32-byte PRF output, HKDF-SHA256 with an empty salt derives `slot` (info `hidden-word/v1/slot`, 16 bytes, lowercase hex), `slot-auth` (info `hidden-word/v1/slot-auth`, 32 bytes, base64url bearer token) and `kek` (info `hidden-word/v1/kek`, 32 bytes, AES-256-GCM key).
- The slot holds `wrapped`: base64url of `nonce ‖ AES-256-GCM(kek, nonce, plaintext)` with the slot id as additional data, where the plaintext is the UTF-8 JSON `{"key": "<sync key text>", "name": "<library name>"}`.

Routes, with the `slot-auth` token: `PUT /v1/slot/{slot}` with `{"wrapped": "…"}` (the first write claims the slot; 204), `GET /v1/slot/{slot}` (`{"wrapped": "…"}`, or 404), `DELETE /v1/slot/{slot}` (204).

A slot's `name` is what the library was called when the passkey was added. Once the library has synced, its `library name` record (1.5) wins. The server never verifies the passkey's signature: the PRF output is the secret. Passkeys are bound to the website that created them, so they are a convenience on that site. The sync key in a password manager is what works everywhere.

When creating a library, an app SHOULD offer a passkey once the key is saved, as a separate, optional step that never blocks getting into the library. The step that saves the key MUST NOT wait on the passkey: password managers, and iOS in particular, only offer to save a password when the form is submitted directly by the person's tap, so a submission made after a passkey prompt by script gets no save offer. The reference app submits the form on Continue and then shows "Add a passkey" (and "Not now") on the library screen.

### 7.3 Handing over the key (deprecated)

Deprecated in 1.2: apps connect with a grant (section 4) instead. Sites keep this working for the rest of 1.x (section 11).

A Selah Vault site can hand a library's key to another app, in the style of an OAuth consent screen. The app opens `https://<site>/unlock?app=<display name>&callback=<url>`. The site asks the person to unlock a library, then asks "Give <app> access to <library>?". On Allow it sends the browser to `<callback>#k=<key>&name=<name>`, or `<callback>#error=denied` on Cancel. Fragments never reach servers.

`callback` MUST be `https:`, a custom scheme, or `http:` on `localhost`, `127.0.0.1` or `[::1]`. Sites MUST refuse `javascript:`, `data:`, `blob:`, `file:` and similar, and SHOULD show the callback's host. The app receives the whole key and can read, change and delete everything in the library.

A site MAY accept `/#k=<key>&name=<name>` to prefill its own unlock form.

### 7.4 Saving from a link

A Selah Vault site MAY save a highlight from a plain link, so any app, bookmarklet or share sheet can send a verse with one `GET`:

```
https://<site>/save?ref=John+3:16&color=blue
```

- `ref` is whatever the person or app has: a reference in any common form (`John 3:16`, `jn 3.16`, `JHN.3.16-18`, `Psalm 23`) or a link from a Bible app or site (bible.com, BibleGateway, route.bible). It covers every verse it names.
- `color` is optional: a color id, or a name the library gave a color (`Prayer`). Anything else means `yellow`.
- The site saves into the library already unlocked in that browser, at once and on the device first (section 6), and says what it saved with a way to undo it. If no library is unlocked, it asks the person to unlock or create one, and saves afterward.
- The link carries no key and reaches no library by itself. A site MUST NOT save for a library the browser hasn't unlocked, and SHOULD forbid framing (`frame-ancestors 'none'`) so the save is always visible.

The reference web app parses `ref` with [grab-bcv](https://github.com/dpshde/grab-bcv).

## 8. Linking

A reference is enough to link to a passage; records don't store links. To open a passage in the reader's preferred Bible app, apps MAY use route.bible, which uses the same book codes: `https://route.bible/` followed by the lowercased `ref`, for example `https://route.bible/jhn.3.16`.

## 9. What a server learns

A server learns how many items each library has, when they change, from which IP addresses, and each blob's size in 256-byte steps. An item that changes many times a day, as a review log's bucket does (1.7), shows when its owner is active and roughly how much; pushing once a session keeps that coarse. It does not learn verses, colors, notes, names or keys. It can delete or withhold items, or serve old versions; section 5.6 repairs the latter, and section 6 makes sure the former never costs a device its copy.

A server that also answers for an assistant with the sync key, like the reference Worker's MCP endpoint (`/mcp`), reads that library while it answers. That is the person's choice, made by giving an app the key; plain server sync never sends it. The MCP endpoint is optional and outside this spec: servers needn't offer it, and section 11's promises don't cover it.

Losing the sync key and every passkey means losing access to the server copy. The copy on a device, and any backup file, are still readable without it.

## 10. Test vectors

`test/vectors.json` holds a key (bytes `00 01 … 0f`), its text form `000G-40R4-0M30-E209-185G-R38E-1YZ0`, every derived value, the item id of `highlight JHN.3.16`, a blob made with a fixed nonce, the PRF input, and slot values for a PRF output of 32 bytes of `0x11`. `bun run vectors` regenerates the file from the reference client.

| | |
|---|---|
| `lib` | `2f4856b70a85a635e64ca60c047e27fb` |
| `enc` | `5e87f9ed998e6aad7edc1bfd67eff85e050949044d082a12577653a0b30e0d4d` |
| `mac` | `1444a07f1522ce58fedbf8f88bc61087b527da58c1238b7d7c3ef747bf293162` |
| id of `highlight JHN.3.16` | `cq_pOilWI_5HRaH6ll9W2d` |
| PRF input | `fcfb4063bf395fdc94420956f179db678140eff05a60a0c776c8c81f3684fef5` |
| `slot` for PRF `11…11` | `2148b32b2ad12085df0d940c85855e97` |

Deterministic block ids (1.3), `b_` + the first 22 characters of base64url(SHA-256(source)):

| Source string | Block `ref` |
|---|---|
| `legacy-note:JHN.3.16-18` | `b_RvrIbWBdj2CJjUQr0YSxAq` |
| `margin-note:jhn.3.16` | `b_TDrZMPX9o3M850j5vPfZG0` |
| `margin-block:jhn.3.16:b1` | `b_ov1VgqE09EJDjwm9KQOu9s` |

### 10.1 Conformance

The `conformance/` folder checks an implementation against this spec. Passing it is necessary, not sufficient.

- `bun run conformance <base-url>` checks a server's library routes (section 5.4): CORS and preflights, claiming, wrong tokens, the POST limits, paging, replacing by id, `epoch`, DELETE, the error body and `Cache-Control`. It uses a fresh random key and deletes its library at the end. It doesn't check slots, the 8,000,000-character library limit, or anything outside `/v1/lib`.
- `conformance/fixtures.json` is for clients: pairs of versions with the one that wins (section 3), the `updated` an edit gets, when a server answer means a refill (5.6), and sync scenarios (two devices converging, a tie, a deletion spreading, a refill after a new epoch, an old version repaired) to replay with your client against a test server.

[docs/quickstart.md](docs/quickstart.md) walks through a first sync with the test-vector key.

## 11. Versioning

This is version 1.3. Every 1.x version keeps these working the same way:

- Records (section 1), the merge rule (3) and the writing rule for `updated`, except the **experimental** parts: `block` records (1.3), saved passages (1.6) and review history (1.7). Their fields and rules MAY change in a later 1.x without a 2.0 bump, until fixtures and a reference client stand behind them and a 1.x version drops the label. Their kind names (`block`, `passage`, `srs-log`) are final. Experimental does not mean optional encryption or a second merge rule: unaware clients still keep unknown kinds and fields (section 1) and apply section 3. Legacy `note` records are not experimental.
- Library files and their header, `"hidden-word": 2` (2).
- The sync key's text form (5.1), every HKDF info and length (5.2, 7.2), and how item ids, blobs, padding and slots are made (5.3, 7.2).
- The `/v1` routes, their status codes and response shapes (5.4, 7.2), and the minimum limits (5.5). A server may accept more, never less.
- Grants: the `/connect` fragment, the `g1.` token and the scopes (4), the unlock handoff (7.3, deprecated) and saving from a link (7.4).

**Breaking** means anything that makes a conforming 1.0 client or server stop working with another: removing or renaming a field, route or parameter, changing a response shape or status code, changing the merge rule, or changing any derivation. A breaking change needs version 2.0, with new routes under `/v2/` and new HKDF infos (`hidden-word/v2/…`), so 1.x clients and servers keep talking to each other.

**Compatible** changes may come in any 1.x version: new optional fields in records, headers or responses; new record kinds; new routes; new optional query parameters whose absence keeps today's behavior; and clarifications. So implementations MUST ignore response fields they don't know, and MUST keep record fields and kinds they don't know (section 1) and write them back unchanged.

**Deprecation.** A feature to be removed is first marked deprecated here, in a 1.x version, and keeps working for the rest of 1.x. It's removed only in 2.0.

Not covered: the reference web app's screens and storage, and the reference Worker's extras (`/mcp`, `/config.json`, `/api/client-error`).

## Changes from 1.2

Compatible (section 11): a 1.2 client or server is a 1.3 one for wire routes and encryption, and keeps the new kinds as kinds it doesn't know. The three new kinds are experimental (11).

- Saved passages (1.6): a `passage` record keyed by canonical reference, the core that everything else attaches to, with the rules any extension follows.
- Outliner notes (1.3): `block` records (`outline`, `parent`, fractional `rank`, plain `text`, optional `passage` and `card`). Legacy `note` records keep working, with rules for a note and its migrated block. Margin import details in `docs/notes-import.md`.
- Review history (1.7): single-writer `srs-log` buckets per device and day, events as compact arrays with per-app columns, and a card's place in the deck worked out from its events. Scheduler state stays on the device.
- Grant scopes `passages:write`, `notes:write` and `srs:write` (4.2); any write scope mints `mk`; consent says the server can't filter by kind.
- Highlights, colors and the library's name are unchanged.

## Changes from 1.1

- One way for apps to work with a library: connect with a grant (section 4), with the highlights API in the reference grant client. The key handoff (7.3) is deprecated.
- A library syncs through its server only, and library files are a personal backup (2, 6).

## Changes from 1.0

Compatible (section 11): a 1.0 client or server is a 1.1 one.

- How apps write and show ranges of verses (1.2, "Ranges in apps"), with vectors in `test/ranges-vectors.json`. Storage is unchanged: one record per verse. A push keeps one edit's records in one POST when they fit (5.6).

- The library's name syncs as a record, `{"kind":"library","ref":"name","name":…}` (section 1.5). A file's header `name` follows it, and passkey slot names give way to it (2, 7.2). A 1.0 app keeps the record as a kind it doesn't know.
- Client fixtures for it in `conformance/fixtures.json`.

## Changes from 0.2

No wire changes: a 0.2 client or server is a 1.0 one.

- The versioning promise (section 11) and a conformance suite (10.1).
- Clarified to match the reference implementation: `updated` must be a safe integer to count (section 3); the merge compares UTF-8 bytes; a POST that repeats an id keeps the later one, and the push shortcut counts distinct ids (5.4, 5.6); `after` must be a non-negative integer; preflights allow `Authorization` and `Content-Type`.
- The MCP endpoint is named as optional and outside the spec (section 9).

## Changes from 0.1

- One merge rule (section 3) decides every conflict, on every device. Servers no longer decide by arrival order.
- Servers report `seq` and `epoch`, and clients refill a server that lost data.
- Colors can be named and added (section 1.4). Bookmarks are gone.
- Files have an optional header line.
- Rules that protect people's data (section 6), and route.bible links (section 8).
- Password-manager saving uses a real form submission that sends nothing (section 7.1). Saving from a link (section 7.4).
