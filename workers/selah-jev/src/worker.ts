// selah-jev: a stateless proxy from the vault client to TypeSafe Jev (jev-latest).
// Accepts only the relevance request shape; never logs the API key; CORS only for the vault.
// Deployed on its own (see wrangler.toml); the selah-vault Worker is untouched.

export interface Env {
  TYPESAFE_API_KEY: string;
  /** Daily spend (usd) and per-library rate counters. */
  CAPS: KVNamespace;
}

const UPSTREAM = "https://api.typesafe.ai/v1/systemone";
const MODEL = "jev-latest";
/** Explicit UA so Cloudflare in front of api.typesafe.ai does not bot-block empty Worker fetches. */
export const UPSTREAM_UA = "selah-jev/1.0";
/** TypeSafe list price: $0.042 per million input tokens; output is free. */
export const USD_PER_MTOK = 0.042;
export const DAILY_CAP_USD = 0.25;
export const MAX_BODY_BYTES = 120_000;
export const MAX_HIGHLIGHTS = 40;
export const RATE_PER_MIN = 12;
export const MAX_TOPIC_CHARS = 200;
export const VAULT_ORIGINS = new Set([
  "https://vault.selah.tools",
  "https://sync.selah.tools",
  "http://localhost:8787",
  "http://127.0.0.1:8787",
]);

/** Preview versions of the vault Worker, e.g. https://1a2b3c4d-selah-vault.dpshade.workers.dev. */
const PREVIEW_ORIGIN = /^https:\/\/[a-z0-9-]+-selah-vault\.dpshade\.workers\.dev$/;

export const allowedOrigin = (origin: string | null): boolean =>
  !!origin && (VAULT_ORIGINS.has(origin) || PREVIEW_ORIGIN.test(origin));

const PASSAGE_TASK =
  "A person highlighted these Bible passages and wants to know which of them speak to `passage`. " +
  "A highlight speaks to it when it shares the passage's teaching, promise, warning, call or story, " +
  "including a real link across books or testaments (a promise and its fulfillment, the same theme in other words). " +
  "Sharing a word or image without sharing the meaning does not count.";

const TOPIC_TASK =
  "A person highlighted Bible passages and wants them ordered by how closely each speaks to `topic`. " +
  "Judge by the highlight's teaching, promise, warning, call or story — not by shared words alone.";

const OBVIOUSNESS = [
  "Hidden: a sound link few readers would see without having it pointed out, usually across books, genres or testaments with no shared words.",
  "Not obvious: the link is real but takes a careful, thoughtful reading to notice.",
  "Clear: a careful reader of both would usually notice the link, such as a well-known cross-reference.",
  "Plain: the link is on the surface, such as the same chapter, the same words, or a direct quotation.",
];

const CLOSENESS = [
  "Unrelated — the highlight does not meaningfully speak to the topic.",
  "Weak — only a faint or indirect connection.",
  "Moderate — a clear secondary connection worth noticing.",
  "Strong — directly and meaningfully addresses the topic.",
  "Primary — among the library's clearest answers to the topic.",
];

type Passage = { ref: string; text: string };
type Highlight = { id: string; ref: string; text: string };
export type Ask = "filter" | "sort" | "topic";
export type RelevanceBody =
  | { lib: string; ask: "filter" | "sort"; passage: Passage; highlights: Highlight[]; topic?: undefined }
  | { lib: string; ask: "topic"; topic: string; highlights: Highlight[]; passage?: undefined };

function cors(origin: string | null): HeadersInit {
  const allow = allowedOrigin(origin) ? origin : "https://vault.selah.tools";
  return {
    "access-control-allow-origin": allow,
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "86400",
    vary: "Origin",
  };
}

function json(body: unknown, status: number, origin: string | null): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors(origin), "content-type": "application/json", "cache-control": "no-store" },
  });
}

const fail = (status: number, error: string, origin: string | null) => json({ error }, status, origin);

/**
 * Scrub anything that looks like a key / Authorization value from an upstream body, then keep the
 * first 300 chars for a non-secret diagnostic. Never put the Worker secret in the response or logs.
 */
export function scrubUpstreamBody(text: string, max = 300): string {
  let s = String(text ?? "");
  s = s.replace(/Bearer\s+[A-Za-z0-9._\-+=\/]+/gi, "Bearer [redacted]");
  s = s.replace(/("?(?:authorization|api[_-]?key|access[_-]?token|secret)"?\s*[:=]\s*")([^"]*)(")/gi, "$1[redacted]$3");
  s = s.replace(/\bsk-[A-Za-z0-9_\-]{8,}\b/g, "[redacted]");
  s = s.replace(/\b(api[_-]?key|token|secret)\s*[:=]\s*[^\s"',}]+/gi, "$1:[redacted]");
  return s.slice(0, max);
}

/** 502 for a non-ok TypeSafe response, with a scrubbed upstream snippet for diagnosis. */
function upstreamFail(
  error: string,
  upstreamStatus: number,
  upstreamText: string,
  origin: string | null,
): Response {
  const upstream_body = scrubUpstreamBody(upstreamText);
  console.log("selah-jev upstream non-ok", { upstream_status: upstreamStatus, upstream_body });
  return json({ error, upstream_status: upstreamStatus, upstream_body }, 502, origin);
}

/** Trim and cap a free-text topic; empty after trim is rejected by the caller. */
export function sanitizeTopic(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const t = raw.replace(/\s+/g, " ").trim();
  if (!t) return null;
  return t.slice(0, MAX_TOPIC_CHARS);
}

function parseHighlights(raw: unknown): { ok: true; highlights: Highlight[] } | { ok: false; error: string } {
  if (!Array.isArray(raw)) return { ok: false, error: "highlights must be an array" };
  if (raw.length === 0) return { ok: false, error: "highlights is empty" };
  if (raw.length > MAX_HIGHLIGHTS) return { ok: false, error: `at most ${MAX_HIGHLIGHTS} highlights` };
  const highlights: Highlight[] = [];
  for (const h of raw) {
    if (!h || typeof h !== "object") return { ok: false, error: "each highlight needs id, ref, text" };
    const row = h as Record<string, unknown>;
    if (typeof row.id !== "string" || typeof row.ref !== "string" || typeof row.text !== "string") {
      return { ok: false, error: "each highlight needs id, ref, text" };
    }
    if (!row.id || row.id.length > 128) return { ok: false, error: "highlight id is too long" };
    highlights.push({ id: row.id, ref: row.ref, text: row.text });
  }
  return { ok: true, highlights };
}

/** Reject anything that isn't a filter/sort/topic relevance shape. */
export function parseRelevanceBody(raw: unknown): { ok: true; body: RelevanceBody } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "body must be a JSON object" };
  const o = raw as Record<string, unknown>;
  if (typeof o.lib !== "string" || !o.lib || o.lib.length > 128) return { ok: false, error: "lib is required" };
  const ask = o.ask;
  if (ask !== "filter" && ask !== "sort" && ask !== "topic") {
    return { ok: false, error: "ask must be filter, sort, or topic" };
  }
  const hl = parseHighlights(o.highlights);
  if (!hl.ok) return hl;

  if (ask === "topic") {
    const topic = sanitizeTopic(o.topic);
    if (!topic) return { ok: false, error: "topic is required" };
    for (const key of Object.keys(o)) {
      if (!["lib", "ask", "topic", "highlights"].includes(key)) return { ok: false, error: `unknown field ${key}` };
    }
    return { ok: true, body: { lib: o.lib, ask: "topic", topic, highlights: hl.highlights } };
  }

  const passage = o.passage as Record<string, unknown> | null;
  if (!passage || typeof passage.ref !== "string" || typeof passage.text !== "string") {
    return { ok: false, error: "passage.ref and passage.text are required" };
  }
  for (const key of Object.keys(o)) {
    if (!["lib", "ask", "passage", "highlights"].includes(key)) return { ok: false, error: `unknown field ${key}` };
  }
  return {
    ok: true,
    body: {
      lib: o.lib,
      ask,
      passage: { ref: passage.ref, text: passage.text },
      highlights: hl.highlights,
    },
  };
}

/**
 * Build the SystemOne payload. `filter` → `{id}_relevant` only; `sort` → `{id}_obviousness` only;
 * `topic` → `{id}_closeness` only (against the free-text topic). No reason/tagline questions.
 */
export function toSystemOne(body: RelevanceBody) {
  const highlights: Record<string, { reference: string; text: string }> = {};
  const questions: Record<string, unknown> = {};
  body.highlights.forEach((h, i) => {
    const key = `h${i}`, path = `\`highlights.${key}\``;
    highlights[key] = { reference: h.ref, text: h.text };
    if (body.ask === "filter") {
      questions[`${h.id}_relevant`] = {
        type: "noul",
        instructions: `Following \`task\`, does the highlighted text ${path} speak to \`passage\`? Judge by both texts, not by their references alone.`,
        criteria: {
          true: "The highlight shares the passage's teaching, promise, warning, call or story, even if it is in another book.",
          false: "The highlight is about something else, or shares only a word or image with the passage.",
        },
      };
    } else if (body.ask === "sort") {
      questions[`${h.id}_obviousness`] = {
        type: "score",
        instructions: `How obvious is the link between the highlighted text ${path} and \`passage\` to an ordinary Bible reader?`,
        criteria: [...OBVIOUSNESS],
      };
    } else {
      questions[`${h.id}_closeness`] = {
        type: "score",
        instructions: `How closely does the highlighted text ${path} speak to \`topic\`?`,
        criteria: [...CLOSENESS],
      };
    }
  });
  if (body.ask === "topic") {
    return {
      model: MODEL,
      state: { task: TOPIC_TASK, topic: body.topic, highlights },
      questions,
    };
  }
  return {
    model: MODEL,
    state: {
      task: PASSAGE_TASK,
      passage: { reference: body.passage.ref, text: body.passage.text },
      highlights,
    },
    questions,
  };
}

/** TypeSafe reports billable `usage.input_tokens`; output tokens are free. */
export function usdFromUsage(usage: { input_tokens?: number } | undefined): number {
  const tokens = usage?.input_tokens ?? 0;
  return (tokens / 1_000_000) * USD_PER_MTOK;
}

function dayKey(now = new Date()) {
  return `spend:${now.toISOString().slice(0, 10)}`;
}

function rateKey(lib: string, now = new Date()) {
  return `rate:${lib}:${now.toISOString().slice(0, 16)}`;
}

/** In-memory stand-in for KV when tests pass a Map-backed binding. */
export function memoryCaps(store = new Map<string, string>()) {
  return {
    store,
    async get(key: string) {
      return store.has(key) ? store.get(key)! : null;
    },
    async put(key: string, value: string, _opts?: { expirationTtl?: number }) {
      store.set(key, value);
    },
  } as unknown as KVNamespace;
}

export async function handle(request: Request, env: Env, upstreamFetch: typeof fetch = fetch): Promise<Response> {
  const origin = request.headers.get("origin");
  if (request.method === "OPTIONS") {
    if (origin && !allowedOrigin(origin)) return new Response(null, { status: 403 });
    return new Response(null, { status: 204, headers: cors(origin) });
  }
  if (request.method !== "POST") return fail(405, "POST only", origin);
  if (origin && !allowedOrigin(origin)) return fail(403, "origin not allowed", origin);

  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_BODY_BYTES) return fail(413, "body too large", origin);
  const rawText = await request.text();
  if (new TextEncoder().encode(rawText).length > MAX_BODY_BYTES) return fail(413, "body too large", origin);

  let raw: unknown;
  try {
    raw = JSON.parse(rawText);
  } catch {
    return fail(400, "invalid JSON", origin);
  }
  const parsed = parseRelevanceBody(raw);
  if (!parsed.ok) return fail(400, parsed.error, origin);

  const spent = Number((await env.CAPS.get(dayKey())) ?? "0");
  if (spent >= DAILY_CAP_USD) return fail(429, "daily spend cap", origin);

  const rk = rateKey(parsed.body.lib);
  const hits = Number((await env.CAPS.get(rk)) ?? "0");
  if (hits >= RATE_PER_MIN) return fail(429, "library rate limit", origin);
  await env.CAPS.put(rk, String(hits + 1), { expirationTtl: 120 });

  const apiKey = String(env.TYPESAFE_API_KEY ?? "").trim();
  if (!apiKey) return fail(503, "jev unavailable", origin);

  let upstream: Response;
  try {
    upstream = await upstreamFetch(UPSTREAM, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": UPSTREAM_UA,
      },
      body: JSON.stringify(toSystemOne(parsed.body)),
    });
  } catch {
    return fail(502, "upstream error", origin);
  }
  const text = await upstream.text();
  if (!upstream.ok) {
    // Rate limits stay 429 for the UI; everything else is a 502 with a scrubbed diagnostic.
    if (upstream.status === 429 || upstream.status === 529) return fail(429, "upstream rate limit", origin);
    if (upstream.status === 401 || upstream.status === 403) {
      return upstreamFail("ranking unavailable", upstream.status, text, origin);
    }
    return upstreamFail("upstream error", upstream.status, text, origin);
  }
  let data: { answers?: unknown; usage?: { input_tokens?: number; output_tokens?: number }; model?: string };
  try {
    data = JSON.parse(text);
  } catch {
    return fail(502, "bad upstream", origin);
  }

  const usd = usdFromUsage(data.usage);
  await env.CAPS.put(dayKey(), String(spent + usd), { expirationTtl: 60 * 60 * 48 });

  return json({ model: data.model ?? MODEL, answers: data.answers ?? {}, usage: data.usage ?? {}, usd }, 200, origin);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await handle(request, env);
    } catch {
      // Always answer with CORS so the vault never surfaces a raw "Failed to fetch" for Worker crashes.
      return fail(500, "jev unavailable", request.headers.get("origin"));
    }
  },
} satisfies ExportedHandler<Env>;
