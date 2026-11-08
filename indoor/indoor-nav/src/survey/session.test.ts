import { describe, expect, it } from 'vitest'
import type { WifiScan } from '../bridge/townpass'
import {
  buildWalk, classifyScan, compassName, makeSessionId, modelFromUserAgent, nearestUndone, newSession, parsePlan, progress, turnVertices,
  validateSession, walkPath, type PlanWalk,
} from './session'

const scan = (started: boolean | undefined, ts: (number | null)[]): WifiScan => ({
  supported: true, status: 'ok', scan_started: started, collected_at: 1,
  results: ts.map((t, i) => ({ bssid: `b${i}`, ssid: 's', level: -50, frequency: 2437, timestamp: t })),
})

const planFc = {
  features: [
    { geometry: { type: 'Point', coordinates: [0, 0] }, properties: { kind: 'point', id: 'sp1', level: '1F' } },
    { geometry: { type: 'Point', coordinates: [4, 0] }, properties: { kind: 'point', id: 'sp2', level: '1F' } },
    { geometry: { type: 'Point', coordinates: [9, 0] }, properties: { kind: 'point', id: 'sp3', level: '1F' } },
    { geometry: { type: 'Point', coordinates: [9, 0] }, properties: { kind: 'point', id: 'x', level: '2F' } },
    { geometry: { type: 'LineString', coordinates: [[0, 0], [5, 0], [5, 5]] }, properties: { kind: 'walk', id: 'w1', level: '1F', name: 'W', length_m: 10 } },
  ],
}
const device = { model: 'SM-A716B', platform: 'android', user_agent: 'ua' }

describe('fresh scan filtering', () => {
  it('rejects throttled scans', () => expect(classifyScan(scan(false, [10]), null)).toBe('throttled'))
  it('rejects empty scans', () => expect(classifyScan(scan(true, []), null)).toBe('empty'))
  it('accepts first scan and newer ones, rejects stale', () => {
    expect(classifyScan(scan(true, [10, 20]), null)).toBe('fresh')
    expect(classifyScan(scan(true, [10, 20]), 20)).toBe('stale')
    expect(classifyScan(scan(true, [5, 21]), 20)).toBe('fresh')
  })
  it('accepts stream scans (no scan_started) and scans without timestamps', () => {
    expect(classifyScan(scan(undefined, [30]), 20)).toBe('fresh')
    expect(classifyScan(scan(true, [null]), 20)).toBe('fresh')
  })
})

describe('walks', () => {
  const coords: [number, number][] = [[0, 0], [5, 0], [5, 5]]
  it('reverse path is reversed without mutating the plan', () => {
    expect(walkPath(coords, 'reverse')).toEqual([[5, 5], [5, 0], [0, 0]])
    expect(walkPath(coords, 'forward')).toEqual(coords)
    expect(coords[0]).toEqual([0, 0])
  })
  it('buildWalk follows the contract', () => {
    const walk: PlanWalk = { id: 'w1', level: '1F', name: 'W', length_m: 10, coords }
    const w = buildWalk({
      walk, direction: 'reverse', pose: 'flat', t_start: 100, t_end: 200, marks: [{ t: 150, vertex: 1 }],
      sensors: { accelerometer: [[101, 0, 0, 9.8]], gyroscope: [], magnetometer: [[101, 1, 2, 3]] }, wifi_scans: [],
    })
    expect(w).toMatchObject({ walk_id: 'w1', level: '1F', direction: 'reverse', path: [[5, 5], [5, 0], [0, 0]], phone_pose: 'flat' })
  })
})

describe('session', () => {
  it('session id and UA model', () => {
    expect(makeSessionId(new Date(2026, 10, 7, 14, 25, 30), 'SM-A716B')).toBe('20261107-142530-a71')
    expect(modelFromUserAgent('Mozilla/5.0 (Linux; Android 13; SM-A716B Build/TP1A.220624.014; wv) AppleWebKit/537.36')).toBe('SM-A716B')
    expect(modelFromUserAgent('Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36')).toBeNull()
  })
  it('assembles a valid session with progress', () => {
    const plan = parsePlan(planFc, '1F')
    expect(plan.points.map((p) => p.id)).toEqual(['sp1', 'sp2', 'sp3'])
    const s = newSession('tianmu', device, new Date(2026, 10, 7, 14, 25, 30))
    s.wifi_points.push({ point_id: 'sp1', level: '1F', x: 0, y: 0, scans: [{ collected_at: 1, results: [] }] })
    s.walks.push(buildWalk({
      walk: plan.walks[0], direction: 'forward', pose: 'flat', t_start: 1, t_end: 2, marks: [],
      sensors: { accelerometer: [], gyroscope: [], magnetometer: [] }, wifi_scans: [],
    }))
    expect(validateSession(JSON.parse(JSON.stringify(s)))).toBeNull()
    expect(s.schema).toBe('tpnav-survey/0')
    expect(progress(plan, s)).toEqual({ pointsDone: 1, pointsTotal: 3, walksDone: 1, walksTotal: 2 })
    expect(nearestUndone(plan, s, [0, 0])?.id).toBe('sp2')
    expect(validateSession({ ...s, session_id: '../x' })).toBe('bad session_id')
  })
})

describe('corner marks', () => {
  it('only real turns count, indexed in walking order', () => {
    // straight-through vertex at [5,0], right turn at [10,0] (heading east -> south), left turn at [10,-10]
    const path: [number, number][] = [[0, 0], [5, 0], [10, 0], [10, -10], [20, -10]]
    expect(turnVertices(path).map((t) => [t.index, t.turn])).toEqual([[2, 'right'], [3, 'left']])
    // reversed walk: same corners, mirrored turn directions, indices into the reversed path
    expect(turnVertices(walkPath(path, 'reverse')).map((t) => [t.index, t.turn])).toEqual([[1, 'right'], [2, 'left']])
    expect(turnVertices([[0, 0], [5, 0.5], [10, 0]])).toEqual([])
  })
  it('names corners by compass position', () => {
    expect(compassName([95, 95], [0, 0, 100, 100])).toBe('東北角')
    expect(compassName([5, 50], [0, 0, 100, 100])).toBe('西側')
    expect(compassName([50, 50], [0, 0, 100, 100])).toBe('中央')
  })
})
