// Repository hygiene checks run via `mise run hygiene`.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { SCOPES, consentLines } from "../public/grants.js";
import {
  FORBIDDEN_V1_PROD_D1_ID,
  SELAH_VAULT_AUTH_D1_ID,
  SELAH_VAULT_AUTH_D1_ID_PLACEHOLDER,
  SELAH_VAULT_AUTH_D1_NAME,
} from "../src/d1-ids";

const BINARY_EXT = /\.(png|ico|webp|woff2?|jpg|jpeg|gif)$/i;
const legacyPattern = new RegExp(["hidden", "[-_ ]", "word"].join(""), "i");
const failures: string[] = [];

// 0. D1 binding must not point at the live v1 prod database or the unmet placeholder,
// and cloudflare.config.ts must stay in sync with src/d1-ids.ts (Wrangler cannot import it).
const configSrc = readFileSync("cloudflare.config.ts", "utf8");
const configId = configSrc.match(/const SELAH_VAULT_AUTH_D1_ID\s*=\s*"([^"]+)"/)?.[1] ?? null;
const configName = configSrc.match(/const SELAH_VAULT_AUTH_D1_NAME\s*=\s*"([^"]+)"/)?.[1] ?? null;
if (!configId || !configName) {
  failures.push("cloudflare.config.ts must declare SELAH_VAULT_AUTH_D1_ID and SELAH_VAULT_AUTH_D1_NAME literals");
} else {
  if (configName !== SELAH_VAULT_AUTH_D1_NAME) {
    failures.push(`cloudflare.config.ts D1 name ${configName} must equal ${SELAH_VAULT_AUTH_D1_NAME}`);
  }
  if (configId !== SELAH_VAULT_AUTH_D1_ID) {
    failures.push(`cloudflare.config.ts D1 id must match src/d1-ids.ts (${SELAH_VAULT_AUTH_D1_ID})`);
  }
  if (configId === FORBIDDEN_V1_PROD_D1_ID || SELAH_VAULT_AUTH_D1_ID === FORBIDDEN_V1_PROD_D1_ID) {
    failures.push(
      `DB id must not be the live v1 prod D1 (${FORBIDDEN_V1_PROD_D1_ID})`,
    );
  }
  if (configId === SELAH_VAULT_AUTH_D1_ID_PLACEHOLDER || SELAH_VAULT_AUTH_D1_ID === SELAH_VAULT_AUTH_D1_ID_PLACEHOLDER) {
    failures.push(
      `DB id is still the placeholder (${SELAH_VAULT_AUTH_D1_ID_PLACEHOLDER}); replace with the real ${SELAH_VAULT_AUTH_D1_NAME} uuid in src/d1-ids.ts and cloudflare.config.ts before deploy`,
    );
  }
}
if (/\bSNAPSHOTS\b/.test(configSrc) || /selah-vault-snapshots/.test(configSrc)) {
  failures.push("Unused SNAPSHOTS / selah-vault-snapshots binding must stay removed from cloudflare.config.ts");
}
const migrateProd = readFileSync("mise.toml", "utf8");
if (!migrateProd.includes(`db:migrate:prod`) || !migrateProd.includes(SELAH_VAULT_AUTH_D1_NAME)) {
  failures.push(`mise db:migrate:prod must target D1 by name (${SELAH_VAULT_AUTH_D1_NAME})`);
}

// 1. Zero legacy product identifier matches across tracked text files (excluding bun.lock).
const tracked = execFileSync("git", ["ls-files"], { encoding: "utf8" })
  .split("\n")
  .map((f) => f.trim())
  .filter((f) => f && f !== "bun.lock" && !BINARY_EXT.test(f));

for (const file of tracked) {
  if (!existsSync(file)) continue;
  const content = readFileSync(file, "utf8");
  if (legacyPattern.test(content)) {
    failures.push(`Legacy product identifier found in ${file}`);
  }
}

// 2. Every SCOPES and consentLines icon exists in public/connect.js ICONS map.
const connectSrc = readFileSync("public/connect.js", "utf8");
const iconsBlock = connectSrc.match(/const ICONS\s*=\s*\{([\s\S]*?)\n\};/)?.[1] ?? "";
const definedIcons = new Set([...iconsBlock.matchAll(/^\s*([a-zA-Z0-9_]+)\s*:/gm)].map((m) => m[1]));
const requiredIcons = new Set<string>([
  ...Object.values(SCOPES).map((s: { icon: string }) => s.icon),
  ...consentLines(Object.keys(SCOPES)).map((l: { icon: string }) => l.icon),
  "check",
  "x",
]);
for (const icon of requiredIcons) {
  if (!definedIcons.has(icon)) {
    failures.push(`Missing SVG icon "${icon}" in public/connect.js ICONS`);
  }
}

// 3. JSON manifests & schemas parse cleanly and referenced icons exist.
for (const jsonPath of ["public/manifest.webmanifest", "docs/webmcp/schema.json", "docs/webmcp/evals.json"]) {
  try {
    const parsed = JSON.parse(readFileSync(jsonPath, "utf8"));
    if (!parsed || typeof parsed !== "object") failures.push(`${jsonPath} did not parse to an object/array`);
    if (jsonPath === "public/manifest.webmanifest" && Array.isArray(parsed.icons)) {
      for (const ic of parsed.icons) {
        const diskPath = `public/${String(ic.src ?? "").replace(/^\//, "")}`;
        if (!existsSync(diskPath)) failures.push(`Manifest icon missing on disk: ${diskPath}`);
      }
    }
  } catch (err) {
    failures.push(`Invalid JSON in ${jsonPath}: ${(err as Error).message}`);
  }
}

// 4. Every ADR in decisions/ is indexed in decisions/README.md with no broken links.
const readmeLinks = new Set(
  [...readFileSync("decisions/README.md", "utf8").matchAll(/\]\(([a-z0-9-]+\.md)\)/g)].map((m) => m[1]),
);
const actualAdrs = readdirSync("decisions").filter((f) => f.endsWith(".md") && f !== "README.md");
for (const link of readmeLinks) {
  if (!existsSync(`decisions/${link}`)) failures.push(`Broken ADR link in decisions/README.md: ${link}`);
}
for (const adr of actualAdrs) {
  if (!readmeLinks.has(adr)) failures.push(`Unindexed ADR in decisions/: ${adr}`);
}

if (failures.length > 0) {
  for (const msg of failures) console.error(`FAIL: ${msg}`);
  process.exit(1);
}
console.log(`Repo hygiene OK (${tracked.length} tracked files, ${requiredIcons.size} OAuth icons, ${actualAdrs.length} ADRs).`);
