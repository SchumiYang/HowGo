/**
 * Leave-one-walk-out evaluation on the REAL survey walks (no ground-truth test walk exists).
 *
 *   cd mapdata && py -3.12 -I tools/eval_lowo_maps.py     # maps without each walk -> mapdata/build/lowo/
 *   cd indoor-nav && npm run eval:positioning
 *
 * Each held-out walk is replayed through the engine with maps built from all other walks; the reference is the
 * walk's reconstructed track (step-proportional, gyro-corner-anchored, see mapdata/tools/walktrack.py), itself
 * good to roughly 1–2 m; it shares the walk's own step detection, so PDR-driven results are somewhat optimistic.
 * Runs only with `--mode eval` and when mapdata/build/lowo/index.json exists.
 * POS_EVAL_OPTIONS='{"mag":{"sigmaB":4}}' overrides engine options for experiments.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { SensorBatch, Vec3Sample, WifiScan } from '../bridge/townpass'
import type { NavFeature, PoiFeature, UnitFeature, Venue, VenueData, WallFeature } from '../data/types'
import { createPositioning, type PositioningOptions } from './engine'
import type { Magmap, Radiomap } from './types'
import { WifiModel } from './wifi'

const MAPDATA = fileURLToPath(new URL('../../../mapdata/', import.meta.url))
const VENUE = join(MAPDATA, 'data', 'tianmu')
const LOWO = process.env.POS_LOWO_DIR ?? join(MAPDATA, 'build', 'lowo')
const SEEDS = [1, 2, 3]
const EXTRA: Partial<PositioningOptions> = process.env.POS_EVAL_OPTIONS ? JSON.parse(process.env.POS_EVAL_OPTIONS) : {}

interface Walk {
  walk_id: string
  direction: string
  path: [number, number][]
  t_start: number
  t_end: number
  sensors: { accelerometer: Vec3Sample[]; gyroscope: Vec3Sample[]; magnetometer: Vec3Sample[] }
  wifi_scans?: { collected_at: number; results: WifiScan['results'] }[]
}
interface Track { t: number[]; x: number[]; y: number[]; area: string; level?: string }
interface Entry { key: string; dir: string; session_file: string; area: string }

const readJson = <T>(p: string): T => JSON.parse(readFileSync(p, 'utf8')) as T
// slow (~1 min): only under `npm run eval:positioning` (vitest --mode eval), not in the regular `npm test`
const available = import.meta.env.MODE === 'eval' && existsSync(join(LOWO, 'index.json'))

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
    nav: fc<NavFeature>(join(VENUE, 'nav.geojson')),
    available: { walls: true, walls3d: false, units: true, pois: false, nav: true },
  }
}

const sessions = new Map<string, { session_id: string; walks: Walk[] }>()
function findWalk(e: Entry): Walk {
  let s = sessions.get(e.session_file)
  if (!s) {
    s = readJson<{ session_id: string; walks: Walk[] }>(join(MAPDATA, e.session_file))
    sessions.set(e.session_file, s)
  }
  const [, walkId, direction, n] = e.key.split('|')
  return s.walks.filter((w) => w.walk_id === walkId && (w.direction ?? 'forward') === direction)[Number(n)]
}

type Event = { t: number; batch?: SensorBatch; scan?: WifiScan }
/** per update of the current method: 1 if the error was within the reported accuracy_m (calibration) */
let calib: number[] = []
/** per engine run of the current method: 1 if it ended on the wrong floor after automatic level changes */
let switches: number[] = []
function replayEvents(w: Walk): Event[] {
  const lo = w.t_start - 3000
  const hi = w.t_end
  const all = (['accelerometer', 'gyroscope', 'magnetometer'] as const)
    .flatMap((k) => (w.sensors[k] ?? []).filter((s) => s[0] >= lo && s[0] <= hi).map((s) => [k, s] as const))
    .sort((a, b) => a[1][0] - b[1][0])
  const ev: Event[] = []
  let cur: SensorBatch = {}
  let tEnd = (all[0]?.[1][0] ?? lo) + 200
  for (const [k, s] of all) {
    if (s[0] >= tEnd) {
      ev.push({ t: tEnd, batch: cur })
      cur = {}
      while (s[0] >= tEnd) tEnd += 200
    }
    ;(cur[k] ??= []).push(s)
  }
  ev.push({ t: tEnd, batch: cur })
  for (const sc of w.wifi_scans ?? []) {
    if (sc.collected_at >= lo && sc.collected_at <= hi + 1000) ev.push({ t: sc.collected_at, scan: { supported: true, status: 'ok', collected_at: sc.collected_at, results: sc.results } })
  }
  return ev.sort((a, b) => a.t - b.t)
}

function at(tr: Track, t: number): [number, number] {
  const T = tr.t
  let lo = 0, hi = T.length - 1
  if (t <= T[0]) return [tr.x[0], tr.y[0]]
  if (t >= T[hi]) return [tr.x[hi], tr.y[hi]]
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1
    if (T[m] <= t) lo = m
    else hi = m
  }
  const f = (t - T[lo]) / (T[hi] - T[lo])
  return [tr.x[lo] + f * (tr.x[hi] - tr.x[lo]), tr.y[lo] + f * (tr.y[hi] - tr.y[lo])]
}

interface Stats { n: number; median: number; p90: number; mean: number }
function stats(e: number[]): Stats {
  const s = [...e].sort((a, b) => a - b)
  const q = (p: number) => (s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN)
  return { n: s.length, median: q(0.5), p90: q(0.9), mean: s.reduce((a, b) => a + b, 0) / Math.max(1, s.length) }
}

function runEngine(w: Walk, tr: Track, venueData: VenueData, radiomap: Radiomap | null, magmap: Magmap[],
  options: Partial<PositioningOptions>, knownStart: boolean, withHeading = true, seedLevel = tr.level ?? '1F'): number[] {
  const eng = createPositioning({ venueData, radiomap, magmap, options: { ...options, ...EXTRA, mag: { ...options.mag, ...EXTRA.mag } } })
  const errors: number[] = []
  eng.onUpdate((u) => {
    if (u.t < w.t_start || u.t > w.t_end) return
    const [x, y] = at(tr, u.t)
    const err = Math.hypot(u.x - x, u.y - y)
    errors.push(err)
    calib.push(err <= u.accuracy_m ? 1 : 0)
  })
  let started = !knownStart
  for (const e of replayEvents(w)) {
    if (!started && e.t >= w.t_start - 1500) {
      const [x, y] = at(tr, w.t_start)
      const [a, b] = w.path
      const headingDeg = (Math.atan2(b[0] - a[0], b[1] - a[1]) * 180) / Math.PI
      eng.setKnownPosition(x, y, seedLevel, { accuracyM: 1.5, headingDeg: withHeading ? headingDeg : null })
      started = true
    }
    if (e.batch) eng.pushSensorBatch(e.batch)
    if (e.scan) eng.pushWifiScan(e.scan)
  }
  switches.push(eng.stats.level === (tr.level ?? '1F') ? 0 : 1)
  return errors
}

function wifiOnly(w: Walk, tr: Track, radiomap: Radiomap | null): number[] {
  if (!radiomap) return []
  const m = new WifiModel(radiomap, tr.level ?? '1F', EXTRA.wifi)
  const out: number[] = []
  for (const sc of w.wifi_scans ?? []) {
    if (sc.collected_at < w.t_start || sc.collected_at > w.t_end) continue
    const obs = m.observe({ supported: true, status: 'ok', collected_at: sc.collected_at, results: sc.results })
    const r = obs && m.wknn(obs)
    if (!r) continue
    const [x, y] = at(tr, sc.collected_at)
    out.push(Math.hypot(r.x - x, r.y - y))
  }
  return out
}

/** Maps with all coverage near the walk's route removed: how the engine behaves where nobody surveyed (1F east). */
function withoutRoute(w: Walk, level: string, r: Radiomap | null, ms: Magmap[]): [Radiomap | null, Magmap[]] {
  const d = (x: number, y: number) => {
    let best = Infinity
    for (let i = 1; i < w.path.length; i++) {
      const [ax, ay] = w.path[i - 1]
      const [bx, by] = w.path[i]
      const l2 = (bx - ax) ** 2 + (by - ay) ** 2 || 1e-9
      const t = Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / l2))
      best = Math.min(best, Math.hypot(x - ax - t * (bx - ax), y - ay - t * (by - ay)))
    }
    return best
  }
  return [
    r && { ...r, points: r.points.filter((p) => (p.level ?? '1F') !== level || d(p.x, p.y) > 4) },
    ms.map((m) => (m.level === level ? { ...m, cells: m.cells.filter((c) => d(c.x, c.y) > 2.5) } : m)),
  ]
}

describe.skipIf(!available)('positioning evaluation on real walks (leave-one-walk-out)', () => {
  it('replays every held-out walk', { timeout: 600000 }, () => {
    const venueData = loadVenue()
    const index = readJson<Entry[]>(join(LOWO, 'index.json'))
    const tracks = readJson<Record<string, Track>>(join(LOWO, 'walk_tracks.json'))
    const methods: [string, (w: Walk, tr: Track, r: Radiomap | null, m: Magmap[]) => number[]][] = [
      ['(a) WiFi only (WkNN per scan)', (w, tr, r) => wifiOnly(w, tr, r)],
      ...([
        ['(b) PDR + map, known start + heading', { useWifi: false, useMagnetic: false }, true],
        ['(c) PDR + map + magnetic, known start', { useWifi: false, useMagnetic: true }, true],
        ['(d) full fusion, known start', { useWifi: true, useMagnetic: true }, true],
        ['(d1) WiFi + PDR + map (no magnetic)', { useWifi: true, useMagnetic: false }, true],
        ['(d2) full fusion, WiFi init, no start', { useWifi: true, useMagnetic: true }, false],
        ['(d3) full fusion, known start, no heading', { useWifi: true, useMagnetic: true }, true, false],
      ] as const).map(([name, opts, known, heading]) => [name, (w: Walk, tr: Track, r: Radiomap | null, m: Magmap[]) =>
        SEEDS.flatMap((seed) => runEngine(w, tr, venueData, r, m, { ...opts, seed }, known, heading ?? true))] as [string, (w: Walk, tr: Track, r: Radiomap | null, m: Magmap[]) => number[]]),
      ['(e) full fusion, route NOT in the maps', (w, tr, r, m) => {
        const [r2, m2] = withoutRoute(w, tr.level ?? '1F', r, m)
        return SEEDS.flatMap((seed) => runEngine(w, tr, venueData, r2, m2, { seed }, true))
      }],
    ]
    const errs = new Map<string, Map<string, number[]>>()
    const cover = new Map<string, number[]>()
    const falseSwitches = new Map<string, number>()
    const areaOf = (tr: Track) => `${tr.level ?? '1F'} ${tr.area}`
    const levelLines: string[] = []
    const perWalk: string[] = []
    const vote = { n: new Map<string, number>(), ok: new Map<string, number>(), margins: new Map<string, number[]>(), streaks: new Map<string, number>() }
    for (const e of index) {
      const w = findWalk(e)
      const tr = tracks[e.key]
      if (!w || !tr) continue
      const dir = join(LOWO, e.dir)
      const radiomap = existsSync(join(dir, 'wifi_radiomap.json')) ? readJson<Radiomap>(join(dir, 'wifi_radiomap.json')) : null
      const magmap = readdirSync(dir).filter((f) => /^magmap_.+\.json$/.test(f)).map((f) => readJson<Magmap>(join(dir, f)))
      const level = tr.level ?? '1F'
      for (const [name, run] of methods) {
        const per = errs.get(name) ?? new Map<string, number[]>()
        errs.set(name, per)
        calib = []
        switches = []
        const v = run(w, tr, radiomap, magmap)
        const c = cover.get(name) ?? []
        cover.set(name, c)
        c.push(...calib)
        falseSwitches.set(name, (falseSwitches.get(name) ?? 0) + switches.reduce((a, b) => a + b, 0))
        for (const area of [areaOf(tr), 'ALL']) per.set(area, [...(per.get(area) ?? []), ...v])
      }
      if (level !== '1F') {
        const q = (v: number[], p: number) => [...v].sort((a, b) => a - b)[Math.min(v.length - 1, Math.floor(p * v.length))]
        const pb = SEEDS.flatMap((seed) => runEngine(w, tr, venueData, radiomap, magmap, { useWifi: false, useMagnetic: false, seed }, true))
        const pd = SEEDS.flatMap((seed) => runEngine(w, tr, venueData, radiomap, magmap, { seed }, true))
        perWalk.push(`  ${e.key.split('|').slice(1).join('|').padEnd(32)} ${e.key.split('|')[0].slice(-7).padEnd(8)} `
          + `(b) ${q(pb, 0.5).toFixed(1)} / ${q(pb, 0.9).toFixed(1)}   (d) ${q(pd, 0.5).toFixed(1)} / ${q(pd, 0.9).toFixed(1)}`)
      }
      // WiFi level classification per fresh scan (held-out maps): best WkNN distance per level
      if (radiomap) {
        const levels = [...new Set(radiomap.points.map((p) => p.level ?? '1F'))]
        const models = new Map(levels.map((l) => [l, new WifiModel(radiomap, l, { ...EXTRA.wifi, adaptOffset: false })]))
        let streak = 0
        for (const sc of w.wifi_scans ?? []) {
          const scan = { supported: true, status: 'ok', collected_at: sc.collected_at, results: sc.results }
          const d = new Map<string, number>()
          for (const [l, m] of models) {
            const obs = m.observe(scan)
            const r = obs && m.wknn(obs)
            if (r) d.set(l, r.dist)
          }
          if (!d.size) continue
          const own = d.get(level) ?? Infinity
          const other = Math.min(...[...d].filter(([l]) => l !== level).map(([, v]) => v), Infinity)
          vote.n.set(level, (vote.n.get(level) ?? 0) + 1)
          if (own < other) vote.ok.set(level, (vote.ok.get(level) ?? 0) + 1)
          if (Number.isFinite(other) && Number.isFinite(own)) vote.margins.set(level, [...(vote.margins.get(level) ?? []), other - own])
          // the engine's WiFi-only trigger: another level better by >= 4 dB on 2 consecutive scans
          streak = own - other >= 4 ? streak + 1 : 0
          if (streak >= 2) vote.streaks.set(level, (vote.streaks.get(level) ?? 0) + 1)
        }
      }
      // a 2F walk with the engine wrongly on 1F (seeded at the right x/y), and with no seed at all
      if (level !== '1F' && radiomap) {
        const eng = createPositioning({ venueData, radiomap, magmap, options: { seed: 1, ...EXTRA } })
        let first: string | null = null
        const changes: string[] = []
        eng.onLevelChange((c) => changes.push(`${c.from}->${c.to} ${c.source} after ${((c.t - w.t_start) / 1000).toFixed(0)} s at ${c.connector}`))
        let started = false
        for (const ev of replayEvents(w)) {
          if (!started && ev.t >= w.t_start - 1500) {
            const [x, y] = at(tr, w.t_start)
            eng.setKnownPosition(x, y, '1F', { accuracyM: 1.5 })
            started = true
          }
          if (ev.batch) eng.pushSensorBatch(ev.batch)
          if (ev.scan) eng.pushWifiScan(ev.scan)
        }
        const noSeed = createPositioning({ venueData, radiomap, magmap, options: { seed: 1, ...EXTRA } })
        noSeed.onUpdate((u) => (first ??= u.level))
        for (const ev of replayEvents(w)) {
          if (ev.batch) noSeed.pushSensorBatch(ev.batch)
          if (ev.scan) noSeed.pushWifiScan(ev.scan)
        }
        levelLines.push(`  ${e.key.split('|').slice(1).join('|').padEnd(32)} seeded on 1F: ${changes.join(', ') || 'stayed on 1F'}`
          + ` (vote ${JSON.stringify(eng.stats.wifiLevelVote?.dist ?? {}, (_k, v) => (typeof v === 'number' ? Math.round(v * 10) / 10 : v))});`
          + ` no seed: started on ${first ?? '-'}`)
      }
    }
    const f = (v: number) => (Number.isFinite(v) ? v.toFixed(2) : '-').padStart(7)
    const lines = ['', `real-data leave-one-walk-out (${index.length} walks, ${SEEDS.length} seeds; error in m vs reconstructed track)`,
      `${'method'.padEnd(42)}${'area'.padEnd(11)}${'n'.padStart(7)}${'median'.padStart(7)}${'p90'.padStart(7)}${'mean'.padStart(7)}`]
    const areas = [...new Set(index.map((e) => (tracks[e.key] ? areaOf(tracks[e.key]) : '')).filter(Boolean))].sort()
    for (const [name, per] of errs) {
      for (const area of [...areas, 'ALL']) {
        const s = stats(per.get(area) ?? [])
        lines.push(`${name.padEnd(42)}${area.padEnd(11)}${String(s.n).padStart(7)}${f(s.median)}${f(s.p90)}${f(s.mean)}`)
      }
    }
    lines.push('runs ending on the wrong floor (automatic level changes; walks are single-floor): '
      + [...falseSwitches].map(([k, v]) => `${k.split(' ')[0]} ${v}`).join(', '))
    lines.push('WiFi level classification per fresh scan (held-out maps; margin = other level − own level, dB):')
    for (const [l, n] of vote.n) {
      const m = [...(vote.margins.get(l) ?? [])].sort((a, b) => a - b)
      lines.push(`  on ${l}: own level best in ${vote.ok.get(l) ?? 0}/${n} scans, margin median ${m.length ? m[m.length >> 1].toFixed(1) : '-'}`
        + ` p10 ${m.length ? m[Math.floor(m.length * 0.1)].toFixed(1) : '-'}; WiFi-only switch trigger (>= 4 dB, 2 scans) met ${vote.streaks.get(l) ?? 0} times`)
    }
    if (levelLines.length) lines.push('2F walks with the engine on the wrong floor / without a seed:', ...levelLines)
    if (perWalk.length) lines.push('per walk, (b) PDR + map / (d) full fusion, known start: median / p90 m', ...perWalk)
    lines.push('accuracy_m calibration (share of errors within the reported accuracy_m; ~68% is honest):')
    for (const [name, c] of cover) if (c.length) lines.push(`  ${name.padEnd(42)}${((100 * c.reduce((a, b) => a + b, 0)) / c.length).toFixed(0).padStart(4)}%`)
    if (Object.keys(EXTRA).length) lines.push(`options override: ${JSON.stringify(EXTRA)}`)
    console.log(lines.join('\n'))
    expect(errs.size).toBe(methods.length)
  })
})
