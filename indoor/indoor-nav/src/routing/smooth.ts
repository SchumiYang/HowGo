/**
 * Any-angle route smoothing ("string pulling"). The nav graph (e.g. the arena's 6.4 m node grid)
 * makes routes zig-zag along grid edges; this greedily drops intermediate vertices while the
 * direct segment stays in walkable area and crosses no wall / column linework.
 *
 * Kept vertices: the start and end, floor changes, and doorways (a node whose arriving and leaving
 * route edges are both door / ramp, i.e. the point in the door opening).
 */
import type { XY } from '../geo/frame'
import { dist, pointInPolygon } from '../geo/geometry'
import type { UnitFeature, WallFeature } from '../data/types'
import type { Step } from './instructions'
import type { Route, RoutePoint } from './route'

/** unit categories a straight leg may cross */
export const WALKABLE_CATEGORIES = new Set(['corridor', 'lobby', 'walkway', 'court'])
const WALL_LAYERS = new Set(['wall', 'column'])
const CELL_M = 2
/** sample spacing for the walkable-area test (m) */
const SAMPLE_M = 0.5
/** samples this close to a leg's ends may lie outside units (doorways sit in wall gaps) */
const END_SLACK_M = 0.8
const DOORISH = new Set(['door', 'ramp'])

type Seg = [XY, XY]

/** Walls (segment grid) and walkable units of one level, for segment-clearance tests. */
export class LevelGeometry {
  private grid = new Map<string, Seg[]>()
  private walkable: XY[][][] = []
  private units: { rings: XY[][]; walkable: boolean }[] = []

  constructor(units: UnitFeature[], walls: WallFeature[]) {
    for (const u of units) {
      const g = u.geometry
      const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates
      const ok = WALKABLE_CATEGORIES.has(u.properties.category)
      for (const rings of polys) {
        this.units.push({ rings, walkable: ok })
        if (ok) this.walkable.push(rings)
      }
    }
    for (const w of walls) {
      if (!WALL_LAYERS.has(w.properties?.layer)) continue
      const c = w.geometry.coordinates
      for (let i = 1; i < c.length; i++) this.addSeg([c[i - 1], c[i]])
    }
  }

  private key(ix: number, iy: number) {
    return `${ix},${iy}`
  }

  private addSeg(s: Seg) {
    const [x0, x1] = [Math.min(s[0][0], s[1][0]), Math.max(s[0][0], s[1][0])]
    const [y0, y1] = [Math.min(s[0][1], s[1][1]), Math.max(s[0][1], s[1][1])]
    for (let ix = Math.floor(x0 / CELL_M); ix <= Math.floor(x1 / CELL_M); ix++) {
      for (let iy = Math.floor(y0 / CELL_M); iy <= Math.floor(y1 / CELL_M); iy++) {
        const k = this.key(ix, iy)
        let list = this.grid.get(k)
        if (!list) this.grid.set(k, (list = []))
        list.push(s)
      }
    }
  }

  /** Does segment a-b cross any wall / column segment? */
  crossesWall(a: XY, b: XY): boolean {
    const seen = new Set<Seg>()
    const [x0, x1] = [Math.min(a[0], b[0]), Math.max(a[0], b[0])]
    const [y0, y1] = [Math.min(a[1], b[1]), Math.max(a[1], b[1])]
    for (let ix = Math.floor(x0 / CELL_M); ix <= Math.floor(x1 / CELL_M); ix++) {
      for (let iy = Math.floor(y0 / CELL_M); iy <= Math.floor(y1 / CELL_M); iy++) {
        for (const s of this.grid.get(this.key(ix, iy)) ?? []) {
          if (seen.has(s)) continue
          seen.add(s)
          if (segmentsIntersect(a, b, s[0], s[1])) return true
        }
      }
    }
    return false
  }

  /** Does the segment stay in walkable units (or the units its ends are in)? */
  inWalkable(a: XY, b: XY): boolean {
    const own = this.units.filter((u) => pointInPolygon(a, u.rings) || pointInPolygon(b, u.rings)).map((u) => u.rings)
    const areas = [...this.walkable, ...own]
    const len = dist(a, b)
    const n = Math.max(1, Math.ceil(len / SAMPLE_M))
    for (let i = 1; i < n; i++) {
      const t = i / n
      if (t * len < END_SLACK_M || (1 - t) * len < END_SLACK_M) continue
      const p: XY = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
      if (!areas.some((rings) => pointInPolygon(p, rings))) return false
    }
    return true
  }

  clear(a: XY, b: XY): boolean {
    return !this.crossesWall(a, b) && this.inWalkable(a, b)
  }
}

/** proper segment intersection (shared endpoints / touching count as crossing; collinear overlap too) */
export function segmentsIntersect(p1: XY, p2: XY, p3: XY, p4: XY): boolean {
  const d = (a: XY, b: XY, c: XY) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
  const on = (a: XY, b: XY, c: XY) => Math.min(a[0], b[0]) - 1e-9 <= c[0] && c[0] <= Math.max(a[0], b[0]) + 1e-9 && Math.min(a[1], b[1]) - 1e-9 <= c[1] && c[1] <= Math.max(a[1], b[1]) + 1e-9
  const d1 = d(p3, p4, p1)
  const d2 = d(p3, p4, p2)
  const d3 = d(p1, p2, p3)
  const d4 = d(p1, p2, p4)
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true
  if (Math.abs(d1) < 1e-9 && on(p3, p4, p1)) return true
  if (Math.abs(d2) < 1e-9 && on(p3, p4, p2)) return true
  if (Math.abs(d3) < 1e-9 && on(p1, p2, p3)) return true
  if (Math.abs(d4) < 1e-9 && on(p1, p2, p4)) return true
  return false
}

/** vertices that must stay: ends, floor changes, doorways */
export function fixedVertices(pts: RoutePoint[]): boolean[] {
  return pts.map((p, i) => {
    if (i === 0 || i === pts.length - 1) return true
    const prev = pts[i - 1]
    const next = pts[i + 1]
    if (prev.level !== p.level || next.level !== p.level) return true
    if (p.via === 'elevator' || p.via === 'stairs' || next.via === 'elevator' || next.via === 'stairs') return true
    return DOORISH.has(p.via ?? '') && DOORISH.has(next.via ?? '')
  })
}

/**
 * Smooth a route's polyline. `geom(level)` returns the level's geometry, or null to leave that
 * level's legs untouched (e.g. walls not loaded yet). Distances are recomputed; `cost` and
 * `targetIndex` are kept.
 */
export function smoothRoute(route: Route, geom: (level: string) => LevelGeometry | null): Route {
  const pts = route.points
  if (pts.length < 3) return route
  const fixed = fixedVertices(pts)
  const out: RoutePoint[] = [pts[0]]
  let i = 0
  while (i < pts.length - 1) {
    let best = i + 1
    const g = geom(pts[i].level)
    if (g) {
      for (let j = i + 2; j < pts.length; j++) {
        // can't skip a fixed vertex or leave the level
        if (fixed[j - 1] || pts[j].level !== pts[i].level) break
        if (!g.clear(pts[i].xy, pts[j].xy)) break
        best = j
      }
    }
    out.push(pts[best])
    i = best
  }
  // floor-change legs are untouched (their vertices are fixed): only the horizontal part changes
  const walkLength = route.walkLength - horizontal(pts) + horizontal(out)
  return { ...route, points: out, walkLength }
}

function horizontal(pts: RoutePoint[]): number {
  let s = 0
  for (let k = 1; k < pts.length; k++) if (pts[k - 1].level === pts[k].level) s += dist(pts[k - 1].xy, pts[k].xy)
  return s
}

/**
 * After re-smoothing, find the step in `next` that corresponds to step `index` of `prev`: the same
 * kind on the same level starting nearest to it (falls back to the nearest step on that level).
 */
export function remapStepIndex(prev: Step[], index: number, next: Step[]): number {
  const s = prev[index]
  if (!s || !next.length) return Math.min(index, Math.max(0, next.length - 1))
  if (s.kind === 'arrive') return next.length - 1
  let best = -1
  let bestScore = Infinity
  next.forEach((n, j) => {
    if (n.level !== s.level) return
    const score = dist(n.xy, s.xy) + (n.kind === s.kind ? 0 : 1000)
    if (score < bestScore) {
      bestScore = score
      best = j
    }
  })
  return best >= 0 ? best : Math.min(index, next.length - 1)
}
