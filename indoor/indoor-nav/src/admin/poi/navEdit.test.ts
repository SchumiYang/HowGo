import { describe, expect, it } from 'vitest'
import type { NavFeature, PoiFeature } from '../../data/types'
import type { XY } from '../../geo/frame'
import { findRoute } from '../../routing/route'
import { buildGraph } from '../../routing/graph'
import { checkReachability, linkPoi, poiNodeId, unlinkPoi } from './navEdit'

const node = (id: string, xy: XY): NavFeature => ({ type: 'Feature', geometry: { type: 'Point', coordinates: xy }, properties: { kind: 'node', id, level: '1F' } })
const edge = (from: string, to: string, a: XY, b: XY, accessible = true, type = 'corridor'): NavFeature => ({
  type: 'Feature', geometry: { type: 'LineString', coordinates: [a, b] },
  properties: { kind: 'edge', from, to, type, accessible, length_m: Math.hypot(b[0] - a[0], b[1] - a[1]) },
})
/*  C(10,10)
 *   |
 *  A(0,0) --- B(10,0) ~~stairs~~ D(20,0)
 */
const base: NavFeature[] = [
  node('A', [0, 0]), node('B', [10, 0]), node('C', [10, 10]), node('D', [20, 0]),
  edge('A', 'B', [0, 0], [10, 0]), edge('B', 'C', [10, 0], [10, 10]), edge('B', 'D', [10, 0], [20, 0], false, 'stairs'),
]
const edges = (nav: NavFeature[]) =>
  nav.filter((f) => f.properties.kind === 'edge').map((f) => {
    const p = f.properties as { from: string; to: string; length_m: number; accessible: boolean; type: string }
    return `${p.from}-${p.to}:${p.length_m}${p.accessible ? '' : '!'}${p.type === 'door' ? 'd' : ''}`
  }).sort()
const poi = (id: string, xy: XY) => ({ id, level: '1F', xy })

describe('POI routing link', () => {
  it('splits the nearest edge at the projection and links with a door edge', () => {
    const r = linkPoi(base, poi('1F-poi-wc', [4, 3]))
    expect(r.nodeId).toBe('1F-poi-wc')
    expect(r.split).toEqual({ from: 'A', to: 'B' })
    expect(r.target).toBe('1F-poi-wc-j')
    expect(r.link).toEqual([[4, 3], [4, 0]])
    expect(edges(r.nav)).toEqual(['1F-poi-wc-1F-poi-wc-j:3d', '1F-poi-wc-j-B:6', 'A-1F-poi-wc-j:4', 'B-C:10', 'B-D:10!'].sort())
    // routable: A -> POI = 4 + 3
    const res = findRoute(buildGraph(r.nav), { node: 'A' }, [{ node: '1F-poi-wc' }], { accessibleOnly: true })
    expect(res.ok && res.route.cost).toBeCloseTo(7)
  })

  it('prefers accessible edges even when a stairs edge is closer', () => {
    const r = linkPoi(base, poi('1F-poi-x', [16, 1]))
    expect(r.split).toEqual({ from: 'B', to: 'C' }) // not the closer B-D stairs
  })

  it('moving a POI removes the old link and merges the split edge back', () => {
    const first = linkPoi(base, poi('1F-poi-wc', [4, 3])).nav
    const moved = linkPoi(first, poi('1F-poi-wc', [12, 5]))
    expect(moved.split).toEqual({ from: 'B', to: 'C' })
    expect(edges(moved.nav)).toEqual(['1F-poi-wc-1F-poi-wc-j:2d', '1F-poi-wc-j-C:5', 'A-B:10', 'B-1F-poi-wc-j:5', 'B-D:10!'].sort())
  })

  it('links straight to an existing node next to the projection (no split)', () => {
    const r = linkPoi(base, poi('1F-poi-e', [0.2, -2]))
    expect(r.split).toBeNull()
    expect(r.target).toBe('A')
    expect(edges(r.nav)).toContain('1F-poi-e-A:2.01d') // link runs to the node itself
  })

  it('unlinking (delete) restores the original graph', () => {
    const linked = linkPoi(base, poi('1F-poi-wc', [4, 3])).nav
    expect(edges(unlinkPoi(linked, poiNodeId({ id: '1F-poi-wc', level: '1F' })))).toEqual(edges(base))
  })

  it('the link accessibility flag is applied', () => {
    const r = linkPoi(base, poi('1F-poi-wc', [4, 3]), { accessible: false })
    expect(edges(r.nav)).toContain('1F-poi-wc-1F-poi-wc-j:3!d')
  })
})

describe('reachability check', () => {
  const p = (id: string, nav_node: string | null, category = 'toilet.male'): PoiFeature => ({
    type: 'Feature', geometry: { type: 'Point', coordinates: [0, 0] }, properties: { id, level: '1F', category, nav_node },
  })
  it('flags missing nodes, disconnected nodes and accessible-only gaps (not stairs)', () => {
    const nav = [...base, node('Z', [50, 50])] // Z is isolated
    const r = checkReachability(nav, [p('ok', 'C'), p('lost', 'Z'), p('none', null), p('upstairs', 'D', 'stairs'), p('acc', 'D', 'toilet.accessible')])
    expect(r.unreachable.sort()).toEqual(['lost', 'none'])
    expect(r.inaccessible).toEqual(['acc'])
  })
})
