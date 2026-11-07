/** Validation-run math: ground truth along a recorded walk, error statistics, snapping. Pure functions. */
import type { XY } from '../../geo/frame'

export interface TruthWalk {
  path: XY[]
  t_start: number
  t_end: number
  marks?: { t: number; vertex: number }[]
}

/**
 * Position on a survey walk at time t (SURVEY_SCHEMA.md §2): linear in arc length between the anchors
 * t_start (s = 0), each mark (s = arc length of its vertex) and t_end (s = L). Clamped outside [t_start, t_end].
 */
export function truthAt(w: TruthWalk, t: number): XY {
  const cum = [0]
  for (let i = 1; i < w.path.length; i++) cum.push(cum[i - 1] + Math.hypot(w.path[i][0] - w.path[i - 1][0], w.path[i][1] - w.path[i - 1][1]))
  const L = cum[cum.length - 1]
  const anchors: [number, number][] = [[w.t_start, 0]]
  for (const m of [...(w.marks ?? [])].sort((a, b) => a.t - b.t)) {
    if (m.vertex > 0 && m.vertex < w.path.length && m.t > anchors[anchors.length - 1][0] && m.t < w.t_end) anchors.push([m.t, cum[m.vertex]])
  }
  anchors.push([w.t_end, L])
  let s: number
  if (t <= anchors[0][0]) s = 0
  else if (t >= anchors[anchors.length - 1][0]) s = L
  else {
    let i = 1
    while (anchors[i][0] < t) i++
    const [t0, s0] = anchors[i - 1]
    const [t1, s1] = anchors[i]
    s = t1 > t0 ? s0 + ((s1 - s0) * (t - t0)) / (t1 - t0) : s1
  }
  return pointAtArc(w.path, cum, s)
}

function pointAtArc(path: XY[], cum: number[], s: number): XY {
  if (path.length === 1) return [path[0][0], path[0][1]]
  for (let i = 1; i < path.length; i++) {
    if (s <= cum[i] || i === path.length - 1) {
      const seg = cum[i] - cum[i - 1]
      const f = seg > 0 ? Math.min(1, Math.max(0, (s - cum[i - 1]) / seg)) : 0
      return [path[i - 1][0] + (path[i][0] - path[i - 1][0]) * f, path[i - 1][1] + (path[i][1] - path[i - 1][1]) * f]
    }
  }
  return [path[path.length - 1][0], path[path.length - 1][1]]
}

/** heading of the first segment, degrees clockwise from local +y */
export function initialHeading(path: XY[]): number | null {
  if (path.length < 2) return null
  const dx = path[1][0] - path[0][0]
  const dy = path[1][1] - path[0][1]
  return ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360
}

export interface ErrorStats { n: number; median_m: number | null; p90_m: number | null; max_m: number | null }

/** nearest-rank percentiles (same as error_summary in HowGo backend/rollx/indoor.py) */
export function errorStats(errors: (number | null | undefined)[]): ErrorStats {
  const e = errors.filter((v): v is number => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b)
  const pct = (q: number) => (e.length ? e[Math.min(e.length - 1, Math.max(0, Math.ceil(q * e.length) - 1))] : null)
  return { n: e.length, median_m: pct(0.5), p90_m: pct(0.9), max_m: e.length ? e[e.length - 1] : null }
}

export const dist = (a: XY, b: XY) => Math.hypot(a[0] - b[0], a[1] - b[1])

/** Snap to the nearest candidate within maxD (survey points / nav nodes are surveyed, known spots). */
export function snap(p: XY, candidates: { id: string; xy: XY }[], maxD: number): { xy: XY; id: string | null } {
  let best: { id: string; xy: XY } | null = null
  let bd = maxD
  for (const c of candidates) {
    const d = dist(p, c.xy)
    if (d <= bd) (bd = d), (best = c)
  }
  return best ? { xy: [best.xy[0], best.xy[1]], id: best.id } : { xy: p, id: null }
}

/** `20261107-1700-pixel9a` */
export function runId(now: Date, model: string | null | undefined): string {
  const p = (n: number) => String(n).padStart(2, '0')
  const tag = (model ?? 'web').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12) || 'web'
  return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}-${tag}`
}
