import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const index = read("public/index.html");
const unlock = read("public/unlock.html");
const connect = read("public/connect.html");
const css = read("public/style.css");
const connectCss = read("public/connect.css");
const app = read("public/app.js");
const unlockJs = read("public/unlock.js");
const connectJs = read("public/connect.js");

function authStack(html: string) {
  const start = html.search(/<div class="auth-stack"/);
  if (start < 0) return "";
  let i = html.indexOf(">", start) + 1, depth = 1;
  while (i < html.length && depth) {
    const nextOpen = html.indexOf("<div", i);
    const nextClose = html.indexOf("</div>", i);
    if (nextClose < 0) break;
    if (nextOpen >= 0 && nextOpen < nextClose) {
      depth++;
      i = nextOpen + 4;
    } else {
      depth--;
      i = nextClose + 6;
    }
  }
  return html.slice(start, i);
}

function button(html: string, id: string) {
  const match = new RegExp(`<button[^>]*id="${id}"[^>]*>[\\s\\S]*?</button>`).exec(html);
  return match?.[0] ?? "";
}

describe("sign-in surfaces have no lone text links", () => {
  test("Create a passkey is a full button in the auth-stack on every sign-in page", () => {
    const pages = [
      { html: index, id: "create-passkey" },
      { html: unlock, id: "passkey-register" },
      { html: connect, id: "passkey-register" },
    ];
    for (const { html, id } of pages) {
      expect(html).not.toMatch(/New here\?/);
      expect(html).not.toContain("passkey-create-wrap");
      expect(html).not.toContain("passkey-register-wrap");
      expect(html).not.toContain("passkey-create-row");
      const stack = authStack(html);
      const btn = button(stack, id);
      expect(btn).toContain("Create a passkey");
      expect(btn).toContain("<svg");
      expect(btn).toContain("<span>");
      expect(btn).toMatch(/class="[^"]*\bauth-btn\b/);
      expect(btn).toMatch(/class="[^"]*\bwide\b/);
      expect(btn).not.toMatch(/class="[^"]*\blink\b/);
    }
  });

  test("Use offline is a full-width quiet button below an or divider, apart from Create a passkey", () => {
    const stack = authStack(index);
    expect(stack).toContain('id="create-passkey"');
    expect(stack).not.toContain('id="open-offline"');
    expect(index).toMatch(/<p class="auth-or"><span>or<\/span><\/p>/);
    const offline = button(index, "open-offline");
    expect(offline).toContain("Use offline on this device");
    expect(offline).toMatch(/class="[^"]*\bwide\b/);
    expect(offline).toMatch(/class="[^"]*\bquiet\b/);
    expect(offline).toMatch(/class="[^"]*\bauth-btn\b/);
    expect(offline).not.toMatch(/class="[^"]*\blink\b/);
    // Create, then the or rule, then offline — not siblings in one line of text.
    const createAt = index.indexOf('id="create-passkey"');
    const orAt = index.indexOf('class="auth-or"');
    const offlineAt = index.indexOf('id="open-offline"');
    expect(createAt).toBeGreaterThan(0);
    expect(orAt).toBeGreaterThan(createAt);
    expect(offlineAt).toBeGreaterThan(orAt);
    expect(css).toMatch(/\.auth-or::before, \.auth-or::after/);
    expect(css).toMatch(/#open-offline \{ min-height: 44px; /);
    // /unlock and /connect have no offline escape hatch.
    expect(unlock).not.toContain("Use offline");
    expect(connect).not.toContain("Use offline");
  });

  test("hiding passkeys hides the Create button, not a leftover text wrap", () => {
    expect(app).toContain('if ($("#create-passkey")) $("#create-passkey").hidden = true;');
    expect(app).not.toContain("passkey-create-wrap");
    expect(unlockJs).toContain('if ($("#passkey-register")) $("#passkey-register").hidden = true;');
    expect(unlockJs).not.toContain("passkey-register-wrap");
    expect(connectJs).toContain('if ($("#passkey-register")) $("#passkey-register").hidden = true;');
    expect(connectJs).not.toContain("passkey-create-row");
  });

  test("other auth-adjacent text links are real buttons too", () => {
    expect(button(index, "skip-passkey")).toMatch(/class="quiet"/);
    expect(button(index, "skip-passkey")).not.toMatch(/class="link"/);
    expect(button(connect, "switch")).toContain('class="oauth-switch"');
    expect(connectCss).toMatch(/\.oauth-switch \{[^}]*border: 1px solid var\(--line\)/);
    expect(connectCss).not.toMatch(/\.oauth-switch \{[^}]*text-decoration: underline/);
  });

  test("email OTP fields require six digits (regression: braces must not be stripped)", () => {
    for (const html of [index, unlock, connect]) {
      expect(html).toMatch(/id="otp-input"[^>]*pattern="\[0-9\]\{6\}"/);
    }
  });
});
