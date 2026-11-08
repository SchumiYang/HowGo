import { describe, expect, it } from 'vitest'
import type { NavFeature } from '../data/types'
import type { XY } from '../geo/frame'
import { corridorEdges, runLength, uncoveredRuns } from './mapping/coverage'
import { errorStats, initialHeading, runId, snap, truthAt } from './eval/evalMath'

const node = (id: string, level: string, c: XY): NavFeature => ({ type: 'Feature', geometry: { type: 'Point', coordinates: c }, properties: { kind: 'node', id, level } })
const edge = (from: string, to: string, coords: XY[], type = 'corridor'): NavFeature => ({
  type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: { kind: 'edge', from, to, type, accessible: true, length_m: 0 },
})

describe('coverage', () => {
  const nav = [
    node('a', '1F', [0, 0]), node('b', '1F', [20, 0]), node('c', '1F', [20, 20]), node('d', '2F', [0, 0]), node('e', '2F', [5, 0]),
    edge('a', 'b', [[0, 0], [20, 0]]), edge('b', 'c', [[20, 0], [20, 20]]), edge('d', 'e', [[0, 0], [5, 0]]), edge('a', 'c', [[0, 0], [20, 20]], 'stairs'),
  ]
  it('picks corridor edges of one level', () => {
    expect(corridorEdges(nav, '1F').map((e) => e.id)).toEqual(['a~b', 'b~c'])
    expect(corridorEdges(nav, '2F').map((e) => e.id)).toEqual(['d~e'])
  })
  it('reports the unwalked corridor only', () => {
    const runs = uncoveredRuns(corridorEdges(nav, '1F'), [[[0, 0], [20, 0]]], [], { radius: 2, step: 1 })
    expect(runs).toHaveLength(1)
    expect(runs[0][0][0]).toBe(20)
    expect(runs[0][0][1]).toBeGreaterThan(2)
    expect(runLength(runs[0])).toBeGreaterThan(15)
  })
  it('counts data points (magmap cells) as coverage', () => {
    const cells: XY[] = []
    for (let y = 0; y <= 20; y += 0.5) cells.push([20, y])
    expect(uncoveredRuns(corridorEdges(nav, '1F'), [[[0, 0], [20, 0]]], cells, { radius: 2 })).toHaveLength(0)
  })
})

describe('eval math', () => {
  const walk = { path: [[0, 0], [10, 0], [10, 10]] as XY[], t_start: 0, t_end: 20000, marks: [{ t: 5000, vertex: 1 }] }
  it('interpolates truth between t_start, marks and t_end by arc length', () => {
    expect(truthAt(walk, 0)).toEqual([0, 0])
    expect(truthAt(walk, 2500)).toEqual([5, 0])
    expect(truthAt(walk, 5000)).toEqual([10, 0])
    expect(truthAt(walk, 12500)).toEqual([10, 5])
    expect(truthAt(walk, 99999)).toEqual([10, 10])
    // without marks: constant speed over the whole path
    expect(truthAt({ ...walk, marks: [] }, 5000)).toEqual([5, 0])
  })
  it('stats, heading, snapping, run id', () => {
    expect(errorStats([3, 1, 2, null])).toEqual({ n: 3, median_m: 2, p90_m: 3, max_m: 3 })
    expect(initialHeading([[0, 0], [1, 0]])).toBe(90)
    expect(initialHeading([[0, 0], [0, 1]])).toBe(0)
    expect(snap([1, 1], [{ id: 'p', xy: [2, 1] }], 2)).toEqual({ xy: [2, 1], id: 'p' })
    expect(snap([1, 1], [{ id: 'p', xy: [9, 9] }], 2)).toEqual({ xy: [1, 1], id: null })
    expect(runId(new Date(2026, 10, 7, 17, 0, 5), 'Pixel 9a')).toBe('20261107-170005-pixel9a')
  })
})
