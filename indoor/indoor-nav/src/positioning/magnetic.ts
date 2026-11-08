/**
 * Magnetic map matching on orientation-invariant features (|B|, Bv = B·up).
 *
 * MagGrid: dense lookup built from magmap cells (only surveyed corridors have data). Gaps up to fillRadiusM
 * around surveyed cells are filled by inverse-distance weighting; lookups interpolate bilinearly.
 *
 * magLikelihood(): sequence matching along each particle's own track. Every particle carries the residuals
 * r = z − map(x_particle) of its recent steps (exponentially forgotten); an unknown per-device bias b is
 * marginalised analytically (Gaussian prior), so each step's weight is the predictive likelihood
 * N(r_k; E[b | r_<k], σ² + Var[b | r_<k]). The product over steps is the likelihood of the whole recent sequence
 * with the bias integrated out: a constant device offset does not matter, the shape of the profile does.
 */
import type { Magmap } from './types'

export interface MagOptions {
  /** combined sensor + map noise per step for |B| and Bv (µT) */
  sigmaB: number
  sigmaV: number
  /** prior std of the per-device bias (µT) */
  biasSigma: number
  /** per-step forgetting of the residual history (≈ 1/(1−forget) steps of memory) */
  forget: number
  temper: number
  /** relative likelihood floor */
  floor: number
  fillRadiusM: number
  useBv: boolean
}

export const DEFAULT_MAG: MagOptions = {
  // real survey (tianmu 1F, 2 phones): forward/reverse RMS 2.9 uT corridors, 4.8 uT arena; 3 was best in LOWO
  sigmaB: 3.0,
  sigmaV: 3.0,
  biasSigma: 6,
  forget: 0.95,
  // consecutive per-step residuals are strongly correlated (smoothed map, 0.65 m steps, coherent map errors);
  // untempered products compound small biases into hijacks (synthetic arena door test, live run 1). LOWO: 0.3
  temper: 0.3,
  floor: 0.05,
  fillRadiusM: 1.5,
  useBv: true,
}

export class MagGrid {
  readonly x0: number
  readonly y0: number
  readonly cell: number
  readonly w: number
  readonly h: number
  readonly B: Float32Array
  readonly Bv: Float32Array
  /** mean and std of the surveyed field (the prior for a place the survey did not cover) */
  readonly stats: { meanB: number; stdB: number; meanV: number; stdV: number }

  constructor(map: Magmap, fillRadiusM = DEFAULT_MAG.fillRadiusM) {
    const c = map.cell_m
    const r = Math.ceil(fillRadiusM / c)
    const mean = (f: (p: (typeof map.cells)[number]) => number) => map.cells.reduce((a, p) => a + f(p), 0) / map.cells.length
    const meanB = mean((p) => p.B)
    const meanV = mean((p) => p.Bv)
    this.stats = {
      meanB, meanV,
      stdB: Math.sqrt(mean((p) => (p.B - meanB) ** 2)),
      stdV: Math.sqrt(mean((p) => (p.Bv - meanV) ** 2)),
    }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const p of map.cells) {
      minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y)
    }
    this.cell = c
    this.x0 = minX - (r + 1) * c
    this.y0 = minY - (r + 1) * c
    this.w = Math.round((maxX - minX) / c) + 2 * r + 3
    this.h = Math.round((maxY - minY) / c) + 2 * r + 3
    const n = this.w * this.h
    this.B = new Float32Array(n).fill(NaN)
    this.Bv = new Float32Array(n).fill(NaN)
    const sw = new Float32Array(n)
    const sB = new Float32Array(n)
    const sV = new Float32Array(n)
    const has = new Uint8Array(n)
    for (const p of map.cells) {
      const i = Math.round((p.x - this.x0) / c)
      const j = Math.round((p.y - this.y0) / c)
      has[j * this.w + i] = 1
      this.B[j * this.w + i] = p.B
      this.Bv[j * this.w + i] = p.Bv
      for (let dj = -r; dj <= r; dj++) {
        for (let di = -r; di <= r; di++) {
          const d = Math.hypot(di, dj) * c
          if (d === 0 || d > fillRadiusM) continue
          const k = (j + dj) * this.w + (i + di)
          const wgt = 1 / (d * d)
          sw[k] += wgt
          sB[k] += wgt * p.B
          sV[k] += wgt * p.Bv
        }
      }
    }
    for (let k = 0; k < n; k++) {
      if (!has[k] && sw[k] > 0) {
        this.B[k] = sB[k] / sw[k]
        this.Bv[k] = sV[k] / sw[k]
      }
    }
  }

  /** Bilinear lookup (cell centres); writes [B, Bv] into out. false where the map has no data. */
  lookup(x: number, y: number, out: Float64Array): boolean {
    const gx = (x - this.x0) / this.cell
    const gy = (y - this.y0) / this.cell
    const i = Math.floor(gx)
    const j = Math.floor(gy)
    if (i < 0 || j < 0 || i + 1 >= this.w || j + 1 >= this.h) return false
    const fx = gx - i
    const fy = gy - j
    let sw = 0, b = 0, v = 0
    for (let k = 0; k < 4; k++) {
      const ii = i + (k & 1)
      const jj = j + (k >> 1)
      const val = this.B[jj * this.w + ii]
      if (Number.isNaN(val)) continue
      const wgt = ((k & 1) ? fx : 1 - fx) * ((k >> 1) ? fy : 1 - fy) + 1e-6
      sw += wgt
      b += wgt * val
      v += wgt * this.Bv[jj * this.w + ii]
    }
    if (sw < 0.15) return false
    out[0] = b / sw
    out[1] = v / sw
    return true
  }
}

/** Per-particle residual history (sufficient statistics of the bias posterior). */
export interface MagTrackState {
  sumB: Float64Array
  sumV: Float64Array
  count: Float64Array
}

const scratch = new Float64Array(2)

/**
 * Multiply the magnetic likelihood of one step's (zB, zV) into w and update each particle's residual history.
 * Particles without map data get the marginal likelihood under the surveyed field's distribution (see below).
 * Returns how many particles had data (0 = step not used).
 */
export function magLikelihood(
  xs: Float64Array, ys: Float64Array, w: Float64Array, n: number, zB: number, zV: number,
  grid: MagGrid, st: MagTrackState, o: MagOptions, ll: Float64Array,
): number {
  const p0 = 1 / (o.biasSigma * o.biasSigma)
  const vB = o.sigmaB * o.sigmaB
  const vV = o.sigmaV * o.sigmaV
  const fs = grid.stats
  // pass 1: map values, and the device bias as the cloud knows it (weighted over particles with map data) — the
  // bias belongs to the phone, so a particle on unsurveyed ground uses that instead of its own (uninformed) estimate
  const mB = new Float64Array(n)
  const mV = new Float64Array(n)
  let nData = 0, sw = 0, bB = 0, bV = 0, qB = 0, qV = 0
  for (let i = 0; i < n; i++) {
    mB[i] = NaN
    if (w[i] === 0 || !grid.lookup(xs[i], ys[i], scratch)) continue
    mB[i] = scratch[0]
    mV[i] = scratch[1]
    nData++
    const c = st.count[i]
    const precB = c / vB + p0
    const precV = c / vV + p0
    const muB = st.sumB[i] / vB / precB
    const muV = st.sumV[i] / vV / precV
    sw += w[i]
    bB += w[i] * muB
    bV += w[i] * muV
    qB += w[i] * (muB * muB + 1 / precB)
    qV += w[i] * (muV * muV + 1 / precV)
  }
  if (!nData) return 0
  bB /= sw
  bV /= sw
  const varB = Math.max(qB / sw - bB * bB, 0)
  const varV = Math.max(qV / sw - bV * bV, 0)
  let max = -Infinity
  for (let i = 0; i < n; i++) {
    if (w[i] === 0) continue
    let l: number
    if (!Number.isNaN(mB[i])) {
      const c = st.count[i]
      // bias posterior from past residuals (prior mean 0) -> mean and predictive variance S per feature
      const precB = c / vB + p0
      const sB = vB + 1 / precB
      const rB = zB - mB[i]
      l = -0.5 * ((rB - st.sumB[i] / vB / precB) ** 2 / sB + Math.log(sB))
      st.sumB[i] = o.forget * st.sumB[i] + rB
      if (o.useBv) {
        const precV = c / vV + p0
        const sV = vV + 1 / precV
        const rV = zV - mV[i]
        l += -0.5 * ((rV - st.sumV[i] / vV / precV) ** 2 / sV + Math.log(sV))
        st.sumV[i] = o.forget * st.sumV[i] + rV
      }
      st.count[i] = o.forget * c + 1
    } else {
      // Not surveyed here: the field is unknown, so use the marginal likelihood under the surveyed field's
      // distribution, N(z; mean + bias, σ² + Var[bias] + std²). It ranks below a good match and above a bad one,
      // by how much depends on how informative the field is — a cloud is not hijacked by mapped corridors it does
      // not match, and an unwalked corridor (1F east) degrades to PDR + walls.
      const tB = vB + varB + fs.stdB * fs.stdB
      l = -0.5 * ((zB - fs.meanB - bB) ** 2 / tB + Math.log(tB))
      if (o.useBv) {
        const tV = vV + varV + fs.stdV * fs.stdV
        l += -0.5 * ((zV - fs.meanV - bV) ** 2 / tV + Math.log(tV))
      }
    }
    ll[i] = o.temper * l
    if (ll[i] > max) max = ll[i]
  }
  for (let i = 0; i < n; i++) {
    if (w[i] === 0) continue
    w[i] *= o.floor + (1 - o.floor) * Math.exp(ll[i] - max)
  }
  return nData
}
