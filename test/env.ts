// Bun SQLite test harness for Selah Vault v2: in-memory D1 + per-user SQLite LibraryDO + mock WebSockets.

import { Database } from "bun:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import type { EmailMessage } from "../src/auth";
import { LibraryEngine } from "../src/library";
import { type Env, fetchApp } from "../src/server";

const migDir = new URL("../migrations/", import.meta.url);
export const AUTH_MIGRATIONS = readdirSync(migDir)
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((f) => readFileSync(new URL(f, migDir), "utf8"));

export const TEST_ORIGIN = "https://vault.selah.tools";

export interface MockWsConnection {
  messages: Array<Record<string, unknown>>;
  closed: boolean;
  protocol: string | null;
  close(): void;
}

function createBunD1(sqlite: Database, onQuery: () => void): D1Database {
  const makeStmt = (sql: string, args: unknown[]) => ({
    sql,
    args,
    bind: (...next: unknown[]) => makeStmt(sql, next),
    async run() {
      onQuery();
      sqlite.query(sql).run(...(args as never[]));
      return { success: true, results: [] };
    },
    async all() {
      onQuery();
      return { success: true, results: sqlite.query(sql).all(...(args as never[])) };
    },
    async first() {
      onQuery();
      return sqlite.query(sql).get(...(args as never[])) ?? null;
    },
  });

  return {
    prepare: (sql: string) => makeStmt(sql, []),
    async batch(statements: Array<{ sql: string; args: unknown[] }>) {
      onQuery();
      return sqlite.transaction(() =>
        statements.map((s) => {
          if (/^\s*select\b|\breturning\b/i.test(s.sql)) {
            return { success: true, results: sqlite.query(s.sql).all(...(s.args as never[])) };
          }
          sqlite.query(s.sql).run(...(s.args as never[]));
          return { success: true, results: [] };
        }),
      )();
    },
  } as unknown as D1Database;
}

export function createTestEnv(overrides: Partial<Env> = {}) {
  const authDb = new Database(":memory:");
  for (const m of AUTH_MIGRATIONS) authDb.exec(m);

  let currentNow = 1_790_000_000_000;
  let d1Queries = 0;
  const emails: EmailMessage[] = [];
  const objects = new Map<
    string,
    { sqlite: Database; engine: LibraryEngine; sockets: Set<MockWsConnection> }
  >();
  let lastAcceptedWs: MockWsConnection | null = null;

  const getOrCreateDo = (key: string) => {
    let entry = objects.get(key);
    if (!entry) {
      let sqlite = new Database(":memory:");
      const sockets = new Set<MockWsConnection>();
      const engine = new LibraryEngine({
        now: () => currentNow,
        sql: {
          exec: <T extends Record<string, unknown>>(query: string, ...bindings: unknown[]): T[] => {
            return sqlite.query(query).all(...(bindings as never[])) as T[];
          },
          transactionSync: <T>(fn: () => T): T => sqlite.transaction(fn)(),
          deleteAll: () => {
            sqlite.close();
            sqlite = new Database(":memory:");
          },
        },
        broadcastPoke: (seq: number) => {
          for (const s of sockets) {
            if (!s.closed) s.messages.push({ type: "poke", seq });
          }
        },
        acceptWebSocket: (req: Request, headSeq: number): Response => {
          if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
            return new Response(JSON.stringify({ error: "Expected WebSocket upgrade" }), { status: 426 });
          }
          const protoHeader = req.headers.get("sec-websocket-protocol") ?? "";
          const protocol = protoHeader.split(",").some((p) => p.trim() === "selah-v2") ? "selah-v2" : null;
          const conn: MockWsConnection = {
            messages: [{ type: "hello", seq: headSeq }],
            closed: false,
            protocol,
            close() {
              conn.closed = true;
              sockets.delete(conn);
            },
          };
          sockets.add(conn);
          lastAcceptedWs = conn;
          const headers = new Headers({ "x-ws-upgraded": "101" });
          if (protocol) headers.set("sec-websocket-protocol", protocol);
          return new Response(null, { status: 200, headers });
        },
      });
      entry = { sqlite, engine, sockets };
      objects.set(key, entry);
    }
    return entry;
  };

  const LIBRARY = {
    idFromName: (name: string) => ({ toString: () => name, equals: (o: { toString(): string }) => o.toString() === name }),
    get: (id: { toString(): string }) => ({
      fetch: (input: RequestInfo | URL, init?: RequestInit) => {
        const req = input instanceof Request ? input : new Request(String(input), init);
        return getOrCreateDo(id.toString()).engine.fetch(req);
      },
    }),
  } as unknown as DurableObjectNamespace;

  const env: Env = {
    DB: createBunD1(authDb, () => {
      d1Queries++;
    }),
    LIBRARY,
    now: () => currentNow,
    sendEmail: async (msg) => {
      emails.push(msg);
    },
    ...overrides,
  };

  const fetch = (pathOrReq: string | Request, init?: RequestInit) => {
    const req = pathOrReq instanceof Request ? pathOrReq : new Request(new URL(pathOrReq, TEST_ORIGIN), init);
    return fetchApp(req, env);
  };

  const connectWs = async (path: string, init: RequestInit = {}) => {
    lastAcceptedWs = null;
    const headers = new Headers(init.headers);
    if (!headers.has("upgrade")) headers.set("upgrade", "websocket");
    const res = await fetch(path, { ...init, headers });
    const upgraded = res.headers.get("x-ws-upgraded") === "101";
    return { status: upgraded ? 101 : res.status, ws: lastAcceptedWs as MockWsConnection | null, res };
  };

  const createUserSession = async (email = "reader@selah.tools", name = "Personal") => {
    await fetch("/auth/email/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email }),
    });
    const code = emails[emails.length - 1]!.code;
    const verifyRes = await fetch("/auth/email/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, code, name }),
    });
    const body = (await verifyRes.json()) as { token: string; user: { id: string; email: string; name: string } };
    const cookie = verifyRes.headers.get("set-cookie")?.split(";")[0] ?? "";
    return { token: body.token, user: body.user, cookie };
  };

  return {
    authDb,
    env,
    emails,
    objects,
    fetch,
    connectWs,
    createUserSession,
    get d1Queries() {
      return d1Queries;
    },
    resetD1Count() {
      d1Queries = 0;
    },
    advanceTime(ms: number) {
      currentNow += ms;
    },
    get now() {
      return currentNow;
    },
  };
}
