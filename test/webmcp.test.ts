import { beforeEach, expect, test } from "bun:test";
import { Library, now, palette } from "../public/sync.js";
import { highlightRecord } from "../public/ranges.js";
import {
  ADD_HIGHLIGHT,
  DELETE_HIGHLIGHTS,
  FIND_HIGHLIGHTS,
  OUTPUT_MAX_CHARS,
  PAGE_SIZE,
  buildSelahVaultTools,
  registerSelahVaultTools,
} from "../public/webmcp.js";
import schema from "../docs/webmcp/schema.json";

type Tool = { name: string; description: string; inputSchema: any; annotations?: Record<string, boolean>; execute: (input: any, options?: any) => Promise<any> };

const capitalized = (s: string) => s[0]!.toUpperCase() + s.slice(1);
const colorName = (c: any) => c.name || (c.builtIn ? capitalized(c.id) : "Color");

let library: any;
let tokenText: string;
let flashes: Array<{ text: string; action?: { label: string; run: () => unknown } }>;

/** The same wiring app.js gives the tools, over a real Library. */
function deps(open = true) {
  return {
    library: () => (open ? library : null),
    colors: () => palette(library.all("color")),
    colorName,
    async highlight(verses: string[], color: string) {
      const t = now();
      const before = verses.map((v) => library.find("highlight", v));
      await library.putMany(verses.map((v, i) => highlightRecord(before[i], v, color, t)));
      return () => library.putMany(verses.map((v, i) => before[i] ?? { kind: "highlight", ref: v, deleted: true }));
    },
    flash: (text: string, action?: any) => flashes.push({ text, action }),
  };
}

const tools = (open = true) => Object.fromEntries((buildSelahVaultTools(deps(open)) as Tool[]).map((t) => [t.name, t]));
const exec = (name: string, input: any = {}, open = true) => tools(open)[name]!.execute(input, { signal: new AbortController().signal });

beforeEach(async () => {
  tokenText = "sv2.u_0123456789abcdef012345.secret_0123456789abcdef0123456789abcdef0123";
  library = await Library.open({ userId: "u_0123456789abcdef012345", token: tokenText });
  flashes = [];
});

test("registers three tools with an abort signal, and does nothing without WebMCP", () => {
  const seen: Array<{ name: string; signal: AbortSignal }> = [];
  const unregister = registerSelahVaultTools(deps(), { registerTool: async (tool: Tool, options: any) => void seen.push({ name: tool.name, signal: options.signal }) });
  expect(seen.map((s) => s.name)).toEqual([FIND_HIGHLIGHTS, ADD_HIGHLIGHT, DELETE_HIGHLIGHTS]);
  unregister!();
  expect(seen.every((s) => s.signal.aborted)).toBe(true);
  expect(registerSelahVaultTools(deps(), undefined)).toBeNull();
  expect(registerSelahVaultTools(deps(), {} as any)).toBeNull();
});

test("tool definitions match docs/webmcp/schema.json and Chrome's budgets", () => {
  const defs = (buildSelahVaultTools(deps()) as Tool[]).map(({ name, description, inputSchema, annotations }) =>
    JSON.parse(JSON.stringify({ name, description, inputSchema, ...(annotations ? { annotations } : {}) })),
  );
  expect(defs).toEqual(schema.tools);
  for (const t of defs) {
    expect(t.name.length).toBeLessThanOrEqual(30);
    expect(t.description.length).toBeLessThanOrEqual(500);
    for (const [name, p] of Object.entries<any>(t.inputSchema.properties)) {
      expect(name.length).toBeLessThanOrEqual(30);
      expect(p.description.length).toBeLessThanOrEqual(150);
    }
    for (const v of Object.values(t.annotations ?? {})) expect(v).toBe(true);
  }
});

test("no tool output ever holds a session or OAuth token", async () => {
  await exec(ADD_HIGHLIGHT, { reference: "John 3:16" });
  const outputs = [
    await exec(FIND_HIGHLIGHTS),
    await exec(ADD_HIGHLIGHT, { reference: "Rom 5:3-5", color: "blue" }),
    await exec(DELETE_HIGHLIGHTS, { reference: "Rom 5:4" }),
    await exec(FIND_HIGHLIGHTS, {}, false),
  ];
  for (const out of outputs) {
    const text = JSON.stringify(out);
    expect(text).not.toContain(tokenText);
    expect(text).not.toContain("sv2.");
  }
});

test("every tool asks for sign-in when no library is open", async () => {
  for (const name of [FIND_HIGHLIGHTS, ADD_HIGHLIGHT, DELETE_HIGHLIGHTS]) {
    const out = await exec(name, { reference: "John 3:16" }, false);
    expect(out).toMatchObject({ code: "LIBRARY_LOCKED", retryable: false });
    expect(out.suggestion).toContain("Never ask them to share");
  }
});

test("add_highlight saves a passage in a color, by name, and offers Undo", async () => {
  const out = await exec(ADD_HIGHLIGHT, { reference: "rom 5:3-5", color: "Blue" });
  expect(out).toEqual({ status: "saved", reference: "Romans 5:3–5", color: "Blue", verses: 3 });
  expect(library.all("highlight").map((r: any) => r.ref).sort()).toEqual(["ROM.5.3", "ROM.5.4", "ROM.5.5"]);
  expect(flashes.at(-1)!.text).toBe("Saved Romans 5:3–5 in Blue.");
  await flashes.at(-1)!.action!.run();
  expect(library.all("highlight")).toEqual([]);
});

test("add_highlight defaults to yellow, recolors, and knows the library's own color names", async () => {
  expect(await exec(ADD_HIGHLIGHT, { reference: "John 3:16" })).toMatchObject({ color: "Yellow" });
  await library.putMany([{ kind: "color", ref: "c1", name: "Prayer", hex: "#336699", created: 1 }]);
  expect(await exec(ADD_HIGHLIGHT, { reference: "John 3:16", color: "prayer" })).toMatchObject({ color: "Prayer", verses: 1 });
  const found = await exec(FIND_HIGHLIGHTS);
  expect(found.highlights).toEqual([{ reference: "John 3:16", color: "Prayer" }]);
  expect(found.colors).toContain("Prayer");
});

test("add_highlight resolves actionable errors", async () => {
  expect(await exec(ADD_HIGHLIGHT, { reference: "" })).toMatchObject({ code: "MISSING_REFERENCE" });
  expect(await exec(ADD_HIGHLIGHT, { reference: "the one about love" })).toMatchObject({ code: "NOT_A_REFERENCE" });
  expect(await exec(ADD_HIGHLIGHT, { reference: "John 3:16", color: "chartreuse" })).toMatchObject({ code: "COLOR_NOT_FOUND" });
  expect(library.all("highlight")).toEqual([]);
});

test("find_highlights filters by book, passage and color, in Bible order", async () => {
  await exec(ADD_HIGHLIGHT, { reference: "Romans 8:28", color: "green" });
  await exec(ADD_HIGHLIGHT, { reference: "John 3:16" });
  await exec(ADD_HIGHLIGHT, { reference: "Romans 5:3-5", color: "blue" });
  const all = await exec(FIND_HIGHLIGHTS);
  expect(all.highlights.map((h: any) => h.reference)).toEqual(["John 3:16", "Romans 5:3–5", "Romans 8:28"]);
  expect(all).toMatchObject({ scope: "whole library", page: 1, page_size: PAGE_SIZE, total_count: 3, total_pages: 1 });
  expect((await exec(FIND_HIGHLIGHTS, { within: "Romans" })).highlights.map((h: any) => h.reference)).toEqual(["Romans 5:3–5", "Romans 8:28"]);
  expect((await exec(FIND_HIGHLIGHTS, { within: "rom" })).scope).toBe("Romans");
  expect((await exec(FIND_HIGHLIGHTS, { within: "Romans 5" })).highlights).toEqual([{ reference: "Romans 5:3–5", color: "Blue" }]);
  expect((await exec(FIND_HIGHLIGHTS, { color: "green" })).highlights).toEqual([{ reference: "Romans 8:28", color: "Green" }]);
  const none = await exec(FIND_HIGHLIGHTS, { within: "Genesis" });
  expect(none.total_count).toBe(0);
  expect(none.suggestion).toBeString();
  expect(await exec(FIND_HIGHLIGHTS, { color: "chartreuse" })).toMatchObject({ code: "COLOR_NOT_FOUND" });
  expect(await exec(FIND_HIGHLIGHTS, { within: "Hezekiah" })).toMatchObject({ code: "NOT_A_REFERENCE" });
});

test("find_highlights paginates and stays inside the output budget", async () => {
  const t = now();
  const long = "word ".repeat(200);
  await library.putMany(
    Array.from({ length: 40 }, (_, i) => ({ kind: "highlight", ref: `PSA.${i + 1}.1`, highlights: [{ color: "yellow", created: t, quote: long }] })),
  );
  const first = await exec(FIND_HIGHLIGHTS);
  expect(first).toMatchObject({ page: 1, total_count: 40, total_pages: 4 });
  expect(first.highlights).toHaveLength(PAGE_SIZE);
  expect(JSON.stringify(first).length).toBeLessThanOrEqual(OUTPUT_MAX_CHARS);
  const last = await exec(FIND_HIGHLIGHTS, { page: 9 });
  expect(last.page).toBe(4);
  expect(last.highlights[0].reference).toBe("Psalm 37:1");
});

test("delete_highlights is consequential, removes only highlighted verses, and can be undone", async () => {
  const del = (buildSelahVaultTools(deps()) as Tool[]).find((t) => t.name === DELETE_HIGHLIGHTS)!;
  expect(del.annotations).toEqual({ consequentialHint: true });
  await exec(ADD_HIGHLIGHT, { reference: "Romans 5:3-5", color: "blue" });
  expect(await exec(DELETE_HIGHLIGHTS, { reference: "Romans 5:4-6" })).toEqual({ status: "deleted", reference: "Romans 5:4–6", verses: 2 });
  expect(library.all("highlight").map((r: any) => r.ref)).toEqual(["ROM.5.3"]);
  await flashes.at(-1)!.action!.run();
  expect(library.all("highlight").map((r: any) => r.ref).sort()).toEqual(["ROM.5.3", "ROM.5.4", "ROM.5.5"]);
  expect(await exec(DELETE_HIGHLIGHTS, { reference: "Genesis 1:1" })).toMatchObject({ code: "NOTHING_HIGHLIGHTED" });
  expect(await exec(DELETE_HIGHLIGHTS, {})).toMatchObject({ code: "MISSING_REFERENCE" });
});
