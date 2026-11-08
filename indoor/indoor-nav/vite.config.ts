import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vitest/config'

// Indoor admin service (admin.html + survey.html). The indoor nav UI lives in the HowGo Nuxt app; both talk to the
// HowGo FastAPI under /v1/indoor, reached here as /api/v1/indoor via the proxy (like Nuxt's /api/** proxy).
const api = {
  '/api': {
    target: process.env.HOWGO_API_TARGET ?? 'http://127.0.0.1:8000',
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/api/, ''),
  },
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [vue()],
  // relative asset URLs: the admin may be served from any sub-path inside the TownPass WebView
  base: './',
  server: { host: '0.0.0.0', port: 5174, strictPort: true, proxy: api },
  preview: { host: '0.0.0.0', port: 5174, strictPort: true, proxy: api },
  // maplibre-gl alone is ~1 MB minified; it is loaded once and cached by the WebView
  build: {
    chunkSizeWarningLimit: 1400,
    rolldownOptions: { input: { admin: 'admin.html', survey: 'survey.html' } },
  },
  test: {
    include: ['src/**/*.test.ts'],
  },
})
