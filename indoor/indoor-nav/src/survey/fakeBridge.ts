/**
 * Dev-only simulated `window.flutterObject` (enable with `?fake=1`, add `&throttle=1` to make every
 * 3rd wifi_scan throttled). Implements wifi_scan, wifi_scan_stream, sensor_stream and deviceinfo
 * closely enough to exercise the survey page outside TownPass.
 */
type L = (e: { data: string }) => void

export function installFakeBridge() {
  const params = new URLSearchParams(location.search)
  if (params.get('fake') !== '1' || window.flutterObject) return
  const throttle = params.get('throttle') === '1'
  const listeners: L[] = []
  const emit = (name: string, data: unknown) => {
    const e = { data: JSON.stringify({ name, data }) }
    for (const l of listeners) l(e)
  }
  const boot = performance.now()
  let scanCount = 0
  let wifiTimer: ReturnType<typeof setInterval> | null = null
  let sensorTimer: ReturnType<typeof setInterval> | null = null

  const scan = (started: boolean) => {
    const ts = Math.round((performance.now() - boot) * 1000) + 1e11
    const results = Array.from({ length: 8 + (scanCount % 4) }, (_, i) => ({
      bssid: `02:00:00:00:00:${i.toString(16).padStart(2, '0')}`,
      ssid: `FAKE-${i}`,
      level: -40 - i * 6 - Math.round(Math.random() * 4),
      frequency: i % 2 ? 5180 : 2437,
      timestamp: started ? ts - i * 1000 : ts - 6e7,
    }))
    return { supported: true, status: 'ok', scan_started: started, collected_at: Date.now(), results }
  }

  window.flutterObject = {
    addEventListener: (_t, l) => listeners.push(l),
    postMessage(raw: string) {
      const { name, data } = JSON.parse(raw)
      if (name === 'deviceinfo') setTimeout(() => emit(name, { model: 'FAKE-DEVICE', os: 'android' }), 50)
      else if (name === 'wifi_scan') {
        scanCount++
        const started = !(throttle && scanCount % 3 === 0)
        setTimeout(() => emit(name, scan(started)), started ? 800 : 100)
      } else if (name === 'wifi_scan_stream') {
        if (wifiTimer) clearInterval(wifiTimer)
        wifiTimer = null
        if (data?.action === 'start') {
          wifiTimer = setInterval(() => {
            const s: Record<string, unknown> = scan(true)
            delete s.scan_started
            emit(name, s)
          }, data.interval_ms ?? 5000)
        } else setTimeout(() => emit(name, true), 30)
      } else if (name === 'sensor_stream') {
        if (sensorTimer) clearInterval(sensorTimer)
        sensorTimer = null
        if (data?.action === 'start') {
          const dt = data.interval_ms ?? 20
          let t = Date.now()
          sensorTimer = setInterval(() => {
            const now = Date.now()
            const acc: number[][] = [], gyr: number[][] = [], mag: number[][] = []
            for (; t < now; t += dt) {
              const ph = t / 300
              acc.push([t, 0.3 * Math.sin(ph), 0.2, 9.81 + Math.sin(ph * 2)])
              gyr.push([t, 0.01, -0.02, 0.005 * Math.sin(ph)])
              mag.push([t, 20 + 5 * Math.sin(t / 2000), -10, -40 + 3 * Math.cos(t / 1500)])
            }
            emit(name, { accelerometer: acc, gyroscope: gyr, magnetometer: mag })
          }, data.batch_ms ?? 200)
        } else setTimeout(() => emit(name, true), 30)
      }
    },
  }
  console.info('[survey] fake flutterObject installed')
}

installFakeBridge()
