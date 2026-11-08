<script setup lang="ts">
import { computed, ref, shallowRef, useTemplateRef, watch } from 'vue'
import type { GeoJSONSource, MapLayerMouseEvent, MapLayerTouchEvent, MapMouseEvent } from 'maplibre-gl'
import { CATEGORY_LABEL } from '../../data/catalog'
import type { NavEdgeProps, NavFeature, PoiFeature, UnitFeature } from '../../data/types'
import type { XY } from '../../geo/frame'
import { TP } from '../../tokens'
import { loadLevelFiles, putData, toVenueData, type FC, type LevelFiles } from '../plan/api'
import { useAdminMap } from '../plan/useAdminMap'
import { checkReachability, linkPoi, poiNodeId, unlinkPoi, type Reachability } from './navEdit'

const props = defineProps<{ venueId: string; level: string }>()
const emit = defineEmits<{ dataChanged: [] }>()

const POI_CATEGORIES = ['toilet.accessible', 'toilet.male', 'toilet.female', 'elevator', 'stairs', 'entrance', 'exit', 'emergency_exit', 'first_aid', 'aed', 'info', 'qr_anchor']
const UNIT_CATEGORIES = ['room', 'office', 'shop', 'restroom.male', 'restroom.female', 'restroom.accessible', 'restroom.unisex', 'stairs', 'elevator', 'corridor', 'lobby', 'court', 'seating', 'opening', 'first_aid', 'nonpublic', 'walkway']
const EDGE_TYPES = ['corridor', 'door', 'ramp', 'stairs', 'elevator']
const POI_COLOR: Record<string, string> = {
  'toilet.accessible': TP.primary500, 'toilet.male': TP.primary700, 'toilet.female': TP.red600, elevator: TP.primary600,
  stairs: TP.grayscale500, entrance: '#1b8a5a', exit: '#1b8a5a', emergency_exit: '#11804c', first_aid: TP.red500, aed: TP.red500,
}
const label = (c: string) => CATEGORY_LABEL[c] ?? c

const mapEl = useTemplateRef<HTMLElement>('mapEl')
const { im, frame, ready, show } = useAdminMap(mapEl)

interface Work {
  pois: FC<PoiFeature>
  nav: FC<NavFeature>
  units: FC<UnitFeature>
}
type Sel = { kind: 'poi'; id: string } | { kind: 'edge'; index: number } | { kind: 'unit'; id: string } | null

const files = shallowRef<LevelFiles | null>(null)
const work = shallowRef<Work | null>(null)
const undoStack = shallowRef<Work[]>([])
const unitsDirty = ref(false)
const sel = shallowRef<Sel>(null)
const adding = ref<string | null>(null)
const busy = ref(false)
const error = ref('')
const status = ref('')
const warnings = shallowRef<Reachability | null>(null)

const dirty = computed(() => undoStack.value.length > 0)
const pois = computed(() => work.value?.pois.features ?? [])
const selPoi = computed(() => (sel.value?.kind === 'poi' ? pois.value.find((p) => p.properties.id === (sel.value as { id: string }).id) ?? null : null))
const selUnit = computed(() => (sel.value?.kind === 'unit' ? work.value?.units.features.find((u) => u.properties.id === (sel.value as { id: string }).id) ?? null : null))
const selEdge = computed(() => {
  if (sel.value?.kind !== 'edge') return null
  const f = work.value?.nav.features[sel.value.index]
  return f && f.properties.kind === 'edge' ? (f as { properties: NavEdgeProps }) : null
})
/** the link edge of the selected POI (its private node's edge) */
const selLink = computed(() => {
  const p = selPoi.value
  if (!p) return null
  const nid = poiNodeId(p.properties)
  return (work.value?.nav.features.find((f) => f.properties.kind === 'edge' && ((f.properties as NavEdgeProps).from === nid || (f.properties as NavEdgeProps).to === nid)) as { properties: NavEdgeProps } | undefined) ?? null
})

const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x))

// ---------------------------------------------------------------- load / refresh
async function load() {
  error.value = ''
  status.value = ''
  warnings.value = null
  sel.value = null
  adding.value = null
  undoStack.value = []
  unitsDirty.value = false
  try {
    const f = await loadLevelFiles(props.venueId, props.level)
    files.value = f
    work.value = { pois: f.pois, nav: f.nav, units: f.units }
    await refresh()
  } catch (e) {
    error.value = (e as Error).message
  }
}
watch(() => [props.venueId, props.level], load, { immediate: true })

async function refresh() {
  const f = files.value
  const w = work.value
  if (!f || !w) return
  await show(toVenueData({ ...f, pois: w.pois, nav: w.nav, units: w.units }, props.level), props.level)
  redraw()
}

/** apply a change with an undo snapshot */
function change(fn: (w: Work) => void, opts: { units?: boolean } = {}) {
  if (!work.value) return
  undoStack.value = [...undoStack.value, clone(work.value)]
  const next = clone(work.value)
  fn(next)
  work.value = next
  if (opts.units) unitsDirty.value = true
  warnings.value = null
  status.value = ''
  void refresh()
}

function undo() {
  const s = undoStack.value
  if (!s.length) return
  work.value = s[s.length - 1]
  undoStack.value = s.slice(0, -1)
  void refresh()
}

// ---------------------------------------------------------------- POI edits
function relink(w: Work, p: PoiFeature, accessible?: boolean) {
  const r = linkPoi(w.nav.features, { id: p.properties.id, level: props.level, xy: p.geometry.coordinates }, { accessible })
  w.nav.features = r.nav
  p.properties.nav_node = r.nodeId
}

function placePoi(xy: XY) {
  const cat = adding.value!
  adding.value = null
  const id = `${props.level}-poi-${cat.replace(/\W/g, '-')}-${Date.now().toString(36).slice(-5)}`
  try {
    change((w) => {
      const p: PoiFeature = { type: 'Feature', geometry: { type: 'Point', coordinates: round(xy) }, properties: { id, level: props.level, category: cat, name: label(cat) } }
      relink(w, p)
      w.pois.features.push(p)
    })
    sel.value = { kind: 'poi', id }
  } catch (e) {
    error.value = (e as Error).message
  }
}

function movePoi(id: string, xy: XY) {
  try {
    change((w) => {
      const p = w.pois.features.find((q) => q.properties.id === id)!
      const linkAcc = linkAccessible(w, p)
      p.geometry.coordinates = round(xy)
      relink(w, p, linkAcc)
    })
  } catch (e) {
    error.value = (e as Error).message
  }
}

function linkAccessible(w: Work, p: PoiFeature): boolean | undefined {
  const nid = poiNodeId(p.properties)
  const e = w.nav.features.find((f) => f.properties.kind === 'edge' && ((f.properties as NavEdgeProps).from === nid || (f.properties as NavEdgeProps).to === nid))
  return e ? (e.properties as NavEdgeProps).accessible : undefined
}

function setPoiProp(key: 'name' | 'name_en' | 'category' | 'unit_id', value: string) {
  const id = selPoi.value?.properties.id
  if (!id) return
  change((w) => {
    const p = w.pois.features.find((q) => q.properties.id === id)!
    if (value) (p.properties as unknown as Record<string, unknown>)[key] = value
    else delete (p.properties as unknown as Record<string, unknown>)[key]
  })
}

function setPoiAccessible(v: boolean | null) {
  const id = selPoi.value?.properties.id
  if (!id) return
  change((w) => {
    const p = w.pois.features.find((q) => q.properties.id === id)! as PoiFeature & { properties: { accessible?: boolean } }
    if (v === null) delete p.properties.accessible
    else p.properties.accessible = v
  })
}

function setLinkAccessible(v: boolean) {
  const id = selPoi.value?.properties.id
  if (!id) return
  change((w) => {
    const p = w.pois.features.find((q) => q.properties.id === id)!
    relink(w, p, v)
  })
}

function deletePoi() {
  const p = selPoi.value
  if (!p) return
  const id = p.properties.id
  change((w) => {
    const nid = poiNodeId(p.properties)
    if (w.pois.features.find((q) => q.properties.id === id)?.properties.nav_node === nid) w.nav.features = unlinkPoi(w.nav.features, nid)
    w.pois.features = w.pois.features.filter((q) => q.properties.id !== id)
  })
  sel.value = null
}

// ---------------------------------------------------------------- edge / unit edits
function setEdge(key: 'accessible' | 'type', value: boolean | string) {
  if (sel.value?.kind !== 'edge') return
  const i = sel.value.index
  change((w) => {
    ;(w.nav.features[i].properties as unknown as Record<string, unknown>)[key] = value
  })
}

function setUnit(key: 'category' | 'name' | 'ref' | 'accessible', value: string | boolean | null) {
  const id = selUnit.value?.properties.id
  if (!id) return
  change((w) => {
    const u = w.units.features.find((q) => q.properties.id === id)!
    const pr = u.properties as unknown as Record<string, unknown>
    if (value === '' || value === null) delete pr[key]
    else pr[key] = value
  }, { units: true })
}

// ---------------------------------------------------------------- map
const round = ([x, y]: XY): XY => [Math.round(x * 100) / 100, Math.round(y * 100) / 100]
let drag: { id: string; xy: XY } | null = null

function navFc() {
  const f = frame.value!
  const w = work.value!
  const pos = new Map<string, { xy: XY; level: string }>()
  for (const n of w.nav.features) if (n.properties.kind === 'node') pos.set(n.properties.id, { xy: n.geometry.coordinates as XY, level: n.properties.level })
  const feats: GeoJSON.Feature[] = []
  w.nav.features.forEach((e, index) => {
    if (e.properties.kind !== 'edge') return
    const a = pos.get(e.properties.from)
    const b = pos.get(e.properties.to)
    if (!a || !b || (a.level !== props.level && b.level !== props.level)) return
    const link = e.properties.from.includes('-poi-') || e.properties.to.includes('-poi-')
    feats.push({
      type: 'Feature', geometry: { type: 'LineString', coordinates: [f.toLngLat(a.xy), f.toLngLat(b.xy)] },
      properties: { index, accessible: e.properties.accessible, type: e.properties.type, link, sel: sel.value?.kind === 'edge' && sel.value.index === index },
    })
  })
  for (const [id, n] of pos) if (n.level === props.level) feats.push({ type: 'Feature', geometry: { type: 'Point', coordinates: f.toLngLat(n.xy) }, properties: { node: id } })
  return { type: 'FeatureCollection' as const, features: feats }
}

function poiFc() {
  const f = frame.value!
  return {
    type: 'FeatureCollection' as const,
    features: pois.value.map((p) => {
      const xy = drag?.id === p.properties.id ? drag.xy : (p.geometry.coordinates as XY)
      return {
        type: 'Feature' as const, geometry: { type: 'Point' as const, coordinates: f.toLngLat(xy) },
        properties: { id: p.properties.id, name: p.properties.name ?? label(p.properties.category), color: POI_COLOR[p.properties.category] ?? TP.secondary500, sel: selPoi.value?.properties.id === p.properties.id },
      }
    }),
  }
}

function redraw() {
  const m = im.value?.map
  if (!m || !frame.value || !work.value || !m.getSource('adm-nav')) return
  ;(m.getSource('adm-nav') as GeoJSONSource).setData(navFc())
  ;(m.getSource('adm-pois') as GeoJSONSource).setData(poiFc())
  m.getCanvas().style.cursor = adding.value ? 'crosshair' : ''
}
watch([sel, adding], redraw)

async function setupLayers() {
  await ready
  const m = im.value!.map
  for (const id of ['pois', 'pois-acc']) m.setLayoutProperty(id, 'visibility', 'none') // replaced by editable markers
  m.addSource('adm-nav', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
  m.addSource('adm-pois', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
  const isEdge: ['has', string] = ['has', 'index']
  m.addLayer({
    id: 'adm-edge-hit', type: 'line', source: 'adm-nav', filter: isEdge,
    paint: { 'line-color': '#000', 'line-opacity': 0.01, 'line-width': 14 },
  })
  m.addLayer({
    id: 'adm-edges', type: 'line', source: 'adm-nav', filter: isEdge,
    layout: { 'line-cap': 'round' },
    paint: {
      'line-color': ['case', ['get', 'sel'], TP.secondary500, ['get', 'link'], TP.orange500, ['get', 'accessible'], TP.primary600, TP.red600],
      'line-width': ['case', ['get', 'sel'], 6, 3],
      'line-dasharray': ['case', ['any', ['get', 'link'], ['!', ['get', 'accessible']]], ['literal', [1.5, 1.2]], ['literal', [1, 0]]],
    },
  })
  m.addLayer({ id: 'adm-nodes', type: 'circle', source: 'adm-nav', filter: ['has', 'node'], paint: { 'circle-radius': 3, 'circle-color': TP.primary700 } })
  m.addLayer({
    id: 'adm-pois', type: 'circle', source: 'adm-pois',
    paint: { 'circle-radius': ['case', ['get', 'sel'], 12, 9], 'circle-color': ['get', 'color'], 'circle-stroke-color': ['case', ['get', 'sel'], TP.secondary500, '#fff'], 'circle-stroke-width': 3 },
  })
  m.addLayer({
    id: 'adm-poi-label', type: 'symbol', source: 'adm-pois',
    layout: { 'text-field': ['get', 'name'], 'text-font': ['PingFang TC', 'sans-serif'], 'text-size': 12, 'text-offset': [0, 1.4], 'text-anchor': 'top', 'text-optional': true },
    paint: { 'text-color': TP.grayscale900, 'text-halo-color': '#fff', 'text-halo-width': 1.5 },
  })

  m.on('click', onClick)
  const startDrag = (e: MapLayerMouseEvent | MapLayerTouchEvent) => {
    const id = e.features?.[0]?.properties?.id as string | undefined
    if (!id || adding.value || ('points' in e && e.points.length !== 1)) return
    e.preventDefault() // stop the map from panning
    sel.value = { kind: 'poi', id }
    drag = { id, xy: frame.value!.toLocal([e.lngLat.lng, e.lngLat.lat]) }
    m.getCanvas().style.cursor = 'grabbing'
  }
  const moveDrag = (e: MapMouseEvent | MapLayerTouchEvent) => {
    if (!drag) return
    drag.xy = frame.value!.toLocal([e.lngLat.lng, e.lngLat.lat])
    ;(m.getSource('adm-pois') as GeoJSONSource).setData(poiFc())
  }
  const endDrag = () => {
    if (!drag) return
    const d = drag
    drag = null
    m.getCanvas().style.cursor = ''
    const p = pois.value.find((q) => q.properties.id === d.id)
    const [x, y] = p?.geometry.coordinates ?? [0, 0]
    if (Math.hypot(d.xy[0] - x, d.xy[1] - y) > 0.05) movePoi(d.id, d.xy)
    else redraw()
  }
  m.on('mousedown', 'adm-pois', startDrag)
  m.on('touchstart', 'adm-pois', startDrag)
  m.on('mousemove', moveDrag)
  m.on('touchmove', moveDrag)
  m.on('mouseup', endDrag)
  m.on('touchend', endDrag)
  m.on('mouseenter', 'adm-pois', () => !drag && (m.getCanvas().style.cursor = 'grab'))
  m.on('mouseleave', 'adm-pois', () => !drag && !adding.value && (m.getCanvas().style.cursor = ''))
  redraw()
}
void setupLayers()

function onClick(e: MapMouseEvent) {
  const m = im.value!.map
  if (adding.value) return placePoi(frame.value!.toLocal([e.lngLat.lng, e.lngLat.lat]))
  const box: [[number, number], [number, number]] = [[e.point.x - 6, e.point.y - 6], [e.point.x + 6, e.point.y + 6]]
  const poi = m.queryRenderedFeatures(box, { layers: ['adm-pois'] })[0]
  if (poi) return void (sel.value = { kind: 'poi', id: poi.properties.id })
  const ed = m.queryRenderedFeatures(box, { layers: ['adm-edge-hit'] })[0]
  if (ed) return void (sel.value = { kind: 'edge', index: ed.properties.index })
  const unit = m.queryRenderedFeatures(e.point, { layers: ['units-fill'] })[0]
  sel.value = unit ? { kind: 'unit', id: unit.properties.id } : null
}

function focusPoi(p: PoiFeature) {
  sel.value = { kind: 'poi', id: p.properties.id }
  im.value?.flyTo(p.geometry.coordinates as XY, 20)
}

// ---------------------------------------------------------------- save
async function save(force = false) {
  const w = work.value
  if (!w) return
  error.value = ''
  status.value = ''
  const r = checkReachability(w.nav.features, w.pois.features)
  if (!force && (r.unreachable.length || r.inaccessible.length)) {
    warnings.value = r
    return
  }
  busy.value = true
  try {
    const dir = `levels/${encodeURIComponent(props.level)}/`
    await putData(props.venueId, dir + 'pois.geojson', w.pois)
    await putData(props.venueId, 'nav.geojson', w.nav)
    const withUnits = unitsDirty.value
    if (withUnits) await putData(props.venueId, dir + 'units.geojson', w.units)
    undoStack.value = []
    unitsDirty.value = false
    warnings.value = null
    status.value = `已儲存（POI、導航網路${withUnits ? '、空間' : ''}）`
    emit('dataChanged')
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    busy.value = false
  }
}
const poiName = (id: string) => pois.value.find((p) => p.properties.id === id)?.properties.name ?? id
</script>

<template>
  <div class="tab">
    <div ref="mapEl" class="map"></div>
    <aside class="panel">
      <div class="bar">
        <select v-model="adding" aria-label="新增 POI 類別">
          <option :value="null">＋ 新增 POI…</option>
          <option v-for="c in POI_CATEGORIES" :key="c" :value="c">{{ label(c) }}（{{ c }}）</option>
        </select>
        <button class="btn" :disabled="!dirty" @click="undo">復原</button>
        <button class="btn primary" :disabled="!dirty || busy" @click="save()">{{ busy ? '儲存中…' : '儲存' }}</button>
      </div>
      <p v-if="adding" class="hint" role="status">在地圖上點選「{{ label(adding) }}」的位置（會自動連接最近的導航路段）</p>
      <p v-if="error" class="err" role="alert">{{ error }}</p>
      <p v-if="status" class="ok" role="status">{{ status }}</p>
      <div v-if="warnings" class="warn" role="alert">
        <b>導航網路檢查</b>
        <p v-if="warnings.unreachable.length">無法到達：{{ warnings.unreachable.map(poiName).join('、') }}</p>
        <p v-if="warnings.inaccessible.length">無障礙路線無法到達：{{ warnings.inaccessible.map(poiName).join('、') }}</p>
        <div class="row"><button class="btn" @click="warnings = null">返回修改</button><button class="btn danger" @click="save(true)">仍要儲存</button></div>
      </div>

      <!-- selection editors -->
      <section v-if="selPoi" class="card">
        <h3>POI · {{ selPoi.properties.id }}</h3>
        <label>類別
          <select :value="selPoi.properties.category" @change="setPoiProp('category', ($event.target as HTMLSelectElement).value)">
            <option v-for="c in POI_CATEGORIES" :key="c" :value="c">{{ label(c) }}（{{ c }}）</option>
          </select>
        </label>
        <label>名稱 <input :value="selPoi.properties.name ?? ''" @change="setPoiProp('name', ($event.target as HTMLInputElement).value)" /></label>
        <label>英文名稱 <input :value="(selPoi.properties as { name_en?: string }).name_en ?? ''" @change="setPoiProp('name_en', ($event.target as HTMLInputElement).value)" /></label>
        <label>所屬空間
          <select :value="selPoi.properties.unit_id ?? ''" @change="setPoiProp('unit_id', ($event.target as HTMLSelectElement).value)">
            <option value="">（無）</option>
            <option v-for="u in work?.units.features ?? []" :key="u.properties.id" :value="u.properties.id">{{ u.properties.name || u.properties.ref || u.properties.id }}</option>
          </select>
        </label>
        <label>無障礙
          <select :value="String((selPoi.properties as { accessible?: boolean }).accessible ?? '')" @change="setPoiAccessible(({ true: true, false: false } as Record<string, boolean>)[($event.target as HTMLSelectElement).value] ?? null)">
            <option value="">未標示</option><option value="true">是</option><option value="false">否</option>
          </select>
        </label>
        <p class="mono">導航節點 {{ selPoi.properties.nav_node ?? '—' }}</p>
        <label v-if="selLink" class="check">
          <input type="checkbox" :checked="selLink.properties.accessible" @change="setLinkAccessible(($event.target as HTMLInputElement).checked)" />
          連接通道無障礙（門口有階梯請取消）
        </label>
        <p v-else class="note">此 POI 使用既有節點；拖曳移動後會建立專屬節點並連接最近路段。</p>
        <p class="note">拖曳地圖上的圓點可移動；橘色虛線為連接線預覽，按「儲存」才寫入。</p>
        <button class="btn danger" @click="deletePoi">刪除 POI</button>
      </section>

      <section v-else-if="selEdge" class="card">
        <h3>導航路段 {{ selEdge.properties.from }} ↔ {{ selEdge.properties.to }}</h3>
        <p class="mono">{{ selEdge.properties.length_m }} m</p>
        <label class="check">
          <input type="checkbox" :checked="selEdge.properties.accessible" @change="setEdge('accessible', ($event.target as HTMLInputElement).checked)" />
          無障礙（無階梯）
        </label>
        <label>類型
          <select :value="selEdge.properties.type" @change="setEdge('type', ($event.target as HTMLSelectElement).value)">
            <option v-for="t in EDGE_TYPES" :key="t" :value="t">{{ t }}</option>
          </select>
        </label>
      </section>

      <section v-else-if="selUnit" class="card">
        <h3>空間 · {{ selUnit.properties.id }}</h3>
        <label>類別
          <select :value="selUnit.properties.category" @change="setUnit('category', ($event.target as HTMLSelectElement).value)">
            <option v-for="c in UNIT_CATEGORIES" :key="c" :value="c">{{ label(c) }}（{{ c }}）</option>
          </select>
        </label>
        <label>名稱 <input :value="selUnit.properties.name ?? ''" @change="setUnit('name', ($event.target as HTMLInputElement).value)" /></label>
        <label>編號 ref <input :value="selUnit.properties.ref ?? ''" @change="setUnit('ref', ($event.target as HTMLInputElement).value)" /></label>
        <label>無障礙
          <select :value="String(selUnit.properties.accessible ?? '')" @change="setUnit('accessible', ({ true: true, false: false } as Record<string, boolean>)[($event.target as HTMLSelectElement).value] ?? null)">
            <option value="">未標示</option><option value="true">是</option><option value="false">否</option>
          </select>
        </label>
      </section>
      <p v-else class="note">點選地圖上的 POI、導航路段或空間以編輯。</p>

      <h3>{{ level }} POI（{{ pois.length }}）</h3>
      <ul class="list">
        <li v-for="p in pois" :key="p.properties.id">
          <button :class="{ on: selPoi?.properties.id === p.properties.id }" @click="focusPoi(p)">
            <span class="dot" :style="{ background: POI_COLOR[p.properties.category] ?? TP.secondary500 }"></span>
            <span class="nm">{{ p.properties.name ?? label(p.properties.category) }}</span>
            <span class="ct">{{ label(p.properties.category) }}</span>
          </button>
        </li>
      </ul>
    </aside>
  </div>
</template>

<style scoped>
.tab {
  /* fills the shell's flex box */
  flex: 1;
  min-height: 0;
  width: 100%;
  display: grid;
  grid-template-columns: 1fr 380px;
  height: 100%;
  min-height: 480px;
}
.map {
  position: relative;
  min-height: 360px;
}
.panel {
  overflow-y: auto;
  padding: 12px 16px;
  border-left: 1px solid var(--tp-grayscale100, #e3e7e9);
  background: var(--tp-white, #fff);
}
.bar {
  display: grid;
  grid-template-columns: 1fr auto auto;
  gap: 8px;
}
select,
input:not([type='checkbox']) {
  min-height: 44px;
  font: inherit;
  font-size: 16px;
  padding: 4px 8px;
  border: 1px solid var(--tp-grayscale200, #cad1d5);
  border-radius: 6px;
  width: 100%;
}
h3 {
  margin: 12px 0 8px;
  font-size: 16px;
  font-weight: 600;
  word-break: break-all;
}
.card {
  margin: 12px 0;
  padding: 12px;
  border-radius: 3px;
  background: var(--tp-white, #fff);
  box-shadow: 0 0 12px rgba(0, 0, 0, 0.08);
}
.card label {
  display: block;
  margin: 8px 0;
  font-size: 14px;
  color: var(--tp-grayscale700, #475259);
}
.card .check {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 44px;
  color: var(--tp-grayscale900, #171b1d);
}
.check input {
  width: 22px;
  height: 22px;
}
.note {
  font-size: 14px;
  color: var(--tp-grayscale700, #475259);
}
.mono {
  font-family: ui-monospace, monospace;
  font-size: 12px;
}
.hint {
  padding: 8px 10px;
  border-radius: 3px;
  background: var(--tp-primary50, #edf8fa);
  color: var(--tp-primary700, #356c77);
  font-weight: 600;
}
.err {
  color: var(--tp-red600, #c2332f);
  font-weight: 600;
}
.ok {
  color: var(--tp-primary700, #356c77);
  font-weight: 600;
}
.warn {
  margin: 8px 0;
  padding: 10px;
  border: 1px solid var(--tp-orange500, #fd853a);
  border-radius: 3px;
  background: #fff4ec;
}
.warn p {
  margin: 4px 0;
}
.row {
  display: flex;
  gap: 8px;
}
.list {
  margin: 0;
  padding: 0;
  list-style: none;
}
.list button {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-height: 44px;
  padding: 4px;
  border: 0;
  border-bottom: 1px solid var(--tp-grayscale100, #e3e7e9);
  background: transparent;
  text-align: left;
  font: inherit;
}
.list button.on {
  background: var(--tp-primary50, #edf8fa);
}
.dot {
  flex: none;
  width: 14px;
  height: 14px;
  border-radius: 50%;
}
.nm {
  flex: 1;
}
.ct {
  font-size: 12px;
  color: var(--tp-grayscale700, #475259);
}
@media (max-width: 760px) {
  .tab {
    grid-template-columns: 1fr;
    grid-template-rows: 55vh auto;
  }
  .panel {
    border-left: 0;
  }
}
</style>
