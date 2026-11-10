// Event validation and SQLite read-model projector for LibraryDO (Selah Vault v2).

import { compareRefs, splitRef } from "../public/refs.js";
import { COLORS as BUILTIN_COLOR_IDS } from "../public/ranges.js";

export interface VaultEventInput {
  id: string;
  ts: number;
  app: string;
  kind: string;
  ref: string | null;
  tags?: string[];
  data: Record<string, unknown>;
}

export interface VaultEvent extends VaultEventInput {
  seq: number;
  tags: string[];
}

export interface SqlAdapter {
  exec<T extends Record<string, unknown> = Record<string, unknown>>(query: string, ...bindings: unknown[]): T[];
  transactionSync<T>(fn: () => T): T;
  deleteAll?(): void;
}

export const EVENT_ID_RE = /^ev_[A-Za-z0-9_-]{16,32}$/;
/** Reject client event timestamps more than this far ahead of server receive time. */
export const MAX_EVENT_FUTURE_SKEW_MS = 5 * 60_000;
const COLOR_ID_RE = /^(?:yellow|green|blue|pink|purple|orange|c-[A-Za-z0-9_-]{1,40})$/;
const BUILTIN_NAMES: Record<string, string> = {
  yellow: "Yellow",
  green: "Green",
  blue: "Blue",
  pink: "Pink",
  purple: "Purple",
  orange: "Orange",
};
const SRS_ACTIONS = new Set(["add", "suspend", "resume", "drop", "reset"]);

export function cmpTsId(aTs: number, aId: string, bTs: number, bId: string): number {
  if (aTs !== bTs) return aTs > bTs ? 1 : -1;
  if (aId === bId) return 0;
  return aId > bId ? 1 : -1;
}

export function validateEventInput(
  raw: unknown,
  opts: { nowMs?: number } = {},
): { event?: VaultEventInput; error?: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: "event must be an object" };
  const obj = raw as Record<string, unknown>;
  const { id, ts, app, kind, ref, tags, data } = obj;

  if (typeof id !== "string" || !EVENT_ID_RE.test(id)) {
    return { error: "event.id must match ev_<16..32 base64url chars>" };
  }
  if (typeof ts !== "number" || !Number.isSafeInteger(ts) || ts < 0) {
    return { error: "event.ts must be a non-negative integer" };
  }
  const nowMs = opts.nowMs ?? Date.now();
  if (ts > nowMs + MAX_EVENT_FUTURE_SKEW_MS) {
    return { error: "event.ts is too far in the future" };
  }
  if (typeof app !== "string" || app.length < 1 || app.length > 64) {
    return { error: "event.app must be a 1..64 char string" };
  }
  if (typeof kind !== "string" || !/^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+$/.test(kind)) {
    return { error: "event.kind must be dot-namespaced" };
  }
  if (ref !== null && typeof ref !== "string") {
    return { error: "event.ref must be string or null" };
  }
  if (ref !== null && !splitRef(ref)) {
    return { error: `invalid canonical USFM ref: ${ref}` };
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { error: "event.data must be an object" };
  }

  const d = data as Record<string, unknown>;
  const parsedRef = ref ? splitRef(ref) : null;

  switch (kind) {
    case "passage.saved":
    case "passage.removed":
      if (!parsedRef) return { error: `${kind} requires a canonical USFM ref` };
      break;
    case "highlight.set":
      if (!parsedRef || parsedRef.verse === null || parsedRef.end !== null) {
        return { error: "highlight.set requires a single-verse USFM ref" };
      }
      if (typeof d.color !== "string" || !COLOR_ID_RE.test(d.color)) {
        return { error: "highlight.set requires a valid color id" };
      }
      break;
    case "highlight.removed":
      if (!parsedRef || parsedRef.verse === null || parsedRef.end !== null) {
        return { error: "highlight.removed requires a single-verse USFM ref" };
      }
      break;
    case "color.set":
      if (typeof d.id !== "string" || !COLOR_ID_RE.test(d.id)) return { error: "color.set requires valid data.id" };
      if (typeof d.name !== "string" || !d.name.trim()) return { error: "color.set requires non-empty data.name" };
      break;
    case "color.removed":
      if (typeof d.id !== "string" || !COLOR_ID_RE.test(d.id)) return { error: "color.removed requires valid data.id" };
      break;
    case "note.block.set":
      if (typeof d.id !== "string" || !d.id.trim()) return { error: "note.block.set requires data.id" };
      if (typeof d.outlineId !== "string" || !d.outlineId.trim()) return { error: "note.block.set requires data.outlineId" };
      if (d.parentId !== null && d.parentId !== undefined && typeof d.parentId !== "string") {
        return { error: "note.block.set data.parentId must be string or null" };
      }
      if (typeof d.rank !== "string") return { error: "note.block.set requires data.rank" };
      if (typeof d.text !== "string") return { error: "note.block.set requires data.text" };
      break;
    case "note.block.deleted":
      if (typeof d.id !== "string" || !d.id.trim()) return { error: "note.block.deleted requires data.id" };
      break;
    case "srs.reviewed":
      if (typeof d.cardKey !== "string" || !d.cardKey.trim()) return { error: "srs.reviewed requires data.cardKey" };
      if (d.rating !== 1 && d.rating !== 2 && d.rating !== 3 && d.rating !== 4) {
        return { error: "srs.reviewed rating must be 1, 2, 3, or 4" };
      }
      break;
    case "srs.card":
      if (typeof d.cardKey !== "string" || !d.cardKey.trim()) return { error: "srs.card requires data.cardKey" };
      if (typeof d.action !== "string" || !SRS_ACTIONS.has(d.action)) {
        return { error: "srs.card action must be add, suspend, resume, drop, or reset" };
      }
      break;
    case "library.renamed":
      if (typeof d.name !== "string" || !d.name.trim()) return { error: "library.renamed requires non-empty data.name" };
      break;
  }

  const tagSet = new Set<string>();
  if (tags !== undefined) {
    if (!Array.isArray(tags) || tags.some((t) => typeof t !== "string" || !t.trim() || t.length > 128)) {
      return { error: "event.tags must be an array of non-empty strings" };
    }
    for (const t of tags) tagSet.add(t.trim());
  }
  if (parsedRef) tagSet.add(`book:${parsedRef.code}`);
  if (typeof d.cardKey === "string" && d.cardKey.trim()) tagSet.add(`card:${d.cardKey.trim()}`);

  return {
    event: {
      id,
      ts,
      app,
      kind,
      ref,
      tags: [...tagSet],
      data: d,
    },
  };
}

export const LIBRARY_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS tokens (
    id TEXT PRIMARY KEY,
    secret_hash TEXT NOT NULL UNIQUE,
    scopes TEXT NOT NULL,
    client_id TEXT,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS events (
    seq INTEGER PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    ts INTEGER NOT NULL,
    app TEXT NOT NULL,
    kind TEXT NOT NULL,
    ref TEXT,
    tags_json TEXT NOT NULL,
    data_json TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS events_kind_seq ON events (kind, seq)`,
  `CREATE INDEX IF NOT EXISTS events_ref_seq ON events (ref, seq)`,
  `CREATE INDEX IF NOT EXISTS events_app_seq ON events (app, seq)`,
  `CREATE TABLE IF NOT EXISTS event_tags (
    seq INTEGER NOT NULL,
    tag TEXT NOT NULL,
    PRIMARY KEY (tag, seq)
  )`,
  `CREATE TABLE IF NOT EXISTS passages (
    ref TEXT PRIMARY KEY,
    state TEXT NOT NULL,
    created_ts INTEGER,
    updated_ts INTEGER NOT NULL,
    last_event_id TEXT NOT NULL,
    apps_json TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS highlights (
    ref TEXT PRIMARY KEY,
    state TEXT NOT NULL,
    color TEXT,
    created_ts INTEGER,
    updated_ts INTEGER NOT NULL,
    last_event_id TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS colors (
    id TEXT PRIMARY KEY,
    state TEXT NOT NULL,
    name TEXT,
    hex TEXT,
    updated_ts INTEGER NOT NULL,
    last_event_id TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS blocks (
    id TEXT PRIMARY KEY,
    state TEXT NOT NULL,
    ref TEXT,
    outline_id TEXT,
    parent_id TEXT,
    rank TEXT,
    text TEXT,
    card_json TEXT,
    apps_json TEXT,
    created_ts INTEGER,
    updated_ts INTEGER NOT NULL,
    last_event_id TEXT NOT NULL
  )`,
  `CREATE VIRTUAL TABLE IF NOT EXISTS blocks_fts USING fts5(block_id UNINDEXED, text)`,
  `CREATE TABLE IF NOT EXISTS srs_cards (
    card_key TEXT PRIMARY KEY,
    ref TEXT,
    state TEXT NOT NULL,
    last_active_ts INTEGER,
    last_reset_ts INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS srs_reviews (
    id TEXT PRIMARY KEY,
    card_key TEXT NOT NULL,
    ts INTEGER NOT NULL,
    rating INTEGER NOT NULL,
    rung TEXT,
    hints INTEGER,
    prompt_card TEXT,
    duration_ms INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS srs_reviews_card_idx ON srs_reviews (card_key, ts, id)`,
  `CREATE TABLE IF NOT EXISTS srs_daily_stats (
    date TEXT PRIMARY KEY,
    reviews INTEGER NOT NULL,
    again INTEGER NOT NULL,
    hard INTEGER NOT NULL,
    good INTEGER NOT NULL,
    easy INTEGER NOT NULL
  )`,
];

export function initSchema(sql: SqlAdapter): void {
  for (const stmt of LIBRARY_SCHEMA_STATEMENTS) {
    sql.exec(stmt);
  }
}

export function projectEvent(sql: SqlAdapter, ev: VaultEvent): void {
  const d = ev.data;
  switch (ev.kind) {
    case "library.renamed": {
      const tsRow = sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = 'name_ts'")[0];
      const idRow = sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = 'name_event_id'")[0];
      const curTs = tsRow ? Number(tsRow.value) : -1;
      const curId = idRow ? idRow.value : "";
      if (cmpTsId(ev.ts, ev.id, curTs, curId) > 0) {
        sql.exec("INSERT OR REPLACE INTO meta (key, value) VALUES ('library_name', ?)", String(d.name).trim());
        sql.exec("INSERT OR REPLACE INTO meta (key, value) VALUES ('name_ts', ?)", String(ev.ts));
        sql.exec("INSERT OR REPLACE INTO meta (key, value) VALUES ('name_event_id', ?)", ev.id);
      }
      break;
    }
    case "passage.saved":
    case "passage.removed": {
      const ref = ev.ref!;
      const cur = sql.exec<{
        state: string;
        created_ts: number | null;
        updated_ts: number;
        last_event_id: string;
        apps_json: string;
      }>("SELECT state, created_ts, updated_ts, last_event_id, apps_json FROM passages WHERE ref = ?", ref)[0];
      const nextCreated =
        ev.kind === "passage.saved"
          ? cur?.created_ts != null
            ? Math.min(cur.created_ts, ev.ts)
            : ev.ts
          : (cur?.created_ts ?? null);
      if (!cur || cmpTsId(ev.ts, ev.id, cur.updated_ts, cur.last_event_id) > 0) {
        const nextState = ev.kind === "passage.saved" ? "saved" : "removed";
        const nextApps =
          ev.kind === "passage.saved"
            ? JSON.stringify(d.apps && typeof d.apps === "object" && !Array.isArray(d.apps) ? d.apps : cur ? JSON.parse(cur.apps_json) : {})
            : (cur?.apps_json ?? "{}");
        sql.exec(
          `INSERT OR REPLACE INTO passages (ref, state, created_ts, updated_ts, last_event_id, apps_json)
           VALUES (?, ?, ?, ?, ?, ?)`,
          ref,
          nextState,
          nextCreated,
          ev.ts,
          ev.id,
          nextApps,
        );
      } else if (nextCreated !== cur.created_ts) {
        sql.exec("UPDATE passages SET created_ts = ? WHERE ref = ?", nextCreated, ref);
      }
      break;
    }
    case "highlight.set":
    case "highlight.removed": {
      const ref = ev.ref!;
      const cur = sql.exec<{
        state: string;
        color: string | null;
        created_ts: number | null;
        updated_ts: number;
        last_event_id: string;
      }>("SELECT state, color, created_ts, updated_ts, last_event_id FROM highlights WHERE ref = ?", ref)[0];
      const nextCreated =
        ev.kind === "highlight.set"
          ? cur?.created_ts != null
            ? Math.min(cur.created_ts, ev.ts)
            : ev.ts
          : (cur?.created_ts ?? null);
      if (!cur || cmpTsId(ev.ts, ev.id, cur.updated_ts, cur.last_event_id) > 0) {
        sql.exec(
          `INSERT OR REPLACE INTO highlights (ref, state, color, created_ts, updated_ts, last_event_id)
           VALUES (?, ?, ?, ?, ?, ?)`,
          ref,
          ev.kind === "highlight.set" ? "active" : "removed",
          ev.kind === "highlight.set" ? String(d.color) : (cur?.color ?? null),
          nextCreated,
          ev.ts,
          ev.id,
        );
      } else if (nextCreated !== cur.created_ts) {
        sql.exec("UPDATE highlights SET created_ts = ? WHERE ref = ?", nextCreated, ref);
      }
      break;
    }
    default:
      projectOtherEvent(sql, ev);
      break;
  }
}

function projectOtherEvent(sql: SqlAdapter, ev: VaultEvent): void {
  const d = ev.data;
  switch (ev.kind) {
    case "color.set":
    case "color.removed": {
      const id = String(d.id);
      const cur = sql.exec<{ updated_ts: number; last_event_id: string }>(
        "SELECT updated_ts, last_event_id FROM colors WHERE id = ?",
        id,
      )[0];
      if (!cur || cmpTsId(ev.ts, ev.id, cur.updated_ts, cur.last_event_id) > 0) {
        sql.exec(
          `INSERT OR REPLACE INTO colors (id, state, name, hex, updated_ts, last_event_id)
           VALUES (?, ?, ?, ?, ?, ?)`,
          id,
          ev.kind === "color.set" ? "active" : "removed",
          ev.kind === "color.set" ? String(d.name).trim() : null,
          ev.kind === "color.set" && typeof d.hex === "string" ? d.hex : null,
          ev.ts,
          ev.id,
        );
      }
      break;
    }
    case "note.block.set":
    case "note.block.deleted": {
      const id = String(d.id);
      const cur = sql.exec<{
        state: string;
        created_ts: number | null;
        updated_ts: number;
        last_event_id: string;
      }>("SELECT state, created_ts, updated_ts, last_event_id FROM blocks WHERE id = ?", id)[0];
      const nextCreated =
        ev.kind === "note.block.set"
          ? cur?.created_ts != null
            ? Math.min(cur.created_ts, ev.ts)
            : ev.ts
          : (cur?.created_ts ?? null);
      if (!cur || cmpTsId(ev.ts, ev.id, cur.updated_ts, cur.last_event_id) > 0) {
        sql.exec("DELETE FROM blocks_fts WHERE block_id = ?", id);
        if (ev.kind === "note.block.set") {
          const text = String(d.text);
          sql.exec(
            `INSERT OR REPLACE INTO blocks
             (id, state, ref, outline_id, parent_id, rank, text, card_json, apps_json, created_ts, updated_ts, last_event_id)
             VALUES (?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            id,
            ev.ref,
            String(d.outlineId),
            d.parentId == null ? null : String(d.parentId),
            String(d.rank),
            text,
            d.card != null ? JSON.stringify(d.card) : null,
            JSON.stringify(d.apps && typeof d.apps === "object" && !Array.isArray(d.apps) ? d.apps : {}),
            nextCreated,
            ev.ts,
            ev.id,
          );
          if (text.trim()) sql.exec("INSERT INTO blocks_fts (block_id, text) VALUES (?, ?)", id, text);
        } else {
          sql.exec(
            `INSERT OR REPLACE INTO blocks
             (id, state, ref, outline_id, parent_id, rank, text, card_json, apps_json, created_ts, updated_ts, last_event_id)
             VALUES (?, 'deleted', ?, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?, ?)`,
            id,
            ev.ref,
            nextCreated,
            ev.ts,
            ev.id,
          );
        }
      } else if (nextCreated !== cur.created_ts) {
        sql.exec("UPDATE blocks SET created_ts = ? WHERE id = ?", nextCreated, id);
      }
      break;
    }
    case "srs.reviewed":
    case "srs.card": {
      if (ev.kind === "srs.reviewed") updateDailyStats(sql, ev.ts, Number(d.rating));
      recomputeSrsCard(sql, String(d.cardKey).trim());
      break;
    }
  }
}

function updateDailyStats(sql: SqlAdapter, ts: number, rating: number): void {
  const date = new Date(ts).toISOString().slice(0, 10);
  const again = rating === 1 ? 1 : 0;
  const hard = rating === 2 ? 1 : 0;
  const good = rating === 3 ? 1 : 0;
  const easy = rating === 4 ? 1 : 0;
  sql.exec(
    `INSERT INTO srs_daily_stats (date, reviews, again, hard, good, easy)
     VALUES (?, 1, ?, ?, ?, ?)
     ON CONFLICT(date) DO UPDATE SET
       reviews = srs_daily_stats.reviews + 1,
       again = srs_daily_stats.again + excluded.again,
       hard = srs_daily_stats.hard + excluded.hard,
       good = srs_daily_stats.good + excluded.good,
       easy = srs_daily_stats.easy + excluded.easy`,
    date,
    again,
    hard,
    good,
    easy,
  );
}

function recomputeSrsCard(sql: SqlAdapter, cardKey: string): void {
  const rows = sql.exec<{ id: string; ts: number; kind: string; ref: string | null; data_json: string }>(
    `SELECT e.id, e.ts, e.kind, e.ref, e.data_json
     FROM events e
     JOIN event_tags t ON t.seq = e.seq
     WHERE t.tag = ? AND e.kind IN ('srs.reviewed', 'srs.card')
     ORDER BY e.ts ASC, e.id ASC`,
    `card:${cardKey}`,
  );
  const hashIdx = cardKey.indexOf("#");
  const prefix = hashIdx > 0 ? cardKey.slice(0, hashIdx) : "";
  let ref: string | null = prefix && splitRef(prefix) ? prefix : null;
  let state = "absent";
  let lastActiveTs: number | null = null;
  let lastResetTs: number | null = null;
  const reviews: Array<{
    id: string;
    ts: number;
    rating: number;
    rung: string | null;
    hints: number | null;
    promptCard: string | null;
    durationMs: number | null;
  }> = [];

  for (const r of rows) {
    if (r.ref) ref = r.ref;
    const d = JSON.parse(r.data_json) as Record<string, unknown>;
    if (String(d.cardKey ?? "").trim() !== cardKey) continue;
    if (r.kind === "srs.card") {
      switch (d.action) {
        case "add":
          state = "active";
          lastActiveTs = r.ts;
          break;
        case "suspend":
          if (state === "active") state = "suspended";
          break;
        case "resume":
          if (state === "suspended" || state === "active") {
            state = "active";
            lastActiveTs = r.ts;
          }
          break;
        case "drop":
          if (state === "active" || state === "suspended") state = "dropped";
          break;
        case "reset":
          lastResetTs = r.ts;
          reviews.length = 0;
          break;
      }
    } else if (r.kind === "srs.reviewed") {
      state = "active";
      lastActiveTs = r.ts;
      reviews.push({
        id: r.id,
        ts: r.ts,
        rating: Number(d.rating),
        rung: typeof d.rung === "string" ? d.rung : null,
        hints: typeof d.hints === "number" ? d.hints : null,
        promptCard: typeof d.promptCard === "string" ? d.promptCard : null,
        durationMs: typeof d.durationMs === "number" ? d.durationMs : null,
      });
    }
  }

  sql.exec("DELETE FROM srs_reviews WHERE card_key = ?", cardKey);
  if (state === "absent" && lastResetTs === null) {
    sql.exec("DELETE FROM srs_cards WHERE card_key = ?", cardKey);
    return;
  }
  sql.exec(
    `INSERT OR REPLACE INTO srs_cards (card_key, ref, state, last_active_ts, last_reset_ts)
     VALUES (?, ?, ?, ?, ?)`,
    cardKey,
    ref,
    state,
    lastActiveTs,
    lastResetTs,
  );
  for (const rev of reviews) {
    sql.exec(
      `INSERT INTO srs_reviews (id, card_key, ts, rating, rung, hints, prompt_card, duration_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      rev.id,
      cardKey,
      rev.ts,
      rev.rating,
      rev.rung,
      rev.hints,
      rev.promptCard,
      rev.durationMs,
    );
  }
}

export interface BlockView {
  id: string;
  ref: string | null;
  outlineId: string;
  parentId: string | null;
  rank: string;
  text: string;
  card: Record<string, unknown> | null;
  apps: Record<string, unknown>;
  createdTs: number;
  updatedTs: number;
}

function mapBlockRow(r: Record<string, unknown>): BlockView {
  return {
    id: String(r.id),
    ref: r.ref == null ? null : String(r.ref),
    outlineId: String(r.outline_id),
    parentId: r.parent_id == null ? null : String(r.parent_id),
    rank: String(r.rank),
    text: String(r.text),
    card: r.card_json ? (JSON.parse(String(r.card_json)) as Record<string, unknown>) : null,
    apps: r.apps_json ? (JSON.parse(String(r.apps_json)) as Record<string, unknown>) : {},
    createdTs: Number(r.created_ts ?? r.updated_ts),
    updatedTs: Number(r.updated_ts),
  };
}

export function buildBootstrap(sql: SqlAdapter, fallbackUserId: string) {
  const headSeq = Number(sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = 'head_seq'")[0]?.value ?? "0");
  const libId = sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = 'library_id'")[0]?.value ?? fallbackUserId;
  const libName = sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = 'library_name'")[0]?.value ?? "Personal";

  const passageRows = sql.exec<{
    ref: string;
    state: string;
    created_ts: number | null;
    updated_ts: number;
    apps_json: string;
  }>("SELECT ref, state, created_ts, updated_ts, apps_json FROM passages");

  const passages = passageRows
    .filter((p) => p.state === "saved")
    .sort((a, b) => compareRefs(a.ref, b.ref))
    .map((p) => ({
      ref: p.ref,
      createdTs: p.created_ts ?? p.updated_ts,
      updatedTs: p.updated_ts,
      apps: JSON.parse(p.apps_json) as Record<string, unknown>,
    }));

  const removedMap = new Map<string, number>();
  const removedPassages = passageRows
    .filter((p) => p.state === "removed")
    .sort((a, b) => compareRefs(a.ref, b.ref))
    .map((p) => {
      removedMap.set(p.ref, p.updated_ts);
      return { ref: p.ref, removedTs: p.updated_ts };
    });

  const highlights = sql
    .exec<{ ref: string; color: string; created_ts: number | null; updated_ts: number }>(
      "SELECT ref, color, created_ts, updated_ts FROM highlights WHERE state = 'active'",
    )
    .sort((a, b) => compareRefs(a.ref, b.ref))
    .map((h) => ({
      ref: h.ref,
      color: h.color,
      createdTs: h.created_ts ?? h.updated_ts,
      updatedTs: h.updated_ts,
    }));

  const colorRows = sql.exec<{ id: string; state: string; name: string | null; hex: string | null }>(
    "SELECT id, state, name, hex FROM colors",
  );
  const colorById = new Map(colorRows.map((c) => [c.id, c]));
  const builtInSet = new Set<string>(BUILTIN_COLOR_IDS);
  const colors = [
    ...BUILTIN_COLOR_IDS.map((id: string) => {
      const custom = colorById.get(id);
      const active = custom && custom.state === "active";
      return {
        id,
        name: active && custom.name ? custom.name : BUILTIN_NAMES[id] ?? id,
        hex: active ? (custom.hex ?? null) : null,
        builtIn: true,
      };
    }),
    ...colorRows
      .filter((c) => !builtInSet.has(c.id) && c.state === "active")
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((c) => ({
        id: c.id,
        name: c.name ?? c.id,
        hex: c.hex ?? null,
        builtIn: false,
      })),
  ];

  const blocks = sql
    .exec("SELECT * FROM blocks WHERE state = 'active' ORDER BY outline_id ASC, rank ASC, id ASC")
    .map(mapBlockRow);

  const cardRows = sql.exec<{
    card_key: string;
    ref: string | null;
    state: string;
    last_active_ts: number | null;
    last_reset_ts: number | null;
  }>("SELECT card_key, ref, state, last_active_ts, last_reset_ts FROM srs_cards ORDER BY card_key ASC");

  const reviewRows = sql.exec<{
    id: string;
    card_key: string;
    ts: number;
    rating: number;
    rung: string | null;
    hints: number | null;
    prompt_card: string | null;
    duration_ms: number | null;
  }>("SELECT id, card_key, ts, rating, rung, hints, prompt_card, duration_ms FROM srs_reviews ORDER BY ts ASC, id ASC");

  const reviewsByCard = new Map<string, Array<Record<string, unknown>>>();
  for (const r of reviewRows) {
    const item: Record<string, unknown> = { id: r.id, ts: r.ts, rating: r.rating };
    if (r.rung !== null) item.rung = r.rung;
    if (r.hints !== null) item.hints = r.hints;
    if (r.prompt_card !== null) item.promptCard = r.prompt_card;
    if (r.duration_ms !== null) item.durationMs = r.duration_ms;
    const list = reviewsByCard.get(r.card_key) ?? [];
    list.push(item);
    reviewsByCard.set(r.card_key, list);
  }

  const cards = cardRows.map((c) => {
    const hashIdx = c.card_key.indexOf("#");
    const passageRef = hashIdx > 0 ? c.card_key.slice(0, hashIdx) : null;
    const removedAt = passageRef ? removedMap.get(passageRef) : undefined;
    const pausedByPassage = removedAt !== undefined && c.last_active_ts !== null && c.last_active_ts <= removedAt;
    return {
      cardKey: c.card_key,
      ref: c.ref,
      state: c.state,
      pausedByPassage,
      lastActiveTs: c.last_active_ts,
      lastResetTs: c.last_reset_ts,
      reviews: reviewsByCard.get(c.card_key) ?? [],
    };
  });

  const dailyStats = sql.exec<{
    date: string;
    reviews: number;
    again: number;
    hard: number;
    good: number;
    easy: number;
  }>("SELECT date, reviews, again, hard, good, easy FROM srs_daily_stats ORDER BY date ASC");

  return {
    seq: headSeq,
    library: { id: libId, name: libName },
    passages,
    removedPassages,
    highlights,
    colors,
    blocks,
    srs: { cards, dailyStats },
  };
}

export function searchBlocks(sql: SqlAdapter, rawQuery: string, limit: number): BlockView[] {
  const tokens = rawQuery.trim().match(/[\p{L}\p{N}_]+/gu);
  if (!tokens || !tokens.length) return [];
  const ftsQuery = tokens.map((t) => `"${t}"*`).join(" AND ");
  const clamped = Math.min(Math.max(1, Math.trunc(limit || 50)), 200);
  const rows = sql.exec(
    `SELECT b.*
     FROM blocks_fts f
     JOIN blocks b ON b.id = f.block_id
     WHERE blocks_fts MATCH ? AND b.state = 'active'
     ORDER BY bm25(blocks_fts) ASC
     LIMIT ?`,
    ftsQuery,
    clamped,
  );
  return rows.map(mapBlockRow);
}
