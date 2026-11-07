import { TP } from '../tokens'
import type { ExpressionSpecification, LayerSpecification, StyleSpecification } from '@maplibre/maplibre-gl-style-spec'

/**
 * Map palette from DESIGN.md (Town Pass tokens applied to the venue map). The accessible restroom
 * is the strongest fill on the map; stairs are de-emphasised.
 */
export const UNIT_COLORS: Record<string, [fill: string, outline: string]> = {
  corridor: [TP.white, TP.grayscale200],
  walkway: [TP.white, TP.grayscale200],
  lobby: [TP.white, TP.grayscale200],
  room: [TP.secondary200, TP.secondary300],
  office: [TP.secondary200, TP.secondary300],
  shop: [TP.secondary200, TP.secondary300],
  first_aid: [TP.secondary200, TP.secondary300],
  'restroom.male': [TP.primary100, TP.primary200],
  'restroom.female': [TP.primary100, TP.primary200],
  'restroom.unisex': [TP.primary100, TP.primary200],
  'restroom.accessible': [TP.primary500, TP.primary600],
  elevator: [TP.primary50, TP.primary200],
  stairs: [TP.grayscale100, TP.grayscale200],
  court: [TP.primary100, TP.primary200],
  seating: [TP.secondary100, TP.secondary300],
  /** 挑空: void over the court, not walkable */
  opening: [TP.primary50, TP.primary100],
  nonpublic: [TP.grayscale100, TP.grayscale200],
}
const DEFAULT_UNIT: [string, string] = [TP.white, TP.grayscale200]

/**
 * Venue-specific stand colours (Tianmu: the directory sign and the real seats — north blue,
 * west orange, east red, south green), muted so they don't compete with the ♿ accent.
 * [3D tier, flat 2D fill]
 */
export const SEAT_COLORS: Record<string, [tier: string, flat: string]> = {
  north: ['#5A84BD', '#D3DFEF'],
  west: ['#DE9260', '#F6E0D0'],
  east: ['#CC7474', '#F2D8D8'],
  south: ['#72A67B', '#D6E8D9'],
}
const SEAT_DEFAULT: [string, string] = ['#B9A88C', TP.secondary100]
const PARAPET_COLOR = TP.grayscale100

const matchSection = (idx: 0 | 1): ExpressionSpecification => [
  'match', ['get', 'section'],
  ...Object.entries(SEAT_COLORS).flatMap(([k, v]) => [k, v[idx]]),
  SEAT_DEFAULT[idx],
] as unknown as ExpressionSpecification

export const COLORS = {
  background: TP.grayscale50,
  wall: TP.grayscale700,
  column: TP.grayscale200,
  route: TP.primary500,
  routeCasing: TP.primary700,
  me: TP.primary700,
  meHalo: TP.primary500,
  dest: TP.red500,
  /** room labels on secondary200 (DESIGN.md) */
  roomLabel: '#AD7B2B',
  label: TP.grayscale700,
  labelHalo: 'rgba(255,255,255,0.9)',
}

/**
 * 2.5D walls: every wall slab and column is extruded to this ONE height (by request: uniform, no
 * per-feature or per-layer heights). The aim is readable enclosed rooms, not real storey heights.
 */
export const WALL_HEIGHT_M = 2.5
/** camera pitch of the 3D view (2D = 0) */
export const PITCH_3D = 50

/** Local font stack: no glyph server, MapLibre rasterises labels with these system fonts. */
export const FONT_STACK = ['PingFang TC', 'Noto Sans TC', 'Microsoft JhengHei', 'sans-serif']

const matchCategory = (idx: 0 | 1): ExpressionSpecification => [
  'match', ['get', 'category'],
  ...Object.entries(UNIT_COLORS).flatMap(([k, v]) => [k, v[idx]]),
  DEFAULT_UNIT[idx],
] as unknown as ExpressionSpecification

export const SRC = {
  units: 'units',
  labels: 'labels',
  walls: 'walls',
  walls3d: 'walls3d',
  seating3d: 'seating3d',
  columns: 'columns',
  pois: 'pois',
  route: 'route',
  routePts: 'route-pts',
  me: 'me',
} as const

/** Layers whose features carry `level` and must be filtered to the current level. */
export const LEVEL_LAYERS = [
  'units-fill', 'units-outline', 'walls-line', 'columns-fill', 'walls-3d', 'seating-3d', 'seating-parapet-3d', 'labels', 'pois', 'pois-acc',
  'route-casing', 'route-line', 'route-ghost', 'route-pts-circle', 'route-pts-label', 'route-dest', 'me-acc', 'me-acc-line', 'me-cone', 'me-dot',
] as const
/** Layers that show what is *not* on the current level (dimmed). */
export const OFF_LEVEL_LAYERS = ['route-off'] as const
/** Static filters combined with the level filter (setFilter replaces the whole filter). */
export const BASE_FILTERS: Partial<Record<string, ExpressionSpecification>> = {
  'me-acc': ['==', ['get', 'kind'], 'acc'],
  'me-acc-line': ['==', ['get', 'kind'], 'acc'],
  'me-cone': ['==', ['get', 'kind'], 'cone'],
  'me-dot': ['==', ['get', 'kind'], 'dot'],
  'route-pts-circle': ['==', ['get', 'kind'], 'transfer'],
  'route-pts-label': ['all', ['has', 'label'], ['==', ['get', 'kind'], 'transfer']],
  'route-dest': ['==', ['get', 'kind'], 'dest'],
  'seating-3d': ['==', ['get', 'kind'], 'tier'],
  'seating-parapet-3d': ['==', ['get', 'kind'], 'parapet'],
  pois: ['!=', ['get', 'category'], 'toilet.accessible'],
  'pois-acc': ['==', ['get', 'category'], 'toilet.accessible'],
}

const empty = { type: 'geojson' as const, data: { type: 'FeatureCollection' as const, features: [] } }
const z = (lo: number, hi: number): ExpressionSpecification => ['interpolate', ['exponential', 1.6], ['zoom'], 17, lo, 21, hi]

export function baseStyle(): StyleSpecification {
  const layers: LayerSpecification[] = [
    { id: 'background', type: 'background', paint: { 'background-color': COLORS.background } },
    {
      id: 'units-fill', type: 'fill', source: SRC.units,
      // stands use their section colour (lighter than the 3D seats), everything else the category palette
      paint: { 'fill-color': ['case', ['==', ['get', 'category'], 'seating'], matchSection(1), matchCategory(0)] },
    },
    { id: 'units-outline', type: 'line', source: SRC.units, paint: { 'line-color': matchCategory(1), 'line-width': z(0.4, 1.2) } },
    {
      id: 'walls-line', type: 'line', source: SRC.walls,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': ['match', ['get', 'layer'],
          'wall', COLORS.wall, 'door', TP.white, 'court', TP.primary200, 'stairs', TP.grayscale500, 'fixture', TP.grayscale200, 'hatch', TP.grayscale100, TP.grayscale200],
        // zoom interpolation must be the outermost expression
        'line-width': ['interpolate', ['exponential', 1.6], ['zoom'],
          17, ['match', ['get', 'layer'], 'wall', 0.8, 'door', 1.2, 'court', 0.6, 0.4],
          21, ['match', ['get', 'layer'], 'wall', 2, 'door', 4, 'court', 1.6, 1]],
      },
    },
    { id: 'columns-fill', type: 'fill', source: SRC.columns, paint: { 'fill-color': COLORS.column, 'fill-outline-color': COLORS.wall } },
    {
      id: 'route-off', type: 'line', source: SRC.route,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': COLORS.routeCasing, 'line-opacity': 0.4, 'line-width': z(2.5, 7), 'line-dasharray': [1, 1.6] },
    },
    {
      id: 'route-casing', type: 'line', source: SRC.route,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': COLORS.routeCasing, 'line-width': z(5, 11) },
    },
    {
      id: 'route-line', type: 'line', source: SRC.route,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': COLORS.route, 'line-width': z(3.5, 8) },
    },
    // position marker, ground-plane parts (polygons in metres: perspective + bearing like the floor)
    {
      id: 'me-acc', type: 'fill', source: SRC.me,
      paint: { 'fill-color': COLORS.meHalo, 'fill-opacity': ['coalesce', ['get', 'opacity'], 0.25] },
    },
    {
      id: 'me-acc-line', type: 'line', source: SRC.me,
      paint: { 'line-color': COLORS.meHalo, 'line-width': 1.2, 'line-opacity': ['min', 0.8, ['*', 3, ['coalesce', ['get', 'opacity'], 0.25]]] },
    },
    { id: 'me-cone', type: 'fill', source: SRC.me, paint: { 'fill-color': COLORS.me, 'fill-opacity': 0.35 } },
    // Extrusions sit above the ground layers (floor fills, flat wall outlines, route) so walls in
    // front occlude what is behind them; symbols and the user dot are drawn after, on top.
    {
      id: 'walls-3d', type: 'fill-extrusion', source: SRC.walls3d,
      layout: { visibility: 'none' },
      paint: {
        'fill-extrusion-color': TP.grayscale300,
        'fill-extrusion-height': WALL_HEIGHT_M,
        'fill-extrusion-base': 0,
        'fill-extrusion-opacity': 0.9,
        'fill-extrusion-vertical-gradient': true,
      },
    },
    // stepped stands: per-feature heights (tiers rise away from the court), unlike the uniform walls
    {
      id: 'seating-3d', type: 'fill-extrusion', source: SRC.seating3d,
      layout: { visibility: 'none' },
      paint: {
        'fill-extrusion-color': matchSection(0),
        'fill-extrusion-height': ['get', 'height_m'],
        'fill-extrusion-base': ['coalesce', ['get', 'base_m'], 0],
        'fill-extrusion-opacity': 0.95,
        'fill-extrusion-vertical-gradient': true,
      },
    },
    {
      id: 'seating-parapet-3d', type: 'fill-extrusion', source: SRC.seating3d,
      layout: { visibility: 'none' },
      paint: {
        'fill-extrusion-color': PARAPET_COLOR,
        'fill-extrusion-height': ['get', 'height_m'],
        'fill-extrusion-base': ['coalesce', ['get', 'base_m'], 0],
        'fill-extrusion-opacity': 0.8,
        'fill-extrusion-vertical-gradient': true,
      },
    },
    // faint copy of the route above the walls, so route parts hidden behind walls in 3D stay readable
    {
      id: 'route-ghost', type: 'line', source: SRC.route,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': COLORS.route, 'line-opacity': 0.45, 'line-width': z(2, 5) },
    },
    {
      id: 'labels', type: 'symbol', source: SRC.labels,
      layout: {
        'text-field': ['get', 'label'],
        'text-font': FONT_STACK,
        'text-size': ['interpolate', ['linear'], ['zoom'], 17, 11, 20, 15],
        'text-max-width': 6,
        'text-padding': 2,
        'symbol-sort-key': ['get', 'rank'],
      },
      paint: {
        'text-color': ['match', ['get', 'category'], ['room', 'office', 'shop', 'first_aid'], COLORS.roomLabel, 'restroom.accessible', TP.white, COLORS.label],
        'text-halo-color': ['match', ['get', 'category'], 'restroom.accessible', TP.primary700, COLORS.labelHalo],
        'text-halo-width': 1.2,
      },
    },
    // Symbol priority: layers higher in the stack are placed first and drawn on top. The accessible
    // restroom gets its own layer above the other POIs so its icon + label win collisions and are
    // never covered; other POI labels (男廁/女廁…) are optional and drop out when they collide.
    {
      id: 'pois', type: 'symbol', source: SRC.pois,
      layout: {
        'icon-image': ['get', 'icon'],
        'icon-size': ['interpolate', ['linear'], ['zoom'], 17, 0.7, 20, 1],
        'icon-allow-overlap': true,
        'symbol-sort-key': ['get', 'rank'],
        'text-field': ['get', 'name'],
        'text-font': FONT_STACK,
        'text-size': 12,
        'text-anchor': 'top',
        'text-offset': [0, 1.2],
        'text-optional': true,
      },
      paint: {
        'text-color': ['match', ['get', 'category'], 'stairs', COLORS.label, TP.primary700],
        'text-halo-color': COLORS.labelHalo,
        'text-halo-width': 1.5,
      },
    },
    {
      id: 'pois-acc', type: 'symbol', source: SRC.pois,
      layout: {
        'icon-image': ['get', 'icon'],
        'icon-size': ['interpolate', ['linear'], ['zoom'], 17, 0.7, 20, 1],
        'icon-allow-overlap': true,
        'symbol-sort-key': ['get', 'rank'],
        'text-field': ['get', 'name'],
        'text-font': FONT_STACK,
        'text-size': 12,
        'text-anchor': 'top',
        'text-offset': [0, 1.2],
        'text-optional': false,
      },
      paint: { 'text-color': TP.primary700, 'text-halo-color': COLORS.labelHalo, 'text-halo-width': 1.5 },
    },
    {
      id: 'route-pts-circle', type: 'circle', source: SRC.routePts,
      paint: {
        'circle-radius': 7, 'circle-color': TP.white, 'circle-stroke-color': COLORS.routeCasing, 'circle-stroke-width': 3,
        'circle-pitch-alignment': 'map', 'circle-pitch-scale': 'viewport',
      },
    },
    {
      id: 'route-pts-label', type: 'symbol', source: SRC.routePts,
      layout: {
        'text-field': ['get', 'label'],
        'text-font': FONT_STACK,
        'text-size': 14,
        'text-offset': [0, -1.6],
        'text-allow-overlap': true,
      },
      paint: { 'text-color': TP.white, 'text-halo-color': COLORS.routeCasing, 'text-halo-width': 3 },
    },
    // destination: a pin whose tip sits just above the POI badge, so it doesn't hide e.g. the ♿ icon
    {
      id: 'route-dest', type: 'symbol', source: SRC.routePts,
      layout: {
        'icon-image': 'dest-pin',
        'icon-anchor': 'bottom',
        'icon-offset': [0, -14],
        'icon-allow-overlap': true,
        'text-field': ['coalesce', ['get', 'label'], ''],
        'text-font': FONT_STACK,
        'text-size': 14,
        'text-anchor': 'bottom',
        'text-offset': [0, -3.7],
        'text-allow-overlap': true,
      },
      paint: { 'text-color': TP.white, 'text-halo-color': TP.red600, 'text-halo-width': 3 },
    },
    {
      // fixed-pixel round dot at the floor point (upright: stays a circle when tilted), drawn above the extrusions so walls never hide it
      id: 'me-dot', type: 'circle', source: SRC.me,
      paint: {
        'circle-radius': 8, 'circle-color': COLORS.me, 'circle-stroke-color': TP.white, 'circle-stroke-width': 3,
        'circle-pitch-alignment': 'viewport', 'circle-pitch-scale': 'viewport',
      },
    },
  ]
  for (const l of layers) {
    // base filters also apply before the first setLevel()
    const f = BASE_FILTERS[l.id]
    if (f && l.type !== 'background') (l as { filter?: ExpressionSpecification }).filter = f
    // icons and labels stay upright and face the viewer when the map is pitched (3D view);
    // only the heading cone lies on the floor
    if (l.type === 'symbol') {
      const lay = (l.layout ??= {}) as Record<string, unknown>
      if (lay['text-field']) Object.assign(lay, { 'text-pitch-alignment': 'viewport', 'text-rotation-alignment': 'viewport' })
      if (lay['icon-image']) Object.assign(lay, { 'icon-pitch-alignment': 'viewport', 'icon-rotation-alignment': 'viewport' })
    }
  }
  return {
    version: 8,
    // no "glyphs": labels use FONT_STACK rendered locally, so the map works offline
    sources: Object.fromEntries(Object.values(SRC).map((id) => [id, empty])),
    layers,
  }
}
