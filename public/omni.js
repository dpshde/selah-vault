// Classify the vault's one omni field: a scripture reference, a bare book name, or a topic.
// Parsing uses the same readPassage path as Highlight (grab-bcv via passage.js, canonical books in refs.js).

import { readPassage } from "./passage.js";
import { BOOKS } from "./refs.js";

export const OMNI_PLACEHOLDER = "Passage or topic, e.g. Rom 8:18 or hope";
export const OMNI_PLACEHOLDER_PHONE = "Passage or topic";
export const OMNI_ARIA = "Passage or topic";

const norm = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

/** 2-letter aliases that are also ordinary English words — treat those as topics. */
const ENGLISH_TWO = new Set([
  "am", "an", "as", "at", "be", "by", "co", "da", "do", "ga", "go", "he", "ho", "if", "in",
  "is", "it", "je", "ju", "la", "me", "my", "na", "no", "of", "on", "or", "re", "ro", "ru",
  "so", "ss", "to", "us", "we", "ac",
]);

/** norm(alias) → USFM book code. First writer wins so official names beat later aliases. */
const ALIASES = new Map();

const addAlias = (alias, code) => {
  const key = norm(alias);
  if (!key) return;
  if (key.length <= 2 && ENGLISH_TWO.has(key)) return;
  if (!ALIASES.has(key)) ALIASES.set(key, code);
};

for (const [code, name] of BOOKS) {
  addAlias(code, code);
  addAlias(name, code);
  if (name.endsWith("s") && name.length > 4) addAlias(name.slice(0, -1), code);
}

// Numbered-book families typed without 1/2: "Kings" → 1 Kings.
for (const [family, code] of [
  ["kings", "1KI"],
  ["samuel", "1SA"],
  ["chronicles", "1CH"],
  ["corinthians", "1CO"],
  ["thessalonians", "1TH"],
  ["thess", "1TH"],
  ["timothy", "1TI"],
  ["peter", "1PE"],
]) addAlias(family, code);

// grab-bcv aliases (3+ letters always; short ones that aren't English words).
for (const [code, names] of [
  ["GEN", ["genesis", "gen"]],
  ["EXO", ["exodus", "exo", "exod", "ex"]],
  ["LEV", ["leviticus", "lev"]],
  ["NUM", ["numbers", "num", "nu"]],
  ["DEU", ["deuteronomy", "deut", "dt"]],
  ["JOS", ["joshua", "josh", "jos"]],
  ["JDG", ["judges", "judg", "jdg"]],
  ["RUT", ["ruth"]],
  ["1SA", ["1samuel", "1sam", "1sa"]],
  ["2SA", ["2samuel", "2sam", "2sa"]],
  ["1KI", ["1kings", "1kgs", "1ki"]],
  ["2KI", ["2kings", "2kgs", "2ki"]],
  ["1CH", ["1chronicles", "1chron", "1chr", "1ch"]],
  ["2CH", ["2chronicles", "2chron", "2chr", "2ch"]],
  ["EZR", ["ezra", "ezr"]],
  ["NEH", ["nehemiah", "neh"]],
  ["EST", ["esther", "est", "esth"]],
  ["JOB", ["job", "jb"]],
  ["PSA", ["psalms", "psalm", "ps", "psa"]],
  ["PRO", ["proverbs", "prov", "pro", "pr"]],
  ["ECC", ["ecclesiastes", "eccles", "eccl", "ecc"]],
  ["SNG", ["songofsolomon", "songofsongs", "songofsongs", "song", "sos", "canticles", "song of songs", "song of solomon"]],
  ["ISA", ["isaiah", "isa"]],
  ["JER", ["jeremiah", "jer"]],
  ["LAM", ["lamentations", "lam"]],
  ["EZK", ["ezekiel", "ezek", "eze", "ezk"]],
  ["DAN", ["daniel", "dan"]],
  ["HOS", ["hosea", "hos"]],
  ["JOL", ["joel", "joe", "jol"]],
  ["AMO", ["amos", "amo"]],
  ["OBA", ["obadiah", "obad", "oba"]],
  ["JON", ["jonah", "jon", "jnh", "jona"]],
  ["MIC", ["micah", "mic"]],
  ["NAM", ["nahum", "nah", "nam"]],
  ["HAB", ["habakkuk", "hab"]],
  ["ZEP", ["zephaniah", "zeph", "zep"]],
  ["HAG", ["haggai", "hag"]],
  ["ZEC", ["zechariah", "zech", "zec"]],
  ["MAL", ["malachi", "mal"]],
  ["MAT", ["matthew", "matt", "mt", "mat"]],
  ["MRK", ["mark", "mrk", "mk"]],
  ["LUK", ["luke", "luk", "lk"]],
  ["JHN", ["john", "jhn", "jn", "joh"]],
  ["ACT", ["acts", "act"]],
  ["ROM", ["romans", "rom", "rm"]],
  ["1CO", ["1corinthians", "1cor", "1co"]],
  ["2CO", ["2corinthians", "2cor", "2co"]],
  ["GAL", ["galatians", "gal"]],
  ["EPH", ["ephesians", "eph", "ephes"]],
  ["PHP", ["philippians", "phil", "php"]],
  ["COL", ["colossians", "col"]],
  ["1TH", ["1thessalonians", "1thess", "1thes", "1th"]],
  ["2TH", ["2thessalonians", "2thess", "2thes", "2th"]],
  ["1TI", ["1timothy", "1tim", "1ti"]],
  ["2TI", ["2timothy", "2tim", "2ti"]],
  ["TIT", ["titus", "tit"]],
  ["PHM", ["philemon", "phlm", "phm"]],
  ["HEB", ["hebrews", "heb"]],
  ["JAS", ["james", "jas"]],
  ["1PE", ["1peter", "1pet", "1pe"]],
  ["2PE", ["2peter", "2pet", "2pe"]],
  ["1JN", ["1john", "1jn", "1jo"]],
  ["2JN", ["2john", "2jn", "2jo"]],
  ["3JN", ["3john", "3jn", "3jo"]],
  ["JUD", ["jude", "jud"]],
  ["REV", ["revelation", "rev", "apocalypse"]],
]) {
  for (const name of names) addAlias(name, code);
}

const bookRecord = (code) => BOOKS.find(([c]) => c === code) ?? null;

/** First chapter of a book, or the whole book when it has only one chapter. */
export function passageForBook(code) {
  const book = bookRecord(code);
  if (!book) return { error: "Unknown book." };
  // "Name 1" is chapter 1, and for one-chapter books (Jude, Obadiah, …) that is the whole book.
  return readPassage(`${book[1]} 1`);
}

/**
 * Classify omni-field text.
 * - `empty`
 * - `ref` — readPassage succeeds (a chapter or verse reference)
 * - `ambiguous` — a bare book name with no chapter (Job, Acts, 1 John, Song, Kings, Jn, …)
 * - `topic` — anything else
 */
export function classifyOmni(input) {
  const text = String(input ?? "").replace(/\s+/g, " ").trim();
  if (!text) return { kind: "empty", query: "" };
  const parsed = readPassage(text);
  if (!parsed.error) {
    return { kind: "ref", query: text, label: parsed.label, verses: parsed.verses };
  }
  const code = ALIASES.get(norm(text));
  if (code) {
    const passage = passageForBook(code);
    if (!passage.error) {
      return {
        kind: "ambiguous",
        query: text,
        search: text,
        label: passage.label,
        verses: passage.verses,
        book: code,
      };
    }
  }
  return { kind: "topic", query: text };
}

/** Where Enter / Go should send a classified query. */
export function routeOmniSubmit(input) {
  const classified = classifyOmni(input);
  if (classified.kind === "empty") return { action: "noop", classified };
  if (classified.kind === "topic") return { action: "topic", classified };
  return { action: "card", classified };
}

export function searchInsteadLabel(query) {
  const q = String(query ?? "").replace(/\s+/g, " ").trim();
  return q ? `Search “${q}” instead` : "Search instead";
}

/** Compact USFM id for <si-passage> from a classifyOmni verses list. */
export function versesToPassageId(verses) {
  if (!Array.isArray(verses) || verses.length === 0) return "";
  if (verses.length === 1) return verses[0];
  const first = String(verses[0]).split(".");
  const last = String(verses[verses.length - 1]).split(".");
  if (first.length < 3 || last.length < 3) return verses[0];
  if (first[0] === last[0] && first[1] === last[1]) {
    return `${first[0]}.${first[1]}.${first[2]}-${last[2]}`;
  }
  return verses[0];
}
