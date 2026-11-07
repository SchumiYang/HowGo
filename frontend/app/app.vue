<script setup lang="ts">
import { locale, t } from '~/i18n'
import { localizeRouteError, localizeRouteText } from './utils/routeLocale'

import type { Feature, FeatureCollection, LineString, MultiPolygon, Point, Polygon } from 'geojson'
import type { ExpressionSpecification, GeoJSONSource, Map as MapLibreMap, MapGeoJSONFeature, Popup as MapLibrePopup } from 'maplibre-gl'
import { createRouteTracker } from './utils/navigation'
import { getFix, locationAvailable, watchFix, type FixError } from './utils/geolocation'
import { LOCAL_CJK_FONT, TAIPEI_BOUNDS, collapseAttribution, loadBasemap } from './utils/basemap'
import type { IconName } from './components/AppIcon.vue'
import type { AppMode } from './components/ModeLanding.vue'
import type { Coordinate, Place } from './composables/usePlaceSearch'

useHead({ htmlAttrs: { lang: () => locale.value } })

/**
 * Screens follow 室外uiux-v1/ACCESSIBLE_NAV_FLUTTER_WEB_SPEC.md:
 * explore = Page 1, preview = Page 2, search = Page 2-1, picker = Page 2-2, navigate = Page 3.
 */
type Screen = 'explore' | 'preview' | 'search' | 'picker' | 'navigate'
type Endpoint = 'start' | 'end'
type FacilityKind = typeof categories[number]['kind']
type Facility = Feature<Point, { kind: FacilityKind; name: string; label: string; distance_m?: number }>
type Facilities = FeatureCollection<Point, Facility['properties']> & { truncated?: boolean }
type WalkwayKind = typeof walkwayCategories[number]['kind']
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
type Metadata = {
  source_url: string
  coverage: [number, number, number, number]
  empty_types: FacilityKind[]
  snapshot: { imported_at: string; fetched_at?: string } | null
}

const categories = [
  { kind: '1', label: '斜坡道', color: '#137a68' },
  { kind: '3', label: '路外停車場無障礙電梯', color: '#704395' },
  { kind: '4', label: '公園', color: '#52812b' },
  { kind: '7', label: '捷運站及公園無障礙出入口', color: '#285cba' },
  { kind: '8', label: '友善店家', color: '#a13b52' },
  { kind: '9', label: '無障礙廁所', color: '#8b479a' },
  { kind: '14', label: '身障設施', color: '#b65419' },
  { kind: '15', label: '路邊停車場', color: '#48617f' },
  { kind: '16', label: '路邊停車格', color: '#8a6525' },
  { kind: 'accessible-parking', label: '身心障礙停車格', color: '#4d4ab1' },
  { kind: '18', label: '公車站', color: '#006d92' },
  { kind: '20', label: '捷運站', color: '#9d305f' },
] as const
const [firstCategory, ...otherCategories] = categories
const facilityColor: ExpressionSpecification = [
  'match', ['get', 'kind'], firstCategory.kind, firstCategory.color,
  ...otherCategories.flatMap(({ kind, color }) => [kind, color]), '#475569',
]

const walkwayCategories = [
  { kind: '11', label: '人行道', color: '#00816f' },
  { kind: '12', label: '標線型人行道', color: '#305fc4' },
  { kind: '13', label: '行穿線（市府）', color: '#8543a3' },
  { kind: 'osm-crossing', label: '行人穿越道（OSM）', color: '#a020af' },
  { kind: 'arcade', label: '騎樓整平路段', color: '#ba5917' },
] as const
const walkwayColor: ExpressionSpecification = [
  'match', ['get', 'kind'], '11', '#00816f', '12', '#305fc4', '13', '#8543a3', 'arcade', '#ba5917', '#475569',
]

type LayerKind = FacilityKind | WalkwayKind | 'slope'
const allLayerKinds: LayerKind[] = [...[...categories, ...walkwayCategories].map(item => item.kind), 'slope']
const layerGroups = [
  { label: '人行通道', kinds: ['11', '12', '13', 'osm-crossing', 'arcade'] },
  { label: '坡度', kinds: ['slope'] },
  { label: '身障停車格', kinds: ['accessible-parking'] },
  { label: '出入口／坡道', kinds: ['1', '3', '7'] },
  { label: '友善店家', kinds: ['8'] },
  { label: '無障礙廁所', kinds: ['9'] },
  { label: '大眾運輸', kinds: ['18', '20'] },
  { label: '公園', kinds: ['4'] },
  { label: '停車', kinds: ['15', '16'] },
  { label: '身障設施', kinds: ['14'] },
] satisfies { label: string; kinds: LayerKind[] }[]
const SLOPE_COLOR = '#AD7B2B'
const layerColors = new Map<LayerKind, string>([
  ...[...categories, ...walkwayCategories].map(item => [item.kind, item.color] as [LayerKind, string]),
  ['slope', SLOPE_COLOR],
])
/** Map colours of a quick-filter group (max 3 dots) so the chips double as a compact legend. */
const groupColors = (kinds: LayerKind[]) => [...new Set(kinds.map(kind => layerColors.get(kind)!))].slice(0, 3)
/** Below these zooms the point / walkway layers would cover the whole map, so they are not drawn or fetched. */
const FACILITY_MIN_ZOOM = 15
const WALKWAY_MIN_ZOOM = 14
const SIDEWALK_MIN_ZOOM = 15

// Town Pass Primary family for the route; amber/orange for destination per DESIGN.md.
const routeColors = {
  route: '#5AB4C5', casing: '#356C77', walked: '#ADB8BE', alternative: '#71C5D5',
  sidewalk: '#76A732', guidedSidewalk: '#5E8F28', ramp: '#356C77', slope: '#E7A43C',
}
const LIVE_COLOR = '#1C7ED6'
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
const enabledFacilities = computed(() => categories.map(item => item.kind).filter(kind => enabledLayers.value.includes(kind)))
const enabledWalkways = computed(() => walkwayCategories.map(item => item.kind).filter(kind => enabledLayers.value.includes(kind)))
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
const voice = useVoiceInput((text) => {
  exploreSearch.query.value = text
  exploreInput.value?.focus()
})
const walkwayKinds = new Set<string>(walkwayCategories.map(item => item.kind))
const browseIcon = computed<IconName>(() => {
  const kind = browseDetails.value[0]?.kind
  if (!kind) return 'pin'
  if (walkwayKinds.has(kind)) return 'walk'
  if (kind === 'slope') return 'slope'
  if (kind === '1' || kind === '3' || kind === '7' || kind === '9' || kind === '14' || kind === 'accessible-parking') return 'accessible'
  return 'pin'
})
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

function setBrowsePlace(place: Place | null, details: FeatureDetail[] = []) {
  browsePlace.value = place
  browseDetails.value = details
  updatePins()
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

function drawLivePosition(point: Coordinate | null) {
  setSource('live-position', point ? [{ type: 'Feature', geometry: { type: 'Point', coordinates: point }, properties: {} }] : [])
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
    layers: ['facilities', 'walkways-fill', 'walkways-outline', 'crossings-osm'],
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
const voiceEnabled = ref(false)
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
/** Smaller status line under the badges while there is no usable live position. */
const navStatusText = computed(() => navState.value === 'waiting' || navState.value === 'offroute' ? navMessage.value : '')
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
  if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel()
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
  const start = result.value.route.geometry.coordinates[0] as Coordinate
  map?.easeTo({ duration: 0,  center: start, zoom: Math.max(map.getZoom(), 17), offset: [0, -Math.round(window.innerHeight * .12)] })
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
    if (previewStep.value === null) map?.jumpTo({ center: point, zoom: Math.max(map.getZoom(), 16) })
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
  map?.easeTo({ duration: 0,  center: point, offset: [0, -Math.round(window.innerHeight * .12)] })
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

function highlightManeuver(maneuver: Maneuver | undefined) {
  if (!maneuver) {
    setSource('selected-step', [])
    return
  }
  const turn = isTurn(maneuver.action)
  const coordinates = tracker.value?.slice(turn ? maneuver.at_m - 8 : maneuver.at_m, turn ? maneuver.at_m + 8 : maneuver.end_m)
  setSource('selected-step', coordinates?.length ? [{
    type: 'Feature', geometry: { type: 'LineString', coordinates }, properties: {},
  }] : [])
}

watch(previewStep, (index) => {
  if (screen.value !== 'navigate') return
  if (index === null) {
    highlightManeuver(undefined)
    if (liveFix.value) map?.easeTo({ duration: 0,  center: liveFix.value, offset: [0, -Math.round(window.innerHeight * .12)] })
    return
  }
  const maneuver = navSteps.value[index]
  highlightManeuver(maneuver)
  if (maneuver) map?.panTo(maneuver.position, { duration: 0, offset: [0, -Math.round(window.innerHeight * .12)] })
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

function resetNorth() {
  map?.easeTo({ bearing: 0, pitch: 0, duration: 300 })
}

function speak(text: string) {
  if (!text || typeof speechSynthesis === 'undefined') return
  speechSynthesis.cancel()
  const utterance = new SpeechSynthesisUtterance(text)
  utterance.lang = locale.value === 'en' ? 'en' : 'zh-TW'
  speechSynthesis.speak(utterance)
}

function toggleVoice() {
  if (typeof speechSynthesis === 'undefined' || typeof SpeechSynthesisUtterance === 'undefined') {
    navNotice.value = t('此瀏覽器不支援語音播報，請參考文字指引。')
    return
  }
  voiceEnabled.value = !voiceEnabled.value
  navNotice.value = ''
  if (voiceEnabled.value) speak(navCard.value.title)
  else speechSynthesis.cancel()
}

// Announce once per manoeuvre, not on every distance update.
watch(() => [currentPassage.value?.at_m, nextManeuver.value?.at_m, navState.value], () => {
  if (voiceEnabled.value && navState.value === 'active' && previewStep.value === null) speak(navigationTitle.value)
  if (voiceEnabled.value && navState.value === 'arrived') speak(navMessage.value)
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
let inspectionPopup: MapLibrePopup | undefined

const displayedDate = computed(() => {
  const snapshot = metadata.value?.snapshot
  if (!snapshot) return ''
  return new Intl.DateTimeFormat(locale.value, { timeZone: 'Asia/Taipei' }).format(
    new Date(snapshot.fetched_at ?? snapshot.imported_at),
  )
})

function setSource(name: string, features: Feature[]) {
  map?.getSource<GeoJSONSource>(name)?.setData({ type: 'FeatureCollection', features })
}

/** Route-related layers. Hidden (not cleared) on the picker so returning to preview restores them as-is. */
const routeLayerIds = [
  'route-sidewalk-fill', 'route-sidewalk-outline', 'guided-sidewalk-fill', 'guided-sidewalk-outline',
  'route-alternatives', 'route-outline', 'route', 'route-walked', 'unverified-walkways', 'selected-step',
  'route-access-points', 'route-ramp-halo', 'route-ramps', 'route-slope-halo', 'route-slope-markers',
]

function applyRouteLayerState() {
  if (!map || !mapReady.value) return
  const picking = screen.value === 'picker'
  for (const id of routeLayerIds) map.setLayoutProperty(id, 'visibility', picking ? 'none' : 'visible')
  // Background data is dimmed behind a route, but shown fully while picking a point.
  const dim = !!result.value && !picking
  map.setPaintProperty('facilities', 'circle-opacity', dim ? .24 : .8)
  map.setPaintProperty('facilities', 'circle-stroke-opacity', dim ? .24 : 1)
  map.setPaintProperty('walkways-fill', 'fill-opacity', dim ? .11 : ['case', ['==', ['get', 'kind'], '13'], .5, .32])
  map.setPaintProperty('walkways-outline', 'line-opacity', dim ? .36 : .86)
  map.setPaintProperty('slope-lines', 'line-opacity', dim ? .35 : 1)
  map.setPaintProperty('slope-markers', 'icon-opacity', dim ? .36 : 1)
}

watch(result, (route) => {
  setSource('route-highlights', route?.highlights?.features ?? [])
  applyRouteLayerState()
})

watch(screen, (value) => {
  inspectionPopup?.remove()
  showLayers.value = false
  showModeMenu.value = false
  if (value !== 'navigate') endConfirm.value = false
  updatePins()
  applyRouteLayerState()
})

function facilityPosition(hit: MapGeoJSONFeature): Coordinate {
  const source = visibleFacilities.features.find(item => item.id === hit.id)
  return (source?.geometry.coordinates ?? (hit.geometry as Point).coordinates) as Coordinate
}

function updatePins() {
  const routing = screen.value !== 'explore'
  setSource('pins', (['start', 'end'] as const).flatMap((endpoint) => {
    if (screen.value === 'picker' && endpoint === editingTarget.value) return []
    const coordinates = routing
      ? endpoints[endpoint]
      : endpoint === 'end' ? browsePlace.value?.coordinates : null
    return coordinates ? [{
      type: 'Feature' as const,
      geometry: { type: 'Point' as const, coordinates },
      properties: { endpoint, current: routing && fromGps[endpoint] },
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
  setSource('facilities', visibleFacilities.features.filter(item => types.includes(item.properties.kind)))
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
    setSource('facilities', data.features)
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
  setSource('walkways', visibleWalkways)
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
    setSource('walkways', visibleWalkways)
    if (data.truncated) walkwayMessage.value = t('放大地圖可查看其餘通行空間。')
  } catch {
    if (controller.signal.aborted) return
    visibleWalkways = []
    setSource('walkways', [])
    walkwayMessage.value = t('通行空間圖層暫時無法載入。')
  }
}

const showSlopes = computed(() => enabledLayers.value.includes('slope'))

async function refreshSlopes() {
  if (!map || !mapReady.value) return
  slopesRequest?.abort()
  if (!showSlopes.value || map.getZoom() < 14) {
    setSource('slopes', [])
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
    setSource('slopes', data.features.flatMap<Feature>((item) => {
      const properties = { ...item.properties, kind: 'slope' }
      if (item.geometry.type === 'Point') {
        return [{ ...item, properties: { ...properties, label: t('坡度點位') } }]
      }
      return [
        item,
        ...[item.geometry.coordinates[0]!, item.geometry.coordinates.at(-1)!].map((coordinates, i): Feature<Point> => ({
          type: 'Feature',
          geometry: { type: 'Point', coordinates },
          properties: { ...properties, label: i === 0 ? t('坡段起點') : t('坡段終點') },
        })),
      ]
    }))
  } catch {
    if (!controller.signal.aborted) setSource('slopes', [])
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
  const shown = new Set<string>()
  for (const { properties } of hits) {
    const { kind, name, label, source, width, slope, offset_m, incline, route_context, side, guided } = properties
    const title = route_context === 'sidewalk' || route_context === 'guided-sidewalk' ? String(label)
      : route_context === 'ramp' ? guided ? t('指引側無障礙坡道') : t('鄰近無障礙坡道')
      : kind === '13' ? t('行人穿越道') : kind === '11' ? t('實體人行道') : String(label)
    const displayName = typeof name === 'string'
      ? name.replace(/^\d+\s*[-_]\s*/, '').replace(/<br\s*\/?>/gi, '\n').trim()
      : ''
    // Width/slope come from the source data. Missing values stay hidden rather than invented (spec §11).
    const lines = [
      typeof width === 'number' && width > 0 ? t('寬度（來源數值） {0}', width) : '',
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
          'live-position': emptySource(),
          pins: emptySource(),
        },
        layers: [
          { id: 'background', type: 'background', paint: { 'background-color': '#F1F3F4' } },
          ...baseShapes,
          { id: 'walkways-fill', source: 'walkways', type: 'fill', minzoom: WALKWAY_MIN_ZOOM,
            filter: ['==', ['geometry-type'], 'Polygon'],
            paint: { 'fill-color': walkwayColor, 'fill-opacity': ['case', ['==', ['get', 'kind'], '13'], 0.5, 0.32] } },
          { id: 'walkways-outline', source: 'walkways', type: 'line', minzoom: WALKWAY_MIN_ZOOM,
            filter: ['==', ['geometry-type'], 'Polygon'],
            paint: { 'line-color': walkwayColor, 'line-width': ['case', ['==', ['get', 'kind'], '13'], 2.5, 1.5],
              'line-opacity': 0.86 } },
          ...baseLabels,
          { id: 'facilities', source: 'facilities', type: 'circle', minzoom: FACILITY_MIN_ZOOM, paint: {
            'circle-color': facilityColor,
            'circle-radius': ['interpolate', ['linear'], ['zoom'], 15, 4, 17, 6.5],
            'circle-opacity': 0.8, 'circle-stroke-color': '#fff', 'circle-stroke-width': 1.5,
          } },
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
            paint: { 'line-color': routeColors.guidedSidewalk, 'line-width': 2.5, 'line-dasharray': [2, 1] } },
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
            paint: { 'line-color': '#F5BA4B', 'line-width': 5, 'line-dasharray': [2, 1.3] } },
          { id: 'crossings-osm', source: 'walkways', type: 'line', minzoom: WALKWAY_MIN_ZOOM,
            filter: ['==', ['get', 'kind'], 'osm-crossing'],
            paint: { 'line-color': '#a020af', 'line-dasharray': [1.5, 1],
              'line-width': ['interpolate', ['linear'], ['zoom'], 12, 2, 17, 4.5] } },
          { id: 'selected-step', source: 'selected-step', type: 'line',
            layout: { 'line-join': 'round', 'line-cap': 'round' },
            paint: { 'line-color': '#FD853A', 'line-width': 7 } },
          { id: 'route-access-points', source: 'route-access-points', type: 'circle', paint: {
            'circle-color': '#fff', 'circle-radius': 6, 'circle-stroke-color': routeColors.casing, 'circle-stroke-width': 3,
          } },
          { id: 'slope-lines', source: 'slopes', type: 'line', filter: ['==', ['geometry-type'], 'LineString'],
            paint: { 'line-color': SLOPE_COLOR, 'line-width': 3, 'line-dasharray': [1.5, 1] } },
          { id: 'slope-markers', source: 'slopes', type: 'symbol', filter: ['==', ['geometry-type'], 'Point'],
            layout: { 'icon-image': 'slope-marker', 'icon-allow-overlap': true } },
          { id: 'route-ramp-halo', source: 'route-highlights', minzoom: 14, type: 'circle',
            filter: ['==', ['get', 'route_context'], 'ramp'],
            paint: { 'circle-color': routeColors.ramp, 'circle-radius': 11, 'circle-opacity': .22 } },
          { id: 'route-ramps', source: 'route-highlights', minzoom: 14, type: 'circle',
            filter: ['==', ['get', 'route_context'], 'ramp'],
            paint: { 'circle-color': routeColors.ramp, 'circle-radius': 6.5, 'circle-stroke-color': '#fff',
              'circle-stroke-width': 2.5 } },
          { id: 'route-slope-halo', source: 'route-highlights', minzoom: 14, type: 'circle',
            filter: ['==', ['get', 'route_context'], 'slope'],
            paint: { 'circle-color': routeColors.slope, 'circle-radius': 16, 'circle-opacity': .28 } },
          { id: 'route-slope-markers', source: 'route-highlights', minzoom: 14, type: 'symbol',
            filter: ['==', ['get', 'route_context'], 'slope'],
            layout: { 'icon-image': 'slope-marker', 'icon-size': 1.22, 'icon-allow-overlap': true } },
          // Live GPS = filled blue dot with halo (spec §4.2 「藍點」); start pin = teal ring with centre dot
          // (matches the endpoint card marker); destination = filled orange.
          { id: 'live-position-halo', source: 'live-position', type: 'circle',
            paint: { 'circle-radius': 20, 'circle-color': LIVE_COLOR, 'circle-opacity': .2 } },
          { id: 'live-position', source: 'live-position', type: 'circle',
            paint: { 'circle-radius': 8, 'circle-color': LIVE_COLOR, 'circle-stroke-color': '#fff', 'circle-stroke-width': 3 } },
          { id: 'pins', source: 'pins', type: 'circle', paint: {
            'circle-color': ['match', ['get', 'endpoint'], 'start', '#fff', '#FD853A'],
            'circle-radius': 9,
            'circle-stroke-color': ['match', ['get', 'endpoint'], 'start', '#356C77', '#fff'],
            'circle-stroke-width': ['match', ['get', 'endpoint'], 'start', 4, 3],
          } },
          { id: 'pins-centre', source: 'pins', type: 'circle', filter: ['==', ['get', 'endpoint'], 'start'],
            paint: { 'circle-radius': 3.5, 'circle-color': '#356C77' } },
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
      const icon = document.createElement('canvas')
      icon.width = icon.height = 48
      const ctx = icon.getContext('2d')
      if (ctx && map) {
        ctx.fillStyle = '#AD7B2B'
        ctx.strokeStyle = '#fff'
        ctx.lineWidth = 4
        ctx.beginPath()
        ctx.arc(24, 24, 21, 0, Math.PI * 2)
        ctx.fill()
        ctx.stroke()
        ctx.lineJoin = 'round'
        ctx.lineCap = 'round'
        ctx.beginPath()
        ctx.moveTo(13, 32)
        ctx.lineTo(35, 32)
        ctx.lineTo(35, 17)
        ctx.closePath()
        ctx.stroke()
        map.addImage('slope-marker', ctx.getImageData(0, 0, 48, 48), { pixelRatio: 2 })
      }
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
        'route-access-points', 'crossings-osm', 'unverified-walkways', 'facilities', 'walkways-fill', 'walkways-outline'] })
      const clicked: Coordinate = [event.lngLat.lng, event.lngLat.lat]
      if (screen.value === 'explore') {
        showLayers.value = false
        showModeMenu.value = false
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
        setBrowsePlace({ name: detail.name || detail.title, address: '', coordinates, is_road: false }, features)
        return
      }
      if (!hits.length) return
      const content = document.createElement('div')
      content.className = 'map-inspection'
      for (const feature of describeHits(hits)) {
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
            <button type="button" class="icon-button ghost" :aria-label="voice.listening.value ? t('正在聆聽') : t('語音搜尋')"
              :aria-pressed="voice.listening.value" @click="voice.start()">
              <AppIcon name="mic" />
            </button>
          </form>
          <button type="button" class="mode-pill" :aria-expanded="showModeMenu" aria-controls="mode-menu"
            @click="showModeMenu = !showModeMenu; showLayers = false">
            <span class="mode-badge">Aa</span>{{ t('一般') }}
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
            <span><strong>{{ t('無障礙模式') }}</strong><small>{{ t('高對比大字、大圖示導航、固定輪椅路線') }}</small></span>
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
              <span class="chip-dots" aria-hidden="true">
                <i v-for="color in groupColors(group.kinds)" :key="color" :style="{ background: color }" />
              </span>{{ t(group.label) }}
            </button>
          </div>
          <details class="layer-details">
            <summary>{{ t('個別圖層') }}</summary>
            <div v-for="(items, index) in [walkwayCategories, categories]" :key="index" class="chip-row"
              role="group" :aria-label="index === 0 ? t('通行空間') : t('設施點')">
              <label v-for="item in items" :key="item.kind" class="chip check-chip">
                <input v-model="enabledLayers" type="checkbox" :value="item.kind">
                <i :style="{ background: item.color }" aria-hidden="true" />{{ t(item.label) }}
                <small v-if="metadata?.empty_types.some(kind => kind === item.kind)">{{ t('來源無點位') }}</small>
              </label>
              <label v-if="index === 0" class="chip check-chip"><input v-model="enabledLayers" type="checkbox" value="slope">{{ t('坡度') }}</label>
            </div>
          </details>
          <p class="hint">{{ t('圓點顏色對應地圖上的設施與通行空間圖示。') }}</p>
          <p v-if="facilitiesHiddenByZoom" class="hint" role="status">{{ t('放大地圖可查看設施點位。') }}</p>
          <p v-if="walkwayMessage" class="hint" role="status">{{ walkwayMessage }}</p>
          <p v-if="facilityMessage" class="hint" role="status">{{ facilityMessage }}</p>
          <footer class="sources">
            <a :href="metadata?.source_url || 'https://data.taipei/dataset/detail?id=2b58f15a-dec6-4b9d-91be-4eaccfda5ae7'">{{ t('輪行臺北設施資料') }}</a>
            <span v-if="displayedDate">・{{ displayedDate }}</span><br>
            <a href="https://data.taipei/dataset/detail?id=09504c47-7349-4cab-9ce6-db30f32a392e">{{ t('臺北市騎樓整平圖資') }}</a><br>
            <a href="https://data.taipei/dataset/detail?id=5a911ea5-1694-4301-808e-e1780d971611">{{ t('臺北市路邊停車格位') }}</a>
          </footer>
        </section>

        <button v-if="facilitiesHiddenByZoom && !showLayers && !showModeMenu && exploreSearch.query.value.trim().length < 2"
          type="button" class="zoom-hint" @click="zoomInForFacilities">
          <AppIcon name="search" :size="16" />{{ t('放大地圖以顯示無障礙設施') }}
        </button>
        <p v-if="voice.message.value" class="notice" role="status">{{ voice.message.value }}</p>
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

      <section class="place-card" :aria-label="t('選取的地點')" aria-live="polite">
        <template v-if="browsePlace">
          <span class="place-icon"><AppIcon :name="browseIcon" :size="26" /></span>
          <div class="place-body">
            <h2>{{ browsePlace.name }}</h2>
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
        </template>
        <template v-else>
          <span class="place-icon muted"><AppIcon name="pin" :size="26" /></span>
          <div class="place-body">
            <h2>{{ t('請先選擇地點') }}</h2>
            <small>{{ t('點選地圖上的設施、人行道或任一位置，也可以用上方搜尋。') }}</small>
          </div>
          <button type="button" class="go-button" disabled :aria-label="t('請先選擇地點')"><AppIcon name="directions" :size="28" /></button>
        </template>
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

      <MapSheet v-model="sheetLevel">
        <template #summary>
          <div v-if="hasOptions" class="route-tabs" role="tablist" :aria-label="t('路線方式')">
            <button v-for="mode in routeModes" :key="mode.key" type="button" role="tab"
              :aria-selected="selectedMode === mode.key" @click="selectMode(mode.key)">
              <AppIcon :name="mode.icon" :size="18" />
              <span>{{ t(mode.label) }}</span>
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
            <p class="hint">{{ t('摘要依沿線可比對圖資，未覆蓋路段的通行條件待確認，請以現場路況為準。') }}</p>

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
            <svg width="40" height="52" viewBox="0 0 40 52"><path d="M20 52C20 52 0 32 0 20a20 20 0 0 1 40 0c0 12-20 32-20 32Z" fill="currentColor" /><circle cx="20" cy="20" r="8" fill="#fff" /></svg>
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
        <button type="button" class="fab" :aria-label="bearing === 0 ? t('地圖已朝北') : t('地圖轉回正北')" @click="resetNorth">
          <AppIcon name="compass" :size="24" class="compass-icon" :style="{ transform: `rotate(${-bearing}deg)` }" />
        </button>
        <button type="button" class="fab" :aria-label="voiceEnabled ? t('關閉語音播報') : t('開啟語音播報')" :aria-pressed="voiceEnabled"
          @click="toggleVoice">
          <AppIcon :name="voiceEnabled ? 'volume' : 'mute'" :size="24" />
        </button>
      </div>

      <section class="nav-panel" :aria-label="t('導航指引')">
        <div class="nav-status-row">
          <span v-if="demoMode" class="badge" data-tone="warn">{{ t('示範模擬位置') }}</span>
          <span v-else-if="navState === 'active'" class="badge" data-tone="good">{{ t('GPS 導航中') }}</span>
          <span v-else-if="navState === 'offroute'" class="badge" data-tone="alarm">{{ t('偏離路線') }}</span>
          <span v-else-if="navState !== 'arrived'" class="badge" data-tone="neutral">{{ t('尚未取得導航位置') }}</span>
          <span v-if="previewStep !== null" class="badge" data-tone="neutral">{{ t('步驟預覽 {0}／{1}', previewStep + 1, navSteps.length) }}</span>
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
        <div v-if="navSteps.length > 1" class="step-dots" role="group" :aria-label="t('導航步驟')">
          <template v-if="navSteps.length <= 12">
            <button v-for="(row, index) in navSteps" :key="index" type="button"
              :aria-label="t('第 {0} 步：{1}', index + 1, localizeRouteText(row.instruction))" :aria-current="index === shownStepIndex ? 'step' : undefined"
              :data-done="index < currentStepIndex" @click="previewAt(index)" />
          </template>
          <span v-else class="step-count">{{ t('{0}／{1}・左右滑動切換', shownStepIndex + 1, navSteps.length) }}</span>
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
