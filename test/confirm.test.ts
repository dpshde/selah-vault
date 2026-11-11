import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
// @ts-ignore plain JS module from public/
import { armDelete } from "../public/confirm.js";

class FakeButton extends EventTarget {
  dataset: Record<string, string> = {};
  attrs: Record<string, string> = {};
  innerHTML = "<svg/>";
  title = "";
  set textContent(t: string) { this.innerHTML = t; }
  setAttribute(k: string, v: string) { this.attrs[k] = v; }
  contains(n: unknown) { return n === this; }
  click() { this.dispatchEvent(new Event("click")); }
}

function setup(ms = 3000) {
  const button = new FakeButton(), doc = new EventTarget(), win = new EventTarget();
  let t = 1000, deleted = 0;
  const ctl = armDelete(button, { label: "Habakkuk 2:14", idleHTML: "<svg/>", onConfirm: () => deleted++, ms, doc, win, clock: () => t });
  const outside = (target: unknown, type = "pointerdown") => { const e = new Event(type); Object.defineProperty(e, "target", { value: target }); doc.dispatchEvent(e); };
  return { button, doc, win, ctl, outside, deletedCount: () => deleted, advance: (n: number) => (t += n) };
}

test("one tap arms and does not delete; the label says what the next tap does", () => {
  const s = setup();
  s.button.click();
  expect(s.deletedCount()).toBe(0);
  expect(s.ctl.armed()).toBe(true);
  expect(s.button.dataset.confirm).toBe("1");
  expect(s.button.innerHTML).toBe("Delete");
  expect(s.button.attrs["aria-label"]).toBe("Confirm delete Habakkuk 2:14");
});

test("a second tap on the armed button deletes, once", () => {
  const s = setup();
  s.button.click(); s.advance(600); s.button.click();
  expect(s.deletedCount()).toBe(1);
  expect(s.ctl.armed()).toBe(false);
  expect(s.button.attrs["aria-label"]).toBe("Delete Habakkuk 2:14");
});

test("an accidental fast double tap does not delete", () => {
  const s = setup();
  s.button.click(); s.advance(100); s.button.click();
  expect(s.deletedCount()).toBe(0);
  expect(s.ctl.armed()).toBe(true);
});

test("a tap elsewhere, a scroll, blur or Escape disarms", () => {
  for (const undo of [
    (s: any) => s.outside({}),
    (s: any) => s.win.dispatchEvent(new Event("scroll")),
    (s: any) => s.button.dispatchEvent(new Event("blur")),
    (s: any) => { const e = new Event("keydown"); Object.assign(e, { key: "Escape" }); s.doc.dispatchEvent(e); },
  ]) {
    const s = setup();
    s.button.click(); undo(s);
    expect(s.ctl.armed()).toBe(false);
    expect(s.button.dataset.confirm).toBeUndefined();
    expect(s.button.innerHTML).toBe("<svg/>");
    s.advance(600); s.button.click();
    expect(s.deletedCount()).toBe(0); // that tap only re-armed
  }
});

test("a tap on the armed button itself doesn't count as elsewhere", () => {
  const s = setup();
  s.button.click(); s.outside(s.button); s.advance(600); s.button.click();
  expect(s.deletedCount()).toBe(1);
});

test("it disarms on its own after the timeout", async () => {
  const s = setup(20);
  s.button.click();
  await new Promise((r) => setTimeout(r, 40));
  expect(s.ctl.armed()).toBe(false);
});

test("keyboard: Enter/Space arm then confirm via the button's click, and other keys don't disarm", () => {
  const s = setup();
  s.button.click(); // Enter or Space on a <button> fires click
  const k = new Event("keydown"); Object.assign(k, { key: "Tab" }); s.doc.dispatchEvent(k);
  expect(s.ctl.armed()).toBe(true);
  s.advance(600); s.button.click();
  expect(s.deletedCount()).toBe(1);
});

test("highlight rows use it, offer a 5s Undo, and touch screens get 44px, separated targets", () => {
  const read = (p: string) => readFileSync(new URL(`../public/${p}`, import.meta.url), "utf8");
  const app = read("app.js"), css = read("style.css");
  expect(app).toContain("armDelete(del, {");
  expect(app).toContain("tombstoneRecords(records)");
  expect(app).toMatch(/flash\(`Deleted \$\{labelRef\(runRef\)\}\.`, \{ label: "Undo", run: \(\) => library\.putMany\(records\), ms: 5000 \}\)/);
  expect(css).toMatch(/@media \(pointer: coarse\), \(max-width: 40rem\) \{[\s\S]*?\.actions \.icon \{ min-width: 2\.75rem; height: 2\.75rem;[\s\S]*?\.actions \.icon\.trash \{ margin-left: \.75rem; \}/);
});
