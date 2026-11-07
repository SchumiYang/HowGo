/**
 * Location source abstraction.
 *
 * - In a secure context (HTTPS / localhost) the browser Geolocation API is used.
 * - Inside the Town Pass app WebView the page is usually served over http:// on the LAN,
 *   which is not a secure context, so `navigator.geolocation` is blocked. There we ask the
 *   host app through its `flutterObject` JS bridge (`{name: 'location'}` → geolocator Position JSON).
 */

export type Fix = { latitude: number; longitude: number; accuracy: number; timestamp: number }
export type FixError = { code: 1 | 2 | 3; message: string }

type BridgeMessage = { name?: string; data?: unknown }
type FlutterObject = {
  postMessage: (message: string) => void
  addEventListener: (type: 'message', listener: (event: { data: string }) => void) => void
  removeEventListener: (type: 'message', listener: (event: { data: string }) => void) => void
}

function flutterObject(): FlutterObject | null {
  const candidate = (window as unknown as { flutterObject?: FlutterObject }).flutterObject
  return candidate && typeof candidate.postMessage === 'function' ? candidate : null
}

const useBrowser = () => window.isSecureContext && 'geolocation' in navigator

export function locationAvailable() {
  return useBrowser() || flutterObject() !== null
}

export const locationSourceLabel = () => useBrowser() ? 'browser' : flutterObject() ? 'townpass' : 'none'

function bridgeFix(timeoutMs: number): Promise<Fix> {
  const bridge = flutterObject()
  if (!bridge) return Promise.reject<Fix>({ code: 2, message: 'no bridge' } satisfies FixError)
  return new Promise((resolve, reject) => {
    const listener = (event: { data: string }) => {
      let reply: BridgeMessage
      try {
        reply = JSON.parse(event.data)
      } catch {
        return
      }
      if (reply.name !== 'location') return
      cleanup()
      const data = reply.data as Partial<Record<'latitude' | 'longitude' | 'accuracy' | 'timestamp', number>> | unknown[]
      if (Array.isArray(data) || typeof data?.latitude !== 'number' || typeof data.longitude !== 'number') {
        // The app replies [] when permission is missing or location services are off.
        reject({ code: 1, message: 'Town Pass 未取得定位' } satisfies FixError)
        return
      }
      resolve({
        latitude: data.latitude,
        longitude: data.longitude,
        accuracy: typeof data.accuracy === 'number' ? data.accuracy : 30,
        timestamp: typeof data.timestamp === 'number' ? data.timestamp : Date.now(),
      })
    }
    const timer = setTimeout(() => {
      cleanup()
      reject({ code: 3, message: 'timeout' } satisfies FixError)
    }, timeoutMs)
    const cleanup = () => {
      clearTimeout(timer)
      bridge.removeEventListener('message', listener)
    }
    bridge.addEventListener('message', listener)
    bridge.postMessage(JSON.stringify({ name: 'location', data: null }))
  })
}

export function getFix(options: { highAccuracy?: boolean; timeout?: number; maximumAge?: number } = {}): Promise<Fix> {
  const timeout = options.timeout ?? 18000
  if (useBrowser()) {
    return new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition(
      ({ coords, timestamp }) => resolve({ latitude: coords.latitude, longitude: coords.longitude, accuracy: coords.accuracy, timestamp }),
      ({ code, message }) => reject({ code: code as FixError['code'], message }),
      { enableHighAccuracy: options.highAccuracy ?? false, timeout, maximumAge: options.maximumAge ?? 15000 },
    ))
  }
  return bridgeFix(timeout)
}

/** Continuous updates. Returns a stop function. The bridge has no stream, so it polls one request at a time. */
export function watchFix(onFix: (fix: Fix) => void, onError: (error: FixError) => void): () => void {
  if (useBrowser()) {
    const id = navigator.geolocation.watchPosition(
      ({ coords, timestamp }) => onFix({ latitude: coords.latitude, longitude: coords.longitude, accuracy: coords.accuracy, timestamp }),
      ({ code, message }) => onError({ code: code as FixError['code'], message }),
      { enableHighAccuracy: true, maximumAge: 2000, timeout: 18000 },
    )
    return () => navigator.geolocation.clearWatch(id)
  }
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const poll = async () => {
    try {
      const fix = await bridgeFix(15000)
      if (!stopped) onFix(fix)
    } catch (error) {
      if (!stopped) onError(error as FixError)
      if ((error as FixError).code === 1) return
    }
    if (!stopped) timer = setTimeout(poll, 2000)
  }
  void poll()
  return () => {
    stopped = true
    clearTimeout(timer)
  }
}

/**
 * True when the page runs inside a host app WebView (Town Pass): the `flutterObject` bridge exists,
 * the URL carries `?embedded` (remembered for the session), or the UA is an Android WebView (`; wv)`).
 * The host app draws its own app bar above the WebView, so the page must not reserve a top inset.
 */
export function isEmbedded() {
  if (flutterObject()) return true
  try {
    if (new URLSearchParams(location.search).has('embedded')) sessionStorage.setItem('howgo-embedded', '1')
    if (sessionStorage.getItem('howgo-embedded') === '1') return true
  } catch {}
  return /; wv\)/.test(navigator.userAgent)
}
