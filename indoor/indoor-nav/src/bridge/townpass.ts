/**
 * Typed client for the TownPass WebView bridge (`window.flutterObject`).
 *
 * Protocol: send `flutterObject.postMessage(JSON.stringify({ name, data }))`, receive
 * `flutterObject.addEventListener('message', e => JSON.parse(e.data))` -> `{ name, data }`.
 * Replies carry only the handler name, so request/response is matched FIFO per name.
 *
 * Outside TownPass (plain browser) every call resolves to `{ ok: false, reason: 'unavailable' }`;
 * nothing here throws.
 */

// ---------- payload types ----------

export interface WifiResult {
  bssid: string
  ssid: string
  /** dBm */
  level: number
  /** MHz */
  frequency: number
  /** µs since boot */
  timestamp: number | null
}

export interface WifiScan {
  supported: boolean
  status: string
  /** absent on stream messages */
  scan_started?: boolean
  /** epoch ms */
  collected_at: number
  results: WifiResult[]
}

export type SensorName = 'accelerometer' | 'user_accelerometer' | 'gyroscope' | 'magnetometer' | 'barometer'
/** [t (epoch ms, fractional), x, y, z] */
export type Vec3Sample = [number, number, number, number]
/** [t (epoch ms, fractional), hPa] */
export type BaroSample = [number, number]

export interface SensorBatch {
  accelerometer?: Vec3Sample[]
  user_accelerometer?: Vec3Sample[]
  gyroscope?: Vec3Sample[]
  magnetometer?: Vec3Sample[]
  barometer?: BaroSample[]
  unavailable?: string[]
  /**
   * iOS only: CMMagneticFieldCalibrationAccuracy of the batch's magnetometer samples (1 = medium,
   * 2 = high). Low / uncalibrated samples aren't sent at all, so an uncalibrated iPhone simply has no
   * `magnetometer` array. Android doesn't send it. Consumers other than the bridge ignore it.
   */
  magnetometer_accuracy?: number
}

/** Magnetometer health, for the calibration hint (see magnetometerStatus()). */
export interface MagnetometerStatus {
  /** a sensor_stream is running */
  streaming: boolean
  /** ms since the stream started (0 when not streaming) */
  streamingForMs: number
  /** ms since the last batch that carried magnetometer samples (Infinity if none yet) */
  sinceLastSampleMs: number
  /** latest magnetometer_accuracy (iOS), null when never sent (Android) */
  accuracy: number | null
}

export interface SensorStreamOptions {
  sensors: SensorName[]
  interval_ms: number
  batch_ms: number
}

/** Shape of the existing `location` handler's reply is app-defined; known fields are typed loosely. */
export interface LocationReply {
  latitude?: number
  longitude?: number
  accuracy?: number
  [k: string]: unknown
}
export type DeviceInfoReply = Record<string, unknown>

export type BridgeFailure = 'unavailable' | 'timeout' | 'bad-reply'
export type BridgeResult<T> = { ok: true; data: T } | { ok: false; reason: BridgeFailure; message: string }

export interface BridgeMessage<T = unknown> {
  name: string
  data: T
}

interface FlutterObject {
  postMessage(message: string): void
  addEventListener(type: 'message', listener: (e: { data: string }) => void): void
}

declare global {
  interface Window {
    flutterObject?: FlutterObject
  }
}

type Listener = (data: unknown) => void

interface Pending {
  accept: (data: unknown) => boolean
  resolve: (r: BridgeResult<unknown>) => void
  timer: ReturnType<typeof setTimeout>
}

const UNAVAILABLE = { ok: false, reason: 'unavailable', message: '不在 TownPass App 內 (flutterObject 不存在)' } as const

/** window for the gyroscope rate estimate (power-saving hint) */
const GYRO_WINDOW_MS = 5000

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

export class TownPassBridge {
  private fo: FlutterObject | null = null
  private listeners = new Map<string, Set<Listener>>()
  private pending = new Map<string, Pending[]>()
  private streams = new Set<'sensor_stream' | 'wifi_scan_stream'>()
  /** last raw messages for the debug panel */
  readonly log: { t: number; dir: 'in' | 'out'; name: string }[] = []

  constructor() {
    if (typeof window !== 'undefined') {
      this.attach()
      // the object is injected at document start, but re-check in case of late injection
      if (!this.fo) setTimeout(() => this.attach(), 500)
      window.addEventListener('pagehide', () => this.stopAllStreams())
    }
  }

  get available(): boolean {
    return this.attach() !== null
  }

  private attach(): FlutterObject | null {
    if (this.fo) return this.fo
    const fo = typeof window !== 'undefined' ? window.flutterObject : undefined
    if (!fo || typeof fo.postMessage !== 'function') return null
    this.fo = fo
    try {
      fo.addEventListener('message', (e) => this.onMessage(e))
    } catch (err) {
      console.warn('[townpass] addEventListener failed', err)
    }
    return fo
  }

  private onMessage(e: { data: string }) {
    let msg: BridgeMessage
    try {
      msg = typeof e.data === 'string' ? JSON.parse(e.data) : (e.data as BridgeMessage)
    } catch {
      return
    }
    if (!isObj(msg) || typeof msg.name !== 'string') return
    this.pushLog('in', msg.name)
    if (msg.name === 'sensor_stream' && isObj(msg.data)) this.noteSensorBatch(msg.data as SensorBatch)

    const queue = this.pending.get(msg.name)
    const idx = queue?.findIndex((p) => p.accept(msg.data)) ?? -1
    if (queue && idx >= 0) {
      const [p] = queue.splice(idx, 1)
      clearTimeout(p.timer)
      p.resolve({ ok: true, data: msg.data })
    }
    for (const l of this.listeners.get(msg.name) ?? []) {
      try {
        l(msg.data)
      } catch (err) {
        console.error('[townpass] listener error', err)
      }
    }
  }

  private pushLog(dir: 'in' | 'out', name: string) {
    this.log.push({ t: Date.now(), dir, name })
    if (this.log.length > 100) this.log.shift()
  }

  /** Fire-and-forget. Returns false if the bridge is unavailable. */
  send(name: string, data: unknown = null): boolean {
    const fo = this.attach()
    if (!fo) return false
    try {
      fo.postMessage(JSON.stringify({ name, data }))
      this.pushLog('out', name)
      return true
    } catch (err) {
      console.warn('[townpass] postMessage failed', err)
      return false
    }
  }

  /** Subscribe to every message with this handler name. Returns an unsubscribe function. */
  on(name: string, listener: Listener): () => void {
    let set = this.listeners.get(name)
    if (!set) this.listeners.set(name, (set = new Set()))
    set.add(listener)
    return () => set!.delete(listener)
  }

  /**
   * Send and wait for the first reply with the same name that `accept` approves.
   */
  request<T>(name: string, data: unknown = null, opts: { timeoutMs?: number; accept?: (data: unknown) => boolean } = {}): Promise<BridgeResult<T>> {
    if (!this.attach()) return Promise.resolve(UNAVAILABLE)
    const timeoutMs = opts.timeoutMs ?? 10000
    return new Promise((resolve) => {
      const p: Pending = {
        accept: opts.accept ?? (() => true),
        resolve: resolve as Pending['resolve'],
        timer: setTimeout(() => {
          const q = this.pending.get(name)
          const i = q?.indexOf(p) ?? -1
          if (q && i >= 0) q.splice(i, 1)
          resolve({ ok: false, reason: 'timeout', message: `${name}: ${timeoutMs} ms 內無回應` })
        }, timeoutMs),
      }
      let q = this.pending.get(name)
      if (!q) this.pending.set(name, (q = []))
      q.push(p)
      if (!this.send(name, data)) {
        clearTimeout(p.timer)
        q.splice(q.indexOf(p), 1)
        resolve(UNAVAILABLE)
      }
    })
  }

  // ---------- existing handlers ----------

  getLocation(timeoutMs = 15000) {
    return this.request<LocationReply>('location', null, { timeoutMs })
  }

  getDeviceInfo(timeoutMs = 5000) {
    return this.request<DeviceInfoReply>('deviceinfo', null, { timeoutMs })
  }

  private gender: Promise<'male' | 'female' | null> | null = null
  /**
   * `user_gender` -> `{ gender: 'male' | 'female' | null }`, derived natively from the ID number (the
   * ID itself is never sent). Null when unknown, outside TownPass or with no reply in `timeoutMs`.
   * A real answer is cached for the session; failures are retried on the next call.
   */
  getUserGender(timeoutMs = 1000): Promise<'male' | 'female' | null> {
    if (this.gender) return this.gender
    const p = this.request<unknown>('user_gender', null, { timeoutMs, accept: isObj }).then((r) => {
      const g = r.ok && isObj(r.data) ? r.data.gender : null
      if (!r.ok) this.gender = null
      return g === 'male' || g === 'female' ? g : null
    })
    this.gender = p
    return p
  }

  /** Opens the native QR scanner; resolves with the scanned string. Long timeout: the user is scanning. */
  async scanQrCode(timeoutMs = 120000): Promise<BridgeResult<string>> {
    const r = await this.request<unknown>('qr_code_scan', null, { timeoutMs })
    if (!r.ok) return r
    if (typeof r.data !== 'string') return { ok: false, reason: 'bad-reply', message: 'qr_code_scan 回傳非字串' }
    return { ok: true, data: r.data }
  }

  // ---------- wifi ----------

  /** One-shot scan (~6 s when a real scan runs; throttled scans return cached results fast). */
  wifiScan(timeoutMs = 15000) {
    return this.request<WifiScan>('wifi_scan', null, { timeoutMs, accept: isObj })
  }

  startWifiStream(interval_ms: number): boolean {
    const sent = this.send('wifi_scan_stream', { action: 'start', interval_ms })
    if (sent) this.streams.add('wifi_scan_stream')
    return sent
  }

  async stopWifiStream(timeoutMs = 5000): Promise<BridgeResult<true>> {
    this.streams.delete('wifi_scan_stream')
    return this.request<true>('wifi_scan_stream', { action: 'stop' }, { timeoutMs, accept: (d) => d === true })
  }

  /** Receives both one-shot (`wifi_scan`) and stream (`wifi_scan_stream`) results. */
  onWifiScan(cb: (scan: WifiScan, source: 'single' | 'stream') => void): () => void {
    const offA = this.on('wifi_scan', (d) => isObj(d) && cb(d as unknown as WifiScan, 'single'))
    const offB = this.on('wifi_scan_stream', (d) => isObj(d) && cb(d as unknown as WifiScan, 'stream'))
    return () => (offA(), offB())
  }

  // ---------- sensors ----------

  startSensorStream(opts: SensorStreamOptions): boolean {
    const sent = this.send('sensor_stream', { action: 'start', ...opts })
    if (sent) {
      this.streams.add('sensor_stream')
      this.sensorStartedAt = Date.now()
      this.lastMagAt = -Infinity
      this.magAccuracy = null
      this.gyroTimes = []
    }
    return sent
  }

  private sensorStartedAt = 0
  private lastMagAt = -Infinity
  private magAccuracy: number | null = null

  /** gyroscope sample timestamps (sensor time, ms) over the last GYRO_WINDOW_MS */
  private gyroTimes: number[] = []

  private noteSensorBatch(b: SensorBatch) {
    if (typeof b.magnetometer_accuracy === 'number') this.magAccuracy = b.magnetometer_accuracy
    if (b.magnetometer?.length) this.lastMagAt = Date.now()
    if (b.gyroscope?.length) {
      for (const r of b.gyroscope) this.gyroTimes.push(r[0])
      const cutoff = this.gyroTimes[this.gyroTimes.length - 1] - GYRO_WINDOW_MS
      while (this.gyroTimes.length && this.gyroTimes[0] < cutoff) this.gyroTimes.shift()
    }
  }

  /**
   * Gyroscope sample rate (Hz) over the last ~5 s of sensor time, or null until ~4 s of samples
   * have arrived. ~50 Hz normally; Android battery saver drops it to ~20 Hz.
   */
  gyroscopeRateHz(): number | null {
    const t = this.gyroTimes
    if (t.length < 2) return null
    const span = t[t.length - 1] - t[0]
    return span >= GYRO_WINDOW_MS * 0.8 ? ((t.length - 1) * 1000) / span : null
  }

  /** Is the magnetometer delivering (calibrated) samples? Used for the 「畫 8 字」 calibration hint. */
  magnetometerStatus(now = Date.now()): MagnetometerStatus {
    const streaming = this.streams.has('sensor_stream')
    return {
      streaming,
      streamingForMs: streaming ? now - this.sensorStartedAt : 0,
      sinceLastSampleMs: now - this.lastMagAt,
      accuracy: this.magAccuracy,
    }
  }

  /** latest iOS magnetometer calibration accuracy (1 medium, 2 high), null if never reported */
  get magnetometerAccuracy(): number | null {
    return this.magAccuracy
  }

  async stopSensorStream(timeoutMs = 5000): Promise<BridgeResult<true>> {
    this.streams.delete('sensor_stream')
    return this.request<true>('sensor_stream', { action: 'stop' }, { timeoutMs, accept: (d) => d === true })
  }

  /** Stream batches; the stop ack (`data === true`) shares the handler name and is filtered out. */
  onSensorBatch(cb: (batch: SensorBatch) => void): () => void {
    return this.on('sensor_stream', (d) => isObj(d) && cb(d as SensorBatch))
  }

  get activeStreams(): string[] {
    return [...this.streams]
  }

  /** Best-effort synchronous stop (used on pagehide). */
  stopAllStreams() {
    if (!this.fo) return
    // always send both: a stream may have been started before a reload
    this.send('sensor_stream', { action: 'stop' })
    this.send('wifi_scan_stream', { action: 'stop' })
    this.streams.clear()
  }
}

export const townpass = new TownPassBridge()

/** Parse `tpnav:<venue>:<nav node id>` QR payloads. */
export function parseNavQr(text: string): { venue: string; node: string } | null {
  const m = /^tpnav:([\w-]+):(.+)$/.exec(text.trim())
  return m ? { venue: m[1], node: m[2] } : null
}
