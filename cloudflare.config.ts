import { bindings, defineConfig, exports } from "cf/config";

// Keep these literals in sync with src/d1-ids.ts. Wrangler loads this file
// without Bun path mapping, so we cannot import that module here. Hygiene
// fails if the id is still the placeholder or the forbidden live v1 prod id.
const SELAH_VAULT_AUTH_D1_NAME = "selah-vault-auth";
const SELAH_VAULT_AUTH_D1_ID = "a11255b0-2b5a-4174-9148-4c96be0d3a2a";

export default defineConfig({
	accountId: "91ff2c2b757414041aeaa00896a8a43f",
	worker: {
		name: "selah-vault",
		compatibilityDate: "2026-09-01",
		entrypoint: "src/worker.ts",
		workersDev: true,
		// Production hostnames, moved from hidden-word at cutover. workers.dev stays for staging.
		domains: ["vault.selah.tools", "sync.selah.tools"],
		observability: {
			enabled: true,
			redactQueryString: true,
			logs: { enabled: true, headSamplingRate: 1, invocationLogs: false },
			traces: { enabled: true, headSamplingRate: 1 },
			issues: { enabled: true },
		},
		assets: {
			runWorkerFirst: [
				"/",
				"/index.html",
				"/connect",
				"/connect.html",
				"/oauth/*",
				"/auth/*",
				"/v2/*",
				"/mcp",
				"/yv/*",
				"/api/*",
				"/.well-known/*",
				"/config.json",
				"/save",
			],
		},
		env: {
			DB: bindings.d1({
				name: SELAH_VAULT_AUTH_D1_NAME,
				// Replace with the real selah-vault-auth uuid in BOTH this file
				// and src/d1-ids.ts once provisioned.
				id: SELAH_VAULT_AUTH_D1_ID,
			}),
			ASSETS: bindings.assets(),
			LIBRARY: bindings.durableObject({
				worker: "selah-vault",
				exportName: "LibraryDO",
			}),
		},
		exports: {
			LibraryDO: exports.durableObject({ storage: "sqlite" }),
		},
	},
});