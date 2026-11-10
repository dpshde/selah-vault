// Converts a record-shaped v1 `.jsonl` backup into a clean Selah Vault v2 event-stream `.jsonl` file.
// Usage: bun scripts/convert-v1-backup.ts <input.jsonl> [output.jsonl]
import { readFileSync, writeFileSync } from "node:fs";
import { COLORS } from "../public/ranges.js";
import { splitRef } from "../public/refs.js";
import { autoTags, newEventId } from "../public/sync.js";

const COLOR_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const HEX = /^#[0-9a-fA-F]{6}$/;

export function convertBackupJsonl(rawText: string, { library = "imported", name = "Personal" } = {}): string {
  const now = Date.now();
  let syncedName = name;
  const events: Array<Record<string, unknown>> = [];

  for (const line of String(rawText ?? "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const obj = JSON.parse(trimmed) as Record<string, any>;
    if (!obj || typeof obj !== "object") continue;

    // Header line (v2 or legacy backup metadata): capture library name if present.
    if (typeof obj.kind !== "string") {
      if (typeof obj.name === "string" && obj.name.trim()) syncedName = obj.name.trim();
      continue;
    }
    // Already a v2 VaultEvent line.
    if (typeof obj.id === "string" && obj.id.startsWith("ev_") && obj.kind.includes(".")) {
      events.push(obj);
      continue;
    }

    const { kind, ref } = obj;
    if (typeof ref !== "string") continue;
    const ts = Number.isSafeInteger(obj.updated) ? obj.updated * 1000 : now;
    const emit = (evKind: string, evRef: string | null, data: Record<string, unknown>) => {
      events.push({ id: newEventId(), ts, app: "selah-vault", kind: evKind, ref: evRef, tags: autoTags(evKind, evRef, data), data });
    };

    if (kind === "library" && ref === "name" && !obj.deleted && typeof obj.name === "string" && obj.name.trim()) {
      syncedName = obj.name.trim();
      emit("library.renamed", null, { name: syncedName });
    } else if (kind === "color" && COLOR_ID.test(ref)) {
      if (obj.deleted === true) emit("color.removed", null, { id: ref });
      else if (COLORS.includes(ref) || HEX.test(obj.hex ?? "")) {
        emit("color.set", null, { id: ref, name: String(obj.name ?? ""), ...(HEX.test(obj.hex ?? "") ? { hex: obj.hex.toLowerCase() } : {}) });
      }
    } else if (splitRef(ref)) {
      if (kind === "highlight") {
        if (obj.deleted === true) emit("highlight.removed", ref, {});
        else {
          const parts = Array.isArray(obj.highlights) ? obj.highlights : obj.color ? [{ color: obj.color }] : [];
          if (!parts.length) continue;
          const best = parts.reduce((a: any, b: any) => ((b.edited ?? b.created ?? 0) >= (a.edited ?? a.created ?? 0) ? b : a));
          const quote = parts.map((h: any) => h.quote).filter(Boolean).join(" ... ");
          const createdSec = parts.map((h: any) => h.created).filter(Number.isSafeInteger);
          const createdTs = createdSec.length ? Math.min(...createdSec) * 1000 : undefined;
          emit("highlight.set", ref, { color: String(best.color || "yellow"), ...(quote ? { quote } : {}), ...(createdTs ? { createdTs } : {}) });
        }
      } else if (kind === "passage") {
        emit(obj.deleted === true ? "passage.removed" : "passage.saved", ref, obj.deleted ? {} : { apps: obj.apps ?? {} });
      } else if (kind === "note") {
        const id = `b_${ref}`;
        if (obj.deleted === true) emit("note.block.deleted", ref, { id });
        else emit("note.block.set", ref, { id, outlineId: ref, parentId: null, rank: "n", text: String(obj.body ?? "") });
      }
    }
  }

  const header = { "selah-vault": 2, library, name: syncedName, exportedAt: now };
  return `${[JSON.stringify(header), ...events.map((e) => JSON.stringify(e))].join("\n")}\n`;
}

if (import.meta.main) {
  const [inPath, outPath] = process.argv.slice(2);
  if (!inPath) {
    console.error("Usage: bun scripts/convert-v1-backup.ts <input.jsonl> [output.jsonl]");
    process.exit(1);
  }
  const converted = convertBackupJsonl(readFileSync(inPath, "utf8"));
  if (outPath) writeFileSync(outPath, converted, "utf8");
  else process.stdout.write(converted);
}
