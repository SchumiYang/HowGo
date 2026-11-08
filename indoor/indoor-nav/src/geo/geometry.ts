import type { XY } from './frame'

export type BBox = [minX: number, minY: number, maxX: number, maxY: number]

export const dist = (a: XY, b: XY) => Math.hypot(b[0] - a[0], b[1] - a[1])

/** Project p onto segment ab. Returns the closest point, its parameter t in [0,1] and distance. */
export function projectOnSegment(p: XY, a: XY, b: XY): { point: XY; t: number; d: number } {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const len2 = dx * dx + dy * dy
  let t = len2 === 0 ? 0 : ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2
  t = Math.max(0, Math.min(1, t))
  const point: XY = [a[0] + t * dx, a[1] + t * dy]
  return { point, t, d: dist(p, point) }
}

export function emptyBBox(): BBox {
  return [Infinity, Infinity, -Infinity, -Infinity]
}

export function extendBBox(b: BBox, [x, y]: XY): BBox {
  if (x < b[0]) b[0] = x
  if (y < b[1]) b[1] = y
  if (x > b[2]) b[2] = x
  if (y > b[3]) b[3] = y
  return b
}

export function isValidBBox(b: BBox) {
  return Number.isFinite(b[0]) && b[2] >= b[0] && b[3] >= b[1]
}

/** Ray-casting point-in-ring test. */
export function pointInRing(p: XY, ring: XY[]): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]
    const [xj, yj] = ring[j]
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

export function pointInPolygon(p: XY, rings: XY[][]): boolean {
  if (!rings.length || !pointInRing(p, rings[0])) return false
  for (let i = 1; i < rings.length; i++) if (pointInRing(p, rings[i])) return false
  return true
}

function ringAreaCentroid(ring: XY[]): { a: number; cx: number; cy: number } {
  let a = 0
  let cx = 0
  let cy = 0
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const f = ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1]
    a += f
    cx += (ring[j][0] + ring[i][0]) * f
    cy += (ring[j][1] + ring[i][1]) * f
  }
  a /= 2
  return a === 0 ? { a: 0, cx: ring[0]?.[0] ?? 0, cy: ring[0]?.[1] ?? 0 } : { a, cx: cx / (6 * a), cy: cy / (6 * a) }
}

/**
 * A label point that lies inside the polygon: the area centroid if it is inside,
 * otherwise the midpoint of the widest horizontal interior span through the centroid's y
 * (cheap stand-in for pole-of-inaccessibility, good enough for rooms and ring corridors).
 */
export function labelPoint(rings: XY[][]): XY {
  const { cx, cy } = ringAreaCentroid(rings[0])
  const c: XY = [cx, cy]
  if (pointInPolygon(c, rings)) return c
  const b = rings[0].reduce((bb, p) => extendBBox(bb, p), emptyBBox())
  let best: XY = rings[0][0]
  let bestW = -1
  for (let k = 1; k < 10; k++) {
    const y = b[1] + ((b[3] - b[1]) * k) / 10
    const xs: number[] = []
    for (const ring of rings) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i]
        const [xj, yj] = ring[j]
        if (yi > y !== yj > y) xs.push(((xj - xi) * (y - yi)) / (yj - yi) + xi)
      }
    }
    xs.sort((m, n) => m - n)
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const w = xs[i + 1] - xs[i]
      if (w > bestW) {
        bestW = w
        best = [(xs[i] + xs[i + 1]) / 2, y]
      }
    }
  }
  return best
}

/** Signed turn angle in degrees from direction a->b to b->c; positive = left (CCW, y up). */
export function turnAngle(a: XY, b: XY, c: XY): number {
  const h1 = Math.atan2(b[1] - a[1], b[0] - a[0])
  const h2 = Math.atan2(c[1] - b[1], c[0] - b[0])
  let d = ((h2 - h1) * 180) / Math.PI
  while (d > 180) d -= 360
  while (d < -180) d += 360
  return d
}
