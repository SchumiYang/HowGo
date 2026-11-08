<script setup lang="ts">
import { computed, ref, shallowRef, useTemplateRef, watch } from 'vue'
import type { GeoJSONSource, MapMouseEvent } from 'maplibre-gl'
import type { XY } from '../../geo/frame'
import { emptyBBox, extendBBox, isValidBBox } from '../../geo/geometry'
import { venueBaseUrl } from '../../data/loader'
import type { FloorplanJson } from '../../map/floorplan'
import { getData, loadLevelFiles, postFloorplan, putData, toVenueData, type LevelFiles } from './api'
import { apply, calibrate, corners, fitInto, fromCorners, nudge, type Affine } from './calibrate'
import { useAdminMap } from './useAdminMap'

const props = defineProps<{ venueId: string; level: string }>()
const emit = defineEmits<{ dataChanged: [] }>()

const mapEl = useTemplateRef<HTMLElement>('mapEl')
const { im, frame, ready, show } = useAdminMap(mapEl)

interface Img {
  url: string
  w: number
  h: number
  /** set for a newly chosen file (uploaded on save) */
  file: File | null
  name: string
}
interface Pt {
  px?: XY
  m?: XY
}

const files = shallowRef<LevelFiles | null>(null)
const image = shallowRef<Img | null>(null)
const t = shallowRef<Affine | null>(null)
const opacity = ref(0.6)
const points = ref<Pt[]>([])
const pick = ref<'none' | 'image' | 'map'>('none')
const calib = ref<{ method: '2-point' | '3-point' | 'manual'; rms: number | null } | null>(null)
const stepM = ref(0.5)
const dirty = ref(false)
const busy = ref(false)
const error = ref('')
const status = ref('')

const complete = computed(() => points.value.filter((p): p is Required<Pt> => !!p.px && !!p.m))
const hint = computed(() =>
  pick.value === 'image' ? `點選影像上的第 ${points.value.length} 個控制點`
  : pick.value === 'map' ? `在地圖上點選同一點（第 ${points.value.length} 點）`
  : '',
)

// ---------------------------------------------------------------- load
async function load() {
  error.value = ''
  status.value = ''
  pick.value = 'none'
  image.value = null
  t.value = null
  points.value = []
  calib.value = null
  dirty.value = false
  try {
    const f = await loadLevelFiles(props.venueId, props.level)
    files.value = f
    await show(toVenueData(f, props.level), props.level)
    const fp = await getData<FloorplanJson>(props.venueId, `levels/${encodeURIComponent(props.level)}/floorplan.json`)
    if (fp?.image && fp.corners?.length === 4) {
      image.value = { url: `${venueBaseUrl(props.venueId)}levels/${encodeURIComponent(props.level)}/${encodeURIComponent(fp.image)}`, w: fp.width_px, h: fp.height_px, file: null, name: fp.image }
      t.value = fromCorners(fp.corners, fp.width_px, fp.height_px)
      opacity.value = fp.opacity ?? 0.6
      points.value = (fp.calibration?.control ?? []).map((c) => ({ px: c.px, m: c.m }))
      calib.value = fp.calibration ? { method: fp.calibration.method, rms: fp.calibration.rms_m ?? null } : null
    }
  } catch (e) {
    error.value = (e as Error).message
  }
}
watch(() => [props.venueId, props.level], load, { immediate: true })

// ---------------------------------------------------------------- image file
function wallsBBox(): [number, number, number, number] {
  const b = emptyBBox()
  for (const w of files.value?.walls ?? []) for (const p of w.geometry.coordinates) extendBBox(b, p)
  return isValidBBox(b) ? b : [0, 0, 80, 60]
}

function onFile(ev: Event) {
  const input = ev.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  error.value = ''
  if (/\.(emf|wmf|dwg|dxf)$/i.test(file.name) || /emf|wmf/i.test(file.type)) {
    error.value = '瀏覽器無法顯示 EMF / WMF / CAD 檔，請先在繪圖軟體匯出成 PNG（建議長邊 4000 px 以上）再上傳。'
    return
  }
  if (!/^image\/(png|jpeg|webp|svg\+xml)$/.test(file.type)) {
    error.value = '只接受 PNG、JPG、WebP 或 SVG。'
    return
  }
  const url = URL.createObjectURL(file)
  const el = new Image()
  el.onload = () => {
    // SVGs without intrinsic size report 0
    const w = el.naturalWidth || 2000
    const h = el.naturalHeight || 1500
    const ext = file.type === 'image/jpeg' ? 'jpg' : file.type === 'image/svg+xml' ? 'svg' : file.type.split('/')[1]
    image.value = { url, w, h, file, name: `floorplan.${ext}` }
    t.value = fitInto(w, h, wallsBBox())
    points.value = []
    calib.value = null
    dirty.value = true
  }
  el.onerror = () => (error.value = '無法讀取這個影像檔')
  el.src = url
}

// ---------------------------------------------------------------- control points
function addPoint() {
  if (!image.value) return
  // drop an unfinished point first
  points.value = points.value.filter((p) => p.px && p.m)
  points.value.push({})
  pick.value = 'image'
}

function onImageClick(ev: MouseEvent) {
  if (pick.value !== 'image' || !image.value) return
  const el = ev.currentTarget as HTMLElement
  const r = el.getBoundingClientRect()
  const px: XY = [((ev.clientX - r.left) / r.width) * image.value.w, ((ev.clientY - r.top) / r.height) * image.value.h]
  points.value[points.value.length - 1].px = px
  pick.value = 'map'
}

function onMapClick(e: MapMouseEvent) {
  if (pick.value !== 'map' || !frame.value) return
  points.value[points.value.length - 1].m = frame.value.toLocal([e.lngLat.lng, e.lngLat.lat])
  pick.value = 'none'
  if (complete.value.length >= 2) applyCalibration()
}

function removePoint(i: number) {
  points.value.splice(i, 1)
  if (pick.value !== 'none' && i === points.value.length) pick.value = 'none'
  if (complete.value.length >= 2) applyCalibration()
}

function applyCalibration() {
  if (!image.value || complete.value.length < 2) return
  try {
    const r = calibrate(complete.value)
    t.value = r.t
    calib.value = { method: r.method, rms: r.rms }
    dirty.value = true
    error.value = ''
  } catch (e) {
    error.value = (e as Error).message
  }
}

// ---------------------------------------------------------------- manual nudge
function doNudge(n: { dx?: number; dy?: number; rotDeg?: number; scale?: number }) {
  if (!t.value || !image.value) return
  t.value = nudge(t.value, image.value.w, image.value.h, n)
  if (calib.value) calib.value = { method: 'manual', rms: null }
  dirty.value = true
}
const mPerPx = computed(() => (t.value ? Math.hypot(t.value[0], t.value[3]) : 0))
const rotation = computed(() => (t.value ? ((Math.atan2(t.value[3], t.value[0]) * 180) / Math.PI).toFixed(1) : '–'))

// ---------------------------------------------------------------- map layers
async function setupLayers() {
  await ready
  const m = im.value!.map
  m.addSource('adm-cp', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
  m.addLayer({ id: 'adm-cp-res', type: 'line', source: 'adm-cp', filter: ['==', ['get', 'kind'], 'res'], paint: { 'line-color': '#C2332F', 'line-width': 2 } })
  m.addLayer({
    id: 'adm-cp-px', type: 'circle', source: 'adm-cp', filter: ['==', ['get', 'kind'], 'px'],
    paint: { 'circle-radius': 7, 'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-color': '#C2332F', 'circle-stroke-width': 2 },
  })
  m.addLayer({
    id: 'adm-cp-m', type: 'circle', source: 'adm-cp', filter: ['==', ['get', 'kind'], 'm'],
    paint: { 'circle-radius': 9, 'circle-color': '#356C77', 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 },
  })
  m.addLayer({
    id: 'adm-cp-label', type: 'symbol', source: 'adm-cp', filter: ['==', ['get', 'kind'], 'm'],
    layout: { 'text-field': ['get', 'n'], 'text-font': ['PingFang TC', 'sans-serif'], 'text-size': 12, 'text-allow-overlap': true },
    paint: { 'text-color': '#fff' },
  })
  m.on('click', onMapClick)
  redraw()
}
void setupLayers()

function redraw() {
  const m = im.value?.map
  const f = frame.value
  if (!m || !f || !m.getSource('adm-cp')) return
  const img = image.value
  void im.value!.setFloorplan(img && t.value ? { url: img.url, corners: corners(t.value, img.w, img.h), opacity: opacity.value } : null, 'walls-line')
  const feats: GeoJSON.Feature[] = []
  points.value.forEach((p, i) => {
    const n = String(i + 1)
    if (p.m) feats.push({ type: 'Feature', geometry: { type: 'Point', coordinates: f.toLngLat(p.m) }, properties: { kind: 'm', n } })
    if (p.px && t.value) {
      const q = apply(t.value, p.px)
      feats.push({ type: 'Feature', geometry: { type: 'Point', coordinates: f.toLngLat(q) }, properties: { kind: 'px', n } })
      if (p.m) feats.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: [f.toLngLat(q), f.toLngLat(p.m)] }, properties: { kind: 'res' } })
    }
  })
  ;(m.getSource('adm-cp') as GeoJSONSource).setData({ type: 'FeatureCollection', features: feats })
  m.getCanvas().style.cursor = pick.value === 'map' ? 'crosshair' : ''
}
watch([image, t, opacity, points, pick, frame], redraw, { deep: true })

// ---------------------------------------------------------------- save
async function save() {
  const img = image.value
  if (!img || !t.value) return
  busy.value = true
  error.value = ''
  status.value = ''
  try {
    let name = img.name
    if (img.file) {
      const r = await postFloorplan(props.venueId, props.level, img.file)
      name = decodeURIComponent(r.url.split('/').pop() || name)
    }
    const fp: FloorplanJson = {
      image: name,
      width_px: img.w,
      height_px: img.h,
      corners: corners(t.value, img.w, img.h).map(([x, y]) => [Math.round(x * 1000) / 1000, Math.round(y * 1000) / 1000]) as FloorplanJson['corners'],
      opacity: Math.round(opacity.value * 100) / 100,
      ...(calib.value
        ? { calibration: { method: calib.value.method, control: complete.value.map((p) => ({ px: p.px.map((v) => Math.round(v * 10) / 10) as XY, m: p.m.map((v) => Math.round(v * 1000) / 1000) as XY })), ...(calib.value.rms != null ? { rms_m: Math.round(calib.value.rms * 1000) / 1000 } : {}) } }
        : {}),
    }
    await putData(props.venueId, `levels/${encodeURIComponent(props.level)}/floorplan.json`, fp)
    image.value = { ...img, file: null, name }
    dirty.value = false
    status.value = '已儲存平面圖'
    emit('dataChanged')
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="tab">
    <aside class="panel">
      <section>
        <h3>平面圖影像（{{ level }}）</h3>
        <label class="btn file">
          選擇影像…
          <input type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml,.emf,.wmf" @change="onFile" />
        </label>
        <p class="note">支援 PNG / JPG / WebP / SVG。EMF 無法在瀏覽器顯示，請先匯出成 PNG。</p>
        <div v-if="image" class="imgwrap" :class="{ picking: pick === 'image' }" @click="onImageClick">
          <img :src="image.url" alt="平面圖預覽" draggable="false" />
          <span
            v-for="(p, i) in points.filter((q) => q.px)"
            :key="i"
            class="marker"
            :style="{ left: `${(p.px![0] / image.w) * 100}%`, top: `${(p.px![1] / image.h) * 100}%` }"
          >{{ points.indexOf(p) + 1 }}</span>
        </div>
      </section>

      <section v-if="image">
        <h3>校正</h3>
        <p class="note">2 點：等比例縮放 + 旋轉 + 平移。3 點以上：仿射最小平方（可修正掃描變形），顯示 RMS 誤差。</p>
        <button class="btn" :disabled="pick !== 'none'" @click="addPoint">＋ 新增控制點</button>
        <p v-if="hint" class="hint" role="status">{{ hint }}</p>
        <ol class="pts">
          <li v-for="(p, i) in points" :key="i">
            <span>#{{ i + 1 }}</span>
            <span class="mono">{{ p.px ? `(${p.px[0].toFixed(0)}, ${p.px[1].toFixed(0)}) px` : '影像 —' }}</span>
            <span class="mono">{{ p.m ? `(${p.m[0].toFixed(2)}, ${p.m[1].toFixed(2)}) m` : '地圖 —' }}</span>
            <button class="x" :aria-label="`刪除控制點 ${i + 1}`" @click="removePoint(i)">✕</button>
          </li>
        </ol>
        <p v-if="calib" class="calib">
          方法：{{ calib.method === '2-point' ? '2 點相似' : calib.method === '3-point' ? `${complete.length} 點仿射` : '手動調整' }}
          <template v-if="calib.rms != null"> · RMS {{ calib.rms.toFixed(2) }} m</template>
        </p>
        <p class="calib mono">比例 {{ (mPerPx * 1000).toFixed(2) }} mm/px · 旋轉 {{ rotation }}°</p>
      </section>

      <section v-if="image">
        <h3>手動微調</h3>
        <label class="row">
          步距
          <select v-model.number="stepM">
            <option :value="0.1">0.1 m / 0.1° / 0.1%</option>
            <option :value="0.5">0.5 m / 0.5° / 0.5%</option>
            <option :value="2">2 m / 2° / 2%</option>
          </select>
        </label>
        <div class="pad">
          <button class="btn" aria-label="往上移" @click="doNudge({ dy: stepM })">↑</button>
          <button class="btn" aria-label="往左移" @click="doNudge({ dx: -stepM })">←</button>
          <button class="btn" aria-label="往右移" @click="doNudge({ dx: stepM })">→</button>
          <button class="btn" aria-label="往下移" @click="doNudge({ dy: -stepM })">↓</button>
          <button class="btn" aria-label="逆時針旋轉" @click="doNudge({ rotDeg: stepM })">⟲</button>
          <button class="btn" aria-label="順時針旋轉" @click="doNudge({ rotDeg: -stepM })">⟳</button>
          <button class="btn" aria-label="放大" @click="doNudge({ scale: 1 + stepM / 100 })">＋</button>
          <button class="btn" aria-label="縮小" @click="doNudge({ scale: 1 - stepM / 100 })">－</button>
        </div>
        <label class="row">
          透明度 {{ Math.round(opacity * 100) }}%
          <input v-model.number="opacity" type="range" min="0.1" max="1" step="0.05" @input="dirty = true" />
        </label>
      </section>

      <p v-if="error" class="err" role="alert">{{ error }}</p>
      <p v-if="status" class="ok" role="status">{{ status }}</p>
      <button class="btn primary save" :disabled="!image || !dirty || busy" @click="save">{{ busy ? '儲存中…' : '儲存平面圖' }}</button>
    </aside>
    <div ref="mapEl" class="map" :class="{ crosshair: pick === 'map' }"></div>
  </div>
</template>

<style scoped>
.tab {
  /* fills the shell's flex box */
  flex: 1;
  min-height: 0;
  width: 100%;
  display: grid;
  grid-template-columns: 380px 1fr;
  height: 100%;
  min-height: 480px;
}
.panel {
  overflow-y: auto;
  padding: 12px 16px;
  border-right: 1px solid var(--tp-grayscale100, #e3e7e9);
  background: var(--tp-white, #fff);
}
.map {
  position: relative;
  min-height: 360px;
}
h3 {
  margin: 12px 0 8px;
  font-size: 16px;
  font-weight: 600;
}
.note {
  margin: 6px 0;
  font-size: 14px;
  color: var(--tp-grayscale700, #475259);
}
.file {
  position: relative;
  overflow: hidden;
}
.file input {
  position: absolute;
  inset: 0;
  opacity: 0;
  cursor: pointer;
}
.imgwrap {
  position: relative;
  margin-top: 8px;
  border: 1px solid var(--tp-grayscale200, #cad1d5);
  line-height: 0;
  user-select: none;
}
.imgwrap.picking {
  cursor: crosshair;
  outline: 3px solid var(--tp-primary500, #5ab4c5);
}
.imgwrap img {
  width: 100%;
  height: auto;
}
.marker {
  position: absolute;
  transform: translate(-50%, -50%);
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background: var(--tp-red600, #c2332f);
  color: #fff;
  font-size: 12px;
  line-height: 22px;
  text-align: center;
  pointer-events: none;
}
.hint {
  margin: 8px 0;
  padding: 8px 10px;
  border-radius: 3px;
  background: var(--tp-primary50, #edf8fa);
  color: var(--tp-primary700, #356c77);
  font-weight: 600;
}
.pts {
  margin: 8px 0;
  padding: 0;
  list-style: none;
  font-size: 14px;
}
.pts li {
  display: grid;
  grid-template-columns: 32px 1fr 1fr 40px;
  align-items: center;
  gap: 4px;
  min-height: 40px;
  border-bottom: 1px solid var(--tp-grayscale100, #e3e7e9);
}
.x {
  width: 40px;
  height: 40px;
  border: 0;
  background: transparent;
  color: var(--tp-red600, #c2332f);
}
.mono {
  font-family: ui-monospace, monospace;
  font-size: 12px;
}
.calib {
  margin: 4px 0;
  font-size: 14px;
}
.row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 8px 0;
  font-size: 14px;
}
.row input[type='range'] {
  flex: 1;
}
select {
  min-height: 40px;
  font: inherit;
}
.pad {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 6px;
}
.pad .btn {
  padding: 8px 0;
  font-size: 18px;
}
.err {
  color: var(--tp-red600, #c2332f);
  font-weight: 600;
}
.ok {
  color: var(--tp-primary700, #356c77);
  font-weight: 600;
}
.save {
  width: 100%;
  margin: 8px 0 16px;
}
@media (max-width: 760px) {
  .tab {
    grid-template-columns: 1fr;
    grid-template-rows: 55vh auto;
  }
  .panel {
    border-right: 0;
    order: 2;
  }
  .map {
    order: 1;
  }
}
</style>
