import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const unlock = readFileSync(new URL("../public/unlock.html", import.meta.url), "utf8");
const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const css = readFileSync(new URL("../public/style.css", import.meta.url), "utf8");

test("hidden forms do not override [hidden] with display: flex", () => {
  expect(css).toMatch(/form\[hidden\]\s*\{\s*display:\s*none;\s*\}/);
});

test("omni bar dims swatch on topic input and passage card actions carry visible labels + active feedback", () => {
  expect(html).toContain('id="omni-card-dot"');
  expect(html).toContain('<span class="omni-action-label">Highlight</span>');
  expect(html).toContain('<span class="omni-action-label">Related</span>');
  expect(app).toContain("function syncOmniDotState()");
  expect(app).toContain("function syncOmniCardActions()");
  expect(css).toContain('#add-dot[data-topic="1"]');
  expect(css).toContain('.omni-card-actions .icon[data-highlighted="1"]');
  expect(css).toContain('.omni-card-actions .icon[data-active="1"]');
});

test("group headers use calm --raised strips with tabular counts, and selection bar swaps in place", () => {
  const summaryRule = /#list \.group > summary\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
  expect(summaryRule).toContain("background: var(--raised)");
  expect(summaryRule).not.toContain("background: var(--accent)");
  expect(app).toContain('count.className = "group-count"');
  expect(css).toContain(".group-count");
  expect(css).toMatch(/\.list-bar\[data-selecting="true"\]\s+\.list-bar-top[\s\S]*?\{\s*display:\s*none;\s*\}/);
});

test("rows use external-link arrow, chevron + category tag, desktop hover reveal, and labeled color picker", () => {
  const globeLine = /globe:\s*'([^']+)'/.exec(app)?.[1] ?? "";
  expect(globeLine).toContain("M15 3h6v6");
  expect(globeLine).not.toContain("<circle");
  expect(app).toContain('chev.className = "row-chevron"');
  expect(app).toContain('cat.className = "row-category"');
  expect(app).toContain('labelRef(run.ref).replaceAll("–", "-")');
  expect(app).toContain('b.className = "color-option"');
  expect(css).toContain("#color-pop .color-option");
  expect(css).toContain("@media (hover: hover) and (pointer: fine) and (min-width: 40.0625rem)");
  expect(app).toContain("if (input) return input.value ?? \"\"");
});

test("ranked views provide explicit Clear exit, unpress Date/Genre, preserve list while drafting, and define related helpers", () => {
  expect(app).toContain("function relatedRankMode()");
  expect(app).toContain("function syncRelatedSortChrome(show)");
  expect(app).toContain("function exitRankedView()");
  expect(app).toContain('clear.className = "group-clear"');
  expect(app).toContain('const inBrowse = listView === "browse"');
  expect(app).toContain('listEl.dataset.drafting = "1"');
  expect(css).toContain('#list[data-drafting="1"]');
});

test("Spec replaces Contract, settings panels auto-commit #add-color on close, and offline views offer Sign in to sync", () => {
  expect(html).not.toContain(">Contract<");
  expect(unlock).not.toContain(">Contract<");
  expect(html).toContain(">Spec</span>");
  expect(unlock).toContain(">Spec</a>");
  expect(html).toContain('id="sync-signin"');
  expect(html).toContain('id="account-signin"');
  expect(app).toContain("async function addCustomColor(");
  expect(app).toContain("async function closeSettingsPanel()");
  expect(app).toContain("function openSignIn()");
});
