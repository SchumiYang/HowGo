/**
 * Floor plan calibration: image pixels (u right, v down) -> local metres (x right, y up).
 *
 * The transform is an affine map  [x, y] = [a b c; d e f] · [u, v, 1].
 * - 2 control points: similarity (uniform scale + rotation + translation, with the image's v-down
 *   axis flipped to y-up), solved exactly with complex numbers.
 * - 3+ control points: least-squares affine (allows shear / non-uniform scale from scanned plans).
 */
import type { XY } from '../../geo/frame'

/** row-major [a, b, c, d, e, f] */
export type Affine = [number, number, number, number, number, number]

export interface ControlPoint {
  px: XY
  m: XY
}

export const apply = (t: Affine, [u, v]: XY): XY => [t[0] * u + t[1] * v + t[2], t[3] * u + t[4] * v + t[5]]

/**
 * Similarity from two point pairs. With w = u − i·v (v flipped so the image's "up" is +y) and
 * z = x + i·y, the map is z = α·w + β.
 */
export function similarity2(p: [ControlPoint, ControlPoint]): Affine {
  const [p1, p2] = p
  const w1 = { re: p1.px[0], im: -p1.px[1] }
  const w2 = { re: p2.px[0], im: -p2.px[1] }
  const dw = { re: w2.re - w1.re, im: w2.im - w1.im }
  const dz = { re: p2.m[0] - p1.m[0], im: p2.m[1] - p1.m[1] }
  const den = dw.re * dw.re + dw.im * dw.im
  if (den === 0) throw new Error('兩個控制點的影像位置相同')
  // α = dz / dw
  const ar = (dz.re * dw.re + dz.im * dw.im) / den
  const ai = (dz.im * dw.re - dz.re * dw.im) / den
  // β = z1 − α·w1
  const br = p1.m[0] - (ar * w1.re - ai * w1.im)
  const bi = p1.m[1] - (ar * w1.im + ai * w1.re)
  // x = ar·u + ai·v + br ; y = ai·u − ar·v + bi   (from w = u − i v)
  return [ar, ai, br, ai, -ar, bi]
}

function solve3(m: number[][], r: number[]): number[] {
  // Cramer's rule for the 3x3 normal equations
  const det = (a: number[][]) =>
    a[0][0] * (a[1][1] * a[2][2] - a[1][2] * a[2][1]) -
    a[0][1] * (a[1][0] * a[2][2] - a[1][2] * a[2][0]) +
    a[0][2] * (a[1][0] * a[2][1] - a[1][1] * a[2][0])
  const d = det(m)
  if (Math.abs(d) < 1e-12) throw new Error('控制點共線，無法計算仿射轉換')
  return [0, 1, 2].map((k) => det(m.map((row, i) => row.map((v, j) => (j === k ? r[i] : v)))) / d)
}

/** Least-squares affine from 3+ point pairs. */
export function affineLsq(pts: ControlPoint[]): Affine {
  if (pts.length < 3) throw new Error('仿射校正至少需要 3 個控制點')
  // normal equations for [u v 1] · [a b c]^T = x (and the same for y)
  const n = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ]
  const rx = [0, 0, 0]
  const ry = [0, 0, 0]
  for (const { px: [u, v], m: [x, y] } of pts) {
    const row = [u, v, 1]
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) n[i][j] += row[i] * row[j]
      rx[i] += row[i] * x
      ry[i] += row[i] * y
    }
  }
  const [a, b, c] = solve3(n, rx)
  const [d, e, f] = solve3(n, ry)
  return [a, b, c, d, e, f]
}

/** Root-mean-square residual (m) of the control points under t. */
export function rms(t: Affine, pts: ControlPoint[]): number {
  if (!pts.length) return 0
  const s = pts.reduce((acc, p) => {
    const q = apply(t, p.px)
    return acc + (q[0] - p.m[0]) ** 2 + (q[1] - p.m[1]) ** 2
  }, 0)
  return Math.sqrt(s / pts.length)
}

export function calibrate(pts: ControlPoint[]): { t: Affine; method: '2-point' | '3-point'; rms: number } {
  const t = pts.length === 2 ? similarity2([pts[0], pts[1]]) : affineLsq(pts)
  return { t, method: pts.length === 2 ? '2-point' : '3-point', rms: rms(t, pts) }
}

/** Image corners in local metres, MapLibre image-source order: TL, TR, BR, BL. */
export function corners(t: Affine, w: number, h: number): [XY, XY, XY, XY] {
  return [apply(t, [0, 0]), apply(t, [w, 0]), apply(t, [w, h]), apply(t, [0, h])]
}

/** Affine recovered from saved corners (uses TL, TR, BL). */
export function fromCorners(c: [XY, XY, XY, XY], w: number, h: number): Affine {
  const [tl, tr, , bl] = c
  return [(tr[0] - tl[0]) / w, (bl[0] - tl[0]) / h, tl[0], (tr[1] - tl[1]) / w, (bl[1] - tl[1]) / h, tl[1]]
}

/** Image fitted (aspect kept, north-up, no rotation) into a local bbox — the starting placement. */
export function fitInto(w: number, h: number, [x0, y0, x1, y1]: [number, number, number, number]): Affine {
  const s = Math.min((x1 - x0) / w, (y1 - y0) / h)
  const cx = (x0 + x1) / 2
  const cy = (y0 + y1) / 2
  return [s, 0, cx - (s * w) / 2, 0, -s, cy + (s * h) / 2]
}

/**
 * Manual nudge applied after the current transform, about the image centre: translate (m),
 * rotate (deg, counter-clockwise), uniform scale factor.
 */
export function nudge(t: Affine, w: number, h: number, n: { dx?: number; dy?: number; rotDeg?: number; scale?: number }): Affine {
  const [cx, cy] = apply(t, [w / 2, h / 2])
  const th = ((n.rotDeg ?? 0) * Math.PI) / 180
  const s = n.scale ?? 1
  const c = Math.cos(th) * s
  const si = Math.sin(th) * s
  // q' = R·S·(q − centre) + centre + d
  const m = (x: number, y: number): XY => [c * (x - cx) - si * (y - cy) + cx + (n.dx ?? 0), si * (x - cx) + c * (y - cy) + cy + (n.dy ?? 0)]
  const o = m(t[2], t[5])
  const ux = m(t[0] + t[2], t[3] + t[5])
  const vx = m(t[1] + t[2], t[4] + t[5])
  return [ux[0] - o[0], vx[0] - o[0], o[0], ux[1] - o[1], vx[1] - o[1], o[1]]
}
