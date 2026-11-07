// Static assets + same-origin /api proxy to the HowGo FastAPI behind a Cloudflare Tunnel.
// /api/<path> -> API_ORIGIN/<path>: the /api prefix is stripped, like the Nuxt and Vite dev proxies.
// The tunnel hostname sits behind Cloudflare Access; only requests carrying the service token get through.
export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      const target = new URL(url.pathname.slice(4) || '/', env.API_ORIGIN)
      target.search = url.search
      const headers = new Headers(request.headers)
      headers.set('CF-Access-Client-Id', env.ACCESS_CLIENT_ID)
      headers.set('CF-Access-Client-Secret', env.ACCESS_CLIENT_SECRET)
      return fetch(target, {
        method: request.method,
        headers,
        body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
        redirect: 'manual',
      })
    }
    // the admin build has no index.html; send the bare origin to its entry page
    if (url.pathname === '/' && env.INDEX_REDIRECT) return Response.redirect(new URL(env.INDEX_REDIRECT, url), 302)
    return env.ASSETS.fetch(request)
  },
}
