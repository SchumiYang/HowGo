import type { XY } from '../geo/frame'
import { labelPoint } from '../geo/geometry'
import type { Target } from '../routing/route'
import type { UnitFeature, VenueData } from './types'

/** Something the user can search for or navigate to. */
export interface PlaceEntry {
  key: string
  source: 'unit' | 'poi'
  id: string
  level: string
  category: string
  name: string
  ref?: string
  xy: XY
  navNode?: string
  /** false for POIs that duplicate their unit in search results */
  searchable?: boolean
}

export const CATEGORY_LABEL: Record<string, string> = {
  'toilet.male': '男廁', 'toilet.female': '女廁', 'toilet.accessible': '無障礙廁所',
  'restroom.male': '男廁', 'restroom.female': '女廁', 'restroom.accessible': '無障礙廁所', 'restroom.unisex': '廁所',
  elevator: '電梯', stairs: '樓梯', entrance: '入口', exit: '出口', emergency_exit: '緊急出口',
  first_aid: '醫護室', aed: 'AED', info: '服務台', qr_anchor: '定位碼',
  room: '教室', office: '辦公室', shop: '商店', corridor: '走廊', lobby: '大廳', court: '球場',
  seating: '觀眾席', nonpublic: '非開放區域', walkway: '通道', opening: '挑空',
}

/**
 * Category buttons, in display order (accessibility first). POI categories are preferred; unit
 * categories are the fallback when a venue has no POIs. Entrances/exits stay reachable via search.
 */
export const QUICK_ACTIONS = {
  accessibleToilet: { label: '無障礙廁所', poi: ['toilet.accessible'], unit: ['restroom.accessible'] },
  toilet: { label: '廁所', poi: ['toilet.male', 'toilet.female', 'toilet.accessible'], unit: ['restroom.male', 'restroom.female', 'restroom.accessible', 'restroom.unisex'] },
  elevator: { label: '電梯', poi: ['elevator'], unit: ['elevator'] },
} as const
export type QuickActionId = keyof typeof QUICK_ACTIONS

const NOT_SEARCHABLE_UNITS = new Set(['corridor', 'walkway', 'opening'])

export function unitLabelPoint(u: UnitFeature): XY {
  const g = u.geometry
  const rings = g.type === 'Polygon' ? g.coordinates : g.coordinates[0]
  return labelPoint(rings)
}

export function buildCatalog(data: VenueData): PlaceEntry[] {
  const out: PlaceEntry[] = []
  for (const L of data.levels) {
    // a unit routes to its POI's nav node (e.g. stairs -> the stair node, so step-free routing excludes it)
    const poiNode = new Map(L.pois.filter((f) => f.properties.unit_id && f.properties.nav_node).map((f) => [f.properties.unit_id!, f.properties.nav_node!]))
    const unitIds = new Set(L.units.map((u) => u.properties.id))
    for (const u of L.units) {
      const p = u.properties
      if (NOT_SEARCHABLE_UNITS.has(p.category)) continue
      const name = p.name || p.ref || CATEGORY_LABEL[p.category]
      if (!name) continue
      out.push({ key: `u:${p.id}`, source: 'unit', id: p.id, level: L.level.id, category: p.category, name, ref: p.ref ?? undefined, xy: unitLabelPoint(u), navNode: poiNode.get(p.id) })
    }
    for (const f of L.pois) {
      const p = f.properties
      if (p.category === 'qr_anchor') continue
      out.push({
        key: `p:${p.id}`, source: 'poi', id: p.id, level: L.level.id, category: p.category,
        name: p.name || CATEGORY_LABEL[p.category] || p.category, xy: f.geometry.coordinates, navNode: p.nav_node ?? undefined,
        searchable: !(p.unit_id && unitIds.has(p.unit_id)),
      })
    }
  }
  return out
}

export function placeTarget(p: PlaceEntry): Target {
  return { node: p.navNode, place: { level: p.level, xy: p.xy } }
}

/** Candidates for a quick action; POIs if any exist for the categories, else matching units. */
export function quickActionPlaces(catalog: PlaceEntry[], id: QuickActionId): PlaceEntry[] {
  const qa = QUICK_ACTIONS[id]
  const pois = catalog.filter((p) => p.source === 'poi' && (qa.poi as readonly string[]).includes(p.category))
  if (pois.length) return pois
  return catalog.filter((p) => p.source === 'unit' && (qa.unit as readonly string[]).includes(p.category))
}

export function searchCatalog(catalog: PlaceEntry[], query: string, limit = 20): PlaceEntry[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const scored: { p: PlaceEntry; s: number }[] = []
  for (const p of catalog) {
    if (p.searchable === false) continue
    const fields = [p.ref, p.name, CATEGORY_LABEL[p.category]].filter(Boolean).map((s) => s!.toLowerCase())
    let s = 0
    for (const f of fields) {
      if (f === q) s = Math.max(s, 3)
      else if (f.startsWith(q)) s = Math.max(s, 2)
      else if (f.includes(q)) s = Math.max(s, 1)
    }
    if (s) scored.push({ p, s })
  }
  scored.sort((a, b) => b.s - a.s || a.p.name.localeCompare(b.p.name, 'zh-Hant'))
  // the same room may appear as unit and POI; keep the first of each (name, level)
  const seen = new Set<string>()
  const out: PlaceEntry[] = []
  for (const { p } of scored) {
    const k = `${p.level}|${p.name}|${p.ref ?? ''}|${p.xy.map((v) => Math.round(v)).join(',')}`
    if (seen.has(k)) continue
    seen.add(k)
    out.push(p)
    if (out.length >= limit) break
  }
  return out
}
