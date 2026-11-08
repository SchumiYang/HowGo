/**
 * Vector basemap from OpenFreeMap (OpenMapTiles schema, OSM data, no API key).
 *
 * Why vector: raster OSM tiles are 256 px bitmaps with the labels baked in, so on a 2.6× phone screen
 * every label is stretched and blurry. Vector tiles are drawn by the device at native resolution, and
 * Chinese labels use the phone's own font (`localIdeographFontFamily`), so text is always sharp.
 *
 * The tile source is clipped to Taipei City (`bounds`), so tiles outside the city are never requested,
 * and the maps use the same box as `maxBounds`.
 */
import type { LayerSpecification, SourceSpecification, StyleSpecification } from 'maplibre-gl'
import { palette } from './palette'

/** Taipei City, with a small margin so edge districts are not flush against the viewport limit. */
export const TAIPEI_BOUNDS: [[number, number], [number, number]] = [[121.44, 24.95], [121.68, 25.22]]
export const LOCAL_CJK_FONT = '"Noto Sans CJK TC", "Noto Sans TC", "PingFang TC", "Microsoft JhengHei", sans-serif'

const OPENFREEMAP = 'https://tiles.openfreemap.org'
const ATTRIBUTION = '<a href="https://openfreemap.org" target="_blank">OpenFreeMap</a> '
  + '<a href="https://www.openmaptiles.org/" target="_blank">© OpenMapTiles</a> '
  + 'Data from <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a>'

/** light = Positron and dark = Dark, both tuned for HowGo; liberty = OpenFreeMap's default style, used as is. */
type Kind = 'light' | 'dark' | 'liberty'
const STYLE_NAME: Record<Kind, string> = { light: 'positron', dark: 'dark', liberty: 'liberty' }
type Options = {
  /** Multiply label sizes (accessible mode). */
  textScale?: number
  /** Label colours for the dark accessible map. */
  textColor?: string
  haloColor?: string
  /** Brighter streets and buildings so the dark map has enough contrast for low vision. */
  roadColor?: string
  buildingColor?: string
}
export type Basemap = Pick<StyleSpecification, 'glyphs' | 'sprite'> & {
  sources: Record<string, SourceSpecification>
  layers: LayerSpecification[]
  vector: boolean
}

/** Prefer the Traditional Chinese name; in Taipei `name` is already Chinese. Latin-only names fall back to `name`. */
const LOCAL_NAME = ['coalesce', ['get', 'name:zh-Hant'], ['get', 'name']]

function scaleSize(value: unknown, factor: number): unknown {
  if (typeof value === 'number') return Math.round(value * factor * 10) / 10
  if (Array.isArray(value) && (value[0] === 'interpolate' || value[0] === 'step')) {
    // ['interpolate', curve, input, z0, v0, z1, v1, ...] / ['step', input, v0, z1, v1, ...]: scale the outputs only.
    const first = value[0] === 'interpolate' ? 4 : 2
    return value.map((item, index) => (index >= first && (index - first) % 2 === 0 ? scaleSize(item, factor) : item))
  }
  if (value && typeof value === 'object' && 'stops' in value) {
    const stops = (value as { stops: [number, number][] }).stops.map(([zoom, size]) => [zoom, size * factor])
    return { ...value, stops }
  }
  return value
}

/** Raster OSM fallback, used only when OpenFreeMap cannot be reached. */
function rasterFallback(tileUrl: string, kind: Kind): Basemap {
  return {
    vector: false,
    sources: {
      basemap: {
        type: 'raster', tiles: [tileUrl], tileSize: 256, maxzoom: 19,
        attribution: '<a href="https://www.openstreetmap.org/copyright">© OpenStreetMap contributors</a>',
      },
    },
    layers: [{
      id: 'basemap', source: 'basemap', type: 'raster',
      paint: kind === 'dark'
        ? { 'raster-brightness-min': 0.92, 'raster-brightness-max': 0.06, 'raster-saturation': -1, 'raster-contrast': 0.25 }
        : kind === 'liberty' ? {}
        : { 'raster-saturation': -0.55, 'raster-contrast': -0.08 },
    }],
  }
}

export async function loadBasemap(kind: Kind, fallbackTileUrl: string, options: Options = {}): Promise<Basemap> {
  try {
    const signal = AbortSignal.timeout(8000)
    const [style, tilejson] = await Promise.all([
      $fetch<StyleSpecification>(`${OPENFREEMAP}/styles/${STYLE_NAME[kind]}`, { signal }),
      $fetch<{ tiles: string[]; minzoom?: number; maxzoom?: number }>(`${OPENFREEMAP}/planet`, { signal }),
    ])
    const [[west, south], [east, north]] = TAIPEI_BOUNDS
    const sources: Record<string, SourceSpecification> = {
      openmaptiles: {
        type: 'vector',
        tiles: tilejson.tiles,
        minzoom: tilejson.minzoom ?? 0,
        maxzoom: tilejson.maxzoom ?? 14,
        bounds: [west, south, east, north],
        attribution: ATTRIBUTION,
      },
    }
    if (kind === 'liberty') {
      // Stock style: every source and layer as published. Only the vector source is clipped to Taipei,
      // layer ids are prefixed so they never clash with the app's own layers, and labels can be enlarged.
      for (const [name, source] of Object.entries(style.sources)) if (name !== 'openmaptiles') sources[name] = source
      const layers = style.layers.map((layer): LayerSpecification => {
        const id = `basemap-${layer.id}`
        if (!options.textScale || layer.type !== 'symbol' || !layer.layout?.['text-field']) return { ...layer, id } as LayerSpecification
        const layout = { ...layer.layout } as Record<string, unknown>
        layout['text-size'] = scaleSize(layout['text-size'] ?? 16, options.textScale) // 16 is MapLibre's default size
        return { ...layer, id, layout } as LayerSpecification
      })
      return { vector: true, glyphs: style.glyphs, sprite: style.sprite, sources, layers }
    }
    const layers = style.layers.flatMap((layer): LayerSpecification[] => {
      if (layer.type === 'background') return [{ ...layer, id: 'basemap-background' }]
      // Only the OpenMapTiles vector layers are kept (drops the world shaded-relief raster).
      if (!('source' in layer) || layer.source !== 'openmaptiles') return []
      const id = `basemap-${layer.id}`
      const sourceLayer = 'source-layer' in layer ? layer['source-layer'] : ''
      if (options.roadColor && layer.type === 'line' && sourceLayer === 'transportation' && /highway|road/.test(layer.id)) {
        return [{ ...layer, id, paint: { ...layer.paint, 'line-color': layer.id.includes('casing') ? palette.grey950 : options.roadColor } }]
      }
      if (options.buildingColor && layer.type === 'fill' && sourceLayer === 'building') {
        return [{ ...layer, id, paint: { ...layer.paint, 'fill-color': options.buildingColor, 'fill-outline-color': palette.grey800 } }]
      }
      if (layer.type !== 'symbol') return [{ ...layer, id }]
      const layout = { ...layer.layout } as Record<string, unknown>
      const paint = { ...layer.paint } as Record<string, unknown>
      if (JSON.stringify(layout['text-field'] ?? '').includes('name')) layout['text-field'] = LOCAL_NAME
      if (options.textScale && layout['text-size'] !== undefined) layout['text-size'] = scaleSize(layout['text-size'], options.textScale)
      else if (options.textScale && layout['text-field']) layout['text-size'] = Math.round(16 * options.textScale)
      if (options.textColor && layout['text-field']) {
        paint['text-color'] = options.textColor
        paint['text-halo-color'] = options.haloColor ?? palette.grey950
        paint['text-halo-width'] = 1.6
      }
      return [{ ...layer, id, layout, paint } as LayerSpecification]
    })
    // Landmark names (parks, schools, stations, sports venues, shops…). Neither the dark nor the positron
    // style draws points of interest, but they are what people navigate by. Text only, no icons.
    const poiSize = 13 * (options.textScale ?? 1)
    layers.push({
      id: 'basemap-poi-label',
      type: 'symbol',
      source: 'openmaptiles',
      'source-layer': 'poi',
      minzoom: 15,
      filter: ['all', ['has', 'name'], ['<=', ['coalesce', ['get', 'rank'], 99], 30]],
      layout: {
        'text-field': LOCAL_NAME as never,
        'text-font': ['Noto Sans Regular'],
        'text-size': ['interpolate', ['linear'], ['zoom'], 15, poiSize, 18, poiSize + 3],
        'text-max-width': 8,
        'text-padding': 4,
        'symbol-sort-key': ['coalesce', ['get', 'rank'], 99],
      },
      paint: {
        'text-color': options.textColor ? palette.secondary400 : palette.grey600,
        'text-halo-color': options.haloColor ?? palette.white,
        'text-halo-width': 1.6,
      },
    })
    return { vector: true, glyphs: style.glyphs, sprite: style.sprite, sources, layers }
  } catch {
    return rasterFallback(fallbackTileUrl, kind)
  }
}

/** MapLibre opens the compact attribution expanded; start it collapsed so it never covers the map. */
export function collapseAttribution(container: HTMLElement) {
  container.querySelector('.maplibregl-ctrl-attrib.maplibregl-compact-show')?.classList.remove('maplibregl-compact-show')
}
