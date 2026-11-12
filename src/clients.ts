// Connected OAuth 2.1 clients, scopes, and shared token/crypto primitives for Selah Vault v2.

export interface ClientMetadata {
  id: string;
  name: string;
  icon: string | null;
  homepage: string;
}

export const SCOPES = [
  "read",
  "passages:write",
  "highlights:write",
  "notes:write",
  "srs:write",
] as const;

export type OAuthScope = (typeof SCOPES)[number];
const SCOPE_SET = new Set<string>(SCOPES);

export const OAUTH_GRANT_TTL_SEC = 90 * 86_400; // 7,776,000s (90 days)
export const SESSION_TTL_SEC = 365 * 86_400;
export const OAUTH_CODE_TTL_MS = 5 * 60_000;

const WEB_ORIGINS: Record<string, ClientMetadata> = {
  "https://route.bible": {
    id: "route.bible",
    name: "route.bible",
    icon: "/apps/route-bible.svg",
    homepage: "https://route.bible",
  },
  "https://www.route.bible": {
    id: "route.bible",
    name: "route.bible",
    icon: "/apps/route-bible.svg",
    homepage: "https://route.bible",
  },
  "https://vault-highlights-route-bible.dpshade.workers.dev": {
    id: "vault-highlights-route-bible.dpshade.workers.dev",
    name: "route.bible (preview)",
    icon: "/apps/route-bible.svg",
    homepage: "https://vault-highlights-route-bible.dpshade.workers.dev",
  },
  "https://proofs.dpshade.workers.dev": {
    id: "proofs.dpshade.workers.dev",
    name: "Proofs",
    icon: "/apps/proofs.svg",
    homepage: "https://proofs.dpshade.workers.dev",
  },
  "https://proofs.selah.tools": {
    id: "proofs.selah.tools",
    name: "Proofs",
    icon: "/apps/proofs.svg",
    homepage: "https://proofs.selah.tools",
  },
};

const PROOFS_IDS = new Set([
  "proofs",
  "proofs-ios",
  "proofs.selah.tools",
  "proofs.dpshade.workers.dev",
  "https://proofs.selah.tools",
  "https://proofs.dpshade.workers.dev",
  "proofs://oauth/callback",
]);

const ROUTE_IDS = new Set([
  "route.bible",
  "https://route.bible",
  "vault-highlights-route-bible.dpshade.workers.dev",
  "https://vault-highlights-route-bible.dpshade.workers.dev",
]);

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * route.bible's Workers previews: the `route-bible` Worker itself, its per-branch version
 * aliases (`<branch>-route-bible`), and the manual `route-bible-preview` Worker, all on the
 * account's own workers.dev subdomain. Only that account can publish to these hostnames.
 */
export const ROUTE_PREVIEW_ORIGIN_RE = /^https:\/\/(?:[a-z0-9-]+-)?route-bible(?:-preview)?\.dpshade\.workers\.dev$/;

function routePreviewClient(origin: string): ClientMetadata | null {
  if (!ROUTE_PREVIEW_ORIGIN_RE.test(origin)) return null;
  const host = new URL(origin).hostname;
  return { id: host, name: "route.bible (preview)", icon: "/apps/route-bible.svg", homepage: origin };
}

export function validateOAuthClient(clientIdRaw: unknown, redirectUriRaw: unknown): ClientMetadata | null {
  if (typeof clientIdRaw !== "string" || typeof redirectUriRaw !== "string") return null;
  const clientId = clientIdRaw.trim();
  const redirectUri = redirectUriRaw.trim();
  if (!clientId || clientId.length > 200 || !redirectUri || redirectUri.length > 500) return null;

  if (redirectUri === "proofs://oauth/callback") {
    if (!PROOFS_IDS.has(clientId)) return null;
    return { id: clientId, name: "Proofs", icon: "/apps/proofs.svg", homepage: "https://proofs.selah.tools" };
  }

  let url: URL;
  try {
    url = new URL(redirectUri);
  } catch {
    return null;
  }
  if (url.username || url.password || url.hash) return null;

  if (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname)) {
    return { id: clientId, name: "Local development", icon: null, homepage: url.origin };
  }

  if (url.protocol !== "https:") return null;
  const meta = WEB_ORIGINS[url.origin] ?? routePreviewClient(url.origin);
  if (!meta) return null;

  if (url.origin.includes("route.bible") || url.origin.includes("route-bible")) {
    if (!ROUTE_IDS.has(clientId) && clientId !== url.origin && clientId !== url.hostname) return null;
    return { ...meta, id: clientId };
  }
  if (url.origin.includes("proofs.")) {
    if (!PROOFS_IDS.has(clientId) && clientId !== url.origin && clientId !== url.hostname) return null;
    return { ...meta, id: clientId };
  }
  return clientId === url.origin || clientId === url.hostname || clientId === meta.id ? { ...meta, id: clientId } : null;
}

export function parseScopes(raw: unknown): OAuthScope[] | null {
  const parts = Array.isArray(raw)
    ? raw
    : String(raw === undefined || raw === null || raw === "" ? "read" : raw)
        .trim()
        .split(/\s+/)
        .filter(Boolean);
  if (!parts.length) return null;
  for (const s of parts) {
    if (typeof s !== "string" || !SCOPE_SET.has(s)) return null;
  }
  return [...new Set(parts as OAuthScope[])].sort();
}

export function hasReadScope(scopes: readonly string[]): boolean {
  return scopes.includes("*") || scopes.includes("read");
}

export function scopeAllowsKind(scopes: readonly string[], kind: string): boolean {
  if (scopes.includes("*")) return true;
  if (kind === "passage.saved" || kind === "passage.removed") return scopes.includes("passages:write");
  if (kind === "highlight.set" || kind === "highlight.removed" || kind === "color.set" || kind === "color.removed") {
    return scopes.includes("highlights:write");
  }
  if (kind === "note.block.set" || kind === "note.block.deleted") return scopes.includes("notes:write");
  if (kind === "srs.reviewed" || kind === "srs.card") return scopes.includes("srs:write");
  return false;
}

export const USER_ID_RE = /^u_[A-Za-z0-9_-]{22}$/;
export const TOKEN_RE = /^sv2\.(u_[A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/;
export const SESSION_COOKIE = "selah_session";

export interface ParsedToken {
  raw: string;
  userId: string;
  secret: string;
}

export function parseToken(raw: string | null | undefined): ParsedToken | null {
  if (!raw) return null;
  const m = TOKEN_RE.exec(raw.trim());
  if (!m) return null;
  return { raw: m[0], userId: m[1], secret: m[2] };
}

export function readCookie(cookieHeader: string | null, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const k = part.slice(0, eq).trim();
    if (k === name) return part.slice(eq + 1).trim();
  }
  return null;
}

export function extractTokenFromRequest(request: Request, allowQueryOrWs = false): ParsedToken | null {
  const auth = request.headers.get("authorization");
  if (auth) {
    const m = /^Bearer\s+(\S+)$/i.exec(auth.trim());
    return m ? parseToken(m[1]) : null;
  }
  if (allowQueryOrWs) {
    const proto = request.headers.get("sec-websocket-protocol");
    if (proto) {
      for (const item of proto.split(",").map((s) => s.trim())) {
        if (item.startsWith("token.")) {
          const parsed = parseToken(item.slice(6));
          if (parsed) return parsed;
        }
      }
    }
    const q = new URL(request.url).searchParams.get("token");
    if (q) return parseToken(q);
  }
  return parseToken(readCookie(request.headers.get("cookie"), SESSION_COOKIE));
}

/** True when the request carries an Authorization Bearer token (not merely a session cookie). */
export function hasBearerAuthorization(request: Request): boolean {
  return /^Bearer\s+\S+/i.test((request.headers.get("authorization") ?? "").trim());
}

/**
 * Cookie-authenticated state-changing `/v2` requests must present an Origin that
 * exactly matches the Worker origin. Bearer tokens skip this check (SPA/API clients).
 * Returns an error message when the check fails, otherwise null.
 */
export function cookieWriteOriginError(request: Request): string | null {
  const method = request.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return null;
  if (hasBearerAuthorization(request)) return null;
  const cookie = request.headers.get("cookie");
  if (!cookie || !readCookie(cookie, SESSION_COOKIE)) return null;
  const origin = request.headers.get("origin");
  const expected = new URL(request.url).origin;
  if (!origin || origin !== expected) return "csrf origin mismatch";
  return null;
}

export function b64uEncode(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64uDecode(str: string): Uint8Array {
  const pad = str.length % 4 === 0 ? "" : "=".repeat(4 - (str.length % 4));
  const bin = atob(str.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function sha256Bytes(input: string | Uint8Array): Promise<Uint8Array> {
  const data = typeof input === "string" ? new TextEncoder().encode(input) : input;
  return new Uint8Array(await crypto.subtle.digest("SHA-256", data as BufferSource));
}

export async function sha256Hex(input: string | Uint8Array): Promise<string> {
  const digest = await sha256Bytes(input);
  let hex = "";
  for (let i = 0; i < digest.length; i++) hex += digest[i].toString(16).padStart(2, "0");
  return hex;
}

export async function sha256B64u(input: string | Uint8Array): Promise<string> {
  return b64uEncode(await sha256Bytes(input));
}

export function newUserId(): string {
  return `u_${b64uEncode(crypto.getRandomValues(new Uint8Array(16)))}`;
}

export function newSecret(): string {
  return b64uEncode(crypto.getRandomValues(new Uint8Array(32)));
}

export function makeToken(userId: string, secret = newSecret()): ParsedToken {
  return { raw: `sv2.${userId}.${secret}`, userId, secret };
}

export function sessionCookieHeader(token: string, requestUrl: string, maxAge = SESSION_TTL_SEC): string {
  const u = new URL(requestUrl);
  const isLocalHttp = u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "local");
  const secure = isLocalHttp ? "" : "; Secure";
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

export function clearSessionCookieHeader(requestUrl: string): string {
  return sessionCookieHeader("", requestUrl, 0);
}
