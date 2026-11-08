import { describe, expect, it } from 'vitest'
import type { SensorBatch, WifiScan } from '../bridge/townpass'
import type { NavFeature, UnitFeature, VenueData } from '../data/types'
import type { XY } from '../geo/frame'
import { createPositioning } from './engine'
import { BaroDetector, levelConnectors, levelForHeightChange } from './levels'
import { mulberry32, makeGauss } from './rng'
import { replayRun, type EvalRun } from './replay'
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
    expect(run(new BaroDetector(), baro(200, (s) => 1010 - (s > 50 ? 0.2 : 0)))).toHaveLength(0)
  })

  it('detects an elevator ride: 0.42 hPa in 6 s (~3.5 m), smooth, at 1 Hz (iOS CMAltimeter) and 25 Hz', () => {
    const ride = (s: number) => 1010 - 0.42 * Math.min(1, Math.max(0, (s - 30) / 6))
    for (const hz of [1, 25]) {
      const ev = run(new BaroDetector(), baro(90, ride, hz))
      expect(ev).toHaveLength(1)
      expect(ev[0]!.dhM).toBeGreaterThan(2.5)
    }
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
  it('replays a recorded live run with barometer samples (elevator ride); runs without them still replay', () => {
    // 90 s standing in the cabin: IMU at 25 Hz, barometer at 1 Hz, a 0.42 hPa ride at 30–36 s, checkpoint on 2F
    const imu = Array.from({ length: 90 * 25 }, (_, i) => T0 + i * 40)
    const run: EvalRun = {
      run_id: 'synthetic-elevator', started_at: T0,
      seeds: [{ t: T0 + 500, level: '1F', x: 3, y: 1.5, heading_deg: null }],
      checkpoints: [{ t: T0 + 85_000, level: '2F', truth: [3, 1.5] }],
      raw: {
        sensors: {
          accelerometer: imu.map((t) => [t, 0, 0, 9.81]), gyroscope: imu.map((t) => [t, 0, 0, 0]), magnetometer: [],
          barometer: baro(90, (s) => 1010 - 0.42 * Math.min(1, Math.max(0, (s - 30) / 6)), 1),
        },
        wifi_scans: [],
      },
    }
    const r = replayRun(run, venueData, { radiomap: null, magmap: null }, { seed: 1 })!
    expect(r.levelChanges.map((c) => [c.from, c.to, c.source, c.connector])).toEqual([['1F', '2F', 'barometer', '2F-A']])
    expect(r.checkpoints[0]).toMatchObject({ level: '2F', estimate_level: '2F' })
    // recorded before the barometer was saved, or on a phone without one (A71): no floor change, still on 1F
    const old: EvalRun = { ...run, raw: { ...run.raw, sensors: { ...run.raw!.sensors, barometer: undefined }, unavailable: ['barometer'] } }
    const r2 = replayRun(old, venueData, { radiomap: null, magmap: null }, { seed: 1 })!
    expect(r2.levelChanges).toEqual([])
    expect(r2.checkpoints[0]).toMatchObject({ level: '2F', estimate_level: '1F' })
  })

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

  it('a WiFi-only start begins on the best-matching floor (users can start anywhere)', () => {
    const eng = createPositioning({ venueData, radiomap, options: { seed: 1 } })
    const changes: LevelChange[] = []
    eng.onLevelChange((c) => changes.push(c))
    eng.pushWifiScan(scanOf(B, T0))
    eng.pushWifiScan(scanOf(B, T0 + 8000))
    expect(eng.stats.level).toBe('2F')
    expect(eng.last?.level).toBe('2F')
    expect(changes).toHaveLength(0)
  })

  it('an elevator ride (no steps, ~0.42 hPa) switches floors and re-seeds at the elevator on the new floor', () => {
    for (const hz of [1, 25]) {
      const eng = createPositioning({ venueData, options: { seed: 1 } })
      const changes: LevelChange[] = []
      eng.onLevelChange((c) => changes.push(c))
      eng.setKnownPosition(3, 1.5, '1F', { t: T0 })
      const g = makeGauss(mulberry32(hz))
      // standing in the cabin: no steps, only the pressure moves (smooth 6 s ride), sensor noise 0.03 hPa
      for (const [t, p] of baro(90, (s) => 1010 - 0.42 * Math.min(1, Math.max(0, (s - 30) / 6)) + g() * 0.03, hz)) {
        eng.pushSensorBatch(still(t, { barometer: [[t, p]] }))
      }
      expect(changes.map((c) => [c.from, c.to, c.source, c.connector])).toEqual([['1F', '2F', 'barometer', '2F-A']])
      expect(eng.stats.steps).toBe(0)
      expect(eng.last?.level).toBe('2F')
    }
  })

  it('the barometer threshold follows the venue storey height (55%, here 5 m -> 0.33 hPa)', () => {
    const eng = createPositioning({ venueData, options: { seed: 1 } })
    const changes: LevelChange[] = []
    eng.onLevelChange((c) => changes.push(c))
    eng.setKnownPosition(3, 1.5, '1F', { t: T0 })
    // 0.25 hPa (~2 m): below the threshold
    for (const [t, p] of baro(90, (s) => 1010 - (s > 30 ? 0.25 : 0))) eng.pushSensorBatch(still(t, { barometer: [[t, p]] }))
    expect(changes).toHaveLength(0)
  })

  it('autoLevel: false keeps the level', () => {
    const eng = createPositioning({ venueData, options: { seed: 1, autoLevel: false } })
    eng.setKnownPosition(3, 1.5, '1F', { t: T0 })
    for (const [t, p] of baro(60, (s) => 1010 - (s > 20 ? 0.6 : 0))) eng.pushSensorBatch(still(t, { barometer: [[t, p]] }))
    expect(eng.stats.level).toBe('1F')
  })
})

// ---- floor void: 1F is a 40 x 30 m hall (the court), 2F only a 3 m ring round it (no floor over the middle)
const hall: VenueData = {
  venue: {
    id: 'h', name: 'h', origin: { lng: 121.5, lat: 25.1 }, bearing_deg: 0, default_level: '1F',
    levels: [{ id: '1F', ordinal: 0, name: '1F', elevation_m: 0 }, { id: '2F', ordinal: 1, name: '2F', elevation_m: 5 }],
  },
  levels: [
    { level: { id: '1F', ordinal: 0, name: '1F', elevation_m: 0 }, wallsLoaded: true, walls: [], walls3d: [], pois: [],
      units: [{ ...rect('1F-hall', '1F', 0, 0, 40, 30), properties: { id: '1F-hall', level: '1F', category: 'court' } }] },
    { level: { id: '2F', ordinal: 1, name: '2F', elevation_m: 5 }, wallsLoaded: true, walls: [], walls3d: [], pois: [],
      units: [rect('2F-s', '2F', 0, 0, 40, 3), rect('2F-n', '2F', 0, 27, 40, 30), rect('2F-w', '2F', 0, 0, 3, 30), rect('2F-e', '2F', 37, 0, 40, 30)] },
  ],
  nav: [node('1F-el', '1F', [1.5, 1.5]), node('2F-el', '2F', [1.5, 1.5]), edge('1F-el', '2F-el', [1.5, 1.5], [1.5, 1.5], 'elevator')],
  available: { walls: false, walls3d: false, units: true, pois: false, nav: true },
}
// the 1F court has (weak) fingerprints; the 2F ring hears the hall APs B well on its north AND south side
const C = ['00:11:22:00:00:0c', '00:11:22:00:00:1c', '00:11:22:00:00:2c']
const hallMap: Radiomap = {
  bssids: [...B, ...C],
  params: { likelihood_temper: 0.25 },
  points: [
    ...[5, 15, 25, 35].map((x) => fp('1F', x, Object.fromEntries(C.map((b, i) => [b, -70 - i * 5])))).map((p) => ({ ...p, y: 15 })),
    ...[10, 20, 30].flatMap((x) => [
      { ...fp('2F', x, Object.fromEntries(B.map((b, i) => [b, -50 - i * 6]))), id: `2F-n${x}`, y: 28.5 },
      { ...fp('2F', x, Object.fromEntries(B.map((b, i) => [b, -50 - i * 6]))), id: `2F-s${x}`, y: 1.5 },
    ]),
  ],
}

describe('floor void (2F has no floor over the 1F court)', () => {
  it('a 1F-court scan that WiFi-matches the 2F ring on both sides ends up on 1F, in the court', () => {
    const eng = createPositioning({ venueData: hall, radiomap: hallMap, options: { seed: 2 } })
    const changes: LevelChange[] = []
    eng.onLevelChange((c) => changes.push(c))
    // the court user hears the hall APs (B) strongly and the court APs (C) weakly: 2F matches ~1 dB better by WiFi
    const court = (t: number): WifiScan => {
      scanTs += 5_000_000
      return { supported: true, status: 'ok', collected_at: t, results: [
        ...B.map((bssid, i) => ({ bssid, ssid: 'x', level: -50 - i * 6, frequency: 2437, timestamp: scanTs })),
        ...C.map((bssid, i) => ({ bssid, ssid: 'x', level: -78 - i * 5, frequency: 2437, timestamp: scanTs })),
      ] }
    }
    for (let k = 0; k < 6; k++) eng.pushWifiScan(court(T0 + k * 8000))
    expect(eng.stats.level).toBe('1F')
    expect(changes.map((c) => [c.from, c.to])).toEqual([['2F', '1F']])
    // re-seeded where the 2F cloud's mean was: the middle of the court, not at a connector
    expect(eng.last!.level).toBe('1F')
    expect(eng.last!.y).toBeGreaterThan(8)
    expect(eng.last!.y).toBeLessThan(22)
  })

  it('a scan that matches only one side of the 2F ring stays on 2F (a 2F start remains possible)', () => {
    const north: Radiomap = { ...hallMap, points: hallMap.points.filter((p) => p.level === '1F' || p.y > 20) }
    const eng = createPositioning({ venueData: hall, radiomap: north, options: { seed: 2 } })
    for (let k = 0; k < 6; k++) eng.pushWifiScan(scanOf(B, T0 + k * 8000))
    expect(eng.stats.level).toBe('2F')
    expect(eng.last!.y).toBeGreaterThan(25)
    expect(eng.stats.floorVoidStreak).toBe(0)
  })

  it('no WiFi vote for 2F while the estimate is in the 1F court (under the void)', () => {
    const eng = createPositioning({ venueData: hall, radiomap: hallMap, options: { seed: 2 } })
    const changes: LevelChange[] = []
    eng.onLevelChange((c) => changes.push(c))
    eng.setKnownPosition(20, 15, '1F', { t: T0 })
    for (let k = 0; k < 6; k++) eng.pushWifiScan(scanOf(B, T0 + 1000 + k * 8000))
    expect(changes).toHaveLength(0)
    expect(eng.stats.level).toBe('1F')
  })

  // south side of the ring: 4 fingerprints with the hall APs B and the south APs S; north side: 1 with B and N
  const S = ['00:11:22:00:00:0e', '00:11:22:00:00:1e']
  const N = ['00:11:22:00:00:0f', '00:11:22:00:00:1f']
  const ringMap = (north: number[]): Radiomap => ({
    bssids: [...B, ...C, ...S, ...N],
    params: { likelihood_temper: 0.25 },
    points: [
      ...[5, 15, 25, 35].map((x) => ({ ...fp('1F', x, Object.fromEntries(C.map((b, i) => [b, -70 - i * 5]))), y: 15 })),
      ...[5, 15, 25, 35].map((x) => ({ ...fp('2F', x, { ...Object.fromEntries(B.map((b, i) => [b, -50 - i * 6])), [S[0]]: -60, [S[1]]: -66 }), id: `2F-s${x}`, y: 1.5 })),
      ...north.map((x) => ({ ...fp('2F', x, { ...Object.fromEntries(B.map((b, i) => [b, -50 - i * 6])), [N[0]]: -60, [N[1]]: -66 }), id: `2F-n${x}`, y: 28.5 })),
    ],
  })
  const scanWith = (t: number, aps: Record<string, number>): WifiScan => {
    scanTs += 5_000_000
    return { supported: true, status: 'ok', collected_at: t, results: Object.entries(aps).map(([bssid, level]) => ({ bssid, ssid: 'x', level, frequency: 2437, timestamp: scanTs })) }
  }
  const hallAps = Object.fromEntries(B.map((b, i) => [b, -50 - i * 6]))
  const onRing = (x: number, y: number) => y <= 4.5 || y >= 25.5 || x <= 4.5 || x >= 35.5

  it('A71 case: a broad (±40–50 m) 2F start cloud whose mean sits over the court near the south stand ends on 1F', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const eng = createPositioning({ venueData: hall, radiomap: ringMap([10, 20, 30]), options: { seed } })
      const ups: { level: string; x: number; y: number; acc: number }[] = []
      eng.onUpdate((u) => ups.push({ level: u.level, x: u.x, y: u.y, acc: u.accuracy_m }))
      // the court user hears the hall APs (B) and faintly the court APs: every 2F fingerprint matches about equally
      for (let k = 0; k < 4; k++) eng.pushWifiScan(scanWith(T0 + k * 8000, { ...hallAps, [C[0]]: -80, [C[1]]: -85 }))
      expect(eng.stats.level).toBe('1F')
      expect(ups.every((u) => u.level !== '2F' || onRing(u.x, u.y))).toBe(true)
      expect(ups.at(-1)!.level).toBe('1F')
    }
  })

  it('a genuine 2F user moved to 1F by a broad start cloud comes back up once WiFi clearly says 2F (on the ring)', () => {
    const eng = createPositioning({ venueData: hall, radiomap: ringMap([10, 20, 30]), options: { seed: 3 } })
    const changes: LevelChange[] = []
    eng.onLevelChange((c) => changes.push(c))
    eng.pushWifiScan(scanWith(T0, { ...hallAps, [C[0]]: -80 }))
    expect(eng.stats.level).toBe('1F')
    // then the south-stand APs: the 2F match is several dB better than 1F and its WkNN position is on the south ring
    for (let k = 1; k <= 3; k++) eng.pushWifiScan(scanWith(T0 + k * 8000, { ...hallAps, [S[0]]: -60, [S[1]]: -66 }))
    expect(changes.map((c) => [c.from, c.to])).toEqual([['2F', '1F'], ['1F', '2F']])
    expect(eng.stats.level).toBe('2F')
    expect(eng.last!.y).toBeLessThan(4.5)
  })

  it('property: no shown 2F position ever lies over the court (random scans, seeds, steps of the cloud)', () => {
    const rng = mulberry32(7)
    const pool = [...B, ...C, ...S, ...N]
    for (let run = 0; run < 25; run++) {
      const eng = createPositioning({ venueData: hall, radiomap: ringMap(run % 2 ? [10, 20, 30] : [20]), options: { seed: run + 1 } })
      let bad = 0
      eng.onUpdate((u) => { if (u.level === '2F' && !onRing(u.x, u.y)) bad++ })
      if (run % 3 === 0) eng.setKnownPosition(20, 1.5, '2F', { t: T0 })
      for (let k = 0; k < 8; k++) {
        const aps: Record<string, number> = {}
        for (const b of pool) if (rng() < 0.6) aps[b] = Math.round(-45 - rng() * 45)
        eng.pushWifiScan(scanWith(T0 + 1000 + k * 8000, aps))
      }
      expect(bad).toBe(0)
    }
  })
})
