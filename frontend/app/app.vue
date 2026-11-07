<script setup lang="ts">
import type { Feature, FeatureCollection, LineString, MultiPolygon, Point, Polygon } from 'geojson'
import { createRouteTracker } from './utils/navigation'
import type { ExpressionSpecification, GeoJSONSource, Map as MapLibreMap, MapGeoJSONFeature, Popup as MapLibrePopup } from 'maplibre-gl'

type Coordinate = [number, number]
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
type Place = { name: string; address: string; coordinates: Coordinate; is_road: boolean }
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

const routeColors = { route: '#2057d6', sidewalk: '#2ea96c', guidedSidewalk: '#2b995c', ramp: '#00785d', slope: '#be4d18' }
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
const error = ref('')
const failedEndpoint = ref<Endpoint | null>(null)
const busy = ref(false)
const locating = ref(false)
const locationMessage = ref('')
const startFromLocation = ref(false)
const selecting = ref<Endpoint | null>(null)
const mapPicking = ref(false)
const planning = ref(false)
const browsePlace = shallowRef<Place | null>(null)
const browseDetails = shallowRef<FeatureDetail[]>([])
const searchInput = useTemplateRef<HTMLInputElement>('searchInput')
const endpointNames = reactive<Record<Endpoint, string>>({ start: '', end: '' })
const placeQuery = ref('')
const placeResults = shallowRef<Place[]>([])
const placeStatus = ref('')
let inspectionPopup: MapLibrePopup | undefined

watch(placeQuery, (query, _, onCleanup) => {
  const text = query.trim()
  placeResults.value = []
  placeStatus.value = ''
  if (text.length < 2) return
  const request = new AbortController()
  placeStatus.value = '搜尋中…'
  const timer = setTimeout(async () => {
    try {
      const data = await $fetch<{ results: Place[] }>('/api/v1/places', {
        query: { q: text }, signal: request.signal,
      })
      if (request.signal.aborted) return
      placeResults.value = data.results
      placeStatus.value = data.results.length ? '' : '找不到相符地點，可改用路名或地圖選點。'
    } catch {
      if (!request.signal.aborted) placeStatus.value = '搜尋暫時無法使用，可在地圖上選點。'
    }
  }, 250)
  onCleanup(() => {
    clearTimeout(timer)
    request.abort()
  })
})
const endpoints = reactive<Record<Endpoint, Coordinate | null>>({ start: null, end: null })
const result = shallowRef<RouteResult | null>(null)
const routeModes = [
  { key: 'fastest', label: '最短距離', description: '一般步行，以預估時間最少為優先。' },
  { key: 'balanced', label: '平衡', description: '避開已知不適合通行的人行道，可接受一段短階梯。' },
  { key: 'accessible', label: '無障礙', description: '避開階梯與已知坡段，優先較寬的人行道。' },
] as const
const routeOptions = shallowRef<Partial<Record<RouteMode, RouteOption>>>({})
const selectedMode = ref<RouteMode>('accessible')
const modeDetails = computed(() => routeModes.find(item => item.key === selectedMode.value)!)
const hasOptions = computed(() => Object.keys(routeOptions.value).length > 0)
const routeFacts = computed(() => {
  const facts = result.value?.assessment
  if (!facts) return []
  return [
    facts.stair_sections === null ? '階梯資料待確認'
      : facts.stair_sections > 0 ? `${facts.stair_sections} 段階梯 · 約 ${formatDistance(facts.stairs_m ?? 0)}`
        : '路網未標示階梯',
    facts.mapped_slope_sections ? `${facts.mapped_slope_sections} 處已知坡段` : '',
    facts.comfortable_m ? `可行人行道約 ${formatDistance(facts.comfortable_m)}` : '',
    facts.limited_m ? `勉強可行人行道約 ${formatDistance(facts.limited_m)}` : '',
    facts.blocked_m ? `含過窄人行道約 ${formatDistance(facts.blocked_m)}` : '',
  ].filter(Boolean)
})
const minutes = (seconds: number) => Math.max(1, Math.round(seconds / 60))
const plannedAt = ref(0)
const arrivalClock = new Intl.DateTimeFormat('zh-TW', { hour: '2-digit', minute: '2-digit', hour12: false })
const estimatedArrival = computed(() => result.value && plannedAt.value
  ? arrivalClock.format(plannedAt.value + result.value.duration_s * 1000) : '')
const selectedStep = ref<number | null>(null)
const sheetLevel = ref(1)
const navState = ref<'idle' | 'waiting' | 'active' | 'offroute' | 'arrived'>('idle')
const navMessage = ref('')
const progress = ref<number | null>(null)
const liveFix = shallowRef<Coordinate | null>(null)
let locationWatch: number | null = null
let navSession = 0
let missedFixes = 0
let lastFixTime = 0
let freshnessTimer: ReturnType<typeof setTimeout> | undefined
const navigating = computed(() => navState.value !== 'idle')
const tracker = computed(() => result.value ? createRouteTracker(result.value.route.geometry.coordinates) : null)
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
  if (currentPassage.value) return currentPassage.value.instruction
  const next = nextManeuver.value
  if (!next || progress.value === null) return '接近目的地'
  const remaining = next.at_m - progress.value
  if (remaining <= 2) return next.instruction
  return `約 ${formatDistance(remaining)} 後 · ${next.instruction}`
})
const liveGuidance = computed(() => {
  if (navState.value !== 'active' || !activeStep.value || !tracker.value || progress.value === null) return ''
  const step = activeStep.value
  const offset = progress.value - tracker.value.cumulative[step.from_index]!
  if (currentPassage.value) return currentPassage.value.note
    ?? (currentPassage.value.action === 'stairs' ? `約 ${formatDistance(currentPassage.value.end_m - progress.value)}` : '請確認可通行後再通過。')
  if (result.value?.unverified_walkways?.some(span => span.at_m <= progress.value! && progress.value! < span.end_m)) {
    return '路網步行通道，輪椅通行條件未確認。'
  }
  if (nextManeuver.value?.action === 'sidewalk' && nextManeuver.value.at_m - progress.value <= 25) {
    return nextManeuver.value.note ?? ''
  }
  const ranges = step.guidance_ranges ?? (step.guidance ? [step.guidance] : [])
  const available = ranges.filter(range => offset >= range.from_m && (range.to_m === null || offset <= range.to_m))
  const physical = available.filter(range => range.reason === '實體人行道')
  const choices = physical.length ? physical : available
  const along = choices.find(range => range.side === 'along')
  if (along) return `維持沿${along.reason}前進。`
  if (physical.some(range => range.side === 'left') && physical.some(range => range.side === 'right')) {
    return '道路兩側有實體人行道，請維持目前可通行的一側。'
  }
  const guidance = choices[0]
  if (!guidance) return ''
  const side = guidance.side === 'left' ? '左側' : '右側'
  return `若已在${side}，請維持${side}前進。該側有${guidance.reason}。`
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
const metadata = shallowRef<Metadata | null>(null)

let map: MapLibreMap | undefined
let mapImportCancelled = false
let locationRequest = 0
let facilitiesRequest: AbortController | undefined
let walkwaysRequest: AbortController | undefined
let slopesRequest: AbortController | undefined
let visibleWalkways: Walkway[] = []
let routeRequest: AbortController | undefined
let resizeObserver: ResizeObserver | undefined
let visibleFacilities: Facilities = { type: 'FeatureCollection', features: [] }

const endpointLabel = (endpoint: Endpoint) => endpoint === 'start' ? '起點' : '終點'
const formatCoordinate = (point: Coordinate) => `${point[1].toFixed(5)}, ${point[0].toFixed(5)}`
const formatDistance = (meters: number) => meters >= 1000 ? `${(meters / 1000).toFixed(1)} 公里` : `${Math.round(meters)} 公尺`
const displayedDate = computed(() => {
  const snapshot = metadata.value?.snapshot
  if (!snapshot) return ''
  return new Intl.DateTimeFormat('zh-TW', { timeZone: 'Asia/Taipei' }).format(
    new Date(snapshot.fetched_at ?? snapshot.imported_at),
  )
})

function setSource(name: string, features: Feature[]) {
  map?.getSource<GeoJSONSource>(name)?.setData({ type: 'FeatureCollection', features })
}

watch(result, (route) => {
  setSource('route-highlights', route?.highlights?.features ?? [])
  if (!map || !mapReady.value) return
  map.setPaintProperty('facilities', 'circle-opacity', route ? .24 : .8)
  map.setPaintProperty('facilities', 'circle-stroke-opacity', route ? .24 : 1)
  map.setPaintProperty('walkways-fill', 'fill-opacity', route ? .11 : ['case', ['==', ['get', 'kind'], '13'], .5, .32])
  map.setPaintProperty('walkways-outline', 'line-opacity', route ? .36 : .86)
  map.setPaintProperty('slope-lines', 'line-opacity', route ? .35 : 1)
  map.setPaintProperty('slope-markers', 'icon-opacity', route ? .36 : 1)
})

function facilityPosition(hit: MapGeoJSONFeature): Coordinate {
  const source = visibleFacilities.features.find(item => item.id === hit.id)
  return (source?.geometry.coordinates ?? (hit.geometry as Point).coordinates) as Coordinate
}

function updatePins() {
  setSource('pins', (['start', 'end'] as const).flatMap((endpoint) => {
    const coordinates = planning.value
      ? endpoints[endpoint]
      : endpoint === 'end' ? browsePlace.value?.coordinates : null
    return coordinates ? [{
      type: 'Feature' as const,
      geometry: { type: 'Point' as const, coordinates },
      properties: { endpoint, current: endpoint === 'start' && startFromLocation.value },
    }] : []
  }))
}

function invalidateRoute() {
  stopNavigation()
  routeRequest?.abort()
  routeRequest = undefined
  busy.value = false
  routeOptions.value = {}
  result.value = null
  setSource('route', [])
  setSource('route-access-points', [])
  setSource('unverified-walkways', [])
  selectedStep.value = null
  setSource('selected-step', [])
}

function setEndpoint(endpoint: Endpoint, point: Coordinate, fromLocation = false, name = '') {
  if (endpoint === 'start') {
    locationRequest++
    locating.value = false
    locationMessage.value = ''
    startFromLocation.value = fromLocation
  }
  invalidateRoute()
  endpoints[endpoint] = point
  inspectionPopup?.remove()
  endpointNames[endpoint] = name
  placeQuery.value = ''
  selecting.value = null
  mapPicking.value = false
  error.value = ''
  failedEndpoint.value = null
  sheetLevel.value = 1
  updatePins()
}

function useCurrentLocation() {
  if (locating.value) return
  locationMessage.value = ''
  if (!window.isSecureContext) {
    locationMessage.value = '定位需要 HTTPS 或 localhost，請先在地圖上選起點。'
    return
  }
  if (!navigator.geolocation) {
    locationMessage.value = '瀏覽器不支援定位，請在地圖上選起點。'
    return
  }

  const request = ++locationRequest
  searchInput.value?.blur()
  locating.value = true
  navigator.geolocation.getCurrentPosition(({ coords }) => {
    if (request !== locationRequest) return
    locating.value = false
    const point: Coordinate = [coords.longitude, coords.latitude]
    const bounds = metadata.value?.coverage
    if (bounds && (point[0] < bounds[0] || point[0] > bounds[2] || point[1] < bounds[1] || point[1] > bounds[3])) {
      locationMessage.value = '目前位置超出服務範圍，請在臺北地圖上選起點。'
      return
    }
    if (planning.value) {
      setEndpoint('start', point, true)
    } else {
      setBrowsePlace({ name: '目前位置', address: '', coordinates: point, is_road: false })
    }
    focusPlaceOnMap(point)
  }, ({ code }) => {
    if (request !== locationRequest) return
    locating.value = false
    locationMessage.value = code === 1
      ? '瀏覽器尚未允許定位，你可以改在地圖上選起點。'
      : code === 3
        ? '定位逾時。若使用 iOS 模擬器，請先在「Features → Location」設定臺北測試座標。'
        : '裝置目前未提供位置。若使用 iOS 模擬器，請先設定模擬位置。'
  }, { enableHighAccuracy: false, timeout: 18000, maximumAge: 15000 })
}

function focusSearch() {
  showLayers.value = false
  mapPicking.value = false
  if (planning.value && !selecting.value) selecting.value = 'end'
}

function editEndpoint(endpoint: Endpoint) {
  if (endpoint === 'start' && locating.value) {
    locationRequest++
    locating.value = false
  }
  selecting.value = endpoint
  mapPicking.value = false
  placeQuery.value = ''
  inspectionPopup?.remove()
  sheetLevel.value = 1
  searchInput.value?.focus()
}

function editFailedEndpoint(endpoint: Endpoint) {
  editEndpoint(endpoint)
  if (endpoint !== 'start' || !startFromLocation.value) {
    placeQuery.value = endpointNames[endpoint].slice(0, 80)
  }
}

function pickOnMap() {
  if (!planning.value || !selecting.value) return
  searchInput.value?.blur()
  placeQuery.value = ''
  mapPicking.value = true
  sheetLevel.value = 0
}

function cancelSearch() {
  placeQuery.value = ''
  selecting.value = null
  mapPicking.value = false
  searchInput.value?.blur()
}

function setBrowsePlace(place: Place | null, details: FeatureDetail[] = []) {
  browsePlace.value = place
  browseDetails.value = details
  updatePins()
}

function focusPlaceOnMap(point: Coordinate) {
  if (!map) return
  const aboveSheet = planning.value && window.innerWidth < 900 ? -Math.round(window.innerHeight * .18) : 0
  map.easeTo({ center: point, zoom: Math.max(map.getZoom(), 15), offset: [0, aboveSheet], duration: 0 })
}

function choosePlace(place: Place) {
  searchInput.value?.blur()
  if (planning.value) {
    setEndpoint(selecting.value ?? 'end', place.coordinates, false, place.name)
  } else {
    cancelSearch()
    setBrowsePlace(place)
  }
  showLayers.value = false
  focusPlaceOnMap(place.coordinates)
}

function planWithPlace(place: Place, endpoint: Endpoint) {
  locationRequest++
  locating.value = false
  locationMessage.value = ''
  showLayers.value = false
  planning.value = true
  setEndpoint(endpoint, place.coordinates, false, place.name)
  focusPlaceOnMap(place.coordinates)
}

function closePlanning() {
  invalidateRoute()
  cancelSearch()
  locationRequest++
  locating.value = false
  locationMessage.value = ''
  error.value = ''
  failedEndpoint.value = null
  endpoints.start = null
  endpoints.end = null
  endpointNames.start = ''
  endpointNames.end = ''
  startFromLocation.value = false
  planning.value = false
  inspectionPopup?.remove()
  updatePins()
  if (browsePlace.value) focusPlaceOnMap(browsePlace.value.coordinates)
}

async function refreshFacilities() {
  const bounds = map?.getBounds()
  if (!bounds || !mapReady.value) return
  facilitiesRequest?.abort()
  const types = enabledFacilities.value
  setSource('facilities', visibleFacilities.features.filter(item => types.includes(item.properties.kind)))
  facilityMessage.value = ''
  if (!types.length) return
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
    facilityMessage.value = data.truncated ? '請放大地圖查看其餘設施。' : ''
  } catch {
    if (controller.signal.aborted) return
    facilityMessage.value = '設施資料暫時無法載入。'
  }
}

async function refreshWalkways() {
  if (!map || !mapReady.value) return
  walkwaysRequest?.abort()
  const controller = new AbortController()
  walkwaysRequest = controller
  const zoom = map.getZoom()
  const types = enabledWalkways.value.filter(kind => !['11', '12'].includes(kind) || zoom >= 14)
  walkwayMessage.value = types.length < enabledWalkways.value.length ? '放大地圖可查看兩類人行道。' : ''
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
    if (data.truncated) walkwayMessage.value = '放大地圖可查看其餘通行空間。'
  } catch {
    if (controller.signal.aborted) return
    visibleWalkways = []
    setSource('walkways', [])
    walkwayMessage.value = '通行空間圖層暫時無法載入。'
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
        return [{ ...item, properties: { ...properties, label: '坡度點位' } }]
      }
      return [
        item,
        ...[item.geometry.coordinates[0]!, item.geometry.coordinates.at(-1)!].map((coordinates, i): Feature<Point> => ({
          type: 'Feature',
          geometry: { type: 'Point', coordinates },
          properties: { ...properties, label: i === 0 ? '坡段起點' : '坡段終點' },
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

async function searchRoute(mode: RouteMode = selectedMode.value) {
  if (!endpoints.start || !endpoints.end) return
  invalidateRoute()
  const controller = new AbortController()
  routeRequest = controller
  error.value = ''
  failedEndpoint.value = null
  busy.value = true
  cancelSearch()
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
    await selectMode(mode)
  } catch (failure) {
    if (controller.signal.aborted) return
    const detail = (failure as { data?: { detail?: { message?: string; endpoint?: Endpoint } } }).data?.detail
    failedEndpoint.value = detail?.endpoint ?? null
    error.value = detail?.message ?? '暫時無法查詢路線，請稍後再試。'
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
      properties: { kind: 'route-access', label: `${endpointLabel(endpoint)}路網接點`, offset_m: access.offset_m },
    }] : []
  }))
  const routeTracker = tracker.value
  setSource('unverified-walkways', (data.unverified_walkways ?? []).flatMap((span) => {
    const coordinates = routeTracker?.slice(span.at_m, span.end_m)
    return coordinates?.length ? [{
      type: 'Feature' as const,
      geometry: { type: 'LineString' as const, coordinates },
      properties: { kind: 'unverified-walkway', label: '路網步行通道', source: 'OpenStreetMap' },
    }] : []
  }))
  const { LngLatBounds } = await import('maplibre-gl')
  if (result.value !== data) return
  const bounds = new LngLatBounds()
  for (const point of data.route.geometry.coordinates) bounds.extend(point as Coordinate)
  if (data.access_points?.start && endpoints.start) bounds.extend(endpoints.start)
  if (data.access_points?.end && endpoints.end) bounds.extend(endpoints.end)
  const wide = window.innerWidth >= 900
  const padding = wide
    ? { top: 128, bottom: 44, left: 455, right: 45 }
    : { top: 128, bottom: Math.round(window.innerHeight * .52), left: 30, right: 30 }
  if (window.innerHeight > padding.top + padding.bottom + 32) {
    map?.fitBounds(bounds, { padding, maxZoom: 17, duration: 0 })
  } else {
    map?.fitBounds(bounds, { padding: 36, maxZoom: 17, duration: 0 })
  }
}

function stopNavigation() {
  navSession++
  if (locationWatch !== null) navigator.geolocation.clearWatch(locationWatch)
  locationWatch = null
  clearTimeout(freshnessTimer)
  navState.value = 'idle'
  navMessage.value = ''
  progress.value = null
  liveFix.value = null
  setSource('live-position', [])
}

function startNavigation() {
  if (!result.value?.steps?.length || navigating.value) return
  locationMessage.value = ''
  if (!window.isSecureContext || !navigator.geolocation) {
    locationMessage.value = '導航定位需要 HTTPS 或 localhost，並需允許瀏覽器取得位置。'
    return
  }
  const session = ++navSession
  missedFixes = 0
  lastFixTime = 0
  cancelSearch()
  showLayers.value = false
  selectedStep.value = null
  setSource('selected-step', [])
  navState.value = 'waiting'
  navMessage.value = '正在取得導航位置…'
  sheetLevel.value = 0
  locationWatch = navigator.geolocation.watchPosition(({ coords, timestamp }) => {
    if (session !== navSession || !tracker.value || timestamp <= lastFixTime) return
    lastFixTime = timestamp
    clearTimeout(freshnessTimer)
    freshnessTimer = setTimeout(() => {
      if (session !== navSession || navState.value === 'arrived') return
      navState.value = 'waiting'
      navMessage.value = '定位暫時中斷，等待新的位置更新。'
    }, 30000)
    if (coords.accuracy > 45 || Date.now() - timestamp > 25000) {
      navState.value = 'waiting'
      navMessage.value = '定位精度不足，正在等待較準確的位置。'
      return
    }
    const point: Coordinate = [coords.longitude, coords.latitude]
    liveFix.value = point
    setSource('live-position', [{
      type: 'Feature', geometry: { type: 'Point', coordinates: point }, properties: {},
    }])
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
          navMessage.value = '請先前往地圖標示的起點路網接點。'
          return
        }
      }
      missedFixes++
      navState.value = missedFixes >= 2 ? 'offroute' : 'waiting'
      navMessage.value = missedFixes >= 2 ? '目前位置偏離路線，可從此處重新規劃。' : '正在確認你與路線的位置。'
      return
    }
    missedFixes = 0
    progress.value = Math.max(progress.value ?? 0, match.along)
    if (tracker.value.total - match.along < 12 && match.endDistance < 15 && coords.accuracy <= 25) {
      if (locationWatch !== null) navigator.geolocation.clearWatch(locationWatch)
      locationWatch = null
      clearTimeout(freshnessTimer)
      navSession++
      navState.value = 'arrived'
      const endAccess = result.value?.access_points?.end
      navMessage.value = endAccess
        ? `已抵達路網接點，距目的地直線約 ${endAccess.offset_m} 公尺。`
        : '已抵達目的地附近。'
      return
    }
    navState.value = 'active'
    navMessage.value = ''
    map?.jumpTo({ center: point, zoom: Math.max(map.getZoom(), 16) })
  }, ({ code }) => {
    if (session !== navSession) return
    if (code === 1) {
      stopNavigation()
      locationMessage.value = '瀏覽器尚未允許導航定位，請確認網站的位置權限。'
      sheetLevel.value = 1
      return
    }
    navState.value = 'waiting'
    navMessage.value = '目前沒有可用的導航位置，正在等待定位。'
  }, { enableHighAccuracy: true, maximumAge: 2000, timeout: 18000 })
}

async function replan() {
  if (!liveFix.value) return
  setEndpoint('start', liveFix.value, true)
  await searchRoute(selectedMode.value)
  if (result.value) startNavigation()
}

function showManeuver(maneuver: Maneuver, index: number) {
  if (selectedStep.value === index) {
    selectedStep.value = null
    setSource('selected-step', [])
    return
  }
  selectedStep.value = index
  const isTurn = ['left', 'right', 'roundabout', 'uturn'].includes(maneuver.action)
  const from = isTurn ? maneuver.at_m - 8 : maneuver.at_m
  const to = isTurn ? maneuver.at_m + 8 : maneuver.end_m
  const coordinates = tracker.value?.slice(from, to)
  setSource('selected-step', coordinates?.length ? [{
    type: 'Feature', geometry: { type: 'LineString', coordinates }, properties: {},
  }] : [])
  const wide = window.innerWidth >= 900
  if (!wide && sheetLevel.value === 2) sheetLevel.value = 1
  map?.panTo(maneuver.position, { duration: 0, offset: [0, wide ? 0 : -Math.round(window.innerHeight * .14)] })
}

onMounted(async () => {
  try {
    const { Map, AttributionControl, NavigationControl, Popup } = await import('maplibre-gl')
    if (!mapElement.value || mapImportCancelled) return
    map = new Map({
      container: mapElement.value,
      center: [121.548, 25.04],
      zoom: 14,
      minZoom: 10,
      maxBounds: [[121.35, 24.86], [121.75, 25.31]],
      renderWorldCopies: false,
      attributionControl: false,
      style: {
        version: 8,
        sources: {
          basemap: {
            type: 'raster',
            tiles: [config.public.tileUrl],
            tileSize: 256,
            maxzoom: 19,
            attribution: '<a href="https://www.openstreetmap.org/copyright">© OpenStreetMap contributors</a>',
          },
          slopes: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
          walkways: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
          facilities: { type: 'geojson', data: visibleFacilities },
          'route-highlights': { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
          route: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
          'route-access-points': { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
          'unverified-walkways': { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
          'selected-step': { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
          'live-position': { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
          pins: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
        },
        layers: [
          { id: 'background', type: 'background', paint: { 'background-color': '#e5eae3' } },
          { id: 'basemap', source: 'basemap', type: 'raster', paint: { 'raster-saturation': -0.35 } },
          { id: 'walkways-fill', source: 'walkways', type: 'fill',
            filter: ['==', ['geometry-type'], 'Polygon'],
            paint: { 'fill-color': walkwayColor, 'fill-opacity': ['case', ['==', ['get', 'kind'], '13'], 0.5, 0.32] } },
          { id: 'walkways-outline', source: 'walkways', type: 'line',
            filter: ['==', ['geometry-type'], 'Polygon'],
            paint: { 'line-color': walkwayColor, 'line-width': ['case', ['==', ['get', 'kind'], '13'], 2.5, 1.5],
              'line-opacity': 0.86 } },
          { id: 'facilities', source: 'facilities', type: 'circle', paint: {
            'circle-color': facilityColor,
            'circle-radius': ['interpolate', ['linear'], ['zoom'], 13, 2.5, 17, 5],
            'circle-opacity': 0.8, 'circle-stroke-color': '#fff', 'circle-stroke-width': 1,
          } },
          { id: 'route-sidewalk-fill', source: 'route-highlights', type: 'fill',
            filter: ['==', ['get', 'route_context'], 'sidewalk'],
            paint: { 'fill-color': routeColors.sidewalk, 'fill-opacity': .62 } },
          { id: 'route-sidewalk-outline', source: 'route-highlights', type: 'line',
            filter: ['==', ['get', 'route_context'], 'sidewalk'], layout: { 'line-join': 'round' },
            paint: { 'line-color': routeColors.sidewalk, 'line-opacity': .82,
              'line-width': ['interpolate', ['linear'], ['zoom'], 14, 13, 17, 9, 20, 2] } },
          { id: 'guided-sidewalk-fill', source: 'route-highlights', type: 'fill',
            filter: ['==', ['get', 'route_context'], 'guided-sidewalk'],
            paint: { 'fill-color': routeColors.guidedSidewalk, 'fill-opacity': .42 } },
          { id: 'guided-sidewalk-outline', source: 'route-highlights', type: 'line',
            filter: ['==', ['get', 'route_context'], 'guided-sidewalk'], layout: { 'line-join': 'round' },
            paint: { 'line-color': routeColors.guidedSidewalk, 'line-width': 2.5, 'line-dasharray': [2, 1] } },
          { id: 'route-outline', source: 'route', type: 'line', layout: { 'line-join': 'round', 'line-cap': 'round' },
            paint: { 'line-color': '#fff', 'line-width': 10 } },
          { id: 'route', source: 'route', type: 'line', layout: { 'line-join': 'round', 'line-cap': 'round' },
            paint: { 'line-color': routeColors.route, 'line-width': 6 } },
          { id: 'unverified-walkways', source: 'unverified-walkways', type: 'line',
            paint: { 'line-color': '#f0aa32', 'line-width': 5, 'line-dasharray': [2, 1.3] } },
          { id: 'crossings-osm', source: 'walkways', type: 'line',
            filter: ['==', ['get', 'kind'], 'osm-crossing'],
            paint: { 'line-color': '#a020af', 'line-dasharray': [1.5, 1],
              'line-width': ['interpolate', ['linear'], ['zoom'], 12, 2, 17, 4.5] } },
          { id: 'selected-step', source: 'selected-step', type: 'line',
            layout: { 'line-join': 'round', 'line-cap': 'round' },
            paint: { 'line-color': '#c9342a', 'line-width': 7 } },
          { id: 'route-access-points', source: 'route-access-points', type: 'circle', paint: {
            'circle-color': '#fff', 'circle-radius': 6, 'circle-stroke-color': '#087e9a', 'circle-stroke-width': 3,
          } },
          { id: 'slope-lines', source: 'slopes', type: 'line', filter: ['==', ['geometry-type'], 'LineString'],
            paint: { 'line-color': '#a64b18', 'line-width': 3, 'line-dasharray': [1.5, 1] } },
          { id: 'slope-markers', source: 'slopes', type: 'symbol', filter: ['==', ['geometry-type'], 'Point'],
            layout: { 'icon-image': 'slope-marker', 'icon-allow-overlap': true } },
          { id: 'route-ramp-halo', source: 'route-highlights', minzoom: 14, type: 'circle',
            filter: ['==', ['get', 'route_context'], 'ramp'],
            paint: { 'circle-color': routeColors.ramp, 'circle-radius': 11, 'circle-opacity': .26 } },
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
          { id: 'pins', source: 'pins', type: 'circle', paint: {
            'circle-color': ['case', ['boolean', ['get', 'current'], false], '#087e9a',
              ['match', ['get', 'endpoint'], 'start', '#33485c', '#b64c28']],
            'circle-radius': 8, 'circle-stroke-color': '#fff', 'circle-stroke-width': 2.5,
          } },
          { id: 'live-position', source: 'live-position', type: 'circle',
            paint: { 'circle-radius': 10, 'circle-color': '#157cf6', 'circle-stroke-color': '#fff', 'circle-stroke-width': 3 } },
        ],
      },
    })
    map.addControl(new NavigationControl({ showCompass: false }), 'top-right')
    map.addControl(new AttributionControl({ compact: true }), 'bottom-right')
    resizeObserver = new ResizeObserver(() => map?.resize())
    resizeObserver.observe(mapElement.value)
    map.on('error', () => { mapMessage.value = '部分地圖內容暫時無法載入。' })
    map.on('load', () => {
      const icon = document.createElement('canvas')
      icon.width = icon.height = 48
      const ctx = icon.getContext('2d')
      if (ctx && map) {
        ctx.fillStyle = '#a64b18'
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
      updatePins()
      void refreshFacilities()
      void refreshWalkways()
      void refreshSlopes()
    })
    map.on('moveend', () => {
      if (!mapReady.value) return
      void refreshFacilities()
      void refreshWalkways()
      void refreshSlopes()
    })
    map.on('click', (event) => {
      if (!mapReady.value || !map) return
      if (mapPicking.value && selecting.value && !navigating.value) {
        const facilities = map.queryRenderedFeatures(event.point, { layers: ['facilities'] })
        const facility = facilities.find(item => item.properties.kind === 'accessible-parking')
          ?? facilities.find(item => item.properties.kind === '7')
        const point = facility?.geometry.type === 'Point'
          ? facilityPosition(facility)
          : [event.lngLat.lng, event.lngLat.lat] as Coordinate
        setEndpoint(selecting.value, point, false, facility?.properties.name)
        focusPlaceOnMap(point)
        return
      }
      inspectionPopup?.remove()
      const hits = map.queryRenderedFeatures([
        [event.point.x - 4, event.point.y - 4], [event.point.x + 4, event.point.y + 4],
      ], { layers: ['route-slope-markers', 'route-ramps', 'route-sidewalk-fill', 'guided-sidewalk-fill', 'slope-markers', 'slope-lines',
        'route-access-points', 'crossings-osm', 'unverified-walkways', 'facilities', 'walkways-fill', 'walkways-outline'] })
      if (!hits.length) {
        if (!planning.value) setBrowsePlace(null)
        return
      }
      const parking = hits.find(item => item.properties.kind === 'accessible-parking' && item.geometry.type === 'Point')
      const features: FeatureDetail[] = []
      const slopeLabels: Record<string, string> = { up: '上坡', down: '下坡', 'up/down': '有高低差', steep: '陡坡', yes: '有坡度' }
      const shown = new Set<string>()
      for (const { properties } of parking ? [parking, ...hits] : hits) {
        const { kind, name, label, source, width, slope, offset_m, incline, route_context, side, guided } = properties
        const title = route_context === 'sidewalk' || route_context === 'guided-sidewalk' ? String(label)
          : route_context === 'ramp' ? guided ? '指引側無障礙坡道' : '鄰近無障礙坡道'
          : kind === '13' ? '行人穿越道' : kind === '11' ? '實體人行道' : String(label)
        const displayName = typeof name === 'string'
          ? name.replace(/^\d+\s*[-_]\s*/, '').replace(/<br\s*\/?>/gi, '\n').trim()
          : ''
        const lines = [
          typeof width === 'number' && width > 0 ? `寬度（來源數值） ${width}` : '',
          typeof slope === 'number' ? `坡度 ${slope}%`
            : typeof incline === 'string' ? slopeLabels[incline] ?? `坡度 ${incline}` : '',
          kind === 'slope' && guided ? '指引側人行道附近的坡度點' : '',
          side ? `行進方向${side}` : '',
          !guided && (route_context === 'slope' || route_context === 'ramp') ? '位於路線附近，接點通行條件待確認' : '',
          source ? `資料來源 ${source}` : kind === '13' ? '資料來源 臺北市交通局' : '',
          kind === 'unverified-walkway' ? '輪椅通行條件未確認' : '',
          kind === 'route-access' ? `距原選點直線約 ${offset_m} 公尺` : '',
        ].filter(Boolean)
        const key = JSON.stringify([kind, displayName, ...lines])
        if (shown.has(key)) continue
        shown.add(key)
        features.push({ kind, title, name: displayName, lines })
      }
      if (!planning.value) {
        cancelSearch()
        showLayers.value = false
        const hit = parking ?? hits[0]!
        const detail = features[0]!
        const coordinates = hit.geometry.type === 'Point'
          ? parking ? facilityPosition(parking) : hit.geometry.coordinates as Coordinate
          : [event.lngLat.lng, event.lngLat.lat] as Coordinate
        setBrowsePlace({ name: detail.name || detail.title, address: '', coordinates, is_road: false }, features)
        return
      }
      const content = document.createElement('div')
      content.className = 'map-inspection'
      for (const feature of features) {
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
      if (parking?.geometry.type === 'Point' && !navigating.value) {
        const actions = document.createElement('div')
        actions.className = 'parking-actions'
        const coordinates = facilityPosition(parking)
        const place = { name: features[0]!.name || features[0]!.title, address: '', coordinates, is_road: false }
        for (const endpoint of ['start', 'end'] as const) {
          const button = document.createElement('button')
          button.type = 'button'
          button.className = endpoint === 'start' ? 'subtle-button' : 'primary'
          button.textContent = `設為${endpointLabel(endpoint)}`
          button.addEventListener('click', () => planWithPlace(place, endpoint))
          actions.append(button)
        }
        content.append(actions)
      }
      inspectionPopup = new Popup({ offset: 10 }).setLngLat(event.lngLat).setDOMContent(content).addTo(map)
    })
    void $fetch<Metadata>('/api/v1/meta').then(data => { metadata.value = data }).catch(() => {})
  } catch {
    mapMessage.value = '無法開啟互動地圖，請使用支援 WebGL 的瀏覽器。'
  }
})

onBeforeUnmount(() => {
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
  <main class="map-app">
    <div ref="mapElement" class="map" aria-label="臺北市設施地圖" />
    <header v-if="!navigating" class="map-toolbar">
      <form class="map-search" role="search" @submit.prevent="placeResults[0] && choosePlace(placeResults[0])">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
          <circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4 4" />
        </svg>
        <input ref="searchInput" v-model="placeQuery" type="search" maxlength="80" autocomplete="off"
          :aria-label="selecting ? `搜尋${endpointLabel(selecting)}` : '搜尋地點或地址'"
          :placeholder="selecting ? `搜尋${endpointLabel(selecting)}` : '搜尋地點、地址或站點'"
          @focus="focusSearch"
          @keydown.esc.prevent="cancelSearch">
        <button v-if="placeQuery || selecting" type="button" class="subtle-button search-action" @click="cancelSearch">取消</button>
        <button v-else type="button" class="subtle-button search-action" :aria-expanded="showLayers"
          aria-controls="map-layer-settings" @click="showLayers = !showLayers">圖資</button>
      </form>

      <div class="filter-rail" role="group" aria-label="地圖圖資篩選">
        <button type="button" class="filter-chip" :aria-pressed="allLayersSelected"
          @click="enabledLayers = [...allLayerKinds]">全部</button>
        <button v-for="group in layerGroups" :key="group.label" type="button" class="filter-chip"
          :aria-pressed="groupSelected(group.kinds)" @click="toggleLayerGroup(group.kinds)">{{ group.label }}</button>
      </div>

      <div v-if="placeStatus || placeResults.length || (selecting && !mapPicking && !showLayers)" class="toolbar-panel">
        <div v-if="selecting && !mapPicking" class="search-options">
          <button v-if="selecting === 'start'" type="button" class="subtle-button" :disabled="locating || !mapReady"
            @click="useCurrentLocation">{{ locating ? '定位中…' : '目前位置' }}</button>
          <button type="button" class="subtle-button" :disabled="!mapReady" @click="pickOnMap">在地圖選點</button>
        </div>
        <p v-if="placeStatus" class="hint search-status" role="status">{{ placeStatus }}</p>
        <ul v-if="placeResults.length" class="place-results" aria-label="搜尋結果">
          <li v-for="(place, index) in placeResults" :key="index">
            <button type="button" @click="choosePlace(place)">
              <strong>{{ place.name }}</strong>
              <small v-if="place.address">{{ place.address }}</small>
              <small v-else-if="place.is_road">道路參考點</small>
            </button>
          </li>
        </ul>
      </div>

      <section v-if="showLayers" id="map-layer-settings" class="toolbar-panel layer-settings" aria-label="圖資設定">
        <div class="panel-heading">
          <div><h2>圖資設定</h2><small>HowGo</small></div>
          <button type="button" class="subtle-button" @click="showLayers = false">完成</button>
        </div>
        <div v-for="(items, index) in [walkwayCategories, categories]" :key="index" class="map-layers"
          role="group" :aria-label="index === 0 ? '通行空間' : '設施點'">
          <label v-for="item in items" :key="item.kind" class="filter-chip">
            <input v-model="enabledLayers" type="checkbox" :value="item.kind">
            <i :style="{ background: item.color }" aria-hidden="true" />{{ item.label }}
            <small v-if="metadata?.empty_types.some(kind => kind === item.kind)">來源無點位</small>
          </label>
        </div>
        <div class="map-layers">
          <label class="filter-chip"><input v-model="enabledLayers" type="checkbox" value="slope">坡度</label>
        </div>
        <p v-if="walkwayMessage" class="hint" role="status">{{ walkwayMessage }}</p>
        <p v-if="facilityMessage" class="hint" role="status">{{ facilityMessage }}</p>
        <footer>
          <a :href="metadata?.source_url || 'https://data.taipei/dataset/detail?id=2b58f15a-dec6-4b9d-91be-4eaccfda5ae7'">輪行臺北設施資料</a>
          <span v-if="displayedDate"> · {{ displayedDate }}</span>
          <br>
          <a href="https://data.taipei/dataset/detail?id=09504c47-7349-4cab-9ce6-db30f32a392e">臺北市騎樓整平圖資</a>
          <br>
          <a href="https://data.taipei/dataset/detail?id=5a911ea5-1694-4301-808e-e1780d971611">臺北市路邊停車格位</a>
        </footer>
      </section>
      <p v-if="mapPicking && selecting" class="map-feedback" role="status">請在地圖上點選{{ endpointLabel(selecting) }}</p>
      <p v-if="mapMessage" class="map-feedback" role="status">{{ mapMessage }}</p>
      <p v-if="!planning && locationMessage" class="map-feedback" role="status">{{ locationMessage }}</p>
    </header>

    <button v-if="!planning && !navigating" class="locate-control" type="button" :disabled="!mapReady || locating"
      @click="useCurrentLocation">{{ locating ? '定位中…' : '目前位置' }}</button>

    <section v-if="browsePlace && !planning" class="place-card" aria-label="選取的地點">
      <div class="panel-heading">
        <div>
          <p class="eyebrow">{{ browseDetails[0]?.title || (browsePlace.is_road ? '道路參考點' : '地點') }}</p>
          <h2>{{ browsePlace.name }}</h2>
        </div>
        <button class="subtle-button" type="button" @click="setBrowsePlace(null)">關閉</button>
      </div>
      <p v-if="browsePlace.address || browseDetails[0]?.lines.length" class="place-detail">
        {{ browsePlace.address || browseDetails[0]?.lines.join(' · ') }}
      </p>
      <details v-if="browseDetails.length > 1" class="nearby-details">
        <summary>同處其他圖資（{{ browseDetails.length - 1 }}）</summary>
        <ul>
          <li v-for="(detail, index) in browseDetails.slice(1)" :key="index">
            <strong>{{ detail.title }}</strong><small>{{ [detail.name, ...detail.lines].filter(Boolean).join(' · ') }}</small>
          </li>
        </ul>
      </details>
      <div v-if="browseDetails[0]?.kind === 'accessible-parking'" class="parking-actions">
        <button type="button" class="subtle-button" :disabled="!mapReady" @click="planWithPlace(browsePlace, 'start')">設為起點</button>
        <button type="button" class="primary" :disabled="!mapReady" @click="planWithPlace(browsePlace, 'end')">設為終點</button>
      </div>
      <button v-else type="button" class="primary" :disabled="!mapReady" @click="planWithPlace(browsePlace, 'end')">規劃步行路線</button>
    </section>

    <MapSheet v-if="planning" v-model="sheetLevel">
      <template #summary>
        <div v-if="navigating || !hasOptions" class="sheet-summary">
          <template v-if="navigating">
            <div class="sheet-status" aria-live="polite">
              <strong v-if="navState !== 'active'">{{ navMessage }}</strong>
              <template v-else>
                <strong>{{ navigationTitle }}</strong>
                <small v-if="liveGuidance">{{ liveGuidance }}</small>
                <small v-else-if="activeStep">目前路段 · {{ activeStep.instruction }}</small>
              </template>
            </div>
            <button v-if="navState === 'offroute'" class="sheet-action" type="button" @click="replan">重查路線</button>
            <button v-else class="sheet-action" type="button" @click="stopNavigation">結束</button>
          </template>
          <template v-else-if="!hasOptions">
            <div class="sheet-status">
              <p class="eyebrow">步行導航</p>
              <strong>規劃步行行程</strong>
              <small v-if="mapPicking && selecting">請在地圖上選擇{{ endpointLabel(selecting) }}</small>
            </div>
            <button class="subtle-button" type="button" @click="closePlanning">返回</button>
          </template>
        </div>
        <div v-if="!navigating && hasOptions" class="mode-tabs" role="group" aria-label="路線方式">
          <button v-for="mode in routeModes" :key="mode.key" type="button"
            :aria-pressed="selectedMode === mode.key" @click="selectMode(mode.key)">
            <strong>{{ mode.label }}</strong>
            <small>{{ routeOptions[mode.key]?.route
              ? `${minutes(routeOptions[mode.key]!.route!.duration_s)} 分` : '無可用路線' }}</small>
          </button>
        </div>
        <p v-if="locationMessage" class="location-message sheet-location-message" role="status">{{ locationMessage }}</p>
      </template>

      <div v-if="!navigating && !hasOptions" class="planning-controls">
        <div class="point-controls">
          <button v-for="endpoint in (['start', 'end'] as const)" :key="endpoint" type="button"
            class="point-button" :aria-pressed="selecting === endpoint" :disabled="!mapReady"
            @click="editEndpoint(endpoint)">
            <i :class="[endpoint, { current: endpoint === 'start' && startFromLocation }]" aria-hidden="true" />
            <span>
              <small>{{ endpointLabel(endpoint) }}</small>
              <strong>{{ endpoint === 'start' && startFromLocation ? '目前位置' : endpoints[endpoint]
                ? endpointNames[endpoint] || formatCoordinate(endpoints[endpoint]!) : `選擇${endpointLabel(endpoint)}` }}</strong>
            </span>
          </button>
        </div>
        <button v-if="!endpoints.start" type="button" class="subtle-button origin-action"
          :disabled="!mapReady || locating" @click="useCurrentLocation">{{ locating ? '定位中…' : '使用目前位置作為起點' }}</button>
        <button class="primary" type="button" :disabled="!mapReady || !endpoints.start || !endpoints.end || busy"
          @click="searchRoute()">{{ busy ? '規劃中…' : '開始規劃路線' }}</button>
        <p v-if="error" class="error" role="alert">{{ error }}</p>
        <button v-if="failedEndpoint" type="button" class="subtle-button"
          @click="editFailedEndpoint(failedEndpoint)">重選{{ endpointLabel(failedEndpoint) }}</button>
      </div>

      <section v-if="!navigating && hasOptions" class="route-overview" aria-live="polite">
        <div class="overview-title">
          <h2>{{ modeDetails.label }}路線</h2>
          <button type="button" class="subtle-button" @click="invalidateRoute(); sheetLevel = 1">編輯行程</button>
        </div>
        <p v-if="result" class="overview-time"><strong>{{ minutes(result.duration_s) }} 分鐘</strong>
          <span>{{ formatDistance(result.distance_m) }} · 預計 {{ estimatedArrival }} 抵達</span></p>
        <p>{{ modeDetails.description }}</p>
        <ul v-if="routeFacts.length" class="route-facts">
          <li v-for="fact in routeFacts" :key="fact">{{ fact }}</li>
        </ul>
        <p v-if="result" class="hint">摘要依沿線可比對圖資，未覆蓋路段的通行條件待確認。</p>
        <p v-else class="error" role="status">{{ routeOptions[selectedMode]?.error?.message ?? '找不到符合條件的路線。' }}</p>
        <button v-if="result" class="primary" type="button" :disabled="!result.steps?.length"
          @click="startNavigation">開始導航</button>
      </section>

        <section v-if="result" class="results" aria-live="polite">
          <p v-if="result.access_points?.start" class="hint">起點路網接點距原起點直線約 {{ result.access_points.start.offset_m }} 公尺。</p>
          <p v-if="result.access_points?.end" class="hint">路線到藍色空心圓為止，距原目的地直線約 {{ result.access_points.end.offset_m }} 公尺。接點到目的地的通行條件待確認。</p>
          <p v-if="result.unverified_walkways?.length" class="hint">黃虛線為路網步行通道，輪椅通行條件未確認。</p>
          <ul class="route-key" aria-label="路線圖例">
            <template v-for="item in routeKey" :key="item.context">
              <li v-if="item.context === 'route' || result.highlights?.features.some(feature => feature.properties.route_context === item.context)">
                <i :style="{ backgroundColor: item.color }" :class="item.context" aria-hidden="true" />{{ item.label }}
              </li>
            </template>
          </ul>
          <h3 v-if="result.maneuvers?.length">詳細路線</h3>
          <p v-if="result.steps?.some(step => step.guidance)" class="hint">
            左右以行進方向為準，換邊時請使用可通行的路口。
          </p>
          <ol v-if="result.maneuvers?.length" class="route-steps">
            <li v-for="(row, index) in result.maneuvers" :key="index">
              <button type="button" :aria-pressed="selectedStep === index" @click="showManeuver(row, index)">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
                  stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path :d="directionIcons[row.action]" />
                </svg>
                <span>
                  <strong>{{ row.instruction }}<template v-if="row.action === 'straight' || row.action === 'crossing' || row.action === 'stairs'">
                    {{ formatDistance(row.end_m - row.at_m) }}</template></strong>
                  <span v-if="row.note" class="step-guidance">{{ row.note }}</span>
                  <span v-if="row.action === 'straight' && result.unverified_walkways?.some(
                    span => Math.min(span.end_m, row.end_m) - Math.max(span.at_m, row.at_m) >= 8,
                  )" class="step-guidance">含輪椅通行待確認路段</span>
                </span>
              </button>
            </li>
          </ol>
        </section>


    </MapSheet>
  </main>
</template>
