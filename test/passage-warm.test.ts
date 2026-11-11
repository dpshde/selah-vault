import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
// @ts-ignore plain JS module from public/
import { keepLoadedOnMove, createWarmer, defineKeepingLoaded } from "../public/passage-warm.js";

test("a passage that already shows its text doesn't reload (or show its spinner) when moved", () => {
  let reloads = 0;
  class Passage {
    loaded: any = null; attrs: Record<string, string> = { "passage-id": "HAB.2.14" };
    systemDark = { addEventListener() {} }; onSystemTheme = () => {}; themed = 0;
    getAttribute(k: string) { return this.attrs[k]; }
    applyTheme() { this.themed++; }
    connectedCallback() { reloads++; }
  }
  keepLoadedOnMove(Passage);
  keepLoadedOnMove(Passage); // idempotent
  const p = new Passage();
  p.connectedCallback(); // first time in the page: loads
  p.loaded = { passageId: "HAB.2.14" };
  p.connectedCallback(); // moved under its row: keeps its text
  expect(reloads).toBe(1);
  expect(p.themed).toBe(1);
  p.attrs["passage-id"] = "JHN.3.16";
  p.connectedCallback(); // a different passage: loads
  expect(reloads).toBe(2);
});

test("the warmer loads every ref once, at most two at a time, only when idle, hovered refs first", async () => {
  const started: string[] = [], waits: Array<() => void> = [];
  let peak = 0, live = 0;
  const idles: Array<() => void> = [];
  const w = createWarmer(
    (ref: string) => { started.push(ref); live++; peak = Math.max(peak, live); return new Promise<void>((r) => waits.push(() => { live--; r(); })); },
    { idle: (f: () => void) => idles.push(f), sleep: () => Promise.resolve() },
  );
  for (const r of ["A", "B", "C", "D", "A"]) w.add(r);
  w.first("D");
  expect(started).toEqual([]); // nothing until the page is idle
  idles.shift()!();
  expect(started).toEqual(["D", "A"]);
  waits.shift()!(); waits.shift()!();
  await new Promise((r) => setTimeout(r, 0));
  while (idles.length) idles.shift()!();
  expect(started).toEqual(["D", "A", "B", "C"]);
  expect(peak).toBeLessThanOrEqual(2);
  expect(w.waiting).toBe(0);
});

test("a failing load doesn't stop the rest", async () => {
  const started: string[] = [];
  const w = createWarmer((ref: string) => { started.push(ref); return Promise.reject(new Error("429")); }, { idle: (f: () => void) => f(), sleep: () => Promise.resolve(), concurrency: 1 });
  w.add("A"); w.add("B");
  await new Promise((r) => setTimeout(r, 10));
  expect(started).toEqual(["A", "B"]);
});

test("the app wires it up, and the spinner only appears after 300ms", () => {
  const read = (p: string) => readFileSync(new URL(`../public/${p}`, import.meta.url), "utf8");
  const app = read("app.js"), css = read("style.css");
  expect(app).toContain("defineKeepingLoaded(() => defineScripturePassage({ yvpPublicAppKey }))");
  expect(app).toContain("warmer.add(runRef)");
  expect(app).toContain("toggle.addEventListener(\"pointerenter\", warm)");
  expect(css).toContain("si-passage::part(loader) { visibility: hidden; animation: si-loader-late 0s linear .3s forwards; }");
});

test("expand waits for scripture-load: skeleton then fade-in; reduced-motion skips fade", () => {
  const read = (p: string) => readFileSync(new URL(`../public/${p}`, import.meta.url), "utf8");
  const app = read("app.js"), css = read("style.css");
  expect(app).toContain("function showText(li, runRef)");
  expect(app).toContain("function verseTextSkeleton");
  expect(app).toContain("function clearOpenVerseText");
  expect(app).toContain("passageReady(el)");
  expect(app).toContain("verse-text-skel");
  expect(app).toContain("verse-text-enter");
  expect(app).toContain('el.addEventListener("scripture-load", onReady, { once: true })');
  expect(app).toContain('el.addEventListener("scripture-error"');
  expect(app).toContain('matchMedia("(prefers-reduced-motion: reduce)")');
  expect(css).toContain(".verse-text-skel");
  expect(css).toMatch(/\.verse-text-skel\s*\{[^}]*min-height:\s*6rem/);
  expect(css).toContain(".verse-text.verse-text-enter");
  expect(css).toContain("verse-text-in");
  expect(css).toMatch(/prefers-reduced-motion: reduce[\s\S]*?\.verse-text\.verse-text-enter/);
  expect(app).toContain("const widths = [92, 88, 84, 78, 70, 38]");
});

test("the keep-loaded patch is applied before <si-passage> is defined (callbacks are read at define time)", () => {
  const defined: Array<[string, any]> = [];
  const registry = { define(name: string, cls: any) { defined.push([name, cls]); } };
  class Passage { connectedCallback() {} }
  class Other { connectedCallback() {} }
  defineKeepingLoaded(() => { registry.define("si-passage", Passage); registry.define("si-other", Other); }, registry as any);
  expect((Passage.prototype as any).__keepsLoaded).toBe(true);
  expect((Other.prototype as any).__keepsLoaded).toBeUndefined();
  expect(defined.map(([n]) => n)).toEqual(["si-passage", "si-other"]);
  expect(registry.define.name).toBe("define"); // put back
});

test("a refocus sync with nothing new doesn't rebuild the list (which would move and re-animate the open passage)", () => {
  const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  // Expand/collapse must not remount the list — verseText.open stays out of listSig.
  expect(app).toContain("const sig = JSON.stringify([shown, colors, groupBy, relatedSort, [...filter], verseText.key, editing, ranking && scopeKey, rankOrder, rankFailed, noneRelevant, !!rankPending, jevWaiting, relatedDrafting, topicDrafting, searching, rankPaint, selecting, [...selected]]);");
  expect(app).not.toMatch(/JSON\.stringify\(\[[^\]]*verseText\.open/);
  expect(app).toMatch(/if \(!editing && sig !== listSig\) \{[\s\S]*?\$\("#list"\)\.replaceChildren/);
  expect(app).toContain("listSig = null; // the edit changes the row by hand");
  expect(app).toContain("if (passageReady(el) && el.parentElement === li && !li.querySelector(\".verse-text-skel\")) return;");
});
