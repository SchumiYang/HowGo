import type { XY } from '../geo/frame'
import { dist, projectOnSegment } from '../geo/geometry'
import type { EdgeType, NavFeature } from '../data/types'

export interface NavNode {
  id: string
  level: string
  xy: XY
}

export interface NavEdge {
  index: number
  from: string
  to: string
  type: EdgeType | string
  accessible: boolean
  /** routing cost in metres-equivalent (includes vertical cost for stairs/elevator) */
  length: number
}

export interface NavGraph {
  nodes: Map<string, NavNode>
  edges: NavEdge[]
  adj: Map<string, NavEdge[]>
}

export const isVertical = (g: NavGraph, e: NavEdge) => g.nodes.get(e.from)!.level !== g.nodes.get(e.to)!.level

export const otherEnd = (e: NavEdge, id: string) => (e.from === id ? e.to : e.from)

export function buildGraph(features: NavFeature[]): NavGraph {
  const nodes = new Map<string, NavNode>()
  for (const f of features) {
    if (f.properties?.kind === 'node' && f.geometry?.type === 'Point') {
      nodes.set(f.properties.id, { id: f.properties.id, level: f.properties.level, xy: f.geometry.coordinates })
    }
  }
  const edges: NavEdge[] = []
  const adj = new Map<string, NavEdge[]>()
  for (const f of features) {
    if (f.properties?.kind !== 'edge') continue
    const p = f.properties
    const a = nodes.get(p.from)
    const b = nodes.get(p.to)
    if (!a || !b || a === b) {
      console.warn(`[nav] edge ${p.from} -> ${p.to} references a missing node; skipped`)
      continue
    }
    const length = Number.isFinite(p.length_m) && p.length_m >= 0 ? p.length_m : dist(a.xy, b.xy)
    const e: NavEdge = { index: edges.length, from: p.from, to: p.to, type: p.type, accessible: p.accessible !== false, length }
    edges.push(e)
    for (const id of [p.from, p.to]) {
      let list = adj.get(id)
      if (!list) adj.set(id, (list = []))
      list.push(e)
    }
  }
  return { nodes, edges, adj }
}

export interface Snap {
  edge: NavEdge
  /** parameter along from -> to */
  t: number
  point: XY
  /** distance from the query point to the graph */
  d: number
}

/** Nearest point on a same-level edge of `level`. Optionally restricted to accessible edges. */
export function snapToGraph(g: NavGraph, level: string, xy: XY, accessibleOnly = false): Snap | null {
  let best: Snap | null = null
  for (const e of g.edges) {
    if (accessibleOnly && !e.accessible) continue
    const a = g.nodes.get(e.from)!
    const b = g.nodes.get(e.to)!
    if (a.level !== level || b.level !== level) continue
    const pr = projectOnSegment(xy, a.xy, b.xy)
    if (!best || pr.d < best.d) best = { edge: e, t: pr.t, point: pr.point, d: pr.d }
  }
  return best
}
