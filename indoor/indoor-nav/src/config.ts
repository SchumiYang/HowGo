import type { Venue } from './data/types'

/**
 * Per-venue app defaults that SCHEMA.md does not (yet) carry. If venue.json gains
 * `short_name` / `default_start`, those win (proposed schema additions).
 */
const VENUE_DEFAULTS: Record<string, { shortName?: string; defaultStart?: string }> = {
  tianmu: { shortName: '天母體育館', defaultStart: '1F-ent-main-out' },
  mock: { defaultStart: '1F-entrance' },
}

type VenueExtras = Venue & { short_name?: string; default_start?: string }

export function venueShortName(v: Venue): string {
  return (v as VenueExtras).short_name ?? VENUE_DEFAULTS[v.id]?.shortName ?? v.name
}

export function venueDefaultStart(v: Venue): string | undefined {
  return (v as VenueExtras).default_start ?? VENUE_DEFAULTS[v.id]?.defaultStart
}

/** Shown in the TPWebView app bar (it renders document.title); generic form is `${venue.name} 無障礙導航`. */
export const pageTitle = (v: Venue) => `${venueShortName(v)} 無障礙導航`
