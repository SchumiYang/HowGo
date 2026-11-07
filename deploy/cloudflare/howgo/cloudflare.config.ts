import { bindings, defineConfig } from "cf/config";

// 好行: the Nuxt app (frontend/, built with `nuxt generate`) at howgo.xmoty.me
export default defineConfig({
	worker: {
		name: "howgo",
		compatibilityDate: "2026-10-01",
		entrypoint: "../worker/index.js",
		domains: ["howgo.xmoty.me"],
		workersDev: false,
		assets: {
			notFoundHandling: "single-page-application",
			runWorkerFirst: ["/api/*"],
		},
		env: {
			API_ORIGIN: bindings.text("https://howgo-api.xmoty.me"),
			ASSETS: bindings.assets(),
		},
	},
});
