import {
  COLORS, Library, now, palette, topColor, parseJsonl, serverTransport,
} from "./sync.js";
import { labelRef, compareRefs } from "./refs.js";
import { editRun, highlightRecord, tombstone, groupRuns } from "./ranges.js";
import { readPassage } from "./passage.js";
import { MODES, RANK_MODES, LEGACY_TOPIC_MODE, LEGACY_RELATED_MODES, JEV_MODES, groupList, startsOpen } from "./groups.js";
import { definePassageInput, defineScripturePassage } from "./vendor/scripture-inline.js";
import {
  cancelled,
  fetchSession,
  fetchSignInMethods,
  loginWithPasskey,
  passkeysAvailable,
  registerPasskey,
  removeSignInMethod,
  renamePasskey,
  sendEmailCode,
  signInWithApple,
  signOutSession,
  verifyEmailCode,
} from "./passkey.js";
import { clientInfo } from "./grants.js";
import { setupThemeToggle } from "./theme-toggle.js";
import { registerSelahVaultTools } from "./webmcp.js";
import { armDelete } from "./confirm.js";
import { defineKeepingLoaded, createWarmer } from "./passage-warm.js";
import { createBsbText } from "./bsb-text.js";
import {
  createRelevance,
  emptyRelevanceCopy,
  chapterRefOf,
  totalCopy,
  relatedCopy,
  topicCopy,
  rankStatusCopy,
  jevHintCopy,
  jevCtaCopy,
  rankingCopy,
  rankErrorMessage,
  sanitizeTopic,
} from "./relevance.js";

const $ = (sel) => document.querySelector(sel);
const SESSION = "selah-vault:session";
const SAVE_LINK = "selah-vault:save-link";
// How this device sorts the list (date / genre / related): a display choice, not synced.
const GROUP_BY = "selah-vault:group-by";
const RELATED_SORT = "selah-vault:related-sort";
const nameKey = (lib) => `selah-vault:name:${lib}`;
const store = {
  load: (lib) => JSON.parse(localStorage.getItem(`selah-vault:${lib}`) ?? "null"),
  save: (lib, state) => localStorage.setItem(`selah-vault:${lib}`, JSON.stringify(state)),
  clear: (lib) => localStorage.removeItem(`selah-vault:${lib}`),
};
const settingsKey = (lib) => `selah-vault:settings:${lib}`;
const settings = (lib) => ({ server: true, ...JSON.parse(localStorage.getItem(settingsKey(lib)) ?? "{}") });
const saveSettings = (lib, s) => localStorage.setItem(settingsKey(lib), JSON.stringify(s));
const filtersKey = (lib) => `selah-vault:filters:${lib}`;

let library = null;
let colors = palette([]);
/** Multi-select color filter ids (empty Set = show all). */
let filter = new Set();
let flashTimer = 0;

function saveFilters() {
  if (!library) return;
  try {
    if (filter.size) localStorage.setItem(filtersKey(library.lib), JSON.stringify([...filter]));
    else localStorage.removeItem(filtersKey(library.lib));
  } catch {}
}

// The screens with a library open. The footer says only whether one is: never the key, never sync.
const SIGNED_IN = new Set(["main", "colors", "backup", "sync", "account"]);

function show(id) {
  for (const section of document.querySelectorAll("main > section")) section.hidden = section.id !== id;
  const label = SIGNED_IN.has(id) ? "Signed in" : "Signed out";
  const status = $("#auth-status");
  if (status) {
    status.textContent = label;
    status.hidden = false;
  }
  const menu = $("#menu");
  if (menu?.open) menu.open = false;
  const filters = $("#filters");
  if (filters?.open) filters.open = false;
}

/** Shows a passing message, with an optional button such as `{ label: "Undo", run, ms }`. */
function flash(text, action) {
  const el = $("#flash");
  el.replaceChildren(text);
  if (action) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = action.label;
    button.addEventListener("click", async () => {
      el.replaceChildren();
      await action.run();
    });
    el.append(" ", button);
  }
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => el.replaceChildren(), action ? (action.ms ?? 15_000) : 6000);
}

const errorIn = (form, text) => (form.querySelector(".error").textContent = text);
const capitalized = (s) => s[0].toUpperCase() + s.slice(1);
const colorName = (c) => c.name || (c.builtIn ? capitalized(c.id) : "Color");

function paint(el, id) {
  const c = colors.find((x) => x.id === id) ?? colors[0];
  el.dataset.color = c.builtIn ? c.id : "own";
  el.style.background = c.builtIn ? "" : c.hex;
}

// ---- signing in, offline local mode, signing out

let signedInUser = null;
let connected = null;

async function enter({ id, name: given = "Personal", online = true } = {}) {
  signedInUser = online ? { id, name: given } : null;
  library = await Library.open({ userId: id, name: given, store });
  library.localName = localStorage.getItem(nameKey(library.lib)) || given;
  try {
    const saved = JSON.parse(localStorage.getItem(filtersKey(library.lib)) ?? "[]");
    filter = new Set(Array.isArray(saved) ? saved : []);
  } catch {
    filter = new Set();
  }
  highlightStamp = new Map();
  relevance = null;
  rankOrder = [];
  clearRelevanceInput();
  showName();
  library.onChange(render);
  library.onChange(showName);
  show("main");
  renderGroupBy(true);
  render();
  await saveFromLink();
  await connect();
  connected = library;
  showName();
}

async function connect() {
  renderSync();
  const useRemote = Boolean(signedInUser && settings(library.lib).server);
  await library.use(useRemote ? [serverTransport()] : []);
}

function showName() {
  if (!library) return;
  const name = library.name;
  if (document.activeElement !== $("#lib-name") && $("#lib-name").textContent !== name) $("#lib-name").textContent = name;
  if (localStorage.getItem(nameKey(library.lib)) !== name) localStorage.setItem(nameKey(library.lib), name);
  localStorage.setItem(SESSION, JSON.stringify({ id: library.lib, name, online: !!signedInUser }));
  if (connected === library && library.syncedName === null && ["synced", "local"].includes(library.status.state)) library.adoptName();
}

async function lock() {
  library?.forget();
  library = null;
  signedInUser = null;
  localStorage.removeItem(SESSION);
  await signOutSession();
  $("#menu").open = false;
  $("#passkey-offer").hidden = true;
  document.querySelectorAll("form").forEach((f) => f.reset());
  $("#email-verify-form").hidden = true;
  $("#email-send-form").hidden = false;
  show("start");
}

let pendingEmail = "";

$("#passkey-login")?.addEventListener("click", async () => {
  $("#start-error").textContent = "";
  try {
    const res = await loginWithPasskey();
    const user = res?.user ?? (await fetchSession());
    await enter({ id: user?.id || "personal", name: user?.name || "Personal", online: true });
  } catch (error) {
    if (!cancelled(error)) $("#start-error").textContent = error.message;
  }
});

$("#create-passkey")?.addEventListener("click", async () => {
  $("#start-error").textContent = "";
  try {
    const res = await registerPasskey({ name: "Personal" });
    const user = res?.user ?? (await fetchSession());
    await enter({ id: user?.id || "personal", name: user?.name || "Personal", online: true });
    flash("Library ready.");
  } catch (error) {
    if (!cancelled(error)) $("#start-error").textContent = error.message;
  }
});

$("#email-send-form")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  $("#start-error").textContent = "";
  const email = String(new FormData(e.target).get("email") ?? "").trim();
  if (!email) return;
  try {
    await sendEmailCode(email);
    pendingEmail = email;
    $("#email-sent-note").textContent = `Enter the 6-digit code sent to ${email}.`;
    $("#email-send-form").hidden = true;
    $("#email-verify-form").hidden = false;
    $("#otp-input")?.focus();
  } catch (error) {
    $("#start-error").textContent = error.message;
  }
});

$("#email-back")?.addEventListener("click", () => {
  $("#start-error").textContent = "";
  $("#email-verify-form").hidden = true;
  $("#email-send-form").hidden = false;
  $("#email-input")?.focus();
});

$("#email-verify-form")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  $("#start-error").textContent = "";
  const code = String(new FormData(e.target).get("code") ?? "").trim();
  try {
    const res = await verifyEmailCode(pendingEmail, code);
    const user = res?.user ?? (await fetchSession());
    await enter({ id: user?.id || "personal", name: user?.name || "Personal", online: true });
    if (passkeysAvailable()) $("#passkey-offer").hidden = false;
  } catch (error) {
    $("#start-error").textContent = error.message;
  }
});

$("#apple-login")?.addEventListener("click", async () => {
  $("#start-error").textContent = "";
  try {
    if (globalThis.AppleID?.auth) {
      const resp = await globalThis.AppleID.auth.signIn();
      const idToken = resp?.authorization?.id_token;
      if (!idToken) throw new Error("Apple did not return an identity token.");
      const fullName = [resp?.user?.name?.firstName, resp?.user?.name?.lastName].filter(Boolean).join(" ").trim();
      const res = await signInWithApple(idToken, { name: fullName || undefined });
      const user = res?.user ?? (await fetchSession());
      await enter({ id: user?.id || "personal", name: user?.name || "Personal", online: true });
      return;
    }
    location.assign("/unlock");
  } catch (error) {
    if (!cancelled(error)) $("#start-error").textContent = error.message;
  }
});

$("#open-offline")?.addEventListener("click", async () => {
  $("#start-error").textContent = "";
  await enter({ id: "offline", name: "Personal", online: false });
});

// ---- highlights

// The add form's color: one dot showing it, which opens the shared color popover to change it. The
// choice lives in the form's hidden "color" input, so submitting reads it like any field.
const addColor = $("#add").elements.namedItem("color");
const addDot = $("#add-dot");

function renderAddColor() {
  if (!colors.some((c) => c.id === addColor.value)) addColor.value = colors[0].id; // its color was deleted
  const c = colors.find((x) => x.id === addColor.value);
  paint(addDot.querySelector(".dot"), c.id);
  addDot.setAttribute("aria-label", `Highlight color: ${colorName(c)}`);
  addDot.title = `Highlight color: ${colorName(c)}`;
}

addDot.addEventListener("click", () =>
  openColorPicker(addDot, addColor.value, (id) => {
    addColor.value = id;
    renderAddColor();
  }),
);

/**
 * Highlights whole verses in one color. A verse already highlighted keeps when it was first. Returns
 * a function that puts back what the verses were before.
 */
async function highlight(verses, color) {
  const t = now();
  const before = verses.map((v) => library.find("highlight", v));
  await library.putMany(verses.map((v, i) => highlightRecord(before[i], v, color, t)));
  return () => library.putMany(verses.map((v, i) => before[i] ?? tombstone(v)));
}

// The reference field is scripture-inline's <si-passage-input>: book, chapter and verse suggestions
// as people type. Its value is a USFM id like ROM.5.3-5 once it reads a passage.
// Related hijacks the same field as the ranking scope (no second passage box).
definePassageInput();
const refField = $("#ref");
const REF_ADD = { placeholder: "John 3:16", aria: "Verse or passage" };
const REF_RANK = { placeholder: "Rom 8:18–25", aria: "Passage to rank highlights against" };
/** Last #ref string that started a Related commit (dedupes change+blur). Cleared while typing. */
let lastRelatedCommitKey = "";
/** What's in a passage field: its passage id when it read one, else the typed text, which readPassage reads
 * more loosely (the field won't take passages across chapters, like Genesis 1–2, but Selah Vault does). */
function refText(field = refField) {
  const typed = field.shadowRoot?.querySelector("input")?.value ?? "";
  return field.value && field.validity.valid ? field.value : typed;
}
/** Whether the field's suggestion list is showing (Enter and Escape act on it first). */
const suggesting = (field) => field.shadowRoot?.querySelector("[role=listbox]")?.hidden === false;

/** Sanitized text in the list-bar topic search, or "" when empty. */
function topicQuery() {
  return sanitizeTopic($("#topic-search")?.value ?? "");
}

/**
 * While topic search is open (or has a query), hide #add so only one text field is visible.
 * Collapse restores the add/rank row; Relevant/Surprising epigraph returns via showRankPreview.
 */
function syncAddHiddenForTopicSearch(searchOpen) {
  const form = $("#add");
  if (form) form.hidden = searchOpen;
  if (searchOpen) {
    const epigraph = $("#rank-epigraph");
    if (epigraph) {
      epigraph.hidden = true;
      epigraph.textContent = "";
    }
  } else if (!topicQuery() && RANK_MODES.includes(groupBy) && relevance?.passage) {
    showRankPreview(relevance.passage);
  }
}

/** Expand the list-bar topic search from its resting icon into the text field. */
function openTopicSearch({ focus = true } = {}) {
  const wrap = $("#topic-search-wrap");
  const toggle = $("#topic-search-toggle");
  const field = $("#topic-search");
  const close = $("#topic-search-close");
  if (!wrap || !toggle || !field) return;
  wrap.classList.add("is-open");
  toggle.setAttribute("aria-expanded", "true");
  field.tabIndex = 0;
  if (close) close.tabIndex = 0;
  syncAddHiddenForTopicSearch(true);
  if (focus) field.focus();
}

/**
 * Collapse topic search back to the icon. Stays expanded while the query is non-empty
 * unless `force` (close ×, Escape, or empty outside tap). Restores #add.
 */
function closeTopicSearch({ force = false } = {}) {
  if (!force && topicQuery()) return;
  const wrap = $("#topic-search-wrap");
  const toggle = $("#topic-search-toggle");
  const field = $("#topic-search");
  const close = $("#topic-search-close");
  if (!wrap || !toggle || !field) return;
  wrap.classList.remove("is-open");
  toggle.setAttribute("aria-expanded", "false");
  field.tabIndex = -1;
  if (close) close.tabIndex = -1;
  syncAddHiddenForTopicSearch(false);
}

/**
 * Fully exit topic search: clear any query (same path as typing empty), collapse chrome, restore #add.
 * One Escape / close × always lands back on highlight chrome — never stuck with #add hidden.
 */
function exitTopicSearch({ focusToggle = true } = {}) {
  const field = $("#topic-search");
  const toggle = $("#topic-search-toggle");
  if (field && topicQuery()) {
    field.value = "";
    field.dispatchEvent(new Event("input", { bubbles: true }));
  }
  closeTopicSearch({ force: true });
  if (focusToggle) toggle?.focus();
}

/** Map Closest|Surprising chrome to the rankVerdicts mode key (relevant = closest-first). */
function relatedRankMode() {
  return relatedSort === "surprising" ? "surprising" : "relevant";
}

/** Show Closest|Surprising only once Related has a non-empty ranked list (hide while empty/loading/search). */
function syncRelatedSortChrome(show) {
  const bar = $("#related-sort");
  if (!bar) return;
  bar.hidden = !show;
  for (const b of bar.querySelectorAll("[data-related-sort]")) {
    b.setAttribute("aria-pressed", String(b.dataset.relatedSort === relatedSort));
  }
}

/** Swap #add between add-highlight and passage-ranking (#ref) chrome. Topic search is orthogonal in #list-bar. */
function syncRefFieldMode() {
  const ranking = RANK_MODES.includes(groupBy);
  const meta = ranking ? REF_RANK : REF_ADD;
  refField.setAttribute("placeholder", meta.placeholder);
  refField.setAttribute("aria-label", meta.aria);
  // si-passage-input copies aria-label only on connect; keep the inner input in sync.
  refField.shadowRoot?.querySelector("input")?.setAttribute("aria-label", meta.aria);
  refField.hidden = false;
  const form = $("#add");
  form.classList.toggle("rank-scope", ranking);
  $("#add-dot").hidden = ranking;
  form.querySelector('button[type="submit"]').hidden = ranking;
}

/**
 * Related ranks on commit only (Enter / autocomplete change / blur with a passage) — never while typing.
 * Dedupes change+blur for the same ref so one pick does not double-fetch.
 */
function commitRelatedRank() {
  if (!RANK_MODES.includes(groupBy) || topicQuery()) return;
  const key = String(refText(refField)).trim();
  // Dedupe change+blur; allow retry after a failed commit for the same ref.
  if (key && key === lastRelatedCommitKey && !rankFailed) return;
  lastRelatedCommitKey = key;
  void runRelevance();
}

// Enter: settle suggestions first; else rank (Related) or add a highlight (Date/Genre).
refField.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" || e.isComposing) return;
  if (suggesting(refField)) return;
  if (RANK_MODES.includes(groupBy)) {
    e.preventDefault();
    commitRelatedRank();
    return;
  }
  $("#add").requestSubmit();
});

$("#add").addEventListener("submit", async (e) => {
  e.preventDefault();
  // Ranking modes never add from this form — #ref is the scope field (Highlight is hidden).
  if (RANK_MODES.includes(groupBy)) {
    commitRelatedRank();
    return;
  }
  const form = e.target;
  const found = readPassage(refText());
  if (found.error) return errorIn(form, found.error);
  errorIn(form, "");
  await highlight(found.verses, new FormData(form).get("color"));
  refField.value = "";
});

// ---- saving from a link: /save?ref=John+3:16&color=blue

/** Keeps a /save link's request until a library is open, even across unlocking or creating one. */
function takeSaveLink() {
  if (location.pathname !== "/save") return null;
  const query = new URLSearchParams(location.search);
  const request = { ref: query.get("ref") ?? "", color: query.get("color") ?? "" };
  sessionStorage.setItem(SAVE_LINK, JSON.stringify(request));
  history.replaceState(null, "", "/");
  return request;
}

/** A color by id or by name ("blue", "Prayer"), else yellow. */
function colorFor(wanted) {
  const w = wanted.trim().toLowerCase();
  return colors.find((c) => c.id === w) ?? colors.find((c) => colorName(c).toLowerCase() === w) ?? colors[0];
}

async function saveFromLink() {
  const request = JSON.parse(sessionStorage.getItem(SAVE_LINK) ?? "null");
  if (!request) return;
  sessionStorage.removeItem(SAVE_LINK);
  $("#start-note").hidden = true;
  const found = readPassage(request.ref);
  if (found.error) return flash(`Nothing saved. ${found.error}`);
  const color = colorFor(request.color);
  const undo = await highlight(found.verses, color.id);
  flash(`Saved ${found.label} in ${colorName(color)}.`, { label: "Undo", run: undo });
}

/** What the list was last built from (see render). */
let listSig = null;
/** Ordered highlight refs for the current Jev result (no reason/tagline attached). */
let rankOrder = [];
let rankPending = null;
/** True after a ranking call failed: keep Date order and the inline error; never "0 of N relevant". */
let rankFailed = false;
/** Bumps whenever a new ranking run starts (or the input changes); stale responses are ignored. */
let rankGeneration = 0;
/**
 * Bumps on each new final paint that may auto-expand (new query, or Relevant ↔ Surprising reorder).
 * Separate from rankGeneration so a cache-only mode switch still re-targets the top row.
 */
let rankPaint = 0;
/** Paint id we already auto-expanded for (once per paint). */
let rankExpandPaint = -1;
/** True after the person toggles a row open/closed during the current query — skip auto-expand. */
let rankUserTouched = false;

function render() {
  if (!library) return;
  colors = palette(library.all("color"));
  renderAddColor();
  syncRelevanceCache();

  const ids = colors.map((c) => c.id);
  const rows = library.all("highlight").sort((a, b) => compareRefs(a.ref, b.ref));
  const counts = new Map();
  for (const r of rows) counts.set(topColor(r, ids), (counts.get(topColor(r, ids)) ?? 0) + 1);
  let filterPruned = false;
  for (const id of filter) {
    if (!counts.has(id)) {
      filter.delete(id);
      filterPruned = true;
    }
  }
  if (counts.size <= 1 && filter.size) {
    filter.clear();
    filterPruned = true;
  }
  if (filterPruned) saveFilters();
  renderFilters(counts);

  const shown = filter.size ? rows.filter((r) => filter.has(topColor(r, ids))) : rows;
  // Topic search in #list-bar owns the list while it has a query; modes stay visible underneath.
  const searching = !!topicQuery();
  const jevActive = RANK_MODES.includes(groupBy) && !searching;
  // Scope is path-specific: a leftover Related passage must not count as topic search scope (and vice versa).
  const hasScope = searching ? !!relevance?.topic : jevActive ? !!relevance?.passage : false;
  // A failed call keeps Date order. Pending keeps Jev chrome (skeleton) after commit before results land.
  const ranking = (searching || jevActive) && !rankFailed && (hasScope || rankPending);
  // Mid-type (commit-only ranking): typed text, no committed scope yet — clear list without the empty CTA.
  const relatedDrafting = jevActive && !hasScope && !rankPending && !!String(refText(refField)).trim();
  const topicDrafting = searching && !rankPending && !hasScope;
  // Related with nothing committed yet: empty list + hint (never a stale Date "Today" header).
  // Empty topic search shows no CTA panel — only the quiet field placeholder.
  const jevWaiting = jevActive && !rankFailed && !hasScope && !rankPending && !relatedDrafting;
  const noneRelevant =
    ranking && !rankPending && !searching && !!relevance?.passage && RANK_MODES.includes(groupBy) && rankOrder.length === 0 && shown.length > 0;
  $("#empty").hidden = rows.length > 0;
  $("#empty").textContent = "No highlights yet.";
  showRelevanceNone(noneRelevant ? { count: shown.length, passage: relevance.passage } : null);
  showRankPreview(ranking && !rankPending && !searching && relevance?.passage && RANK_MODES.includes(groupBy) ? relevance.passage : null);
  renderGroupBy(rows.length > 0);
  // A row being edited stays as it is until the edit ends (a sync mid-edit would wipe the field);
  // finishing the edit renders again.
  // Rebuild the list only when what it shows changed. A sync that brings nothing new (every window
  // focus runs one) still emits for its status; rebuilding then would move the open passage and
  // replay its opening animation.
  const scopeKey = searching
    ? relevance?.topic || ""
    : RANK_MODES.includes(groupBy)
      ? relevance?.passage?.ref || ""
      : "";
  // verseText.open is omitted: expand/collapse is local (wireTextToggle/showText). Including it
  // remounted the whole list on every open/close whenever another render ran.
  const sig = JSON.stringify([shown, colors, groupBy, relatedSort, [...filter], verseText.key, editing, ranking && scopeKey, rankOrder, rankFailed, noneRelevant, !!rankPending, jevWaiting, relatedDrafting, topicDrafting, searching, rankPaint]);
  let showRelatedSort = false;
  if (!editing && sig !== listSig) {
    if (jevWaiting) {
      // Actionable empty scope CTA in the list area; foot status stays empty.
      $("#list-total").textContent = "";
      const box = document.createElement("div");
      box.className = "offer rank-empty";
      box.setAttribute("role", "status");
      const hint = document.createElement("p");
      hint.className = "rank-hint";
      hint.textContent = jevHintCopy(groupBy);
      const row = document.createElement("div");
      row.className = "row";
      const cta = document.createElement("button");
      cta.type = "button";
      cta.className = "quiet rank-cta";
      cta.textContent = jevCtaCopy(groupBy);
      cta.addEventListener("click", () => {
        refField?.focus();
        refField?.suggest?.();
      });
      row.append(cta);
      box.append(hint, row);
      $("#list").replaceChildren(box);
      showRankPreview(null);
      $("#empty").hidden = true;
    } else if (relatedDrafting || topicDrafting) {
      // Typing before commit: clear stale ranked UI without Ranking… or the empty CTA.
      $("#list-total").textContent = "";
      $("#list").replaceChildren();
      showRankPreview(null);
      $("#empty").hidden = true;
    } else if (ranking) {
      const runs = groupRuns(shown, (r) => topColor(r, ids));
      const byRef = new Map(runs.map((run) => [run.ref, run]));
      const ranked = rankOrder.map((id) => byRef.get(id)).filter(Boolean);
      if (rankPending) {
        $("#list-total").textContent = rankingCopy();
        $("#list").replaceChildren(rankSkeleton(Math.min(Math.max(shown.length, 3), 5)));
      } else if (ranked.length) {
        const heading = searching
          ? topicCopy(relevance?.topic)
          : relatedCopy(relevance?.passage?.label);
        $("#list-total").textContent = rankStatusCopy(
          ranked.length,
          shown.length,
          searching ? "topic" : relatedRankMode(),
        );
        // New final paint: expand the new top unless the person toggled a row this query.
        applyRankAutoExpand(ranked[0].ref);
        // Same group()/row() markup as Date and Genre — only the heading text differs.
        const rankedGroup = group({ id: "ranked", name: heading, runs: ranked });
        rankedGroup.classList.add("rank-enter");
        $("#list").replaceChildren(rankedGroup);
        // Closest|Surprising is results chrome for Related — not for topic search.
        showRelatedSort = !searching && RANK_MODES.includes(groupBy);
      } else {
        // Zero survivors (passage modes). Topic search keeps every highlight, so this is rare.
        // Never put topicCopy in the foot with an empty list.
        $("#list-total").textContent = searching ? "" : RANK_MODES.includes(groupBy) ? totalCopy(0, shown.length) : "";
        $("#list").replaceChildren();
      }
      $("#empty").hidden = true; // library has rows; zero relevant uses #relevance-none, not #empty
    } else {
      // Date/Genre, or a failed Jev/search call: Date/Genre grouping (failed stays in Date order).
      const mode = jevActive || searching ? "date" : groupBy;
      const groups = groupList(shown, mode, (r) => topColor(r, ids));
      const total = groups.reduce((n, g) => n + g.runs.length, 0);
      $("#list-total").textContent = `${total} ${total === 1 ? "highlight" : "highlights"}`;
      $("#list").replaceChildren(...groups.map(group));
      showRankPreview(null);
    }
    syncRelatedSortChrome(showRelatedSort);
  } else if (!editing) {
    // Sig unchanged: still refresh Closest|Surprising pressed state if results are showing.
    const rankedVisible = ranking && !rankPending && rankOrder.length > 0 && !searching && RANK_MODES.includes(groupBy);
    syncRelatedSortChrome(!!rankedVisible);
  }
  listSig = editing ? null : sig;
  if (!$("#colors").hidden) renderColors();
  scheduleListScrollFade();
}

/**
 * Soft top/bottom fade on the highlights list while content overflows the scrollport.
 * `data-fade` is top | bottom | both — only the edges that still have more content beyond them.
 * Top overlay tint matches the surface under it: group header → --accent; else shell --bg
 * (avoids a cream smear over dark "Last 7 days" bars).
 */
function syncListScrollFade() {
  const list = $("#list");
  if (!list) return;
  const { scrollTop, scrollHeight, clientHeight } = list;
  const overflow = scrollHeight > clientHeight + 1;
  let fade = "";
  if (overflow) {
    const showTop = scrollTop > 1;
    const showBottom = scrollTop + clientHeight < scrollHeight - 1;
    fade = showTop && showBottom ? "both" : showTop ? "top" : showBottom ? "bottom" : "";
  }
  if (fade) list.dataset.fade = fade;
  else delete list.dataset.fade;

  if (fade === "top" || fade === "both") {
    const rect = list.getBoundingClientRect();
    const sampleY = rect.top + 4;
    const sampleX = rect.left + Math.min(24, Math.max(8, rect.width / 2));
    const hit = document.elementFromPoint(sampleX, sampleY);
    if (hit?.closest?.("#list .group > summary")) list.dataset.fadeTop = "accent";
    else delete list.dataset.fadeTop;
  } else {
    delete list.dataset.fadeTop;
  }
}

function scheduleListScrollFade() {
  requestAnimationFrame(syncListScrollFade);
}

{
  const list = $("#list");
  if (list) {
    list.addEventListener("scroll", syncListScrollFade, { passive: true });
    // Group open/close and verse expand change scrollHeight without resizing #list's box.
    list.addEventListener("toggle", scheduleListScrollFade, true);
    new ResizeObserver(scheduleListScrollFade).observe(list);
  }
  addEventListener("resize", scheduleListScrollFade, { passive: true });
}

/** Start a new auto-expand paint (new query results, or Closest ↔ Surprising reorder). */
function beginRankPaint({ resetUser = false } = {}) {
  rankPaint++;
  rankExpandPaint = -1;
  if (resetUser) rankUserTouched = false;
}

/**
 * On a new final paint, open the top result once — collapsing whatever a previous paint auto-opened.
 * If the person opened/closed a row during this query, leave their choice alone.
 */
function applyRankAutoExpand(topRef) {
  if (!verseText.key || !topRef) return;
  if (rankExpandPaint === rankPaint) return;
  rankExpandPaint = rankPaint;
  if (rankUserTouched) return;
  verseText.open = topRef;
}

// ---- grouping / ranking: Date and Genre group; Related ranks against a passage (Closest|Surprising order).
// Topic search is orthogonal chrome in #list-bar (not a mode).

/** Load persisted mode; migrate legacy Topic → Date and Relevant/Surprising → Related. */
function readGroupBy() {
  const stored = localStorage.getItem(GROUP_BY) ?? "";
  if (stored === LEGACY_TOPIC_MODE) {
    localStorage.setItem(GROUP_BY, "date");
    return "date";
  }
  if (LEGACY_RELATED_MODES.includes(stored)) {
    // Keep Surprising preference as the Closest|Surprising order after the mode merge.
    if (stored === "surprising") localStorage.setItem(RELATED_SORT, "surprising");
    localStorage.setItem(GROUP_BY, "related");
    return "related";
  }
  return MODES.includes(stored) ? stored : "date";
}

function readRelatedSort() {
  return localStorage.getItem(RELATED_SORT) === "surprising" ? "surprising" : "closest";
}

let groupBy = readGroupBy();
/** Related results order: closest (default) or surprising — not a list mode. */
let relatedSort = readRelatedSort();
const groupOpen = new Map();
let relevance = null;
const bsbText = createBsbText();
/** ref → updated, for change-only re-judging. */
let highlightStamp = new Map();

function renderGroupBy(any) {
  $("#group-by").hidden = !any;
  $("#group-by-select").hidden = !any;
  $("#group-by-select").value = groupBy;
  $("#list-bar").hidden = !any;
  syncRefFieldMode();
  for (const b of document.querySelectorAll("#group-by button")) b.setAttribute("aria-pressed", String(b.dataset.mode === groupBy));
}

function selectMode(next) {
  if (!MODES.includes(next) || next === groupBy) return;
  const wasJev = JEV_MODES.includes(groupBy);
  const willJev = JEV_MODES.includes(next);
  const wasPassage = RANK_MODES.includes(groupBy);
  const willPassage = RANK_MODES.includes(next);
  const searching = !!topicQuery();
  groupBy = next;
  localStorage.setItem(GROUP_BY, groupBy);
  // Leaving Related: clear ranking scope from #ref so Date/Genre don't inherit it as an add.
  // Topic search stays — it is orthogonal chrome, not a mode.
  if (wasPassage && !willPassage) clearRankScopeFromRef();
  if (wasJev && !willJev && !searching) clearRelevanceInput({ keepRef: wasPassage, keepSearch: true });
  // Entering Related from Date/Genre: start with an empty rank field (don't rank a half-typed add).
  if (willPassage && !wasPassage) {
    refField.value = "";
    errorIn($("#add"), "");
  }
  renderGroupBy(!!$("#list-bar") && !$("#list-bar").hidden);
  // Search owns the list until cleared; only persist the mode for when the field empties.
  if (searching) {
    render();
    return;
  }
  if (willPassage && refText(refField).trim()) {
    void runRelevance();
  } else {
    if (willPassage) relevance?.clearPassage();
    rankOrder = [];
    rankFailed = false;
    verseText.open = null;
    beginRankPaint({ resetUser: true });
    render();
  }
}

/** Closest | Surprising results order for Related (reorders cached verdicts; no new network call). */
function selectRelatedSort(next) {
  if (next !== "closest" && next !== "surprising") return;
  if (relatedSort === next) return;
  relatedSort = next;
  localStorage.setItem(RELATED_SORT, relatedSort);
  syncRelatedSortChrome(true);
  if (!RANK_MODES.includes(groupBy) || topicQuery() || !relevance?.passage || rankFailed) {
    render();
    return;
  }
  beginRankPaint();
  void reorderRelevance();
}

for (const b of document.querySelectorAll("#group-by button")) {
  b.addEventListener("click", () => selectMode(b.dataset.mode));
}
$("#group-by-select").addEventListener("change", (e) => selectMode(e.target.value));
for (const b of document.querySelectorAll("#related-sort [data-related-sort]")) {
  b.addEventListener("click", () => selectRelatedSort(b.dataset.relatedSort));
}

/** Clear #ref ranking text and restore add-mode placeholder/aria (Highlight stays until renderGroupBy). */
function clearRankScopeFromRef() {
  lastRelatedCommitKey = "";
  refField.value = "";
  errorIn($("#add"), "");
}

function clearRelevanceInput({ keepRef = false, keepSearch = false } = {}) {
  if (!keepRef) clearRankScopeFromRef();
  if (!keepSearch) {
    const topicField = $("#topic-search");
    if (topicField) topicField.value = "";
  }
  errorIn($("#add"), "");
  rankGeneration++; // drop any in-flight response
  relevance?.clearPassage();
  rankOrder = [];
  rankPending = null;
  rankFailed = false;
  beginRankPaint({ resetUser: true });
  verseText.open = null;
  showRelevanceNone(null);
  showRankPreview(null);
  // Collapse after clearing passage so syncAddHiddenForTopicSearch doesn't revive the epigraph.
  if (!keepSearch) closeTopicSearch({ force: true });
}

/**
 * Threshold for the hybrid Relevant/Surprising passage preview:
 * - Short passages (≤ 2 verses and ≤ 200 chars, roughly ≤ 2 lines at the 32rem Vault measure):
 *   Option 1 — quiet left-ruled epigraph (#rank-epigraph) directly under #ref, no repeated title or box.
 * - Longer passages (> 2 verses or > 200 chars, e.g. multi-verse ranges or whole chapters):
 *   Option 3 — one-line collapsible strip (#rank-preview) that expands to show the BSB text with verse numbers.
 */
const SHORT_PREVIEW_MAX_VERSES = 2;
const SHORT_PREVIEW_MAX_CHARS = 200;
let previewRenderedRef = null;

function renderPreviewBody(body, passage) {
  body.replaceChildren();
  const block = document.createElement("div");
  block.className = "rank-preview-scripture";
  if (passage.html) {
    const doc = new DOMParser().parseFromString(passage.html, "text/html");
    for (const bad of doc.querySelectorAll("script, style, iframe, object")) bad.remove();
    const p = document.createElement("div");
    p.className = "rank-preview-verses";
    p.innerHTML = doc.body.innerHTML;
    block.append(p);
  } else if (verseText.key) {
    block.append(passageFor(passage.ref));
  } else {
    const p = document.createElement("p");
    p.className = "rank-preview-verses";
    p.textContent = passage.text;
    block.append(p);
  }
  const cite = document.createElement("div");
  cite.className = "rank-preview-cite";
  cite.textContent = "BSB";
  block.append(cite);
  body.append(block);
}

/** Hybrid preview of the input passage in Relevant/Surprising (Topic uses header copy only). */
function showRankPreview(passage) {
  // Topic search chrome hides #add; don't leave the epigraph floating without the scope field.
  if ($("#topic-search-wrap")?.classList.contains("is-open")) passage = null;
  const epigraph = $("#rank-epigraph");
  const panel = $("#rank-preview");
  if (!passage?.text) {
    if (epigraph) {
      epigraph.hidden = true;
      epigraph.textContent = "";
    }
    if (panel) {
      panel.hidden = true;
      panel.open = false;
    }
    previewRenderedRef = null;
    return;
  }
  const verseCount = passage.verses?.length ?? 1;
  const isShort = verseCount <= SHORT_PREVIEW_MAX_VERSES && passage.text.length <= SHORT_PREVIEW_MAX_CHARS;
  if (isShort) {
    if (panel) {
      panel.hidden = true;
      panel.open = false;
    }
    if (epigraph) {
      epigraph.textContent = passage.text;
      epigraph.hidden = false;
    }
    previewRenderedRef = passage.ref;
    return;
  }
  if (epigraph) {
    epigraph.hidden = true;
    epigraph.textContent = "";
  }
  if (panel) {
    panel.querySelector(".rank-preview-text").textContent = `“${passage.text}”`;
    const body = $("#rank-preview-body");
    if (previewRenderedRef !== passage.ref) {
      panel.open = false;
      const toggle = panel.querySelector(".rank-preview-toggle");
      if (toggle) toggle.textContent = "Read ▾";
      if (body) renderPreviewBody(body, passage);
      previewRenderedRef = passage.ref;
    }
    panel.hidden = false;
  }
}

$("#rank-preview")?.addEventListener("toggle", (e) => {
  const panel = e.currentTarget;
  const toggle = panel.querySelector(".rank-preview-toggle");
  if (toggle) toggle.textContent = panel.open ? "Hide ▴" : "Read ▾";
});

/** Calm panel when a valid passage returns no relevant highlights — not the error line, not #empty. */
function showRelevanceNone(info) {
  const panel = $("#relevance-none");
  if (!info) {
    panel.hidden = true;
    return;
  }
  const label = info.passage.label || labelRef(info.passage.ref);
  $("#relevance-none-copy").textContent = emptyRelevanceCopy(info.count, label);
  panel.dataset.ref = info.passage.ref;
  panel.dataset.label = label;
  const chapter = chapterRefOf(info.passage.ref);
  $("#relevance-none-chapter").hidden = !chapter || chapter === info.passage.ref;
  panel.hidden = false;
}

$("#relevance-none-route").addEventListener("click", () => {
  const ref = $("#relevance-none").dataset.ref;
  if (ref) window.open(`https://route.bible/${ref.toLowerCase()}`, "_blank", "noopener");
});

$("#relevance-none-chapter").addEventListener("click", () => {
  const ref = $("#relevance-none").dataset.ref;
  const chapter = chapterRefOf(ref);
  if (!chapter) return;
  refField.value = labelRef(chapter);
  void runRelevance();
});

$("#relevance-none-date").addEventListener("click", () => {
  selectMode("date");
});

function syncRelevanceCache() {
  if (!library || !relevance) return;
  const now = new Map();
  for (const r of library.all("highlight")) now.set(r.ref, r.updated);
  const upserts = [];
  const deletions = [];
  for (const [ref, updated] of now) if (highlightStamp.get(ref) !== updated) upserts.push({ ref });
  for (const ref of highlightStamp.keys()) if (!now.has(ref)) deletions.push(ref);
  if (upserts.length || deletions.length) relevance.applyChanges({ upserts, deletions });
  highlightStamp = now;
}

async function ensureRelevance() {
  if (!library) return null;
  if (!relevance || relevance.lib !== library.lib) {
    relevance = createRelevance({ lib: library.lib, verseText: bsbText });
    relevance.lib = library.lib;
  }
  return relevance;
}

/** Highlight runs currently shown (respecting the color filter), warmed for BSB text. */
function currentRuns() {
  const ids = colors.map((c) => c.id);
  const records = library.all("highlight").sort((a, b) => compareRefs(a.ref, b.ref));
  const shown = filter.size ? records.filter((r) => filter.has(topColor(r, ids))) : records;
  const runs = groupRuns(shown, (r) => topColor(r, ids));
  bsbText.warm(runs.map((r) => r.ref));
  return runs;
}

async function runRelevance() {
  const session = await ensureRelevance();
  // Topic search owns the list while it has a query; don't race passage ranking underneath.
  if (!session || !RANK_MODES.includes(groupBy) || topicQuery()) return;
  const form = $("#add");
  const raw = refText(refField);
  const gen = ++rankGeneration;
  // Drop prior results immediately so a slow second call can't flash an intermediate list.
  rankOrder = [];
  rankFailed = false;
  beginRankPaint({ resetUser: true });
  verseText.open = null;
  showRelevanceNone(null);
  showRankPreview(null);
  if (!String(raw).trim()) {
    errorIn(form, "");
    session.clearPassage();
    rankPending = null;
    if (gen === rankGeneration) render();
    return;
  }
  rankPending = true;
  render(); // loading before any network / verse fetch
  const found = await session.setPassageInput(raw);
  if (gen !== rankGeneration) return;
  if (found.error) {
    errorIn(form, found.error);
    session.clearPassage();
    rankOrder = [];
    rankPending = null;
    rankFailed = false;
    render();
    return;
  }
  errorIn(form, "");
  const runs = currentRuns();
  const items = runs.map((r) => ({ id: r.ref, ref: r.ref }));
  try {
    const { ranked } = await session.judge(items, relatedRankMode());
    if (gen !== rankGeneration) return; // newer input or a later run owns the UI
    rankOrder = ranked.map((v) => v.id);
    rankFailed = false;
    beginRankPaint({ resetUser: true }); // final paint for this query
  } catch (e) {
    if (gen !== rankGeneration) return;
    errorIn(form, rankErrorMessage(e));
    rankOrder = [];
    rankFailed = true;
  } finally {
    if (gen === rankGeneration) {
      rankPending = null;
      render();
    }
  }
}

async function runTopic() {
  const session = await ensureRelevance();
  if (!session) return;
  const form = $("#add");
  const cleaned = topicQuery();
  const gen = ++rankGeneration;
  rankOrder = [];
  rankFailed = false;
  beginRankPaint({ resetUser: true });
  verseText.open = null;
  showRelevanceNone(null);
  showRankPreview(null);
  if (!cleaned) {
    errorIn(form, "");
    session.clearPassage();
    rankPending = null;
    if (gen !== rankGeneration) return;
    // Restore the selected mode's list (Related re-ranks from #ref when present).
    if (RANK_MODES.includes(groupBy) && refText(refField).trim()) void runRelevance();
    else render();
    return;
  }
  rankPending = true;
  session.setTopicInput(cleaned);
  render(); // loading before any network
  errorIn(form, "");
  const runs = currentRuns();
  const items = runs.map((r) => ({ id: r.ref, ref: r.ref }));
  try {
    const { ranked } = await session.judgeTopic(items, cleaned);
    if (gen !== rankGeneration) return;
    rankOrder = ranked.map((v) => v.id);
    rankFailed = false;
    beginRankPaint({ resetUser: true });
  } catch (e) {
    if (gen !== rankGeneration) return;
    errorIn(form, rankErrorMessage(e));
    rankOrder = [];
    rankFailed = true;
  } finally {
    if (gen === rankGeneration) {
      rankPending = null;
      render();
    }
  }
}

async function reorderRelevance() {
  const session = await ensureRelevance();
  if (!session?.passage || rankFailed) return render();
  const runs = currentRuns();
  const { ranked } = session.reorder(runs.map((r) => ({ id: r.ref, ref: r.ref })), relatedRankMode());
  rankOrder = ranked.map((v) => v.id);
  render();
}

// Ranking input is #ref (hijacked in Related). Autocomplete stays on that one field.
// Typing clears stale results only — Jev runs on commit (Enter / change / blur), not on a debounce.
refField.addEventListener("input", () => {
  if (!RANK_MODES.includes(groupBy) || topicQuery()) return;
  lastRelatedCommitKey = "";
  const form = $("#add");
  const raw = refText(refField);
  if (!String(raw).trim()) errorIn(form, "");
  // Leave the old ranked list immediately when the passage changes.
  rankGeneration++; // no network until commit
  rankOrder = [];
  rankFailed = false;
  beginRankPaint({ resetUser: true });
  verseText.open = null;
  showRelevanceNone(null);
  showRankPreview(null);
  if (String(raw).trim()) {
    // Keep list chrome in the ranking path without implying a fetch yet (no Ranking… copy).
    rankPending = null;
    relevance?.clearPassage();
  } else {
    relevance?.clearPassage();
    rankPending = null;
  }
  render();
});

// Autocomplete / passage pick that finalizes a ref (si-passage-input bubbles change).
refField.addEventListener("change", () => {
  commitRelatedRank();
});

// Blur commit when the field holds a passage (invalid → inline error, no Jev). Deferred so an
// accept's change event wins and lastRelatedCommitKey dedupes the pair.
refField.addEventListener("focusout", () => {
  setTimeout(() => {
    if (!RANK_MODES.includes(groupBy) || topicQuery()) return;
    if (refField.contains(document.activeElement) || refField.shadowRoot?.activeElement) return;
    if (!String(refText(refField)).trim()) return;
    commitRelatedRank();
  }, 0);
});

{
  const topicField = $("#topic-search");
  const topicToggle = $("#topic-search-toggle");
  const topicClose = $("#topic-search-close");
  /** Last topic string that started a commit (dedupes Enter+blur). Cleared while typing. */
  let lastTopicCommitKey = "";
  topicToggle.addEventListener("click", () => openTopicSearch());
  // Close ×: clear + collapse in one step (mousedown so the field doesn't blur first).
  topicClose?.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    exitTopicSearch();
  });
  topicClose?.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    exitTopicSearch();
  });
  topicField.addEventListener("input", () => {
    lastTopicCommitKey = "";
    const form = $("#add");
    const cleaned = sanitizeTopic(topicField.value);
    if (!cleaned) errorIn(form, "");
    // Stay expanded while typing a query; empty alone does not collapse (blur/Escape/× does).
    if (cleaned) openTopicSearch({ focus: false });
    // Search owns the list whenever the field has a query — independent of Date/Genre/Related.
    // Clear stale results while typing; Jev runs on Enter/blur only (same commit rule as Related).
    rankGeneration++;
    rankOrder = [];
    rankFailed = false;
    beginRankPaint({ resetUser: true });
    verseText.open = null;
    showRelevanceNone(null);
    showRankPreview(null);
    if (cleaned) {
      rankPending = null;
      relevance?.setTopicInput(cleaned);
      render();
    } else {
      relevance?.clearPassage();
      rankPending = null;
      // Restore Related from #ref on clear (commit-style restore, not a mid-type fire).
      if (RANK_MODES.includes(groupBy) && refText(refField).trim()) {
        lastRelatedCommitKey = "";
        commitRelatedRank();
      } else render();
    }
  });
  function commitTopicSearch() {
    const cleaned = topicQuery();
    if (!cleaned) return;
    if (cleaned === lastTopicCommitKey) return;
    lastTopicCommitKey = cleaned;
    void runTopic();
  }
  topicField.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      // One Escape fully exits — clear query if any, collapse, restore #add.
      exitTopicSearch();
      return;
    }
    if (e.key !== "Enter" || e.isComposing) return;
    e.preventDefault();
    commitTopicSearch();
  });
  topicField.addEventListener("blur", () => {
    // Commit a non-empty query on blur; collapse only when empty.
    if (topicQuery()) commitTopicSearch();
    closeTopicSearch();
  });
  // Empty open search: tap outside collapses and restores #add. Non-empty keeps results (use × / Escape).
  document.addEventListener("pointerdown", (e) => {
    const wrap = $("#topic-search-wrap");
    if (!wrap?.classList.contains("is-open")) return;
    if (e.target instanceof Node && wrap.contains(e.target)) return;
    if (topicQuery()) return;
    closeTopicSearch({ force: true });
  }, true);
}

/** Skeleton rows while Related/topic waits on Jev after commit — matches list row rhythm. */
function rankSkeleton(count = 4) {
  const wrap = document.createElement("div");
  wrap.className = "rank-skeleton";
  wrap.setAttribute("role", "status");
  wrap.setAttribute("aria-busy", "true");
  wrap.setAttribute("aria-label", rankingCopy());
  for (let i = 0; i < count; i++) {
    const row = document.createElement("div");
    row.className = "rank-skeleton-row";
    const dot = document.createElement("span");
    dot.className = "rank-skeleton-dot";
    const line = document.createElement("span");
    line.className = "rank-skeleton-line";
    line.style.width = `${58 + ((i * 13) % 28)}%`;
    row.append(dot, line);
    wrap.append(row);
  }
  return wrap;
}

/** One group: its name as the summary (the whole header toggles it), then its rows. */
function group({ id, name, runs }) {
  const key = `${groupBy}:${id}`;
  const details = document.createElement("details");
  details.className = "group";
  details.dataset.group = id;
  details.open = groupOpen.get(key) ?? startsOpen(groupBy, id);
  details.addEventListener("toggle", () => groupOpen.set(key, details.open));
  const summary = document.createElement("summary");
  const title = document.createElement("span");
  title.className = "group-name";
  title.textContent = name;
  summary.append(title);
  const list = document.createElement("ul");
  list.className = "rows";
  list.append(...runs.map(row));
  details.append(summary, list);
  return details;
}

function renderFilters(counts) {
  const details = $("#filters");
  const summary = $("#filter-summary");
  const badge = $("#filter-badge");
  const box = $("#filter-options");
  if (!details || !summary || !box) return;
  if (counts.size <= 1) {
    details.open = false;
    details.hidden = true;
    box.replaceChildren();
    return;
  }
  details.hidden = false;
  details.dataset.active = String(filter.size > 0);
  const label = filter.size > 0 ? `Filter by color (${filter.size} active)` : "Filter by color";
  summary.setAttribute("aria-label", label);
  summary.title = label;
  if (badge) {
    badge.hidden = filter.size === 0;
    badge.textContent = filter.size > 0 ? String(filter.size) : "";
  }

  const items = [];
  for (const c of colors) {
    if (!counts.has(c.id)) continue;
    const label = document.createElement("label");
    label.className = "filter-option";
    const check = document.createElement("input");
    check.type = "checkbox";
    check.checked = filter.has(c.id);
    check.addEventListener("change", () => {
      if (check.checked) filter.add(c.id);
      else filter.delete(c.id);
      saveFilters();
      render();
    });
    const dot = document.createElement("span");
    dot.className = "dot";
    paint(dot, c.id);
    const name = document.createElement("span");
    name.className = "filter-name";
    name.textContent = colorName(c);
    const count = document.createElement("span");
    count.className = "filter-count";
    count.textContent = String(counts.get(c.id));
    label.append(check, dot, name, count);
    items.push(label);
  }
  box.replaceChildren(...items);
}

const ICONS = {
  edit: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21.17 6.81a1 1 0 0 0-3.98-3.98L3.84 16.17a2 2 0 0 0-.5.83l-1.32 4.35a.5.5 0 0 0 .62.62l4.35-1.32a2 2 0 0 0 .83-.5z"/><path d="m15 5 4 4"/></svg>',
  filter: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M22 3H2l8 9.46V19l4 2v-8.54L22 3z"/></svg>',
  plus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14"/><path d="M5 12h14"/></svg>',
  globe: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/></svg>',
  trash: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
};

function iconButton(tag, icon, label) {
  const el = document.createElement(tag);
  el.className = "icon";
  el.innerHTML = ICONS[icon];
  el.setAttribute("aria-label", label);
  el.title = label;
  if (tag === "button") el.type = "button";
  return el;
}

/** One list row: a single highlight, or a run of back-to-back verses in one color (see groupRuns). */
function row({ ref: runRef, records }) {
  const ids = colors.map((c) => c.id);
  const li = document.createElement("li");

  const dot = document.createElement("button");
  dot.type = "button";
  dot.className = "dot";
  paint(dot, topColor(records[0], ids));
  dot.setAttribute("aria-label", `Change color of ${labelRef(runRef)}`);
  dot.setAttribute("aria-haspopup", "true");
  dot.addEventListener("click", () =>
    openColorPicker(dot, topColor(records[0], ids), (id) => {
      const t = now();
      library.putMany(records.map((r) => ({ ...r, highlights: r.highlights.map((h) => ({ ...h, color: id, edited: t })) })));
    }),
  );

  // The whole row opens the passage's text under it (see .row-link in style.css: its ::after covers
  // the line, and the dot and icons sit above it as their own buttons). Without verse text it opens
  // the passage in route.bible instead, like the globe.
  const routeHref = `https://route.bible/${runRef.toLowerCase()}`; // the whole run, e.g. rom.5.3-5
  const link = document.createElement("button");
  link.type = "button";
  link.className = "row-link";
  if (verseText.key) {
    link.setAttribute("aria-label", `Show the text of ${labelRef(runRef)}`);
    wireTextToggle(link, li, runRef);
  } else {
    link.setAttribute("aria-label", `Open ${labelRef(runRef)} on route.bible`);
    link.addEventListener("click", () => window.open(routeHref, "_blank", "noopener"));
  }
  const ref = document.createElement("span");
  ref.className = "ref";
  ref.textContent = labelRef(runRef);
  const quote = document.createElement("span");
  quote.className = "quote";
  quote.textContent = records.flatMap((r) => r.highlights.map((h) => h.quote)).filter(Boolean).join(" … ");
  link.append(ref, quote);

  const line = document.createElement("div");
  line.className = "row";

  const edit = iconButton("button", "edit", `Edit ${labelRef(runRef)}`);
  edit.classList.add("edit");
  edit.addEventListener("click", () => editRow(li, line, { ref: runRef, records }));

  // Two taps to delete (see confirm.js): the first turns the trash into a red "Delete" confirm, and
  // a tap anywhere else, a scroll, Escape or 3 seconds puts it back. Deleting offers an Undo.
  const del = iconButton("button", "trash", `Delete ${labelRef(runRef)}`);
  del.classList.add("trash");
  armDelete(del, {
    label: labelRef(runRef),
    idleHTML: ICONS.trash,
    onConfirm: async () => {
      await library.putMany(records.map((r) => tombstone(r.ref)));
      flash(`Deleted ${labelRef(runRef)}.`, { label: "Undo", run: () => library.putMany(records), ms: 5000 });
    },
  });

  // Three icons as one compact group (see .actions in style.css). They sit above the row's link, so
  // tapping one never opens route.bible.
  const actions = document.createElement("span");
  actions.className = "actions";
  actions.append(edit);
  actions.append(globeLink(runRef, routeHref));
  actions.append(del);
  line.append(dot, link, actions);
  li.append(line);
  if (verseText.open === runRef) showText(li, runRef);
  return li;
}

// ---- editing a row's reference, in place

/** The row being edited, if any: while set, render leaves the list alone. */
let editing = null;

/**
 * Swaps a row's reference for a passage field in the same place, at the same size: the dot and icons
 * stay where they are (inert while editing). Enter, or leaving the field after changing it, saves;
 * Escape cancels. A reference that doesn't read keeps the field open and says why in the flash line.
 * Saving rewrites the run's verses (see editRun) in one putMany.
 */
function editRow(li, line, run) {
  const ids = colors.map((c) => c.id);
  const color = topColor(run.records[0], ids);
  const form = document.createElement("form");
  form.className = "ref-edit";
  form.noValidate = true;
  form.autocomplete = "off";
  const field = document.createElement("si-passage-input");
  field.setAttribute("aria-label", `Reference for ${labelRef(run.ref)}`);
  field.setAttribute("placeholder", "John 3:16");
  form.append(field);
  line.querySelector(".row-link").replaceWith(form);
  line.classList.add("editing");
  for (const el of line.querySelectorAll(":scope > .dot, :scope > .actions")) el.inert = true;
  editing = run.ref;
  listSig = null; // the edit changes the row by hand, so the next render rebuilds it
  field.value = labelRef(run.ref);
  const start = refText(field);
  field.focus();

  let done = false;
  const finish = () => {
    done = true;
    editing = null;
    render();
  };
  const save = async () => {
    if (done) return;
    const found = readPassage(refText(field));
    if (found.error) return (form.dataset.invalid = "1"), flash(found.error);
    const changes = editRun(run.records, found.verses, color, now(), (v) => library.find("highlight", v));
    finish();
    if (changes.length) await library.putMany(changes);
  };
  form.addEventListener("submit", (e) => (e.preventDefault(), save()));
  field.addEventListener("keydown", (e) => {
    if (e.isComposing) return;
    if (e.key === "Enter" && !suggesting(field)) (e.preventDefault(), save());
    if (e.key === "Escape" && !suggesting(field)) (e.preventDefault(), finish());
  });
  field.addEventListener("input", () => delete form.dataset.invalid);
  // Leaving the field saves a change and quietly closes an unchanged one. An invalid change stays open.
  form.addEventListener("focusout", (e) => {
    if (done || form.contains(/** @type {Node} */ (e.relatedTarget))) return;
    setTimeout(() => {
      if (done || form.contains(document.activeElement)) return;
      if (refText(field) === start) finish();
      else save();
    });
  });
}

// ---- verse text: a row's passage from YouVersion (BSB), shown under the row when its book icon is tapped.
// One at a time, and only on request, so YouVersion hears only about passages someone opens. The app key
// comes from the server's /config.json (a Worker secret, kept out of the public repo); without one the
// icon doesn't show.

const verseText = { key: null, open: null, passages: new Map() };
const warmer = createWarmer(warmText);
// A passage's text themes itself inside its shadow root, so it's told the theme on screen, not left on auto.
const themeNow = setupThemeToggle(document.querySelectorAll(".theme-toggle"), {
  onChange: (theme) => {
    for (const el of verseText.passages.values()) el.setAttribute("theme", theme);
  },
});

// The verse-text key is public (it's served at /config.json). It's kept on this device too, so the
// book button shows on every load even when /config.json is slow, rate limited or offline; a failed
// fetch is retried once.
const YV_KEY = "selah-vault:yv-key";
function useVerseKey(yvpPublicAppKey) {
  if (!yvpPublicAppKey || verseText.key === yvpPublicAppKey) return;
  if (!verseText.key) {
    defineKeepingLoaded(() => defineScripturePassage({ yvpPublicAppKey }));
  }
  verseText.key = yvpPublicAppKey;
  render();
}

const authConfig = { appleClientId: null, emailConfigured: false };

function applyAuthConfig() {
  const appleOn = Boolean(authConfig.appleClientId);
  if ($("#apple-login")) $("#apple-login").hidden = !appleOn;
}

async function loadConfig(retry = true) {
  try { useVerseKey(localStorage.getItem(YV_KEY)); } catch {}
  try {
    const res = await fetch("/config.json", { cache: "no-store" });
    if (!res.ok) throw new Error(`config ${res.status}`);
    const data = await res.json();
    authConfig.appleClientId = data.appleClientId || null;
    authConfig.emailConfigured = Boolean(data.emailConfigured);
    applyAuthConfig();
    if (!data.yvpPublicAppKey) return;
    try { localStorage.setItem(YV_KEY, data.yvpPublicAppKey); } catch {}
    useVerseKey(data.yvpPublicAppKey);
  } catch {
    // Offline or no server: the kept key (if any) still shows verse text; try once more shortly.
    if (retry) setTimeout(() => loadConfig(false), 2000);
  }
}

/** The globe: opens the run in route.bible, in a new tab, whether or not verse text is available. */
function globeLink(runRef, href) {
  const a = iconButton("a", "globe", `Open ${labelRef(runRef)} on route.bible`);
  a.classList.add("globe");
  a.href = href;
  a.target = "_blank";
  a.rel = "noopener";
  return a;
}

/** Makes `toggle` (the row) show and hide the run's text under it, warming it on the way. */
function wireTextToggle(toggle, li, runRef) {
  toggle.setAttribute("aria-expanded", String(verseText.open === runRef));
  // Every row's text loads in the background once the list is up (see passage-warm.js), so a tap
  // finds it ready; hover or focus moves this one to the front.
  warmer.add(runRef);
  const warm = () => (warmer.first(runRef), prefetchText(runRef));
  toggle.addEventListener("pointerenter", warm);
  toggle.addEventListener("focus", warm);
  toggle.addEventListener("click", () => {
    // Manual open/close during this query — don't let the next mode-switch paint override it.
    if (JEV_MODES.includes(groupBy) || topicQuery()) rankUserTouched = true;
    const wasOpen = verseText.open === runRef;
    clearOpenVerseText();
    for (const other of document.querySelectorAll("#list .row-link[aria-expanded]")) other.setAttribute("aria-expanded", "false");
    verseText.open = wasOpen ? null : runRef;
    if (!wasOpen) (showText(li, runRef), toggle.setAttribute("aria-expanded", "true"));
  });
}

/** Remove any open passage or its loading skeleton from the list. */
function clearOpenVerseText() {
  for (const other of document.querySelectorAll("#list .verse-text, #list .verse-text-skel")) other.remove();
  scheduleListScrollFade();
}

/** The run's <si-passage>, made once and kept, so a re-render doesn't refetch. */
function passageFor(runRef) {
  let el = verseText.passages.get(runRef);
  if (!el) {
    el = document.createElement("si-passage");
    el.className = "verse-text";
    el.id = `text-${runRef.replace(/\W/g, "-")}`;
    el.setAttribute("yvp-bible-version-id", "3034"); // Berean Standard Bible
    el.setAttribute("passage-id", runRef);
    // "citation" puts "<reference> <version>" after the text; style.css shows only the version (BSB).
    el.setAttribute("reference", "citation");
    el.setAttribute("theme", themeNow());
    el.setAttribute("headings", "hide");
    // Through this site's edge-cached pass-through (src/yv.ts) rather than straight to YouVersion.
    if (location.protocol === "https:") el.setAttribute("yvp-api-host", `${location.host}/yv`);
    styleScripture(el);
    verseText.passages.set(runRef, el);
  }
  return el;
}

/** Resolves once a run's text has loaded off screen (or failed, or 8s passed). */
function warmText(runRef) {
  const fresh = !verseText.passages.has(runRef);
  prefetchText(runRef);
  const el = verseText.passages.get(runRef);
  if (!el || el.loaded || !fresh) return Promise.resolve();
  return new Promise((done) => {
    el.addEventListener("scripture-load", done, { once: true });
    el.addEventListener("scripture-error", done, { once: true });
    setTimeout(done, 8000);
  });
}

/** Loads a run's text off screen: <si-passage> fetches when it's put in the page, and keeps what it got. */
function prefetchText(runRef) {
  if (!verseText.key || verseText.passages.has(runRef)) return;
  let holder = $("#text-prefetch");
  if (!holder) {
    holder = document.createElement("div");
    holder.id = "text-prefetch";
    holder.hidden = true;
    document.body.append(holder);
  }
  holder.append(passageFor(runRef));
}

/**
 * The passage's inside (verse numbers, words of Jesus, measure) lives in <si-passage>'s shadow root,
 * which outside CSS can't reach; one shared sheet is adopted there. Colors come from custom
 * properties set on .verse-text in style.css, so both themes follow the app.
 */
let scriptureSheet;
function styleScripture(el) {
  const root = el.shadowRoot;
  if (!root || !("adoptedStyleSheets" in root)) return;
  if (!scriptureSheet) {
    scriptureSheet = new CSSStyleSheet();
    scriptureSheet.replaceSync(SCRIPTURE_CSS);
  }
  if (!root.adoptedStyleSheets.includes(scriptureSheet)) root.adoptedStyleSheets = [...root.adoptedStyleSheets, scriptureSheet];
}
const SCRIPTURE_CSS = `
/* Set type on the part itself: si-passage's inner .root uses all:initial, which drops host
   custom-property inheritance and falls back to Untitled Serif / tight leading. */
[part="text"] {
  max-width: var(--vault-measure, 36rem);
  font-family: "Lexend", "Helvetica Neue", sans-serif !important;
  font-size: var(--scripture-font-size, 1rem) !important;
  line-height: var(--scripture-line-height, 1.75) !important;
}
[part="text"] p { margin-block: 0 .55em; }
[part="text"] :is(p, .p) { text-indent: 0 !important; }
.yv-vlbl, .va { color: var(--vault-verse, currentColor) !important; font-size: .62em !important; font-weight: 600; letter-spacing: .02em;
  vertical-align: .55em; line-height: 0; margin-inline: .2em .25em; font-style: normal; }
.wj { color: var(--vault-wj, inherit) !important; }
`;

/** Placeholder under a row while <si-passage> loads — sized near real scripture (≈5–6 lines + cite). */
function verseTextSkeleton(dot) {
  const skel = document.createElement("div");
  skel.className = "verse-text-skel";
  skel.setAttribute("aria-hidden", "true");
  if (dot) skel.style.setProperty("--row-color", getComputedStyle(dot).backgroundColor);
  const widths = [92, 88, 84, 78, 70, 38];
  for (const w of widths) {
    const line = document.createElement("span");
    line.className = "verse-text-skel-line";
    line.style.width = `${w}%`;
    skel.append(line);
  }
  return skel;
}

/** True when the passage has finished loading (or failed) and is safe to show without mid-layout jump. */
function passageReady(el) {
  return !!(el?.loaded || el?.dataset?.verseError);
}

/**
 * Puts the run's passage under its row, with a rule in the row's color.
 * If not yet loaded: show a skeleton and only reveal <si-passage> after scripture-load/error
 * (opacity fade unless prefers-reduced-motion). Already-warm passages open immediately.
 * If already ready and mounted under this row, no-op (avoids re-fade on list rebuild).
 */
function showText(li, runRef) {
  const el = passageFor(runRef);
  li.querySelector(".row-link")?.setAttribute("aria-controls", el.id);
  // Already showing under this row — don't remount or re-trigger verse-text-enter.
  if (passageReady(el) && el.parentElement === li && !li.querySelector(".verse-text-skel")) return;

  el.className = "verse-text";
  styleScripture(el); // re-apply after reconnect; same path in Date/Genre/Jev
  const dot = li.querySelector(".dot");
  if (dot) el.style.setProperty("--row-color", getComputedStyle(dot).backgroundColor);

  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const reveal = () => {
    if (verseText.open !== runRef) return;
    li.querySelector(".verse-text-skel")?.remove();
    const firstReveal = el.parentElement !== li;
    if (firstReveal && !reduceMotion) el.classList.add("verse-text-enter");
    else el.classList.remove("verse-text-enter");
    if (firstReveal) li.append(el);
    scheduleListScrollFade();
  };

  if (passageReady(el)) {
    reveal();
    return;
  }

  // Not ready: reserve height with a skeleton; keep <si-passage> off the open row until load settles.
  if (!li.querySelector(".verse-text-skel")) {
    li.append(verseTextSkeleton(dot));
    scheduleListScrollFade();
  }
  prefetchText(runRef);
  if (!el.isConnected) {
    let holder = $("#text-prefetch");
    if (!holder) {
      holder = document.createElement("div");
      holder.id = "text-prefetch";
      holder.hidden = true;
      document.body.append(holder);
    }
    holder.append(el);
  }

  let settled = false;
  const onReady = () => {
    if (settled || verseText.open !== runRef) return;
    settled = true;
    reveal();
  };
  el.addEventListener("scripture-load", onReady, { once: true });
  el.addEventListener("scripture-error", () => {
    el.dataset.verseError = "1";
    onReady();
  }, { once: true });
  setTimeout(onReady, 8000);
}

/** Shows a popover under its anchor (above it when there's no room below), kept on screen. */
function placePopover(pop, anchor, { alignEnd = false } = {}) {
  pop.showPopover();
  const a = anchor.getBoundingClientRect();
  const w = pop.offsetWidth;
  const h = pop.offsetHeight;
  const left = Math.max(8, Math.min(alignEnd ? a.right - w : a.left - 8, innerWidth - w - 8));
  const below = a.bottom + 6;
  pop.style.left = `${left}px`;
  pop.style.top = `${below + h > innerHeight - 8 ? a.top - h - 6 : below}px`;
}

/**
 * The shared color popover, anchored under the dot that opened it, with `current` pressed. Picking a
 * different color calls `pick(id)`: a row's dot recolors its run, the add form's dot only sets the form.
 * It closes on an outside press or Escape by itself, and focus goes back to the dot.
 */
function openColorPicker(anchor, current, pick) {
  const pop = $("#color-pop");
  pop.replaceChildren(
    ...colors.map((c) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "dot";
      b.title = colorName(c);
      paint(b, c.id);
      b.setAttribute("aria-label", `Make ${colorName(c)}`);
      b.setAttribute("aria-pressed", String(current === c.id));
      b.addEventListener("click", () => {
        pop.hidePopover();
        if (c.id !== current) pick(c.id);
      });
      return b;
    }),
  );
  pop.ontoggle = (e) => {
    if (e.newState !== "closed") return;
    const focus = document.activeElement;
    if (anchor.isConnected && (!focus || focus === document.body || pop.contains(focus))) anchor.focus();
  };
  placePopover(pop, anchor);
  pop.querySelector('[aria-pressed="true"]')?.focus();
}

// ---- colors

function renderColors() {
  $("#color-list").replaceChildren(
    ...colors.map((c) => {
      const li = document.createElement("li");
      const record = library.find("color", c.id);
      if (c.builtIn) {
        const dot = document.createElement("span");
        dot.className = "dot";
        paint(dot, c.id);
        li.append(dot);
      } else {
        const pick = document.createElement("input");
        pick.type = "color";
        pick.value = c.hex;
        pick.setAttribute("aria-label", `${colorName(c)} color`);
        pick.addEventListener("change", () => library.put({ ...record, hex: pick.value }));
        li.append(pick);
      }
      const name = document.createElement("input");
      name.value = c.name;
      name.placeholder = c.builtIn ? capitalized(c.id) : "Name";
      name.setAttribute("aria-label", `Name for ${colorName(c)}`);
      name.addEventListener("change", () => {
        const base = record ?? { kind: "color", ref: c.id };
        library.put({ ...base, name: name.value.trim() });
      });
      // Every row's field is the same width: the action sits inside its right edge, and the built-in
      // colors (which can't be deleted) keep that space empty.
      const field = document.createElement("span");
      field.className = "color-field";
      field.append(name);
      if (!c.builtIn) {
        const del = iconButton("button", "trash", `Delete ${colorName(c)}`);
        del.classList.add("trash", "field-action");
        del.addEventListener("click", () => deleteColor(c));
        field.append(del);
      }
      li.append(field);
      return li;
    }),
  );
}

async function deleteColor(c) {
  const using = library.all("highlight").filter((r) => r.highlights.some((h) => h.color === c.id));
  if (using.length && !confirm(`${using.length} highlight${using.length === 1 ? "" : "s"} use ${colorName(c)}. They'll turn yellow.`)) return;
  const t = now();
  await library.putMany([
    ...using.map((r) => ({ ...r, highlights: r.highlights.map((h) => (h.color === c.id ? { ...h, color: "yellow", edited: t } : h)) })),
    { kind: "color", ref: c.id, deleted: true },
  ]);
}

$("#add-color").addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = new FormData(e.target);
  const id = `c-${Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) => b.toString(36).padStart(2, "0")).join("")}`;
  await library.put({ kind: "color", ref: id, name: form.get("name").trim(), hex: form.get("hex").toLowerCase(), created: now() });
  e.target.name.value = "";
});

// ---- sync choices & connected apps

async function loadGrants() {
  const list = $("#grants-list");
  const empty = $("#grants-empty");
  if (!list || !empty) return;
  if (!signedInUser) {
    list.replaceChildren();
    empty.hidden = false;
    empty.textContent = "Sign in to manage connected apps.";
    return;
  }
  try {
    const res = await fetch("/v2/grants", { credentials: "same-origin", cache: "no-store" });
    if (!res.ok) throw new Error();
    const data = await res.json();
    const grants = Array.isArray(data?.grants) ? data.grants : Array.isArray(data) ? data : [];
    list.replaceChildren(
      ...grants.map((g) => {
        const li = document.createElement("li");
        const meta = document.createElement("div");
        meta.className = "grant-meta";
        const info = clientInfo(g.client_id || g.clientId || "", g.client_id || g.clientId || "");
        const title = document.createElement("strong");
        title.textContent = info.name || g.client_id || g.clientId || "Connected app";
        const sub = document.createElement("small");
        const scopes = Array.isArray(g.scopes) ? g.scopes.join(" · ") : String(g.scope || "read");
        sub.textContent = scopes;
        meta.append(title, sub);
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "quiet danger";
        btn.textContent = "Disconnect";
        btn.addEventListener("click", async () => {
          btn.disabled = true;
          const del = await fetch(`/v2/grants/${encodeURIComponent(g.id)}`, { method: "DELETE", credentials: "same-origin" });
          if (del.ok) loadGrants();
          else btn.disabled = false;
        });
        li.append(meta, btn);
        return li;
      }),
    );
    empty.hidden = grants.length > 0;
    empty.textContent = "No connected apps.";
  } catch {
    list.replaceChildren();
    empty.hidden = false;
    empty.textContent = "No connected apps.";
  }
}

function renderSync() {
  if (!library) return;
  const on = Boolean(signedInUser && settings(library.lib).server);
  $("#use-server").checked = on;
  $("#use-server").disabled = !signedInUser;
  $("#use-server").setAttribute("aria-checked", String(on));
  loadGrants();
}

$("#use-server").addEventListener("change", async (e) => {
  const on = e.target.checked;
  e.target.setAttribute("aria-checked", String(on));
  saveSettings(library.lib, { ...settings(library.lib), server: on });
  await connect();
});


function formatMethodDate(ms) {
  if (!ms) return "";
  try {
    return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  } catch {
    return "";
  }
}

function hideLinkEmailForms() {
  const send = $("#link-email-send-form");
  const verify = $("#link-email-verify-form");
  if (send) send.hidden = true;
  if (verify) verify.hidden = true;
}

function emailFormsOpen() {
  return Boolean($("#link-email-send-form") && !$("#link-email-send-form").hidden)
    || Boolean($("#link-email-verify-form") && !$("#link-email-verify-form").hidden);
}

function renderAccount() {
  const name = library?.name || signedInUser?.name || "Personal";
  if ($("#account-display-name")) $("#account-display-name").textContent = name;
  if ($("#account-display-email")) $("#account-display-email").textContent = signedInUser ? "…" : "Not signed in";
  if ($("#account-note")) $("#account-note").textContent = "";
  hideLinkEmailForms();
  loadMethods();
}

function setSlotStatus(el, text, on) {
  if (!el) return;
  el.textContent = text;
  el.classList.toggle("is-on", Boolean(on));
}

async function removeMethod(payload, btn) {
  if (btn) btn.disabled = true;
  try {
    await removeSignInMethod(payload);
    if ($("#account-note")) $("#account-note").textContent = "";
    await loadMethods();
  } catch (error) {
    if (btn) btn.disabled = false;
    if ($("#account-note")) $("#account-note").textContent = error.message;
  }
}

function passkeyTitle(pk) {
  const name = typeof pk.name === "string" ? pk.name.trim() : "";
  if (name) return name;
  const suffix = pk.suffix || String(pk.id || "").slice(-8);
  return suffix ? `Passkey · ${suffix}` : "Passkey";
}

function passkeyRow(pk, canRemove) {
  const li = document.createElement("li");
  const view = document.createElement("div");
  view.className = "passkey-row-view";
  const meta = document.createElement("div");
  meta.className = "grant-meta";
  const strong = document.createElement("strong");
  strong.textContent = passkeyTitle(pk);
  const small = document.createElement("small");
  const added = formatMethodDate(pk.created_at);
  small.textContent = added ? `Added ${added}` : "Passkey";
  meta.append(strong, small);
  const actions = document.createElement("div");
  actions.className = "method-slot-actions";
  const renameBtn = document.createElement("button");
  renameBtn.type = "button";
  renameBtn.className = "quiet passkey-rename";
  renameBtn.innerHTML = `${ICONS.edit}<span>Rename</span>`;
  const removeBtn = document.createElement("button");
  removeBtn.type = "button";
  removeBtn.className = "quiet danger";
  removeBtn.textContent = "Remove";
  removeBtn.disabled = !canRemove;
  if (!canRemove) {
    removeBtn.title = "You need at least one sign-in method.";
    removeBtn.setAttribute("aria-describedby", "slot-passkey-hint");
  }
  removeBtn.addEventListener("click", () => removeMethod({ type: "passkey", id: pk.id }, removeBtn));
  actions.append(renameBtn, removeBtn);
  view.append(meta, actions);

  const form = document.createElement("form");
  form.className = "passkey-rename-form";
  form.hidden = true;
  const input = document.createElement("input");
  input.type = "text";
  input.maxLength = 40;
  input.required = true;
  input.autocomplete = "off";
  input.spellcheck = false;
  input.setAttribute("aria-label", "Passkey name");
  const save = document.createElement("button");
  save.type = "submit";
  save.textContent = "Save";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "quiet";
  cancel.textContent = "Cancel";
  form.append(input, save, cancel);

  renameBtn.addEventListener("click", () => {
    if ($("#account-note")) $("#account-note").textContent = "";
    const current = typeof pk.name === "string" ? pk.name.trim() : "";
    input.value = current || passkeyTitle(pk);
    view.hidden = true;
    form.hidden = false;
    input.focus();
    input.select();
  });
  cancel.addEventListener("click", () => {
    form.hidden = true;
    view.hidden = false;
  });
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = input.value.trim();
    if (name.length < 1 || name.length > 40) {
      if ($("#account-note")) $("#account-note").textContent = "Name must be 1–40 characters.";
      return;
    }
    save.disabled = true;
    try {
      await renamePasskey({ credentialId: pk.id, name });
      if ($("#account-note")) $("#account-note").textContent = "";
      await loadMethods();
    } catch (error) {
      save.disabled = false;
      if ($("#account-note")) $("#account-note").textContent = error.message;
    }
  });

  li.append(view, form);
  return li;
}

function renderSlots({ signedIn, email, apple, appleConfigured, emailConfigured, passkeys }) {
  const signedOut = $("#methods-signed-out");
  if (signedOut) signedOut.hidden = signedIn;
  const keys = Array.isArray(passkeys) ? passkeys : [];
  const count = (email ? 1 : 0) + (apple ? 1 : 0) + keys.length;
  const canRemove = count > 1;
  const formsOpen = emailFormsOpen();

  const pkSlot = $("#slot-passkey");
  const pkOn = keys.length > 0;
  pkSlot?.classList.toggle("is-enabled", pkOn);
  pkSlot?.classList.remove("is-unavailable");
  setSlotStatus($("#slot-passkey-status"), pkOn ? "Enabled" : "Not set up", pkOn);
  const addPk = $("#add-passkey");
  if (addPk) addPk.hidden = !signedIn || !passkeysAvailable();
  const pkList = $("#slot-passkey-list");
  if (pkList) {
    pkList.replaceChildren(...keys.map((pk) => passkeyRow(pk, canRemove)));
    pkList.hidden = keys.length === 0;
  }
  const pkHint = $("#slot-passkey-hint");
  if (pkHint) pkHint.hidden = !(pkOn && !canRemove);

  const emailSlot = $("#slot-email");
  const emailOn = Boolean(email);
  const emailReady = Boolean(emailConfigured);
  emailSlot?.classList.toggle("is-enabled", emailOn);
  emailSlot?.classList.toggle("is-unavailable", signedIn && !emailReady && !emailOn);
  const emailStatus = !signedIn || emailReady || emailOn
    ? (emailOn ? "Enabled" : "Not set up")
    : "Not available yet";
  setSlotStatus($("#slot-email-status"), emailStatus, emailOn);
  const emailDetail = $("#slot-email-detail");
  if (emailDetail) {
    emailDetail.textContent = emailOn ? email : "";
    emailDetail.hidden = !emailOn;
  }
  const addEmail = $("#add-email");
  const changeEmail = $("#change-email");
  const removeEmail = $("#remove-email");
  if (addEmail) addEmail.hidden = !signedIn || !emailReady || emailOn || formsOpen;
  if (changeEmail) changeEmail.hidden = !signedIn || !emailOn || formsOpen;
  if (removeEmail) {
    removeEmail.hidden = !signedIn || !emailOn;
    removeEmail.disabled = !canRemove;
    if (!canRemove) {
      removeEmail.title = "You need at least one sign-in method.";
      removeEmail.setAttribute("aria-describedby", "slot-email-hint");
    } else {
      removeEmail.removeAttribute("title");
      removeEmail.removeAttribute("aria-describedby");
    }
  }
  const emailHint = $("#slot-email-hint");
  if (emailHint) emailHint.hidden = !(emailOn && !canRemove);

  const appleSlot = $("#slot-apple");
  const appleOn = Boolean(apple);
  const appleReady = Boolean(appleConfigured);
  appleSlot?.classList.toggle("is-enabled", appleOn);
  appleSlot?.classList.toggle("is-unavailable", signedIn && !appleReady && !appleOn);
  const appleStatus = appleOn ? "Enabled" : (appleReady || !signedIn ? "Not set up" : "Not available yet");
  setSlotStatus($("#slot-apple-status"), appleStatus, appleOn);
  const appleDetail = $("#slot-apple-detail");
  if (appleDetail) {
    appleDetail.textContent = "Linked";
    appleDetail.hidden = !appleOn;
  }
  const addApple = $("#add-apple");
  const removeApple = $("#remove-apple");
  if (addApple) addApple.hidden = !signedIn || !appleReady || appleOn;
  if (removeApple) {
    removeApple.hidden = !signedIn || !appleOn;
    removeApple.disabled = !canRemove;
    if (!canRemove) {
      removeApple.title = "You need at least one sign-in method.";
      removeApple.setAttribute("aria-describedby", "slot-apple-hint");
    } else {
      removeApple.removeAttribute("title");
      removeApple.removeAttribute("aria-describedby");
    }
  }
  const appleHint = $("#slot-apple-hint");
  if (appleHint) appleHint.hidden = !(appleOn && !canRemove);
}

async function loadMethods() {
  const slots = $("#methods-slots");
  if (!slots) return;
  if (!signedInUser) {
    hideLinkEmailForms();
    if ($("#account-display-email")) $("#account-display-email").textContent = "Not signed in";
    renderSlots({
      signedIn: false,
      email: null,
      apple: false,
      appleConfigured: Boolean(authConfig.appleClientId),
      emailConfigured: Boolean(authConfig.emailConfigured),
      passkeys: [],
    });
    return;
  }
  try {
    const data = await fetchSignInMethods();
    authConfig.emailConfigured = Boolean(data.emailConfigured);
    applyAuthConfig();
    if ($("#account-display-email")) {
      $("#account-display-email").textContent = data.email || "No email linked";
    }
    renderSlots({
      signedIn: true,
      email: data.email || null,
      apple: Boolean(data.apple),
      appleConfigured: Boolean(data.appleConfigured),
      emailConfigured: Boolean(data.emailConfigured),
      passkeys: Array.isArray(data.passkeys) ? data.passkeys : [],
    });
  } catch (error) {
    if ($("#account-note")) $("#account-note").textContent = error.message;
  }
}

let pendingLinkEmail = "";

function openLinkEmailForm() {
  if ($("#account-note")) $("#account-note").textContent = "";
  const send = $("#link-email-send-form");
  const verify = $("#link-email-verify-form");
  if (verify) verify.hidden = true;
  if (send) {
    send.hidden = false;
    $("#add-email") && ($("#add-email").hidden = true);
    $("#change-email") && ($("#change-email").hidden = true);
    $("#link-email-input")?.focus();
  }
}

$("#add-email")?.addEventListener("click", openLinkEmailForm);
$("#change-email")?.addEventListener("click", openLinkEmailForm);
$("#remove-email")?.addEventListener("click", () => removeMethod({ type: "email" }, $("#remove-email")));
$("#remove-apple")?.addEventListener("click", () => removeMethod({ type: "apple" }, $("#remove-apple")));

$("#link-email-cancel")?.addEventListener("click", () => {
  hideLinkEmailForms();
  loadMethods();
});

$("#link-email-send-form")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  if ($("#account-note")) $("#account-note").textContent = "";
  const email = String(new FormData(e.target).get("email") ?? "").trim();
  if (!email) return;
  try {
    await sendEmailCode(email);
    pendingLinkEmail = email;
    $("#link-email-sent-note").textContent = `Enter the 6-digit code sent to ${email}.`;
    $("#link-email-send-form").hidden = true;
    $("#link-email-verify-form").hidden = false;
    $("#link-otp-input")?.focus();
  } catch (error) {
    if ($("#account-note")) $("#account-note").textContent = error.message;
  }
});

$("#link-email-back")?.addEventListener("click", () => {
  $("#link-email-verify-form").hidden = true;
  $("#link-email-send-form").hidden = false;
  $("#link-email-input")?.focus();
});

$("#link-email-verify-form")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  if ($("#account-note")) $("#account-note").textContent = "";
  const code = String(new FormData(e.target).get("code") ?? "").trim();
  try {
    await verifyEmailCode(pendingLinkEmail, code);
    hideLinkEmailForms();
    await loadMethods();
    if ($("#account-note")) $("#account-note").textContent = "Email linked to this account.";
  } catch (error) {
    if ($("#account-note")) $("#account-note").textContent = error.message;
  }
});

async function ensureAppleSdk(clientId) {
  if (globalThis.AppleID?.auth) {
    if (clientId && !globalThis.AppleID.auth._vaultInit) {
      globalThis.AppleID.auth.init({
        clientId,
        scope: "name email",
        redirectURI: `${location.origin}/auth/apple`,
        usePopup: true,
      });
      globalThis.AppleID.auth._vaultInit = true;
    }
    return true;
  }
  if (!clientId) return false;
  await new Promise((resolve, reject) => {
    const existing = document.querySelector('script[data-apple-auth]');
    if (existing) {
      existing.addEventListener("load", resolve, { once: true });
      existing.addEventListener("error", reject, { once: true });
      return;
    }
    const script = document.createElement("script");
    script.src = "https://appleid.cdn-apple.com/appleauth/static/jsapi/appleid/1/en_US/appleid.auth.js";
    script.dataset.appleAuth = "true";
    script.addEventListener("load", resolve, { once: true });
    script.addEventListener("error", reject, { once: true });
    document.head.append(script);
  });
  if (!globalThis.AppleID?.auth) return false;
  globalThis.AppleID.auth.init({
    clientId,
    scope: "name email",
    redirectURI: `${location.origin}/auth/apple`,
    usePopup: true,
  });
  globalThis.AppleID.auth._vaultInit = true;
  return true;
}

$("#add-apple")?.addEventListener("click", async () => {
  if ($("#account-note")) $("#account-note").textContent = "";
  try {
    const clientId = authConfig.appleClientId;
    if (!clientId || clientId === true) {
      throw new Error("Sign in with Apple isn't configured on this server yet.");
    }
    const ok = await ensureAppleSdk(clientId);
    if (!ok || !globalThis.AppleID?.auth) {
      throw new Error("Sign in with Apple isn't available in this browser.");
    }
    const resp = await globalThis.AppleID.auth.signIn();
    const idToken = resp?.authorization?.id_token;
    if (!idToken) throw new Error("Apple did not return an identity token.");
    const fullName = [resp?.user?.name?.firstName, resp?.user?.name?.lastName].filter(Boolean).join(" ").trim();
    await signInWithApple(idToken, { name: fullName || undefined });
    await loadMethods();
    if ($("#account-note")) $("#account-note").textContent = "Apple linked to this account.";
  } catch (error) {
    if (!cancelled(error) && $("#account-note")) $("#account-note").textContent = error.message;
  }
});

for (const back of document.querySelectorAll(".back")) back.addEventListener("click", () => (show("main"), render()));

// ---- the library's name, edited in place

function rename(next) {
  library.rename(next);
}

const libName = $("#lib-name");
libName.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.isComposing) (e.preventDefault(), libName.blur());
  if (e.key === "Escape") (e.preventDefault(), (libName.textContent = library.name), libName.blur());
});
// Enter and tapping away save it; an empty name keeps the old one.
libName.addEventListener("blur", () => {
  if (!library) return;
  const next = libName.textContent.replace(/\s+/g, " ").trim().slice(0, 80);
  if (next && next !== library.name) rename(next);
  libName.textContent = library.name;
  getSelection()?.removeAllRanges();
});

// ---- menu
// One ••• control permanently in <header>: reachable on both desktop and phone, even when the library is empty.

// Keep the focused field on screen when the soft keyboard opens on phone settings.
document.addEventListener("focusin", (e) => {
  const el = e.target;
  if (!(el instanceof HTMLElement)) return;
  if (!el.matches("input, textarea, select, si-passage-input")) return;
  if (!matchMedia("(max-width: 600px)").matches) return;
  if (!el.closest(".settings-panel")) return;
  requestAnimationFrame(() => {
    setTimeout(() => el.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" }), 250);
  });
});

document.addEventListener("pointerdown", (e) => {
  const menu = $("#menu");
  if (menu?.open && !menu.contains(e.target)) menu.open = false;
  const filters = $("#filters");
  if (filters?.open && !filters.contains(e.target)) filters.open = false;
});
document.addEventListener("keydown", (e) => {
  const menu = $("#menu");
  if (e.key === "Escape" && menu?.open) {
    menu.open = false;
    menu.querySelector("summary")?.focus();
  }
  const filters = $("#filters");
  if (e.key === "Escape" && filters?.open) {
    filters.open = false;
    filters.querySelector("summary")?.focus();
  }
});

function menuAction(sel, fn) {
  for (const el of document.querySelectorAll(sel)) {
    el.addEventListener("click", async () => {
      const menu = $("#menu");
      if (menu) menu.open = false;
      try {
        await fn();
      } catch (error) {
        if (!cancelled(error)) flash(error.message);
      }
    });
  }
}

menuAction("#open-sync", () => (renderSync(), show("sync")));
menuAction("#open-colors", () => (renderColors(), show("colors")));
menuAction("#open-backup", () => (($("#backup-note").textContent = ""), show("backup")));
menuAction("#open-account", () => (renderAccount(), show("account")));

/** Runs a button on a settings screen, saying how it went in that screen's status line. */
function screenAction(id, note, fn) {
  $(id)?.addEventListener("click", async () => {
    try {
      const said = await fn();
      if (said) $(note).textContent = said;
    } catch (error) {
      if (!cancelled(error)) $(note).textContent = error.message;
    }
  });
}

async function addPasskey() {
  await registerPasskey({ name: library?.name || "Personal" });
  $("#passkey-offer").hidden = true;
  return "Passkey added. Use it to sign in on any device.";
}

screenAction("#add-passkey", "#account-note", async () => {
  const said = await addPasskey();
  await loadMethods();
  return said;
});

$("#offer-passkey")?.addEventListener("click", async () => {
  try {
    flash(await addPasskey());
  } catch (error) {
    if (!cancelled(error)) flash(error.message);
  }
});
$("#skip-passkey")?.addEventListener("click", () => ($("#passkey-offer").hidden = true));

screenAction("#export", "#backup-note", async () => {
  let content = library.toFile();
  if (signedInUser) {
    const res = await fetch("/v2/export", { credentials: "same-origin" }).catch(() => null);
    if (res?.ok) content = await res.text();
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([content], { type: "application/x-ndjson" }));
  a.download = `selah-vault-${new Date().toISOString().slice(0, 10)}.jsonl`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  return "Saved a copy of this library as a file.";
});

screenAction("#import", "#backup-note", () => $("#import-file").click());

$("#import-file").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  try {
    const text = await file.text();
    if (signedInUser) {
      const res = await fetch("/v2/import", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/x-ndjson" },
        body: text,
      }).catch(() => null);
      if (res?.ok) {
        const out = await res.json().catch(() => ({}));
        await library.sync();
        $("#backup-note").textContent = `Imported ${out.accepted ?? 0} ${out.accepted === 1 ? "event" : "events"}.`;
        return;
      }
    }
    const entries = parseJsonl(text);
    const changed = await library.merge(entries);
    const older = entries.length - changed;
    $("#backup-note").textContent = `Imported ${changed} ${changed === 1 ? "entry" : "entries"}${older ? ` (${older} already present)` : ""}.`;
  } catch (error) {
    $("#backup-note").textContent = `Couldn't import that file: ${error.message}`;
  }
});

menuAction("#lock", lock);

$("#erase").addEventListener("click", async () => {
  const ok = confirm("Erase this library from the server and this device?");
  if (!ok) return;
  const id = library.lib;
  await library.erase();
  localStorage.removeItem(settingsKey(id));
  localStorage.removeItem(nameKey(id));
  $("#danger").open = false;
  await lock();
});

// ---- boot

addEventListener("online", () => library?.sync());
addEventListener("focus", () => library?.sync());
setInterval(() => document.visibilityState === "visible" && library?.sync(), 30_000);

async function boot() {
  loadConfig();
  if (!passkeysAvailable()) {
    if ($("#passkey-login")) $("#passkey-login").hidden = true;
    if ($("#passkey-create-wrap")) $("#passkey-create-wrap").hidden = true;
    if ($("#add-passkey")) $("#add-passkey").hidden = true;
  }
  const request = takeSaveLink();
  if (request) {
    const found = readPassage(request.ref);
    $("#start-note").textContent = found.error ? "Sign in to save this verse." : `Sign in to save ${found.label}.`;
    $("#start-note").hidden = false;
  }
  const user = await fetchSession();
  if (user) {
    await enter({ id: user.id, name: user.name || "Personal", online: true });
    return;
  }
  const saved = JSON.parse(localStorage.getItem(SESSION) ?? "null");
  if (saved?.id && saved.online === false) {
    await enter({ id: saved.id, name: saved.name || "Personal", online: false });
    return;
  }
  show("start");
}

registerSelahVaultTools({ library: () => library, colors: () => colors, colorName, highlight, flash });

boot();
