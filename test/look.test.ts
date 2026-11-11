import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const read = (p: string) => readFileSync(new URL(`../public/${p}`, import.meta.url), "utf8");
const css = read("style.css"), app = read("app.js");

test("both pages carry route.bible's second, unmasked grain layer, shown only in dark", () => {
  for (const page of ["index.html", "unlock.html"])
    expect(read(page)).toMatch(/<body[^>]*>\s*(<!--[^>]*-->\s*)?<div class="monologue-grain" aria-hidden="true"><div class="monologue-grain__tile"><\/div><\/div>/);
  expect(css).toMatch(/\.monologue-grain \{ display: none;[^}]*z-index: 12;[^}]*mix-blend-mode: lighten; opacity: \.06; \}/);
  expect(css).toContain(':root[data-theme="dark"] .monologue-grain { display: block; }');
  expect(css).toContain(':root:not([data-theme="light"]) .monologue-grain { display: block; }');
});

test("custom and add rows are shaped like the built-in rows, with the action inside the field", () => {
  const add = /<form id="add-color"[\s\S]*?<\/form>/.exec(read("index.html"))?.[0] ?? "";
  expect(add).toMatch(/<span class="color-field">\s*<input name="name"[^>]*>\s*<button type="submit" class="icon field-action" aria-label="Add color"/);
  expect(app).toContain('iconButton("button", "trash", `Delete ${colorName(c)}`)');
  expect(app).toMatch(/className = "color-field"/);
  expect(css).toMatch(/input\[type="color"\] \{ width: 1\.25rem; height: 1\.25rem;/);
  // On phones, Delete/Add share a 44px slot so custom rows match built-ins edge-to-edge.
  expect(css).toMatch(/@media \(max-width: 600px\)[\s\S]*?#color-list \.field-action,[\s\S]*?min-width: 44px;[\s\S]*?height: 44px;/);
});

test("book suggestions under #ref are name-only, clipped to the field (no CHAPTERS stamp / horizontal scroll)", () => {
  // Vendor still emits .si-passage-count; app chrome hides it so rows stay "Isaiah", not "Isaiah 66 CHAPTERS".
  expect(css).toMatch(/si-passage-input::part\(count\)\s*\{\s*display:\s*none/);
  expect(css).toMatch(/si-passage-input::part\(listbox\)\s*\{[^}]*overflow-x:\s*hidden/);
  expect(css).toMatch(/#add si-passage-input::part\(listbox\)\s*\{[^}]*left:\s*0[^}]*right:\s*0/);
  expect(css).toMatch(/#add si-passage-input::part\(listbox\)\s*\{[^}]*overflow-x:\s*hidden/);
  expect(css).toMatch(/si-passage-input::part\(option\)\s*\{[^}]*text-overflow:\s*ellipsis/);
  // Chapter/verse grid cells keep readable numbers (not ellipsized away).
  expect(css).toMatch(/si-passage-input::part\(cell\)\s*\{[^}]*overflow:\s*visible/);
});

test("one way to sync: the Sync screen offers server sync and connected apps (no folder or sync key)", () => {
  const sync = /<section id="sync"[\s\S]*?<\/section>/.exec(read("index.html"))?.[0] ?? "";
  expect(sync).toContain('id="use-server"');
  expect(sync).toContain('role="switch"');
  expect(sync).toContain("Across devices");
  expect(sync).toContain('id="grants-list"');
  expect(sync).toContain("Connected apps");
  expect(sync).not.toContain('id="add-passkey"');
  expect(sync).not.toContain('id="show-key"');
  expect(sync).not.toContain('class="lede"');
  expect(sync.toLowerCase()).not.toContain("folder");
  expect(app).not.toMatch(/folder\.js|showDirectoryPicker|folderTransport|fromBibleRs/);
  expect(read("index.html")).toContain('accept=".jsonl,application/x-ndjson"');
});

test("the Account page lists sign-in methods and holds Log out; menu opens it", () => {
  const html = read("index.html");
  const account = /<section id="account"[\s\S]*?<\/section>/.exec(html)?.[0] ?? "";
  expect(account).toContain("<h1>Account</h1>");
  expect(account).toContain("Sign-in methods");
  expect(account).toContain('id="methods-slots"');
  expect(account).toContain('id="slot-passkey"');
  expect(account).toContain('id="slot-email"');
  expect(account).toContain('id="slot-apple"');
  expect(account).toContain('id="add-passkey"');
  expect(account).toContain('id="add-email"');
  expect(account).toContain('id="add-apple"');
  expect(account).toContain('id="toggle-passkeys"');
  expect(account).toContain('id="lock"');
  expect(account).toContain("Log out");
  expect(account).toContain('aria-label="Add passkey"');
  expect(account).toContain('aria-label="Change email"');
  expect(account).toContain('aria-label="Remove email"');
  expect(account).toContain("panel-close");
  expect(account).toContain("Done");
  expect(account).not.toContain('id="methods-list"');
  expect(account).not.toContain("Add passkey</button>");
  const menu = /<details id="menu">([\s\S]*?)<\/details>/.exec(html)?.[1] ?? "";
  expect(menu).toContain('id="open-account"');
  expect(menu).not.toContain('id="lock"');
  expect(app).toContain("function renderAccount");
  expect(app).toContain("function loadMethods");
  expect(app).toContain("function renderSlots");
  expect(app).toContain("function syncPasskeyExpand");
  expect(app).toContain("renamePasskey");
  expect(app).toContain("Show passkeys");
  expect(app).not.toContain("<span>Rename</span>");
  expect(css).toMatch(/\.method-slot \{/);
  expect(css).toMatch(/@media \(max-width: 600px\)[\s\S]*?#account \.method-slot-actions > button[\s\S]*?min-height: 48px/);
  expect(css).toContain(".method-slot-title");
  expect(css).toContain(".icon[hidden] { display: none; }");
});

