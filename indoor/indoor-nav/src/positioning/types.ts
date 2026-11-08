/** Positioning data contract (mapdata/SURVEY_SCHEMA.md §3–4). Coordinates are local metres. */

export interface RadiomapAp {
  /** mean RSSI over the scans that saw the AP (dBm) */
  mean: number
  std: number
  /** fraction of scans at this location in which the AP was seen */
  detect: number
}

export interface RadiomapPoint {
  id: string
  level: string
  x: number
  y: number
  n_scans: number
  /** 'point' = static survey point, 'walk' = scan taken while walking */
  src?: string
  aps: Record<string, RadiomapAp>
}

export interface Radiomap {
  schema?: string
  /** legacy single-level maps; current maps hold every level (points carry their level) */
  level?: string
  levels?: string[]
  built_at?: number
  sessions?: string[]
  /** built from synthetic-* sessions: ignored by the engine unless allowSyntheticMaps */
  synthetic?: boolean
  /** likelihood_temper: builder's recommended WiFi weight (0.25 point survey, 0.05 walk-only survey) */
  /** ap_grouping 'radio/v1': bssids are radio keys (wifi.ts apKey); allowlist: rules the map was built with */
  params?: {
    missing_dbm?: number
    likelihood_temper?: number
    /** per level: the builder's WiFi weight for that level's fingerprints (point vs walk survey) */
    levels?: Record<string, { likelihood_temper?: number; points?: number; walk_bins?: number }>
    ap_grouping?: string
    allowlist?: { file: string; rules: string[] } | null
  }
  bssids: string[]
  points: RadiomapPoint[]
}

export interface MagmapCell {
  x: number
  y: number
  /** |B| µT */
  B: number
  /** B · u_up µT (u_up from the low-passed accelerometer; negative in the northern hemisphere) */
  Bv: number
  Bh: number
  n: number
}

export interface Magmap {
  schema?: string
  level: string
  cell_m: number
  synthetic?: boolean
  cells: MagmapCell[]
}

export type PositionSource = 'wifi' | 'pdr' | 'fused'

/** Engine output (SURVEY_SCHEMA.md §4). */
export interface PositionUpdate {
  /** epoch ms */
  t: number
  level: string
  x: number
  y: number
  /** ~1σ radial spread of the estimate (m), floored at 1 m */
  accuracy_m: number
  /** walking direction, degrees clockwise from local +y (map up); null until known */
  heading_deg: number | null
  source: PositionSource
  confidence: number
}

/** Automatic floor change (engine onLevelChange). */
export interface LevelChange {
  /** epoch ms */
  t: number
  from: string
  to: string
  /** barometric step, or WiFi: level vote, or the WiFi-matched estimate sat where this level has no floor (2F over the
   *  arena void, confidence 0.9) — or both agreeing */
  source: 'barometer' | 'wifi' | 'both'
  confidence: number
  /** nav node the filter was re-seeded at (e.g. 2F-el2), null when no connector links the levels */
  connector: string | null
}
