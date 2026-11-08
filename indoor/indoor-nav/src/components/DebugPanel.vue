<script setup lang="ts">
import { onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { townpass, type SensorBatch, type SensorName, type WifiScan } from '../bridge/townpass'
import type { VenueData } from '../data/types'
import type { Positioning } from '../positioning/engine'
import type { PositionUpdate } from '../positioning/types'

const props = defineProps<{
  data: VenueData | null
  venueId: string
  live?: PositionUpdate | null
  liveStats?: Positioning['stats'] | null
  liveStartedAt?: number
}>()
/**
 * Floor-detection stats from the engine (barometer availability, pressure delta in hPa, WiFi level
 * vote), shown generically so field names can evolve on the positioning side.
 */
const levelStats = () =>
  Object.entries((props.liveStats ?? {}) as unknown as Record<string, unknown>)
    .filter(([k]) => /baro|pressure|hpa|vote|levelChange/i.test(k))
    .map(([k, v]) => `${k}: ${typeof v === 'number' ? v.toFixed(2) : JSON.stringify(v)}`)
/** steps per minute since live positioning started */
const stepRate = () => {
  const st = props.liveStats
  const min = props.liveStartedAt ? (Date.now() - props.liveStartedAt) / 60000 : 0
  return st && min > 0 ? (st.steps / min).toFixed(0) : '–'
}

const open = ref(true)
const available = ref(townpass.available)
const SENSORS: SensorName[] = ['accelerometer', 'user_accelerometer', 'gyroscope', 'magnetometer', 'barometer']
const RATE_WINDOW_MS = 5000

// per-sensor sample timestamps in the last window -> Hz
const times: Record<string, number[]> = {}
const rates = reactive<Record<string, number>>({})
const unavailable = ref<string[]>([])
const batches = ref(0)
const sensorsOn = ref(false)
const wifi = ref<{ scan: WifiScan; source: string; at: number } | null>(null)
const status = ref('')
const tick = ref(0)

function onBatch(b: SensorBatch) {
  batches.value++
  if (b.unavailable?.length) unavailable.value = b.unavailable
  for (const name of SENSORS) {
    const rows = b[name]
    if (!rows?.length) continue
    const arr = (times[name] ??= [])
    for (const r of rows) arr.push(r[0])
    const cutoff = arr[arr.length - 1] - RATE_WINDOW_MS
    while (arr.length && arr[0] < cutoff) arr.shift()
    const span = arr[arr.length - 1] - arr[0]
    rates[name] = span > 0 ? ((arr.length - 1) * 1000) / span : 0
  }
}

let offs: (() => void)[] = []
let timer: ReturnType<typeof setInterval>
onMounted(() => {
  offs = [
    townpass.onSensorBatch(onBatch),
    townpass.onWifiScan((scan, source) => (wifi.value = { scan, source, at: Date.now() })),
  ]
  timer = setInterval(() => {
    available.value = townpass.available
    tick.value++
  }, 1000)
})
onBeforeUnmount(() => {
  offs.forEach((f) => f())
  clearInterval(timer)
})

async function deviceInfo() {
  const r = await townpass.getDeviceInfo()
  status.value = r.ok ? JSON.stringify(r.data) : `deviceinfo: ${r.message}`
}
function startSensors() {
  sensorsOn.value = townpass.startSensorStream({ sensors: SENSORS, interval_ms: 20, batch_ms: 200 })
  status.value = sensorsOn.value ? 'sensor_stream started' : 'bridge unavailable'
}
async function stopSensors() {
  const r = await townpass.stopSensorStream()
  sensorsOn.value = false
  status.value = r.ok ? 'sensor_stream stopped' : `stop: ${r.message}`
}
async function scanWifi() {
  status.value = 'wifi_scan…'
  const r = await townpass.wifiScan()
  status.value = r.ok ? `wifi_scan: ${r.data.results.length} APs, status ${r.data.status}, started ${r.data.scan_started}` : `wifi_scan: ${r.message}`
}
const ago = (t: number) => `${Math.round((Date.now() - t) / 1000)} s`
</script>

<template>
  <aside class="dbg" :class="{ closed: !open }">
    <button class="hd" @click="open = !open">debug {{ open ? '▾' : '▸' }}</button>
    <div v-if="open" class="body" :data-tick="tick">
      <div>
        bridge:
        <b :class="available ? 'ok' : 'bad'">{{ available ? 'flutterObject OK' : 'not available' }}</b>
      </div>
      <div>venue: {{ venueId }} · files: {{ props.data ? Object.entries(props.data.available).filter(([, v]) => v).map(([k]) => k).join(', ') || 'none' : '—' }}</div>
      <div v-if="props.data">nav: {{ props.data.nav.length }} features</div>
      <div class="row">
        <button @click="deviceInfo">deviceinfo</button>
        <button @click="scanWifi">wifi_scan</button>
        <button v-if="!sensorsOn" @click="startSensors">sensors ▶</button>
        <button v-else @click="stopSensors">sensors ■</button>
      </div>
      <table>
        <tr v-for="s in SENSORS" :key="s">
          <td>{{ s }}</td>
          <td class="n">{{ unavailable.includes(s) ? 'n/a' : rates[s] != null ? rates[s].toFixed(1) + ' Hz' : '–' }}</td>
        </tr>
      </table>
      <div>batches: {{ batches }} · streams: {{ townpass.activeStreams.join(', ') || 'none' }}</div>
      <div v-if="wifi">wifi ({{ wifi.source }}): {{ wifi.scan.results.length }} APs · {{ ago(wifi.at) }} ago</div>
      <div v-if="props.live || props.liveStats" class="livebox">
        <div>live: <b>{{ props.live?.source ?? '–' }}</b> conf {{ props.live?.confidence ?? '–' }}</div>
        <div v-if="props.live">x {{ props.live.x.toFixed(2) }} y {{ props.live.y.toFixed(2) }} {{ props.live.level }} · acc {{ props.live.accuracy_m }} m · hdg {{ props.live.heading_deg?.toFixed(0) ?? '–' }}°</div>
        <div v-if="props.liveStats">
          steps {{ props.liveStats.steps }} ({{ stepRate() }}/min) · wifi {{ props.liveStats.wifiUsed }}/{{ props.liveStats.wifiScans }} · mag {{ props.liveStats.magSteps }}
          · maps {{ props.liveStats.maps.wifi ? 'W' : '-' }}{{ props.liveStats.maps.magnetic ? 'M' : '-' }} · lost {{ props.liveStats.lostSteps }}
        </div>
        <div>floor: {{ props.liveStats?.level ?? '–' }}<template v-for="line in levelStats()" :key="line"> · {{ line }}</template><template v-if="!levelStats().length"> · (engine has no floor-detection stats yet)</template></div>
      </div>
      <div v-if="status" class="status">{{ status }}</div>
    </div>
  </aside>
</template>

<style scoped>
.dbg {
  position: absolute;
  left: 8px;
  bottom: calc(var(--sheet-h, 200px) + 8px);
  z-index: 20;
  width: min(280px, calc(100vw - 80px));
  background: rgba(20, 24, 28, 0.86);
  color: #e6e9ed;
  border-radius: 10px;
  font: 11px/1.4 ui-monospace, monospace;
}
.hd {
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  padding: 6px 10px;
  min-height: 32px;
}
.body {
  padding: 0 10px 8px;
  max-height: 40vh;
  overflow: auto;
}
.row {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin: 6px 0;
}
.row button {
  font: inherit;
  min-height: 32px;
  padding: 0 8px;
  border-radius: 6px;
  border: 1px solid #556;
  background: #2a3038;
  color: inherit;
}
table {
  width: 100%;
  border-collapse: collapse;
}
td.n {
  text-align: right;
}
.ok {
  color: #4cc27a;
}
.bad {
  color: #ff6b6b;
}
.livebox {
  margin-top: 6px;
  padding-top: 6px;
  border-top: 1px solid #445;
}
.status {
  margin-top: 4px;
  word-break: break-all;
  color: #f0c060;
}
</style>
