import { describe, expect, it } from 'vitest'
import type { SensorBatch, WifiScan } from '../bridge/townpass'
import type { NavFeature, UnitFeature, VenueData } from '../data/types'
import type { XY } from '../geo/frame'
import { createPositioning } from './engine'
import { BaroDetector, levelConnectors, levelForHeightChange } from './levels'
import { mulberry32, makeGauss } from './rng'
import type { LevelChange, Radiomap } from './types'

const T0 = 1_800_000_000_000

/** pressure samples at hz from t0 for `seconds`, p(t_s) */
function baro(seconds: number, p: (s: number) => number, hz = 10, t0 = T0): [number, number][] {
  const out: [number, number][] = []
  for (let k = 0; k < seconds * hz; k++) out.push([t0 + (k * 1000) / hz, p(k / hz)])
  return out
}
const run = (det: BaroDetector, samples: [number, number][]) => samples.map(([t, v]) => det.push(t, v)).filter((e) => e !== null)

describe('BaroDetector', () => {
  it('detects a 0.6 hPa drop within 10 s as about +5 m (one storey up)', () => {
    const det = new BaroDetector()
    const ev = run(det, baro(120, (s) => 1010 - (s > 40 ? Math.min(1, (s - 40) / 10) * 0.6 : 0)))
    expect(ev).toHaveLength(1)
    expect(ev[0]!.dhM).toBeGreaterThan(4)
    expect(ev[0]!.dhM).toBeLessThan(6)
    // held >= 5 s after the change built up
    expect(ev[0]!.t - (T0 + 45000)).toBeGreaterThan(4000)
  })

  it('detects going down too', () => {
    const ev = run(new BaroDetector(), baro(120, (s) => 1010 + (s > 30 ? Math.min(1, (s - 30) / 8) * 0.6 : 0)))
    expect(ev).toHaveLength(1)
    expect(ev[0]!.dhM).toBeLessThan(-4)
  })

  it('ignores weather drift of 1 hPa/hour', () => {
    expect(run(new BaroDetector(), baro(7200, (s) => 1010 - s / 3600, 1))).toHaveLength(0)
  })

  it('does not flap on noisy pressure, and still reports a real step once', () => {
    const g = makeGauss(mulberry32(4))
    const noisy = baro(600, () => 1010 + g() * 0.08 + (Math.random() < 0.01 ? 2 : 0), 10)
    expect(run(new BaroDetector(), noisy)).toHaveLength(0)
    const g2 = makeGauss(mulberry32(5))
    const step = baro(300, (s) => 1010 + g2() * 0.08 - (s > 100 ? 0.6 : 0), 10)
    expect(run(new BaroDetector(), step)).toHaveLength(1)
  })

  it('ignores a half step (escalator landing, door draught)', () => {
    expect(run(new BaroDetector(), baro(200, (s) => 1010 - (s > 50 ? 0.3 : 0)))).toHaveLength(0)
  })

  it('maps a height change to the adjacent level by elevation', () => {
    const levels = [{ id: '1F', ordinal: 0, elevation_m: 0 }, { id: '2F', ordinal: 1, elevation_m: 5 }, { id: '3F', ordinal: 2, elevation_m: 9 }]
    expect(levelForHeightChange(levels, '1F', 5.2)).toBe('2F')
    expect(levelForHeightChange(levels, '2F', -4.6)).toBe('1F')
    expect(levelForHeightChange(levels, '2F', 4.1)).toBe('3F')
    expect(levelForHeightChange(levels, '1F', -5)).toBeNull()
    expect(levelForHeightChange(levels, '1F', 1.2)).toBeNull()
  })
})

// ---- engine: two floors, a corridor each, an elevator at the west end (A-el) and one at the east end (B-el)
const rect = (id: string, level: string, x0: number, y0: number, x1: number, y1: number): UnitFeature => ({
  type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]] as XY[]] },
  properties: { id, level, category: 'corridor' },
})
const node = (id: string, level: string, p: XY): NavFeature => ({ type: 'Feature', geometry: { type: 'Point', coordinates: p }, properties: { kind: 'node', id, level } })
const edge = (from: string, to: string, a: XY, b: XY, type: string): NavFeature => ({
  type: 'Feature', geometry: { type: 'LineString', coordinates: [a, b] }, properties: { kind: 'edge', from, to, type, accessible: true, length_m: 15 },
})
const venueData: VenueData = {
  venue: {
    id: 't', name: 't', origin: { lng: 121.5, lat: 25.1 }, bearing_deg: 0, default_level: '1F',
    levels: [{ id: '1F', ordinal: 0, name: '1F', elevation_m: 0 }, { id: '2F', ordinal: 1, name: '2F', elevation_m: 5 }],
  },
  levels: ['1F', '2F'].map((l, i) => ({
    level: { id: l, ordinal: i, name: l, elevation_m: i * 5 }, wallsLoaded: true, walls: [], walls3d: [], pois: [],
    units: [rect(`${l}-c`, l, 0, 0, 60, 3)],
  })),
  nav: [
    node('1F-A', '1F', [2, 1.5]), node('2F-A', '2F', [2.5, 1.5]), node('1F-B', '1F', [58, 1.5]), node('2F-B', '2F', [57.5, 1.5]),
    edge('1F-A', '2F-A', [2, 1.5], [2.5, 1.5], 'elevator'), edge('1F-B', '2F-B', [58, 1.5], [57.5, 1.5], 'elevator'),
  ],
  available: { walls: false, walls3d: false, units: true, pois: false, nav: true },
}
// WiFi: AP "a" only heard on 1F, AP "b" only on 2F
const fp = (level: string, x: number, aps: Record<string, number>) => ({
  id: `${level}-${x}`, level, x, y: 1.5, n_scans: 4,
  aps: Object.fromEntries(Object.entries(aps).map(([b, m]) => [b, { mean: m, std: 2, detect: 1 }])),
})
const A = ['00:11:22:00:00:0a', '00:11:22:00:00:1a', '00:11:22:00:00:2a']
const B = ['00:11:22:00:00:0b', '00:11:22:00:00:1b', '00:11:22:00:00:2b']
const radiomap: Radiomap = {
  bssids: [...A, ...B],
  params: { likelihood_temper: 0.25 },
  points: [0, 10, 20, 30, 40, 50, 60].flatMap((x) => [
    fp('1F', x, Object.fromEntries(A.map((b, i) => [b, -50 - i * 6]))),
    fp('2F', x, Object.fromEntries(B.map((b, i) => [b, -50 - i * 6]))),
  ]),
}
let scanTs = 1
const scanOf = (bssids: string[], t: number): WifiScan => {
  scanTs += 5_000_000
  return { supported: true, status: 'ok', collected_at: t, results: bssids.map((bssid, i) => ({ bssid, ssid: 'x', level: -50 - i * 6, frequency: 2437, timestamp: scanTs })) }
}
const still = (t: number, extra: Partial<SensorBatch> = {}): SensorBatch => ({
  accelerometer: [[t, 0, 0, 9.81]], gyroscope: [[t, 0, 0, 0]], magnetometer: [[t, 0, 30, -30]], ...extra,
})

describe('automatic floor changes', () => {
  it('lists the elevator connectors from nav', () => {
    const c = levelConnectors(venueData.nav)
    expect(c.find((x) => x.id === '1F-A')?.partners.map((p) => p.id)).toEqual(['2F-A'])
  })

  it('switches on a barometric step and re-seeds at the partner elevator', () => {
    const eng = createPositioning({ venueData, options: { seed: 1 } })
    const changes: LevelChange[] = []
    eng.onLevelChange((c) => changes.push(c))
    eng.setKnownPosition(3, 1.5, '1F', { t: T0 })
    for (const [t, p] of baro(60, (s) => 1010 - (s > 20 ? Math.min(1, (s - 20) / 10) * 0.6 : 0))) eng.pushSensorBatch(still(t, { barometer: [[t, p]] }))
    expect(changes).toHaveLength(1)
    expect(changes[0]).toMatchObject({ from: '1F', to: '2F', source: 'barometer', connector: '2F-A' })
    expect(eng.stats.level).toBe('2F')
    expect(eng.last!.level).toBe('2F')
    expect(Math.hypot(eng.last!.x - 2.5, eng.last!.y - 1.5)).toBeLessThan(3)
    expect(eng.stats.baroAvailable).toBe(true)
  })

  it('switches on WiFi alone near an elevator (strong margin, 2 scans)', () => {
    const eng = createPositioning({ venueData, radiomap, options: { seed: 1 } })
    const changes: LevelChange[] = []
    eng.onLevelChange((c) => changes.push(c))
    eng.setKnownPosition(56, 1.5, '1F', { t: T0 })
    eng.pushWifiScan(scanOf(B, T0 + 5000))
    expect(changes).toHaveLength(0) // one scan is not enough
    eng.pushWifiScan(scanOf(B, T0 + 13000))
    expect(changes).toHaveLength(1)
    expect(changes[0]).toMatchObject({ from: '1F', to: '2F', source: 'wifi', connector: '2F-B' })
    expect(eng.stats.wifiLevelVote?.dist).toBeDefined()
  })

  it('does not switch on WiFi far from any elevator', () => {
    const eng = createPositioning({ venueData, radiomap, options: { seed: 1 } })
    const changes: LevelChange[] = []
    eng.onLevelChange((c) => changes.push(c))
    eng.setKnownPosition(30, 1.5, '1F', { t: T0 })
    for (let k = 0; k < 5; k++) eng.pushWifiScan(scanOf(B, T0 + 5000 + k * 8000))
    expect(changes).toHaveLength(0)
    expect(eng.stats.level).toBe('1F')
    expect(eng.stats.wifiLevelVote?.candidate).toBe('2F')
  })

  it('a working barometer that says "same floor" vetoes a WiFi-only switch', () => {
    const eng = createPositioning({ venueData, radiomap, options: { seed: 1 } })
    const changes: LevelChange[] = []
    eng.onLevelChange((c) => changes.push(c))
    eng.setKnownPosition(56, 1.5, '1F', { t: T0 })
    for (const [t, p] of baro(30, () => 1010)) eng.pushSensorBatch(still(t, { barometer: [[t, p]] }))
    for (let k = 0; k < 3; k++) eng.pushWifiScan(scanOf(B, T0 + 31000 + k * 8000))
    expect(changes).toHaveLength(0)
  })

  it('works without a barometer (A71): stats say so, WiFi still switches', () => {
    const eng = createPositioning({ venueData, radiomap, options: { seed: 1 } })
    const changes: LevelChange[] = []
    eng.onLevelChange((c) => changes.push(c))
    eng.setKnownPosition(3, 1.5, '1F', { t: T0 })
    for (let k = 0; k < 20; k++) eng.pushSensorBatch(still(T0 + k * 200, { unavailable: ['barometer'] }))
    expect(eng.stats.baroAvailable).toBe(false)
    expect(eng.stats.pressureDeltaHpa).toBeNull()
    eng.pushWifiScan(scanOf(B, T0 + 5000))
    eng.pushWifiScan(scanOf(B, T0 + 13000))
    expect(changes.map((c) => c.source)).toEqual(['wifi'])
  })

  it('setKnownPosition is authoritative and restarts the barometer reference', () => {
    const eng = createPositioning({ venueData, options: { seed: 1 } })
    const changes: LevelChange[] = []
    eng.onLevelChange((c) => changes.push(c))
    eng.setKnownPosition(3, 1.5, '1F', { t: T0 })
    // the user rides up and confirms 2F in the UI before the barometer step is confirmed
    const samples = baro(60, (s) => 1010 - (s > 20 ? Math.min(1, (s - 20) / 10) * 0.6 : 0))
    for (const [t, p] of samples.slice(0, 260)) eng.pushSensorBatch(still(t, { barometer: [[t, p]] }))
    eng.setKnownPosition(2.5, 1.5, '2F', { t: samples[260][0] })
    for (const [t, p] of samples.slice(260)) eng.pushSensorBatch(still(t, { barometer: [[t, p]] }))
    expect(changes).toHaveLength(0)
    expect(eng.stats.level).toBe('2F')
  })

  it('autoLevel: false keeps the level', () => {
    const eng = createPositioning({ venueData, options: { seed: 1, autoLevel: false } })
    eng.setKnownPosition(3, 1.5, '1F', { t: T0 })
    for (const [t, p] of baro(60, (s) => 1010 - (s > 20 ? 0.6 : 0))) eng.pushSensorBatch(still(t, { barometer: [[t, p]] }))
    expect(eng.stats.level).toBe('1F')
  })
})
