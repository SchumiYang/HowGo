<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import FloorPlanTab from './plan/FloorPlanTab.vue'
import PoiTab from './poi/PoiTab.vue'
import MappingTab from './mapping/MappingTab.vue'
import EvalTab from './eval/EvalTab.vue'
import { health } from './api'
import { getVenue } from './venue'
import type { Level } from '../data/types'
import { venueShortName } from '../config'

type TabId = 'plan' | 'poi' | 'mapping' | 'eval'
const TABS: { id: TabId; label: string }[] = [
  { id: 'plan', label: '平面圖' },
  { id: 'poi', label: 'POI' },
  { id: 'mapping', label: '場勘建圖' },
  { id: 'eval', label: '驗證' },
]

const params = new URLSearchParams(location.search)
const venueId = params.get('venue') ?? 'tianmu'
const levels = ref<Level[]>([])
const level = ref(params.get('level') ?? '')
const venueName = ref('')
const loadError = ref('')
const serverOk = ref<boolean | null>(null)

const hashTab = (): TabId => {
  const h = location.hash.replace(/^#/, '').split('-')[0]
  return (TABS.some((t) => t.id === h) ? h : 'mapping') as TabId
}
const tab = ref<TabId>(hashTab())
/** mapping (survey recording) and eval (live engine run) keep running in the background once opened */
const visited = ref<Record<TabId, boolean>>({ plan: false, poi: false, mapping: false, eval: false })
/** bumped on dataChanged: plan / POI tabs remount and reload */
const dataVersion = ref(0)
/** a survey recording is running: the floor cannot change under it */
const floorLocked = ref(false)

watch(tab, (t) => {
  visited.value[t] = true
  if (location.hash.replace(/^#/, '').split('-')[0] !== t) history.replaceState(null, '', `#${t}`)
}, { immediate: true })
window.addEventListener('hashchange', () => (tab.value = hashTab()))

function onDataChanged() {
  dataVersion.value++
  void getVenue(venueId, true)
}

onMounted(async () => {
  try {
    const d = await getVenue(venueId)
    levels.value = d.levels.map((l) => l.level)
    venueName.value = venueShortName(d.venue)
    if (!levels.value.some((l) => l.id === level.value)) level.value = d.venue.default_level ?? levels.value[0]?.id ?? '1F'
  } catch (e) {
    loadError.value = `場館資料載入失敗：${(e as Error).message}`
    level.value ||= '1F'
  }
  health().then((h) => (serverOk.value = h.ok), () => (serverOk.value = false))
})
</script>

<template>
  <div class="admin">
    <header class="top">
      <div class="brand">
        <!-- inside TownPass the app bar already shows the page title, so the title is desktop-only -->
        <b class="title">管理後台</b>
        <small class="muted">{{ venueName || venueId }}</small>
        <span class="srv" :class="{ ok: serverOk, bad: serverOk === false }" :title="serverOk === false ? '無法連線 /api（僅本機開發伺服器提供）' : ''" />
      </div>
      <div class="floors" role="tablist" aria-label="樓層">
        <span v-if="floorLocked" class="lock">錄製中</span>
        <button v-for="l in levels" :key="l.id" :class="{ on: l.id === level }" :disabled="floorLocked && l.id !== level" :title="floorLocked ? '錄製中，暫停切換樓層' : ''" @click="level = l.id">{{ l.name }}</button>
      </div>
      <nav class="tabs">
        <button v-for="t in TABS" :key="t.id" :class="{ on: tab === t.id }" @click="tab = t.id">{{ t.label }}</button>
      </nav>
    </header>
    <div v-if="loadError" class="warn">{{ loadError }}</div>

    <main v-if="level" class="body">
      <FloorPlanTab v-if="tab === 'plan'" :key="`plan-${level}-${dataVersion}`" :venue-id="venueId" :level="level" @data-changed="onDataChanged" />
      <PoiTab v-else-if="tab === 'poi'" :key="`poi-${level}-${dataVersion}`" :venue-id="venueId" :level="level" @data-changed="onDataChanged" />
      <div v-if="visited.mapping" v-show="tab === 'mapping'" class="pane">
        <MappingTab :venue-id="venueId" :level="level" @data-changed="onDataChanged" @busy="(b: boolean) => (floorLocked = b)" />
      </div>
      <div v-if="visited.eval" v-show="tab === 'eval'" class="pane">
        <EvalTab :venue-id="venueId" :level="level" />
      </div>
    </main>
  </div>
</template>

<style scoped>
.admin { display: flex; flex-direction: column; height: 100%; }
.top {
  /* no safe-area padding: the page always sits below the TownPass app bar (or in a desktop browser) */
  display: flex; flex-wrap: wrap; align-items: center; gap: 2px 16px; padding: 4px 12px 0;
  background: var(--tp-white); box-shadow: var(--tp-sheet-shadow); z-index: 3;
}
.brand { display: flex; align-items: center; gap: 8px; }
.brand b { font-size: 17px; }
.brand small { font-size: 14px; }
.title { display: none; }
.muted { color: var(--tp-grayscale500); }
.srv { width: 9px; height: 9px; border-radius: 50%; background: var(--tp-grayscale300); }
.srv.ok { background: var(--tp-primary500); }
.srv.bad { background: var(--tp-red500); }
.floors { display: flex; gap: 4px; margin-left: auto; }
.floors button { min-width: 44px; padding: 5px 10px; border-radius: 16px; border: 1px solid var(--tp-grayscale200); background: var(--tp-white); font-size: 14px; }
.floors button:disabled { opacity: 0.4; }
.lock { font-size: 12px; color: var(--tp-red600); align-self: center; }
.floors button.on { background: var(--tp-primary600); border-color: var(--tp-primary600); color: var(--tp-white); font-weight: 600; }
.tabs { display: flex; width: 100%; order: 3; }
.tabs button { flex: 1; border: 0; background: none; padding: 10px 0; font-size: 15px; color: var(--tp-grayscale500); border-bottom: 3px solid transparent; }
.tabs button.on { color: var(--tp-primary600); border-bottom-color: var(--tp-primary500); font-weight: 600; }
@media (min-width: 900px) {
  .top { padding-top: 6px; gap: 6px 16px; }
  .title { display: inline; }
  .tabs { width: auto; order: 0; flex: 0 1 480px; }
  .floors { order: 2; }
}
.warn { background: var(--tp-secondary100); padding: 6px 12px; font-size: 14px; }
.body { flex: 1; min-height: 0; position: relative; display: flex; flex-direction: column; }
.body > * { flex: 1; min-height: 0; }
.pane { height: 100%; display: flex; flex-direction: column; }
.pane > * { flex: 1; min-height: 0; }
</style>
