import { describe, expect, it } from 'vitest'
import type { UnitFeature } from '../data/types'
import {
  apCentroid, apStats, cellCenter, coverageFraction, coverageLabel, defaultAp, fieldPixels, gridCorners, interpolateField, makeGrid,
  quantile, rampColor, unitMask,
} from './mapping/heatmap'

const unit = (category: string, x0: number, y0: number, x1: number, y1: number): UnitFeature => ({
  type: 'Feature',
  geometry: { type: 'Polygon', coordinates: [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]] },
  properties: { id: category, category } as UnitFeature['properties'],
})

describe('grid', () => {
  const g = makeGrid([0, 0, 10, 4], 1)
  it('has image orientation (row 0 = top) and TL/TR/BR/BL corners', () => {
    expect([g.cols, g.rows]).toEqual([10, 4])
    expect(cellCenter(g, 0, 0)).toEqual([0.5, 3.5])
    expect(cellCenter(g, 9, 3)).toEqual([9.5, 0.5])
    expect(gridCorners(g)).toEqual([[0, 4], [10, 4], [10, 0], [0, 0]])
  })
})

describe('masking', () => {
  const g = makeGrid([0, 0, 10, 10], 1)
  const units = [unit('corridor', 0, 0, 10, 2), unit('room', 0, 2, 10, 10), unit('lobby', 0, 8, 3, 10)]
  it('marks only cells inside units of the given categories', () => {
    const m = unitMask(g, units, new Set(['corridor', 'lobby']))
    const at = (x: number, y: number) => m[(g.rows - 1 - Math.floor(y)) * g.cols + Math.floor(x)]
    expect(at(5, 1)).toBe(1) // corridor
    expect(at(5, 5)).toBe(0) // room
    expect(at(1, 9)).toBe(1) // lobby
    expect(m.reduce((s, v) => s + v, 0)).toBe(20 + 6)
  })
})

describe('interpolation', () => {
  const g = makeGrid([0, 0, 20, 1], 1)
  it('averages nearby samples, fades with distance, leaves far / masked cells empty', () => {
    const f = interpolateField(g, [{ x: 2.5, y: 0.5, v: 10 }, { x: 6.5, y: 0.5, v: 20 }], null, { radius: 3, sigma: 1, solid: 1 })
    expect(f.values[2]).toBeCloseTo(10, 3) // on the first sample (the other is 4 m away, beyond radius)
    expect(f.values[4]).toBeCloseTo(15, 3) // halfway
    expect(f.alpha[2]).toBe(1)
    expect(f.alpha[8]).toBeCloseTo(0.5, 5) // 2 m from the nearest sample: 1 - (2 - 1) / (3 - 1)
    expect(Number.isNaN(f.values[15])).toBe(true)
    const mask = new Uint8Array(g.cols * g.rows)
    const m = interpolateField(g, [{ x: 2.5, y: 0.5, v: 10 }], mask, { radius: 3, sigma: 1, solid: 1 })
    expect(Number.isNaN(m.values[2])).toBe(true)
  })
  it('colours values on the ramp and makes empty cells transparent', () => {
    expect(rampColor(0)).toEqual([43, 87, 220])
    expect(rampColor(1)).toEqual([225, 50, 40])
    expect(rampColor(-5)).toEqual(rampColor(0))
    const g2 = makeGrid([0, 0, 2, 1], 1)
    const px = fieldPixels(g2, { values: Float32Array.from([0, NaN]), alpha: Float32Array.from([1, 1]) }, 0, 1, 200)
    expect([...px.slice(0, 4)]).toEqual([43, 87, 220, 200])
    expect(px[7]).toBe(0)
  })
  it('quantiles ignore NaN', () => {
    expect(quantile([NaN, 1, 2, 3, 4, 5], 0.5)).toBe(3)
    expect(quantile([NaN], 0.5)).toBeNull()
  })
})

describe('coverage', () => {
  const g = makeGrid([0, 0, 20, 2], 0.5)
  const mask = new Uint8Array(g.cols * g.rows).fill(1)
  it('counts masked area within the radius of walked lines', () => {
    const c = coverageFraction(g, mask, [[[0, 1], [10, 1]]], [], 1.5)
    expect(c.fraction).toBeGreaterThan(0.5)
    expect(c.fraction).toBeLessThan(0.6)
    expect(coverageFraction(g, mask, [], [[19, 1]], 1).covered).toBeGreaterThan(0)
    expect(coverageLabel(0.8).level).toBe('good')
    expect(coverageLabel(0.5).level).toBe('fair')
    expect(coverageLabel(0.1).level).toBe('poor')
  })
})

describe('wifi', () => {
  const pts: { x: number; y: number; aps: Record<string, { mean: number }> }[] = [
    { x: 0, y: 0, aps: { a: { mean: -40 }, b: { mean: -80 } } },
    { x: 10, y: 0, aps: { a: { mean: -70 }, c: { mean: -50 } } },
    { x: 20, y: 0, aps: { a: { mean: -90 } } },
  ]
  it('sorts APs by detections and prefers strong campus APs', () => {
    const st = apStats(pts, { a: { ssids: ['eduroam'] }, c: { ssids: ['uTaipei'] }, b: { ssids: ['Home'] } })
    expect(st.map((s) => s.bssid)).toEqual(['a', 'c', 'b'])
    // only campus APs heard at >= half the best count compete: a (3 hits) beats c (1 hit)
    expect(defaultAp(st)).toBe('a')
    expect(defaultAp(apStats(pts, {}))).toBe('a')
  })
  it('estimates the AP position near its strongest fingerprints', () => {
    const c = apCentroid(pts, 'a')!
    expect(c[0]).toBeLessThan(5)
  })
})
