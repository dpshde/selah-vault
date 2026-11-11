import { expect, test } from "bun:test";
import { yvProxy } from "../src/yv";

/** A stand-in for Cloudflare's cache. */
function memoryCache() {
  const m = new Map<string, Response>();
  return {
    m,
    match: async (r: Request) => m.get(r.url)?.clone(),
    put: async (r: Request, res: Response) => void m.set(r.url, res.clone()),
  } as unknown as Cache & { m: Map<string, Response> };
}

function upstream() {
  const calls: { url: string; key: string | null }[] = [];
  const fetch = (async (input: URL | string, init?: RequestInit) => {
    calls.push({ url: String(input), key: new Headers(init?.headers).get("x-yvp-app-key") });
    return new Response(JSON.stringify({ id: "JHN.3.16", content: "<p>For God so loved</p>" }), { headers: { "content-type": "application/json", "set-cookie": "x=1" } });
  }) as typeof fetch;
  return { calls, fetch };
}

const get = (path: string, init?: RequestInit) => new Request(`https://vault.selah.tools${path}`, init);

test("a passage is fetched once with the Worker's key, then served from the edge cache", async () => {
  const cache = memoryCache(), up = upstream();
  const a = await yvProxy(get("/yv/v1/bibles/3034/passages/JHN.3.16?include_headings=true&format=html"), "KEY", { fetch: up.fetch, cache });
  expect(a.status).toBe(200);
  expect(a.headers.get("x-vault-cache")).toBe("MISS");
  expect(a.headers.get("set-cookie")).toBeNull();
  expect(a.headers.get("cache-control")).toBe("public, max-age=86400");
  expect(await a.json()).toMatchObject({ id: "JHN.3.16" });
  const b = await yvProxy(get("/yv/v1/bibles/3034/passages/JHN.3.16?format=html&include_headings=true"), "KEY", { fetch: up.fetch, cache });
  expect(b.headers.get("x-vault-cache")).toBe("HIT");
  expect(up.calls).toEqual([{ url: "https://api.youversion.com/v1/bibles/3034/passages/JHN.3.16?format=html&include_headings=true", key: "KEY" }]);
});

test("only <si-passage>'s few GETs, for the one Bible, get through", async () => {
  const up = upstream();
  const deps = { fetch: up.fetch, cache: null };
  for (const ok of ["/yv/v1/bibles/3034", "/yv/v1/bibles/3034/passages/PSA.23", "/yv/v1/bibles/3034/passages/ROM.8.28-ROM.8.30", "/yv/v1/fonts/1/stylesheet"])
    expect((await yvProxy(get(ok), "KEY", deps)).status).toBe(200);
  for (const no of ["/yv/v1/bibles/111", "/yv/v1/bibles/3034/passages/../../users", "/yv/v1/users/me", "/yv/v1/bibles"])
    expect((await yvProxy(get(no), "KEY", deps)).status).toBe(404);
  expect((await yvProxy(get("/yv/v1/bibles/3034", { method: "POST" }), "KEY", deps)).status).toBe(405);
  expect((await yvProxy(get("/yv/v1/bibles/3034"), undefined, deps)).status).toBe(404);
});

test("the caller's app_key is dropped; the fonts stylesheet gets the Worker's", async () => {
  const up = upstream();
  await yvProxy(get("/yv/v1/fonts/1/stylesheet?app_key=CALLER"), "KEY", { fetch: up.fetch, cache: null });
  expect(up.calls[0].url).toBe("https://api.youversion.com/v1/fonts/1/stylesheet?app_key=KEY");
});

test("an unreplaced placeholder key is treated as missing and never sent upstream", async () => {
  const up = upstream();
  const deps = { fetch: up.fetch, cache: null };
  expect((await yvProxy(get("/yv/v1/bibles/3034/passages/ROM.8.18"), "YVP_PUBLIC_APP_KEY", deps)).status).toBe(404);
  expect((await yvProxy(get("/yv/v1/fonts/1/stylesheet?app_key=YVP_PUBLIC_APP_KEY"), "YVP_PUBLIC_APP_KEY", deps)).status).toBe(404);
  expect(up.calls).toEqual([]);
});
