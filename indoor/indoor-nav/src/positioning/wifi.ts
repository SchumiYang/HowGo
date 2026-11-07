/**
 * WiFi fingerprinting on the radiomap (mapdata/SURVEY_SCHEMA.md §3).
 *
 * - observe(): filters a scan (cached/throttled repeats, stale results, locally-administered BSSIDs, unknown APs)
 *   into an observation vector over the radiomap's APs.
 * - wknn(): weighted k-nearest neighbours in signal space. Distance = RMS dB difference over the APs present in
 *   the observation or the fingerprint (missing side filled with missingDbm); APs absent from both are ignored.
 * - fingerprintLikelihood() + likelihoodAt(): particle-filter likelihood, a tempered Gaussian in that distance per
 *   fingerprint, kernel-interpolated in space at the particle positions.
 * A slowly adapting device RSSI offset absorbs gain differences between the survey phone and the user's phone.
 */
import type { WifiScan } from '../bridge/townpass'
import type { Radiomap } from './types'

export interface WifiOptions {
  k: number
  missingDbm: number
  /** per-AP RSSI noise for the likelihood (dB) */
  sigmaDb: number
  /** likelihood tempering (APs are correlated, dual-band radios duplicate each other); the radiomap's
   *  params.likelihood_temper (set by the builder from the survey type) takes precedence over this default */
  temper: number
  /** spatial kernel for interpolating fingerprint likelihoods (m) */
  kernelM: number
  /** drop results last seen this long before the newest result of the scan */
  staleMs: number
  /** observation time = collected_at − scanLagMs (mid-sweep of a ~5 s scan) */
  scanLagMs: number
  /** fingerprint APs detected less often than this count as absent */
  minDetect: number
  /** minimum APs heard (known to the radiomap) to use a scan */
  minAps: number
  /** likelihood floor (robustness to outliers) */
  floor: number
  /** APs below this on both sides (or missing) are ignored in the distance */
  strongDbm: number
  /** per-AP difference cap (dB): one AP heard at −55 here and missing there must not dominate */
  capDb: number
  /** remove the mean RSSI difference per fingerprint before comparing (cross-device robustness) */
  offsetInvariant: boolean
  /** adapt a device RSSI offset (adaptOffsetAt); clamp (dB) */
  adaptOffset: boolean
  maxOffsetDb: number
}

export const DEFAULT_WIFI: WifiOptions = {
  k: 4,
  missingDbm: -100,
  sigmaDb: 6,
  temper: 0.05,
  kernelM: 2.5,
  staleMs: 10000,
  scanLagMs: 2500,
  minDetect: 0.25,
  minAps: 3,
  floor: 0.02,
  strongDbm: -85,
  capDb: 15,
  offsetInvariant: true,
  adaptOffset: true,
  maxOffsetDb: 10,
}

export interface WifiObservation {
  /** collected_at (epoch ms) */
  t: number
  /** estimated time the scan represents (epoch ms) */
  tObs: number
  /** RSSI per radiomap AP index (NaN = not heard), device offset applied */
  rssi: Float64Array
  nSeen: number
  nUnknown: number
}

export interface WknnResult {
  x: number
  y: number
  /** weighted spread of the k neighbours (m) */
  spread: number
  /** RMS dB distance of the best match */
  dist: number
  neighbours: number[]
}

export const isLocallyAdministered = (bssid: string) => (parseInt(bssid.slice(0, 2), 16) & 2) !== 0

/**
 * Radio key (radiomap params.ap_grouping 'radio/v1'; must match mapdata/tools/build_radiomap.py ap_key): one radio
 * broadcasts several SSIDs on BSSIDs differing only in the low nibble of the last octet, or (locally administered)
 * only in the first octet's admin bits. Key = first 5 octets + high nibble of the last (octets 2–6 if locally
 * administered) + band.
 */
export function apKey(bssid: string, frequency: number | null | undefined): string {
  const b = bssid.toLowerCase()
  const f = frequency ?? 0
  const band = f < 3000 ? '2.4' : f < 5925 ? '5' : '6'
  const o = b.split(':')
  return (isLocallyAdministered(b) ? o.slice(1).join(':') : o.slice(0, 5).join(':') + ':' + o[5][0]) + '|' + band
}

export class WifiModel {
  readonly opts: WifiOptions
  readonly nAp: number
  readonly nFp: number
  readonly fpX: Float64Array
  readonly fpY: Float64Array
  /** fingerprint mean RSSI [fp * nAp + ap], NaN = absent */
  private readonly fpVal: Float64Array
  private readonly apIndex = new Map<string, number>()
  private readonly dist: Float64Array
  private readonly nUnion: Int32Array
  private lastKey = ''
  /** radiomap APs are radio keys (apKey) rather than BSSIDs */
  private readonly grouped: boolean
  deviceOffsetDb = 0

  constructor(map: Radiomap, level: string | null, opts: Partial<WifiOptions> = {}) {
    this.opts = { ...DEFAULT_WIFI, ...opts }
    if (map.params?.missing_dbm !== undefined && opts.missingDbm === undefined) this.opts.missingDbm = map.params.missing_dbm
    const temper = (level ? map.params?.levels?.[level]?.likelihood_temper : undefined) ?? map.params?.likelihood_temper
    if (temper !== undefined && opts.temper === undefined) this.opts.temper = temper
    this.grouped = map.params?.ap_grouping === 'radio/v1'
    map.bssids.forEach((b, i) => this.apIndex.set(b.toLowerCase(), i))
    const pts = map.points.filter((p) => !level || !p.level || p.level === level)
    this.nAp = map.bssids.length
    this.nFp = pts.length
    this.fpX = new Float64Array(pts.map((p) => p.x))
    this.fpY = new Float64Array(pts.map((p) => p.y))
    this.fpVal = new Float64Array(this.nFp * this.nAp).fill(NaN)
    pts.forEach((p, j) => {
      for (const [b, a] of Object.entries(p.aps)) {
        const i = this.apIndex.get(b.toLowerCase())
        if (i !== undefined && a.detect >= this.opts.minDetect) this.fpVal[j * this.nAp + i] = a.mean
      }
    })
    this.dist = new Float64Array(this.nFp)
    this.nUnion = new Int32Array(this.nFp)
  }

  /** null for unusable scans: unsupported, empty, a cached repeat of the previous scan, or too few known APs. */
  observe(scan: WifiScan): WifiObservation | null {
    if (scan.supported === false || !scan.results?.length) return null
    const key = scan.results.map((r) => `${r.bssid}@${r.timestamp}`).sort().join('|')
    if (key === this.lastKey) return null
    this.lastKey = key
    let newest = -Infinity
    for (const r of scan.results) if (r.timestamp) newest = Math.max(newest, r.timestamp)
    // only APs in the radiomap count, so the builder's filtering (allowlist / phone hotspots) applies to scans too;
    // with radio grouping, the virtual BSSIDs of one radio are averaged
    const sum = new Float64Array(this.nAp)
    const cnt = new Int32Array(this.nAp)
    let nUnknown = 0
    for (const r of scan.results) {
      const b = r.bssid.toLowerCase()
      if (r.timestamp && newest - r.timestamp > this.opts.staleMs * 1000) continue
      const i = this.apIndex.get(this.grouped ? apKey(b, r.frequency) : b)
      if (i === undefined) {
        nUnknown++
        continue
      }
      sum[i] += r.level
      cnt[i]++
    }
    const rssi = new Float64Array(this.nAp).fill(NaN)
    let nSeen = 0
    for (let i = 0; i < this.nAp; i++) {
      if (!cnt[i]) continue
      rssi[i] = sum[i] / cnt[i] + this.deviceOffsetDb
      nSeen++
    }
    if (nSeen < this.opts.minAps) return null
    return { t: scan.collected_at, tObs: scan.collected_at - this.opts.scanLagMs, rssi, nSeen, nUnknown }
  }

  /**
   * RMS dB distance to every fingerprint (Infinity when fewer than 2 APs in common). With offsetInvariant, the mean
   * difference over the APs both sides heard (clamped) is removed first: phones disagree on absolute RSSI by several
   * dB, and fingerprints may come from a different phone than the user's.
   */
  distances(obs: WifiObservation): Float64Array {
    const { nAp, fpVal, dist, nUnion } = this
    const miss = this.opts.missingDbm
    const maxOff = this.opts.offsetInvariant ? this.opts.maxOffsetDb : 0
    const strong = this.opts.strongDbm
    const cap = this.opts.capDb
    for (let j = 0; j < this.nFp; j++) {
      const base = j * nAp
      let common = 0
      let md = 0
      for (let a = 0; a < nAp; a++) {
        const o = obs.rssi[a]
        const f = fpVal[base + a]
        if (!Number.isNaN(o) && !Number.isNaN(f)) {
          md += o - f
          common++
        }
      }
      md = common ? Math.max(-maxOff, Math.min(maxOff, md / common)) : 0
      let sum = 0
      let n = 0
      for (let a = 0; a < nAp; a++) {
        const o = obs.rssi[a]
        const f = fpVal[base + a]
        const oMiss = Number.isNaN(o)
        const fMiss = Number.isNaN(f)
        if (oMiss && fMiss) continue
        const ov = oMiss ? miss : o - md
        const fv = fMiss ? miss : f
        // weak on both sides: presence/absence of such APs is mostly scan-to-scan noise
        if (ov < strong && fv < strong) continue
        const d = Math.max(-cap, Math.min(cap, ov - fv))
        sum += d * d
        n++
      }
      nUnion[j] = n
      dist[j] = common >= 2 ? Math.sqrt(sum / n) : Infinity
    }
    return dist
  }

  wknn(obs: WifiObservation): WknnResult | null {
    const d = this.distances(obs)
    const order = Array.from(d.keys()).filter((j) => Number.isFinite(d[j])).sort((a, b) => d[a] - d[b])
    const nb = order.slice(0, this.opts.k)
    if (!nb.length) return null
    let sw = 0, x = 0, y = 0
    for (const j of nb) {
      const w = 1 / Math.max(d[j], 0.5)
      sw += w
      x += w * this.fpX[j]
      y += w * this.fpY[j]
    }
    x /= sw
    y /= sw
    let v = 0
    for (const j of nb) v += (1 / Math.max(d[j], 0.5)) * ((this.fpX[j] - x) ** 2 + (this.fpY[j] - y) ** 2)
    return { x, y, spread: Math.sqrt(v / sw), dist: d[nb[0]], neighbours: nb }
  }

  /**
   * Adapt the device RSSI offset from a scan taken at a trusted position (the filter's estimate while it is
   * confident): mean (fingerprint − observed) over APs heard at both, for fingerprints within radiusM. Against the
   * WkNN best match it would be biased, since a weaker phone simply matches fingerprints farther from the APs.
   */
  adaptOffsetAt(obs: WifiObservation, x: number, y: number, radiusM = 3) {
    if (!this.opts.adaptOffset) return
    let s = 0
    let n = 0
    for (let j = 0; j < this.nFp; j++) {
      if (Math.hypot(this.fpX[j] - x, this.fpY[j] - y) > radiusM) continue
      for (let a = 0; a < this.nAp; a++) {
        const o = obs.rssi[a]
        const f = this.fpVal[j * this.nAp + a]
        if (!Number.isNaN(o) && !Number.isNaN(f)) {
          s += f - o
          n++
        }
      }
    }
    if (n < 8) return
    const m = this.opts.maxOffsetDb
    this.deviceOffsetDb = Math.max(-m, Math.min(m, this.deviceOffsetDb + 0.3 * (s / n)))
  }

  /** Relative likelihood (max 1) of the observation at every fingerprint location. */
  fingerprintLikelihood(obs: WifiObservation): Float64Array {
    const d = this.distances(obs)
    const ll = new Float64Array(this.nFp)
    let max = -Infinity
    const k = this.opts.temper / (2 * this.opts.sigmaDb ** 2)
    for (let j = 0; j < this.nFp; j++) {
      ll[j] = Number.isFinite(d[j]) ? -k * this.nUnion[j] * d[j] * d[j] : -Infinity
      if (ll[j] > max) max = ll[j]
    }
    for (let j = 0; j < this.nFp; j++) ll[j] = Number.isFinite(max) ? Math.exp(ll[j] - max) : 0
    return ll
  }

  /** true if a fingerprint lies within radiusM of (x, y) */
  covered(x: number, y: number, radiusM = 5): boolean {
    const r2 = radiusM * radiusM
    for (let j = 0; j < this.nFp; j++) {
      const dx = this.fpX[j] - x
      const dy = this.fpY[j] - y
      if (dx * dx + dy * dy <= r2) return true
    }
    return false
  }

  /**
   * Likelihood at an arbitrary position: kernel-weighted fingerprint likelihoods, shrunk toward the mean over all
   * fingerprints where few are nearby. Unsurveyed space (e.g. the middle of the open arena) is then "unknown", not
   * "unlikely" — otherwise every scan would pull particles toward the nearest surveyed corridor.
   */
  likelihoodAt(fpLik: Float64Array, x: number, y: number): number {
    const h2 = 2 * this.opts.kernelM ** 2
    const cut = 9 * this.opts.kernelM ** 2
    let sw = 0
    let s = 0
    let all = 0
    for (let j = 0; j < this.nFp; j++) {
      all += fpLik[j]
      const dx = this.fpX[j] - x
      const dy = this.fpY[j] - y
      const r2 = dx * dx + dy * dy
      if (r2 > cut) continue
      const w = Math.exp(-r2 / h2)
      sw += w
      s += w * fpLik[j]
    }
    const neutral = this.nFp ? all / this.nFp : 0
    const prior = 0.3 // ≈ weight of one fingerprint 3.9 m away
    const v = (s + prior * neutral) / (sw + prior)
    return this.opts.floor + (1 - this.opts.floor) * v
  }
}
