# WebMCP tools (in-page)

The web app registers three [WebMCP](https://github.com/webmachinelearning/webmcp) tools on
`document.modelContext`, so a browser agent can work with the library that is open in that tab.
Code: `public/webmcp.js`, registered from the end of `public/app.js`. Browsers without WebMCP
skip it entirely.

These are distinct from the remote MCP server at `/mcp`. Remote `/mcp` authenticates requests with
OAuth 2.1 `sv2.<userId>.<secret>` bearer tokens (`scopes` enforced in `LibraryDO`). In-page WebMCP
tools only act on a library the user has already signed in to on the page. They never read, return,
or ask for session cookies or tokens, and they do not modify sync settings or transports. Changes
go through the same local-first `Library` code as the UI buttons, so they sync like any other edit.

| Tool | What it does | Annotations |
| --- | --- | --- |
| `find_highlights` | Highlights in Bible order, optionally within a book or passage or one color, 12 per page, each with its color and a clipped quote. Also lists the library's color names. | `readOnlyHint`, `untrustedContentHint` (quotes and color names are user-written) |
| `add_highlight` | Highlights or recolors every verse of a reference as typed. Yellow by default. Shows the usual "Saved ... Undo" line. | none |
| `delete_highlights` | Removes the highlights in a reference here and, on their next sync, on other devices. Shows "Deleted ... Undo". | `consequentialHint` |

`schema.json` is the tool contract (a test keeps it identical to the code). `evals.json` is the
`webmcp-evals` suite: `bunx webmcp-evals local -t docs/webmcp/schema.json -e docs/webmcp/evals.json`
(needs a model provider key in `.env`).

## Goals & boundaries

1. **Save a verse** — highlights the requested verses in the requested color inside an open library. Never signs in, creates, or switches accounts, and never handles credentials or tokens.
2. **Find highlights** — returns a paged list filtered by book, passage, or color. Read-only.
3. **Remove a highlight** — deletes verse highlights across synced devices; marked `consequentialHint` so agents confirm first, with Undo shown in the UI.
4. *(Out of scope)* Account sign-in, passkeys, OAuth grants, export/import, and color definitions stay in the UI.

## Flows

- **Starting states:** signed-out screen or open library view. Calling any tool while signed out returns `LIBRARY_LOCKED`, instructing the agent to let the user sign in on the page with their passkey, email code, or Apple account and never share credentials in chat (eval 6).
- **Save:** "highlight Romans 8:28 in green" -> `add_highlight` -> `{status:"saved", reference:"Romans 8:28", color:"Green", verses:1}`. Variations: no color defaults to yellow; unknown color returns `COLOR_NOT_FOUND` so the agent inspects `find_highlights` colors (eval 7); invalid reference returns `NOT_A_REFERENCE`; over 500 verses returns the parser limit message.
- **Find:** "what have I highlighted in Romans?" -> `find_highlights({within:"Romans"})`. Supports book names, abbreviations (`rom`, `Ps 23`, `John 3`), and custom color names. Empty results return `total_count: 0` with a suggestion to widen the query.
- **Remove:** "remove my highlight in Psalm 23" -> `find_highlights`, then `delete_highlights` on the run's reference (eval 5). Unhighlighted passages return `NOTHING_HIGHLIGHTED`.

## Verification

- `test/webmcp.test.ts` (`mise run test`): exercises every tool against a real `Library`, covering the signed-out `LIBRARY_LOCKED` state, colors by name, Undo callbacks, book and passage filters, pagination, the 1,500-character output budget, schema parity with `docs/webmcp/schema.json`, and credential leak checks.
