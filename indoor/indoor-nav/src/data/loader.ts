import type {
  FeatureCollection, LevelData, NavFeature, PoiFeature, UnitFeature, Seating3DFeature, Venue, VenueData, Wall3DFeature, WallFeature,
} from './types'

export class VenueLoadError extends Error {}

/**
 * Wall linework dropped at load: exploded CAD text strokes ('other' per SCHEMA.md, 'text' in older
 * exports) and dimensions. They are ~75% of the features and add nothing to the map.
 */
const DROPPED_WALL_LAYERS = new Set(['other', 'text', 'dim'])

/**
 * Root of the venue data: HowGo's FastAPI `GET /v1/indoor/data/{venue}/{path}`, reached through the
 * host's `/api` proxy. Hosts / tests can point it elsewhere with setDataBase().
 */
export const DEFAULT_DATA_BASE = '/api/v1/indoor/data/'
let dataBase = DEFAULT_DATA_BASE

export function setDataBase(base: string) {
  dataBase = base.endsWith('/') ? base : base + '/'
}

/** Base URL of one venue's files (venue.json, levels/…, nav.geojson, positioning/…). */
export function venueBaseUrl(venueId: string): string {
  return `${dataBase}${encodeURIComponent(venueId)}/`
}

/**
 * Fetch a JSON file, returning null if it is missing. Vite's dev server (and many static
 * hosts) answer unknown paths with index.html + 200, so a body that does not parse as JSON
 * is treated as missing too.
 */
async function fetchJson<T>(url: string): Promise<T | null> {
  let res: Response
  try {
    res = await fetch(url)
  } catch {
    return null
  }
  if (!res.ok) return null
  const text = await res.text()
  try {
    return JSON.parse(text) as T
  } catch {
    return null
  }
}

async function fetchFeatures<F>(url: string): Promise<F[] | null> {
  const fc = await fetchJson<FeatureCollection<unknown, unknown>>(url)
  if (!fc || fc.type !== 'FeatureCollection' || !Array.isArray(fc.features)) return null
  return fc.features as F[]
}

const withLevel = <F extends { properties: object }>(fs: F[], level: string): F[] => {
  // files are per level directory; make sure every feature carries its level
  for (const f of fs) f.properties = { ...(f.properties ?? {}), level } as F['properties']
  return fs
}

export interface LevelWalls {
  /** null if the level has no walls.geojson */
  walls: WallFeature[] | null
  /** null if the level has no walls3d.geojson (optional; the map then stays flat) */
  walls3d: Wall3DFeature[] | null
  /** null if the level has no seating3d.geojson */
  seating3d: Seating3DFeature[] | null
}

/** Wall linework + extrusion slabs of one level (the biggest files). */
export async function loadLevelWalls(venueId: string, levelId: string): Promise<LevelWalls> {
  const dir = `${venueBaseUrl(venueId)}levels/${encodeURIComponent(levelId)}/`
  const [walls, walls3d, seating3d] = await Promise.all([
    fetchFeatures<WallFeature>(dir + 'walls.geojson'),
    fetchFeatures<Wall3DFeature>(dir + 'walls3d.geojson'),
    fetchFeatures<Seating3DFeature>(dir + 'seating3d.geojson'),
  ])
  return {
    walls: walls && withLevel(walls.filter((w) => !DROPPED_WALL_LAYERS.has(w.properties?.layer ?? '')), levelId),
    walls3d: walls3d && withLevel(walls3d, levelId),
    seating3d: seating3d && withLevel(seating3d, levelId),
  }
}

/**
 * Load a venue. Units, POIs and nav (small, needed for search and routing) are fetched for every
 * level in parallel; walls only for the initial level so the first map shows quickly. Other
 * levels' walls come later via loadLevelWalls (LevelData.wallsLoaded tells them apart).
 */
export async function loadVenue(venueId: string): Promise<VenueData> {
  if (!/^[\w-]+$/.test(venueId)) throw new VenueLoadError(`無效的場館代碼: ${venueId}`)
  const base = venueBaseUrl(venueId)
  const venue = await fetchJson<Venue>(base + 'venue.json')
  if (!venue || !Array.isArray(venue.levels) || !venue.origin) {
    throw new VenueLoadError(`找不到場館資料 (${base}venue.json)`)
  }
  venue.bearing_deg ??= 0

  const sorted = [...venue.levels].sort((a, b) => a.ordinal - b.ordinal)
  const initial = sorted.some((l) => l.id === venue.default_level) ? venue.default_level : sorted[0]?.id
  const available = { walls: false, walls3d: false, units: false, pois: false, nav: false }

  const [levels, nav] = await Promise.all([
    Promise.all(
      sorted.map(async (level): Promise<LevelData> => {
        const dir = `${base}levels/${encodeURIComponent(level.id)}/`
        const eager = level.id === initial
        const [w, units, pois] = await Promise.all([
          eager ? loadLevelWalls(venueId, level.id) : Promise.resolve({ walls: null, walls3d: null, seating3d: null }),
          fetchFeatures<UnitFeature>(dir + 'units.geojson'),
          fetchFeatures<PoiFeature>(dir + 'pois.geojson'),
        ])
        if (w.walls) available.walls = true
        if (w.walls3d) available.walls3d = true
        if (units) available.units = true
        if (pois) available.pois = true
        return {
          level, walls: w.walls ?? [], walls3d: w.walls3d ?? [], seating3d: w.seating3d ?? [], wallsLoaded: eager,
          units: withLevel(units ?? [], level.id), pois: withLevel(pois ?? [], level.id),
        }
      }),
    ),
    fetchFeatures<NavFeature>(base + 'nav.geojson'),
  ])
  if (nav) available.nav = true

  return { venue, levels, nav: nav ?? [], available }
}
