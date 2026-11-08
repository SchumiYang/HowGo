import { t } from '../i18n'
import { computed, ref, shallowRef, watch } from 'vue'
import { buildCatalog, CATEGORY_LABEL, placeTarget, QUICK_ACTIONS, quickActionPlaces, type PlaceEntry, type QuickActionId } from '../data/catalog'
import { loadLevelWalls, loadVenue } from '../data/loader'
import type { VenueData } from '../data/types'
import { venueDefaultStart } from '../config'
import { makeFrame, type XY } from '../geo/frame'
import { dist, pointInPolygon } from '../geo/geometry'
import { buildGraph } from '../routing/graph'
import { buildSteps } from '../routing/instructions'
import { LevelGeometry, remapStepIndex, smoothRoute } from '../routing/smooth'
import { findRoute, routeLevels, type Origin, type Route, type RouteFailure } from '../routing/route'

/**
 * Where the start position came from (shown as a chip, CityGeni-style). `wifi` / `pdr` / `fused`
 * come from the live positioning engine (e.g. a reroute from the current position).
 */
export type PositionSource = 'default' | 'url' | 'qr' | 'tap' | 'place' | 'wifi' | 'pdr' | 'fused'

export const SOURCE_LABEL: Record<PositionSource, string> = {
  default: '預設', url: '連結', qr: '定位碼', tap: '地圖點選', place: '地點', wifi: 'WiFi', pdr: '步行推算', fused: '融合',
}

export interface StartPoint {
  level: string
  xy: XY
  /** set when the start is a nav node (default, ?start=, QR code) */
  node?: string
  label: string
  source: PositionSource
}

interface Destination {
  label: string
  places: PlaceEntry[]
}

const FAILURE_TEXT: Record<RouteFailure, string> = {
  'no-graph': '此場館尚無導航資料',
  'start-not-on-graph': '起點附近沒有可通行的路線',
  unreachable: '找不到路線',
}

/** m/s for the ETA; slower when the step-free route (wheelchair users) is selected */
const SPEED = { walk: 1.2, accessible: 1.0 }

export function useNavigator(venueId: string) {
  const data = shallowRef<VenueData | null>(null)
  const loadError = ref<string | null>(null)
  const level = ref('')
  const start = shallowRef<StartPoint | null>(null)
  /** accessibility first: step-free routing is the default */
  const accessibleOnly = ref(true)
  const destination = shallowRef<Destination | null>(null)
  const route = shallowRef<Route | null>(null)
  /** the route as found by the router, before smoothing (re-smoothed when walls load) */
  let rawRoute: Route | null = null
  /** why route last changed: a new route, or the same route re-smoothed with newly loaded walls */
  const routeChange = ref<'new' | 'refined'>('new')
  const routeError = ref<string | null>(null)
  const routeFailure = ref<RouteFailure | null>(null)
  /** false = route preview (destination card), true = turn-by-turn */
  const navigating = ref(false)
  const activeStep = ref(0)

  const frame = computed(() => (data.value ? makeFrame({ origin: data.value.venue.origin, bearingDeg: data.value.venue.bearing_deg }) : null))
  const graph = computed(() => (data.value ? buildGraph(data.value.nav) : null))
  const catalog = computed(() => (data.value ? buildCatalog(data.value) : []))
  const canRoute = computed(() => !!graph.value?.edges.length)
  const levels = computed(() => data.value?.levels.map((l) => l.level) ?? [])
  const navLevels = computed(() => new Set([...(graph.value?.nodes.values() ?? [])].map((n) => n.level)))

  const levelName = (id: string) => levels.value.find((l) => l.id === id)?.name ?? id
  const levelOrdinal = (id: string) => levels.value.find((l) => l.id === id)?.ordinal ?? 0

  const routePlace = computed(() => (route.value && destination.value ? destination.value.places[route.value.targetIndex] : null))
  const destLabel = computed(() => routePlace.value?.name ?? destination.value?.label)
  const steps = computed(() =>
    route.value ? buildSteps(route.value, { levelName, levelOrdinal, destinationName: destLabel.value }) : [],
  )
  const summary = computed(() => {
    const r = route.value
    if (!r) return null
    const speed = accessibleOnly.value ? SPEED.accessible : SPEED.walk
    return { meters: Math.round(r.walkLength), minutes: Math.max(1, Math.round(r.cost / speed / 60)), levels: routeLevels(r) }
  })
  /** compass heading of the first leg on the start level, used for the heading cone placeholder */
  const startHeading = computed(() => {
    const r = route.value
    const v = data.value?.venue
    if (!r || !v || r.points.length < 2) return null
    const a = r.points[0]
    const b = r.points.find((p, i) => i > 0 && p.level === a.level && dist(p.xy, a.xy) > 0.5)
    if (!b) return null
    const localDeg = (Math.atan2(b.xy[0] - a.xy[0], b.xy[1] - a.xy[1]) * 180) / Math.PI // clockwise from local +y
    return (((localDeg + v.bearing_deg) % 360) + 360) % 360
  })

  // any-angle smoothing needs each level's units + walls (cached per LevelData; null until its walls load)
  const geomCache = new WeakMap<object, LevelGeometry>()
  function levelGeometry(levelId: string): LevelGeometry | null {
    const L = data.value?.levels.find((l) => l.level.id === levelId)
    if (!L || !L.wallsLoaded || !L.walls.length) return null
    let g = geomCache.get(L)
    if (!g) geomCache.set(L, (g = new LevelGeometry(L.units, L.walls)))
    return g
  }

  async function load() {
    try {
      const d = await loadVenue(venueId)
      data.value = d
      level.value = d.venue.default_level && d.levels.some((l) => l.level.id === d.venue.default_level) ? d.venue.default_level : d.levels[0]?.level.id ?? ''
      const def = venueDefaultStart(d.venue)
      if (def) setStartNode(def, 'default')
    } catch (e) {
      loadError.value = e instanceof Error ? e.message : String(e)
    }
  }

  const wallRequests = new Map<string, Promise<void>>()
  /** Fetch a level's walls if they aren't loaded yet (only the initial level comes with load()). */
  function ensureWalls(levelId: string): Promise<void> {
    const d = data.value
    if (!d || d.levels.find((l) => l.level.id === levelId)?.wallsLoaded !== false) return Promise.resolve()
    let p = wallRequests.get(levelId)
    if (!p) {
      p = loadLevelWalls(venueId, levelId).then(({ walls, walls3d, seating3d }) => {
        const cur = data.value!
        data.value = {
          ...cur,
          levels: cur.levels.map((l) => (l.level.id === levelId ? { ...l, walls: walls ?? [], walls3d: walls3d ?? [], seating3d: seating3d ?? [], wallsLoaded: true } : l)),
          available: { ...cur.available, walls: cur.available.walls || !!walls, walls3d: cur.available.walls3d || !!walls3d },
        }
      })
      wallRequests.set(levelId, p)
    }
    return p
  }
  /** Background-load the remaining levels' walls (after the first render). */
  const prefetchWalls = () => Promise.all(levels.value.map((l) => ensureWalls(l.id)))
  watch(level, (l) => l && ensureWalls(l))

  /** Human label for a position: a POI at that spot (e.g. 主入口), else the unit containing it. */
  function describePlace(lv: string, xy: XY, node?: string): string {
    const L = data.value?.levels.find((l) => l.level.id === lv)
    const poi = L?.pois.find((p) => (node && p.properties.nav_node === node) || dist(p.geometry.coordinates, xy) < 1.5)
    if (poi?.properties.name) return poi.properties.name
    const u = L?.units.find((u) => {
      const g = u.geometry
      return g.type === 'Polygon' ? pointInPolygon(xy, g.coordinates) : g.coordinates.some((poly) => pointInPolygon(xy, poly))
    })
    const name = u ? u.properties.name || u.properties.ref || CATEGORY_LABEL[u.properties.category] : null
    return `${levelName(lv)} ${name ?? t('地圖上的位置')}`
  }

  function setStartPlace(lv: string, xy: XY, source: PositionSource = 'tap') {
    start.value = { level: lv, xy, label: describePlace(lv, xy), source }
  }

  /** Returns false if the node does not exist. */
  function setStartNode(id: string, source: PositionSource): boolean {
    const n = graph.value?.nodes.get(id)
    if (!n) return false
    start.value = { level: n.level, xy: n.xy, node: id, label: describePlace(n.level, n.xy, id), source }
    return true
  }

  /** (Re)route to the current destination; an active navigation stays active on reroute. */
  function compute() {
    const wasNavigating = navigating.value
    rawRoute = null
    route.value = null
    routeError.value = null
    routeFailure.value = null
    activeStep.value = 0
    navigating.value = false
    const dest = destination.value
    const g = graph.value
    if (!dest) return
    if (!g || !g.edges.length) {
      routeError.value = t(FAILURE_TEXT['no-graph'])
      return
    }
    if (!dest.places.length) {
      routeError.value = t('此場館沒有「{0}」', dest.label)
      return
    }
    const s = start.value
    if (!s) {
      routeError.value = t('請先設定起點：點地圖或掃描定位碼')
      return
    }
    if (!navLevels.value.has(s.level)) {
      const where = [...navLevels.value].map(levelName).join('、')
      routeError.value = t('{0} 尚無導航資料，請在 {1} 設定起點', levelName(s.level), where)
      return
    }
    const origin: Origin = s.node ? { node: s.node } : { place: { level: s.level, xy: s.xy } }
    const res = findRoute(g, origin, dest.places.map(placeTarget), { accessibleOnly: accessibleOnly.value })
    if (res.ok) {
      rawRoute = res.route
      routeChange.value = 'new'
      route.value = smoothRoute(res.route, levelGeometry)
      navigating.value = wasNavigating
    }
    else {
      routeFailure.value = res.reason
      routeError.value = res.reason === 'unreachable' && accessibleOnly.value
        ? t('沒有通往「{0}」的無障礙路線', t(dest.label))
        : t(FAILURE_TEXT[res.reason])
    }
  }

  function navigateTo(places: PlaceEntry[], label: string) {
    navigating.value = false
    destination.value = { label, places }
    compute()
  }

  function navigateQuick(id: QuickActionId) {
    navigateTo(quickActionPlaces(catalog.value, id), QUICK_ACTIONS[id].label)
  }

  function clearRoute() {
    destination.value = null
    rawRoute = null
    route.value = null
    routeError.value = null
    routeFailure.value = null
    navigating.value = false
  }

  // re-route when the start or the accessibility option changes
  watch([start, accessibleOnly], () => {
    if (destination.value) compute()
  })

  // a level's walls finished lazy-loading: re-smooth the active route on the new geometry, keeping
  // navigation and the current step (mapped onto the new step list)
  watch(data, () => {
    const cur = route.value
    if (!rawRoute || !cur) return
    const next = smoothRoute(rawRoute, levelGeometry)
    if (next.points.length === cur.points.length && next.points.every((p, i) => p === cur.points[i])) return
    const oldSteps = steps.value
    const oldIndex = activeStep.value
    routeChange.value = 'refined'
    route.value = next
    activeStep.value = remapStepIndex(oldSteps, oldIndex, steps.value)
  })

  return {
    data, loadError, level, levels, frame, graph, catalog, canRoute,
    start, accessibleOnly, destination, route, routeChange, routeError, routeFailure, routePlace, destLabel, steps, summary, navigating, activeStep, startHeading,
    levelName, levelOrdinal, describePlace, load, prefetchWalls, setStartPlace, setStartNode, navigateTo, navigateQuick, clearRoute,
  }
}

export type Navigator = ReturnType<typeof useNavigator>
