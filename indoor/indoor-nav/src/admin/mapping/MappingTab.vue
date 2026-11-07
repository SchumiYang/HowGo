<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import SurveyApp from '../../survey/SurveyApp.vue'
import { AdminMap, type LocalFeature, type Overlay } from '../AdminMap'
import {
  buildPreviewUrl, buildStatus, getMagmap, getRadiomap, listSessions, startBuild,
  type BuildStatus, type BuildTarget, type SessionSummary,
} from '../api'
import { getVenue, SERIES, venueFrame } from '../venue'
import { venueBaseUrl } from '../../data/loader'
import type { VenueData } from '../../data/types'
import type { XY } from '../../geo/frame'
import type { Magmap, Radiomap } from '../../positioning/types'
import { corridorEdges, runLength, uncoveredRuns } from './coverage'
import {
  apCentroid, apStats, CORRIDOR, coverageFraction, coverageLabel, defaultAp, fieldPixels, gridCorners, interpolateField, makeGrid,
  quantile, RAMP_CSS, renderHeatmapUrl, unitMask, unitsBBox, WALKABLE, type FieldOptions, type Grid, type Sample,
} from './heatmap'

const props = defineProps<{ venueId: string; level: string }>()
/** busy: the recorder is recording a walk / point scan (the shell locks its floor switch) */
const emit = defineEmits<{ dataChanged: []; busy: [boolean] }>()

// survey.html redirects to admin.html#mapping-record (phones surveying); desktops land on 建圖・覆蓋
const view = ref<'record' | 'build'>(location.hash.includes('record') || new URLSearchParams(location.search).has('fake') ? 'record' : 'build')

// ---------- map + coverage ----------
const mapEl = ref<HTMLElement | null>(null)
let amap: AdminMap | null = null
const venue = shallowRef<VenueData | null>(null)
const radiomap = shallowRef<Radiomap | null>(null)
const magmap = shallowRef<Magmap | null>(null)
const planPts = shallowRef<XY[]>([])
const planWalks = shallowRef<{ id: string; name: string; coords: XY[] }[]>([])
const sessions = ref<SessionSummary[]>([])
const included = ref<Record<string, boolean>>({})
const error = ref('')
const show = ref<Record<'fp' | 'mag' | 'walked' | 'uncovered' | 'gaps' | 'plan', boolean>>({ fp: true, mag: false, walked: true, uncovered: true, gaps: false, plan: false })

const sessionColor = (id: string) => SERIES[Math.max(0, sessions.value.findIndex((s) => s.session_id === id)) % SERIES.length]
const levelWalks = (s: SessionSummary) => s.walk_list.filter((w) => (w.level ?? '1F') === props.level)

const uncovered = computed(() => {
  const v = venue.value
  if (!v) return []
  const walked = sessions.value.filter((s) => included.value[s.session_id]).flatMap((s) => levelWalks(s).map((w) => w.path))
  const cells: XY[] = (magmap.value?.cells ?? []).map((c) => [c.x, c.y])
  const units = v.levels.find((l) => l.level.id === props.level)?.units ?? []
  return uncoveredRuns(corridorEdges(v.nav, props.level, units), walked, cells, { radius: 2.5, minLen: 3 })
})
/** planned walks (survey plan) without any recording in the included sessions, e.g. 1F-walk-east */
const unwalked = computed(() => {
  const done = new Set(sessions.value.filter((s) => included.value[s.session_id]).flatMap((s) => levelWalks(s).map((w) => w.walk_id)))
  return planWalks.value.filter((w) => !done.has(w.id))
})
const uncoveredM = computed(() => uncovered.value.reduce((s, r) => s + runLength(r), 0))
const fpCount = computed(() => (radiomap.value?.points ?? []).filter((p) => p.level === props.level).length)

function drawCoverage() {
  if (!amap) return
  amap.set('fp', (radiomap.value?.points ?? []).filter((p) => p.level === props.level).map((p) => ({
    geometry: { type: 'Point', coordinates: [p.x, p.y] }, properties: { n: Object.keys(p.aps).length, src: p.src ?? 'point' },
  })))
  amap.set('mag', (magmap.value?.cells ?? []).map((c) => ({ geometry: { type: 'Point', coordinates: [c.x, c.y] }, properties: { B: c.B } })))
  const walked: LocalFeature[] = []
  for (const s of sessions.value) {
    if (!included.value[s.session_id]) continue
    for (const w of levelWalks(s)) if (w.path?.length >= 2) walked.push({ geometry: { type: 'LineString', coordinates: w.path }, properties: { color: sessionColor(s.session_id) } })
  }
  amap.set('walked', walked)
  amap.set('uncovered', uncovered.value.map((r) => ({ geometry: { type: 'LineString', coordinates: r } })))
  amap.set('plan', planPts.value.map((p) => ({ geometry: { type: 'Point', coordinates: p } })))
  amap.set('gaps', unwalked.value.map((w) => ({ geometry: { type: 'LineString', coordinates: w.coords }, properties: { id: w.id } })))
  for (const k of Object.keys(show.value) as (keyof typeof show.value)[]) void amap.setVisible(k as Overlay, show.value[k])
}

// ---------- heatmap ----------
type HeatKind = 'none' | 'B' | 'Bv' | 'Bh' | 'rssi' | 'apcount'
const HEAT_KINDS: { id: HeatKind; label: string }[] = [
  { id: 'none', label: '無' }, { id: 'B', label: '|B|' }, { id: 'Bv', label: '垂直 Bv' }, { id: 'Bh', label: '水平 Bh' },
  { id: 'rssi', label: 'WiFi 訊號' }, { id: 'apcount', label: 'AP 數量' },
]
const heatKind = ref<HeatKind>('B')
const apSel = ref<string | null>(null)
const heatOpacity = ref(0.75)
const heatBusy = ref(false)
interface HeatInfo { vmin: number; vmax: number; unit: string; title: string; nData: string; cov: { fraction: number; text: string; level: string } | null }
const heatInfo = shallowRef<HeatInfo | null>(null)
/** rendered overlays per selection (the canvas work happens once per key) */
const heatCache = new Map<string, { url: string; corners: [XY, XY, XY, XY]; info: HeatInfo; ap: XY | null }>()
let heatSeq = 0
let gridCache: { level: string; grid: Grid; walk: Uint8Array; corr: Uint8Array } | null = null
const HEAT_CELL_M = 0.33
const MAG_FIELD: FieldOptions = { radius: 3, sigma: 1, solid: 1 }
const WIFI_FIELD: FieldOptions = { radius: 8, sigma: 3, solid: 3.5 }

const levelFps = computed(() => (radiomap.value?.points ?? []).filter((p) => p.level === props.level))
const aps = computed(() => apStats(levelFps.value, (radiomap.value as unknown as { ap_info?: Record<string, { ssids?: string[] }> } | null)?.ap_info ?? {}))
const apLabel = (b: { bssid: string; ssid: string; count: number }) => `${b.ssid || '(隱藏)'} …${b.bssid.slice(-5)} · ${b.count} 點`

function levelGrid(): typeof gridCache {
  const units = venue.value?.levels.find((l) => l.level.id === props.level)?.units ?? []
  if (gridCache?.level === props.level) return gridCache
  const bb = unitsBBox(units.filter((u) => WALKABLE.has(u.properties.category)))
  if (!Number.isFinite(bb[0])) return null
  const grid = makeGrid(bb, HEAT_CELL_M, 1)
  gridCache = { level: props.level, grid, walk: unitMask(grid, units, WALKABLE), corr: unitMask(grid, units, CORRIDOR) }
  return gridCache
}

function walkedLines(): XY[][] {
  return sessions.value.filter((s) => included.value[s.session_id]).flatMap((s) => levelWalks(s).map((w) => w.path)).filter((p) => p?.length >= 2)
}

function clearHeat() {
  heatInfo.value = null
  amap?.set('ap', [])
  void amap?.setHeat(null)
}

async function drawHeat() {
  if (!amap) return
  const kind = heatKind.value
  if (kind === 'none') return clearHeat()
  const gc = levelGrid()
  const mm = magmap.value
  const rm = radiomap.value
  const magKind = kind === 'B' || kind === 'Bv' || kind === 'Bh'
  if (!gc || (magKind && !mm?.cells.length) || (!magKind && !levelFps.value.length)) return clearHeat()
  if (kind === 'rssi' && (!apSel.value || !aps.value.some((a) => a.bssid === apSel.value))) {
    apSel.value = defaultAp(aps.value) // the apSel watcher draws
    return
  }
  const seq = ++heatSeq
  const version = magKind ? (mm as { built_at?: number }).built_at : rm?.built_at
  const key = `${props.level}|${kind}|${kind === 'rssi' ? apSel.value : ''}|${version}`
  let hit = heatCache.get(key)
  if (!hit) {
    heatBusy.value = true
    await new Promise((r) => setTimeout(r, 0)) // let the 「計算中」 state paint
    const t0 = performance.now()
    let samples: Sample[]
    let opts = WIFI_FIELD
    let info: Omit<HeatInfo, 'cov'>
    let ap: XY | null = null
    if (magKind) {
      samples = mm!.cells.map((c) => ({ x: c.x, y: c.y, v: c[kind] }))
      opts = MAG_FIELD
      const vals = samples.map((x) => x.v)
      info = {
        vmin: quantile(vals, 0.05) ?? 0, vmax: quantile(vals, 0.95) ?? 1, unit: 'µT',
        title: kind === 'B' ? '磁場強度 |B|' : kind === 'Bv' ? '垂直分量 Bv' : '水平分量 Bh',
        nData: `資料格 ${mm!.cells.length} · 樣本 ${mm!.cells.reduce((n, c) => n + c.n, 0)}`,
      }
    } else if (kind === 'rssi') {
      const b = apSel.value!
      const missing = rm?.params?.missing_dbm ?? -100
      samples = levelFps.value.map((p) => ({ x: p.x, y: p.y, v: p.aps[b]?.mean ?? missing }))
      ap = apCentroid(levelFps.value, b)
      const a = aps.value.find((x) => x.bssid === b)
      info = { vmin: -96, vmax: -30, unit: 'dBm', title: `${a?.ssid || 'AP'} …${b.slice(-5)}`, nData: `指紋 ${samples.length} · 收到 ${a?.count ?? 0}` }
    } else {
      samples = levelFps.value.map((p) => ({ x: p.x, y: p.y, v: Object.values(p.aps).filter((a) => a.detect >= 0.5).length }))
      const vals = samples.map((x) => x.v)
      info = { vmin: quantile(vals, 0.05) ?? 0, vmax: quantile(vals, 0.95) ?? 1, unit: '個 AP', title: '每點可用 AP 數', nData: `指紋 ${samples.length}` }
    }
    const field = interpolateField(gc.grid, samples, gc.walk, opts)
    const url = renderHeatmapUrl(gc.grid, fieldPixels(gc.grid, field, info.vmin, info.vmax))
    hit = { url, corners: gridCorners(gc.grid), info: { ...info, cov: null }, ap }
    heatCache.set(key, hit)
    heatBusy.value = false
    console.info(`[heatmap] ${key}: ${gc.grid.cols}x${gc.grid.rows} in ${(performance.now() - t0).toFixed(0)} ms`)
  }
  if (seq !== heatSeq) return // a newer selection is being drawn
  // coverage depends on the ticked sessions, so it is recomputed (cheap) rather than cached with the image
  const cov = magKind
    ? coverageFraction(gc.grid, gc.corr, walkedLines(), [], 1.5)
    : coverageFraction(gc.grid, gc.corr, [], levelFps.value.map((p) => [p.x, p.y] as XY), 4)
  const lab = coverageLabel(cov.fraction)
  heatInfo.value = { ...hit.info, cov: { fraction: cov.fraction, text: lab.text, level: lab.level } }
  amap.set('ap', hit.ap ? [{ geometry: { type: 'Point', coordinates: hit.ap } }] : [])
  await amap.setHeat({ url: hit.url, corners: hit.corners }, heatOpacity.value)
}

watch([heatKind, apSel], () => void drawHeat())
watch(heatOpacity, (o) => void amap?.setHeatOpacity(o))
watch(included, () => void drawHeat(), { deep: true })
watch(() => props.level, () => (gridCache = null))

async function loadAll(fresh = false) {
  error.value = ''
  try {
    const [v, rm, mm, ss, plan] = await Promise.all([
      getVenue(props.venueId, fresh),
      getRadiomap(props.venueId),
      getMagmap(props.venueId, props.level),
      listSessions().catch((e) => ((error.value = `場次清單：${e.message}`), [] as SessionSummary[])),
      fetch(`${venueBaseUrl(props.venueId)}survey/${encodeURIComponent(props.level)}_plan.geojson`, { cache: 'no-store' }).then((r) => r.json()).catch(() => null),
    ])
    venue.value = v
    radiomap.value = rm
    magmap.value = mm
    sessions.value = ss
    for (const s of ss) if (!(s.session_id in included.value)) included.value[s.session_id] = !s.synthetic && s.purpose !== 'evaluation' && !s.error
    planWalks.value = (plan?.features ?? [])
      .filter((f: { properties?: { kind?: string }; geometry?: { type: string } }) => f.properties?.kind === 'walk' && f.geometry?.type === 'LineString')
      .map((f: { properties: { id: string; name?: string }; geometry: { coordinates: XY[] } }) => ({ id: f.properties.id, name: f.properties.name ?? f.properties.id, coords: f.geometry.coordinates }))
    planPts.value = (plan?.features ?? []).filter((f: { properties?: { kind?: string } }) => f.properties?.kind === 'point').map((f: { geometry: { coordinates: XY } }) => f.geometry.coordinates)
    if (!amap && mapEl.value) {
      amap = new AdminMap(mapEl.value, venueFrame(v))
      new ResizeObserver(() => amap?.resize()).observe(mapEl.value)
    }
    await amap?.setBase(v, props.level)
    drawCoverage()
    if (fresh) heatCache.clear()
    await drawHeat()
  } catch (e) {
    error.value = `載入失敗：${(e as Error).message}`
  }
}

watch(() => props.level, () => void loadAll())
watch([show, included], drawCoverage, { deep: true })
const recordOpened = ref(view.value === 'record')
watch(view, (v) => {
  if (v === 'record') recordOpened.value = true
  else setTimeout(() => amap?.resize(), 0)
})

// ---------- build ----------
const targets = ref<Record<BuildTarget, boolean>>({ radiomap: true, magmap: true })
const walksOnly = ref(false)
/** 'all' = every level (default); 'level' = advanced: the current floor only (radiomap merged by the builder) */
const buildScope = ref<'all' | 'level'>('all')
const status = ref<BuildStatus | null>(null)
const buildErr = ref('')
const logEl = ref<HTMLElement | null>(null)
let poll: ReturnType<typeof setInterval> | null = null

async function refreshStatus() {
  try {
    const was = status.value?.running
    status.value = await buildStatus(props.venueId)
    setTimeout(() => logEl.value && (logEl.value.scrollTop = logEl.value.scrollHeight), 0)
    if (!status.value.running) {
      if (poll) clearInterval(poll)
      poll = null
      if (was && status.value.exitCode === 0) {
        await loadAll(true)
        emit('dataChanged')
      }
    }
  } catch (e) {
    buildErr.value = (e as Error).message
  }
}

async function runBuild() {
  buildErr.value = ''
  const t = (Object.keys(targets.value) as BuildTarget[]).filter((k) => targets.value[k])
  if (!t.length) return void (buildErr.value = '請至少選一個目標')
  const exclude = sessions.value.filter((s) => !included.value[s.session_id] && !s.synthetic).map((s) => s.session_id)
  try {
    await startBuild(props.venueId, t, { walksOnly: walksOnly.value, exclude, level: buildScope.value === 'all' ? 'all' : props.level })
    status.value = { running: true, jobId: null, startedAt: Date.now(), finishedAt: null, exitCode: null, log: '', report: null }
    poll ??= setInterval(refreshStatus, 1000)
  } catch (e) {
    buildErr.value = (e as Error).message
  }
}

const fmtSize = (n: number) => (n < 1e6 ? `${(n / 1e3).toFixed(0)} KB` : `${(n / 1e6).toFixed(1)} MB`)
const fmtTime = (t: number | null | undefined) => (t ? new Date(t).toLocaleString('zh-TW', { hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—')
const outputs = computed(() => Object.entries(status.value?.report?.outputs ?? {}))
const previews = computed(() => [`radiomap_${props.level}.png`, `magmap_${props.level}.png`])

onMounted(async () => {
  await loadAll()
  await refreshStatus()
  if (status.value?.running) poll ??= setInterval(refreshStatus, 1000)
})
onBeforeUnmount(() => {
  if (poll) clearInterval(poll)
  amap?.destroy()
})
</script>

<template>
  <div class="mapping">
    <div class="seg">
      <button :class="{ on: view === 'record' }" @click="view = 'record'">場勘錄製</button>
      <button :class="{ on: view === 'build' }" @click="view = 'build'">建圖・覆蓋</button>
    </div>

    <!-- mounted on first use, then kept alive so a recording survives switching views -->
    <div v-if="recordOpened" v-show="view === 'record'" class="record"><SurveyApp :venue-id="venueId" :level="level" @busy="(b: boolean) => emit('busy', b)" /></div>

    <div v-show="view === 'build'" class="split">
      <div class="mapwrap">
        <div ref="mapEl" class="map" />
        <div v-if="heatInfo" class="heatlegend">
          <div class="htitle">{{ heatInfo.title }}</div>
          <div class="hbar" :style="{ background: RAMP_CSS }">
            <span>{{ heatInfo.vmin.toFixed(heatInfo.unit === 'µT' ? 1 : 0) }} {{ heatInfo.unit }}</span>
            <span>{{ heatInfo.vmax.toFixed(heatInfo.unit === 'µT' ? 1 : 0) }} {{ heatInfo.unit }}</span>
          </div>
          <div class="hfoot">
            {{ heatInfo.nData }}<template v-if="heatInfo.cov"> · 覆蓋率 <b :class="heatInfo.cov.level">{{ (heatInfo.cov.fraction * 100).toFixed(0) }}% {{ heatInfo.cov.text }}</b></template>
          </div>
        </div>
        <div v-if="heatBusy" class="heatbusy">熱圖計算中…</div>
        <div v-else-if="heatKind !== 'none' && !heatInfo && venue" class="heatbusy">{{ level }} 尚無{{ ['B', 'Bv', 'Bh'].includes(heatKind) ? '磁場圖' : ' WiFi 指紋' }}（先場勘並建圖）</div>
      </div>
      <aside class="side">
        <div v-if="error" class="warn">{{ error }}</div>

        <section>
          <h3>覆蓋</h3>
          <div class="toggles">
            <label><input v-model="show.fp" type="checkbox" /> WiFi 指紋（{{ fpCount }}）</label>
            <label><input v-model="show.mag" type="checkbox" /> 磁場格（{{ magmap?.cells.length ?? 0 }}）</label>
            <label><input v-model="show.walked" type="checkbox" /> 已走路線</label>
            <label><input v-model="show.uncovered" type="checkbox" /> 未覆蓋走廊</label>
            <label><input v-model="show.gaps" type="checkbox" /> 未錄製路線（{{ unwalked.length }}）</label>
            <label><input v-model="show.plan" type="checkbox" /> 規劃點位</label>
          </div>
          <div class="heatsel">
            <span class="muted small-label">熱圖</span>
            <button v-for="k in HEAT_KINDS" :key="k.id" class="chip" :class="{ on: heatKind === k.id }" @click="heatKind = k.id">{{ k.label }}</button>
          </div>
          <select v-if="heatKind === 'rssi'" v-model="apSel" class="sel">
            <option v-for="a in aps" :key="a.bssid" :value="a.bssid">{{ apLabel(a) }}</option>
          </select>
          <label v-if="heatKind !== 'none'" class="opacity">透明度 <input v-model.number="heatOpacity" type="range" min="0.1" max="1" step="0.05" /></label>
          <div class="legend">
            <span class="dot pt" /> <small>點位指紋</small> <span class="dot wk" /> <small>行走掃描</small>
            <template v-if="heatKind === 'rssi'"><span class="dot apm" /> <small>AP 估計位置</small></template>
          </div>
          <p v-if="unwalked.length" class="bad">⚠ 規劃路線未錄製：{{ unwalked.map((w) => `${w.name}（${w.id}）`).join('、') }}</p>
          <p v-if="uncovered.length" class="bad">⚠ 未覆蓋走廊約 {{ uncoveredM.toFixed(0) }} m（紅色虛線，{{ uncovered.length }} 段）</p>
          <p v-else-if="venue" class="ok">走廊皆已覆蓋</p>
        </section>

        <section>
          <h3>場次 <small class="muted">勾選 = 納入建圖</small></h3>
          <div v-if="!sessions.length" class="muted">尚無上傳的場次</div>
          <label v-for="s in sessions" :key="s.session_id" class="sess" :class="{ dim: !included[s.session_id] }">
            <input v-model="included[s.session_id]" type="checkbox" :disabled="!!s.error" />
            <span class="sw" :style="{ background: sessionColor(s.session_id) }" />
            <span class="sname">
              <b>{{ s.device?.model ?? '?' }}</b> {{ s.session_id }}
              <small class="muted">
                <template v-if="s.error">讀取失敗：{{ s.error }}</template>
                <template v-else>路線 {{ s.walks }} · 點位 {{ s.points }} · {{ fmtSize(s.bytes) }} · {{ fmtTime(s.mtime) }}<template v-if="s.synthetic"> · 模擬</template><template v-if="s.purpose"> · {{ s.purpose }}</template></template>
              </small>
            </span>
          </label>
        </section>

        <section>
          <h3>建圖</h3>
          <div class="toggles">
            <label><input v-model="targets.radiomap" type="checkbox" /> WiFi 指紋圖</label>
            <label><input v-model="targets.magmap" type="checkbox" /> 磁場圖</label>
            <label><input v-model="walksOnly" type="checkbox" /> 只用行走掃描</label>
          </div>
          <button class="big primary" :disabled="status?.running" @click="runBuild">{{ status?.running ? '建圖中…' : '建圖' }}</button>
          <div class="toggles">
            <label><input v-model="buildScope" type="radio" value="all" /> 全部樓層（建議）</label>
            <label><input v-model="buildScope" type="radio" value="level" /> 進階：只建 {{ level }}</label>
          </div>
          <div v-if="buildErr" class="bad">{{ buildErr }}</div>
          <template v-if="status && (status.running || status.jobId)">
            <div class="verdict" :class="status.running ? '' : status.exitCode === 0 ? 'ok' : 'bad'">
              {{ status.running ? '執行中' : status.exitCode === 0 ? '✓ 完成（已寫入 mapdata）' : `✗ 失敗（exit ${status.exitCode}）` }}
              <small class="muted">{{ status.jobId }} · {{ fmtTime(status.finishedAt ?? status.startedAt) }}</small>
            </div>
            <ul v-if="outputs.length" class="outs">
              <li v-for="[f, o] in outputs" :key="f">
                <b>{{ f }}</b>
                <span v-if="o.points != null"> {{ o.points }} 指紋 · {{ o.bssids }} AP</span>
                <span v-if="o.cells != null"> {{ o.cells }} 格（{{ o.cell_m }} m）</span>
                <span v-if="o.sessions"> · {{ o.sessions.length }} 場次</span>
                <span v-if="o.synthetic" class="bad"> · 模擬資料</span>
              </li>
            </ul>
            <p v-for="w in ((status.report?.warnings as string[] | undefined) ?? [])" :key="w" class="bad">⚠ {{ w }}</p>
            <ul v-if="status.report?.verdicts" class="outs">
              <li v-for="(v, k) in (status.report.verdicts as Record<string, string>)" :key="k">{{ k }}：<b :class="/GOOD|OK/i.test(v) ? 'ok' : 'bad'">{{ v }}</b></li>
            </ul>
            <div v-if="!status.running && status.exitCode === 0" class="row">
              <a v-for="p in previews" :key="p" :href="buildPreviewUrl(p)" target="_blank">{{ p }}</a>
            </div>
            <pre ref="logEl" class="log">{{ status.log }}</pre>
          </template>
        </section>
      </aside>
    </div>
  </div>
</template>

<style scoped>
.mapping { display: flex; flex-direction: column; height: 100%; min-height: 0; }
.seg { display: flex; gap: 6px; padding: 6px 12px; background: var(--tp-white); border-bottom: 1px solid var(--tp-grayscale100); }
.seg button { flex: 1; padding: 8px; border-radius: 16px; border: 1px solid var(--tp-grayscale200); background: var(--tp-white); font-size: 14px; }
.seg button.on { background: var(--tp-primary500); border-color: var(--tp-primary500); color: var(--tp-white); font-weight: 600; }
.record { flex: 1; min-height: 0; }
.split { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.mapwrap { flex: 1; min-height: 260px; position: relative; display: flex; flex-direction: column; }
.map { flex: 1; min-height: 200px; }
/* colour bar below the map (not over it: the phone map is small) */
.heatlegend { background: var(--tp-white); border-top: 1px solid var(--tp-grayscale100); padding: 5px 10px 6px; font-size: 12px; }
.htitle { font-weight: 600; margin-bottom: 2px; }
.hbar { height: 16px; border-radius: 3px; display: flex; justify-content: space-between; align-items: center; padding: 0 5px; color: #fff; font-size: 11px; text-shadow: 0 0 2px rgba(0, 0, 0, 0.7); }
.hfoot { margin-top: 3px; color: var(--tp-grayscale700); }
.hfoot .good { color: #2e9e5b; }
.hfoot .fair { color: #c98a00; }
.hfoot .poor { color: var(--tp-red600); }
.heatbusy { position: absolute; top: 8px; left: 8px; z-index: 2; background: var(--tp-white); padding: 4px 10px; border-radius: 12px; font-size: 13px; box-shadow: var(--float-shadow); }
.heatsel { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.small-label { font-size: 13px; }
.chip { padding: 5px 10px; border-radius: 16px; border: 1px solid var(--tp-grayscale200); background: var(--tp-white); font-size: 13px; }
.chip.on { background: var(--tp-primary600); border-color: var(--tp-primary600); color: var(--tp-white); }
.sel { width: 100%; padding: 7px; font-size: 13px; border-radius: 6px; border: 1px solid var(--tp-grayscale200); background: var(--tp-white); }
.opacity { display: flex; align-items: center; gap: 8px; font-size: 13px; }
.opacity input { flex: 1; }
.dot.apm { background: var(--tp-white); border: 2px solid var(--tp-grayscale900); }
.side { background: var(--tp-white); overflow-y: auto; max-height: 45vh; padding: 8px 12px calc(var(--safe-bottom) + 12px); }
@media (min-width: 900px) {
  .split { flex-direction: row; }
  .side { width: 400px; max-height: none; border-left: 1px solid var(--tp-grayscale100); }
}
section { padding: 8px 0; border-bottom: 1px solid var(--tp-grayscale100); display: flex; flex-direction: column; gap: 8px; }
h3 { margin: 0; font-size: 16px; }
.toggles { display: flex; flex-wrap: wrap; gap: 6px 14px; font-size: 14px; }
.legend { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.ramp { width: 90px; height: 10px; border-radius: 5px; }
.dot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; }
.dot.pt { background: var(--tp-primary700); }
.dot.wk { background: var(--tp-secondary500); }
.muted { color: var(--tp-grayscale500); }
small { font-size: 12px; }
.ok { color: var(--tp-primary700); margin: 0; }
.bad { color: var(--tp-red600); margin: 0; }
.warn { background: var(--tp-secondary100); padding: 6px 10px; font-size: 14px; }
.sess { display: flex; align-items: flex-start; gap: 8px; font-size: 14px; }
.sess.dim { opacity: 0.55; }
.sw { width: 12px; height: 12px; border-radius: 3px; margin-top: 5px; flex: none; }
.sname { display: flex; flex-direction: column; word-break: break-all; }
.big { width: 100%; min-height: 48px; border-radius: 8px; border: 1px solid var(--tp-grayscale200); background: var(--tp-white); font-size: 17px; font-weight: 600; }
.big.primary { background: var(--tp-primary500); border-color: var(--tp-primary500); color: var(--tp-white); }
.big:disabled { opacity: 0.5; }
.verdict { font-weight: 600; display: flex; flex-direction: column; }
.verdict.ok { color: var(--tp-primary700); }
.verdict.bad { color: var(--tp-red600); }
.outs { margin: 0; padding-left: 18px; font-size: 13px; }
.row { display: flex; gap: 12px; flex-wrap: wrap; font-size: 13px; }
.row a { color: var(--tp-primary600); }
.log { background: var(--tp-grayscale900); color: #d8e0e3; font-size: 11px; line-height: 1.35; padding: 8px; border-radius: 6px; max-height: 260px; overflow: auto; white-space: pre-wrap; margin: 0; }
</style>
