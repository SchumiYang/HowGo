import type { Feature, Geometry, LineString, MultiPolygon, Point, Polygon, Position } from 'geojson'

/**
 * Geometry helpers for UI-004 (representative icon points on line / area layers) and UI-006
 * (which facilities a route actually passes). Local equirectangular metres are accurate enough at
 * city scale (Taipei) and avoid a turf dependency.
 */

const M_PER_DEG = 111_195

function toMetres(origin: Position, point: Position): [number, number] {
  const k = Math.cos(origin[1]! * Math.PI / 180)
  return [(point[0]! - origin[0]!) * M_PER_DEG * k, (point[1]! - origin[1]!) * M_PER_DEG]
}

function segmentLength(a: Position, b: Position) {
  const [x, y] = toMetres(a, b)
  return Math.hypot(x, y)
}

/** Straight-line distance in metres. */
export const distanceM = segmentLength

/** Point halfway along the line's length (not the middle vertex). */
export function lineMidpoint(coordinates: Position[]): Position | null {
  if (!coordinates.length) return null
  if (coordinates.length === 1) return coordinates[0]!
  const lengths = coordinates.slice(1).map((point, i) => segmentLength(coordinates[i]!, point))
  let remaining = lengths.reduce((sum, value) => sum + value, 0) / 2
  for (let i = 0; i < lengths.length; i++) {
    const length = lengths[i]!
    if (remaining <= length) {
      const t = length ? remaining / length : 0
      const a = coordinates[i]!
      const b = coordinates[i + 1]!
      return [a[0]! + (b[0]! - a[0]!) * t, a[1]! + (b[1]! - a[1]!) * t]
    }
    remaining -= length
  }
  return coordinates.at(-1)!
}

function ringContains(ring: Position[], [x, y]: Position) {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!
    const [xj, yj] = ring[j]!
    if ((yi! > y!) !== (yj! > y!) && x! < (xj! - xi!) * (y! - yi!) / (yj! - yi!) + xi!) inside = !inside
  }
  return inside
}

function polygonContains(rings: Position[][], point: Position) {
  return !!rings[0] && ringContains(rings[0], point) && !rings.slice(1).some(hole => ringContains(hole, point))
}

function ringArea(ring: Position[]) {
  let area = 0
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    area += (ring[j]![0]! * ring[i]![1]! - ring[i]![0]! * ring[j]![1]!)
  }
  return area / 2
}

/**
 * A point guaranteed inside the polygon: the centroid when it falls inside, otherwise the middle
 * of the widest horizontal span through the centroid's latitude (long thin sidewalk polygons are
 * often L- or C-shaped, where the centroid lies outside).
 */
export function pointOnSurface(rings: Position[][]): Position | null {
  const outer = rings[0]
  if (!outer?.length) return null
  const area = ringArea(outer)
  let cx = 0
  let cy = 0
  if (Math.abs(area) > 0) {
    for (let i = 0, j = outer.length - 1; i < outer.length; j = i++) {
      const cross = outer[j]![0]! * outer[i]![1]! - outer[i]![0]! * outer[j]![1]!
      cx += (outer[j]![0]! + outer[i]![0]!) * cross
      cy += (outer[j]![1]! + outer[i]![1]!) * cross
    }
    cx /= 6 * area
    cy /= 6 * area
  } else {
    cx = outer.reduce((sum, p) => sum + p[0]!, 0) / outer.length
    cy = outer.reduce((sum, p) => sum + p[1]!, 0) / outer.length
  }
  if (polygonContains(rings, [cx, cy])) return [cx, cy]
  const xs: number[] = []
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i]!
      const [xj, yj] = ring[j]!
      if ((yi! > cy) !== (yj! > cy)) xs.push(xi! + (cy - yi!) * (xj! - xi!) / (yj! - yi!))
    }
  }
  xs.sort((a, b) => a - b)
  let best: Position | null = null
  let width = 0
  for (let i = 0; i + 1 < xs.length; i += 2) {
    if (xs[i + 1]! - xs[i]! > width) {
      width = xs[i + 1]! - xs[i]!
      best = [(xs[i]! + xs[i + 1]!) / 2, cy]
    }
  }
  return best ?? outer[0]!
}

/** Representative icon position for a line or area feature. */
export function representativePoint(geometry: Polygon | MultiPolygon | LineString): Position | null {
  if (geometry.type === 'LineString') return lineMidpoint(geometry.coordinates)
  if (geometry.type === 'Polygon') return pointOnSurface(geometry.coordinates)
  const largest = [...geometry.coordinates].sort((a, b) => Math.abs(ringArea(b[0] ?? [])) - Math.abs(ringArea(a[0] ?? [])))[0]
  return largest ? pointOnSurface(largest) : null
}

/** Icon point features for line / area features, carrying the source properties so taps open the card. */
export function iconPoints<P>(features: Feature<Polygon | MultiPolygon | LineString, P>[]): Feature<Point, P>[] {
  return features.flatMap((feature) => {
    const coordinates = representativePoint(feature.geometry)
    return coordinates ? [{ type: 'Feature' as const, id: feature.id, geometry: { type: 'Point' as const, coordinates }, properties: feature.properties }] : []
  })
}

/* ---------- Route proximity (UI-006) ---------- */

function distanceToSegment(p: Position, a: Position, b: Position) {
  const [bx, by] = toMetres(a, b)
  const [px, py] = toMetres(a, p)
  const len2 = bx * bx + by * by
  const t = len2 ? Math.max(0, Math.min(1, (px * bx + py * by) / len2)) : 0
  return Math.hypot(px - bx * t, py - by * t)
}

export function distanceToLine(point: Position, line: Position[]) {
  if (line.length === 1) return segmentLength(line[0]!, point)
  let best = Infinity
  for (let i = 1; i < line.length; i++) best = Math.min(best, distanceToSegment(point, line[i - 1]!, line[i]!))
  return best
}

/** Points every ~`step` metres along the line, used to test which areas the route walks through. */
function samples(line: Position[], step = 4): Position[] {
  const out: Position[] = []
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1]!
    const b = line[i]!
    const n = Math.max(1, Math.ceil(segmentLength(a, b) / step))
    for (let k = 0; k < n; k++) out.push([a[0]! + (b[0]! - a[0]!) * k / n, a[1]! + (b[1]! - a[1]!) * k / n])
  }
  if (line.length) out.push(line.at(-1)!)
  return out
}

/**
 * Builds a predicate "does the route pass this feature?". Points/lines count when within
 * `bufferM` of the route line; areas when the route runs through them (or within the buffer of
 * their edge, since the routed centreline and the drawn sidewalk polygon rarely coincide exactly).
 */
export function routePasses(route: Position[], bufferM: number) {
  const routeSamples = samples(route)
  const lon = route.map(p => p[0]!)
  const lat = route.map(p => p[1]!)
  const padLat = bufferM / M_PER_DEG
  const padLon = padLat / Math.cos((lat[0] ?? 25) * Math.PI / 180)
  const box = [Math.min(...lon) - padLon, Math.min(...lat) - padLat, Math.max(...lon) + padLon, Math.max(...lat) + padLat]
  const inBox = (p: Position) => p[0]! >= box[0]! && p[0]! <= box[2]! && p[1]! >= box[1]! && p[1]! <= box[3]!
  const near = (p: Position) => inBox(p) && distanceToLine(p, route) <= bufferM

  return (geometry: Geometry | null | undefined): boolean => {
    if (!geometry || !route.length) return false
    switch (geometry.type) {
      case 'Point': return near(geometry.coordinates)
      case 'LineString': return geometry.coordinates.some(near)
        || routeSamples.some(p => distanceToLine(p, geometry.coordinates) <= bufferM)
      case 'Polygon':
      case 'MultiPolygon': {
        const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates
        return polygons.some(rings => (rings[0] ?? []).some(inBox)
          && (routeSamples.some(p => polygonContains(rings, p)) || (rings[0] ?? []).some(near)))
      }
      default: return false
    }
  }
}
