import { describe, expect, it } from 'vitest'
import { LOCATE_TIMEOUT_MS, StartLocator } from './startLocator'

const wifiFix = (x: number, y: number, acc = 12) => ({ source: 'wifi', level: '1F', x, y, accuracy_m: acc })

describe('start locator', () => {
  it('locating -> estimate on the first WiFi fix -> confirmed', () => {
    const s = new StartLocator()
    expect(s.begin(0, true)).toBe('locating')
    // PDR-only updates (no absolute position) don't count
    expect(s.update({ source: 'pdr', level: '1F', x: 1, y: 1, accuracy_m: 3 })).toBe('locating')
    expect(s.update(wifiFix(40, 30))).toBe('estimate')
    expect(s.estimate).toEqual({ level: '1F', xy: [40, 30], accuracy_m: 12 })
    // later updates refresh the unconfirmed estimate
    s.update({ source: 'fused', level: '1F', x: 41, y: 31, accuracy_m: 9 })
    expect(s.estimate?.xy).toEqual([41, 31])
    expect(s.pending).toBe(true)
    expect(s.confirm()).toBe('confirmed')
    expect(s.result).toEqual({ level: '1F', xy: [41, 31], accuracy_m: 9, source: 'wifi' })
    expect(s.pending).toBe(false)
    // nothing changes after confirmation
    s.update(wifiFix(0, 0))
    expect(s.result?.xy).toEqual([41, 31])
  })

  it('estimate -> corrected by a map tap', () => {
    const s = new StartLocator()
    s.begin(0, true)
    s.update(wifiFix(40, 30, 17))
    expect(s.correct('1F', [5, 34])).toBe('corrected')
    expect(s.result).toEqual({ level: '1F', xy: [5, 34], accuracy_m: 1, source: 'tap' })
  })

  it('falls back after the timeout, and a tap still corrects', () => {
    const s = new StartLocator()
    s.begin(1000, true)
    expect(s.tick(1000 + LOCATE_TIMEOUT_MS - 1)).toBe('locating')
    expect(s.tick(1000 + LOCATE_TIMEOUT_MS)).toBe('fallback')
    expect(s.reason).toBe('timeout')
    expect(s.pending).toBe(true)
    // a late WiFi fix doesn't reopen the question
    expect(s.update(wifiFix(40, 30))).toBe('fallback')
    expect(s.confirm()).toBe('fallback')
    expect(s.correct('1F', [10, 20])).toBe('corrected')
  })

  it('falls back immediately on iOS (wifi_scan supported:false), without a radiomap, or outside TownPass', () => {
    const ios = new StartLocator()
    ios.begin(0, true)
    expect(ios.wifiScan(false)).toBe('fallback')
    expect(ios.reason).toBe('no-wifi')
    const noMap = new StartLocator()
    expect(noMap.begin(0, 'no-radiomap')).toBe('fallback')
    const browser = new StartLocator()
    expect(browser.begin(0, 'unavailable')).toBe('fallback')
    expect(browser.reason).toBe('unavailable')
  })

  it('confirm is ignored without an estimate; dismiss ends the phase', () => {
    const s = new StartLocator()
    s.begin(0, true)
    expect(s.confirm()).toBe('locating')
    expect(s.dismiss()).toBe('idle')
    expect(s.pending).toBe(false)
  })
})
