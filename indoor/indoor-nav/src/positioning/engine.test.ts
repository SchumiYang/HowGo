import { describe, expect, it } from 'vitest'
import type { SensorBatch, SensorStreamOptions, Vec3Sample, WifiScan } from '../bridge/townpass'
import type { VenueData } from '../data/types'
import { createPositioning, type PositioningBridge } from './engine'
import type { PositionUpdate } from './types'

const venueData: VenueData = {
  venue: { id: 't', name: 't', origin: { lng: 121.5, lat: 25.1 }, bearing_deg: 0, levels: [{ id: '1F', ordinal: 0, name: '1F' }], default_level: '1F' },
  levels: [{
    level: { id: '1F', ordinal: 0, name: '1F' }, wallsLoaded: true, walls: [], walls3d: [], pois: [],
    units: [{ type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[0, 0], [50, 0], [50, 3], [0, 3], [0, 0]]] }, properties: { id: 'c', level: '1F', category: 'corridor' } }],
  }],
  nav: [],
  available: { walls: false, walls3d: false, units: true, pois: false, nav: false },
}

class FakeBridge implements PositioningBridge {
  sensorOpts: SensorStreamOptions | null = null
  wifiInterval: number | null = null
  stopped: string[] = []
  sensorCb: ((b: SensorBatch) => void) | null = null
  wifiCb: ((s: WifiScan, src: 'single' | 'stream') => void) | null = null
  startSensorStream(o: SensorStreamOptions) {
    this.sensorOpts = o
    return true
  }
  async stopSensorStream() {
    this.stopped.push('sensor')
  }
  onSensorBatch(cb: (b: SensorBatch) => void) {
    this.sensorCb = cb
    return () => (this.sensorCb = null)
  }
  startWifiStream(ms: number) {
    this.wifiInterval = ms
    return true
  }
  async stopWifiStream() {
    this.stopped.push('wifi')
  }
  onWifiScan(cb: (s: WifiScan, src: 'single' | 'stream') => void) {
    this.wifiCb = cb
    return () => (this.wifiCb = null)
  }
}

/** walking east (phone flat, top = +y device axis pointing east = local +x; field north = local +y) */
function walkBatches(seconds: number): SensorBatch[] {
  const out: SensorBatch[] = []
  let cur: SensorBatch = { accelerometer: [], gyroscope: [], magnetometer: [] }
  for (let k = 0; k < seconds * 50; k++) {
    const t = 1_800_000_000_000 + k * 20
    const a: Vec3Sample = [t, 0, 0, 9.81 + 2.5 * Math.sin(2 * Math.PI * 1.8 * k * 0.02)]
    cur.accelerometer!.push(a)
    cur.gyroscope!.push([t, 0, 0, 0])
    // device y (top) points east, so magnetic north (local +y) is the device's −x axis
    cur.magnetometer!.push([t, -36, 0, -26])
    if (k % 10 === 9) out.push(cur), (cur = { accelerometer: [], gyroscope: [], magnetometer: [] })
  }
  return out
}

describe('createPositioning', () => {
  it('wires the bridge, emits PDR updates after a known start, and stops cleanly', async () => {
    const eng = createPositioning({ venueData, options: { seed: 1, declinationDeg: 0 } })
    const bridge = new FakeBridge()
    const updates: PositionUpdate[] = []
    eng.onUpdate((u) => updates.push(u))
    expect(eng.start(bridge)).toBe(true)
    expect(bridge.sensorOpts?.sensors).toEqual(['accelerometer', 'gyroscope', 'magnetometer', 'barometer'])
    expect(bridge.wifiInterval).toBeNull() // no radiomap -> no WiFi scanning
    const batches = walkBatches(12)
    batches.slice(0, 5).forEach((b) => bridge.sensorCb!(b))
    eng.setKnownPosition(2, 1.5, '1F')
    batches.slice(5).forEach((b) => bridge.sensorCb!(b))
    expect(eng.stats.steps).toBeGreaterThan(15)
    const last = updates[updates.length - 1]
    expect(last.source).toBe('pdr')
    expect(last.level).toBe('1F')
    expect(last.x).toBeGreaterThan(8) // walked east along the corridor
    expect(last.y).toBeGreaterThan(0)
    expect(last.y).toBeLessThan(3)
    expect(last.heading_deg).not.toBeNull()
    expect(Math.abs(((last.heading_deg! - 90 + 540) % 360) - 180)).toBeLessThan(25)
    expect(last.confidence).toBeGreaterThan(0)
    expect(last.confidence).toBeLessThanOrEqual(1)
    await eng.stop()
    expect(bridge.stopped).toContain('sensor')
    expect(bridge.sensorCb).toBeNull()
  })

  it('corrects a sensor clock that is off the wall clock (iOS bridge: 217 s behind)', () => {
    const eng = createPositioning({ venueData, options: { seed: 1, declinationDeg: 0 } })
    const updates: PositionUpdate[] = []
    eng.onUpdate((u) => updates.push(u))
    const batches = walkBatches(12)
    const t0 = batches[0].accelerometer![0][0]
    const skew = 217_400
    // batches arrive in real time (t + 200 ms delivery) while their sample clock runs 217.4 s behind
    batches.forEach((b, k) => {
      const shifted: SensorBatch = {}
      for (const key of ['accelerometer', 'gyroscope', 'magnetometer'] as const) shifted[key] = b[key]!.map((v) => [v[0] - skew, v[1], v[2], v[3]])
      if (k === 5) eng.setKnownPosition(2, 1.5, '1F', { t: t0 + 1000 })
      eng.pushSensorBatch(shifted, t0 + (k + 1) * 200 + 200)
    })
    const steps = updates.filter((u) => u.t > t0 + 1000)
    expect(steps.length).toBeGreaterThan(10)
    // step updates carry wall-clock times (within the walk), not the skewed sensor clock
    for (const u of steps) expect(Math.abs(u.t - (t0 + 6000))).toBeLessThan(7000)
  })

  it('produces nothing without a start position or WiFi', () => {
    const eng = createPositioning({ venueData, options: { seed: 1 } })
    const updates: PositionUpdate[] = []
    eng.onUpdate((u) => updates.push(u))
    walkBatches(5).forEach((b) => eng.pushSensorBatch(b))
    expect(updates).toHaveLength(0)
    expect(eng.stats.initialized).toBe(false)
  })

  it('ignores synthetic maps unless allowed', () => {
    const radiomap = { synthetic: true, bssids: ['00:00:00:00:00:01'], points: [{ id: 'p', level: '1F', x: 1, y: 1, n_scans: 1, aps: {} }] }
    const warn = console.warn
    console.warn = () => {}
    try {
      expect(createPositioning({ venueData, radiomap }).stats.maps.wifi).toBe(false)
    } finally {
      console.warn = warn
    }
    expect(createPositioning({ venueData, radiomap, options: { allowSyntheticMaps: true } }).stats.maps.wifi).toBe(true)
  })
})
