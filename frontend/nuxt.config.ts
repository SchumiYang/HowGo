import { fileURLToPath } from 'node:url'

const apiTarget = (process.env.ROLLX_API_TARGET || 'http://127.0.0.1:8000').replace(/\/$/, '')
// Indoor navigation (indoor/indoor-nav) is embedded by components/IndoorOverlay.vue. Its sources
// keep their own maplibre-gl v6 (resolved from indoor/indoor-nav/node_modules); Vue is deduped.
// The alias is Vite-only so `nuxt typecheck` doesn't pull in the indoor sources (they are checked
// by indoor-nav's own vue-tsc); app/types/indoor-nav.d.ts types the entry component.
const indoorRoot = fileURLToPath(new URL('../indoor', import.meta.url))
const indoorSrc = fileURLToPath(new URL('../indoor/indoor-nav/src', import.meta.url))
const indoorMaplibre = fileURLToPath(new URL('../indoor/indoor-nav/node_modules/maplibre-gl/dist/maplibre-gl.mjs', import.meta.url))
const indoorPrefix = indoorRoot.replace(/\\/g, '/')

export default defineNuxtConfig({
  vite: {
    resolve: { alias: { '#indoor': indoorSrc }, dedupe: ['vue'] },
    server: { fs: { allow: [indoorRoot] } },
    plugins: [{
      // dev: Vite's dep optimizer would hand the indoor sources HowGo's pre-bundled maplibre-gl v5,
      // which can't talk to the indoor v6 worker (blank indoor map). Builds already resolve v6.
      name: 'indoor-maplibre-v6',
      enforce: 'pre',
      resolveId(id, importer) {
        if (id === 'maplibre-gl' && importer?.replace(/\\/g, '/').startsWith(indoorPrefix)) return indoorMaplibre
      },
    }],
  },
  ssr: false,
  devtools: { enabled: false },
  css: ['maplibre-gl/dist/maplibre-gl.css', '~/assets/main.css', '~/assets/map-layers.css'],
  app: {
    head: {
      htmlAttrs: { lang: 'zh-Hant' },
      title: 'HowGo',
      meta: [{ name: 'description', content: '比較臺北市三種步行路線，查看沿途通行條件與設施。' }],
    },
  },
  runtimeConfig: {
    public: {
      tileUrl: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    },
  },
  routeRules: {
    '/api/**': { proxy: apiTarget + '/**' },
  },
})
