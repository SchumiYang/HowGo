import { describe, expect, it } from 'vitest'
import type { XY } from '../geo/frame'
import { buildSteps } from './instructions'
import { RouteTracker, type LivePos, type ProgressEvent } from './progress'
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

  it('advances past a turn only after the hysteresis, then stops at the elevator', () => {
    const tr = new RouteTracker(route, steps)
    // up to 1 m past the corner: still step 0
    expect(types(feed(tr, [...walk('1F', [[0, 0], [20, 0]]), { t: 21000, level: '1F', x: 20, y: 1 }]))).toEqual([])
    expect(tr.step).toBe(0)
    // 3 m past the corner (> 2 m hysteresis): step 1
    expect(types(tr.update({ t: 22000, level: '1F', x: 20, y: 3 }))).toEqual(['advance:1'])
    // walking on to the elevator makes the elevator step current, and nothing advances beyond it
    expect(types(feed(tr, walk('1F', [[20, 3], [20, 20]], 23000)))).toEqual(['advance:2'])
    expect(types(feed(tr, walk('1F', [[20, 20], [20, 25]], 60000)))).toEqual([])
    expect(tr.step).toBe(2)
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
