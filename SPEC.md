# Selah Vault, version 2.0

> Thy word have I hid in mine heart, that I might not sin against thee. (Psalm 119:11)

Selah Vault is a shared Bible library for passages, highlights, outliner notes, and spaced-repetition study across devices and apps.

Each user owns one isolated SQLite Durable Object (`LibraryDO`) holding an append-only event log (`events`), materialized views, and full-text note search (`FTS5`). First-party devices sign in with WebAuthn passkeys, Sign in with Apple, or a 6-digit email code. Connected apps (`route.bible`, `Proofs`, and MCP assistants) connect through standard **OAuth 2.1 Authorization Code + PKCE (`S256`)**.

The key words MUST, SHOULD, and MAY are used as in RFC 2119.

---

## 1. Identity, Tokens & Zero-Hop Routing

Every session token and OAuth 2.1 access token shares one self-routing format:

```
sv2.<userId>.<secret>
```

- `userId`: `"u_"` followed by 22 base64url characters (`^u_[A-Za-z0-9_-]{22}$`).
- `secret`: 43 base64url characters representing 32 random bytes (`^[A-Za-z0-9_-]{43}$`).
- First-party web sessions also set an `HttpOnly; Secure; SameSite=Lax; Path=/` cookie `selah_session=sv2.<userId>.<secret>` (`Secure` omitted on loopback `http://localhost` / `http://127.0.0.1` for local development).
- **Zero-hop Durable Object routing:** On any `/v2/*` or `/mcp` request, the Worker extracts `<userId>` from `Authorization: Bearer sv2.<userId>.<secret>` or `selah_session` and routes directly to `env.LIBRARY.get(env.LIBRARY.idFromName(userId))` with zero D1 round-trips. `LibraryDO` hashes `<secret>` with SHA-256 and checks its local SQLite `tokens` table (`expires_at > now`).

### 1.1 First-Party Authentication (`/auth/*`)

The global D1 database (`selah-vault-auth`) stores only identity directory tables (`users`, `passkeys`, `auth_challenges`, `oauth_codes`):

1. **WebAuthn Passkeys (`ES256` / P-256):** `POST /auth/passkey/register/options`, `POST /auth/passkey/register/verify`, `POST /auth/passkey/login/options`, `POST /auth/passkey/login/verify`. Standard discoverable P-256 credentials work across iCloud Keychain, 1Password, Google Password Manager, Safari, Chrome, and Firefox without WebAuthn extensions.
2. **Sign in with Apple:** `POST /auth/apple` verifies Apple's RS256 OIDC `id_token` against `https://appleid.apple.com/auth/keys` via WebCrypto.
3. **Email 6-digit OTP:** `POST /auth/email/send` issues a short-lived hashed 6-digit code; `POST /auth/email/verify` redeems it.
4. **Session inspection & sign-out:** `GET /auth/me` returns `{ user: { id, email, name } }`; `POST /auth/logout` revokes the current session token and clears `selah_session`.

---

## 2. Connecting an App: OAuth 2.1 + PKCE

Apps never handle first-party credentials. Every connected app obtains a scoped 90-day `sv2` access token via OAuth 2.1 Authorization Code + PKCE (`S256`), discovered via `GET /.well-known/oauth-authorization-server`.

### 2.1 Allowed Clients

- `https://route.bible` and `https://vault-highlights-route-bible.dpshade.workers.dev` (`client_id`: `"route.bible"` or origin)
- `https://proofs.selah.tools` and `https://proofs.dpshade.workers.dev` (`client_id`: `"proofs"`, `"proofs-web"`, or origin)
- `proofs://oauth/callback` (`client_id`: `"proofs"` or `"proofs-ios"`)
- Loopback `http://localhost:<port>/*` and `http://127.0.0.1:<port>/*` (local development and desktop MCP clients)

### 2.2 Scopes

| Scope | Permitted Operations |
|---|---|
| `read` | `GET /v2/bootstrap`, `GET /v2/events`, `GET /v2/search`, `GET /v2/ws` |
| `passages:write` | Append `passage.*` events to `POST /v2/events` |
| `highlights:write` | Append `highlight.*` and `color.*` events to `POST /v2/events` |
| `notes:write` | Append `note.*` events to `POST /v2/events` |
| `srs:write` | Append `srs.*` events to `POST /v2/events` |

No OAuth grant can delete a library (`DELETE /v2/library`), list or revoke other apps' grants (`GET /v2/grants`), or modify sign-in methods.

### 2.3 Authorization, Token Exchange & Revocation

1. **Consent UI (`GET /oauth/authorize` or `GET /connect`):** Accepts `client_id`, `redirect_uri`, `response_type=code`, `scope` (space-separated, default `read`), `code_challenge` (43–128 base64url chars), `code_challenge_method=S256`, and `state` (8–128 `[A-Za-z0-9_.-]`).
2. **Decision (`POST /oauth/authorize`):** Authenticated by owner session. When `approve: true`, stores single-use `SHA-256(code)` (5-minute expiry) and returns `{ redirect_to: "<redirect_uri>?code=<code>&state=<state>" }`. When `approve: false`, returns `{ redirect_to: "<redirect_uri>?error=access_denied&state=<state>" }`.
3. **Token Exchange (`POST /oauth/token`, CORS `*`):** Accepts JSON or `application/x-www-form-urlencoded` `{ grant_type: "authorization_code", code, redirect_uri, client_id, code_verifier }`. Verifies `base64url(SHA-256(ascii(code_verifier))) === code_challenge`, mints a 90-day grant token in `LibraryDO`, and returns `{ access_token, token_type: "Bearer", expires_in: 7776000, scope, user: { id, name } }`.
4. **Revocation (`POST /oauth/revoke` or `DELETE /v2/grants/self`):** Revokes the caller's own grant token in `LibraryDO`. Owners list and revoke any grant via `GET /v2/grants` and `DELETE /v2/grants/:id`.

---

## 3. References, Event Envelope & Projector Rules

### 3.1 Canonical USFM References

Scripture references use the 66-book Protestant USFM canon and KJV versification without leading zeros (`JHN.3`, `JHN.3.16`, `JHN.3.16-18`, `JUD.1.3`). Single-chapter books include chapter `1`. Range end verses MUST exceed start verses.

### 3.2 Event Envelope (`VaultEvent`)

Every event appended to or read from `/v2/events` has this JSON shape:

```json
{
  "seq": 14,
  "id": "ev_q8Zr0aXv5Tg1234567890",
  "ts": 1793000000000,
  "app": "selah-vault",
  "kind": "highlight.set",
  "ref": "JHN.3.16",
  "tags": ["book:JHN"],
  "data": { "color": "yellow" }
}
```

- `seq`: 1-indexed monotonic integer assigned by `LibraryDO` on commit (omitted on `POST /v2/events`).
- `id`: Client-generated unique ID (`^ev_[A-Za-z0-9_-]{16,32}$`). Writes are idempotent by `id` (`INSERT OR IGNORE`).
- `ts`: Client Unix timestamp in milliseconds.
- `app`: Writer identifier (e.g. `"selah-vault"`, `"proofs-web"`, `"proofs-ios"`, `"route.bible"`).
- `tags`: Query tags; `LibraryDO` automatically indexes `"book:<BOOK>"` when `ref` starts with `<BOOK>.` and `"card:<cardKey>"` when `data.cardKey` is present.

### 3.3 Deterministic `(ts, id)` Convergence & Canonical Event Kinds

When two events update the same stateful entity, the larger `(ts, id)` wins (`ts` compared numerically; ties broken by lexicographically larger ASCII `id`). Offline devices therefore converge to identical state regardless of arrival order.

1. **Saved Passages (`passages:write`):**
   - `passage.saved` (`ref: "<USFM>"`, `data: { apps?: {} }`): Saves a chapter, verse, or single-chapter range, preserving earliest `createdTs`.
   - `passage.removed` (`ref: "<USFM>"`, `data: {}`): Marks the passage removed at `ts` without deleting notes or SRS review history.
2. **Highlights & Colors (`highlights:write`):**
   - `highlight.set` (`ref: "<single-verse USFM>"`, `data: { color, quote? }`): Sets a verse's highlight color (`yellow`, `green`, `blue`, `pink`, `purple`, `orange`, or custom `c-...`), preserving earliest `createdTs`. Adjacent single-verse highlights of the same color in one chapter group into ranges in client views (`public/ranges.js`).
   - `highlight.removed` (`ref: "<single-verse USFM>"`, `data: {}`): Clears a verse's highlight.
   - `color.set` (`ref: null`, `data: { id, name, hex? }`) and `color.removed` (`ref: null`, `data: { id }`).
3. **Outliner Notes (`notes:write`):**
   - `note.block.set` (`ref: "<USFM>" | null`, `data: { id, outlineId, parentId, rank, text, card?, apps? }`) and `note.block.deleted` (`ref: "<USFM>" | null`, `data: { id }`). Live blocks are indexed in SQLite `FTS5`.
4. **Spaced Repetition (`srs:write`):**
   - Card keys: `"<USFM>#ref"`, `"<USFM>#text"`, `"<cardId>"`, `"<cardId>#c<N>"`, or `"x-proofs:<id>"`.
   - `srs.reviewed` (`data: { cardKey, rating: 1|2|3|4, rung?, hints?, promptCard?, durationMs? }`) and `srs.card` (`data: { cardKey, action: "add"|"suspend"|"resume"|"drop"|"reset" }`).
   - Replaying events in `(ts, id)` order transitions card state (`absent` -> `active` <-> `suspended` / `dropped`; `reset` clears prior reviews and restarts ladder `rung` while keeping state). If passage `<USFM>` is currently removed at `removedTs` and a `<USFM>#<unit>` card's latest activating event has `ts <= removedTs`, `pausedByPassage` is `true` until re-saved or explicitly resumed.
5. **Library Settings (owner `*`):**
   - `library.renamed` (`ref: null`, `data: { name }`).

---

## 4. `/v2` Endpoints, Backups & MCP

All `/v2/*` routes support CORS (`Authorization`, `Content-Type`) and authenticate via `Bearer sv2.<userId>.<secret>` or `selah_session`.

- `POST /v2/events`: Appends 1–500 events atomically (`{ events }`), enforces scopes per `kind`, updates projections, broadcasts `{"type":"poke","seq":headSeq}` to open WebSockets, and returns `{ seq, accepted, duplicates }`.
- `GET /v2/events`: Incremental feed (`?after=0&limit=500`, optional `kind`, `ref`, `tag`, `app`) -> `{ events, seq, more }`.
- `GET /v2/bootstrap`: Instant materialized snapshot at `seq` (`{ seq, library, passages, removedPassages, highlights, colors, blocks, srs: { cards, dailyStats } }`) so new devices hydrate in one round-trip.
- `GET /v2/search?q=<query>&limit=50`: `FTS5` search over live note blocks -> `{ blocks }`.
- `GET /v2/ws`: Hibernating WebSocket (`Sec-WebSocket-Protocol: selah-v2, token.<sv2...>` or session cookie) emitting `hello` on open and `poke` on commits.
- `GET /v2/export` & `POST /v2/import`: Readable `.jsonl` backups starting with `{"selah-vault":2,"library":"...","name":"...","exportedAt":...}` followed by one `VaultEvent` JSON object per line.
- `DELETE /v2/library`: Owner-only erasure of the `LibraryDO` SQLite store and D1 identity records.
- `POST /mcp`: Streamable HTTP Model Context Protocol server authenticated by `Bearer sv2.<userId>.<secret>` (advertising `/.well-known/oauth-authorization-server` via `WWW-Authenticate` on `401`).
- **Links & Save-from-Link:** Passages link to `https://route.bible/<lowercased-ref>`. Navigating to `/save?ref=John+3:16&color=blue` highlights the passage in the signed-in browser library with one-tap Undo.

