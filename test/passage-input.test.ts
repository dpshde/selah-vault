// The passage field's keys, run against the vendored bundle the app ships (public/vendor/scripture-inline.js,
// built with patches/@faith-tools%2Fscripture-inline@0.3.1.patch).
import { expect, test } from "bun:test";

const classes: any[] = [];
Object.assign(globalThis, {
  HTMLElement: class {},
  customElements: { get: () => undefined, define: (_name: string, c: any) => classes.push(c) },
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  document: { createElement: () => ({ setAttribute() {}, append() {}, style: {}, dataset: {} }) },
});
const { definePassageInput } = await import("../public/vendor/scripture-inline.js");
definePassageInput();
const Field = classes[0];

const suggestions = [
  { kind: "book", insertText: "John", label: "John" },
  { kind: "book", insertText: "1 John", label: "1 John" },
  { kind: "book", insertText: "2 John", label: "2 John" },
];

function field({ hovered = null as number | null, active = -1, open = true } = {}) {
  const accepted: string[] = [];
  const f = Object.create(Field.prototype);
  Object.assign(f, {
    suggestions,
    active,
    input: { value: "Joh" },
    list: {
      hidden: !open,
      querySelector: (sel: string) => (sel.includes(":hover") && hovered !== null ? { dataset: { index: String(hovered) } } : null),
    },
    accept: (s: { insertText: string }) => accepted.push(s.insertText),
  });
  return { f, accepted };
}

const tab = (shiftKey = false) => {
  const e = { key: "Tab", shiftKey, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
  return e;
};

test("Tab takes the option under the mouse, like a click", () => {
  const { f, accepted } = field({ hovered: 2, active: 0 });
  const e = tab();
  f.onKeydown(e);
  expect(accepted).toEqual(["2 John"]);
  expect(e.defaultPrevented).toBe(true);
});

test("with nothing under the mouse, Tab still completes the active (or first) book", () => {
  const first = field();
  first.f.onKeydown(tab());
  expect(first.accepted).toEqual(["John"]);
  const active = field({ active: 1 });
  active.f.onKeydown(tab());
  expect(active.accepted).toEqual(["1 John"]);
});

test("Shift+Tab, or a closed list, ignores the hovered option", () => {
  const shifted = field({ hovered: 2 });
  const e = tab(true);
  shifted.f.onKeydown(e);
  expect(shifted.accepted).toEqual([]);
  expect(e.defaultPrevented).toBe(false);
  const closed = field({ hovered: 2, open: false });
  closed.f.onKeydown(tab());
  expect(closed.accepted).toEqual(["John"]); // unchanged behavior: completes the first book
});

test("hovering marks the option active without scrolling, so Enter takes it too", () => {
  let scrolled = 0;
  const kids = [0, 1, 2].map((i) => ({ id: `l-${i}`, attrs: {} as Record<string, string>, setAttribute(k: string, v: string) { this.attrs[k] = v; }, scrollIntoView() { scrolled++; } }));
  const attrs: Record<string, string> = {};
  const f = Object.create(Field.prototype);
  Object.assign(f, { active: -1, list: { id: "l", children: kids }, input: { setAttribute: (k: string, v: string) => (attrs[k] = v), removeAttribute() {} } });
  f.highlight(2, false);
  expect(f.active).toBe(2);
  expect(kids[2].attrs["aria-selected"]).toBe("true");
  expect(attrs["aria-activedescendant"]).toBe("l-2");
  expect(scrolled).toBe(0);
  f.highlight(1);
  expect(scrolled).toBe(1); // arrow keys still scroll the option into view
});

test("chapter, verse, and range suggestions render a sticky header and pure-number grid cells while books stay a list", () => {
  const makeNode = (tag: string): any => ({
    tag,
    id: "",
    className: "",
    textContent: "",
    dataset: {} as Record<string, string>,
    attrs: {} as Record<string, string>,
    children: [] as any[],
    setAttribute(k: string, v: string) { this.attrs[k] = v; },
    removeAttribute(k: string) { delete this.attrs[k]; },
    append(...nodes: any[]) { this.children.push(...nodes); },
    replaceChildren(...nodes: any[]) { this.children = nodes; },
  });
  const prevCreate = document.createElement;
  document.createElement = makeNode;
  try {
    const f = Object.create(Field.prototype);
    const list = makeNode("ul");
    list.id = "l";
    Object.assign(f, {
      list,
      getAttribute: () => null,
      input: { value: "Deuteronomy ", setAttribute() {}, removeAttribute() {} },
    });
    f.suggest();
    expect(list.dataset.kind).toBe("chapter");
    expect(list.children[0].className).toBe("si-grid-head");
    expect(list.children[0].attrs.part).toBe("header");
    expect(list.children[1].textContent).toBe("1");
    expect(list.children[1].attrs.part).toBe("option cell");
    expect(list.children[1].attrs["aria-label"]).toContain("Deuteronomy");

    f.input.value = "Deuteronomy 29:";
    f.suggest();
    expect(list.dataset.kind).toBe("verse");
    expect(list.children[0].className).toBe("si-grid-head");
    expect(list.children[1].textContent).toBe("1");
    expect(list.children[29].textContent).toBe("29");

    f.input.value = "Ezekiel 36:26-27";
    f.suggest();
    expect(list.dataset.kind).toBe("range");
    expect(list.children[0].className).toBe("si-grid-head");
    expect(list.children[0].children[0].textContent).toBe("Ezekiel 36");
    expect(list.children[1].textContent).toBe("–27");
    expect(list.children[1].textContent).not.toContain("undefined");

    f.input.value = "Joh";
    f.suggest();
    expect(list.dataset.kind).toBe("book");
    expect(list.children[0].attrs.part).toBe("option");
  } finally {
    document.createElement = prevCreate;
  }
});

test("accepting a chapter opens the verse grid without a colon so chapter-only submit still works", () => {
  const makeNode = (tag: string): any => ({
    tag,
    id: "",
    className: "",
    textContent: "",
    dataset: {} as Record<string, string>,
    attrs: {} as Record<string, string>,
    children: [] as any[],
    get childElementCount() { return this.children.length; },
    setAttribute(k: string, v: string) { this.attrs[k] = v; },
    removeAttribute(k: string) { delete this.attrs[k]; },
    append(...nodes: any[]) { this.children.push(...nodes); },
    replaceChildren(...nodes: any[]) { this.children = nodes; },
  });
  const prevCreate = document.createElement;
  document.createElement = makeNode;
  const committed: string[] = [];
  try {
    const f = Object.create(Field.prototype);
    const list = makeNode("ul");
    list.id = "l";
    Object.assign(f, {
      list,
      getAttribute: () => null,
      pendingChapter: null,
      input: { value: "John ", setAttribute() {}, removeAttribute() {} },
      commit: (val: string) => committed.push(val),
      close() {
        this.list.hidden = true;
        this.pendingChapter = null;
        this.active = -1;
        this.rangeAnchor = -1;
        this.draggingRange = false;
      },
    });
    f.suggest();
    expect(list.dataset.kind).toBe("chapter");
    const chapter = f.suggestions.find((s: { canonical: string }) => s.canonical === "JHN.3");
    expect(chapter?.kind).toBe("chapter");
    f.accept(chapter);
    expect(committed).toEqual([]);
    expect(f.input.value).toBe("John 3");
    expect(f.pendingChapter).toEqual(chapter);
    expect(list.dataset.kind).toBe("verse");
    expect(list.hidden).toBe(false);
    expect(list.children[0].className).toBe("si-grid-head");
    expect(list.children[0].children[0].textContent).toBe("John 3");
    expect(list.children[1].textContent).toBe("1");
    expect(list.children[16].textContent).toBe("16");

    // Enter with no verse highlighted commits the chapter-only passage.
    f.onKeydown({ key: "Enter", preventDefault() {} });
    expect(committed).toEqual(["John 3"]);
    expect(f.pendingChapter).toBeNull();
  } finally {
    document.createElement = prevCreate;
  }
});

test("after a chapter accept, picking a verse commits Book N:verse", () => {
  const makeNode = (tag: string): any => ({
    tag,
    id: "",
    className: "",
    textContent: "",
    dataset: {} as Record<string, string>,
    attrs: {} as Record<string, string>,
    children: [] as any[],
    get childElementCount() { return this.children.length; },
    setAttribute(k: string, v: string) { this.attrs[k] = v; },
    removeAttribute(k: string) { delete this.attrs[k]; },
    append(...nodes: any[]) { this.children.push(...nodes); },
    replaceChildren(...nodes: any[]) { this.children = nodes; },
  });
  const prevCreate = document.createElement;
  document.createElement = makeNode;
  const committed: string[] = [];
  try {
    const f = Object.create(Field.prototype);
    const list = makeNode("ul");
    list.id = "l";
    Object.assign(f, {
      list,
      getAttribute: () => null,
      pendingChapter: null,
      input: { value: "John ", setAttribute() {}, removeAttribute() {} },
      commit: (val: string) => committed.push(val),
      close() {
        this.list.hidden = true;
        this.pendingChapter = null;
        this.active = -1;
        this.rangeAnchor = -1;
        this.draggingRange = false;
      },
    });
    f.suggest();
    const chapter = f.suggestions.find((s: { canonical: string }) => s.canonical === "JHN.3");
    f.accept(chapter);
    expect(f.input.value).toBe("John 3");
    expect(list.dataset.kind).toBe("verse");
    const verse = f.suggestions.find((s: { canonical: string }) => s.canonical === "JHN.3.16");
    expect(verse?.insertText).toBe("John 3:16");
    f.accept(verse);
    expect(committed).toEqual(["John 3:16"]);
    expect(f.pendingChapter).toBeNull();
  } finally {
    document.createElement = prevCreate;
  }
});

test("typed John 3 stays a chapter grid until the user accepts or types a colon", () => {
  const makeNode = (tag: string): any => ({
    tag,
    id: "",
    className: "",
    textContent: "",
    dataset: {} as Record<string, string>,
    attrs: {} as Record<string, string>,
    children: [] as any[],
    get childElementCount() { return this.children.length; },
    setAttribute(k: string, v: string) { this.attrs[k] = v; },
    removeAttribute(k: string) { delete this.attrs[k]; },
    append(...nodes: any[]) { this.children.push(...nodes); },
    replaceChildren(...nodes: any[]) { this.children = nodes; },
  });
  const prevCreate = document.createElement;
  document.createElement = makeNode;
  try {
    const f = Object.create(Field.prototype);
    const list = makeNode("ul");
    list.id = "l";
    Object.assign(f, {
      list,
      getAttribute: () => null,
      pendingChapter: null,
      input: { value: "John 3", setAttribute() {}, removeAttribute() {} },
    });
    f.suggest();
    expect(f.pendingChapter).toBeNull();
    expect(list.dataset.kind).toBe("chapter");
    f.input.value = "John 3:";
    f.suggest();
    expect(list.dataset.kind).toBe("verse");
  } finally {
    document.createElement = prevCreate;
  }
});

test("verse grid supports range selection and Shift+Arrow range extension", () => {
  const committed: string[] = [];
  const verseSuggestions = [
    { kind: "verse", canonical: "JHN.3.16", label: "John 3:16", insertText: "John 3:16" },
    { kind: "verse", canonical: "JHN.3.17", label: "John 3:17", insertText: "John 3:17" },
    { kind: "verse", canonical: "JHN.3.18", label: "John 3:18", insertText: "John 3:18" },
  ];
  const kids = [0, 1, 2].map((i) => ({
    id: `l-${i}`,
    dataset: { index: String(i) },
    attrs: {} as Record<string, string>,
    setAttribute(k: string, v: string) { this.attrs[k] = v; },
    removeAttribute(k: string) { delete this.attrs[k]; },
    scrollIntoView() {},
  }));
  const f = Object.create(Field.prototype);
  Object.assign(f, {
    suggestions: verseSuggestions,
    active: 0,
    rangeAnchor: -1,
    draggingRange: false,
    input: { value: "John 3:", setAttribute() {}, removeAttribute() {} },
    list: { id: "l", hidden: false, dataset: { kind: "verse" }, children: kids },
    commit: (val: string) => committed.push(val),
  });
  f.onKeydown({ key: "ArrowRight", shiftKey: true, preventDefault() {} });
  f.onKeydown({ key: "ArrowRight", shiftKey: true, preventDefault() {} });
  expect(f.rangeAnchor).toBe(0);
  expect(f.active).toBe(2);
  expect(kids[0].attrs["data-in-range"]).toBe("true");
  expect(kids[1].attrs["data-in-range"]).toBe("true");
  expect(kids[2].attrs["data-in-range"]).toBe("true");
  f.onKeydown({ key: "Enter", preventDefault() {} });
  expect(committed).toEqual(["John 3:16-18"]);
});

test("Enter on a chapter-only passage closes the verse grid with the field's own close()", () => {
  const makeNode = (tag: string): any => ({
    tag,
    id: "",
    className: "",
    textContent: "",
    dataset: {} as Record<string, string>,
    attrs: {} as Record<string, string>,
    children: [] as any[],
    get childElementCount() { return this.children.length; },
    setAttribute(k: string, v: string) { this.attrs[k] = v; },
    removeAttribute(k: string) { delete this.attrs[k]; },
    append(...nodes: any[]) { this.children.push(...nodes); },
    replaceChildren(...nodes: any[]) { this.children = nodes; },
  });
  const prevCreate = document.createElement;
  document.createElement = makeNode;
  const committed: string[] = [];
  try {
    const f = Object.create(Field.prototype);
    const list = makeNode("ul");
    list.id = "l";
    const input = makeNode("input");
    input.value = "John ";
    Object.assign(f, { list, input, getAttribute: () => null, pendingChapter: null, commit: (val: string) => committed.push(val) });
    f.suggest();
    f.accept(f.suggestions.find((s: { canonical: string }) => s.canonical === "JHN.3"));
    expect(list.hidden).toBe(false);
    expect(input.attrs["aria-expanded"]).toBe("true");
    // A stationary mouse over the new grid must not pre-select a verse (Enter would commit John 3:N).
    expect(f.active).toBe(-1);
    expect(f.hoverArmed).toBe(false);

    f.onKeydown({ key: "Enter", preventDefault() {} });
    expect(committed).toEqual(["John 3"]);
    expect(list.hidden).toBe(true);
    expect(input.attrs["aria-expanded"]).toBe("false");
    expect(f.pendingChapter).toBeNull();
  } finally {
    document.createElement = prevCreate;
  }
});

test("a closed grid listbox stays hidden: [hidden] beats the grid kinds' display: grid", async () => {
  // The chapter/verse/range grid rule sets display: grid at the same specificity as [hidden] and comes later,
  // so without !important a closed verse grid kept painting after a chapter-only submit.
  const src = await Bun.file(new URL("../public/vendor/scripture-inline.js", import.meta.url)).text();
  expect(src).toContain('[role="listbox"][hidden] { display: none !important; }');
});
