import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { NavFeature } from '../data/types'
import type { XY } from '../geo/frame'
import { buildGraph, snapToGraph } from './graph'
import { buildSteps } from './instructions'
import { findRoute, routeLevels, type Route } from './route'

const node = (id: string, level: string, xy: XY): NavFeature => ({
  type: 'Feature', geometry: { type: 'Point', coordinates: xy }, properties: { kind: 'node', id, level },
})
const edge = (from: string, to: string, a: XY, b: XY, type = 'corridor', accessible = true, length_m = Math.hypot(b[0] - a[0], b[1] - a[1])): NavFeature => ({
  type: 'Feature', geometry: { type: 'LineString', coordinates: [a, b] }, properties: { kind: 'edge', from, to, type, accessible, length_m },
})

/*
 * 1F:  t1(0,5)          x(1,-2) is only reachable from C
 *       |
 *      A(0,0) --- B(10,0) --- C(20,0) --- E1(30,0)
 *                  |stairs     |  \
 *                  |           t2  x
 * 2F:            S2(10,0) --- D(20,0) --- E2(30,0)
 *                  |
 *                 t3(10,1)
 */
const P: Record<string, XY> = {
  A: [0, 0], B: [10, 0], C: [20, 0], E1: [30, 0], t1: [0, 5], t2: [20, 2], x: [1, -2],
  S2: [10, 0], D: [20, 0], E2: [30, 0], t3: [10, 1],
}
const toy = buildGraph([
  node('A', '1F', P.A), node('B', '1F', P.B), node('C', '1F', P.C), node('E1', '1F', P.E1),
  node('t1', '1F', P.t1), node('t2', '1F', P.t2), node('x', '1F', P.x),
  node('S2', '2F', P.S2), node('D', '2F', P.D), node('E2', '2F', P.E2), node('t3', '2F', P.t3),
  edge('A', 'B', P.A, P.B), edge('B', 'C', P.B, P.C), edge('C', 'E1', P.C, P.E1),
  edge('A', 't1', P.A, P.t1, 'door'), edge('C', 't2', P.C, P.t2, 'door'), edge('C', 'x', P.C, P.x, 'door'),
  edge('B', 'S2', P.B, P.S2, 'stairs', false, 12),
  edge('E1', 'E2', P.E1, P.E2, 'elevator', true, 15),
  edge('S2', 'D', P.S2, P.D), edge('D', 'E2', P.D, P.E2), edge('S2', 't3', P.S2, P.t3, 'door'),
])

const ok = (r: ReturnType<typeof findRoute>): Route => {
  if (!r.ok) throw new Error(`route failed: ${r.reason}`)
  return r.route
}
const nodesOf = (r: Route) => r.points.map((p) => p.node).filter(Boolean)

describe('snapping', () => {
  it('snaps to the nearest same-level edge', () => {
    const s = snapToGraph(toy, '1F', [12, 1])!
    expect(new Set([s.edge.from, s.edge.to])).toEqual(new Set(['B', 'C']))
    expect(s.point).toEqual([12, 0])
  })
  it('never snaps to cross-level edges', () => {
    const s = snapToGraph(toy, '2F', [10, -3])!
    expect(s.edge.type).not.toBe('stairs')
  })
})

describe('multi-target nearest', () => {
  it('chooses by route distance, not straight-line distance', () => {
    // x is 2.2 m away in a straight line but ~37 m by route; t1 is 5.4 m / 7 m
    const r = ok(findRoute(toy, { place: { level: '1F', xy: [2, 0] } }, [{ node: 'x' }, { node: 't1' }]))
    expect(r.targetIndex).toBe(1)
    expect(r.cost).toBeCloseTo(7)
  })
  it('picks the other target when the start moves', () => {
    const r = ok(findRoute(toy, { place: { level: '1F', xy: [14, 0] } }, [{ node: 't1' }, { node: 't2' }]))
    expect(r.targetIndex).toBe(1)
    expect(r.cost).toBeCloseTo(8)
  })
  it('routes to an off-graph place by snapping it, including start and target on the same edge', () => {
    const r = ok(findRoute(toy, { place: { level: '1F', xy: [12, 0] } }, [{ place: { level: '1F', xy: [16, 1] } }]))
    expect(r.cost).toBeCloseTo(4)
    expect(r.points.at(-1)!.xy).toEqual([16, 1])
  })
})

describe('cross-level and accessible routing', () => {
  const start = { place: { level: '1F', xy: [2, 0] as XY } }

  it('uses stairs when allowed (shortest)', () => {
    const r = ok(findRoute(toy, start, [{ node: 't3' }]))
    expect(nodesOf(r)).toEqual(['B', 'S2', 't3'])
    expect(r.cost).toBeCloseTo(8 + 12 + 1)
    expect(routeLevels(r)).toEqual(['1F', '2F'])
    const steps = buildSteps(r, { levelOrdinal: (l) => (l === '1F' ? 0 : 1) })
    expect(steps.some((s) => s.kind === 'stairs' && s.toLevel === '2F' && s.text.includes('上樓'))).toBe(true)
  })

  it('accessible-only takes the elevator and never a stairs edge', () => {
    const r = ok(findRoute(toy, start, [{ node: 't3' }], { accessibleOnly: true }))
    expect(nodesOf(r)).toEqual(['B', 'C', 'E1', 'E2', 'D', 'S2', 't3'])
    expect(r.points.some((p) => p.via === 'stairs')).toBe(false)
    const steps = buildSteps(r, { levelName: (l) => l })
    expect(steps.find((s) => s.kind === 'elevator')?.text).toContain('搭電梯')
    expect(steps.find((s) => s.kind === 'elevator')?.toLevel).toBe('2F')
  })

  it('reports unreachable when only stairs connect the target', () => {
    const g = buildGraph([
      node('a', '1F', [0, 0]), node('b', '1F', [5, 0]), node('c', '2F', [5, 0]),
      edge('a', 'b', [0, 0], [5, 0]), edge('b', 'c', [5, 0], [5, 0], 'stairs', false, 10),
    ])
    const r = findRoute(g, { node: 'a' }, [{ node: 'c' }], { accessibleOnly: true })
    expect(r).toEqual({ ok: false, reason: 'unreachable' })
  })
})

describe('mock venue data', () => {
  const root = fileURLToPath(new URL('../../public/data/mock', import.meta.url))
  const nav = JSON.parse(readFileSync(join(root, 'nav.geojson'), 'utf8')).features as NavFeature[]
  const g = buildGraph(nav)

  it('every nav node is reachable from the entrance, also accessible-only', () => {
    for (const accessibleOnly of [false, true]) {
      for (const id of g.nodes.keys()) {
        const r = findRoute(g, { node: '1F-entrance' }, [{ node: id }], { accessibleOnly })
        expect(r.ok, `${id} accessibleOnly=${accessibleOnly}`).toBe(true)
      }
    }
  })

  it('nearest toilet from the entrance is on 1F; accessible route to 2F uses an elevator', () => {
    const pois = (['1F', '2F'] as const).flatMap((l) => JSON.parse(readFileSync(join(root, 'levels', l, 'pois.geojson'), 'utf8')).features)
    const toilets = pois.filter((f: { properties: { category: string } }) => f.properties.category.startsWith('toilet.'))
    const r = ok(findRoute(g, { node: '1F-entrance' }, toilets.map((f: { properties: { nav_node: string } }) => ({ node: f.properties.nav_node }))))
    expect(toilets[r.targetIndex].properties.level).toBe('1F')

    const r2 = ok(findRoute(g, { node: '1F-entrance' }, [{ node: '2F-D202' }], { accessibleOnly: true }))
    expect(r2.points.some((p) => p.via === 'elevator')).toBe(true)
    expect(r2.points.some((p) => p.via === 'stairs')).toBe(false)
  })
})

describe('step text', () => {
  const steps = (points: [string, XY][], name = '男廁') =>
    buildSteps({ points: points.map(([level, xy]) => ({ level, xy })), cost: 0, walkLength: 0, targetIndex: 0 }, { destinationName: name })

  it('folds a short final door leg into the run and names the side of the destination', () => {
    const r = ok(findRoute(toy, { place: { level: '1F', xy: [2, 0] } }, [{ node: 't2' }]))
    const s = buildSteps(r, { destinationName: '男廁' })
    // east 18 m, then a 2 m leg north (+y) into the toilet = on the left
    expect(s.map((x) => x.text)).toEqual(['直走 20 公尺後，男廁在左側', '抵達 男廁'])
    expect(s[0]).toMatchObject({ kind: 'walk', maneuver: 'straight', level: '1F' })
  })

  it('merges a short jog (4 m diagonal, path length kept: 20 + 4.2 + 17) instead of emitting 左轉/右轉 noise', () => {
    const s = steps([['1F', [0, 0]], ['1F', [0, 20]], ['1F', [-3, 23]], ['1F', [-3, 40]], ['1F', [20, 40]]])
    expect(s.map((x) => x.text)).toEqual(['直走 41 公尺後右轉', '直走 23 公尺後抵達 男廁', '抵達 男廁'])
  })

  it('keeps real turns between long legs', () => {
    const s = steps([['1F', [0, 0]], ['1F', [0, 10]], ['1F', [10, 10]], ['1F', [10, 0]]], 'X')
    expect(s.map((x) => x.maneuver ?? x.kind)).toEqual(['turn-right', 'turn-right', 'straight', 'arrive'])
  })
})

// Real data is synced, not committed (npm run sync-data); these checks run only when it is present.
const tianmuDir = fileURLToPath(new URL('../../../mapdata/data/tianmu', import.meta.url))
describe.skipIf(!existsSync(join(tianmuDir, 'nav.geojson')))('tianmu real data', () => {
  const read = (p: string) => JSON.parse(readFileSync(join(tianmuDir, p), 'utf8')).features
  const g = buildGraph(read('nav.geojson'))
  const pois = read('levels/1F/pois.geojson') as { properties: { category: string; nav_node: string } }[]
  const targets = (cat: string) => pois.filter((p) => p.properties.category === cat).map((p) => ({ node: p.properties.nav_node }))
  const from = { node: '1F-ent-main-out' }

  it('accessible toilet from the main entrance is ~57 m', () => {
    const r = ok(findRoute(g, from, targets('toilet.accessible'), { accessibleOnly: true }))
    expect(r.walkLength).toBeGreaterThan(50)
    expect(r.walkLength).toBeLessThan(64)
    // the A101 lobby jog must not produce 左轉/右轉 noise
    const s = buildSteps(r, { destinationName: '無障礙廁所' })
    expect(s.length).toBeLessThanOrEqual(6)
    expect(s.map((x) => x.text).join()).toContain('無障礙廁所在右側')
  })
  it('nearest elevator from the main entrance is ~43 m', () => {
    const r = ok(findRoute(g, from, targets('elevator'), { accessibleOnly: true }))
    expect(r.walkLength).toBeGreaterThan(38)
    expect(r.walkLength).toBeLessThan(48)
  })
  it('cross-floor: main entrance to the 2F north accessible toilet costs ~77 m (62 m walked + 15 m elevator) via an elevator', () => {
    const r = ok(findRoute(g, from, [{ node: '2F-rt-acc' }], { accessibleOnly: true }))
    expect(r.cost).toBeGreaterThan(72)
    expect(r.cost).toBeLessThan(82)
    expect(r.walkLength).toBeCloseTo(r.cost - 15, 1)
    expect(r.points.some((p) => p.via === 'elevator')).toBe(true)
    expect(r.points.some((p) => p.via === 'stairs')).toBe(false)
    const s = buildSteps(r, { levelOrdinal: (l) => (l === '1F' ? 0 : 1), destinationName: '無障礙廁所（北）' })
    expect(s.map((x) => x.text)).toContain('搭電梯上樓到 2F')
  })
  it('the 無障礙廁所 category considers both floors by route distance', () => {
    const all = (['1F', '2F'] as const).flatMap((l) => read(`levels/${l}/pois.geojson`)) as { properties: { category: string; nav_node: string; level: string } }[]
    const acc = all.filter((p) => p.properties.category === 'toilet.accessible')
    expect(new Set(acc.map((p) => p.properties.level))).toEqual(new Set(['1F', '2F']))
    const r = ok(findRoute(g, from, acc.map((p) => ({ node: p.properties.nav_node })), { accessibleOnly: true }))
    expect(acc[r.targetIndex].properties.level).toBe('1F') // the 1F one is closer from the entrance
    const r2 = ok(findRoute(g, { node: '2F-el2' }, acc.map((p) => ({ node: p.properties.nav_node })), { accessibleOnly: true }))
    expect(acc[r2.targetIndex].properties.level).toBe('2F') // from 2F, a 2F toilet wins
  })
  it('stairs are unreachable with the accessible route on, reachable with it off', () => {
    expect(findRoute(g, from, targets('stairs'), { accessibleOnly: true })).toEqual({ ok: false, reason: 'unreachable' })
    expect(findRoute(g, from, targets('stairs')).ok).toBe(true)
  })
})
