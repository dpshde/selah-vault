// How highlight records become the ranges people see, and the records a highlight edit writes.
// The one definition: the vault's list, its WebMCP tools, the remote MCP server and route.bible
// (which vendors this file and checks it against test/ranges-vectors.json) all use it.
//
// Rules:
// - Storage is one record per verse. A range ("run") is back-to-back single verses, in one chapter
//   of one book, that share a color. A gap, a new chapter, or a different color starts a new run, so
//   John 3:16 yellow + 3:17 green are two rows (each row has one color, which its picker edits).
// - A record's color is its newest highlight part's color (topColor); unknown ids read as yellow.
// - A run's time is its newest verse's time (runTime); newest-first lists sort by it, ties keeping
//   canonical order.
// - Deleting is a tombstone per verse ({ kind, ref, deleted: true }). Tombstoned verses aren't live,
//   so a run loses them: deleting a run's middle verse splits it, an end verse shrinks it.
// - A write is stamped like Library.putMany: updated = max(now, the replaced version's updated + 1).
// - A range write ("ROM.5.3-5" in one color) is the reverse of grouping: expandRange gives its
//   verses, rangeWrites the records to save, all in one putMany so they reach a server in one POST
//   (all or none). At most MAX_RANGE_VERSES verses, one POST's worth. A verse already that color,
//   whole, is left alone, so repeating a write changes nothing; any other verse takes the color as
//   highlightRecord does for one verse.
// - The server never sees refs or colors (they're encrypted), so ranges exist only here, on clients.
import { compareRefs, splitRef } from "./refs.js";

export const COLORS = ["yellow", "green", "blue", "pink", "purple", "orange"];

/** The color a highlight record shows as: its most recently colored part's, or yellow when unknown. */
export function topColor(record, known = COLORS) {
  let best = record.highlights?.[0];
  for (const h of record.highlights ?? []) if ((h.edited ?? h.created ?? 0) >= (best.edited ?? best.created ?? 0)) best = h;
  return known.includes(best?.color) ? best.color : "yellow";
}

/**
 * When a record was made, in Unix seconds: its newest part's `created`, else its `updated`, else null
 * (a record with no times, which goes in Older).
 */
export function recordTime(record) {
  const created = (record.highlights ?? []).map((h) => h.created).filter(Number.isSafeInteger);
  if (created.length) return Math.max(...created);
  return Number.isSafeInteger(record.updated) ? record.updated : null;
}

/** When a run was made: its newest verse's time, or null when none of its verses has one. */
export function runTime(run) {
  const times = run.records.map(recordTime).filter((t) => t !== null);
  return times.length ? Math.max(...times) : null;
}

/**
 * Groups sorted records into runs of back-to-back single verses in one chapter that share a key
 * (their color), so Romans 5:3, 5:4 and 5:5 read as Romans 5:3–5. Storage stays one record per
 * verse; this is only how the list shows them. Returns [{ ref, records }], ref being the run's label ref.
 */
export function groupRuns(records, keyOf) {
  const runs = [];
  for (const record of records) {
    const r = splitRef(record.ref);
    const last = runs.at(-1);
    const prev = last && splitRef(last.records.at(-1).ref);
    const joins =
      r && prev && r.verse !== null && r.end === null && prev.verse !== null && prev.end === null &&
      r.book === prev.book && r.chapter === prev.chapter && r.verse === prev.verse + 1 &&
      keyOf(record) === last.key;
    if (joins) last.records.push(record);
    else runs.push({ key: keyOf(record), records: [record] });
  }
  return runs.map(({ records: rs }) => {
    if (rs.length === 1) return { ref: rs[0].ref, records: rs };
    const first = splitRef(rs[0].ref);
    return { ref: `${first.code}.${first.chapter}.${first.verse}-${first.verse + rs.length - 1}`, records: rs };
  });
}

/**
 * A verse highlighted in one color, as the add form saves it. A verse already highlighted (`prev`)
 * keeps its other fields and when it was first highlighted; the color counts as an edit.
 */
export function highlightRecord(prev, ref, color, t) {
  const created = prev?.highlights?.length ? Math.min(...prev.highlights.map((h) => h.created ?? t)) : t;
  const part = created === t ? { color, created } : { color, created, edited: t };
  return { ...(prev ?? {}), kind: "highlight", ref, highlights: [part] };
}

/**
 * The records that turn a row's run into a new set of verses, for one putMany. Verses in both stay
 * untouched (left out); verses only in the run are tombstoned, like deleting them; verses only in
 * the new set are highlighted in the run's color. `find(ref)` gives any live record for a verse.
 */
export function editRun(records, verses, color, t, find = () => null) {
  const old = new Set(records.map((r) => r.ref));
  const next = new Set(verses);
  return [
    ...records.filter((r) => !next.has(r.ref)).map((r) => tombstone(r.ref)),
    ...[...next].filter((v) => !old.has(v)).map((v) => highlightRecord(find(v), v, color, t)),
  ];
}

/** Most verses one range write may cover: one POST (SPEC 5.4), so the server takes all of them or none. */
export const MAX_RANGE_VERSES = 100;

/**
 * A canonical verse or same-chapter range ("ROM.5.3-5", "JHN.3.16") → { ref, verses }, or { error }.
 * `verseCount(code, chapter)`, when given, refuses verses past the chapter's end.
 * @param {string} ref
 * @param {{ max?: number, verseCount?: (code: string, chapter: number) => number }} [options]
 */
export function expandRange(ref, { max = MAX_RANGE_VERSES, verseCount } = {}) {
  const text = String(ref ?? "");
  const r = splitRef(text);
  if (!r) {
    const m = /^[1-3A-Z][A-Z0-9]{2}\.\d+\.(\d+)-(\d+)$/.exec(text);
    if (m && Number(m[2]) < Number(m[1])) return { error: "the range runs backwards: its end is before its start" };
    if (m && m[1] === m[2]) return { error: "a single verse is written without a range, like ROM.5.3" };
    if (/^[^.]+\.\d+\.\d+-.*\./.test(text)) return { error: "a range stays in one chapter, like ROM.5.3-5" };
    return { error: "not a canonical reference (like ROM.5.3-5)" };
  }
  if (r.verse === null) return { error: "give verses, like ROM.5.3-5, not a whole chapter" };
  const last = r.end ?? r.verse;
  if (last - r.verse + 1 > max) return { error: `at most ${max} verses in one range` };
  if (verseCount && last > verseCount(r.code, r.chapter)) return { error: "past the end of the chapter" };
  const verses = [];
  for (let v = r.verse; v <= last; v++) verses.push(`${r.code}.${r.chapter}.${v}`);
  return { ref: verses.length === 1 ? verses[0] : `${r.code}.${r.chapter}.${r.verse}-${last}`, verses };
}

/** Whether a record already shows as `color` over its whole verse, so highlighting it again changes nothing. */
export function alreadyHighlighted(record, color) {
  const parts = record?.deleted ? [] : (record?.highlights ?? []);
  return parts.length === 1 && parts[0].color === color && !parts[0].start && parts[0].end === undefined;
}

/**
 * The records that highlight `verses` in `color`, for one putMany: verses already that color are left
 * out (idempotent); others keep when they were first highlighted (highlightRecord). `find(ref)` gives
 * a verse's live record.
 * @param {string[]} verses
 * @param {string} color
 * @param {number} t
 * @param {(ref: string) => any} [find]
 */
export function highlightWrites(verses, color, t, find = () => null) {
  return verses.flatMap((v) => {
    const prev = find(v);
    return alreadyHighlighted(prev, color) ? [] : [highlightRecord(prev, v, color, t)];
  });
}

/**
 * A range write: { ref, verses, records } with records for one putMany, or { error }.
 * @param {string} ref
 * @param {string} color
 * @param {number} t
 * @param {(ref: string) => any} [find]
 * @param {{ max?: number, verseCount?: (code: string, chapter: number) => number }} [options]
 */
export function rangeWrites(ref, color, t, find = () => null, options = {}) {
  if (typeof color !== "string" || !color) return { error: "a color id is required" };
  const range = expandRange(ref, options);
  if (range.error) return range;
  return { ...range, records: highlightWrites(range.verses, color, t, find) };
}

/** Runs as a grouped read returns them: [{ ref, verses, color, time }], verses being each member's ref. */
export function rangeView(runs) {
  return runs.map(({ ref, verses, color, time }) => ({ ref, verses, color, time }));
}

/** A verse's deletion, as the vault writes it. */
export function tombstone(ref) {
  return { kind: "highlight", ref, deleted: true };
}

/**
 * Recolor every highlight part on each record — same write shape as a row's color picker.
 * Batch color change is one putMany of these records.
 */
export function recolorRecords(records, color, t) {
  return records.map((r) => ({
    ...r,
    highlights: (r.highlights ?? []).map((h) => ({ ...h, color, edited: t })),
  }));
}

/**
 * Tombstones for each record's ref — same write shape as a row's delete.
 * Batch delete is one putMany of these; Undo restores the prior live records.
 */
export function tombstoneRecords(records) {
  return records.map((r) => tombstone(r.ref));
}

/** The version a device writes: `record` stamped one second past `prevUpdated` when its clock is behind. */
export function stamp(record, prevUpdated, t) {
  return { ...record, updated: Math.max(t, (prevUpdated ?? 0) + 1) };
}

/** Live single-verse highlight records only (no tombstones, no other kinds). */
export function liveHighlights(records) {
  return records.filter((r) => r && r.kind === "highlight" && r.deleted !== true && splitRef(r.ref)?.verse != null);
}

/**
 * Records (any kinds, tombstones included) → runs in canonical order:
 * [{ ref, verses, color, time, records }]. `known` is the library's color ids.
 */
export function listRanges(records, known = COLORS) {
  const live = liveHighlights(records).sort((a, b) => compareRefs(a.ref, b.ref));
  return groupRuns(live, (r) => topColor(r, known)).map((run) => ({
    ref: run.ref,
    verses: run.records.map((r) => r.ref),
    color: topColor(run.records[0], known),
    time: runTime(run),
    records: run.records,
  }));
}

/** Runs newest first by time; equal times keep their order (canonical). */
export function newestFirst(runs) {
  return runs
    .map((run, i) => ({ run, i, t: run.time ?? runTime(run) ?? -Infinity }))
    .sort((a, b) => b.t - a.t || a.i - b.i)
    .map((x) => x.run);
}
