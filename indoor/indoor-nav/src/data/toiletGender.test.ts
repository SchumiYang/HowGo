import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PlaceEntry } from './catalog'
import {
  genderToiletPlaces, loadToiletGender, otherGender, parseGenderReply, resolveToiletGender, saveToiletGender,
} from './toiletGender'

const place = (id: string, source: 'poi' | 'unit', category: string): PlaceEntry => ({
  key: `${source[0]}:${id}`, source, id, level: '1F', category, name: id, xy: [0, 0],
})

describe('parseGenderReply', () => {
  it('reads male / female', () => {
    expect(parseGenderReply({ gender: 'male' })).toBe('male')
    expect(parseGenderReply({ gender: 'female' })).toBe('female')
  })
  it('treats null, unknown values and malformed payloads as unknown', () => {
    expect(parseGenderReply({ gender: null })).toBeNull()
    expect(parseGenderReply({ gender: 'M' })).toBeNull()
    expect(parseGenderReply({})).toBeNull()
    expect(parseGenderReply(null)).toBeNull()
    expect(parseGenderReply('male')).toBeNull()
  })
})

describe('resolveToiletGender', () => {
  it('prefers the TownPass answer over the remembered choice', () => {
    expect(resolveToiletGender('female', 'male')).toBe('female')
  })
  it('falls back to the remembered choice, else asks (null)', () => {
    expect(resolveToiletGender(null, 'male')).toBe('male')
    expect(resolveToiletGender(null, null)).toBeNull()
  })
  it('otherGender flips', () => {
    expect(otherGender('male')).toBe('female')
    expect(otherGender('female')).toBe('male')
  })
})

describe('genderToiletPlaces', () => {
  const catalog = [
    place('m1', 'poi', 'toilet.male'), place('m2', 'poi', 'toilet.male'),
    place('f1', 'poi', 'toilet.female'), place('a1', 'poi', 'toilet.accessible'),
    place('um', 'unit', 'restroom.male'), place('uf', 'unit', 'restroom.female'), place('elev', 'poi', 'elevator'),
  ]
  it('returns only that gender\'s toilet POIs, never accessible ones', () => {
    expect(genderToiletPlaces(catalog, 'male').map((p) => p.id)).toEqual(['m1', 'm2'])
    expect(genderToiletPlaces(catalog, 'female').map((p) => p.id)).toEqual(['f1'])
  })
  it('falls back to restroom units (plus unisex) when the venue has no toilet POIs', () => {
    const units = [place('um', 'unit', 'restroom.male'), place('uf', 'unit', 'restroom.female'), place('uu', 'unit', 'restroom.unisex'), place('ua', 'unit', 'restroom.accessible')]
    expect(genderToiletPlaces(units, 'female').map((p) => p.id)).toEqual(['uf', 'uu'])
  })
  it('is empty when the venue has neither', () => {
    expect(genderToiletPlaces([place('a1', 'poi', 'toilet.accessible')], 'male')).toEqual([])
  })
})

describe('remembered choice', () => {
  afterEach(() => vi.unstubAllGlobals())
  it('round-trips through localStorage and ignores junk', () => {
    const store = new Map<string, string>()
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v) })
    expect(loadToiletGender()).toBeNull()
    saveToiletGender('female')
    expect(loadToiletGender()).toBe('female')
    store.set('tpnav-toilet-gender', 'x')
    expect(loadToiletGender()).toBeNull()
  })
  it('survives blocked storage', () => {
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') } })
    expect(() => saveToiletGender('male')).not.toThrow()
    expect(loadToiletGender()).toBeNull()
  })
})
