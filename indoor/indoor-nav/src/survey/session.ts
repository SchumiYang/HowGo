/**
 * Survey session assembly (pure, no DOM). Produces the `tpnav-survey/0` contract of
 * mapdata/SURVEY_SCHEMA.md §2.
 */
import type { Vec3Sample, WifiResult, WifiScan } from '../bridge/townpass'

export type XY = [number, number]
export type Direction = 'forward' | 'reverse'
export type PhonePose = 'flat' | 'upright'

export interface ScanRecord {
  collected_at: number
  results: WifiResult[]
}

export interface WifiPointRecord {
  point_id: string | null
  level: string
  x: number
  y: number
  scans: ScanRecord[]
}

export interface WalkRecord {
  walk_id: string
  level: string
  direction: Direction
  path: XY[]
  t_start: number
  t_end: number
  marks: { t: number; vertex: number }[]
  phone_pose: PhonePose
  sensors: { accelerometer: Vec3Sample[]; gyroscope: Vec3Sample[]; magnetometer: Vec3Sample[] }
  wifi_scans: ScanRecord[]
}

export interface DeviceRecord {
  model: string | null
  platform: string
  user_agent: string
  info?: Record<string, unknown>
}

export interface Session {
  schema: 'tpnav-survey/0'
  session_id: string
  venue: string
  device: DeviceRecord
  started_at: number
  wifi_points: WifiPointRecord[]
  walks: WalkRecord[]
}

// ---------- plan ----------

export interface PlanPoint { id: string; level: string; xy: XY }
export interface PlanWalk { id: string; level: string; name: string; length_m: number; coords: XY[] }
export interface Plan { points: PlanPoint[]; walks: PlanWalk[] }

interface PlanFeature {
  geometry?: { type: string; coordinates: unknown }
  properties?: Record<string, unknown>
}

export function parsePlan(fc: { features?: PlanFeature[] } | null, level?: string): Plan {
  const plan: Plan = { points: [], walks: [] }
  for (const f of fc?.features ?? []) {
    const p = f.properties ?? {}
    if (level && p.level !== level) continue
    if (p.kind === 'point' && f.geometry?.type === 'Point') {
      plan.points.push({ id: String(p.id), level: String(p.level), xy: f.geometry.coordinates as XY })
    } else if (p.kind === 'walk' && f.geometry?.type === 'LineString') {
      plan.walks.push({
        id: String(p.id), level: String(p.level), name: String(p.name ?? p.id),
        length_m: Number(p.length_m ?? 0), coords: f.geometry.coordinates as XY[],
      })
    }
  }
  return plan
}

// ---------- session ----------

const pad = (n: number, w = 2) => String(n).padStart(w, '0')

/** Short device tag for the session id: `a71` for SM-A71xx, else a sanitized model prefix. */
export function deviceTag(model: string | null): string {
  if (!model) return 'web'
  const m = /\bSM-([A-Z])(\d{2})/i.exec(model)
  if (m) return (m[1] + m[2]).toLowerCase()
  return model.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8) || 'web'
}

/** `20261107-142530-a71` (local time). */
export function makeSessionId(now: Date, model: string | null): string {
  const d = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
  const t = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  return `${d}-${t}-${deviceTag(model)}`
}

/** Model from an Android UA: `(Linux; Android 13; SM-A716B Build/...; wv)`. Reduced UAs give `K` -> null. */
export function modelFromUserAgent(ua: string): string | null {
  const m = /Android [\d.]+; ([^;)]+?)(?: Build\/[^;)]*)?[;)]/.exec(ua)
  const model = m?.[1]?.trim()
  return model && model !== 'K' ? model : null
}

export function newSession(venue: string, device: DeviceRecord, now = new Date()): Session {
  return {
    schema: 'tpnav-survey/0',
    session_id: makeSessionId(now, device.model),
    venue,
    device,
    started_at: now.getTime(),
    wifi_points: [],
    walks: [],
  }
}

// ---------- wifi freshness ----------

/** Newest AP timestamp (µs since boot) in a scan, or null if no result carries one. */
export function newestApTimestamp(scan: Pick<WifiScan, 'results'>): number | null {
  let best: number | null = null
  for (const r of scan.results ?? []) {
    if (typeof r.timestamp === 'number' && (best === null || r.timestamp > best)) best = r.timestamp
  }
  return best
}

export type ScanVerdict = 'fresh' | 'throttled' | 'stale' | 'empty'

/**
 * A scan is fresh when the OS actually started a scan (`scan_started`, absent on stream messages)
 * and its newest AP timestamp is newer than the previous accepted scan's. Without timestamps
 * (some devices) any started, non-empty scan is accepted.
 */
export function classifyScan(scan: WifiScan, prevNewest: number | null): ScanVerdict {
  if (scan.scan_started === false) return 'throttled'
  if (!scan.results?.length) return 'empty'
  const newest = newestApTimestamp(scan)
  if (newest !== null && prevNewest !== null && newest <= prevNewest) return 'stale'
  return 'fresh'
}

export const toScanRecord = (scan: WifiScan): ScanRecord => ({ collected_at: scan.collected_at, results: scan.results })

// ---------- walks ----------

export function walkPath(coords: XY[], direction: Direction): XY[] {
  const path = coords.map((c) => [c[0], c[1]] as XY)
  return direction === 'reverse' ? path.reverse() : path
}

export function buildWalk(args: {
  walk: PlanWalk
  direction: Direction
  pose: PhonePose
  t_start: number
  t_end: number
  marks: { t: number; vertex: number }[]
  sensors: WalkRecord['sensors']
  wifi_scans: ScanRecord[]
}): WalkRecord {
  return {
    walk_id: args.walk.id,
    level: args.walk.level,
    direction: args.direction,
    path: walkPath(args.walk.coords, args.direction),
    t_start: args.t_start,
    t_end: args.t_end,
    marks: args.marks,
    phone_pose: args.pose,
    sensors: args.sensors,
    wifi_scans: args.wifi_scans,
  }
}

export interface TurnVertex {
  /** index into the walking-order path (what `marks[].vertex` refers to) */
  index: number
  xy: XY
  turn: 'left' | 'right'
  deg: number
}

/**
 * Interior vertices of a walking-order path where the direction changes by at least `minDeg` — the corners
 * a surveyor actually notices. Straight-through vertices (plan nodes on a straight corridor) are skipped, so a
 * 「經過轉角」 tap is anchored to the right vertex.
 */
export function turnVertices(path: XY[], minDeg = 20): TurnVertex[] {
  const out: TurnVertex[] = []
  for (let i = 1; i < path.length - 1; i++) {
    const [a, b, c] = [path[i - 1], path[i], path[i + 1]]
    const h1 = Math.atan2(b[1] - a[1], b[0] - a[0])
    const h2 = Math.atan2(c[1] - b[1], c[0] - b[0])
    let d = ((h2 - h1) * 180) / Math.PI
    d = ((d + 540) % 360) - 180 // -180..180, positive = counter-clockwise = left (local +x east, +y north)
    if (Math.abs(d) >= minDeg) out.push({ index: i, xy: b, turn: d > 0 ? 'left' : 'right', deg: Math.abs(d) })
  }
  return out
}

/** 「東北角」-style name of a point relative to a bbox centre (local frame is north-up: +y north, +x east). */
export function compassName(xy: XY, bbox: [number, number, number, number]): string {
  const [x0, y0, x1, y1] = bbox
  const fx = (xy[0] - x0) / Math.max(1e-6, x1 - x0)
  const fy = (xy[1] - y0) / Math.max(1e-6, y1 - y0)
  const ns = fy > 0.62 ? '北' : fy < 0.38 ? '南' : ''
  const ew = fx > 0.62 ? '東' : fx < 0.38 ? '西' : ''
  return ns || ew ? `${ew && ns ? ew + ns : ew || ns}${ew && ns ? '角' : '側'}` : '中央'
}

// ---------- progress ----------

export function scansPerPoint(s: Session): Map<string, number> {
  const m = new Map<string, number>()
  for (const p of s.wifi_points) if (p.point_id) m.set(p.point_id, (m.get(p.point_id) ?? 0) + p.scans.length)
  return m
}

export const walkKey = (id: string, d: Direction) => `${id}|${d}`

export function doneWalks(s: Session): Set<string> {
  return new Set(s.walks.map((w) => walkKey(w.walk_id, w.direction)))
}

export function progress(plan: Plan, s: Session) {
  const spp = scansPerPoint(s)
  const dw = doneWalks(s)
  return {
    pointsDone: plan.points.filter((p) => (spp.get(p.id) ?? 0) > 0).length,
    pointsTotal: plan.points.length,
    walksDone: plan.walks.reduce((n, w) => n + (dw.has(walkKey(w.id, 'forward')) ? 1 : 0) + (dw.has(walkKey(w.id, 'reverse')) ? 1 : 0), 0),
    walksTotal: plan.walks.length * 2,
  }
}

/** Nearest plan point with no scans, measured from `from`; null when all are done. */
export function nearestUndone(plan: Plan, s: Session, from: XY, exclude?: string): PlanPoint | null {
  const spp = scansPerPoint(s)
  let best: PlanPoint | null = null
  let bd = Infinity
  for (const p of plan.points) {
    if (p.id === exclude || (spp.get(p.id) ?? 0) > 0) continue
    const d = Math.hypot(p.xy[0] - from[0], p.xy[1] - from[1])
    if (d < bd) (bd = d), (best = p)
  }
  return best
}

export function nearestPoint(plan: Plan, from: XY): PlanPoint | null {
  let best: PlanPoint | null = null
  let bd = Infinity
  for (const p of plan.points) {
    const d = Math.hypot(p.xy[0] - from[0], p.xy[1] - from[1])
    if (d < bd) (bd = d), (best = p)
  }
  return best
}

// ---------- validation (mirrors validate_session in HowGo backend/rollx/indoor.py) ----------

export const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,80}$/

export function validateSession(s: unknown): string | null {
  if (!s || typeof s !== 'object') return 'not an object'
  const o = s as Record<string, unknown>
  if (o.schema !== 'tpnav-survey/0') return 'bad schema'
  if (typeof o.session_id !== 'string' || !SESSION_ID_RE.test(o.session_id)) return 'bad session_id'
  if (typeof o.venue !== 'string') return 'bad venue'
  if (typeof o.started_at !== 'number') return 'bad started_at'
  if (!o.device || typeof o.device !== 'object') return 'bad device'
  if (!Array.isArray(o.wifi_points) || !Array.isArray(o.walks)) return 'missing wifi_points / walks'
  for (const p of o.wifi_points as WifiPointRecord[]) {
    if (typeof p.x !== 'number' || typeof p.y !== 'number' || typeof p.level !== 'string' || !Array.isArray(p.scans)) return 'bad wifi point'
  }
  for (const w of o.walks as WalkRecord[]) {
    if (typeof w.walk_id !== 'string' || (w.direction !== 'forward' && w.direction !== 'reverse')) return 'bad walk'
    if (!Array.isArray(w.path) || w.path.length < 2 || !(w.t_end >= w.t_start)) return 'bad walk path/time'
    if (!w.sensors || !Array.isArray(w.sensors.magnetometer)) return 'bad walk sensors'
  }
  return null
}

export function sampleCount(s: Session): number {
  let n = 0
  for (const w of s.walks) n += w.sensors.accelerometer.length + w.sensors.gyroscope.length + w.sensors.magnetometer.length
  return n
}
