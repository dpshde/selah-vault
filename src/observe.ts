// Redacted structured observability for Selah Vault v2.
// Logs route templates, status, and duration — never tokens, emails, OTP codes, refs, or bodies.

export type Note = (fields: Record<string, string | number | boolean>) => void;
export const noNote: Note = () => {};

type Log = Pick<Console, "log" | "error">;

const FIELD_MAX = 300;
const METHODS = new Set(["GET", "HEAD", "POST", "PUT", "DELETE", "OPTIONS"]);

export function scrub(text: unknown, max = FIELD_MAX): string {
  return String(text ?? "")
    .replace(/https?:\/\/[^\s"'`)]+/g, (url) => url.replace(/[?#].*$/, ""))
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[email]")
    .replace(/\bsv2\.[A-Za-z0-9_.-]+/g, "[redacted]")
    .replace(/\bu_[A-Za-z0-9_-]{16,}\b/g, "[redacted]")
    .replace(/\b(?:[0-9A-Za-z]{4}[\s-]){3,}[0-9A-Za-z]{2,4}\b/g, (run) => (/\d/.test(run) ? "[redacted]" : run))
    .replace(/[A-Za-z0-9_-]{16,}/g, (run) => (/\d/.test(run) ? "[redacted]" : run))
    .replace(/\b\d{6}\b/g, "[code]")
    .replace(/'[^']*'|"[^"]*"|`[^`]*`|\u201c[^\u201d]*\u201d|\u2018[^\u2019]*\u2019/g, (q) => `${q[0]}…${q[q.length - 1]}`)
    .replace(/\b[1-3]?[A-Z]{2,3}\.\d+(\.\d+)?(-\d+)?\b/g, "[ref]")
    .replace(/\b(?:[1-3]\s?)?[A-Z][a-z]+\.?\s\d+(?::\d+(?:[-\u2013]\d+)?)?\b/g, "[ref]")
    .replace(/\b\d+:\d+(?:[-\u2013]\d+)?\b/g, "[ref]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

const EXACT_ROUTES = new Set([
  "/",
  "/connect",
  "/mcp",
  "/save",
  "/config.json",
  "/api/client-error",
  "/.well-known/oauth-authorization-server",
  "/oauth/authorize",
  "/oauth/token",
  "/oauth/revoke",
  "/auth/me",
  "/auth/logout",
  "/auth/apple",
  "/auth/email/send",
  "/auth/email/verify",
  "/auth/passkey/register/options",
  "/auth/passkey/register/verify",
  "/auth/passkey/login/options",
  "/auth/passkey/login/verify",
  "/v2/events",
  "/v2/bootstrap",
  "/v2/search",
  "/v2/ws",
  "/v2/grants",
  "/v2/grants/self",
  "/v2/export",
  "/v2/import",
  "/v2/library",
]);

export function routeOf(pathname: string): string {
  if (EXACT_ROUTES.has(pathname)) return pathname;
  if (/^\/v2\/grants\/[^/]+$/.test(pathname)) return "/v2/grants/:id";
  if (pathname.startsWith("/v2/")) return "/v2/other";
  if (pathname.startsWith("/auth/")) return "/auth/other";
  if (pathname.startsWith("/oauth/")) return "/oauth/other";
  if (pathname.startsWith("/yv/")) return "/yv/*";
  return "other";
}

export function errorFields(error: unknown): { error_class: string; error: string } {
  const name = error instanceof Error ? error.name : typeof error;
  return {
    error_class: /^[A-Za-z]{1,40}$/.test(name) ? name : "Error",
    error: scrub(error instanceof Error ? error.message : "", 200),
  };
}

export async function observe(request: Request, run: (note: Note) => Promise<Response>, log: Log = console): Promise<Response> {
  const started = Date.now();
  const fields: Record<string, string | number | boolean> = {};
  const note: Note = (more) => Object.assign(fields, more);
  let status = 500;
  try {
    const response = await run(note);
    status = response.status;
    return response;
  } catch (error) {
    note(errorFields(error));
    throw error;
  } finally {
    const line = {
      event: "request",
      method: METHODS.has(request.method) ? request.method : "OTHER",
      route: routeOf(new URL(request.url).pathname),
      status,
      ms: Date.now() - started,
      ...fields,
    };
    (status >= 500 ? log.error : log.log)(JSON.stringify(line));
  }
}

function sitePath(url: unknown, origin: string): string {
  if (!url || typeof url !== "string") return "";
  if (url === "external") return url;
  if (!/^(https?:\/\/|\/)/.test(url)) return "";
  try {
    const u = new URL(url, origin);
    return u.origin === origin ? u.pathname : "external";
  } catch {
    return "";
  }
}

function frames(stack: unknown, origin: string): string {
  const out: string[] = [];
  for (const m of String(stack ?? "").matchAll(/(https?:\/\/[^\s)]+?):(\d+):(\d+)/g)) {
    out.push(`${sitePath(m[1], origin)}:${m[2]}:${m[3]}`);
    if (out.length === 6) break;
  }
  return out.join(" ");
}

export function reportFor(
  input: { kind?: unknown; error?: unknown; message?: unknown; filename?: unknown; lineno?: unknown; colno?: unknown },
  where: { origin: string; pathname: string },
) {
  const errObj = input.error && typeof input.error === "object" ? (input.error as { name?: unknown; message?: unknown; stack?: unknown }) : null;
  const name = errObj && typeof errObj.name === "string" ? errObj.name : "";
  return {
    kind: input.kind === "unhandledrejection" ? "unhandledrejection" : "error",
    name: /^[A-Za-z]{1,40}$/.test(name) ? name : "",
    message: scrub(errObj?.message ?? input.message),
    source: sitePath(input.filename, where.origin),
    line: Number.isInteger(input.lineno) ? (input.lineno as number) : 0,
    col: Number.isInteger(input.colno) ? (input.colno as number) : 0,
    stack: frames(errObj?.stack, where.origin),
    page: where.pathname,
  };
}

const PAGES = new Set(["/", "/index.html", "/connect", "/connect.html", "/save"]);
export const CLIENT_ERROR_LIMITS = { bodyBytes: 4_096, perMinute: 30 } as const;

export function clientErrors({ perMinute = CLIENT_ERROR_LIMITS.perMinute, now = Date.now, log = console as Log } = {}) {
  let windowStart = 0;
  let count = 0;
  const empty = (status: number) => new Response(null, { status, headers: { "cache-control": "no-store" } });
  return async (request: Request, note: Note = noNote): Promise<Response> => {
    if (request.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } });
    const url = new URL(request.url);
    const origin = request.headers.get("origin");
    if (origin && origin !== url.origin) return empty(403);
    if (Number(request.headers.get("content-length") ?? "0") > CLIENT_ERROR_LIMITS.bodyBytes) return empty(413);
    const text = await request.text();
    if (text.length > CLIENT_ERROR_LIMITS.bodyBytes) return empty(413);
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(text);
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
    } catch {
      return empty(400);
    }
    const t = now();
    if (t - windowStart >= 60_000) {
      windowStart = t;
      count = 0;
    }
    if (++count > perMinute) {
      note({ dropped: true });
      return empty(429);
    }
    const str = (v: unknown) => (typeof v === "string" ? v : "");
    const report = reportFor(
      {
        kind: body.kind,
        error: { name: str(body.name), message: str(body.message), stack: "" },
        filename: str(body.source),
        lineno: body.line,
        colno: body.col,
      },
      { origin: url.origin, pathname: PAGES.has(str(body.page)) ? str(body.page) : "other" },
    );
    const stack = str(body.stack)
      .split(" ")
      .filter((f) => /^(\/[\w./-]{0,80}|external):\d{1,7}:\d{1,7}$/.test(f))
      .slice(0, 6)
      .join(" ");
    log.error(JSON.stringify({ event: "client_error", ...report, stack }));
    return empty(204);
  };
}
