import { bindings, defineConfig } from "cf/config";

// 好行管理: the indoor admin (indoor/indoor-nav, built with `npm run build`) at howgo-admin.xmoty.me
export default defineConfig({
	worker: {
		name: "howgo-admin",
		compatibilityDate: "2026-10-01",
		entrypoint: "../worker/index.js",
		domains: ["howgo-admin.xmoty.me"],
		workersDev: false,
		assets: {
			runWorkerFirst: ["/api/*", "/"],
		},
		env: {
			API_ORIGIN: bindings.text("https://howgo-api.xmoty.me"),
			INDEX_REDIRECT: bindings.text("/admin"),
			ASSETS: bindings.assets(),
		},
	},
});
