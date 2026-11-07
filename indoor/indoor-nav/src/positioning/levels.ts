/**
 * Automatic floor-change detection: barometer step detector, WiFi level voting and level connectors (elevators /
 * stairs from nav.geojson). The engine fuses them (engine.ts, autoLevel).
 */
import type { NavFeature } from '../data/types'

export interface BaroOptions {
  /** |pressure − reference| that counts as a floor change (hPa). The engine derives it from the venue: 55% of the
   *  smallest storey height (tianmu 5 m -> 0.33 hPa); a real elevator ride there drops only ~0.4–0.5 hPa, which the
   *  earlier fixed 0.45 hPa missed (and re-referenced away as drift after 60 s) */
  stepHpa: number
  /** the change must hold this long (ms) */
  holdMs: number
  /** and must have built up within this window (ms) — slower changes are weather and get re-referenced */
  windowMs: number
  /** smoothing time constant of the pressure (ms) */
  smoothMs: number
  /** the reference follows the pressure with this time constant while it stays within followHpa (weather drift) */
  refFollowMs: number
  followHpa: number
  /** after an event, ignore further events for this long (ms) */
  holdOffMs: number
  /** hPa per metre of height near sea level */
  hpaPerM: number
}

export const DEFAULT_BARO: BaroOptions = {
  stepHpa: 0.33,
  holdMs: 5000,
  windowMs: 60000,
  smoothMs: 2000,
  refFollowMs: 60000,
  followHpa: 0.15,
  holdOffMs: 10000,
  hpaPerM: 0.12,
}

export interface BaroEvent {
  t: number
  /** smoothed pressure − reference (hPa); negative = went up */
  deltaHpa: number
  /** height change (m), positive = up */
  dhM: number
}

/**
 * Relative barometric step detector. Works on pressure differences only (no absolute altitude); timestamps are only
 * used for durations, so a constant clock offset (iOS bridge) does not matter.
 */
export class BaroDetector {
  readonly o: BaroOptions
  /** smoothed pressure, reference (hPa) and the current delta */
  p: number | null = null
  ref: number | null = null
  private recent: number[] = []
  private tLast = -Infinity
  private outSince: number | null = null
  private partialSince: number | null = null
  private holdOffUntil = -Infinity

  constructor(opts: Partial<BaroOptions> = {}) {
    this.o = { ...DEFAULT_BARO, ...opts }
  }

  get delta(): number {
    return this.p !== null && this.ref !== null ? this.p - this.ref : 0
  }

  /** forget the reference (new level set from outside): the next samples define it */
  reset() {
    this.ref = this.p
    this.outSince = this.partialSince = null
  }

  push(t: number, hpa: number): BaroEvent | null {
    if (!Number.isFinite(hpa) || hpa < 300 || hpa > 1100 || t <= this.tLast) return null
    const dt = Number.isFinite(this.tLast) ? Math.min(t - this.tLast, 10000) : 0
    this.tLast = t
    // median of the last 5 raw samples (spikes), then a time-based EMA
    this.recent.push(hpa)
    if (this.recent.length > 5) this.recent.shift()
    const med = [...this.recent].sort((a, b) => a - b)[this.recent.length >> 1]
    this.p = this.p === null ? med : this.p + (dt / (this.o.smoothMs + dt)) * (med - this.p)
    if (this.ref === null) this.ref = this.p
    const d = this.p - this.ref
    const ad = Math.abs(d)
    if (ad < this.o.followHpa) {
      // on the level: follow slow weather drift
      this.ref += (dt / (this.o.refFollowMs + dt)) * d
      this.outSince = this.partialSince = null
      return null
    }
    if (ad < this.o.stepHpa) {
      // partly off: if it stays there longer than the window it is drift (or a half step), re-reference
      this.outSince = null
      this.partialSince ??= t
      if (t - this.partialSince > this.o.windowMs) {
        this.ref = this.p
        this.partialSince = null
      }
      return null
    }
    this.outSince ??= t
    if (this.partialSince !== null && t - this.partialSince > this.o.windowMs) {
      // built up too slowly to be a floor change
      this.ref = this.p
      this.outSince = this.partialSince = null
      return null
    }
    if (t - this.outSince < this.o.holdMs || t < this.holdOffUntil) return null
    const ev: BaroEvent = { t, deltaHpa: d, dhM: -d / this.o.hpaPerM }
    this.ref = this.p
    this.outSince = this.partialSince = null
    this.holdOffUntil = t + this.o.holdOffMs
    return ev
  }
}

/** Level whose elevation best matches a height change from `from`; null if none is close enough. */
export function levelForHeightChange(levels: { id: string; elevation_m?: number; ordinal: number }[], from: string, dhM: number): string | null {
  const cur = levels.find((l) => l.id === from)
  if (!cur) return null
  const e0 = cur.elevation_m ?? cur.ordinal * 5
  let best: { id: string; err: number; diff: number } | null = null
  for (const l of levels) {
    if (l.id === from) continue
    const diff = (l.elevation_m ?? l.ordinal * 5) - e0
    if (Math.sign(diff) !== Math.sign(dhM)) continue
    const err = Math.abs(diff - dhM)
    if (!best || err < best.err) best = { id: l.id, err, diff }
  }
  return best && best.err <= Math.max(2.5, 0.5 * Math.abs(best.diff)) ? best.id : null
}

export interface Connector { level: string; id: string; x: number; y: number; partners: { level: string; id: string; x: number; y: number }[] }

/** Elevator / stairs nodes that link levels (cross-level edges in nav.geojson). */
export function levelConnectors(nav: NavFeature[]): Connector[] {
  const nodes = new Map<string, { level: string; x: number; y: number }>()
  for (const f of nav) {
    if (f.properties.kind === 'node') {
      const [x, y] = f.geometry.coordinates as [number, number]
      nodes.set(f.properties.id, { level: f.properties.level, x, y })
    }
  }
  const out = new Map<string, Connector>()
  for (const f of nav) {
    const e = f.properties
    if (e.kind !== 'edge') continue
    const a = nodes.get(e.from)
    const b = nodes.get(e.to)
    if (!a || !b || a.level === b.level) continue
    for (const [id, n, pid, p] of [[e.from, a, e.to, b], [e.to, b, e.from, a]] as const) {
      const c = out.get(id) ?? { level: n.level, id, x: n.x, y: n.y, partners: [] }
      if (!c.partners.some((q) => q.id === pid)) c.partners.push({ level: p.level, id: pid, x: p.x, y: p.y })
      out.set(id, c)
    }
  }
  return [...out.values()]
}

/** Nearest connector on `level` with a partner on `to` (and its distance). */
export function nearestConnector(connectors: Connector[], level: string, to: string, x: number, y: number) {
  let best: { c: Connector; partner: Connector['partners'][number]; d: number } | null = null
  for (const c of connectors) {
    if (c.level !== level) continue
    const partner = c.partners.find((p) => p.level === to)
    if (!partner) continue
    const d = Math.hypot(c.x - x, c.y - y)
    if (!best || d < best.d) best = { c, partner, d }
  }
  return best
}

export interface WifiLevelVote {
  /** best WkNN distance (dB) per level for the last fresh scan */
  dist: Record<string, number>
  /** level that beat the current one by the margin, and for how many consecutive scans */
  candidate: string | null
  streak: number
}

/**
 * Track which level's fingerprints match fresh scans best. A candidate is another level that beats the current
 * level's best distance by marginDb; streak counts consecutive scans voting for it.
 */
export class WifiLevelVoter {
  vote: WifiLevelVote = { dist: {}, candidate: null, streak: 0 }

  update(current: string, perLevel: Record<string, number>, marginDb: number): WifiLevelVote {
    const cur = perLevel[current] ?? Infinity
    let best: string | null = null
    for (const [l, d] of Object.entries(perLevel)) if (l !== current && Number.isFinite(d) && (best === null || d < perLevel[best])) best = l
    const winner = best !== null && perLevel[best] + marginDb < cur ? best : null
    const streak = winner !== null && winner === this.vote.candidate ? this.vote.streak + 1 : winner !== null ? 1 : 0
    this.vote = { dist: perLevel, candidate: winner, streak }
    return this.vote
  }

  reset() {
    this.vote = { dist: {}, candidate: null, streak: 0 }
  }
}

