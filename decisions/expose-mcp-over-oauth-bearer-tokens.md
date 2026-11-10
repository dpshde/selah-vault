# Expose MCP over OAuth bearer tokens

Date: 2026-11-10

## Status

Accepted

## Context

Desktop and hosted AI assistants (Claude, Cursor, and custom MCP clients) benefit from reading a person's saved passages, highlights, colors, and notes and writing new highlights or notes on request. Requiring users to paste raw long-lived master credentials into MCP configuration files creates unrevocable, unscoped access. Standard MCP remote servers instead pair Streamable HTTP JSON-RPC with OAuth 2.1 bearer tokens and RFC 8414 authorization server metadata discovery.

## Decision

Serve a stateless Streamable HTTP Model Context Protocol endpoint at `POST /mcp` (`src/mcp/index.ts`):

1. **RFC 8414 discovery & `WWW-Authenticate`:** Unauthenticated or expired requests return HTTP `401` with `WWW-Authenticate: Bearer realm="selah-vault", authorization_uri="<origin>/.well-known/oauth-authorization-server", resource_metadata="<origin>/.well-known/oauth-authorization-server"`, pointing MCP clients to `GET /.well-known/oauth-authorization-server` for OAuth 2.1 + PKCE (`S256`) authorization (`/oauth/authorize` and `/oauth/token`).
2. **Zero-hop `LibraryDO` execution:** Valid `Authorization: Bearer sv2.<userId>.<secret>` requests verify the token hash and OAuth scopes inside `LibraryDO` without touching D1, then read materialized views (`GET /v2/bootstrap`, `GET /v2/search`) and append scoped `VaultEvent` items (`POST /v2/events`).
3. **Shared parsing & range grouping:** `/mcp` imports `public/passage.js` (`grab-bcv`) and `public/ranges.js` directly so reference parsing and contiguous highlight grouping match the web app and `route.bible` byte-for-byte.

## Consequences

- Assistants obtain least-privilege, 90-day revocable tokens (`read`, `highlights:write`, `notes:write`, `passages:write`) through `/connect` without ever seeing user credentials.
- Every write through `/mcp` appends normal `VaultEvent` rows in `LibraryDO` and broadcasts `/v2/ws` pokes to open browsers and connected apps immediately.
