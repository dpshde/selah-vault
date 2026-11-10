// Selah Vault v2 client SDK: local-first event outbox, deterministic (ts, id) projector,
// /v2/bootstrap hydration, incremental /v2/events sync, live /v2/ws pokes, and .jsonl backups.
import { compareRefs, expandVerses, splitRef } from "./refs.js";
import { COLORS, listRanges, rangeView, rangeWrites, topColor } from "./ranges.js";

export { COLORS, topColor };
const COLOR_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const HEX = /^#[0-9a-fA-F]{6}$/;
const FORMAT = 2;
const EVENT_BATCH = 500;
const TIMEOUT_MS = 20_000;

export class SyncError extends Error {
  constructor(status, body) {
    super(`server answered ${status}${body ? `: ${body}` : ""}`);
    this.status = status;
  }
}

export const now = () => Math.floor(Date.now() / 1000);
export const nowMs = () => Date.now();
export const randomBytes = (n) => crypto.getRandomValues(new Uint8Array(n));

export function b64url(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromB64url(text) {
  const s = String(text ?? "").replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(s + "=".repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export const newEventId = () => `ev_${b64url(randomBytes(16))}`;

/** Deterministic (ts, id) ordering so offline multi-device events converge regardless of arrival order. */
export function compareEventOrder(a, b) {
  const dt = (Number(a?.ts) || 0) - (Number(b?.ts) || 0);
  if (dt !== 0) return dt;
  const x = String(a?.id ?? "");
  const y = String(b?.id ?? "");
  return x < y ? -1 : x > y ? 1 : 0;
}

export function autoTags(kind, ref, data) {
  const set = new Set();
  if (typeof ref === "string") {
    const code = splitRef(ref)?.code;
    if (code) set.add(`book:${code}`);
  }
  if (data && typeof data.cardKey === "string" && data.cardKey) {
    set.add(`card:${data.cardKey}`);
  }
  return [...set];
}

export function palette(colorItems = []) {
  const byId = new Map();
  for (const item of colorItems) {
    if (!item || item.deleted) continue;
    const id = item.id ?? item.ref;
    if (id) byId.set(id, item);
  }
  const builtIn = COLORS.map((id) => ({ id, name: byId.get(id)?.name ?? "", hex: null, builtIn: true }));
  const own = [...byId.values()]
    .filter((c) => {
      const id = c.id ?? c.ref;
      return !COLORS.includes(id) && HEX.test(c.hex ?? "");
    })
    .sort((a, b) => (a.createdTs ?? (a.created ?? 0) * 1000) - (b.createdTs ?? (b.created ?? 0) * 1000) || String(a.id ?? a.ref).localeCompare(String(b.id ?? b.ref)))
    .map((c) => ({ id: c.id ?? c.ref, name: c.name ?? "", hex: c.hex.toLowerCase(), builtIn: false }));
  return [...builtIn, ...own];
}

export function emptyProjectedState() {
  return {
    v: FORMAT,
    seq: 0,
    syncedName: null,
    nameOrder: null,
    passages: {},
    highlights: {},
    colors: {},
    blocks: {},
    srsEvents: {},
    seenIds: {},
    events: [],
    outbox: [],
  };
}

function beats(ev, prevOrder) {
  return !prevOrder || compareEventOrder(ev, prevOrder) > 0;
}

export function applyEventToState(state, rawEvent) {
  if (!rawEvent || typeof rawEvent.id !== "string" || typeof rawEvent.kind !== "string") return false;
  if (state.seenIds[rawEvent.id]) {
    if (Number.isInteger(rawEvent.seq) && rawEvent.seq > state.seq) state.seq = rawEvent.seq;
    return false;
  }
  const ev = {
    ...(Number.isInteger(rawEvent.seq) ? { seq: rawEvent.seq } : {}),
    id: rawEvent.id,
    ts: Number.isFinite(rawEvent.ts) ? Math.trunc(rawEvent.ts) : nowMs(),
    app: String(rawEvent.app || "selah-vault"),
    kind: rawEvent.kind,
    ref: rawEvent.ref ?? null,
    tags: Array.isArray(rawEvent.tags) ? rawEvent.tags : autoTags(rawEvent.kind, rawEvent.ref, rawEvent.data),
    data: rawEvent.data && typeof rawEvent.data === "object" ? rawEvent.data : {},
  };
  state.seenIds[ev.id] = 1;
  state.events.push(ev);
  if (Number.isInteger(ev.seq) && ev.seq > state.seq) state.seq = ev.seq;
  const ord = { ts: ev.ts, id: ev.id };

  if (ev.kind === "library.renamed" && typeof ev.data.name === "string" && ev.data.name.trim()) {
    if (beats(ord, state.nameOrder)) {
      state.syncedName = ev.data.name.trim();
      state.nameOrder = ord;
    }
  } else if (ev.kind === "passage.saved" && typeof ev.ref === "string" && splitRef(ev.ref)) {
    const cur = state.passages[ev.ref];
    const earliest = cur?.createdTs ? Math.min(cur.createdTs, ev.ts) : ev.ts;
    if (beats(ord, cur?.order)) {
      state.passages[ev.ref] = { ref: ev.ref, createdTs: earliest, updatedTs: ev.ts, removedTs: null, apps: ev.data.apps ?? cur?.apps ?? {}, order: ord };
    } else if (cur) cur.createdTs = earliest;
  } else if (ev.kind === "passage.removed" && typeof ev.ref === "string") {
    const cur = state.passages[ev.ref];
    if (beats(ord, cur?.order)) {
      state.passages[ev.ref] = { ref: ev.ref, createdTs: cur?.createdTs ?? ev.ts, updatedTs: ev.ts, removedTs: ev.ts, apps: cur?.apps ?? {}, order: ord };
    }
  } else if (ev.kind === "highlight.set" && typeof ev.ref === "string" && splitRef(ev.ref)?.verse != null) {
    const cur = state.highlights[ev.ref];
    const givenCreated = Number.isFinite(ev.data.createdTs) ? ev.data.createdTs : ev.ts;
    const earliest = cur?.createdTs ? Math.min(cur.createdTs, givenCreated) : givenCreated;
    if (beats(ord, cur?.order)) {
      state.highlights[ev.ref] = {
        ref: ev.ref,
        color: String(ev.data.color || "yellow"),
        quote: typeof ev.data.quote === "string" ? ev.data.quote : (cur?.quote ?? ""),
        edited: Boolean(cur && !cur.deleted),
        createdTs: earliest,
        updatedTs: ev.ts,
        deleted: false,
        order: ord,
      };
    } else if (cur) cur.createdTs = earliest;
  } else if (ev.kind === "highlight.removed" && typeof ev.ref === "string") {
    const cur = state.highlights[ev.ref];
    if (beats(ord, cur?.order)) {
      state.highlights[ev.ref] = { ...(cur ?? { ref: ev.ref, color: "yellow", createdTs: ev.ts }), updatedTs: ev.ts, deleted: true, order: ord };
    }
  } else if (ev.kind === "color.set" && typeof ev.data.id === "string" && COLOR_ID.test(ev.data.id)) {
    const id = ev.data.id;
    const cur = state.colors[id];
    const earliest = cur?.createdTs ? Math.min(cur.createdTs, ev.ts) : ev.ts;
    if (beats(ord, cur?.order)) {
      state.colors[id] = { id, name: String(ev.data.name ?? ""), hex: typeof ev.data.hex === "string" ? ev.data.hex : (cur?.hex ?? null), createdTs: earliest, updatedTs: ev.ts, deleted: false, order: ord };
    }
  } else if (ev.kind === "color.removed" && typeof ev.data.id === "string") {
    const id = ev.data.id;
    const cur = state.colors[id];
    if (beats(ord, cur?.order)) {
      state.colors[id] = { ...(cur ?? { id, name: "", hex: null, createdTs: ev.ts }), updatedTs: ev.ts, deleted: true, order: ord };
    }
  } else if (ev.kind === "note.block.set" && typeof ev.data.id === "string") {
    const id = ev.data.id;
    const cur = state.blocks[id];
    if (beats(ord, cur?.order)) {
      state.blocks[id] = { id, ref: ev.ref, outlineId: String(ev.data.outlineId ?? (ev.ref || "inbox")), parentId: ev.data.parentId ?? null, rank: String(ev.data.rank ?? "n"), text: String(ev.data.text ?? ""), card: ev.data.card ?? null, apps: ev.data.apps ?? {}, updatedTs: ev.ts, deleted: false, order: ord };
    }
  } else if (ev.kind === "note.block.deleted" && typeof ev.data.id === "string") {
    const id = ev.data.id;
    const cur = state.blocks[id];
    if (beats(ord, cur?.order)) state.blocks[id] = { ...(cur ?? { id, ref: ev.ref }), updatedTs: ev.ts, deleted: true, order: ord };
  } else if ((ev.kind === "srs.reviewed" || ev.kind === "srs.card") && typeof ev.data.cardKey === "string") {
    const list = (state.srsEvents[ev.data.cardKey] ??= []);
    list.push(ev);
    list.sort(compareEventOrder);
  }
  return true;
}

export function projectSrsCards(state) {
  const out = [];
  for (const [cardKey, evs] of Object.entries(state.srsEvents)) {
    let cardState = "absent";
    let lastActiveTs = null;
    let lastResetTs = null;
    let reviews = [];
    let ref = cardKey.includes("#") && !cardKey.startsWith("x-") ? cardKey.split("#")[0] : null;
    for (const ev of evs) {
      if (ev.ref) ref = ev.ref;
      if (ev.kind === "srs.reviewed") {
        cardState = "active";
        lastActiveTs = ev.ts;
        reviews.push({ id: ev.id, ts: ev.ts, rating: ev.data.rating, ...(ev.data.rung ? { rung: ev.data.rung } : {}), ...(ev.data.hints !== undefined ? { hints: ev.data.hints } : {}), ...(ev.data.promptCard ? { promptCard: ev.data.promptCard } : {}) });
      } else {
        const action = ev.data.action;
        if (action === "add" || action === "resume") {
          cardState = "active";
          lastActiveTs = ev.ts;
        } else if (action === "suspend") {
          if (cardState === "active") cardState = "suspended";
        } else if (action === "drop") {
          if (cardState === "active" || cardState === "suspended") cardState = "dropped";
        } else if (action === "reset") {
          lastResetTs = ev.ts;
          reviews = [];
        }
      }
    }
    if (cardState === "absent") continue;
    const passageRef = cardKey.includes("#") && !cardKey.startsWith("x-") ? cardKey.split("#")[0] : null;
    const removedTs = passageRef ? state.passages[passageRef]?.removedTs ?? null : null;
    const pausedByPassage = Boolean(removedTs && lastActiveTs !== null && lastActiveTs <= removedTs);
    out.push({ cardKey, ref, state: cardState, lastActiveTs, lastResetTs, pausedByPassage, reviews });
  }
  return out;
}

export function hydrateStateFromBootstrap(state, snap) {
  if (!snap || typeof snap !== "object") return;
  state.seq = Math.max(state.seq, Number(snap.seq) || 0);
  if (snap.library?.name) {
    state.syncedName = snap.library.name;
    state.nameOrder = { ts: 1, id: "ev_bootstrap_name" };
  }
  for (const p of snap.passages ?? []) {
    state.passages[p.ref] = { ref: p.ref, createdTs: p.createdTs ?? 0, updatedTs: p.updatedTs ?? 0, removedTs: null, apps: p.apps ?? {}, order: { ts: p.updatedTs ?? 0, id: "ev_bootstrap" } };
  }
  for (const r of snap.removedPassages ?? []) {
    const cur = state.passages[r.ref];
    state.passages[r.ref] = { ref: r.ref, createdTs: cur?.createdTs ?? r.removedTs ?? 0, updatedTs: r.removedTs ?? 0, removedTs: r.removedTs ?? 0, apps: cur?.apps ?? {}, order: { ts: r.removedTs ?? 0, id: "ev_bootstrap" } };
  }
  for (const h of snap.highlights ?? []) {
    state.highlights[h.ref] = { ref: h.ref, color: h.color || "yellow", quote: h.quote ?? "", createdTs: h.createdTs ?? 0, updatedTs: h.updatedTs ?? 0, deleted: false, order: { ts: h.updatedTs ?? 0, id: "ev_bootstrap" } };
  }
  for (const c of snap.colors ?? []) {
    if (c.builtIn && !c.name) continue;
    state.colors[c.id] = { id: c.id, name: c.name ?? "", hex: c.hex ?? null, createdTs: c.createdTs ?? 0, updatedTs: c.updatedTs ?? 0, deleted: false, order: { ts: c.updatedTs ?? 0, id: "ev_bootstrap" } };
  }
  for (const b of snap.blocks ?? []) {
    state.blocks[b.id] = { ...b, deleted: false, order: { ts: b.updatedTs ?? 0, id: "ev_bootstrap" } };
  }
  for (const c of snap.srs?.cards ?? []) {
    const list = [];
    if (c.lastResetTs) list.push({ id: `ev_boot_rst_${c.cardKey}`, ts: c.lastResetTs, app: "selah-vault", kind: "srs.card", ref: c.ref, data: { cardKey: c.cardKey, action: "reset" } });
    if (c.lastActiveTs) list.push({ id: `ev_boot_act_${c.cardKey}`, ts: c.lastActiveTs, app: "selah-vault", kind: "srs.card", ref: c.ref, data: { cardKey: c.cardKey, action: "add" } });
    for (const rv of c.reviews ?? []) list.push({ id: rv.id || newEventId(), ts: rv.ts, app: "selah-vault", kind: "srs.reviewed", ref: c.ref, data: { cardKey: c.cardKey, ...rv } });
    if (c.state === "suspended") list.push({ id: `ev_boot_sus_${c.cardKey}`, ts: (c.lastActiveTs ?? 0) + 1, app: "selah-vault", kind: "srs.card", ref: c.ref, data: { cardKey: c.cardKey, action: "suspend" } });
    if (c.state === "dropped") list.push({ id: `ev_boot_drp_${c.cardKey}`, ts: (c.lastActiveTs ?? 0) + 1, app: "selah-vault", kind: "srs.card", ref: c.ref, data: { cardKey: c.cardKey, action: "drop" } });
    list.sort(compareEventOrder);
    state.srsEvents[c.cardKey] = list;
  }
}

function recordToEvents(record, { app = "selah-vault", ts = nowMs() } = {}) {
  if (!record || typeof record !== "object") throw new Error("a record is a JSON object");
  if (typeof record.id === "string" && record.id.startsWith("ev_") && typeof record.kind === "string" && record.kind.includes(".")) {
    return [record];
  }
  const { kind, ref } = record;
  if (typeof kind !== "string" || typeof ref !== "string") throw new Error("kind and ref are required");
  const eventTs = Number.isSafeInteger(record.updated) ? record.updated * 1000 : ts;
  const make = (evKind, evRef, data) => ({
    id: newEventId(),
    ts: eventTs,
    app,
    kind: evKind,
    ref: evRef,
    tags: autoTags(evKind, evRef, data),
    data,
  });

  if (kind === "library") {
    if (ref !== "name") throw new Error(`not a library setting: ${ref}`);
    if (record.deleted) return [];
    if (typeof record.name !== "string" || !record.name.trim()) throw new Error("a library's name is text");
    return [make("library.renamed", null, { name: record.name.trim() })];
  }
  if (kind === "color") {
    if (!COLOR_ID.test(ref)) throw new Error(`not a color id: ${ref}`);
    if (record.deleted === true) return [make("color.removed", null, { id: ref })];
    if (record.hex !== undefined && record.hex !== null && !HEX.test(record.hex)) throw new Error("hex looks like #RRGGBB");
    if (!record.hex && !COLORS.includes(ref)) throw new Error("a new color needs a hex");
    return [make("color.set", null, { id: ref, name: String(record.name ?? ""), ...(record.hex ? { hex: record.hex.toLowerCase() } : {}) })];
  }
  const parsed = splitRef(ref);
  if (!parsed) throw new Error(`not a canonical ref: ${ref}`);
  if (kind === "highlight") {
    if (parsed.verse === null || parsed.end !== null) throw new Error("a highlight's ref is one verse");
    if (record.deleted === true) return [make("highlight.removed", ref, {})];
    const parts = Array.isArray(record.highlights) ? record.highlights : record.color ? [{ color: record.color }] : [];
    if (!parts.length || parts.some((h) => !h || typeof h.color !== "string")) throw new Error("every highlight needs a color");
    const best = parts.reduce((a, b) => ((b.edited ?? b.created ?? 0) >= (a.edited ?? a.created ?? 0) ? b : a));
    const quote = parts.map((h) => h.quote).filter(Boolean).join(" … ");
    const createdSec = parts.map((h) => h.created).filter(Number.isSafeInteger);
    const createdTs = createdSec.length ? Math.min(...createdSec) * 1000 : undefined;
    return [make("highlight.set", ref, { color: best.color, ...(quote ? { quote } : {}), ...(createdTs ? { createdTs } : {}) })];
  }
  if (kind === "passage") {
    return [make(record.deleted === true ? "passage.removed" : "passage.saved", ref, record.deleted ? {} : { apps: record.apps ?? {} })];
  }
  if (kind === "note") {
    const blockId = `b_${ref}`;
    if (record.deleted === true) return [make("note.block.deleted", ref, { id: blockId })];
    return [make("note.block.set", ref, { id: blockId, outlineId: ref, parentId: null, rank: "n", text: String(record.body ?? "") })];
  }
  throw new Error(`unknown kind ${kind}`);
}

export function parseJsonl(text) {
  const out = [];
  for (const line of String(text ?? "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    const obj = JSON.parse(line);
    if (!obj || typeof obj !== "object") continue;
    if (obj["selah-vault"] !== undefined) continue;
    if (typeof obj.kind === "string" && obj.kind.includes(".") && typeof obj.id === "string") out.push(obj);
    else if (typeof obj.kind === "string" && typeof obj.ref === "string") out.push(obj);
  }
  return out;
}

export function memoryStore() {
  const m = new Map();
  return {
    load: (lib) => structuredClone(m.get(lib) ?? null),
    save: (lib, s) => m.set(lib, structuredClone(s)),
    clear: (lib) => m.delete(lib),
  };
}

function toHighlightRecord(h) {
  const created = Math.floor((h.createdTs || 0) / 1000);
  const updated = Math.floor((h.updatedTs || 0) / 1000);
  const part = { color: h.color, created, ...(h.edited && updated >= created ? { edited: updated } : {}), ...(h.quote ? { quote: h.quote } : {}) };
  return { kind: "highlight", ref: h.ref, highlights: [part], updated };
}

function toColorRecord(c) {
  return { kind: "color", id: c.id, ref: c.id, name: c.name ?? "", ...(c.hex ? { hex: c.hex } : {}), createdTs: c.createdTs, updatedTs: c.updatedTs, created: Math.floor((c.createdTs || 0) / 1000), updated: Math.floor((c.updatedTs || 0) / 1000) };
}

export class Library {
  static async open({ lib, userId, token = null, name = "Personal", app = "selah-vault", store = memoryStore(), transports = [] } = {}) {
    const id = userId || lib || (token?.startsWith("sv2.") ? token.split(".")[1] : null) || `local_${b64url(randomBytes(8))}`;
    return new Library({ lib: id, token, name, app, store, transports });
  }

  constructor({ lib = "local", token = null, name = "Personal", app = "selah-vault", store = memoryStore(), transports = [] } = {}) {
    Object.assign(this, { id: lib, token, localName: name, app, store, transports });
    const saved = store.load(lib);
    this.state = saved?.v === FORMAT ? saved : emptyProjectedState();
    this.lastTs = nowMs();
    this.status = { state: transports.length ? "idle" : "local", remotes: {} };
    this.listeners = new Set();
    this.running = null;
    this.again = false;
  }

  get lib() {
    return this.id;
  }

  get name() {
    return this.syncedName ?? this.localName;
  }

  get syncedName() {
    return this.state.syncedName ?? null;
  }

  nextTs() {
    this.lastTs = Math.max(nowMs(), this.lastTs + 1);
    return this.lastTs;
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit() {
    this.store.save(this.lib, this.state);
    for (const fn of this.listeners) fn(this);
  }

  all(kind) {
    if (kind === "highlight") {
      return Object.values(this.state.highlights).filter((h) => !h.deleted).map(toHighlightRecord);
    }
    if (kind === "color") {
      return Object.values(this.state.colors).filter((c) => !c.deleted).map(toColorRecord);
    }
    if (kind === "passage") {
      return Object.values(this.state.passages).filter((p) => !p.removedTs).map((p) => ({ kind: "passage", ...p }));
    }
    if (kind === "block" || kind === "note") {
      return Object.values(this.state.blocks).filter((b) => !b.deleted).map((b) => ({ kind: "block", ...b }));
    }
    if (kind === "library") {
      return this.syncedName ? [{ kind: "library", ref: "name", name: this.syncedName }] : [];
    }
    if (!kind) {
      return [...this.all("highlight"), ...this.all("color"), ...this.all("passage"), ...this.all("block"), ...this.all("library")];
    }
    return [];
  }

  find(kind, ref) {
    return this.all(kind).find((r) => r.ref === ref || r.id === ref) ?? null;
  }

  srsCards() {
    return projectSrsCards(this.state);
  }

  async appendEvents(rawEvents) {
    if (!rawEvents?.length) return [];
    const prepared = rawEvents.map((ev) => ({
      id: ev.id || newEventId(),
      ts: Number.isFinite(ev.ts) ? Math.trunc(ev.ts) : this.nextTs(),
      app: ev.app || this.app,
      kind: ev.kind,
      ref: ev.ref ?? null,
      tags: Array.isArray(ev.tags) ? ev.tags : autoTags(ev.kind, ev.ref, ev.data),
      data: ev.data ?? {},
    }));
    for (const ev of prepared) {
      if (applyEventToState(this.state, ev)) this.state.outbox.push(ev);
    }
    this.emit();
    this.sync();
    return prepared;
  }

  async put(record) {
    await this.putMany([record]);
    return record;
  }

  async putMany(records) {
    const events = [];
    for (const record of records) {
      const clean = record?.id?.startsWith?.("ev_") ? record : { ...record, updated: undefined };
      events.push(...recordToEvents(clean, { app: this.app, ts: this.nextTs() }));
    }
    if (events.length) await this.appendEvents(events);
  }

  remove(kind, ref) {
    return this.put({ kind, ref, deleted: true });
  }

  async highlightRange(ref, color = "yellow", options = {}) {
    const w = rangeWrites(ref, color, now(), (v) => this.find("highlight", v), options);
    if (w.error) throw new Error(w.error);
    if (w.records.length) await this.putMany(w.records);
    return { ref: w.ref, verses: w.verses, written: w.records.map((r) => r.ref) };
  }

  highlights({ group } = {}) {
    const records = this.all("highlight").sort((a, b) => compareRefs(a.ref, b.ref));
    if (group === undefined || group === "verses") return records;
    if (group !== "ranges") throw new Error(`unknown group ${group}`);
    return rangeView(listRanges(records, palette(this.all("color")).map((c) => c.id)));
  }

  async savePassage(ref, { apps = {} } = {}) {
    if (!splitRef(ref)) throw new Error(`not a canonical ref: ${ref}`);
    await this.appendEvents([{ kind: "passage.saved", ref, data: { apps } }]);
    return this.find("passage", ref);
  }

  async removePassage(ref) {
    if (!splitRef(ref)) throw new Error(`not a canonical ref: ${ref}`);
    await this.appendEvents([{ kind: "passage.removed", ref, data: {} }]);
  }

  async putColor({ id, name = "", hex = null }) {
    return this.put({ kind: "color", ref: id, name, ...(hex ? { hex } : {}) });
  }

  rename(name) {
    this.localName = name;
    return this.put({ kind: "library", ref: "name", name });
  }

  async adoptName() {
    if (this.syncedName !== null || !this.localName || this.erased) return false;
    if (this.transports.some((t) => this.status.remotes[t.name]?.state !== "synced")) return false;
    await this.appendEvents([{ id: newEventId(), ts: 1, app: this.app, kind: "library.renamed", ref: null, data: { name: this.localName } }]);
    return true;
  }

  async merge(entries) {
    let changed = 0;
    const added = [];
    for (const entry of entries) {
      let evs;
      try {
        evs = recordToEvents(entry, { app: this.app, ts: this.nextTs() });
      } catch {
        continue;
      }
      for (const ev of evs) {
        if (applyEventToState(this.state, ev)) {
          added.push(ev);
          changed++;
        }
      }
    }
    if (added.length) {
      this.state.outbox.push(...added);
      this.emit();
      this.sync();
    }
    return changed;
  }

  toFile() {
    const header = { "selah-vault": FORMAT, library: this.lib, name: this.name, exportedAt: nowMs() };
    const lines = [JSON.stringify(header)];
    if (this.state.events.length) {
      for (const ev of this.state.events) lines.push(JSON.stringify(ev));
    } else {
      if (this.syncedName) lines.push(JSON.stringify({ id: newEventId(), ts: nowMs(), app: this.app, kind: "library.renamed", ref: null, data: { name: this.syncedName } }));
      for (const c of Object.values(this.state.colors).filter((x) => !x.deleted)) {
        lines.push(JSON.stringify({ id: newEventId(), ts: c.updatedTs || nowMs(), app: this.app, kind: "color.set", ref: null, data: { id: c.id, name: c.name, ...(c.hex ? { hex: c.hex } : {}) } }));
      }
      for (const p of Object.values(this.state.passages).filter((x) => !x.removedTs)) {
        lines.push(JSON.stringify({ id: newEventId(), ts: p.updatedTs || nowMs(), app: this.app, kind: "passage.saved", ref: p.ref, data: { apps: p.apps ?? {} } }));
      }
      for (const h of Object.values(this.state.highlights).filter((x) => !x.deleted)) {
        lines.push(JSON.stringify({ id: newEventId(), ts: h.updatedTs || nowMs(), app: this.app, kind: "highlight.set", ref: h.ref, data: { color: h.color, ...(h.quote ? { quote: h.quote } : {}) } }));
      }
    }
    return `${lines.join("\n")}\n`;
  }

  waiting() {
    return this.transports.length ? this.state.outbox.length : 0;
  }

  use(transports) {
    for (const t of this.transports) t.close?.();
    this.transports = transports;
    this.status = { state: transports.length ? "idle" : "local", remotes: {} };
    this.emit();
    return this.sync();
  }

  sync() {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      await null;
      try {
        do {
          this.again = false;
          for (const t of this.transports) {
            try {
              await t.sync(this);
              this.status.remotes[t.name] = { state: "synced" };
            } catch (error) {
              this.status.remotes[t.name] = { state: error instanceof SyncError ? "error" : "offline", error };
            }
          }
        } while (this.again);
      } finally {
        this.running = null;
        this.setStatus();
      }
    })();
    return this.running;
  }

  setStatus() {
    const states = this.transports.map((t) => this.status.remotes[t.name]?.state ?? "idle");
    const worst = ["error", "offline", "idle", "synced"].find((s) => states.includes(s));
    this.status.state = this.transports.length ? worst : "local";
    this.status.failures = worst === "error" || worst === "offline" ? (this.status.failures ?? 0) + 1 : 0;
    this.emit();
  }

  async erase() {
    this.erased = true;
    for (const t of this.transports) {
      t.close?.();
      await t.erase?.(this);
    }
    this.state = emptyProjectedState();
    this.store.clear(this.lib);
    for (const fn of this.listeners) fn(this);
  }

  forget() {
    for (const t of this.transports) t.close?.();
    this.listeners.clear();
  }
}

export function serverTransport({ url = "", token = null, fetch: fetchFn, WebSocket: WsClass = globalThis.WebSocket } = {}) {
  const base = url.replace(/\/$/, "");
  const name = `server ${base}`;
  let ws = null;
  let closed = false;

  const call = async (lib, method, path, body) => {
    const authToken = token ?? lib.token;
    const headers = {};
    if (authToken) headers.authorization = `Bearer ${authToken}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    const res = await (fetchFn ?? globalThis.fetch.bind(globalThis))(`${base}${path}`, {
      method,
      credentials: authToken ? "omit" : "same-origin",
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new SyncError(res.status, await res.text().catch(() => ""));
    return res.status === 204 ? null : res.json();
  };

  const openSocket = (lib) => {
    if (closed || ws || !WsClass) return;
    try {
      const origin = base || (typeof location !== "undefined" ? location.origin : "");
      if (!origin || !/^https?:\/\//.test(origin)) return;
      const wsUrl = `${origin.replace(/^http/, "ws")}/v2/ws`;
      const authToken = token ?? lib.token;
      const protocols = authToken ? ["selah-v2", `token.${authToken}`] : ["selah-v2"];
      ws = new WsClass(wsUrl, protocols);
      ws.addEventListener("message", (e) => {
        try {
          const msg = JSON.parse(String(e.data));
          if ((msg?.type === "poke" || msg?.type === "hello") && Number(msg.seq) > lib.state.seq) {
            lib.sync();
          }
        } catch {}
      });
      const clear = () => { ws = null; };
      ws.addEventListener("close", clear);
      ws.addEventListener("error", clear);
    } catch {
      ws = null;
    }
  };

  return {
    name,
    async sync(lib) {
      while (lib.state.outbox.length) {
        const chunk = lib.state.outbox.slice(0, EVENT_BATCH);
        const payload = chunk.map(({ seq: _seq, ...rest }) => rest);
        const answer = await call(lib, "POST", "/v2/events", { events: payload });
        const sentIds = new Set(chunk.map((e) => e.id));
        lib.state.outbox = lib.state.outbox.filter((e) => !sentIds.has(e.id));
        if (Number.isInteger(answer?.seq) && lib.state.seq > 0 && answer.seq - (answer.accepted ?? 0) === lib.state.seq) {
          lib.state.seq = answer.seq;
        }
        lib.emit();
      }

      if (lib.state.seq === 0) {
        const snap = await call(lib, "GET", "/v2/bootstrap");
        hydrateStateFromBootstrap(lib.state, snap);
        lib.emit();
      } else {
        for (;;) {
          const page = await call(lib, "GET", `/v2/events?after=${lib.state.seq}&limit=${EVENT_BATCH}`);
          let changed = false;
          for (const ev of page.events ?? []) {
            if (applyEventToState(lib.state, ev)) changed = true;
          }
          lib.state.seq = Math.max(lib.state.seq, Number(page.seq) || 0);
          if (changed) lib.emit();
          if (!page.more) break;
        }
      }
      openSocket(lib);
    },
    async erase(lib) {
      this.close();
      await call(lib, "DELETE", "/v2/library");
    },
    close() {
      closed = true;
      try { ws?.close(); } catch {}
      ws = null;
    },
  };
}







