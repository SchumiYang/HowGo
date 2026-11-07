import { describe, expect, it } from 'vitest'
import type { NavFeature, UnitFeature, WallFeature } from '../data/types'
import type { XY } from '../geo/frame'
import { OccupancyGrid } from './grid'

const unit = (id: string, category: string, ring: XY[]): UnitFeature => ({
  type: 'Feature', geometry: { type: 'Polygon', coordinates: [ring] }, properties: { id, level: '1F', category },
})
const wall = (a: XY, b: XY, layer: WallFeature['properties']['layer'] = 'wall'): WallFeature => ({
  type: 'Feature', geometry: { type: 'LineString', coordinates: [a, b] }, properties: { layer },
})
const node = (id: string, p: XY): NavFeature => ({
  type: 'Feature', geometry: { type: 'Point', coordinates: p }, properties: { kind: 'node', id, level: '1F' },
})
const edge = (from: string, to: string, a: XY, b: XY, type = 'door'): NavFeature => ({
  type: 'Feature', geometry: { type: 'LineString', coordinates: [a, b] },
  properties: { kind: 'edge', from, to, type, accessible: true, length_m: 2 },
})

// 20 x 4 m corridor, cut in half by a wall at x = 10 with a door (nav edge) at y = 2
const units = [unit('c', 'corridor', [[0, 0], [20, 0], [20, 4], [0, 4], [0, 0]]), unit('r', 'nonpublic', [[0, 4], [20, 4], [20, 8], [0, 8], [0, 4]])]
const walls = [wall([10, 0], [10, 4]), wall([5, 1], [5, 1.5], 'fixture')]
const nav = [node('a', [9, 2]), node('b', [11, 2]), edge('a', 'b', [9, 2], [11, 2])]

describe('OccupancyGrid', () => {
  const g = OccupancyGrid.build({ level: '1F', units, walls, nav })

  it('marks walkable units free and everything else blocked', () => {
    expect(g.isFree(2, 2)).toBe(true)
    expect(g.isFree(2, 6)).toBe(false) // nonpublic
    expect(g.isFree(-2, 2)).toBe(false)
    expect(g.isFree(5, 1.2)).toBe(true) // fixtures do not block
  })

  it('blocks wall crossings except through carved nav openings', () => {
    expect(g.segmentFree(8, 0.5, 12, 0.5)).toBe(false)
    expect(g.segmentFree(8, 3.5, 12, 3.5)).toBe(false)
    expect(g.segmentFree(8, 2, 12, 2)).toBe(true)
    expect(g.segmentFree(2, 1, 8, 3)).toBe(true)
  })

  it('never slips diagonally through a wall', () => {
    for (let k = 0; k < 200; k++) {
      const y0 = 0.05 + (k % 20) * 0.02 // below the door opening (doors are carved 1 m wide)
      expect(g.segmentFree(9.6, y0, 10.4, y0 + 0.37)).toBe(false)
    }
  })

  it('does not leave the grid', () => {
    expect(g.segmentFree(19, 2, 30, 2)).toBe(false)
  })
})
