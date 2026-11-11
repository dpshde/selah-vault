import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const css = readFileSync(new URL("../public/style.css", import.meta.url), "utf8");

describe("Sign in to sync visibility", () => {
  test("the label exists only on the Sync and Account CTAs (both start hidden)", () => {
    const hits = [...html.matchAll(/Sign in to sync/g)];
    expect(hits).toHaveLength(2);
    expect(html).toMatch(/id="sync-signin-row"[^>]*\bhidden\b/);
    expect(html).toMatch(/id="account-signin"[^>]*\bhidden\b/);
    expect(html).toContain('id="sync-signin"');
    expect(html).toContain('id="account-signin"');
  });

  test("visibility follows signedInUser (session /auth/me), not a v1 sync-key leftover", () => {
    expect(app).toContain('if (signInRow) signInRow.hidden = Boolean(signedInUser);');
    expect(app).toContain('if ($("#account-signin")) $("#account-signin").hidden = Boolean(signedInUser);');
    expect(app).toContain("const user = await fetchSession();");
    expect(app).toContain("const SESSION = \"selah-vault:session\"");
    // Offline restore happens only after /auth/me returns no user, and only for online:false.
    const boot = app.slice(app.indexOf("async function boot()"));
    expect(boot).toMatch(/const user = await fetchSession\(\);/);
    expect(boot.indexOf("await fetchSession()")).toBeLessThan(boot.indexOf("localStorage.getItem(SESSION)"));
    expect(boot).toContain("if (saved?.id && saved.online === false)");
    expect(app).not.toMatch(/syncKey|sync.key|e2eVault|e2e-vault/);
  });

  test("phone Sync CSS cannot override [hidden] on the Sign in to sync row", () => {
    // The ≤600px rule sets #sync .sync-actions { display: flex }, which is more
    // specific than .sync-actions[hidden] { display: none }. A matching [hidden]
    // rule must win on phones.
    expect(css).toMatch(/#sync \.sync-actions\[hidden\][\s\S]{0,80}display:\s*none/);
    expect(css).toMatch(/#account \.account-signin\[hidden\][\s\S]{0,80}display:\s*none/);
    const phone = /@media \(max-width: 600px\) \{[\s\S]*$/.exec(css)?.[0] ?? "";
    const flex = phone.indexOf("#sync .sync-actions {");
    const hidden = phone.indexOf("#sync .sync-actions[hidden]");
    expect(flex).toBeGreaterThan(0);
    expect(hidden).toBeGreaterThan(flex);
  });
});
