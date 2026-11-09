// A small reference for SPEC.md 1.3 (deterministic imports) and 1.7 (review log, yearly archive),
// used only by tests. No client writes these kinds yet (docs/reference-gaps.md); this exists so
// the spec's rules, examples and budget are checked against something that runs.
import { createHash } from "node:crypto";

type Rec = Record<string, unknown>;
export type Ev = [number, number, number | string, ...unknown[]];
export type Day = [string, number | null, number, Ev[]];

export interface Bucket extends Rec {
  kind: "srs-log";
  ref: string;
  date: string;
  part?: number;
  cards: string[];
  cols?: string[];
  events: Ev[];
  tz?: number;
  client?: string;
}

export interface Chunk extends Rec {
  kind: "srs-archive";
  ref: string;
  base: number;
  cards: string[];
  cols?: string[];
  days: Day[];
  client?: string;
}

/** One event, with everything replay needs. `seq` orders one device's events as it wrote them. */
export interface Flat {
  card: string;
  time: number;
  what: number | string;
  cols: Record<string, unknown>;
  device: string;
  date: string;
  tz: number | null;
  seq: [string, number, number, number];
}

export const LIMIT = 16 * 1024;
export const jsonBytes = (r: unknown) => new TextEncoder().encode(JSON.stringify(r)).length;
/** Blob characters of a record's item (SPEC.md 5.3): padded to 256 bytes, nonce and tag, base64url. */
export const blobChars = (r: unknown) => Math.ceil(((Math.ceil(jsonBytes(r) / 256) * 256 + 28) * 4) / 3);

export function bucketRef(ref: string) {
  const m = /^([A-Za-z0-9_-]{1,32})\/([1-9]\d*)$/.exec(ref);
  return m ? { device: m[1], slot: Number(m[2]) } : null;
}

export function chunkRef(ref: string) {
  const m = /^([A-Za-z0-9_-]{1,32})\/(\d{4})\/([1-9]\d*)$/.exec(ref);
  return m ? { device: m[1], year: m[2], n: Number(m[3]) } : null;
}

const colsOf = (names: string[] | undefined, e: unknown[]) => {
  const out: Record<string, unknown> = {};
  (names ?? []).forEach((name, i) => {
    if (e[3 + i] !== undefined && e[3 + i] !== null) out[name] = e[3 + i];
  });
  return out;
};

/** Every event in a library's live log and archive records, each counted once (1.7, "Archive"). */
export function allEvents(records: Rec[]): Flat[] {
  const live = records.filter((r) => !r.deleted);
  const chunks = (live.filter((r) => r.kind === "srs-archive") as Chunk[])
    .map((c) => ({ c, at: chunkRef(c.ref) }))
    .filter((x) => x.at)
    .sort((a, b) => a.at!.n - b.at!.n);
  const out: Flat[] = [];
  const folded = new Set<string>();
  const tables = new Map<string, string[]>();
  for (const { c, at } of chunks) {
    const key = `${at!.device}/${at!.year}`;
    const table = tables.get(key) ?? [];
    // A chunk whose earlier chunks haven't arrived can't be read yet: its indexes would be wrong.
    if (table.length !== c.base) continue;
    table.push(...c.cards);
    tables.set(key, table);
    c.days.forEach(([date, tz, t0, events]) => {
      folded.add(`${at!.device}/${date}`);
      let time = t0;
      events.forEach((e, i) => {
        time += e[1];
        out.push({ card: table[e[0]], time, what: e[2], cols: colsOf(c.cols, e), device: at!.device, date, tz, seq: [date, at!.n, 0, i] });
      });
    });
  }
  for (const b of live.filter((r) => r.kind === "srs-log") as Bucket[]) {
    const at = bucketRef(b.ref);
    if (!at || typeof b.date !== "string" || folded.has(`${at.device}/${b.date}`)) continue;
    b.events.forEach((e, i) => {
      out.push({ card: b.cards[e[0]], time: e[1], what: e[2], cols: colsOf(b.cols, e), device: at.device, date: b.date, tz: b.tz ?? null, seq: [b.date, b.part ?? 0, at.slot, i] });
    });
  }
  return out.sort(
    (a, b) =>
      a.time - b.time ||
      (a.device < b.device ? -1 : a.device > b.device ? 1 : 0) ||
      (a.seq[0] < b.seq[0] ? -1 : a.seq[0] > b.seq[0] ? 1 : 0) ||
      a.seq[1] - b.seq[1] ||
      a.seq[2] - b.seq[2] ||
      a.seq[3] - b.seq[3],
  );
}

export type CardState = "absent" | "active" | "suspended" | "dropped";

/** Replays one card (1.7, "Events and a card's state"): its state, and the reviews that count. */
export function replay(records: Rec[], card: string): { state: CardState; reviews: Flat[] } {
  let state: CardState = "absent";
  let reviews: Flat[] = [];
  for (const e of allEvents(records)) {
    if (e.card !== card) continue;
    const review = typeof e.what === "number" && Number.isInteger(e.what) && e.what >= 1 && e.what <= 4;
    if (review) reviews.push(e);
    if (e.what === "reset") reviews = [];
    else if (e.what === "add" || review) state = "active";
    else if (e.what === "suspend") state = state === "active" ? "suspended" : state;
    else if (e.what === "resume") state = state === "suspended" ? "active" : state;
    else if (e.what === "drop") state = state === "active" || state === "suspended" ? "dropped" : state;
  }
  return { state, reviews };
}

/**
 * Folds one device's closed buckets (by date, then part; one calendar year) into the next archive chunk.
 * `earlier` is that device-year's chunks so far. Throws when the chunk would pass 16 KiB.
 */
export function fold(buckets: Bucket[], earlier: Chunk[], updated: number): Chunk {
  const first = bucketRef(buckets[0].ref)!;
  const year = buckets[0].date.slice(0, 4);
  const table = earlier.flatMap((c) => c.cards);
  const index = new Map(table.map((k, i) => [k, i]));
  const cards: string[] = [];
  const cols: string[] = [];
  const days: Day[] = [];
  for (const b of buckets) {
    const at = bucketRef(b.ref)!;
    if (at.device !== first.device || b.date.slice(0, 4) !== year) throw new Error("one device, one year");
    let day = days.at(-1);
    if (!day || day[0] !== b.date) {
      if (!b.events.length) continue;
      day = [b.date, b.tz ?? null, b.events[0][1], []];
      days.push(day);
    }
    let time = day[3].reduce((t, e) => t + e[1], day[2]);
    for (const e of b.events) {
      const key = b.cards[e[0]];
      if (!index.has(key)) {
        index.set(key, index.size);
        cards.push(key);
      }
      const values: unknown[] = [];
      (b.cols ?? []).forEach((name, i) => {
        const v = e[3 + i];
        if (v === undefined || v === null) return;
        if (!cols.includes(name)) cols.push(name);
        values[cols.indexOf(name)] = v;
      });
      for (let i = 0; i < values.length; i++) values[i] ??= null;
      day[3].push([index.get(key)!, e[1] - time, e[2], ...values]);
      time = e[1];
    }
  }
  const chunk: Chunk = {
    kind: "srs-archive",
    ref: `${first.device}/${year}/${earlier.length + 1}`,
    v: 1,
    updated,
    ...(buckets[0].client ? { client: buckets[0].client } : {}),
    base: table.length,
    cards,
    ...(cols.length ? { cols } : {}),
    days,
  };
  if (jsonBytes(chunk) > LIMIT) throw new Error("chunk too large");
  return chunk;
}

const b64 = (s: string) => createHash("sha256").update(s).digest("base64url");
/** A deterministic block id (1.3). */
export const blockId = (source: string) => `b_${b64(source).slice(0, 22)}`;
/** The rank an import gives the k-th child (from 0) of a parent (docs/notes-import.md). */
export const importRank = (k: number) => `a${String(k).padStart(5, "0")}V`;

export interface MarginNote {
  slug: string;
  passage: string;
  created_at: string;
  updated_at: string;
  blocks: { id: string; text: string; indent: number }[];
}

/** A Margin note as vault blocks (docs/notes-import.md): the same records on every device. */
export function importMargin(note: MarginNote): Rec[] {
  const seconds = (iso: string) => Math.floor(Date.parse(iso) / 1000);
  const root = blockId(`margin-note:${note.slug}`);
  const common = { v: 1, updated: seconds(note.updated_at), created: seconds(note.created_at), outline: root };
  const out: Rec[] = [{ kind: "block", ref: root, ...common, parent: null, rank: "a1", text: "", passage: note.passage }];
  const stack: { ref: string; indent: number }[] = [];
  const children = new Map<string, number>();
  for (const b of note.blocks) {
    while (stack.length && stack.at(-1)!.indent >= b.indent) stack.pop();
    const parent = stack.at(-1)?.ref ?? root;
    const k = children.get(parent) ?? 0;
    children.set(parent, k + 1);
    const ref = blockId(`margin-block:${note.slug}:${b.id}`);
    out.push({ kind: "block", ref, ...common, parent, rank: importRank(k), text: b.text, passage: note.passage });
    stack.push({ ref, indent: b.indent });
  }
  return out;
}
