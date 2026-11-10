# Save highlights from a GET link

Date: 2026-11-02

## Status

Accepted

## Context

Most Bible apps can open a URL but will never implement Selah Vault. A plain link lets any app, bookmarklet, shortcut or share sheet send a verse with no integration work. The save must feel instant, and must not need the network.

## Decision

`GET /save?ref=<anything>&color=<id or name>` is served by the web app (the worker hands it the app's page). The app reads `ref` with grab-bcv, saves the verses into the library open in that browser, on the device first, and shows "Saved John 3:16 in Blue" with Undo. Syncing follows in the background. If no session is open yet, the request waits in `sessionStorage` while the person signs in, then saves. `SPEC.md` section 4 describes it.

## Consequences

- One URL format works from anything that can open a link.
- Saving uses the cached library, so it's instant and works offline once the page is cached by the browser.
- A link can't choose an account or carry credentials or tokens: it only acts on the library the person has already signed in to in that browser, and the page can't be framed, so every save is visible and undoable.
- Because it's a GET, a link opened by mistake saves a highlight. Undo covers that.
