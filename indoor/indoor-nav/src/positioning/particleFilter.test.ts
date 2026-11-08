import { describe, expect, it } from 'vitest'
import type { UnitFeature, WallFeature } from '../data/types'
import type { XY } from '../geo/frame'
import { OccupancyGrid } from './grid'
import { MagGrid } from './magnetic'
import { ParticleFilter } from './particleFilter'
import type { StepEvent } from './pdr'
import { mulberry32 } from './rng'

const unit = (ring: XY[]): UnitFeature => ({
  type: 'Feature', geometry: { type: 'Polygon', coordinates: [ring] }, properties: { id: 'c', level: '1F', category: 'corridor' },
})
const wall = (a: XY, b: XY): WallFeature => ({ type: 'Feature', geometry: { type: 'LineString', coordinates: [a, b] }, properties: { layer: 'wall' } })

// L-shaped corridor: 40 m east-west (y 0..2.5) + 30 m north (x 37.5..40)
const ring: XY[] = [[0, 0], [40, 0], [40, 30], [37.5, 30], [37.5, 2.5], [0, 2.5], [0, 0]]
const grid = OccupancyGrid.build({ level: '1F', units: [unit(ring)], walls: ring.slice(1).map((p, i) => wall(ring[i], p)) })
const step = (t: number, yaw: number, length = 0.7): StepEvent => ({ t, length, yaw, dYaw: 0, dt: 0.55, magB: null, magBv: null, compass: null })

describe('ParticleFilter', () => {
  it('tracks a walk along a corridor from a known start', () => {
    const pf = new ParticleFilter(grid, { n: 600 }, mulberry32(3))
    pf.init([{ x: 1.5, y: 1.25, w: 1 }], 0.5, { mean: 0, sigma: 0.1, uniformFrac: 0 }, 0)
    for (let k = 0; k < 30; k++) {
      pf.predict(step(k * 550, 0))
      pf.maybeResample()
    }
    const e = pf.estimate(0)
    expect(e.x).toBeGreaterThan(17)
    expect(e.x).toBeLessThan(27)
    expect(e.y).toBeGreaterThan(0)
    expect(e.y).toBeLessThan(2.5)
  })

  it('resolves an unknown heading from the walls', () => {
    const pf = new ParticleFilter(grid, { n: 1000 }, mulberry32(5))
    // PDR yaw frame is rotated by 1 rad against the map; the filter must learn the offset
    const yawOffset = 1
    pf.init([{ x: 5, y: 1.25, w: 1 }], 0.3, { mean: null, sigma: 0, uniformFrac: 1 }, 0)
    for (let k = 0; k < 25; k++) {
      pf.predict(step(k * 550, -yawOffset))
      pf.maybeResample()
    }
    const e = pf.estimate(-yawOffset)
    // walking +x (east) or −x both fit a straight corridor; after 17 m only east remains (wall at x = 0)
    expect(Math.abs(Math.atan2(Math.sin(e.heading), Math.cos(e.heading)))).toBeLessThan(0.2)
    expect(e.x).toBeGreaterThan(15)
  })

  it('never moves through a wall: a step every particle is blocked on leaves them where they are', () => {
    // a 2 x 2 m room: a 3 m step is blocked whichever way a particle tries
    const room: XY[] = [[0, 0], [2, 0], [2, 2], [0, 2], [0, 0]]
    const g = OccupancyGrid.build({ level: '1F', units: [unit(room)], walls: room.slice(1).map((p, i) => wall(room[i], p)) })
    const pf = new ParticleFilter(g, { n: 400 }, mulberry32(4))
    pf.init([{ x: 1, y: 1, w: 1 }], 0.2, { mean: 0, sigma: 0.01, uniformFrac: 0 }, 0)
    const before = [Array.from(pf.x), Array.from(pf.y)]
    const h0 = Array.from(pf.h)
    pf.predict(step(0, 0, 3))
    expect(pf.lostSteps).toBe(1)
    for (let i = 0; i < pf.n; i++) {
      expect([pf.x[i], pf.y[i]]).toEqual([before[0][i], before[1][i]])
      expect(g.isFree(pf.x[i], pf.y[i])).toBe(true)
    }
    // headings widened (about 20 degrees), so the next steps can find a way round
    const dh = Array.from(pf.h).map((h, i) => Math.abs(h - h0[i]))
    expect(dh.reduce((a, b) => a + b, 0) / dh.length).toBeGreaterThan(0.1)
  })

  it('turns the corner and keeps particles inside the map', () => {
    const pf = new ParticleFilter(grid, { n: 600 }, mulberry32(9))
    pf.init([{ x: 30, y: 1.25, w: 1 }], 0.3, { mean: 0, sigma: 0.05, uniformFrac: 0 }, 0)
    for (let k = 0; k < 12; k++) pf.predict(step(k * 550, 0)), pf.maybeResample()
    for (let k = 12; k < 30; k++) pf.predict(step(k * 550, Math.PI / 2)), pf.maybeResample()
    const e = pf.estimate(Math.PI / 2)
    expect(e.x).toBeGreaterThan(37)
    expect(e.y).toBeGreaterThan(6)
    for (let i = 0; i < pf.n; i++) if (pf.w[i] > 0) expect(grid.isFree(pf.x[i], pf.y[i])).toBe(true)
  })

  it('prefers the track whose magnetic profile matches, despite a device offset', () => {
    // map: |B| ramps along the corridor; two hypotheses, at x = 5 and x = 25, both walking east
    const cells = []
    for (let x = 0.25; x < 40; x += 0.5) for (const y of [0.75, 1.25, 1.75]) cells.push({ x, y, B: 40 + 8 * Math.sin(x / 3), Bv: -25 + 4 * Math.cos(x / 4), Bh: 30, n: 5 })
    const mg = new MagGrid({ level: '1F', cell_m: 0.5, cells })
    const pf = new ParticleFilter(grid, { n: 800 }, mulberry32(11))
    pf.init([{ x: 5, y: 1.25, w: 1 }, { x: 25, y: 1.25, w: 1 }], 0.3, { mean: 0, sigma: 0.03, uniformFrac: 0 }, 0)
    const bias = 4 // device reads 4 µT high on both features
    let truthX = 25
    for (let k = 0; k < 20; k++) {
      truthX += 0.7
      pf.predict(step(k * 550, 0))
      pf.weightMagnetic(40 + 8 * Math.sin(truthX / 3) + bias, -25 + 4 * Math.cos(truthX / 4) + bias, mg,
        { sigmaB: 1.5, sigmaV: 1.5, biasSigma: 6, forget: 0.95, temper: 1, floor: 0.05, fillRadiusM: 1, useBv: true })
      pf.maybeResample()
    }
    expect(Math.abs(pf.estimate(0).x - truthX)).toBeLessThan(2.5)
  })
})
