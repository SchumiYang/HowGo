import { describe, expect, it } from 'vitest'
import type { XY } from '../../geo/frame'
import { affineLsq, apply, calibrate, corners, fitInto, fromCorners, nudge, rms, similarity2, type Affine, type ControlPoint } from './calibrate'

const close = (a: XY, b: XY, eps = 1e-6) => {
  expect(a[0]).toBeCloseTo(b[0], -Math.log10(eps))
  expect(a[1]).toBeCloseTo(b[1], -Math.log10(eps))
}

// ground truth: 0.02 m/px, rotated 30°, v flipped, offset (10, 50)
const th = (30 * Math.PI) / 180
const truth: Affine = [0.02 * Math.cos(th), 0.02 * Math.sin(th), 10, 0.02 * Math.sin(th), -0.02 * Math.cos(th), 50]
const cp = (u: number, v: number): ControlPoint => ({ px: [u, v], m: apply(truth, [u, v]) })

describe('2-point similarity', () => {
  it('recovers scale, rotation, the v-flip and translation exactly', () => {
    const t = similarity2([cp(100, 200), cp(4000, 2500)])
    for (const p of [[0, 0], [5000, 0], [5000, 3800], [1234, 987]] as XY[]) close(apply(t, p), apply(truth, p))
    expect(rms(t, [cp(100, 200), cp(4000, 2500)])).toBeLessThan(1e-9)
  })

  it('maps image "up" (−v) to +y for an unrotated plan', () => {
    const t = similarity2([{ px: [0, 100], m: [0, 0] }, { px: [0, 0], m: [0, 10] }])
    close(apply(t, [0, 50]), [0, 5])
    close(apply(t, [100, 100]), [10, 0]) // u right -> x right, same scale
  })

  it('rejects identical image points', () => {
    expect(() => similarity2([cp(1, 1), cp(1, 1)])).toThrow()
  })
})

describe('affine least squares', () => {
  it('is exact for 3 points and recovers shear / anisotropic scale', () => {
    const sheared: Affine = [0.021, 0.003, -5, 0.001, -0.019, 70]
    const pts = ([[0, 0], [3000, 100], [200, 2500]] as XY[]).map((px) => ({ px, m: apply(sheared, px) }))
    const t = affineLsq(pts)
    t.forEach((v, i) => expect(v).toBeCloseTo(sheared[i], 9))
  })

  it('averages noisy points and reports their RMS', () => {
    const noise: XY[] = [[0.1, -0.1], [-0.1, 0.1], [0.1, 0.1], [-0.1, -0.1]]
    const pts = ([[0, 0], [4000, 0], [4000, 3000], [0, 3000]] as XY[]).map((px, i) => {
      const m = apply(truth, px)
      return { px, m: [m[0] + noise[i][0], m[1] + noise[i][1]] as XY }
    })
    const r = calibrate(pts)
    expect(r.method).toBe('3-point')
    expect(r.rms).toBeGreaterThan(0.05)
    expect(r.rms).toBeLessThan(0.15)
    close(apply(r.t, [2000, 1500]), apply(truth, [2000, 1500]), 0.1)
  })

  it('rejects collinear points', () => {
    expect(() => affineLsq([cp(0, 0), cp(10, 10), cp(20, 20)])).toThrow()
  })
})

describe('corners, nudge, initial fit', () => {
  it('corners round-trip through fromCorners', () => {
    const c = corners(truth, 5000, 3800)
    fromCorners(c, 5000, 3800).forEach((v, i) => expect(v).toBeCloseTo(truth[i], 9))
  })

  it('nudge rotates and scales about the image centre and translates', () => {
    const w = 1000
    const h = 500
    const t = fitInto(w, h, [0, 0, 100, 50]) // 0.1 m/px, centred at (50, 25)
    close(apply(t, [w / 2, h / 2]), [50, 25])
    const r = nudge(t, w, h, { rotDeg: 90 })
    close(apply(r, [w / 2, h / 2]), [50, 25])
    close(apply(r, [w, h / 2]), [50, 75]) // right edge midpoint swung to the top
    const s = nudge(t, w, h, { scale: 2, dx: 1, dy: -2 })
    close(apply(s, [w, h / 2]), [151, 23])
  })
})
