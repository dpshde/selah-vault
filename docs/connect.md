# Connect an App: OAuth 2.1 + PKCE

Connected apps (`route.bible`, `Proofs` Web & iOS, and local tools) read and write a person's Selah Vault library using standard **OAuth 2.1 Authorization Code + PKCE (`S256`)** ([SPEC 2](../SPEC.md#2-connecting-an-app-oauth-21--pkce)).

## 1. Start Authorization

Generate a PKCE `codeVerifier` + `S256` `codeChallenge` and a random `state`, keep them in `sessionStorage`, and send the browser to `/oauth/authorize` (or `/connect`):

```js
import { buildAuthorizeUrl, createOAuthState, createPkce } from "./grant-client.js";

const { codeVerifier, codeChallenge } = await createPkce();
const state = createOAuthState();
sessionStorage.setItem("selah.pkce", JSON.stringify({ codeVerifier, state }));

location.assign(
  buildAuthorizeUrl({
    vault: "https://vault.selah.tools",
    clientId: "proofs",
    redirectUri: `${location.origin}/oauth/callback`,
    scope: "read passages:write srs:write",
    codeChallenge,
    state,
  }),
);
```

Allowed `redirect_uri` values:
- Allowlisted HTTPS origins in `CLIENTS` (`public/grants.js`): `https://route.bible`, `https://www.route.bible`, `https://proofs.selah.tools`, `https://proofs.dpshade.workers.dev`, `https://vault-highlights-route-bible.dpshade.workers.dev`
- route.bible Workers previews matching `ROUTE_PREVIEW_ORIGIN_RE`: `https://route-bible.dpshade.workers.dev`, `https://<branch>-route-bible.dpshade.workers.dev`, `https://route-bible-preview.dpshade.workers.dev`. Their `client_id` is the preview hostname.
- Native iOS custom scheme: `proofs://oauth/callback`
- Any loopback origin: `http://localhost:<port>/*` or `http://127.0.0.1:<port>/*`

Available scopes: `read`, `highlights:write`, `passages:write`, `notes:write`, `srs:write`.

## 2. Exchange the Code for an `sv2` Token

When the user approves on `/connect`, Selah Vault redirects to `<redirect_uri>?code=<code>&state=<state>` (or `?error=access_denied&state=<state>` on cancel). Exchange `code` at `POST /oauth/token` (CORS `*` is enabled for browser SPAs):

```js
import { GrantClient, exchangeCode, parseOAuthCallback } from "./grant-client.js";

const cb = parseOAuthCallback(location.search);
const saved = JSON.parse(sessionStorage.getItem("selah.pkce") ?? "null");
if (cb.error || !saved || cb.state !== saved.state) throw new Error(cb.error || "state_mismatch");

const tokenResponse = await exchangeCode({
  vault: "https://vault.selah.tools",
  clientId: "proofs",
  redirectUri: `${location.origin}/oauth/callback`,
  code: cb.code,
  codeVerifier: saved.codeVerifier,
});
// tokenResponse: { access_token: "sv2.u_....", token_type: "Bearer", expires_in: 7776000, scope, user }

const vault = await GrantClient.open({ vault: "https://vault.selah.tools", ...tokenResponse });
```

## 3. Sync, Read, Write & Live WebSocket Pokes

```js
// Initial call hydrates from GET /v2/bootstrap; subsequent calls pull GET /v2/events?after=<cursor>
const { upserts, deletions, passages, colors, next, reset } = await vault.changes(savedCursor);

vault.highlights({ group: "ranges" });            // grouped contiguous verse runs
await vault.highlightRange("ROM.5.3-5", "green"); // requires highlights:write
await vault.remove(["ROM.5.4"]);                  // requires highlights:write
await vault.savePassage("JHN.3.16-18");           // requires passages:write
await vault.appendEvents([                        // requires srs:write
  { kind: "srs.reviewed", ref: "JHN.3.16-18", data: { cardKey: "JHN.3.16-18#text", rating: 3, rung: "R2" } },
]);

// Listen for real-time commits across devices via /v2/ws:
const stopWs = vault.connectWebSocket(() => vault.changes(vault.state.seq));

// Disconnect and revoke the 90-day grant token:
await vault.disconnect();
```
