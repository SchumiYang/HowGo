const apiTarget = (process.env.ROLLX_API_TARGET || 'http://127.0.0.1:8000').replace(/\/$/, '')

export default defineNuxtConfig({
  ssr: false,
  devtools: { enabled: false },
  css: ['maplibre-gl/dist/maplibre-gl.css', '~/assets/main.css'],
  app: {
    head: {
      htmlAttrs: { lang: 'zh-Hant' },
      title: '輪行 X｜Roll X',
      meta: [{ name: 'description', content: '查看臺北市輪椅步行路線與附近無障礙設施。' }],
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
