/**
 * Replays the live validation runs that carry raw sensor data (mapdata/survey/eval/*.json) through the current
 * engine and maps, and compares with what the app reported live.
 *
 *   npm run eval:positioning        (runs under --mode eval only)
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { NavFeature, PoiFeature, UnitFeature, Venue, VenueData, WallFeature } from '../data/types'
import type { PositioningOptions } from './engine'
import { replayRun, type EvalRun } from './replay'
import type { Magmap, Radiomap } from './types'

const MAPDATA = fileURLToPath(new URL('../../../mapdata/', import.meta.url))
const VENUE = join(MAPDATA, 'data', 'tianmu')
const EVAL = join(MAPDATA, 'survey', 'eval')
const EXTRA: Partial<PositioningOptions> = process.env.POS_EVAL_OPTIONS ? JSON.parse(process.env.POS_EVAL_OPTIONS) : {}
const available = import.meta.env.MODE === 'eval' && existsSync(EVAL)
const readJson = <T>(p: string): T => JSON.parse(readFileSync(p, 'utf8')) as T

function loadVenue(): VenueData {
  const venue = readJson<Venue>(join(VENUE, 'venue.json'))
  const fc = <F>(p: string) => readJson<{ features: F[] }>(p).features
  const level = venue.levels.find((l) => l.id === '1F')!
  return {
    venue,
    levels: [{
      level, wallsLoaded: true, walls3d: [], pois: [] as PoiFeature[],
      walls: fc<WallFeature>(join(VENUE, 'levels', '1F', 'walls.geojson')),
      units: fc<UnitFeature>(join(VENUE, 'levels', '1F', 'units.geojson')),
    }],
    nav: fc<NavFeature>(join(VENUE, 'nav.geojson')),
    available: { walls: true, walls3d: false, units: true, pois: false, nav: true },
  }
}

const med = (v: number[]) => [...v].sort((a, b) => a - b)[v.length >> 1]
const p90 = (v: number[]) => [...v].sort((a, b) => a - b)[Math.min(v.length - 1, Math.floor(0.9 * v.length))]
const SEEDS = [1, 2, 3, 4, 5]

describe.skipIf(!available)('replay of live validation runs', () => {
  it('replays every run with raw data', { timeout: 600000 }, () => {
    const venueData = loadVenue()
    const radiomap = readJson<Radiomap>(join(VENUE, 'positioning', 'wifi_radiomap.json'))
    const magmap = readJson<Magmap>(join(VENUE, 'positioning', 'magmap_1F.json'))
    const lines = ['', 'live runs: live (as recorded) vs replay (current engine + maps, 5 seeds pooled); checkpoint error m, median / p90 / max, and share within accuracy_m']
    let n = 0
    const hits: number[] = []
    // power saving (A71 battery saver, run 193516): gyroscope + magnetometer ~20 Hz, accelerometer ~65 Hz
    const powerSave = { accelerometer: 65, gyroscope: 20, magnetometer: 20 }
    const jobs = readdirSync(EVAL).filter((f) => f.endsWith('.json')).sort().flatMap((f) => {
      const run = readJson<EvalRun>(join(EVAL, f))
      const android = /sma716b|pixel/i.test(run.run_id)
      return [[run, undefined], ...(android ? [[run, powerSave]] : [])] as [EvalRun, typeof powerSave | undefined][]
    })
    for (const [run, dec] of jobs) {
      // the particle filter is stochastic: pool 5 seeds (single seeds differ by several metres at the tail)
      const rs = SEEDS.map((seed) => replayRun(run, venueData, { radiomap, magmap }, { seed, ...EXTRA }, { decimate: dec }))
      const r = rs[0]
      if (!r) continue
      n++
      const live = run.checkpoints.filter((c) => c.error_m != null)
      const liveIn = live.filter((c) => c.error_m! <= (c.accuracy_m ?? 0)).length
      const rep = rs.flatMap((x) => x!.checkpoints).filter((c) => c.error_m != null)
      const repIn = rep.filter((c) => c.error_m! <= c.accuracy_m!).length
      if (!dec) rep.forEach((c) => hits.push(c.error_m! <= c.accuracy_m! ? 1 : 0))
      const fmt = (e: number[]) => (e.length ? `${med(e).toFixed(1).padStart(5)} / ${p90(e).toFixed(1).padStart(5)} / ${Math.max(...e).toFixed(1).padStart(5)}` : '    - /     - /     -')
      lines.push(`${(run.run_id + (dec ? ' @20Hz' : '')).padEnd(32)} ${String(run.device?.model ?? '').padEnd(9)} n=${String(rep.length).padStart(2)}  live ${fmt(live.map((c) => c.error_m!))} (${liveIn}/${live.length} in acc)`
        + `   replay ${fmt(rep.map((c) => c.error_m!))} (${repIn}/${rep.length} in acc)`)
      if (process.env.POS_EVAL_VERBOSE) {
        for (const c of r.checkpoints) lines.push(`    t=${((c.t - r.track[0].t) / 1000).toFixed(0).padStart(4)} truth=(${c.truth.map((v) => v.toFixed(1)).join(',')}) est=(${c.estimate?.map((v) => v.toFixed(1)).join(',')}) err=${c.error_m?.toFixed(1)} acc=${c.accuracy_m}`)
      }
    }
    if (hits.length) lines.push(`replay: ${((100 * hits.reduce((a, b) => a + b, 0)) / hits.length).toFixed(0)}% of checkpoint errors within accuracy_m (target ~68%)`)
    if (Object.keys(EXTRA).length) lines.push(`options override: ${JSON.stringify(EXTRA)}`)
    console.log(lines.join('\n'))
    expect(n).toBeGreaterThan(0)
  })
})
