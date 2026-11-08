/**
 * Minimal admin API client (mapdata/ADMIN_API.md) for the 平面圖 / POI tabs, plus a loader that
 * reads a level's editable files from the source of truth (GET /api/v1/indoor/data/...).
 */
import type { Level, LevelData, NavFeature, PoiFeature, UnitFeature, Venue, VenueData, WallFeature } from '../../data/types'

const API = '/api/v1/indoor'

export class ApiError extends Error {}

/** GET a data file; null when it doesn't exist (404). */
export async function getData<T>(venue: string, path: string): Promise<T | null> {
  const res = await fetch(`${API}/data/${encodeURIComponent(venue)}/${path}`, { cache: 'no-store' })
  if (res.status === 404) return null
  const text = await res.text()
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    throw new ApiError(`GET ${path}: 伺服器未回傳 JSON（admin 伺服器是否已啟動？）`)
  }
  if (!res.ok) throw new ApiError(`GET ${path}: ${(body as { error?: string })?.error ?? res.status}`)
  return body as T
}

/** PUT a full replacement of a data file. */
export async function putData(venue: string, path: string, json: unknown): Promise<{ ok: true; bytes: number; history: string | null }> {
  const res = await fetch(`${API}/data/${encodeURIComponent(venue)}/${path}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(json),
  })
  const body = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }))
  if (!res.ok || !body.ok) throw new ApiError(`PUT ${path}: ${body.error ?? res.status}`)
  return body
}

/** POST a floor plan image; returns its API URL. */
export async function postFloorplan(venue: string, level: string, file: Blob): Promise<{ ok: true; url: string }> {
  const res = await fetch(`${API}/floorplan/${encodeURIComponent(venue)}/${encodeURIComponent(level)}`, {
    method: 'POST',
    headers: { 'Content-Type': file.type || 'application/octet-stream' },
    body: file,
  })
  const body = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }))
  if (!res.ok || !body.ok) throw new ApiError(`上傳平面圖失敗: ${body.error ?? res.status}`)
  return body
}

/** a FeatureCollection keeping any extra top-level members (e.g. the server's `source`) */
export type FC<F> = { type: 'FeatureCollection'; features: F[]; [k: string]: unknown }

/** The editable files of one level as FeatureCollections (top-level members such as `source` kept). */
export interface LevelFiles {
  venue: Venue
  nav: FC<NavFeature>
  units: FC<UnitFeature>
  pois: FC<PoiFeature>
  walls: WallFeature[]
}

const emptyFc = <F>(): FC<F> => ({ type: 'FeatureCollection', features: [] })

export async function loadLevelFiles(venueId: string, level: string): Promise<LevelFiles> {
  const dir = `levels/${encodeURIComponent(level)}/`
  const [venue, nav, units, pois, walls] = await Promise.all([
    getData<Venue>(venueId, 'venue.json'),
    getData<FC<NavFeature>>(venueId, 'nav.geojson'),
    getData<FC<UnitFeature>>(venueId, dir + 'units.geojson'),
    getData<FC<PoiFeature>>(venueId, dir + 'pois.geojson'),
    getData<FC<WallFeature>>(venueId, dir + 'walls.geojson'),
  ])
  if (!venue) throw new ApiError(`找不到 ${venueId}/venue.json`)
  venue.bearing_deg ??= 0
  const keep = ['wall', 'column', 'stairs', 'fixture', 'court', 'door', 'hatch'] // as the main loader: skip CAD text strokes
  return {
    venue,
    nav: nav ?? emptyFc(),
    units: units ?? emptyFc(),
    pois: pois ?? emptyFc(),
    walls: (walls?.features ?? []).filter((w) => keep.includes(w.properties?.layer)),
  }
}

/** VenueData for the map: the edited level filled in, other levels empty. */
export function toVenueData(f: LevelFiles, level: string): VenueData {
  const withLevel = <F extends { properties: object }>(fs: F[]) => fs.map((x) => ({ ...x, properties: { ...x.properties, level } }))
  const levels: LevelData[] = f.venue.levels.map((l: Level) =>
    l.id === level
      ? { level: l, walls: withLevel(f.walls), wallsLoaded: true, walls3d: [], units: withLevel(f.units.features), pois: withLevel(f.pois.features) }
      : { level: l, walls: [], wallsLoaded: true, walls3d: [], units: [], pois: [] },
  )
  return {
    venue: f.venue,
    levels,
    nav: f.nav.features,
    available: { walls: true, walls3d: false, units: true, pois: true, nav: f.nav.features.length > 0 },
  }
}
