// Read by Wrangler when `cf dev` and `cf deploy` delegate Worker + Static Assets bundling.
// `cloudflare.config.ts` declares the Worker bindings; this points Wrangler at `./public`
// and disables auto-writing `.wrangler/types` on build.
import { defineWranglerConfig } from "wrangler/experimental-config";

export default defineWranglerConfig({
	types: {
		generate: false,
	},
	assetsDirectory: "./public",
});
