/**
 * Replays the live validation runs that carry raw sensor data (mapdata/survey/eval/*.json) through the current
 * engine and maps (all levels, as the app loads them), and compares with what the app reported live. Runs recorded
 * with the barometer (since 2026-11-08) replay it too; floor changes and checkpoints on the wrong floor are listed.
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

const med = (v: number[]) => [...v].sort((a, b) => a - b)[v.length >> 1]
const p90 = (v: number[]) => [...v].sort((a, b) => a - b)[Math.min(v.length - 1, Math.floor(0.9 * v.length))]
const SEEDS = [1, 2, 3, 4, 5]

describe.skipIf(!available)('replay of live validation runs', () => {
  it('replays every run with raw data', { timeout: 600000 }, () => {
    const venueData = loadVenue()
    const radiomap = readJson<Radiomap>(join(VENUE, 'positioning', 'wifi_radiomap.json'))
    const magmap = readdirSync(join(VENUE, 'positioning')).filter((f) => /^magmap_.+\.json$/.test(f))
      .map((f) => readJson<Magmap>(join(VENUE, 'positioning', f)))
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
      if (!dec) {
        const all = rs.flatMap((x) => x!.checkpoints)
        const wrong = all.filter((c) => c.estimate_level !== null && c.estimate_level !== c.level).length
        const baro = run.raw?.sensors?.barometer?.length ?? 0
        const changes = rs.map((x) => x!.levelChanges.map((c) => `${c.from}->${c.to} ${c.source}${c.connector ? ` @${c.connector}` : ''}`).join(', ') || 'none')
        lines.push(`    floor: ${wrong}/${all.length} checkpoints on the wrong floor; barometer ${baro ? `${baro} samples` : 'not recorded'}`
          + `${run.raw?.unavailable?.length ? ` (unavailable: ${run.raw.unavailable.join(', ')})` : ''}; changes per seed: ${[...new Set(changes)].join(' | ')}`)
      }
      if (process.env.POS_EVAL_VERBOSE) {
        for (const c of r.checkpoints) lines.push(`    t=${((c.t - r.track[0].t) / 1000).toFixed(0).padStart(4)} truth=(${c.truth.map((v) => v.toFixed(1)).join(',')}) est=(${c.estimate?.map((v) => v.toFixed(1)).join(',')}) err=${c.error_m?.toFixed(1)} acc=${c.accuracy_m}`)
      }
    }
    // regression (2026-11-08 Pixel, 2F corner lobby -> corner passage -> front walkway): the 2F magnetic map matched
    // at 3 uT pulled the cloud off the passage into the west lobby (live 10.9 / 12.4 m, replays failed 7 of 20 seeds)
    const px = jobs.find(([r, d]) => r.run_id === '20261108-111925-pixel9a' && !d)?.[0]
    if (px) {
      const errs = SEEDS.flatMap((seed) => replayRun(px, venueData, { radiomap, magmap }, { seed, ...EXTRA })!.checkpoints.map((c) => c.error_m!))
      lines.push(`regression 20261108-111925-pixel9a (2F corner passage): checkpoint error median ${med(errs).toFixed(1)} m, max ${Math.max(...errs).toFixed(1)} m`)
      if (!Object.keys(EXTRA).length) {
        expect(med(errs)).toBeLessThan(3)
        expect(Math.max(...errs)).toBeLessThan(8)
      }
    }
    if (hits.length) lines.push(`replay: ${((100 * hits.reduce((a, b) => a + b, 0)) / hits.length).toFixed(0)}% of checkpoint errors within accuracy_m (target ~68%)`)
    if (Object.keys(EXTRA).length) lines.push(`options override: ${JSON.stringify(EXTRA)}`)
    console.log(lines.join('\n'))
    expect(n).toBeGreaterThan(0)
  })
})
