/**
 * Automatic start position (no QR codes): on open the positioning engine runs in a "locate" phase
 * and self-initialises from the first WiFi scan; the user confirms the estimate or corrects it on
 * the map. Pure state machine, driven by the app (see App.vue) and unit-tested.
 *
 *   idle ──begin──▶ locating ──wifi estimate──▶ estimate ──confirm──▶ confirmed
 *                     │  ▲                         │ (later scans refresh the estimate)
 *                     │  └──────────────┐          └──correct(tap)──▶ corrected
 *          timeout / no WiFi / no radiomap / no bridge
 *                     ▼
 *                  fallback ──correct(tap)──▶ corrected   (start stays at the default entrance until then)
 */
import type { XY } from '../geo/frame'

export type LocateState = 'idle' | 'locating' | 'estimate' | 'confirmed' | 'corrected' | 'fallback'
export type FallbackReason = 'timeout' | 'no-wifi' | 'no-radiomap' | 'unavailable'

export interface Estimate {
  level: string
  xy: XY
  accuracy_m: number
}

export const LOCATE_TIMEOUT_MS = 10000

export class StartLocator {
  state: LocateState = 'idle'
  estimate: Estimate | null = null
  reason: FallbackReason | null = null
  /** the confirmed / corrected start */
  result: (Estimate & { source: 'wifi' | 'tap' }) | null = null
  private startedAt = 0

  /** Enter the locate phase. `canLocate` = inside TownPass on Android with a radiomap. */
  begin(now: number, canLocate: true | FallbackReason): LocateState {
    this.estimate = null
    this.result = null
    if (canLocate !== true) return this.fallback(canLocate)
    this.state = 'locating'
    this.reason = null
    this.startedAt = now
    return this.state
  }

  /** An engine update. Only WiFi-derived fixes count as an estimate (PDR alone has no absolute position). */
  update(u: { source: string; level: string; x: number; y: number; accuracy_m: number }): LocateState {
    if (this.state === 'locating' && u.source === 'wifi') this.state = 'estimate'
    if (this.state === 'estimate') this.estimate = { level: u.level, xy: [u.x, u.y], accuracy_m: u.accuracy_m }
    return this.state
  }

  /** A WiFi scan result arrived; `supported: false` (iOS) means no estimate will ever come. */
  wifiScan(supported: boolean): LocateState {
    if (!supported && this.state === 'locating') return this.fallback('no-wifi')
    return this.state
  }

  /** Call periodically; gives up waiting after LOCATE_TIMEOUT_MS. */
  tick(now: number): LocateState {
    if (this.state === 'locating' && now - this.startedAt >= LOCATE_TIMEOUT_MS) return this.fallback('timeout')
    return this.state
  }

  /** 「是」: accept the current estimate as the start. */
  confirm(): LocateState {
    if (this.state !== 'estimate' || !this.estimate) return this.state
    this.result = { ...this.estimate, source: 'wifi' }
    this.state = 'confirmed'
    return this.state
  }

  /** 「點地圖修正」 / 「請點地圖標出你的位置」: the user marked the start on the map. */
  correct(level: string, xy: XY): LocateState {
    if (this.state === 'idle') return this.state
    this.result = { level, xy, accuracy_m: 1, source: 'tap' }
    this.state = 'corrected'
    return this.state
  }

  /** the user picked a start some other way (QR code, place card, ?start=): the locate phase is over */
  dismiss(): LocateState {
    this.state = 'idle'
    return this.state
  }

  /** still asking the user (chip shows the locate UI) */
  get pending(): boolean {
    return this.state === 'locating' || this.state === 'estimate' || this.state === 'fallback'
  }

  private fallback(reason: FallbackReason): LocateState {
    this.state = 'fallback'
    this.reason = reason
    this.estimate = null
    return this.state
  }
}
