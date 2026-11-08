<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { townpass, type BaroSample, type SensorBatch, type Vec3Sample, type WifiScan } from '../../bridge/townpass'
import { venueBaseUrl } from '../../data/loader'
import type { VenueData } from '../../data/types'
import type { XY } from '../../geo/frame'
import { createPositioning, loadPositioningMaps, type Positioning } from '../../positioning/engine'
import type { LevelChange, Magmap, PositionUpdate, Radiomap } from '../../positioning/types'
import { modelFromUserAgent } from '../../survey/session'
import MagCalibrationHint from '../../components/MagCalibrationHint.vue'
import { AdminMap, circlePolygon, type LocalFeature } from '../AdminMap'
import {
  getSessionWalk, listEvals, listSessions, saveEval,
  type EvalCheckpoint, type EvalListItem, type EvalRun, type RecordedWalk, type SessionSummary,
} from '../api'
import { getVenue, venueFrame } from '../venue'
import { dist, errorStats, initialHeading, runId, snap, truthAt } from './evalMath'

const props = defineProps<{ venueId: string; level: string }>()

const SOURCE_LABEL: Record<string, string> = { pdr: '步行推算', wifi: 'WiFi', fused: '融合' }
const HEADINGS: { label: string; deg: number | null }[] = [
  { label: '方向未知', deg: null }, { label: '↑', deg: 0 }, { label: '→', deg: 90 }, { label: '↓', deg: 180 }, { label: '←', deg: 270 },
]

const mapEl = ref<HTMLElement | null>(null)
let amap: AdminMap | null = null
const venue = shallowRef<VenueData | null>(null)
const maps = shallowRef<{ radiomap: Radiomap | null; magmaps: Magmap[] } | null>(null)
const snapTargets = shallowRef<{ id: string; xy: XY }[]>([])
const error = ref('')

const mode = ref<'live' | 'replay'>('live')
const useWifi = ref(true)
const useMag = ref(true)
const snapOn = ref(true)
const heading = ref<number | null>(null)
const truth = ref<{ xy: XY; id: string | null } | null>(null)

// engine state
let engine: Positioning | null = null
let offUpdate: (() => void) | null = null
let offLevel: (() => void) | null = null
/** automatic floor changes of this run (barometer / WiFi), saved with live runs */
const levelChanges = shallowRef<LevelChange[]>([])
const running = ref(false)
const last = shallowRef<PositionUpdate | null>(null)
const engStats = shallowRef<Positioning['stats'] | null>(null)
const track = shallowRef<[number, number, number, number, string][]>([])
const checkpoints = ref<EvalCheckpoint[]>([])
const startedAt = ref(0)
const saveMsg = ref('')
const runs = ref<EvalListItem[]>([])

const mapsLabel = computed(() => {
  const m = maps.value
  if (!m) return '載入中'
  const rm = m.radiomap ? (m.radiomap.synthetic ? 'WiFi 圖（模擬，忽略）' : `WiFi 圖 ${m.radiomap.points.length} 點`) : '無 WiFi 圖'
  const mm = m.magmaps.find((x) => x.level === props.level)
  return `${rm} · ${mm ? `磁場圖 ${mm.cells.length} 格${mm.synthetic ? '（模擬）' : ''}` : '無磁場圖'}`
})
const stats = computed(() => errorStats(checkpoints.value.map((c) => c.error_m)))
const fmt = (v: number | null | undefined, d = 1) => (v === null || v === undefined ? '—' : v.toFixed(d))

// ---------- map ----------
function drawTruth() {
  amap?.set('truth', truth.value ? [{ geometry: { type: 'Point', coordinates: truth.value.xy } }] : [])
}
function drawEngine() {
  if (!amap) return
  const u = last.value
  const onLevel = u && u.level === props.level
  amap.set('est', onLevel ? [{ geometry: { type: 'Point', coordinates: [u.x, u.y] } }] : [])
  amap.set('acc', onLevel ? [{ geometry: circlePolygon([u.x, u.y], u.accuracy_m) }] : [])
  const pts = track.value.map((r) => [r[1], r[2]] as XY)
  amap.set('track', pts.length >= 2 ? [{ geometry: { type: 'LineString', coordinates: pts } }] : [])
}
function drawCheckpoints() {
  const f: LocalFeature[] = []
  for (const c of checkpoints.value) {
    f.push({ geometry: { type: 'Point', coordinates: c.truth }, properties: { role: 'truth' } })
    if (c.estimate) {
      f.push({ geometry: { type: 'Point', coordinates: c.estimate }, properties: { role: 'est' } })
      f.push({ geometry: { type: 'LineString', coordinates: [c.truth, c.estimate] } })
    }
  }
  amap?.set('cp', f)
}

function onTap(xy: XY) {
  if (mode.value !== 'live') return
  truth.value = snapOn.value ? snap(xy, snapTargets.value, 2) : { xy, id: null }
  drawTruth()
}

// ---------- engine ----------
function newEngine(): Positioning | null {
  const v = venue.value
  const m = maps.value
  if (!v || !m) return null
  offUpdate?.()
  offLevel?.()
  const e = createPositioning({
    venueData: v,
    radiomap: useWifi.value ? m.radiomap : null,
    magmap: useMag.value ? m.magmaps : [],
    options: { level: props.level, useWifi: useWifi.value, useMagnetic: useMag.value },
  })
  offUpdate = e.onUpdate((u) => onUpdate(u))
  offLevel = e.onLevelChange((c) => (levelChanges.value = [...levelChanges.value, c]))
  levelChanges.value = []
  track.value = []
  last.value = null
  return e
}

let replayClock = 0
let replayWalk: RecordedWalk | null = null
const replayErrors: number[] = []

function onUpdate(u: PositionUpdate) {
  const t = mode.value === 'replay' ? replayClock : u.t
  last.value = u
  engStats.value = engine ? { ...engine.stats } : null
  const prev = track.value[track.value.length - 1]
  if (!prev || t - prev[0] >= 500) {
    track.value = [...track.value, [t, +u.x.toFixed(2), +u.y.toFixed(2), +u.accuracy_m.toFixed(2), u.source]]
    if (replayWalk) {
      const tr = truthAt(replayWalk, t)
      replayErrors.push(dist(tr, [u.x, u.y]))
      replay.value.truth = tr
      amap?.set('truth', [{ geometry: { type: 'Point', coordinates: tr } }])
    }
  }
  drawEngine()
}

// ---------- raw recording (live runs can be re-run offline: same tuples as survey walks) ----------
const LIVE_START = { sensorIntervalMs: 20, batchMs: 200, wifiIntervalMs: 30000 }
interface RawRec {
  /** barometer: [t, hPa] (~1 Hz on iOS, up to 25 Hz on Android; empty when the phone has none) */
  sensors: { accelerometer: Vec3Sample[]; gyroscope: Vec3Sample[]; magnetometer: Vec3Sample[]; barometer: BaroSample[] }
  /** sensors the bridge reported unavailable (e.g. barometer on the A71) */
  unavailable: string[]
  wifi_scans: { collected_at: number; results: WifiScan['results'] }[]
  /** [t, accuracy] whenever iOS reports magnetometer_accuracy (absent on Android) */
  mag_accuracy: [number, number][]
  offs: (() => void)[]
}
interface SeedRec { t: number; level: string; x: number; y: number; heading_deg: number | null; accuracy_m: number; snapped_id: string | null }
let raw: RawRec | null = null
let ownWifiStream = false
const saveRaw = ref(true)
const rawCounts = ref({ samples: 0, scans: 0 })
const seeds = ref<SeedRec[]>([])
/** ~45 bytes per [t, x, y, z] tuple in JSON, ~2.5 kB per scan */
const rawSizeMB = computed(() => (rawCounts.value.samples * 45 + rawCounts.value.scans * 2500) / 1e6)

function startRaw() {
  const r: RawRec = { sensors: { accelerometer: [], gyroscope: [], magnetometer: [], barometer: [] }, unavailable: [], wifi_scans: [], mag_accuracy: [], offs: [] }
  rawCounts.value = { samples: 0, scans: 0 }
  r.offs.push(
    townpass.onSensorBatch((b) => {
      if (typeof b.magnetometer_accuracy === 'number') {
        const lastAcc = r.mag_accuracy[r.mag_accuracy.length - 1]
        if (!lastAcc || lastAcc[1] !== b.magnetometer_accuracy) r.mag_accuracy.push([Date.now(), b.magnetometer_accuracy])
      }
      for (const k of ['accelerometer', 'gyroscope', 'magnetometer'] as const) {
        const a = b[k]
        if (!a?.length) continue
        r.sensors[k].push(...a)
        rawCounts.value.samples += a.length
      }
      if (b.barometer?.length) {
        r.sensors.barometer.push(...b.barometer)
        rawCounts.value.samples += b.barometer.length
      }
      for (const u of b.unavailable ?? []) if (!r.unavailable.includes(u)) r.unavailable.push(u)
    }),
    townpass.onWifiScan((scan) => {
      if (r.wifi_scans.some((w) => w.collected_at === scan.collected_at)) return
      r.wifi_scans.push({ collected_at: scan.collected_at, results: scan.results })
      rawCounts.value.scans = r.wifi_scans.length
    }),
  )
  raw = r
}

async function startLive() {
  error.value = ''
  engine = newEngine()
  if (!engine) return
  startRaw()
  if (!engine.start(townpass, { ...LIVE_START, wifiIntervalMs: useWifi.value ? LIVE_START.wifiIntervalMs : null })) {
    error.value = '需在台北通 App 內才能讀取感測器（桌面測試可用「重播」）'
    raw?.offs.forEach((off) => off())
    raw = null
    engine = null
    return
  }
  // record WiFi even when the engine ignores it, so the run can be re-run offline with WiFi on
  ownWifiStream = !useWifi.value && townpass.startWifiStream(LIVE_START.wifiIntervalMs)
  running.value = true
  startedAt.value = Date.now()
  checkpoints.value = []
  seeds.value = []
  drawCheckpoints()
  if (truth.value) seedHere()
}

async function stopLive() {
  running.value = false
  await engine?.stop()
  if (ownWifiStream) await townpass.stopWifiStream()
  ownWifiStream = false
  // unsubscribe after the stop acks so the last batch is kept; the data stays in `raw` until the next start
  raw?.offs.forEach((off) => off())
}

function seedHere() {
  if (!engine || !truth.value) return
  engine.setKnownPosition(truth.value.xy[0], truth.value.xy[1], props.level, { accuracyM: 1, headingDeg: heading.value })
  seeds.value.push({ t: Date.now(), level: props.level, x: truth.value.xy[0], y: truth.value.xy[1], heading_deg: heading.value, accuracy_m: 1, snapped_id: truth.value.id })
}

/** live-run extras: start options, seeds and (optionally) the raw bridge data */
function liveExtra(): Record<string, unknown> {
  const extra: Record<string, unknown> = {
    started_at: startedAt.value,
    start: { sensor_interval_ms: LIVE_START.sensorIntervalMs, batch_ms: LIVE_START.batchMs, wifi_interval_ms: LIVE_START.wifiIntervalMs, engine_uses_wifi: useWifi.value },
    seed: seeds.value[0] ?? null,
    seeds: seeds.value,
    level_changes: levelChanges.value,
  }
  if (saveRaw.value && raw) {
    const r = {
      sensors: raw.sensors, wifi_scans: raw.wifi_scans,
      ...(raw.unavailable.length ? { unavailable: raw.unavailable } : {}),
      ...(raw.mag_accuracy.length ? { mag_accuracy: raw.mag_accuracy } : {}),
    }
    extra.raw = { ...r, stats: { samples: rawCounts.value.samples, scans: raw.wifi_scans.length, bytes: JSON.stringify(r).length } }
  }
  return extra
}

function addCheckpoint() {
  if (!truth.value) return
  const u = last.value
  const est: XY | null = u && u.level === props.level ? [+u.x.toFixed(2), +u.y.toFixed(2)] : null
  checkpoints.value.push({
    t: Date.now(), level: props.level, truth: [+truth.value.xy[0].toFixed(2), +truth.value.xy[1].toFixed(2)], estimate: est,
    accuracy_m: u ? +u.accuracy_m.toFixed(2) : null, source: u?.source ?? null, confidence: u ? +u.confidence.toFixed(2) : null,
    error_m: est ? +dist(est, truth.value.xy).toFixed(2) : null,
    estimate_level: u?.level ?? null,
  })
  drawCheckpoints()
  navigator.vibrate?.(40)
}

function undoCheckpoint() {
  checkpoints.value.pop()
  drawCheckpoints()
}

async function deviceInfo(): Promise<Record<string, unknown>> {
  const ua = navigator.userAgent
  const d: Record<string, unknown> = { model: modelFromUserAgent(ua), user_agent: ua }
  const r = await townpass.getDeviceInfo(2000)
  if (r.ok && r.data && typeof r.data === 'object') {
    const m = (r.data as Record<string, unknown>).model
    if (typeof m === 'string') d.model = m
    d.info = r.data
  }
  return d
}

async function save(kind: 'live' | 'replay', cps: EvalCheckpoint[], extra: Record<string, unknown> = {}) {
  saveMsg.value = '儲存中…'
  const device = await deviceInfo()
  const m = maps.value
  const run: EvalRun & Record<string, unknown> = {
    schema: 'tpnav-eval/0',
    run_id: `${runId(new Date(), device.model as string | null)}${kind === 'replay' ? '-replay' : ''}`,
    venue: props.venueId,
    kind,
    device,
    engine: {
      maps: {
        radiomap: useWifi.value && m?.radiomap && !m.radiomap.synthetic ? 'real' : 'none',
        magmap: useMag.value && m?.magmaps.some((x) => x.level === props.level && !x.synthetic) ? 'real' : 'none',
      },
      options: { useWifi: useWifi.value, useMagnetic: useMag.value, level: props.level, heading: heading.value },
      map_versions: { radiomap_built_at: m?.radiomap?.built_at ?? null, magmap_built_at: (m?.magmaps.find((x) => x.level === props.level) as { built_at?: number } | undefined)?.built_at ?? null },
    },
    checkpoints: cps,
    track: track.value,
    summary: errorStats(cps.map((c) => c.error_m)),
    ...extra,
  }
  try {
    await saveEval(run)
    saveMsg.value = `已儲存 ${run.run_id}`
    runs.value = await listEvals()
  } catch (e) {
    saveMsg.value = `儲存失敗：${(e as Error).message}`
  }
}

// ---------- replay ----------
const sessions = ref<SessionSummary[]>([])
const replaySel = ref<{ session: string; walk: number } | null>(null)
const replaySeed = ref(true)
const replaySpeed = ref<number>(0)
const replay = ref<{ running: boolean; progress: number; truth: XY | null; msg: string; timing?: string; stats: ReturnType<typeof errorStats> | null }>({
  running: false, progress: 0, truth: null, msg: '', stats: null,
})
let replayCancel = false

const replayOptions = computed(() =>
  sessions.value.flatMap((s) =>
    s.walk_list.filter((w) => (w.level ?? '1F') === props.level).map((w) => ({
      key: `${s.session_id}|${w.index}`, session: s.session_id, walk: w.index,
      label: `${s.device?.model ?? '?'} · ${w.walk_id} ${w.direction === 'reverse' ? '←' : '→'} · ${((w.t_end - w.t_start) / 1000).toFixed(0)} 秒${s.synthetic ? '（模擬）' : ''}`,
    })),
  ),
)
const replayKey = computed({
  get: () => (replaySel.value ? `${replaySel.value.session}|${replaySel.value.walk}` : ''),
  set: (k: string) => {
    const o = replayOptions.value.find((x) => x.key === k)
    replaySel.value = o ? { session: o.session, walk: o.walk } : null
  },
})

/** walks fetched for replay (one walk per request, never the whole session file); prefetched on selection */
const walkCache = new Map<string, Promise<RecordedWalk>>()
function fetchWalk(session: string, index: number): Promise<RecordedWalk> {
  const k = `${session}|${index}`
  let p = walkCache.get(k)
  if (!p) {
    p = getSessionWalk(session, index).then((r) => r.walk)
    p.catch(() => walkCache.delete(k))
    walkCache.set(k, p)
  }
  return p
}
watch(replaySel, (sel) => sel && void fetchWalk(sel.session, sel.walk).catch(() => {}))
watch([snapOn, mode], () => void amap?.setVisible('plan', snapOn.value && mode.value === 'live'))

async function runReplay() {
  const sel = replaySel.value
  if (!sel || replay.value.running) return
  replay.value = { running: true, progress: 0, truth: null, msg: '下載中…', stats: null }
  replayCancel = false
  try {
    const t0p = performance.now()
    const walk = await fetchWalk(sel.session, sel.walk)
    const tFetch = performance.now()
    replay.value.msg = '建立定位引擎…'
    await new Promise((r) => setTimeout(r, 0))
    engine = newEngine()
    const tEngine = performance.now()
    if (!engine) throw new Error('定位引擎未就緒')
    replayWalk = walk
    replayErrors.length = 0
    amap?.set('truthpath', [{ geometry: { type: 'LineString', coordinates: walk.path } }])
    amap?.set('cp', [])
    if (replaySeed.value) {
      replayClock = walk.t_start
      engine.setKnownPosition(walk.path[0][0], walk.path[0][1], walk.level ?? props.level, { accuracyM: 1, headingDeg: initialHeading(walk.path) })
    }
    const S = walk.sensors
    const t0 = Math.min(S.accelerometer[0]?.[0] ?? walk.t_start, walk.t_start)
    const t1 = Math.max(S.accelerometer[S.accelerometer.length - 1]?.[0] ?? walk.t_end, walk.t_end)
    const cur = { accelerometer: 0, gyroscope: 0, magnetometer: 0 }
    const baro = S.barometer ?? []
    let bi = 0
    const scans = [...(walk.wifi_scans ?? [])].sort((a, b) => a.collected_at - b.collected_at)
    let si = 0
    replay.value.msg = '重播中…'
    for (let t = t0 + 200, n = 0; t <= t1 + 200 && !replayCancel; t += 200, n++) {
      const batch: SensorBatch = {}
      for (const k of Object.keys(cur) as (keyof typeof cur)[]) {
        const arr = S[k] as Vec3Sample[]
        const out: Vec3Sample[] = []
        while (cur[k] < arr.length && arr[cur[k]][0] <= t) out.push(arr[cur[k]++])
        if (out.length) batch[k] = out
      }
      const b0 = bi
      while (bi < baro.length && baro[bi][0] <= t) bi++
      if (bi > b0) batch.barometer = baro.slice(b0, bi)
      replayClock = t
      engine.pushSensorBatch(batch)
      while (si < scans.length && scans[si].collected_at <= t) {
        const s = scans[si++]
        if (useWifi.value) engine.pushWifiScan({ supported: true, status: 'ok', collected_at: s.collected_at, results: s.results })
      }
      replay.value.progress = (t - t0) / (t1 - t0)
      if (replaySpeed.value > 0) await new Promise((r) => setTimeout(r, 200 / replaySpeed.value))
      else if (n % 25 === 0) await new Promise((r) => setTimeout(r, 0))
    }
    replay.value.stats = errorStats(replayErrors)
    const tEnd = performance.now()
    const sec = (ms: number) => (ms / 1000).toFixed(1)
    replay.value.timing = `下載 ${sec(tFetch - t0p)} s · 引擎 ${sec(tEngine - tFetch)} s · 重播 ${sec(tEnd - tEngine)} s`
    replay.value.msg = replayCancel ? '已停止' : '完成'
  } catch (e) {
    replay.value.msg = `重播失敗：${(e as Error).message}`
  } finally {
    replay.value.running = false
  }
}

function saveReplay() {
  const w = replayWalk
  if (!w || !replaySel.value) return
  // checkpoints every ~2 s along the walk, truth from the mark-interpolated path
  const cps: EvalCheckpoint[] = []
  let lastT = -Infinity
  for (const [t, x, y, acc, src] of track.value) {
    if (t - lastT < 2000) continue
    lastT = t
    const tr = truthAt(w, t)
    cps.push({ t, level: w.level ?? props.level, truth: [+tr[0].toFixed(2), +tr[1].toFixed(2)], estimate: [x, y], accuracy_m: acc, source: src, confidence: null, error_m: +dist(tr, [x, y]).toFixed(2) })
  }
  const rec = sessions.value.find((s) => s.session_id === replaySel.value?.session)
  void save('replay', cps, { device: { ...rec?.device, replayed_on: navigator.userAgent }, replay: { session_id: replaySel.value.session, walk_index: replaySel.value.walk, walk_id: w.walk_id, direction: w.direction, seeded: replaySeed.value } })
}

function setMode(m: 'live' | 'replay') {
  if (running.value || replay.value.running) return
  mode.value = m
  replayWalk = null
  track.value = []
  last.value = null
  amap?.set('truthpath', [])
  drawEngine()
  drawTruth()
  drawCheckpoints()
}

// ---------- lifecycle ----------
async function load() {
  try {
    const v = await getVenue(props.venueId)
    venue.value = v
    const plan = await fetch(`${venueBaseUrl(props.venueId)}survey/${encodeURIComponent(props.level)}_plan.geojson`, { cache: 'no-store' }).then((r) => r.json()).catch(() => null)
    const targets: { id: string; xy: XY }[] = []
    for (const f of plan?.features ?? []) if (f.properties?.kind === 'point') targets.push({ id: f.properties.id, xy: f.geometry.coordinates })
    for (const f of v.nav) if (f.geometry?.type === 'Point' && f.properties.kind === 'node' && f.properties.level === props.level) targets.push({ id: f.properties.id, xy: f.geometry.coordinates })
    snapTargets.value = targets
    if (!amap && mapEl.value) {
      amap = new AdminMap(mapEl.value, venueFrame(v))
      amap.onTap = onTap
      new ResizeObserver(() => amap?.resize()).observe(mapEl.value)
    }
    await amap?.setBase(v, props.level)
    amap?.set('plan', targets.map((t) => ({ geometry: { type: 'Point', coordinates: t.xy } })))
    void amap?.setVisible('plan', snapOn.value && mode.value === 'live')
    maps.value = await loadPositioningMaps(props.venueId, v.levels.map((l) => l.level.id))
  } catch (e) {
    error.value = `載入失敗：${(e as Error).message}`
  }
  listSessions().then((s) => (sessions.value = s)).catch(() => {})
  listEvals().then((r) => (runs.value = r)).catch(() => {})
}

watch(() => props.level, async () => {
  if (running.value) await stopLive()
  replayCancel = true
  truth.value = null
  checkpoints.value = []
  setMode(mode.value)
  await load()
})

onMounted(load)
onBeforeUnmount(() => {
  replayCancel = true
  void engine?.stop()
  if (ownWifiStream) void townpass.stopWifiStream()
  raw?.offs.forEach((off) => off())
  offUpdate?.()
  offLevel?.()
  amap?.destroy()
})

const fmtTime = (t: number) => new Date(t).toLocaleString('zh-TW', { hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
</script>

<template>
  <div class="split">
    <div ref="mapEl" class="map" />
    <aside class="side">
      <div v-if="error" class="warn">{{ error }}</div>
      <div class="seg">
        <button :class="{ on: mode === 'live' }" @click="setMode('live')">現場驗證</button>
        <button :class="{ on: mode === 'replay' }" @click="setMode('replay')">重播場勘路線</button>
      </div>
      <div class="muted small">{{ mapsLabel }}</div>
      <div class="toggles">
        <label><input v-model="useWifi" type="checkbox" :disabled="running || replay.running" /> 使用 WiFi</label>
        <label><input v-model="useMag" type="checkbox" :disabled="running || replay.running" /> 使用磁場</label>
      </div>

      <!-- live -->
      <template v-if="mode === 'live'">
        <MagCalibrationHint :active="running" />
        <section>
          <div class="muted small">點地圖標出你「實際」站的位置{{ snapOn ? '（2 m 內吸附到點位 / 節點）' : '' }}</div>
          <div class="toggles"><label><input v-model="snapOn" type="checkbox" /> 吸附</label>
            <span v-if="truth">真值 ({{ truth.xy[0].toFixed(1) }}, {{ truth.xy[1].toFixed(1) }}) {{ truth.id ?? '' }}</span></div>
          <div class="row">
            <span class="muted small">起點方向</span>
            <button v-for="h in HEADINGS" :key="h.label" class="chip" :class="{ on: heading === h.deg }" @click="heading = h.deg">{{ h.label }}</button>
          </div>
          <button v-if="!running" class="big primary" @click="startLive">開始定位{{ truth ? '（以標記點為起點）' : '' }}</button>
          <template v-else>
            <button class="big secondary" :disabled="!truth" @click="addCheckpoint">我在這（記錄檢查點）</button>
            <div class="row">
              <button class="btn-s" :disabled="!truth" @click="seedHere">設為已知位置</button>
              <button class="btn-s" :disabled="!checkpoints.length" @click="undoCheckpoint">撤銷上一點</button>
              <button class="btn-s danger" @click="stopLive">停止</button>
            </div>
          </template>
          <div v-if="last" class="live">
            估計 ({{ last.x.toFixed(1) }}, {{ last.y.toFixed(1) }}) ±{{ last.accuracy_m.toFixed(1) }} m · {{ SOURCE_LABEL[last.source] }} · 信心 {{ last.confidence.toFixed(2) }}
            <small v-if="engStats" class="muted"> · 步數 {{ engStats.steps }} · WiFi {{ engStats.wifiUsed }}/{{ engStats.wifiScans }} · 磁場步 {{ engStats.magSteps }} · 重定位 {{ engStats.relocalizations }}</small>
          </div>
        </section>
        <section>
          <div class="stats">
            <div><b>{{ stats.n }}</b><small>點</small></div>
            <div><b>{{ fmt(stats.median_m) }}</b><small>中位數 m</small></div>
            <div><b>{{ fmt(stats.p90_m) }}</b><small>P90 m</small></div>
            <div><b>{{ fmt(stats.max_m) }}</b><small>最大 m</small></div>
          </div>
          <ol class="cps">
            <li v-for="(c, i) in checkpoints" :key="i">
              {{ c.error_m === null ? '無估計' : `${c.error_m.toFixed(1)} m` }} <small class="muted">· {{ c.source ? SOURCE_LABEL[c.source] : '' }} · ±{{ fmt(c.accuracy_m) }}</small>
            </li>
          </ol>
          <label class="toggles"><input v-model="saveRaw" type="checkbox" /> 一併儲存原始感測資料（可離線重跑）<small v-if="rawCounts.samples" class="muted">· {{ rawCounts.samples }} 筆樣本 · {{ rawCounts.scans }} 次 WiFi · 約 {{ rawSizeMB.toFixed(1) }} MB</small></label>
          <button class="big" :disabled="!checkpoints.length" @click="save('live', checkpoints, liveExtra())">儲存結果</button>
          <div class="muted small">{{ saveMsg }}</div>
        </section>
      </template>

      <!-- replay -->
      <template v-else>
        <section>
          <select v-model="replayKey" class="sel" :disabled="replay.running">
            <option value="">選擇場勘路線…</option>
            <option v-for="o in replayOptions" :key="o.key" :value="o.key">{{ o.label }}</option>
          </select>
          <div class="toggles">
            <label><input v-model="replaySeed" type="checkbox" :disabled="replay.running" /> 已知起點與方向</label>
            <label>速度
              <select v-model.number="replaySpeed" :disabled="replay.running">
                <option :value="1">1×</option><option :value="4">4×</option><option :value="8">8×</option><option :value="0">最快</option>
              </select>
            </label>
          </div>
          <button v-if="!replay.running" class="big primary" :disabled="!replaySel" @click="runReplay">重播</button>
          <button v-else class="big" @click="replayCancel = true">停止（{{ (replay.progress * 100).toFixed(0) }}%）</button>
          <div v-if="replay.timing" class="muted small">{{ replay.timing }}</div>
          <div class="muted small">{{ replay.msg }} — 橘虛線 = 依轉角標記內插的真值路徑，藍線 = 引擎軌跡</div>
          <div v-if="replay.stats" class="stats">
            <div><b>{{ replay.stats.n }}</b><small>樣本</small></div>
            <div><b>{{ fmt(replay.stats.median_m) }}</b><small>中位數 m</small></div>
            <div><b>{{ fmt(replay.stats.p90_m) }}</b><small>P90 m</small></div>
            <div><b>{{ fmt(replay.stats.max_m) }}</b><small>最大 m</small></div>
          </div>
          <button v-if="replay.stats && !replay.running" class="big" @click="saveReplay">儲存重播結果</button>
          <div class="muted small">{{ saveMsg }}</div>
        </section>
      </template>

      <section>
        <h3>歷次驗證</h3>
        <div v-if="!runs.length" class="muted small">尚無紀錄</div>
        <table v-else class="runs">
          <tr><th>時間</th><th>裝置</th><th>WiFi/磁</th><th>n</th><th>中位</th><th>P90</th></tr>
          <tr v-for="r in runs" :key="r.run_id" :title="r.run_id">
            <td>{{ fmtTime(r.mtime) }}<small v-if="r.kind === 'replay'" class="muted"> 重播</small></td>
            <td>{{ (r.device?.model as string) ?? '?' }}</td>
            <td>{{ r.engine?.maps.radiomap === 'real' ? '✓' : '–' }}/{{ r.engine?.maps.magmap === 'real' ? '✓' : '–' }}</td>
            <td>{{ r.summary.n }}</td><td>{{ fmt(r.summary.median_m) }}</td><td>{{ fmt(r.summary.p90_m) }}</td>
          </tr>
        </table>
      </section>
    </aside>
  </div>
</template>

<style scoped>
.split { display: flex; flex-direction: column; height: 100%; min-height: 0; }
.map { flex: 1; min-height: 260px; }
.side { background: var(--tp-white); overflow-y: auto; max-height: 58vh; padding: 8px 12px calc(var(--safe-bottom) + 12px); display: flex; flex-direction: column; gap: 8px; }
@media (min-width: 900px) {
  .split { flex-direction: row; }
  .side { width: 400px; max-height: none; border-left: 1px solid var(--tp-grayscale100); }
}
section { padding: 8px 0; border-top: 1px solid var(--tp-grayscale100); display: flex; flex-direction: column; gap: 8px; }
h3 { margin: 0; font-size: 16px; }
.seg { display: flex; gap: 6px; }
.seg button { flex: 1; padding: 8px; border-radius: 16px; border: 1px solid var(--tp-grayscale200); background: var(--tp-white); font-size: 14px; }
.seg button.on { background: var(--tp-primary500); border-color: var(--tp-primary500); color: var(--tp-white); font-weight: 600; }
.toggles { display: flex; flex-wrap: wrap; gap: 6px 14px; font-size: 14px; align-items: center; }
.row { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
.muted { color: var(--tp-grayscale500); }
.small, small { font-size: 12px; }
.warn { background: var(--tp-secondary100); padding: 6px 10px; font-size: 14px; }
.chip { padding: 6px 10px; border-radius: 16px; border: 1px solid var(--tp-grayscale200); background: var(--tp-white); font-size: 14px; }
.chip.on { background: var(--tp-orange500); border-color: var(--tp-orange500); color: var(--tp-white); }
.big { width: 100%; min-height: 48px; border-radius: 8px; border: 1px solid var(--tp-grayscale200); background: var(--tp-white); font-size: 17px; font-weight: 600; }
.big.primary { background: var(--tp-primary500); border-color: var(--tp-primary500); color: var(--tp-white); }
.big.secondary { background: var(--tp-secondary500); border-color: var(--tp-secondary500); min-height: 64px; font-size: 19px; }
.big:disabled { opacity: 0.5; }
.btn-s { padding: 6px 10px; border-radius: 6px; border: 1px solid var(--tp-grayscale200); background: var(--tp-white); font-size: 14px; }
.danger { color: var(--tp-red600); border-color: var(--tp-red500); }
.live { background: var(--tp-primary50); border-radius: 6px; padding: 8px; font-size: 14px; }
.stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; text-align: center; }
.stats div { background: var(--tp-grayscale50); border-radius: 6px; padding: 6px 0; display: flex; flex-direction: column; }
.stats b { font-size: 20px; color: var(--tp-primary700); }
.cps { margin: 0; padding-left: 22px; font-size: 14px; max-height: 160px; overflow-y: auto; }
.sel { width: 100%; padding: 8px; font-size: 14px; border-radius: 6px; border: 1px solid var(--tp-grayscale200); background: var(--tp-white); }
.runs { width: 100%; font-size: 12px; border-collapse: collapse; }
.runs th, .runs td { text-align: left; padding: 3px 4px; border-bottom: 1px solid var(--tp-grayscale100); }
</style>
