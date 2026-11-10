// OAuth 2.1 clients and scopes for Selah Vault v2 (/oauth/authorize, /connect, /v2/*).

export const CLIENTS = {
  "https://route.bible": {
    id: "route.bible",
    name: "route.bible",
    icon: "/apps/route-bible.svg",
    homepage: "https://route.bible",
  },
  "https://vault-highlights-route-bible.dpshade.workers.dev": {
    id: "route.bible",
    name: "route.bible (preview)",
    icon: "/apps/route-bible.svg",
    homepage: "https://vault-highlights-route-bible.dpshade.workers.dev",
  },
  "https://proofs.dpshade.workers.dev": {
    id: "proofs",
    name: "Proofs",
    icon: "/apps/proofs.svg",
    homepage: "https://proofs.dpshade.workers.dev",
  },
  "https://proofs.selah.tools": {
    id: "proofs",
    name: "Proofs",
    icon: "/apps/proofs.svg",
    homepage: "https://proofs.selah.tools",
  },
};

export const CLIENT_ORIGINS = Object.keys(CLIENTS);
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
const PROOFS_IDS = new Set(["proofs", "proofs-web", "proofs-ios"]);

export const GRANT_DAYS = 90;
export const SV2_TOKEN = /^sv2\.u_[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/;

export const SCOPES = {
  read: { methods: ["GET"], prefixes: [], label: "View your passages, highlights, notes, and study history", icon: "eye" },
  "highlights:write": { methods: ["POST"], prefixes: ["highlight.", "color."], label: "Save and remove highlights and colors", icon: "bookmark" },
  "passages:write": { methods: ["POST"], prefixes: ["passage."], label: "Save and remove passages", icon: "bookmark" },
  "notes:write": { methods: ["POST"], prefixes: ["note."], label: "Create and edit notes", icon: "note" },
  "srs:write": { methods: ["POST"], prefixes: ["srs."], label: "Record study reviews and card progress", icon: "cards" },
};

/** Returns canonical origin (or custom-scheme URI) when redirectUri + clientId are allowed, else null. */
export function allowedClient(redirectUri, clientId) {
  try {
    const raw = String(redirectUri ?? "");
    if (raw === "proofs://oauth/callback") {
      return !clientId || PROOFS_IDS.has(clientId) ? "proofs://oauth/callback" : null;
    }
    const url = new URL(raw);
    if (url.username || url.password || url.hash) return null;
    if (url.protocol === "http:" && LOOPBACK.has(url.hostname)) {
      return clientId === "" ? null : url.origin;
    }
    if (url.protocol !== "https:" || !Object.hasOwn(CLIENTS, url.origin)) return null;
    if (!clientId || clientId === url.origin || clientId === CLIENTS[url.origin].id) return url.origin;
    if (CLIENTS[url.origin].id === "proofs" && PROOFS_IDS.has(clientId)) return url.origin;
    return null;
  } catch {
    return null;
  }
}

/** Display info { name, icon, homepage } for an allowed client origin or client_id. */
export function clientInfo(origin, clientId) {
  if (origin === "proofs://oauth/callback" || PROOFS_IDS.has(origin) || PROOFS_IDS.has(clientId)) {
    return { name: "Proofs", icon: "/apps/proofs.svg", homepage: "https://proofs.selah.tools" };
  }
  if (origin === "route.bible" || clientId === "route.bible") return CLIENTS["https://route.bible"];
  if (Object.hasOwn(CLIENTS, origin)) return CLIENTS[origin];
  const label = clientId && !clientId.startsWith("http") ? clientId : "Local development";
  return { name: label, icon: null, homepage: origin };
}

/** Deduplicated sorted scopes array, or null if empty or unknown. */
export function parseScopes(value) {
  const list = Array.isArray(value) ? value : String(value ?? "").split(/\s+/).filter(Boolean);
  if (!list.length || list.some((s) => typeof s !== "string" || !Object.hasOwn(SCOPES, s))) return null;
  return [...new Set(list)].sort();
}

/** Checks whether scopes permit an HTTP method ("GET"/"POST") or a v2 event kind ("highlight.set"). */
export function grantAllows(scopes, target) {
  if (scopes.includes("*")) return true;
  if (target === "GET") return scopes.includes("read");
  if (target === "POST") return scopes.some((s) => SCOPES[s]?.methods.includes("POST"));
  return scopes.some((s) => SCOPES[s]?.prefixes.some((p) => String(target).startsWith(p)));
}

/** Consent lines for /connect: what the app can do, then what it cannot, then expiry. */
export function consentLines(scopes) {
  const can = Object.keys(SCOPES)
    .filter((s) => scopes.includes(s))
    .map((s) => ({ ok: true, icon: SCOPES[s].icon, text: SCOPES[s].label }));
  const hasWrite = scopes.some((s) => s.endsWith(":write"));
  const cant = hasWrite ? "Can't delete your library or change your sign-in methods" : "Can't change or delete anything";
  return [...can, { ok: false, icon: "lock", text: cant }, { ok: true, icon: "clock", text: `Access expires in ${GRANT_DAYS} days · disconnect anytime` }];
}
