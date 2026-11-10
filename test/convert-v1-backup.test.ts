import { describe, expect, test } from "bun:test";
import { Library, memoryStore, parseJsonl } from "../public/sync.js";
import { convertBackupJsonl } from "../scripts/convert-v1-backup";

describe("convert-v1-backup", () => {
  test("converts legacy highlight, color, note, and library name lines into v2 event jsonl", async () => {
    const legacy = [
      JSON.stringify({ version: 1, name: "Study Vault" }),
      JSON.stringify({ kind: "library", ref: "name", name: "Study Vault", updated: 1700000001 }),
      JSON.stringify({ kind: "color", ref: "yellow", name: "Promises", updated: 1700000002 }),
      JSON.stringify({ kind: "color", ref: "c-hope", name: "Hope", hex: "#336699", updated: 1700000003 }),
      JSON.stringify({ kind: "highlight", ref: "JHN.3.16", highlights: [{ color: "yellow", created: 1700000000, quote: "For God so loved" }], updated: 1700000004 }),
      JSON.stringify({ kind: "note", ref: "ROM.8.28", body: "All things work together", updated: 1700000005 }),
    ].join("\n");

    const out = convertBackupJsonl(legacy, { library: "u_test012345678901234567" });
    const lines = out.trim().split("\n").map((l) => JSON.parse(l));
    expect(lines[0]["selah-vault"]).toBe(2);
    expect(lines[0].name).toBe("Study Vault");
    expect(lines.slice(1).every((ev) => String(ev.id).startsWith("ev_") && String(ev.kind).includes("."))).toBe(true);

    const lib = await Library.open({ store: memoryStore() });
    const merged = await lib.merge(parseJsonl(out));
    expect(merged).toBe(5);
    expect(lib.name).toBe("Study Vault");
    expect(lib.find("highlight", "JHN.3.16")?.highlights[0]?.color).toBe("yellow");
    expect(lib.find("color", "c-hope")?.hex).toBe("#336699");
    expect(lib.find("block", "b_ROM.8.28")?.text).toBe("All things work together");
  });
});
