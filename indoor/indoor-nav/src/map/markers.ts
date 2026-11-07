/**
 * Ground-plane marker shapes in local metres (converted to lng/lat by the caller), so they get
 * perspective when the map is pitched and rotate with the map's bearing — unlike screen-space
 * circles / icons.
 */
import type { XY } from '../geo/frame'

/** Closed ring approximating a circle of radius `r` metres. */
export function circleRing([cx, cy]: XY, r: number, n = 64): XY[] {
  const ring: XY[] = []
  for (let i = 0; i < n; i++) {
    const a = (i / n) * 2 * Math.PI
    ring.push([cx + r * Math.cos(a), cy + r * Math.sin(a)])
  }
  ring.push(ring[0]) // exactly closed
  return ring
}

/**
 * Closed ring of a heading wedge: apex at `c`, opening towards `headingDeg` (clockwise from
 * local +y), `length` metres long, ±`halfAngleDeg` wide, with an arc of `n` segments.
 */
export function wedgeRing([cx, cy]: XY, headingDeg: number, length = 6, halfAngleDeg = 25, n = 12): XY[] {
  const ring: XY[] = [[cx, cy]]
  for (let i = 0; i <= n; i++) {
    const h = ((headingDeg - halfAngleDeg + (2 * halfAngleDeg * i) / n) * Math.PI) / 180
    // clockwise from +y: x = sin, y = cos
    ring.push([cx + length * Math.sin(h), cy + length * Math.cos(h)])
  }
  ring.push([cx, cy])
  return ring
}

/** Accuracy fill opacity: confident fixes are clearly visible, huge (> 15 m) ones fade out. */
export const accuracyOpacity = (accM: number) => (accM <= 5 ? 0.25 : accM >= 35 ? 0.07 : accM <= 15 ? 0.25 - ((accM - 5) / 10) * 0.1 : 0.15 - ((accM - 15) / 20) * 0.08)
