#!/usr/bin/env node
// Generates the mock venue (public/data/mock/) in the mapdata/SCHEMA.md format.
// 80 x 60 m, 2 levels: central court (1F) / seating around a void (2F), a corridor ring,
// rooms in the outer bands, restrooms, 2 elevators + 4 stairs, entrance + side exit.
// Run: npm run gen-mock
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'data', 'mock')
const LEVELS = [
  { id: '1F', ordinal: 0, name: '1F', elevation_m: 0 },
  { id: '2F', ordinal: 1, name: '2F', elevation_m: 5 },
]
const CLIMB = LEVELS[1].elevation_m - LEVELS[0].elevation_m

const r2 = (v) => Math.round(v * 100) / 100
const pt = ([x, y]) => [r2(x), r2(y)]
const rect = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]
const center = ([x0, y0, x1, y1]) => [(x0 + x1) / 2, (y0 + y1) / 2]
const dist = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1])
const feature = (geometry, properties) => ({ type: 'Feature', geometry, properties })
const fc = (features) => ({ type: 'FeatureCollection', features })

// ---------- unit specs (shared footprint, per-level names) ----------
// door: point on the room boundary facing the corridor ring; node: routing node inside (default centre)
function unitsFor(L) {
  const is1 = L === '1F'
  const u = (id, category, box, extra = {}) => ({ id: `${L}-${id}`, category, box, ...extra })
  return [
    // west band
    u('ST1', 'stairs', [0, 9, 10, 17], { ref: 'S1', name: '樓梯 S1', door: [10, 13], node: is1 ? [5, 10.5] : [5, 15.5] }),
    u(is1 ? 'A101' : 'C201', 'room', [0, 17, 10, 30], { ref: is1 ? 'A101' : 'C201', name: is1 ? '桌球教室' : '舞蹈教室', door: [10, 23.5] }),
    u(is1 ? 'A102' : 'C202', 'room', [0, 30, 10, 43], { ref: is1 ? 'A102' : 'C202', name: is1 ? '韻律教室' : '桌球室', door: [10, 36.5] }),
    u('ST3', 'stairs', [0, 43, 10, 51], { ref: 'S3', name: '樓梯 S3', door: [10, 47], node: is1 ? [5, 49.5] : [5, 44.5] }),
    // east band
    u('ST2', 'stairs', [70, 9, 80, 17], { ref: 'S2', name: '樓梯 S2', door: [70, 13], node: is1 ? [75, 10.5] : [75, 15.5] }),
    u(is1 ? 'B101' : 'D201', 'room', [70, 17, 80, 30], { ref: is1 ? 'B101' : 'D201', name: is1 ? '重訓室' : '會議室', door: [70, 23.5] }),
    u(is1 ? 'B102' : 'D202', 'room', [70, 30, 80, 43], { ref: is1 ? 'B102' : 'D202', name: is1 ? '會議室' : '貴賓室', door: [70, 36.5] }),
    u('ST4', 'stairs', [70, 43, 80, 51], { ref: 'S4', name: '樓梯 S4', door: [70, 47], node: is1 ? [75, 49.5] : [75, 44.5] }),
    // south band
    u('X01', 'nonpublic', [0, 0, 10, 9], { name: '儲藏室' }),
    u('WC-M1', 'restroom.male', [10, 0, 20, 9], { name: '男廁', door: [15, 9] }),
    u('WC-A1', 'restroom.accessible', [20, 0, 26, 9], { name: '無障礙廁所', door: [23, 9], accessible: true }),
    u('EV1', 'elevator', [26, 0, 32, 9], { ref: 'E1', name: '電梯 E1', door: [29, 9], accessible: true }),
    is1
      ? u('LOBBY', 'lobby', [32, 0, 48, 9], { name: '大廳', door: [40, 9], accessible: true })
      : u('REST', 'lobby', [32, 0, 48, 9], { name: '休息區', door: [40, 9], accessible: true }),
    u('WC-F1', 'restroom.female', [48, 0, 58, 9], { name: '女廁', door: [53, 9] }),
    ...(is1
      ? [
          u('MED', 'first_aid', [58, 0, 66, 9], { name: '醫護室', door: [62, 9] }),
          u('EXIT-E', 'walkway', [66, 0, 80, 9], { name: '東側通道', door: [67, 9], node: [73, 4.5] }),
        ]
      : [u('OFF', 'office', [58, 0, 80, 9], { ref: '201', name: '行政辦公室', door: [62, 9] })]),
    // north band
    u('X02', 'nonpublic', [0, 51, 10, 60], { name: '機房' }),
    u('X03', 'nonpublic', [10, 51, 22, 60], { name: is1 ? '器材室' : '廣播室' }),
    u('WC-F2', 'restroom.female', [22, 51, 32, 60], { name: '女廁', door: [27, 51] }),
    u('WC-A2', 'restroom.accessible', [32, 51, 38, 60], { name: '無障礙廁所', door: [35, 51], accessible: true }),
    u('EV2', 'elevator', [38, 51, 44, 60], { ref: 'E2', name: '電梯 E2', door: [41, 51], accessible: true }),
    u('WC-M2', 'restroom.male', [44, 51, 54, 60], { name: '男廁', door: [49, 51] }),
    is1
      ? u('OFF', 'office', [54, 51, 70, 60], { ref: '101', name: '管理辦公室', door: [62, 51] })
      : u('E201', 'room', [54, 51, 70, 60], { ref: 'E201', name: '研討室', door: [62, 51] }),
    u('X04', 'nonpublic', [70, 51, 80, 60], { name: '倉庫' }),
  ]
}

// corridor ring: outer 10..70 x 9..51, inner 18..62 x 15..45; centreline below
const RING = [[14, 12], [66, 12], [66, 48], [14, 48]]
const RING_NAMES = ['sw', 'se', 'ne', 'nw']

function buildLevel(L) {
  const specs = unitsFor(L)
  const units = []
  const walls = []
  const nodes = new Map() // id -> xy
  const edges = []
  const addNode = (id, xy) => (nodes.set(id, pt(xy)), id)
  const addEdge = (from, to, type = 'corridor', accessible = true, length) =>
    edges.push({ from, to, type, accessible, length_m: r2(length ?? dist(nodes.get(from), nodes.get(to))) })

  // ---- units ----
  for (const s of specs) {
    units.push(feature({ type: 'Polygon', coordinates: [rect(...s.box)] }, {
      id: s.id, level: L, category: s.category, ref: s.ref ?? null, name: s.name ?? null,
      ...(s.accessible ? { accessible: true } : {}),
    }))
  }
  units.push(feature({ type: 'Polygon', coordinates: [rect(10, 9, 70, 51), rect(18, 15, 62, 45).reverse()] },
    { id: `${L}-CORR`, level: L, category: 'corridor', name: '走廊', accessible: true }))
  if (L === '1F') {
    units.push(feature({ type: 'Polygon', coordinates: [rect(18, 15, 62, 45)] },
      { id: '1F-COURT', level: L, category: 'court', name: '比賽場地', accessible: true }))
  } else {
    units.push(feature({ type: 'Polygon', coordinates: [rect(18, 15, 62, 45), rect(24, 21, 56, 39).reverse()] },
      { id: '2F-SEAT', level: L, category: 'seating', name: '觀眾席' }))
  }

  // ---- corridor ring nodes ----
  const attaches = RING.map((c, i) => ({ id: addNode(`${L}-c-${RING_NAMES[i]}`, c), xy: c }))
  const attachAt = (xy) => {
    const hit = attaches.find((a) => dist(a.xy, xy) < 0.3)
    if (hit) return hit.id
    const id = addNode(`${L}-c${attaches.length - 3}`, xy)
    attaches.push({ id, xy })
    return id
  }
  // project a door onto the nearest ring leg (clamped)
  const ringProject = ([x, y]) => {
    let best = null
    for (let i = 0; i < 4; i++) {
      const a = RING[i]
      const b = RING[(i + 1) % 4]
      const dx = b[0] - a[0]
      const dy = b[1] - a[1]
      const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / (dx * dx + dy * dy)))
      const p = [a[0] + t * dx, a[1] + t * dy]
      const d = dist(p, [x, y])
      if (!best || d < best.d) best = { p, d }
    }
    return best.p
  }
  const connectDoor = (doorId, doorXY) => addEdge(attachAt(ringProject(doorXY)), doorId)

  // ---- room nodes ----
  for (const s of specs) {
    if (!s.door) continue
    const inner = addNode(s.id, s.node ?? center(s.box))
    const door = addNode(`${s.id}-door`, s.door)
    connectDoor(door, s.door)
    addEdge(door, inner, 'door')
  }
  if (L === '1F') {
    addNode('1F-entrance', [40, 0.6])
    addEdge('1F-LOBBY', '1F-entrance', 'door')
    addNode('1F-exit-e', [79.4, 4.5])
    addEdge('1F-EXIT-E', '1F-exit-e', 'door')
    addNode('1F-COURT', [40, 30])
    for (const [suffix, y, side] of [['s', 15, 12], ['n', 45, 48]]) {
      const door = addNode(`1F-COURT-door-${suffix}`, [40, y])
      addEdge(attachAt([40, side]), door)
      addEdge(door, '1F-COURT', 'door')
    }
  } else {
    const seat = { s: [40, 18], sw: [21, 18], nw: [21, 42], n: [40, 42], ne: [59, 42], se: [59, 18] }
    for (const [k, xy] of Object.entries(seat)) addNode(`2F-SEAT-${k}`, xy)
    const ring = ['s', 'sw', 'nw', 'n', 'ne', 'se', 's']
    for (let i = 0; i + 1 < ring.length; i++) addEdge(`2F-SEAT-${ring[i]}`, `2F-SEAT-${ring[i + 1]}`)
    for (const [suffix, y, side] of [['s', 15, 12], ['n', 45, 48]]) {
      const door = addNode(`2F-SEAT-door-${suffix}`, [40, y])
      addEdge(attachAt([40, side]), door)
      addEdge(door, `2F-SEAT-${suffix}`, 'door')
    }
  }

  // chain ring nodes along each leg
  for (let i = 0; i < 4; i++) {
    const a = RING[i]
    const b = RING[(i + 1) % 4]
    const len = dist(a, b)
    const onLeg = attaches
      .map((n) => ({ ...n, t: ((n.xy[0] - a[0]) * (b[0] - a[0]) + (n.xy[1] - a[1]) * (b[1] - a[1])) / (len * len) }))
      .filter((n) => n.t >= -1e-6 && n.t <= 1 + 1e-6 && Math.abs(dist(a, n.xy) + dist(n.xy, b) - len) < 1e-6)
      .sort((m, n) => m.t - n.t)
    for (let k = 0; k + 1 < onLeg.length; k++) addEdge(onLeg[k].id, onLeg[k + 1].id)
  }

  // ---- walls ----
  const seg = new Map()
  const addSeg = (a, b, layer = 'wall') => {
    const k = [pt(a).join(','), pt(b).join(',')].sort().join('|') + layer
    if (!seg.has(k)) seg.set(k, feature({ type: 'LineString', coordinates: [pt(a), pt(b)] }, { layer }))
  }
  const ringSegs = (ring, layer) => { for (let i = 0; i + 1 < ring.length; i++) addSeg(ring[i], ring[i + 1], layer) }
  ringSegs(rect(0, 0, 80, 60))
  for (const s of specs) ringSegs(rect(...s.box))
  ringSegs(rect(18, 15, 62, 45), L === '1F' ? 'wall' : 'fixture')
  walls.push(...seg.values())
  // doors drawn as short segments along the wall
  for (const s of specs) {
    if (!s.door) continue
    const [x, y] = s.door
    const vertical = x === s.box[0] || x === s.box[2]
    walls.push(feature({ type: 'LineString', coordinates: vertical ? [pt([x, y - 0.8]), pt([x, y + 0.8])] : [pt([x - 0.8, y]), pt([x + 0.8, y])] }, { layer: 'door' }))
  }
  // columns (closed rings)
  const cols = [[18, 15], [26, 15], [34, 15], [46, 15], [54, 15], [62, 15], [18, 45], [26, 45], [34, 45], [46, 45], [54, 45], [62, 45], [18, 25], [18, 35], [62, 25], [62, 35]]
  for (const [x, y] of cols) walls.push(feature({ type: 'LineString', coordinates: rect(x - 0.35, y - 0.35, x + 0.35, y + 0.35).map(pt) }, { layer: 'column' }))
  // stair treads
  for (const s of specs.filter((s) => s.category === 'stairs')) {
    const [x0, y0, x1, y1] = s.box
    for (let y = y0 + 2; y <= y1 - 2 + 1e-6; y += 0.5) walls.push(feature({ type: 'LineString', coordinates: [pt([x0 + 1, y]), pt([x1 - 1, y])] }, { layer: 'stairs' }))
  }
  if (L === '1F') {
    // basketball court markings
    const lines = [rect(26, 22.5, 54, 37.5), [[40, 22.5], [40, 37.5]]]
    const circle = Array.from({ length: 25 }, (_, i) => [40 + 1.8 * Math.cos((i / 24) * 2 * Math.PI), 30 + 1.8 * Math.sin((i / 24) * 2 * Math.PI)])
    for (const l of [...lines, circle]) walls.push(feature({ type: 'LineString', coordinates: l.map(pt) }, { layer: 'court' }))
  } else {
    walls.push(feature({ type: 'LineString', coordinates: rect(24, 21, 56, 39) }, { layer: 'fixture' }))
    for (const d of [1.5, 3, 4.5]) walls.push(feature({ type: 'LineString', coordinates: rect(24 - d, 21 - d, 56 + d, 39 + d).map(pt) }, { layer: 'fixture' }))
  }

  // ---- POIs ----
  const pois = []
  const poi = (id, category, xy, extra = {}) => pois.push(feature({ type: 'Point', coordinates: pt(xy) }, { id, level: L, category, ...extra }))
  const toiletCat = { 'restroom.male': 'toilet.male', 'restroom.female': 'toilet.female', 'restroom.accessible': 'toilet.accessible' }
  for (const s of specs) {
    const c = center(s.box)
    if (toiletCat[s.category]) poi(`poi-${s.id}`, toiletCat[s.category], c, { name: s.name, unit_id: s.id, nav_node: s.id })
    if (s.category === 'elevator' || s.category === 'stairs') poi(`poi-${s.id}`, s.category, nodes.get(s.id), { name: s.name, unit_id: s.id, nav_node: s.id })
  }
  if (L === '1F') {
    poi('poi-1F-entrance', 'entrance', [40, 0.6], { name: '正門入口', unit_id: '1F-LOBBY', nav_node: '1F-entrance' })
    poi('poi-1F-exit-e', 'exit', [79.4, 4.5], { name: '東側門', unit_id: '1F-EXIT-E', nav_node: '1F-exit-e' })
    poi('poi-1F-MED', 'first_aid', center([58, 0, 66, 9]), { name: '醫護室', unit_id: '1F-MED', nav_node: '1F-MED' })
    poi('poi-1F-aed', 'aed', [34.5, 4.5], { name: 'AED', unit_id: '1F-LOBBY', nav_node: '1F-LOBBY' })
    poi('poi-1F-info', 'info', [45.5, 4.5], { name: '服務台', unit_id: '1F-LOBBY', nav_node: '1F-LOBBY' })
  } else {
    poi('poi-2F-aed', 'aed', [34.5, 4.5], { name: 'AED', unit_id: '2F-REST', nav_node: '2F-REST' })
  }
  for (const n of RING_NAMES) poi(`qr-${L}-${n}`, 'qr_anchor', nodes.get(`${L}-c-${n}`), { name: `定位碼 ${L}-${n.toUpperCase()}`, nav_node: `${L}-c-${n}` })

  return { units, walls, pois, nodes, edges }
}

const built = Object.fromEntries(LEVELS.map((l) => [l.id, buildLevel(l.id)]))

// ---- nav (all levels) ----
const nav = []
for (const l of LEVELS) {
  const b = built[l.id]
  for (const [id, xy] of b.nodes) nav.push(feature({ type: 'Point', coordinates: xy }, { kind: 'node', id, level: l.id }))
}
for (const l of LEVELS) {
  const b = built[l.id]
  for (const e of b.edges) nav.push(feature({ type: 'LineString', coordinates: [b.nodes.get(e.from), b.nodes.get(e.to)] }, { kind: 'edge', ...e }))
}
const n1 = built['1F'].nodes
const n2 = built['2F'].nodes
for (const id of ['EV1', 'EV2']) {
  nav.push(feature({ type: 'LineString', coordinates: [n1.get(`1F-${id}`), n2.get(`2F-${id}`)] },
    { kind: 'edge', from: `1F-${id}`, to: `2F-${id}`, type: 'elevator', accessible: true, length_m: 15 }))
}
for (const id of ['ST1', 'ST2', 'ST3', 'ST4']) {
  const a = n1.get(`1F-${id}`)
  const b = n2.get(`2F-${id}`)
  nav.push(feature({ type: 'LineString', coordinates: [a, b] },
    { kind: 'edge', from: `1F-${id}`, to: `2F-${id}`, type: 'stairs', accessible: false, length_m: r2(dist(a, b) + 2 * CLIMB) }))
}

// ---- write ----
const write = (rel, obj) => {
  const p = join(OUT, rel)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, JSON.stringify(obj, null, 1) + '\n')
}
write('venue.json', {
  id: 'mock',
  name: '模擬體育館 (測試資料)',
  name_en: 'Mock Gymnasium',
  origin: { lng: 121.5645, lat: 25.0375 },
  bearing_deg: 0,
  levels: LEVELS,
  default_level: '1F',
})
for (const l of LEVELS) {
  const b = built[l.id]
  write(`levels/${l.id}/walls.geojson`, fc(b.walls))
  write(`levels/${l.id}/units.geojson`, fc(b.units))
  write(`levels/${l.id}/pois.geojson`, fc(b.pois))
}
write('nav.geojson', fc(nav))
const nNodes = nav.filter((f) => f.properties.kind === 'node').length
console.log(`mock venue written to ${OUT}: ${nNodes} nodes, ${nav.length - nNodes} edges`)
