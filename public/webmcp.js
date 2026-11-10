// WebMCP: in-page tools a browser agent can call through `document.modelContext` while a library is
// open on this page. They work on the open library in this tab, through the same code as the
// buttons, so changes sync like any other edit. No tool reads, returns or asks for tokens.
// Feature-detected: browsers without WebMCP never see any of this. Design notes: docs/webmcp/.

import { readPassage } from "./passage.js";
import { BOOKS, compareRefs, labelRef, splitRef } from "./refs.js";
import { groupRuns, tombstone } from "./ranges.js";
import { topColor } from "./sync.js";

export const FIND_HIGHLIGHTS = "find_highlights";
export const ADD_HIGHLIGHT = "add_highlight";
export const DELETE_HIGHLIGHTS = "delete_highlights";
export const PAGE_SIZE = 12;
export const OUTPUT_MAX_CHARS = 1500;
const QUOTE_MAX_CHARS = 80;

const REFERENCE = {
  type: "string",
  description: "A Bible reference as the user said it, e.g. 'John 3:16', 'rom 5:3-5', 'Psalm 23', or a bible.com or route.bible link.",
};
const COLOR = {
  type: "string",
  description: "A color as the user named it: yellow, green, blue, pink, purple, orange, or a name the library gave a color (e.g. 'Prayer').",
};

export const findHighlightsSchema = {
  type: "object",
  properties: {
    within: {
      type: "string",
      description: "Only highlights inside this passage or book, as the user said it ('Romans', 'John 3', 'Ps 23'). Omit for the whole library.",
    },
    color: COLOR,
    page: { type: "integer", minimum: 1, description: "Page of results, starting at 1." },
  },
};
export const addHighlightSchema = {
  type: "object",
  properties: { reference: REFERENCE, color: { ...COLOR, description: `${COLOR.description} Yellow when omitted.` } },
  required: ["reference"],
};
export const deleteHighlightsSchema = {
  type: "object",
  properties: { reference: REFERENCE },
  required: ["reference"],
};

const fail = (code, error, suggestion, retryable = false) => ({ error, code, retryable, ...(suggestion ? { suggestion } : {}) });
const LOCKED = () =>
  fail(
    "LIBRARY_LOCKED",
    "No library is open on this page.",
    "Ask the user to sign in on this page with their passkey, email code, or Apple account. Never ask them to share credentials in chat.",
  );
const clip = (text, max) => {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
};

/** The book code when the text is exactly a book's name or code ("Romans", "ROM", "Psalm"), else null. */
function exactBook(text) {
  const t = String(text ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  return BOOKS.find(([code, name]) => code.toLowerCase() === t || name.toLowerCase() === t || (code === "PSA" && t === "psalm"))?.[0] ?? null;
}

/** "Romans", "rom", "1 John", "Ps" → a book code, or null. */
export function bookCode(text) {
  if (!String(text ?? "").trim()) return null;
  const exact = exactBook(text);
  if (exact) return exact;
  const found = readPassage(`${text} 1:1`);
  return found.error !== undefined ? null : (splitRef(found.verses[0])?.code ?? null);
}

/**
 * The tools, bound to the page's app state.
 * deps: { library(): Library|null, colors(): [{id,name,builtIn}], colorName(c): string,
 *         highlight(verses, colorId): Promise<undo>, flash(text, action?): void }
 */
export function buildSelahVaultTools(deps) {
  const named = (id) => deps.colorName(deps.colors().find((c) => c.id === id) ?? { id, builtIn: true });
  /** A color by id or name, or null when the library has no such color. */
  const colorFor = (wanted) => {
    const w = String(wanted).trim().toLowerCase();
    const colors = deps.colors();
    return colors.find((c) => c.id === w) ?? colors.find((c) => deps.colorName(c).toLowerCase() === w) ?? null;
  };
  const passage = (reference) => {
    const found = readPassage(reference);
    return found.error ? { error: fail("NOT_A_REFERENCE", found.error, "Ask the user for a reference like John 3:16, or check the spelling of the book.") } : found;
  };

  const findHighlights = {
    name: FIND_HIGHLIGHTS,
    description:
      "Lists the highlights in the open library, in Bible order, with each one's color and saved quote, plus the library's color names. Use when the user asks what they highlighted, in a book or passage or color, or before changing a highlight.",
    inputSchema: findHighlightsSchema,
    annotations: { readOnlyHint: true, untrustedContentHint: true },
    async execute(input = {}) {
      const library = deps.library();
      if (!library) return LOCKED();
      const ids = deps.colors().map((c) => c.id);
      let rows = library.all("highlight").sort((a, b) => compareRefs(a.ref, b.ref));
      let scope = "whole library";
      if (typeof input.within === "string" && input.within.trim()) {
        // A whole book ("Romans", "rom", "Psalm") or a passage ("John 3", "Ps 23:1-3").
        let code = exactBook(input.within);
        const found = code ? null : readPassage(input.within);
        if (found && !found.error) {
          const set = new Set(found.verses);
          rows = rows.filter((r) => set.has(r.ref));
          scope = found.label;
        } else {
          code ??= bookCode(input.within);
          if (!code) return fail("NOT_A_REFERENCE", found?.error ?? "That isn't a book of the Bible.", "Ask the user for a book or passage like Romans or John 3.");
          rows = rows.filter((r) => splitRef(r.ref)?.code === code);
          scope = BOOKS.find(([c]) => c === code)[1];
        }
      }
      if (typeof input.color === "string" && input.color.trim()) {
        const c = colorFor(input.color);
        if (!c) return fail("COLOR_NOT_FOUND", `This library has no color called "${clip(input.color, 30)}".`, "Call find_highlights without a color to see the library's colors.");
        rows = rows.filter((r) => topColor(r, ids) === c.id);
      }
      const runs = groupRuns(rows, (r) => topColor(r, ids));
      const pageSize = PAGE_SIZE;
      const totalPages = Math.max(1, Math.ceil(runs.length / pageSize));
      const page = Math.min(Math.max(1, Math.floor(Number(input.page) || 1)), totalPages);
      const highlights = runs.slice((page - 1) * pageSize, page * pageSize).map(({ ref, records }) => {
        const quote = records.flatMap((r) => (r.highlights ?? []).map((h) => h.quote)).filter(Boolean).join(" … ");
        return { reference: labelRef(ref), color: named(topColor(records[0], ids)), ...(quote ? { quote: clip(quote, QUOTE_MAX_CHARS) } : {}) };
      });
      const payload = {
        scope,
        page,
        page_size: pageSize,
        total_count: runs.length,
        total_pages: totalPages,
        highlights,
        colors: deps.colors().map((c) => deps.colorName(c)),
      };
      while (JSON.stringify(payload).length > OUTPUT_MAX_CHARS && payload.highlights.some((h) => h.quote)) {
        const h = [...payload.highlights].reverse().find((x) => x.quote);
        delete h.quote;
      }
      if (runs.length === 0) payload.suggestion = "Nothing matched. Try without a color, or a wider passage or book.";
      return payload;
    },
  };

  const addHighlight = {
    name: ADD_HIGHLIGHT,
    description:
      "Highlights every verse of a passage in one color in the open library; verses already highlighted take the new color. Use when the user wants to save, highlight or recolor a verse or passage.",
    inputSchema: addHighlightSchema,
    async execute(input = {}) {
      const library = deps.library();
      if (!library) return LOCKED();
      if (typeof input.reference !== "string" || !input.reference.trim()) return fail("MISSING_REFERENCE", "No reference was given.", "Ask the user which verse or passage to highlight.");
      const found = passage(input.reference);
      if (found.error) return found.error;
      const color = input.color === undefined || input.color === "" ? colorFor("yellow") : colorFor(input.color);
      if (!color) return fail("COLOR_NOT_FOUND", `This library has no color called "${clip(input.color, 30)}".`, "Ask the user to pick one of the colors find_highlights lists.");
      const undo = await deps.highlight(found.verses, color.id);
      deps.flash(`Saved ${found.label} in ${deps.colorName(color)}.`, { label: "Undo", run: undo });
      return { status: "saved", reference: found.label, color: deps.colorName(color), verses: found.verses.length };
    },
  };

  const deleteHighlights = {
    name: DELETE_HIGHLIGHTS,
    description:
      "Removes the highlights on every verse of a passage from the open library and from the user's other devices when they sync. Use when the user asks to delete or clear a highlight.",
    inputSchema: deleteHighlightsSchema,
    annotations: { consequentialHint: true },
    async execute(input = {}) {
      const library = deps.library();
      if (!library) return LOCKED();
      if (typeof input.reference !== "string" || !input.reference.trim()) return fail("MISSING_REFERENCE", "No reference was given.", "Ask the user which highlight to delete.");
      const found = passage(input.reference);
      if (found.error) return found.error;
      const before = found.verses.map((v) => library.find("highlight", v)).filter(Boolean);
      if (!before.length) return fail("NOTHING_HIGHLIGHTED", `Nothing in ${found.label} is highlighted.`, "Call find_highlights to see what is highlighted.");
      await library.putMany(before.map((r) => tombstone(r.ref)));
      deps.flash(`Deleted ${found.label}.`, { label: "Undo", run: () => library.putMany(before) });
      return { status: "deleted", reference: found.label, verses: before.length };
    },
  };

  return [findHighlights, addHighlight, deleteHighlights];
}

/** Registers the tools when the browser has WebMCP. Returns a function that removes them, or null. */
export function registerSelahVaultTools(deps, modelContext = globalThis.document?.modelContext) {
  if (!modelContext || typeof modelContext.registerTool !== "function") return null;
  const controller = new AbortController();
  for (const tool of buildSelahVaultTools(deps)) {
    try {
      Promise.resolve(modelContext.registerTool(tool, { signal: controller.signal })).catch((error) =>
        console.warn(`WebMCP tool ${tool.name} did not register`, error),
      );
    } catch (error) {
      console.warn(`WebMCP tool ${tool.name} did not register`, error);
    }
  }
  return () => controller.abort();
}
/* asset-rev 2 */
