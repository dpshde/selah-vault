// Cloudflare Worker entrypoint & hibernating SQLite LibraryDO for Selah Vault v2.

import { DurableObject } from "cloudflare:workers";
import { LibraryEngine } from "./library";
import { type Env, fetchApp } from "./server";

export type { Env };

export class LibraryDO extends DurableObject<Env> {
  private readonly engine: LibraryEngine;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.engine = new LibraryEngine({
      sql: {
        exec: <T extends Record<string, unknown> = Record<string, unknown>>(query: string, ...bindings: unknown[]): T[] => {
          const cursor = this.ctx.storage.sql.exec(query, ...(bindings as SqlStorageValue[]));
          return [...cursor] as unknown as T[];
        },
        transactionSync: <T>(fn: () => T): T => this.ctx.storage.transactionSync(fn),
        deleteAll: () => {
          void this.ctx.storage.deleteAll();
        },
      },
      broadcastPoke: (seq: number) => {
        const msg = JSON.stringify({ type: "poke", seq });
        for (const ws of this.ctx.getWebSockets()) {
          try {
            ws.send(msg);
          } catch {
            // Ignore closed sockets.
          }
        }
      },
      acceptWebSocket: (request: Request, headSeq: number): Response => {
        if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
          return new Response(JSON.stringify({ error: "Expected WebSocket upgrade" }), {
            status: 426,
            headers: { "content-type": "application/json" },
          });
        }
        const pair = new WebSocketPair();
        const [client, server] = Object.values(pair);
        this.ctx.acceptWebSocket(server);
        server.send(JSON.stringify({ type: "hello", seq: headSeq }));

        const headers = new Headers();
        const proto = request.headers.get("sec-websocket-protocol") ?? "";
        if (proto.split(",").some((p) => p.trim() === "selah-v2")) {
          headers.set("sec-websocket-protocol", "selah-v2");
        }
        return new Response(null, { status: 101, webSocket: client, headers });
      },
    });
  }

  override async fetch(request: Request): Promise<Response> {
    return this.engine.fetch(request);
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message === "string" && (message === "ping" || message.includes('"ping"'))) {
      ws.send(JSON.stringify({ type: "pong", seq: this.engine.headSeq() }));
    }
  }

  override async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    try {
      ws.close(code, reason);
    } catch {
      // Already closed.
    }
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return fetchApp(request, env);
  },
} satisfies ExportedHandler<Env>;
