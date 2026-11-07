/**
 * Nav-graph edits for the POI admin (ADMIN_API.md "POI editing semantics"):
 * a POI owns a private node `<level>-poi-<slug>` linked by a `door` edge to the nearest point of the
 * nearest same-level edge; that edge is split at a junction node `<poiNode>-j`. Unlinking removes the
 * private node + link and merges the split edge back when the junction is otherwise unused.
 * All functions are pure: they return new feature arrays.
 */
import type { XY } from '../../geo/frame'
import { dist } from '../../geo/geometry'
import type { NavFeature, NavEdgeProps, PoiFeature } from '../../data/types'
import { buildGraph, snapToGraph } from '../../routing/graph'

const r2 = (v: number) => Math.round(v * 100) / 100
const pt = (xy: XY): XY => [r2(xy[0]), r2(xy[1])]
/** link straight to an existing node when the projection is this close to it (m) */
const ENDPOINT_SNAP_M = 0.3

type EdgeF = Extract<NavFeature, { properties: NavEdgeProps }>
type NodeF = Exclude<NavFeature, EdgeF>
const isEdge = (f: NavFeature): f is EdgeF => f.properties.kind === 'edge'
const isNode = (f: NavFeature): f is NodeF => f.properties.kind === 'node'

export function poiNodeId(poi: { id: string; level: string }): string {
  const slug = poi.id.replace(new RegExp(`^${poi.level}-poi-`), '').replace(/[^\w-]/g, '_')
  return `${poi.level}-poi-${slug}`
}

const node = (id: string, level: string, xy: XY): NodeF => ({ type: 'Feature', geometry: { type: 'Point', coordinates: pt(xy) }, properties: { kind: 'node', id, level } })
const edge = (from: string, to: string, a: XY, b: XY, type: string, accessible: boolean, length_m: number): EdgeF => ({
  type: 'Feature', geometry: { type: 'LineString', coordinates: [pt(a), pt(b)] },
  properties: { kind: 'edge', from, to, type, accessible, length_m: r2(length_m) },
})

/** Remove a POI's private node + edges; merge its junction's two halves back into one edge. */
export function unlinkPoi(nav: NavFeature[], nodeId: string): NavFeature[] {
  const j = `${nodeId}-j`
  let out = nav.filter((f) => !(isNode(f) && f.properties.id === nodeId) && !(isEdge(f) && (f.properties.from === nodeId || f.properties.to === nodeId)))
  const jEdges = out.filter((f): f is EdgeF => isEdge(f) && (f.properties.from === j || f.properties.to === j))
  if (out.some((f) => isNode(f) && f.properties.id === j) && jEdges.length === 2) {
    const [e1, e2] = jEdges
    const other = (e: EdgeF) => (e.properties.from === j ? e.properties.to : e.properties.from)
    const pos = new Map(out.filter(isNode).map((n) => [n.properties.id, n.geometry.coordinates]))
    const a = other(e1)
    const b = other(e2)
    const merged = edge(a, b, pos.get(a)!, pos.get(b)!, e1.properties.type, e1.properties.accessible && e2.properties.accessible, e1.properties.length_m + e2.properties.length_m)
    out = out.filter((f) => f !== e1 && f !== e2 && !(isNode(f) && f.properties.id === j))
    out.push(merged)
  }
  return out
}

export interface LinkResult {
  nav: NavFeature[]
  nodeId: string
  /** the link edge's other end (an existing node or the new junction) */
  target: string
  /** link geometry for previews */
  link: [XY, XY]
  /** the edge that was split, if any */
  split: { from: string; to: string } | null
}

/**
 * (Re)link a POI: drop its old private node/link, then connect a node at the POI position to the
 * nearest point on the nearest same-level edge (accessible edges preferred), splitting that edge.
 */
export function linkPoi(nav: NavFeature[], poi: { id: string; level: string; xy: XY }, opts: { accessible?: boolean } = {}): LinkResult {
  const nodeId = poiNodeId(poi)
  const base = unlinkPoi(nav, nodeId)
  const g = buildGraph(base)
  const snap = snapToGraph(g, poi.level, poi.xy, true) ?? snapToGraph(g, poi.level, poi.xy, false)
  if (!snap) throw new Error(`${poi.level} 沒有可連接的導航路段`)
  const e = snap.edge
  const a = g.nodes.get(e.from)!
  const b = g.nodes.get(e.to)!
  let target: string
  let split: LinkResult['split'] = null
  let out = base
  if (dist(snap.point, a.xy) <= ENDPOINT_SNAP_M) target = a.id
  else if (dist(snap.point, b.xy) <= ENDPOINT_SNAP_M) target = b.id
  else {
    target = `${nodeId}-j`
    split = { from: e.from, to: e.to }
    const orig = base.find((f): f is EdgeF => isEdge(f) && f.properties.from === e.from && f.properties.to === e.to)!
    out = base.filter((f) => f !== orig)
    out.push(
      node(target, poi.level, snap.point),
      edge(e.from, target, a.xy, snap.point, e.type, e.accessible, snap.t * e.length),
      edge(target, e.to, snap.point, b.xy, e.type, e.accessible, (1 - snap.t) * e.length),
    )
  }
  const tXY = target === a.id ? a.xy : target === b.id ? b.xy : snap.point
  out.push(node(nodeId, poi.level, poi.xy), edge(nodeId, target, poi.xy, tXY, 'door', opts.accessible ?? true, Math.max(0.1, dist(poi.xy, tXY))))
  return { nav: out, nodeId, target, link: [pt(poi.xy), pt(tXY)], split }
}

export interface Reachability {
  /** POIs whose node is missing or not in the largest connected component */
  unreachable: string[]
  /** POIs not reachable with accessible-only edges (stairs excluded: expected) */
  inaccessible: string[]
}

/** Connectivity check before saving. */
export function checkReachability(nav: NavFeature[], pois: PoiFeature[]): Reachability {
  const comp = (accessibleOnly: boolean) => {
    const g = buildGraph(nav)
    const label = new Map<string, number>()
    let next = 0
    const sizes: number[] = []
    for (const id of g.nodes.keys()) {
      if (label.has(id)) continue
      const stack = [id]
      label.set(id, next)
      let size = 0
      while (stack.length) {
        const u = stack.pop()!
        size++
        for (const e of g.adj.get(u) ?? []) {
          if (accessibleOnly && !e.accessible) continue
          const v = e.from === u ? e.to : e.from
          if (!label.has(v)) {
            label.set(v, next)
            stack.push(v)
          }
        }
      }
      sizes.push(size)
      next++
    }
    const main = sizes.indexOf(Math.max(...sizes))
    return (id: string | null | undefined) => !!id && label.get(id) === main
  }
  const inMain = comp(false)
  const inMainAcc = comp(true)
  const unreachable: string[] = []
  const inaccessible: string[] = []
  for (const p of pois) {
    const n = p.properties.nav_node
    if (!inMain(n)) unreachable.push(p.properties.id)
    else if (p.properties.category !== 'stairs' && !inMainAcc(n)) inaccessible.push(p.properties.id)
  }
  return { unreachable, inaccessible }
}
