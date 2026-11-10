# Quick Start: Sync with Selah Vault v2

Building a connected app (`route.bible`, `Proofs`, or a custom tool)? Start with [docs/connect.md](connect.md) to obtain a scoped OAuth 2.1 `sv2.<userId>.<secret>` token. This guide shows the `/v2` event-stream sync loop underneath `public/sync.js` and `public/grant-client.js`.

## 1. Authenticate (`sv2.<userId>.<secret>`)

Every `/v2/*` request carries either the first-party `selah_session` cookie or an `Authorization: Bearer sv2.<userId>.<secret>` header. The Worker extracts `<userId>` directly from the token prefix and routes straight to that user's isolated SQLite Durable Object (`LibraryDO`) with zero D1 hops.

## 2. Cold Boot (`GET /v2/bootstrap`)

When a device starts with `seq === 0`, hydrate materialized state in a single round-trip instead of replaying every historical event:

```sh
S=http://localhost:8787
TOKEN="sv2.u_0123456789abcdef012345.yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy"

curl -s "$S/v2/bootstrap" -H "authorization: Bearer $TOKEN"
```

```json
{
  "seq": 14,
  "library": { "id": "u_0123456789abcdef012345", "name": "Personal" },
  "passages": [{ "ref": "JHN.3.16-18", "createdTs": 1792000000000, "updatedTs": 1793000000000, "apps": {} }],
  "removedPassages": [],
  "highlights": [{ "ref": "JHN.3.16", "color": "yellow", "createdTs": 1792000000000, "updatedTs": 1793000000000 }],
  "colors": [{ "id": "yellow", "name": "Promises", "hex": null, "builtIn": true }],
  "blocks": [],
  "srs": { "cards": [], "dailyStats": [] }
}
```

Save `seq` (`14`) locally as your incremental cursor.

## 3. Append Events (`POST /v2/events`)

Queue edits in a local outbox with client-generated `"ev_<16..32 base64url chars>"` IDs and millisecond timestamps (`ts`), then flush in batches of up to 500 events:

```sh
curl -s -X POST "$S/v2/events" \
  -H "authorization: Bearer $TOKEN" \
  -H "content-type: application/json" \
  -d '{"events":[{"id":"ev_a1b2c3d4e5f6g7h8i9j0","ts":1793000500000,"app":"selah-vault","kind":"highlight.set","ref":"ROM.5.3","data":{"color":"green"}}]}'
```

```json
{"seq":15,"accepted":1,"duplicates":0}
```

Writes are idempotent by `event.id` (`INSERT OR IGNORE`): retrying an interrupted network request increments `duplicates` without re-applying the event.

## 4. Incremental Pull (`GET /v2/events`) & Live WebSockets (`/v2/ws`)

Pull events committed after your saved `seq` (optionally filtered by `kind`, `ref`, `tag`, or `app`):

```sh
curl -s "$S/v2/events?after=14&limit=500" -H "authorization: Bearer $TOKEN"
```

Open a WebSocket to `wss://vault.selah.tools/v2/ws` with `Sec-WebSocket-Protocol: selah-v2, token.<TOKEN>` to receive `{"type":"hello","seq":15}` on connect and `{"type":"poke","seq":16}` whenever another device or app appends events.

## 5. Using the Reference Client (`public/sync.js`)

```js
import { Library, serverTransport } from "./sync.js";

const lib = await Library.open({ userId: "u_0123456789abcdef012345", token: TOKEN });
await lib.use([serverTransport({ url: "https://vault.selah.tools", token: TOKEN })]);

await lib.highlightRange("ROM.5.3-5", "green");
await lib.savePassage("JHN.3.16-18");
lib.highlights({ group: "ranges" });
```
