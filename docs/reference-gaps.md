# Reference code gaps for SPEC 1.3 (notes + SRS)

SPEC 1.3 adds `block`, `srs-log`, `srs-card`, and scopes `notes:write` / `srs:write`.
The reference web app and grant client on this branch do **not** implement those yet.
Shipping production clients that write the new kinds needs the same-release changes
below. This document is the checklist; this PR is docs-only.

## Required same-release changes

| Area | File | Gap today | Required change |
|---|---|---|---|
| Backup import | `public/sync.js` `checkRecord` | Rejects unknown non-`x-` kinds, so `merge()` / file import **drops** `block` and `srs-*` records (already violates SPEC §1 “MUST keep”) | Accept `block`, `srs-log`, `srs-card` (and keep unknown kinds, or at least all non-validated kinds with `kind`+`ref`) |
| Connect scopes | `public/grants.js` `SCOPES` / `parseScopes` | Unknown scopes → null → error page | Add `notes:write` and `srs:write` with consent labels that warn write is honor-system by kind |
| Consent / `mk` | `public/connect.js` | Mints `mk` only when scopes include `highlights:write` | Mint `mk` when **any** write scope is granted |
| Consent copy | `public/grants.js` `consentLines` | “Can't change…” assumes only highlights write | Reflect any write scope; describe that the server cannot filter by kind |
| Grant client | `public/grant-client.js` `canWrite` | True only for `highlights:write` | True when any write scope is present and `mk` is available; callers still restrict which kinds they POST |

## Client fallback (until sites upgrade)

A 1.3 app that asks a 1.2 `/connect` for `notes:write` or `srs:write` gets a rejected
scope list. Apps SHOULD:

1. Detect the failure,
2. Retry with scopes the site understands, and/or
3. Use the sync key (person's own devices) when grant scopes are insufficient.

Do not assume `mk` is present without a write scope on older sites.

## Out of scope for the docs PR

No edits to `sync.js`, `grants.js`, `connect.js`, or `grant-client.js` in PR #37.
