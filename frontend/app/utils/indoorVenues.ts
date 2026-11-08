import { locale, t } from '~/i18n'
import type { Map as MapLibreMap, Marker } from 'maplibre-gl'
import { watch } from 'vue'
import { semantic } from './palette'

/** A building with an indoor map (FastAPI GET /v1/indoor/venues). */
export interface IndoorVenue {
  id: string
  name: string
  shortName: string
  /** [lng, lat] marker position */
  center: [number, number]
}

/**
 * Fallback when the indoor API is unreachable. Tianmu's centre comes from its georeferenced
 * venue.json (origin 25.1156940, 121.5346582, bearing −0.39°) plus the building's local centre
 * (≈ 37 m east, 33 m north of the origin).
 */
export const STATIC_INDOOR_VENUES: IndoorVenue[] = [
  { id: 'tianmu', name: '臺北市立大學天母體育館', shortName: '天母體育館', center: [121.53503, 25.11599] },
]

/** Below this zoom the marker is hidden; until FULL_ZOOM it shows the icon only. */
const MIN_ZOOM = 13
const FULL_ZOOM = 15

type ApiVenue = {
  id?: string
  name?: string
  short_name?: string | null
  center?: [number, number]
  origin?: { lng: number; lat: number }
}

export async function fetchIndoorVenues(signal?: AbortSignal): Promise<IndoorVenue[]> {
  try {
    const res = await fetch('/api/v1/indoor/venues', { signal, headers: { Accept: 'application/json' } })
    if (!res.ok) throw new Error(String(res.status))
    const body = (await res.json()) as ApiVenue[] | { venues?: ApiVenue[] }
    const list = Array.isArray(body) ? body : body.venues ?? []
    const venues = list.flatMap((v): IndoorVenue[] => {
      const fallback = STATIC_INDOOR_VENUES.find((s) => s.id === v.id)
      const center = v.center ?? (v.origin ? [v.origin.lng, v.origin.lat] as [number, number] : fallback?.center)
      if (!v.id || !center) return []
      return [{ id: v.id, name: v.name ?? fallback?.name ?? v.id, shortName: v.short_name ?? fallback?.shortName ?? v.name ?? v.id, center }]
    })
    knownVenues = venues.length ? venues : STATIC_INDOOR_VENUES
  } catch {
    knownVenues = STATIC_INDOOR_VENUES
  }
  return knownVenues
}

let knownVenues = STATIC_INDOOR_VENUES

/** Centre the outdoor map on a venue (e.g. on leaving its indoor map), so its marker is in view at full size. */
export function focusIndoorVenue(map: MapLibreMap | undefined, venueId: string) {
  const venue = knownVenues.find((v) => v.id === venueId)
  if (map && venue) map.easeTo({ center: venue.center, zoom: 16, duration: 0 })
}

const STYLE_ID = 'indoor-venue-marker-style'
const BUILDING_ICON =
  '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M4 21V8l8-5 8 5v13M4 21h16M9 21v-5h6v5M8 11h2m4 0h2" /></svg>'

function injectStyle() {
  if (document.getElementById(STYLE_ID)) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  // HowGo floating pill: icon + text (never colour-only), ≥ 48 px target, --shadow-floating
  style.textContent = `
.indoor-venue-marker {
  display: inline-flex; align-items: center; gap: 6px;
  min-height: 48px; min-width: 48px; padding: 0 16px 0 12px;
  border: 2px solid var(--map-marker-white, ${semantic.mapMarkerWhite}); border-radius: 999px;
  background: var(--indoor-map-accent, ${semantic.indoorMapAccent}); color: var(--map-marker-white, ${semantic.mapMarkerWhite});
  font: 600 14px/20px "PingFang TC", "Noto Sans TC", "Microsoft JhengHei", system-ui, sans-serif;
  white-space: nowrap; cursor: pointer;
  box-shadow: var(--shadow-floating);
}
/* UI-001 has no darker violet, so hover deepens the accent instead of switching tokens. */
.indoor-venue-marker:hover { filter: brightness(.88); }
.indoor-venue-marker:focus-visible { outline: 3px solid var(--indoor-map-accent, ${semantic.indoorMapAccent}); outline-offset: 2px; }
.indoor-venue-marker[data-compact] { padding: 0; justify-content: center; width: 48px; }
.indoor-venue-marker[data-compact] .indoor-venue-label { display: none; }
.indoor-venue-marker[hidden] { display: none; }`
  document.head.appendChild(style)
}

export interface IndoorVenueMarkerOptions {
  /** Tapping a marker calls this with the venue id. */
  onOpen: (venueId: string) => void
  /** Reactive getter; markers show only while it is true (e.g. general mode). */
  visible?: () => boolean
}

/**
 * Add a floating 「天母體育館 · 室內地圖」 HTML marker per indoor venue (above every basemap layer).
 * Returns a cleanup function. Uses its own dynamic import of maplibre-gl (already loaded by the map).
 */
export async function addIndoorVenueMarkers(map: MapLibreMap, { onOpen, visible = () => true }: IndoorVenueMarkerOptions): Promise<() => void> {
  const [{ Marker: MarkerCtor }, venues] = await Promise.all([import('maplibre-gl'), fetchIndoorVenues()])
  injectStyle()
  const markers: { marker: Marker; el: HTMLButtonElement; name: string }[] = venues.map((v) => {
    const el = document.createElement('button')
    el.type = 'button'
    el.className = 'indoor-venue-marker'
    el.innerHTML = `${BUILDING_ICON}<span class="indoor-venue-label"></span>`
    el.addEventListener('click', (e) => {
      e.stopPropagation()
      onOpen(v.id)
    })
    return { marker: new MarkerCtor({ element: el, anchor: 'center' }).setLngLat(v.center).addTo(map), el, name: v.shortName }
  })
  const update = () => {
    const z = map.getZoom()
    const show = visible()
    for (const { el } of markers) {
      el.hidden = !show || z < MIN_ZOOM
      el.toggleAttribute('data-compact', z < FULL_ZOOM)
    }
  }
  update()
  map.on('zoom', update)
  const updateLabels = () => {
    for (const { el, name } of markers) {
      el.setAttribute('aria-label', t('開啟{0}室內地圖', t(name)))
      el.querySelector('.indoor-venue-label')!.textContent = t('{0} · 室內地圖', t(name))
    }
  }
  updateLabels()
  const stopLabels = watch(locale, updateLabels)
  const stopWatch = watch(visible, update)
  return () => {
    stopLabels()
    stopWatch()
    map.off('zoom', update)
    for (const { marker } of markers) marker.remove()
  }
}

/* ---------- UI-009 building footprint highlight ---------- */

type LocalUnits = { features?: { properties?: { category?: string }; geometry?: { type?: string; coordinates?: unknown } }[] }
type VenueFrame = { origin?: { lng: number; lat: number }; bearing_deg?: number; default_level?: string; levels?: { id: string }[] }

/** Local venue metres → [lng, lat]; same tangent-plane frame as indoor-nav/src/geo/frame.ts and backend local_to_lnglat. */
function toLngLat([x, y]: number[], origin: { lng: number; lat: number }, bearingDeg: number): [number, number] {
  const r = 6378137
  const th = bearingDeg * Math.PI / 180
  const east = x! * Math.cos(th) + y! * Math.sin(th)
  const north = -x! * Math.sin(th) + y! * Math.cos(th)
  return [origin.lng + (east / (r * Math.cos(origin.lat * Math.PI / 180))) * 180 / Math.PI, origin.lat + (north / r) * 180 / Math.PI]
}

function convexHull(points: number[][]): number[][] {
  const sorted = [...points].sort((a, b) => a[0]! - b[0]! || a[1]! - b[1]!)
  const cross = (o: number[], a: number[], b: number[]) => (a[0]! - o[0]!) * (b[1]! - o[1]!) - (a[1]! - o[1]!) * (b[0]! - o[0]!)
  const half = (list: number[][]) => list.reduce<number[][]>((hull, p) => {
    while (hull.length >= 2 && cross(hull[hull.length - 2]!, hull[hull.length - 1]!, p) <= 0) hull.pop()
    hull.push(p)
    return hull
  }, [])
  const lower = half(sorted)
  const upper = half([...sorted].reverse())
  return [...lower.slice(0, -1), ...upper.slice(0, -1)]
}

/**
 * The venue data has no separate building-outline polygon, so the footprint is the outline of the
 * default level's indoor units (rooms, corridors, stairs…), excluding outdoor `walkway` units such as
 * an entrance platform. Returns null when the venue data cannot be loaded; the map then shows only the entrance.
 */
async function venueFootprint(id: string): Promise<[number, number][] | null> {
  try {
    const base = `/api/v1/indoor/data/${encodeURIComponent(id)}/`
    const venue = await (await fetch(base + 'venue.json')).json() as VenueFrame
    const level = venue.default_level ?? venue.levels?.[0]?.id
    if (!venue.origin || !level) return null
    const units = await (await fetch(`${base}levels/${encodeURIComponent(level)}/units.geojson`)).json() as LocalUnits
    const points = (units.features ?? []).flatMap((feature) => {
      if (feature.properties?.category === 'walkway') return []
      const { type, coordinates } = feature.geometry ?? {}
      const polygons = type === 'Polygon' ? [coordinates] : type === 'MultiPolygon' ? coordinates as unknown[] : []
      return (polygons as number[][][][]).flatMap(rings => rings[0] ?? [])
    })
    if (points.length < 3) return null
    const ring = convexHull(points).map(p => toLngLat(p, venue.origin!, venue.bearing_deg ?? 0))
    return [...ring, ring[0]!]
  } catch {
    return null
  }
}

/**
 * Violet (indoor-map-accent) footprint per indoor venue: 16 % fill and a 2 px outline, inserted
 * below `beforeId` so markers and the HTML entrance stay on top.
 */
export async function addIndoorBuildingOutlines(map: MapLibreMap, beforeId?: string) {
  const venues = await fetchIndoorVenues()
  const outlines = (await Promise.all(venues.map(async v => ({ v, ring: await venueFootprint(v.id) }))))
    .flatMap(({ v, ring }) => ring ? [{ type: 'Feature' as const, properties: { venue: v.id }, geometry: { type: 'Polygon' as const, coordinates: [ring] } }] : [])
  if (!outlines.length || map.getSource('indoor-buildings')) return
  const before = beforeId && map.getLayer(beforeId) ? beforeId : undefined
  map.addSource('indoor-buildings', { type: 'geojson', data: { type: 'FeatureCollection', features: outlines } })
  map.addLayer({ id: 'indoor-building-fill', source: 'indoor-buildings', type: 'fill',
    paint: { 'fill-color': semantic.indoorMapAccent, 'fill-opacity': .16 } }, before)
  map.addLayer({ id: 'indoor-building-outline', source: 'indoor-buildings', type: 'line',
    paint: { 'line-color': semantic.indoorMapAccent, 'line-width': 2 } }, before)
}
