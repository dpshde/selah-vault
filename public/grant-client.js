// OAuth 2.1 + PKCE client SDK for apps connecting to Selah Vault v2 (/oauth/authorize, /oauth/token, /v2/*).
import { compareRefs, splitRef } from "./refs.js";
import { listRanges, rangeView, rangeWrites, topColor } from "./ranges.js";
import {
  SyncError,
  applyEventToState,
  autoTags,
  b64url,
  emptyProjectedState,
  hydrateStateFromBootstrap,
  newEventId,
  now,
  nowMs,
  palette,
  randomBytes,
} from "./sync.js";

const TIMEOUT_MS = 20_000;
const te = new TextEncoder();

export async function createPkce() {
  const codeVerifier = b64url(randomBytes(32));
  const digest = await crypto.subtle.digest("SHA-256", te.encode(codeVerifier));
  const codeChallenge = b64url(new Uint8Array(digest));
  return { codeVerifier, codeChallenge, codeChallengeMethod: "S256" };
}

export const createOAuthState = () => b64url(randomBytes(18));

export function buildAuthorizeUrl({ vault = "https://vault.selah.tools", clientId, redirectUri, scope = "read", codeChallenge, state }) {
  const scopes = Array.isArray(scope) ? scope.join(" ") : String(scope || "read").trim();
  const url = new URL(`${vault.replace(/\/$/, "")}/oauth/authorize`);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", scopes);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  return url.href;
}

export function parseOAuthCallback(search) {
  const p = new URLSearchParams(String(search ?? "").replace(/^\?/, ""));
  if (p.get("error")) return { error: p.get("error"), state: p.get("state") };
  const code = p.get("code");
  const state = p.get("state");
  if (!code || !state) return { error: "invalid_callback", state };
  return { code, state };
}

export async function exchangeCode({ vault = "https://vault.selah.tools", clientId, redirectUri, code, codeVerifier, fetch: fetchFn = globalThis.fetch.bind(globalThis) }) {
  const res = await fetchFn(`${vault.replace(/\/$/, "")}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: codeVerifier,
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new SyncError(res.status, await res.text().catch(() => ""));
  return res.json();
}

export class GrantClient {
  static async open(grant, opts = {}) {
    const token = grant?.accessToken ?? grant?.access_token ?? grant?.token;
    if (!token || !String(token).startsWith("sv2.")) throw new Error("A valid sv2 access token is required.");
    return new GrantClient({ ...grant, token }, opts);
  }

  constructor(grant, { app = grant.clientId || "connected-app", fetch: fetchFn, WebSocket: WsClass = globalThis.WebSocket } = {}) {
    this.vault = String(grant.vault || "https://vault.selah.tools").replace(/\/$/, "");
    this.token = grant.token;
    this.app = app;
    this.scopes = Array.isArray(grant.scope) ? grant.scope : String(grant.scope ?? "read").split(/\s+/).filter(Boolean);
    this.user = grant.user ?? null;
    this.fetch = fetchFn ?? globalThis.fetch.bind(globalThis);
    this.WsClass = WsClass;
    this.state = emptyProjectedState();
    this.lastTs = nowMs();
    this.ws = null;
  }

  nextTs() {
    this.lastTs = Math.max(nowMs(), this.lastTs + 1);
    return this.lastTs;
  }

  async call(method, path, body) {
    const headers = { authorization: `Bearer ${this.token}` };
    if (body !== undefined) headers["content-type"] = "application/json";
    const res = await this.fetch(`${this.vault}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new SyncError(res.status, await res.text().catch(() => ""));
    return res.status === 204 ? null : res.json();
  }

  async changes(since) {
    const parsed = since === undefined || since === null || since === "" ? null : Number(since);
    const reset = parsed === null || !Number.isInteger(parsed) || parsed < 0;
    const changedHighlights = new Set();
    if (reset) {
      this.state = emptyProjectedState();
      const snap = await this.call("GET", "/v2/bootstrap");
      hydrateStateFromBootstrap(this.state, snap);
      for (const ref of Object.keys(this.state.highlights)) changedHighlights.add(ref);
    } else {
      let after = parsed;
      for (;;) {
        const page = await this.call("GET", `/v2/events?after=${after}&limit=500`);
        for (const ev of page.events ?? []) {
          after = Math.max(after, ev.seq ?? after);
          if (applyEventToState(this.state, ev) && (ev.kind === "highlight.set" || ev.kind === "highlight.removed") && ev.ref) {
            changedHighlights.add(ev.ref);
          }
        }
        after = Math.max(after, Number(page.seq) || 0);
        this.state.seq = Math.max(this.state.seq, after);
        if (!page.more) break;
      }
    }
    const known = this.colors().map((c) => c.id);
    const upserts = [];
    const deletions = [];
    for (const ref of [...changedHighlights].sort(compareRefs)) {
      const h = this.state.highlights[ref];
      if (!h || h.deleted) {
        if (!reset) deletions.push(ref);
      } else {
        const rec = this.find(ref);
        upserts.push({ ref, color: topColor(rec, known), record: rec });
      }
    }
    return { upserts, deletions, passages: this.passages(), colors: this.colors(), next: String(this.state.seq), reset };
  }

  colors() {
    return palette(Object.values(this.state.colors).filter((c) => !c.deleted));
  }

  passages() {
    return Object.values(this.state.passages).filter((p) => !p.removedTs).sort((a, b) => compareRefs(a.ref, b.ref));
  }

  highlights({ group } = {}) {
    const records = Object.values(this.state.highlights)
      .filter((h) => !h.deleted && splitRef(h.ref)?.verse != null)
      .map((h) => ({ kind: "highlight", ref: h.ref, color: h.color, updated: Math.floor((h.updatedTs || 0) / 1000), highlights: [{ color: h.color, created: Math.floor((h.createdTs || 0) / 1000), ...(h.quote ? { quote: h.quote } : {}) }] }))
      .sort((a, b) => compareRefs(a.ref, b.ref));
    if (group === undefined || group === "verses") return records;
    if (group !== "ranges") throw new Error(`unknown group ${group}`);
    return rangeView(listRanges(records, this.colors().map((c) => c.id)));
  }

  find(ref) {
    return this.highlights().find((r) => r.ref === ref) ?? null;
  }

  async appendEvents(rawEvents) {
    if (!rawEvents?.length) return { seq: this.state.seq, accepted: 0, duplicates: 0 };
    const events = rawEvents.map((ev) => ({
      id: ev.id || newEventId(),
      ts: Number.isFinite(ev.ts) ? Math.trunc(ev.ts) : this.nextTs(),
      app: ev.app || this.app,
      kind: ev.kind,
      ref: ev.ref ?? null,
      tags: Array.isArray(ev.tags) ? ev.tags : autoTags(ev.kind, ev.ref, ev.data),
      data: ev.data ?? {},
    }));
    const answer = await this.call("POST", "/v2/events", { events });
    for (const ev of events) applyEventToState(this.state, ev);
    if (Number.isInteger(answer?.seq) && this.state.seq > 0 && answer.seq - (answer.accepted ?? 0) === this.state.seq) {
      this.state.seq = answer.seq;
    }
    return answer;
  }

  async highlightRange(ref, color = "yellow") {
    if (!this.scopes.includes("highlights:write") && !this.scopes.includes("*")) {
      throw new Error("this grant needs highlights:write");
    }
    const w = rangeWrites(ref, color, now(), (v) => this.find(v));
    if (w.error) throw new Error(w.error);
    if (w.records.length) {
      await this.appendEvents(w.records.map((r) => ({ kind: "highlight.set", ref: r.ref, data: { color } })));
    }
    return { ref: w.ref, verses: w.verses, written: w.records.map((r) => r.ref) };
  }

  async remove(refs) {
    if (!this.scopes.includes("highlights:write") && !this.scopes.includes("*")) {
      throw new Error("this grant needs highlights:write");
    }
    const live = refs.filter((ref) => this.find(ref));
    if (live.length) {
      await this.appendEvents(live.map((ref) => ({ kind: "highlight.removed", ref, data: {} })));
    }
    return live;
  }

  async savePassage(ref, { apps = {} } = {}) {
    if (!this.scopes.includes("passages:write") && !this.scopes.includes("*")) {
      throw new Error("this grant needs passages:write");
    }
    if (!splitRef(ref)) throw new Error(`not a canonical ref: ${ref}`);
    await this.appendEvents([{ kind: "passage.saved", ref, data: { apps } }]);
  }

  async removePassage(ref) {
    if (!this.scopes.includes("passages:write") && !this.scopes.includes("*")) {
      throw new Error("this grant needs passages:write");
    }
    if (!splitRef(ref)) throw new Error(`not a canonical ref: ${ref}`);
    await this.appendEvents([{ kind: "passage.removed", ref, data: {} }]);
  }

  connectWebSocket(onPoke) {
    if (!this.WsClass) return () => {};
    const wsUrl = `${this.vault.replace(/^http/, "ws")}/v2/ws`;
    const ws = new this.WsClass(wsUrl, ["selah-v2", `token.${this.token}`]);
    this.ws = ws;
    ws.addEventListener("message", (e) => {
      try {
        const msg = JSON.parse(String(e.data));
        if ((msg?.type === "poke" || msg?.type === "hello") && Number(msg.seq) > this.state.seq) onPoke?.(msg.seq);
      } catch {}
    });
    return () => {
      try { ws.close(); } catch {}
      if (this.ws === ws) this.ws = null;
    };
  }

  async disconnect() {
    try { this.ws?.close(); } catch {}
    this.ws = null;
    const res = await this.fetch(`${this.vault}/oauth/revoke`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
      body: JSON.stringify({ token: this.token }),
    });
    if (!res.ok && res.status !== 401) throw new SyncError(res.status, "");
  }
}

