# Keep a record for each saved passage

Date: 2026-11-09

## Status

Accepted. Experimental in SPEC 1.3 (section 11). Shared with other selah.tools apps: also filed in the shared ADR log.

## Context

Notes and review history both hang off a verse or a range, and nothing in the library said "this passage is one of mine". Notes carried an optional `passage` field. Review events carried a card key. A deck could only be guessed from which cards had events, so a passage saved but not yet reviewed existed nowhere. Per-card settings sat on an optional `srs-card` record keyed by a minted id, which two devices saving the same verse would mint differently.

Highlights don't fill the gap. A highlight is one record per verse (SPEC.md 1.2) and a range is something apps derive by grouping, so "the range I saved" has no identity there.

## Decision

- A saved passage is a record, `{"kind":"passage","ref":<canonical reference>,…}` (SPEC.md 1.6). Its identity is the reference: a chapter, a verse or a range.
- The record is the core of a library and stays small: a reference and when it was saved. Saved means the person chose it; a curriculum that contains a verse doesn't save it.
- Everything done with a passage is an extension that keeps its own records and points at the passage (SPEC.md 1.6, "Extending a passage"). An extension uses one of three shapes: one record per thing, a log per device, or a small rarely-written field under `apps.<appId>`. Its records stand alone when the passage is missing, and nothing cascades when a passage is removed.
- Notes and review history are the two extensions the spec defines. An app adds its own under `x-<appId>` without a spec change.
- Notes attach with a block's `passage` field. Review history attaches with card keys built from the reference and a unit (`JHN.3.16#text`).
- `srs-card` is removed before anything shipped it. Whether a card is in the deck, suspended or dropped is worked out from review events, and so is any state that follows from history.
- Overlapping passages (a verse and a range holding it) stay separate records.
- A new scope, `passages:write`, covers the kind.

## Consequences

- Two devices that save the same passage while apart write the same `kind` and `ref`, so the merge rule leaves one record and one schedule.
- Removing a passage hides nothing else: its notes and review events stay, and saving it again brings the history back.
- An app that builds a deck from highlights now has to write a `passage` record when a person takes a range up.
- Two apps never write the same record for their own state, so they can't overwrite each other.
- The vault spec doesn't grow with each new use of a passage. What an app asks, grades and counts is specified by the app.
- One more item per saved passage against the library's limits.
