import type { ExpressionSpecification, Map as MapLibreMap } from 'maplibre-gl'
import { palette } from './palette'

/**
 * UI-004: one circular-badge SVG per layer-panel category, shared by the layer panel, the map
 * markers and the place card (UI-005). Files live in public/icons/map-layers/<name>.svg.
 */
export const layerIconNames = [
  'pedestrian', 'slope', 'accessible-parking', 'entrance-ramp', 'friendly-store',
  'accessible-restroom', 'public-transit', 'park', 'parking', 'accessible-facilities',
] as const
export type LayerIconName = typeof layerIconNames[number]

/** Badge colours from the spec table (UI-001 swatches), for anything that colour-codes a category. */
export const layerIconColors: Record<LayerIconName, string> = {
  pedestrian: palette.primary600,
  slope: palette.secondary800,
  'accessible-parking': palette.primary900,
  'entrance-ramp': palette.grey700,
  'friendly-store': palette.secondary500,
  'accessible-restroom': palette.primary800,
  'public-transit': palette.grey800,
  park: palette.green500,
  parking: palette.secondary700,
  'accessible-facilities': palette.orange500,
}

/** Data `kind` → category icon. Mirrors the quick-filter groups in app.vue. */
const kindIcons: Record<string, LayerIconName> = {
  '11': 'pedestrian', '12': 'pedestrian', '13': 'pedestrian', 'osm-crossing': 'pedestrian', arcade: 'pedestrian',
  slope: 'slope',
  'accessible-parking': 'accessible-parking',
  '1': 'entrance-ramp', '7': 'entrance-ramp', ramp: 'entrance-ramp',
  '8': 'friendly-store',
  '9': 'accessible-restroom',
  '18': 'public-transit', '20': 'public-transit',
  '4': 'park',
  '15': 'parking', '16': 'parking',
  '3': 'accessible-facilities', '14': 'accessible-facilities',
}

export function layerIconFor(kind: string | undefined | null): LayerIconName | null {
  return kind ? kindIcons[kind] ?? null : null
}

/** Public asset URL that respects app.baseURL / app.cdnURL. */
export function layerIconUrl(name: LayerIconName, base = '/') {
  return `${base.replace(/\/?$/, '/')}icons/map-layers/${name}.svg`
}

export const layerImageId = (name: LayerIconName) => `layer-${name}`

/** MapLibre `icon-image` expression: feature `kind` → registered layer image. */
export const layerIconExpression: ExpressionSpecification = [
  'match', ['get', 'kind'],
  ...Object.entries(kindIcons).flatMap(([kind, name]) => [kind, layerImageId(name)]),
  layerImageId('accessible-facilities'),
] as unknown as ExpressionSpecification

const ICON_PX = 64

/** Rasterise each SVG at 64 px and register it with pixelRatio 2 (32 CSS px at icon-size 1). */
export async function addLayerIcons(map: MapLibreMap, base = '/') {
  await Promise.all(layerIconNames.map(async (name) => {
    const id = layerImageId(name)
    if (map.hasImage(id)) return
    try {
      const image = new Image(ICON_PX, ICON_PX)
      image.src = layerIconUrl(name, base)
      await image.decode()
      const canvas = document.createElement('canvas')
      canvas.width = canvas.height = ICON_PX
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      ctx.drawImage(image, 0, 0, ICON_PX, ICON_PX)
      if (!map.hasImage(id)) map.addImage(id, ctx.getImageData(0, 0, ICON_PX, ICON_PX), { pixelRatio: 2 })
    } catch {
      // A missing icon only leaves that category without a marker; the rest still load.
    }
  }))
}
