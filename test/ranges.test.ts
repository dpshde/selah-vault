import { describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { highlightRecord, listRanges, newestFirst, stamp, tombstone } from "../public/ranges.js";
import { Library, memoryStore } from "../public/sync.js";

const vectors = JSON.parse(readFileSync(new URL("./ranges-vectors.json", import.meta.url), "utf8"));
const view = (runs: any[]) => runs.map(({ ref, verses, color, time }) => ({ ref, verses, color, time }));

describe("ranges: the one rule (test/ranges-vectors.json, shared with route.bible)", () => {
  for (const [name, c] of Object.entries<any>(vectors.ranges)) {
    it(name, () => {
      const runs = listRanges(c.records);
      expect(view(runs)).toEqual(c.canonical);
      expect(view(newestFirst(runs))).toEqual(c.newestFirst);
    });
  }
  for (const w of vectors.writes) {
    it(`write: ${w.name}`, () => {
      const live = w.prev && !w.prev.deleted ? w.prev : null;
      const record = w.delete ? tombstone(w.ref) : highlightRecord(live, w.ref, w.color, w.t);
      expect(JSON.stringify(stamp(record, w.prev?.updated, w.t))).toBe(w.expect);
    });
  }
  it("the vectors file is what the generator writes", () => {
    const before = readFileSync(new URL("./ranges-vectors.json", import.meta.url), "utf8");
    execFileSync("node", [new URL("../scripts/ranges-vectors.mjs", import.meta.url).pathname]);
    expect(readFileSync(new URL("./ranges-vectors.json", import.meta.url), "utf8")).toBe(before);
  });
  it("Library.putMany writes the same record text as the vectors (the app's own path)", async () => {
    const lib = await Library.open({ store: memoryStore() });
    const t = Math.floor(Date.now() / 1000);
    await lib.putMany([highlightRecord(null, "JHN.3.16", "yellow", t)]);
    const r = lib.find("highlight", "JHN.3.16");
    expect(JSON.stringify(r)).toBe(JSON.stringify(stamp(highlightRecord(null, "JHN.3.16", "yellow", t), undefined, r.updated)));
  });
});
