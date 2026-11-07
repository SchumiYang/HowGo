/**
 * Exact replay of a live validation run (mapdata/survey/eval/<run_id>.json, ADMIN_API.md "Validation run") through
 * the engine: raw sensor samples (barometer included, when recorded) in 200 ms batches, WiFi scans at collected_at,
 * every 設為已知位置 seed at its time. At each checkpoint the estimate is the last engine update at or before it —
 * what the app showed. A run without seeds replays as a WiFi-only start (the engine picks the floor).
 */
import type { BaroSample, SensorBatch, Vec3Sample, WifiScan } from '../bridge/townpass'
import type { VenueData } from '../data/types'
import { createPositioning, type PositioningOptions } from './engine'
import type { LevelChange, Magmap, PositionUpdate, Radiomap } from './types'

export interface EvalSeed { t: number; level: string; x: number; y: number; heading_deg: number | null; accuracy_m?: number }
export interface EvalCheckpoint { t: number; level: string; truth: [number, number]; estimate?: [number, number] | null; accuracy_m?: number; error_m?: number }
export interface EvalRun {
  run_id: string
  device?: { model?: string }
  engine?: { options?: { useWifi?: boolean; useMagnetic?: boolean } }
  checkpoints: EvalCheckpoint[]
  seed?: EvalSeed
  seeds?: EvalSeed[]
  started_at?: number
  raw?: {
    /** barometer: [t, hPa], recorded since 2026-11-08 (older runs have none) */
    sensors?: { accelerometer?: Vec3Sample[]; gyroscope?: Vec3Sample[]; magnetometer?: Vec3Sample[]; barometer?: BaroSample[]; magnetometer_accuracy?: [number, number][] }
    wifi_scans?: { collected_at: number; results: WifiScan['results'] }[]
    /** sensors the bridge reported unavailable (e.g. barometer on the A71) */
    unavailable?: string[]
  }
}

export interface ReplayCheckpoint {
  t: number
  truth: [number, number]
  estimate: [number, number] | null
  accuracy_m: number | null
  error_m: number | null
  /** checkpoint (truth) level and the level the engine was on */
  level: string
  estimate_level: string | null
}
export interface ReplayResult { checkpoints: ReplayCheckpoint[]; track: PositionUpdate[]; levelChanges: LevelChange[]; clockShiftMs: number }

const hasRaw = (run: EvalRun) => !!run.raw?.sensors?.accelerometer?.length

/** keep at most one sample per 1000/hz ms (simulates a phone in power-saving mode) */
function decimate(v: Vec3Sample[], hz: number | undefined): Vec3Sample[] {
  if (!hz) return v
  const dt = 1000 / hz
  const out: Vec3Sample[] = []
  let next = -Infinity
  for (const x of v) {
    if (x[0] < next) continue
    out.push(x)
    next = x[0] + dt
  }
  return out
}

export interface ReplayOptions {
  /** resample the recorded sensors down to these rates (Hz), e.g. power saving: { accelerometer: 65, gyroscope: 20, magnetometer: 20 } */
  decimate?: { accelerometer?: number; gyroscope?: number; magnetometer?: number }
}

export function replayRun(run: EvalRun, venueData: VenueData, maps: { radiomap: Radiomap | null; magmap: Magmap | Magmap[] | null },
  options: Partial<PositioningOptions> = {}, replay: ReplayOptions = {}): ReplayResult | null {
  if (!hasRaw(run)) return null
  const seeds = [...(run.seeds?.length ? run.seeds : run.seed ? [run.seed] : [])].sort((a, b) => a.t - b.t)
  if (!seeds.length && !run.started_at) return null
  const eo = run.engine?.options ?? {}
  const eng = createPositioning({
    venueData, radiomap: maps.radiomap, magmap: maps.magmap,
    options: { useWifi: eo.useWifi ?? true, useMagnetic: eo.useMagnetic ?? true, ...options },
  })
  const track: PositionUpdate[] = []
  const levelChanges: LevelChange[] = []
  eng.onUpdate((u) => track.push(u))
  eng.onLevelChange((c) => levelChanges.push(c))

  // samples from before the run (stale bridge buffers) are dropped
  const t0 = Math.min(run.started_at ?? Infinity, seeds[0]?.t ?? Infinity) - 3000
  const s = run.raw!.sensors!
  // a sensor clock off the wall clock (iOS bridge, 2026-11-07: 217 s behind) shows as samples that end long before
  // the last checkpoint; the live engine corrects it from batch arrival times, here the first sample is aligned
  // with started_at
  const acc = s.accelerometer!
  const lastCp = Math.max(...run.checkpoints.map((c) => c.t))
  const shift = acc[acc.length - 1][0] < lastCp - 10000 && run.started_at ? run.started_at - acc[0][0] : 0
  const all = (['accelerometer', 'gyroscope', 'magnetometer'] as const)
    .flatMap((k) => decimate((s[k] ?? []).map((v) => [v[0] + shift, v[1], v[2], v[3]] as Vec3Sample).filter((v) => v[0] >= t0), replay.decimate?.[k])
      .map((v) => [k, v] as const))
    .sort((a, b) => a[1][0] - b[1][0])
  const baro = (s.barometer ?? []).map((v) => [v[0] + shift, v[1]] as BaroSample).filter((v) => v[0] >= t0)
  type Ev = { t: number; batch?: SensorBatch; scan?: WifiScan; seed?: EvalSeed }
  const ev: Ev[] = []
  let cur: SensorBatch = {}
  let tEnd = (all[0]?.[1][0] ?? t0) + 200
  for (const [k, v] of all) {
    if (v[0] >= tEnd) {
      ev.push({ t: tEnd, batch: cur })
      cur = {}
      while (v[0] >= tEnd) tEnd += 200
    }
    ;(cur[k] ??= []).push(v)
  }
  ev.push({ t: tEnd, batch: cur })
  // barometer samples (~1 Hz iOS, up to 25 Hz Android) go in at their own time, between the 200 ms IMU batches
  for (const v of baro) ev.push({ t: v[0], batch: { barometer: [v] } })
  // what the bridge said it could not deliver (the engine marks the barometer as missing)
  if (run.raw!.unavailable?.length) ev.push({ t: t0, batch: { unavailable: run.raw!.unavailable } })
  for (const sc of run.raw!.wifi_scans ?? []) {
    if (sc.collected_at >= t0) ev.push({ t: sc.collected_at, scan: { supported: true, status: 'ok', collected_at: sc.collected_at, results: sc.results } })
  }
  for (const sd of seeds) ev.push({ t: sd.t, seed: sd })
  ev.sort((a, b) => a.t - b.t || (a.seed ? -1 : 0))
  for (const e of ev) {
    if (e.seed) eng.setKnownPosition(e.seed.x, e.seed.y, e.seed.level, { accuracyM: e.seed.accuracy_m ?? 1, headingDeg: e.seed.heading_deg, t: e.seed.t })
    if (e.batch) eng.pushSensorBatch(e.batch)
    if (e.scan) eng.pushWifiScan(e.scan)
  }

  const checkpoints = run.checkpoints.map((c): ReplayCheckpoint => {
    let last: PositionUpdate | null = null
    for (const u of track) {
      if (u.t > c.t) break
      last = u
    }
    return {
      t: c.t, truth: c.truth,
      estimate: last ? [last.x, last.y] : null,
      accuracy_m: last ? last.accuracy_m : null,
      error_m: last ? Math.hypot(last.x - c.truth[0], last.y - c.truth[1]) : null,
      level: c.level, estimate_level: last?.level ?? null,
    }
  })
  return { checkpoints, track, levelChanges, clockShiftMs: shift }
}
