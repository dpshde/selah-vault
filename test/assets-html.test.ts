import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { staticAssetPath } from "../src/assets";
import { createTestEnv } from "./env";

const connectHtml = readFileSync(new URL("../public/connect.html", import.meta.url), "utf8");
const indexHtml = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const unlockHtml = readFileSync(new URL("../public/unlock.html", import.meta.url), "utf8");

/**
 * Mimics Workers Assets `html_handling`: `*.html` → 307 to the extensionless path;
 * clean URLs serve the HTML body with 200. Returning a `.html` Assets response from a
 * runWorkerFirst route is what caused the /connect loop in production.
 */
function createHtmlHandlingAssets(): Fetcher {
  const pages: Record<string, string> = {
    "/": indexHtml,
    "/connect": connectHtml,
    "/unlock": unlockHtml,
  };
  return {
    fetch(input: RequestInfo | URL) {
      const req = input instanceof Request ? input : new Request(String(input));
      const path = new URL(req.url).pathname;
      if (path.endsWith(".html")) {
        const clean = staticAssetPath(path);
        return Promise.resolve(
          new Response(null, {
            status: 307,
            headers: { location: clean, "content-type": "text/html" },
          }),
        );
      }
      const body = pages[path];
      if (body === undefined) return Promise.resolve(new Response("not found", { status: 404 }));
      return Promise.resolve(
        new Response(body, {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
      );
    },
  } as Fetcher;
}

describe("staticAssetPath", () => {
  test("maps html paths to the extensionless Assets URLs", () => {
    expect(staticAssetPath("/connect.html")).toBe("/connect");
    expect(staticAssetPath("/index.html")).toBe("/");
    expect(staticAssetPath("/unlock.html")).toBe("/unlock");
    expect(staticAssetPath("/connect")).toBe("/connect");
    expect(staticAssetPath("/")).toBe("/");
  });
});

describe("HTML asset routes without redirect loops", () => {
  test("GET /connect returns 200 HTML with no redirect (OAuth connect page)", async () => {
    const h = createTestEnv({ ASSETS: createHtmlHandlingAssets() });
    const res = await h.fetch("/connect", { headers: { accept: "text/html" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("content-type") ?? "").toMatch(/text\/html/);
    const body = await res.text();
    expect(body).toContain("connect");
    expect(body).toEqual(connectHtml);
  });

  test("GET /oauth/authorize (browser Accept) serves connect HTML without redirect", async () => {
    const h = createTestEnv({ ASSETS: createHtmlHandlingAssets() });
    const res = await h.fetch("/oauth/authorize", { headers: { accept: "text/html" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
    expect(await res.text()).toEqual(connectHtml);
  });

  test("worker-first HTML routes /, /index.html, /connect.html and /unlock stay loop-free", async () => {
    const h = createTestEnv({ ASSETS: createHtmlHandlingAssets() });

    const home = await h.fetch("/", { headers: { accept: "text/html" } });
    expect(home.status).toBe(200);
    expect(home.headers.get("location")).toBeNull();
    expect(await home.text()).toEqual(indexHtml);

    // /index.html is rewritten to Assets `/` so Assets never 307s into a Worker loop.
    const index = await h.fetch("/index.html", { headers: { accept: "text/html" } });
    expect(index.status).toBe(200);
    expect(index.headers.get("location")).toBeNull();
    expect(await index.text()).toEqual(indexHtml);

    // /connect.html is rewritten to Assets `/connect` (same page, no 307).
    const connectDotHtml = await h.fetch("/connect.html", { headers: { accept: "text/html" } });
    expect(connectDotHtml.status).toBe(200);
    expect(connectDotHtml.headers.get("location")).toBeNull();
    expect(await connectDotHtml.text()).toEqual(connectHtml);

    // /unlock is not runWorkerFirst in prod, but if ASSETS is bound through the Worker fallthrough
    // it must still serve 200 without bouncing on .html.
    const unlock = await h.fetch("/unlock", { headers: { accept: "text/html" } });
    expect(unlock.status).toBe(200);
    expect(unlock.headers.get("location")).toBeNull();
    expect(await unlock.text()).toEqual(unlockHtml);

    const unlockHtmlPath = await h.fetch("/unlock.html", { headers: { accept: "text/html" } });
    expect(unlockHtmlPath.status).toBe(200);
    expect(unlockHtmlPath.headers.get("location")).toBeNull();
    expect(await unlockHtmlPath.text()).toEqual(unlockHtml);

    // /save rewrites to the home page asset.
    const save = await h.fetch("/save", { headers: { accept: "text/html" } });
    expect(save.status).toBe(200);
    expect(await save.text()).toEqual(indexHtml);
  });

  test("regression: fetching Assets /connect.html would 307 to /connect (the old loop source)", async () => {
    const assets = createHtmlHandlingAssets();
    const bad = await assets.fetch(new Request("https://vault.selah.tools/connect.html"));
    expect(bad.status).toBe(307);
    expect(bad.headers.get("location")).toBe("/connect");
    const good = await assets.fetch(new Request("https://vault.selah.tools/connect"));
    expect(good.status).toBe(200);
  });
});
