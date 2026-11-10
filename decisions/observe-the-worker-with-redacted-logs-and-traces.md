# Observe the Worker with redacted logs and traces

Date: 2026-11-03

## Status

Accepted

## Context

With observability completely disabled, server 5xx errors, slow routes, and broken pages in users' browsers go unseen. At the same time, telemetry must never record session or OAuth tokens (`sv2.<userId>.<secret>`), email OTP codes, email addresses, Scripture references, or user-written notes and quotes.

Cloudflare provides Workers Logs (custom structured lines plus optional automatic invocation logs), Workers Traces, Workers Issues, Workers Metrics, and live `wrangler tail`.

## Decision

- Enable Workers Logs with `invocationLogs: false`. The Worker emits one structured `request` line per request (`src/observe.ts`): HTTP method, route template (for example `/v2/events` or `/mcp`), status code, duration (`ms`), and on failure the error class plus a scrubbed error message. Disabling automatic invocation logs prevents raw URLs and headers from being logged.
- Enable Workers Traces (`headSamplingRate: 1`), `redactQueryString: true`, and Workers Issues in `cloudflare.config.ts`.
- Expose a same-origin browser error endpoint (`public/report.js` -> `POST /api/client-error`) that records error class, scrubbed message, and same-origin `path:line:col` stack frames, capped at 4 KB per payload, 5 reports per page load, and 30 per minute per Worker isolate.
- Scrub tokens, email addresses, USFM references, and quoted text in both `public/report.js` and `src/observe.ts` (verified by `test/observe.test.ts`).

## Consequences

- Cloudflare retains short-window operational logs and traces (`LibraryDO` RPCs, D1 auth queries without bound parameters, R2 calls, and asset fetches) with zero `sv2.` tokens, OTP codes, query strings, or note bodies.
- Because `/v2/*` and `/mcp` carry `userId` inside the `Authorization` header or `selah_session` cookie rather than the URL path, logged route templates never expose user IDs.
- Operational queries and cost bounds are documented in [docs/observability.md](../docs/observability.md).
