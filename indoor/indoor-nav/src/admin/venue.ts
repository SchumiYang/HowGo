/** Venue data for admin tabs: every level's walls loaded (the positioning grid and per-level maps need them). */
import { loadLevelWalls, loadVenue } from '../data/loader'
import type { VenueData } from '../data/types'
import { makeFrame, type Frame } from '../geo/frame'

const cache = new Map<string, Promise<VenueData>>()

export function getVenue(venueId: string, fresh = false): Promise<VenueData> {
  if (fresh) cache.delete(venueId)
  let p = cache.get(venueId)
  if (!p) {
    p = (async () => {
      const data = await loadVenue(venueId)
      await Promise.all(
        data.levels.filter((l) => !l.wallsLoaded).map(async (l) => {
          const w = await loadLevelWalls(venueId, l.level.id)
          l.walls = w.walls ?? []
          l.walls3d = w.walls3d ?? []
          l.wallsLoaded = true
        }),
      )
      return data
    })()
    p.catch(() => cache.delete(venueId))
    cache.set(venueId, p)
  }
  return p
}

export const venueFrame = (d: VenueData): Frame => makeFrame({ origin: d.venue.origin, bearingDeg: d.venue.bearing_deg ?? 0 })

/** Distinct colours for sessions / devices on the coverage map. */
export const SERIES = ['#356C77', '#FD853A', '#7B61FF', '#2E9E5B', '#C2332F', '#F5BA4B', '#475259']
