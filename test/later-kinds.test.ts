// A library made before 1.3 must keep working when 1.3's kinds (passage, block, srs-log) turn up
// in it, and this client must keep those records without understanding them (SPEC.md 1, 11).
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { MIGRATIONS, d1 } from "./d1";
import { handle } from "../src/worker";
import { Library, formatKey, memoryStore, newKey, parseJsonl, serverTransport } from "../public/sync.js";

type Rec = Record<string, unknown>;

const OLD: Rec[] = [
  { kind: "highlight", ref: "JHN.3.16", updated: 1793000000, highlights: [{ color: "yellow", created: 1792000000 }] },
  { kind: "highlight", ref: "JHN.3.17", updated: 1793000000, highlights: [{ color: "yellow", created: 1792000000 }] },
  { kind: "note", ref: "JHN.3.16-18", updated: 1793000000, created: 1792000000, body: "Plain text." },
  { kind: "color", ref: "c-7f3a9b", updated: 1793000000, name: "Prayer", hex: "#3a7bd5", created: 1793000000 },
  { kind: "library", ref: "name", updated: 1793000000, name: "Family devotions" },
];

const LATER: Rec[] = [
  { kind: "passage", ref: "JHN.3.16-18", v: 1, updated: 1793000000, created: 1792000000 },
  { kind: "block", ref: "b_RvrIbWBdj2CJjUQr0YSxAq", v: 1, updated: 1793000000, outline: "b_RvrIbWBdj2CJjUQr0YSxAq", parent: null, rank: "a1", text: "Plain text.", passage: "JHN.3.16-18" },
  {
    kind: "srs-log", ref: "q8Zr0aXv5Tg/2026-11-09", v: 1, updated: 1793000100, client: "proofs-web", tz: -360,
    cards: ["JHN.3.16-18#text", "x-proofs:q1-s1"], cols: ["x-proofs-rung", "x-proofs-hints"],
    events: [[0, 1792999000, "add"], [0, 1792999010, 3], [0, 1792999400, 2, "R2b", 1], [1, 1793000000, 1], [0, 1793000100, "reset"]],
  },
];

function server() {
  const sqlite = new Database(":memory:");
  for (const m of MIGRATIONS) sqlite.exec(m);
  const env = { DB: d1(sqlite) };
  return async (input: string | URL | Request, init?: RequestInit) => handle(new Request(new URL(String(input), "http://local"), init), env);
}

/** What a pre-1.3 app shows: everything it reads from the kinds it knows. */
const view = (lib: InstanceType<typeof Library>) => ({
  highlights: lib.all("highlight"),
  ranges: lib.highlights({ group: "ranges" }),
  notes: lib.all("note"),
  colors: lib.all("color"),
  name: lib.name,
});

const sorted = (records: Rec[]) => [...records].sort((a, b) => `${a.kind} ${a.ref}`.localeCompare(`${b.kind} ${b.ref}`));

describe("a pre-1.3 library that gains 1.3 kinds", () => {
  test("an import keeps the later kinds, and what the app shows doesn't change", async () => {
    const lib = await Library.open({ keyText: await formatKey(newKey()), store: memoryStore() });
    await lib.merge(OLD);
    const before = view(lib);

    expect(await lib.merge(LATER)).toBe(LATER.length);
    expect(view(lib)).toEqual(before);
    for (const r of LATER) expect(lib.find(r.kind as string, r.ref as string)).toEqual(r);
  });

  test("a backup file carries them out and back in, unchanged", async () => {
    const a = await Library.open({ keyText: await formatKey(newKey()), store: memoryStore() });
    await a.merge([...OLD, ...LATER]);
    const file = a.toFile();

    const b = await Library.open({ keyText: await formatKey(newKey()), store: memoryStore() });
    await b.merge(parseJsonl(file));
    expect(sorted(b.all() as Rec[])).toEqual(sorted([...OLD, ...LATER]));
    expect(view(b)).toEqual(view(a));
  });

  test("they sync between two devices through the server, and old records are untouched", async () => {
    const fetch = server();
    const keyText = await formatKey(newKey());
    const open = () => Library.open({ keyText, store: memoryStore(), transports: [serverTransport({ fetch })] });

    const a = await open();
    await a.merge(OLD);
    await a.sync();
    const before = view(a);

    const b = await open();
    await b.sync();
    await b.merge(LATER);
    await b.sync();

    await a.sync();
    expect(view(a)).toEqual(before);
    expect(sorted(a.all() as Rec[])).toEqual(sorted([...OLD, ...LATER]));

    // An edit on the device that doesn't know the later kinds leaves them alone.
    await a.put({ kind: "note", ref: "JHN.3.16-18", created: 1792000000, body: "Edited." });
    await a.sync();
    await b.sync();
    for (const r of LATER) expect(b.find(r.kind as string, r.ref as string)).toEqual(r);
    expect((b.find("note", "JHN.3.16-18") as Rec).body).toBe("Edited.");
  });

  test("a malformed record of an unknown kind is still refused", async () => {
    const lib = await Library.open({ keyText: await formatKey(newKey()), store: memoryStore() });
    expect(await lib.merge([{ kind: "passage" }, { kind: "passage", ref: "JHN.3.16", updated: 1.5 }, { kind: "", ref: "x" }] as Rec[])).toBe(0);
    // A known kind is still checked as before.
    expect(await lib.merge([{ kind: "highlight", ref: "JHN.3", highlights: [{ color: "yellow" }] }])).toBe(0);
  });
});
