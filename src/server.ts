// Selah Vault v2 HTTP router (pure Web Standards, zero cloudflare:workers import so Bun tests run directly).

import { type AuthEnv, handleAuthAndOAuth } from "./auth";
import { clearSessionCookieHeader, extractTokenFromRequest } from "./clients";
import { CORS_HEADERS } from "./library";
import { mcp } from "./mcp/index";
import { type Note, clientErrors, errorFields, noNote, observe } from "./observe";
import { YV_PREFIX, yvProxy } from "./yv";

export type Env = AuthEnv;

function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "content-type": "application/json", "cache-control": "no-store", ...extra },
  });
}

const edgeCache = (): Cache | null => (globalThis as { caches?: { default?: Cache } }).caches?.default ?? null;
const clientError = clientErrors();

export async function fetchApp(request: Request, env: Env): Promise<Response> {
  return observe(request, async (note) => {
    try {
      return await handle(request, env, note);
    } catch (error) {
      note(errorFields(error));
      return json({ error: "server error" }, 500);
    }
  });
}

export async function handle(request: Request, env: Env, note: Note = noNote): Promise<Response> {
  const url = new URL(request.url);
  const isRead = request.method === "GET" || request.method === "HEAD";

  if (url.pathname === "/save" && env.ASSETS && isRead) {
    return env.ASSETS.fetch(new Request(new URL("/", url), request));
  }
  if (url.pathname === "/config.json" && isRead) {
    return json({ yvpPublicAppKey: env.YVP_PUBLIC_APP_KEY || null });
  }
  if (url.pathname === "/api/client-error") {
    return clientError(request, note);
  }
  if (url.pathname.startsWith(`${YV_PREFIX}/`)) {
    return yvProxy(request, env.YVP_PUBLIC_APP_KEY, { fetch: (u, i) => fetch(u, i), cache: edgeCache() });
  }
  if (url.pathname === "/mcp") {
    return mcp(request, env.LIBRARY, note);
  }

  const authRes = await handleAuthAndOAuth(request, env);
  if (authRes) return authRes;

  if (url.pathname === "/v2" || url.pathname.startsWith("/v2/")) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
    const parsed = extractTokenFromRequest(request, url.pathname === "/v2/ws");
    if (!parsed) return json({ error: "unauthorized" }, 401);

    const stub = env.LIBRARY.get(env.LIBRARY.idFromName(parsed.userId));
    const doRes = await stub.fetch(request);

    if (url.pathname === "/v2/library" && request.method === "DELETE" && doRes.ok) {
      await env.DB.batch([
        env.DB.prepare("DELETE FROM passkeys WHERE user_id = ?").bind(parsed.userId),
        env.DB.prepare("DELETE FROM auth_challenges WHERE user_id = ?").bind(parsed.userId),
        env.DB.prepare("DELETE FROM oauth_codes WHERE user_id = ?").bind(parsed.userId),
        env.DB.prepare("DELETE FROM users WHERE id = ?").bind(parsed.userId),
      ]);
      return json({ deleted: true }, 200, { "set-cookie": clearSessionCookieHeader(request.url) });
    }
    return doRes;
  }

  if (env.ASSETS && isRead) return env.ASSETS.fetch(request);
  return json({ error: "not found" }, 404);
}
