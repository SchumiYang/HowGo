import { isEmbedded } from '~/utils/geolocation'

/**
 * Marks <html data-embedded> inside the Town Pass WebView so CSS treats the top safe-area inset as 0
 * (see --safe-top in assets/main.css). The JS bridge can be injected slightly after start-up, so the
 * check is repeated a few times; once embedded, the flag is never removed.
 */
export default defineNuxtPlugin(() => {
  const root = document.documentElement
  const check = () => {
    if (!root.hasAttribute('data-embedded') && isEmbedded()) root.setAttribute('data-embedded', '')
  }
  check()
  window.addEventListener('load', check, { once: true })
  for (const delay of [300, 1000, 2500]) setTimeout(check, delay)
})
