// Per-user SQLite Durable Object engine (LibraryEngine) for Selah Vault v2.
// Pure TypeScript + synchronous SqlAdapter so both Cloudflare LibraryDO and bun:sqlite run the exact same code.

import {
  b64uEncode,
  extractTokenFromRequest,
  hasReadScope,
  scopeAllowsKind,
  sha256Hex,
} from "./clients";
import {
  type SqlAdapter,
  type VaultEvent,
  type VaultEventInput,
  buildBootstrap,
  initSchema,
  projectEvent,
  searchBlocks,
  validateEventInput,
} from "./projector";

export const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
  "access-control-allow-headers": "authorization, content-type, accept, mcp-protocol-version, mcp-session-id",
  "access-control-max-age": "86400",
};

export interface LibraryEngineOptions {
  sql: SqlAdapter;
  broadcastPoke?: (seq: number) => void;
  acceptWebSocket?: (request: Request, headSeq: number) => Response;
  now?: () => number;
}

interface TokenAuth {
  id: string;
  scopes: string[];
  clientId: string | null;
}

function jsonResp(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "content-type": "application/json", "cache-control": "no-store", ...extra },
  });
}

export class LibraryEngine {
  private readonly sql: SqlAdapter;
  private readonly broadcastPoke: (seq: number) => void;
  private readonly acceptWs?: (request: Request, headSeq: number) => Response;
  private readonly now: () => number;
  private initialized = false;

  constructor(opts: LibraryEngineOptions) {
    this.sql = opts.sql;
    this.broadcastPoke = opts.broadcastPoke ?? (() => {});
    this.acceptWs = opts.acceptWebSocket;
    this.now = opts.now ?? (() => Date.now());
  }

  private ensureInit(): void {
    if (this.initialized) return;
    initSchema(this.sql);
    this.initialized = true;
  }

  public headSeq(): number {
    this.ensureInit();
    return Number(this.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = 'head_seq'")[0]?.value ?? "0");
  }

  public libraryMeta(fallbackId = ""): { id: string; name: string } {
    this.ensureInit();
    const id = this.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = 'library_id'")[0]?.value ?? fallbackId;
    const name = this.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = 'library_name'")[0]?.value ?? "Personal";
    return { id, name };
  }

  private async authenticate(request: Request, allowWsQuery = false): Promise<{ userId: string; token: TokenAuth } | null> {
    this.ensureInit();
    const parsed = extractTokenFromRequest(request, allowWsQuery);
    if (!parsed) return null;
    const hash = await sha256Hex(parsed.secret);
    const nowSec = Math.floor(this.now() / 1000);
    const row = this.sql.exec<{ id: string; scopes: string; client_id: string | null }>(
      "SELECT id, scopes, client_id FROM tokens WHERE secret_hash = ? AND expires_at > ?",
      hash,
      nowSec,
    )[0];
    if (!row) return null;
    const storedLib = this.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = 'library_id'")[0]?.value;
    if (storedLib && storedLib !== parsed.userId) return null;
    return {
      userId: parsed.userId,
      token: { id: row.id, scopes: row.scopes.split(" ").filter(Boolean), clientId: row.client_id },
    };
  }

  public appendValidatedEvents(userId: string, events: VaultEventInput[]): { seq: number; accepted: number; duplicates: number } {
    this.ensureInit();
    const res = this.sql.transactionSync(() => {
      this.sql.exec("INSERT OR IGNORE INTO meta (key, value) VALUES ('library_id', ?)", userId);
      this.sql.exec("INSERT OR IGNORE INTO meta (key, value) VALUES ('library_name', 'Personal')");
      let seq = Number(this.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = 'head_seq'")[0]?.value ?? "0");
      let accepted = 0;
      let duplicates = 0;

      for (const ev of events) {
        const exists = this.sql.exec<{ seq: number }>("SELECT seq FROM events WHERE id = ?", ev.id)[0];
        if (exists) {
          duplicates++;
          continue;
        }
        seq++;
        accepted++;
        const tags = ev.tags ?? [];
        const full: VaultEvent = { ...ev, seq, tags };
        this.sql.exec(
          `INSERT INTO events (seq, id, ts, app, kind, ref, tags_json, data_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          seq,
          ev.id,
          ev.ts,
          ev.app,
          ev.kind,
          ev.ref,
          JSON.stringify(tags),
          JSON.stringify(ev.data),
        );
        for (const tag of tags) {
          this.sql.exec("INSERT OR IGNORE INTO event_tags (seq, tag) VALUES (?, ?)", seq, tag);
        }
        projectEvent(this.sql, full);
      }

      this.sql.exec("INSERT OR REPLACE INTO meta (key, value) VALUES ('head_seq', ?)", String(seq));
      return { seq, accepted, duplicates };
    });

    if (res.accepted > 0) this.broadcastPoke(res.seq);
    return res;
  }

  public async fetch(request: Request): Promise<Response> {
    this.ensureInit();
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
    const url = new URL(request.url);

    if (url.pathname.startsWith("/_internal/")) {
      return this.handleInternal(request, url);
    }

    const auth = await this.authenticate(request, url.pathname === "/v2/ws");
    if (!auth) return jsonResp({ error: "unauthorized" }, 401);

    return this.handleV2(request, url, auth.userId, auth.token);
  }

  private async handleInternal(request: Request, url: URL): Promise<Response> {
    if (request.method !== "POST") return jsonResp({ error: "method not allowed" }, 405);
    const body = (await request.json()) as Record<string, unknown>;

    if (url.pathname === "/_internal/tokens") {
      const userId = String(body.userId);
      const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : "Personal";
      const secretHash = String(body.secretHash);
      const scopes = Array.isArray(body.scopes) ? body.scopes.map(String).join(" ") : String(body.scopes ?? "*");
      const clientId = typeof body.clientId === "string" ? body.clientId : null;
      const ttlSec = Number(body.ttlSec ?? 86_400);
      const nowSec = Math.floor(this.now() / 1000);
      const id = `gr_${b64uEncode(crypto.getRandomValues(new Uint8Array(12)))}`;

      this.sql.transactionSync(() => {
        this.sql.exec("INSERT OR IGNORE INTO meta (key, value) VALUES ('library_id', ?)", userId);
        this.sql.exec("INSERT OR IGNORE INTO meta (key, value) VALUES ('library_name', ?)", name);
        this.sql.exec(
          `INSERT INTO tokens (id, secret_hash, scopes, client_id, created_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          id,
          secretHash,
          scopes,
          clientId,
          nowSec,
          nowSec + ttlSec,
        );
      });
      return jsonResp({ id, library: this.libraryMeta(userId) });
    }

    if (url.pathname === "/_internal/verify") {
      const secretHash = String(body.secretHash ?? "");
      const nowSec = Math.floor(this.now() / 1000);
      const row = this.sql.exec<{ id: string; scopes: string; client_id: string | null }>(
        "SELECT id, scopes, client_id FROM tokens WHERE secret_hash = ? AND expires_at > ?",
        secretHash,
        nowSec,
      )[0];
      if (!row) return jsonResp({ error: "unauthorized" }, 401);
      return jsonResp({
        tokenId: row.id,
        scopes: row.scopes.split(" ").filter(Boolean),
        clientId: row.client_id,
        library: this.libraryMeta(String(body.userId ?? "")),
      });
    }

    if (url.pathname === "/_internal/revoke") {
      const secretHash = String(body.secretHash ?? "");
      this.sql.exec("DELETE FROM tokens WHERE secret_hash = ?", secretHash);
      return jsonResp({ revoked: true });
    }

    return jsonResp({ error: "not found" }, 404);
  }

  private async handleV2(request: Request, url: URL, userId: string, token: TokenAuth): Promise<Response> {
    const path = url.pathname;
    const method = request.method;

    if (path === "/v2/ws" && method === "GET") {
      if (!hasReadScope(token.scopes)) return jsonResp({ error: "insufficient_scope" }, 403);
      if (!this.acceptWs) return jsonResp({ error: "websocket upgrade unsupported" }, 426);
      return this.acceptWs(request, this.headSeq());
    }

    if (path === "/v2/bootstrap" && method === "GET") {
      if (!hasReadScope(token.scopes)) return jsonResp({ error: "insufficient_scope" }, 403);
      return jsonResp(buildBootstrap(this.sql, userId));
    }

    if (path === "/v2/search" && method === "GET") {
      if (!hasReadScope(token.scopes)) return jsonResp({ error: "insufficient_scope" }, 403);
      const q = url.searchParams.get("q") ?? "";
      const limit = Number(url.searchParams.get("limit") ?? "50");
      return jsonResp({ blocks: searchBlocks(this.sql, q, Number.isFinite(limit) ? limit : 50) });
    }

    return this.handleV2EventsAndAdmin(request, url, userId, token);
  }

  private async handleV2EventsAndAdmin(request: Request, url: URL, userId: string, token: TokenAuth): Promise<Response> {
    const path = url.pathname;
    const method = request.method;

    if (path === "/v2/events" && method === "POST") {
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return jsonResp({ error: "body must be JSON" }, 400);
      }
      const rawEvents = (body as { events?: unknown })?.events;
      if (!Array.isArray(rawEvents) || rawEvents.length < 1 || rawEvents.length > 500) {
        return jsonResp({ error: "events must be an array of 1..500 items" }, 400);
      }
      const validated: VaultEventInput[] = [];
      for (const item of rawEvents) {
        const res = validateEventInput(item);
        if (!res.event) return jsonResp({ error: res.error ?? "invalid event" }, 400);
        if (!scopeAllowsKind(token.scopes, res.event.kind)) {
          return jsonResp({ error: `insufficient_scope for ${res.event.kind}` }, 403);
        }
        validated.push(res.event);
      }
      return jsonResp(this.appendValidatedEvents(userId, validated));
    }

    if (path === "/v2/events" && method === "GET") {
      if (!hasReadScope(token.scopes)) return jsonResp({ error: "insufficient_scope" }, 403);
      const afterRaw = url.searchParams.get("after") ?? "0";
      const after = Number(afterRaw);
      if (!Number.isSafeInteger(after) || after < 0) return jsonResp({ error: "after must be a non-negative integer" }, 400);
      const limitRaw = url.searchParams.get("limit");
      const parsedLimit = limitRaw === null || limitRaw.trim() === "" ? 500 : Math.trunc(Number(limitRaw));
      const limit = Number.isFinite(parsedLimit) ? Math.min(Math.max(parsedLimit, 1), 1000) : 500;

      const clauses: string[] = ["e.seq > ?"];
      const params: unknown[] = [after];

      const kind = url.searchParams.get("kind");
      if (kind) {
        if (kind.endsWith(".")) {
          clauses.push("SUBSTR(e.kind, 1, ?) = ?");
          params.push(kind.length, kind);
        } else {
          clauses.push("e.kind = ?");
          params.push(kind);
        }
      }
      const ref = url.searchParams.get("ref");
      if (ref) {
        clauses.push("e.ref = ?");
        params.push(ref);
      }
      const app = url.searchParams.get("app");
      if (app) {
        clauses.push("e.app = ?");
        params.push(app);
      }
      const tag = url.searchParams.get("tag");
      if (tag) {
        clauses.push("EXISTS (SELECT 1 FROM event_tags t WHERE t.seq = e.seq AND t.tag = ?)");
        params.push(tag);
      }
      params.push(limit + 1);

      const rows = this.sql.exec<{
        seq: number;
        id: string;
        ts: number;
        app: string;
        kind: string;
        ref: string | null;
        tags_json: string;
        data_json: string;
      }>(`SELECT e.seq, e.id, e.ts, e.app, e.kind, e.ref, e.tags_json, e.data_json FROM events e WHERE ${clauses.join(" AND ")} ORDER BY e.seq ASC LIMIT ?`, ...params);

      const events: VaultEvent[] = rows.slice(0, limit).map((r) => ({
        seq: r.seq,
        id: r.id,
        ts: r.ts,
        app: r.app,
        kind: r.kind,
        ref: r.ref,
        tags: JSON.parse(r.tags_json) as string[],
        data: JSON.parse(r.data_json) as Record<string, unknown>,
      }));
      return jsonResp({ events, seq: this.headSeq(), more: rows.length > limit });
    }

    return this.handleAdminRoutes(request, url, userId, token);
  }

  private async handleAdminRoutes(request: Request, url: URL, userId: string, token: TokenAuth): Promise<Response> {
    const path = url.pathname;
    const method = request.method;
    const isOwner = token.scopes.includes("*");

    if (path === "/v2/grants/self" && method === "DELETE") {
      this.sql.exec("DELETE FROM tokens WHERE id = ?", token.id);
      return jsonResp({ revoked: true });
    }

    if (path === "/v2/grants" && method === "GET") {
      if (!isOwner) return jsonResp({ error: "owner scope required" }, 403);
      const nowSec = Math.floor(this.now() / 1000);
      const rows = this.sql.exec<{
        id: string;
        scopes: string;
        client_id: string;
        created_at: number;
        expires_at: number;
      }>("SELECT id, scopes, client_id, created_at, expires_at FROM tokens WHERE client_id IS NOT NULL AND expires_at > ? ORDER BY created_at DESC", nowSec);
      return jsonResp({
        grants: rows.map((r) => ({
          id: r.id,
          clientId: r.client_id,
          scopes: r.scopes.split(" ").filter(Boolean),
          createdAt: r.created_at,
          expiresAt: r.expires_at,
        })),
      });
    }

    if (path.startsWith("/v2/grants/") && method === "DELETE") {
      if (!isOwner) return jsonResp({ error: "owner scope required" }, 403);
      const id = decodeURIComponent(path.slice("/v2/grants/".length));
      this.sql.exec("DELETE FROM tokens WHERE id = ? AND client_id IS NOT NULL", id);
      return jsonResp({ revoked: true });
    }

    if (path === "/v2/export" && method === "GET") {
      if (!hasReadScope(token.scopes)) return jsonResp({ error: "insufficient_scope" }, 403);
      const meta = this.libraryMeta(userId);
      const header = JSON.stringify({ "selah-vault": 2, library: meta.id, name: meta.name, exportedAt: this.now() });
      const rows = this.sql.exec<{
        seq: number;
        id: string;
        ts: number;
        app: string;
        kind: string;
        ref: string | null;
        tags_json: string;
        data_json: string;
      }>("SELECT seq, id, ts, app, kind, ref, tags_json, data_json FROM events ORDER BY seq ASC");
      const lines = [header];
      for (const r of rows) {
        lines.push(
          JSON.stringify({
            seq: r.seq,
            id: r.id,
            ts: r.ts,
            app: r.app,
            kind: r.kind,
            ref: r.ref,
            tags: JSON.parse(r.tags_json),
            data: JSON.parse(r.data_json),
          }),
        );
      }
      return new Response(lines.join("\n") + "\n", {
        status: 200,
        headers: {
          ...CORS_HEADERS,
          "content-type": "application/x-ndjson; charset=utf-8",
          "cache-control": "no-store",
        },
      });
    }

    if (path === "/v2/import" && method === "POST") {
      if (!isOwner) return jsonResp({ error: "owner scope required" }, 403);
      const text = await request.text();
      const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      if (!lines.length) return jsonResp({ error: "empty import file" }, 400);
      let header: Record<string, unknown>;
      try {
        header = JSON.parse(lines[0]);
      } catch {
        return jsonResp({ error: "invalid JSONL header" }, 400);
      }
      if (!header || header["selah-vault"] !== 2) {
        return jsonResp({ error: "expected selah-vault v2 export header" }, 400);
      }
      const events: VaultEventInput[] = [];
      for (let i = 1; i < lines.length; i++) {
        let raw: unknown;
        try {
          raw = JSON.parse(lines[i]);
        } catch {
          return jsonResp({ error: `invalid JSON on line ${i + 1}` }, 400);
        }
        const res = validateEventInput(raw);
        if (!res.event) return jsonResp({ error: `line ${i + 1}: ${res.error}` }, 400);
        events.push(res.event);
      }
      if (typeof header.name === "string" && header.name.trim()) {
        const hasNameTs = this.sql.exec("SELECT 1 FROM meta WHERE key = 'name_ts'")[0];
        if (!hasNameTs) {
          this.sql.exec("INSERT OR REPLACE INTO meta (key, value) VALUES ('library_name', ?)", header.name.trim());
        }
      }
      const out = events.length ? this.appendValidatedEvents(userId, events) : { seq: this.headSeq(), accepted: 0, duplicates: 0 };
      return jsonResp(out);
    }

    if (path === "/v2/library" && method === "DELETE") {
      if (!isOwner) return jsonResp({ error: "owner scope required" }, 403);
      this.sql.transactionSync(() => {
        for (const tbl of ["tokens", "events", "event_tags", "passages", "highlights", "colors", "blocks", "blocks_fts", "srs_cards", "srs_reviews", "srs_daily_stats", "meta"]) {
          this.sql.exec(`DELETE FROM ${tbl}`);
        }
      });
      if (this.sql.deleteAll) this.sql.deleteAll();
      this.initialized = false;
      return jsonResp({ deleted: true, userId });
    }

    return jsonResp({ error: "not found" }, 404);
  }
}
