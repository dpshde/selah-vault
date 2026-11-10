import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { clientErrors, errorFields, observe, reportFor, routeOf, scrub } from "../src/observe";
import { makeToken, newUserId } from "../src/clients";
import { TEST_ORIGIN, createTestEnv } from "./env";

let lines: string[] = [];
let spies: Array<{ mockRestore(): void }> = [];

beforeEach(() => {
  lines = [];
  spies = (["log", "error", "warn", "info", "debug"] as const).map((level) =>
    spyOn(console, level).mockImplementation((...args: unknown[]) => void lines.push(args.map(String).join(" "))),
  );
});

afterEach(() => spies.forEach((s) => s.mockRestore()));

const logged = () => lines.map((l) => JSON.parse(l));

describe("scrub", () => {
  test("scrubs sv2 tokens, user ids, OTP codes, quoted text, references, emails, and query strings", () => {
    const uid = newUserId();
    const tok = makeToken(uid);
    const text = scrub(
      `bad token ${tok.raw} user ${uid} otp 482910 ` +
        `"For God so loved the world" 'JHN.3.16' saving John 3:16 and Rom 5:3-5 and JHN.3.16-18 from reader@selah.tools at https://vault.selah.tools/save?ref=JHN.3.16#token=${tok.raw}`,
    );
    for (const secret of [tok.raw, tok.secret, uid, "482910", "loved", "JHN", "3:16", "5:3", "reader@selah.tools", "ref=", "#token"]) {
      expect(text).not.toContain(secret);
    }
    expect(text).toContain("https://vault.selah.tools/save");
  });

  test("keeps an error's shape readable", () => {
    expect(scrub("Cannot read properties of undefined (reading 'color')")).toBe(
      "Cannot read properties of undefined (reading '…')",
    );
    expect(scrub("addEventListener is not a function")).toBe("addEventListener is not a function");
    expect(scrub("x".repeat(1000)).length).toBe(300);
  });

  test("errorFields returns class and scrubbed message", () => {
    const tok = makeToken(newUserId());
    expect(errorFields(new TypeError(`no ${tok.raw}`))).toEqual({ error_class: "TypeError", error: "no [redacted]" });
    expect(errorFields("thrown string").error_class).toBe("string");
  });
});

describe("request logs", () => {
  test("routes map to templates without leaking ids", () => {
    expect(routeOf("/v2/events")).toBe("/v2/events");
    expect(routeOf("/v2/bootstrap")).toBe("/v2/bootstrap");
    expect(routeOf("/v2/grants/gr_abc123")).toBe("/v2/grants/:id");
    expect(routeOf("/v2/grants/self")).toBe("/v2/grants/self");
    expect(routeOf("/mcp")).toBe("/mcp");
    expect(routeOf("/oauth/token")).toBe("/oauth/token");
    expect(routeOf("/something/else")).toBe("other");
  });

  test("logs one redacted line per request without leaking tokens, emails, codes, or refs", async () => {
    const s = createTestEnv();
    const session = await s.createUserSession("alice@selah.tools", "Alice");
    lines = [];

    await s.fetch("/v2/events?after=0&ref=JHN.3.16", { headers: { authorization: `Bearer ${session.token}` } });
    await s.fetch("/v2/bootstrap", { headers: { authorization: "Bearer nope" } });
    await s.fetch("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${session.token}` },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "add_highlight", arguments: { reference: "John 3:16" } },
      }),
    });
    await s.fetch("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer invalid_secret_12345" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" }),
    });
    await s.fetch("/save?ref=JHN.3.16&color=yellow");

    const all = lines.join("\n");
    for (const secret of [session.token, session.user.id, "alice@selah.tools", "invalid_secret_12345", "JHN", "John", "3:16", "after=", "Bearer"]) {
      expect(all).not.toContain(secret);
    }
    const [read, wrong, tool, badToken, save] = logged();
    expect(read).toMatchObject({ event: "request", method: "GET", route: "/v2/events", status: 200 });
    expect(typeof read.ms).toBe("number");
    expect(wrong).toMatchObject({ route: "/v2/bootstrap", status: 401 });
    expect(tool).toMatchObject({ route: "/mcp", status: 200, mcp: "ok", mcp_methods: "tools/call", tools: "add_highlight" });
    expect(badToken).toMatchObject({ route: "/mcp", status: 401, mcp: "unauthorized" });
    expect(save).toMatchObject({ route: "/save" });
  });

  test("failures log class and scrubbed message at error level and answer 500", async () => {
    const tok = makeToken(newUserId());
    const errors: string[] = [];
    const res = await observe(
      new Request(`${TEST_ORIGIN}/v2/events`),
      async (note) => {
        note(errorFields(new RangeError(`broke on ${tok.raw}`)));
        return new Response(null, { status: 500 });
      },
      { log: () => {}, error: (line: string) => void errors.push(line) },
    );
    expect(res.status).toBe(500);
    expect(errors).toHaveLength(1);
    expect(errors[0]).not.toContain(tok.raw);
    expect(JSON.parse(errors[0])).toMatchObject({ status: 500, error_class: "RangeError", error: "broke on [redacted]" });
  });

  test("server answers 500 when a binding throws and logs scrubbed error", async () => {
    const s = createTestEnv({
      DB: {
        prepare() {
          throw new Error("D1 down");
        },
      } as unknown as D1Database,
    });
    const res = await s.fetch("/auth/email/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "reader@selah.tools" }),
    });
    expect(res.status).toBe(500);
    expect(logged()[0]).toMatchObject({ status: 500, error_class: "Error", error: "D1 down" });
  });
});

describe("browser error reports", () => {
  const post = (body: unknown, headers: Record<string, string> = {}) =>
    new Request(`${TEST_ORIGIN}/api/client-error`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: TEST_ORIGIN, ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });

  test("a report is logged with only its scrubbed shape", async () => {
    const tok = makeToken(newUserId());
    const handler = clientErrors();
    const res = await handler(
      post({
        kind: "error",
        name: "TypeError",
        message: `Cannot read 'x' of ${tok.raw} while saving John 3:16`,
        source: "/app.js",
        line: 12,
        col: 4,
        stack: `/app.js:12:4 /connect.js:80:9 ${tok.raw} https://evil.test/x.js:1:1`,
        page: "/",
        verse: "For God so loved the world",
      }),
    );
    expect(res.status).toBe(204);
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain(tok.raw);
    expect(lines[0]).not.toContain("loved");
    expect(lines[0]).not.toContain("3:16");
    expect(JSON.parse(lines[0])).toEqual({
      event: "client_error",
      kind: "error",
      name: "TypeError",
      message: "Cannot read '…' of [redacted] while saving [ref]",
      source: "/app.js",
      line: 12,
      col: 4,
      stack: "/app.js:12:4 /connect.js:80:9",
      page: "/",
    });
  });

  test("rejects cross-origin, oversized, malformed, and rate-limited requests", async () => {
    let t = 1_000_000;
    const handler = clientErrors({ perMinute: 2, now: () => t });
    expect((await handler(post({ message: "x" }, { origin: "https://evil.test" }))).status).toBe(403);
    expect((await handler(post({ message: "x".repeat(5000) }))).status).toBe(413);
    expect((await handler(post("{not json"))).status).toBe(400);
    expect((await handler(new Request(`${TEST_ORIGIN}/api/client-error`))).status).toBe(405);
    expect((await handler(post({ message: "e1" }))).status).toBe(204);
    expect((await handler(post({ message: "e2" }))).status).toBe(204);
    expect((await handler(post({ message: "e3" }))).status).toBe(429);
    t += 60_000;
    expect((await handler(post({ message: "e4" }))).status).toBe(204);
  });

  test("reportFor extracts only site frames", () => {
    const err = new TypeError("bad 'thing'");
    err.stack = `TypeError: bad\n    at render (${TEST_ORIGIN}/app.js:10:5)\n    at https://cdn.other.test/lib.js:1:2`;
    const report = reportFor(
      { kind: "error", error: err, filename: `${TEST_ORIGIN}/app.js?v=1`, lineno: 10, colno: 5 },
      { origin: TEST_ORIGIN, pathname: "/" },
    );
    expect(report).toEqual({
      kind: "error",
      name: "TypeError",
      message: "bad '…'",
      source: "/app.js",
      line: 10,
      col: 5,
      stack: "/app.js:10:5 external:1:2",
      page: "/",
    });
  });
});
