import type { PlaceEntry } from './catalog'

/**
 * The 廁所 quick action routes to the toilets of the user's gender: TownPass's `user_gender` bridge
 * (derived natively from the ID number) if it answers, else the user's remembered 男廁 / 女廁 choice,
 * else the UI asks. Accessible toilets are a separate quick action and are never picked here.
 */
export type Gender = 'male' | 'female'

export const GENDER_TOILET_LABEL: Record<Gender, string> = { male: '男廁', female: '女廁' }
export const otherGender = (g: Gender): Gender => (g === 'male' ? 'female' : 'male')

export const isGender = (v: unknown): v is Gender => v === 'male' || v === 'female'

/** `user_gender` reply payload `{ gender: 'male' | 'female' | null }` -> gender, null if unknown / malformed. */
export function parseGenderReply(data: unknown): Gender | null {
  if (!data || typeof data !== 'object') return null
  const g = (data as { gender?: unknown }).gender
  return isGender(g) ? g : null
}

/** Bridge answer first (it is the user's own profile), then the remembered choice; null = ask. */
export function resolveToiletGender(bridge: Gender | null, remembered: Gender | null): Gender | null {
  return bridge ?? remembered
}

/** Candidates of one gender: its toilet POIs if the venue has any, else its restroom units plus unisex ones. */
export function genderToiletPlaces(catalog: PlaceEntry[], gender: Gender): PlaceEntry[] {
  const pois = catalog.filter((p) => p.source === 'poi' && p.category === `toilet.${gender}`)
  if (pois.length) return pois
  return catalog.filter((p) => p.source === 'unit' && (p.category === `restroom.${gender}` || p.category === 'restroom.unisex'))
}

const STORAGE_KEY = 'tpnav-toilet-gender'

export function loadToiletGender(): Gender | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    return isGender(v) ? v : null
  } catch {
    return null
  }
}

export function saveToiletGender(g: Gender) {
  try {
    localStorage.setItem(STORAGE_KEY, g)
  } catch {
    // private mode / storage blocked: the choice just isn't remembered
  }
}
