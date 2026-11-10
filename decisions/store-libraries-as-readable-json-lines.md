# Store libraries as readable JSON Lines

Date: 2026-11-02

## Status

Accepted

## Context

Backups must be portable to any language and inspectable without special software. A person should be able to open an exported library in a text editor, search it with `grep` or `jq`, or commit it to git without installing Selah Vault or any proprietary reader.

## Decision

A Selah Vault backup file (`GET /v2/export`, `POST /v2/import`, `Library.toFile()`) is UTF-8 JSON Lines (`.jsonl`) with one JSON object per line:

- Line 1 is an optional metadata header: `{"selah-vault":2,"library":"u_...","name":"Personal","exportedAt":1793000000000}`.
- Every subsequent line is a `VaultEvent` JSON object (`id`, `ts`, `app`, `kind`, `ref`, `tags`, `data`), identical to the objects exchanged over `/v2/events`.
- Importing a `.jsonl` file (`POST /v2/import` or `Library.merge()`) deduplicates events by `id` (`INSERT OR IGNORE`) and applies them through the standard `(ts, id)` projector. `Library.merge()` also converts legacy record-shaped lines (`kind: "highlight" | "note" | "color" | "passage" | "library"`) into `VaultEvent` items so older backups import cleanly.

## Consequences

- Any line-oriented JSON parser can read, filter, or diff a library backup.
- Export, import, and `/v2/events` share the exact same `VaultEvent` schema and projector rules.
- Because `event.id` is preserved across export and re-import, importing the same backup twice is strictly idempotent.
