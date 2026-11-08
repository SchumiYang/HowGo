import { describe, expect, it } from 'vitest'
import type { SensorBatch, Vec3Sample } from '../bridge/townpass'
import { Pdr } from './pdr'

const G = 9.80665

/** 50 Hz samples, delivered in 200 ms batches. up = gravity direction in the device frame. */
function simulate(seconds: number, opts: { stepHz?: number; amp?: number; yawRate?: number; up?: [number, number, number] } = {}) {
  const { stepHz = 1.8, amp = 2.5, yawRate = 0, up = [0, 0, 1] } = opts
  const batches: SensorBatch[] = []
  const t0 = 1_800_000_000_000
  let cur: SensorBatch = { accelerometer: [], gyroscope: [], magnetometer: [] }
  for (let k = 0; k < seconds * 50; k++) {
    const t = t0 + k * 20
    const s = G + amp * Math.sin(2 * Math.PI * stepHz * k * 0.02)
    const a: Vec3Sample = [t, up[0] * s, up[1] * s, up[2] * s]
    cur.accelerometer!.push(a)
    cur.gyroscope!.push([t + 3, up[0] * yawRate, up[1] * yawRate, up[2] * yawRate])
    cur.magnetometer!.push([t + 7, 0, 36, -26])
    if (k % 10 === 9) {
      batches.push(cur)
      cur = { accelerometer: [], gyroscope: [], magnetometer: [] }
    }
  }
  return batches
}

describe('Pdr', () => {
  it('counts steps of a 1.8 Hz walking signal', () => {
    const pdr = new Pdr()
    const steps = simulate(10).flatMap((b) => pdr.push(b))
    // filters settle in the first ~0.5 s
    expect(steps.length).toBeGreaterThanOrEqual(16)
    expect(steps.length).toBeLessThanOrEqual(19)
    for (const s of steps.slice(2)) {
      expect(s.length).toBeGreaterThan(0.5)
      expect(s.length).toBeLessThan(0.9)
      expect(s.magB).toBeCloseTo(Math.hypot(36, 26), 3)
      expect(s.magBv).toBeCloseTo(-26, 3)
    }
  })

  it('keeps counting steps when the accelerometer switches rate mid-stream (A71: 50 <-> 125 Hz)', () => {
    const pdr = new Pdr()
    const t0 = 1_800_000_000_000
    const batch: SensorBatch = { accelerometer: [] }
    let t = 0
    while (t < 30000) {
      const period = Math.floor(t / 10000) === 1 ? 8 : 20 // 50 Hz, then 125 Hz, then 50 Hz again
      const s = G + 2.5 * Math.sin(2 * Math.PI * 1.8 * (t / 1000))
      batch.accelerometer!.push([t0 + t, 0, 0, s])
      t += period
    }
    const steps = pdr.push(batch)
    const inFast = steps.filter((s) => s.t - t0 >= 10500 && s.t - t0 < 19500).length
    expect(steps.length).toBeGreaterThanOrEqual(52)
    expect(steps.length).toBeLessThanOrEqual(55)
    expect(inFast).toBeGreaterThanOrEqual(15)
    expect(inFast).toBeLessThanOrEqual(17)
  })

  it('detects no steps while standing still', () => {
    const pdr = new Pdr()
    expect(simulate(5, { amp: 0.05 }).flatMap((b) => pdr.push(b))).toHaveLength(0)
  })

  it('respects the minimum step interval', () => {
    const pdr = new Pdr()
    const steps = simulate(5, { stepHz: 5 }).flatMap((b) => pdr.push(b))
    for (let i = 1; i < steps.length; i++) expect(steps[i].t - steps[i - 1].t).toBeGreaterThanOrEqual(300)
  })

  it('integrates yaw about gravity, for a flat and a tilted phone', () => {
    for (const up of [[0, 0, 1], [0, Math.sin(0.5), Math.cos(0.5)]] as [number, number, number][]) {
      const pdr = new Pdr()
      simulate(2, { yawRate: 0.5, up }).forEach((b) => pdr.push(b))
      expect(pdr.yaw).toBeCloseTo(1.0, 1)
    }
  })

  it('gives a compass heading relative to magnetic north', () => {
    const pdr = new Pdr()
    // phone flat, top pointing along the horizontal field (north): heading 0
    simulate(3, { amp: 0 }).forEach((b) => pdr.push(b))
    expect(pdr.compass).not.toBeNull()
    expect(Math.abs(pdr.compass!)).toBeLessThan(0.05)
  })
})
