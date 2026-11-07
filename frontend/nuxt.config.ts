const apiTarget = (process.env.ROLLX_API_TARGET || 'http://127.0.0.1:8000').replace(/\/$/, '')

export default defineNuxtConfig({
  ssr: false,
  devtools: { enabled: false },
  css: ['maplibre-gl/dist/maplibre-gl.css', '~/assets/main.css'],
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
