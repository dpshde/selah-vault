# Decisions

Architecture decision records for Selah Vault (formerly Hidden Word), in the [Michael Nygard format](https://github.com/architecture-decision-record/architecture-decision-record/tree/main/locales/en-001/templates/decision-record-template-by-michael-nygard): status, context, decision, consequences. Each file holds one decision and is named with an imperative phrase, following the [architecture-decision-record](https://github.com/architecture-decision-record/architecture-decision-record) conventions.

To change a decision, write a new record and mark the old one `Superseded by …`. Facts that arrive later can be added to a record under a dated "Update" heading.

## Shared selah.tools ADRs

Cross-cutting architecture decisions for the selah.tools family (vault interop, E2E encryption, shared verse ranges, USFM refs, grab-bcv, route.bible links, deploy map, SRS progress, outliner notes) live in the **selah tools** Cursor Project Agent Store at `/cursor/stores/self/docs/adrs/INDEX.md`. That store copy is canonical. Add a shared ADR there when a decision affects more than one app (for example vault ↔ route.bible). Keep vault-only decisions in this folder. Readable GitHub mirrors of recent shared ADRs (0008 SRS, 0009 outliner blocks) live under [`docs/adr/`](../docs/adr/).

| Decision | Status | Date |
|---|---|---|
| [Keep the library on the device first](keep-the-library-on-the-device-first.md) | Accepted | 2026-11-02 |
| [Identify passages with USFM references](identify-passages-with-usfm-references.md) | Accepted | 2026-11-02 |
| [Store libraries as readable JSON Lines](store-libraries-as-readable-json-lines.md) | Accepted | 2026-11-02 |
| [Resolve conflicts with one merge rule](resolve-conflicts-with-one-merge-rule.md) | Accepted | 2026-11-02 |
| [Sync through a server that can't read the library](sync-through-a-server-that-cannot-read-the-library.md) | Accepted | 2026-11-02 |
| [Detect server data loss with an epoch](detect-server-data-loss-with-an-epoch.md) | Accepted | 2026-11-02 |
| [Unlock with a sync key kept in the password manager](unlock-with-a-sync-key-kept-in-the-password-manager.md) | Accepted | 2026-11-02 |
| [Use colors as categories instead of bookmarks](use-colors-as-categories-instead-of-bookmarks.md) | Accepted | 2026-11-02 |
| [Derive route.bible links instead of storing them](derive-route-bible-links-instead-of-storing-them.md) | Accepted | 2026-11-02 |
| [Host the server on Cloudflare Workers and D1](host-the-server-on-cloudflare-workers-and-d1.md) | Accepted | 2026-11-02 |
| [Build the web app without a framework](build-the-web-app-without-a-framework.md) | Accepted | 2026-11-02 |
| [Typecheck with tsrs](typecheck-with-tsrs.md) | Accepted | 2026-11-02 |
| [Parse references with grab-bcv](parse-references-with-grab-bcv.md) | Accepted | 2026-11-02 |
| [Save highlights from a GET link](save-highlights-from-a-get-link.md) | Accepted | 2026-11-02 |
| [Offer 1Password's save button](offer-1password-s-save-button.md) | Accepted | 2026-11-02 |
| [Show verse text from YouVersion on request](show-verse-text-from-youversion-on-request.md) | Accepted | 2026-11-03 |
| [Serve an MCP server that opens a library with its sync key](serve-an-mcp-server-that-opens-a-library-with-its-sync-key.md) | Accepted | 2026-11-03 |
| [Observe the Worker with redacted logs and traces](observe-the-worker-with-redacted-logs-and-traces.md) | Accepted | 2026-11-03 |
| [Promise a stable 1.0 contract](promise-a-stable-1-0-contract.md) | Accepted | 2026-11-03 |
| [Write and group ranges in the client, not the server](write-and-group-ranges-in-the-client-not-the-server.md) | Accepted | 2026-11-04 |
| [Sync the library's name as a record](sync-the-library-s-name-as-a-record.md) | Accepted | 2026-11-03 |
| [Style the app like route.bible](style-the-app-like-route-bible.md) | Accepted | 2026-11-03 |
| [Rename the product to Selah Vault](rename-product-to-selah-vault.md) | Accepted | 2026-11-03 |
| [One way to interoperate](one-way-to-interoperate.md) | Accepted | 2026-11-04 |
