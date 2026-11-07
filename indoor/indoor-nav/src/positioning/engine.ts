/**
 * Positioning facade for the app: consumes the TownPass bridge's sensor_stream and wifi_scan_stream and emits
 * PositionUpdate (SURVEY_SCHEMA.md §4) after every detected step and every fresh WiFi scan.
 *
 * Runs on the main thread: per step it moves 2000 particles (a few cell checks each) and looks up the magnetic
 * map, well under a millisecond; a WiFi update (every ~30 s on Android) costs a few ms. No worker needed.
 *
 * Initialisation: setKnownPosition() (start point chosen in the app / QR anchor) or, on Android, the first fresh
 * WiFi scan (WkNN). iOS has no WiFi scan: without a known position there is no output.
 *
 * Floor changes (autoLevel): a barometric step (levels.ts) switches level anywhere; WiFi level voting confirms it, or
 * alone switches with a strong margin over consecutive scans near an elevator / stairs. The filter is re-seeded at
 * the matching connector of the new level (1F-el2 -> 2F-el2). setKnownPosition stays authoritative.
 */
import type { SensorBatch, SensorStreamOptions, WifiScan } from '../bridge/townpass'
import { venueBaseUrl } from '../data/loader'
import type { VenueData } from '../data/types'
import { OccupancyGrid, type GridOptions } from './grid'
import {
  BaroDetector, type BaroEvent, type BaroOptions, type Connector, levelConnectors, levelForHeightChange, nearestConnector,
  type WifiLevelVote, WifiLevelVoter,
} from './levels'
import { DEFAULT_MAG, MagGrid, type MagOptions } from './magnetic'
import { ParticleFilter, type HeadingPrior, type PfOptions } from './particleFilter'
import { Pdr, type PdrOptions, type StepEvent } from './pdr'
import { mulberry32 } from './rng'
import type { LevelChange, Magmap, PositionSource, PositionUpdate, Radiomap } from './types'
import { WifiModel, type WknnResult, type WifiOptions } from './wifi'

const DEG = Math.PI / 180

/** The subset of TownPassBridge the engine uses (TownPassBridge satisfies it). */
export interface PositioningBridge {
  startSensorStream(opts: SensorStreamOptions): boolean
  stopSensorStream(): Promise<unknown>
  onSensorBatch(cb: (batch: SensorBatch) => void): () => void
  startWifiStream?(interval_ms: number): boolean
  stopWifiStream?(): Promise<unknown>
  onWifiScan?(cb: (scan: WifiScan, source: 'single' | 'stream') => void): () => void
}

export interface PositioningOptions {
  /** level to track; default radiomap level, else venue default level */
  level: string | null
  useWifi: boolean
  useMagnetic: boolean
  /** maps built from synthetic-* sessions are ignored unless true (tests / evaluation only) */
  allowSyntheticMaps: boolean
  /** PRNG seed for reproducible runs; null = Math.random */
  seed: number | null
  /** magnetic declination (deg, east positive); Taipei ≈ −4.5 */
  declinationDeg: number
  /** inject particles at the WiFi fix when the filter is this far away (m) and explains the scan poorly */
  relocalizeM: number
  /** use a scan only if this share of the particle weight is within 5 m of a fingerprint */
  wifiMinCoverage: number
  /** WiFi-only initialisation: number of best fingerprints seeded, and spread around each (m) */
  wifiInitSeeds: number
  wifiInitSigmaM: number
  /** door hops (particleFilter.hop): radius around a door-edge end (m) and probability per step; 0 disables */
  doorHopRadiusM: number
  doorHopProb: number
  /**
   * accuracy_m = max(floorM, scale · sqrt(spread² + baseM²)), spread = 1σ radial spread of the particle cloud. The
   * cloud alone is overconfident (correlated errors, unmodelled reference / map error); scale and floor are
   * calibrated on the leave-one-walk-out replays so that ~68% of errors fall within accuracy_m.
   */
  accuracy: { scale: number; floorM: number; baseM: number }
  /** treat the output as 'fused' for this long after the last WiFi / magnetic update (ms) */
  fusedHoldMs: number
  /** detect floor changes (barometer + WiFi) and switch level automatically */
  autoLevel: boolean
  baro: Partial<BaroOptions>
  /** WiFi level vote: another level's best match must beat the current level by marginDb (support for the barometer);
   *  to switch on WiFi alone: by strongMarginDb for `scans` consecutive fresh scans, within connectorRadiusM of a
   *  level connector, and not while a working barometer says the floor did not change. A WiFi-only start begins on
   *  the entrance level and may move within its first initialWindowScans fresh scans (same margin, anywhere) */
  wifiLevel: { marginDb: number; strongMarginDb: number; scans: number; connectorRadiusM: number; initialWindowScans: number }
  pdr: Partial<PdrOptions>
  wifi: Partial<WifiOptions>
  mag: Partial<MagOptions>
  pf: Partial<PfOptions>
  grid: Partial<GridOptions>
}

export const DEFAULT_POSITIONING: PositioningOptions = {
  level: null,
  useWifi: true,
  useMagnetic: true,
  allowSyntheticMaps: false,
  seed: null,
  declinationDeg: -4.5,
  relocalizeM: 12,
  wifiMinCoverage: 0.6,
  wifiInitSeeds: 8,
  wifiInitSigmaM: 2,
  doorHopRadiusM: 2,
  doorHopProb: 0.04,
  // calibrated on the replayed live runs of 2026-11-07 (A71 + Pixel 9a, 16 checkpoints, errors 1–6 m): 69% of
  // checkpoint errors within accuracy_m (the earlier ±2 m covered 0/8 on the A71). LOWO replays are optimistic
  // (their reference shares the walk's own steps) and show ~98% with this setting
  accuracy: { scale: 2, floorM: 3, baseM: 1.5 },
  fusedHoldMs: 20000,
  autoLevel: true,
  baro: {},
  wifiLevel: { marginDb: 2, strongMarginDb: 4, scans: 2, connectorRadiusM: 10, initialWindowScans: 4 },
  pdr: {},
  wifi: {},
  mag: {},
  pf: {},
  grid: {},
}

export interface PositioningConfig {
  venueData: VenueData
  radiomap?: Radiomap | null
  /** one map per level */
  magmap?: Magmap | Magmap[] | null
  options?: Partial<PositioningOptions>
}

export interface StartOptions {
  sensorIntervalMs?: number
  batchMs?: number
  /** wifi_scan_stream interval; Android allows 4 foreground scans per 2 min, so ~30 s. null = no WiFi */
  wifiIntervalMs?: number | null
}

export interface KnownPositionOptions {
  /** 1σ uncertainty of the given position (m), default 1 */
  accuracyM?: number
  /** walking direction if known (deg clockwise from local +y); otherwise the compass is a weak prior */
  headingDeg?: number | null
  /** time of the fix (epoch ms), default now (replays pass the recorded time) */
  t?: number
}

export interface PositioningStats {
  initialized: boolean
  level: string
  steps: number
  wifiScans: number
  wifiUsed: number
  magSteps: number
  relocalizations: number
  lostSteps: number
  deviceOffsetDb: number
  /** false when the session's magnetometer is implausible vs the map (magnetic matching + compass off) */
  magHealthy: boolean
  magNote: string | null
  lastWknn: WknnResult | null
  maps: { wifi: boolean; magnetic: boolean }
  /** barometer: null until known, false when the phone has none (A71) */
  baroAvailable: boolean | null
  /** smoothed pressure − reference of the current level (hPa; negative = higher up) */
  pressureDeltaHpa: number | null
  /** last WiFi level vote (best WkNN distance per level, candidate level, consecutive scans) */
  wifiLevelVote: WifiLevelVote | null
  levelChanges: number
}

export interface Positioning {
  start(bridge: PositioningBridge, opts?: StartOptions): boolean
  stop(): Promise<void>
  setKnownPosition(x: number, y: number, level?: string, opts?: KnownPositionOptions): void
  onUpdate(cb: (u: PositionUpdate) => void): () => void
  /** automatic floor changes (autoLevel); a position update on the new level follows */
  onLevelChange(cb: (c: LevelChange) => void): () => void
  /** feed data directly (replay, tests); start() wires these to the bridge. receivedAt (epoch ms of arrival)
   *  enables correction of a sensor clock that is off the wall clock */
  pushSensorBatch(batch: SensorBatch, receivedAt?: number): void
  pushWifiScan(scan: WifiScan): void
  readonly last: PositionUpdate | null
  readonly stats: PositioningStats
}

class PositioningEngine implements Positioning {
  private readonly o: PositioningOptions
  private readonly venueData: VenueData
  private readonly radiomap: Radiomap | null
  private readonly magmaps = new Map<string, Magmap>()
  private readonly grids = new Map<string, OccupancyGrid>()
  private readonly portals = new Map<string, number[][]>()
  private readonly magGrids = new Map<string, MagGrid>()
  private readonly magOpts: MagOptions
  private readonly rng: () => number
  private level: string
  private pdr: Pdr
  private wifi: WifiModel | null = null
  private pf: ParticleFilter | null = null
  private listeners = new Set<(u: PositionUpdate) => void>()
  private offs: (() => void)[] = []
  private bridge: PositioningBridge | null = null
  private lastAbsT = -Infinity
  private stepsSinceInit = 0
  private initSource: PositionSource = 'pdr'
  /** fresh scans left in which a WiFi-only start may still move to another level (initial correction) */
  private initialWindow = 0
  /** the floor was decided (first fix, seed, correction or switch): the entrance prior no longer applies */
  private levelChosen = false
  /** sensor clock correction (arrival time − newest sample time) applied to live batches, ms; and recent lags */
  private clockLag: number | null = null
  private lagWindow: number[] = []
  /** batch-mean |B| of the last ~30 s, step |B| − map residuals, and the two plausibility verdicts */
  private magRing: number[] = []
  private magResid: number[] = []
  private magGlobalOk = true
  private magResidOk = true
  private magNote = ''
  private readonly magTmp = new Float64Array(2)
  private readonly baro: BaroDetector
  private readonly voter = new WifiLevelVoter()
  /** WiFi models of the other levels (level voting) */
  private readonly levelModels = new Map<string, WifiModel>()
  private readonly connectors: Connector[]
  private levelListeners = new Set<(c: LevelChange) => void>()
  last: PositionUpdate | null = null
  readonly stats: PositioningStats

  constructor(cfg: PositioningConfig) {
    this.o = { ...DEFAULT_POSITIONING, ...cfg.options }
    this.venueData = cfg.venueData
    this.rng = this.o.seed === null ? Math.random : mulberry32(this.o.seed)
    this.magOpts = { ...DEFAULT_MAG, ...this.o.mag }
    const usable = (m: { synthetic?: boolean } | null | undefined, what: string) => {
      if (!m) return false
      if (m.synthetic && !this.o.allowSyntheticMaps) {
        console.warn(`[positioning] ignoring synthetic ${what} (built from synthetic-* survey data)`)
        return false
      }
      return true
    }
    this.radiomap = usable(cfg.radiomap, 'radiomap') ? cfg.radiomap! : null
    const mags = Array.isArray(cfg.magmap) ? cfg.magmap : cfg.magmap ? [cfg.magmap] : []
    for (const m of mags) if (usable(m, `magmap ${m.level}`) && m.cells?.length) this.magmaps.set(m.level, m)
    const venue = cfg.venueData.venue
    const known = (l: string | undefined) => (l && cfg.venueData.levels.some((d) => d.level.id === l) ? l : undefined)
    this.level = this.o.level ?? known(this.radiomap?.level) ?? known(venue.default_level) ?? cfg.venueData.levels[0]?.level.id ?? '1F'
    this.pdr = new Pdr(this.o.pdr)
    this.baro = new BaroDetector(this.o.baro)
    this.connectors = levelConnectors(cfg.venueData.nav)
    this.stats = {
      initialized: false, level: this.level, steps: 0, wifiScans: 0, wifiUsed: 0, magSteps: 0, relocalizations: 0,
      lostSteps: 0, deviceOffsetDb: 0, magHealthy: true, magNote: null, lastWknn: null, maps: { wifi: false, magnetic: false },
      baroAvailable: null, pressureDeltaHpa: null, wifiLevelVote: null, levelChanges: 0,
    }
    this.setLevel(this.level)
  }

  private setLevel(level: string) {
    this.level = level
    this.stats.level = level
    this.wifi = this.radiomap && this.o.useWifi && this.radiomap.points.some((p) => !p.level || p.level === level)
      ? new WifiModel(this.radiomap, level, this.o.wifi)
      : null
    this.stats.maps = { wifi: !!this.wifi, magnetic: this.o.useMagnetic && this.magmaps.has(level) }
    this.pf = null
    this.stats.initialized = false
  }

  private grid(level: string): OccupancyGrid {
    let g = this.grids.get(level)
    if (!g) {
      const ld = this.venueData.levels.find((l) => l.level.id === level)
      if (!ld) throw new Error(`positioning: unknown level ${level}`)
      g = OccupancyGrid.build({ level, units: ld.units, walls: ld.walls, nav: this.venueData.nav }, this.o.grid)
      // walls of non-initial levels load lazily; rebuild once they are there
      if (ld.wallsLoaded) this.grids.set(level, g)
    }
    return g
  }

  /** both directions of every door edge on the level, as [ax, ay, bx, by] */
  private doorPortals(level: string): number[][] {
    let p = this.portals.get(level)
    if (!p) {
      const nodes = new Map<string, [number, number]>()
      for (const f of this.venueData.nav) {
        if (f.properties.kind === 'node' && f.properties.level === level) nodes.set(f.properties.id, f.geometry.coordinates as [number, number])
      }
      p = []
      for (const f of this.venueData.nav) {
        const e = f.properties
        if (e.kind !== 'edge' || e.type !== 'door') continue
        const a = nodes.get(e.from)
        const b = nodes.get(e.to)
        if (a && b) p.push([a[0], a[1], b[0], b[1]], [b[0], b[1], a[0], a[1]])
      }
      this.portals.set(level, p)
    }
    return p
  }

  private magGrid(level: string): MagGrid | null {
    if (!this.o.useMagnetic) return null
    let g = this.magGrids.get(level)
    const m = this.magmaps.get(level)
    if (!g && m) this.magGrids.set(level, (g = new MagGrid(m, this.magOpts.fillRadiusM)))
    return g ?? null
  }

  private newFilter(): ParticleFilter {
    this.pf = new ParticleFilter(this.grid(this.level), this.o.pf, this.rng)
    return this.pf
  }

  /** compass (rad CCW from magnetic north) -> math angle in the local frame */
  private compassPrior(): HeadingPrior {
    const c = this.stats.magHealthy ? this.pdr.compass : null
    if (c === null) return { mean: null, sigma: 0, uniformFrac: 1 }
    const beta = (this.o.declinationDeg - (this.venueData.venue.bearing_deg ?? 0)) * DEG
    return { mean: Math.PI / 2 - beta + c, sigma: 30 * DEG, uniformFrac: 0.25 }
  }

  start(bridge: PositioningBridge, opts: StartOptions = {}): boolean {
    this.detach()
    this.bridge = bridge
    this.offs.push(bridge.onSensorBatch((b) => this.pushSensorBatch(b, Date.now())))
    const ok = bridge.startSensorStream({
      sensors: ['accelerometer', 'gyroscope', 'magnetometer', 'barometer'],
      interval_ms: opts.sensorIntervalMs ?? 20,
      batch_ms: opts.batchMs ?? 200,
    })
    const wifiMs = opts.wifiIntervalMs === undefined ? 30000 : opts.wifiIntervalMs
    if (this.wifi && wifiMs && bridge.onWifiScan && bridge.startWifiStream) {
      this.offs.push(bridge.onWifiScan((s) => this.pushWifiScan(s)))
      bridge.startWifiStream(wifiMs)
    }
    return ok
  }

  private detach() {
    for (const off of this.offs) off()
    this.offs = []
  }

  async stop(): Promise<void> {
    this.detach()
    const b = this.bridge
    this.bridge = null
    if (b) await Promise.allSettled([b.stopSensorStream(), b.stopWifiStream?.()])
  }

  onUpdate(cb: (u: PositionUpdate) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  onLevelChange(cb: (c: LevelChange) => void): () => void {
    this.levelListeners.add(cb)
    return () => this.levelListeners.delete(cb)
  }

  setKnownPosition(x: number, y: number, level: string = this.level, opts: KnownPositionOptions = {}) {
    if (level !== this.level) this.setLevel(level)
    // the user / navigation is authoritative about the floor: restart the barometer reference and the WiFi vote
    this.baro.reset()
    this.voter.reset()
    const heading: HeadingPrior = opts.headingDeg !== undefined && opts.headingDeg !== null
      ? { mean: (90 - opts.headingDeg) * DEG, sigma: 15 * DEG, uniformFrac: 0.1 }
      : this.compassPrior()
    const pf = this.pf ?? this.newFilter()
    pf.init([{ x, y, w: 1 }], opts.accuracyM ?? 1, heading, this.pdr.yaw)
    this.afterInit('pdr')
    this.emit(opts.t ?? Date.now(), 'pdr')
  }

  private afterInit(source: PositionSource) {
    this.levelChosen = true
    this.initSource = source
    this.initialWindow = source === 'wifi' ? this.o.wifiLevel.initialWindowScans : 0
    this.stepsSinceInit = 0
    this.stats.initialized = true
  }

  pushSensorBatch(batch: SensorBatch, receivedAt?: number) {
    if (receivedAt !== undefined) {
      // Sensor timestamps must be on the wall clock (WiFi scans, seeds, output). The iOS bridge was seen 217 s
      // behind (boot time computed with sleep included): track the newest-sample lag and correct a steady offset.
      let newest = -Infinity
      for (const k of ['accelerometer', 'gyroscope', 'magnetometer'] as const) {
        const a = batch[k]
        if (a?.length) newest = Math.max(newest, a[a.length - 1][0])
      }
      // A real offset is steady: adopt it only when 5 consecutive batches agree within 0.5 s, and change it only if
      // it moves by > 5 s (delivery jitter and back-to-back test batches must not shift samples around)
      if (Number.isFinite(newest)) {
        this.lagWindow.push(receivedAt - newest)
        if (this.lagWindow.length > 5) this.lagWindow.shift()
        const w = [...this.lagWindow].sort((a, b) => a - b)
        if (w.length === 5 && w[4] - w[0] < 500) {
          const lag = w[2]
          if (Math.abs(lag) <= 1000) this.clockLag = null
          else if (this.clockLag === null || Math.abs(lag - this.clockLag) > 5000) this.clockLag = lag
        }
      }
      if (this.clockLag !== null) batch = shiftBatch(batch, this.clockLag)
    }
    // iOS reports magnetometer_accuracy per batch (0 = uncalibrated, 1 = medium, 2 = high): drop uncalibrated samples
    const magAcc = (batch as SensorBatch & { magnetometer_accuracy?: number }).magnetometer_accuracy
    if (typeof magAcc === 'number' && magAcc < 1 && batch.magnetometer) batch = { ...batch, magnetometer: [] }
    this.checkMagnetometer(batch)
    this.checkBarometer(batch)
    for (const step of this.pdr.push(batch)) this.onStep(step)
  }

  private checkBarometer(batch: SensorBatch) {
    if (batch.unavailable?.includes('barometer')) this.stats.baroAvailable = false
    const b = batch.barometer
    if (!b?.length) return
    this.stats.baroAvailable = true
    for (const [t, hpa] of b) {
      const ev = this.baro.push(t, hpa)
      if (ev) this.onBaroEvent(ev)
    }
    this.stats.pressureDeltaHpa = this.baro.p === null ? null : Math.round(this.baro.delta * 1000) / 1000
  }

  private onBaroEvent(ev: BaroEvent) {
    if (!this.o.autoLevel || !this.pf?.initialized) return
    const to = levelForHeightChange(this.venueData.levels.map((l) => l.level), this.level, ev.dhM)
    if (!to) return
    const both = this.voter.vote.candidate === to
    this.switchLevel(to, ev.t, both ? 'both' : 'barometer', both ? 0.95 : 0.8, true)
  }

  /** true while a working barometer reports no floor change (vetoes WiFi-only switches) */
  private baroSaysSameFloor(): boolean {
    return this.stats.baroAvailable === true && this.baro.ref !== null && Math.abs(this.baro.delta) < 0.25
  }

  /**
   * Switch to `to`: re-seed at the partner of the connector nearest the current estimate (elevator / stairs).
   * anywhere = false (WiFi alone) requires that connector within connectorRadiusM.
   */
  private switchLevel(to: string, t: number, source: LevelChange['source'], confidence: number, anywhere: boolean): boolean {
    const pf = this.pf
    if (!pf?.initialized || !this.venueData.levels.some((l) => l.level.id === to)) return false
    const e = pf.estimate(this.pdr.yaw)
    const nc = nearestConnector(this.connectors, this.level, to, e.x, e.y)
    if (!anywhere && (!nc || nc.d > this.o.wifiLevel.connectorRadiusM)) return false
    const from = this.level
    this.setLevel(to)
    const seed = nc ? { x: nc.partner.x, y: nc.partner.y, acc: 3 } : { x: e.x, y: e.y, acc: 8 }
    // heading is not trusted across a floor change: people turn round in elevators / on stair landings and the steel
    // cabin bends the compass; the walls of the landing resolve it within a few steps
    this.newFilter().init([{ x: seed.x, y: seed.y, w: 1 }], seed.acc, { mean: null, sigma: 0, uniformFrac: 1 }, this.pdr.yaw)
    this.afterInit('pdr')
    this.voter.reset()
    this.magResid = []
    if (source === 'wifi') this.baro.reset()
    this.stats.levelChanges++
    const c: LevelChange = { t, from, to, source, confidence, connector: nc ? nc.partner.id : null }
    for (const cb of this.levelListeners) {
      try {
        cb(c)
      } catch (err) {
        console.error('[positioning] level listener error', err)
      }
    }
    this.emit(t, 'pdr')
    return true
  }

  /** WiFi level vote for a fresh scan: best WkNN distance per level (current level from its own observation) */
  private voteLevel(scan: WifiScan, currentDist: number): WifiLevelVote | null {
    const rm = this.radiomap
    if (!rm) return null
    const dist: Record<string, number> = { [this.level]: currentDist }
    for (const level of new Set(rm.points.map((p) => p.level).filter((l): l is string => !!l && l !== this.level))) {
      if (!this.venueData.levels.some((l) => l.level.id === level)) continue
      let m = this.levelModels.get(level)
      if (!m) this.levelModels.set(level, (m = new WifiModel(rm, level, { ...this.o.wifi, adaptOffset: false })))
      const obs = m.observe(scan)
      const r = obs && m.wknn(obs)
      if (r) dist[level] = r.dist
    }
    if (Object.keys(dist).length < 2) return null
    return this.voter.update(this.level, dist, this.o.wifiLevel.marginDb)
  }

  /**
   * Session plausibility of the magnetometer against the map. A phone with an uncompensated hard-iron bias (iPhone
   * runs of 2026-11-07: |B| 117–143 uT vs map 45 uT, 31–182 uT depending on orientation — a vector bias no scalar
   * offset can absorb) would hijack the filter; magnetic matching and the compass prior are then off.
   * Two checks, both must pass:
   * - early, coarse: median of the last 30 s of batch-mean |B| within max(45 uT, 3.5 std) of the map's mean (the
   *   iPhones are ~+100 uT off; real anomalies are local — 2F north corridor dips to 7–10 uT, other stretches reach
   *   ~70 uT — and a tighter global bound switched magnetic off exactly where it is most informative);
   * - per step, fine: median of the last 15 step |B| minus the map |B| at the current estimate within 35 uT (25 tripped
   *   on healthy phones in the steep 2F gradients; biased iPhones are 70–100 uT off).
   */
  private checkMagnetometer(batch: SensorBatch) {
    const m = batch.magnetometer
    if (!m?.length) return
    let sum = 0
    for (const v of m) sum += Math.hypot(v[1], v[2], v[3])
    this.magRing.push(sum / m.length)
    if (this.magRing.length > 150) this.magRing.shift()
    const mg = this.magGrid(this.level)
    if (!mg || this.magRing.length < 25) return
    const sorted = [...this.magRing].sort((a, b) => a - b)
    const med = sorted[sorted.length >> 1]
    this.magGlobalOk = Math.abs(med - mg.stats.meanB) <= Math.max(45, 3.5 * mg.stats.stdB)
    if (!this.magGlobalOk) this.magNote = `magnetometer |B| median ${med.toFixed(0)} uT vs map ${mg.stats.meanB.toFixed(0)} uT`
    this.updateMagHealth()
  }

  /** residual of a step's |B| against the map at the current estimate (fine plausibility check) */
  private checkMagResidual(magB: number, mg: MagGrid) {
    const pf = this.pf
    if (!pf?.initialized) return
    const e = pf.estimate(this.pdr.yaw)
    if (!mg.lookup(e.x, e.y, this.magTmp)) return
    this.magResid.push(magB - this.magTmp[0])
    if (this.magResid.length > 15) this.magResid.shift()
    if (this.magResid.length < 15) return
    const r = [...this.magResid].sort((a, b) => a - b)[7]
    this.magResidOk = Math.abs(r) <= 35
    if (!this.magResidOk) this.magNote = `magnetometer |B| ${r > 0 ? '+' : ''}${r.toFixed(0)} uT off the map (median of 15 steps)`
    this.updateMagHealth()
  }

  private updateMagHealth() {
    const ok = this.magGlobalOk && this.magResidOk
    if (ok !== this.stats.magHealthy) {
      this.stats.magHealthy = ok
      this.stats.magNote = ok ? null : `${this.magNote}: magnetic matching off`
      if (!ok) console.warn(`[positioning] ${this.stats.magNote}`)
    }
  }

  private onStep(step: StepEvent) {
    this.stats.steps++
    const pf = this.pf
    if (!pf?.initialized) return
    pf.predict(step)
    if (this.o.doorHopProb > 0) pf.hop(this.doorPortals(this.level), this.o.doorHopRadiusM, this.o.doorHopProb)
    const levelMag = this.magGrid(this.level)
    if (levelMag && step.magB !== null) this.checkMagResidual(step.magB, levelMag)
    const mg = this.stats.magHealthy ? levelMag : null
    if (mg && step.magB !== null && step.magBv !== null && pf.weightMagnetic(step.magB, step.magBv, mg, this.magOpts) > 0) {
      this.stats.magSteps++
      this.lastAbsT = step.t
    }
    pf.maybeResample()
    this.stats.lostSteps = pf.lostSteps
    this.stepsSinceInit++
    this.emit(step.t, step.t - this.lastAbsT < this.o.fusedHoldMs ? 'fused' : 'pdr')
  }

  pushWifiScan(scan: WifiScan) {
    // WiFi-only start: begin on the entrance level (users arrive from outdoors). An arg-min level pick on the first
    // scan put users standing on the 1F arena onto 2F: the 2F walkway overlooks the hall and hears the same APs
    // (real-data margins ~2 dB). Another level only wins through the initial-correction window below.
    if (!this.levelChosen && !this.pf?.initialized && this.o.level === null) {
      const entrance = this.entranceLevel()
      if (entrance && entrance !== this.level) this.setLevel(entrance)
    }
    const wifi = this.wifi
    if (!wifi) return
    const obs = wifi.observe(scan)
    if (!obs) return
    this.stats.wifiScans++
    const knn = wifi.wknn(obs)
    // level vote first: a scan that matches nothing on this level (knn null) is the clearest sign of another floor
    const vote = this.voteLevel(scan, knn?.dist ?? Infinity)
    if (vote) this.stats.wifiLevelVote = vote
    const wl = this.o.wifiLevel
    // initial correction: right after a WiFi-only start, another level that beats the entrance level by
    // strongMarginDb on `scans` consecutive fresh scans (the first one included) re-initialises the filter there —
    // anywhere (the user may have started anywhere) and regardless of the barometer (it only sees changes)
    if (this.pf?.initialized && this.initialWindow > 0) this.initialWindow--
    if (vote?.candidate && this.o.autoLevel && (!this.pf?.initialized || (this.initSource === 'wifi' && this.initialWindow > 0)) &&
        vote.streak >= wl.scans && vote.dist[this.level] - vote.dist[vote.candidate] >= wl.strongMarginDb) {
      const from = this.level
      this.setLevel(vote.candidate)
      this.levelChosen = true
      this.voter.reset()
      this.initialWindow = 0
      this.stats.levelChanges++
      const c: LevelChange = { t: scan.collected_at, from, to: vote.candidate, source: 'wifi', confidence: 0.6, connector: null }
      for (const cb of this.levelListeners) {
        try {
          cb(c)
        } catch (err) {
          console.error('[positioning] level listener error', err)
        }
      }
      this.pushWifiScan(scan) // initialise on the new level from this scan
      return
    }
    // WiFi alone: also only where this level is surveyed — off its fingerprints the own-level distance is bad anyway
    // and says nothing about another floor (LOWO with the route removed: 3 false switches without this)
    const est = this.pf?.initialized ? this.pf.estimate(this.pdr.yaw) : null
    if (vote?.candidate && this.o.autoLevel && vote.streak >= wl.scans && !this.baroSaysSameFloor() &&
        vote.dist[this.level] - vote.dist[vote.candidate] >= wl.strongMarginDb && est && wifi.covered(est.x, est.y) &&
        this.switchLevel(vote.candidate, obs.t, 'wifi', 0.6, false)) return
    if (!knn) return
    this.stats.lastWknn = knn
    this.stats.wifiUsed++
    const lik = wifi.fingerprintLikelihood(obs)
    const pf = this.pf
    if (!pf?.initialized) {
      const seeds = Array.from(lik.keys())
        .sort((a, b) => lik[b] - lik[a])
        .slice(0, this.o.wifiInitSeeds)
        .map((j) => ({ x: wifi.fpX[j], y: wifi.fpY[j], w: lik[j] }))
      ;(pf ?? this.newFilter()).init(seeds, this.o.wifiInitSigmaM, this.compassPrior(), this.pdr.yaw)
      this.afterInit('wifi')
      this.lastAbsT = obs.t
      this.emit(obs.t, 'wifi')
      return
    }
    // coverage gate: where the cloud is mostly outside the surveyed area, the fingerprints of the nearest surveyed
    // corridor would only drag it away, so the scan is not used
    if (pf.weightShare((x, y) => wifi.covered(x, y)) < this.o.wifiMinCoverage) {
      this.emit(obs.t, this.stepsSinceInit === 0 ? this.initSource : 'pdr')
      return
    }
    const fit = pf.weightAt(obs.tObs, (x, y) => wifi.likelihoodAt(lik, x, y))
    pf.normalize()
    const e = pf.estimate(this.pdr.yaw)
    // Relocalise only a WiFi-initialised filter (it is itself only as good as WiFi) when it disagrees with WiFi and
    // explains the scan poorly. After a user-given start never: walk-survey WiFi fixes are 10–20 m off in the open
    // arena, and injecting particles there broke correct tracks (live run 193729-pixel9a: 29 m at the NW door;
    // LOWO: p90 3.3 -> 11 m with relocalisation after a known start)
    if (this.initSource === 'wifi' && fit < 0.15 && Math.hypot(e.x - knn.x, e.y - knn.y) > this.o.relocalizeM) {
      pf.inject(knn.x, knn.y, Math.max(knn.spread, 3), 0.25, this.compassPrior(), this.pdr.yaw)
      this.stats.relocalizations++
    }
    pf.maybeResample()
    const after = pf.estimate(this.pdr.yaw)
    if (after.spread < 2.5 && this.stepsSinceInit > 10) wifi.adaptOffsetAt(obs, after.x, after.y)
    this.stats.deviceOffsetDb = wifi.deviceOffsetDb
    this.lastAbsT = obs.t
    this.emit(obs.t, this.stepsSinceInit === 0 && this.initSource === 'wifi' ? 'wifi' : 'fused')
  }

  /**
   * Level users arrive on: venue.default_level, else the level of an entrance node (nav id containing "ent"), else the
   * lowest ordinal. The prior for a WiFi-only start.
   */
  private entranceLevel(): string | null {
    const levels = this.venueData.levels.map((l) => l.level)
    const known = (id: string | undefined) => (id && levels.some((l) => l.id === id) ? id : null)
    const ent = this.venueData.nav.find((f) => f.properties.kind === 'node' && /(^|-)ent(-|$)/.test(f.properties.id))
    return known(this.venueData.venue.default_level) ?? known(ent?.properties.kind === 'node' ? ent.properties.level : undefined)
      ?? [...levels].sort((x, y) => x.ordinal - y.ordinal)[0]?.id ?? null
  }

  private emit(t: number, source: PositionSource) {
    const pf = this.pf
    if (!pf?.initialized) return
    const e = pf.estimate(this.pdr.yaw)
    if (!Number.isFinite(e.x)) return
    const a = this.o.accuracy
    const accuracy = Math.max(a.floorM, a.scale * Math.hypot(e.spread, a.baseM))
    const u: PositionUpdate = {
      t,
      level: this.level,
      x: e.x,
      y: e.y,
      accuracy_m: Math.round(accuracy * 10) / 10,
      heading_deg: e.headingConc > 0.5 && this.stepsSinceInit > 0 ? (((90 - e.heading / DEG) % 360) + 360) % 360 : null,
      source,
      confidence: Math.round(Math.exp(-accuracy / 6) * Math.min(1, 0.4 + 0.6 * e.headingConc) * 100) / 100,
    }
    this.last = u
    for (const cb of this.listeners) {
      try {
        cb(u)
      } catch (err) {
        console.error('[positioning] listener error', err)
      }
    }
  }
}

function shiftBatch(b: SensorBatch, dt: number): SensorBatch {
  const out: SensorBatch = { ...b }
  for (const k of ['accelerometer', 'gyroscope', 'magnetometer'] as const) {
    const a = b[k]
    if (a) out[k] = a.map((v) => [v[0] + dt, v[1], v[2], v[3]])
  }
  if (b.barometer) out.barometer = b.barometer.map((v) => [v[0] + dt, v[1]])
  return out
}

export function createPositioning(cfg: PositioningConfig): Positioning {
  return new PositioningEngine(cfg)
}

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url)
    if (!res.ok) return null
    return JSON.parse(await res.text()) as T
  } catch {
    return null
  }
}

/** Fetch positioning/wifi_radiomap.json and positioning/magmap_<level>.json (null / skipped when missing). */
export async function loadPositioningMaps(venueId: string, levelIds: string[]): Promise<{ radiomap: Radiomap | null; magmaps: Magmap[] }> {
  const base = `${venueBaseUrl(venueId)}positioning/`
  const [radiomap, ...mags] = await Promise.all([
    fetchJson<Radiomap>(base + 'wifi_radiomap.json'),
    ...levelIds.map((l) => fetchJson<Magmap>(`${base}magmap_${encodeURIComponent(l)}.json`)),
  ])
  return {
    radiomap: radiomap && Array.isArray(radiomap.points) && Array.isArray(radiomap.bssids) ? radiomap : null,
    magmaps: mags.filter((m): m is Magmap => !!m && Array.isArray(m.cells)),
  }
}
