# Reference code gaps for SPEC 1.3 (saved passages, notes, review history)

SPEC 1.3 adds the kinds `passage`, `block`, `srs-log` and `srs-archive`, and the scopes
`passages:write`, `notes:write` and `srs:write`. All four kinds are experimental
(SPEC §11). The reference web app and grant client don't implement them yet. A client
that writes the new kinds in production needs the changes below in the same release.

## Done

- **Backup import keeps later kinds.** `Library.merge` used to drop any record whose kind it didn't know, so restoring a backup lost `passage`, `block` and `srs-log` records. It now keeps a well-formed record of an unknown kind, as the server receive path always did. `test/later-kinds.test.ts` checks import, a backup round trip and two-device sync, and that what a pre-1.3 app shows doesn't change.

## Required changes

| Area | File | Gap today | Required change |
|---|---|---|---|
| Connect scopes | `public/grants.js` `SCOPES` / `parseScopes` | Unknown scopes → null → error page | Add `passages:write`, `notes:write` and `srs:write` |
| Consent / `mk` | `public/connect.js` | Mints `mk` only when scopes include `highlights:write` | Mint `mk` when **any** write scope is granted |
| Consent copy | `public/grants.js` `consentLines` | "Can't change…" assumes only highlights write | Reflect any write scope; say that the server cannot filter by kind |
| Grant client | `public/grant-client.js` `canWrite` | True only for `highlights:write` | True when any write scope is present and `mk` is available; callers still restrict which kinds they POST |
| Device id | `public/grant-client.js` | A grant app has no device id of its own, and nowhere to keep one | Mint one per install (9 random bytes, base64url) for `srs-log` and `srs-archive` refs (SPEC §1.7), and keep it with the grant so it survives a reload |
| Grant client API | `public/grant-client.js` | Only highlights have helpers (SPEC §4.3) | Helpers to read and write `passage`, `block`, `srs-log` and `srs-archive`: save and remove a passage, a passage's notes as a tree, append and push a day's events, fold, replay a card |

## Before the experimental label comes off

SPEC §11 keeps `block`, `passage`, `srs-log` and `srs-archive` experimental until a
reference client stands behind them.

In place now, as test code and fixtures only (`test/review-log.ts`,
`conformance/fixtures.json`, `test/review-log.test.ts`): deterministic block ids, the
Margin import, review-log replay with the card state table, folding into the archive,
and the storage budget in SPEC §1.7.

Still to write:

- A reference module for blocks: tree build, rank minting, cycle and orphan repair.
- A shipped reference module for the review log: append, split into parts, push per
  session, fold, and the copied-device-id rule.
- Fixtures for: tree build, a cycle, an orphan, a rank tie, an insert with no room, a
  legacy note and its block, a copied device id, the deck rule for block cards, and
  suspend and resume when a passage is removed and saved again.
- Scheduler vectors: a fixed log, pinned FSRS version and parameters, expected state.

## Client fallback (until sites upgrade)

A 1.3 app that asks a 1.2 `/connect` for a scope it doesn't know gets a rejected
scope list. Apps SHOULD:

1. Detect the failure,
2. Retry with scopes the site understands, and/or
3. Use the sync key (person's own devices) when grant scopes are insufficient.

Do not assume `mk` is present without a write scope on older sites.
