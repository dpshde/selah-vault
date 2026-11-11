import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
// @ts-ignore plain JS module from public/
import { recolorRecords, tombstone, tombstoneRecords } from "../public/ranges.js";

const read = (p: string) => readFileSync(new URL(`../public/${p}`, import.meta.url), "utf8");
const app = read("app.js");
const css = read("style.css");
const html = read("index.html");

test("recolorRecords matches a row color picker write for every record", () => {
  const records = [
    { kind: "highlight", ref: "JHN.3.16", highlights: [{ color: "yellow", created: 1, quote: "For God" }] },
    {
      kind: "highlight",
      ref: "JHN.3.17",
      highlights: [
        { color: "yellow", created: 1 },
        { color: "green", edited: 2 },
      ],
    },
  ];
  const next = recolorRecords(records, "blue", 99);
  expect(next).toHaveLength(2);
  expect(next[0].highlights).toEqual([{ color: "blue", created: 1, quote: "For God", edited: 99 }]);
  expect(next[1].highlights).toEqual([
    { color: "blue", created: 1, edited: 99 },
    { color: "blue", edited: 99 },
  ]);
  // Input records stay untouched so Undo can restore them.
  expect(records[0].highlights[0].color).toBe("yellow");
});

test("tombstoneRecords matches a row delete write for every record", () => {
  const records = [
    { kind: "highlight", ref: "ROM.5.3", highlights: [{ color: "yellow", created: 1 }] },
    { kind: "highlight", ref: "ROM.5.4", highlights: [{ color: "yellow", created: 1 }] },
  ];
  expect(tombstoneRecords(records)).toEqual([tombstone("ROM.5.3"), tombstone("ROM.5.4")]);
});

test("list-bar has select toggle + selection toolbar (color + delete only)", () => {
  expect(html).toContain('id="select-toggle"');
  expect(html).toContain('id="selection-bar"');
  expect(html).toContain('id="selection-done"');
  expect(html).toContain('id="selection-all"');
  expect(html).toContain('id="selection-color"');
  expect(html).toContain('id="selection-delete"');
  expect(html).toContain('id="selection-count"');
  // Locked scope: no batch tags / notes / move / export chrome.
  expect(html).not.toContain("selection-tag");
  expect(html).not.toContain("selection-note");
  expect(html).not.toContain("selection-export");
  expect(html).not.toContain("selection-move");
});

test("app wires selection mode through existing putMany color/delete helpers", () => {
  expect(app).toContain("function enterSelectMode");
  expect(app).toContain("function exitSelectMode");
  expect(app).toContain("function selectAllVisible");
  expect(app).toContain("function batchRecolorSelected");
  expect(app).toContain("function batchDeleteSelected");
  expect(app).toContain("recolorRecords(records, id, t)");
  expect(app).toContain("recolorRecords(records, colorId, t)");
  expect(app).toContain("tombstoneRecords(records)");
  expect(app).toContain("armDelete(delBtn, {");
  expect(app).toMatch(/flash\(`Deleted \$\{n\} \$\{n === 1 \? "highlight" : "highlights"\}\.`/);
  expect(app).toContain("exitSelectMode({ render: false })");
  expect(app).toContain("toggleRunSelected(runRef)");
  expect(app).toContain('line.dataset.selecting = "1"');
  expect(app).toContain('className = "row-check"');
  expect(app).toContain("closeOmniCard()");
  expect(app).not.toContain("closeTopicSearch");
});

test("selection chrome matches house list-bar density", () => {
  expect(css).toContain(".select-toggle");
  expect(css).toContain(".selection-bar");
  expect(css).toContain(".selection-done");
  expect(css).toContain(".row-check");
  expect(css).toContain('#list .rows .row[data-selected="1"]');
  expect(css).toContain('.list-bar[data-selecting="true"] .segmented');
  expect(css).toMatch(/@media \(max-width: 600px\)[\s\S]*?\.select-toggle \{[\s\S]*?min-height: 40px/);
});

test("omni card Highlight and Related are icon buttons with labels", () => {
  expect(html).toContain('id="omni-card-highlight"');
  expect(html).toContain('id="omni-card-related"');
  expect(html).toContain('aria-label="Highlight"');
  expect(html).toContain('aria-label="Related"');
  expect(html).toContain('id="omni-card-close"');
  expect(html).not.toContain(">Highlight</button>");
  expect(html).not.toContain(">Related</button>");
  expect(css).toMatch(/@media \(max-width: 600px\)[\s\S]*?\.omni-card-actions \.icon[\s\S]*?min-height: 44px/);
});
