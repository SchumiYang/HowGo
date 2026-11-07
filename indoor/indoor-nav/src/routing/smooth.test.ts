import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { NavFeature, UnitFeature, WallFeature } from '../data/types'
import type { XY } from '../geo/frame'
import { buildGraph } from './graph'
import { buildSteps } from './instructions'
import { findRoute, type Route } from './route'
import { fixedVertices, LevelGeometry, remapStepIndex, segmentsIntersect, smoothRoute } from './smooth'

const sq = (x0: number, y0: number, x1: number, y1: number): XY[][] => [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]]
const unit = (id: string, category: string, rings: XY[][]): UnitFeature => ({ type: 'Feature', geometry: { type: 'Polygon', coordinates: rings }, properties: { id, level: '1F', category } })
const wall = (c: XY[], layer = 'wall'): WallFeature => ({ type: 'Feature', geometry: { type: 'LineString', coordinates: c }, properties: { layer: layer as WallFeature['properties']['layer'] } })

describe('segment geometry', () => {
  it('segmentsIntersect', () => {
    expect(segmentsIntersect([0, 0], [10, 10], [0, 10], [10, 0])).toBe(true)
    expect(segmentsIntersect([0, 0], [10, 0], [0, 1], [10, 1])).toBe(false)
    expect(segmentsIntersect([0, 0], [10, 0], [5, 0], [5, 5])).toBe(true) // touching
  })

  it('LevelGeometry: walls block, open court is clear, non-walkable rooms block', () => {
    // a 20x20 court with a wall stub inside, a non-walkable room east of it, then a corridor
    const g = new LevelGeometry(
      [unit('court', 'court', sq(0, 0, 20, 20)), unit('room', 'nonpublic', sq(20, 0, 30, 20)), unit('hall', 'corridor', sq(30, 0, 40, 20))],
      [wall([[10, 8], [10, 12]]), wall([[3, 3], [3.4, 3], [3.4, 3.4], [3, 3.4], [3, 3]], 'column'), wall([[0, 0], [5, 0]], 'fixture')],
    )
    expect(g.clear([2, 10], [18, 10])).toBe(false) // through the wall stub
    expect(g.clear([2, 15], [18, 15])).toBe(true)
    expect(g.clear([1, 1], [5, 5])).toBe(false) // through the column
    expect(g.clear([1, 1], [19, 1])).toBe(true) // fixture linework is ignored
    expect(g.clear([15, 10], [35, 10])).toBe(false) // across a non-walkable room
    expect(g.clear([15, 10], [28, 10])).toBe(true) // into the room the leg ends in (walls decide)
  })
})

describe('string pulling', () => {
  const g = new LevelGeometry([unit('court', 'court', sq(0, 0, 30, 30)), unit('corr', 'corridor', sq(-6, 0, 0, 30))], [wall([[0, 0], [0, 20]]), wall([[0, 22], [0, 30]])])
  const P = (x: number, y: number, via?: string, node?: string) => ({ level: '1F', xy: [x, y] as XY, via, node })

  it('replaces a grid zig-zag with a straight leg', () => {
    const r: Route = { points: [P(25, 5), P(20, 5, 'corridor'), P(15, 10, 'corridor'), P(10, 15, 'corridor'), P(5, 20, 'corridor'), P(2, 21, 'corridor')], cost: 30, walkLength: 0, targetIndex: 0 }
    r.walkLength = 5 + 3 * Math.hypot(5, 5) + Math.hypot(3, 1)
    const s = smoothRoute(r, () => g)
    expect(s.points.map((p) => p.xy)).toEqual([[25, 5], [2, 21]])
    expect(s.walkLength).toBeCloseTo(Math.hypot(23, 16), 6)
  })

  it('keeps doorways (door in + door out) and floor changes', () => {
    // the door node at (0,21) sits in the wall gap between the court and the corridor
    const pts = [P(25, 5), P(10, 15, 'corridor'), P(2, 21, 'corridor'), P(0, 21, 'door', 'd'), P(-3, 21, 'door', 'c'), P(-3, 28, 'corridor')]
    expect(fixedVertices(pts)).toEqual([true, false, false, true, false, true])
    const s = smoothRoute({ points: pts, cost: 0, walkLength: 0, targetIndex: 0 }, () => g)
    expect(s.points.map((p) => p.node ?? '')).toContain('d')
    // court leg straightened up to the doorway
    expect(s.points[1].node).toBe('d')
  })

  it('re-smoothing when walls arrive keeps the current step (remapped onto the new steps)', () => {
    const pts = [P(25, 5), P(20, 5, 'corridor'), P(20, 15, 'corridor'), P(10, 15, 'corridor'), P(2, 21, 'corridor'), P(0, 21, 'door', 'd'), P(-3, 21, 'door', 'c'), P(-3, 28, 'corridor')]
    const raw: Route = { points: pts, cost: 0, walkLength: 0, targetIndex: 0 }
    const first = smoothRoute(raw, () => null) // walls not loaded yet: unsmoothed
    const refined = smoothRoute(raw, () => g) // walls loaded
    expect(refined.points.length).toBeLessThan(first.points.length)
    const before = buildSteps(first, { destinationName: 'X' })
    const after = buildSteps(refined, { destinationName: 'X' })
    expect(after.length).toBeLessThan(before.length) // the right-angle detour in the court is gone
    // before: 3 walk legs; after: the court detour and corridor collapse into one walk leg.
    // A user on any walking leg is on that single leg afterwards (never jumps to arrival).
    for (let i = 0; i < before.length - 1; i++) expect(after[remapStepIndex(before, i, after)].kind).toBe('walk')
    // first step stays first, arrival stays arrival
    expect(remapStepIndex(before, 0, after)).toBe(0)
    expect(remapStepIndex(before, before.length - 1, after)).toBe(after.length - 1)
  })

  it('leaves levels without geometry untouched', () => {
    const pts = [P(25, 5), P(20, 5, 'corridor'), P(15, 10, 'corridor')]
    expect(smoothRoute({ points: pts, cost: 0, walkLength: 0, targetIndex: 0 }, () => null).points).toHaveLength(3)
  })
})

const dir = fileURLToPath(new URL('../../../mapdata/data/tianmu', import.meta.url))
describe.skipIf(!existsSync(join(dir, 'levels/1F/walls.geojson')))('tianmu arena smoothing', () => {
  const read = <T>(p: string) => JSON.parse(readFileSync(join(dir, p), 'utf8')).features as T[]
  const keep = new Set(['wall', 'column'])
  const walls = read<WallFeature>('levels/1F/walls.geojson').filter((w) => keep.has(w.properties.layer))
  const units = read<UnitFeature>('levels/1F/units.geojson')
  const g1 = new LevelGeometry(units, walls)
  const graph = buildGraph(read<NavFeature>('nav.geojson'))
  const geom = (l: string) => (l === '1F' ? g1 : null)
  const route = (from: Parameters<typeof findRoute>[1], node: string) => {
    const r = findRoute(graph, from, [{ node }], { accessibleOnly: true })
    if (!r.ok) throw new Error(r.reason)
    return r.route
  }

  it('arena start -> accessible toilet: one straight leg to the NW arena door', () => {
    const raw = route({ place: { level: '1F', xy: [45, 30] } }, '1F-rt-acc')
    const s = smoothRoute(raw, geom)
    const i = s.points.findIndex((p) => p.node === '1F-d-ar-nw')
    expect(i).toBe(1) // start -> doorway directly
    expect(s.points.length).toBeLessThan(raw.points.length)
    expect(s.walkLength).toBeLessThan(raw.walkLength)
    const steps = buildSteps(s, { destinationName: '無障礙廁所' })
    expect(steps.length).toBeLessThanOrEqual(5)
  })

  it('smoothed legs never cross wall / column linework, and doorways are kept', () => {
    for (const [from, to] of [['1F-ent-main-out', '1F-rt-acc'], ['1F-ent-sw-out', '1F-el2'], ['1F-ar-se', '1F-rt-f'], ['1F-se', '1F-fa']] as const) {
      const raw = route({ node: from }, to)
      const s = smoothRoute(raw, geom)
      for (let k = 1; k < s.points.length; k++) {
        const [a, b] = [s.points[k - 1], s.points[k]]
        // legs that were edges of the original route are allowed (door edges pass through wall gaps)
        const wasEdge = raw.points.some((p, j) => j > 0 && raw.points[j - 1] === a && p === b)
        if (!wasEdge && a.level === b.level) expect(g1.crossesWall(a.xy, b.xy), `${from}->${to} leg ${k}`).toBe(false)
      }
      const fixed = fixedVertices(raw.points)
      raw.points.forEach((p, j) => fixed[j] && expect(s.points).toContain(p))
    }
  })
})
