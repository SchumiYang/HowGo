/**
 * Local metric frame <-> WGS84 (see mapdata/SCHEMA.md "Coordinate frame").
 *
 * Local frame: metres, +x right / +y up on the 1F drawing, origin at venue.origin.
 * `bearingDeg` is the clockwise angle from true north to local +y.
 *
 * Uses a local tangent-plane (equirectangular) approximation around the origin.
 * For a ~100 m building the error is well below a centimetre.
 */

export type LngLat = [number, number]
export type XY = [number, number]

export interface FrameParams {
  origin: { lng: number; lat: number }
  bearingDeg: number
}

/** WGS84 semi-major axis (m). */
const R = 6378137
const DEG = Math.PI / 180

export interface Frame {
  toLngLat(xy: XY): LngLat
  toLocal(ll: LngLat): XY
}

export function makeFrame({ origin, bearingDeg }: FrameParams): Frame {
  const th = bearingDeg * DEG
  const c = Math.cos(th)
  const s = Math.sin(th)
  const mPerDegLat = R * DEG
  const mPerDegLng = R * DEG * Math.cos(origin.lat * DEG)

  return {
    toLngLat([x, y]) {
      // local +y points to bearing θ (clockwise from north); +x is 90° clockwise from +y
      const east = x * c + y * s
      const north = -x * s + y * c
      return [origin.lng + east / mPerDegLng, origin.lat + north / mPerDegLat]
    },
    toLocal([lng, lat]) {
      const east = (lng - origin.lng) * mPerDegLng
      const north = (lat - origin.lat) * mPerDegLat
      return [east * c - north * s, east * s + north * c]
    },
  }
}

export function localToLngLat(xy: XY, p: FrameParams): LngLat {
  return makeFrame(p).toLngLat(xy)
}

export function lngLatToLocal(ll: LngLat, p: FrameParams): XY {
  return makeFrame(p).toLocal(ll)
}

/** Haversine distance in metres, used only to validate the approximation in tests. */
export function haversine([lng1, lat1]: LngLat, [lng2, lat2]: LngLat): number {
  const dLat = (lat2 - lat1) * DEG
  const dLng = (lng2 - lng1) * DEG
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(a))
}
