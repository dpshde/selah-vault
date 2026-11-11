import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
// @ts-ignore plain JS
import {
  APPLE_SDK_SRC,
  appleErrorMessage,
  applePopupSignIn,
  appleSdkReady,
  idTokenFromAppleResponse,
  initAppleSdk,
  preloadAppleSdk,
} from "../public/apple-auth.js";

const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const headers = readFileSync(new URL("../public/_headers", import.meta.url), "utf8");

function addAppleHandler() {
  const start = app.indexOf('$("#add-apple")?.addEventListener("click"');
  const end = app.indexOf("$(\"#remove-apple\")") > start ? app.indexOf("async function closeSettingsPanel()") : -1;
  // handler runs until closeSettingsPanel; also try next function if needed
  const stop = app.indexOf("\nasync function closeSettingsPanel()", start);
  return start >= 0 && stop > start ? app.slice(start, stop) : "";
}

function appleLoginHandler() {
  const start = app.indexOf('$("#apple-login")?.addEventListener("click"');
  const stop = app.indexOf("$(\"#open-offline\")", start);
  return start >= 0 && stop > start ? app.slice(start, stop) : "";
}

describe("wiring and CSP", () => {
  test("#add-apple exists and is wired to the Apple popup + /auth/apple link path", () => {
    expect(html).toContain('id="add-apple"');
    const handler = addAppleHandler();
    expect(handler).toContain("applePopupSignIn()");
    expect(handler).toContain("signInWithApple(");
    expect(handler).toContain("loadMethods()");
    expect(handler).toContain("appleErrorMessage(error)");
    expect(handler).toContain('#account-note');
    // iOS Safari: no await before signIn() in the click handler.
    expect(handler).not.toMatch(/await\s+ensureAppleSdk/);
    expect(handler).not.toMatch(/await\s+preloadAppleSdk/);
    const code = handler.replace(/\/\/[^\n]*/g, "");
    expect(code.search(/\bawait\b/)).toBe(code.indexOf("await applePopupSignIn()"));
  });

  test("#apple-login also calls signIn() with no await before it", () => {
    const handler = appleLoginHandler();
    expect(handler).toContain("applePopupSignIn()");
    expect(handler).not.toMatch(/await\s+ensureAppleSdk/);
    expect(handler).not.toMatch(/await\s+preloadAppleSdk/);
    expect(handler).toContain("appleErrorMessage(error)");
    const code = handler.replace(/\/\/[^\n]*/g, "");
    expect(code.search(/\bawait\b/)).toBe(code.indexOf("await applePopupSignIn()"));
  });

  test("the Apple SDK is preloaded at config load and when Account opens", () => {
    expect(app).toContain("preloadAppleSdk(authConfig.appleClientId)");
    expect(app).toMatch(/applyAuthConfig\(\);\s*preloadAppleSdk\(authConfig\.appleClientId\)/);
    expect(app).toMatch(/function renderAccount\(\) \{\s*preloadAppleSdk\(authConfig\.appleClientId\)/);
  });

  test("CSP allows the Apple JS SDK and popup frame", () => {
    expect(headers).toContain("script-src 'self' https://appleid.cdn-apple.com");
    expect(headers).toContain("frame-src https://appleid.apple.com");
    expect(headers).toContain("https://appleid.apple.com");
  });
});

describe("apple-auth helpers", () => {
  test("appleErrorMessage surfaces 409 and empty/event errors clearly", () => {
    expect(appleErrorMessage(new Error("already linked to another account"))).toBe(
      "That Apple ID is already linked to another account.",
    );
    expect(appleErrorMessage(new Error("Apple token audience mismatch"))).toBe("Apple token audience mismatch");
    expect(appleErrorMessage(undefined)).toBe("Couldn't sign in with Apple.");
    expect(appleErrorMessage({ message: "" })).toBe("Couldn't sign in with Apple.");
  });

  test("applePopupSignIn calls AppleID.auth.signIn immediately when the SDK is ready", async () => {
    const calls: unknown[] = [];
    // @ts-expect-error test stub
    globalThis.AppleID = {
      auth: {
        _vaultInit: true,
        signIn: () => {
          calls.push("signIn");
          return Promise.resolve({
            authorization: { id_token: "tok-1" },
            user: { name: { firstName: "A", lastName: "B" } },
          });
        },
      },
    };
    expect(appleSdkReady()).toBe(true);
    const resp = await applePopupSignIn();
    expect(calls).toEqual(["signIn"]);
    expect(idTokenFromAppleResponse(resp)).toEqual({ idToken: "tok-1", name: "A B" });
    // @ts-expect-error cleanup
    delete globalThis.AppleID;
  });

  test("applePopupSignIn throws a visible error when the SDK is not loaded", () => {
    // @ts-expect-error cleanup
    delete globalThis.AppleID;
    expect(appleSdkReady()).toBe(false);
    expect(() => applePopupSignIn()).toThrow("Sign in with Apple is still loading. Try again in a moment.");
  });

  test("preloadAppleSdk inits a stubbed SDK without appending a script", async () => {
    const initCalls: unknown[] = [];
    // @ts-expect-error test stub
    globalThis.AppleID = {
      auth: {
        init(opts: unknown) {
          initCalls.push(opts);
        },
        signIn() {
          return Promise.resolve({});
        },
      },
    };
    const ok = await preloadAppleSdk("tools.selah.vault", { origin: "https://vault.selah.tools" });
    expect(ok).toBe(true);
    expect(initCalls).toEqual([
      {
        clientId: "tools.selah.vault",
        scope: "name email",
        redirectURI: "https://vault.selah.tools/auth/apple",
        usePopup: true,
      },
    ]);
    expect(initAppleSdk("tools.selah.vault", { origin: "https://vault.selah.tools" })).toBe(true);
    expect(initCalls).toHaveLength(1); // already inited
    expect(APPLE_SDK_SRC).toContain("appleid.cdn-apple.com");
    // @ts-expect-error cleanup
    delete globalThis.AppleID;
  });
});
