/**
 * Reacting to the positioning engine's automatic floor-change detection
 * (`onLevelChange({ t, from, to, source, confidence })`, barometer and/or WiFi level vote).
 *
 * - Navigating, current/next step is the matching floor change → advance past it (as if
 *   「已到 2F」 was pressed), with an undo 「不對，還在 1F」.
 * - Navigating, unexpected floor → reroute from the new floor.
 * - Not navigating → follow the detected floor, unless the user picked a floor in the last 10 s
 *   (then only suggest it).
 * The manual 「已到 2F」 button stays the fallback (no barometer, no 2F WiFi data yet).
 */
import type { XY } from '../geo/frame'
import type { Step } from '../routing/instructions'

export interface LevelChangeEvent {
  t: number
  from: string
  to: string
  source: 'barometer' | 'wifi' | 'both'
  confidence: number
}

export const LEVEL_SOURCE_TEXT: Record<LevelChangeEvent['source'], string> = { barometer: '氣壓', wifi: 'WiFi', both: '氣壓＋WiFi' }
/** a manual floor pick within this window wins over detection (only a suggestion is shown) */
export const MANUAL_PICK_MS = 10000

export interface LevelContext {
  navigating: boolean
  steps: Step[]
  activeStep: number
  /** floor shown in the level switcher */
  displayedLevel: string
  /** last time the user picked a floor by hand (epoch ms) */
  lastManualPickAt: number
  now: number
}

export interface UndoInfo {
  step: number
  level: string
  /** the connector (elevator / stairs) on the previous floor, to re-seed the engine there */
  xy: XY
}

export type LevelAction =
  | { kind: 'advance'; step: number; level: string; undo: UndoInfo }
  | { kind: 'reroute'; level: string }
  | { kind: 'follow'; level: string }
  | { kind: 'suggest'; level: string }
  | { kind: 'none' }

const isVertical = (s: Step | undefined) => s?.kind === 'elevator' || s?.kind === 'stairs'

export function decideLevelChange(e: LevelChangeEvent, c: LevelContext): LevelAction {
  if (e.from === e.to) return { kind: 'none' }
  if (!c.navigating) {
    if (e.to === c.displayedLevel) return { kind: 'none' }
    return c.now - c.lastManualPickAt < MANUAL_PICK_MS ? { kind: 'suggest', level: e.to } : { kind: 'follow', level: e.to }
  }
  const cur = c.steps[c.activeStep]
  if (!cur) return { kind: 'none' }
  // already on that floor (e.g. the user confirmed by hand just before)
  if (!isVertical(cur) && cur.level === e.to) return { kind: 'none' }
  // the next floor change on the route (the current step, or the one the current walk leads to)
  const v = c.steps.findIndex((s, i) => i >= c.activeStep && isVertical(s))
  const vs = c.steps[v]
  if (v >= 0 && vs.toLevel === e.to && vs.level === e.from) {
    return { kind: 'advance', step: Math.min(v + 1, c.steps.length - 1), level: e.to, undo: { step: c.activeStep, level: e.from, xy: vs.xy } }
  }
  return { kind: 'reroute', level: e.to }
}

export interface LevelHooks {
  context(): LevelContext
  advance(step: number, level: string): void
  /** undo an auto-advance: back to the step, floor and connector position */
  undoTo(u: UndoInfo): void
  reroute(level: string): void
  follow(level: string): void
  suggest(level: string): void
  /** aria-live message; `undoLabel` present when the change can be undone */
  notify(text: string, undoLabel?: string): void
}

export class LevelChangeController {
  private lastUndo: UndoInfo | null = null
  private readonly hooks: LevelHooks

  constructor(hooks: LevelHooks) {
    this.hooks = hooks
  }

  handle(e: LevelChangeEvent): LevelAction {
    const a = decideLevelChange(e, this.hooks.context())
    const src = LEVEL_SOURCE_TEXT[e.source] ?? e.source
    switch (a.kind) {
      case 'advance':
        this.lastUndo = a.undo
        this.hooks.advance(a.step, a.level)
        this.hooks.notify(`已偵測到 ${a.level}（${src}）`, `不對，還在 ${a.undo.level}`)
        break
      case 'reroute':
        this.lastUndo = null
        this.hooks.reroute(a.level)
        this.hooks.notify(`已偵測到 ${a.level}（${src}），重新規劃路線`)
        break
      case 'follow':
        this.hooks.follow(a.level)
        this.hooks.notify(`已偵測到 ${a.level}（${src}）`)
        break
      case 'suggest':
        this.hooks.suggest(a.level)
        break
    }
    return a
  }

  /** 「不對，還在 1F」 */
  undo(): boolean {
    const u = this.lastUndo
    if (!u) return false
    this.lastUndo = null
    this.hooks.undoTo(u)
    return true
  }
}
