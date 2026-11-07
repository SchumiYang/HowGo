/**
 * Typed client for the indoor admin API, HowGo FastAPI /v1/indoor (backend/rollx/indoor.py; contract: mapdata/ADMIN_API.md).
 * All calls go to the same origin; errors surface as thrown ApiError with the server's message.
 */
import type { Magmap, Radiomap } from '../positioning/types'
import type { XY } from '../geo/frame'

export class ApiError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

async function call<T>(method: string, url: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  let res: Response
  try {
    const raw = body instanceof Blob || body instanceof ArrayBuffer
    res = await fetch(url, {
      method,
      cache: 'no-store',
      headers: body === undefined || raw ? headers : { 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : raw ? (body as BodyInit) : JSON.stringify(body),
    })
  } catch (err) {
    throw new ApiError(0, `無法連線伺服器：${(err as Error).message}`)
  }
  const text = await res.text()
  let j: unknown = null
  try {
    j = text ? JSON.parse(text) : null
  } catch {
    /* non-JSON */
  }
  if (!res.ok) throw new ApiError(res.status, (j as { error?: string } | null)?.error ?? `HTTP ${res.status}`)
  return j as T
}

const enc = encodeURIComponent
/** HowGo FastAPI indoor router behind the /api proxy (Vite here, Nuxt in the main app) */
export const API = '/api/v1/indoor'

// ---------- data ----------

export const getData = <T = unknown>(venue: string, path: string) => call<T>('GET', `${API}/data/${enc(venue)}/${path}`)

/** `history`: where the previous version was backed up (mapdata-relative), null for a new file */
export interface PutResult { ok: true; bytes: number; history: string | null }
export const putData = (venue: string, path: string, obj: unknown) => call<PutResult>('PUT', `${API}/data/${enc(venue)}/${path}`, obj)

export const uploadFloorplan = (venue: string, level: string, file: Blob) =>
  call<{ ok: true; url: string; bytes: number }>('POST', `${API}/floorplan/${enc(venue)}/${enc(level)}`, file, { 'Content-Type': file.type })

// ---------- build ----------

export type BuildTarget = 'radiomap' | 'magmap'
export interface BuildOptions { walksOnly?: boolean; exclude?: string[]; level?: string }
export interface BuildStatus {
  running: boolean
  jobId: string | null
  startedAt: number | null
  finishedAt: number | null
  exitCode: number | null
  log: string
  report?: {
    verdict?: 'ok' | 'failed'
    outputs?: Record<string, { built_at?: number | null; sessions?: string[] | null; points?: number; bssids?: number; cells?: number; cell_m?: number; synthetic?: boolean }>
    [target: string]: unknown
  } | null
}

export const startBuild = (venue: string, targets: BuildTarget[], options: BuildOptions = {}) =>
  call<{ ok: true; jobId: string }>('POST', `${API}/build/${enc(venue)}`, { targets, options })
export const buildStatus = (venue: string) => call<BuildStatus>('GET', `${API}/build/${enc(venue)}/status`)
export const buildPreviewUrl = (name: string) => `${API}/build/preview/${enc(name)}`

// ---------- sessions ----------

export interface WalkSummary {
  index: number
  walk_id: string
  direction: 'forward' | 'reverse'
  level: string | null
  path: XY[]
  t_start: number
  t_end: number
  marks: { t: number; vertex: number }[]
  n_mag: number
  n_wifi: number
}
export interface SessionSummary {
  session_id: string
  device: { model: string | null; platform: string | null }
  purpose: string | null
  synthetic: boolean
  walks: number
  points: number
  bytes: number
  mtime: number
  walk_list: WalkSummary[]
  error?: string
}
export const listSessions = () => call<SessionSummary[]>('GET', `${API}/survey/sessions`)

export interface RecordedWalk {
  walk_id: string
  level?: string
  direction: 'forward' | 'reverse'
  path: XY[]
  t_start: number
  t_end: number
  marks?: { t: number; vertex: number }[]
  sensors: { accelerometer: [number, number, number, number][]; gyroscope: [number, number, number, number][]; magnetometer: [number, number, number, number][] }
  wifi_scans?: { collected_at: number; results: { bssid: string; ssid: string; level: number; frequency: number; timestamp: number | null }[] }[]
}
export const getSessionWalk = (sessionId: string, index: number) =>
  call<{ session_id: string; device: unknown; walk: RecordedWalk }>('GET', `${API}/survey/session/${enc(sessionId)}?walk=${index}`)

export const health = () => call<{ ok: boolean }>('GET', `${API}/survey/health`)

// ---------- eval ----------

export interface EvalCheckpoint {
  t: number
  level: string
  truth: XY
  estimate: XY | null
  accuracy_m: number | null
  source: string | null
  confidence: number | null
  error_m: number | null
}
export interface EvalSummary { n: number; median_m: number | null; p90_m: number | null; max_m: number | null }
export interface EvalRun {
  schema: 'tpnav-eval/0'
  run_id: string
  venue: string
  kind?: 'live' | 'replay'
  device: Record<string, unknown>
  engine: { maps: { radiomap: 'real' | 'none'; magmap: 'real' | 'none' }; options: Record<string, unknown>; map_versions?: { radiomap_built_at: number | null; magmap_built_at: number | null } }
  checkpoints: EvalCheckpoint[]
  track?: [number, number, number, number, string][]
  summary: EvalSummary
  // live runs (optional): enough to re-run the engine offline
  started_at?: number
  start?: { sensor_interval_ms: number; batch_ms: number; wifi_interval_ms: number; engine_uses_wifi: boolean }
  /** first known-position seed; `seeds` lists every 「設為已知位置」 (t, level, x, y, heading_deg clockwise from +y) */
  seed?: EvalSeed | null
  seeds?: EvalSeed[]
  /** raw bridge data, same tuples as survey walks (SURVEY_SCHEMA.md §2); ~45 B per sample, ~7 MB per 10 min */
  raw?: {
    sensors: RecordedWalk['sensors']
    wifi_scans: NonNullable<RecordedWalk['wifi_scans']>
    /** iOS only: [t, magnetometer_accuracy] on change */
    mag_accuracy?: [number, number][]
    stats: { samples: number; scans: number; bytes: number }
  }
}
export interface EvalSeed { t: number; level: string; x: number; y: number; heading_deg: number | null; accuracy_m: number; snapped_id: string | null }
export interface EvalListItem {
  run_id: string
  venue: string
  device: Record<string, unknown> | null
  engine: EvalRun['engine'] | null
  kind: string
  summary: EvalSummary
  checkpoints: number
  mtime: number
}
export const saveEval = (run: EvalRun) => call<{ ok: true }>('POST', `${API}/eval`, run)
export const listEvals = () => call<EvalListItem[]>('GET', `${API}/eval`)

// ---------- positioning maps (raw, for coverage overlays) ----------

export const getRadiomap = (venue: string) => getData<Radiomap>(venue, 'positioning/wifi_radiomap.json').catch(() => null)
export const getMagmap = (venue: string, level: string) => getData<Magmap>(venue, `positioning/magmap_${enc(level)}.json`).catch(() => null)
