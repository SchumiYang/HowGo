<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, triggerRef, watch } from 'vue'
import { townpass, type BaroSample, type Vec3Sample, type WifiScan } from '../bridge/townpass'
import { venueBaseUrl } from '../data/loader'
import type { VenueData } from '../data/types'
import { getVenue } from '../admin/venue'
import { makeFrame } from '../geo/frame'
import { SurveyMap } from './SurveyMap'
import {
  buildWalk, classifyScan, doneWalks, modelFromUserAgent, nearestPoint, nearestUndone, newestApTimestamp, newSession,
  compassName, parsePlan, progress, sampleCount, scansPerPoint, toScanRecord, turnVertices, walkKey, walkPath,
  type DeviceRecord, type Direction, type PhonePose, type Plan, type PlanWalk, type ScanRecord, type Session,
} from './session'
import { loadLatestSession, saveSession } from './store'

// embedded in the admin 場勘建圖 tab (admin.html#mapping); survey.html redirects there
const props = withDefaults(defineProps<{ venueId?: string; level?: string }>(), { venueId: 'tianmu', level: '1F' })
const emit = defineEmits<{ busy: [boolean] }>()
const VENUE = props.venueId
/**
 * Level being surveyed: follows the admin floor switch (props.level) whenever nothing is recording; one session
 * spans all levels (every point / walk carries its own level from the plan).
 */
const level = ref(props.level)
const SCANS_PER_POINT = 3
const THROTTLE_WAIT_S = 10
const THROTTLE_HINT = 'WiFi 掃描被節流：請到 開發人員選項 → 關閉『Wi-Fi 掃描節流』'

const mapEl = ref<HTMLElement | null>(null)
let smap: SurveyMap | null = null

const plan = shallowRef<Plan>({ points: [], walks: [] })
const session = shallowRef<Session | null>(null)
const loadError = ref('')
const saveError = ref(false)
const bridgeOk = ref(townpass.available)
const mode = ref<'point' | 'walk' | 'upload'>('point')

// ---------- derived ----------
const prog = computed(() => (session.value ? progress(plan.value, session.value) : null))
const spp = computed(() => (session.value ? scansPerPoint(session.value) : new Map<string, number>()))
const dws = computed(() => (session.value ? doneWalks(session.value) : new Set<string>()))

function refreshMap() {
  if (!smap || !session.value) return
  smap.setPlan(plan.value, spp.value, dws.value, mode.value === 'point' ? selPointId.value : null)
  const w = mode.value === 'walk' ? selWalk.value : null
  smap.setSelectedWalk(w?.coords ?? null, walkDir.value)
}

async function commit() {
  if (!session.value) return
  triggerRef(session)
  refreshMap()
  saveError.value = !(await saveSession(session.value))
  scheduleUpload()
}

// ---------- session ----------
async function deviceRecord(): Promise<DeviceRecord> {
  const ua = navigator.userAgent
  const dev: DeviceRecord = { model: modelFromUserAgent(ua), platform: /Android/i.test(ua) ? 'android' : /iPhone|iPad/i.test(ua) ? 'ios' : 'web', user_agent: ua }
  const r = await townpass.getDeviceInfo(3000)
  if (r.ok && r.data && typeof r.data === 'object') {
    dev.info = r.data
    const m = (r.data as Record<string, unknown>).model ?? (r.data as Record<string, unknown>).device_model
    if (typeof m === 'string' && m) dev.model = m
  }
  return dev
}

async function startNewSession() {
  session.value = newSession(VENUE, await deviceRecord())
  lastUpload.value = null
  await commit()
}

async function confirmNewSession() {
  if (!confirm('開始新場次？目前場次仍保存在手機中（請先上傳）。')) return
  await startNewSession()
}

// ---------- point mode ----------
const selPointId = ref<string | null>(null)
const selPoint = computed(() => plan.value.points.find((p) => p.id === selPointId.value) ?? null)
const scan = ref({ active: false, got: 0, aps: 0, msg: '', throttled: false, cancel: false })
/** newest AP timestamp of the last accepted scan, across points (a cached result must not count twice) */
let lastNewest: number | null = null

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function selectPoint(id: string | null) {
  selPointId.value = id
  refreshMap()
}

async function runPointScan() {
  const p = selPoint.value
  if (!p || !session.value || scan.value.active) return
  const s = scan.value
  Object.assign(s, { active: true, got: 0, aps: 0, msg: '掃描中…', throttled: false, cancel: false })
  const scans: ScanRecord[] = []
  let failures = 0
  while (scans.length < SCANS_PER_POINT && !s.cancel) {
    s.msg = `掃描中… 第 ${scans.length + 1} 次`
    const r = await townpass.wifiScan()
    if (s.cancel) break
    if (!r.ok) {
      s.msg = `掃描失敗：${r.message}`
      if (++failures >= 5) break
      await sleep(3000)
      continue
    }
    failures = 0
    const v = classifyScan(r.data as WifiScan, lastNewest)
    if (v === 'fresh') {
      s.throttled = false
      scans.push(toScanRecord(r.data))
      lastNewest = newestApTimestamp(r.data) ?? lastNewest
      s.got = scans.length
      s.aps = r.data.results.length
      continue
    }
    if (v === 'throttled') {
      s.throttled = true
      for (let i = THROTTLE_WAIT_S; i > 0 && !s.cancel; i--) {
        s.msg = `被節流，${i} 秒後重試`
        await sleep(1000)
      }
    } else {
      s.msg = v === 'stale' ? '結果未更新，重試中…' : '沒有掃到任何 AP，重試中…'
      await sleep(2000)
    }
  }
  s.active = false
  if (scans.length) {
    session.value.wifi_points.push({ point_id: p.id, level: p.level, x: p.xy[0], y: p.xy[1], scans })
    s.msg = scans.length >= SCANS_PER_POINT ? `完成 ${p.id}：${scans.length} 次` : `已存 ${scans.length} 次（未滿 ${SCANS_PER_POINT}）`
    await commit()
    if (scans.length >= SCANS_PER_POINT) selectPoint(nearestUndone(plan.value, session.value, p.xy, p.id)?.id ?? p.id)
  } else if (!s.msg.startsWith('掃描失敗')) {
    s.msg = '已取消'
  }
}

async function clearPoint() {
  const p = selPoint.value
  if (!p || !session.value || !confirm(`刪除 ${p.id} 的所有掃描？`)) return
  session.value.wifi_points = session.value.wifi_points.filter((w) => w.point_id !== p.id)
  await commit()
}

// ---------- walk mode ----------
const selWalkId = ref<string | null>(null)
const walkDir = ref<Direction>('forward')
const pose = ref<PhonePose>('flat')
const selWalk = computed<PlanWalk | null>(() => plan.value.walks.find((w) => w.id === selWalkId.value) ?? null)

interface Rec {
  walk: PlanWalk
  direction: Direction
  pose: PhonePose
  t_start: number
  marks: { t: number; vertex: number }[]
  sensors: { accelerometer: Vec3Sample[]; gyroscope: Vec3Sample[]; magnetometer: Vec3Sample[]; barometer: BaroSample[] }
  wifi: ScanRecord[]
  wifiNewest: number | null
  offs: (() => void)[]
}
let rec: Rec | null = null
const recUi = ref<{ elapsed: number; acc: number; gyr: number; mag: number; marks: number; wifi: number; stopping: boolean } | null>(null)
let recTimer: ReturnType<typeof setInterval> | null = null

function pickWalk(id: string, d: Direction) {
  if (rec) return
  selWalkId.value = id
  walkDir.value = d
  refreshMap()
}

/** Hz over the last 2 s of samples */
function rate(a: Vec3Sample[], now: number): number {
  let n = 0
  for (let i = a.length - 1; i >= 0 && a[i][0] > now - 2000; i--) n++
  return n / 2
}

function startWalk() {
  const w = selWalk.value
  if (!w || rec) return
  if (!townpass.available) {
    alert('不在 TownPass App 內，無法讀取感測器')
    return
  }
  const r: Rec = {
    walk: w, direction: walkDir.value, pose: pose.value, t_start: Date.now(), marks: [],
    sensors: { accelerometer: [], gyroscope: [], magnetometer: [], barometer: [] }, wifi: [], wifiNewest: null, offs: [],
  }
  r.offs.push(
    townpass.onSensorBatch((b) => {
      if (b.accelerometer) r.sensors.accelerometer.push(...b.accelerometer)
      if (b.gyroscope) r.sensors.gyroscope.push(...b.gyroscope)
      if (b.magnetometer) r.sensors.magnetometer.push(...b.magnetometer)
      if (b.barometer) r.sensors.barometer.push(...b.barometer)
    }),
    townpass.onWifiScan((s, src) => {
      // scan_started is meaningless for stream pushes (older TownPass builds always send false), so only check freshness
      if (src !== 'stream' || classifyScan({ ...s, scan_started: true }, r.wifiNewest) !== 'fresh') return
      r.wifi.push(toScanRecord(s))
      r.wifiNewest = newestApTimestamp(s) ?? r.wifiNewest
    }),
  )
  rec = r
  townpass.startSensorStream({ sensors: ['accelerometer', 'gyroscope', 'magnetometer', 'barometer'], interval_ms: 20, batch_ms: 200 })
  townpass.startWifiStream(5000)
  recUi.value = { elapsed: 0, acc: 0, gyr: 0, mag: 0, marks: 0, wifi: 0, stopping: false }
  smap?.setNextVertex(nextTurn.value?.xy ?? null)
  recTimer = setInterval(() => {
    if (!rec || !recUi.value) return
    const now = Date.now()
    Object.assign(recUi.value, {
      elapsed: (now - rec.t_start) / 1000,
      acc: rate(rec.sensors.accelerometer, now), gyr: rate(rec.sensors.gyroscope, now), mag: rate(rec.sensors.magnetometer, now),
      marks: rec.marks.length, wifi: rec.wifi.length,
    })
  }, 250)
}

/** plan extent, for 「東北角」-style corner names */
const planBox = computed<[number, number, number, number]>(() => {
  const xs: number[] = []
  const ys: number[] = []
  for (const p of plan.value.points) xs.push(p.xy[0]), ys.push(p.xy[1])
  for (const w of plan.value.walks) for (const c of w.coords) xs.push(c[0]), ys.push(c[1])
  return xs.length ? [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] : [0, 0, 1, 1]
})

/**
 * Next real corner of the walk being recorded (walking order). Marks are anchored to turn vertices only:
 * straight-through plan vertices would otherwise swallow the taps (marks[].vertex = index into `path`).
 */
const nextTurn = computed(() => {
  void recUi.value?.marks
  if (!rec) return null
  const turns = turnVertices(walkPath(rec.walk.coords, rec.direction))
  const t = turns[rec.marks.length]
  if (!t) return null
  return { ...t, n: rec.marks.length + 1, of: turns.length, label: `${compassName(t.xy, planBox.value)}${t.turn === 'left' ? '左轉' : '右轉'}` }
})

function markCorner() {
  const t = nextTurn.value
  if (!rec || !t) return
  rec.marks.push({ t: Date.now(), vertex: t.index })
  if (recUi.value) recUi.value.marks = rec.marks.length
  smap?.setNextVertex(nextTurn.value?.xy ?? null)
  navigator.vibrate?.(60)
}

async function stopStreams(r: Rec) {
  smap?.setNextVertex(null)
  if (recTimer) clearInterval(recTimer)
  recTimer = null
  await Promise.all([townpass.stopSensorStream(3000), townpass.stopWifiStream(3000)])
  r.offs.forEach((off) => off())
}

async function finishWalk() {
  const r = rec
  if (!r || !session.value || recUi.value?.stopping) return
  const t_end = Date.now()
  if (recUi.value) recUi.value.stopping = true
  await stopStreams(r)
  rec = null
  recUi.value = null
  session.value.walks.push(buildWalk({
    walk: r.walk, direction: r.direction, pose: r.pose, t_start: r.t_start, t_end, marks: r.marks, sensors: r.sensors, wifi_scans: r.wifi,
  }))
  walkMsg.value = `已存 ${r.walk.id} ${r.direction === 'forward' ? '正向' : '反向'}：${((t_end - r.t_start) / 1000).toFixed(0)} 秒，磁力計 ${r.sensors.magnetometer.length} 筆`
  // suggest the opposite direction next
  if (!dws.value.has(walkKey(r.walk.id, r.direction === 'forward' ? 'reverse' : 'forward'))) walkDir.value = r.direction === 'forward' ? 'reverse' : 'forward'
  await commit()
}

async function discardWalk() {
  const r = rec
  if (!r || !confirm('放棄這次錄製？')) return
  rec = null
  recUi.value = null
  await stopStreams(r)
  walkMsg.value = '已放棄'
}
const walkMsg = ref('')

// ---------- upload ----------
const serverOk = ref<boolean | null>(null)
const lastUpload = ref<number | null>(null)
const uploading = ref(false)
const uploadMsg = ref('')
let uploadTimer: ReturnType<typeof setTimeout> | null = null
let healthTimer: ReturnType<typeof setInterval> | null = null

async function checkHealth() {
  try {
    const r = await fetch('/api/v1/indoor/survey/health', { cache: 'no-store' })
    serverOk.value = r.ok && (await r.json())?.ok === true
  } catch {
    serverOk.value = false
  }
}

function scheduleUpload() {
  if (uploadTimer) clearTimeout(uploadTimer)
  uploadTimer = setTimeout(() => {
    // never auto-upload an empty session (the admin page mounts the recorder on desktops too)
    const s = session.value
    if (serverOk.value && !rec && s && (s.wifi_points.length || s.walks.length)) void upload()
  }, 2000)
}

async function upload() {
  if (!session.value || uploading.value) return
  uploading.value = true
  uploadMsg.value = '上傳中…'
  try {
    const body = JSON.stringify(session.value)
    const r = await fetch('/api/v1/indoor/survey', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })
    const j = await r.json().catch(() => null)
    if (!r.ok || !j?.ok) throw new Error(j?.error ?? `HTTP ${r.status}`)
    lastUpload.value = Date.now()
    serverOk.value = true
    uploadMsg.value = `已上傳 ${fmtSize(body.length)}`
  } catch (err) {
    uploadMsg.value = `上傳失敗：${(err as Error).message}`
    void checkHealth()
  } finally {
    uploading.value = false
  }
}

const exportInfo = ref('')
async function exportJson() {
  if (!session.value) return
  const text = JSON.stringify(session.value)
  const size = fmtSize(text.length)
  try {
    await navigator.clipboard.writeText(text)
    exportInfo.value = `已複製 ${size} 到剪貼簿`
  } catch {
    const ta = document.createElement('textarea')
    ta.value = text
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    ta.remove()
    exportInfo.value = ok ? `已複製 ${size} 到剪貼簿` : `複製失敗（${size}）`
  }
}

const fmtSize = (n: number) => (n < 1e6 ? `${(n / 1e3).toFixed(0)} KB` : `${(n / 1e6).toFixed(2)} MB`)
const fmtTime = (t: number | null) => (t ? new Date(t).toLocaleTimeString('zh-TW', { hour12: false }) : '—')

// ---------- lifecycle ----------
function onTap(xy: [number, number]) {
  if (mode.value !== 'point' || scan.value.active) return
  selectPoint(nearestPoint(plan.value, xy)?.id ?? null)
}

function setMode(m: typeof mode.value) {
  if (rec) return
  mode.value = m
  refreshMap()
}

let venueData: VenueData | null = null
const fetchPlan = (l: string) =>
  fetch(`${venueBaseUrl(VENUE)}survey/${encodeURIComponent(l)}_plan.geojson`, { cache: 'no-store' }).then((r) => r.json()).catch(() => null)

/** load a level's plan + base map and reset the selections (only while idle) */
async function switchLevel(l: string) {
  const planFc = await fetchPlan(l)
  level.value = l
  plan.value = parsePlan(planFc, l)
  selPointId.value = session.value ? (nearestUndone(plan.value, session.value, plan.value.points[0]?.xy ?? [0, 0])?.id ?? null) : null
  selWalkId.value = plan.value.walks[0]?.id ?? null
  walkMsg.value = ''
  scan.value.msg = ''
  if (venueData) await smap?.setBase(venueData, l, plan.value)
  refreshMap()
}

const busy = computed(() => !!recUi.value || scan.value.active)
watch(busy, (b) => emit('busy', b))
/** floor change requested while recording: ignored until idle (the admin also locks its floor switch) */
const pendingLevel = ref<string | null>(null)
watch(() => props.level, (l) => {
  if (l === level.value) return void (pendingLevel.value = null)
  if (busy.value) return void (pendingLevel.value = l)
  pendingLevel.value = null
  void switchLevel(l)
})
watch(busy, (b) => {
  if (!b && pendingLevel.value && pendingLevel.value !== level.value) {
    const l = pendingLevel.value
    pendingLevel.value = null
    void switchLevel(l)
  }
})

onMounted(async () => {
  try {
    const [data, saved] = await Promise.all([getVenue(VENUE), loadLatestSession()])
    venueData = data
    if (saved) session.value = saved
    else await startNewSession()
    const frame = makeFrame({ origin: data.venue.origin, bearingDeg: data.venue.bearing_deg ?? 0 })
    smap = new SurveyMap(mapEl.value!, frame)
    smap.onTap = onTap
    await switchLevel(level.value)
    new ResizeObserver(() => smap?.resize()).observe(mapEl.value!)
  } catch (err) {
    loadError.value = `載入失敗：${(err as Error).message}`
  }
  bridgeOk.value = townpass.available
  void checkHealth()
  healthTimer = setInterval(checkHealth, 10000)
})

onBeforeUnmount(() => {
  if (healthTimer) clearInterval(healthTimer)
  townpass.stopAllStreams()
})
</script>

<template>
  <div class="survey">
    <header class="bar">
      <div class="prog" v-if="prog">{{ level }} 點位 {{ prog.pointsDone }}/{{ prog.pointsTotal }} · 路線 {{ prog.walksDone }}/{{ prog.walksTotal }}</div>
      <div class="srv" :class="{ ok: serverOk, bad: serverOk === false }" @click="checkHealth">
        <span class="dot" /> {{ serverOk ? '伺服器已連線' : serverOk === false ? '伺服器未連線' : '檢查中' }}
        <small v-if="lastUpload">· 上傳 {{ fmtTime(lastUpload) }}</small>
      </div>
    </header>
    <div v-if="!bridgeOk" class="warn">不在 TownPass App 內：無法掃描 WiFi / 讀取感測器（測試請加 ?fake=1）</div>
    <div v-if="pendingLevel" class="warn">錄製中：完成或取消後才會切換到 {{ pendingLevel }}（目前仍在 {{ level }}）</div>
    <div v-if="saveError" class="warn">⚠ 無法儲存到手機（IndexedDB），請盡快上傳或匯出</div>
    <div v-if="loadError" class="warn">{{ loadError }}</div>

    <div ref="mapEl" class="map" />

    <section class="panel">
      <nav class="tabs">
        <button :class="{ on: mode === 'point' }" :disabled="!!recUi" @click="setMode('point')">WiFi 點位</button>
        <button :class="{ on: mode === 'walk' }" :disabled="!!recUi" @click="setMode('walk')">磁場路線</button>
        <button :class="{ on: mode === 'upload' }" :disabled="!!recUi" @click="setMode('upload')">上傳</button>
      </nav>

      <!-- WiFi point -->
      <div v-if="mode === 'point'" class="body">
        <template v-if="selPoint">
          <div class="title">站在 <b>{{ selPoint.id }}</b> <span class="muted">已有 {{ spp.get(selPoint.id) ?? 0 }} 次</span></div>
          <button v-if="!scan.active" class="big primary" @click="runPointScan">
            {{ (spp.get(selPoint.id) ?? 0) > 0 ? '重新掃描' : '開始掃描' }}（{{ SCANS_PER_POINT }} 次）
          </button>
          <button v-else class="big" @click="scan.cancel = true">取消（{{ scan.got }}/{{ SCANS_PER_POINT }}）</button>
          <div class="status">
            <span v-if="scan.active || scan.got">{{ scan.got }}/{{ SCANS_PER_POINT }} 次 · {{ scan.aps }} 個 AP</span>
            <span>{{ scan.msg }}</span>
          </div>
          <div v-if="scan.throttled" class="hint">{{ THROTTLE_HINT }}</div>
          <div class="row">
            <button class="small" :disabled="scan.active" @click="selectPoint(nearestUndone(plan, session!, selPoint.xy, selPoint.id)?.id ?? null)">下一個未完成點</button>
            <button v-if="(spp.get(selPoint.id) ?? 0) > 0" class="small danger" :disabled="scan.active" @click="clearPoint">刪除此點資料</button>
          </div>
        </template>
        <div v-else class="muted">點地圖選擇點位</div>
      </div>

      <!-- walk -->
      <div v-else-if="mode === 'walk'" class="body">
        <template v-if="!recUi">
          <div class="walks">
            <div v-for="w in plan.walks" :key="w.id" class="walk" :class="{ sel: w.id === selWalkId }">
              <div class="wname">{{ w.name }} <span class="muted">{{ w.length_m.toFixed(0) }} m</span></div>
              <button v-for="d in (['forward', 'reverse'] as const)" :key="d" class="chip"
                :class="{ on: w.id === selWalkId && d === walkDir, done: dws.has(walkKey(w.id, d)) }" @click="pickWalk(w.id, d)">
                {{ d === 'forward' ? '正向 →' : '← 反向' }}{{ dws.has(walkKey(w.id, d)) ? ' ✓' : '' }}
              </button>
            </div>
          </div>
          <div class="row">
            <button class="chip" :class="{ on: pose === 'flat' }" @click="pose = 'flat'">平拿，手機頂端朝前</button>
            <button class="chip" :class="{ on: pose === 'upright' }" @click="pose = 'upright'">直立</button>
          </div>
          <div class="muted small-text">從橘色圓點出發，沿橘線等速走到底。</div>
          <button class="big primary" :disabled="!selWalk" @click="startWalk">開始</button>
          <div class="status">{{ walkMsg }}</div>
        </template>
        <template v-else>
          <div class="title">錄製中 <b>{{ selWalk?.id }}</b> {{ walkDir === 'forward' ? '正向' : '反向' }}</div>
          <div class="rec">
            <div class="elapsed">{{ recUi.elapsed.toFixed(1) }} 秒</div>
            <div>加速度 {{ recUi.acc.toFixed(0) }} Hz · 陀螺儀 {{ recUi.gyr.toFixed(0) }} Hz · 磁力計 {{ recUi.mag.toFixed(0) }} Hz · WiFi {{ recUi.wifi }}</div>
          </div>
          <div v-if="recUi.elapsed > 3 && recUi.mag < 40" class="hint">磁力計取樣率過低（{{ recUi.mag.toFixed(0) }} Hz &lt; 40 Hz）</div>
          <button class="big secondary" :disabled="!nextTurn" @click="markCorner">
            <template v-if="nextTurn">經過轉角 {{ nextTurn.n }}/{{ nextTurn.of }}：{{ nextTurn.label }}</template>
            <template v-else>{{ recUi.marks ? '已無轉角，走到終點' : '此路線沒有轉角' }}</template>
          </button>
          <div v-if="nextTurn" class="muted small-text">走到地圖上紅色圓點（下一個轉角）時按下</div>
          <button class="big primary" :disabled="recUi.stopping" @click="finishWalk">抵達終點</button>
          <button class="small danger" @click="discardWalk">放棄</button>
        </template>
      </div>

      <!-- upload -->
      <div v-else-if="session" class="body">
        <div class="title">場次 <b>{{ session.session_id }}</b></div>
        <div class="muted">點位 {{ session.wifi_points.length }} 筆 · 路線 {{ session.walks.length }} 條 · 感測樣本 {{ sampleCount(session) }}</div>
        <button class="big primary" :disabled="uploading" @click="upload">上傳</button>
        <div class="status">{{ uploadMsg }} <span v-if="lastUpload">（上次 {{ fmtTime(lastUpload) }}）</span></div>
        <div class="row">
          <button class="small" @click="exportJson">匯出（複製 JSON）</button>
          <button class="small danger" @click="confirmNewSession">新場次</button>
        </div>
        <div class="status">{{ exportInfo }}</div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.survey { display: flex; flex-direction: column; height: 100%; }
.bar {
  display: flex; justify-content: space-between; align-items: center; gap: 8px;
  padding: 8px 12px; /* embedded below the admin header: no safe-area inset */ background: var(--tp-white); box-shadow: var(--tp-sheet-shadow); z-index: 2;
}
.prog { font-weight: 600; font-size: 17px; }
.srv { font-size: 13px; color: var(--tp-grayscale500); display: flex; align-items: center; gap: 4px; }
.srv .dot { width: 9px; height: 9px; border-radius: 50%; background: var(--tp-grayscale300); }
.srv.ok .dot { background: var(--tp-primary500); }
.srv.bad .dot { background: var(--tp-red500); }
.warn { background: var(--tp-secondary100); color: var(--tp-grayscale900); padding: 6px 12px; font-size: 14px; }
.map { flex: 1; min-height: 160px; }
.panel { background: var(--tp-white); box-shadow: var(--tp-sheet-shadow); padding-bottom: calc(var(--safe-bottom) + 8px); max-height: 58vh; overflow-y: auto; }
.tabs { display: flex; border-bottom: 1px solid var(--tp-grayscale100); }
.tabs button { flex: 1; border: 0; background: none; padding: 12px 0; font-size: 16px; color: var(--tp-grayscale500); border-bottom: 3px solid transparent; }
.tabs button.on { color: var(--tp-primary600); border-bottom-color: var(--tp-primary500); font-weight: 600; }
.body { padding: 12px; display: flex; flex-direction: column; gap: 10px; }
.title { font-size: 18px; }
.muted { color: var(--tp-grayscale500); font-size: 14px; }
.small-text { font-size: 13px; }
.big { width: 100%; min-height: 56px; border-radius: 8px; border: 1px solid var(--tp-grayscale200); background: var(--tp-white); font-size: 18px; font-weight: 600; }
.big.primary { background: var(--tp-primary500); border-color: var(--tp-primary500); color: var(--tp-white); }
.big.secondary { background: var(--tp-secondary500); border-color: var(--tp-secondary500); min-height: 72px; font-size: 20px; }
.big:disabled { opacity: 0.45; }
.small { padding: 8px 12px; border-radius: 6px; border: 1px solid var(--tp-grayscale200); background: var(--tp-white); font-size: 14px; }
.danger { color: var(--tp-red600); border-color: var(--tp-red500); }
.row { display: flex; gap: 8px; flex-wrap: wrap; }
.status { font-size: 14px; color: var(--tp-grayscale700); display: flex; gap: 8px; flex-wrap: wrap; min-height: 1.5em; }
.hint { background: var(--tp-secondary200); border-radius: 6px; padding: 8px 10px; font-size: 14px; font-weight: 600; }
.walks { display: flex; flex-direction: column; gap: 6px; }
.walk { display: flex; align-items: center; gap: 6px; padding: 4px 6px; border-radius: 6px; }
.walk.sel { background: var(--tp-primary50); }
.wname { flex: 1; font-size: 14px; }
.chip { padding: 8px 10px; border-radius: 16px; border: 1px solid var(--tp-grayscale200); background: var(--tp-white); font-size: 14px; white-space: nowrap; }
.chip.done { border-color: var(--tp-primary500); color: var(--tp-primary700); }
.chip.on { background: var(--tp-orange500); border-color: var(--tp-orange500); color: var(--tp-white); }
.rec { background: var(--tp-primary50); border-radius: 8px; padding: 10px; font-size: 14px; }
.elapsed { font-size: 32px; font-weight: 600; color: var(--tp-primary700); }
</style>
