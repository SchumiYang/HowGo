import type { XY } from '../geo/frame'
import { dist } from '../geo/geometry'
import { dijkstra, type Arc } from './dijkstra'
import { otherEnd, snapToGraph, type NavEdge, type NavGraph, type Snap } from './graph'

/** A location on a level, e.g. the user's position or a room's label point. */
export interface Place {
  level: string
  xy: XY
}

/**
 * Start: either a nav node or an arbitrary place (snapped to the nearest edge on its level).
 */
export type Origin = { node: string } | { place: Place }

/**
 * Destination candidate. With `node`, routes to that node; `place` (optional) is then only
 * appended as the final display point. Without `node`, `place` is snapped to the graph.
 */
export interface Target {
  node?: string
  place?: Place
}

export interface RouteOptions {
  /** only use edges with accessible: true (no stairs) */
  accessibleOnly?: boolean
}

/** How the route arrives at a point. 'snap' = off-graph leg to/from the start/end place. */
export type Via = 'snap' | NavEdge['type']

export interface RoutePoint {
  level: string
  xy: XY
  node?: string
  /** how this point is reached from the previous one (undefined for the first point) */
  via?: Via
}

export interface Route {
  points: RoutePoint[]
  /** routing cost, metres-equivalent (includes vertical costs) */
  cost: number
  /** walked distance in metres: horizontal legs + stairs edges, excluding elevator rides */
  walkLength: number
  /** index into the targets array of the chosen destination */
  targetIndex: number
}

export type RouteFailure = 'no-graph' | 'start-not-on-graph' | 'unreachable'
export type RouteResult = { ok: true; route: Route } | { ok: false; reason: RouteFailure }

const START = '\u0000start'
const tid = (i: number) => `\u0000t${i}`

type Hop = { kind: 'edge'; edge: NavEdge } | { kind: 'virtual' }

export function findRoute(g: NavGraph, origin: Origin, targets: Target[], opts: RouteOptions = {}): RouteResult {
  if (!g.edges.length) return { ok: false, reason: 'no-graph' }
  const acc = !!opts.accessibleOnly

  // virtual arcs added for this query: start -> edge ends, edge ends -> target places
  const extra = new Map<string, Arc<Hop>[]>()
  const addArc = (from: string, to: string, cost: number) => {
    let list = extra.get(from)
    if (!list) extra.set(from, (list = []))
    list.push({ to, cost, via: { kind: 'virtual' } })
  }

  let startSnap: Snap | null = null
  let source: string
  if ('node' in origin) {
    if (!g.nodes.has(origin.node)) return { ok: false, reason: 'start-not-on-graph' }
    source = origin.node
  } else {
    startSnap = snapToGraph(g, origin.place.level, origin.place.xy, acc)
    if (!startSnap) return { ok: false, reason: 'start-not-on-graph' }
    source = START
    addArc(START, startSnap.edge.from, startSnap.t * startSnap.edge.length)
    addArc(START, startSnap.edge.to, (1 - startSnap.t) * startSnap.edge.length)
  }

  const nodeTargets = new Map<string, number>() // nav node id -> first target index
  const targetSnaps = new Map<number, Snap>()
  targets.forEach((t, i) => {
    if (t.node) {
      if (g.nodes.has(t.node) && !nodeTargets.has(t.node)) nodeTargets.set(t.node, i)
      return
    }
    if (!t.place) return
    const s = snapToGraph(g, t.place.level, t.place.xy, acc)
    if (!s) return
    targetSnaps.set(i, s)
    addArc(s.edge.from, tid(i), s.t * s.edge.length)
    addArc(s.edge.to, tid(i), (1 - s.t) * s.edge.length)
    if (startSnap && startSnap.edge === s.edge) addArc(START, tid(i), Math.abs(startSnap.t - s.t) * s.edge.length)
  })

  const virtualTarget = new Map<string, number>([...targetSnaps.keys()].map((i) => [tid(i), i]))
  const isTarget = (id: string) => nodeTargets.has(id) || virtualTarget.has(id)

  function* neighbors(id: string): Iterable<Arc<Hop>> {
    yield* extra.get(id) ?? []
    for (const e of g.adj.get(id) ?? []) {
      if (acc && !e.accessible) continue
      yield { to: otherEnd(e, id), cost: e.length, via: { kind: 'edge', edge: e } }
    }
  }

  const res = dijkstra(source, neighbors, isTarget)
  if (!res) return { ok: false, reason: 'unreachable' }

  const targetIndex = nodeTargets.get(res.target) ?? virtualTarget.get(res.target)!
  const target = targets[targetIndex]
  const points: RoutePoint[] = []
  const push = (p: RoutePoint) => {
    const last = points[points.length - 1]
    if (last && last.level === p.level && dist(last.xy, p.xy) < 0.05) return
    points.push(p)
  }

  if (startSnap && 'place' in origin) {
    push({ level: origin.place.level, xy: origin.place.xy })
    push({ level: origin.place.level, xy: startSnap.point, via: 'snap' })
  }
  res.path.forEach((id, k) => {
    const node = g.nodes.get(id)
    if (!node) return // virtual
    const hop = k > 0 ? res.vias[k - 1] : undefined
    push({ level: node.level, xy: node.xy, node: id, via: hop?.kind === 'edge' ? hop.edge.type : hop ? 'corridor' : undefined })
  })
  const tSnap = targetSnaps.get(targetIndex)
  if (tSnap && target.place) {
    push({ level: target.place.level, xy: tSnap.point, via: 'corridor' })
    push({ level: target.place.level, xy: target.place.xy, via: 'snap' })
  } else if (target.place && target.place.level === g.nodes.get(res.target)?.level) {
    push({ level: target.place.level, xy: target.place.xy, via: 'snap' })
  }

  let walkLength = 0
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]
    const b = points[i]
    if (a.level === b.level) walkLength += dist(a.xy, b.xy)
    else if (b.via !== 'elevator') {
      const e = edgeBetween(g, a.node, b.node)
      walkLength += e ? e.length : dist(a.xy, b.xy)
    }
  }

  return { ok: true, route: { points, cost: res.cost, walkLength, targetIndex } }
}

function edgeBetween(g: NavGraph, a?: string, b?: string): NavEdge | undefined {
  if (!a || !b) return undefined
  return g.adj.get(a)?.find((e) => otherEnd(e, a) === b)
}

/** Levels visited by the route, in order, without consecutive duplicates. */
export function routeLevels(route: Route): string[] {
  const out: string[] = []
  for (const p of route.points) if (out[out.length - 1] !== p.level) out.push(p.level)
  return out
}
