/** levels/<L>/floorplan.json (ADMIN_API.md): a calibrated raster floor plan for a level. */
import type { XY } from '../geo/frame'
import { venueBaseUrl } from '../data/loader'

export interface FloorplanJson {
  /** file name next to floorplan.json, e.g. "floorplan.png" */
  image: string
  width_px: number
  height_px: number
  /** local metres of the image corners, TL, TR, BR, BL (MapLibre image-source order) */
  corners: [XY, XY, XY, XY]
  opacity?: number
  calibration?: { method: '2-point' | '3-point' | 'manual'; control: { px: XY; m: XY }[]; rms_m?: number }
}

/** what the map needs to draw it */
export interface FloorplanOverlay {
  url: string
  corners: [XY, XY, XY, XY]
  opacity: number
}

/** Published floor plan of a level from the static data root (null when the level has none). */
export async function fetchFloorplan(venueId: string, level: string): Promise<FloorplanOverlay | null> {
  const dir = `${venueBaseUrl(venueId)}levels/${encodeURIComponent(level)}/`
  try {
    const res = await fetch(dir + 'floorplan.json')
    if (!res.ok) return null
    const fp = JSON.parse(await res.text()) as FloorplanJson
    if (!fp?.image || fp.corners?.length !== 4) return null
    return { url: dir + encodeURIComponent(fp.image), corners: fp.corners, opacity: fp.opacity ?? 0.6 }
  } catch {
    return null // missing (dev server answers index.html) or invalid
  }
}
