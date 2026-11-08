/**
 * Survey heatmaps (magnetic field, WiFi RSSI / AP count): scattered samples -> smooth field on a fine grid, masked to
 * walkable units, faded out away from data, coloured into an RGBA image for one MapLibre image overlay.
 * Pure functions except renderHeatmapUrl (canvas).
 */
import type { XY } from '../../geo/frame'
import { pointInPolygon } from '../../geo/geometry'
import type { UnitFeature } from '../../data/types'
import { PointIndex } from './coverage'

export interface Sample { x: number; y: number; v: number }

/** Regular grid; row 0 is the TOP row (max y), like an image. Cell centres at x0 + (c + .5) * cell. */
export interface Grid { x0: number; y0: number; cols: number; rows: number; cell: number }

export const cellCenter = (g: Grid, c: number, r: number): XY => [g.x0 + (c + 0.5) * g.cell, g.y0 + (g.rows - r - 0.5) * g.cell]

export function makeGrid(bbox: [number, number, number, number], cell: number, pad = 0): Grid {
  const x0 = bbox[0] - pad
  const y0 = bbox[1] - pad
  return { x0, y0, cell, cols: Math.max(1, Math.ceil((bbox[2] + pad - x0) / cell)), rows: Math.max(1, Math.ceil((bbox[3] + pad - y0) / cell)) }
}

/** Corner coordinates of the grid image, MapLibre image-source order TL, TR, BR, BL (local metres). */
export function gridCorners(g: Grid): [XY, XY, XY, XY] {
  const x1 = g.x0 + g.cols * g.cell
  const y1 = g.y0 + g.rows * g.cell
  return [[g.x0, y1], [x1, y1], [x1, g.y0], [g.x0, g.y0]]
}

/** Unit categories the field may cover (walls/rooms/stairs stay blank). */
export const WALKABLE = new Set(['corridor', 'walkway', 'lobby', 'court', 'elevator', 'restroom.male', 'restroom.female', 'restroom.unisex', 'restroom.accessible'])
/** "corridor area" for coverage % (where people actually walk to destinations) */
export const CORRIDOR = new Set(['corridor', 'walkway', 'lobby'])

export function unitsBBox(units: UnitFeature[]): [number, number, number, number] {
  const b: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity]
  for (const u of units) {
    const polys = u.geometry?.type === 'Polygon' ? [u.geometry.coordinates] : u.geometry?.type === 'MultiPolygon' ? u.geometry.coordinates : []
    for (const rings of polys) for (const [x, y] of rings[0] ?? []) (b[0] = Math.min(b[0], x)), (b[1] = Math.min(b[1], y)), (b[2] = Math.max(b[2], x)), (b[3] = Math.max(b[3], y))
  }
  return b
}

/** 1 where the cell centre lies inside a unit whose category is in `cats`. */
export function unitMask(g: Grid, units: UnitFeature[], cats: Set<string>): Uint8Array {
  const m = new Uint8Array(g.cols * g.rows)
  for (const u of units) {
    if (!cats.has(u.properties.category) || !u.geometry) continue
    const polys = u.geometry.type === 'Polygon' ? [u.geometry.coordinates] : u.geometry.coordinates
    for (const rings of polys) {
      let [bx0, by0, bx1, by1] = [Infinity, Infinity, -Infinity, -Infinity]
      for (const [x, y] of rings[0]) (bx0 = Math.min(bx0, x)), (by0 = Math.min(by0, y)), (bx1 = Math.max(bx1, x)), (by1 = Math.max(by1, y))
      const c0 = Math.max(0, Math.floor((bx0 - g.x0) / g.cell))
      const c1 = Math.min(g.cols - 1, Math.ceil((bx1 - g.x0) / g.cell))
      const r0 = Math.max(0, g.rows - 1 - Math.ceil((by1 - g.y0) / g.cell))
      const r1 = Math.min(g.rows - 1, g.rows - 1 - Math.floor((by0 - g.y0) / g.cell))
      for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) {
          const i = r * g.cols + c
          if (!m[i] && pointInPolygon(cellCenter(g, c, r), rings)) m[i] = 1
        }
      }
    }
  }
  return m
}

export interface FieldOptions {
  /** samples farther than this do not contribute (m) */
  radius: number
  /** Gaussian kernel σ (m) */
  sigma: number
  /** full opacity up to this distance from the nearest sample, fading to 0 at `radius` (m) */
  solid: number
}

/**
 * Gaussian-weighted average of the samples within `radius` of each masked cell. Returns values (NaN = no data) and
 * an alpha (0..1) that fades with the distance to the nearest sample.
 */
export function interpolateField(g: Grid, samples: Sample[], mask: Uint8Array | null, o: FieldOptions): { values: Float32Array; alpha: Float32Array } {
  const n = g.cols * g.rows
  const values = new Float32Array(n).fill(NaN)
  const alpha = new Float32Array(n)
  // bucket samples by cell of size radius
  const size = o.radius
  const buckets = new Map<string, Sample[]>()
  for (const s of samples) {
    const k = `${Math.floor(s.x / size)},${Math.floor(s.y / size)}`
    let b = buckets.get(k)
    if (!b) buckets.set(k, (b = []))
    b.push(s)
  }
  const r2 = o.radius * o.radius
  const inv2s2 = 1 / (2 * o.sigma * o.sigma)
  for (let r = 0; r < g.rows; r++) {
    for (let c = 0; c < g.cols; c++) {
      const i = r * g.cols + c
      if (mask && !mask[i]) continue
      const [x, y] = cellCenter(g, c, r)
      const bx = Math.floor(x / size)
      const by = Math.floor(y / size)
      let sw = 0
      let sv = 0
      let dmin2 = Infinity
      for (let ix = bx - 1; ix <= bx + 1; ix++) {
        for (let iy = by - 1; iy <= by + 1; iy++) {
          for (const s of buckets.get(`${ix},${iy}`) ?? []) {
            const d2 = (s.x - x) ** 2 + (s.y - y) ** 2
            if (d2 > r2) continue
            const w = Math.exp(-d2 * inv2s2)
            sw += w
            sv += w * s.v
            if (d2 < dmin2) dmin2 = d2
          }
        }
      }
      if (sw <= 1e-12) continue
      values[i] = sv / sw
      const d = Math.sqrt(dmin2)
      alpha[i] = d <= o.solid ? 1 : Math.max(0, 1 - (d - o.solid) / (o.radius - o.solid))
    }
  }
  return { values, alpha }
}

export function quantile(vals: ArrayLike<number>, q: number): number | null {
  const a: number[] = []
  for (let i = 0; i < vals.length; i++) if (Number.isFinite(vals[i])) a.push(vals[i])
  if (!a.length) return null
  a.sort((x, y) => x - y)
  return a[Math.min(a.length - 1, Math.max(0, Math.round(q * (a.length - 1))))]
}

/** blue -> cyan -> green -> yellow -> red (WiFi-survey style) */
export const RAMP: [number, [number, number, number]][] = [
  [0, [43, 87, 220]], [0.25, [32, 190, 230]], [0.5, [60, 200, 90]], [0.75, [250, 220, 50]], [1, [225, 50, 40]],
]
export const RAMP_CSS = `linear-gradient(90deg, ${RAMP.map(([t, [r, g, b]]) => `rgb(${r},${g},${b}) ${t * 100}%`).join(', ')})`

export function rampColor(t: number): [number, number, number] {
  const u = Math.min(1, Math.max(0, Number.isFinite(t) ? t : 0))
  for (let i = 1; i < RAMP.length; i++) {
    if (u <= RAMP[i][0]) {
      const [t0, a] = RAMP[i - 1]
      const [t1, b] = RAMP[i]
      const f = (u - t0) / (t1 - t0)
      return [Math.round(a[0] + (b[0] - a[0]) * f), Math.round(a[1] + (b[1] - a[1]) * f), Math.round(a[2] + (b[2] - a[2]) * f)]
    }
  }
  return RAMP[RAMP.length - 1][1]
}

/** RGBA pixels (row 0 = top) for the field; alpha scaled by `maxAlpha` (0..255). */
export function fieldPixels(g: Grid, f: { values: Float32Array; alpha: Float32Array }, vmin: number, vmax: number, maxAlpha = 255): Uint8ClampedArray {
  const px = new Uint8ClampedArray(g.cols * g.rows * 4)
  const span = vmax - vmin || 1
  for (let i = 0; i < f.values.length; i++) {
    const v = f.values[i]
    if (!Number.isFinite(v) || f.alpha[i] <= 0) continue
    const [r, gg, b] = rampColor((v - vmin) / span)
    px[i * 4] = r
    px[i * 4 + 1] = gg
    px[i * 4 + 2] = b
    px[i * 4 + 3] = Math.round(maxAlpha * f.alpha[i])
  }
  return px
}

/** PNG data URL of the pixels (canvas; browser only). */
export function renderHeatmapUrl(g: Grid, px: Uint8ClampedArray): string {
  const cv = document.createElement('canvas')
  cv.width = g.cols
  cv.height = g.rows
  const ctx = cv.getContext('2d')!
  const img = ctx.createImageData(g.cols, g.rows)
  img.data.set(px)
  ctx.putImageData(img, 0, 0)
  return cv.toDataURL('image/png')
}

/**
 * Share of masked cells (e.g. corridor area) within `radius` of any walked line or data point.
 * Lines are rasterised segment by segment; points use a spatial index.
 */
export function coverageFraction(g: Grid, mask: Uint8Array, lines: XY[][], points: XY[], radius: number): { covered: number; total: number; fraction: number } {
  const hit = new Uint8Array(mask.length)
  const r2 = radius * radius
  for (const line of lines) {
    for (let k = 1; k < line.length; k++) {
      const a = line[k - 1]
      const b = line[k]
      const c0 = Math.max(0, Math.floor((Math.min(a[0], b[0]) - radius - g.x0) / g.cell))
      const c1 = Math.min(g.cols - 1, Math.ceil((Math.max(a[0], b[0]) + radius - g.x0) / g.cell))
      const r0 = Math.max(0, g.rows - 1 - Math.ceil((Math.max(a[1], b[1]) + radius - g.y0) / g.cell))
      const r1 = Math.min(g.rows - 1, g.rows - 1 - Math.floor((Math.min(a[1], b[1]) - radius - g.y0) / g.cell))
      const dx = b[0] - a[0]
      const dy = b[1] - a[1]
      const L2 = dx * dx + dy * dy
      for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) {
          const i = r * g.cols + c
          if (!mask[i] || hit[i]) continue
          const [x, y] = cellCenter(g, c, r)
          const t = L2 ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / L2)) : 0
          if ((x - a[0] - t * dx) ** 2 + (y - a[1] - t * dy) ** 2 <= r2) hit[i] = 1
        }
      }
    }
  }
  if (points.length) {
    const idx = new PointIndex(points, Math.max(radius, 0.5))
    for (let r = 0; r < g.rows; r++) for (let c = 0; c < g.cols; c++) {
      const i = r * g.cols + c
      if (mask[i] && !hit[i] && idx.anyWithin(cellCenter(g, c, r), radius)) hit[i] = 1
    }
  }
  let total = 0
  let covered = 0
  for (let i = 0; i < mask.length; i++) if (mask[i]) (total++, hit[i] && covered++)
  return { covered, total, fraction: total ? covered / total : 0 }
}

export const coverageLabel = (f: number): { text: string; level: 'good' | 'fair' | 'poor' } =>
  f >= 0.7 ? { text: '良好', level: 'good' } : f >= 0.4 ? { text: '普通', level: 'fair' } : { text: '不足', level: 'poor' }

// ---------- WiFi ----------

export interface ApStat { bssid: string; ssid: string; count: number; maxRssi: number; campus: boolean }
const CAMPUS_SSID = /^(uTaipei|eduroam|TANetRoaming)/i

/** APs of a radiomap level sorted by detection count (fingerprints that heard them), then max RSSI. */
export function apStats(points: { aps: Record<string, { mean: number }> }[], apInfo: Record<string, { ssids?: string[] }> = {}): ApStat[] {
  const m = new Map<string, ApStat>()
  for (const p of points) {
    for (const [b, a] of Object.entries(p.aps)) {
      let s = m.get(b)
      if (!s) {
        const ssid = apInfo[b]?.ssids?.[0] ?? ''
        m.set(b, (s = { bssid: b, ssid, count: 0, maxRssi: -Infinity, campus: CAMPUS_SSID.test(ssid) }))
      }
      s.count++
      s.maxRssi = Math.max(s.maxRssi, a.mean)
    }
  }
  return [...m.values()].sort((a, b) => b.count - a.count || b.maxRssi - a.maxRssi)
}

/** Default AP: among the well-detected campus APs (≥ half the best count), the strongest. */
export function defaultAp(stats: ApStat[]): string | null {
  const pool = stats.filter((s) => s.campus).length ? stats.filter((s) => s.campus) : stats
  if (!pool.length) return null
  const best = pool[0].count
  return pool.filter((s) => s.count >= best / 2).sort((a, b) => b.maxRssi - a.maxRssi)[0].bssid
}

/** RSSI-weighted centroid of the AP's strongest fingerprints (weights (rssi + 100)²). */
export function apCentroid(points: { x: number; y: number; aps: Record<string, { mean: number }> }[], bssid: string, top = 5): XY | null {
  const hits = points.filter((p) => p.aps[bssid]).sort((a, b) => b.aps[bssid].mean - a.aps[bssid].mean).slice(0, top)
  let sw = 0
  let sx = 0
  let sy = 0
  for (const p of hits) {
    const w = Math.max(1, p.aps[bssid].mean + 100) ** 2
    sw += w
    sx += w * p.x
    sy += w * p.y
  }
  return sw ? [sx / sw, sy / sw] : null
}
