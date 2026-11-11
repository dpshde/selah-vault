// A same-origin, edge-cached pass-through to YouVersion's API for a row's verse text (scripture-inline's
// <si-passage>, pointed here with yvp-api-host). YouVersion answers in about a second; the Berean Standard
// Bible's text doesn't change, so Cloudflare's cache keeps each answer and everyone after the first person
// gets it from the nearest data center. Only the few GETs <si-passage> makes are allowed through, for the
// one Bible the app shows, with the Worker's own app key. YouVersion no longer sees visitors' addresses.

export const YV_PREFIX = "/yv";
const UPSTREAM = "https://api.youversion.com";
const BIBLE = "3034"; // Berean Standard Bible, the only version the app shows
const ALLOWED = [
  new RegExp(`^/v1/bibles/${BIBLE}$`),
  new RegExp(`^/v1/bibles/${BIBLE}/passages/[A-Z0-9]{3}\\.[0-9]+(?:\\.[0-9]+)?(?:-[A-Z0-9.]+)?$`),
  /^\/v1\/fonts\/1\/stylesheet$/,
];
/** A week at the edge and a day in the browser: the text is fixed, and a week bounds any correction. */
const EDGE_TTL = 7 * 24 * 3600;
const BROWSER_TTL = 24 * 3600;

type Deps = { fetch: typeof fetch; cache: Cache | null };

/** A missing key, or the unreplaced build-time placeholder, must not be sent upstream. */
export function usableYvpAppKey(appKey: string | undefined | null): string | undefined {
  const key = appKey?.trim();
  if (!key || key === "YVP_PUBLIC_APP_KEY") return undefined;
  return key;
}


export async function yvProxy(request: Request, appKey: string | undefined, deps: Deps): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.slice(YV_PREFIX.length);
  if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { status: 405, headers: { allow: "GET, HEAD" } });
  const key = usableYvpAppKey(appKey);
  if (!key) return new Response(null, { status: 404 });
  if (!ALLOWED.some((re) => re.test(path))) return new Response(null, { status: 404 });
  const query = new URLSearchParams(url.search);
  query.delete("app_key"); // the Worker sends its own; never part of the cache key
  query.sort();
  const qs = query.toString();
  const target = `${UPSTREAM}${path}${qs ? `?${qs}` : ""}`;
  const cacheKey = new Request(`https://yv-cache.internal${path}${qs ? `?${qs}` : ""}`);
  const hit = await deps.cache?.match(cacheKey);
  if (hit) return withHeaders(hit, "HIT");
  const upstream = new URL(target);
  if (path.startsWith("/v1/fonts/")) upstream.searchParams.set("app_key", key);
  const res = await deps.fetch(upstream, { headers: { "x-yvp-app-key": key, accept: request.headers.get("accept") ?? "*/*" } });
  if (!res.ok) return withHeaders(new Response(res.body, { status: res.status, headers: { "content-type": res.headers.get("content-type") ?? "application/json" } }), "BYPASS", false);
  const body = await res.arrayBuffer();
  const stored = new Response(body, {
    status: 200,
    headers: { "content-type": res.headers.get("content-type") ?? "application/json", "cache-control": `public, max-age=${EDGE_TTL}` },
  });
  if (deps.cache) await deps.cache.put(cacheKey, stored.clone());
  return withHeaders(stored, "MISS");
}

function withHeaders(res: Response, state: string, cacheable = true): Response {
  const out = new Response(res.body, res);
  out.headers.set("cache-control", cacheable ? `public, max-age=${BROWSER_TTL}` : "no-store");
  out.headers.set("x-vault-cache", state);
  out.headers.delete("set-cookie");
  return out;
}
