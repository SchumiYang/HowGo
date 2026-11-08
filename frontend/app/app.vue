<script setup lang="ts">
import { locale, t } from '~/i18n'
import { localizeRouteError, localizeRouteText } from './utils/routeLocale'

import type { Feature, FeatureCollection, LineString, MultiPolygon, Point, Polygon } from 'geojson'
import type { ExpressionSpecification, GeoJSONSource, Map as MapLibreMap, MapGeoJSONFeature, Popup as MapLibrePopup } from 'maplibre-gl'
import { createRouteTracker } from './utils/navigation'
import { getFix, locationAvailable, openExternal, watchFix, type FixError } from './utils/geolocation'
import { LOCAL_CJK_FONT, TAIPEI_BOUNDS, collapseAttribution, loadBasemap } from './utils/basemap'
import type { IconName } from './components/AppIcon.vue'
import type { AppMode } from './components/ModeLanding.vue'
import type { Coordinate, Place } from './composables/usePlaceSearch'
import {
  DESTINATION_PIN_ID, DESTINATION_PIN_OFFSET, SELECTED_PIN_ID, addDestinationPin, addLayerIcons, addSelectionImages, layerDotExpression, layerIconColors, layerIconExpression, layerIconFor,
  layerImageId, type LayerIconName,
} from './utils/mapLayerIcons'
import { distanceM, iconPoints, routePasses } from './utils/layerGeometry'
import { palette } from './utils/palette'

useHead({ htmlAttrs: { lang: () => locale.value } })

/**
 * Screens follow 室外uiux-v1/ACCESSIBLE_NAV_FLUTTER_WEB_SPEC.md:
 * explore = Page 1, preview = Page 2, search = Page 2-1, picker = Page 2-2, navigate = Page 3.
 */
type Screen = 'explore' | 'preview' | 'search' | 'picker' | 'navigate'
type Endpoint = 'start' | 'end'
type FacilityKind = typeof facilityKinds[number]
type Facility = Feature<Point, { kind: FacilityKind; name: string; label: string; distance_m?: number }>
type Facilities = FeatureCollection<Point, Facility['properties']> & { truncated?: boolean }
type WalkwayKind = typeof walkwayKinds[number]
type Walkway = Feature<Polygon | MultiPolygon | LineString, { kind: WalkwayKind; name: string; label: string }>
type Walkways = FeatureCollection<Walkway['geometry'], Walkway['properties']> & { truncated?: boolean }
type SlopeFeature = Feature<Point | LineString, { kind: string; name?: string; source: string; slope?: number; incline?: string }>
type RouteMode = 'fastest' | 'balanced' | 'accessible'
type RouteError = { message: string; endpoint?: Endpoint }
type RouteOption = { route?: RouteResult; error?: RouteError }
type DirectionAction = 'left' | 'right' | 'straight' | 'roundabout' | 'uturn' | 'arrive'
type WalkwayGuidance = { side: 'left' | 'right' | 'along'; reason: string; from_m: number; to_m: number | null }
type RouteStep = {
  action: DirectionAction
  instruction: string
  distance_m: number
  from_index: number
  to_index: number
  guidance?: WalkwayGuidance
  guidance_ranges?: WalkwayGuidance[]
  crossings?: { at_m: number; end_m: number }[]
}
type Maneuver = {
  action: DirectionAction | 'crossing' | 'sidewalk' | 'stairs' | 'advice'
  instruction: string
  note?: string
  at_m: number
  end_m: number
  position: Coordinate
}
type FeatureDetail = { kind: string; title: string; name: string; lines: string[] }
type RouteResult = {
  mode: RouteMode
  assessment: {
    comfortable_m: number
    limited_m: number
    blocked_m: number
    stairs_m: number | null
    stair_sections: number | null
    mapped_slope_sections: number
  }
  route: Feature<LineString>
  distance_m: number
  duration_s: number
  steps?: RouteStep[]
  maneuvers?: Maneuver[]
  unverified_walkways?: { at_m: number; end_m: number }[]
  highlights?: FeatureCollection<Point | Polygon, { route_context: string }>
  access_points?: Partial<Record<Endpoint, { coordinates: Coordinate; offset_m: number }>>
}
/** /v1/meta: only the service coverage is used (to reject GPS fixes outside Taipei). */
type Metadata = {
  coverage: [number, number, number, number]
}

/**
 * /v1/facilities kinds: 1 斜坡道, 3 無障礙電梯, 4 公園, 7 捷運站及公園無障礙出入口, 8 友善店家, 9 無障礙廁所,
 * 14 身障設施, 15 路邊停車場, 16 路邊停車格, accessible-parking 身心障礙停車格, 18 公車站, 20 捷運站.
 * Display names come from each feature's `label`.
 */
const facilityKinds = ['1', '3', '4', '7', '8', '9', '14', '15', '16', 'accessible-parking', '18', '20'] as const
/** Map marker size for the UI-004 badges (images are 32 CSS px at icon-size 1). */
const LAYER_ICON_SIZE: ExpressionSpecification = ['interpolate', ['linear'], ['zoom'], 15, .62, 18, .9]

/** /v1/walkways kinds: 11 人行道, 12 標線型人行道, 13 行穿線（市府）, osm-crossing 行人穿越道（OSM）, arcade 騎樓整平路段. */
const walkwayKinds = ['11', '12', '13', 'osm-crossing', 'arcade'] as const
/**
 * UI-014: walkway polygons are coloured by the backend's feasibility grade (`grade`, from
 * rollx/route_modes.py sidewalk_grade: comfortable 可行 / limited 勉強可行 / blocked 不可行).
 * Missing or unknown grades fall back to Primary / 500; this is display only, the card shows the raw grade.
 */
const walkwayColor: ExpressionSpecification = [
  'match', ['get', 'grade'], 'limited', palette.secondary500, 'blocked', palette.red500, palette.primary500,
]

type LayerKind = FacilityKind | WalkwayKind | 'slope'
const allLayerKinds: LayerKind[] = [...facilityKinds, ...walkwayKinds, 'slope']
// UI-004: each quick-filter group has one badge icon, shared with the map markers and place card.
const layerGroups = [
  { label: '人行通道', icon: 'pedestrian', kinds: ['11', '12', '13', 'osm-crossing', 'arcade'] },
  { label: '坡度', icon: 'slope', kinds: ['slope'] },
  { label: '身障停車格', icon: 'accessible-parking', kinds: ['accessible-parking'] },
  { label: '出入口／坡道', icon: 'entrance-ramp', kinds: ['1', '7'] },
  { label: '友善店家', icon: 'friendly-store', kinds: ['8'] },
  { label: '無障礙廁所', icon: 'accessible-restroom', kinds: ['9'] },
  { label: '大眾運輸', icon: 'public-transit', kinds: ['18', '20'] },
  { label: '公園', icon: 'park', kinds: ['4'] },
  { label: '停車', icon: 'parking', kinds: ['15', '16'] },
  { label: '身障設施', icon: 'accessible-facilities', kinds: ['3', '14'] },
] satisfies { label: string; icon: LayerIconName; kinds: LayerKind[] }[]
const SLOPE_COLOR = layerIconColors.slope
/** Below these zooms the point / walkway layers would cover the whole map, so they are not drawn or fetched. */
const FACILITY_MIN_ZOOM = 15
const WALKWAY_MIN_ZOOM = 14
const SIDEWALK_MIN_ZOOM = 15

// Town Pass Primary family for the route; amber/orange for destination per DESIGN.md.
const routeColors = {
  route: palette.primary500, casing: palette.primary700, walked: palette.grey300, alternative: palette.primary400,
  // 行經 and 指引側 sidewalks share UI-001's only green; the guided side is told apart by its lighter fill
  // and a dashed Primary / 700 outline (map and legend swatch alike).
  sidewalk: palette.green500, guidedSidewalk: palette.green500, guidedOutline: palette.primary700,
  ramp: palette.primary700, slope: palette.secondary600,
}
/*
 * UI-019 live position: Primary / 700 dot with a thin white ring, over a Primary / 500 accuracy disc
 * (28% fill, thin stroke) and a Primary / 700 heading cone (32% at the centre) when a heading is known.
 */
const LIVE_DOT_COLOR = palette.primary700
const LIVE_DISC_COLOR = palette.primary500
const LIVE_RADIUS_PX = 22
const LIVE_HEADING_ID = 'live-heading-cone'
/** UI-019 navigation focus: other route steps at 35%, off-step facilities as 55% category dots. */
const NAV_OTHER_ROUTE_OPACITY = .35
const NAV_OFF_STEP_DOT_OPACITY = .55
const NAV_ARROW_ID = 'nav-step-chevron'
/** Context drawn around a turn so the step shows the approach and the exit, not just the corner. */
const NAV_TURN_APPROACH_M = 30
const NAV_TURN_EXIT_M = 30
const NAV_SHORT_STEP_M = 25
/**
 * Layers that only explain the route while planning. During navigation they compete with the step
 * (five extra colours: sidewalk greens, walkway teal, crossing dashes, halos), so they are hidden.
 */
const NAV_HIDDEN_LAYERS = ['walkways-fill', 'walkways-outline', 'crossings-osm', 'route-sidewalk-fill',
  'route-sidewalk-outline', 'guided-sidewalk-fill', 'guided-sidewalk-outline', 'route-alternatives',
  'slope-lines', 'route-access-points']
const routeKey = [
  { context: 'route', label: '路線', color: routeColors.route },
  { context: 'sidewalk', label: '行經人行道', color: routeColors.sidewalk },
  { context: 'guided-sidewalk', label: '指引側人行道', color: routeColors.guidedSidewalk },
  { context: 'ramp', label: '無障礙坡道', color: routeColors.ramp },
  { context: 'slope', label: '鄰近坡度點', color: routeColors.slope },
]

const config = useRuntimeConfig()
const mapElement = useTemplateRef<HTMLDivElement>('mapElement')
const mapReady = ref(false)
const mapMessage = ref('')
const facilityMessage = ref('')
const walkwayMessage = ref('')
const enabledLayers = ref<LayerKind[]>([...allLayerKinds])
const allLayersSelected = computed(() => allLayerKinds.every(kind => enabledLayers.value.includes(kind)))
const enabledFacilities = computed(() => facilityKinds.filter(kind => enabledLayers.value.includes(kind)))
const enabledWalkways = computed(() => walkwayKinds.filter(kind => enabledLayers.value.includes(kind)))
const showLayers = ref(false)
const mapZoom = ref(FACILITY_MIN_ZOOM)
const facilitiesHiddenByZoom = computed(() => mapReady.value && mapZoom.value < FACILITY_MIN_ZOOM && enabledFacilities.value.length > 0)

function zoomInForFacilities() {
  map?.easeTo({ zoom: FACILITY_MIN_ZOOM, duration: 300 })
}
const showModeMenu = ref(false)

function groupSelected(kinds: LayerKind[]) {
  return !allLayersSelected.value && kinds.every(kind => enabledLayers.value.includes(kind))
}

function toggleLayerGroup(kinds: LayerKind[]) {
  if (allLayersSelected.value) {
    enabledLayers.value = [...kinds]
    return
  }
  const next = groupSelected(kinds)
    ? enabledLayers.value.filter(kind => !kinds.includes(kind))
    : [...new Set([...enabledLayers.value, ...kinds])]
  enabledLayers.value = next.length ? next : [...allLayerKinds]
}

/* ---------- Screen flow & browser history ---------- */

/**
 * The microservice opens on the mode landing page. Choosing a mode pushes one history entry, so the
 * Back key from a mode's first screen returns to the landing page. The last choice is preselected.
 */
const appMode = ref<'landing' | AppMode>('landing')
const lastMode = ref<AppMode>('general')
// Indoor navigation overlay (components/IndoorOverlay.vue): opening pushes one history entry, closing goes back.
const indoorVenue = ref<string | null>(null)
function openIndoor(id: string) {
  history.pushState({ howgo: 'indoor' }, '')
  indoorVenue.value = id
}
const closeIndoor = () => history.back()
function enterMode(mode: AppMode) {
  try { localStorage.setItem('howgo-mode', mode) } catch {}
  lastMode.value = mode
  history.pushState({ howgo: 'mode' }, '')
  appMode.value = mode
}
/** Switching between modes keeps the same history entry. */
function switchMode(mode: AppMode) {
  try { localStorage.setItem('howgo-mode', mode) } catch {}
  lastMode.value = mode
  appMode.value = mode
}
const screen = ref<Screen>('explore')
const editingTarget = ref<Endpoint | null>(null)
const screenDepth: Record<Screen, number> = { explore: 0, preview: 1, search: 2, picker: 3, navigate: 2 }
let expectedPops = 0

/** Move to another screen, keeping the browser history depth in step so the hardware Back key works. */
function go(next: Screen) {
  const diff = screenDepth[next] - screenDepth[screen.value]
  for (let i = 0; i < diff; i++) history.pushState({ howgo: true }, '')
  if (diff < 0) {
    expectedPops++
    history.go(diff)
  }
  screen.value = next
}

/** In-app back buttons defer to the browser so both paths share handleBack(). */
function back() {
  if (screenDepth[screen.value] > 0) history.back()
}

function handleBack() {
  switch (screen.value) {
    case 'preview':
      leavePreview()
      screen.value = 'explore'
      break
    case 'search':
      cancelLocate()
      editingTarget.value = null
      screen.value = 'preview'
      break
    case 'picker':
      screen.value = 'search'
      break
    case 'navigate':
      history.pushState({ howgo: true }, '')
      endConfirm.value = true
      break
  }
}

function onPopState() {
  if (indoorVenue.value) { focusIndoorVenue(map, indoorVenue.value); indoorVenue.value = null; return }
  // Accessible mode handles its own history and emits `home` when popped past its first screen.
  if (appMode.value !== 'general') return
  if (expectedPops > 0) {
    expectedPops--
    return
  }
  if (screen.value === 'explore') {
    showModeMenu.value = false
    appMode.value = 'landing'
    return
  }
  handleBack()
}

/* ---------- Explore (Page 1) ---------- */

const browsePlace = shallowRef<Place | null>(null)
const browseDetails = shallowRef<FeatureDetail[]>([])
const exploreSearch = usePlaceSearch()
const exploreInput = useTemplateRef<HTMLInputElement>('exploreInput')
/** UI-005: the card shows the tapped item's category badge (same SVG as the map); plain places keep a pin. */
const browseLayerIcon = computed(() => layerIconFor(browseDetails.value[0]?.kind))
const browseLayerLabel = computed(() => layerGroups.find(group => group.icon === browseLayerIcon.value)?.label ?? '')

/** Google Maps search URL for the selected spot (its own coordinates, lat,lng). */
const googleMapsUrl = computed(() => {
  const point = browsePlace.value?.coordinates
  return point ? `https://www.google.com/maps/search/?api=1&query=${point[1].toFixed(6)},${point[0].toFixed(6)}` : undefined
})
function openInGoogleMaps(event: MouseEvent) {
  if (!googleMapsUrl.value) return
  event.preventDefault()
  openExternal(googleMapsUrl.value)
}

/** UI-003: clearing the selection removes the card so the map runs to the bottom edge again. */
function clearBrowsePlace() {
  setBrowsePlace(null)
}
const browseTags = computed(() => {
  const detail = browseDetails.value[0]
  if (!detail) return browsePlace.value?.address ? [browsePlace.value.address] : []
  return [detail.title, ...detail.lines.filter(line => !(line.startsWith('資料來源') || line.startsWith('Source:')))]
    .filter((tag, index, all) => tag && tag !== browsePlace.value?.name && all.indexOf(tag) === index)
})
const browseSource = computed(() => browseDetails.value[0]?.lines.find(line => line.startsWith('資料來源') || line.startsWith('Source:')) ?? '')

const recentPlaces = useRecentPlaces()

function chooseExplorePlace(place: Place) {
  // Page 1 search picks share the Page 2-1 recent list.
  recentPlaces.remember(place)
  exploreInput.value?.blur()
  exploreSearch.query.value = ''
  showLayers.value = false
  setBrowsePlace(place)
  focusPlaceOnMap(place.coordinates)
}

/**
 * UI-009: `marker` is the tapped map marker (point feature carrying a `uid`) when a facility, walkway
 * or slope was picked; it is drawn full-size on top while every other marker shrinks to a dot.
 * Non-facility picks (empty map, search results) have no marker and get the red location pin instead.
 */
const selectedMarker = shallowRef<Feature<Point> | null>(null)

function setBrowsePlace(place: Place | null, details: FeatureDetail[] = [], marker: Feature<Point> | null = null) {
  browsePlace.value = place
  browseDetails.value = details
  selectedMarker.value = place ? marker : null
  updatePins()
  applyMarkerSelection()
}

/** Explore-screen selection drives the marker styles; route screens always show full badges. */
function applyMarkerSelection() {
  if (!map || !mapReady.value) return
  const active = screen.value === 'explore' && !!browsePlace.value
  const uid = selectedMarker.value?.properties?.uid ?? null
  setSource('selected-marker', active && selectedMarker.value ? [selectedMarker.value] : [])
  const isSelected: ExpressionSpecification = ['==', ['get', 'uid'], uid ?? '']
  for (const [layer, image] of [['facilities', layerIconExpression], ['walkway-icons', layerImageId('pedestrian')],
    ['slope-markers', layerImageId('slope')]] as const) {
    map.setLayoutProperty(layer, 'icon-image', active ? layerDotExpression : image)
    // Dots are 12 CSS px at icon-size 1; the selected marker itself is drawn by `selected-marker` on top.
    map.setLayoutProperty(layer, 'icon-size', active ? 1 : LAYER_ICON_SIZE)
    map.setPaintProperty(layer, 'icon-opacity', active ? ['case', isSelected, 0, .55] : 1)
  }
}

/** Page 1 card arrow: selected place becomes the destination; origin is kept or taken from GPS. */
function openPreview() {
  const place = browsePlace.value
  if (!place || !mapReady.value) return
  showLayers.value = false
  showModeMenu.value = false
  go('preview')
  setEndpoint('end', place.coordinates, false, place.name)
  if (!endpoints.start) locate('start')
}

function leavePreview() {
  invalidateRoute()
  cancelLocate()
  error.value = ''
  failedEndpoint.value = null
  inspectionPopup?.remove()
}

/* ---------- Endpoints & location ---------- */

const endpoints = reactive<Record<Endpoint, Coordinate | null>>({ start: null, end: null })
const endpointNames = reactive<Record<Endpoint, string>>({ start: '', end: '' })
const fromGps = reactive<Record<Endpoint, boolean>>({ start: false, end: false })
const locating = ref(false)
const locationMessage = ref('')
const gpsPoint = shallowRef<Coordinate | null>(null)
let locationRequest = 0

const endpointLabel = (endpoint: Endpoint) => endpoint === 'start' ? t('起點') : t('終點')
const formatCoordinate = (point: Coordinate) => `${point[1].toFixed(5)}, ${point[0].toFixed(5)}`
const formatDistance = (meters: number) => meters >= 1000 ? t('{0} 公里', (meters / 1000).toFixed(1)) : t('{0} 公尺', Math.round(meters))

function endpointText(endpoint: Endpoint) {
  if (endpoints[endpoint]) return endpointNames[endpoint] || formatCoordinate(endpoints[endpoint]!)
  if (endpoint === 'start' && locating.value) return t('定位中…')
  return endpoint === 'start' && locationMessage.value ? t('尚未取得目前位置') : t('選擇{0}', endpointLabel(endpoint))
}

function setEndpoint(endpoint: Endpoint, point: Coordinate, fromLocation = false, name = '') {
  if (endpoint === 'start') cancelLocate()
  invalidateRoute()
  endpoints[endpoint] = point
  endpointNames[endpoint] = name
  fromGps[endpoint] = fromLocation
  inspectionPopup?.remove()
  error.value = ''
  failedEndpoint.value = null
  updatePins()
  if (endpoints.start && endpoints.end) void searchRoute()
}

function swapEndpoints() {
  if (busy.value) return
  cancelLocate()
  invalidateRoute()
  ;[endpoints.start, endpoints.end] = [endpoints.end, endpoints.start]
  ;[endpointNames.start, endpointNames.end] = [endpointNames.end, endpointNames.start]
  ;[fromGps.start, fromGps.end] = [fromGps.end, fromGps.start]
  error.value = ''
  failedEndpoint.value = null
  updatePins()
  if (endpoints.start && endpoints.end) void searchRoute()
}

function cancelLocate() {
  locationRequest++
  locating.value = false
}

/** Last drawn live point, so a heading change can redraw without a new fix. */
let livePoint: Coordinate | null = null
/** Compass heading in degrees clockwise from north, or null when the device reports none. */
let liveHeading: number | null = null

function drawLivePosition(point: Coordinate | null) {
  livePoint = point
  setSource('live-position', point ? [{
    type: 'Feature', geometry: { type: 'Point', coordinates: point },
    properties: liveHeading === null ? {} : { heading: liveHeading },
  }] : [])
}

/*
 * UI-019 heading: the device compass (absolute orientation; iOS reports webkitCompassHeading).
 * Fixes from the bridge / geolocation carry no heading, so the cone only appears where the
 * device exposes one. Redraws are limited to changes of at least 3 degrees.
 */
let headingListening = false
function onOrientation(event: DeviceOrientationEvent) {
  const compass = (event as DeviceOrientationEvent & { webkitCompassHeading?: number }).webkitCompassHeading
  const heading = typeof compass === 'number' ? compass
    : event.absolute && typeof event.alpha === 'number' ? (360 - event.alpha) % 360 : null
  if (heading === null) return
  if (liveHeading !== null && Math.abs(((heading - liveHeading + 540) % 360) - 180) < 3) return
  liveHeading = heading
  if (livePoint) drawLivePosition(livePoint)
}
function listenHeading(on: boolean) {
  if (on === headingListening || typeof window === 'undefined') return
  headingListening = on
  const type = 'ondeviceorientationabsolute' in window ? 'deviceorientationabsolute' : 'deviceorientation'
  if (on) window.addEventListener(type, onOrientation as EventListener)
  else {
    window.removeEventListener(type, onOrientation as EventListener)
    liveHeading = null
    if (livePoint) drawLivePosition(livePoint)
  }
}

/** White chevron drawn along the shown step, pointing the way to walk. */
function addNavArrowImage(target: MapLibreMap) {
  if (target.hasImage(NAV_ARROW_ID)) return
  const px = 28
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = px
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.strokeStyle = palette.white
  ctx.lineWidth = 4
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.beginPath()
  ctx.moveTo(10, 7)
  ctx.lineTo(18, 14)
  ctx.lineTo(10, 21)
  ctx.stroke()
  target.addImage(NAV_ARROW_ID, ctx.getImageData(0, 0, px, px), { pixelRatio: 2 })
}

/** Heading cone image: a 70 degree wedge pointing north, fading from 32% Primary / 700 at the centre to clear. */
function addLiveHeadingImage(target: MapLibreMap) {
  if (target.hasImage(LIVE_HEADING_ID)) return
  const px = LIVE_RADIUS_PX * 4
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = px
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const c = px / 2
  const [r, g, b] = [1, 3, 5].map(i => parseInt(LIVE_DOT_COLOR.slice(i, i + 2), 16))
  const gradient = ctx.createRadialGradient(c, c, 0, c, c, c)
  gradient.addColorStop(0, `rgba(${r},${g},${b},0.32)`)
  gradient.addColorStop(1, `rgba(${r},${g},${b},0)`)
  ctx.beginPath()
  ctx.moveTo(c, c)
  ctx.arc(c, c, c, -Math.PI / 2 - 35 * Math.PI / 180, -Math.PI / 2 + 35 * Math.PI / 180)
  ctx.closePath()
  ctx.fillStyle = gradient
  ctx.fill()
  target.addImage(LIVE_HEADING_ID, ctx.getImageData(0, 0, px, px), { pixelRatio: 2 })
}

/**
 * One-shot GPS. Never substitutes demo coordinates when permission is denied (spec §6.3).
 * `target` = endpoint to fill, or 'browse' to just centre the Page 1 map on the position.
 */
function locate(target: Endpoint | 'browse', onSuccess?: () => void) {
  if (locating.value) return
  locationMessage.value = ''
  if (!locationAvailable()) {
    locationMessage.value = window.isSecureContext
      ? t('瀏覽器不支援定位，請改用搜尋或在地圖上選擇。')
      : t('定位需要 HTTPS、localhost 或在 Town Pass App 內開啟，請改用搜尋或在地圖上選擇。')
    return
  }
  const request = ++locationRequest
  locating.value = true
  getFix().then((fix) => {
    if (request !== locationRequest) return
    locating.value = false
    const point: Coordinate = [fix.longitude, fix.latitude]
    const bounds = metadata.value?.coverage
    if (bounds && (point[0] < bounds[0] || point[0] > bounds[2] || point[1] < bounds[1] || point[1] > bounds[3])) {
      locationMessage.value = t('目前位置超出服務範圍（臺北市），請改用搜尋或在地圖上選擇。')
      return
    }
    gpsPoint.value = point
    if (screen.value !== 'navigate') drawLivePosition(point)
    if (target === 'browse') {
      // Spec §4.2: only move the map to the GPS position and show the dot; the selected place and card stay.
      map?.easeTo({ center: point, zoom: Math.max(map.getZoom(), 16), duration: 0 })
    } else {
      setEndpoint(target, point, true, t('目前位置'))
    }
    onSuccess?.()
  }, ({ code }: FixError) => {
    if (request !== locationRequest) return
    locating.value = false
    locationMessage.value = code === 1
      ? t('尚未取得目前位置：未允許定位或定位服務未開啟，可改用搜尋或在地圖上選擇。')
      : code === 3
        ? t('定位逾時，請重試或改用搜尋、在地圖上選擇。')
        : t('裝置目前無法提供位置，請改用搜尋或在地圖上選擇。')
  })
}

/* ---------- Location search (Page 2-1) & picker (Page 2-2) ---------- */

function editEndpoint(endpoint: Endpoint) {
  if (endpoint === 'start') cancelLocate()
  editingTarget.value = endpoint
  locationMessage.value = ''
  inspectionPopup?.remove()
  go('search')
}

function commitEndpoint(endpoint: Endpoint, point: Coordinate, fromLocation: boolean, name: string) {
  editingTarget.value = null
  go('preview')
  setEndpoint(endpoint, point, fromLocation, name)
}

function chooseSearchResult(place: Place) {
  if (editingTarget.value) commitEndpoint(editingTarget.value, place.coordinates, false, place.name)
}

function useLocationForTarget() {
  const target = editingTarget.value
  if (!target) return
  locate(target, () => {
    if (screen.value !== 'search') return
    editingTarget.value = null
    go('preview')
  })
}

const pickerPin = useTemplateRef<HTMLElement>('pickerPin')
const pickerLabel = ref('')

/** Map pixel under the pin tip (not the screen centre — header and footer take space). */
function pinPixel(): [number, number] | null {
  if (!pickerPin.value || !mapElement.value) return null
  const pin = pickerPin.value.getBoundingClientRect()
  const box = mapElement.value.getBoundingClientRect()
  return [pin.left + pin.width / 2 - box.left, pin.bottom - box.top]
}

function updatePickerLabel() {
  const pixel = pinPixel()
  if (!map || !pixel) return
  const hits = map.queryRenderedFeatures([[pixel[0] - 6, pixel[1] - 6], [pixel[0] + 6, pixel[1] + 6]], {
    layers: ['facilities', 'walkway-icons', 'walkways-fill', 'walkways-outline', 'crossings-osm'],
  })
  const hit = hits[0]?.properties
  const name = typeof hit?.name === 'string' ? hit.name.replace(/^\d+\s*[-_]\s*/, '').replace(/<br\s*\/?>/gi, ' ').trim() : ''
  pickerLabel.value = [name, hit?.label].filter(Boolean).join(' ')
}

async function openPicker() {
  const target = editingTarget.value
  if (!target) return
  go('picker')
  await nextTick()
  const pixel = pinPixel()
  const current = endpoints[target] ?? (target === 'end' ? endpoints.start : endpoints.end) ?? gpsPoint.value
  if (map && pixel) {
    if (current) {
      map.jumpTo({ zoom: Math.max(map.getZoom(), 17) })
      const projected = map.project(current)
      map.panBy([projected.x - pixel[0], projected.y - pixel[1]], { duration: 0 })
    }
    updatePickerLabel()
  }
}

function confirmPick() {
  const target = editingTarget.value
  const pixel = pinPixel()
  if (!map || !target || !pixel) return
  const { lng, lat } = map.unproject(pixel)
  const point: Coordinate = [lng, lat]
  commitEndpoint(target, point, false, pickerLabel.value || t('地圖選點 {0}', formatCoordinate(point)))
}

/* ---------- Route preview (Page 2) ---------- */

const error = ref('')
const failedEndpoint = ref<Endpoint | null>(null)
const busy = ref(false)
const result = shallowRef<RouteResult | null>(null)
const routeModes = [
  { key: 'fastest', label: '最快', title: '最快路線', icon: 'bolt',
    description: '以預估時間最短為優先，可能經過階梯或較窄的路段。' },
  { key: 'balanced', label: '平衡', title: '平衡路線', icon: 'balance',
    description: '避開已知不適合通行的人行道，可接受一段短階梯。' },
  { key: 'accessible', label: '輪椅', title: '輪椅友善路線', icon: 'accessible',
    description: '避開已知階梯與坡段，優先較寬的人行道。' },
] as const satisfies readonly { key: RouteMode; label: string; title: string; icon: IconName; description: string }[]
const routeOptions = shallowRef<Partial<Record<RouteMode, RouteOption>>>({})
const selectedMode = ref<RouteMode>('balanced')
const modeDetails = computed(() => routeModes.find(item => item.key === selectedMode.value)!)
const hasOptions = computed(() => Object.keys(routeOptions.value).length > 0)
const sheetLevel = ref(1)
const showDetails = ref(false)
type RouteFact = { text: string; icon: IconName; tone: 'neutral' | 'good' | 'warn' | 'alarm' }
const stairBadge = computed(() => {
  const facts = result.value?.assessment
  if (!facts) return null
  if (facts.stair_sections === null) return { text: t('階梯資料待確認'), tone: 'neutral' }
  return facts.stair_sections > 0 ? { text: t('含階梯・不適合輪椅'), tone: 'alarm' } : null
})
const routeFacts = computed<RouteFact[]>(() => {
  const facts = result.value?.assessment
  if (!facts) return []
  const rows: (RouteFact | false)[] = [
    facts.stair_sections === null ? { text: t('階梯資料待確認'), icon: 'stairs', tone: 'neutral' }
      : facts.stair_sections > 0
        ? { text: t('{0} 段階梯・約 {1}', facts.stair_sections, formatDistance(facts.stairs_m ?? 0)), icon: 'stairs', tone: 'alarm' }
        : { text: t('路網未標示階梯'), icon: 'check', tone: 'good' },
    facts.mapped_slope_sections > 0 && { text: t('{0} 處已知坡段', facts.mapped_slope_sections), icon: 'slope', tone: 'warn' },
    facts.comfortable_m > 0 && { text: t('可行人行道約 {0}', formatDistance(facts.comfortable_m)), icon: 'ruler', tone: 'good' },
    facts.limited_m > 0 && { text: t('勉強可行人行道約 {0}', formatDistance(facts.limited_m)), icon: 'ruler', tone: 'warn' },
    facts.blocked_m > 0 && { text: t('含過窄人行道約 {0}', formatDistance(facts.blocked_m)), icon: 'ruler', tone: 'alarm' },
  ]
  return rows.filter((row): row is RouteFact => Boolean(row))
})
const minutes = (seconds: number) => Math.max(1, Math.round(seconds / 60))
const plannedAt = ref(0)
const arrivalClock = computed(() => new Intl.DateTimeFormat(locale.value, { hour: '2-digit', minute: '2-digit', hour12: false }))
const estimatedArrival = computed(() => result.value && plannedAt.value
  ? arrivalClock.value.format(plannedAt.value + result.value.duration_s * 1000) : '')
const previewStatus = computed(() => {
  if (!endpoints.start && !endpoints.end) return t('請選擇起點與終點')
  if (!endpoints.start) return locating.value ? t('正在取得目前位置…') : t('請選擇起點')
  if (!endpoints.end) return t('請選擇終點')
  if (busy.value) return t('正在規劃路線…')
  return error.value
})
const startDisabledReason = computed(() => {
  if (!endpoints.start) return t('缺少起點')
  if (!endpoints.end) return t('缺少終點')
  if (busy.value) return t('規劃中…')
  if (!result.value) return t('沒有可用路線')
  if (!result.value.maneuvers?.length) return t('此路線沒有導航步驟')
  return ''
})

function invalidateRoute() {
  stopNavigation()
  routeRequest?.abort()
  routeRequest = undefined
  busy.value = false
  routeOptions.value = {}
  result.value = null
  for (const name of ['route', 'route-alternatives', 'route-access-points', 'unverified-walkways', 'selected-step', 'route-walked']) {
    setSource(name, [])
  }
  selectedStep.value = null
}

async function searchRoute(mode: RouteMode = selectedMode.value) {
  if (!endpoints.start || !endpoints.end) return
  invalidateRoute()
  const [ax, ay] = endpoints.start
  const [bx, by] = endpoints.end
  if (111195 * Math.hypot((bx - ax) * Math.cos(ay * Math.PI / 180), by - ay) < 10) {
    error.value = t('起點與終點太近，請重新確認。')
    return
  }
  const controller = new AbortController()
  routeRequest = controller
  error.value = ''
  failedEndpoint.value = null
  busy.value = true
  inspectionPopup?.remove()
  try {
    const { options } = await $fetch<{ options: Record<RouteMode, RouteOption> }>('/api/v1/route-options', {
      method: 'POST',
      body: { start: endpoints.start, end: endpoints.end },
      signal: controller.signal,
    })
    if (controller.signal.aborted) return
    plannedAt.value = Date.now()
    routeOptions.value = options
    sheetLevel.value = 1
    // Keep the chosen tab if it still has a route; otherwise fall back to the first available one (spec invariant 4).
    const usable = options[mode]?.route ? mode : routeModes.find(item => options[item.key]?.route)?.key ?? mode
    await selectMode(usable)
  } catch (failure) {
    if (controller.signal.aborted) return
    const detail = (failure as { data?: { detail?: { message?: string; endpoint?: Endpoint } } }).data?.detail
    failedEndpoint.value = detail?.endpoint ?? null
    error.value = localizeRouteError(detail) ?? t('目前沒有可預覽的路線，請稍後再試或調整起終點。')
  } finally {
    if (routeRequest === controller) {
      busy.value = false
      routeRequest = undefined
    }
  }
}

async function selectMode(mode: RouteMode) {
  selectedMode.value = mode
  const data = routeOptions.value[mode]?.route ?? null
  result.value = data
  selectedStep.value = null
  setSource('selected-step', [])
  inspectionPopup?.remove()
  setSource('route-alternatives', routeModes.flatMap(({ key }) => {
    const other = routeOptions.value[key]?.route
    return key !== mode && other ? [other.route] : []
  }))
  if (!data) {
    setSource('route', [])
    setSource('route-access-points', [])
    setSource('unverified-walkways', [])
    return
  }
  setSource('route', [data.route])
  setSource('route-access-points', (['start', 'end'] as const).flatMap(endpoint => {
    const access = data.access_points?.[endpoint]
    return access ? [{
      type: 'Feature' as const,
      geometry: { type: 'Point' as const, coordinates: access.coordinates },
      properties: { kind: 'route-access', label: t('{0}路網接點', endpointLabel(endpoint)), offset_m: access.offset_m },
    }] : []
  }))
  const routeTracker = tracker.value
  setSource('unverified-walkways', (data.unverified_walkways ?? []).flatMap((span) => {
    const coordinates = routeTracker?.slice(span.at_m, span.end_m)
    return coordinates?.length ? [{
      type: 'Feature' as const,
      geometry: { type: 'LineString' as const, coordinates },
      properties: { kind: 'unverified-walkway', label: t('路網步行通道'), source: 'OpenStreetMap' },
    }] : []
  }))
  await fitRoute(data)
}

async function fitRoute(data: RouteResult) {
  const { LngLatBounds } = await import('maplibre-gl')
  if (result.value !== data) return
  const bounds = new LngLatBounds()
  for (const point of data.route.geometry.coordinates) bounds.extend(point as Coordinate)
  if (data.access_points?.start && endpoints.start) bounds.extend(endpoints.start)
  if (data.access_points?.end && endpoints.end) bounds.extend(endpoints.end)
  const wide = window.innerWidth >= 900
  const padding = wide
    ? { top: 60, bottom: 60, left: 470, right: 60 }
    : { top: 170, bottom: Math.round(window.innerHeight * .5), left: 30, right: 30 }
  map?.fitBounds(bounds, {
    padding: window.innerHeight > padding.top + padding.bottom + 32 ? padding : 36, maxZoom: 17, duration: 0,
  })
}

function editFailedEndpoint(endpoint: Endpoint) {
  editEndpoint(endpoint)
}

/* ---------- Active navigation (Page 3) ---------- */

const navState = ref<'idle' | 'waiting' | 'active' | 'offroute' | 'arrived'>('idle')
const navMessage = ref('')
const progress = ref<number | null>(null)
const liveFix = shallowRef<Coordinate | null>(null)
const previewStep = ref<number | null>(null)
const endConfirm = ref(false)
const navNotice = ref('')
const bearing = ref(0)
const demoAvailable = ref(false)
const demoMode = ref(false)
const selectedStep = ref<number | null>(null)
let stopWatch: (() => void) | null = null
let navSession = 0
let missedFixes = 0
let lastFixTime = 0
let freshnessTimer: ReturnType<typeof setTimeout> | undefined
const tracker = computed(() => result.value ? createRouteTracker(result.value.route.geometry.coordinates) : null)
const navSteps = computed(() => result.value?.maneuvers ?? [])
const isTurn = (action: Maneuver['action']) => ['left', 'right', 'roundabout', 'uturn'].includes(action)
/** Actual progress (GPS / demo simulator). Swiping never changes this (spec §8.3). */
const currentStepIndex = computed(() => {
  const steps = navSteps.value
  if (!steps.length) return -1
  if (progress.value === null) return 0
  const index = steps.findIndex(row => row.end_m > progress.value! + 1 || (isTurn(row.action) && row.at_m >= progress.value! - 2))
  return index < 0 ? steps.length - 1 : index
})
const shownStepIndex = computed(() => previewStep.value ?? currentStepIndex.value)
const activeStepIndex = computed(() => {
  const steps = result.value?.steps ?? []
  if (!tracker.value || progress.value === null) return -1
  return steps.findIndex(step => tracker.value!.cumulative[step.to_index]! > progress.value! + 1)
})
const activeStep = computed(() => result.value?.steps?.[activeStepIndex.value])
const currentPassage = computed(() => progress.value === null ? undefined : result.value?.maneuvers?.find(
  row => (row.action === 'crossing' || row.action === 'stairs') && row.at_m - 2 <= progress.value! && row.end_m > progress.value!,
))
const nextManeuver = computed(() => progress.value === null ? undefined : result.value?.maneuvers?.find(
  row => row.action !== 'straight' && row.action !== 'advice'
    && (row.at_m >= progress.value! + 1
      || (['left', 'right'].includes(row.action) && row.at_m >= progress.value! - 2)),
))
const navigationTitle = computed(() => {
  if (currentPassage.value) return localizeRouteText(currentPassage.value.instruction)
  const next = nextManeuver.value
  if (!next || progress.value === null) return t('接近目的地')
  const remaining = next.at_m - progress.value
  if (remaining <= 2) return localizeRouteText(next.instruction)
  return t('約 {0} 後・{1}', formatDistance(remaining), localizeRouteText(next.instruction))
})
const liveGuidance = computed(() => {
  if (navState.value !== 'active' || !activeStep.value || !tracker.value || progress.value === null) return ''
  const step = activeStep.value
  const offset = progress.value - tracker.value.cumulative[step.from_index]!
  if (currentPassage.value) return (currentPassage.value.note ? localizeRouteText(currentPassage.value.note) : undefined)
    ?? (currentPassage.value.action === 'stairs' ? t('約 {0}', formatDistance(currentPassage.value.end_m - progress.value)) : t('請確認可通行後再通過。'))
  if (result.value?.unverified_walkways?.some(span => span.at_m <= progress.value! && progress.value! < span.end_m)) {
    return t('路網步行通道，輪椅通行條件未確認。')
  }
  if (nextManeuver.value?.action === 'sidewalk' && nextManeuver.value.at_m - progress.value <= 25) {
    return localizeRouteText(nextManeuver.value.note ?? '')
  }
  const ranges = step.guidance_ranges ?? (step.guidance ? [step.guidance] : [])
  const available = ranges.filter(range => offset >= range.from_m && (range.to_m === null || offset <= range.to_m))
  const physical = available.filter(range => range.reason === '實體人行道')
  const choices = physical.length ? physical : available
  const along = choices.find(range => range.side === 'along')
  if (along) return t('維持沿{0}前進。', t(along.reason))
  if (physical.some(range => range.side === 'left') && physical.some(range => range.side === 'right')) {
    return t('道路兩側有實體人行道，請維持目前可通行的一側。')
  }
  const guidance = choices[0]
  if (!guidance) return ''
  const side = guidance.side === 'left' ? t('左側') : t('右側')
  return t('若已在{0}，請維持{1}前進。該側有{2}。', side, side, t(guidance.reason))
})
const directionIcons: Record<Maneuver['action'], string> = {
  left: 'M18 20v-6a5 5 0 0 0-5-5H5m5-5L5 9l5 5',
  right: 'M6 20v-6a5 5 0 0 1 5-5h8m-5-5 5 5-5 5',
  straight: 'M12 20V4m-5 5 5-5 5 5',
  roundabout: 'M12 3a8 8 0 1 1-7 4m0-4v4h4',
  uturn: 'M19 20v-8a7 7 0 0 0-14 0v3m-3-3 3 3 3-3',
  arrive: 'M5 21V4m0 1 13-2v10L5 15',
  crossing: 'M4 20h16M4 15h16M4 10h16M4 5h16',
  sidewalk: 'M6 20V4m0 8h12m-4-4 4 4-4 4',
  stairs: 'M3 20h5v-5h5v-5h5V5h3',
  advice: 'M12 7h.01M12 11v6M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z',
}
const stepDistance = (row: Maneuver) => ['straight', 'crossing', 'stairs'].includes(row.action) && row.end_m > row.at_m
  ? ` ${formatDistance(row.end_m - row.at_m)}` : ''
const navCard = computed(() => {
  const preview = previewStep.value === null ? null : navSteps.value[previewStep.value]
  if (preview) {
    return { icon: preview.action, title: localizeRouteText(preview.instruction) + stepDistance(preview), detail: localizeRouteText(preview.note ?? '') }
  }
  if (navState.value === 'active') {
    return {
      icon: currentPassage.value?.action ?? nextManeuver.value?.action ?? 'arrive',
      title: navigationTitle.value,
      detail: liveGuidance.value || (activeStep.value ? t('目前路段・{0}', localizeRouteText(activeStep.value.instruction)) : ''),
    }
  }
  if (navState.value === 'arrived') return { icon: 'arrive' as const, title: navMessage.value, detail: '' }
  // Waiting / off-route: the step stays the headline; the GPS status goes to the status line (navStatusText).
  const first = navSteps.value[currentStepIndex.value]
  return {
    icon: first?.action ?? 'straight',
    title: first ? localizeRouteText(first.instruction) + stepDistance(first) : navMessage.value,
    detail: localizeRouteText(first?.note ?? ''),
  }
})
/**
 * Smaller status line under the badges while there is no usable live position.
 * UI-011: the "checking your position" message is covered by the badge alone, so it renders nothing.
 */
const navStatusText = computed(() => {
  if (navState.value !== 'waiting' && navState.value !== 'offroute') return ''
  return navMessage.value === t('正在確認你與路線的位置。') ? '' : navMessage.value
})
const remaining = computed(() => {
  if (!result.value || !tracker.value) return null
  const left = Math.max(0, tracker.value.total - (progress.value ?? 0))
  return { meters: left, minutes: minutes(result.value.duration_s * left / Math.max(1, tracker.value.total)) }
})
const stairWarningStep = computed(() => navSteps.value[shownStepIndex.value]?.action === 'stairs')

function stopNavigation() {
  navSession++
  stopWatch?.()
  stopWatch = null
  clearTimeout(freshnessTimer)
  navState.value = 'idle'
  navMessage.value = ''
  progress.value = null
  liveFix.value = null
  previewStep.value = null
  demoMode.value = false
  setSource('route-walked', [])
  drawLivePosition(gpsPoint.value)
}

function startNavigation() {
  if (!result.value?.maneuvers?.length || screen.value === 'navigate') return
  stopNavigation()
  const session = ++navSession
  missedFixes = 0
  lastFixTime = 0
  inspectionPopup?.remove()
  showLayers.value = false
  selectedStep.value = null
  navNotice.value = ''
  endConfirm.value = false
  setSource('selected-step', [])
  setSource('route-alternatives', [])
  go('navigate')
  navState.value = 'waiting'
  // UI-011: once the nav card is laid out, centre the first step in the visible map area.
  const zoom = Math.max(map?.getZoom() ?? 17, 17)
  void nextTick(() => { if (session === navSession) liveNavCamera(zoom) })
  if (!locationAvailable()) {
    navMessage.value = t('此環境無法取得定位，可左右滑動預覽步驟。')
    return
  }
  navMessage.value = t('正在取得導航位置…')
  stopWatch = watchFix(({ latitude, longitude, accuracy, timestamp }) => {
    const coords = { latitude, longitude, accuracy }
    if (session !== navSession || !tracker.value || timestamp <= lastFixTime) return
    lastFixTime = timestamp
    clearTimeout(freshnessTimer)
    freshnessTimer = setTimeout(() => {
      if (session !== navSession || navState.value === 'arrived') return
      navState.value = 'waiting'
      navMessage.value = t('定位暫時中斷，等待新的位置更新。')
    }, 30000)
    if (coords.accuracy > 45 || Date.now() - timestamp > 25000) {
      navState.value = 'waiting'
      navMessage.value = t('定位精度不足，正在等待較準確的位置。')
      return
    }
    const point: Coordinate = [coords.longitude, coords.latitude]
    liveFix.value = point
    drawLivePosition(point)
    const match = tracker.value.match(point, progress.value)
    if (match.distance > Math.max(24, coords.accuracy * 1.1)) {
      const startAccess = result.value?.access_points?.start
      if (progress.value === null && startAccess && endpoints.start) {
        const [lon, lat] = endpoints.start
        const distanceToSelection = 111195 * Math.hypot(
          (point[0] - lon) * Math.cos(lat * Math.PI / 180), point[1] - lat,
        )
        if (distanceToSelection <= startAccess.offset_m + 30) {
          navState.value = 'waiting'
          navMessage.value = t('請先前往地圖標示的起點路網接點。')
          return
        }
      }
      missedFixes++
      navState.value = missedFixes >= 2 ? 'offroute' : 'waiting'
      navMessage.value = missedFixes >= 2 ? t('目前位置偏離路線，可從此處重新規劃。') : t('正在確認你與路線的位置。')
      return
    }
    missedFixes = 0
    progress.value = Math.max(progress.value ?? 0, match.along)
    if (tracker.value.total - match.along < 12 && match.endDistance < 15 && coords.accuracy <= 25) {
      stopWatch?.()
      stopWatch = null
      clearTimeout(freshnessTimer)
      navSession++
      navState.value = 'arrived'
      const endAccess = result.value?.access_points?.end
      navMessage.value = endAccess
        ? t('已抵達路網接點，距目的地直線約 {0} 公尺。', endAccess.offset_m)
        : t('已抵達目的地附近。')
      return
    }
    navState.value = 'active'
    navMessage.value = ''
    if (previewStep.value === null && map) liveNavCamera(Math.max(map.getZoom(), 16))
  }, ({ code }: FixError) => {
    if (session !== navSession) return
    navState.value = 'waiting'
    if (code === 1) {
      stopWatch?.()
      stopWatch = null
      navMessage.value = t('未取得定位權限，目前只能預覽步驟。')
      return
    }
    navMessage.value = t('目前沒有可用的導航位置，正在等待定位。')
  })
}

/** Debug-only progress simulator (spec §8.4). Clearly labelled; stops real GPS so the two never mix. */
function demoAdvance() {
  const routeTracker = tracker.value
  if (!routeTracker || navState.value === 'arrived') return
  navSession++
  stopWatch?.()
  stopWatch = null
  clearTimeout(freshnessTimer)
  demoMode.value = true
  previewStep.value = null
  const now = progress.value ?? 0
  const next = navSteps.value.find(row => row.at_m > now + 1)
  const target = Math.min(routeTracker.total, next ? Math.min(next.at_m, now + 60) : now + 60)
  progress.value = target
  const point = routeTracker.pointAt(target) as Coordinate
  liveFix.value = point
  drawLivePosition(point)
  if (routeTracker.total - target < 1) {
    navState.value = 'arrived'
    navMessage.value = t('已抵達目的地附近（示範模擬）。')
  } else {
    navState.value = 'active'
    navMessage.value = ''
  }
  liveNavCamera()
}

async function replan() {
  if (!liveFix.value) return
  const point = liveFix.value
  editingTarget.value = null
  go('preview')
  setEndpoint('start', point, true, t('目前位置'))
}

function stepBy(delta: number) {
  const count = navSteps.value.length
  if (!count) return
  const next = Math.max(0, Math.min(count - 1, shownStepIndex.value + delta))
  previewStep.value = next === currentStepIndex.value ? null : next
}

function previewAt(index: number) {
  previewStep.value = index === currentStepIndex.value ? null : index
}

let swipe: { id: number; x: number; y: number } | null = null
function swipeStart(event: PointerEvent) {
  if (event.isPrimary) swipe = { id: event.pointerId, x: event.clientX, y: event.clientY }
}
function swipeEnd(event: PointerEvent) {
  if (!swipe || swipe.id !== event.pointerId) return
  const dx = event.clientX - swipe.x
  const dy = event.clientY - swipe.y
  swipe = null
  if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy) * 1.5) stepBy(dx < 0 ? 1 : -1)
}

function swipeCancel() {
  swipe = null
}

/** Page 2 step list: highlight one manoeuvre on the map (tap again to clear). */
function toggleRouteStep(row: Maneuver, index: number) {
  selectedStep.value = selectedStep.value === index ? null : index
  highlightManeuver(selectedStep.value === null ? undefined : row)
  if (selectedStep.value !== null) map?.panTo(row.position, { duration: 0 })
}

/** Route-distance range (metres) a manoeuvre's card covers: turns ±8 m around the turn, other steps start→end. */
const maneuverRange = (maneuver: Maneuver): [number, number] => isTurn(maneuver.action)
  ? [maneuver.at_m - 8, maneuver.at_m + 8] : [maneuver.at_m, Math.max(maneuver.at_m, maneuver.end_m)]

function highlightManeuver(maneuver: Maneuver | undefined) {
  if (!maneuver) {
    setSource('selected-step', [])
    return
  }
  const coordinates = tracker.value?.slice(...maneuverRange(maneuver))
  setSource('selected-step', coordinates?.length ? [{
    type: 'Feature', geometry: { type: 'LineString', coordinates }, properties: {},
  }] : [])
}

/* ---------- UI-011 navigation camera ---------- */

const navPanelEl = ref<HTMLElement | null>(null)

/** Height of the top safe area (env() can't be read directly, so measure a probe). */
function safeTopInset() {
  const probe = document.createElement('div')
  probe.style.cssText = 'position:fixed;top:0;visibility:hidden;pointer-events:none;height:var(--safe-top)'
  document.body.append(probe)
  const height = probe.getBoundingClientRect().height
  probe.remove()
  return height
}

/**
 * easeTo offset that puts the camera target at the centre of the map area that is actually visible:
 * below the top inset and above the bottom nav card (or right of it when the card floats on the left).
 */
function navViewOffset(): [number, number] {
  const container = map?.getContainer()
  if (!container) return [0, 0]
  const box = container.getBoundingClientRect()
  const panel = navPanelEl.value?.getBoundingClientRect()
  const top = safeTopInset()
  let bottom = 0
  let left = 0
  if (panel && panel.height) {
    if (panel.width >= box.width * 0.6) bottom = Math.max(0, box.bottom - panel.top)
    else left = Math.max(0, panel.right - box.left)
  }
  const x = left + (box.width - left) / 2
  const y = top + Math.max(0, box.height - top - bottom) / 2
  return [Math.round(x - box.width / 2), Math.round(y - box.height / 2)]
}

/**
 * Frame the shown step in the map area that is actually visible (below the top inset, above the nav
 * card), so its whole line, chevrons and end ring are on screen. Zoom stays between street and
 * block level so short steps don't jump to building scale.
 */
function centerOnStep(maneuver: Maneuver | undefined) {
  if (!map || !maneuver) return
  const line = navStepLine(maneuver)
  if (line.length < 2) return
  const container = map.getContainer().getBoundingClientRect()
  const panel = navPanelEl.value?.getBoundingClientRect()
  const [offsetX] = navViewOffset()
  const top = safeTopInset() + 72
  const bottom = panel && panel.width >= container.width * 0.6 ? Math.max(0, container.bottom - panel.top) + 28 : 28
  const left = Math.max(36, offsetX * 2 + 36)
  let [minX, minY, maxX, maxY] = [Infinity, Infinity, -Infinity, -Infinity]
  for (const [x, y] of line) {
    minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y)
  }
  if (container.height - top - bottom < 80) {
    map.easeTo({ center: [(minX + maxX) / 2, (minY + maxY) / 2], offset: navViewOffset(), duration: 0 })
    return
  }
  map.fitBounds([[minX, minY], [maxX, maxY]], {
    padding: { top, bottom, left, right: 36 }, maxZoom: 18.2, duration: 350,
  })
}

/** Live navigation camera: the live position when there is one, otherwise the current step. */
function liveNavCamera(zoom?: number) {
  if (!map) return
  // No `zoom` key unless asked: MapLibre checks `'zoom' in options`.
  if (liveFix.value) map.easeTo({ center: liveFix.value, offset: navViewOffset(), duration: 0, ...(zoom === undefined ? {} : { zoom }) })
  else {
    if (zoom !== undefined) map.jumpTo({ zoom })
    centerOnStep(navSteps.value[currentStepIndex.value])
  }
}

watch(previewStep, async (index) => {
  if (screen.value !== 'navigate') return
  const maneuver = index === null ? undefined : navSteps.value[index]
  await nextTick() // the card height (and so the visible area) follows the new step
  if (screen.value !== 'navigate' || previewStep.value !== index) return
  if (index === null) liveNavCamera()
  else centerOnStep(maneuver)
})

watch(progress, (value) => {
  const coordinates = value && tracker.value ? tracker.value.slice(0, value) : []
  setSource('route-walked', coordinates.length ? [{
    type: 'Feature', geometry: { type: 'LineString', coordinates }, properties: {},
  }] : [])
})

function requestEnd() {
  if (navState.value === 'arrived') {
    endNavigation()
    return
  }
  endConfirm.value = true
}

/** Confirmed end: back to Page 2 with endpoints and the selected route kept. */
function endNavigation() {
  endConfirm.value = false
  stopNavigation()
  highlightManeuver(undefined)
  go('preview')
  void selectMode(selectedMode.value)
}

/** UI-007: north up again; only the bearing changes, so centre and zoom stay put. */
function resetNorth() {
  map?.easeTo({ bearing: 0, duration: 300 })
}

/* UI-007 step-progress dots: keep the active (yellow) dot scrolled into view. */
const stepDotsEl = ref<HTMLElement | null>(null)
watch([shownStepIndex, () => navSteps.value.length, screen], async () => {
  await nextTick()
  const row = stepDotsEl.value
  const dot = row?.querySelector<HTMLElement>('[data-active="true"]')
  if (!row || !dot) return
  const left = dot.offsetLeft - (row.clientWidth - dot.offsetWidth) / 2
  row.scrollTo({ left: Math.max(0, left), behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
})

/* ---------- Map ---------- */

const metadata = shallowRef<Metadata | null>(null)
let map: MapLibreMap | undefined
let mapImportCancelled = false
let facilitiesRequest: AbortController | undefined
let walkwaysRequest: AbortController | undefined
let slopesRequest: AbortController | undefined
let visibleWalkways: Walkway[] = []
let routeRequest: AbortController | undefined
let resizeObserver: ResizeObserver | undefined
let visibleFacilities: Facilities = { type: 'FeatureCollection', features: [] }
let visibleSlopes: Feature[] = []
let inspectionPopup: MapLibrePopup | undefined

function setSource(name: string, features: Feature[]) {
  map?.getSource<GeoJSONSource>(name)?.setData({ type: 'FeatureCollection', features })
}

/** Route-related layers. Hidden (not cleared) on the picker so returning to preview restores them as-is. */
const routeLayerIds = [
  'route-sidewalk-fill', 'route-sidewalk-outline', 'guided-sidewalk-fill', 'guided-sidewalk-outline',
  'route-alternatives', 'route-outline', 'route', 'route-walked', 'unverified-walkways', 'selected-step',
  'route-access-points', 'route-ramps', 'route-slope-markers',
]

function applyRouteLayerState() {
  if (!map || !mapReady.value) return
  const picking = screen.value === 'picker'
  for (const id of routeLayerIds) map.setLayoutProperty(id, 'visibility', picking ? 'none' : 'visible')
  // Walkway areas the route passes are dimmed under the route's own sidewalk highlight; the
  // along-route facility icons (UI-006) stay at full strength. Everything is full while picking.
  const dim = !!result.value && !picking
  map.setPaintProperty('walkways-fill', 'fill-opacity', dim ? .11 : ['case', ['==', ['get', 'kind'], '13'], .5, .32])
  map.setPaintProperty('walkways-outline', 'line-opacity', dim ? .36 : .86)
}

/* ---------- Route view layer filter (UI-006) ---------- */

/**
 * Route view = the route screens except the point picker (which shows the normal map to pick on).
 * Entering it saves the explore layer filter and shows every category, but only items the selected
 * route passes; leaving it restores the saved filter.
 */
const routeView = computed(() => screen.value !== 'explore' && screen.value !== 'picker')
let savedLayers: LayerKind[] | null = null
watch(routeView, (inRoute) => {
  if (inRoute) {
    savedLayers ??= [...enabledLayers.value]
    enabledLayers.value = [...allLayerKinds]
  } else if (savedLayers) {
    enabledLayers.value = savedLayers
    savedLayers = null
  }
  redrawLayerData()
})

/**
 * The route planner only associates sidewalks, ramps and slopes with a route (`highlights`); other
 * facilities have no association data, so they are matched by distance to the selected route line.
 * Points within 15 m count (facilities sit beside the walked path); walkway areas count when the
 * route runs through them or within 3 m of their edge.
 */
const ROUTE_POINT_BUFFER_M = 15
const ROUTE_AREA_BUFFER_M = 3
let routeMatchers: { route: RouteResult; point: ReturnType<typeof routePasses>; area: ReturnType<typeof routePasses> } | null = null

/** null = no filtering (map browsing); otherwise a predicate per geometry, or "nothing" when no route yet. */
function routeFilter(): ((feature: Feature) => boolean) | null {
  if (!routeView.value) return null
  const route = result.value
  if (!route) return () => false
  if (routeMatchers?.route !== route) {
    const line = route.route.geometry.coordinates
    routeMatchers = { route, point: routePasses(line, ROUTE_POINT_BUFFER_M), area: routePasses(line, ROUTE_AREA_BUFFER_M) }
  }
  const { point, area } = routeMatchers
  return feature => feature.geometry?.type === 'Point' ? point(feature.geometry) : area(feature.geometry)
}

/**
 * Planner ramps / slopes and the distance-matched facility or slope points of the same category
 * almost always mark the same spot. Measured against /v1/route-options on 6 Taipei routes, all
 * 337 planner ramps had the identical facility record underneath, and 13 of 15 planner slopes had
 * a slope point within 12 m. So in route view there is one badge per location: the planner badge
 * stays (it carries the route context and halo), and same-category points within MERGE_M are not
 * drawn separately. Their data is kept on the badge (`merge_id`) so a tap shows both.
 */
const MERGE_M = 12
type PlannerBadge = { mergeId: string; id: Feature['id']; icon: LayerIconName; coordinates: Coordinate }
let plannerBadges: PlannerBadge[] = []
const mergedFacilities = new Map<string, Feature[]>()
const mergedSlopes = new Map<string, Feature[]>()

function plannerHighlights(route: RouteResult | null): Feature[] {
  plannerBadges = []
  return (route?.highlights?.features ?? []).map((feature, index) => {
    const context = feature.properties.route_context
    if (feature.geometry.type !== 'Point' || (context !== 'ramp' && context !== 'slope')) return feature
    const mergeId = `h${index}`
    plannerBadges.push({ mergeId, id: feature.id, icon: context === 'ramp' ? 'entrance-ramp' : 'slope',
      coordinates: feature.geometry.coordinates as Coordinate })
    return { ...feature, properties: { ...feature.properties, merge_id: mergeId } }
  })
}

/** Drops points that a same-category planner badge already marks, remembering them on that badge. */
function mergeIntoPlanner<F extends Feature>(features: F[], into: Map<string, Feature[]>): F[] {
  into.clear()
  if (!routeView.value || !plannerBadges.length) return features
  return features.filter((feature) => {
    if (feature.geometry?.type !== 'Point') return true
    const icon = layerIconFor(String(feature.properties?.kind ?? ''))
    const point = feature.geometry.coordinates
    const badge = plannerBadges.find(item => item.icon === icon && distanceM(item.coordinates, point) <= MERGE_M)
    if (!badge) return true
    // The planner ramp is often the very same facility record; only distinct records add information.
    if (feature.id === undefined || feature.id !== badge.id) into.set(badge.mergeId, [...into.get(badge.mergeId) ?? [], feature])
    return false
  })
}

/** Tapped planner badges expand to the facility / slope records merged into them. */
function withMerged(hits: MapGeoJSONFeature[]): MapGeoJSONFeature[] {
  return hits.flatMap((hit) => {
    const id = hit.properties.merge_id
    if (typeof id !== 'string') return [hit]
    const extra = [...mergedFacilities.get(id) ?? [], ...mergedSlopes.get(id) ?? []]
    return [hit, ...extra.map(feature => ({ ...feature, properties: feature.properties ?? {} }) as unknown as MapGeoJSONFeature)]
  })
}

/**
 * UI-009: every marker carries a `uid` (source + feature id) so the selected one can be told apart
 * from the rest in layer expressions; a walkway polygon and its badge point share the same uid.
 */
function withUid<F extends Feature>(features: F[], prefix: string): F[] {
  return features.map(feature => feature.properties?.uid ? feature : {
    ...feature, properties: { ...feature.properties, uid: `${prefix}:${feature.id ?? JSON.stringify(feature.geometry)}` },
  })
}

/** What each marker layer currently draws, for the UI-019 step focus. */
let drawnFacilities: Feature[] = []
let drawnWalkways: Feature[] = []
let drawnSlopes: Feature[] = []

function drawFacilities(features: Facility[]) {
  const passes = routeFilter()
  drawnFacilities = withUid(mergeIntoPlanner(passes ? features.filter(passes) : features, mergedFacilities), 'f')
  setSource('facilities', drawnFacilities)
}

let walkwayIcons: Feature<Point>[] = []
function drawWalkways(features: Walkway[]) {
  const passes = routeFilter()
  const shown = withUid(passes ? features.filter(passes) : features, 'w')
  walkwayIcons = iconPoints(shown)
  drawnWalkways = shown
  setSource('walkways', shown)
  setSource('walkway-icons', walkwayIcons)
}

function drawSlopes(features: Feature[]) {
  const passes = routeFilter()
  drawnSlopes = mergeIntoPlanner(passes ? features.filter(passes) : features, mergedSlopes)
  setSource('slopes', drawnSlopes)
}

/** Re-applies the route filter to the cached data after the route or the screen changes. */
function redrawLayerData() {
  if (!mapReady.value) return
  const types = enabledFacilities.value
  drawFacilities(visibleFacilities.features.filter(item => types.includes(item.properties.kind)))
  drawWalkways(visibleWalkways)
  drawSlopes(showSlopes.value ? visibleSlopes : [])
  if (navFocusActive) applyNavStepFocus()
}

watch(result, (route) => {
  setSource('route-highlights', plannerHighlights(route))
  applyRouteLayerState()
  redrawLayerData()
})

watch(screen, (value) => {
  inspectionPopup?.remove()
  showLayers.value = false
  showModeMenu.value = false
  if (value !== 'navigate') endConfirm.value = false
  updatePins()
  applyRouteLayerState()
  applyMarkerSelection()
  listenHeading(value === 'navigate')
})

/* ---------- UI-019 navigation step focus ---------- */

/** Route-distance range drawn for a step while navigating: turns include their approach and exit. */
function navStepRange(maneuver: Maneuver): [number, number] {
  const total = tracker.value?.total ?? 0
  if (isTurn(maneuver.action)) return [Math.max(0, maneuver.at_m - NAV_TURN_APPROACH_M), Math.min(total, maneuver.at_m + NAV_TURN_EXIT_M)]
  const end = Math.min(total, Math.max(maneuver.at_m + 1, maneuver.end_m))
  // Short steps (a crossing, a few stairs) would be a stub under their own badge; show 20 m either side.
  if (end - maneuver.at_m < NAV_SHORT_STEP_M) return [Math.max(0, maneuver.at_m - 20), Math.min(total, end + 20)]
  return [maneuver.at_m, end]
}
function navStepLine(maneuver: Maneuver): Coordinate[] {
  return (tracker.value?.slice(...navStepRange(maneuver)) ?? []) as Coordinate[]
}

/**
 * While navigating, the shown step (live progress, or the swiped-to preview) is drawn in Primary / 500
 * at full strength and the rest of the route at 35%. Markers within the step's reach keep their full
 * badge; every other marker along the route becomes its category dot at 55%. Planner ramp / slope
 * badges (the route's attached icons) only appear for the shown step.
 */
let navFocusActive = false
const fullMarkerImages = [['facilities', layerIconExpression], ['walkway-icons', layerImageId('pedestrian')],
  ['slope-markers', layerImageId('slope')]] as const
const plannerMarkerLayers = [['route-ramps', 'ramp'], ['route-slope-markers', 'slope']] as const

function applyNavStepFocus() {
  if (!map || !mapReady.value) return
  const step = screen.value === 'navigate' ? navSteps.value[shownStepIndex.value] : undefined
  const line = step ? navStepLine(step) : []
  if (!step || line.length < 2) {
    if (!navFocusActive) return
    navFocusActive = false
    setSource('selected-step', [])
    setSource('nav-step-end', [])
    map.setPaintProperty('selected-step', 'line-color', palette.orange500)
    map.setPaintProperty('selected-step', 'line-width', 7)
    map.setPaintProperty('selected-step-casing', 'line-opacity', 0)
    for (const id of ['route', 'route-walked']) map.setPaintProperty(id, 'line-opacity', 1)
    map.setPaintProperty('route-outline', 'line-color', routeColors.casing)
    map.setPaintProperty('route-outline', 'line-opacity', 1)
    for (const id of NAV_HIDDEN_LAYERS) map.setLayoutProperty(id, 'visibility', 'visible')
    for (const [id, context] of plannerMarkerLayers) map.setFilter(id, ['==', ['get', 'route_context'], context])
    applyRouteLayerState()
    applyMarkerSelection()
    return
  }
  navFocusActive = true
  /*
   * Hierarchy, strongest first: the shown step (Primary / 500 on a Primary / 700 casing, white chevrons
   * pointing the way, a ring where the step ends), then the rest of the route as a pale 35% line on a
   * white casing, then the map. Planning-only layers are hidden.
   */
  setSource('selected-step', [{ type: 'Feature', geometry: { type: 'LineString', coordinates: line }, properties: { nav: true } }])
  setSource('nav-step-end', [{ type: 'Feature', geometry: { type: 'Point', coordinates: line.at(-1)! }, properties: {} }])
  map.setPaintProperty('selected-step', 'line-color', palette.primary500)
  map.setPaintProperty('selected-step', 'line-width', 8)
  map.setPaintProperty('selected-step-casing', 'line-opacity', 1)
  for (const id of ['route', 'route-walked']) map.setPaintProperty(id, 'line-opacity', NAV_OTHER_ROUTE_OPACITY)
  map.setPaintProperty('route-outline', 'line-color', palette.white)
  map.setPaintProperty('route-outline', 'line-opacity', 1)
  for (const id of NAV_HIDDEN_LAYERS) map.setLayoutProperty(id, 'visibility', 'none')

  const nearPoint = routePasses(line, ROUTE_POINT_BUFFER_M)
  const nearArea = routePasses(line, ROUTE_AREA_BUFFER_M)
  const uids = new Set<string>()
  for (const feature of [...drawnFacilities, ...drawnSlopes]) {
    const uid = feature.properties?.uid
    if (typeof uid === 'string' && nearPoint(feature.geometry)) uids.add(uid)
  }
  for (const feature of drawnWalkways) {
    const uid = feature.properties?.uid
    if (typeof uid === 'string' && nearArea(feature.geometry)) uids.add(uid)
  }
  const onStep: ExpressionSpecification = ['in', ['get', 'uid'], ['literal', [...uids]]]
  for (const [layer, image] of fullMarkerImages) {
    map.setLayoutProperty(layer, 'icon-image', ['case', onStep, image, layerDotExpression])
    map.setLayoutProperty(layer, 'icon-size', ['case', onStep, LAYER_ICON_SIZE, .8])
    map.setPaintProperty(layer, 'icon-opacity', ['case', onStep, 1, NAV_OFF_STEP_DOT_OPACITY])
  }
  const badgeIds = plannerBadges.filter(badge => nearPoint({ type: 'Point', coordinates: badge.coordinates }))
    .map(badge => badge.mergeId)
  for (const [id, context] of plannerMarkerLayers) {
    map.setFilter(id, ['all', ['==', ['get', 'route_context'], context], ['in', ['get', 'merge_id'], ['literal', badgeIds]]])
  }
}

watch([screen, shownStepIndex, result], () => applyNavStepFocus())

/** Facility ids are strings, which MapLibre drops from rendered features; match on the `uid` instead. */
function facilityPosition(hit: MapGeoJSONFeature): Coordinate {
  const source = visibleFacilities.features.find(item => `f:${item.id}` === hit.properties.uid)
  return (source?.geometry.coordinates ?? (hit.geometry as Point).coordinates) as Coordinate
}

/** The badge point for a tapped marker: the point itself, or the badge of a tapped walkway area / slope line. */
function markerFor(hit: MapGeoJSONFeature): Feature<Point> | null {
  const uid = hit.properties.uid
  if (typeof uid !== 'string') return null
  const point = hit.geometry.type === 'Point'
    ? { type: 'Feature' as const, geometry: { type: 'Point' as const, coordinates: hit.layer.id === 'facilities' ? facilityPosition(hit) : hit.geometry.coordinates }, properties: hit.properties }
    : walkwayIcons.find(item => item.properties?.uid === uid)
      ?? visibleSlopes.find((item): item is Feature<Point> => item.geometry.type === 'Point' && item.properties?.uid === uid)
  return point ?? null
}

function updatePins() {
  const routing = screen.value !== 'explore'
  if (!routing) {
    // UI-009: on the map page only non-facility picks get a pin (map-selected-location); facilities
    // are marked by their own full badge instead.
    const coordinates = !selectedMarker.value ? browsePlace.value?.coordinates : null
    setSource('pins', coordinates ? [{
      type: 'Feature', geometry: { type: 'Point', coordinates }, properties: { endpoint: 'selected' },
    }] : [])
    return
  }
  setSource('pins', (['start', 'end'] as const).flatMap((endpoint) => {
    if (screen.value === 'picker' && endpoint === editingTarget.value) return []
    const coordinates = endpoints[endpoint]
    return coordinates ? [{
      type: 'Feature' as const,
      geometry: { type: 'Point' as const, coordinates },
      properties: { endpoint, current: fromGps[endpoint] },
    }] : []
  }))
}

function focusPlaceOnMap(point: Coordinate) {
  if (!map) return
  const aboveCard = window.innerWidth < 900 ? -Math.round(window.innerHeight * .1) : 0
  map.easeTo({ center: point, zoom: Math.max(map.getZoom(), 16), offset: [0, aboveCard], duration: 0 })
}

async function refreshFacilities() {
  const bounds = map?.getBounds()
  if (!bounds || !mapReady.value) return
  facilitiesRequest?.abort()
  const types = enabledFacilities.value
  drawFacilities(visibleFacilities.features.filter(item => types.includes(item.properties.kind)))
  facilityMessage.value = ''
  if (!types.length || map!.getZoom() < FACILITY_MIN_ZOOM) return
  const controller = new AbortController()
  facilitiesRequest = controller
  const bbox = [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()]
  try {
    const data = await $fetch<Facilities>('/api/v1/facilities', {
      query: { bbox: bbox.join(','), types },
      signal: controller.signal,
    })
    if (controller.signal.aborted) return
    visibleFacilities = data
    drawFacilities(data.features)
    facilityMessage.value = data.truncated ? t('請放大地圖查看其餘設施。') : ''
  } catch {
    if (controller.signal.aborted) return
    facilityMessage.value = t('設施資料暫時無法載入。')
  }
}

async function refreshWalkways() {
  if (!map || !mapReady.value) return
  walkwaysRequest?.abort()
  const controller = new AbortController()
  walkwaysRequest = controller
  const zoom = map.getZoom()
  const types = zoom < WALKWAY_MIN_ZOOM ? []
    : enabledWalkways.value.filter(kind => !['11', '12'].includes(kind) || zoom >= SIDEWALK_MIN_ZOOM)
  walkwayMessage.value = types.length < enabledWalkways.value.length ? t('放大地圖可查看人行道等通行空間。') : ''
  visibleWalkways = visibleWalkways.filter(item => types.includes(item.properties.kind))
  drawWalkways(visibleWalkways)
  if (!types.length) return

  const bounds = map.getBounds()
  const bbox = [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()].join(',')
  try {
    const data = await $fetch<Walkways>('/api/v1/walkways', {
      query: { bbox, types },
      signal: controller.signal,
    })
    if (controller.signal.aborted) return
    visibleWalkways = data.features
    drawWalkways(visibleWalkways)
    if (data.truncated) walkwayMessage.value = t('放大地圖可查看其餘通行空間。')
  } catch {
    if (controller.signal.aborted) return
    visibleWalkways = []
    drawWalkways([])
    walkwayMessage.value = t('通行空間圖層暫時無法載入。')
  }
}

const showSlopes = computed(() => enabledLayers.value.includes('slope'))

async function refreshSlopes() {
  if (!map || !mapReady.value) return
  slopesRequest?.abort()
  if (!showSlopes.value || map.getZoom() < 14) {
    drawSlopes([])
    return
  }
  const controller = new AbortController()
  slopesRequest = controller
  const bounds = map.getBounds()
  const bbox = [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()].join(',')
  try {
    const data = await $fetch<FeatureCollection<SlopeFeature['geometry'], SlopeFeature['properties']>>('/api/v1/slopes', {
      query: { bbox }, signal: controller.signal,
    })
    if (controller.signal.aborted) return
    // UI-004: slope sections keep their line and get one category icon at the line's midpoint.
    visibleSlopes = data.features.flatMap<Feature>((item) => {
      // The line and its midpoint badge share one uid (UI-009 selection).
      const properties = { ...item.properties, kind: 'slope', uid: `s:${item.id ?? JSON.stringify(item.geometry.coordinates)}` }
      if (item.geometry.type === 'Point') {
        return [{ ...item, properties: { ...properties, label: t('坡度點位') } }]
      }
      return [
        { ...item, properties },
        ...iconPoints([{ ...item, geometry: item.geometry, properties: { ...properties, label: t('坡段') } }]),
      ]
    })
    drawSlopes(visibleSlopes)
  } catch {
    if (controller.signal.aborted) return
    visibleSlopes = []
    drawSlopes([])
  }
}

watch(showSlopes, () => {
  inspectionPopup?.remove()
  void refreshSlopes()
})

watch(enabledWalkways, () => {
  inspectionPopup?.remove()
  void refreshWalkways()
})

watch(enabledFacilities, () => {
  inspectionPopup?.remove()
  void refreshFacilities()
})

function describeHits(hits: MapGeoJSONFeature[]): FeatureDetail[] {
  const features: FeatureDetail[] = []
  const slopeLabels: Record<string, string> = { up: t('上坡'), down: t('下坡'), 'up/down': t('有高低差'), steep: t('陡坡'), yes: t('有坡度') }
  const gradeLabels: Record<string, string> = { comfortable: t('可行'), limited: t('勉強可行'), blocked: t('不可行') }
  const shown = new Set<string>()
  for (const { properties } of hits) {
    const { kind, name, label, source, width, slope, offset_m, incline, route_context, side, guided, grade } = properties
    const title = route_context === 'sidewalk' || route_context === 'guided-sidewalk' ? String(label)
      : route_context === 'ramp' ? guided ? t('指引側無障礙坡道') : t('鄰近無障礙坡道')
      : kind === '13' ? t('行人穿越道') : kind === '11' ? t('實體人行道') : String(label)
    const displayName = typeof name === 'string'
      ? name.replace(/^\d+\s*[-_]\s*/, '').replace(/<br\s*\/?>/gi, '\n').trim()
      : ''
    // Width/slope come from the source data. Missing values stay hidden rather than invented (spec §11).
    const lines = [
      typeof width === 'number' && width > 0 ? t('寬度（來源數值） {0}', width) : '',
      // UI-014: the backend's own grade, shown as-is (the map colour falls back for unknown values, the card does not).
      typeof grade === 'string' && grade ? t('通行評估 {0}', gradeLabels[grade] ?? grade) : '',
      typeof slope === 'number' ? t('坡度 {0}%', slope)
        : typeof incline === 'string' ? slopeLabels[incline] ?? t('坡度 {0}', incline) : '',
      kind === 'slope' && guided ? t('指引側人行道附近的坡度點') : '',
      side ? t('行進方向{0}', t(String(side))) : '',
      !guided && (route_context === 'slope' || route_context === 'ramp') ? t('位於路線附近，接點通行條件待確認') : '',
      source ? t('資料來源 {0}', t(String(source))) : kind === '13' ? t('資料來源 臺北市交通局') : '',
      kind === 'unverified-walkway' ? t('輪椅通行條件未確認') : '',
      kind === 'route-access' ? t('距原選點直線約 {0} 公尺', offset_m) : '',
    ].filter(Boolean)
    const key = JSON.stringify([kind, displayName, ...lines])
    if (shown.has(key)) continue
    shown.add(key)
    features.push({ kind, title, name: displayName, lines })
  }
  return features
}

onMounted(async () => {
  window.addEventListener('popstate', onPopState)
  try {
    const saved = localStorage.getItem('howgo-mode')
    if (saved === 'general' || saved === 'accessible') lastMode.value = saved
  } catch {}
  demoAvailable.value = import.meta.dev || new URLSearchParams(location.search).has('demo')
  // Deep link ?indoor=<venue>: open on the general map with the overlay on top, so Back lands on the map.
  const indoorLink = new URLSearchParams(location.search).get('indoor')
  if (indoorLink) {
    const url = new URL(location.href)
    url.searchParams.delete('indoor')
    history.replaceState(history.state, '', url)
    enterMode('general')
    openIndoor(indoorLink)
  }
  try {
    const [{ Map, AttributionControl, NavigationControl, Popup }, basemap] = await Promise.all([
      import('maplibre-gl'),
      loadBasemap('light', config.public.tileUrl),
    ])
    if (!mapElement.value || mapImportCancelled) return
    // Data layers sit between the basemap's shapes and its labels, so street names stay on top.
    const baseShapes = basemap.layers.filter(layer => layer.type !== 'symbol')
    const baseLabels = basemap.layers.filter(layer => layer.type === 'symbol')
    const emptySource = () => ({ type: 'geojson' as const, data: { type: 'FeatureCollection' as const, features: [] } })
    map = new Map({
      container: mapElement.value,
      center: [121.548, 25.04],
      zoom: FACILITY_MIN_ZOOM,
      minZoom: 11,
      maxBounds: TAIPEI_BOUNDS,
      renderWorldCopies: false,
      attributionControl: false,
      localIdeographFontFamily: LOCAL_CJK_FONT,
      style: {
        version: 8,
        glyphs: basemap.glyphs,
        sprite: basemap.sprite,
        sources: {
          ...basemap.sources,
          slopes: emptySource(),
          walkways: emptySource(),
          facilities: { type: 'geojson', data: visibleFacilities },
          'route-highlights': emptySource(),
          'route-alternatives': emptySource(),
          route: emptySource(),
          'route-walked': emptySource(),
          'route-access-points': emptySource(),
          'unverified-walkways': emptySource(),
          'selected-step': emptySource(),
          'nav-step-end': emptySource(),
          'live-position': emptySource(),
          pins: emptySource(),
          'walkway-icons': emptySource(),
          'selected-marker': emptySource(),
        },
        layers: [
          { id: 'background', type: 'background', paint: { 'background-color': palette.grey50 } },
          ...baseShapes,
          { id: 'walkways-fill', source: 'walkways', type: 'fill', minzoom: WALKWAY_MIN_ZOOM,
            filter: ['==', ['geometry-type'], 'Polygon'],
            paint: { 'fill-color': walkwayColor, 'fill-opacity': ['case', ['==', ['get', 'kind'], '13'], 0.5, 0.32] } },
          { id: 'walkways-outline', source: 'walkways', type: 'line', minzoom: WALKWAY_MIN_ZOOM,
            filter: ['==', ['geometry-type'], 'Polygon'],
            paint: { 'line-color': walkwayColor, 'line-width': ['case', ['==', ['get', 'kind'], '13'], 2.5, 1.5],
              'line-opacity': 0.86 } },
          ...baseLabels,
          { id: 'route-sidewalk-fill', source: 'route-highlights', type: 'fill',
            filter: ['==', ['get', 'route_context'], 'sidewalk'],
            paint: { 'fill-color': routeColors.sidewalk, 'fill-opacity': .5 } },
          { id: 'route-sidewalk-outline', source: 'route-highlights', type: 'line',
            filter: ['==', ['get', 'route_context'], 'sidewalk'], layout: { 'line-join': 'round' },
            paint: { 'line-color': routeColors.sidewalk, 'line-opacity': .7,
              'line-width': ['interpolate', ['linear'], ['zoom'], 14, 13, 17, 9, 20, 2] } },
          { id: 'guided-sidewalk-fill', source: 'route-highlights', type: 'fill',
            filter: ['==', ['get', 'route_context'], 'guided-sidewalk'],
            paint: { 'fill-color': routeColors.guidedSidewalk, 'fill-opacity': .36 } },
          { id: 'guided-sidewalk-outline', source: 'route-highlights', type: 'line',
            filter: ['==', ['get', 'route_context'], 'guided-sidewalk'], layout: { 'line-join': 'round' },
            paint: { 'line-color': routeColors.guidedOutline, 'line-width': 2, 'line-dasharray': [2, 1] } },
          { id: 'route-alternatives', source: 'route-alternatives', type: 'line',
            layout: { 'line-join': 'round', 'line-cap': 'round' },
            paint: { 'line-color': routeColors.alternative, 'line-width': 4, 'line-opacity': .65, 'line-dasharray': [1.6, 1.2] } },
          { id: 'route-outline', source: 'route', type: 'line', layout: { 'line-join': 'round', 'line-cap': 'round' },
            paint: { 'line-color': routeColors.casing, 'line-width': 9 } },
          { id: 'route', source: 'route', type: 'line', layout: { 'line-join': 'round', 'line-cap': 'round' },
            paint: { 'line-color': routeColors.route, 'line-width': 5.5 } },
          { id: 'route-walked', source: 'route-walked', type: 'line', layout: { 'line-join': 'round', 'line-cap': 'round' },
            paint: { 'line-color': routeColors.walked, 'line-width': 7 } },
          { id: 'unverified-walkways', source: 'unverified-walkways', type: 'line',
            paint: { 'line-color': palette.secondary500, 'line-width': 5, 'line-dasharray': [2, 1.3] } },
          { id: 'crossings-osm', source: 'walkways', type: 'line', minzoom: WALKWAY_MIN_ZOOM,
            filter: ['==', ['get', 'kind'], 'osm-crossing'],
            paint: { 'line-color': palette.primary600, 'line-dasharray': [1.5, 1],
              'line-width': ['interpolate', ['linear'], ['zoom'], 12, 2, 17, 4.5] } },
          // UI-019 step casing (navigation only; transparent while planning).
          { id: 'selected-step-casing', source: 'selected-step', type: 'line',
            layout: { 'line-join': 'round', 'line-cap': 'round' },
            paint: { 'line-color': palette.primary700, 'line-width': 12, 'line-opacity': 0 } },
          { id: 'selected-step', source: 'selected-step', type: 'line',
            layout: { 'line-join': 'round', 'line-cap': 'round' },
            paint: { 'line-color': palette.orange500, 'line-width': 7 } },
          { id: 'selected-step-arrows', source: 'selected-step', type: 'symbol',
            filter: ['==', ['get', 'nav'], true],
            layout: { 'symbol-placement': 'line', 'symbol-spacing': 56, 'icon-image': NAV_ARROW_ID,
              'icon-allow-overlap': true, 'icon-ignore-placement': true, 'icon-rotation-alignment': 'map' } },
          { id: 'selected-step-end', source: 'nav-step-end', type: 'circle', paint: {
            'circle-radius': 6, 'circle-color': palette.white, 'circle-stroke-color': palette.primary700, 'circle-stroke-width': 3,
          } },
          { id: 'route-access-points', source: 'route-access-points', type: 'circle', paint: {
            'circle-color': palette.white, 'circle-radius': 6, 'circle-stroke-color': routeColors.casing, 'circle-stroke-width': 3,
          } },
          { id: 'slope-lines', source: 'slopes', type: 'line', filter: ['==', ['geometry-type'], 'LineString'],
            paint: { 'line-color': SLOPE_COLOR, 'line-width': 3, 'line-dasharray': [1.5, 1] } },
          // UI-004 category badges. Walkway areas / OSM crossings get one badge at a representative
          // point (thinned by collision); facility and slope points always show theirs.
          { id: 'walkway-icons', source: 'walkway-icons', type: 'symbol', minzoom: WALKWAY_MIN_ZOOM,
            layout: { 'icon-image': layerImageId('pedestrian'), 'icon-size': LAYER_ICON_SIZE, 'icon-padding': 4 } },
          { id: 'slope-markers', source: 'slopes', type: 'symbol', filter: ['==', ['geometry-type'], 'Point'],
            layout: { 'icon-image': layerImageId('slope'), 'icon-size': LAYER_ICON_SIZE, 'icon-allow-overlap': true } },
          { id: 'facilities', source: 'facilities', type: 'symbol', minzoom: FACILITY_MIN_ZOOM,
            layout: { 'icon-image': layerIconExpression, 'icon-size': LAYER_ICON_SIZE, 'icon-allow-overlap': true } },
          // UI-009: the selected marker's full badge, above every other marker.
          { id: 'selected-marker', source: 'selected-marker', type: 'symbol',
            layout: { 'icon-image': layerIconExpression, 'icon-size': LAYER_ICON_SIZE, 'icon-allow-overlap': true,
              'icon-ignore-placement': true } },
          // Planner-associated ramps / slopes along the route (UI-006) use the same category badges.
          { id: 'route-ramps', source: 'route-highlights', minzoom: 14, type: 'symbol',
            filter: ['==', ['get', 'route_context'], 'ramp'],
            layout: { 'icon-image': layerImageId('entrance-ramp'), 'icon-size': .8, 'icon-padding': 1 } },
          { id: 'route-slope-markers', source: 'route-highlights', minzoom: 14, type: 'symbol',
            filter: ['==', ['get', 'route_context'], 'slope'],
            layout: { 'icon-image': layerImageId('slope'), 'icon-size': .9, 'icon-padding': 1 } },
          // UI-019 live position (disc, heading cone, dot on top); start pin = teal ring with centre dot
          // (matches the endpoint card marker); destination = filled orange.
          { id: 'live-position-halo', source: 'live-position', type: 'circle',
            paint: { 'circle-radius': LIVE_RADIUS_PX, 'circle-color': LIVE_DISC_COLOR, 'circle-opacity': .28,
              'circle-stroke-color': LIVE_DISC_COLOR, 'circle-stroke-width': 1, 'circle-stroke-opacity': .8 } },
          { id: 'live-heading', source: 'live-position', type: 'symbol', filter: ['has', 'heading'],
            layout: { 'icon-image': LIVE_HEADING_ID, 'icon-rotate': ['get', 'heading'], 'icon-rotation-alignment': 'map',
              'icon-allow-overlap': true, 'icon-ignore-placement': true } },
          { id: 'live-position', source: 'live-position', type: 'circle',
            paint: { 'circle-radius': 7, 'circle-color': LIVE_DOT_COLOR, 'circle-stroke-color': palette.white, 'circle-stroke-width': 2 } },
          { id: 'pins', source: 'pins', type: 'circle', filter: ['==', ['get', 'endpoint'], 'start'], paint: {
            'circle-color': ['match', ['get', 'endpoint'], 'start', palette.white, palette.orange500],
            'circle-radius': 9,
            'circle-stroke-color': ['match', ['get', 'endpoint'], 'start', palette.primary700, palette.white],
            'circle-stroke-width': ['match', ['get', 'endpoint'], 'start', 4, 3],
          } },
          { id: 'pins-centre', source: 'pins', type: 'circle', filter: ['==', ['get', 'endpoint'], 'start'],
            paint: { 'circle-radius': 3.5, 'circle-color': palette.primary700 } },
          // Route destination: the map-pin artwork, its location dot on the destination.
          { id: 'destination-pin', source: 'pins', type: 'symbol', filter: ['==', ['get', 'endpoint'], 'end'],
            layout: { 'icon-image': DESTINATION_PIN_ID, 'icon-anchor': 'bottom', 'icon-offset': DESTINATION_PIN_OFFSET,
              'icon-allow-overlap': true, 'icon-ignore-placement': true } },
          // UI-009: red location pin (map-selected-location) for non-facility picks on the map page.
          { id: 'selected-location', source: 'pins', type: 'symbol', filter: ['==', ['get', 'endpoint'], 'selected'],
            layout: { 'icon-image': SELECTED_PIN_ID, 'icon-anchor': 'bottom', 'icon-allow-overlap': true,
              'icon-ignore-placement': true } },
        ],
      },
    })
    map.addControl(new NavigationControl({ showCompass: false }), 'top-right')
    map.addControl(new AttributionControl({ compact: true }), 'top-left')
    map.once('load', () => mapElement.value && collapseAttribution(mapElement.value))
    resizeObserver = new ResizeObserver(() => map?.resize())
    resizeObserver.observe(mapElement.value)
    map.on('error', () => { mapMessage.value = t('部分地圖內容暫時無法載入。') })
    map.on('rotate', () => { bearing.value = map?.getBearing() ?? 0 })
    map.on('load', () => {
      if (map) void addIndoorVenueMarkers(map, { onOpen: openIndoor, visible: () => appMode.value === 'general' })
      if (map) void addLayerIcons(map, config.app.cdnURL || config.app.baseURL)
      if (map) void addDestinationPin(map, config.app.cdnURL || config.app.baseURL)
      if (map) addSelectionImages(map)
      if (map) addLiveHeadingImage(map)
      if (map) addNavArrowImage(map)
      // UI-009: indoor-map buildings get a violet footprint highlight below the data layers and markers.
      if (map) void addIndoorBuildingOutlines(map, 'route-sidewalk-fill')
      mapReady.value = true
      mapZoom.value = map?.getZoom() ?? mapZoom.value
      applyRouteLayerState()
      updatePins()
      void refreshFacilities()
      void refreshWalkways()
      void refreshSlopes()
    })
    map.on('moveend', () => {
      mapZoom.value = map?.getZoom() ?? mapZoom.value
      if (!mapReady.value) return
      if (screen.value === 'picker') updatePickerLabel()
      void refreshFacilities()
      void refreshWalkways()
      void refreshSlopes()
    })
    map.on('click', (event) => {
      if (!mapReady.value || !map) return
      if (screen.value !== 'explore' && screen.value !== 'preview') return
      inspectionPopup?.remove()
      const hits = map.queryRenderedFeatures([
        [event.point.x - 4, event.point.y - 4], [event.point.x + 4, event.point.y + 4],
      ], { layers: ['route-slope-markers', 'route-ramps', 'route-sidewalk-fill', 'guided-sidewalk-fill', 'slope-markers', 'slope-lines',
        'route-access-points', 'crossings-osm', 'unverified-walkways', 'selected-marker', 'facilities', 'walkway-icons',
        'walkways-fill', 'walkways-outline'] })
      const clicked: Coordinate = [event.lngLat.lng, event.lngLat.lat]
      if (screen.value === 'explore') {
        showLayers.value = false
        showModeMenu.value = false
        // Tapping the selected marker (or the red location pin) again closes the card.
        const selectedUid = selectedMarker.value?.properties?.uid
        const tappedSelected = browsePlace.value && (selectedUid
          ? hits.some(item => item.properties.uid === selectedUid)
          : map.queryRenderedFeatures(event.point, { layers: ['selected-location'] }).length > 0)
        if (tappedSelected) {
          clearBrowsePlace()
          return
        }
        if (!hits.length) {
          setBrowsePlace({ name: t('地圖選取位置'), address: formatCoordinate(clicked), coordinates: clicked, is_road: false })
          return
        }
        const parking = hits.find(item => item.properties.kind === 'accessible-parking' && item.geometry.type === 'Point')
        const features = describeHits(parking ? [parking, ...hits] : hits)
        const hit = parking ?? hits[0]!
        const detail = features[0]!
        // Long walkway geometries use the tapped point, not the geometry start (spec §4.4).
        const coordinates = hit.geometry.type === 'Point'
          ? parking ? facilityPosition(parking) : hit.geometry.coordinates as Coordinate
          : clicked
        setBrowsePlace({ name: detail.name || detail.title, address: '', coordinates, is_road: false }, features, markerFor(hit))
        return
      }
      if (!hits.length) return
      const content = document.createElement('div')
      content.className = 'map-inspection'
      for (const feature of describeHits(withMerged(hits))) {
        const entry = document.createElement('div')
        entry.className = 'map-inspection-entry'
        const heading = document.createElement('strong')
        heading.textContent = feature.title
        entry.append(heading)
        const lines = [feature.name === feature.title ? '' : feature.name, ...feature.lines].filter(Boolean)
        if (lines.length) {
          const detail = document.createElement('p')
          detail.textContent = lines.join('\n')
          entry.append(detail)
        }
        content.append(entry)
      }
      inspectionPopup = new Popup({ offset: 10 }).setLngLat(event.lngLat).setDOMContent(content).addTo(map)
    })
    void $fetch<Metadata>('/api/v1/meta').then(data => { metadata.value = data }).catch(() => {})
  } catch {
    mapMessage.value = t('無法開啟互動地圖，請使用支援 WebGL 的瀏覽器。')
  }
})

onBeforeUnmount(() => {
  window.removeEventListener('popstate', onPopState)
  stopNavigation()
  mapImportCancelled = true
  locationRequest++
  facilitiesRequest?.abort()
  walkwaysRequest?.abort()
  slopesRequest?.abort()
  routeRequest?.abort()
  resizeObserver?.disconnect()
  inspectionPopup?.remove()
  map?.remove()
})
</script>

<template>
  <ModeLanding v-if="appMode === 'landing'" :initial="lastMode" @choose="enterMode" />
  <AccessibleMode v-else-if="appMode === 'accessible'" @exit="switchMode('general')" @home="appMode = 'landing'" />
  <main class="map-app" :data-screen="screen" :inert="appMode !== 'general'">
    <div ref="mapElement" class="map" :aria-label="t('臺北市無障礙設施地圖')" />

    <!-- ============ Page 1 無障礙地圖 ============ -->
    <template v-if="screen === 'explore'">
      <header class="top-bar">
        <div class="top-row">
          <form class="search-pill" role="search"
            @submit.prevent="exploreSearch.results.value[0] && chooseExplorePlace(exploreSearch.results.value[0])">
            <AppIcon name="search" class="search-pill-icon" />
            <input ref="exploreInput" v-model="exploreSearch.query.value" type="search" enterkeyhint="search"
              maxlength="80" autocomplete="off" :aria-label="t('搜尋地點或地址')" :placeholder="t('搜尋地點或地址')"
              @focus="showLayers = false; showModeMenu = false"
              @keydown.esc.prevent="exploreSearch.query.value = ''">
          </form>
          <button type="button" class="mode-pill" :aria-expanded="showModeMenu" aria-controls="mode-menu"
            @click="showModeMenu = !showModeMenu; showLayers = false">
            <!-- UI-017: public/icons/display-mode/switch.svg, inlined so it follows currentColor (Primary/500) -->
            <span class="mode-badge"><svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><g fill="currentColor"
              stroke="currentColor" stroke-width="0.8" stroke-linejoin="round"><path id="mode-switch-arc"
              d="M3 13.5c.3-4.6 3.9-8.2 8.8-8.3V2.7l6 4.3-6 4.3V8.9c-3.7 0-7.2 1.5-8.8 4.6Z" /><use href="#mode-switch-arc"
              transform="rotate(180 12 12)" /></g></svg></span>{{ t('一般') }}
          </button>
        </div>

        <div v-if="exploreSearch.query.value.trim().length >= 2" class="floating-panel">
          <p v-if="exploreSearch.status.value" class="hint search-status" role="status">{{ exploreSearch.status.value }}</p>
          <ul v-if="exploreSearch.results.value.length" class="place-list" :aria-label="t('搜尋結果')">
            <li v-for="(place, index) in exploreSearch.results.value" :key="index">
              <button type="button" @click="chooseExplorePlace(place)">
                <AppIcon name="pin" class="place-list-icon" />
                <span>
                  <strong>{{ place.name }}</strong>
                  <small v-if="place.address">{{ place.address }}</small>
                  <small v-else-if="place.is_road">{{ t('道路參考點') }}</small>
                </span>
              </button>
            </li>
          </ul>
        </div>

        <section v-if="showModeMenu" id="mode-menu" class="floating-panel mode-menu" :aria-label="t('顯示模式')">
          <h2>{{ t('顯示模式') }}</h2>
          <button type="button" class="mode-option" aria-pressed="true" @click="showModeMenu = false">
            <span><strong>{{ t('一般模式') }}</strong><small>{{ t('目前使用中') }}</small></span><AppIcon name="check" />
          </button>
          <button type="button" class="mode-option" aria-pressed="false" @click="showModeMenu = false; switchMode('accessible')">
            <span><strong>{{ t('友善模式') }}</strong><small>{{ t('高對比大字、大圖示導航、固定輪椅路線') }}</small></span>
          </button>
        </section>

        <section v-if="showLayers" id="map-layer-settings" class="floating-panel layer-settings" :aria-label="t('圖層設定')">
          <div class="panel-heading">
            <h2>{{ t('圖層') }}</h2>
            <button type="button" class="text-button" @click="showLayers = false">{{ t('完成') }}</button>
          </div>
          <div class="chip-row" role="group" :aria-label="t('快速篩選')">
            <button type="button" class="chip" :aria-pressed="allLayersSelected"
              @click="enabledLayers = [...allLayerKinds]">{{ t('全部') }}</button>
            <button v-for="group in layerGroups" :key="group.label" type="button" class="chip"
              :aria-pressed="groupSelected(group.kinds)" @click="toggleLayerGroup(group.kinds)">
              <LayerIcon :name="group.icon" />{{ t(group.label) }}
            </button>
          </div>
          <p v-if="facilitiesHiddenByZoom" class="hint" role="status">{{ t('放大地圖可查看設施點位。') }}</p>
          <p v-if="walkwayMessage" class="hint" role="status">{{ walkwayMessage }}</p>
          <p v-if="facilityMessage" class="hint" role="status">{{ facilityMessage }}</p>
        </section>

        <button v-if="facilitiesHiddenByZoom && !showLayers && !showModeMenu && exploreSearch.query.value.trim().length < 2"
          type="button" class="zoom-hint" @click="zoomInForFacilities">
          <AppIcon name="search" :size="16" />{{ t('放大地圖以顯示無障礙設施') }}
        </button>
        <p v-if="mapMessage" class="notice" role="status">{{ mapMessage }}</p>
        <p v-if="locationMessage" class="notice" role="status">{{ locationMessage }}</p>
      </header>

      <div class="fab-stack explore-fabs">
        <button type="button" class="fab" :aria-label="t('圖層')" :aria-expanded="showLayers" aria-controls="map-layer-settings"
          @click="showLayers = !showLayers; showModeMenu = false">
          <AppIcon name="layers" :size="24" />
        </button>
        <button type="button" class="fab" :aria-label="locating ? t('定位中') : t('移到目前位置')" :disabled="!mapReady || locating"
          @click="locate('browse')">
          <AppIcon name="locate" :size="24" />
        </button>
      </div>

      <!-- UI-003: the card only exists while a place or facility is selected. -->
      <!-- UI-020: no close button; the title takes its space. Escape inside the card still clears the selection. -->
      <section v-if="browsePlace" class="place-card" :aria-label="t('選取的地點')" aria-live="polite"
        @keydown.esc.prevent="clearBrowsePlace">
        <LayerIcon v-if="browseLayerIcon" class="place-badge" :name="browseLayerIcon" :size="52" :label="browseLayerLabel" />
        <span v-else class="place-icon"><AppIcon name="pin" :size="26" /></span>
        <div class="place-body">
          <div class="place-title-row">
            <!-- Title + pin icon (public/icons/place-card/primary_icon_others.svg) open the spot in Google Maps. -->
            <h2>
              <a class="place-map-link" :href="googleMapsUrl" target="_blank" rel="noopener"
                :aria-label="t('{0}，在 Google 地圖開啟', browsePlace.name)" @click="openInGoogleMaps">
                {{ browsePlace.name }}<svg class="place-map-icon" viewBox="0 0 24 24" width="18" height="18" fill="none"
                  aria-hidden="true"><path stroke="currentColor" stroke-width="2" d="M12 4C15.866 4 19 7.13401 19 11C19 16.0159
                  13.8819 19.0342 12.3984 19.8037C12.1456 19.9349 11.8544 19.9349 11.6016 19.8037C10.1181 19.0342 5 16.0159 5
                  11C5 7.13401 8.13401 4 12 4ZM12 8C10.3431 8 9 9.34315 9 11C9 12.6569 10.3431 14 12 14C13.6569 14 15 12.6569
                  15 11C15 9.34315 13.6569 8 12 8Z" /></svg>
              </a>
            </h2>
          </div>
          <ul v-if="browseTags.length" class="tag-list">
            <li v-for="tag in browseTags" :key="tag">{{ t(tag) }}</li>
          </ul>
          <small v-if="browseSource">{{ t(browseSource) }}</small>
          <details v-if="browseDetails.length > 1" class="nearby-details">
            <summary>{{ t('同處其他圖資（{0}）', browseDetails.length - 1) }}</summary>
            <ul>
              <li v-for="(detail, index) in browseDetails.slice(1)" :key="index">
                <strong>{{ t(detail.title) }}</strong><small>{{ [detail.name, ...detail.lines].filter(Boolean).join('・') }}</small>
              </li>
            </ul>
          </details>
        </div>
        <button type="button" class="go-button" :disabled="!mapReady" :aria-label="t('設為終點並預覽路線')" @click="openPreview">
          <AppIcon name="directions" :size="28" />
        </button>
      </section>
    </template>

    <!-- ============ Page 2 導航路線預覽 ============ -->
    <template v-if="screen === 'preview'">
      <header class="endpoint-card">
        <button type="button" class="icon-button" :aria-label="t('返回地圖')" @click="back"><AppIcon name="back" /></button>
        <div class="endpoint-rows">
          <button v-for="endpoint in (['start', 'end'] as const)" :key="endpoint" type="button" class="endpoint-row"
            :disabled="!mapReady" @click="editEndpoint(endpoint)">
            <i :class="endpoint" aria-hidden="true" />
            <small>{{ endpointLabel(endpoint) }}</small>
            <strong :class="{ placeholder: !endpoints[endpoint] }">{{ endpointText(endpoint) }}</strong>
          </button>
        </div>
        <button type="button" class="swap-button" :aria-label="t('交換起點與終點')"
          :disabled="busy || (!endpoints.start && !endpoints.end)" @click="swapEndpoints">
          <AppIcon name="swap" :size="24" />
        </button>
      </header>

      <MapSheet v-model="sheetLevel" :fit="!showDetails">
        <template #summary>
          <div v-if="hasOptions" class="route-tabs" role="tablist" :aria-label="t('路線方式')">
            <button v-for="mode in routeModes" :key="mode.key" type="button" role="tab"
              :aria-selected="selectedMode === mode.key" @click="selectMode(mode.key)">
              <!-- UI-010 icons: public/icons/route-tabs/{fastest,balanced,wheelchair}.svg, inlined for currentColor -->
              <svg class="tab-icon" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
                <path v-if="mode.key === 'fastest'" fill="currentColor" d="M14.6 1 3 14h7l-1.6 9L21 10h-7l1.4-9z" />
                <g v-else-if="mode.key === 'balanced'" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M12 2.5v18m-8 0h16M3 5h18M5.5 5 2 13h7L5.5 5Zm13 0L15 13h7l-3.5-8Z" />
                  <path d="M2 13c.2 2.8 6.8 2.8 7 0m6 0c.2 2.8 6.8 2.8 7 0" />
                </g>
                <template v-else>
                  <circle cx="11" cy="3" r="2.1" fill="currentColor" />
                  <path fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"
                    d="M10.7 7 12 13.6h5l2.1 5.9h2.1M11.4 10H17M7.8 10.5a5.5 5.5 0 1 0 6.5 7.9" />
                </template>
              </svg>
              <span class="tab-label">{{ t(mode.label) }}</span>
              <span class="tab-time">{{ routeOptions[mode.key]?.route
                ? t('{0}分', minutes(routeOptions[mode.key]!.route!.duration_s)) : t('無') }}</span>
            </button>
          </div>
          <div v-else class="sheet-status" role="status">
            <strong>{{ previewStatus || t('尚無路線') }}</strong>
            <small v-if="locationMessage">{{ locationMessage }}</small>
            <button v-if="failedEndpoint" type="button" class="text-button"
              @click="editFailedEndpoint(failedEndpoint)">{{ t('重選{0}', endpointLabel(failedEndpoint)) }}</button>
          </div>
        </template>

        <section v-if="hasOptions" class="route-overview" aria-live="polite">
          <div class="overview-title">
            <h2>{{ t(modeDetails.title) }}</h2>
            <span v-if="stairBadge" class="badge" :data-tone="stairBadge.tone">{{ stairBadge.text }}</span>
          </div>
          <template v-if="result">
            <p class="overview-time"><strong>{{ t('{0} 分鐘', minutes(result.duration_s)) }}</strong>
              <span>{{ t('（{0}・預計抵達 {1}）', formatDistance(result.distance_m), estimatedArrival) }}</span></p>
            <p class="overview-description">{{ t(modeDetails.description) }}</p>
            <ul v-if="routeFacts.length" class="fact-list">
              <li v-for="fact in routeFacts" :key="fact.text" :data-tone="fact.tone">
                <AppIcon :name="fact.icon" :size="15" />{{ fact.text }}
              </li>
            </ul>

            <button type="button" class="text-button details-toggle" :aria-expanded="showDetails"
              @click="showDetails = !showDetails; if (showDetails) sheetLevel = 2">
              {{ showDetails ? t('收合路線細節') : t('查看路線細節與步驟') }}
            </button>
            <div v-if="showDetails" class="route-details">
              <p v-if="result.access_points?.start" class="hint">{{ t('起點路網接點距原起點直線約 {0} 公尺。', result.access_points.start.offset_m) }}</p>
              <p v-if="result.access_points?.end" class="hint">{{ t('路線到空心圓為止，距原目的地直線約 {0} 公尺，接點到目的地的通行條件待確認。', result.access_points.end.offset_m) }}</p>
              <p v-if="result.unverified_walkways?.length" class="hint">{{ t('黃色虛線為路網步行通道，輪椅通行條件未確認。') }}</p>
              <ul class="route-key" :aria-label="t('路線圖例')">
                <template v-for="item in routeKey" :key="item.context">
                  <li v-if="item.context === 'route' || result.highlights?.features.some(feature => feature.properties.route_context === item.context)">
                    <i :style="{ backgroundColor: item.color }" :class="item.context" aria-hidden="true" />{{ t(item.label) }}
                  </li>
                </template>
              </ul>
              <ol v-if="result.maneuvers?.length" class="route-steps">
                <li v-for="(row, index) in result.maneuvers" :key="index">
                  <button type="button" :aria-pressed="selectedStep === index" @click="toggleRouteStep(row, index)">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
                      stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                      <path :d="directionIcons[row.action]" />
                    </svg>
                    <span>
                      <strong>{{ localizeRouteText(row.instruction) }}{{ stepDistance(row) }}</strong>
                      <span v-if="row.note" class="step-note">{{ localizeRouteText(row.note) }}</span>
                      <span v-if="row.action === 'straight' && result.unverified_walkways?.some(
                        span => Math.min(span.end_m, row.end_m) - Math.max(span.at_m, row.at_m) >= 8,
                      )" class="step-note">{{ t('含輪椅通行待確認路段') }}</span>
                    </span>
                  </button>
                </li>
              </ol>
            </div>
          </template>
          <p v-else class="error" role="status">{{ localizeRouteError(routeOptions[selectedMode]?.error) ?? t('此方式找不到符合條件的路線。') }}</p>
        </section>

        <template #footer>
          <button class="primary-button" type="button" :disabled="!!startDisabledReason" @click="startNavigation">
            <AppIcon name="navigation" />{{ startDisabledReason || t('開始導航') }}
          </button>
        </template>
      </MapSheet>
    </template>

    <!-- ============ Page 2-1 選擇起點或終點（搜尋）============ -->
    <LocationSearch v-if="screen === 'search' && editingTarget" :target="editingTarget" :locating="locating"
      :map-ready="mapReady" :message="locationMessage" @back="back" @choose="chooseSearchResult"
      @use-location="useLocationForTarget" @pick-on-map="openPicker" />

    <!-- ============ Page 2-2 選擇起點或終點（地圖選點）============ -->
    <template v-if="screen === 'picker' && editingTarget">
      <header class="picker-header">
        <button type="button" class="icon-button" :aria-label="t('返回搜尋')" @click="back"><AppIcon name="back" /></button>
        <div>
          <h1>{{ t('選擇{0}', endpointLabel(editingTarget)) }}</h1>
          <small>{{ t('可平移或縮放調整') }}</small>
        </div>
      </header>
      <div class="picker-stage" aria-hidden="true">
        <div class="picker-target">
          <span v-if="pickerLabel" class="picker-label">{{ pickerLabel }}</span>
          <span ref="pickerPin" class="picker-pin" :data-target="editingTarget">
            <svg width="40" height="52" viewBox="0 0 40 52"><path d="M20 52C20 52 0 32 0 20a20 20 0 0 1 40 0c0 12-20 32-20 32Z" fill="currentColor" /><circle cx="20" cy="20" r="8" style="fill: var(--white-50)" /></svg>
          </span>
        </div>
        <span class="picker-hint"><AppIcon name="move" :size="18" />{{ t('拖曳地圖調整中心點') }}</span>
      </div>
      <footer class="picker-footer">
        <button type="button" class="primary-button" :disabled="!mapReady" @click="confirmPick">{{ t('確定') }}</button>
      </footer>
    </template>

    <!-- ============ Page 3 室外即時導航 ============ -->
    <template v-if="screen === 'navigate'">
      <div class="fab-stack nav-fabs">
        <button type="button" class="fab compass-fab" :aria-label="t('將地圖轉回北方朝上')" @click="resetNorth">
          <!-- public/icons/navigation/compass.svg (adapted from Feather, MIT), inlined so the needle can follow the map bearing -->
          <svg class="compass-icon" viewBox="0 0 24 24" width="40" height="40" aria-hidden="true"
            :style="{ transform: `rotate(${-bearing}deg)` }">
            <circle class="compass-face" cx="12" cy="12" r="11.5" />
            <path class="compass-north" d="M12 5 14.8 12H9.2Z" />
            <path class="compass-south" d="M9.2 12H14.8L12 19Z" />
            <circle class="compass-pivot" cx="12" cy="12" r="0.9" />
          </svg>
        </button>
      </div>

      <section ref="navPanelEl" class="nav-panel" :aria-label="t('導航指引')">
        <div class="nav-status-row">
          <span v-if="previewStep !== null" class="badge" data-tone="info">{{ t('預覽 第 {0}/{1} 步', previewStep + 1, navSteps.length) }}</span>
          <span v-else-if="demoMode" class="badge" data-tone="warn">{{ t('示範模擬位置') }}</span>
          <span v-else-if="navState === 'active'" class="badge" data-tone="good">{{ t('GPS 導航中') }}</span>
          <span v-else-if="navState === 'offroute'" class="badge" data-tone="alarm">{{ t('偏離路線') }}</span>
          <span v-else-if="navState !== 'arrived'" class="badge" data-tone="neutral">{{ t('尚未取得導航位置') }}</span>
        </div>
        <p v-if="navStatusText" class="nav-status-text" :data-tone="navState === 'offroute' ? 'alarm' : 'neutral'" role="status">
          {{ navStatusText }}
        </p>
        <div class="nav-instruction" tabindex="0" aria-live="polite" :aria-roledescription="t('可左右滑動的導航步驟')"
          @pointerdown="swipeStart" @pointerup="swipeEnd" @pointercancel="swipeCancel"
          @keydown.left.prevent="stepBy(-1)" @keydown.right.prevent="stepBy(1)">
          <span class="direction-tile" :data-warn="stairWarningStep">
            <svg viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="currentColor" stroke-width="2.4"
              stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path :d="directionIcons[navCard.icon]" /></svg>
          </span>
          <div class="instruction-text">
            <strong>{{ navCard.title }}</strong>
            <span v-if="navCard.detail">{{ navCard.detail }}</span>
            <small v-if="remaining && navState !== 'arrived'">{{ t('預估 {0} 分鐘・剩餘 {1}', remaining.minutes, formatDistance(remaining.meters)) }}</small>
          </div>
        </div>
        <p v-if="navNotice" class="notice" role="status">{{ navNotice }}</p>
        <div v-if="navSteps.length > 1" class="step-progress">
          <p class="sr-only" role="status" aria-live="polite" aria-atomic="true">{{ t('第 {0} 步，共 {1} 步', shownStepIndex + 1, navSteps.length) }}</p>
          <div ref="stepDotsEl" class="step-dots" aria-hidden="true">
            <span v-for="(_, index) in navSteps" :key="index" class="step-dot"
              :data-active="index === shownStepIndex" @click="previewAt(index)" />
          </div>
          <p class="step-count">{{ t('左右滑動切換') }}</p>
        </div>
        <div class="nav-actions">
          <button v-if="navState === 'offroute' && previewStep === null" type="button" class="secondary-button" @click="replan">
            <AppIcon name="navigation" />{{ t('從此處重新規劃') }}
          </button>
          <button v-else type="button" class="secondary-button" :disabled="previewStep === null" @click="previewStep = null">
            <AppIcon name="locate" />{{ t('回到目前進度') }}
          </button>
          <button type="button" class="alarm-button" @click="requestEnd">
            <AppIcon :name="navState === 'arrived' ? 'check' : 'close'" />{{ navState === 'arrived' ? t('完成') : t('結束') }}
          </button>
        </div>
        <button v-if="demoAvailable && navState !== 'arrived'" type="button" class="text-button demo-button" @click="demoAdvance">
          {{ t('示範：模擬前進（開發用）') }}
        </button>
      </section>

      <div v-if="endConfirm" class="dialog-backdrop" @click.self="endConfirm = false">
        <div class="dialog" role="alertdialog" aria-modal="true" aria-labelledby="end-title" aria-describedby="end-desc">
          <h2 id="end-title">{{ t('結束導航？') }}</h2>
          <p id="end-desc">{{ t('結束後會回到路線預覽，起終點與選擇的路線會保留。') }}</p>
          <div class="dialog-actions">
            <button type="button" class="secondary-button" autofocus @click="endConfirm = false">{{ t('取消') }}</button>
            <button type="button" class="alarm-button solid" @click="endNavigation">{{ t('結束導航') }}</button>
          </div>
        </div>
      </div>
    </template>
  </main>
  <IndoorOverlay v-if="indoorVenue && appMode === 'general'" :venue="indoorVenue" @close="closeIndoor" />
</template>
