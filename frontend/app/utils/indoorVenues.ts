import { locale, t } from '~/i18n'
import type { Map as MapLibreMap, Marker } from 'maplibre-gl'
import { watch } from 'vue'

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
  border: 2px solid var(--white, #fff); border-radius: 999px;
  background: var(--primary-700, #356C77); color: var(--white, #fff);
  font: 600 14px/20px "PingFang TC", "Noto Sans TC", "Microsoft JhengHei", system-ui, sans-serif;
  white-space: nowrap; cursor: pointer;
  box-shadow: var(--shadow-floating, 0 8px 24px -4px #22474E1F, 0 2px 6px -1px #22474E0F);
}
.indoor-venue-marker:hover { background: var(--primary-800, #22474E); }
.indoor-venue-marker:focus-visible { outline: 3px solid var(--primary-300, #93D4DF); outline-offset: 2px; }
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
