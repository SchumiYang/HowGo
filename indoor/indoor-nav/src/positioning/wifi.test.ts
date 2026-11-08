import { describe, expect, it } from 'vitest'
import type { WifiResult, WifiScan } from '../bridge/townpass'
import type { Radiomap } from './types'
import { apKey, isLocallyAdministered, WifiModel } from './wifi'

const APS: [string, number, number][] = [
  ['00:11:22:00:00:01', 0, 0],
  ['00:11:22:00:00:02', 20, 0],
  ['00:11:22:00:00:03', 10, 10],
  ['00:11:22:00:00:04', 30, 8],
]
const rssiAt = (x: number, y: number, ax: number, ay: number) => -35 - 25 * Math.log10(Math.max(1, Math.hypot(x - ax, y - ay)))

const points = [0, 4, 8, 12, 16, 20, 24, 28].map((x, i) => ({
  id: `p${i}`, level: '1F', x, y: 2, n_scans: 4,
  aps: Object.fromEntries(APS.map(([b, ax, ay]) => [b, { mean: rssiAt(x, 2, ax, ay), std: 2, detect: 1 }])),
}))
const radiomap: Radiomap = { bssids: APS.map((a) => a[0]), points }

let ts = 1_000_000
function scanAt(x: number, y: number, extra: WifiResult[] = []): WifiScan {
  ts += 5_000_000
  return {
    supported: true, status: 'ok', collected_at: 1_800_000_000_000 + ts / 1000,
    results: [...APS.map(([bssid, ax, ay]) => ({ bssid, ssid: 'x', level: Math.round(rssiAt(x, y, ax, ay)), frequency: 2437, timestamp: ts })), ...extra],
  }
}

describe('WifiModel', () => {
  it('locates a scan near the matching fingerprints (WkNN)', () => {
    const m = new WifiModel(radiomap, '1F')
    const r = m.wknn(m.observe(scanAt(13, 2))!)!
    expect(Math.abs(r.x - 13)).toBeLessThan(3)
    expect(r.y).toBeCloseTo(2, 5)
  })

  it('drops cached repeats, hotspots, stale and unknown results', () => {
    const m = new WifiModel(radiomap, '1F')
    const hotspot = { bssid: 'da:a1:19:5c:33:01', ssid: 'iPhone', level: -40, frequency: 2437, timestamp: ts + 5_000_000 }
    const s = scanAt(5, 2, [hotspot, { bssid: '00:11:22:00:00:99', ssid: 'n', level: -80, frequency: 2412, timestamp: ts + 5_000_000 }])
    const obs = m.observe(s)!
    expect(obs.nSeen).toBe(4)
    expect(obs.nUnknown).toBe(2) // only radiomap APs count: the hotspot and the unknown AP are ignored
    expect(m.observe({ ...s, collected_at: s.collected_at + 8000 })).toBeNull()
    const stale = scanAt(5, 2)
    stale.results[0].timestamp = stale.results[1].timestamp! - 20_000_000
    expect(m.observe(stale)!.nSeen).toBe(3)
    expect(isLocallyAdministered('da:a1:19:5c:33:01')).toBe(true)
    expect(isLocallyAdministered('00:11:22:00:00:01')).toBe(false)
  })

  it('groups the virtual BSSIDs of one radio (radiomap ap_grouping radio/v1)', () => {
    // campus multi-SSID: low nibble of the last octet; locally administered CodeFest E/F: first octet only
    expect(apKey('50:E4:E0:D1:48:31', 5180)).toBe(apKey('50:e4:e0:d1:48:35', 5180))
    expect(apKey('50:e4:e0:d1:48:31', 5180)).not.toBe(apKey('50:e4:e0:d1:48:31', 2437))
    expect(apKey('38:17:c3:99:db:71', 5180)).not.toBe(apKey('38:17:c3:99:db:d1', 5180))
    expect(apKey('22:6a:1b:93:bc:19', 2462)).toBe(apKey('26:6a:1b:93:bc:19', 2462))
    const grouped: Radiomap = {
      bssids: [apKey('00:11:22:33:44:51', 2437)],
      params: { ap_grouping: 'radio/v1' },
      points: [{ id: 'p', level: '1F', x: 0, y: 0, n_scans: 1, aps: { [apKey('00:11:22:33:44:51', 2437)]: { mean: -60, std: 1, detect: 1 } } }],
    }
    const m = new WifiModel(grouped, '1F', { minAps: 1 })
    const obs = m.observe({ supported: true, status: 'ok', collected_at: 1, results: [
      { bssid: '00:11:22:33:44:51', ssid: 'uTaipei', level: -58, frequency: 2437, timestamp: 1 },
      { bssid: '00:11:22:33:44:52', ssid: 'eduroam', level: -62, frequency: 2437, timestamp: 1 },
    ] })!
    expect(obs.nSeen).toBe(1)
    expect(obs.rssi[0]).toBeCloseTo(-60, 5)
  })

  it('ignores scans from platforms without WiFi scanning', () => {
    const m = new WifiModel(radiomap, '1F')
    expect(m.observe({ supported: false, status: 'unsupported', collected_at: 0, results: [] })).toBeNull()
  })

  it('likelihood peaks at the true location', () => {
    const m = new WifiModel(radiomap, '1F')
    const lik = m.fingerprintLikelihood(m.observe(scanAt(20, 2))!)
    const at = (x: number) => m.likelihoodAt(lik, x, 2)
    expect(at(20)).toBeGreaterThan(at(10))
    expect(at(20)).toBeGreaterThan(at(28))
    // unsurveyed space is neutral (mean fingerprint likelihood), not penalised
    const mean = lik.reduce((a, b) => a + b, 0) / lik.length
    expect(at(100)).toBeCloseTo(m.opts.floor + (1 - m.opts.floor) * mean, 5)
    expect(at(100)).toBeGreaterThan(at(5))
  })

  it('adapts a device RSSI offset from a trusted position', () => {
    const m = new WifiModel(radiomap, '1F')
    for (let k = 0; k < 15; k++) {
      const s = scanAt(12, 2)
      s.results.forEach((r) => (r.level -= 4))
      m.adaptOffsetAt(m.observe(s)!, 12, 2, 5)
    }
    expect(m.deviceOffsetDb).toBeGreaterThan(3)
    expect(m.deviceOffsetDb).toBeLessThan(5)
  })
})
