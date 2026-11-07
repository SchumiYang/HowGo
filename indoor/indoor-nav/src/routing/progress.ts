/**
 * Route progress from live positions: which step the user is on, arrival, off-route.
 *
 * The route is treated as a polyline with cumulative distance `s`; each step starts at an `s`.
 * A position is projected onto the route segments of its level (near the current progress, so a
 * loop can't make it jump ahead). Rules:
 * - advance to the next step once the projection is within NEXT_STEP_M of where it starts (the
 *   next turn node), but never past a floor change: elevator / stairs steps are left by the
 *   floor-change detection or the user's 「已到 2F」 (see levelChange.ts);
 * - arrive within ARRIVE_M of the destination;
 * - off-route when farther than OFF_ROUTE_M from the route for OFF_ROUTE_MS, with hysteresis:
 *   the timer only resets once the position is back within ON_ROUTE_M, so jitter around the
 *   threshold neither triggers nor keeps cancelling it.
 * The snapped position (`snap`) lets the UI draw the route from the user onwards and show the
 * remaining distances.
 */
import type { XY } from '../geo/frame'
import { dist, projectOnSegment } from '../geo/geometry'
import type { Step } from './instructions'
import type { Route } from './route'

export interface ProgressOptions {
  /** advance when the next step's start is this close along the route (m) */
  nextStepM: number
  arriveM: number
  offRouteM: number
  /** back on the route (resets the off-route timer) within this distance (m) */
  onRouteM: number
  offRouteMs: number
  /** how far behind the current step a projection may land (m) */
  lookBackM: number
}

export const DEFAULT_PROGRESS: ProgressOptions = { nextStepM: 3.5, arriveM: 3, offRouteM: 7, onRouteM: 4.5, offRouteMs: 4000, lookBackM: 5 }

export interface LivePos {
  t: number
  level: string
  x: number
  y: number
}

/** The live position snapped onto the route. `bi`: index in route.points of the segment's end. */
export interface RouteSnap {
  level: string
  xy: XY
  /** distance along the route (m) */
  s: number
  bi: number
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
  /** index of b in route.points */
  bi: number
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
  /** last on-route position snapped onto the route (null until the first fix / after setStep) */
  snap: RouteSnap | null = null
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
      this.segs.push({ level: a.level, a: a.xy, b: b.xy, bi: i, s0: s, len })
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
    this.snap = null
  }

  private stepEnd(i: number) {
    return this.stepS[i + 1] ?? this.total
  }

  /** metres left in the current step (to its turn / connector / destination) */
  get stepRemainingM(): number {
    return Math.max(0, this.stepEnd(this.step) - this.s)
  }

  /** metres left to the destination (walking legs only) */
  get totalRemainingM(): number {
    return Math.max(0, this.total - this.s)
  }

  /** nearest point on the route on `level`, considering only segments ending after `minS` */
  private project(level: string, xy: XY, minS: number): (RouteSnap & { d: number }) | null {
    let best: (RouteSnap & { d: number }) | null = null
    for (const g of this.segs) {
      if (g.level !== level || g.s0 + g.len < minS) continue
      const pr = projectOnSegment(xy, g.a, g.b)
      if (!best || pr.d < best.d - 1e-9) {
        const at: XY = [g.a[0] + pr.t * (g.b[0] - g.a[0]), g.a[1] + pr.t * (g.b[1] - g.a[1])]
        best = { level, xy: at, s: g.s0 + pr.t * g.len, bi: g.bi, d: pr.d }
      }
    }
    return best
  }

  update(p: LivePos): ProgressEvent[] {
    const ev: ProgressEvent[] = []
    if (this.arrived) return ev
    const cur = this.steps[this.step]
    // during a floor change the position is meaningless until the new floor is detected / confirmed
    if (!cur || cur.kind === 'elevator' || cur.kind === 'stairs' || p.level !== cur.level) return ev

    if (p.level === this.dest.level && dist([p.x, p.y], this.dest.xy) <= this.opts.arriveM) {
      this.arrived = true
      this.step = this.steps.length - 1
      return [{ type: 'arrive', step: this.step }]
    }

    const pr = this.project(p.level, [p.x, p.y], this.stepS[this.step] - this.opts.lookBackM)
    if (!pr) return ev
    this.lateral = pr.d

    // off-route: time threshold + hysteresis, so neither one noisy fix nor jitter around the
    // threshold triggers it; progress is frozen while possibly off the route
    if (pr.d > this.opts.offRouteM) this.farSince ??= p.t
    else if (pr.d < this.opts.onRouteM) this.farSince = null
    if (this.farSince !== null) {
      if (!this.offRoute && p.t - this.farSince >= this.opts.offRouteMs) {
        this.offRoute = true
        ev.push({ type: 'off-route', distance: pr.d })
      }
      return ev
    }
    if (this.offRoute) {
      this.offRoute = false
      ev.push({ type: 'on-route' })
    }
    // progress only moves forward (a fix slightly behind doesn't pull the route line back)
    if (pr.s >= this.s || !this.snap) {
      this.s = Math.max(this.s, pr.s)
      this.snap = { level: pr.level, xy: pr.xy, s: pr.s, bi: pr.bi }
    }

    // reaching an elevator / stairs (the route ends there on this floor) makes it the current step
    const nx = this.steps[this.step + 1]
    if (nx && (nx.kind === 'elevator' || nx.kind === 'stairs') && dist([p.x, p.y], nx.xy) <= this.opts.arriveM) {
      this.step++
      ev.push({ type: 'advance', step: this.step })
      return ev
    }

    // advance (possibly several steps) when the next step's start is near, stopping at the next
    // floor change; steps never go back, so this needs no extra hysteresis
    let next = this.step
    while (next < this.steps.length - 1 && this.s >= this.stepEnd(next) - this.opts.nextStepM) {
      next++
      const k = this.steps[next].kind
      if (k === 'elevator' || k === 'stairs' || k === 'arrive') break
    }
    if (next !== this.step) {
      const k = this.steps[next].kind
      // the destination needs arriveM, and floor changes need the user at the connector (above)
      if (k === 'arrive' || k === 'elevator' || k === 'stairs') next--
      if (next !== this.step) {
        this.step = next
        ev.push({ type: 'advance', step: next })
      }
    }
    return ev
  }
}

/** The route from the snapped live position onwards (what is left to walk), for drawing. */
export function trimRoute(route: Route, snap: RouteSnap | null): Route {
  if (!snap || snap.bi < 1 || snap.bi >= route.points.length) return route
  return { ...route, points: [{ level: snap.level, xy: snap.xy }, ...route.points.slice(snap.bi)] }
}

/** A walk step's text with the live distance to its end (「直走 12 公尺後右轉」). */
export function liveStepText(step: Step, remainingM: number | null): string {
  if (step.kind !== 'walk' || remainingM === null) return step.text
  return step.text.replace(/直走 \d+ 公尺/, `直走 ${Math.max(1, Math.round(remainingM))} 公尺`)
}

/** Previewing a route with live positioning: move its start to the live fix? */
export const FOLLOW_START_M = 5
export const FOLLOW_START_MS = 3000
export function shouldFollowStart(
  start: { level: string; xy: XY } | null,
  fix: LivePos,
  lastMovedAt: number,
): boolean {
  if (!start || fix.t - lastMovedAt < FOLLOW_START_MS) return false
  return start.level !== fix.level || dist(start.xy, [fix.x, fix.y]) >= FOLLOW_START_M
}
