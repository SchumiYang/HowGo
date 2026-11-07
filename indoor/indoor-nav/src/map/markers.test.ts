import { describe, expect, it } from 'vitest'
import { accuracyOpacity, circleRing, wedgeRing } from './markers'

describe('ground-plane marker shapes', () => {
  it('circleRing is a closed ring at the given radius (metres)', () => {
    const r = circleRing([10, 20], 35)
    expect(r).toHaveLength(65)
    expect(r[0]).toEqual(r[64])
    for (const [x, y] of r) expect(Math.hypot(x - 10, y - 20)).toBeCloseTo(35, 9)
  })

  it('wedgeRing points along the heading (clockwise from +y) with the requested spread', () => {
    const w = wedgeRing([0, 0], 90, 6, 25) // east
    expect(w[0]).toEqual([0, 0])
    expect(w.at(-1)).toEqual([0, 0])
    const arc = w.slice(1, -1)
    const mid = arc[Math.floor(arc.length / 2)]
    expect(mid[0]).toBeCloseTo(6, 9)
    expect(mid[1]).toBeCloseTo(0, 9)
    const angles = arc.map(([x, y]) => (Math.atan2(x, y) * 180) / Math.PI)
    expect(Math.min(...angles)).toBeCloseTo(65, 6)
    expect(Math.max(...angles)).toBeCloseTo(115, 6)
  })

  it('accuracyOpacity fades out for huge circles', () => {
    expect(accuracyOpacity(2)).toBe(0.25)
    expect(accuracyOpacity(15)).toBeCloseTo(0.15, 9)
    expect(accuracyOpacity(35)).toBe(0.07)
    expect(accuracyOpacity(25)).toBeLessThan(accuracyOpacity(10))
  })
})
