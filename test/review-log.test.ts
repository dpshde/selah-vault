// SPEC.md 1.3 and 1.7 against the test-side reference (test/review-log.ts) and the client fixtures.
// Nothing here writes the new kinds to a library: it checks the rules, the examples and the budget.
import { describe, expect, test } from "bun:test";
import fixtures from "../conformance/fixtures.json";
import { LIMIT, allEvents, blobChars, blockId, fold, importMargin, importRank, jsonBytes, replay, type Bucket, type Chunk, type MarginNote } from "./review-log";

type Rec = Record<string, unknown>;

describe("deterministic blocks (1.3)", () => {
  for (const v of fixtures.blockIds) test(`id of ${v.source}`, () => expect(blockId(v.source)).toBe(v.ref));

  for (const c of fixtures.marginImport) {
    test(`Margin import: ${c.name}`, () => {
      const records = importMargin(c.note as MarginNote);
      expect(records).toEqual(c.records);
      // Any device, any number of times: the same bytes, so the merge rule has nothing to decide.
      expect(JSON.stringify(importMargin(structuredClone(c.note) as MarginNote))).toBe(JSON.stringify(records));
    });
  }

  test("import ranks sort in order, never end in 0, and leave room between", () => {
    const ranks = Array.from({ length: 1200 }, (_, k) => importRank(k));
    expect([...ranks].sort()).toEqual(ranks);
    for (const r of ranks) expect(r).toMatch(/^[0-9A-Za-z]{1,128}$/);
    expect(ranks.some((r) => r.endsWith("0"))).toBe(false);
    expect("a00000V" < "a00000k" && "a00000k" < "a00001V").toBe(true);
  });
});

describe("review log replay (1.7)", () => {
  for (const c of fixtures.reviewLog.replay) {
    test(c.name, () => {
      const r = replay(c.records as Rec[], c.card);
      expect(r.state).toBe(c.state as typeof r.state);
      expect(r.reviews.map((e) => [e.time, e.what, e.device, e.cols])).toEqual(c.reviews as unknown[]);
    });
  }

  test("the order records arrive in doesn't change the result", () => {
    for (const c of fixtures.reviewLog.replay) {
      const a = replay(c.records as Rec[], c.card);
      const b = replay([...(c.records as Rec[])].reverse(), c.card);
      expect(b).toEqual(a);
    }
  });
});

describe("yearly archive (1.7)", () => {
  const view = (records: Rec[]) => allEvents(records).map((e) => [e.card, e.time, e.what, e.cols, e.device, e.date, e.tz]);

  for (const c of fixtures.reviewLog.fold) {
    test(c.name, () => {
      const chunk = fold(c.buckets as Bucket[], c.earlier as Chunk[], c.updated);
      expect(chunk).toEqual(c.chunk as Chunk);
      // Folding loses nothing: the chunks read back as the buckets did.
      expect(view([...(c.earlier as Rec[]), chunk])).toEqual(view([...(c.earlier as Rec[]), ...(c.buckets as Rec[])]));
    });
  }

  /** A year of one device's reviews: `perDay` a day, drawn from `passages` passages in `units`. */
  function year(perDay: number, passages: number, units: string[], cols: boolean): Bucket[] {
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const books = ["JHN", "ROM", "PSA", "1CO", "EPH", "GEN", "MAT", "ISA"];
    const keys: string[] = [];
    for (let i = 0; i < passages; i++) {
      const v = 1 + Math.floor(rnd() * 38);
      const ref = `${books[Math.floor(rnd() * books.length)]}.${1 + Math.floor(rnd() * 50)}.${rnd() < 0.3 ? `${v}-${v + 1 + Math.floor(rnd() * 3)}` : v}`;
      for (const u of units) keys.push(`${ref}#${u}`);
    }
    return Array.from({ length: 365 }, (_, d) => {
      const cards: string[] = [];
      const events: Bucket["events"] = [];
      let t = Date.UTC(2027, 0, 1 + d, 13) / 1000;
      for (let i = 0; i < perDay; i++) {
        const k = keys[Math.floor(rnd() * keys.length)];
        if (!cards.includes(k)) cards.push(k);
        t += 5 + Math.floor(rnd() * 60);
        events.push(cols && k.endsWith("#text") ? [cards.indexOf(k), t, 1 + Math.floor(rnd() * 4), "R2b", Math.floor(rnd() * 2)] : [cards.indexOf(k), t, 1 + Math.floor(rnd() * 4)]);
      }
      const date = new Date(Date.UTC(2027, 0, 1 + d)).toISOString().slice(0, 10);
      return { kind: "srs-log", ref: `q8Zr0aXv5Tg/${1 + (d % 40)}`, v: 1, updated: t, date, client: "proofs-web", tz: -360, cards, ...(cols ? { cols: ["x-proofs-rung", "x-proofs-hints"] } : {}), events } as Bucket;
    });
  }

  /** Folds a year greedily: each chunk takes as many whole days as fit in 16 KiB. */
  function foldYear(buckets: Bucket[]): Chunk[] {
    const chunks: Chunk[] = [];
    for (let i = 0; i < buckets.length; ) {
      let n = 0;
      let best: Chunk | null = null;
      while (i + n < buckets.length) {
        try {
          best = fold(buckets.slice(i, i + n + 1), chunks, 1);
          n++;
        } catch {
          break;
        }
      }
      if (!best) throw new Error("a single day doesn't fit a chunk");
      chunks.push(best);
      i += n;
    }
    return chunks;
  }

  // The figures in SPEC.md 1.7, "Budget". If these move, the spec's numbers move with them.
  const budget: [string, number, string[], boolean, [number, number], [number, number]][] = [
    ["50 a day, two units, no columns", 50, ["text", "ref"], false, [2_600, 2_900], [280_000, 330_000]],
    ["50 a day, two units, two columns on text reviews", 50, ["text", "ref"], true, [2_900, 3_300], [370_000, 440_000]],
    ["150 a day, three units, no columns", 150, ["text", "ref", "x-proofs-initials"], false, [7_800, 8_500], [820_000, 950_000]],
    ["150 a day, three units, two columns on text reviews", 150, ["text", "ref", "x-proofs-initials"], true, [8_300, 9_000], [1_000_000, 1_140_000]],
  ];
  for (const [name, perDay, units, cols, dayRange, yearRange] of budget) {
    test(`budget: ${name}`, () => {
      const buckets = year(perDay, 500, units, cols);
      const perDayChars = buckets.reduce((n, b) => n + blobChars(b), 0) / 365;
      expect(perDayChars).toBeGreaterThan(dayRange[0]);
      expect(perDayChars).toBeLessThan(dayRange[1]);

      const chunks = foldYear(buckets);
      for (const c of chunks) expect(jsonBytes(c)).toBeLessThanOrEqual(LIMIT);
      const archived = chunks.reduce((n, c) => n + blobChars(c), 0);
      expect(archived).toBeGreaterThan(yearRange[0]);
      expect(archived).toBeLessThan(yearRange[1]);
      // A year folded is the same year.
      expect(view(chunks)).toEqual(view(buckets));
      // Folded buckets left behind, as after a restore from an old backup, change nothing.
      expect(view([...chunks, ...buckets.slice(0, 30)])).toEqual(view(buckets));
    });
  }
});
