import { describe, expect, test } from "bun:test";
import { Library, memoryStore, parseJsonl } from "../public/sync.js";
import { convertBackupJsonl, deterministicEventId } from "../scripts/convert-v1-backup";
import { createTestEnv } from "./env";

const legacyFixture = [
  JSON.stringify({ version: 1, name: "Study Vault" }),
  JSON.stringify({ kind: "library", ref: "name", name: "Study Vault", updated: 1700000001 }),
  JSON.stringify({ kind: "color", ref: "yellow", name: "Promises", updated: 1700000002 }),
  JSON.stringify({ kind: "color", ref: "c-hope", name: "Hope", hex: "#336699", updated: 1700000003 }),
  JSON.stringify({
    kind: "highlight",
    ref: "JHN.3.16",
    highlights: [
      { color: "blue", created: 1699999990, quote: "older blue" },
      { color: "yellow", created: 1700000000, edited: 1700000004, quote: "For God so loved" },
    ],
    updated: 1700000004,
  }),
  JSON.stringify({ kind: "note", ref: "ROM.8.28", body: "All things work together", updated: 1700000005 }),
].join("\n");

describe("convert-v1-backup", () => {
  test("converts legacy highlight, color, note, and library name lines into v2 event jsonl", async () => {
    const out = convertBackupJsonl(legacyFixture, { library: "u_test012345678901234567" });
    const lines = out.trim().split("\n").map((l) => JSON.parse(l));
    expect(lines[0]["selah-vault"]).toBe(2);
    expect(lines[0].name).toBe("Study Vault");
    expect(lines.slice(1).every((ev) => String(ev.id).startsWith("ev_") && String(ev.kind).includes("."))).toBe(true);

    const lib = await Library.open({ store: memoryStore() });
    const merged = await lib.merge(parseJsonl(out));
    expect(merged).toBe(5);
    expect(lib.name).toBe("Study Vault");
    // v2 keeps one color per verse (newest wins); older blue on JHN.3.16 is dropped.
    expect(lib.find("highlight", "JHN.3.16")?.highlights[0]?.color).toBe("yellow");
    expect(lib.find("color", "c-hope")?.hex).toBe("#336699");
    expect(lib.find("block", "b_ROM.8.28")?.text).toBe("All things work together");
  });

  test("event ids are deterministic so re-converting the same backup is idempotent", () => {
    const a = convertBackupJsonl(legacyFixture, { library: "u_test012345678901234567" });
    const b = convertBackupJsonl(legacyFixture, { library: "u_test012345678901234567" });
    const idsA = a
      .trim()
      .split("\n")
      .slice(1)
      .map((l) => JSON.parse(l).id);
    const idsB = b
      .trim()
      .split("\n")
      .slice(1)
      .map((l) => JSON.parse(l).id);
    expect(idsA).toEqual(idsB);
    expect(deterministicEventId("v1", "highlight.set", "JHN.3.16", "yellow")).toMatch(/^ev_[A-Za-z0-9_-]{22}$/);
  });

  test("converted backup imports through POST /v2/import and re-import is a no-op", async () => {
    const h = createTestEnv();
    const owner = await h.createUserSession("import-v1@selah.tools", "Importer");
    const converted = convertBackupJsonl(legacyFixture, { library: owner.user.id });

    const first = await h.fetch("/v2/import", {
      method: "POST",
      headers: {
        "content-type": "application/x-ndjson",
        authorization: `Bearer ${owner.token}`,
      },
      body: converted,
    });
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { accepted: number; duplicates: number; seq: number };
    expect(firstBody.accepted).toBe(5);
    expect(firstBody.duplicates).toBe(0);

    const boot = (await (await h.fetch("/v2/bootstrap", { headers: { authorization: `Bearer ${owner.token}` } })).json()) as {
      library: { name: string };
      highlights: Array<{ ref: string; color: string }>;
      colors: Array<{ id: string; hex?: string }>;
      blocks: Array<{ id: string; text: string }>;
    };
    expect(boot.library.name).toBe("Study Vault");
    expect(boot.highlights.some((x) => x.ref === "JHN.3.16" && x.color === "yellow")).toBe(true);
    expect(boot.colors.some((x) => x.id === "c-hope" && x.hex === "#336699")).toBe(true);
    expect(boot.blocks.some((x) => x.id === "b_ROM.8.28" && x.text === "All things work together")).toBe(true);

    const second = await h.fetch("/v2/import", {
      method: "POST",
      headers: {
        "content-type": "application/x-ndjson",
        authorization: `Bearer ${owner.token}`,
      },
      body: converted,
    });
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({
      seq: firstBody.seq,
      accepted: 0,
      duplicates: 5,
    });
  });
});
