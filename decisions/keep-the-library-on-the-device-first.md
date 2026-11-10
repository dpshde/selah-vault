# Keep the library on the device first

Date: 2026-11-02

## Status

Accepted

## Context

Selah Vault exists so that Bible passages, highlights, notes, and study cards follow a person between apps and devices. People read offline (on planes, in church, with no signal) and expect what they mark there to stay marked immediately without waiting on a server round-trip.

## Decision

The copy on the device is a first-class library (`public/sync.js`). Every read and write applies to the local projected state and local event outbox first, and the UI never blocks on the network to show or save a change. Sync through `LibraryDO` (`/v2/bootstrap`, `/v2/events`, `/v2/ws`) runs asynchronously in the background, and a library used purely offline is complete:

- An app never deletes local state merely because the network is unreachable or fails. Only an explicit removal event (`highlight.removed`, `passage.removed`, `color.removed`, `note.block.deleted`) removes an item.
- Events appended offline persist in the local outbox across browser restarts until `POST /v2/events` acknowledges them.
- Network requests time out after 20 seconds and retry automatically on subsequent edits, reconnects, or WebSocket pokes.
- Readable `.jsonl` export is always available locally (`Library.toFile()`).

## Consequences

- Server outages or offline sessions never block reading, highlighting, or note-taking, and never lose local edits.
- Every client runs the deterministic `(ts, id)` event projector ([Model the library as an append-only event log](model-the-library-as-an-append-only-event-log.md)) so local optimistic state and `LibraryDO` state converge identically.
- The main library header stays quiet during normal sync; sync status, connected OAuth apps, passkeys, and account erasure live in the Sync dialog opened from the menu.
