import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import {
  CLIENTS,
  CLIENT_ORIGINS,
  GRANT_DAYS,
  SCOPES,
  allowedClient,
  clientInfo,
  consentLines,
  grantAllows,
  parseScopes,
} from "../public/grants.js";
import {
  GrantClient,
  buildAuthorizeUrl,
  createOAuthState,
  createPkce,
  exchangeCode,
  parseOAuthCallback,
} from "../public/grant-client.js";
import {
  Library,
  applyEventToState,
  b64url,
  emptyProjectedState,
  memoryStore,
  parseJsonl,
  projectSrsCards,
  serverTransport,
  topColor,
} from "../public/sync.js";
import { fromBase64Url, loginWithPasskey, registerPasskey, toBase64Url } from "../public/passkey.js";

describe("public/grants.js — OAuth 2.1 clients and scopes", () => {
  test("exports CLIENTS, CLIENT_ORIGINS, GRANT_DAYS=90, and all 5 v2 scopes", () => {
    expect(GRANT_DAYS).toBe(90);
    expect(CLIENT_ORIGINS).toContain("https://route.bible");
    expect(CLIENT_ORIGINS).toContain("https://proofs.selah.tools");
    expect(Object.keys(SCOPES)).toEqual(["read", "highlights:write", "passages:write", "notes:write", "srs:write"]);
  });

  test("allowedClient validates allowlisted HTTPS origins, proofs://oauth/callback, and loopback", () => {
    expect(allowedClient("https://route.bible/auth/callback", "route.bible")).toBe("https://route.bible");
    expect(allowedClient("https://proofs.selah.tools/callback", "proofs")).toBe("https://proofs.selah.tools");
    expect(allowedClient("https://proofs.dpshade.workers.dev/cb", "proofs-web")).toBe("https://proofs.dpshade.workers.dev");
    expect(allowedClient("proofs://oauth/callback", "proofs-ios")).toBe("proofs://oauth/callback");
    expect(allowedClient("proofs://oauth/callback", "route.bible")).toBeNull();
    expect(allowedClient("http://localhost:5173/oauth/callback", "proofs")).toBe("http://localhost:5173");
    expect(allowedClient("http://127.0.0.1:8788/cb", "claude")).toBe("http://127.0.0.1:8788");
    expect(allowedClient("https://evil.example/cb", "proofs")).toBeNull();
    expect(allowedClient("https://user:pass@route.bible/cb", "route.bible")).toBeNull();
    expect(allowedClient("https://route.bible/cb#frag", "route.bible")).toBeNull();
  });

  test("allowedClient accepts route.bible Workers previews on the dpshade subdomain only", () => {
    expect(allowedClient("https://www.route.bible/", "route.bible")).toBe("https://www.route.bible");
    const host = "oauth-v2-route-bible.dpshade.workers.dev";
    expect(allowedClient(`https://${host}/`, host)).toBe(`https://${host}`);
    expect(allowedClient("https://route-bible-preview.dpshade.workers.dev/", "route-bible-preview.dpshade.workers.dev")).toBe("https://route-bible-preview.dpshade.workers.dev");
    expect(clientInfo(`https://${host}`, host).name).toBe("route.bible (preview)");
    expect(allowedClient(`https://${host}/`, "evil")).toBeNull();
    expect(allowedClient("https://x-route-bible.evil.workers.dev/", "x-route-bible.evil.workers.dev")).toBeNull();
    expect(allowedClient(`http://${host}/`, host)).toBeNull();
  });

  test("parseScopes, grantAllows, clientInfo, and consentLines work across all scopes", () => {
    expect(parseScopes("srs:write read passages:write read")).toEqual(["passages:write", "read", "srs:write"]);
    expect(parseScopes("read unknown")).toBeNull();
    expect(parseScopes("")).toBeNull();
    expect(grantAllows(["read"], "GET")).toBe(true);
    expect(grantAllows(["read"], "POST")).toBe(false);
    expect(grantAllows(["highlights:write"], "highlight.set")).toBe(true);
    expect(grantAllows(["highlights:write"], "color.set")).toBe(true);
    expect(grantAllows(["highlights:write"], "srs.reviewed")).toBe(false);
    expect(grantAllows(["srs:write"], "srs.reviewed")).toBe(true);
    expect(clientInfo("proofs://oauth/callback", "proofs-ios").name).toBe("Proofs");
    expect(clientInfo("https://route.bible").name).toBe(CLIENTS["https://route.bible"].name);
    const lines = consentLines(["read", "passages:write"]);
    expect(lines.some((l) => l.ok && l.text.includes("passages"))).toBe(true);
    expect(lines.some((l) => !l.ok && l.icon === "lock")).toBe(true);
  });
});

describe("public/grant-client.js — PKCE & GrantClient", () => {
  const TOKEN = "sv2.u_0123456789abcdef012345.secret_0123456789abcdef0123456789abcdef0123";

  test("createPkce produces S256 challenge matching verifier SHA-256 and builds authorize URL", async () => {
    const pkce = await createPkce();
    expect(pkce.codeChallengeMethod).toBe("S256");
    expect(pkce.codeVerifier.length).toBeGreaterThanOrEqual(43);
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(pkce.codeVerifier));
    expect(pkce.codeChallenge).toBe(b64url(new Uint8Array(digest)));

    const state = createOAuthState();
    const url = new URL(buildAuthorizeUrl({
      vault: "https://vault.selah.tools",
      clientId: "proofs",
      redirectUri: "https://proofs.selah.tools/cb",
      scope: ["read", "srs:write"],
      codeChallenge: pkce.codeChallenge,
      state,
    }));
    expect(url.pathname).toBe("/oauth/authorize");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("scope")).toBe("read srs:write");
    expect(parseOAuthCallback(`?code=abc123&state=${state}`)).toEqual({ code: "abc123", state });
    expect(parseOAuthCallback(`?error=access_denied&state=${state}`)).toEqual({ error: "access_denied", state });
  });

  test("exchangeCode, GrantClient bootstrap/events, range writes, passages, and revoke", async () => {
    const calls: Array<{ method: string; url: string; auth: string | null; body: any }> = [];
    const serverEvents: any[] = [];
    const mockFetch = (async (url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      calls.push({ method: init?.method || "GET", url: String(url), auth: headers.get("authorization"), body });
      if (String(url).endsWith("/oauth/token")) {
        return Response.json({ access_token: TOKEN, token_type: "Bearer", expires_in: 7776000, scope: "read highlights:write passages:write", user: { id: "u_0123456789abcdef012345", name: "Personal" } });
      }
      if (String(url).endsWith("/v2/bootstrap")) {
        return Response.json({
          seq: 2,
          library: { id: "u_0123456789abcdef012345", name: "Personal" },
          passages: [{ ref: "PSA.23", createdTs: 1000, updatedTs: 1000, apps: {} }],
          removedPassages: [],
          highlights: [{ ref: "JHN.3.16", color: "yellow", createdTs: 1000, updatedTs: 1000 }],
          colors: [{ id: "yellow", name: "Promises", hex: null, builtIn: true }],
          blocks: [],
          srs: { cards: [], dailyStats: [] },
        });
      }
      if (String(url).includes("/v2/events") && (init?.method || "GET") === "POST") {
        for (const ev of body.events) serverEvents.push({ ...ev, seq: 2 + serverEvents.length + 1 });
        return Response.json({ seq: 2 + serverEvents.length, accepted: body.events.length, duplicates: 0 });
      }
      if (String(url).includes("/v2/events?after=")) {
        const after = Number(new URL(String(url)).searchParams.get("after") || 0);
        return Response.json({ events: serverEvents.filter((e) => e.seq > after), seq: 2 + serverEvents.length, more: false });
      }
      if (String(url).endsWith("/oauth/revoke")) return new Response(null, { status: 204 });
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const tok = await exchangeCode({ vault: "https://vault.selah.tools", clientId: "proofs", redirectUri: "https://proofs.selah.tools/cb", code: "c1", codeVerifier: "v1", fetch: mockFetch });
    const client = await GrantClient.open({ vault: "https://vault.selah.tools", ...tok }, { fetch: mockFetch });
    const initial = await client.changes();
    expect(initial.reset).toBe(true);
    expect(initial.next).toBe("2");
    expect(initial.upserts.map((u: any) => u.ref)).toEqual(["JHN.3.16"]);
    expect(client.passages().map((p: any) => p.ref)).toEqual(["PSA.23"]);

    await client.highlightRange("ROM.5.3-4", "green");
    expect(client.highlights({ group: "ranges" }).map((r: any) => `${r.ref}:${r.color}`)).toEqual(["JHN.3.16:yellow", "ROM.5.3-4:green"]);
    await client.remove(["JHN.3.16"]);
    await client.savePassage("ROM.8.28");
    expect(client.passages().map((p: any) => p.ref)).toEqual(["PSA.23", "ROM.8.28"]);
    expect(calls.filter((c) => c.url.includes("/v2/")).every((c) => c.auth === `Bearer ${TOKEN}`)).toBe(true);

    await client.disconnect();
    expect(calls.at(-1)?.url).toBe("https://vault.selah.tools/oauth/revoke");
  });
});

describe("public/sync.js — Library v2 projector, outbox, WebSocket & backups", () => {
  test("out-of-order offline events converge identically by (ts, id) and derive SRS pausedByPassage", () => {
    const events = [
      { id: "ev_0000000000000001", ts: 1000, app: "proofs-web", kind: "passage.saved", ref: "JHN.3.16-18", data: {} },
      { id: "ev_0000000000000002", ts: 1500, app: "proofs-web", kind: "srs.reviewed", ref: "JHN.3.16-18", data: { cardKey: "JHN.3.16-18#text", rating: 3, rung: "R1" } },
      { id: "ev_0000000000000003", ts: 2000, app: "selah-vault", kind: "highlight.set", ref: "JHN.3.16", data: { color: "yellow" } },
      { id: "ev_0000000000000009", ts: 2000, app: "route.bible", kind: "highlight.set", ref: "JHN.3.16", data: { color: "blue" } },
      { id: "ev_0000000000000004", ts: 3000, app: "selah-vault", kind: "passage.removed", ref: "JHN.3.16-18", data: {} },
    ];
    const s1 = emptyProjectedState();
    const s2 = emptyProjectedState();
    for (const ev of events) applyEventToState(s1, ev);
    for (const ev of [...events].reverse()) applyEventToState(s2, ev);

    expect(s1.highlights["JHN.3.16"].color).toBe("blue");
    expect(s2.highlights["JHN.3.16"].color).toBe("blue");
    const cards1 = projectSrsCards(s1);
    const cards2 = projectSrsCards(s2);
    expect(cards1).toEqual(cards2);
    expect(cards1[0]).toMatchObject({ cardKey: "JHN.3.16-18#text", state: "active", pausedByPassage: true });

    applyEventToState(s1, { id: "ev_0000000000000005", ts: 4000, app: "proofs-ios", kind: "srs.card", ref: "JHN.3.16-18", data: { cardKey: "JHN.3.16-18#text", action: "reset" } });
    expect(projectSrsCards(s1)[0].reviews).toEqual([]);
  });

  test("Library syncs via /v2/bootstrap, /v2/events, /v2/ws pokes, and selah-vault:2 .jsonl backups", async () => {
    const serverLog: any[] = [];
    let wsInstance: any = null;
    class FakeWS extends EventTarget {
      url: string;
      protocols: string[];
      constructor(url: string, protocols: string[]) {
        super();
        this.url = url;
        this.protocols = protocols;
        wsInstance = this;
      }
      close() {}
    }
    const mockFetch = (async (url: string, init?: RequestInit) => {
      if (String(url).endsWith("/v2/bootstrap")) {
        return Response.json({ seq: serverLog.length, library: { id: "u_abc", name: "Study" }, passages: [], removedPassages: [], highlights: serverLog.filter((e) => e.kind === "highlight.set").map((e) => ({ ref: e.ref, color: e.data.color, createdTs: e.ts, updatedTs: e.ts })), colors: [], blocks: [], srs: { cards: [], dailyStats: [] } });
      }
      if (String(url).endsWith("/v2/events") && init?.method === "POST") {
        const { events } = JSON.parse(String(init.body));
        for (const ev of events) serverLog.push({ ...ev, seq: serverLog.length + 1 });
        return Response.json({ seq: serverLog.length, accepted: events.length, duplicates: 0 });
      }
      if (String(url).includes("/v2/events?after=")) {
        const after = Number(new URL(String(url), "https://vault.selah.tools").searchParams.get("after") || 0);
        return Response.json({ events: serverLog.filter((e) => e.seq > after), seq: serverLog.length, more: false });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const store = memoryStore();
    const lib = await Library.open({ userId: "u_0123456789abcdef012345", token: "sv2.u_0123456789abcdef012345.secret_0123456789abcdef0123456789abcdef0123", store });
    await lib.highlightRange("JHN.3.16-17", "blue");
    await lib.use([serverTransport({ url: "https://vault.selah.tools", fetch: mockFetch, WebSocket: FakeWS as any })]);
    expect(lib.status.state).toBe("synced");
    expect(lib.name).toBe("Study");
    expect(wsInstance?.protocols[0]).toBe("selah-v2");

    serverLog.push({ seq: serverLog.length + 1, id: "ev_remote000000000001", ts: Date.now() + 5000, app: "proofs-web", kind: "highlight.set", ref: "ROM.8.28", data: { color: "green" } });
    const msg = new Event("message");
    Object.assign(msg, { data: JSON.stringify({ type: "poke", seq: serverLog.length }) });
    wsInstance.dispatchEvent(msg);
    await new Promise((r) => setTimeout(r, 20));
    expect(topColor(lib.find("highlight", "ROM.8.28"))).toBe("green");

    const exported = lib.toFile();
    expect(JSON.parse(exported.split("\n")[0]!)).toMatchObject({ "selah-vault": 2, library: "u_0123456789abcdef012345" });
    const lib2 = await Library.open({ userId: "u_restored0123456789abcd" });
    const merged = await lib2.merge(parseJsonl(exported));
    expect(merged).toBeGreaterThanOrEqual(2);
    expect(lib2.highlights({ group: "ranges" }).map((r: any) => r.ref)).toEqual(["JHN.3.16-17", "ROM.8.28"]);
  });
});

describe("public/passkey.js & v2 sign-in / consent UI", () => {
  test("WebAuthn helper encodes PublicKeyCredential without PRF extension", async () => {
    let createdOpts: any = null;
    const prevNav = globalThis.navigator;
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: {
        credentials: {
          async create(opts: any) {
            createdOpts = opts;
            return { id: "cred_1", rawId: new Uint8Array([1, 2, 3]).buffer, type: "public-key", response: { clientDataJSON: new Uint8Array([4, 5]).buffer, attestationObject: new Uint8Array([6, 7]).buffer, getTransports: () => ["internal"] } };
          },
          async get() {
            return { id: "cred_1", rawId: new Uint8Array([1, 2, 3]).buffer, type: "public-key", response: { clientDataJSON: new Uint8Array([4]).buffer, authenticatorData: new Uint8Array([5]).buffer, signature: new Uint8Array([6]).buffer, userHandle: null } };
          },
        },
      },
    });
    try {
      const calls: string[] = [];
      const mockFetch = (async (url: string) => {
        calls.push(String(url));
        if (String(url).includes("/register/options")) {
          return Response.json({ challengeId: "ch_1", challenge: toBase64Url(new Uint8Array(32)), rp: { id: "vault.selah.tools", name: "Selah Vault" }, user: { id: toBase64Url(new Uint8Array(16)), name: "Personal", displayName: "Personal" }, pubKeyCredParams: [{ type: "public-key", alg: -7 }] });
        }
        if (String(url).includes("/login/options")) {
          return Response.json({ challengeId: "ch_2", challenge: toBase64Url(new Uint8Array(32)), allowCredentials: [] });
        }
        return Response.json({ ok: true, user: { id: "u_0123456789abcdef012345", name: "Personal" } });
      }) as typeof fetch;
      expect(fromBase64Url(toBase64Url(new Uint8Array([9, 8, 7])))).toEqual(new Uint8Array([9, 8, 7]));
      await registerPasskey({ name: "Personal", fetch: mockFetch });
      await loginWithPasskey({ fetch: mockFetch });
      expect(createdOpts.publicKey.extensions?.prf).toBeUndefined();
      expect(calls).toEqual(["/auth/passkey/register/options", "/auth/passkey/register/verify", "/auth/passkey/login/options", "/auth/passkey/login/verify"]);
    } finally {
      Object.defineProperty(globalThis, "navigator", { configurable: true, value: prevNav });
    }
  });

  test("unlock, connect, and index offer Passkey, Email OTP, and Apple with zero sync keys", () => {
    const unlock = readFileSync(new URL("../public/unlock.html", import.meta.url), "utf8");
    const connect = readFileSync(new URL("../public/connect.html", import.meta.url), "utf8");
    const index = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
    for (const html of [unlock, connect, index]) {
      expect(html).toContain("Continue with Passkey");
      expect(html).toContain("Sign in with Apple");
      expect(html).toContain("Continue with Email");
      expect(html.toLowerCase()).not.toContain("sync key");
      expect(html).not.toContain("1password");
    }
  });

  test("zero legacy product identifier strings across public/, SPEC.md, README.md, docs/, decisions/, and workers/", () => {
    const legacy = new RegExp(["hidden", "[-_ ]", "word"].join(""), "i");
    const decisionFiles = readdirSync(new URL("../decisions", import.meta.url))
      .filter((f) => f.endsWith(".md"))
      .map((f) => `decisions/${f}`);
    const docFiles = readdirSync(new URL("../docs", import.meta.url))
      .filter((f) => f.endsWith(".md"))
      .map((f) => `docs/${f}`);
    const files = [
      "SPEC.md",
      "README.md",
      ...docFiles,
      ...decisionFiles,
      "public/app.js",
      "public/sync.js",
      "public/grants.js",
      "public/grant-client.js",
      "public/passkey.js",
      "public/unlock.html",
      "public/unlock.js",
      "public/connect.html",
      "public/connect.js",
      "public/index.html",
      "public/theme.js",
      "public/theme-toggle.js",
      "workers/selah-jev/src/worker.ts",
      "workers/selah-jev/README.md",
    ];
    for (const f of files) {
      expect(readFileSync(new URL(`../${f}`, import.meta.url), "utf8")).not.toMatch(legacy);
    }
  });
});


