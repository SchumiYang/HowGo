import { afterEach, describe, expect, it, vi } from 'vitest'
import { lowSensorRate } from '../composables/useMagHint'

/** Minimal stand-in for the object TownPass injects into the WebView. */
function fakeFlutter() {
  const listeners: ((e: { data: string }) => void)[] = []
  const sent: { name: string; data: unknown }[] = []
  return {
    sent,
    obj: {
      postMessage: (m: string) => sent.push(JSON.parse(m)),
      addEventListener: (_: 'message', l: (e: { data: string }) => void) => listeners.push(l),
    },
    reply: (name: string, data: unknown) => listeners.forEach((l) => l({ data: JSON.stringify({ name, data }) })),
  }
}

async function freshBridge(flutterObject?: unknown) {
  vi.stubGlobal('window', { flutterObject, addEventListener: () => {} })
  vi.resetModules()
  const mod = await import('./townpass')
  return { mod, bridge: new mod.TownPassBridge() }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('TownPass bridge outside the app', () => {
  it('reports unavailable and never throws', async () => {
    const { bridge } = await freshBridge(undefined)
    expect(bridge.available).toBe(false)
    expect(bridge.send('location')).toBe(false)
    expect(await bridge.getLocation()).toMatchObject({ ok: false, reason: 'unavailable' })
    expect(await bridge.scanQrCode()).toMatchObject({ ok: false, reason: 'unavailable' })
    expect(bridge.startSensorStream({ sensors: ['gyroscope'], interval_ms: 20, batch_ms: 200 })).toBe(false)
    expect(await bridge.stopSensorStream()).toMatchObject({ ok: false, reason: 'unavailable' })
  })
})

describe('TownPass bridge inside the app', () => {
  it('sends {name, data} and resolves the reply with the same name', async () => {
    const f = fakeFlutter()
    const { bridge } = await freshBridge(f.obj)
    const p = bridge.scanQrCode()
    expect(f.sent).toEqual([{ name: 'qr_code_scan', data: null }])
    f.reply('deviceinfo', { os: 'x' }) // unrelated message is ignored
    f.reply('qr_code_scan', 'tpnav:mock:1F-entrance')
    expect(await p).toEqual({ ok: true, data: 'tpnav:mock:1F-entrance' })
  })

  it('times out when the handler never answers', async () => {
    vi.useFakeTimers()
    const f = fakeFlutter()
    const { bridge } = await freshBridge(f.obj)
    const p = bridge.getDeviceInfo(1000)
    vi.advanceTimersByTime(1001)
    expect(await p).toMatchObject({ ok: false, reason: 'timeout' })
  })

  it('separates sensor batches from the stop ack on the shared handler name', async () => {
    const f = fakeFlutter()
    const { bridge } = await freshBridge(f.obj)
    const batches: unknown[] = []
    const off = bridge.onSensorBatch((b) => batches.push(b))
    expect(bridge.startSensorStream({ sensors: ['accelerometer', 'barometer'], interval_ms: 20, batch_ms: 200 })).toBe(true)
    expect(f.sent[0]).toEqual({ name: 'sensor_stream', data: { action: 'start', sensors: ['accelerometer', 'barometer'], interval_ms: 20, batch_ms: 200 } })
    f.reply('sensor_stream', { accelerometer: [[1, 0, 0, 9.8]], barometer: [[1, 1013.2]] })
    const stop = bridge.stopSensorStream()
    f.reply('sensor_stream', { accelerometer: [[2, 0, 0, 9.8]] }) // in-flight batch must not resolve stop
    f.reply('sensor_stream', true)
    expect(await stop).toEqual({ ok: true, data: true })
    expect(batches).toHaveLength(2)
    off()
    f.reply('sensor_stream', { accelerometer: [[3, 0, 0, 9.8]] })
    expect(batches).toHaveLength(2)
  })

  it('delivers one-shot and stream wifi results to onWifiScan', async () => {
    const f = fakeFlutter()
    const { bridge } = await freshBridge(f.obj)
    const got: string[] = []
    bridge.onWifiScan((_, source) => got.push(source))
    const scan = { supported: true, status: 'yes', collected_at: 1, results: [] }
    const p = bridge.wifiScan()
    f.reply('wifi_scan', { ...scan, scan_started: true })
    expect((await p).ok).toBe(true)
    f.reply('wifi_scan_stream', scan)
    f.reply('wifi_scan_stream', true) // stop ack is not a scan
    expect(got).toEqual(['single', 'stream'])
  })
})

describe('magnetometer status', () => {
  it('tracks iOS magnetometer_accuracy and the last batch with magnetometer samples', async () => {
    const f = fakeFlutter()
    const { bridge } = await freshBridge(f.obj)
    expect(bridge.magnetometerStatus().streaming).toBe(false)
    bridge.startSensorStream({ sensors: ['magnetometer'], interval_ms: 20, batch_ms: 200 })
    const t0 = Date.now()
    // uncalibrated iPhone: batches without a magnetometer array
    f.reply('sensor_stream', { accelerometer: [[1, 0, 0, 9.8]] })
    let s = bridge.magnetometerStatus(t0 + 4000)
    expect(s.streaming).toBe(true)
    expect(s.sinceLastSampleMs).toBe(Infinity)
    expect(s.accuracy).toBeNull()
    // calibrated: samples + accuracy
    f.reply('sensor_stream', { magnetometer: [[2, 20, -10, -40]], magnetometer_accuracy: 2 })
    s = bridge.magnetometerStatus()
    expect(s.sinceLastSampleMs).toBeLessThan(1000)
    expect(s.accuracy).toBe(2)
    expect(bridge.magnetometerAccuracy).toBe(2)
  })
})

describe('gyroscope rate', () => {
  it('measures the rate over ~5 s of sensor time (null before)', async () => {
    const f = fakeFlutter()
    const { bridge } = await freshBridge(f.obj)
    bridge.startSensorStream({ sensors: ['gyroscope'], interval_ms: 20, batch_ms: 200 })
    const batch = (t0: number, hz: number, ms: number) => Array.from({ length: Math.round((ms * hz) / 1000) }, (_, i) => [t0 + (i * 1000) / hz, 0, 0, 0])
    f.reply('sensor_stream', { gyroscope: batch(0, 20, 1000) }) // battery saver: ~20 Hz
    expect(bridge.gyroscopeRateHz()).toBeNull() // only 1 s so far
    f.reply('sensor_stream', { gyroscope: batch(1000, 20, 5000) })
    expect(bridge.gyroscopeRateHz()).toBeCloseTo(20, 0)
    expect(lowSensorRate(bridge.gyroscopeRateHz())).toBe(true) // -> power-saving hint
    f.reply('sensor_stream', { gyroscope: batch(6000, 50, 6000) })
    expect(bridge.gyroscopeRateHz()).toBeCloseTo(50, 0) // window slid past the slow part
  })
})

describe('parseNavQr', () => {
  it('parses tpnav codes', async () => {
    const { mod } = await freshBridge(undefined)
    expect(mod.parseNavQr('tpnav:tianmu:1F-n12')).toEqual({ venue: 'tianmu', node: '1F-n12' })
    expect(mod.parseNavQr('https://example.com')).toBeNull()
  })
})
