import { describe, expect, setSystemTime, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { MIGRATIONS, d1 } from "./d1";
import { handle } from "../src/worker";
import { routeOf } from "../src/observe";
import { allowedClient, clientInfo, consentLines, grantAllows, parseScopes } from "../public/grants.js";
import { decryptRecord, deriveKeys, encryptRecord, formatKey, newKey, parseKey, readKeys } from "../public/sync.js";

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

async function setup() {
  const sqlite = new Database(":memory:");
  for (const m of MIGRATIONS) sqlite.exec(m);
  const env = { DB: d1(sqlite) };
  const fetch: Fetch = async (input, init) => handle(new Request(new URL(input, "http://local"), init), env);
  const key = await parseKey(await formatKey(newKey()));
  const keys = await deriveKeys(key);
  const owner = { authorization: `Bearer ${keys.auth}`, "content-type": "application/json" };
  const item = await encryptRecord(keys, { kind: "highlight", ref: "JHN.3.16", highlights: [{ color: "yellow", created: 1 }] });
  await fetch(`/v1/lib/${keys.lib}`, { method: "POST", headers: owner, body: JSON.stringify({ items: [item] }) });
  const grant = (body: unknown) => fetch(`/v1/grant/${keys.lib}`, { method: "POST", headers: owner, body: JSON.stringify(body) });
  return { sqlite, fetch, key, keys, owner, grant };
}
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

describe("grants", () => {
  test("a read grant reads and decrypts, and can't write or delete", async () => {
    const { fetch, key, keys, grant } = await setup();
    const res = await grant({ scopes: ["read"], client: "https://route.bible" });
    expect(res.status).toBe(200);
    const g = await res.json();
    expect(g.token).toMatch(/^g1\./);
    expect(g.expires - Date.now() / 1000).toBeGreaterThan(89 * 86400);
    const got = await fetch(`/v1/lib/${keys.lib}`, { headers: bearer(g.token) });
    expect(got.status).toBe(200);
    const { items } = await got.json();
    // The app decrypts with only the library id and enc key it was handed.
    const rk = await readKeys(key);
    expect(rk.lib).toBe(keys.lib);
    const enc = await crypto.subtle.importKey("raw", Buffer.from(rk.enc, "hex"), "AES-GCM", false, ["decrypt"]);
    expect((await decryptRecord({ enc }, items[0].id, items[0].blob)).ref).toBe("JHN.3.16");
    for (const method of ["POST", "PUT", "DELETE"]) {
      expect((await fetch(`/v1/lib/${keys.lib}`, { method, headers: bearer(g.token), body: method === "POST" ? "{}" : undefined })).status).toBe(403);
    }
    expect((await fetch(`/v1/slot/${keys.lib}`, { headers: bearer(g.token) })).status).toBe(403);
  });

  test("revoked by the app (Disconnect) or by the owner, then 401", async () => {
    const { fetch, keys, owner, grant } = await setup();
    const a = await (await grant({ scopes: ["read"], client: "http://localhost:5173" })).json();
    expect((await fetch(`/v1/grant/${keys.lib}`, { method: "DELETE", headers: bearer(a.token) })).status).toBe(204);
    expect((await fetch(`/v1/lib/${keys.lib}`, { headers: bearer(a.token) })).status).toBe(401);
    const b = await (await grant({ scopes: "read", client: "https://route.bible" })).json();
    const list = await (await fetch(`/v1/grant/${keys.lib}`, { headers: owner })).json();
    expect(list.grants.map((x: { id: string }) => x.id)).toEqual([b.id]);
    expect(JSON.stringify(list)).not.toContain(b.token);
    expect((await fetch(`/v1/grant/${keys.lib}?id=${b.id}`, { method: "DELETE", headers: owner })).status).toBe(204);
    expect((await fetch(`/v1/lib/${keys.lib}`, { headers: bearer(b.token) })).status).toBe(401);
  });

  test("expires after 90 days", async () => {
    const { fetch, keys, grant } = await setup();
    const g = await (await grant({ scopes: ["read"], client: "https://route.bible" })).json();
    setSystemTime(new Date(Date.now() + 91 * 86400_000));
    try {
      expect((await fetch(`/v1/lib/${keys.lib}`, { headers: bearer(g.token) })).status).toBe(401);
    } finally {
      setSystemTime();
    }
  });

  test("refuses unknown apps, unknown scopes, and other tokens", async () => {
    const { fetch, keys, grant } = await setup();
    expect((await grant({ scopes: ["read"], client: "https://evil.example" })).status).toBe(403);
    expect((await grant({ scopes: ["read"], client: "http://route.bible" })).status).toBe(403);
    expect((await grant({ scopes: ["write"], client: "https://route.bible" })).status).toBe(400);
    expect((await grant({ scopes: ["highlights:add"], client: "https://route.bible" })).status).toBe(400);
    expect((await grant({ scopes: ["read", "highlights:write"], client: "https://evil.example" })).status).toBe(403);
    const other = await deriveKeys(newKey());
    const res = await fetch(`/v1/grant/${keys.lib}`, { method: "POST", headers: bearer(other.auth), body: "{}" });
    expect(res.status).toBe(401);
    const g = await (await grant({ scopes: ["read"], client: "https://route.bible" })).json();
    expect((await fetch(`/v1/lib/${other.lib}`, { headers: bearer(g.token) })).status).toBe(401);
    expect((await fetch(`/v1/grant/${keys.lib}`, { method: "POST", headers: bearer(g.token), body: "{}" })).status).toBe(403);
  });

  test("deleting the library deletes its grants", async () => {
    const { fetch, sqlite, keys, owner, grant } = await setup();
    await grant({ scopes: ["read"], client: "https://route.bible" });
    await fetch(`/v1/lib/${keys.lib}`, { method: "DELETE", headers: owner });
    expect(sqlite.query("SELECT COUNT(*) AS n FROM grants").get()).toEqual({ n: 0 });
  });

  test("helpers", () => {
    expect(allowedClient("https://route.bible/john/3?x=1")).toBe("https://route.bible");
    expect(allowedClient("https://proofs.dpshade.workers.dev/")).toBe("https://proofs.dpshade.workers.dev");
    expect(allowedClient("https://route.bible.evil.example/")).toBeNull();
    expect(allowedClient("https://u:p@route.bible/")).toBeNull();
    expect(allowedClient("http://localhost:4321/a")).toBe("http://localhost:4321");
    expect(allowedClient("javascript:alert(1)")).toBeNull();
    expect(parseScopes("read read")).toEqual(["read"]);
    expect(parseScopes([])).toBeNull();
    expect(grantAllows(["read"], "GET")).toBe(true);
    expect(grantAllows(["read"], "POST")).toBe(false);
    expect(grantAllows(["highlights:write"], "POST")).toBe(true);
    expect(grantAllows(["read", "highlights:write"], "DELETE")).toBe(false);
    expect(clientInfo("https://route.bible").name).toBe("route.bible");
    expect(clientInfo("https://vault-highlights-route-bible.dpshade.workers.dev").name).toBe("route.bible (preview)");
    expect(clientInfo("https://proofs.dpshade.workers.dev")).toEqual({
      name: "Proofs",
      icon: "/apps/proofs.svg",
      homepage: "https://proofs.dpshade.workers.dev",
    });
    expect(clientInfo("http://localhost:5173").name).toBe("Local development");
    expect(consentLines(["read"]).map((l) => l.text)).toEqual(["View your highlights and notes", "Can't change or delete anything", "Access expires in 90 days · disconnect anytime"]);
    expect(consentLines(["highlights:write", "read"]).map((l) => l.text)[2]).toBe("Can't delete your library or change your passkeys");
    expect(routeOf("/v1/grant/abc")).toBe("/v1/grant/:grant");
  });

  test("a write grant saves and removes records, and can't delete the library or touch slots", async () => {
    const { fetch, key, keys, grant } = await setup();
    const g = await (await grant({ scopes: ["read", "highlights:write"], client: "https://route.bible" })).json();
    expect(g.scopes).toEqual(["highlights:write", "read"]);
    // The app writes with only the enc and mac keys from the fragment.
    const rk = await readKeys(key);
    expect(rk.mac).toMatch(/^[0-9a-f]{64}$/);
    const app = await deriveKeys(key);
    const save = await encryptRecord(app, { kind: "highlight", ref: "ROM.8.28", updated: 10, highlights: [{ color: "yellow", created: 10 }] });
    const h = { ...bearer(g.token), "content-type": "application/json" };
    expect((await fetch(`/v1/lib/${keys.lib}`, { method: "POST", headers: h, body: JSON.stringify({ items: [save] }) })).status).toBe(200);
    let items = (await (await fetch(`/v1/lib/${keys.lib}`, { headers: bearer(g.token) })).json()).items;
    expect(items.map((i: { id: string }) => i.id)).toContain(save.id);
    const unsave = await encryptRecord(app, { kind: "highlight", ref: "ROM.8.28", updated: 11, deleted: true });
    expect((await fetch(`/v1/lib/${keys.lib}`, { method: "POST", headers: h, body: JSON.stringify({ items: [unsave] }) })).status).toBe(200);
    items = (await (await fetch(`/v1/lib/${keys.lib}`, { headers: bearer(g.token) })).json()).items;
    const row = items.find((i: { id: string }) => i.id === save.id);
    expect((await decryptRecord(app, row.id, row.blob)).deleted).toBe(true);
    expect((await fetch(`/v1/lib/${keys.lib}`, { method: "DELETE", headers: bearer(g.token) })).status).toBe(403);
    expect((await fetch(`/v1/slot/${keys.lib}`, { method: "PUT", headers: h, body: "{}" })).status).toBe(403);
    expect((await fetch(`/v1/grant/${keys.lib}`, { method: "POST", headers: h, body: "{}" })).status).toBe(403);
  });

  test("the consent page: fragment-only handoff, Cancel is access_denied, an unlocked library skips the form", () => {
    const js = readFileSync("public/connect.js", "utf8");
    expect(js).toContain("url.hash =");
    expect(js).not.toMatch(/searchParams\.set\(["'](rt|ek|mk|k)["']/);
    expect(js).toContain("history.replaceState");
    expect(js).toContain('finish({ error: "access_denied" })');
    expect(js).toMatch(/if \(session\?\.key\) consent\(/);
    expect(js).toContain("clientInfo(back.origin)");
    const html = readFileSync("public/connect.html", "utf8");
    expect(html).toContain("wants to access your Selah Vault");
    expect(html).toContain("Use sync key instead");
    expect(html).toContain("Only allow apps you trust.");
  });
});
