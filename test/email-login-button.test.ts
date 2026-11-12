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
  const match = /<div class="auth-stack"[^>]*>[\s\S]*?<\/div>/.exec(html);
  return match?.[0] ?? "";
}

function button(html: string, id: string) {
  const match = new RegExp(`<button[^>]*id="${id}"[^>]*>[\\s\\S]*?</button>`).exec(html);
  return match?.[0] ?? "";
}

describe("Continue with Email is a button like Passkey and Apple", () => {
  test("index, unlock, and connect put Email in the same auth-stack as Passkey and Apple", () => {
    for (const html of [index, unlock, connect]) {
      const stack = authStack(html);
      expect(stack).toContain('id="passkey-login"');
      expect(stack).toContain('id="apple-login"');
      expect(stack).toContain('id="email-login"');
      expect(stack).toContain("Continue with Passkey");
      expect(stack).toContain("Sign in with Apple");
      expect(stack).toContain("Continue with Email");
      // Each method is a real button with an icon and a label, not a text link or <summary>.
      for (const id of ["passkey-login", "apple-login", "email-login"]) {
        const btn = button(stack, id);
        expect(btn).toContain("<svg");
        expect(btn).toContain("<span>");
        expect(btn).toMatch(/class="[^"]*\bauth-btn\b/);
        expect(btn).toMatch(/class="[^"]*\bwide\b/);
      }
      expect(html).not.toMatch(/<p class="divider"/);
      expect(html.toLowerCase()).not.toContain("or continue with email");
      expect(html).not.toContain("email-details");
      expect(html).not.toContain("<summary>Continue with Email</summary>");
    }
  });

  test("the email form starts hidden and the Email button reveals it", () => {
    expect(index).toMatch(/id="email-send-form"[^>]*\bhidden\b/);
    expect(unlock).toMatch(/id="email-send-form"[^>]*\bhidden\b/);
    expect(connect).toMatch(/id="email-send-form"[^>]*\bhidden\b/);
    expect(button(index, "email-login")).toContain('aria-expanded="false"');
    expect(button(unlock, "email-login")).toContain('aria-expanded="false"');
    expect(button(connect, "email-login")).toContain('aria-expanded="false"');

    for (const [src, name] of [
      [app, "app.js"],
      [unlockJs, "unlock.js"],
      [connectJs, "connect.js"],
    ] as const) {
      expect(src, name).toContain('$("#email-login")?.addEventListener("click"');
      expect(src, name).toContain("function showEmailSignIn()");
      expect(src, name).toContain("function resetEmailSignIn()");
      expect(src, name).toContain('$("#email-send-form").hidden = false');
      expect(src, name).toContain('$("#email-login")?.setAttribute("aria-expanded", "true")');
      expect(src, name).toContain('$("#email-input")?.focus()');
    }

    // Leaving the start screen (or switching accounts on /connect) collapses the form again.
    expect(app).toContain("resetEmailSignIn()");
    expect(connectJs).toContain('if (!passkeysAvailable()) showEmailSignIn()');
    expect(connectJs).not.toContain("email-details");
  });

  test("auth-btn display does not override [hidden] (Apple and Passkey can hide)", () => {
    expect(css).toMatch(/\.auth-btn \[hidden\]|\.auth-btn\[hidden\][\s\S]{0,40}display:\s*none/);
    expect(css).toContain(".auth-btn[hidden] { display: none; }");
    expect(connectCss).not.toContain(".oauth-key");
    expect(connectCss).toContain(".email-auth-form");
  });
});
