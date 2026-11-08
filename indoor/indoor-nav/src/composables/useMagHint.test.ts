import { afterEach, describe, expect, it, vi } from 'vitest'
import { effectScope, nextTick, ref } from 'vue'
import type { MagnetometerStatus } from '../bridge/townpass'
import { lowSensorRate, MAG_SILENCE_MS, needsMagCalibration, useMagCalibrationHint, useSensorHints } from './useMagHint'

const st = (o: Partial<MagnetometerStatus>): MagnetometerStatus => ({ streaming: true, streamingForMs: 10000, sinceLastSampleMs: 100, accuracy: null, ...o })

describe('needsMagCalibration', () => {
  it('only while streaming, after the grace period', () => {
    expect(needsMagCalibration(st({ streaming: false, sinceLastSampleMs: Infinity }))).toBe(false)
    expect(needsMagCalibration(st({ streamingForMs: MAG_SILENCE_MS - 1, sinceLastSampleMs: Infinity }))).toBe(false)
  })
  it('silent magnetometer (uncalibrated iPhone) -> hint; samples -> no hint', () => {
    expect(needsMagCalibration(st({ sinceLastSampleMs: Infinity }))).toBe(true)
    expect(needsMagCalibration(st({ sinceLastSampleMs: MAG_SILENCE_MS + 1 }))).toBe(true)
    expect(needsMagCalibration(st({ sinceLastSampleMs: 200, accuracy: 2 }))).toBe(false)
    expect(needsMagCalibration(st({ sinceLastSampleMs: 200 }))).toBe(false) // Android: no accuracy field
  })
  it('reported accuracy below 1 -> hint', () => {
    expect(needsMagCalibration(st({ accuracy: 0 }))).toBe(true)
  })
})

describe('useMagCalibrationHint', () => {
  afterEach(() => vi.useRealTimers())

  it('shows while active and silent, can be dismissed, and re-arms after samples return', async () => {
    vi.useFakeTimers()
    let status = st({ sinceLastSampleMs: Infinity })
    const bridge = { magnetometerStatus: () => status, gyroscopeRateHz: () => 50 }
    const active = ref(true)
    const scope = effectScope()
    const h = scope.run(() => useMagCalibrationHint(() => active.value, bridge, 100))!
    vi.advanceTimersByTime(150)
    expect(h.show.value).toBe(true)
    h.dismiss()
    vi.advanceTimersByTime(300)
    expect(h.show.value).toBe(false) // stays dismissed while still silent
    status = st({ sinceLastSampleMs: 50, accuracy: 2 }) // calibrated samples arrive
    vi.advanceTimersByTime(150)
    expect(h.show.value).toBe(false)
    status = st({ sinceLastSampleMs: Infinity }) // lost again -> shows again
    vi.advanceTimersByTime(150)
    expect(h.show.value).toBe(true)
    active.value = false // positioning stopped
    await nextTick()
    expect(h.show.value).toBe(false)
    scope.stop()
  })
})

describe('power-saving (low sensor rate) hint', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('lowSensorRate: below 35 Hz, not before a rate is known', () => {
    expect(lowSensorRate(null)).toBe(false)
    expect(lowSensorRate(21)).toBe(true)
    expect(lowSensorRate(49.8)).toBe(false)
  })

  it('shows at ~21 Hz while active, and the dismissal is remembered for the session', () => {
    vi.useFakeTimers()
    const store = new Map<string, string>()
    vi.stubGlobal('sessionStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v) })
    const bridge = { magnetometerStatus: () => ({ streaming: true, streamingForMs: 10000, sinceLastSampleMs: 50, accuracy: null }), gyroscopeRateHz: () => 21 as number | null }
    const scope = effectScope()
    const h = scope.run(() => useSensorHints(() => true, bridge, 100))!
    vi.advanceTimersByTime(150)
    expect(h.power.value).toBe(true)
    expect(h.mag.value).toBe(false)
    h.dismissPower()
    vi.advanceTimersByTime(300)
    expect(h.power.value).toBe(false)
    scope.stop()
    // a new hint instance in the same session (e.g. after a remount) stays dismissed
    const scope2 = effectScope()
    const h2 = scope2.run(() => useSensorHints(() => true, bridge, 100))!
    vi.advanceTimersByTime(150)
    expect(h2.power.value).toBe(false)
    scope2.stop()
  })
})
