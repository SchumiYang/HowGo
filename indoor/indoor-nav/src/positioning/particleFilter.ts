/**
 * Particle filter fusing PDR steps with the map constraint, WiFi and magnetic likelihoods.
 *
 * State per particle: x, y, heading offset h (absolute walking direction = PDR yaw + h), step-length scale,
 * magnetic residual history (per-device bias, see magnetic.ts) and the positions of its last histLen steps
 * (lets a WiFi scan, which describes where the phone was a few seconds ago, weight the particle's past position).
 * Motion: PDR step with heading/length noise; a step that would cross a blocked cell is retried with more heading
 * noise (penalised) and otherwise kills the particle. Resampling is systematic, on low effective sample size.
 */
import type { OccupancyGrid } from './grid'
import type { MagGrid, MagOptions, MagTrackState } from './magnetic'
import { magLikelihood } from './magnetic'
import type { StepEvent } from './pdr'
import { makeGauss, type Rng } from './rng'

export interface PfOptions {
  n: number
  histLen: number
  /** relative step length noise per step */
  stepSigmaFrac: number
  /** heading noise per step (rad), not accumulated */
  headingSigma: number
  /** random walk of the heading offset per step (rad) */
  headingDrift: number
  scaleDrift: number
  scaleRange: [number, number]
  /** resample when ESS < essFrac · n */
  essFrac: number
  /** position jitter after resampling (m) */
  roughenM: number
  /** extra attempts for a blocked step, each multiplying the weight by retryPenalty */
  retries: number
  retryPenalty: number
}

export const DEFAULT_PF: PfOptions = {
  // 2000: the tail of the live replays at power-saving sensor rates (20 Hz gyro/mag) needed it (p90 13 -> 7 m)
  n: 2000,
  histLen: 16,
  stepSigmaFrac: 0.12,
  headingSigma: (4 * Math.PI) / 180,
  headingDrift: (0.6 * Math.PI) / 180,
  scaleDrift: 0.01,
  scaleRange: [0.75, 1.3],
  essFrac: 0.5,
  roughenM: 0.08,
  retries: 2,
  retryPenalty: 0.3,
}

/** Prior on the absolute walking direction (math angle, rad, CCW from local +x). */
export interface HeadingPrior {
  mean: number | null
  sigma: number
  /** fraction of particles with a uniformly random heading */
  uniformFrac: number
}

export interface PfEstimate {
  x: number
  y: number
  /** sqrt(var x + var y) of the weighted particle cloud */
  spread: number
  /** absolute walking direction (math angle, rad) */
  heading: number
  /** mean resultant length of the heading distribution (0..1) */
  headingConc: number
  ess: number
}

const TAU = 2 * Math.PI

export class ParticleFilter {
  readonly o: PfOptions
  readonly n: number
  initialized = false
  /** set when every particle was blocked and the constraint had to be ignored */
  lostSteps = 0
  private readonly grid: OccupancyGrid
  private readonly rng: Rng
  private readonly gauss: () => number
  x: Float64Array
  y: Float64Array
  h: Float64Array
  sc: Float64Array
  w: Float64Array
  mag: MagTrackState
  hist: Float32Array
  readonly histT: Float64Array
  private histPos = 0
  private readonly ll: Float64Array

  constructor(grid: OccupancyGrid, opts: Partial<PfOptions> = {}, rng: Rng = Math.random) {
    this.o = { ...DEFAULT_PF, ...opts }
    this.n = this.o.n
    this.grid = grid
    this.rng = rng
    this.gauss = makeGauss(rng)
    const n = this.n
    this.x = new Float64Array(n)
    this.y = new Float64Array(n)
    this.h = new Float64Array(n)
    this.sc = new Float64Array(n)
    this.w = new Float64Array(n)
    this.mag = { sumB: new Float64Array(n), sumV: new Float64Array(n), count: new Float64Array(n) }
    this.hist = new Float32Array(n * this.o.histLen * 2)
    this.histT = new Float64Array(this.o.histLen).fill(NaN)
    this.ll = new Float64Array(n)
  }

  private sampleHeading(prior: HeadingPrior, yaw: number): number {
    if (prior.mean === null || this.rng() < prior.uniformFrac) return this.rng() * TAU
    return prior.mean - yaw + this.gauss() * prior.sigma
  }

  /** Free position near (cx, cy) with isotropic sigma; falls back to the centre (or the cell itself). */
  private sampleFree(cx: number, cy: number, sigma: number): [number, number] {
    for (let k = 0; k < 30; k++) {
      const s = sigma * (1 + k / 10)
      const x = cx + this.gauss() * s
      const y = cy + this.gauss() * s
      if (this.grid.isFree(x, y)) return [x, y]
    }
    return [cx, cy]
  }

  /**
   * (Re)initialise from weighted seed locations (a known start: one seed; WiFi: the best fingerprints).
   * yaw = current PDR yaw, so heading offsets map the prior onto the PDR frame.
   */
  init(seeds: { x: number; y: number; w: number }[], sigma: number, heading: HeadingPrior, yaw: number) {
    const total = seeds.reduce((s, p) => s + p.w, 0)
    for (let i = 0; i < this.n; i++) {
      let u = this.rng() * total
      let seed = seeds[0]
      for (const p of seeds) {
        if ((u -= p.w) <= 0) {
          seed = p
          break
        }
      }
      const [x, y] = this.sampleFree(seed.x, seed.y, sigma)
      this.x[i] = x
      this.y[i] = y
      this.h[i] = this.sampleHeading(heading, yaw)
      this.sc[i] = this.o.scaleRange[0] + this.rng() * (this.o.scaleRange[1] - this.o.scaleRange[0])
      this.w[i] = 1 / this.n
      this.mag.sumB[i] = this.mag.sumV[i] = this.mag.count[i] = 0
      for (let k = 0; k < this.o.histLen; k++) {
        this.hist[(i * this.o.histLen + k) * 2] = x
        this.hist[(i * this.o.histLen + k) * 2 + 1] = y
      }
    }
    this.histT.fill(NaN)
    this.histPos = 0
    this.initialized = true
    this.lostSteps = 0
  }

  /** Replace the m lowest-weight particles with fresh ones around a point (relocalisation / kidnapping). */
  inject(cx: number, cy: number, sigma: number, frac: number, heading: HeadingPrior, yaw: number) {
    const m = Math.floor(this.n * frac)
    if (m <= 0) return
    const order = Array.from(this.w.keys()).sort((a, b) => this.w[a] - this.w[b]).slice(0, m)
    let mean = 0
    for (let i = 0; i < this.n; i++) mean += this.w[i]
    mean /= this.n
    for (const i of order) {
      const [x, y] = this.sampleFree(cx, cy, sigma)
      this.x[i] = x
      this.y[i] = y
      this.h[i] = this.sampleHeading(heading, yaw)
      this.sc[i] = 1
      this.w[i] = mean
      this.mag.sumB[i] = this.mag.sumV[i] = this.mag.count[i] = 0
      for (let k = 0; k < this.o.histLen; k++) {
        this.hist[(i * this.o.histLen + k) * 2] = x
        this.hist[(i * this.o.histLen + k) * 2 + 1] = y
      }
    }
  }

  predict(step: StepEvent) {
    const { o, n, grid, gauss } = this
    const ox = Float64Array.from(this.x)
    const oy = Float64Array.from(this.y)
    let alive = 0
    for (let i = 0; i < n; i++) {
      if (this.w[i] === 0) continue
      this.h[i] += gauss() * o.headingDrift
      this.sc[i] = Math.min(o.scaleRange[1], Math.max(o.scaleRange[0], this.sc[i] + gauss() * o.scaleDrift))
      let moved = false
      for (let a = 0; a <= o.retries && !moved; a++) {
        const th = step.yaw + this.h[i] + gauss() * o.headingSigma * (1 + 3 * a)
        const L = step.length * this.sc[i] * (1 + gauss() * o.stepSigmaFrac)
        const nx = ox[i] + L * Math.cos(th)
        const ny = oy[i] + L * Math.sin(th)
        if (grid.segmentFree(ox[i], oy[i], nx, ny)) {
          this.x[i] = nx
          this.y[i] = ny
          if (a > 0) this.w[i] *= o.retryPenalty ** a
          moved = true
        }
      }
      if (moved) alive++
      else this.w[i] = 0
    }
    if (!alive) {
      // every hypothesis hit a wall (map error or a bad cloud): move unconstrained rather than lose the track
      this.lostSteps++
      for (let i = 0; i < n; i++) {
        const th = step.yaw + this.h[i] + gauss() * o.headingSigma
        const L = step.length * this.sc[i]
        this.x[i] = ox[i] + L * Math.cos(th)
        this.y[i] = oy[i] + L * Math.sin(th)
        this.w[i] = 1 / n
      }
    }
    const H = o.histLen
    for (let i = 0; i < n; i++) {
      this.hist[(i * H + this.histPos) * 2] = this.x[i]
      this.hist[(i * H + this.histPos) * 2 + 1] = this.y[i]
    }
    this.histT[this.histPos] = step.t
    this.histPos = (this.histPos + 1) % H
  }

  /**
   * Door hops: particles within radius of one end of a door edge jump to the other end (with the given probability
   * per step), keeping heading offset, step scale and weight. Keeps both sides of a doorway alive as hypotheses —
   * inside an open hall nothing else would push a cloud through a 1–2 m gap — and lets magnetic / WiFi / walls decide.
   * portals: [ax, ay, bx, by] per direction. Returns how many particles hopped.
   */
  hop(portals: number[][], radius: number, prob: number): number {
    const r2 = radius * radius
    let n = 0
    for (let i = 0; i < this.n; i++) {
      if (this.w[i] === 0) continue
      for (const [ax, ay, bx, by] of portals) {
        if ((this.x[i] - ax) ** 2 + (this.y[i] - ay) ** 2 > r2 || this.rng() >= prob) continue
        const nx = bx + this.gauss() * 0.6
        const ny = by + this.gauss() * 0.6
        if (!this.grid.isFree(nx, ny)) continue
        this.x[i] = nx
        this.y[i] = ny
        n++
        break
      }
    }
    return n
  }

  /** Ring index of the stored step closest to time t, or -1 to use the current positions. */
  private histIndexAt(t: number): number {
    let best = -1
    let bestD = Infinity
    for (let k = 0; k < this.o.histLen; k++) {
      const tk = this.histT[k]
      if (Number.isNaN(tk)) continue
      const d = Math.abs(tk - t)
      if (d < bestD) {
        bestD = d
        best = k
      }
    }
    const newest = (this.histPos + this.o.histLen - 1) % this.o.histLen
    return best === newest || best < 0 ? -1 : best
  }

  /**
   * Multiply weights by lik(x, y) evaluated at each particle's position at time t (past step positions from the
   * history, current positions for recent t). Returns the mean likelihood before normalisation (fit quality).
   */
  weightAt(t: number, lik: (x: number, y: number) => number): number {
    const k = this.histIndexAt(t)
    const H = this.o.histLen
    let s = 0
    let sw = 0
    for (let i = 0; i < this.n; i++) {
      if (this.w[i] === 0) continue
      const x = k < 0 ? this.x[i] : this.hist[(i * H + k) * 2]
      const y = k < 0 ? this.y[i] : this.hist[(i * H + k) * 2 + 1]
      const l = lik(x, y)
      s += this.w[i] * l
      sw += this.w[i]
      this.w[i] *= l
    }
    return sw > 0 ? s / sw : 0
  }

  /** share of the particle weight for which pred(x, y) holds */
  weightShare(pred: (x: number, y: number) => boolean): number {
    let s = 0
    let sw = 0
    for (let i = 0; i < this.n; i++) {
      if (this.w[i] === 0) continue
      sw += this.w[i]
      if (pred(this.x[i], this.y[i])) s += this.w[i]
    }
    return sw > 0 ? s / sw : 0
  }

  weightMagnetic(zB: number, zV: number, grid: MagGrid, o: MagOptions): number {
    return magLikelihood(this.x, this.y, this.w, this.n, zB, zV, grid, this.mag, o, this.ll)
  }

  /** Normalise; returns the effective sample size. Resets to uniform weights if everything vanished. */
  normalize(): number {
    let s = 0
    for (let i = 0; i < this.n; i++) s += this.w[i]
    if (!(s > 0) || !Number.isFinite(s)) {
      this.w.fill(1 / this.n)
      return this.n
    }
    let s2 = 0
    for (let i = 0; i < this.n; i++) {
      this.w[i] /= s
      s2 += this.w[i] * this.w[i]
    }
    return 1 / s2
  }

  /** Normalise and resample when the ESS is low. Returns true if resampled. */
  maybeResample(): boolean {
    const ess = this.normalize()
    if (ess >= this.o.essFrac * this.n) return false
    this.resample()
    return true
  }

  resample() {
    const { n } = this
    const H = this.o.histLen
    const idx = new Int32Array(n)
    const step = 1 / n
    let u = this.rng() * step
    let c = this.w[0]
    let j = 0
    for (let i = 0; i < n; i++) {
      while (u > c && j < n - 1) c += this.w[++j]
      idx[i] = j
      u += step
    }
    const pick = (a: Float64Array) => {
      const b = new Float64Array(n)
      for (let i = 0; i < n; i++) b[i] = a[idx[i]]
      return b
    }
    this.x = pick(this.x)
    this.y = pick(this.y)
    this.h = pick(this.h)
    this.sc = pick(this.sc)
    this.mag = { sumB: pick(this.mag.sumB), sumV: pick(this.mag.sumV), count: pick(this.mag.count) }
    const hist = new Float32Array(this.hist.length)
    for (let i = 0; i < n; i++) hist.set(this.hist.subarray(idx[i] * H * 2, (idx[i] + 1) * H * 2), i * H * 2)
    this.hist = hist
    this.w.fill(1 / n)
    // roughening keeps duplicates from collapsing onto one hypothesis
    for (let i = 0; i < n; i++) {
      const nx = this.x[i] + this.gauss() * this.o.roughenM
      const ny = this.y[i] + this.gauss() * this.o.roughenM
      if (this.grid.segmentFree(this.x[i], this.y[i], nx, ny)) {
        this.x[i] = nx
        this.y[i] = ny
      }
      this.h[i] += this.gauss() * 0.01
    }
  }

  estimate(yaw: number): PfEstimate {
    let sw = 0, mx = 0, my = 0, c = 0, s = 0, s2 = 0
    for (let i = 0; i < this.n; i++) {
      const w = this.w[i]
      sw += w
      mx += w * this.x[i]
      my += w * this.y[i]
      c += w * Math.cos(yaw + this.h[i])
      s += w * Math.sin(yaw + this.h[i])
      s2 += w * w
    }
    if (!(sw > 0)) return { x: NaN, y: NaN, spread: Infinity, heading: 0, headingConc: 0, ess: 0 }
    mx /= sw
    my /= sw
    let v = 0
    for (let i = 0; i < this.n; i++) v += this.w[i] * ((this.x[i] - mx) ** 2 + (this.y[i] - my) ** 2)
    return {
      x: mx, y: my, spread: Math.sqrt(v / sw), heading: Math.atan2(s, c), headingConc: Math.hypot(c, s) / sw,
      ess: (sw * sw) / s2,
    }
  }
}
