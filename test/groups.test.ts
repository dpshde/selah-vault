import { expect, test } from "bun:test";
import { BOOKS } from "../public/refs.js";
import { GENRES, LEGACY_TOPIC_MODE, LEGACY_RELATED_MODES, MODES, JEV_MODES, dateGroup, genreOf, groupList, recordTime, runTime, startsOpen } from "../public/groups.js";

// Local midnight is what matters, so pin a zone with daylight saving time.
process.env.TZ = "America/New_York";

const secs = (d: Date) => Math.floor(d.getTime() / 1000);
// 3pm local on Tuesday, November 3, 2026: two days after US daylight saving time ended.
const NOW = new Date(2026, 10, 3, 15, 0, 0);

test("every one of the 66 books has its genre, in canonical order", () => {
  const expected: Record<string, string[]> = {
    law: ["GEN", "EXO", "LEV", "NUM", "DEU"],
    history: ["JOS", "JDG", "RUT", "1SA", "2SA", "1KI", "2KI", "1CH", "2CH", "EZR", "NEH", "EST"],
    wisdom: ["JOB", "PSA", "PRO", "ECC", "SNG"],
    major: ["ISA", "JER", "LAM", "EZK", "DAN"],
    minor: ["HOS", "JOL", "AMO", "OBA", "JON", "MIC", "NAM", "HAB", "ZEP", "HAG", "ZEC", "MAL"],
    gospels: ["MAT", "MRK", "LUK", "JHN"],
    acts: ["ACT"],
    pauline: ["ROM", "1CO", "2CO", "GAL", "EPH", "PHP", "COL", "1TH", "2TH", "1TI", "2TI", "TIT", "PHM"],
    general: ["HEB", "JAS", "1PE", "2PE", "1JN", "2JN", "3JN", "JUD"],
    revelation: ["REV"],
  };
  expect(Object.keys(expected)).toEqual(GENRES.map((g) => g.id));
  expect(Object.values(expected).flat()).toEqual(BOOKS.map(([code]: [string]) => code));
  for (const [genre, codes] of Object.entries(expected)) for (const code of codes) expect([code, genreOf(code)]).toEqual([code, genre]);
  expect(genreOf("TOB")).toBe(null);
  expect(GENRES.map((g) => g.name)).toEqual([
    "Law", "History", "Wisdom & Poetry", "Major Prophets", "Minor Prophets", "Gospels", "Acts", "Pauline Letters", "General Letters", "Revelation",
  ]);
});

test("date groups split at local midnight: today, the six days before, older", () => {
  const midnight = new Date(2026, 10, 3, 0, 0, 0);
  expect(dateGroup(secs(NOW), NOW)).toBe("today");
  expect(dateGroup(secs(midnight), NOW)).toBe("today");
  expect(dateGroup(secs(midnight) - 1, NOW)).toBe("week");
  // Six calendar days back is October 28, still daylight time: its midnight is 4am UTC, not 5am.
  const weekStart = new Date(2026, 9, 28, 0, 0, 0);
  expect(weekStart.getTimezoneOffset()).not.toBe(NOW.getTimezoneOffset()); // the DST case is real here
  expect(dateGroup(secs(weekStart), NOW)).toBe("week");
  expect(dateGroup(secs(weekStart) - 1, NOW)).toBe("older");
  expect(dateGroup(null, NOW)).toBe("older");
  // Just after midnight, yesterday evening is already "Last 7 days".
  const early = new Date(2026, 10, 4, 0, 5);
  expect(dateGroup(secs(new Date(2026, 10, 3, 23, 50)), early)).toBe("week");
});

test("a record's time is its newest part's created, else updated, else none", () => {
  expect(recordTime({ highlights: [{ created: 5 }, { created: 9 }], updated: 20 })).toBe(9);
  expect(recordTime({ highlights: [{ color: "blue" }], updated: 20 })).toBe(20);
  expect(recordTime({ highlights: [{ color: "blue" }] })).toBe(null);
  expect(runTime({ records: [{ highlights: [{ created: 3 }] }, { highlights: [{ created: 7 }] }] })).toBe(7);
});

const at = (ref: string, when: Date | null, color = "yellow") => ({ kind: "highlight", ref, highlights: [{ color, ...(when ? { created: secs(when) } : {}) }] });
const shape = (groups: Array<{ id: string; runs: Array<{ ref: string }> }>) => groups.map((g) => [g.id, g.runs.map((r) => r.ref)]);
const color = (r: { highlights: Array<{ color: string }> }) => r.highlights[0].color;

test("by date: runs form as in the plain list, go by their newest verse, newest first, empty groups hidden", () => {
  const today = new Date(2026, 10, 3, 9);
  const later = new Date(2026, 10, 3, 14);
  const lastWeek = new Date(2026, 9, 30, 12);
  const records = [
    at("ROM.5.3", lastWeek), at("ROM.5.4", today), at("ROM.5.5", lastWeek), // one run, as new as 5:4
    at("JHN.3.16", later),
    at("GEN.1.1", lastWeek),
    at("PSA.23.1", null), // no times: Older
  ];
  expect(shape(groupList(records, "date", color, NOW))).toEqual([
    ["today", ["JHN.3.16", "ROM.5.3-5"]],
    ["week", ["GEN.1.1"]],
    ["older", ["PSA.23.1"]],
  ]);
  expect(shape(groupList([at("GEN.1.1", lastWeek)], "date", color, NOW))).toEqual([["week", ["GEN.1.1"]]]);
});

test("by genre: canonical order inside each genre, runs within it, empty genres hidden", () => {
  const t = new Date(2026, 10, 1);
  const records = [at("REV.22.21", t), at("ROM.8.28", t), at("ROM.5.3", t), at("ROM.5.4", t), at("ROM.5.5", t, "blue"), at("GEN.1.1", t), at("ACT.2.1", t), at("1CO.13.4", t)];
  expect(shape(groupList(records, "genre", color, NOW))).toEqual([
    ["law", ["GEN.1.1"]],
    ["acts", ["ACT.2.1"]],
    ["pauline", ["ROM.5.3-4", "ROM.5.5", "ROM.8.28", "1CO.13.4"]],
    ["revelation", ["REV.22.21"]],
  ]);
});

test("modes are Date · Genre; legacy topic, Relevant/Surprising, and Related migrate off the strip", () => {
  expect(MODES).toEqual(["date", "genre"]);
  expect(MODES).not.toContain("topic");
  expect(MODES).not.toContain("relevant");
  expect(MODES).not.toContain("surprising");
  expect(MODES).not.toContain("related");
  expect(JEV_MODES).toEqual([]);
  expect(LEGACY_TOPIC_MODE).toBe("topic");
  expect(LEGACY_RELATED_MODES).toEqual(["relevant", "surprising", "related"]);
});

test("Today and Last 7 days start open; Older and every genre start closed; Jev ranked group starts open", () => {
  expect(startsOpen("date", "today")).toBe(true);
  expect(startsOpen("date", "week")).toBe(true);
  expect(startsOpen("date", "older")).toBe(false);
  for (const g of GENRES) expect(startsOpen("genre", g.id)).toBe(false);
  expect(startsOpen("related", "ranked")).toBe(true);
  // Topic and Related results reuse the ranked group id on top of Date/Genre.
  expect(startsOpen("date", "ranked")).toBe(true);
});
