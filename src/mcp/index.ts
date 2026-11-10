// Selah Vault v2 MCP Server: Streamable HTTP JSON-RPC at /mcp.
// Authenticates with OAuth 2.1 / session Bearer tokens (sv2.<userId>.<secret>) and routes zero-hop to LibraryDO.

import { BOOKS as books, compareRefs, labelRef, splitRef } from "../../public/refs.js";
import { groupRuns } from "../../public/ranges.js";
import { readPassage as read } from "../../public/passage.js";
import { b64uEncode, extractTokenFromRequest, sha256Hex } from "../clients";
import { CORS_HEADERS } from "../library";
import { type Note, noNote } from "../observe";

const BOOKS = books as Array<[code: string, name: string, chapters: number]>;
const readPassage = read as (
  text: string,
) => { verses: string[]; label: string; error?: undefined } | { error: string; verses?: undefined; label?: undefined };

const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const SERVER_INFO = { name: "selah-vault", title: "Selah Vault", version: "2.0.0" };
const MAX_BODY = 64_000;

type Json = Record<string, unknown>;
type Rpc = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Json };

const reply = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "content-type": "application/json", "cache-control": "no-store", ...extra },
  });

const rpcError = (id: Rpc["id"], code: number, message: string) => ({
  jsonrpc: "2.0",
  id: id ?? null,
  error: { code, message },
});

function wwwAuthHeader(request: Request): string {
  const origin = new URL(request.url).origin;
  const meta = `${origin}/.well-known/oauth-authorization-server`;
  return `Bearer realm="selah-vault", authorization_uri="${meta}", resource_metadata="${meta}"`;
}

const METHODS = new Set(["initialize", "ping", "tools/list", "tools/call"]);

export async function mcp(request: Request, libraryNs: DurableObjectNamespace, note: Note = noNote): Promise<Response> {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (request.method !== "POST") {
    return reply(rpcError(null, -32000, "Method not allowed"), 405, { allow: "POST, OPTIONS" });
  }

  const text = await request.text();
  if (text.length > MAX_BODY) return reply(rpcError(null, -32600, "Request too large"), 413);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return reply(rpcError(null, -32700, "Parse error"), 400);
  }
  const messages = (Array.isArray(body) ? body : [body]) as Rpc[];
  if (!messages.length || messages.some((m) => !m || typeof m !== "object" || typeof m.method !== "string")) {
    return reply(rpcError(null, -32600, "Invalid request"), 400);
  }

  const parsed = extractTokenFromRequest(request, false);
  if (!parsed) {
    note({ mcp: "unauthorized" });
    return reply(rpcError(messages[0]?.id, -32001, "Missing or invalid Bearer token."), 401, {
      "www-authenticate": wwwAuthHeader(request),
    });
  }

  const stub = libraryNs.get(libraryNs.idFromName(parsed.userId));
  const secretHash = await sha256Hex(parsed.secret);
  const verifyRes = await stub.fetch(
    new Request("https://library.internal/_internal/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: parsed.userId, secretHash }),
    }),
  );
  if (!verifyRes.ok) {
    note({ mcp: "unauthorized" });
    return reply(rpcError(messages[0]?.id, -32001, "Invalid or expired Bearer token."), 401, {
      "www-authenticate": wwwAuthHeader(request),
    });
  }

  const session = new McpSession(stub, parsed.raw);
  const answers: Json[] = [];
  for (const m of messages) {
    const ans = await session.answer(m);
    if (ans) answers.push(ans);
  }
  const methodTag = (m: Rpc) =>
    METHODS.has(m.method as string)
      ? (m.method as string)
      : (m.method as string).startsWith("notifications/")
        ? "notification"
        : "other";
  note({ mcp: "ok", mcp_methods: messages.map(methodTag).join(","), ...session.outcome });
  if (!answers.length) return new Response(null, { status: 202, headers: CORS_HEADERS });
  return reply(Array.isArray(body) ? answers : answers[0]);
}

const COLOR = {
  type: "string",
  description:
    'A color id (yellow, green, blue, pink, purple, orange, or a custom c-... id) or a custom color name like "Promises".',
};
const GROUP = {
  type: "string",
  enum: ["ranges", "verses"],
  description: '"ranges" (default) groups contiguous verses in one color; "verses" returns one entry per verse.',
};
const REFERENCE = {
  type: "string",
  description: 'A Bible reference in any common form: "John 3:16", "Rom 5:3-5", "Psalm 23", or "JHN.3.16-18".',
};
const BOOK_PROP = {
  type: "string",
  description: 'A book name or USFM code, like "Romans" or "ROM".',
};

export const TOOLS = [
  {
    name: "list_highlights",
    description: "List the library's highlights in canonical order.",
    inputSchema: { type: "object", properties: { color: COLOR, group: GROUP }, additionalProperties: false },
  },
  {
    name: "find_highlights",
    description: "Find highlights inside a passage or book.",
    inputSchema: {
      type: "object",
      properties: { reference: REFERENCE, book: BOOK_PROP, group: GROUP },
      additionalProperties: false,
    },
  },
  {
    name: "add_highlight",
    description: "Highlight every verse a reference covers in one color (yellow by default).",
    inputSchema: { type: "object", properties: { reference: REFERENCE, color: COLOR }, required: ["reference"], additionalProperties: false },
  },
  {
    name: "set_highlight_color",
    description: "Recolor already-highlighted verses inside a reference.",
    inputSchema: { type: "object", properties: { reference: REFERENCE, color: COLOR }, required: ["reference", "color"], additionalProperties: false },
  },
  {
    name: "delete_highlight",
    description: "Remove highlights on every verse a reference covers.",
    inputSchema: { type: "object", properties: { reference: REFERENCE }, required: ["reference"], additionalProperties: false },
  },
  {
    name: "list_passages",
    description: "List saved passages in the library in canonical order.",
    inputSchema: { type: "object", properties: { book: BOOK_PROP }, additionalProperties: false },
  },
  {
    name: "save_passage",
    description: "Save a Scripture passage to the library.",
    inputSchema: { type: "object", properties: { reference: REFERENCE }, required: ["reference"], additionalProperties: false },
  },
  {
    name: "remove_passage",
    description: "Remove a saved passage from the library without deleting notes or SRS history.",
    inputSchema: { type: "object", properties: { reference: REFERENCE }, required: ["reference"], additionalProperties: false },
  },
  {
    name: "search_notes",
    description: "Full-text search over outliner note blocks in the library.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search words or phrase." },
        limit: { type: "number", description: "Maximum results (default 50)." },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "list_colors",
    description: "List the library's colors and verse counts.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_library_info",
    description: "Get the library's name, sequence number, and item counts.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_passage_link",
    description: "Build a route.bible link for a Scripture reference.",
    inputSchema: { type: "object", properties: { reference: REFERENCE }, required: ["reference"], additionalProperties: false },
  },
] as const;

class Refusal extends Error {}

class RpcFault extends Error {
  constructor(readonly code: number, message: string) {
    super(message);
  }
}

interface BootstrapState {
  seq: number;
  library: { id: string; name: string };
  passages: Array<{ ref: string; createdTs: number; updatedTs: number; apps: Json }>;
  removedPassages: Array<{ ref: string; removedTs: number }>;
  highlights: Array<{ ref: string; color: string; createdTs: number; updatedTs: number }>;
  colors: Array<{ id: string; name: string; hex: string | null; builtIn: boolean }>;
  blocks: Array<Json>;
  srs: { cards: Array<Json>; dailyStats: Array<Json> };
}

const link = (ref: string) => `https://route.bible/${ref.toLowerCase()}`;
const newEventId = () => `ev_${b64uEncode(crypto.getRandomValues(new Uint8Array(16)))}`;

class McpSession {
  private bootCache: BootstrapState | null = null;
  outcome: Record<string, string> = {};

  constructor(
    private readonly stub: DurableObjectStub,
    private readonly rawToken: string,
  ) {}

  async answer(m: Rpc): Promise<Json | null> {
    const notification = m.id === undefined || m.id === null;
    try {
      const result = await this.dispatch(m.method as string, m.params ?? {});
      return notification ? null : { jsonrpc: "2.0", id: m.id, result };
    } catch (error) {
      if (notification) return null;
      if (error instanceof RpcFault) return rpcError(m.id, error.code, error.message);
      this.outcome.mcp_error_class = error instanceof Error && /^[A-Za-z]{1,40}$/.test(error.name) ? error.name : "Error";
      return rpcError(m.id, -32603, "Internal error");
    }
  }

  async dispatch(method: string, params: Json): Promise<unknown> {
    switch (method) {
      case "initialize": {
        const asked = String(params.protocolVersion ?? "");
        return {
          protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions:
            "Tools for a Selah Vault v2 library of Scripture passages, highlights, notes, and SRS. Give references in any common form.",
        };
      }
      case "ping":
        return {};
      case "tools/list":
        return { tools: TOOLS };
      case "tools/call":
        return this.call(String(params.name ?? ""), (params.arguments ?? {}) as Json);
      default:
        if (method.startsWith("notifications/")) return {};
        throw new RpcFault(-32601, "Method not found");
    }
  }

  async call(name: string, args: Json) {
    if (!TOOLS.some((t) => t.name === name)) throw new RpcFault(-32602, `Unknown tool: ${name}`);
    this.outcome.tools = this.outcome.tools ? `${this.outcome.tools},${name}` : name;
    try {
      const result = await this.run(name, args);
      return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result, isError: false };
    } catch (error) {
      this.outcome.tool_result = error instanceof Refusal ? "refused" : "failed";
      if (!(error instanceof Refusal)) {
        this.outcome.mcp_error_class = error instanceof Error && /^[A-Za-z]{1,40}$/.test(error.name) ? error.name : "Error";
      }
      const message = error instanceof Refusal ? error.message : "The library couldn't be reached. Try again.";
      return { content: [{ type: "text", text: message }], isError: true };
    }
  }

  private async fetchLibrary(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${this.rawToken}`);
    return this.stub.fetch(new Request(`https://library.internal${path}`, { ...init, headers }));
  }

  private async bootstrap(refresh = false): Promise<BootstrapState> {
    if (this.bootCache && !refresh) return this.bootCache;
    const res = await this.fetchLibrary("/v2/bootstrap");
    if (res.status === 403) throw new Refusal("This token does not have read permission.");
    if (!res.ok) throw new Error(`bootstrap ${res.status}`);
    this.bootCache = (await res.json()) as BootstrapState;
    return this.bootCache;
  }

  private async postEvents(events: Array<Record<string, unknown>>): Promise<void> {
    if (!events.length) return;
    const res = await this.fetchLibrary("/v2/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ events }),
    });
    if (res.status === 403) throw new Refusal("This token does not have permission for that write.");
    if (!res.ok) throw new Error(`events ${res.status}`);
    this.bootCache = null;
  }

  private verses(reference: unknown): { verses: string[]; label: string } {
    const found = readPassage(String(reference ?? ""));
    if (found.error !== undefined) throw new Refusal(found.error);
    return found;
  }

  private resolveColor(boot: BootstrapState, wanted: unknown, fallback?: string) {
    if (wanted === undefined || wanted === null || wanted === "") {
      if (!fallback) throw new Refusal("Give a color.");
      const fb = boot.colors.find((c) => c.id === fallback)!;
      return fb;
    }
    const w = String(wanted).trim().toLowerCase();
    const found = boot.colors.find((c) => c.id.toLowerCase() === w) ?? boot.colors.find((c) => c.name.toLowerCase() === w);
    if (!found) {
      throw new Refusal(`That isn't one of the library's colors: ${boot.colors.map((c) => c.name).join(", ")}.`);
    }
    return found;
  }

  private formatRuns(
    boot: BootstrapState,
    records: Array<{ ref: string; color: string }>,
    group: unknown = "ranges",
  ) {
    if (group !== undefined && group !== "ranges" && group !== "verses") {
      throw new Refusal('group must be "ranges" or "verses".');
    }
    const sorted = [...records].sort((a, b) => compareRefs(a.ref, b.ref));
    const colorName = (id: string) => boot.colors.find((c) => c.id === id)?.name ?? id;
    return groupRuns(sorted, group === "verses" ? (r: { ref: string }) => r.ref : (r: { color: string }) => r.color).map(
      ({ ref, records: rs }: { ref: string; records: Array<{ ref: string; color: string }> }) => ({
        reference: labelRef(ref),
        ref,
        color: rs[0].color,
        colorName: colorName(rs[0].color),
        verses: rs.map((r) => r.ref),
        link: link(ref),
      }),
    );
  }

  private passageRefs(reference: unknown): { refs: string[]; label: string } {
    const raw = String(reference ?? "").trim();
    const direct = splitRef(raw);
    if (direct) return { refs: [raw], label: labelRef(raw) };
    const { verses, label } = this.verses(raw);
    const refs = groupRuns(verses.map((ref) => ({ ref })), () => 0).map((g: { ref: string }) => g.ref);
    return { refs, label };
  }

  async run(name: string, args: Json): Promise<Json> {
    if (name === "get_passage_link") {
      const { verses, label } = this.verses(args.reference);
      const refs = groupRuns(verses.map((ref) => ({ ref })), () => 0).map((g: { ref: string }) => g.ref);
      return { reference: label, links: refs.map((ref: string) => ({ reference: labelRef(ref), ref, link: link(ref) })) };
    }

    if (name === "search_notes") {
      const q = String(args.query ?? "").trim();
      if (!q) throw new Refusal("Provide a search query.");
      const limit = typeof args.limit === "number" ? args.limit : 50;
      const res = await this.fetchLibrary(`/v2/search?q=${encodeURIComponent(q)}&limit=${encodeURIComponent(String(limit))}`);
      if (res.status === 403) throw new Refusal("This token does not have read permission.");
      if (!res.ok) throw new Error(`search ${res.status}`);
      return (await res.json()) as Json;
    }

    return this.runBootstrapTool(name, args);
  }

  private async runBootstrapTool(name: string, args: Json): Promise<Json> {
    const boot = await this.bootstrap();
    const maxSeen = Math.max(
      0,
      ...boot.highlights.map((h) => h.updatedTs ?? 0),
      ...boot.passages.map((p) => p.updatedTs ?? 0),
      ...(boot.removedPassages ?? []).map((p) => p.removedTs ?? 0),
    );
    const now = Math.max(Date.now(), maxSeen + 1);

    switch (name) {
      case "list_highlights": {
        const color = args.color === undefined ? null : this.resolveColor(boot, args.color).id;
        const filtered = boot.highlights.filter((h) => !color || h.color === color);
        return { highlights: this.formatRuns(boot, filtered, args.group) };
      }
      case "find_highlights": {
        let inside: (ref: string) => boolean;
        let label: string;
        if (args.book !== undefined && args.reference === undefined) {
          const code = bookCode(String(args.book));
          if (!code) throw new Refusal("That isn't a book of the Bible.");
          inside = (ref) => splitRef(ref)?.code === code;
          label = BOOKS.find(([c]) => c === code)![1];
        } else {
          const found = this.verses(args.reference);
          const set = new Set(found.verses);
          inside = (ref) => set.has(ref);
          label = found.label;
        }
        return { reference: label, highlights: this.formatRuns(boot, boot.highlights.filter((h) => inside(h.ref)), args.group) };
      }
      case "add_highlight": {
        const { verses, label } = this.verses(args.reference);
        const col = this.resolveColor(boot, args.color, "yellow");
        const existing = new Map(boot.highlights.map((h) => [h.ref, h.color]));
        const toWrite = verses.filter((v) => existing.get(v) !== col.id);
        await this.postEvents(
          toWrite.map((ref) => ({
            id: newEventId(),
            ts: now,
            app: "selah-mcp",
            kind: "highlight.set",
            ref,
            data: { color: col.id },
          })),
        );
        return { added: label, color: col.id, colorName: col.name, verses };
      }
      case "set_highlight_color": {
        const { verses, label } = this.verses(args.reference);
        const col = this.resolveColor(boot, args.color);
        const existing = new Set(boot.highlights.map((h) => h.ref));
        const targets = verses.filter((v) => existing.has(v));
        if (!targets.length) throw new Refusal(`Nothing in ${label} is highlighted.`);
        await this.postEvents(
          targets.map((ref) => ({
            id: newEventId(),
            ts: now,
            app: "selah-mcp",
            kind: "highlight.set",
            ref,
            data: { color: col.id },
          })),
        );
        return { recolored: label, color: col.id, colorName: col.name, verses: targets };
      }
      case "delete_highlight": {
        const { verses, label } = this.verses(args.reference);
        const existing = new Set(boot.highlights.map((h) => h.ref));
        const targets = verses.filter((v) => existing.has(v));
        if (!targets.length) throw new Refusal(`Nothing in ${label} is highlighted.`);
        await this.postEvents(
          targets.map((ref) => ({
            id: newEventId(),
            ts: now,
            app: "selah-mcp",
            kind: "highlight.removed",
            ref,
            data: {},
          })),
        );
        return { deleted: label, verses: targets };
      }
      case "list_passages": {
        const code = args.book !== undefined ? bookCode(String(args.book)) : null;
        if (args.book !== undefined && !code) throw new Refusal("That isn't a book of the Bible.");
        const passages = boot.passages
          .filter((p) => !code || splitRef(p.ref)?.code === code)
          .map((p) => ({
            reference: labelRef(p.ref),
            ref: p.ref,
            createdTs: p.createdTs,
            updatedTs: p.updatedTs,
            link: link(p.ref),
          }));
        return { passages };
      }
      case "save_passage": {
        const { refs, label } = this.passageRefs(args.reference);
        await this.postEvents(
          refs.map((ref) => ({
            id: newEventId(),
            ts: now,
            app: "selah-mcp",
            kind: "passage.saved",
            ref,
            data: { apps: {} },
          })),
        );
        return {
          saved: label,
          passages: refs.map((ref) => ({ reference: labelRef(ref), ref, link: link(ref) })),
        };
      }
      case "remove_passage": {
        const { refs, label } = this.passageRefs(args.reference);
        await this.postEvents(
          refs.map((ref) => ({
            id: newEventId(),
            ts: now,
            app: "selah-mcp",
            kind: "passage.removed",
            ref,
            data: {},
          })),
        );
        return { removed: label, refs };
      }
      case "list_colors": {
        const counts = new Map<string, number>();
        for (const h of boot.highlights) counts.set(h.color, (counts.get(h.color) ?? 0) + 1);
        return {
          colors: boot.colors.map((c) => ({
            id: c.id,
            name: c.name,
            builtIn: c.builtIn,
            ...(c.hex ? { hex: c.hex } : {}),
            verses: counts.get(c.id) ?? 0,
          })),
        };
      }
      case "get_library_info": {
        return {
          id: boot.library.id,
          name: boot.library.name,
          seq: boot.seq,
          highlightedVerses: boot.highlights.length,
          highlightRanges: this.formatRuns(boot, boot.highlights).length,
          passages: boot.passages.length,
          savedPassages: boot.passages.length,
          notes: boot.blocks.length,
          srsCards: boot.srs.cards.length,
          colors: boot.colors.length,
          ownColors: boot.colors.filter((c) => !c.builtIn).length,
        };
      }
    }
    throw new Refusal("Unknown tool.");
  }
}

export function bookCode(text: string): string | null {
  const t = text.trim().toLowerCase().replace(/\s+/g, " ");
  if (!t) return null;
  const exact = BOOKS.find(
    ([code, name]) => code.toLowerCase() === t || name.toLowerCase() === t || (code === "PSA" && t === "psalm"),
  );
  if (exact) return exact[0];
  const found = readPassage(`${text} 1:1`);
  return found.error !== undefined ? null : (splitRef(found.verses[0])?.code ?? null);
}
