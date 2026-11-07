/**
 * Pedestrian dead reckoning from the raw sensor_stream (device frame, any phone pose).
 *
 * - Gravity: first-order low-pass of the accelerometer -> up unit vector u (device frame).
 * - Steps: |a| resampled to a uniform 50 Hz clock, band-passed (~1–3 Hz), peak detection with an adaptive threshold, a valley required between peaks
 *   and a minimum step interval. Step length: Weinberg L = K · (a_max − a_min)^¼ over the step window.
 * - Heading: gyroscope projected on u (yaw rate about the vertical), integrated -> relative yaw (rad, CCW +).
 *   Gyro bias is re-estimated while the phone is stationary.
 * - Per step: mean |B| and Bv = B·u (orientation-invariant magnetic features) and a magnetometer compass heading,
 *   which is unreliable indoors and only used by the filter as a weak initial prior.
 */
import type { SensorBatch } from '../bridge/townpass'
import { Biquad } from './filters'

const G = 9.80665

export interface PdrOptions {
  /** Weinberg constant; 0.45 gives ~0.65–0.7 m for normal walking. The particle filter refines a per-user scale. */
  weinbergK: number
  minStepIntervalS: number
  bandHz: [number, number]
  /** floor of the adaptive peak threshold (m/s², band-passed |a|) */
  minPeak: number
  /** threshold = max(minPeak, peakFrac · running mean peak height) */
  peakFrac: number
  gravityTauS: number
}

/** The step detector runs on a uniform clock: phones switch accelerometer rate mid-stream (A71: 50 <-> 125 Hz when
 *  another listener asks for more), so |a| is resampled to this rate instead of designing filters for one rate. */
const STEP_FS = 50
const STEP_DT_MS = 1000 / STEP_FS

export const DEFAULT_PDR: PdrOptions = {
  weinbergK: 0.45,
  minStepIntervalS: 0.3,
  bandHz: [0.9, 3.0],
  minPeak: 0.5,
  peakFrac: 0.4,
  gravityTauS: 0.8,
}

export interface StepEvent {
  /** epoch ms of the step (acceleration peak) */
  t: number
  /** metres, before the filter's per-user scale */
  length: number
  /** integrated relative yaw at the step (rad, CCW positive) */
  yaw: number
  dYaw: number
  /** seconds since the previous step (capped) */
  dt: number
  /** mean |B| and B·up over the step (µT), null without magnetometer samples */
  magB: number | null
  magBv: number | null
  /** walking-direction heading from the magnetometer: rad CCW from magnetic north; weak prior only */
  compass: number | null
}

type V3 = [number, number, number]

export class Pdr {
  readonly opts: PdrOptions
  steps = 0
  private up: V3 = [0, 0, 1]
  private grav: V3 | null = null
  private tAcc = -1
  private tGyr = -1
  private yawRad = 0
  private bias: V3 = [0, 0, 0]
  private readonly hp: Biquad
  private readonly lp: Biquad
  /** next tick of the uniform step-detector clock, and the previous accelerometer sample (t, |a| − g) */
  private tick = -1
  private prevT = -1
  private prevD = 0
  private s1 = 0
  private s2 = 0
  private t1 = 0
  private winMax = -Infinity
  private winMin = Infinity
  private sawValley = true
  private peakAvg: number
  private lastStepT = -Infinity
  private lastStepYaw = 0
  private magSumB = 0
  private magSumV = 0
  private magN = 0
  private compassC = 0
  private compassS = 0
  private motionVar = 1
  private lastMoveT = -Infinity

  constructor(opts: Partial<PdrOptions> = {}) {
    this.opts = { ...DEFAULT_PDR, ...opts }
    this.peakAvg = this.opts.minPeak
    this.hp = Biquad.highpass(this.opts.bandHz[0], STEP_FS)
    this.lp = Biquad.lowpass(this.opts.bandHz[1], STEP_FS)
  }

  get yaw(): number {
    return this.yawRad
  }

  /** latest magnetometer compass (rad CCW from magnetic north of the walking direction), null if unknown */
  get compass(): number | null {
    return this.compassC || this.compassS ? Math.atan2(this.compassS, this.compassC) : null
  }

  get stationary(): boolean {
    return this.motionVar < 0.03 && this.tAcc - this.lastMoveT > 1000
  }

  /** Process one sensor_stream batch; samples of all sensors are merged in time order. */
  push(batch: SensorBatch): StepEvent[] {
    const ev: [number, number, number, number, number][] = []
    for (const s of batch.accelerometer ?? []) ev.push([s[0], 0, s[1], s[2], s[3]])
    for (const s of batch.gyroscope ?? []) ev.push([s[0], 1, s[1], s[2], s[3]])
    for (const s of batch.magnetometer ?? []) ev.push([s[0], 2, s[1], s[2], s[3]])
    ev.sort((a, b) => a[0] - b[0])
    const out: StepEvent[] = []
    for (const [t, k, x, y, z] of ev) {
      if (k === 0) {
        const st = this.accel(t, x, y, z)
        if (st) out.push(st)
      } else if (k === 1) this.gyro(t, x, y, z)
      else this.mag(x, y, z)
    }
    return out
  }

  private accel(t: number, x: number, y: number, z: number): StepEvent | null {
    if (this.tAcc >= 0 && t <= this.tAcc) return null
    const dt = this.tAcc < 0 ? 0.02 : Math.min((t - this.tAcc) / 1000, 0.5)
    this.tAcc = t
    if (!this.grav) this.grav = [x, y, z]
    else {
      const a = dt / (this.opts.gravityTauS + dt)
      this.grav[0] += a * (x - this.grav[0])
      this.grav[1] += a * (y - this.grav[1])
      this.grav[2] += a * (z - this.grav[2])
    }
    const gn = Math.hypot(this.grav[0], this.grav[1], this.grav[2]) || 1
    this.up = [this.grav[0] / gn, this.grav[1] / gn, this.grav[2] / gn]
    const d = Math.hypot(x, y, z) - G
    this.motionVar += (dt / (0.5 + dt)) * (d * d - this.motionVar)
    if (this.motionVar > 0.1) this.lastMoveT = t

    // resample onto the uniform clock (linear interpolation; a gap > 0.5 s restarts the clock)
    let step: StepEvent | null = null
    if (this.prevT < 0 || t - this.prevT > 500) this.tick = t
    else {
      for (; this.tick <= t; this.tick += STEP_DT_MS) {
        const v = this.prevD + ((this.tick - this.prevT) / (t - this.prevT)) * (d - this.prevD)
        step = this.detect(this.tick, this.lp.process(this.hp.process(v))) ?? step
      }
    }
    this.prevT = t
    this.prevD = d
    return step
  }

  /** one sample s of the band-passed |a| at uniform time t */
  private detect(t: number, s: number): StepEvent | null {
    if (s > this.winMax) this.winMax = s
    if (s < this.winMin) this.winMin = s
    if (t - this.lastStepT > 2000) this.peakAvg = this.opts.minPeak
    const thr = Math.max(this.opts.minPeak, this.opts.peakFrac * this.peakAvg)
    if (s < -0.3 * thr) this.sawValley = true

    let step: StepEvent | null = null
    if (this.s1 > this.s2 && this.s1 >= s && this.s1 > thr && this.sawValley &&
        (this.t1 - this.lastStepT) / 1000 >= this.opts.minStepIntervalS) {
      const p2p = Math.max(this.winMax - this.winMin, 0)
      const length = Math.min(1.2, Math.max(0.25, this.opts.weinbergK * Math.sqrt(Math.sqrt(p2p))))
      const gap = (this.t1 - this.lastStepT) / 1000
      this.peakAvg = gap < 2 ? this.peakAvg + 0.25 * (this.s1 - this.peakAvg) : this.s1
      step = {
        t: this.t1,
        length,
        yaw: this.yawRad,
        dYaw: this.yawRad - this.lastStepYaw,
        dt: Number.isFinite(gap) ? Math.min(gap, 2) : 0.6,
        magB: this.magN ? this.magSumB / this.magN : null,
        magBv: this.magN ? this.magSumV / this.magN : null,
        compass: this.compass,
      }
      this.steps++
      this.lastStepT = this.t1
      this.lastMoveT = this.t1
      this.lastStepYaw = this.yawRad
      this.winMax = this.winMin = s
      this.sawValley = false
      this.magSumB = this.magSumV = this.magN = 0
    }
    this.s2 = this.s1
    this.s1 = s
    this.t1 = t
    return step
  }

  private gyro(t: number, x: number, y: number, z: number) {
    if (this.tGyr >= 0 && t <= this.tGyr) return
    const dt = this.tGyr < 0 ? 0 : Math.min((t - this.tGyr) / 1000, 0.2)
    this.tGyr = t
    // Android already removes most gyro bias. Learn the residual only when the phone is really still (resting, not
    // hand-held: hand sway averaged over a few seconds would be mistaken for bias), slowly and clamped.
    if (this.stationary && this.motionVar < 0.01 && Math.hypot(x - this.bias[0], y - this.bias[1], z - this.bias[2]) < 0.02) {
      const a = 0.002
      this.bias[0] = Math.max(-0.02, Math.min(0.02, this.bias[0] + a * (x - this.bias[0])))
      this.bias[1] = Math.max(-0.02, Math.min(0.02, this.bias[1] + a * (y - this.bias[1])))
      this.bias[2] = Math.max(-0.02, Math.min(0.02, this.bias[2] + a * (z - this.bias[2])))
    }
    const u = this.up
    this.yawRad += ((x - this.bias[0]) * u[0] + (y - this.bias[1]) * u[1] + (z - this.bias[2]) * u[2]) * dt
  }

  private mag(x: number, y: number, z: number) {
    const u = this.up
    const B = Math.hypot(x, y, z)
    const Bv = x * u[0] + y * u[1] + z * u[2]
    this.magSumB += B
    this.magSumV += Bv
    this.magN++
    // walking direction in the device frame: top of the phone (+y), or out of the back when held upright
    let f: V3 = Math.abs(u[1]) > 0.8 ? [0, 0, -1] : [0, 1, 0]
    const fu = f[0] * u[0] + f[1] * u[1] + f[2] * u[2]
    f = [f[0] - fu * u[0], f[1] - fu * u[1], f[2] - fu * u[2]]
    const mh: V3 = [x - Bv * u[0], y - Bv * u[1], z - Bv * u[2]]
    // signed angle from horizontal B (magnetic north) to f about up
    const cx = mh[1] * f[2] - mh[2] * f[1]
    const cy = mh[2] * f[0] - mh[0] * f[2]
    const cz = mh[0] * f[1] - mh[1] * f[0]
    const psi = Math.atan2(cx * u[0] + cy * u[1] + cz * u[2], mh[0] * f[0] + mh[1] * f[1] + mh[2] * f[2])
    this.compassC += 0.05 * (Math.cos(psi) - this.compassC)
    this.compassS += 0.05 * (Math.sin(psi) - this.compassS)
  }
}
