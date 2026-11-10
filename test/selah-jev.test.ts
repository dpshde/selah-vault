import { describe, expect, test } from "bun:test";
import {
  allowedOrigin,
  DAILY_CAP_USD,
  MAX_BODY_BYTES,
  MAX_HIGHLIGHTS,
  USD_PER_MTOK,
  UPSTREAM_UA,
  handle,
  memoryCaps,
  parseRelevanceBody,
  scrubUpstreamBody,
  toSystemOne,
  usdFromUsage,
  type Env,
} from "../workers/selah-jev/src/worker";

const origin = "https://vault.selah.tools";
/** Fixture API key assembled in parts so source scanners never see a real-looking secret. */
const FIXTURE_KEY = ["test", "-", "key", "-", "not", "-", "real"].join("");
const good = {
  lib: "abcdef0123456789abcdef0123456789",
  ask: "filter" as const,
  passage: { ref: "ROM.8.18-25", text: "I consider that our present sufferings" },
  highlights: [
    { id: "JHN.3.16", ref: "JHN.3.16", text: "For God so loved the world" },
    { id: "PSA.23.1", ref: "PSA.23.1", text: "The LORD is my shepherd" },
  ],
};

function env(extra: Partial<Env> = {}): Env {
  return {
    TYPESAFE_API_KEY: FIXTURE_KEY,
    CAPS: memoryCaps(),
    ...extra,
  };
}

function post(body: unknown, headers: Record<string, string> = {}) {
  return new Request("https://jev.selah.tools/", {
    method: "POST",
    headers: { "content-type": "application/json", origin, ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("relevance request shape", () => {
  test("accepts the client shape and refuses unknown fields or oversize batches", () => {
    expect(parseRelevanceBody(good).ok).toBe(true);
    expect(parseRelevanceBody({ ...good, model: "jev-latest" }).ok).toBe(false);
    expect(parseRelevanceBody({ ...good, highlights: [] }).ok).toBe(false);
    const many = {
      ...good,
      highlights: Array.from({ length: MAX_HIGHLIGHTS + 1 }, (_, i) => ({
        id: String(i),
        ref: `JHN.1.${i + 1}`,
        text: "x",
      })),
    };
    expect(parseRelevanceBody(many).ok).toBe(false);
  });

  test("filter ask: only _relevant questions; no reason/tagline", () => {
    const req = toSystemOne(good);
    expect(req.model).toBe("jev-latest");
    expect(req.state.task).toContain("speak to `passage`");
    expect(req.state.passage.text).toContain("present sufferings");
    expect(req.state.highlights.h0).toEqual({ reference: "JHN.3.16", text: expect.stringContaining("For God so loved") });
    expect(JSON.stringify(req.questions["JHN.3.16_relevant"])).toContain("`highlights.h0`");
    expect(JSON.stringify(req.questions)).not.toContain("JHN.3.16 ·");
    expect(Object.keys(req.questions).filter((k) => k.endsWith("_relevant"))).toHaveLength(2);
    expect(req.questions["JHN.3.16_reason"]).toBeUndefined();
    expect(req.questions["JHN.3.16_obviousness"]).toBeUndefined();
    expect(JSON.stringify(req.questions)).not.toContain("_reason");
  });

  test("sort ask: only _obviousness; topic ask: only _closeness against free text", () => {
    const sortReq = toSystemOne({ ...good, ask: "sort" });
    expect(Object.keys(sortReq.questions)).toEqual(["JHN.3.16_obviousness", "PSA.23.1_obviousness"]);
    expect(sortReq.questions["JHN.3.16_obviousness"]).toMatchObject({ type: "score" });

    const topicBody = {
      lib: good.lib,
      ask: "topic" as const,
      topic: "grace",
      highlights: good.highlights,
    };
    expect(parseRelevanceBody(topicBody).ok).toBe(true);
    const topicReq = toSystemOne(topicBody);
    expect(topicReq.state.task).toContain("`topic`");
    expect((topicReq.state as { topic: string }).topic).toBe("grace");
    expect((topicReq.state as { passage?: unknown }).passage).toBeUndefined();
    expect(Object.keys(topicReq.questions)).toEqual(["JHN.3.16_closeness", "PSA.23.1_closeness"]);
  });

  test("usd comes from billable input tokens at TypeSafe's rate", () => {
    expect(usdFromUsage(undefined)).toBe(0);
    expect(usdFromUsage({ input_tokens: 1_000_000 })).toBeCloseTo(USD_PER_MTOK);
  });
});

describe("selah-jev Worker", () => {
  test("CORS allows the alias and preview versions of the vault, and no look-alikes", () => {
    expect(allowedOrigin("https://sync.selah.tools")).toBe(true);
    expect(allowedOrigin("https://1a2b3c4d-selah-vault.dpshade.workers.dev")).toBe(true);
    expect(allowedOrigin("https://selah-vault.evil.workers.dev")).toBe(false);
    expect(allowedOrigin("https://x-selah-vault.dpshade.workers.dev.evil.example")).toBe(false);
  });

  test("CORS allows only the vault origin", async () => {
    const ok = await handle(new Request("https://jev.selah.tools/", { method: "OPTIONS", headers: { origin } }), env());
    expect(ok.status).toBe(204);
    expect(ok.headers.get("access-control-allow-origin")).toBe(origin);

    const bad = await handle(
      new Request("https://jev.selah.tools/", { method: "OPTIONS", headers: { origin: "https://evil.example" } }),
      env(),
    );
    expect(bad.status).toBe(403);

    const blocked = await handle(post(good, { origin: "https://evil.example" }), env(), (async () => new Response("{}")) as typeof fetch);
    expect(blocked.status).toBe(403);
  });

  test("refuses an oversized body", async () => {
    const huge = "x".repeat(MAX_BODY_BYTES + 10);
    expect((await handle(post(huge), env())).status).toBe(413);
    expect((await handle(post(good, { "content-length": String(MAX_BODY_BYTES + 1) }), env())).status).toBe(413);
  });

  test("refuses when the daily spend cap is already met", async () => {
    const caps = memoryCaps();
    const day = `spend:${new Date().toISOString().slice(0, 10)}`;
    await caps.put(day, String(DAILY_CAP_USD));
    const res = await handle(post(good), { TYPESAFE_API_KEY: "k", CAPS: caps });
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "daily spend cap" });
  });

  test("refuses when a library hits the per-minute rate limit", async () => {
    const caps = memoryCaps();
    const minute = `rate:${good.lib}:${new Date().toISOString().slice(0, 16)}`;
    await caps.put(minute, "12");
    const res = await handle(post(good), { TYPESAFE_API_KEY: "k", CAPS: caps });
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "library rate limit" });
  });

  test("proxies a valid body to TypeSafe and never echoes the key", async () => {
    const seen: Array<{ url: string; headers: Headers; body: unknown }> = [];
    const upstream = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({
        url: String(url),
        headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body)),
      });
      return new Response(
        JSON.stringify({
          model: "jev-1.14.0",
          answers: { "JHN.3.16_relevant": { type: "noul", noul: 0.9 } },
          usage: { input_tokens: 1000, output_tokens: 10 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
    const res = await handle(post(good), env(), upstream);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.answers["JHN.3.16_relevant"].noul).toBe(0.9);
    expect(data.usd).toBeCloseTo((1000 / 1_000_000) * USD_PER_MTOK);
    expect(seen[0].url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(seen[0].headers.get("authorization")).toBe(`Bearer ${FIXTURE_KEY}`);
    expect(seen[0].headers.get("content-type")).toBe("application/json");
    expect(seen[0].headers.get("accept")).toBe("application/json");
    expect(seen[0].headers.get("user-agent")).toBe(UPSTREAM_UA);
    expect(JSON.stringify(data)).not.toContain(FIXTURE_KEY);
    expect((seen[0].body as { state: { highlights: Record<string, { text: string }> } }).state.highlights.h0.text).toContain("For God so loved");
  });

  test("shape refusal does not call upstream", async () => {
    let called = 0;
    const upstream = (async () => {
      called++;
      return new Response("{}");
    }) as typeof fetch;
    const res = await handle(post({ ...good, extra: true }), env(), upstream);
    expect(res.status).toBe(400);
    expect(called).toBe(0);
  });

  test("scrubUpstreamBody redacts keys and caps length", () => {
    // Assemble fake token-shaped strings so scanners don't treat the source as a real secret.
    const fakeBearer = ["Be", "arer ", "FAKE", "TOKEN", "FOR", "SCRUB", "TEST", "ONLY"].join("");
    const fakeKey = ["sk", "-", "fake", "scrub", "test", "only", "0000"].join("");
    const raw = `error unauthorized ${fakeBearer} api_key=${fakeKey} more ` + "x".repeat(400);
    const out = scrubUpstreamBody(raw);
    expect(out.length).toBeLessThanOrEqual(300);
    expect(out).toContain("Bearer [redacted]");
    expect(out).toContain("[redacted]");
    expect(out).not.toContain(fakeBearer);
    expect(out).not.toContain(fakeKey);
  });

  test("upstream 401 becomes ranking unavailable with scrubbed diagnostic; key is trimmed and never echoed", async () => {
    let headers: Headers | null = null;
    const upstream = (async (_url: string | URL | Request, init?: RequestInit) => {
      headers = new Headers(init?.headers);
      return new Response(
        JSON.stringify({ error: "unauthorized", detail: `Bearer ${FIXTURE_KEY} was rejected` }),
        { status: 401 },
      );
    }) as typeof fetch;
    const logs: unknown[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args);
    };
    try {
      const res = await handle(post(good), env({ TYPESAFE_API_KEY: `  ${FIXTURE_KEY}\n` }), upstream);
      expect(headers!.get("authorization")).toBe(`Bearer ${FIXTURE_KEY}`);
      expect(headers!.get("user-agent")).toBe(UPSTREAM_UA);
      expect(headers!.get("accept")).toBe("application/json");
      expect(res.status).toBe(502);
      expect(res.headers.get("access-control-allow-origin")).toBe(origin);
      const body = await res.json();
      expect(body.error).toBe("ranking unavailable");
      expect(body.upstream_status).toBe(401);
      expect(body.upstream_body).toContain("unauthorized");
      expect(body.upstream_body).toContain("Bearer [redacted]");
      expect(JSON.stringify(body)).not.toContain(FIXTURE_KEY);
      expect(JSON.stringify(logs)).toContain("upstream_status");
      expect(JSON.stringify(logs)).not.toContain(FIXTURE_KEY);
    } finally {
      console.log = orig;
    }
  });

  test("upstream 403 and 500 include upstream_status and a scrubbed body snippet", async () => {
    const fakeKey = ["sk", "-", "should", "-", "not", "-", "leak", "-", "abcdef"].join("");
    for (const [status, error] of [
      [403, "ranking unavailable"],
      [500, "upstream error"],
    ] as const) {
      const upstream = (async () =>
        new Response(JSON.stringify({ message: "blocked", api_key: fakeKey }), { status })) as typeof fetch;
      const res = await handle(post(good), env(), upstream);
      expect(res.status).toBe(502);
      const body = await res.json();
      expect(body).toMatchObject({ error, upstream_status: status });
      expect(body.upstream_body).toContain("blocked");
      expect(body.upstream_body).not.toContain(fakeKey);
      expect(body.upstream_body).toContain("[redacted]");
    }
  });
});
