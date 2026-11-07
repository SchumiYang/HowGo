<script setup lang="ts">
/**
 * Accessible mode (uiux_disable_v1/ACCESSIBLE_MODE_FLOW.md). It is the entry screen of the microservice.
 *   destination = Page 1 目的地選擇
 *   arrow       = Page 2 大圖示導航
 *   map         = Page 3 地圖輔助導航
 * Page 2 and Page 3 are two views of the same navigation session. Switching between them never
 * refetches the route or resets progress. The route kind is always wheelchair (backend mode `accessible`).
 */
import type { Feature, LineString } from 'geojson'
import type { GeoJSONSource, Map as MapLibreMap } from 'maplibre-gl'
import { createRouteTracker } from '~/utils/navigation'
import { getFix, locationAvailable, watchFix, type FixError } from '~/utils/geolocation'
import { LOCAL_CJK_FONT, TAIPEI_BOUNDS, collapseAttribution, loadBasemap } from '~/utils/basemap'
import type { Coordinate, Place } from '~/composables/usePlaceSearch'

type View = 'destination' | 'arrow' | 'map'
type Action = 'left' | 'right' | 'straight' | 'roundabout' | 'uturn' | 'arrive' | 'crossing' | 'sidewalk' | 'stairs' | 'advice'
type Maneuver = { action: Action; instruction: string; note?: string; at_m: number; end_m: number; position: Coordinate }
/** What the big arrow shows: backend actions plus angle-refined turns and road bends measured from the geometry. */
type Icon = Action | 'slightLeft' | 'slightRight' | 'sharpLeft' | 'sharpRight' | 'bendLeft' | 'bendRight'
type Bend = { at: number; side: 'left' | 'right'; angle: number }
type Route = { route: Feature<LineString>; distance_m: number; duration_s: number; maneuvers?: Maneuver[] }

const emit = defineEmits<{ exit: []; home: [] }>()
const config = useRuntimeConfig()

/* ---------- View flow & browser history (Back key) ---------- */

const view = ref<View>('destination')
const depth: Record<View, number> = { destination: 0, arrow: 1, map: 2 }
let expectedPops = 0

function go(next: View) {
  const diff = depth[next] - depth[view.value]
  for (let i = 0; i < diff; i++) history.pushState({ howgo: 'accessible' }, '')
  if (diff < 0) {
    expectedPops++
    history.go(diff)
  }
  view.value = next
}

function onPopState() {
  if (expectedPops > 0) {
    expectedPops--
    return
  }
  if (view.value === 'map') closeMap(false)
  else if (view.value === 'arrow') endSession()
  else emit('home')
}

/* ---------- Page 1 目的地選擇 ---------- */

const { query, results, status: searchStatus } = usePlaceSearch()
const { remember } = useRecentPlaces()
const input = useTemplateRef<HTMLInputElement>('input')
const destination = shallowRef<Place | null>(null)
const phase = ref<'idle' | 'locating' | 'routing'>('idle')
const failure = ref('')
let attempt = 0
/** Background fix taken when Page 1 opens: lets results show distance and saves a wait when planning. */
const here = shallowRef<{ at: Coordinate; time: number } | null>(null)
const metersBetween = ([ax, ay]: Coordinate, [bx, by]: Coordinate) =>
  111195 * Math.hypot((bx - ax) * Math.cos(ay * Math.PI / 180), by - ay)
const distanceLabel = (place: Place) => here.value ? `距離約 ${formatDistance(metersBetween(here.value.at, place.coordinates))}` : ''

function warmUpLocation() {
  if (!locationAvailable()) return
  getFix({ highAccuracy: true, timeout: 20000, maximumAge: 30000 })
    .then(fix => { here.value = { at: [fix.longitude, fix.latitude], time: Date.now() } })
    .catch(() => {})
}

async function choose(place: Place) {
  remember(place)
  input.value?.blur()
  destination.value = place
  query.value = place.name
  await plan()
}

async function plan() {
  const place = destination.value
  if (!place) return
  const run = ++attempt
  failure.value = ''
  if (!locationAvailable()) {
    failure.value = '此環境無法取得目前位置，請開啟定位後再試一次。'
    return
  }
  phase.value = 'locating'
  let start: Coordinate
  if (here.value && Date.now() - here.value.time < 20000) start = here.value.at
  else try {
    const fix = await getFix({ highAccuracy: true, timeout: 20000, maximumAge: 10000 })
    start = [fix.longitude, fix.latitude]
    here.value = { at: start, time: Date.now() }
  } catch (error) {
    if (run !== attempt) return
    phase.value = 'idle'
    failure.value = (error as FixError).code === 1
      ? '沒有定位權限，無法規劃路線。請允許定位後再試一次。'
      : '暫時取得不到目前位置，請到空曠處再試一次。'
    return
  }
  if (run !== attempt) return
  phase.value = 'routing'
  try {
    const data = await $fetch<Route>('/api/v1/routes', {
      method: 'POST',
      body: { start, end: place.coordinates, mode: 'accessible' },
    })
    if (run !== attempt) return
    if (!data.maneuvers?.length) throw new Error('empty')
    phase.value = 'idle'
    startSession(data, start)
  } catch (error) {
    if (run !== attempt) return
    phase.value = 'idle'
    const detail = (error as { data?: { detail?: { message?: string } } }).data?.detail
    failure.value = detail?.message ?? '目前找不到可用的輪椅路線，請稍後再試或換一個目的地。'
  }
}

const busyText = computed(() => phase.value === 'locating' ? '正在取得目前位置…' : phase.value === 'routing' ? '正在規劃輪椅路線…' : '')

/* ---------- Navigation session (shared by Page 2 and Page 3) ---------- */

const route = shallowRef<Route | null>(null)
const progress = ref<number | null>(null)
const liveFix = ref<Coordinate | null>(null)
const navState = ref<'waiting' | 'active' | 'offroute' | 'arrived'>('waiting')
const navNote = ref('')
const previewStep = ref<number | null>(null)
let stopWatch: (() => void) | null = null
let missedFixes = 0
let session = 0

const tracker = computed(() => route.value ? createRouteTracker(route.value.route.geometry.coordinates) : null)
const steps = computed(() => route.value?.maneuvers ?? [])
const isTurn = (action: Action) => ['left', 'right', 'roundabout', 'uturn'].includes(action)
const currentStepIndex = computed(() => {
  const list = steps.value
  if (!list.length) return -1
  const at = progress.value ?? 0
  const index = list.findIndex(row => row.end_m > at + 1 || (isTurn(row.action) && row.at_m >= at - 2))
  return index < 0 ? list.length - 1 : index
})
const shownStepIndex = computed(() => previewStep.value ?? currentStepIndex.value)

/* ---------- Turn angle & road bends from the route geometry ---------- */

/** Signed heading change (degrees, + = right) around `at`, comparing ~`span` m before with ~`span` m after. */
function turnAngle(at: number, span = 12) {
  const t = tracker.value
  if (!t) return 0
  const bearing = (from: number, to: number) => {
    const [ax, ay] = t.pointAt(from) as Coordinate
    const [bx, by] = t.pointAt(to) as Coordinate
    return Math.atan2((bx - ax) * Math.cos(ay * Math.PI / 180), by - ay) * 180 / Math.PI
  }
  const before = bearing(Math.max(0, at - span), Math.max(0, at - 2))
  const after = bearing(Math.min(t.total, at + 2), Math.min(t.total, at + span))
  return ((after - before + 540) % 360) - 180
}

/** Icon for a backend maneuver: left/right are refined into slight / normal / sharp by the measured angle. */
function iconFor(row: Maneuver): Icon {
  if (row.action !== 'left' && row.action !== 'right') return row.action
  const angle = Math.abs(turnAngle(row.at_m))
  const side = row.action === 'left' ? 'Left' : 'Right'
  if (/急轉/.test(row.instruction) || (angle >= 125 && angle < 160)) return `sharp${side}`
  if (angle >= 160) return 'uturn'
  if (/微轉|靠/.test(row.instruction) || (angle >= 15 && angle < 50)) return `slight${side}`
  return row.action
}

/**
 * Bends where the path curves ≥ 35° without a backend turn step (curving sidewalks, road bends, ramps).
 * Scans every 4 m; each run above the threshold yields its peak. Bends within 15 m of another maneuver
 * are dropped because that step already tells the user what to do there.
 */
const bends = computed<Bend[]>(() => {
  const t = tracker.value
  if (!t || t.total < 30) return []
  const found: Bend[] = []
  let peak: Bend | null = null
  for (let at = 15; at <= t.total - 15; at += 4) {
    const angle = turnAngle(at, 15)
    if (Math.abs(angle) >= 35) {
      if (!peak || Math.abs(angle) > Math.abs(peak.angle)) peak = { at, side: angle < 0 ? 'left' : 'right', angle }
    } else if (peak) {
      found.push(peak)
      peak = null
    }
  }
  if (peak) found.push(peak)
  return found.filter(bend => !steps.value.some(row =>
    row.action !== 'straight' && row.action !== 'advice' && Math.abs(row.at_m - bend.at) <= 15))
})

const formatDistance = (meters: number) => meters >= 1000 ? `${(meters / 1000).toFixed(1)} 公里` : `${Math.max(1, Math.round(meters))} 公尺`
/**
 * Headline verb: "左轉，沿忠誠路前進" → "左轉"; the full sentence stays in the detail line. For turns the verb
 * follows the measured angle (iconFor) so the words always match the arrow; "靠左/右前進" is kept as is.
 */
const TURN_WORDS: Partial<Record<Icon, string>> = {
  left: '左轉', right: '右轉', slightLeft: '稍向左轉', slightRight: '稍向右轉',
  sharpLeft: '向左急轉', sharpRight: '向右急轉', uturn: '迴轉',
}
/** The rest of the sentence after the verb ("沿忠誠路二段前進"), else the step note. */
const instructionDetail = (row: Maneuver) => row.instruction.split(/[，,]/).slice(1).join('，') || row.note || ''
function shortInstruction(row: Maneuver) {
  const first = row.instruction.split(/[，,]/)[0] ?? row.instruction
  if ((row.action === 'left' || row.action === 'right') && !first.includes('靠')) return TURN_WORDS[iconFor(row)] ?? first
  return first
}
const stepLength = (row: Maneuver) => row.end_m > row.at_m ? ` ${formatDistance(row.end_m - row.at_m)}` : ''

/** Live guidance for Page 2: the next real action and the distance to it. */
const live = computed<{ action: Icon; title: string; detail: string }>(() => {
  if (navState.value === 'arrived') return { action: 'arrive', title: '已抵達目的地附近', detail: destination.value?.name ?? '' }
  const at = progress.value ?? 0
  const passage = steps.value.find(row => (row.action === 'crossing' || row.action === 'stairs') && row.at_m - 2 <= at && row.end_m > at)
  if (passage) return { action: passage.action, title: passage.instruction, detail: passage.note ?? '請確認可通行後再通過。' }
  const next = steps.value.find(row => row.action !== 'straight' && row.action !== 'advice' && row.action !== 'sidewalk'
    && (row.at_m >= at + 1 || (isTurn(row.action) && row.at_m >= at - 2)))
  const bend = bends.value.find(item => item.at >= at - 3 && (!next || item.at < next.at_m - 10))
  if (bend && bend.at - at <= 60) {
    // Graded by the measured angle: a gentle curve, an unannounced turn, or a near reversal.
    const side = bend.side === 'left' ? '左' : '右'
    const size = Math.abs(bend.angle)
    const [action, what] = size >= 135
      ? ['uturn' as const, `向${side}迴轉`]
      : size >= 60
        ? [bend.side, `${side}轉`]
        : [bend.side === 'left' ? 'bendLeft' as const : 'bendRight' as const, `道路向${side}彎`]
    const remaining = bend.at - at
    return {
      action,
      title: remaining <= 8 ? what : `前進 ${formatDistance(remaining)}後${what}`,
      detail: size >= 60 ? '請沿黃色路線轉向' : '請順著人行道前進',
    }
  }
  if (!next) return { action: 'straight', title: '直行至目的地', detail: '' }
  const remaining = next.at_m - at
  if (next.action === 'arrive') {
    return { action: remaining <= 10 ? 'arrive' : 'straight', title: remaining <= 10 ? '即將抵達目的地' : `前進 ${formatDistance(remaining)}後抵達`, detail: '' }
  }
  const title = remaining <= 8 ? shortInstruction(next) : `前進 ${formatDistance(remaining)}後${shortInstruction(next)}`
  const current = steps.value[currentStepIndex.value]
  return { action: remaining <= 8 || isTurn(next.action) ? iconFor(next) : 'straight', title, detail: instructionDetail(next) || current?.note || '' }
})

/** What Page 2 / Page 3 show: the swipe preview when there is one, else live guidance. */
const card = computed(() => {
  const row = previewStep.value === null ? null : steps.value[previewStep.value]
  if (row) return { action: iconFor(row), title: shortInstruction(row) + stepLength(row), detail: instructionDetail(row) }
  return live.value
})

const statusLine = computed(() => {
  if (previewStep.value !== null) return '預覽中，按「現在位置」回到目前步驟'
  if (navState.value === 'offroute') return '目前位置偏離路線'
  if (navState.value === 'waiting') return navNote.value
  return ''
})

function startSession(data: Route, start: Coordinate) {
  stopSession()
  route.value = data
  liveFix.value = start
  go('arrow')
  beginTracking()
}

/** GPS tracking for the current route. Does not touch the view or history. */
function beginTracking() {
  navState.value = 'waiting'
  navNote.value = '正在確認你與路線的位置…'
  const id = ++session
  stopWatch = watchFix(({ latitude, longitude, accuracy, timestamp }) => {
    if (id !== session || !tracker.value || navState.value === 'arrived') return
    if (accuracy > 45 || Date.now() - timestamp > 25000) {
      navState.value = 'waiting'
      navNote.value = '定位精度不足，正在等待較準確的位置。'
      return
    }
    const point: Coordinate = [longitude, latitude]
    liveFix.value = point
    const match = tracker.value.match(point, progress.value)
    if (match.distance > Math.max(24, accuracy * 1.1)) {
      const routeStart = route.value?.route.geometry.coordinates[0] as Coordinate | undefined
      if (progress.value === null && routeStart && metersBetween(point, routeStart) <= 150) {
        navState.value = 'waiting'
        navNote.value = `請先前往路線起點，約 ${formatDistance(metersBetween(point, routeStart))}（地圖上黃線的開頭）`
        return
      }
      missedFixes++
      navState.value = missedFixes >= 2 ? 'offroute' : 'waiting'
      navNote.value = '正在確認你與路線的位置…'
      return
    }
    missedFixes = 0
    progress.value = Math.max(progress.value ?? 0, match.along)
    if (tracker.value.total - match.along < 12 && match.endDistance < 15 && accuracy <= 25) {
      navState.value = 'arrived'
      stopWatch?.()
      stopWatch = null
    } else {
      navState.value = 'active'
    }
    if (previewStep.value === null && view.value === 'map') follow()
  }, ({ code }: FixError) => {
    if (id !== session) return
    navState.value = 'waiting'
    navNote.value = code === 1 ? '沒有定位權限，無法更新目前位置。' : '暫時沒有定位訊號，正在等待。'
  })
}

function stopSession() {
  session++
  stopWatch?.()
  stopWatch = null
  missedFixes = 0
  progress.value = null
  previewStep.value = null
  navState.value = 'waiting'
  navNote.value = ''
  if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel()
}

/** Back from Page 2 ends the session and returns to Page 1 with the destination kept in the field. */
function endSession() {
  stopSession()
  route.value = null
  view.value = 'destination'
}

async function replan() {
  const place = destination.value
  if (!place || !liveFix.value) return
  navNote.value = '正在重新規劃…'
  try {
    const data = await $fetch<Route>('/api/v1/routes', {
      method: 'POST',
      body: { start: liveFix.value, end: place.coordinates, mode: 'accessible' },
    })
    if (!data.maneuvers?.length) throw new Error('empty')
    const start = liveFix.value
    stopSession()
    route.value = data
    liveFix.value = start
    beginTracking()
  } catch {
    navNote.value = '重新規劃失敗，請稍後再試。'
  }
}

/** 現在位置: drop any preview and go back to live guidance; also ask for a fresh fix. */
async function backToLive() {
  previewStep.value = null
  if (view.value === 'map') follow(true)
  if (navState.value === 'arrived' || !locationAvailable()) return
  try {
    const fix = await getFix({ highAccuracy: true, timeout: 8000, maximumAge: 0 })
    liveFix.value = [fix.longitude, fix.latitude]
    if (view.value === 'map') follow(true)
  } catch {}
}

/* ---------- Page 3 地圖輔助導航 ---------- */

const mapElement = useTemplateRef<HTMLDivElement>('mapElement')
let map: MapLibreMap | null = null
let mapLoaded = false
const mapError = ref('')

async function openMap() {
  go('map')
  await nextTick()
  if (map) {
    map.resize()
    drawAll()
    follow(true)
    return
  }
  await createMap()
}

function closeMap(viaHistory = true) {
  previewStep.value = null
  if (viaHistory) {
    history.back()
    return
  }
  view.value = 'arrow'
}

async function createMap() {
  try {
    const [{ Map }, basemap] = await Promise.all([
      import('maplibre-gl'),
      // OpenFreeMap's default style (Liberty) as published, with labels 1.3× larger.
      loadBasemap('liberty', config.public.tileUrl, { textScale: 1.3 }),
    ])
    if (!mapElement.value) return
    // Lines go between the basemap's shapes and its labels so street names stay readable over the route.
    const baseShapes = basemap.layers.filter(layer => layer.type !== 'symbol')
    const baseLabels = basemap.layers.filter(layer => layer.type === 'symbol')
    const empty = () => ({ type: 'geojson' as const, data: { type: 'FeatureCollection' as const, features: [] } })
    map = new Map({
      container: mapElement.value,
      center: liveFix.value ?? [121.548, 25.04],
      zoom: 17,
      minZoom: 12,
      maxBounds: TAIPEI_BOUNDS,
      renderWorldCopies: false,
      attributionControl: { compact: true },
      localIdeographFontFamily: LOCAL_CJK_FONT,
      pitchWithRotate: false,
      dragRotate: false,
      style: {
        version: 8,
        glyphs: basemap.glyphs,
        sprite: basemap.sprite,
        sources: {
          ...basemap.sources,
          route: empty(),
          walked: empty(),
          step: empty(),
          facilities: empty(),
          destination: empty(),
          live: empty(),
        },
        layers: [
          ...baseShapes,
          { id: 'route-casing', source: 'route', type: 'line', layout: { 'line-cap': 'round', 'line-join': 'round' },
            paint: { 'line-color': '#0B0D0E', 'line-width': 13 } },
          { id: 'route', source: 'route', type: 'line', layout: { 'line-cap': 'round', 'line-join': 'round' },
            paint: { 'line-color': '#F5BA4B', 'line-width': 8 } },
          { id: 'walked', source: 'walked', type: 'line', layout: { 'line-cap': 'round', 'line-join': 'round' },
            paint: { 'line-color': '#6B7780', 'line-width': 8 } },
          ...baseLabels,
          { id: 'facilities', source: 'facilities', type: 'circle', minzoom: 15,
            paint: { 'circle-color': '#30383D', 'circle-radius': 7, 'circle-stroke-color': '#F0C87C', 'circle-stroke-width': 2 } },
          { id: 'step', source: 'step', type: 'circle',
            paint: { 'circle-color': '#0B0D0E', 'circle-radius': 14, 'circle-stroke-color': '#F5BA4B', 'circle-stroke-width': 4 } },
          { id: 'destination-halo', source: 'destination', type: 'circle',
            paint: { 'circle-color': '#F5BA4B', 'circle-radius': 20, 'circle-opacity': 0.25 } },
          { id: 'destination', source: 'destination', type: 'circle',
            paint: { 'circle-color': '#F5BA4B', 'circle-radius': 10, 'circle-stroke-color': '#0B0D0E', 'circle-stroke-width': 3 } },
          { id: 'live-halo', source: 'live', type: 'circle',
            paint: { 'circle-color': '#FFFFFF', 'circle-radius': 22, 'circle-opacity': 0.18 } },
          { id: 'live', source: 'live', type: 'circle',
            paint: { 'circle-color': '#FFFFFF', 'circle-radius': 9, 'circle-stroke-color': '#F5BA4B', 'circle-stroke-width': 4 } },
        ],
      },
    })
    map.on('load', () => {
      mapLoaded = true
      if (mapElement.value) collapseAttribution(mapElement.value)
      drawAll()
      follow(true)
      void loadFacilities()
    })
    map.on('error', () => {})
  } catch {
    mapError.value = '地圖暫時無法載入，仍可使用大圖示導航。'
  }
}

function setData(name: string, features: Feature[]) {
  if (!map || !mapLoaded) return
  ;(map.getSource(name) as GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features })
}
const point = (coordinates: Coordinate | number[]): Feature => ({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates } })

function drawRoute() {
  const data = route.value
  setData('route', data ? [data.route] : [])
  const end = data?.route.geometry.coordinates.at(-1)
  setData('destination', end ? [point(end)] : [])
}

function drawProgress() {
  const t = tracker.value
  const walked = t && progress.value ? t.slice(0, progress.value) : []
  setData('walked', walked.length > 1 ? [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: walked } }] : [])
  setData('live', liveFix.value ? [point(liveFix.value)] : [])
  const row = steps.value[shownStepIndex.value]
  setData('step', row && row.action !== 'straight' ? [point(row.position)] : [])
}

function drawAll() {
  drawRoute()
  drawProgress()
}

function follow(force = false) {
  if (!map) return
  const target = previewStep.value !== null ? steps.value[previewStep.value]?.position : liveFix.value
  if (!target) return
  if (force) map.easeTo({ center: target, zoom: Math.max(map.getZoom(), 17), duration: 400 })
  else map.easeTo({ center: target, duration: 300 })
}

/** A few facilities around the destination; failures are silent because they are only context. */
async function loadFacilities() {
  const end = route.value?.route.geometry.coordinates.at(-1)
  if (!end) return
  const [lon, lat] = end as Coordinate
  const d = 0.004
  try {
    const data = await $fetch<{ features: Feature[] }>('/api/v1/facilities', {
      query: { bbox: [lon - d, lat - d, lon + d, lat + d].join(','), types: ['1', '7', '9'] },
    })
    setData('facilities', data.features.slice(0, 30))
  } catch {}
}

watch([progress, liveFix, shownStepIndex], drawProgress)
watch(route, () => {
  drawRoute()
  void loadFacilities()
})
watch(previewStep, (value) => {
  if (value !== null) follow(true)
})

/* ---------- Step swipe (Page 3 card) ---------- */

let swipeStart: { x: number; y: number } | null = null
function stepBy(delta: number) {
  const count = steps.value.length
  if (!count) return
  const from = previewStep.value ?? currentStepIndex.value
  const next = Math.min(count - 1, Math.max(0, from + delta))
  previewStep.value = next === currentStepIndex.value ? null : next
}
function onPointerDown(event: PointerEvent) {
  swipeStart = { x: event.clientX, y: event.clientY }
}
function onPointerUp(event: PointerEvent) {
  if (!swipeStart) return
  const dx = event.clientX - swipeStart.x
  const dy = event.clientY - swipeStart.y
  swipeStart = null
  if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy)) stepBy(dx < 0 ? 1 : -1)
}
/** At most 7 dots; the window follows the shown step. */
const dots = computed(() => {
  const count = steps.value.length
  const size = Math.min(7, count)
  const first = Math.min(Math.max(0, shownStepIndex.value - 3), count - size)
  return Array.from({ length: size }, (_, i) => first + i)
})

/* ---------- Arrow artwork ---------- */

/** Left-hand artwork; right-hand variants are drawn mirrored (see `mirrored`). */
const arrowArt: Record<Icon, { stroke?: string; fill?: string }> = {
  left: { stroke: 'M78 110V56a12 12 0 0 0-12-12H40', fill: 'M44 14 8 44l36 30Z' },
  right: { stroke: 'M42 110V56a12 12 0 0 1 12-12h26', fill: 'M76 14l36 30-36 30Z' },
  straight: { stroke: 'M60 112V46', fill: 'M60 8 22 50h76Z' },
  sidewalk: { stroke: 'M60 112V46', fill: 'M60 8 22 50h76Z' },
  advice: { stroke: 'M60 112V46', fill: 'M60 8 22 50h76Z' },
  uturn: { stroke: 'M84 112V50a24 24 0 0 0-48 0v26', fill: 'M36 112 10 74h52Z' },
  roundabout: { stroke: 'M60 112V82M60 82a22 22 0 1 0-22-22', fill: 'M38 28 16 62h44Z' },
  arrive: { fill: 'M60 112S22 78 22 48a38 38 0 0 1 76 0c0 30-38 64-38 64Zm0-50a14 14 0 1 0 0-28 14 14 0 0 0 0 28Z' },
  crossing: { fill: 'M14 18h92v14H14Zm0 26h92v14H14Zm0 26h92v14H14Zm0 26h92v14H14Z' },
  stairs: { stroke: 'M10 108h26V82h26V56h26V30h22' },
  slightLeft: { stroke: 'M76 112V86L53.4 63.4', fill: 'M30.7 40.7L35.0 84.6L74.6 45.0Z' },
  slightRight: { stroke: 'M76 112V86L53.4 63.4', fill: 'M30.7 40.7L35.0 84.6L74.6 45.0Z' },
  sharpLeft: { stroke: 'M86 112V30L52.1 63.9', fill: 'M29.4 86.6L71.9 80.9L35.1 44.1Z' },
  sharpRight: { stroke: 'M86 112V30L52.1 63.9', fill: 'M29.4 86.6L71.9 80.9L35.1 44.1Z' },
  bendLeft: { stroke: 'M76 112V84C76 62 66 48 48.2 39.1', fill: 'M19.6 24.8L36.6 66.8L63.4 13.2Z' },
  bendRight: { stroke: 'M76 112V84C76 62 66 48 48.2 39.1', fill: 'M19.6 24.8L36.6 66.8L63.4 13.2Z' },
}
const mirrored = (icon: Icon) => ['slightRight', 'sharpRight', 'bendRight'].includes(icon)

const LABELS: Record<Icon, string> = {
  left: '左轉', right: '右轉', straight: '直行', sidewalk: '直行', advice: '直行', uturn: '迴轉',
  roundabout: '圓環', arrive: '抵達', crossing: '穿越路口', stairs: '注意階梯',
  slightLeft: '稍向左', slightRight: '稍向右', sharpLeft: '向左急轉', sharpRight: '向右急轉',
  bendLeft: '道路向左彎', bendRight: '道路向右彎',
}

onMounted(() => {
  window.addEventListener('popstate', onPopState)
  warmUpLocation()
  if (!new URLSearchParams(location.search).has('noautofocus')) input.value?.focus()
})

onBeforeUnmount(() => {
  window.removeEventListener('popstate', onPopState)
  stopSession()
  map?.remove()
  map = null
})
</script>

<template>
  <div class="a11y-mode" :data-view="view">
    <!-- ============ Page 1 目的地選擇 ============ -->
    <section v-if="view === 'destination'" class="a11y-destination" aria-labelledby="a11y-title">
      <h1 id="a11y-title" class="a11y-title">去哪裡？</h1>
      <form role="search" class="a11y-form" @submit.prevent="input?.blur()">
        <label for="a11y-input" class="a11y-label">目的地：</label>
        <input id="a11y-input" ref="input" v-model="query" class="a11y-input" type="search" enterkeyhint="search"
          maxlength="80" autocomplete="off" placeholder="請輸入目的地" :disabled="phase !== 'idle'"
          @input="failure = ''">
      </form>

      <div v-if="busyText" class="a11y-busy" role="status" aria-live="polite">
        <span class="a11y-spinner" aria-hidden="true" />{{ busyText }}
      </div>

      <div v-else-if="failure" class="a11y-failure" role="alert">
        <p>{{ failure }}</p>
        <button type="button" class="a11y-button" @click="plan">再試一次</button>
      </div>

      <template v-else-if="query.trim().length >= 2 && query !== destination?.name">
        <p v-if="searchStatus" class="a11y-hint" role="status">{{ searchStatus }}</p>
        <ul v-if="results.length" class="a11y-results" aria-label="搜尋結果">
          <li v-for="(place, index) in results" :key="index">
            <button type="button" @click="choose(place)">
              <strong>{{ place.name }}</strong>
              <small v-if="place.address || place.is_road || here">
                {{ [place.address || (place.is_road ? '道路參考點' : ''), distanceLabel(place)].filter(Boolean).join('・') }}
              </small>
            </button>
          </li>
        </ul>
      </template>

      <button type="button" class="a11y-switch" @click="emit('exit')">切換到一般模式（地圖與多種路線）</button>
    </section>

    <!-- ============ Page 2 / Page 3 shared top bar ============ -->
    <template v-else>
      <header class="a11y-topbar">
        <p class="a11y-dest" :aria-label="`目的地：${destination?.name ?? ''}`">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path :d="arrowArt.arrive.fill" transform="scale(.2)" fill="currentColor" /></svg>
          <span>目的地：</span><strong>{{ destination?.name }}</strong>
        </p>
      </header>

      <!-- ============ Page 2 大圖示導航 ============ -->
      <section v-show="view === 'arrow'" class="a11y-arrow-view" aria-label="大圖示導航">
        <h2 class="a11y-instruction" aria-live="polite">{{ card.title }}</h2>
        <p v-if="card.detail" class="a11y-detail">{{ card.detail }}</p>
        <svg class="a11y-arrow" viewBox="0 0 120 120" role="img" :aria-label="LABELS[card.action]">
          <g :transform="mirrored(card.action) ? 'matrix(-1 0 0 1 120 0)' : undefined">
          <path v-if="arrowArt[card.action].stroke" :d="arrowArt[card.action].stroke" fill="none" stroke="currentColor"
            stroke-width="24" stroke-linejoin="round" :stroke-linecap="card.action === 'stairs' ? 'square' : 'butt'" />
          <path v-if="arrowArt[card.action].fill" :d="arrowArt[card.action].fill" fill="currentColor" fill-rule="evenodd" />
          </g>
        </svg>
        <p v-if="statusLine" class="a11y-status" role="status">{{ statusLine }}</p>
        <button v-if="navState === 'offroute' && previewStep === null" type="button" class="a11y-button" @click="replan">
          從這裡重新規劃
        </button>
      </section>

      <!-- ============ Page 3 地圖輔助導航 ============ -->
      <section v-show="view === 'map'" class="a11y-map-view" aria-label="地圖輔助導航">
        <div ref="mapElement" class="a11y-map" role="img" aria-label="路線地圖：黃色為輪椅路線，白點為目前位置" />
        <p v-if="mapError" class="a11y-failure-inline" role="alert">{{ mapError }}</p>
        <div class="a11y-card" tabindex="0" aria-roledescription="可左右滑動的導航步驟"
          @pointerdown="onPointerDown" @pointerup="onPointerUp" @pointercancel="swipeStart = null"
          @keydown.left.prevent="stepBy(-1)" @keydown.right.prevent="stepBy(1)">
          <div class="a11y-card-main">
            <svg class="a11y-card-icon" viewBox="0 0 120 120" aria-hidden="true">
              <g :transform="mirrored(card.action) ? 'matrix(-1 0 0 1 120 0)' : undefined">
              <path v-if="arrowArt[card.action].stroke" :d="arrowArt[card.action].stroke" fill="none" stroke="currentColor"
                stroke-width="24" stroke-linejoin="round" />
              <path v-if="arrowArt[card.action].fill" :d="arrowArt[card.action].fill" fill="currentColor" fill-rule="evenodd" />
              </g>
            </svg>
            <div>
              <h2 aria-live="polite">{{ card.title }}</h2>
              <p v-if="card.detail">{{ card.detail }}</p>
            </div>
          </div>
          <div class="a11y-card-foot">
            <span class="a11y-dots" aria-hidden="true">
              <i v-for="index in dots" :key="index" :class="{ on: index === shownStepIndex }" />
            </span>
            <span>左右滑動切換步驟（{{ shownStepIndex + 1 }}/{{ steps.length }}）</span>
          </div>
          <p v-if="statusLine" class="a11y-status small" role="status">{{ statusLine }}</p>
        </div>
      </section>

      <nav class="a11y-bottom" aria-label="導航操作">
        <button type="button" @click="backToLive">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19a7 7 0 1 0 0-14 7 7 0 0 0 0 14Zm0-4a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm0-13v3m0 14v3M2 12h3m14 0h3" /></svg>
          現在位置
        </button>
        <button v-if="view === 'arrow'" type="button" @click="openMap">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2Zm0 0v14m6-12v14" /></svg>
          開啟地圖
        </button>
        <button v-else type="button" @click="closeMap()">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2Zm0 0v14m6-12v14" /></svg>
          關閉地圖
        </button>
      </nav>
    </template>
  </div>
</template>

<style scoped>
.a11y-mode {
  --a-bg: #0B0D0E;
  --a-card: #30383D;
  --a-accent: #F5BA4B;
  --a-text: #FCF2DF;
  --a-focus: #F0C87C;
  position: fixed;
  inset: 0;
  z-index: 50;
  display: flex;
  flex-direction: column;
  background: var(--a-bg);
  color: var(--a-accent);
  font-size: 1.125rem;
  line-height: 1.45;
  overflow: hidden;
  /* The global font-synthesis: none leaves CJK text regular-weight on phones whose system CJK font has no bold face. */
  font-synthesis: weight;
}
.a11y-mode :focus-visible { outline: 4px solid var(--a-focus); outline-offset: 3px; }
.a11y-mode button { font: inherit; cursor: pointer; }

/* Page 1 */
.a11y-destination {
  flex: 1;
  overflow-y: auto;
  padding: calc(var(--safe-top, 0px) + 48px) 24px calc(var(--safe-bottom, 0px) + 24px);
  display: flex;
  flex-direction: column;
}
.a11y-title { margin: 0 0 40px; font-size: 2.25rem; font-weight: 800; letter-spacing: .04em; }
.a11y-label { display: block; margin-bottom: 14px; font-size: 1.5rem; font-weight: 800; }
.a11y-input {
  width: 100%;
  min-height: 64px;
  box-sizing: border-box;
  padding: 0 20px;
  border: 3px solid var(--a-accent);
  border-radius: 16px;
  background: var(--a-card);
  color: var(--a-text);
  font: inherit;
  font-size: 1.375rem;
}
.a11y-input::placeholder { color: #C9C2B4; }
.a11y-input:focus { outline: 4px solid var(--a-focus); outline-offset: 2px; }
.a11y-input::-webkit-search-cancel-button { filter: invert(1); }
.a11y-hint { margin: 20px 4px 0; color: var(--a-text); font-size: 1.125rem; }
.a11y-results { list-style: none; margin: 16px 0 0; padding: 0; display: grid; gap: 12px; }
.a11y-results button {
  width: 100%;
  min-height: 64px;
  padding: 12px 18px;
  display: grid;
  gap: 4px;
  text-align: left;
  border: 2px solid #4A555C;
  border-radius: 14px;
  background: var(--a-card);
  color: var(--a-accent);
}
.a11y-results strong { font-size: 1.375rem; }
.a11y-results small { color: var(--a-text); font-size: 1rem; }
.a11y-busy { margin-top: 28px; display: flex; align-items: center; gap: 14px; font-size: 1.5rem; font-weight: 700; color: var(--a-text); }
.a11y-spinner {
  width: 28px; height: 28px; flex: none;
  border: 4px solid #4A555C; border-top-color: var(--a-accent); border-radius: 50%;
  animation: a11y-spin 1s linear infinite;
}
@keyframes a11y-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .a11y-spinner { animation: none; } }
.a11y-failure { margin-top: 28px; }
.a11y-failure p { margin: 0 0 18px; font-size: 1.5rem; font-weight: 700; color: var(--a-text); }
.a11y-button {
  min-height: 60px;
  padding: 0 28px;
  border: 0;
  border-radius: 14px;
  background: var(--a-accent);
  color: var(--a-bg);
  font-size: 1.375rem !important;
  font-weight: 800;
}
.a11y-switch {
  margin-top: auto;
  align-self: center;
  min-height: 48px;
  padding: 0 12px;
  border: 0;
  background: none;
  color: #C9C2B4;
  font-size: 1rem !important;
  text-decoration: underline;
  text-underline-offset: 4px;
}

/* Shared top bar */
.a11y-topbar { flex: none; padding: calc(var(--safe-top, 0px) + 16px) 16px 12px; }
.a11y-dest {
  margin: 0;
  min-height: 64px;
  box-sizing: border-box;
  padding: 12px 20px;
  display: flex;
  align-items: center;
  gap: 6px;
  border: 3px solid var(--a-accent);
  border-radius: 16px;
  background: var(--a-card);
  font-size: 1.375rem;
  font-weight: 800;
}
.a11y-dest svg { width: 26px; height: 26px; flex: none; }
.a11y-dest span { flex: none; color: var(--a-text); }
.a11y-dest strong { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* Page 2 */
.a11y-arrow-view {
  flex: 1;
  min-height: 0;
  padding: 16px 20px;
  display: flex;
  flex-direction: column;
  align-items: center;
  overflow-y: auto;
  text-align: center;
}
.a11y-instruction { margin: 8px 0 0; font-size: 2.25rem; font-weight: 800; letter-spacing: .04em; line-height: 1.3; }
.a11y-detail { margin: 10px 0 0; color: var(--a-text); font-size: 1.25rem; }
.a11y-arrow { flex: 1; width: 100%; max-width: 360px; min-height: 160px; margin: 16px 0; color: var(--a-accent); }
.a11y-status { margin: 0 0 12px; color: var(--a-text); font-size: 1.125rem; }
.a11y-status.small { margin: 8px 0 0; font-size: 1rem; }

/* Page 3 */
.a11y-map-view { position: relative; flex: 1; min-height: 0; display: flex; flex-direction: column; }
.a11y-map { flex: 1; min-height: 0; background: var(--a-bg); }
.a11y-failure-inline { position: absolute; top: 12px; left: 16px; right: 16px; margin: 0; padding: 12px; border-radius: 12px; background: var(--a-card); color: var(--a-text); }
.a11y-card {
  flex: none;
  margin: 12px 16px;
  padding: 16px 18px;
  border: 3px solid var(--a-accent);
  border-radius: 20px;
  background: var(--a-card);
  touch-action: pan-y;
  user-select: none;
}
.a11y-card-main { display: flex; gap: 16px; align-items: center; }
.a11y-card-icon { width: 64px; height: 64px; flex: none; padding: 8px; box-sizing: border-box; border: 2px solid var(--a-accent); border-radius: 14px; background: var(--a-bg); }
.a11y-card h2 { margin: 0; font-size: 1.625rem; font-weight: 800; line-height: 1.3; }
.a11y-card p { margin: 4px 0 0; color: var(--a-text); font-size: 1.0625rem; }
.a11y-card-foot {
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid #4A555C;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  color: var(--a-text);
  font-size: 1rem;
}
.a11y-dots { display: flex; gap: 8px; align-items: center; }
.a11y-dots i { width: 10px; height: 10px; border-radius: 5px; background: #7A6A48; }
.a11y-dots i.on { width: 28px; background: var(--a-accent); }

/* Bottom bar */
.a11y-bottom {
  flex: none;
  display: grid;
  grid-template-columns: 1fr 1fr;
  border-top: 2px solid var(--a-accent);
  background: var(--a-card);
  padding-bottom: var(--safe-bottom, 0px);
}
.a11y-bottom button {
  min-height: 96px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  border: 0;
  background: none;
  color: var(--a-accent);
  font-size: 1.5rem !important;
  font-weight: 800;
}
.a11y-bottom button + button { border-left: 2px solid var(--a-accent); }
.a11y-bottom svg { width: 40px; height: 40px; fill: none; stroke: currentColor; stroke-width: 2.4; stroke-linecap: round; stroke-linejoin: round; }

@media (max-height: 640px) {
  .a11y-instruction { font-size: 1.875rem; }
  .a11y-bottom button { min-height: 76px; }
}
</style>
