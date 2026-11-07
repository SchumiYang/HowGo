/** Local-metre venue data -> WGS84 GeoJSON for MapLibre sources. */
import type { Feature, FeatureCollection, Geometry } from 'geojson'
import type { Frame, XY } from '../geo/frame'
import { emptyBBox, extendBBox, type BBox } from '../geo/geometry'
import { unitLabelPoint } from '../data/catalog'
import type { VenueData } from '../data/types'
import type { Route } from '../routing/route'
import { poiIcon } from './icons'

type FC = FeatureCollection<Geometry, Record<string, unknown>>
const fc = (features: Feature<Geometry, Record<string, unknown>>[]): FC => ({ type: 'FeatureCollection', features })

const closed = (c: XY[]) => c.length >= 4 && c[0][0] === c[c.length - 1][0] && c[0][1] === c[c.length - 1][1]

/** label priority: lower = placed first */
const LABEL_RANK: Record<string, number> = { court: 0, lobby: 1, room: 2, office: 2, shop: 2, first_aid: 2, seating: 3 }
const POI_RANK: Record<string, number> = { 'toilet.accessible': 0, elevator: 1, 'toilet.male': 2, 'toilet.female': 2, stairs: 3 }
const NO_LABEL = new Set(['corridor', 'walkway'])

export interface VenueSources {
  units: FC
  labels: FC
  walls: FC
  walls3d: FC
  seating3d: FC
  columns: FC
  pois: FC
  bbox: BBox
}

export function venueSources(data: VenueData, frame: Frame): VenueSources {
  const ll = (p: XY) => frame.toLngLat(p)
  const bbox = emptyBBox()
  const units: FC['features'] = []
  const labels: FC['features'] = []
  const walls: FC['features'] = []
  const walls3d: FC['features'] = []
  const seating3d: FC['features'] = []
  const columns: FC['features'] = []
  const pois: FC['features'] = []

  for (const L of data.levels) {
    const level = L.level.id
    // units that get a POI icon don't also get a text label
    const iconUnits = new Set(L.pois.filter((p) => poiIcon(p.properties.category) && p.properties.unit_id).map((p) => p.properties.unit_id))
    for (const w of L.walls) {
      const c = w.geometry?.coordinates
      if (!c || c.length < 2) continue
      c.forEach((p) => extendBBox(bbox, p))
      if (w.properties.layer === 'column' && closed(c)) {
        columns.push({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [c.map(ll)] }, properties: { level } })
      } else {
        walls.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: c.map(ll) }, properties: { level, layer: w.properties.layer } })
      }
    }
    for (const w of L.walls3d) {
      const g = w.geometry
      if (!g) continue
      const coordinates = g.type === 'Polygon' ? g.coordinates.map((r) => r.map(ll)) : g.coordinates.map((poly) => poly.map((r) => r.map(ll)))
      walls3d.push({ type: 'Feature', geometry: { type: g.type, coordinates } as Geometry, properties: { level } })
    }
    for (const t of L.seating3d ?? []) {
      const g = t.geometry
      if (!g) continue
      const coordinates = g.type === 'Polygon' ? g.coordinates.map((r) => r.map(ll)) : g.coordinates.map((poly) => poly.map((r) => r.map(ll)))
      const p = t.properties
      seating3d.push({
        type: 'Feature', geometry: { type: g.type, coordinates } as Geometry,
        properties: { level, kind: p.kind, section: p.section ?? '', height_m: p.height_m, base_m: p.base_m ?? 0 },
      })
    }
    for (const u of L.units) {
      const g = u.geometry
      if (!g) continue
      const coords = g.type === 'Polygon' ? g.coordinates.map((r) => r.map(ll)) : g.coordinates.map((poly) => poly.map((r) => r.map(ll)))
      const flat = g.type === 'Polygon' ? g.coordinates.flat() : g.coordinates.flat(2)
      flat.forEach((p) => extendBBox(bbox, p))
      const p = u.properties
      units.push({
        type: 'Feature', geometry: { type: g.type, coordinates: coords } as Geometry,
        properties: { level, id: p.id, category: p.category, section: (p as { section?: string }).section ?? '' },
      })
      const label = p.name || p.ref
      if (label && !NO_LABEL.has(p.category) && !iconUnits.has(p.id)) {
        // rooms are signed by ref (A101…), so the ref leads
        const text = p.name && p.ref && !p.name.includes(p.ref) ? `${p.ref}\n${p.name}` : label
        labels.push({
          type: 'Feature', geometry: { type: 'Point', coordinates: ll(unitLabelPoint(u)) },
          properties: { level, id: p.id, category: p.category, label: text, rank: LABEL_RANK[p.category] ?? 5 },
        })
      }
    }
    for (const f of L.pois) {
      const p = f.properties
      const icon = poiIcon(p.category)
      if (!icon || !f.geometry?.coordinates) continue
      pois.push({
        type: 'Feature', geometry: { type: 'Point', coordinates: ll(f.geometry.coordinates) },
        properties: { level, id: p.id, category: p.category, icon, name: p.name ?? '', rank: POI_RANK[p.category] ?? 4 },
      })
    }
  }
  return { units: fc(units), labels: fc(labels), walls: fc(walls), walls3d: fc(walls3d), seating3d: fc(seating3d), columns: fc(columns), pois: fc(pois), bbox }
}

export interface RouteSources {
  lines: FC
  points: FC
}

/** Split a route into same-level runs; add transfer + destination markers. */
export function routeSources(route: Route | null, frame: Frame, levelName: (id: string) => string, destLabel?: string): RouteSources {
  if (!route || route.points.length < 2) return { lines: fc([]), points: fc([]) }
  const ll = (p: XY) => frame.toLngLat(p)
  const lines: FC['features'] = []
  const points: FC['features'] = []
  let run: XY[] = [route.points[0].xy]
  let level = route.points[0].level
  const flush = () => {
    if (run.length >= 2) lines.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: run.map(ll) }, properties: { level } })
  }
  for (let i = 1; i < route.points.length; i++) {
    const a = route.points[i - 1]
    const p = route.points[i]
    if (p.level !== level) {
      flush()
      const how = p.via === 'elevator' ? '電梯' : '樓梯'
      points.push({ type: 'Feature', geometry: { type: 'Point', coordinates: ll(a.xy) }, properties: { level, kind: 'transfer', label: `${how} → ${levelName(p.level)}` } })
      points.push({ type: 'Feature', geometry: { type: 'Point', coordinates: ll(p.xy) }, properties: { level: p.level, kind: 'transfer', label: `${how}出口` } })
      run = [p.xy]
      level = p.level
    } else run.push(p.xy)
  }
  flush()
  const last = route.points[route.points.length - 1]
  points.push({ type: 'Feature', geometry: { type: 'Point', coordinates: ll(last.xy) }, properties: { level: last.level, kind: 'dest', ...(destLabel ? { label: destLabel } : {}) } })
  return { lines: fc(lines), points: fc(points) }
}
