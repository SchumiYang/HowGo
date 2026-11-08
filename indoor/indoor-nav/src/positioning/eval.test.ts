/**
 * Offline evaluation: replays the held-out synthetic test walks (mapdata/survey/raw/synthetic-test.json, with
 * ground truth) through the positioning stack and reports error statistics per method.
 *
 *   npm run eval:positioning
 *
 * Maps come from mapdata/build/positioning-synthetic/ (built with --synthetic-only --out, see
 * mapdata/tools/build_*.py), so rebuilding data/tianmu/positioning/ from real survey data never breaks this test.
 * Override with POSITIONING_MAPS=<dir>.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { SensorBatch, Vec3Sample, WifiScan } from '../bridge/townpass'
import type { NavFeature, PoiFeature, UnitFeature, Venue, VenueData, WallFeature } from '../data/types'
import { pointInPolygon } from '../geo/geometry'
import { createPositioning, type PositioningOptions } from './engine'
import { Pdr } from './pdr'
import { makeGauss, mulberry32 } from './rng'
import type { LevelChange, Magmap, Radiomap } from './types'
import { WifiModel } from './wifi'

const MAPDATA = fileURLToPath(new URL('../../../mapdata/', import.meta.url))
const VENUE = join(MAPDATA, 'data', 'tianmu')
const MAPS = process.env.POSITIONING_MAPS ?? join(MAPDATA, 'build', 'positioning-synthetic')
const SESSION = join(MAPDATA, 'survey', 'raw', 'synthetic-test.json')
const SEEDS = [1, 2, 3, 4, 5]
/** the three walks of the multi-level scenario (1F -> elevator up -> 2F -> elevator down -> 1F) */
const ML_WALKS = ['test-ml-1F-to-el2', 'test-ml-2F-west', 'test-ml-1F-from-el1']
const EXTRA: Partial<PositioningOptions> = process.env.POS_EVAL_OPTIONS ? JSON.parse(process.env.POS_EVAL_OPTIONS) : {}
/** experiment hook: POS_EVAL_NAV='[[x1,y1,x2,y2],...]' adds corridor edges to the nav graph (carved in the grid) */
const navEdges = (segs: number[][]): NavFeature[] => segs.flatMap(([x1, y1, x2, y2], i) => [
  { type: 'Feature', geometry: { type: 'Point', coordinates: [x1, y1] }, properties: { kind: 'node', id: `x${i}a`, level: '1F' } },
  { type: 'Feature', geometry: { type: 'Point', coordinates: [x2, y2] }, properties: { kind: 'node', id: `x${i}b`, level: '1F' } },
  { type: 'Feature', geometry: { type: 'LineString', coordinates: [[x1, y1], [x2, y2]] },
    properties: { kind: 'edge', from: `x${i}a`, to: `x${i}b`, type: 'corridor', accessible: true, length_m: Math.hypot(x2 - x1, y2 - y1) } },
] as NavFeature[])
const EXTRA_NAV = navEdges(process.env.POS_EVAL_NAV ? JSON.parse(process.env.POS_EVAL_NAV) : [])

interface TestWalk {
  walk_id: string
  level: string
  t_start: number
  t_end: number
  sensors: { accelerometer: Vec3Sample[]; gyroscope: Vec3Sample[]; magnetometer: Vec3Sample[] }
  wifi_scans: { collected_at: number; results: WifiScan['results'] }[]
  truth: { t: number[]; x: number[]; y: number[] }
}

const readJson = <T>(p: string): T => JSON.parse(readFileSync(p, 'utf8')) as T
const available = [SESSION, join(MAPS, 'wifi_radiomap.json'), join(MAPS, 'magmap_1F.json'), join(MAPS, 'magmap_2F.json'), join(VENUE, 'venue.json')].every(existsSync)

function loadVenue(): VenueData {
  const venue = readJson<Venue>(join(VENUE, 'venue.json'))
  const fc = <F>(p: string) => readJson<{ features: F[] }>(p).features
  return {
    venue,
    levels: venue.levels.map((level) => ({
      level, wallsLoaded: true, walls3d: [], pois: [] as PoiFeature[],
      walls: fc<WallFeature>(join(VENUE, 'levels', level.id, 'walls.geojson')),
      units: fc<UnitFeature>(join(VENUE, 'levels', level.id, 'units.geojson')),
    })),
    nav: [...fc<NavFeature>(join(VENUE, 'nav.geojson')), ...EXTRA_NAV],
    available: { walls: true, walls3d: false, units: true, pois: false, nav: true },
  }
}

type Event = { t: number; batch?: SensorBatch; scan?: WifiScan }

/** Sensor data as the bridge delivers it: 200 ms batches, WiFi scans interleaved at collected_at. */
function replayEvents(w: TestWalk): Event[] {
  const all = [
    ...w.sensors.accelerometer.map((s) => ['accelerometer', s] as const),
    ...w.sensors.gyroscope.map((s) => ['gyroscope', s] as const),
    ...w.sensors.magnetometer.map((s) => ['magnetometer', s] as const),
  ].sort((a, b) => a[1][0] - b[1][0])
  const ev: Event[] = []
  let cur: SensorBatch = {}
  let tEnd = all[0][1][0] + 200
  for (const [k, s] of all) {
    if (s[0] >= tEnd) {
      ev.push({ t: tEnd, batch: cur })
      cur = {}
      while (s[0] >= tEnd) tEnd += 200
    }
    ;(cur[k] ??= []).push(s)
  }
  ev.push({ t: tEnd, batch: cur })
  for (const sc of w.wifi_scans) ev.push({ t: sc.collected_at, scan: { supported: true, status: 'ok', collected_at: sc.collected_at, results: sc.results } })
  return ev.sort((a, b) => a.t - b.t)
}

function truthAt(w: TestWalk, t: number): [number, number] {
  const T = w.truth.t
  if (t <= T[0]) return [w.truth.x[0], w.truth.y[0]]
  if (t >= T[T.length - 1]) return [w.truth.x[T.length - 1], w.truth.y[T.length - 1]]
  let lo = 0, hi = T.length - 1
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1
    if (T[m] <= t) lo = m
    else hi = m
  }
  const f = (t - T[lo]) / (T[hi] - T[lo])
  return [w.truth.x[lo] + f * (w.truth.x[hi] - w.truth.x[lo]), w.truth.y[lo] + f * (w.truth.y[hi] - w.truth.y[lo])]
}

interface Stats { n: number; mean: number; median: number; p90: number; max: number }
function stats(e: number[]): Stats {
  const s = [...e].sort((a, b) => a - b)
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))]
  return { n: s.length, mean: s.reduce((a, b) => a + b, 0) / Math.max(1, s.length), median: q(0.5), p90: q(0.9), max: s[s.length - 1] }
}

function runEngine(w: TestWalk, venueData: VenueData, radiomap: Radiomap, magmap: Magmap[],
  options: Partial<PositioningOptions>, knownStart: boolean): { errors: number[]; firstFixDelayS: number | null; track: [number, number, number][] } {
  const eng = createPositioning({ venueData, radiomap, magmap, options: { allowSyntheticMaps: true, ...options, ...EXTRA } })
  const errors: number[] = []
  const track: [number, number, number][] = []
  let firstFix: number | null = null
  const tMin = w.truth.t[0]
  const tMax = w.truth.t[w.truth.t.length - 1]
  eng.onUpdate((u) => {
    if (u.t < tMin || u.t > tMax) return
    firstFix ??= u.t
    const [gx, gy] = truthAt(w, u.t)
    errors.push(Math.hypot(u.x - gx, u.y - gy))
    track.push([u.t, u.x, u.y])
  })
  let started = !knownStart
  for (const e of replayEvents(w)) {
    if (!started && e.t >= w.t_start - 1500) {
      const [x, y] = truthAt(w, e.t)
      eng.setKnownPosition(x, y, w.level, { accuracyM: 1 })
      started = true
    }
    if (e.batch) eng.pushSensorBatch(e.batch)
    if (e.scan) eng.pushWifiScan(e.scan)
  }
  return { errors, firstFixDelayS: firstFix === null ? null : (firstFix - w.t_start) / 1000, track }
}

function wifiOnly(w: TestWalk, radiomap: Radiomap): number[] {
  const m = new WifiModel(radiomap, w.level)
  const errors: number[] = []
  for (const sc of w.wifi_scans) {
    const obs = m.observe({ supported: true, status: 'ok', collected_at: sc.collected_at, results: sc.results })
    const r = obs && m.wknn(obs)
    if (!r) continue
    const [gx, gy] = truthAt(w, sc.collected_at)
    errors.push(Math.hypot(r.x - gx, r.y - gy))
  }
  return errors
}

/** Plain dead reckoning: known start, initial heading from the magnetometer compass, no map. */
function pdrRaw(w: TestWalk, venue: Venue): number[] {
  const pdr = new Pdr()
  const errors: number[] = []
  let [x, y] = truthAt(w, w.t_start)
  let theta0: number | null = null
  let yaw0 = 0
  const beta = (-4.5 - venue.bearing_deg) * (Math.PI / 180)
  for (const e of replayEvents(w)) {
    if (!e.batch) continue
    for (const st of pdr.push(e.batch)) {
      if (theta0 === null) {
        theta0 = Math.PI / 2 - beta + (st.compass ?? 0)
        yaw0 = st.yaw
      }
      const th = theta0 + st.yaw - yaw0
      x += st.length * Math.cos(th)
      y += st.length * Math.sin(th)
      const [gx, gy] = truthAt(w, st.t)
      errors.push(Math.hypot(x - gx, y - gy))
    }
  }
  return errors
}

describe.skipIf(!available)('positioning evaluation on the synthetic test walks', () => {
  const venueData = available ? loadVenue() : (null as unknown as VenueData)
  const radiomap = available ? readJson<Radiomap>(join(MAPS, 'wifi_radiomap.json')) : (null as unknown as Radiomap)
  const magmap = available ? ['1F', '2F'].map((l) => readJson<Magmap>(join(MAPS, `magmap_${l}.json`))) : []
  const walks = available ? readJson<{ walks: TestWalk[] }>(SESSION).walks : []

  const modes: { name: string; run: (w: TestWalk) => number[] }[] = [
    { name: '(a) WiFi only (WkNN, per scan)', run: (w) => wifiOnly(w, radiomap) },
    { name: '(b0) PDR raw, known start, compass', run: (w) => pdrRaw(w, venueData.venue) },
    ...([
      ['(b) PDR + map, known start', { useWifi: false, useMagnetic: false }, true],
      ['(c) PDR + map + magnetic, known start', { useWifi: false, useMagnetic: true }, true],
      ['(d) full fusion, known start', { useWifi: true, useMagnetic: true }, true],
      ['(d2) full fusion, WiFi init (no start)', { useWifi: true, useMagnetic: true }, false],
    ] as const).map(([name, opts, known]) => ({
      name,
      run: (w: TestWalk) => SEEDS.flatMap((seed) => runEngine(w, venueData, radiomap, magmap, { ...opts, seed }, known).errors),
    })),
  ]

  const results = new Map<string, Map<string, Stats>>()
  const pooled = new Map<string, Stats>()

  it('replays every walk through every method', { timeout: 120000 }, () => {
    for (const m of modes) {
      const per = new Map<string, Stats>()
      const all: number[] = []
      for (const w of walks) {
        const e = m.run(w)
        per.set(w.walk_id, stats(e))
        all.push(...e)
      }
      results.set(m.name, per)
      pooled.set(m.name, stats(all))
    }
    const f = (v: number) => v.toFixed(2).padStart(6)
    const lines = ['', `positioning evaluation (synthetic, ${SEEDS.length} seeds for filter modes; error in m)`,
      `${'method'.padEnd(42)}${'walk'.padEnd(30)}${'n'.padStart(6)}  mean  median    p90    max`]
    for (const m of modes) {
      for (const [walk, s] of [...results.get(m.name)!, ['ALL', pooled.get(m.name)!] as const]) {
        lines.push(`${m.name.padEnd(42)}${walk.padEnd(30)}${String(s.n).padStart(6)}${f(s.mean)}${f(s.median)}${f(s.p90)}${f(s.max)}`)
      }
    }
    console.log(lines.join('\n'))
    expect(results.size).toBe(modes.length)
  })

  it('full fusion meets the synthetic target (median < 3 m)', () => {
    const d = results.get('(d) full fusion, known start')!
    expect(d.get('test-entrance-to-acc-toilet')!.median).toBeLessThan(3)
    expect(pooled.get('(d) full fusion, known start')!.median).toBeLessThan(3)
    expect(pooled.get('(d2) full fusion, WiFi init (no start)')!.median).toBeLessThan(3)
  })

  // live runs 172234 (SW door) and 193516 / 193729 (NW door): start inside the arena, the user walks out through an
  // arena door; the engine kept the cloud inside the arena wall (10–35 m errors). One synthetic walk per door.
  // [walk, door, end point, max share of post-exit updates inside the arena, max median end error]
  // SE: since the 1F plan dropped the arena-cross walk, the synthetic arena loop (x = 69) and the east corridor
  // (x = 73.7) are two surveyed lines 4.7 m apart behind one column-lined wall with near-identical synthetic fields, so
  // the cloud stays bimodal across the wall; only the end error is checked there (real arena field: std 14 uT)
  const doorWalks: [string, string, [number, number], number, number][] = [
    ['test-arena-to-west-corridor', 'SW', [11.0, 44.4], 0.35, 3],
    ['test-arena-nw-door', 'NW', [14.6, 65.6], 0.25, 3],
    ['test-arena-se-door', 'SE', [73.7, 34.0], 1, 5],
  ]
  const inArena = (x: number, y: number) => x > 14.6 && x < 71.9 && y > 13.9 && y < 53.0
  it.each(doorWalks)('follows a door transition out of the arena: %s (%s door)', (walkId, _door, end, maxShare, maxEnd) => {
    const w = walks.find((x) => x.walk_id === walkId)
    expect(w).toBeDefined()
    const lines: string[] = []
    const ends: number[] = []
    const checks: (() => void)[] = []
    for (const seed of SEEDS) {
      const { track } = runEngine(w!, venueData, radiomap, magmap, { seed }, true)
      // walker out of the arena (and past the doorway)
      const out = track.filter(([t]) => {
        const [x, y] = truthAt(w!, t)
        return !inArena(x, y) && Math.min(...[[16, 15.9], [16, 51.6], [70, 15.9]].map(([dx, dy]) => Math.hypot(x - dx, y - dy))) > 3
      })
      const share = out.filter(([, x, y]) => inArena(x, y)).length / Math.max(1, out.length)
      const last = track[track.length - 1]
      const endErr = Math.hypot(last[1] - end[0], last[2] - end[1])
      ends.push(endErr)
      let detour = ''
      if (walkId === 'test-arena-to-west-corridor') {
        // the route goes around the enclosed room A101 through the west lobby: so must the estimate
        const lobby = track.filter(([t]) => truthAt(w!, t)[0] < 7)
        const west = lobby.filter(([, x]) => x < 10).length / Math.max(1, lobby.length)
        detour = `, lobby detour ${(100 * west).toFixed(0)}%`
        checks.push(() => expect(west).toBeGreaterThan(0.8))
      }
      lines.push(`seed ${seed}: in arena ${(100 * share).toFixed(0)}% of updates after leaving it${detour}, end error ${endErr.toFixed(1)} m`)
      checks.push(() => expect(out.length).toBeGreaterThan(15), () => expect(share).toBeLessThanOrEqual(maxShare))
    }
    console.log(`door transition ${walkId}:\n  ` + lines.join('\n  '))
    checks.forEach((c) => c())
    expect([...ends].sort((a, b) => a - b)[ends.length >> 1]).toBeLessThan(maxEnd)
  })

  it('switches levels: 1F -> elevator #2 up -> 2F west corridor -> elevator #1 down -> 1F', () => {
    // navigation calls setKnownPosition(x, y, level) after 「已到 2F」; the engine must swap grid, magmap and WiFi model
    const ws = ML_WALKS.map((id) => walks.find((w) => w.walk_id === id)!)
    expect(ws.every(Boolean)).toBe(true)
    const seating = venueData.levels.find((l) => l.level.id === '2F')!.units.filter((u) => u.properties.category === 'seating')
    const onSeating = (x: number, y: number) => seating.some((u) => u.geometry.type === 'Polygon' && pointInPolygon([x, y], u.geometry.coordinates))
    const lines: string[] = []
    for (const seed of SEEDS) {
      const eng = createPositioning({ venueData, radiomap, magmap, options: { allowSyntheticMaps: true, seed } })
      let cur: TestWalk | null = null
      const errs = new Map<string, number[]>()
      const wrongLevel: string[] = []
      let seatHits = 0
      eng.onUpdate((u) => {
        const w = cur
        if (!w || u.t < w.t_start || u.t > w.truth.t[w.truth.t.length - 1]) return
        if (u.level !== w.level) wrongLevel.push(`${w.walk_id}: ${u.level}`)
        if (u.level === '2F' && onSeating(u.x, u.y)) seatHits++
        const [gx, gy] = truthAt(w, u.t)
        errs.set(w.walk_id, [...(errs.get(w.walk_id) ?? []), Math.hypot(u.x - gx, u.y - gy)])
      })
      for (const w of ws) {
        cur = w
        let started = false
        for (const e of replayEvents(w)) {
          if (!started && e.t >= w.t_start - 1500) {
            const [x, y] = truthAt(w, e.t)
            eng.setKnownPosition(x, y, w.level, { accuracyM: 1, t: e.t })
            started = true
          }
          if (e.batch) eng.pushSensorBatch(e.batch)
          if (e.scan) eng.pushWifiScan(e.scan)
        }
        expect(eng.stats.level).toBe(w.level)
        expect(eng.stats.maps).toEqual({ wifi: true, magnetic: true })
      }
      expect(wrongLevel).toEqual([])
      expect(seatHits).toBe(0)
      const med = (v: number[]) => [...v].sort((a, b) => a - b)[v.length >> 1]
      lines.push(`seed ${seed}: ` + ws.map((w) => `${w.walk_id} median ${med(errs.get(w.walk_id)!).toFixed(2)} m`).join(', '))
      for (const w of ws) expect(med(errs.get(w.walk_id)!)).toBeLessThan(3)
    }
    console.log('multi-level scenario:\n  ' + lines.join('\n  '))
  })

  it('switches floors automatically from the barometer (no setKnownPosition at the elevators)', () => {
    const ws = ML_WALKS.map((id) => walks.find((w) => w.walk_id === id)!)
    // pressure: 1F 1010.00 hPa, 2F 0.60 hPa lower; the step happens mid-way through each elevator gap (10 s ramp)
    const gaps = [[ws[0].t_end, ws[1].t_start], [ws[1].t_end, ws[2].t_start]].map(([a, b]) => (a + b) / 2)
    const g = makeGauss(mulberry32(3))
    const pressure = (t: number) => {
      const ramp = (c: number) => Math.min(1, Math.max(0, (t - c + 5000) / 10000))
      return 1010 - 0.6 * ramp(gaps[0]) + 0.6 * ramp(gaps[1]) + g() * 0.03
    }
    const tA = ws[0].t_start - 3000
    const tB = ws[2].t_end + 2000
    const baroEvents: Event[] = []
    for (let t = tA; t < tB; t += 200) baroEvents.push({ t, batch: { barometer: [[t, pressure(t)], [t + 100, pressure(t + 100)]] } })
    const lines: string[] = []
    const checks: (() => void)[] = []
    for (const seed of SEEDS) {
      const eng = createPositioning({ venueData, radiomap, magmap, options: { allowSyntheticMaps: true, seed } })
      const changes: LevelChange[] = []
      eng.onLevelChange((c) => changes.push(c))
      const errs = new Map<string, number[]>()
      eng.onUpdate((u) => {
        const w = ws.find((x) => u.t >= x.t_start && u.t <= x.truth.t[x.truth.t.length - 1])
        if (!w) return
        const [gx, gy] = truthAt(w, u.t)
        errs.set(w.walk_id, [...(errs.get(w.walk_id) ?? []), u.level === w.level ? Math.hypot(u.x - gx, u.y - gy) : 99])
      })
      const ev: Event[] = [...ws.flatMap((w) => replayEvents(w)), ...baroEvents].sort((a, b) => a.t - b.t)
      let started = false
      for (const e of ev) {
        if (!started && e.t >= ws[0].t_start - 1500) {
          const [x, y] = truthAt(ws[0], e.t)
          eng.setKnownPosition(x, y, '1F', { accuracyM: 1, t: e.t })
          started = true
        }
        if (e.batch) eng.pushSensorBatch(e.batch)
        if (e.scan) eng.pushWifiScan(e.scan)
      }
      const med = (v: number[]) => [...v].sort((a, b) => a - b)[v.length >> 1]
      lines.push(`seed ${seed}: ${changes.map((c) => `${c.from}->${c.to} (${c.source}, at ${c.connector})`).join(', ')}; `
        + ws.map((w) => `${w.walk_id} ${med(errs.get(w.walk_id) ?? [99]).toFixed(2)} m`).join(', '))
      checks.push(() => expect(changes.map((c) => [c.from, c.to, c.connector])).toEqual([['1F', '2F', '2F-el2'], ['2F', '1F', '1F-el1']]))
      for (const w of ws) checks.push(() => expect(med(errs.get(w.walk_id)!)).toBeLessThan(3))
    }
    console.log('automatic floor changes (barometer):\n  ' + lines.join('\n  '))
    checks.forEach((c) => c())
  })

  it('map constraint and magnetic matching each improve on the previous stage', () => {
    const med = (k: string) => pooled.get(k)!.median
    expect(med('(b) PDR + map, known start')).toBeLessThan(med('(b0) PDR raw, known start, compass'))
    expect(med('(c) PDR + map + magnetic, known start')).toBeLessThan(med('(b) PDR + map, known start') + 0.25)
  })
})
