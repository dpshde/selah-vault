import { describe, expect, test } from "bun:test";
import { sha256B64u } from "../src/clients";
import { createTestEnv } from "./env";

const evId = (suffix: string) => `ev_${suffix.padEnd(18, "0")}`;

describe("LibraryDO /v2/events, Zero-Hop Routing, Filters & Scopes", () => {
  test("routes /v2/* with zero D1 hops, auto-tags book/card, deduplicates by id, and filters GET /v2/events", async () => {
    const h = createTestEnv();
    const owner = await h.createUserSession("lib@selah.tools", "Personal");
    h.resetD1Count();

    const post1 = await h.fetch("/v2/events", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${owner.token}` },
      body: JSON.stringify({
        events: [
          {
            id: evId("save_jhn_1"),
            ts: 1_792_000_000_000,
            app: "selah-vault",
            kind: "passage.saved",
            ref: "JHN.3.16-18",
            data: { apps: { proofs: { pinned: true } } },
          },
          {
            id: evId("hl_jhn_1"),
            ts: 1_792_000_001_000,
            app: "route.bible",
            kind: "highlight.set",
            ref: "JHN.3.16",
            data: { color: "yellow" },
          },
          {
            id: evId("rev_jhn_1"),
            ts: 1_793_000_400_000,
            app: "proofs-ios",
            kind: "srs.reviewed",
            ref: "JHN.3.16-18",
            data: { cardKey: "JHN.3.16-18#text", rating: 3, rung: "R2b", hints: 1, promptCard: "q1-s1" },
          },
        ],
      }),
    });
    expect(post1.status).toBe(200);
    expect(await post1.json()).toEqual({ seq: 3, accepted: 3, duplicates: 0 });
    expect(h.d1Queries).toBe(0);

    // Duplicate id is ignored idempotently
    const post2 = await h.fetch("/v2/events", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${owner.token}` },
      body: JSON.stringify({
        events: [
          {
            id: evId("hl_jhn_1"),
            ts: 1_792_000_001_000,
            app: "route.bible",
            kind: "highlight.set",
            ref: "JHN.3.16",
            data: { color: "yellow" },
          },
        ],
      }),
    });
    expect(await post2.json()).toEqual({ seq: 3, accepted: 0, duplicates: 1 });

    // Query filters: prefix kind=srs., tag=book:JHN, tag=card:..., app, limit/more
    const byPrefix = await (
      await h.fetch("/v2/events?kind=srs.", { headers: { authorization: `Bearer ${owner.token}` } })
    ).json();
    expect(byPrefix).toMatchObject({ seq: 3, more: false, events: [{ seq: 3, kind: "srs.reviewed" }] });

    const byBookTag = await (
      await h.fetch("/v2/events?tag=book:JHN&limit=2", { headers: { authorization: `Bearer ${owner.token}` } })
    ).json();
    expect(byBookTag.events).toHaveLength(2);
    expect(byBookTag.more).toBe(true);

    const byCardTag = await (
      await h.fetch(`/v2/events?tag=${encodeURIComponent("card:JHN.3.16-18#text")}`, {
        headers: { authorization: `Bearer ${owner.token}` },
      })
    ).json();
    expect(byCardTag.events).toHaveLength(1);
    expect(byCardTag.events[0].tags).toContain("book:JHN");
    expect(byCardTag.events[0].tags).toContain("card:JHN.3.16-18#text");
    expect(h.d1Queries).toBe(0);
  });

  test("enforces OAuth scope boundaries per event kind", async () => {
    const h = createTestEnv();
    const owner = await h.createUserSession("scopes@selah.tools", "Personal");
    const verifier = "verifier_abcdefghijklmnopqrstuvwxyz_0123456789_abcdef";
    const challenge = await sha256B64u(verifier);

    const authz = await h.fetch("/oauth/authorize", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${owner.token}` },
      body: JSON.stringify({
        client_id: "route.bible",
        redirect_uri: "https://route.bible/cb",
        scope: "read highlights:write",
        code_challenge: challenge,
        code_challenge_method: "S256",
        state: "state_scope_1",
        approve: true,
      }),
    });
    const code = new URL(((await authz.json()) as { redirect_to: string }).redirect_to).searchParams.get("code")!;
    const tokRes = await h.fetch("/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        grant_type: "authorization_code",
        code,
        redirect_uri: "https://route.bible/cb",
        client_id: "route.bible",
        code_verifier: verifier,
      }),
    });
    const { access_token: grantToken } = (await tokRes.json()) as { access_token: string };

    // Allowed: highlight.set
    const okHl = await h.fetch("/v2/events", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${grantToken}` },
      body: JSON.stringify({
        events: [{ id: evId("grant_hl_1"), ts: 1000, app: "route.bible", kind: "highlight.set", ref: "ROM.8.28", data: { color: "blue" } }],
      }),
    });
    expect(okHl.status).toBe(200);

    // Disallowed: passage.saved and library.renamed
    for (const [kind, ref, data] of [
      ["passage.saved", "ROM.8.28", {}],
      ["library.renamed", null, { name: "Hacked" }],
    ] as const) {
      const denied = await h.fetch("/v2/events", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${grantToken}` },
        body: JSON.stringify({
          events: [{ id: evId(`deny_${kind.replace(".", "_")}`), ts: 2000, app: "route.bible", kind, ref, data }],
        }),
      });
      expect(denied.status).toBe(403);
    }
  });
});

describe("Projector (ts, id) Convergence, SRS State Machine & FTS5", () => {
  test("converges to identical bootstrap state regardless of event arrival order", async () => {
    const h = createTestEnv();
    const u1 = await h.createUserSession("u1@selah.tools", "Personal");
    const u2 = await h.createUserSession("u2@selah.tools", "Personal");

    const batch = [
      { id: evId("a_rename_early"), ts: 1000, app: "selah-vault", kind: "library.renamed", ref: null, data: { name: "Old Name" } },
      { id: evId("b_rename_tie"), ts: 1000, app: "selah-vault", kind: "library.renamed", ref: null, data: { name: "Tie Winner" } },
      { id: evId("hl_early"), ts: 1500, app: "selah-vault", kind: "highlight.set", ref: "PSA.23.1", data: { color: "yellow" } },
      { id: evId("hl_late"), ts: 2500, app: "selah-vault", kind: "highlight.set", ref: "PSA.23.1", data: { color: "green" } },
      { id: evId("color_promises"), ts: 1200, app: "selah-vault", kind: "color.set", ref: null, data: { id: "yellow", name: "Promises" } },
      { id: evId("color_custom"), ts: 1300, app: "selah-vault", kind: "color.set", ref: null, data: { id: "c-gold", name: "Glory", hex: "#d4af37" } },
      {
        id: evId("blk_1"),
        ts: 1600,
        app: "selah-vault",
        kind: "note.block.set",
        ref: "PSA.23.1",
        data: { id: "b1", outlineId: "out_psa23", parentId: null, rank: "a0", text: "The Lord is my shepherd" },
      },
      {
        id: evId("blk_2"),
        ts: 2600,
        app: "selah-vault",
        kind: "note.block.set",
        ref: "PSA.23.1",
        data: { id: "b1", outlineId: "out_psa23", parentId: null, rank: "a0", text: "The Lord is my faithful shepherd" },
      },
      { id: evId("srs_r1"), ts: 1800, app: "proofs-web", kind: "srs.reviewed", ref: "PSA.23.1", data: { cardKey: "PSA.23.1#text", rating: 2 } },
      { id: evId("srs_reset"), ts: 2000, app: "proofs-web", kind: "srs.card", ref: "PSA.23.1", data: { cardKey: "PSA.23.1#text", action: "reset" } },
      { id: evId("srs_r2"), ts: 2200, app: "proofs-web", kind: "srs.reviewed", ref: "PSA.23.1", data: { cardKey: "PSA.23.1#text", rating: 4, rung: "R3" } },
    ];

    await h.fetch("/v2/events", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${u1.token}` },
      body: JSON.stringify({ events: batch }),
    });
    await h.fetch("/v2/events", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${u2.token}` },
      body: JSON.stringify({ events: [...batch].reverse() }),
    });

    const b1 = await (await h.fetch("/v2/bootstrap", { headers: { authorization: `Bearer ${u1.token}` } })).json();
    const b2 = await (await h.fetch("/v2/bootstrap", { headers: { authorization: `Bearer ${u2.token}` } })).json();

    expect({ ...b1, library: { ...b1.library, id: "same" } }).toEqual({ ...b2, library: { ...b2.library, id: "same" } });
    expect(b1.library.name).toBe("Tie Winner");
    expect(b1.highlights).toEqual([{ ref: "PSA.23.1", color: "green", createdTs: 1500, updatedTs: 2500 }]);
    expect(b1.colors[0]).toEqual({ id: "yellow", name: "Promises", hex: null, builtIn: true });
    expect(b1.colors.find((c: { id: string }) => c.id === "c-gold")).toEqual({
      id: "c-gold",
      name: "Glory",
      hex: "#d4af37",
      builtIn: false,
    });
    expect(b1.srs.cards[0]).toMatchObject({
      cardKey: "PSA.23.1#text",
      state: "active",
      lastResetTs: 2000,
      lastActiveTs: 2200,
      reviews: [{ id: evId("srs_r2"), ts: 2200, rating: 4, rung: "R3" }],
    });
    expect(b1.srs.dailyStats[0]).toMatchObject({ reviews: 2, hard: 1, easy: 1, again: 0, good: 0 });
  });

  test("derived passage pause (pausedByPassage) pauses active cards on passage.removed and restores without unsuspending manual suspends", async () => {
    const h = createTestEnv();
    const owner = await h.createUserSession("srs@selah.tools", "Personal");

    const send = (events: Array<Record<string, unknown>>) =>
      h.fetch("/v2/events", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${owner.token}` },
        body: JSON.stringify({ events }),
      });

    await send([
      { id: evId("rom_save_1"), ts: 1000, app: "selah-vault", kind: "passage.saved", ref: "ROM.8.28", data: {} },
      { id: evId("rom_rev_txt"), ts: 1200, app: "proofs-ios", kind: "srs.reviewed", ref: "ROM.8.28", data: { cardKey: "ROM.8.28#text", rating: 3 } },
      { id: evId("rom_add_ref"), ts: 1300, app: "proofs-ios", kind: "srs.card", ref: "ROM.8.28", data: { cardKey: "ROM.8.28#ref", action: "add" } },
      { id: evId("rom_sus_ref"), ts: 1400, app: "proofs-ios", kind: "srs.card", ref: "ROM.8.28", data: { cardKey: "ROM.8.28#ref", action: "suspend" } },
      { id: evId("rom_remove"), ts: 2000, app: "selah-vault", kind: "passage.removed", ref: "ROM.8.28", data: {} },
    ]);

    const bootRemoved = await (await h.fetch("/v2/bootstrap", { headers: { authorization: `Bearer ${owner.token}` } })).json();
    expect(bootRemoved.passages).toEqual([]);
    expect(bootRemoved.removedPassages).toEqual([{ ref: "ROM.8.28", removedTs: 2000 }]);
    const txtCard = bootRemoved.srs.cards.find((c: { cardKey: string }) => c.cardKey === "ROM.8.28#text");
    const refCard = bootRemoved.srs.cards.find((c: { cardKey: string }) => c.cardKey === "ROM.8.28#ref");
    expect(txtCard).toMatchObject({ state: "active", pausedByPassage: true });
    expect(refCard).toMatchObject({ state: "suspended", pausedByPassage: true });

    // Re-saving ROM.8.28 clears pausedByPassage while preserving earliest createdTs (1000) and manual suspend
    await send([{ id: evId("rom_save_2"), ts: 3000, app: "selah-vault", kind: "passage.saved", ref: "ROM.8.28", data: {} }]);
    const bootResaved = await (await h.fetch("/v2/bootstrap", { headers: { authorization: `Bearer ${owner.token}` } })).json();
    expect(bootResaved.passages).toEqual([{ ref: "ROM.8.28", createdTs: 1000, updatedTs: 3000, apps: {} }]);
    expect(bootResaved.removedPassages).toEqual([]);
    expect(bootResaved.srs.cards.find((c: { cardKey: string }) => c.cardKey === "ROM.8.28#text")).toMatchObject({
      state: "active",
      pausedByPassage: false,
    });
    expect(bootResaved.srs.cards.find((c: { cardKey: string }) => c.cardKey === "ROM.8.28#ref")).toMatchObject({
      state: "suspended",
      pausedByPassage: false,
    });
  });
});

describe("FTS5 Search, WebSockets, Grants, Export/Import & Library Wipe", () => {
  test("FTS5 searches live blocks, WebSocket receives hello & poke, grants list/revoke, JSONL exports/imports, and DELETE /v2/library wipes all", async () => {
    const h = createTestEnv();
    const owner = await h.createUserSession("ws@selah.tools", "Personal");

    // Connect WebSocket via Sec-WebSocket-Protocol: selah-v2, token.<sv2...>
    const wsConn = await h.connectWs("/v2/ws", {
      headers: { "sec-websocket-protocol": `selah-v2, token.${owner.token}` },
    });
    expect(wsConn.status).toBe(101);
    expect(wsConn.ws?.protocol).toBe("selah-v2");
    expect(wsConn.ws?.messages).toEqual([{ type: "hello", seq: 0 }]);

    // Append note blocks and verify poke + FTS5 search
    await h.fetch("/v2/events", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${owner.token}` },
      body: JSON.stringify({
        events: [
          {
            id: evId("note_propitiation"),
            ts: 5000,
            app: "selah-vault",
            kind: "note.block.set",
            ref: "ROM.3.25",
            data: { id: "blk_rom", outlineId: "out_rom", parentId: null, rank: "m", text: "Propitiation through faith in His blood" },
          },
          {
            id: evId("note_deleted"),
            ts: 5100,
            app: "selah-vault",
            kind: "note.block.set",
            ref: "JHN.1.1",
            data: { id: "blk_del", outlineId: "out_jhn", parentId: null, rank: "m", text: "Temporary logos note" },
          },
          {
            id: evId("note_deleted_tomb"),
            ts: 5200,
            app: "selah-vault",
            kind: "note.block.deleted",
            ref: "JHN.1.1",
            data: { id: "blk_del" },
          },
        ],
      }),
    });
    expect(wsConn.ws?.messages).toEqual([
      { type: "hello", seq: 0 },
      { type: "poke", seq: 3 },
    ]);

    const searchHit = await (
      await h.fetch("/v2/search?q=propitiation+faith!", { headers: { authorization: `Bearer ${owner.token}` } })
    ).json();
    expect(searchHit.blocks).toHaveLength(1);
    expect(searchHit.blocks[0]).toMatchObject({ id: "blk_rom", ref: "ROM.3.25" });

    const searchDeleted = await (
      await h.fetch("/v2/search?q=Temporary", { headers: { authorization: `Bearer ${owner.token}` } })
    ).json();
    expect(searchDeleted.blocks).toEqual([]);

    // Export .jsonl and import into a second user
    const exportRes = await h.fetch("/v2/export", { headers: { authorization: `Bearer ${owner.token}` } });
    expect(exportRes.status).toBe(200);
    const jsonl = await exportRes.text();
    const firstLine = JSON.parse(jsonl.split("\n")[0]);
    expect(firstLine["selah-vault"]).toBe(2);

    const target = await h.createUserSession("import@selah.tools", "Imported");
    const impRes = await h.fetch("/v2/import", {
      method: "POST",
      headers: { "content-type": "application/x-ndjson", authorization: `Bearer ${target.token}` },
      body: jsonl,
    });
    expect(await impRes.json()).toEqual({ seq: 3, accepted: 3, duplicates: 0 });

    // Grants list + owner revoke + self revoke
    const verifier = "verifier_grant_mgmt_0123456789_abcdefghijklmnop";
    const challenge = await sha256B64u(verifier);
    const issueGrant = async (clientId: string, redirectUri: string) => {
      const a = await h.fetch("/oauth/authorize", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${owner.token}` },
        body: JSON.stringify({
          client_id: clientId,
          redirect_uri: redirectUri,
          scope: "read",
          code_challenge: challenge,
          code_challenge_method: "S256",
          state: "grant_state_1",
          approve: true,
        }),
      });
      const code = new URL(((await a.json()) as { redirect_to: string }).redirect_to).searchParams.get("code")!;
      const t = await h.fetch("/oauth/token", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: clientId, code_verifier: verifier }),
      });
      return ((await t.json()) as { access_token: string }).access_token;
    };

    const g1 = await issueGrant("proofs", "https://proofs.selah.tools/cb");
    const g2 = await issueGrant("route.bible", "https://route.bible/cb");

    const grantsList = (await (await h.fetch("/v2/grants", { headers: { authorization: `Bearer ${owner.token}` } })).json()) as {
      grants: Array<{ id: string; clientId: string }>;
    };
    expect(grantsList.grants).toHaveLength(2);

    // Grant g1 revokes itself via DELETE /v2/grants/self
    expect((await h.fetch("/v2/grants/self", { method: "DELETE", headers: { authorization: `Bearer ${g1}` } })).status).toBe(200);
    expect((await h.fetch("/v2/bootstrap", { headers: { authorization: `Bearer ${g1}` } })).status).toBe(401);

    // Owner revokes g2 via DELETE /v2/grants/:id
    const g2Entry = grantsList.grants.find((g) => g.clientId === "route.bible")!;
    expect((await h.fetch(`/v2/grants/${g2Entry.id}`, { method: "DELETE", headers: { authorization: `Bearer ${owner.token}` } })).status).toBe(200);
    expect((await h.fetch("/v2/bootstrap", { headers: { authorization: `Bearer ${g2}` } })).status).toBe(401);

    // DELETE /v2/library wipes LibraryDO + D1 users row
    const delRes = await h.fetch("/v2/library", { method: "DELETE", headers: { authorization: `Bearer ${owner.token}` } });
    expect(delRes.status).toBe(200);
    expect((await h.fetch("/v2/bootstrap", { headers: { authorization: `Bearer ${owner.token}` } })).status).toBe(401);
    const dbRow = h.authDb.query("SELECT id FROM users WHERE id = ?").get(owner.user.id);
    expect(dbRow).toBeNull();
  });
});
