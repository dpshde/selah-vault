// Selah Vault reference client (spec v1.2). Needs only WebCrypto and fetch, so it runs in browsers,
// Bun, Node 20+, Deno and Workers.
import { compareRefs, splitRef } from "./refs.js";

const te = new TextEncoder();
const td = new TextDecoder();
const subtle = globalThis.crypto.subtle;

import { COLORS, listRanges, rangeView, rangeWrites, stamp, topColor } from "./ranges.js";

export { COLORS, topColor };
export const KINDS = ["highlight", "note", "color", "library"];
/** The ref of the `library` record that holds the library's name (spec section 1.5). */
export const NAME_REF = "name";
const COLOR_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const HEX = /^#[0-9a-fA-F]{6}$/;
const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const PAD = 256;
const BATCH = 100;
const FORMAT = 2;
const TIMEOUT_MS = 20_000;

export class KeyError extends Error {
  constructor() {
    super("That sync key has a typo.");
  }
}

export class SyncError extends Error {
  constructor(status, body) {
    super(`server answered ${status}${body ? `: ${body}` : ""}`);
    this.status = status;
  }
}

// ---- bytes and primitives

export const now = () => Math.floor(Date.now() / 1000);
export const randomBytes = (n) => crypto.getRandomValues(new Uint8Array(n));
export const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

export function b64url(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromB64url(text) {
  const s = text.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(s + "=".repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

const sha256 = async (bytes) => new Uint8Array(await subtle.digest("SHA-256", bytes));

async function hkdf(ikm, info, length) {
  const key = await subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const bits = await subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: te.encode(info) },
    key,
    length * 8,
  );
  return new Uint8Array(bits);
}

const aesKey = (raw) => subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);

/** base64url(nonce ‖ AES-256-GCM(plaintext)), with `aad` bound as associated data. */
async function seal(key, aad, plaintext, nonce = randomBytes(12)) {
  const ct = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: te.encode(aad) }, key, plaintext));
  const out = new Uint8Array(12 + ct.length);
  out.set(nonce);
  out.set(ct, 12);
  return b64url(out);
}

async function unseal(key, aad, blob) {
  const b = fromB64url(blob);
  const pt = await subtle.decrypt({ name: "AES-GCM", iv: b.subarray(0, 12), additionalData: te.encode(aad) }, key, b.subarray(12));
  return new Uint8Array(pt);
}

function base32(bytes) {
  let out = "";
  let value = 0;
  let bits = 0;
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function unbase32(text) {
  const bytes = [];
  let value = 0;
  let bits = 0;
  for (const ch of text) {
    value = (value << 5) | B32.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
    value &= (1 << bits) - 1;
  }
  return { bytes: Uint8Array.from(bytes), rest: value };
}

// ---- the sync key

export const newKey = () => randomBytes(16);

/** 16 key bytes + 1 check byte (SHA-256(key)[0]) → 28 Crockford base32 chars in groups of 4. */
export async function formatKey(key) {
  const check = (await sha256(key))[0];
  return base32(Uint8Array.of(...key, check)).match(/.{4}/g).join("-");
}

/** Accepts any case, spaces or dashes, and O/I/L for 0/1. Throws KeyError on a typo. */
export async function parseKey(text) {
  const s = String(text).toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
  if (!/^[0-9A-HJKMNP-TV-Z]{28}$/.test(s)) throw new KeyError();
  const { bytes, rest } = unbase32(s);
  const key = bytes.slice(0, 16);
  if (rest !== 0 || bytes.length !== 17 || (await sha256(key))[0] !== bytes[16]) throw new KeyError();
  return key;
}

export async function deriveKeys(key) {
  const [lib, auth, enc, mac] = await Promise.all([
    hkdf(key, "hidden-word/v1/lib", 16),
    hkdf(key, "hidden-word/v1/auth", 32),
    hkdf(key, "hidden-word/v1/enc", 32),
    hkdf(key, "hidden-word/v1/mac", 32),
  ]);
  return {
    lib: hex(lib),
    auth: b64url(auth),
    enc: await aesKey(enc),
    mac: await subtle.importKey("raw", mac, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]),
  };
}

/** The library id, its raw decryption key and item-id key (hex): what a grant's app needs to read, and to write records. */
export async function readKeys(key) {
  return {
    lib: hex(await hkdf(key, "hidden-word/v1/lib", 16)),
    enc: hex(await hkdf(key, "hidden-word/v1/enc", 32)),
    mac: hex(await hkdf(key, "hidden-word/v1/mac", 32)),
  };
}

export async function itemId(keys, kind, ref) {
  const mac = new Uint8Array(await subtle.sign("HMAC", keys.mac, te.encode(`${kind} ${ref}`)));
  return b64url(mac).slice(0, 22);
}

/** UTF-8 JSON padded with spaces to a multiple of 256 bytes, so sizes don't reveal note length. */
export function pad(json) {
  const bytes = te.encode(json);
  const out = new Uint8Array(Math.max(PAD, Math.ceil(bytes.length / PAD) * PAD)).fill(0x20);
  out.set(bytes);
  return out;
}

export async function encryptRecord(keys, record, nonce) {
  const id = await itemId(keys, record.kind, record.ref);
  return { id, blob: await seal(keys.enc, id, pad(JSON.stringify(record)), nonce) };
}

/** The record's JSON text as its writer encrypted it, without the padding. */
export async function decryptText(keys, id, blob) {
  return td.decode(await unseal(keys.enc, id, blob)).replace(/ +$/, "");
}

export async function decryptRecord(keys, id, blob) {
  return JSON.parse(await decryptText(keys, id, blob));
}

// ---- records

/** Null when the record is valid, else what's wrong. Unknown fields are always allowed. */
export function checkRecord(r) {
  if (!r || typeof r !== "object" || Array.isArray(r)) return "a record is a JSON object";
  if (typeof r.kind !== "string" || typeof r.ref !== "string") return "kind and ref are required";
  if (r.updated !== undefined && !Number.isSafeInteger(r.updated)) return "updated is a whole number of seconds";
  if (r.kind.startsWith("x-")) return null;
  if (!KINDS.includes(r.kind)) return `unknown kind ${r.kind}`;
  if (r.kind === "library") {
    if (r.ref !== NAME_REF) return `not a library setting: ${r.ref}`;
    if (r.deleted === true) return null;
    if (typeof r.name !== "string" || !r.name.trim()) return "a library's name is text";
    return null;
  }
  if (r.kind === "color") {
    if (!COLOR_ID.test(r.ref)) return `not a color id: ${r.ref}`;
    if (r.deleted === true) return null;
    if (r.hex !== undefined && !HEX.test(r.hex)) return "hex looks like #RRGGBB";
    if (r.hex === undefined && !COLORS.includes(r.ref)) return "a new color needs a hex";
    if (r.name !== undefined && typeof r.name !== "string") return "a color's name is text";
    return null;
  }
  const ref = splitRef(r.ref);
  if (!ref) return `not a canonical ref: ${r.ref}`;
  if (r.deleted === true) return null;
  if (r.kind === "highlight") {
    if (ref.verse === null || ref.end !== null) return "a highlight's ref is one verse";
    if (!Array.isArray(r.highlights) || !r.highlights.length) return "highlights must be a non-empty list";
    if (r.highlights.some((h) => !h || typeof h.color !== "string")) return "every highlight needs a color";
  }
  if (r.kind === "note" && typeof r.body !== "string") return "a note needs a body";
  return null;
}

/**
 * A well-formed record of a kind this client doesn't know (a later version's, such as `passage`,
 * `block` or `srs-log`). It can't be checked or shown here, and MUST be kept (SPEC.md 1), so a
 * file import carries it the same way a server does.
 */
export function isUnknownKind(r) {
  if (!r || typeof r !== "object" || Array.isArray(r)) return false;
  if (typeof r.kind !== "string" || typeof r.ref !== "string" || !r.kind || !r.ref) return false;
  if (r.updated !== undefined && !Number.isSafeInteger(r.updated)) return false;
  return !KINDS.includes(r.kind) && !r.kind.startsWith("x-");
}

/**
 * The merge rule: > 0 when version `a` beats `b`. The larger `updated` wins; on a tie, the JSON
 * text that sorts later as UTF-8 bytes. Every device, server and file compares the same way, so
 * they all keep the same version whatever order changes arrive in.
 */
export function compareVersions(a, b) {
  const d = (Number.isSafeInteger(a.updated) ? a.updated : 0) - (Number.isSafeInteger(b.updated) ? b.updated : 0);
  if (d) return d;
  const x = te.encode(a.text);
  const y = te.encode(b.text);
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] - y[i];
  return x.length - y.length;
}

/** The library's colors: the six built in (named, when the library names them), then its own. */
export function palette(colorRecords) {
  const byId = new Map(colorRecords.filter((r) => r.kind === "color" && !r.deleted).map((r) => [r.ref, r]));
  const builtIn = COLORS.map((id) => ({ id, name: byId.get(id)?.name ?? "", hex: null, builtIn: true }));
  const own = [...byId.values()]
    .filter((r) => !COLORS.includes(r.ref) && HEX.test(r.hex ?? ""))
    .sort((a, b) => (a.created ?? 0) - (b.created ?? 0) || a.ref.localeCompare(b.ref))
    .map((r) => ({ id: r.ref, name: r.name ?? "", hex: r.hex.toLowerCase(), builtIn: false }));
  return [...builtIn, ...own];
}


// ---- files

/** JSON Lines. Later lines win; lines that aren't records (like a file's header) are skipped. */
export function parseJsonl(text) {
  const out = new Map();
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const r = JSON.parse(line);
    if (typeof r?.kind !== "string" || typeof r.ref !== "string") continue;
    out.set(`${r.kind} ${r.ref}`, r);
  }
  return [...out.values()];
}

// ---- a library on this device

export function memoryStore() {
  const m = new Map();
  return { load: (lib) => structuredClone(m.get(lib) ?? null), save: (lib, s) => m.set(lib, structuredClone(s)), clear: (lib) => m.delete(lib) };
}

// items: id → { t: the record's JSON text, n: local change number, s: the transport it came from }
const emptyState = () => ({ v: FORMAT, device: b64url(randomBytes(9)), n: 0, items: {}, remotes: {} });

export class Library {
  /** `name` is what this device calls the library until a synced name arrives (the name typed to unlock). */
  static async open({ keyText, name = "Personal", store = memoryStore(), transports = [] }) {
    const key = await parseKey(keyText);
    const keys = await deriveKeys(key);
    return new Library({ keyText: await formatKey(key), name, store, keys, transports });
  }

  constructor({ keyText, name, store, keys, transports }) {
    Object.assign(this, { keyText, store, keys, transports });
    this.localName = name;
    const saved = store.load(keys.lib);
    this.state = saved?.v === FORMAT ? saved : emptyState();
    this.records = new Map(Object.entries(this.state.items).map(([id, it]) => [id, JSON.parse(it.t)]));
    this.blobs = new Map();
    this.status = { state: transports.length ? "idle" : "local", remotes: {} };
    this.listeners = new Set();
    this.running = null;
    this.again = false;
  }

  get lib() {
    return this.keys.lib;
  }

  /** The library's synced name (its `library name` record), else what this device called it. */
  get name() {
    return this.syncedName ?? this.localName;
  }

  /** The name from the library itself, or null when no device has written one yet. */
  get syncedName() {
    return this.find("library", NAME_REF)?.name ?? null;
  }

  /** Renames the library everywhere: a `library name` record, synced like any other edit. */
  rename(name) {
    this.localName = name;
    return this.put({ ...(this.find("library", NAME_REF) ?? {}), kind: "library", ref: NAME_REF, name });
  }

  /**
   * Gives a library that has no name record this device's name for it, once every transport has
   * synced, so a name chosen elsewhere has arrived first. It's written with `updated` 0, so it never
   * beats a name chosen on any device: a name typed to unlock never renames a library.
   */
  async adoptName() {
    if (this.syncedName !== null || !this.localName) return false;
    if (this.transports.some((t) => this.status.remotes[t.name]?.state !== "synced")) return false;
    const id = await itemId(this.keys, "library", NAME_REF);
    if (this.state.items[id] || this.erased) return false;
    const r = { kind: "library", ref: NAME_REF, updated: 0, name: this.localName };
    this.write(id, r, JSON.stringify(r), null);
    this.emit();
    this.sync();
    return true;
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit() {
    this.store.save(this.lib, this.state);
    for (const fn of this.listeners) fn(this);
  }

  /** Sets how this library syncs: through its server (`serverTransport`), or not at all (`[]`). */
  use(transports) {
    this.transports = transports;
    this.status = { state: transports.length ? "idle" : "local", remotes: {} };
    this.emit();
    return this.sync();
  }

  /** Every live record, optionally of one kind. */
  all(kind) {
    return [...this.records.values()].filter((r) => !r.deleted && (!kind || r.kind === kind));
  }

  find(kind, ref) {
    return this.all(kind).find((r) => r.ref === ref) ?? null;
  }

  async put(record) {
    await this.putMany([record]);
    return record;
  }

  /**
   * Saves edits on this device at once and syncs in the background. Each gets `updated` = now, or
   * one second past the version it replaces when this device's clock is behind, so an edit always
   * beats what it was made from. All or nothing: one bad record and nothing is saved. Up to 100
   * records saved together reach a server in one POST, so it takes all of them or none.
   */
  async putMany(records) {
    const t = now();
    for (const record of records) {
      const err = checkRecord(record);
      if (err) throw new Error(err);
    }
    const ids = await Promise.all(records.map((record) => itemId(this.keys, record.kind, record.ref)));
    // Written back to back with nothing awaited between, so they hold consecutive change numbers.
    const group = this.state.n + 1;
    records.forEach((record, i) => {
      const r = stamp(record, this.records.get(ids[i])?.updated, t);
      this.write(ids[i], r, JSON.stringify(r), null, records.length > 1 ? group : undefined);
    });
    this.emit();
    this.sync();
  }

  /**
   * Highlights a canonical verse or same-chapter range ("ROM.5.3-5") in one color: one record per
   * verse, saved together (one POST, all or none). Verses already that color stay as they are.
   * → { ref, verses, written }. Throws on a bad range (see ranges.js expandRange).
   */
  async highlightRange(ref, color = "yellow", options = {}) {
    const w = rangeWrites(ref, color, now(), (v) => this.find("highlight", v), options);
    if (w.error) throw new Error(w.error);
    if (w.records.length) await this.putMany(w.records);
    return { ref: w.ref, verses: w.verses, written: w.records.map((r) => r.ref) };
  }

  /**
   * Live highlight records in canonical order, one per verse; with { group: "ranges" }, the runs the
   * app lists (ranges.js listRanges): [{ ref, verses, color, time }].
   */
  highlights({ group } = {}) {
    const records = this.all("highlight").sort((a, b) => compareRefs(a.ref, b.ref));
    if (group === undefined || group === "verses") return records;
    if (group !== "ranges") throw new Error(`unknown group ${group}`);
    return rangeView(listRanges(records, palette(this.all("color")).map((c) => c.id)));
  }

  remove(kind, ref) {
    return this.put({ kind, ref, deleted: true });
  }

  /** Merges records from a file by the merge rule: each replaces this device's copy only if newer. */
  async merge(records) {
    let changed = 0;
    for (const record of records) {
      if (checkRecord(record) && !isUnknownKind(record)) continue;
      const r = Number.isSafeInteger(record.updated) ? record : { ...record, updated: now() };
      if ((await this.offer(r, JSON.stringify(r), null)) === "newer") changed++;
    }
    if (changed) {
      this.emit();
      this.sync();
    }
    return changed;
  }

  /** `group`: the first change number of a putMany, so a push keeps its records in one POST. */
  write(id, record, text, source, group) {
    this.state.items[id] = source ? { t: text, n: ++this.state.n, s: source } : group ? { t: text, n: ++this.state.n, g: group } : { t: text, n: ++this.state.n };
    this.records.set(id, record);
  }

  /** Keeps `record` if it beats this device's copy. "newer", "older" (this device's wins) or "same". */
  async offer(record, text, source, id) {
    id ??= await itemId(this.keys, record.kind, record.ref);
    const mine = this.state.items[id];
    const c = mine ? compareVersions({ updated: record.updated, text }, { updated: this.records.get(id).updated, text: mine.t }) : 1;
    if (c > 0) this.write(id, record, text, source);
    return c > 0 ? "newer" : c < 0 ? "older" : "same";
  }

  /** One encrypted item from a server. Items that don't decrypt, or sit under the wrong id, are "bad". */
  async receive(id, blob, source) {
    let text;
    let record;
    try {
      text = await decryptText(this.keys, id, blob);
      record = JSON.parse(text);
      if ((await itemId(this.keys, record.kind, record.ref)) !== id) return "bad";
    } catch {
      return "bad";
    }
    const result = await this.offer(record, text, source, id);
    if (result === "newer") this.blobs.set(id, { n: this.state.items[id].n, blob });
    return result;
  }

  async blob(id) {
    const item = this.state.items[id];
    const cached = this.blobs.get(id);
    if (cached?.n === item.n) return cached.blob;
    const blob = await seal(this.keys.enc, id, pad(item.t));
    this.blobs.set(id, { n: item.n, blob });
    return blob;
  }

  remote(name) {
    return (this.state.remotes[name] ??= { cursor: 0, seq: 0, epoch: null, sent: 0, all: false, redo: [] });
  }

  /** Ids a transport hasn't got yet, oldest change first. */
  unsent(name) {
    const r = this.remote(name);
    const redo = new Set(r.redo);
    return Object.entries(this.state.items)
      .filter(([id, it]) => r.all || redo.has(id) || (it.n > r.sent && it.s !== name))
      .sort((a, b) => a[1].n - b[1].n)
      .map(([id]) => id);
  }

  /** How many changes haven't reached any transport yet (all of them when there are none). */
  waiting() {
    if (!this.transports.length) return 0;
    return Math.min(...this.transports.map((t) => this.unsent(t.name).length));
  }

  /** Every transport in turn. Concurrent calls share one run. Never throws: see `status`. */
  sync() {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      // Without this, a run with nothing to await would finish before `running` is even set.
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

  /**
   * Sets `status.state` from the run that just finished: "synced", "offline", "error", "idle" (not
   * synced yet) or "local" (no transports). A run in progress doesn't change it: syncing is never
   * shown. `status.failures` counts runs in a row that failed, so a one-off failure can be ignored.
   */
  setStatus() {
    const states = this.transports.map((t) => this.status.remotes[t.name]?.state ?? "idle");
    const worst = ["error", "offline", "idle", "synced"].find((s) => states.includes(s));
    this.status.state = this.transports.length ? worst : "local";
    this.status.failures = worst === "error" || worst === "offline" ? (this.status.failures ?? 0) + 1 : 0;
    this.emit();
  }

  /** The library as a readable JSON Lines file: a header line, then one record per line. */
  toFile({ deleted = false } = {}) {
    const header = { "hidden-word": FORMAT, library: this.lib, device: this.state.device, name: this.name };
    const lines = Object.entries(this.state.items)
      .filter(([id]) => deleted || !this.records.get(id).deleted)
      .map(([, it]) => it.t);
    return [JSON.stringify(header), ...lines].join("\n") + "\n";
  }

  /** Erases the library from every transport and this device. */
  async erase() {
    this.erased = true;
    for (const t of this.transports) await t.erase?.(this);
    this.state = emptyState();
    this.records.clear();
    this.blobs.clear();
    this.store.clear(this.lib);
    for (const fn of this.listeners) fn(this);
  }

  /** Forgets this device's copy without touching anything else. */
  forget() {
    this.store.clear(this.lib);
    this.listeners.clear();
  }
}

// ---- syncing through a server (spec section 5.6)

/**
 * Whether a server's answer shows it lost data since `seen` (the epoch and latest seq remembered):
 * a different epoch, or a seq lower than the latest seen. Then the client refills it (5.6, step 3).
 */
export function serverLostData(seen, answer) {
  return (seen.epoch !== null && answer.epoch !== seen.epoch) || (answer.seq !== undefined && answer.seq < seen.seq);
}

/**
 * Ids (oldest change first) → POST-sized batches, in order. Ids that share a group (saved by one
 * putMany) stay in one batch when the group fits one, so the server writes them all or none.
 */
export function batches(ids, groupOf = () => undefined, size = BATCH) {
  const out = [];
  let chunk = [];
  for (let i = 0; i < ids.length; ) {
    const g = groupOf(ids[i]);
    let j = i + 1;
    while (g !== undefined && j < ids.length && groupOf(ids[j]) === g) j++;
    const run = ids.slice(i, j);
    if (chunk.length && chunk.length + run.length > size && run.length <= size) (out.push(chunk), (chunk = []));
    for (const id of run) {
      if (chunk.length === size) (out.push(chunk), (chunk = []));
      chunk.push(id);
    }
    i = j;
  }
  if (chunk.length) out.push(chunk);
  return out;
}

/** A Selah Vault server. `url` "" means the site this page came from. */
export function serverTransport({ url = "", fetch: f } = {}) {
  const name = `server ${url}`;
  const call = async (lib, method, query = "", body) => {
    const headers = { authorization: `Bearer ${lib.keys.auth}` };
    if (body) headers["content-type"] = "application/json";
    const res = await (f ?? globalThis.fetch.bind(globalThis))(`${url}/v1/lib/${lib.lib}${query}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new SyncError(res.status, await res.text().catch(() => ""));
    return res.status === 204 ? null : res.json();
  };

  // The server lost data (it's a new library, or older than what we've seen): start over and
  // send it everything we have.
  const lost = serverLostData;
  const restart = (r, answer) => Object.assign(r, { cursor: 0, seq: 0, epoch: answer.epoch, sent: 0, all: true, redo: [] });

  /** Sends what the server hasn't got. False when the server lost data and must be refilled. */
  async function push(lib, r) {
    const ids = lib.unsent(name);
    for (const chunk of batches(ids, (id) => lib.state.items[id].g)) {
      const ns = chunk.map((id) => lib.state.items[id].n);
      const items = await Promise.all(chunk.map(async (id) => ({ id, blob: await lib.blob(id) })));
      const answer = await call(lib, "POST", "", { items });
      if (lost(r, answer)) {
        restart(r, answer);
        return false;
      }
      r.epoch = answer.epoch;
      // Our items took the last n seqs. When the one before them is our cursor, nobody else wrote
      // since our last read, so there is nothing new to pull and no reason to read our own back.
      if (answer.seq - items.length === r.cursor) r.cursor = answer.seq;
      r.seq = Math.max(r.seq, answer.seq);
      const done = new Set(chunk);
      r.redo = r.redo.filter((id) => !done.has(id));
      if (!r.all) r.sent = Math.max(r.sent, ...ns);
      lib.emit();
    }
    if (r.all) Object.assign(r, { all: false, sent: Math.max(r.sent, ...ids.map((id) => lib.state.items[id]?.n ?? 0)) });
    return true;
  }

  async function pull(lib, r) {
    for (;;) {
      const page = await call(lib, "GET", `?after=${r.cursor}`);
      if (lost(r, page)) {
        restart(r, page);
        return false;
      }
      if (page.epoch !== null) r.epoch = page.epoch;
      r.seq = Math.max(r.seq, page.seq ?? 0);
      for (const { seq, id, blob } of page.items) {
        // This device has a newer copy than the server: send it again.
        if ((await lib.receive(id, blob, name)) === "older" && !r.redo.includes(id)) r.redo.push(id);
        r.cursor = seq;
        r.seq = Math.max(r.seq, seq);
      }
      if (page.items.length) lib.emit();
      if (!page.more) return true;
    }
  }

  return {
    name,
    async sync(lib) {
      const r = lib.remote(name);
      for (let round = 0; round < 4; round++) {
        const sent = lib.unsent(name).length > 0;
        if (!(await push(lib, r))) continue;
        // After a push that left the cursor at the latest seq, a pull would only find our own items.
        if (!(sent && r.cursor === r.seq) && !(await pull(lib, r))) continue;
        if (!r.redo.length && !lib.unsent(name).length) return;
      }
    },
    async erase(lib) {
      await call(lib, "DELETE");
    },
  };
}

// ---- passkey key slots (WebAuthn PRF)

export const prfSalt = () => sha256(te.encode("hidden-word/v1/prf"));

export async function slotKeys(prf) {
  const [slot, auth, kek] = await Promise.all([
    hkdf(prf, "hidden-word/v1/slot", 16),
    hkdf(prf, "hidden-word/v1/slot-auth", 32),
    hkdf(prf, "hidden-word/v1/kek", 32),
  ]);
  return { slot: hex(slot), auth: b64url(auth), kek: await aesKey(kek) };
}

async function slotRequest({ server = "", prf, fetch: f = globalThis.fetch.bind(globalThis) }, method, body) {
  const s = await slotKeys(prf);
  const headers = { authorization: `Bearer ${s.auth}` };
  if (body) headers["content-type"] = "application/json";
  const res = await f(`${server}/v1/slot/${s.slot}`, { method, headers, body: body ? JSON.stringify(body(s)) : undefined });
  return { res, s };
}

/** Wraps `{key, name}` under a passkey's PRF output and stores it in the passkey's slot. */
export async function saveSlot({ keyText, name, ...opts }) {
  const s = await slotKeys(opts.prf);
  const wrapped = await seal(s.kek, s.slot, te.encode(JSON.stringify({ key: keyText, name })));
  const { res } = await slotRequest(opts, "PUT", () => ({ wrapped }));
  if (!res.ok) throw new SyncError(res.status, await res.text().catch(() => ""));
}

/** `{key, name}` from a passkey's slot, or null when the passkey has no slot. */
export async function openSlot(opts) {
  const { res, s } = await slotRequest(opts, "GET");
  if (res.status === 404) return null;
  if (!res.ok) throw new SyncError(res.status, await res.text().catch(() => ""));
  const { wrapped } = await res.json();
  return JSON.parse(td.decode(await unseal(s.kek, s.slot, wrapped)));
}
