import { t } from '../i18n'
import type { XY } from '../geo/frame'
import { dist, projectOnSegment, turnAngle } from '../geo/geometry'
import type { Route } from './route'

/**
 * Route steps, structured so Map mode and a future Text & Voice mode render the same data:
 * every step has a complete, speakable `text` plus machine-readable fields.
 *
 * A walking step covers one straight run and names the manoeuvre at its end
 * (「直走 20 公尺後右轉」); floor changes are their own step (「搭電梯上樓到 2F」);
 * the last step is the arrival.
 */
export type Maneuver = 'turn-left' | 'turn-right' | 'u-turn' | 'straight'
export type StepKind = 'walk' | 'elevator' | 'stairs' | 'arrive'

export interface Step {
  kind: StepKind
  text: string
  /** level the step starts on */
  level: string
  /** where the step starts (map focus) */
  xy: XY
  /** walk: what to do at the end of the run */
  maneuver?: Maneuver
  /** walk: metres */
  distance?: number
  /** elevator / stairs: destination level */
  toLevel?: string
  /** elevator / stairs: up (true) or down (false), when ordinals are known */
  up?: boolean
}

export interface InstructionOptions {
  levelName?: (id: string) => string
  levelOrdinal?: (id: string) => number
  destinationName?: string
}

/** legs shorter than this (path length) are merged into the next leg: door stubs, small jogs */
const MERGE_M = 6
/** lateral tolerance for straightening jogs; a real L-turn between two >= 6 m legs deviates >= 4.2 m */
const JOG_TOL_M = 3.5
/** after merging, bends below this are 直走 */
const TURN_DEG = 35
const UTURN_DEG = 145
/** the destination side (左側/右側) is only mentioned when the final approach is this short */
const SIDE_MAX_M = 15

const fmtM = (m: number) => t('{0} 公尺', Math.max(1, Math.round(m)))

type Side = 'left' | 'right'
type Item =
  | { t: 'run'; start: Maneuver | 'depart' | 'resume'; level: string; xy: XY; distance: number; arriveSide?: Side }
  | { t: 'vertical'; kind: 'elevator' | 'stairs'; level: string; xy: XY; toLevel: string; up?: boolean }

/** vertex with cumulative path length, so merged legs keep their real walking distance */
interface Vtx {
  xy: XY
  s: number
}

/**
 * Merge legs shorter than MERGE_M into the following leg (the last leg into the previous one),
 * so jogs around a room become one straight chord.
 */
export function simplifyLegs(v: Vtx[]): Vtx[] {
  const out = [...v]
  let i = 0
  while (out.length > 2 && i < out.length - 1) {
    if (out[i + 1].s - out[i].s >= MERGE_M) i++
    else if (i + 1 < out.length - 1) out.splice(i + 1, 1)
    else {
      out.splice(i, 1)
      i = Math.max(0, i - 1)
    }
  }
  return out
}

/** Douglas-Peucker: drop vertices within JOG_TOL_M of the chord (detours around a room, door offsets). */
export function straightenJogs(v: Vtx[]): Vtx[] {
  if (v.length <= 2) return v
  let worst = 0
  let idx = -1
  for (let k = 1; k < v.length - 1; k++) {
    const d = projectOnSegment(v[k].xy, v[0].xy, v[v.length - 1].xy).d
    if (d > worst) {
      worst = d
      idx = k
    }
  }
  if (worst <= JOG_TOL_M) return [v[0], v[v.length - 1]]
  return [...straightenJogs(v.slice(0, idx + 1)).slice(0, -1), ...straightenJogs(v.slice(idx))]
}

function turnOf(a: XY, b: XY, c: XY): Maneuver {
  const ang = turnAngle(a, b, c)
  if (Math.abs(ang) >= UTURN_DEG) return 'u-turn'
  if (ang >= TURN_DEG) return 'turn-left'
  if (ang <= -TURN_DEG) return 'turn-right'
  return 'straight'
}

/** Which side the destination is on, from the last corridor leg and the final point. */
function arrivalSide(raw: Vtx[]): Side | undefined {
  const n = raw.length - 1
  for (let j = n - 1; j >= 1; j--) {
    if (raw[j].s - raw[j - 1].s < MERGE_M) continue
    if (raw[n].s - raw[j].s > SIDE_MAX_M) return undefined
    const m = turnOf(raw[j - 1].xy, raw[j].xy, raw[n].xy)
    return m === 'turn-left' ? 'left' : m === 'turn-right' ? 'right' : undefined
  }
  return undefined
}

/** Split the route into straight runs (separated by turns) and floor changes. */
function segment(route: Route, ord?: (id: string) => number): Item[] {
  const pts = route.points
  const items: Item[] = []
  let i = 0
  while (i < pts.length) {
    // one same-level stretch: pts[i..j]
    let j = i
    while (j + 1 < pts.length && pts[j + 1].level === pts[i].level) j++
    const raw: Vtx[] = []
    for (let k = i; k <= j; k++) {
      const prev = raw[raw.length - 1]
      const d = prev ? dist(prev.xy, pts[k].xy) : 0
      if (!prev || d > 1e-6) raw.push({ xy: pts[k].xy, s: (prev?.s ?? 0) + d })
    }
    const v = straightenJogs(simplifyLegs(raw))
    let run: Extract<Item, { t: 'run' }> | null = null
    for (let k = 1; k < v.length; k++) {
      const m = k === 1 ? null : turnOf(v[k - 2].xy, v[k - 1].xy, v[k].xy)
      if (!run || (m && m !== 'straight')) {
        run = { t: 'run', start: run ? m! : items.length === 0 ? 'depart' : 'resume', level: pts[i].level, xy: v[k - 1].xy, distance: 0 }
        items.push(run)
      }
      run.distance += v[k].s - v[k - 1].s
    }
    if (run && j === pts.length - 1) run.arriveSide = arrivalSide(raw)

    if (j + 1 < pts.length) {
      const a = pts[j]
      const b = pts[j + 1]
      const up = ord ? ord(b.level) > ord(a.level) : undefined
      items.push({ t: 'vertical', kind: b.via === 'elevator' ? 'elevator' : 'stairs', level: a.level, xy: a.xy, toLevel: b.level, up })
    }
    i = j + 1
  }
  return items
}

const TURN_TEXT: Record<Maneuver, string> = { 'turn-left': '左轉', 'turn-right': '右轉', 'u-turn': '迴轉', straight: '' }

export function buildSteps(route: Route, opts: InstructionOptions = {}): Step[] {
  const name = opts.levelName ?? ((id: string) => id)
  const destName = t(opts.destinationName ?? '目的地')
  const last = route.points[route.points.length - 1]
  const arrive: Step = { kind: 'arrive', text: t('抵達 {0}', destName), level: last?.level ?? '', xy: last?.xy ?? [0, 0] }
  if (route.points.length < 2) return [{ ...arrive, text: t('您已在{0}', destName) }]

  const items = segment(route, opts.levelOrdinal).filter((it) => it.t === 'vertical' || it.distance >= 0.5)
  const steps: Step[] = []
  items.forEach((it, k) => {
    const prev = items[k - 1]
    const next = items[k + 1]
    if (it.t === 'vertical') {
      const verb = it.up === undefined ? '' : it.up ? t('上樓') : t('下樓')
      steps.push({
        kind: it.kind, level: it.level, xy: it.xy, toLevel: it.toLevel, up: it.up,
        text: t('{0}{1}到 {2}', t(it.kind === 'elevator' ? '搭電梯' : '走樓梯'), verb, name(it.toLevel)),
      })
      return
    }
    const maneuver: Maneuver = next?.t === 'run' && next.start !== 'depart' && next.start !== 'resume' ? next.start : 'straight'
    const end =
      maneuver !== 'straight' ? t('後{0}', t(TURN_TEXT[maneuver]))
      : next?.t === 'vertical' ? (next.kind === 'elevator' ? t('後抵達電梯') : t('後抵達樓梯'))
      : it.arriveSide ? t('後，{0}在{1}側', destName, t(it.arriveSide === 'left' ? '左' : '右'))
      : t('後抵達 {0}', destName)
    const prefix = prev?.t === 'vertical' ? (prev.kind === 'elevator' ? t('出電梯，') : t('離開樓梯，')) : ''
    steps.push({ kind: 'walk', level: it.level, xy: it.xy, maneuver, distance: it.distance, text: t('{0}直走 {1}{2}', prefix, fmtM(it.distance), end) })
  })
  steps.push(arrive)
  return steps
}
