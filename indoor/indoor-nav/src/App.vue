<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, shallowRef, useTemplateRef, watch } from 'vue'
import { parseNavQr, townpass } from './bridge/townpass'
import CategoryButtons from './components/CategoryButtons.vue'
import CompassButton from './components/CompassButton.vue'
import MagCalibrationHint from './components/MagCalibrationHint.vue'
import DebugPanel from './components/DebugPanel.vue'
import DestinationCard from './components/DestinationCard.vue'
import LevelSwitcher from './components/LevelSwitcher.vue'
import MapView from './components/MapView.vue'
import NavigationPanel from './components/NavigationPanel.vue'
import PlaceCard from './components/PlaceCard.vue'
import SearchBox from './components/SearchBox.vue'
import StartChip from './components/StartChip.vue'
import SafetyTip from './components/SafetyTip.vue'
import { LIVE_SOURCE_LABEL, useLivePosition } from './composables/useLivePosition'
import { useNavigator } from './composables/useNavigator'
import { RouteTracker } from './routing/progress'
import { StartLocator } from './composables/startLocator'
import { LevelChangeController } from './composables/levelChange'
import { fetchFloorplan, type FloorplanOverlay } from './map/floorplan'
import { pageTitle } from './config'
import type { PlaceEntry, QuickActionId } from './data/catalog'
import type { MapPick } from './map/IndoorMap'

/**
 * Standalone (main.ts) the page reads ?venue= / ?start= / ?debug=; embedded (IndoorNav.vue in the
 * HowGo app) the host passes props and gets a back control that emits 'close'.
 */
const props = defineProps<{
  venue?: string
  initialLevel?: string
  /** quick action (accessibleToilet | toilet | elevator) or a place id / ref / name to route to */
  destination?: string
  /** embedded in a host app: restore document.title on close (back = the host's / TownPass back key) */
  embedded?: boolean
}>()
defineEmits<{ close: [] }>()

const params = new URLSearchParams(location.search)
const venueId = props.venue || params.get('venue') || 'tianmu'
const debug = params.get('debug') === '1'
const hostTitle = document.title
onBeforeUnmount(() => {
  if (props.embedded) document.title = hostTitle
})

const nav = useNavigator(venueId)
const {
  data, loadError, level, levels, frame, graph, catalog, canRoute, start, accessibleOnly,
  route, routeError, routePlace, destLabel, steps, summary, navigating, activeStep, startHeading, levelName,
} = nav

const mapView = useTemplateRef<InstanceType<typeof MapView>>('mapView')
const sheetEl = useTemplateRef<HTMLElement>('sheet')

const selected = shallowRef<PlaceEntry | null>(null)
const picking = ref(false)
const scanning = ref(false)
const searchQuery = ref('')

// ---- 2D / 3D view (3D default; choice remembered per device) ----
const VIEW_KEY = 'indoor-nav:view'
function readView(): boolean {
  try {
    return localStorage.getItem(VIEW_KEY) !== '2d'
  } catch {
    return true
  }
}
const view3d = ref(readView())
function toggleView() {
  view3d.value = !view3d.value
  try {
    localStorage.setItem(VIEW_KEY, view3d.value ? '3d' : '2d')
  } catch {
    /* storage unavailable (private mode / WebView settings): keep the in-memory choice */
  }
  afterLayout(() => {
    if (route.value) mapView.value?.fitPoints(routePoints(level.value))
    else mapView.value?.fitBuilding()
  })
}
const levelsWithNav = computed(() => [...new Set([...(graph.value?.nodes.values() ?? [])].map((n) => n.level))])

// ---- toast (transient confirmations; errors use the persistent alert in the sheet) ----
const toast = ref('')
let toastTimer: ReturnType<typeof setTimeout> | undefined
function say(msg: string, ms = 3000) {
  toast.value = msg
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => (toast.value = ''), ms)
}

// ---- layout: keep map content clear of the bottom sheet and the level switcher ----
const sheetH = ref(260)
// right: the floating level switcher + locate button column (52 px + 12 px margin + label slack)
const insets = computed(() => ({ top: 20, bottom: sheetH.value + 16, left: 16, right: 84 }))
/** the floating control column (top-right), for the building fit */
const sideEl = useTemplateRef<HTMLElement>('side')
const controlsZone = ref<{ right: number; bottom: number } | null>(null)
let ro: ResizeObserver | undefined
onMounted(() => {
  ro = new ResizeObserver(() => {
    sheetH.value = sheetEl.value?.offsetHeight ?? sheetH.value
    const r = sideEl.value?.getBoundingClientRect()
    if (r) controlsZone.value = { right: window.innerWidth - r.left, bottom: r.bottom }
  })
  if (sheetEl.value) ro.observe(sheetEl.value)
  if (sideEl.value) ro.observe(sideEl.value)
})
onBeforeUnmount(() => ro?.disconnect())

// ---- load ----
onMounted(async () => {
  await nav.load()
  if (!data.value) return
  document.title = pageTitle(data.value.venue)
  const s = params.get('start')
  if (s && !nav.setStartNode(s, 'url')) say(`找不到起點「${s}」`)
  if (start.value) level.value = start.value.level
  if (props.initialLevel && levels.value.some((l) => l.id === props.initialLevel)) level.value = props.initialLevel
  // automatic start position (no QR codes): locate from WiFi unless the link names a start
  if (!s) void beginLocate()
  if (props.destination) routeToDestination(props.destination)
  // refit once the sheet has its real height (the first fit ran with the loading-state sheet)
  afterLayout(() => mapView.value?.fitBuilding(false))
  // 2F walls etc. after the first render
  setTimeout(() => nav.prefetchWalls(), 1500)
})

const routePoints = (lv: string) => route.value?.points.filter((p) => p.level === lv).map((p) => p.xy) ?? []
const afterLayout = (fn: () => void) => requestAnimationFrame(() => requestAnimationFrame(fn))

watch(route, (r) => {
  // a re-smoothed route (walls loaded) keeps the camera where it is
  if (!r || navigating.value || nav.routeChange.value === 'refined') return
  selected.value = null
  level.value = r.points[0].level
  afterLayout(() => mapView.value?.fitPoints(routePoints(level.value)))
})

/** host-provided destination: a quick action key, or a place matched by id / ref / name */
function routeToDestination(d: string) {
  if (d === 'accessibleToilet' || d === 'toilet' || d === 'elevator') return nav.navigateQuick(d)
  const q = d.trim().toLowerCase()
  const p =
    catalog.value.find((c) => c.id.toLowerCase() === q || c.navNode?.toLowerCase() === q) ??
    catalog.value.find((c) => c.ref?.toLowerCase() === q || c.name.toLowerCase() === q)
  if (p) goTo(p)
  else say(`找不到「${d}」`)
}

// ---- actions ----
function onPick(p: MapPick) {
  if (picking.value || p.kind === 'longpress') {
    picking.value = false
    nav.setStartPlace(p.level, p.xy, 'tap')
    if (locator.pending) locator.correct(p.level, p.xy)
    else locator.dismiss()
    if (live.active.value) live.seed(p.xy[0], p.xy[1], p.level)
    finishLocate()
    say(`起點：${start.value?.label}`)
    return
  }
  if (route.value) return
  const key = p.poiId ? `p:${p.poiId}` : p.unitId ? `u:${p.unitId}` : null
  selected.value = (key && catalog.value.find((c) => c.key === key)) || null
}

function onSearch(p: PlaceEntry) {
  selected.value = p
  level.value = p.level
  mapView.value?.flyTo(p.xy, 20)
}

function onCategory(id: QuickActionId) {
  selected.value = null
  if (locator.state === 'estimate') confirmLocate() // choosing a destination accepts the shown position
  nav.navigateQuick(id)
}

function goTo(p: PlaceEntry) {
  selected.value = null // failures show in the home view's alert
  if (locator.state === 'estimate') confirmLocate()
  nav.navigateTo([p], p.name)
}

function startHere(p: PlaceEntry) {
  if (!(p.navNode && nav.setStartNode(p.navNode, 'place'))) nav.setStartPlace(p.level, p.xy, 'place')
  endLocate()
  selected.value = null
  say(`起點：${start.value?.label}`)
}

// ---- live positioning ----
const live = useLivePosition(venueId, () => data.value, () => nav.prefetchWalls())
const { active: liveActive, starting: liveStarting, last: liveLast, stats: liveStats } = live
/** live positioning was started by 開始導航 (stopped again by 結束導航) rather than the user's toggle */
let liveByNav = false
/** keep the map centred on the live dot while navigating; paused when the user pans */
const following = ref(true)
let tracker: RouteTracker | null = null

const TIP_KEY = 'indoor-nav:live-tip-ok'
const showTip = ref(false)
function maybeShowTip() {
  try {
    if (localStorage.getItem(TIP_KEY)) return
  } catch {
    /* storage unavailable: show it (once per page load) */
  }
  showTip.value = true
}
function dismissTip() {
  showTip.value = false
  try {
    localStorage.setItem(TIP_KEY, '1')
  } catch {
    /* ignore */
  }
}

/** Start the engine and seed it at the start point. Returns false outside TownPass. */
async function startLive(headingDeg?: number | null): Promise<boolean> {
  const s = start.value
  if (!s) {
    say('請先設定起點')
    return false
  }
  if (!(await live.start())) {
    say(live.error.value ?? '無法啟動即時定位')
    return false
  }
  live.seed(s.xy[0], s.xy[1], s.level, headingDeg)
  following.value = true
  maybeShowTip()
  return true
}

async function toggleLive() {
  locateOwnsEngine = false
  if (live.active.value) {
    liveByNav = false
    await live.stop()
    return
  }
  liveByNav = false
  await startLive(navigating.value ? localStepHeading(activeStep.value) : null)
}

// ---- automatic start position (locate phase) ----
const locator = reactive(new StartLocator())
/** the engine is running only for the locate phase (stop it once the start is settled) */
let locateOwnsEngine = false
let locateTimer: ReturnType<typeof setInterval> | undefined
let offWifiWatch: (() => void) | undefined

async function beginLocate() {
  const now = Date.now()
  // iOS has no WiFi scan; outside TownPass there is no bridge at all
  if (!townpass.available) return void locator.begin(now, 'unavailable')
  if (!/Android/i.test(navigator.userAgent)) return void locator.begin(now, 'no-wifi')
  if (!(await live.start())) return void locator.begin(Date.now(), 'unavailable')
  locateOwnsEngine = true
  if (!live.stats.value?.maps.wifi) {
    locator.begin(Date.now(), 'no-radiomap')
    return finishLocate()
  }
  locator.begin(Date.now(), true)
  offWifiWatch = townpass.onWifiScan((scan) => {
    if (locator.wifiScan(scan.supported) === 'fallback') finishLocate()
  })
  locateTimer = setInterval(() => {
    if (locator.tick(Date.now()) === 'fallback') finishLocate()
  }, 500)
}

/** 「是」: the WiFi estimate becomes the route start */
function confirmLocate() {
  if (locator.confirm() !== 'confirmed' || !locator.result) return
  const r = locator.result
  nav.setStartPlace(r.level, r.xy, 'wifi')
  live.seed(r.xy[0], r.xy[1], r.level)
  finishLocate()
}

/** the start was set some other way (QR, place card): stop asking */
function endLocate() {
  if (locator.pending) locator.dismiss()
  finishLocate()
}

/** stop the locate-phase machinery; the engine keeps running only if navigation / the user needs it */
function finishLocate() {
  clearInterval(locateTimer)
  offWifiWatch?.()
  offWifiWatch = undefined
  if (locator.state === 'estimate' || locator.state === 'locating') return
  // don't burn battery: confirmed / corrected / fallback end the locate phase's engine
  // (after a handover to navigation the engine is no longer ours)
  if (locateOwnsEngine) {
    locateOwnsEngine = false
    void live.stop()
  }
}

watch(live.last, (u) => {
  if (u && (locator.state === 'locating' || locator.state === 'estimate')) {
    const before = locator.state
    locator.update(u)
    if (before === 'locating' && locator.state === 'estimate') {
      // a small uncertainty circle is framed whole; a huge one (WiFi-only init, p90 ≈ 17 m) would
      // zoom out past the building, so then the building is shown instead
      level.value = u.level
      const r = Math.max(8, u.accuracy_m)
      afterLayout(() => (u.accuracy_m > 15 ? mapView.value?.fitBuilding() : mapView.value?.fitPoints([[u.x - r, u.y - r], [u.x + r, u.y + r]])))
    }
  }
})

/** start-chip content while the locate phase asks the user */
const locateChip = computed(() => {
  if (locator.state === 'locating') return { kind: 'locating' as const }
  if (locator.state === 'estimate' && locator.estimate) {
    const e = locator.estimate
    return { kind: 'estimate' as const, place: `${nav.describePlace(e.level, e.xy)}附近`, acc: Math.max(1, Math.round(e.accuracy_m)) }
  }
  if (locator.state === 'fallback') return { kind: 'fallback' as const, fallbackLabel: start.value?.label ?? '主入口' }
  return null
})

function newTracker() {
  tracker = route.value ? new RouteTracker(route.value, steps.value) : null
  tracker?.setStep(activeStep.value)
}

async function startNavigation() {
  navigating.value = true
  onStep(0)
  newTracker()
  if (locateOwnsEngine) {
    // seamless handover: the engine started for locating keeps running for navigation
    locateOwnsEngine = false
    liveByNav = true
    locator.dismiss()
  }
  if (!live.active.value) {
    // seeding with the first leg's direction removes the start-up heading error
    liveByNav = await startLive(localStepHeading(0))
  } else if (start.value) live.seed(start.value.xy[0], start.value.xy[1], start.value.level, localStepHeading(0))
}

/** Re-plan from the live position (auto on off-route, or the 重新規劃 button). */
function reroute() {
  const u = live.last.value
  if (!u) return
  nav.setStartPlace(u.level, [u.x, u.y], u.source)
}

watch(live.last, (u) => {
  if (!u) return
  if (navigating.value && following.value && u.level === level.value) mapView.value?.follow([u.x, u.y])
  if (!navigating.value || !tracker) return
  for (const e of tracker.update(u)) {
    if (e.type === 'advance') activeStep.value = e.step
    else if (e.type === 'arrive') {
      activeStep.value = e.step
      say(`已抵達 ${destLabel.value ?? '目的地'}`)
    } else if (e.type === 'off-route') {
      say('已偏離路線，已重新規劃')
      reroute()
    }
  }
})

// a new route while navigating (reroute) restarts progress tracking
watch(route, (r) => {
  if (r && navigating.value) newTracker()
})

// ---- optional raster floor plan (admin-calibrated floorplan.json) under the map; off by default ----
const floorplans = new Map<string, Promise<FloorplanOverlay | null>>()
const levelFloorplan = shallowRef<FloorplanOverlay | null>(null)
const showFloorplan = ref(false)
watch(level, async (l) => {
  if (!l) return
  if (!floorplans.has(l)) floorplans.set(l, fetchFloorplan(venueId, l))
  const fp = await floorplans.get(l)!
  if (level.value === l) levelFloorplan.value = fp
}, { immediate: true })

// ---- map rotation ----
const bearing = ref(0)
const rotated = computed(() => Math.abs(((((bearing.value + 180) % 360) + 360) % 360) - 180) > 1.5)
/** 隨行方向: rotate the map so the current step's leg points up (course-up). Default off. */
const courseUp = ref(false)

/** Direction of a walk step's leg, degrees clockwise from local +y (start -> start of the next step). */
function localStepHeading(i: number): number | undefined {
  const s = steps.value[i]
  if (!s || s.kind !== 'walk') return undefined
  const n = steps.value[i + 1]
  const end = n && n.level === s.level ? n.xy : route.value?.points.at(-1)?.xy
  if (!end || (end[0] === s.xy[0] && end[1] === s.xy[1])) return undefined
  return (Math.atan2(end[0] - s.xy[0], end[1] - s.xy[1]) * 180) / Math.PI
}
/** the same as a compass bearing (for rotating the map) */
function stepHeading(i: number): number | undefined {
  const h = localStepHeading(i)
  return h === undefined ? undefined : (data.value?.venue.bearing_deg ?? 0) + h
}

function onStep(i: number) {
  const s = steps.value[i]
  if (!s) return
  const prev = steps.value[i - 1]
  activeStep.value = i
  level.value = s.level
  tracker?.setStep(i)
  // 「已到 2F」: the engine can't detect floors (no barometer on many phones), so re-seed it at
  // the step's start on the new floor (the elevator / stairs exit)
  if (live.active.value && prev && (prev.kind === 'elevator' || prev.kind === 'stairs') && s.level === prev.toLevel) {
    live.seed(s.xy[0], s.xy[1], s.level, localStepHeading(i))
  }
  following.value = true
  mapView.value?.flyTo(s.xy, 20, courseUp.value ? stepHeading(i) : undefined)
}

watch(courseUp, (on) => on && navigating.value && onStep(activeStep.value))

// ---- automatic floor-change detection (engine.onLevelChange: barometer / WiFi level vote) ----
/** last time the user picked a floor by hand: detection then only suggests */
let lastManualPickAt = 0
function onManualLevel(l: string) {
  lastManualPickAt = Date.now()
  suggestLevel.value = null
  level.value = l
}
const suggestLevel = ref<string | null>(null)
const levelToast = ref<{ text: string; undoLabel?: string } | null>(null)
let levelToastTimer: ReturnType<typeof setTimeout> | undefined
const levelCtl = new LevelChangeController({
  context: () => ({ navigating: navigating.value, steps: steps.value, activeStep: activeStep.value, displayedLevel: level.value, lastManualPickAt, now: Date.now() }),
  // as if 「已到 2F」 was pressed (onStep re-seeds the engine at the connector exit)
  advance: (step) => onStep(step),
  undoTo: (u) => {
    activeStep.value = u.step
    level.value = u.level
    tracker?.setStep(u.step)
    live.seed(u.xy[0], u.xy[1], u.level)
    mapView.value?.flyTo(u.xy, 20)
  },
  reroute: (l) => {
    const u = live.last.value
    if (u && u.level === l) nav.setStartPlace(l, [u.x, u.y], u.source)
    else if (u) nav.setStartPlace(l, [u.x, u.y], 'pdr') // snaps to the nearest path on the new floor
    level.value = l
  },
  follow: (l) => {
    suggestLevel.value = null
    level.value = l
  },
  suggest: (l) => (suggestLevel.value = l),
  notify: (text, undoLabel) => {
    levelToast.value = { text, undoLabel }
    clearTimeout(levelToastTimer)
    levelToastTimer = setTimeout(() => (levelToast.value = null), undoLabel ? 10000 : 4000)
  },
})
live.onLevelChange((e) => levelCtl.handle(e))
function undoLevel() {
  levelCtl.undo()
  levelToast.value = null
}

function endRoute() {
  nav.clearRoute()
  tracker = null
  if (liveByNav) {
    liveByNav = false
    void live.stop()
  }
}

/** the locate button alternates: position -> whole building (「顯示全館」) -> position … */
const locateShowsAll = ref(false)
function locate() {
  if (locateShowsAll.value) {
    locateShowsAll.value = false
    mapView.value?.fitBuilding()
    return
  }
  locateShowsAll.value = true
  const u = live.last.value
  if (u) {
    following.value = true
    level.value = u.level
    mapView.value?.flyTo([u.x, u.y], 20)
    return
  }
  if (!start.value) {
    mapView.value?.fitBuilding()
    return
  }
  level.value = start.value.level
  mapView.value?.flyTo(start.value.xy, 20)
}

async function scanQr() {
  if (scanning.value) return
  scanning.value = true
  const r = await townpass.scanQrCode()
  scanning.value = false
  if (!r.ok) {
    say(r.reason === 'unavailable' ? '掃描定位碼需在台北通 App 內使用' : `掃描失敗：${r.message}`)
    return
  }
  const q = parseNavQr(r.data)
  if (!q) return say('無法辨識的定位碼')
  if (q.venue !== venueId) {
    const u = new URL(location.href)
    u.searchParams.set('venue', q.venue)
    u.searchParams.set('start', q.node)
    location.href = u.toString()
    return
  }
  if (nav.setStartNode(q.node, 'qr')) {
    endLocate()
    locate()
    say(`起點：${start.value!.label}`)
  } else say(`找不到定位點「${q.node}」`)
}

const accessibleBlocked = computed(() => accessibleOnly.value && !!routeError.value?.includes('無障礙路線'))
/** the dot: live position when positioning runs, else the chosen start point */
const me = computed(() => {
  const u = live.last.value
  if (u) return { level: u.level, xy: [u.x, u.y] as [number, number], accuracy: u.accuracy_m }
  return start.value ? { level: start.value.level, xy: start.value.xy } : null
})
const meHeading = computed(() => {
  const u = live.last.value
  if (u) return u.heading_deg == null ? null : (data.value?.venue.bearing_deg ?? 0) + u.heading_deg
  return startHeading.value
})
const liveChip = computed(() => {
  const u = live.last.value
  if (!live.active.value) return null
  return u
    ? { label: `定位：${LIVE_SOURCE_LABEL[u.source]} ±${Math.max(1, Math.round(u.accuracy_m))} 公尺`, low: live.lowConfidence.value }
    : { label: '定位中…', low: false }
})
</script>

<template>
  <div class="app" :class="{ embedded }" :style="{ '--sheet-h': sheetH + 'px' }">
    <MapView
      ref="mapView"
      :data="data"
      :frame="frame"
      :level="level"
      :me="me"
      :heading="meHeading"
      :animate-me="liveActive"
      :route="route"
      :dest-label="destLabel"
      :level-name="levelName"
      :insets="insets"
      :view3d="view3d && !!data?.available.walls3d"
      :floorplan="showFloorplan ? levelFloorplan : null"
      :controls-zone="controlsZone"
      @pick="onPick"
      @camera="(c) => (bearing = c.bearing)"
      @userpan="(following = false), (locateShowsAll = false)"
    />

    <div ref="side" class="side">
      <LevelSwitcher v-if="levels.length > 1" :model-value="level" @update:model-value="onManualLevel" :levels="levels" :route-levels="summary?.levels" :levels-with-nav="levelsWithNav" />
      <button v-if="data?.available.walls3d" class="tn-fab view" :aria-pressed="view3d" aria-label="立體檢視（3D）" @click="toggleView">
        <span class="view-mode">{{ view3d ? '3D' : '2D' }}</span>
        <span class="view-cap" aria-hidden="true">{{ view3d ? '立體' : '平面' }}</span>
      </button>
      <button v-if="levelFloorplan" class="tn-fab view" :aria-pressed="showFloorplan" aria-label="顯示建築平面圖底圖" @click="showFloorplan = !showFloorplan">
        <span class="view-mode">圖</span>
        <span class="view-cap" aria-hidden="true">{{ showFloorplan ? '底圖開' : '底圖' }}</span>
      </button>
      <CompassButton v-if="rotated" :bearing="bearing" @reset="mapView?.resetNorth()" />
      <button class="tn-fab" :aria-label="locateShowsAll || !start ? '顯示全館' : '回到目前位置'" @click="locate">
        <svg v-if="locateShowsAll || !start" viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" /></svg>
        <svg v-else viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">
          <circle cx="12" cy="12" r="4" fill="currentColor" />
          <path d="M12 2v3M12 19v3M2 12h3M19 12h3" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
          <circle cx="12" cy="12" r="7.5" fill="none" stroke="currentColor" stroke-width="2" />
        </svg>
      </button>
    </div>

    <div class="top-notes">
      <!-- live positioning / locate phase: an uncalibrated magnetometer (iPhone) sends no samples -->
      <MagCalibrationHint :active="liveActive" />
      <!-- automatic floor detection: announcement (+ undo during navigation) and follow suggestion -->
      <div v-if="levelToast" class="level-toast" role="status" aria-live="polite">
        <span>{{ levelToast.text }}</span>
        <button v-if="levelToast.undoLabel" class="btn" @click="undoLevel">{{ levelToast.undoLabel }}</button>
      </div>
      <button v-if="suggestLevel && suggestLevel !== level" class="level-suggest" @click="(level = suggestLevel), (suggestLevel = null)">
        你目前在 {{ levelName(suggestLevel) }}（點此切換）
      </button>
      <div v-if="canRoute && level && !levelsWithNav.includes(level)" class="level-note" role="status">
        {{ levelName(level) }} 目前僅有平面圖，尚無導航
      </div>
    </div>

    <transition name="fade">
      <div v-if="toast" class="toast" role="status">{{ toast }}</div>
    </transition>

    <section ref="sheet" class="sheet" aria-label="導航面板">
      <div class="grip" aria-hidden="true"></div>

      <div v-if="loadError" class="state" role="alert">
        <b>無法載入場館</b>
        <div class="mut">{{ loadError }}</div>
        <div v-if="venueId !== 'mock'" class="mut">若是新場館資料，請先執行 <code>npm run sync-data</code>。</div>
      </div>
      <div v-else-if="!data" class="state mut" role="status">載入中…</div>

      <template v-else>
        <NavigationPanel
          v-if="route && summary && navigating"
          :dest-label="destLabel"
          :summary="summary"
          :steps="steps"
          :active-step="activeStep"
          v-model:course-up="courseUp"
          :level-name="levelName"
          :live="liveChip"
          :live-starting="liveStarting"
          @step="onStep"
          @end="endRoute"
          @reroute="reroute"
          @live="toggleLive"
        />

        <DestinationCard
          v-else-if="route && summary"
          v-model:accessible-only="accessibleOnly"
          :dest-label="destLabel"
          :dest-level="routePlace?.level"
          :summary="summary"
          :level-name="levelName"
          @start="startNavigation"
          @close="endRoute"
        />

        <div v-else-if="picking" class="picking" role="status">
          <p>請點選地圖上的位置作為起點</p>
          <button class="btn" @click="picking = false">取消</button>
        </div>

        <PlaceCard
          v-else-if="selected"
          :place="selected"
          :level-name="levelName"
          :can-route="canRoute"
          @go="goTo(selected!)"
          @start="startHere(selected!)"
          @close="selected = null"
        />

        <div v-else class="home">
          <div v-if="routeError" class="alert" role="alert">
            <span>{{ routeError }}</span>
            <div class="alert-actions">
              <button v-if="accessibleBlocked" class="btn" @click="accessibleOnly = false">改用一般路線</button>
              <button class="btn text" @click="endRoute">關閉</button>
            </div>
          </div>
          <StartChip
            :start="start"
            :scanning="scanning"
            :live="liveChip"
            :live-starting="liveStarting"
            @pick="picking = true"
            @scan="scanQr"
            @live="toggleLive"
            :locate="locateChip"
            @confirm="confirmLocate"
            @correct="picking = true"
          />
          <CategoryButtons v-if="!searchQuery.trim()" :disabled="!canRoute" @action="onCategory" />
          <p v-if="!canRoute" class="note">此場館尚無導航資料，目前僅顯示平面圖。</p>
          <SearchBox v-model="searchQuery" :catalog="catalog" :level-name="levelName" @select="onSearch" />
        </div>
      </template>
    </section>

    <SafetyTip v-if="showTip" @close="dismissTip" />
    <DebugPanel v-if="debug" :data="data" :venue-id="venueId" :live="liveLast" :live-stats="liveStats" :live-started-at="live.startedAt.value" />
  </div>
</template>

<style scoped>
.app {
  position: relative;
  height: 100%;
  overflow: hidden;
}
.side {
  position: absolute;
  top: calc(var(--tpnav-safe-top) + 12px);
  right: 16px;
  z-index: 9;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
}
/* HowGo .fab: 56 px white circle, primary-700 icon, floating shadow */
.tn-fab {
  width: 56px;
  height: 56px;
  border: 0;
  border-radius: 50%;
  background: var(--tp-white);
  box-shadow: var(--float-shadow);
  display: grid;
  place-items: center;
  color: var(--tp-primary700);
}
.top-notes {
  position: absolute;
  top: calc(var(--tpnav-safe-top) + 12px);
  left: 16px;
  right: 84px;
  z-index: 9;
  display: flex;
  flex-direction: column;
  gap: 8px;
  pointer-events: none;
}
.top-notes > * {
  pointer-events: auto;
}
.level-toast {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 6px 6px 14px;
  border-radius: var(--tpnav-radius-small);
  background: var(--tp-primary700);
  color: var(--tp-white);
  font-weight: 600;
  box-shadow: var(--float-shadow);
}
.level-toast span {
  flex: 1;
}
.level-toast .btn {
  min-height: 44px;
  font-size: 14px;
}
.level-suggest {
  min-height: 48px;
  padding: 8px 14px;
  border: 1px solid var(--tp-primary500);
  border-radius: var(--tpnav-radius-control);
  background: var(--tp-primary50);
  color: var(--tp-primary700);
  font-weight: 600;
  text-align: left;
  box-shadow: var(--float-shadow);
}
.level-note {
  padding: 10px 14px;
  border-radius: var(--tpnav-radius-small);
  background: var(--tp-white);
  box-shadow: var(--float-shadow);
  color: var(--tp-grayscale700);
  font-size: 14px;
  font-weight: 600;
}
.tn-fab.view {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0;
  padding: 0;
  line-height: 1.1;
  text-align: center;
}
.view-mode {
  font-size: 16px;
  font-weight: 600;
}
.view-cap {
  font-size: 12px;
  color: var(--tp-grayscale700);
}
.toast {
  position: absolute;
  left: 50%;
  transform: translateX(-50%);
  bottom: calc(var(--sheet-h) + 14px);
  z-index: 30;
  max-width: calc(100% - 32px);
  padding: 10px 16px;
  border-radius: var(--tpnav-radius-small);
  background: var(--tp-grayscale900);
  color: var(--tp-white);
  text-align: center;
}
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.2s;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
.sheet {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 10;
  /* HowGo .map-sheet: centred, max 560 px, 28 px top radius */
  width: min(100%, 560px);
  margin: 0 auto;
  max-height: 72vh;
  overflow-y: auto;
  padding: 8px 20px calc(var(--tpnav-safe-bottom) + 16px);
  background: var(--tp-white);
  border-radius: 28px 28px 0 0;
  box-shadow: var(--tpnav-sheet-shadow);
}
.grip {
  width: 48px;
  height: 5px;
  margin: 2px auto 12px;
  border-radius: 99px;
  background: var(--tp-grayscale200);
}
.state {
  padding: 8px 0;
}
.home {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.alert {
  padding: 12px;
  border-radius: var(--tpnav-radius-small);
  background: #fdecec;
  border: 1px solid var(--tp-red500);
  color: var(--tp-red600);
  font-weight: 600;
}
.alert-actions {
  display: flex;
  gap: 8px;
  margin-top: 8px;
}
.picking {
  display: flex;
  align-items: center;
  gap: 12px;
}
.picking p {
  flex: 1;
  margin: 0;
  font-size: 18px;
  font-weight: 600;
}
.note {
  margin: 0;
  color: var(--tp-grayscale700);
}
</style>
