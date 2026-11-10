# selah-jev

Stateless Cloudflare Worker that proxies Selah Vault's highlight-relevance requests to TypeSafe `jev-latest`. Deployed on its own; the `selah-vault` Worker does not call it.

## Request

`POST /` with JSON `{ lib, passage: { ref, text }, highlights: [{ id, ref, text }, …] }` from the vault origin only. Other shapes are refused.

Upstream call uses `Authorization: Bearer …`, `Content-Type` / `Accept: application/json`, and `User-Agent: selah-jev/1.0`. On a non-ok TypeSafe response the Worker answers **502** with `{ error, upstream_status, upstream_body }` (`upstream_body` is scrubbed and capped at 300 chars) and `console.log`s the same for Workers Observability.

## Secrets and bindings

- `TYPESAFE_API_KEY` — `wrangler secret put TYPESAFE_API_KEY` (never commit)
- `CAPS` — KV namespace for the $0.25/day spend counter and per-library rate limit

See `wrangler.toml` for reference. Deploy happens elsewhere.

## Bundle (upload without wrangler deploy)

From the repo root:

```bash
bunx wrangler deploy -c workers/selah-jev/wrangler.toml --dry-run --outdir /tmp/selah-jev-bundle
```

Upload `worker.js` (and any accompanying modules) from that outdir through the Cloudflare API.
