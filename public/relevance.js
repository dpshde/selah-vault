// Rank highlights against a passage with TypeSafe Jev (via the selah-jev Worker).
// Everything runs under a read grant on the device: the vault server never sees verses or verdicts.
//
// Two calls per judge: (1) filter — `{id}_relevant` noul for every highlight; keep those >= RELEVANT_MIN;
// (2) sort — `{id}_obviousness` score for survivors only (skipped when 0 or 1 remain). Relevant mode
// orders by strongest noul first; Surprising by least-obvious first. No reason/tagline questions.
// Switching Relevant ↔ Surprising reorders the cache with no network call. Verdicts are keyed by
// passage+id+rangeHash+BSB; a changes feed re-judges only the ids that moved.

import { readPassage } from "./passage.js";

export const JEV_URL = "https://jev.selah.tools";
export const BATCH_SIZE = 40;
/** Soft token budget per batch (~4–6k); highlights stop joining a batch past this estimate. */
export const BATCH_TOKENS = 5_000;
export const RELEVANT_MIN = 0.5;
export const BIBLE = "BSB";

const estimateTokens = (s) => Math.ceil(String(s ?? "").length / 4);

/** Stable short hash of highlight text (rangeHash), so an edit invalidates its verdict. */
export async function rangeHash(text) {
  const bytes = new TextEncoder().encode(String(text ?? ""));
  const dig = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(dig)].slice(0, 8).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function cacheKey(passageRef, highlightId, hash, bible = BIBLE) {
  return `${passageRef}\0${highlightId}\0${hash}\0${bible}`;
}

/** Split highlights into batches of ~BATCH_SIZE or ~BATCH_TOKENS. */
export function batchHighlights(highlights, { size = BATCH_SIZE, tokens = BATCH_TOKENS } = {}) {
  const batches = [];
  let cur = [], used = 0;
  for (const h of highlights) {
    const cost = estimateTokens(h.text) + 20;
    if (cur.length && (cur.length >= size || used + cost > tokens)) {
      batches.push(cur);
      cur = [];
      used = 0;
    }
    cur.push(h);
    used += cost;
  }
  if (cur.length) batches.push(cur);
  return batches;
}

export const MAX_TOPIC_CHARS = 200;

/** Trim and cap a free-text topic (same rules as the Worker). */
export function sanitizeTopic(raw) {
  const t = String(raw ?? "").replace(/\s+/g, " ").trim();
  if (!t) return "";
  return t.slice(0, MAX_TOPIC_CHARS);
}

/**
 * Build the relevance request body the selah-jev Worker accepts.
 * `ask`: `"filter"` → `{id}_relevant`; `"sort"` → `{id}_obviousness`; `"topic"` → `{id}_closeness`.
 */
export function buildRelevanceRequest({ lib, passage, highlights, ask, topic }) {
  const base = {
    lib: String(lib ?? ""),
    highlights: highlights.map((h) => ({ id: String(h.id), ref: h.ref, text: h.text })),
  };
  if (ask === "topic") {
    return { ...base, ask: "topic", topic: sanitizeTopic(topic) };
  }
  return {
    ...base,
    ask: ask === "sort" ? "sort" : "filter",
    passage: { ref: passage.ref, text: passage.text },
  };
}

/**
 * Parse a mocked or live Worker response into per-id verdicts:
 * `{ id → { relevant, relevance, obviousness, closeness } }` (no reason/tagline).
 */
export function parseVerdicts(answers = {}) {
  const byId = new Map();
  for (const [qid, ans] of Object.entries(answers)) {
    const m = /^(.*)_(relevant|obviousness|closeness)$/.exec(qid);
    if (!m) continue;
    const [, id, kind] = m;
    const row = byId.get(id) ?? { id, relevant: false, relevance: 0, obviousness: 1.5, closeness: 0 };
    if (kind === "relevant" && ans?.type === "noul") {
      row.relevance = Number(ans.noul) || 0;
      row.relevant = row.relevance >= RELEVANT_MIN;
    } else if (kind === "obviousness" && ans?.type === "score") {
      row.obviousness = Number(ans.score) || 0;
    } else if (kind === "closeness" && ans?.type === "score") {
      row.closeness = Number(ans.score) || 0;
      row.relevant = true; // topic mode keeps every highlight
    }
    byId.set(id, row);
  }
  return byId;
}

/**
 * Rank order for Related results and topic search.
 * - `closest` / `relevant` / `related`: strongest link first (default Related).
 * - `surprising`: least obvious among the relevant first.
 * - `topic`: closeness sort (every highlight kept).
 */
export function rankVerdicts(verdicts, mode) {
  if (mode === "topic") {
    return [...verdicts].sort(
      (a, b) => (b.closeness ?? 0) - (a.closeness ?? 0) || String(a.id).localeCompare(String(b.id)),
    );
  }
  const list = [...verdicts].filter((v) => v.relevant);
  if (mode === "surprising") {
    return list.sort((a, b) => a.obviousness - b.obviousness || b.relevance - a.relevance || String(a.id).localeCompare(String(b.id)));
  }
  return list.sort((a, b) => b.relevance - a.relevance || a.obviousness - b.obviousness || String(a.id).localeCompare(String(b.id)));
}

export function totalCopy(shown, librarySize) {
  return `${shown} of ${librarySize} relevant`;
}

/** Related group header, e.g. "Related to Habakkuk 2:2". Sort order is Closest|Surprising chrome, not the title. */
export function relatedCopy(label) {
  const named = String(label ?? "").trim();
  return named ? `Related to ${named}` : "Related";
}

/** Topic-mode group header, e.g. 'Results for “grace”'. Requires a real topic. */
export function topicCopy(topic) {
  const named = sanitizeTopic(topic);
  return named ? `Results for “${named}”` : "Results";
}

/** Sort-bar microcopy: short enough for one line beside the segmented control at ~390px. */
export function rankStatusCopy(shown, total, mode) {
  if (mode === "topic") return `${shown} · closest`;
  const order = mode === "surprising" ? "least obvious" : "closest";
  return `${shown} of ${total} · ${order}`;
}

/** Hint when Related is on but the person hasn't typed a passage yet. */
export function jevHintCopy(_mode) {
  return "Find the highlights in your library most closely connected to a passage.";
}

/** Primary CTA button label in the empty passage-scope state. */
export function jevCtaCopy(_mode) {
  return "Choose a passage";
}

/** List-foot status while a ranking request is in flight. */
export function rankingCopy() {
  return "Ranking…";
}

/** Fallback when the passage label isn't known yet. Prefer emptyRelevanceCopy with a count and label. */
export const EMPTY_RELEVANCE = "None of your highlights speak to this passage yet.";

/** Calm no-results line naming the library size and the passage, e.g. "None of your 17 highlights connect to Hab 2:2". */
export function emptyRelevanceCopy(count, label) {
  const n = Number(count) || 0;
  const what = n === 1 ? "highlight" : "highlights";
  const named = String(label ?? "").trim() || "this passage";
  return `None of your ${n} ${what} connect to ${named}`;
}

/** The whole-chapter reference for "try the chapter" (HAB.2.2 → HAB.2; ROM.8.18-25 → ROM.8). */
export function chapterRefOf(ref) {
  const m = /^([1-3A-Z][A-Z0-9]{2})\.(\d+)/.exec(String(ref ?? ""));
  return m ? `${m[1]}.${m[2]}` : null;
}

/** Turn network / Worker errors into a short line under the passage field (never raw "Failed to fetch"). */
export function rankErrorMessage(err) {
  const raw = String(err?.message ?? err ?? "");
  if (/failed to fetch|networkerror|load failed|network request failed/i.test(raw)) {
    return "Couldn't reach Selah Vault ranking. Check your connection and try again.";
  }
  if (/daily spend cap/i.test(raw)) return "Today's ranking budget is used up. Try again tomorrow.";
  if (/library rate limit|upstream rate limit/i.test(raw)) {
    return "Too many ranking requests. Wait a moment and try again.";
  }
  if (/ranking unavailable|jev unavailable|upstream error|bad upstream/i.test(raw)) {
    return "Selah Vault couldn't rank these highlights right now. Try again in a moment.";
  }
  if (/verse text/i.test(raw)) return "Couldn't load the Bible text for that passage. Try again.";
  return raw || "Couldn't rank highlights.";
}

/**
 * Session for one library: caches verdicts, talks to selah-jev, and re-judges from a changes feed.
 *
 * `verseText.get(ref)` → `{ text }` (createBsbText). `fetch` posts to `jevUrl`.
 */
export function createRelevance({
  lib,
  jevUrl = JEV_URL,
  fetch = globalThis.fetch.bind(globalThis),
  verseText,
} = {}) {
  /** cacheKey → verdict */
  const cache = new Map();
  /** highlightId → rangeHash last judged under the current scope */
  const hashes = new Map();
  let passage = null; // { ref, label, text }
  let topic = ""; // sanitized free-text topic for Topic mode
  let lastFetchCount = 0;

  function scopeKey() {
    if (topic) return `topic:${topic}`;
    return passage?.ref ?? "";
  }

  function verdictFor(id) {
    const scope = scopeKey();
    if (!scope) return null;
    const hash = hashes.get(id);
    if (!hash) return null;
    return cache.get(cacheKey(scope, id, hash)) ?? null;
  }

  function writeVerdict(id, patch) {
    const scope = scopeKey();
    const hash = hashes.get(id);
    if (!hash || !scope) return;
    const key = cacheKey(scope, id, hash);
    const prev = cache.get(key) ?? { id, relevant: false, relevance: 0, obviousness: 1.5, closeness: 0 };
    cache.set(key, { ...prev, ...patch, id });
  }

  async function postBatch(highlights, ask) {
    const body =
      ask === "topic"
        ? buildRelevanceRequest({ lib, highlights, ask: "topic", topic })
        : buildRelevanceRequest({ lib, passage, highlights, ask });
    let res;
    try {
      res = await fetch(jevUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch {
      // Browsers surface DNS/CORS/offline as TypeError "Failed to fetch" — keep that wording for the UI mapper.
      throw new Error("Failed to fetch");
    }
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `jev ${res.status}`);
    }
    const data = await res.json();
    return parseVerdicts(data.answers);
  }

  async function prepareItems(items) {
    // Bounded parallelism: missing BSB text used to be fetched one ref at a time,
    // which made Related / topic search feel far slower than Jev itself. Cap the
    // fan-out so the /yv proxy is not stampeded on a large library.
    const PREPARE_CONCURRENCY = 6;
    const prepared = new Array(items.length);
    let next = 0;
    async function worker() {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        const item = items[i];
        const text = item.text ?? (await verseText.get(item.ref)).text;
        const hash = await rangeHash(text);
        hashes.set(item.id, hash);
        prepared[i] = { id: item.id, ref: item.ref, text };
      }
    }
    const n = Math.min(PREPARE_CONCURRENCY, items.length);
    await Promise.all(Array.from({ length: n }, () => worker()));
    return prepared;
  }

  /**
   * Judge `items` against the current passage (Related: closest or surprising order).
   * Call 1 filters; call 2 sorts survivors (skipped when fewer than 2).
   */
  async function judge(items, mode = "relevant") {
    if (!passage) return { ranked: [], total: items.length, fetched: 0 };
    topic = "";
    const prepared = await prepareItems(items);
    lastFetchCount = 0;

    // Call 1 — filter: noul for every highlight missing a cached filter result.
    const needFilter = prepared.filter((h) => {
      const v = verdictFor(h.id);
      return !v || v._filtered !== true;
    });
    for (const batch of batchHighlights(needFilter)) {
      lastFetchCount++;
      const got = await postBatch(batch, "filter");
      for (const [id, v] of got) {
        writeVerdict(id, { relevance: v.relevance, relevant: v.relevant, _filtered: true });
      }
    }

    const survivors = prepared.filter((h) => verdictFor(h.id)?.relevant);

    // Call 2 — sort: obviousness for survivors only (skip when 0 or 1).
    if (survivors.length >= 2) {
      const needSort = survivors.filter((h) => {
        const v = verdictFor(h.id);
        return !v || v._sorted !== true;
      });
      for (const batch of batchHighlights(needSort)) {
        lastFetchCount++;
        const got = await postBatch(batch, "sort");
        for (const [id, v] of got) {
          writeVerdict(id, { obviousness: v.obviousness, _sorted: true });
        }
      }
    } else if (survivors.length === 1) {
      writeVerdict(survivors[0].id, { _sorted: true });
    }

    const verdicts = items.map((item) => verdictFor(item.id)).filter(Boolean);
    return { ranked: rankVerdicts(verdicts, mode), total: items.length, fetched: lastFetchCount };
  }

  /**
   * Topic mode: one sort call for every highlight (nothing filtered out). Closest first.
   */
  async function judgeTopic(items, rawTopic) {
    const cleaned = sanitizeTopic(rawTopic);
    if (!cleaned) return { ranked: [], total: items.length, fetched: 0 };
    passage = null;
    topic = cleaned;
    const prepared = await prepareItems(items);
    lastFetchCount = 0;
    const need = prepared.filter((h) => {
      const v = verdictFor(h.id);
      return !v || v._topicSorted !== true;
    });
    for (const batch of batchHighlights(need)) {
      lastFetchCount++;
      const got = await postBatch(batch, "topic");
      for (const [id, v] of got) {
        writeVerdict(id, { closeness: v.closeness, relevant: true, _topicSorted: true });
      }
    }
    const verdicts = items.map((item) => verdictFor(item.id)).filter(Boolean);
    return { ranked: rankVerdicts(verdicts, "topic"), total: items.length, fetched: lastFetchCount };
  }

  return {
    lib,
    get passage() {
      return passage;
    },
    get topic() {
      return topic;
    },
    get lastFetchCount() {
      return lastFetchCount;
    },
    /**
     * Set the input passage from what the person typed. Returns `{ error }` from readPassage,
     * or `{ label, ref, verses }` after loading BSB text. Nothing is sent to Jev here.
     */
    async setPassageInput(raw) {
      topic = "";
      const found = readPassage(raw);
      if (found.error) {
        passage = null;
        return found;
      }
      const ref = found.verses.length === 1
        ? found.verses[0]
        : (() => {
            // Prefer a compact range ref when the verses form one run in one chapter.
            const first = found.verses[0];
            const last = found.verses.at(-1);
            if (found.verses.length > 1 && first.replace(/\.\d+$/, "") === last.replace(/\.\d+$/, "")) {
              const a = first.split("."), b = last.split(".");
              return `${a[0]}.${a[1]}.${a[2]}-${b[2]}`;
            }
            return first;
          })();
      verseText.first?.(ref);
      const { text, html } = await verseText.get(ref);
      passage = { ref, label: found.label, text, html, verses: found.verses };
      return { label: found.label, ref, verses: found.verses };
    },
    setTopicInput(raw) {
      passage = null;
      topic = sanitizeTopic(raw);
      return topic;
    },
    clearPassage() {
      passage = null;
      topic = "";
    },
    /** Reorder cached verdicts for `items` with no network call. */
    reorder(items, mode) {
      const verdicts = items.map((item) => verdictFor(item.id)).filter(Boolean);
      lastFetchCount = 0;
      return { ranked: rankVerdicts(verdicts, mode), total: items.length, fetched: 0 };
    },
    judge,
    judgeTopic,
    /**
     * Apply a grant-client changes feed: drop deleted ids, and forget upserts so the next judge
     * re-asks only for those. Verse-level refs also invalidate any run id that covers them.
     * `reset` clears every cached verdict for this library session.
     */
    applyChanges({ upserts = [], deletions = [], reset = false } = {}) {
      if (reset) {
        cache.clear();
        hashes.clear();
        return;
      }
      const touched = new Set([
        ...deletions.map(String),
        ...upserts.map((u) => String(u.ref ?? u.id)),
      ]);
      const drop = (id) => {
        hashes.delete(id);
        for (const key of [...cache.keys()]) {
          const parts = key.split("\0");
          if (parts[1] === id) cache.delete(key);
        }
      };
      for (const id of [...hashes.keys()]) {
        if (touched.has(id)) {
          drop(id);
          continue;
        }
        // Run ids like ROM.5.3-5: invalidate when any of their verses changed.
        const m = /^([1-3A-Z][A-Z0-9]{2})\.(\d+)\.(\d+)-(\d+)$/.exec(id);
        if (!m) continue;
        for (let v = Number(m[3]); v <= Number(m[4]); v++) {
          if (touched.has(`${m[1]}.${m[2]}.${v}`)) {
            drop(id);
            break;
          }
        }
      }
      for (const ref of touched) drop(ref);
    },
    /** Test helper: seed a verdict without calling Jev. */
    put(passageRef, id, hash, verdict) {
      hashes.set(id, hash);
      cache.set(cacheKey(passageRef, id, hash), { _filtered: true, _sorted: true, ...verdict, id });
    },
  };
}
