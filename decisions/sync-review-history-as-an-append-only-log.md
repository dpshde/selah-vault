# Sync review history as an append-only log

Date: 2026-11-09

## Status

Accepted. Experimental in SPEC 1.3 (section 11). Shared with other selah.tools apps: filed in the shared ADR log as 0008.

## Context

Proofs, and later other apps, need a person's review history on every device. Scheduler state kept per device drifts apart. Syncing scheduler state as records doesn't work either: it depends on the scheduler's parameters, so two clients with different parameters rewrite each other's records without end.

A log shared between devices under one ref needs a set-union merge, which the one merge rule (SPEC.md 3) doesn't do and which a 1.2 client would never apply. A bucket per card per month runs through the library's item limit.

Size decides the rest. A full 16 KiB item is about 21,900 blob characters, so a library's 8,000,000 characters hold about 365 full items. Events written as objects with their own ids ran to about 150 bytes: about 100 an item, about 36,500 reviews for a whole library and every device in it. Proofs reviews several units per verse, so that is about two years of use.

## Decision

- An append-only `srs-log` is the truth (SPEC.md 1.7). Scheduler state is a local cache rebuilt by replay, and is never synced.
- Each device owns its buckets, one per local day. A bucket's `ref` is `{deviceId}/{slot}`: the slot is only a place, and the day is the bucket's `date` field, with a `part` number when a day outgrows 16 KiB. One writer per ref makes the ordinary merge rule correct. An earlier day's bucket is closed. A bucket carries the device's UTC offset, so a streak replays the same anywhere.
- A day, not a month, because the server replaces whole items: every push sends the whole bucket again. Clients push once a session, not once a review, which also keeps what the server sees of a person's habits coarse.
- A bucket holds a table of card keys, a table of column names, and events as arrays, `[card index, time, what, …column values]`. An event needs no id: it is the one at that index, in that part, of that date, from that device. An event is about 19 bytes.
- `what` is a rating `1`–`4` or one of `add`, `suspend`, `resume`, `drop`, `reset`. Replay orders events by time, then device id, then the order the device wrote them, runs a small state table to say whether a card is in the deck, and drops every review before a card's last reset. State an app derives from its columns, such as a ladder rung, restarts at the same reset.
- Columns are named `x-<appId>-<name>` and hold what an app records about a review. The spec defines none: the form of a question, hints and accuracy are the app's. An app builds its statistics and its own history-dependent state from them by replay.
- Times are whole seconds, rounded down, and the writer's own scheduler is fed the stored value.
- Units are a small vocabulary (`text`, `ref`) plus `x-<appId>-<name>`, and each unit of a passage is its own card with its own schedule. A cloze block is one card per hole. A card that is not a passage or a block is keyed `x-<appId>:<id>`. A passage card needs no saved passage.
- Each app install mints its own device id. A writer appends only when the winning version of its bucket is the one it last wrote. Otherwise the id has been copied: it leaves those records alone, mints a new id, and writes what the winners lack under it.
- Removing a saved passage suspends its cards and saving it again resumes them. The history is kept.
- A block's card is in the deck when the block is live, its `card` names the card, and the log hasn't suspended or dropped it.
- A device folds its closed buckets into a yearly archive, `srs-archive` with `ref` `{deviceId}/{yyyy}/{n}`. A chunk is written once. It keeps one card table for the device's year across chunks, times as differences, and each day's date and offset. The chunk and the deletions of the buckets it folded go in one POST, and the freed slots are used again.
- A reader leaves out a bucket whose device and date a chunk already holds. That, not a stored event id, is what keeps an event from counting twice: it costs nothing per event, and it also covers a bucket that comes back from an old backup.
- Slots are reused instead of leaving a deleted record per day, because a deleted record still costs an item and 379 blob characters for good: about 138,000 characters and 365 items per device per year, which would have been a third of the archived total.
- Both kind names are final now. A later rename would change every item id.

## Consequences

- Measured, per device (pinned by `test/review-log.test.ts`): 50 reviews a day is about 1,000,000 blob characters a year as day buckets and about 310,000 archived; 150 a day with columns is about 3,200,000 and 1,070,000. Half of a minimum library holds about four years of the heavier pace archived, where unfolded it would fill the whole library in two and a half.
- The log is still finite. The next lever is a server that gives a library more than the minimum.
- A card key is paid once per day bucket and once per year in the archive, so small pushes and compact storage no longer pull against each other.
- A client that doesn't know the kind can't lose another device's reviews by pushing a stale record.
- Every client replays across every device's buckets, and needs shared vectors to agree on the result.
