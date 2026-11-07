/**
 * Route progress from live positions: which step the user is on, arrival, off-route.
 *
 * The route is treated as a polyline with cumulative distance `s`; each step starts at an `s`.
 * A position is projected onto the route segments of its level (near the current progress, so a
 * loop can't make it jump ahead). Rules:
 * - advance to the step containing the projection once it is ADVANCE_HYST_M past the current
 *   step's end, but never past a floor change: elevator / stairs steps wait for the user to
 *   confirm (「已到 2F」) because floors can't be detected without a barometer;
 * - arrive within ARRIVE_M of the destination;
 * - off-route when farther than OFF_ROUTE_M from the route for OFF_ROUTE_MS.
 */
import type { XY } from '../geo/frame'
import { dist, projectOnSegment } from '../geo/geometry'
import type { Step } from './instructions'
import type { Route } from './route'

export interface ProgressOptions {
  advanceHystM: number
  arriveM: number
  offRouteM: number
  offRouteMs: number
  /** how far behind the current step a projection may land (m) */
  lookBackM: number
}

export const DEFAULT_PROGRESS: ProgressOptions = { advanceHystM: 2, arriveM: 3, offRouteM: 8, offRouteMs: 5000, lookBackM: 5 }

export interface LivePos {
  t: number
  level: string
  x: number
  y: number
}

export type ProgressEvent =
  | { type: 'advance'; step: number }
  | { type: 'arrive'; step: number }
  | { type: 'off-route'; distance: number }
  | { type: 'on-route' }

interface Seg {
  level: string
  a: XY
  b: XY
  s0: number
  len: number
}

export class RouteTracker {
  readonly opts: ProgressOptions
  private segs: Seg[] = []
  private stepS: number[] = []
  private total = 0
  private dest: { level: string; xy: XY }
  step = 0
  arrived = false
  offRoute = false
  /** last projected distance along the route (m) and lateral distance */
  s = 0
  lateral = 0
  private farSince: number | null = null

  private readonly steps: Step[]

  constructor(route: Route, steps: Step[], opts: Partial<ProgressOptions> = {}) {
    this.steps = steps
    this.opts = { ...DEFAULT_PROGRESS, ...opts }
    const pts = route.points
    let s = 0
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1]
      const b = pts[i]
      if (a.level !== b.level) continue // floor change: no length along the polyline
      const len = dist(a.xy, b.xy)
      this.segs.push({ level: a.level, a: a.xy, b: b.xy, s0: s, len })
      s += len
    }
    this.total = s
    const last = pts[pts.length - 1]
    this.dest = { level: last.level, xy: last.xy }
    // step start positions, monotonic along the route
    let from = 0
    for (const st of steps) {
      const p = this.project(st.level, st.xy, from)
      const v = st.kind === 'arrive' ? this.total : p ? p.s : from
      this.stepS.push(Math.max(from, v))
      from = this.stepS[this.stepS.length - 1]
    }
  }

  /** Manual step change (上一步 / 下一步 / 已到 2F). */
  setStep(i: number) {
    this.step = Math.max(0, Math.min(this.steps.length - 1, i))
    this.arrived = this.steps[this.step]?.kind === 'arrive'
    this.s = this.stepS[this.step] ?? 0
  }

  private stepEnd(i: number) {
    return this.stepS[i + 1] ?? this.total
  }

  /** nearest point on the route on `level`, considering only segments ending after `minS` */
  private project(level: string, xy: XY, minS: number): { s: number; d: number } | null {
    let best: { s: number; d: number } | null = null
    for (const g of this.segs) {
      if (g.level !== level || g.s0 + g.len < minS) continue
      const pr = projectOnSegment(xy, g.a, g.b)
      if (!best || pr.d < best.d - 1e-9) best = { s: g.s0 + pr.t * g.len, d: pr.d }
    }
    return best
  }

  update(p: LivePos): ProgressEvent[] {
    const ev: ProgressEvent[] = []
    if (this.arrived) return ev
    const cur = this.steps[this.step]
    // after a floor change the position is meaningless until the user confirms the new floor
    if (!cur || cur.kind === 'elevator' || cur.kind === 'stairs' || p.level !== cur.level) return ev

    if (p.level === this.dest.level && dist([p.x, p.y], this.dest.xy) <= this.opts.arriveM) {
      this.arrived = true
      this.step = this.steps.length - 1
      return [{ type: 'arrive', step: this.step }]
    }

    const pr = this.project(p.level, [p.x, p.y], this.stepS[this.step] - this.opts.lookBackM)
    if (!pr) return ev
    this.s = pr.s
    this.lateral = pr.d

    // off-route with a time threshold, so one noisy fix doesn't trigger it
    if (pr.d > this.opts.offRouteM) {
      this.farSince ??= p.t
      if (!this.offRoute && p.t - this.farSince >= this.opts.offRouteMs) {
        this.offRoute = true
        ev.push({ type: 'off-route', distance: pr.d })
      }
      return ev
    }
    this.farSince = null
    if (this.offRoute) {
      this.offRoute = false
      ev.push({ type: 'on-route' })
    }

    // reaching an elevator / stairs (the route ends there on this floor) makes it the current step
    const nx = this.steps[this.step + 1]
    if (nx && (nx.kind === 'elevator' || nx.kind === 'stairs') && dist([p.x, p.y], nx.xy) <= this.opts.arriveM) {
      this.step++
      ev.push({ type: 'advance', step: this.step })
      return ev
    }

    // advance (possibly several steps), stopping at the next floor change
    let next = this.step
    while (next < this.steps.length - 1 && pr.s > this.stepEnd(next) + this.opts.advanceHystM) {
      next++
      const k = this.steps[next].kind
      if (k === 'elevator' || k === 'stairs' || k === 'arrive') break
    }
    if (next !== this.step) {
      if (this.steps[next].kind === 'arrive') {
        // passing the last step's end without being within arriveM: stay on the last walk step
        next--
      }
      if (next !== this.step) {
        this.step = next
        ev.push({ type: 'advance', step: next })
      }
    }
    return ev
  }
}
