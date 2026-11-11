// How the highlight list is grouped: by when verses were highlighted, or by the Bible's genres. Pure
// functions, so the app and its tests share them. Runs (groupRuns) form inside a group, never across.

import { BOOKS, compareRefs, splitRef } from "./refs.js";
import { groupRuns, recordTime, runTime } from "./ranges.js";

export { recordTime, runTime };

export const MODES = ["date", "genre"];
export const GROUP_MODES = ["date", "genre"];
/** Passage-ranked modes (filter then sort). Topic search is orthogonal chrome in #list-bar, not a mode. */
export const RANK_MODES = []; // Related is an omni-card action, not a list mode.
/** Persisted `groupBy` from when Topic was a 5th mode; migrate to `date`. */
export const LEGACY_TOPIC_MODE = "topic";
/** Persisted modes before Relevant+Surprising merged into Related; migrate to `related`. */
export const LEGACY_RELATED_MODES = ["relevant", "surprising", "related"];
/** Any list mode that uses Jev passage ranking. Topic search uses Jev too, but is not a mode. */
export const JEV_MODES = [];

/** The Protestant canon's genres, each a span of books in canonical order (BOOKS indexes). */
export const GENRES = [
  { id: "law", name: "Law", first: "GEN", last: "DEU" },
  { id: "history", name: "History", first: "JOS", last: "EST" },
  { id: "wisdom", name: "Wisdom & Poetry", first: "JOB", last: "SNG" },
  { id: "major", name: "Major Prophets", first: "ISA", last: "DAN" },
  { id: "minor", name: "Minor Prophets", first: "HOS", last: "MAL" },
  { id: "gospels", name: "Gospels", first: "MAT", last: "JHN" },
  { id: "acts", name: "Acts", first: "ACT", last: "ACT" },
  { id: "pauline", name: "Pauline Letters", first: "ROM", last: "PHM" },
  { id: "general", name: "General Letters", first: "HEB", last: "JUD" },
  { id: "revelation", name: "Revelation", first: "REV", last: "REV" },
];

const INDEX = new Map(BOOKS.map(([code], i) => [code, i]));
const SPANS = GENRES.map((g) => ({ ...g, from: INDEX.get(g.first), to: INDEX.get(g.last) }));

/** The genre id of a USFM book code, or null for one outside the canon. */
export function genreOf(code) {
  const i = INDEX.get(code);
  return i === undefined ? null : SPANS.find((g) => i >= g.from && i <= g.to).id;
}

export const DATE_GROUPS = [
  { id: "today", name: "Today" },
  { id: "week", name: "Last 7 days" },
  { id: "older", name: "Older" },
];

/** Whether a group starts open: Today and Last 7 days do; the single Jev ranked group does; Older and every genre start closed. */
export const startsOpen = (mode, id) =>
  (mode === "date" && id !== "older") || id === "ranked";


/**
 * "today" from local midnight on, "week" for the six days before that (with today, the last 7
 * calendar days), else "older". `now` is a Date; days follow the local calendar, DST included.
 */
export function dateGroup(seconds, now = new Date()) {
  if (seconds === null || seconds === undefined) return "older";
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const weekStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6);
  const ms = seconds * 1000;
  if (ms >= midnight.getTime()) return "today";
  if (ms >= weekStart.getTime()) return "week";
  return "older";
}


/**
 * The list's groups, in order, without empty ones: [{ id, name, runs }]. `records` are live
 * highlights; `keyOf` is a record's color. Runs form exactly as in the plain list (groupRuns), then
 * each run goes in one group, so a run never spans two: a genre's books are contiguous, and a date
 * group goes by the run's newest verse. Date groups list the newest run first; genres, canonical order.
 */
export function groupList(records, mode, keyOf, now = new Date()) {
  const runs = groupRuns([...records].sort((a, b) => compareRefs(a.ref, b.ref)), keyOf);
  const defs = mode === "genre" ? GENRES : DATE_GROUPS;
  const of = mode === "genre"
    ? (run) => genreOf(splitRef(run.ref)?.code) ?? "revelation"
    : (run) => dateGroup(runTime(run), now);
  const buckets = new Map(defs.map((d) => [d.id, []]));
  runs.forEach((run, i) => buckets.get(of(run)).push({ run, i, t: runTime(run) ?? -Infinity }));
  return defs
    .map((d) => {
      const items = buckets.get(d.id);
      // Stable: runs made at the same moment stay in canonical order.
      if (mode === "date") items.sort((a, b) => b.t - a.t || a.i - b.i);
      return { id: d.id, name: d.name, runs: items.map((x) => x.run) };
    })
    .filter((g) => g.runs.length);
}
