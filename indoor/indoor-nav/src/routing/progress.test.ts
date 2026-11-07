import { describe, expect, it } from 'vitest'
import type { XY } from '../geo/frame'
import { buildSteps } from './instructions'
import { liveStepText, RouteTracker, shouldFollowStart, trimRoute, type LivePos, type ProgressEvent } from './progress'
import type { Route, RoutePoint } from './route'

/*
 * 1F: (0,0) -> (20,0) -> (20,20)=elevator  ...  2F: (20,20) -> (40,20)=destination
 * steps: 直走 20 後左轉 | 直走 20 後抵達電梯 | 搭電梯上樓到 2F | 出電梯，直走 20 後抵達 | 抵達
 */
const points: RoutePoint[] = [
  { level: '1F', xy: [0, 0] },
  { level: '1F', xy: [20, 0], via: 'corridor' },
  { level: '1F', xy: [20, 20], via: 'corridor' },
  { level: '2F', xy: [20, 20], via: 'elevator' },
  { level: '2F', xy: [40, 20], via: 'corridor' },
]
const route: Route = { points, cost: 75, walkLength: 60, targetIndex: 0 }
const steps = buildSteps(route, { levelOrdinal: (l) => (l === '1F' ? 0 : 1), destinationName: 'X' })

/** a walk along a polyline at 1 m/s, one fix per metre, with optional lateral offset */
function walk(level: string, path: XY[], t0 = 0, offset = 0): LivePos[] {
  const out: LivePos[] = []
  let t = t0
  for (let i = 1; i < path.length; i++) {
    const [a, b] = [path[i - 1], path[i]]
    const len = Math.hypot(b[0] - a[0], b[1] - a[1])
    const [ux, uy] = [(b[0] - a[0]) / len, (b[1] - a[1]) / len]
    for (let d = 0; d < len; d += 1) out.push({ t: (t += 1000), level, x: a[0] + ux * d - uy * offset, y: a[1] + uy * d + ux * offset })
  }
  return out
}
const feed = (tr: RouteTracker, ps: LivePos[]) => ps.flatMap((p) => tr.update(p))
const types = (ev: ProgressEvent[]) => ev.map((e) => (e.type === 'advance' || e.type === 'arrive' ? `${e.type}:${e.step}` : e.type))

describe('route progress', () => {
  it('has the expected steps', () => {
    expect(steps.map((s) => s.kind)).toEqual(['walk', 'walk', 'elevator', 'walk', 'arrive'])
  })

  it('advances ~3.5 m before the next turn node, then stops at the elevator', () => {
    const tr = new RouteTracker(route, steps)
    // 4 m before the corner: still step 0
    expect(types(feed(tr, walk('1F', [[0, 0], [17, 0]])))).toEqual([])
    expect(tr.step).toBe(0)
    // 3 m before the corner (within 3.5 m): the turn becomes the current step
    expect(types(tr.update({ t: 18000, level: '1F', x: 17, y: 0 }))).toEqual(['advance:1'])
    // walking on to the elevator makes the elevator step current, and nothing advances beyond it
    expect(types(feed(tr, walk('1F', [[20, 0], [20, 20]], 23000)))).toEqual(['advance:2'])
    expect(types(feed(tr, walk('1F', [[20, 20], [20, 25]], 60000)))).toEqual([])
    expect(tr.step).toBe(2)
  })

  it('snaps the position onto the route and reports the remaining distances', () => {
    const tr = new RouteTracker(route, steps)
    tr.update({ t: 0, level: '1F', x: 6, y: 1.5 }) // 1.5 m beside the first leg
    expect(tr.snap).toMatchObject({ level: '1F', xy: [6, 0], s: 6, bi: 1 })
    expect(tr.stepRemainingM).toBeCloseTo(14)
    expect(tr.totalRemainingM).toBeCloseTo(54) // 60 m walk - 6 m
    // a fix slightly behind doesn't pull progress back
    tr.update({ t: 1000, level: '1F', x: 5, y: 0 })
    expect(tr.s).toBe(6)
    expect(trimRoute(route, tr.snap).points.map((p) => p.xy)).toEqual([[6, 0], [20, 0], [20, 20], [20, 20], [40, 20]])
  })

  it('off-route hysteresis: jitter inside the band neither cancels nor needs a fresh start', () => {
    // 8 m off, then alternating 8 m / 5.5 m (between onRouteM 4.5 and offRouteM 7): fires after 4 s
    const tr = new RouteTracker(route, steps)
    const zig = [8, 5.5, 8, 5.5, 8, 5.5].map((d, i) => ({ t: i * 1000, level: '1F', x: 5 + i, y: -d }))
    expect(types(feed(tr, zig))).toEqual(['off-route'])
    // alternating 8 m / 3 m: every return within 4.5 m resets the timer, never fires
    const tr2 = new RouteTracker(route, steps)
    const jitter = Array.from({ length: 12 }, (_, i) => ({ t: i * 1000, level: '1F', x: 3 + i, y: i % 2 ? -3 : -8 }))
    expect(types(feed(tr2, jitter))).toEqual([])
    expect(tr2.offRoute).toBe(false)
  })

  it('after the user confirms the floor, tracks 2F and arrives within 3 m', () => {
    const tr = new RouteTracker(route, steps)
    tr.setStep(3) // 「已到 2F」
    const ev = feed(tr, walk('2F', [[20, 20], [40, 20]]))
    expect(types(ev)).toEqual(['arrive:4'])
    expect(tr.arrived).toBe(true)
    // the arrival fired at 37 m, i.e. within 3 m of the destination
    expect(ev.length).toBe(1)
  })

  it('reports off-route only after > 8 m for 5 s, and recovers', () => {
    const tr = new RouteTracker(route, steps)
    expect(types(tr.update({ t: 0, level: '1F', x: 2, y: 0 }))).toEqual([])
    // one noisy fix 12 m off: nothing
    expect(types(tr.update({ t: 1000, level: '1F', x: 4, y: -12 }))).toEqual([])
    expect(types(tr.update({ t: 2000, level: '1F', x: 5, y: 0 }))).toEqual([])
    // 10 m off for 6 s: one off-route event
    const off = walk('1F', [[6, 0], [14, 0]], 3000, -10)
    expect(types(feed(tr, off))).toEqual(['off-route'])
    expect(tr.offRoute).toBe(true)
    expect(types(tr.update({ t: 20000, level: '1F', x: 15, y: 0.5 }))).toEqual(['on-route'])
  })

  it('ignores positions on another floor than the current step', () => {
    const tr = new RouteTracker(route, steps)
    expect(types(feed(tr, walk('2F', [[0, 0], [10, 0]])))).toEqual([])
    expect(tr.step).toBe(0)
  })
})

describe('live step text', () => {
  it('replaces the walk distance with the live remainder', () => {
    expect(steps[0].text).toMatch(/直走 20 公尺/)
    expect(liveStepText(steps[0], 12.4)).toBe(steps[0].text.replace('直走 20 公尺', '直走 12 公尺'))
    expect(liveStepText(steps[0], 0.2)).toContain('直走 1 公尺')
    expect(liveStepText(steps[0], null)).toBe(steps[0].text)
    expect(liveStepText(steps[2], 5)).toBe(steps[2].text) // elevator: unchanged
  })
})

describe('preview start follows the live fix', () => {
  const start = { level: '1F', xy: [0, 0] as XY }
  it('moves the start only after 5 m (or a floor change) and at most every 3 s', () => {
    expect(shouldFollowStart(start, { t: 10000, level: '1F', x: 3, y: 3 }, 0)).toBe(false) // 4.2 m
    expect(shouldFollowStart(start, { t: 10000, level: '1F', x: 4, y: 3 }, 0)).toBe(true) // 5 m
    expect(shouldFollowStart(start, { t: 10000, level: '2F', x: 0, y: 0 }, 0)).toBe(true)
    expect(shouldFollowStart(start, { t: 10000, level: '1F', x: 9, y: 0 }, 8000)).toBe(false) // too soon
    expect(shouldFollowStart(null, { t: 10000, level: '1F', x: 9, y: 0 }, 0)).toBe(false)
  })
})
