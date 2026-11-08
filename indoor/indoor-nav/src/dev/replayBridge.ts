/**
 * Dev-only: a fake `window.flutterObject` that replays a recorded / synthetic survey walk
 * (mapdata/survey/raw/*.json `walks[]` entry) or a live validation run's raw data (mapdata/survey/eval/*.json `raw`,
 * barometer included when recorded) through sensor_stream and wifi_scan_stream, so live
 * positioning can be exercised in a desktop browser. Loaded only with `?replay=...` (main.ts):
 *   ?replay=<url of a walk or session JSON>[&walk=<walk_id>][&speed=2]
 *   ?replay=1  with the walk object injected as window.__TPNAV_REPLAY__ (headless screenshots)
 * Timestamps are shifted so the walk starts when sensor_stream starts.
 */
import type { BaroSample, Vec3Sample, WifiResult } from '../bridge/townpass'

interface Walk {
  walk_id?: string
  sensors: { accelerometer: Vec3Sample[]; gyroscope: Vec3Sample[]; magnetometer: Vec3Sample[]; barometer?: BaroSample[] }
  wifi_scans?: { collected_at: number; results: WifiResult[] }[]
  unavailable?: string[]
}

declare global {
  interface Window {
    __TPNAV_REPLAY__?: Walk
  }
}

type L = (e: { data: string }) => void

export async function installReplayBridge() {
  const params = new URLSearchParams(location.search)
  const src = params.get('replay')
  if (!src || window.flutterObject) return
  let walk: Walk | undefined = window.__TPNAV_REPLAY__
  if (!walk && src !== '1') {
    const j = await (await fetch(src)).json()
    const id = params.get('walk')
    walk = Array.isArray(j.walks) ? (j.walks.find((w: Walk) => !id || w.walk_id === id) ?? j.walks[0]) : j.raw?.sensors ? { walk_id: j.run_id, ...j.raw } : j
  }
  if (!walk) return console.warn('[replay] no walk to replay')
  const w = walk
  const speed = Math.max(0.1, Number(params.get('speed') ?? 1))
  const listeners: L[] = []
  const emit = (name: string, data: unknown) => listeners.forEach((l) => l({ data: JSON.stringify({ name, data }) }))
  const t0 = w.sensors.accelerometer[0]?.[0] ?? 0
  let sensorTimer: ReturnType<typeof setInterval> | null = null
  let wifiTimer: ReturnType<typeof setInterval> | null = null
  let shift = 0 // added to recorded timestamps
  let wallStart = 0

  const recordedNow = () => t0 + (performance.now() - wallStart) * speed
  const cursors = { accelerometer: 0, gyroscope: 0, magnetometer: 0 }
  let baroCursor = 0

  window.flutterObject = {
    addEventListener: (_t, l) => listeners.push(l),
    postMessage(raw: string) {
      const { name, data } = JSON.parse(raw)
      if (name === 'sensor_stream') {
        if (sensorTimer) clearInterval(sensorTimer)
        sensorTimer = null
        if (data?.action !== 'start') return void setTimeout(() => emit(name, true), 20)
        wallStart = performance.now()
        shift = Date.now() - t0
        for (const k of Object.keys(cursors) as (keyof typeof cursors)[]) cursors[k] = 0
        baroCursor = 0
        if (w.unavailable?.length) emit(name, { unavailable: w.unavailable })
        sensorTimer = setInterval(() => {
          const until = recordedNow()
          const batch: Record<string, Vec3Sample[] | BaroSample[]> = {}
          for (const k of Object.keys(cursors) as (keyof typeof cursors)[]) {
            const arr = w.sensors[k]
            const out: Vec3Sample[] = []
            while (cursors[k] < arr.length && arr[cursors[k]][0] <= until) {
              const s = arr[cursors[k]++]
              out.push([s[0] + shift, s[1], s[2], s[3]])
            }
            if (out.length) batch[k] = out
          }
          const baro = w.sensors.barometer ?? []
          const b: BaroSample[] = []
          while (baroCursor < baro.length && baro[baroCursor][0] <= until) {
            const s = baro[baroCursor++]
            b.push([s[0] + shift, s[1]])
          }
          if (b.length) batch.barometer = b
          if (Object.keys(batch).length) emit(name, batch)
          if (cursors.accelerometer >= w.sensors.accelerometer.length && sensorTimer) clearInterval(sensorTimer)
        }, data.batch_ms ?? 200)
      } else if (name === 'wifi_scan_stream') {
        if (wifiTimer) clearInterval(wifiTimer)
        wifiTimer = null
        if (data?.action !== 'start') return void setTimeout(() => emit(name, true), 20)
        let next = 0
        const scans = w.wifi_scans ?? []
        wifiTimer = setInterval(() => {
          while (next < scans.length && scans[next].collected_at <= recordedNow()) {
            const s = scans[next++]
            emit(name, { supported: true, status: 'ok', collected_at: s.collected_at + shift, results: s.results })
          }
        }, 250)
      }
    },
  }
  console.info(`[replay] fake flutterObject replaying ${w.walk_id ?? 'walk'} at ${speed}x`)
}
