import { describe, expect, it } from 'vitest'
import { haversine, lngLatToLocal, localToLngLat, makeFrame, type XY } from './frame'
import { labelPoint, pointInPolygon, turnAngle } from './geometry'

const origin = { lng: 121.5335, lat: 25.1155 }

describe('frame conversion', () => {
  it('maps the origin to itself', () => {
    expect(localToLngLat([0, 0], { origin, bearingDeg: 37 })).toEqual([origin.lng, origin.lat])
  })

  it('bearing 0: +y is north, +x is east', () => {
    const f = makeFrame({ origin, bearingDeg: 0 })
    const [lngN, latN] = f.toLngLat([0, 100])
    expect(lngN).toBeCloseTo(origin.lng, 12)
    expect(latN).toBeGreaterThan(origin.lat)
    const [lngE, latE] = f.toLngLat([100, 0])
    expect(latE).toBeCloseTo(origin.lat, 12)
    expect(lngE).toBeGreaterThan(origin.lng)
  })

  it('bearing 90: +y points east, +x points south', () => {
    const f = makeFrame({ origin, bearingDeg: 90 })
    const [lng, lat] = f.toLngLat([0, 50])
    expect(lat).toBeCloseTo(origin.lat, 10)
    expect(lng).toBeGreaterThan(origin.lng)
    const [, latS] = f.toLngLat([50, 0])
    expect(latS).toBeLessThan(origin.lat)
  })

  it('preserves distances within 1 cm over the building extent (vs haversine)', () => {
    for (const bearingDeg of [0, 23.5, -0.39, -120]) {
      const f = makeFrame({ origin, bearingDeg })
      const pts: XY[] = [[0, 0], [85, 0], [0, 67], [85, 67], [42, 33]]
      for (const a of pts) {
        for (const b of pts) {
          const d = Math.hypot(b[0] - a[0], b[1] - a[1])
          expect(Math.abs(haversine(f.toLngLat(a), f.toLngLat(b)) - d)).toBeLessThan(0.01)
        }
      }
    }
  })

  it('round-trips local -> lnglat -> local', () => {
    for (const bearingDeg of [0, 15, 200]) {
      for (const p of [[0, 0], [85, 67], [-10, 30], [12.34, -5.6]] as XY[]) {
        const back = lngLatToLocal(localToLngLat(p, { origin, bearingDeg }), { origin, bearingDeg })
        expect(back[0]).toBeCloseTo(p[0], 6)
        expect(back[1]).toBeCloseTo(p[1], 6)
      }
    }
  })
})

describe('geometry helpers', () => {
  it('labelPoint stays inside a ring corridor (centroid falls in the hole)', () => {
    const outer: XY[] = [[0, 0], [60, 0], [60, 40], [0, 40], [0, 0]]
    const hole: XY[] = [[8, 6], [8, 34], [52, 34], [52, 6], [8, 6]]
    const p = labelPoint([outer, hole])
    expect(pointInPolygon(p, [outer, hole])).toBe(true)
  })

  it('turnAngle: left is positive with y up', () => {
    expect(turnAngle([0, 0], [10, 0], [10, 10])).toBeCloseTo(90)
    expect(turnAngle([0, 0], [10, 0], [10, -10])).toBeCloseTo(-90)
  })
})
