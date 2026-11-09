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
- Each device owns its buckets: `ref` is `{deviceId}/{yyyy-mm-dd}`, one per local day, split as `/{n}` at 16 KiB. One writer per ref makes the ordinary merge rule correct. An earlier day's bucket is closed and never changes. A bucket carries the device's UTC offset, so a streak replays the same anywhere.
- A day, not a month, because the server replaces whole items: every push sends the whole bucket again. Clients push once a session, not once a review, which also keeps what the server sees of a person's habits coarse.
- A bucket holds a table of card keys, a table of column names, and events as arrays, `[card index, time, what, …column values]`. An event's id is its bucket's ref and its index, so none is stored. An event is about 19 bytes.
- `what` is a rating `1`–`4` or one of `add`, `suspend`, `resume`, `drop`, `reset`. Replay orders events by time, then bucket ref, then index, runs a small state table to say whether a card is in the deck, and drops every review before a card's last reset.
- Columns are named `x-<appId>-<name>` and hold what an app records about a review. The spec defines none: the form of a question, hints and accuracy are the app's. An app builds its statistics and its own history-dependent state from them by replay.
- Times are whole seconds, rounded down, and the writer's own scheduler is fed the stored value.
- Units are a small vocabulary (`text`, `ref`) plus `x-<appId>-<name>`. A cloze block is one card per hole. A card that is not a passage or a block is keyed `x-<appId>:<id>`. A passage card needs no saved passage.
- Each app install mints its own device id. A writer starts from the winning version of its own bucket and re-appends what it lacks, and an install that finds events it never wrote in its bucket mints a new id.
- No compaction. Moving events between buckets under the same size limit frees nothing.
- The kind name is final now. A later rename would change every item id.

## Consequences

- Measured: 50 reviews a day, each of a different card, is about 1,000,000 blob characters a year. Half of a minimum library holds about four years of that, and under a year and a half at three times the pace. A summary that replaces old events is left for a later version; until then the lever is a server that gives a library more than the minimum.
- A card key is paid once per bucket, so daily buckets cost more than monthly ones when the same cards come round within a month. That buys pushes that are about thirty times smaller.
- A client that doesn't know the kind can't lose another device's reviews by pushing a stale record.
- Every client replays across every device's buckets, and needs shared vectors to agree on the result.
