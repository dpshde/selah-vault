import { bindings, defineConfig, exports } from "cf/config";

export default defineConfig({
	accountId: "91ff2c2b757414041aeaa00896a8a43f",
	worker: {
		name: "selah-vault",
		compatibilityDate: "2026-09-01",
		entrypoint: "src/worker.ts",
		workersDev: true,
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
				name: "selah-vault-auth",
				id: "4e60d989-d13b-4884-ad5c-1366f4c73f00",
			}),
			ASSETS: bindings.assets(),
			LIBRARY: bindings.durableObject({
				worker: "selah-vault",
				exportName: "LibraryDO",
			}),
			SNAPSHOTS: bindings.r2({
				name: "selah-vault-snapshots",
			}),
		},
		exports: {
			LibraryDO: exports.durableObject({ storage: "sqlite" }),
		},
	},
});
