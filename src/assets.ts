// Helpers for serving Workers Static Assets without html_handling redirect loops.
// Assets 307 `*.html` → the extensionless path. If that clean URL is in
// `runWorkerFirst`, returning the redirect to the client sends them back into
// the Worker, which fetches `.html` again — an endless loop (seen on /connect).

/** Map a request path to the canonical Assets URL that will not 307. */
export function staticAssetPath(pathname: string): string {
  if (pathname === "/index.html") return "/";
  if (pathname.length > 5 && pathname.endsWith(".html")) return pathname.slice(0, -5);
  return pathname;
}

/** Fetch from `env.ASSETS` using a path Assets will serve with 200 (not 307). */
export function fetchStaticAsset(assets: Fetcher, request: Request, pathname?: string): Promise<Response> {
  const url = new URL(request.url);
  const path = staticAssetPath(pathname ?? url.pathname);
  if (path === url.pathname && pathname === undefined) return assets.fetch(request);
  url.pathname = path;
  return assets.fetch(new Request(url, request));
}
