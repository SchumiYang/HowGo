import { describe, expect, it } from 'vitest'
import type { Step } from '../routing/instructions'
import { decideLevelChange, LevelChangeController, MANUAL_PICK_MS, type LevelChangeEvent, type LevelContext, type UndoInfo } from './levelChange'

// 1F walk -> walk to the elevator -> elevator to 2F -> 2F walk -> arrive
const steps: Step[] = [
  { kind: 'walk', text: '直走 10 公尺後左轉', level: '1F', xy: [0, 0], maneuver: 'turn-left', distance: 10 },
  { kind: 'walk', text: '直走 20 公尺後抵達電梯', level: '1F', xy: [10, 0], maneuver: 'straight', distance: 20 },
  { kind: 'elevator', text: '搭電梯上樓到 2F', level: '1F', xy: [10, 20], toLevel: '2F', up: true },
  { kind: 'walk', text: '出電梯，直走 8 公尺後抵達 X', level: '2F', xy: [10, 20], maneuver: 'straight', distance: 8 },
  { kind: 'arrive', text: '抵達 X', level: '2F', xy: [18, 20] },
]
const ev = (to: string, source: LevelChangeEvent['source'] = 'barometer', from = '1F'): LevelChangeEvent => ({ t: 0, from, to, source, confidence: 0.9 })
const ctx = (o: Partial<LevelContext>): LevelContext => ({ navigating: true, steps, activeStep: 2, displayedLevel: '1F', lastManualPickAt: 0, now: 100000, ...o })

describe('decideLevelChange', () => {
  it('at the elevator step, reaching its floor advances past it', () => {
    expect(decideLevelChange(ev('2F'), ctx({}))).toEqual({ kind: 'advance', step: 3, level: '2F', undo: { step: 2, level: '1F', xy: [10, 20] } })
  })
  it('still walking to the elevator (tracker behind): advances past the floor change too', () => {
    expect(decideLevelChange(ev('2F', 'wifi'), ctx({ activeStep: 1 }))).toMatchObject({ kind: 'advance', step: 3, undo: { step: 1 } })
  })
  it('a floor the route does not expect -> reroute', () => {
    expect(decideLevelChange(ev('3F'), ctx({}))).toEqual({ kind: 'reroute', level: '3F' })
    // already on 2F (after the floor change), detected back on 1F
    expect(decideLevelChange(ev('1F', 'barometer', '2F'), ctx({ activeStep: 3 }))).toEqual({ kind: 'reroute', level: '1F' })
  })
  it('no-op when already confirmed by hand', () => {
    expect(decideLevelChange(ev('2F'), ctx({ activeStep: 3 }))).toEqual({ kind: 'none' })
  })
  it('outside navigation: follow, unless the user picked a floor in the last 10 s', () => {
    expect(decideLevelChange(ev('2F'), ctx({ navigating: false }))).toEqual({ kind: 'follow', level: '2F' })
    expect(decideLevelChange(ev('2F'), ctx({ navigating: false, lastManualPickAt: 100000 - MANUAL_PICK_MS + 1 }))).toEqual({ kind: 'suggest', level: '2F' })
    expect(decideLevelChange(ev('2F'), ctx({ navigating: false, displayedLevel: '2F' }))).toEqual({ kind: 'none' })
  })
})

describe('LevelChangeController with a fake engine', () => {
  function setup(c: Partial<LevelContext> = {}) {
    const calls: string[] = []
    let state = ctx(c)
    let undone: UndoInfo | null = null
    const ctl = new LevelChangeController({
      context: () => state,
      advance: (step, level) => {
        calls.push(`advance ${step} ${level}`)
        state = { ...state, activeStep: step, displayedLevel: level }
      },
      undoTo: (u) => {
        undone = u
        calls.push(`undo ${u.step} ${u.level}`)
        state = { ...state, activeStep: u.step, displayedLevel: u.level }
      },
      reroute: (l) => calls.push(`reroute ${l}`),
      follow: (l) => calls.push(`follow ${l}`),
      suggest: (l) => calls.push(`suggest ${l}`),
      notify: (t, u) => calls.push(`notify ${t}${u ? ` [${u}]` : ''}`),
    })
    // the fake engine: just emits events into the controller
    const engine = { emit: (e: LevelChangeEvent) => ctl.handle(e) }
    return { ctl, engine, calls, get undone() { return undone }, get state() { return state } }
  }

  it('auto-advance with an undo toast, and undo restores step + floor + connector', () => {
    const t = setup()
    t.engine.emit(ev('2F', 'barometer'))
    expect(t.calls).toEqual(['advance 3 2F', 'notify 已偵測到 2F（氣壓） [不對，還在 1F]'])
    expect(t.ctl.undo()).toBe(true)
    expect(t.calls.at(-1)).toBe('undo 2 1F')
    expect(t.undone).toEqual({ step: 2, level: '1F', xy: [10, 20] })
    expect(t.state.activeStep).toBe(2)
    expect(t.ctl.undo()).toBe(false) // one undo per detection
  })

  it('reroutes on an unexpected floor (WiFi) without an undo', () => {
    const t = setup({ activeStep: 0 })
    t.engine.emit(ev('3F', 'wifi'))
    expect(t.calls).toEqual(['reroute 3F', 'notify 已偵測到 3F（WiFi），重新規劃路線'])
    expect(t.ctl.undo()).toBe(false)
  })

  it('outside navigation: follows with a toast, or only suggests after a manual pick', () => {
    const a = setup({ navigating: false })
    a.engine.emit(ev('2F', 'both'))
    expect(a.calls).toEqual(['follow 2F', 'notify 已偵測到 2F（氣壓＋WiFi）'])
    const b = setup({ navigating: false, lastManualPickAt: 99000 })
    b.engine.emit(ev('2F'))
    expect(b.calls).toEqual(['suggest 2F'])
  })
})
