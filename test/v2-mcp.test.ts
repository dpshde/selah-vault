import { describe, expect, test } from "bun:test";
import { sha256B64u } from "../src/clients";
import { TOOLS } from "../src/mcp/index";
import { TEST_ORIGIN, createTestEnv } from "./env";

describe("MCP Server v2 (/mcp)", () => {
  test("returns 401 with WWW-Authenticate pointing at /.well-known/oauth-authorization-server when missing or invalid token", async () => {
    const h = createTestEnv();

    const noAuth = await h.fetch("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(noAuth.status).toBe(401);
    expect(noAuth.headers.get("www-authenticate")).toContain(`${TEST_ORIGIN}/.well-known/oauth-authorization-server`);

    const badAuth = await h.fetch("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer sv2.u_0000000000000000000000.0000000000000000000000000000000000000000000" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" }),
    });
    expect(badAuth.status).toBe(401);
    expect(badAuth.headers.get("www-authenticate")).toContain("/.well-known/oauth-authorization-server");
  });

  test("handshake, tools/list, and all 12 tools read/write directly through LibraryDO with zero D1 hops", async () => {
    const h = createTestEnv();
    const owner = await h.createUserSession("mcp@selah.tools", "Devotional");

    // Seed a note block so search_notes can find it via FTS5
    await h.fetch("/v2/events", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${owner.token}` },
      body: JSON.stringify({
        events: [
          {
            id: "ev_mcp_note_seed_0001",
            ts: 1000,
            app: "selah-vault",
            kind: "note.block.set",
            ref: "EPH.2.8",
            data: { id: "b_eph", outlineId: "out_eph", parentId: null, rank: "m", text: "By grace you have been saved through faith" },
          },
        ],
      }),
    });
    h.resetD1Count();

    const callRpc = async (method: string, params: Record<string, unknown> = {}, token = owner.token) => {
      const res = await h.fetch("/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      expect(res.status).toBe(200);
      return (await res.json()) as { result?: Record<string, unknown>; error?: Record<string, unknown> };
    };

    const callTool = async (name: string, args: Record<string, unknown> = {}, token = owner.token) => {
      const rpc = await callRpc("tools/call", { name, arguments: args }, token);
      return rpc.result as { structuredContent?: Record<string, unknown>; isError: boolean; content: Array<{ text: string }> };
    };

    const init = await callRpc("initialize", { protocolVersion: "2025-06-18" });
    expect(init.result?.serverInfo).toEqual({ name: "selah-vault", title: "Selah Vault", version: "2.0.0" });

    const list = await callRpc("tools/list");
    expect((list.result?.tools as Array<{ name: string }>).map((t) => t.name)).toEqual(TOOLS.map((t) => t.name));
    expect(TOOLS).toHaveLength(12);

    // 1. add_highlight + 2. list_highlights + 3. find_highlights + 4. set_highlight_color + 5. delete_highlight
    const added = await callTool("add_highlight", { reference: "Romans 5:3-5", color: "yellow" });
    expect(added.isError).toBe(false);
    expect(added.structuredContent).toMatchObject({ color: "yellow", verses: ["ROM.5.3", "ROM.5.4", "ROM.5.5"] });

    const listed = await callTool("list_highlights", {});
    expect(listed.structuredContent?.highlights).toEqual([
      {
        reference: "Romans 5:3\u20135",
        ref: "ROM.5.3-5",
        color: "yellow",
        colorName: "Yellow",
        verses: ["ROM.5.3", "ROM.5.4", "ROM.5.5"],
        link: "https://route.bible/rom.5.3-5",
      },
    ]);

    const foundBook = await callTool("find_highlights", { book: "Romans" });
    expect((foundBook.structuredContent?.highlights as unknown[]).length).toBe(1);

    const recolored = await callTool("set_highlight_color", { reference: "Romans 5:4", color: "blue" });
    expect(recolored.structuredContent).toMatchObject({ color: "blue", verses: ["ROM.5.4"] });

    const deleted = await callTool("delete_highlight", { reference: "Romans 5:4" });
    expect(deleted.structuredContent).toMatchObject({ verses: ["ROM.5.4"] });

    // 6. save_passage + 7. list_passages + 8. remove_passage
    const saved = await callTool("save_passage", { reference: "John 3:16-18" });
    expect(saved.isError).toBe(false);
    expect(saved.structuredContent?.passages).toEqual([
      { reference: "John 3:16\u201318", ref: "JHN.3.16-18", link: "https://route.bible/jhn.3.16-18" },
    ]);

    const passages = await callTool("list_passages", { book: "John" });
    expect((passages.structuredContent?.passages as unknown[]).length).toBe(1);

    // 9. search_notes + 10. list_colors + 11. get_library_info + 12. get_passage_link
    const notes = await callTool("search_notes", { query: "grace saved" });
    expect((notes.structuredContent?.blocks as Array<{ id: string }>)[0].id).toBe("b_eph");

    const colors = await callTool("list_colors", {});
    expect((colors.structuredContent?.colors as Array<{ id: string; verses: number }>)[0]).toMatchObject({
      id: "yellow",
      verses: 2,
    });

    const info = await callTool("get_library_info", {});
    expect(info.structuredContent).toMatchObject({
      name: "Devotional",
      highlightedVerses: 2,
      highlightRanges: 2,
      savedPassages: 1,
      notes: 1,
    });

    const pLink = await callTool("get_passage_link", { reference: "Psalm 23:1-6" });
    expect(pLink.structuredContent?.links).toEqual([
      { reference: "Psalm 23:1\u20136", ref: "PSA.23.1-6", link: "https://route.bible/psa.23.1-6" },
    ]);

    const removed = await callTool("remove_passage", { reference: "JHN.3.16-18" });
    expect(removed.structuredContent).toMatchObject({ refs: ["JHN.3.16-18"] });

    expect(h.d1Queries).toBe(0);

    // Read-only OAuth grant can read via MCP but write tools refuse cleanly
    const verifier = "mcp_readonly_verifier_abcdefghijklmnopqrstuvwxyz_012345";
    const challenge = await sha256B64u(verifier);
    const authz = await h.fetch("/oauth/authorize", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${owner.token}` },
      body: JSON.stringify({
        client_id: "claude-desktop",
        redirect_uri: "http://127.0.0.1:49152/callback",
        scope: "read",
        code_challenge: challenge,
        code_challenge_method: "S256",
        state: "mcp_state_1",
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
        redirect_uri: "http://127.0.0.1:49152/callback",
        client_id: "claude-desktop",
        code_verifier: verifier,
      }),
    });
    const { access_token: readToken } = (await tokRes.json()) as { access_token: string };

    const readOk = await callTool("list_highlights", {}, readToken);
    expect(readOk.isError).toBe(false);

    const writeDenied = await callTool("add_highlight", { reference: "John 1:1" }, readToken);
    expect(writeDenied.isError).toBe(true);
    expect(writeDenied.content[0].text).toContain("permission");
  });
});
