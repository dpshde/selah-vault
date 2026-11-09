// Grants: what another app may do with a library, shared by the server (src/worker.ts) and the
// consent page (public/connect.js). A grant token starts with "g1." so the server tells it from a
// library's own token without a lookup.

/**
 * Apps that may ask for a grant, by exact origin: the name, icon and homepage the consent page
 * shows. Any localhost port is allowed for development, shown as "Local development".
 */
export const CLIENTS = {
  "https://route.bible": { name: "route.bible", icon: "/apps/route-bible.svg", homepage: "https://route.bible" },
  "https://vault-highlights-route-bible.dpshade.workers.dev": {
    name: "route.bible (preview)",
    icon: "/apps/route-bible.svg",
    homepage: "https://vault-highlights-route-bible.dpshade.workers.dev",
  },
  "https://proofs.dpshade.workers.dev": {
    name: "Proofs",
    icon: "/apps/proofs.svg",
    homepage: "https://proofs.dpshade.workers.dev",
  },
};
export const CLIENT_ORIGINS = Object.keys(CLIENTS);
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

export const GRANT_DAYS = 90;
export const GRANT_TOKEN = /^g1\.[A-Za-z0-9_-]{43}$/;

/**
 * Each scope and what it lets a grant token do on /v1/lib/:lib.
 *
 * "highlights:write" lets the app POST encrypted records (route.bible's save button). The library
 * is end-to-end encrypted, so the server can't see a record's kind: it enforces the method (POST
 * of items only: never DELETE the library, never touch passkey slots), the size limits, and that
 * the grant is live. That the app writes only highlight records is up to the app, which is why
 * the scope is only offered to apps in CLIENTS. Each write is one item per verse, merged by the
 * record's `updated` time like any device's, so nothing else in the library is re-sent or rewritten.
 */
export const SCOPES = {
  read: { methods: ["GET"], label: "View your highlights and notes", icon: "eye" },
  "highlights:write": { methods: ["POST"], label: "Save and remove highlights", icon: "bookmark" },
};

/** The origin of `raw` when it's an allowed app, else null. */
export function allowedClient(raw) {
  try {
    const url = new URL(raw);
    if (url.username || url.password) return null;
    if (url.protocol === "http:" && LOOPBACK.has(url.hostname)) return url.origin;
    return url.protocol === "https:" && Object.hasOwn(CLIENTS, url.origin) ? url.origin : null;
  } catch {
    return null;
  }
}

/** The name, icon and homepage to show for an allowed origin. */
export function clientInfo(origin) {
  if (Object.hasOwn(CLIENTS, origin)) return CLIENTS[origin];
  return { name: "Local development", icon: null, homepage: origin };
}

/** The scopes as a list, or null when any is unknown or the list is empty. */
export function parseScopes(value) {
  const list = Array.isArray(value) ? value : String(value ?? "").split(/\s+/).filter(Boolean);
  if (!list.length || list.some((s) => typeof s !== "string" || !Object.hasOwn(SCOPES, s))) return null;
  return [...new Set(list)].sort();
}

/** Whether a grant with these scopes may make this request. */
export function grantAllows(scopes, method) {
  return scopes.some((s) => SCOPES[s]?.methods.includes(method));
}

/** The consent page's list: what the app can do, then what it can't. */
export function consentLines(scopes) {
  const can = Object.keys(SCOPES).filter((s) => scopes.includes(s)).map((s) => ({ ok: true, icon: SCOPES[s].icon, text: SCOPES[s].label }));
  const cant = scopes.includes("highlights:write") ? "Can't delete your library or change your passkeys" : "Can't change or delete anything";
  return [...can, { ok: false, icon: "lock", text: cant }, { ok: true, icon: "clock", text: `Access expires in ${GRANT_DAYS} days · disconnect anytime` }];
}
/* asset-rev 3 */
