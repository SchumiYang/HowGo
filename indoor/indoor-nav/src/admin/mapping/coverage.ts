/** Survey coverage: which corridors have been walked / have magnetic or WiFi data. Pure functions. */
import type { XY } from '../../geo/frame'
import { pointInPolygon, projectOnSegment } from '../../geo/geometry'
import type { NavFeature, UnitFeature } from '../../data/types'

/** distance from p to a polyline */
export function distToPolyline(p: XY, line: XY[]): number {
  if (line.length === 1) return Math.hypot(p[0] - line[0][0], p[1] - line[0][1])
  let d = Infinity
  for (let i = 1; i < line.length; i++) d = Math.min(d, projectOnSegment(p, line[i - 1], line[i]).d)
  return d
}

/** Spatial hash of points for fast "any point within r" queries. */
export class PointIndex {
  private cells = new Map<string, XY[]>()
  private readonly size: number
  constructor(points: XY[], size: number) {
    this.size = size
    for (const p of points) {
      const k = this.key(p[0], p[1])
      let c = this.cells.get(k)
      if (!c) this.cells.set(k, (c = []))
      c.push(p)
    }
  }
  private key(x: number, y: number) {
    return `${Math.floor(x / this.size)},${Math.floor(y / this.size)}`
  }
  anyWithin(p: XY, r: number): boolean {
    const cx = Math.floor(p[0] / this.size)
    const cy = Math.floor(p[1] / this.size)
    const n = Math.ceil(r / this.size)
    for (let i = cx - n; i <= cx + n; i++) {
      for (let j = cy - n; j <= cy + n; j++) {
        for (const q of this.cells.get(`${i},${j}`) ?? []) if (Math.hypot(q[0] - p[0], q[1] - p[1]) <= r) return true
      }
    }
    return false
  }
}

const COVERAGE_EDGE_TYPES = new Set(['corridor', 'ramp'])
/** open areas crossed by routing edges that nobody walks as a survey line */
const OPEN_AREAS = new Set(['court', 'seating'])

/**
 * Corridor edges of a level as polylines (nav edges carry no level; it comes from their nodes). Edges whose
 * midpoint lies in an open area (court, seating) are skipped when `units` are given.
 */
export function corridorEdges(nav: NavFeature[], level: string, units: UnitFeature[] = []): { id: string; coords: XY[] }[] {
  const open = units.filter((u) => OPEN_AREAS.has(u.properties.category) && u.geometry)
  const inOpen = (p: XY) => open.some((u) => (u.geometry.type === 'Polygon' ? [u.geometry.coordinates] : u.geometry.coordinates).some((rings) => pointInPolygon(p, rings)))
  const nodeLevel = new Map<string, string>()
  for (const f of nav) if (f.geometry?.type === 'Point' && f.properties.kind === 'node') nodeLevel.set(f.properties.id, f.properties.level)
  const out: { id: string; coords: XY[] }[] = []
  for (const f of nav) {
    if (f.geometry?.type !== 'LineString' || f.properties.kind !== 'edge') continue
    const p = f.properties
    if (!COVERAGE_EDGE_TYPES.has(p.type) || nodeLevel.get(p.from) !== level) continue
    const c = f.geometry.coordinates as XY[]
    if (open.length && inOpen([(c[0][0] + c[c.length - 1][0]) / 2, (c[0][1] + c[c.length - 1][1]) / 2])) continue
    out.push({ id: `${p.from}~${p.to}`, coords: f.geometry.coordinates as XY[] })
  }
  return out
}

/**
 * Parts of corridor edges farther than `radius` from every walked line and every data point (magmap cells,
 * fingerprints). Edges are sampled every `step` m; consecutive uncovered samples form a run, runs shorter than
 * `minLen` are dropped.
 */
export function uncoveredRuns(edges: { coords: XY[] }[], walked: XY[][], dataPoints: XY[], opts: { radius?: number; step?: number; minLen?: number } = {}): XY[][] {
  const radius = opts.radius ?? 3
  const step = opts.step ?? 1
  const minLen = opts.minLen ?? 2
  const idx = new PointIndex(dataPoints, Math.max(radius, 1))
  const covered = (p: XY) => idx.anyWithin(p, radius) || walked.some((l) => l.length && distToPolyline(p, l) <= radius)
  const runs: XY[][] = []
  for (const e of edges) {
    let run: XY[] = []
    const flush = () => {
      let len = 0
      for (let i = 1; i < run.length; i++) len += Math.hypot(run[i][0] - run[i - 1][0], run[i][1] - run[i - 1][1])
      if (run.length >= 2 && len >= minLen) runs.push(run)
      run = []
    }
    for (let i = 1; i < e.coords.length; i++) {
      const a = e.coords[i - 1]
      const b = e.coords[i]
      const L = Math.hypot(b[0] - a[0], b[1] - a[1])
      const n = Math.max(1, Math.ceil(L / step))
      for (let k = i === 1 ? 0 : 1; k <= n; k++) {
        const p: XY = [a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]
        if (covered(p)) flush()
        else run.push(p)
      }
    }
    flush()
  }
  return runs
}

export const runLength = (r: XY[]) => r.reduce((s, p, i) => (i ? s + Math.hypot(p[0] - r[i - 1][0], p[1] - r[i - 1][1]) : 0), 0)
