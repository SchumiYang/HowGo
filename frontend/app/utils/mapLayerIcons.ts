import type { ExpressionSpecification, Map as MapLibreMap } from 'maplibre-gl'
import { palette, semantic } from './palette'

/**
 * UI-004: one circular-badge SVG per layer-panel category, shared by the layer panel, the map
 * markers and the place card (UI-005). Files live in public/icons/map-layers/<name>.svg.
 */
export const layerIconNames = [
  'pedestrian', 'slope', 'accessible-parking', 'entrance-ramp', 'friendly-store',
  'accessible-restroom', 'public-transit', 'park', 'parking', 'accessible-facilities',
] as const
export type LayerIconName = typeof layerIconNames[number]

/** Badge colours (UI-004 table, v2 UI-008 for 出入口／坡道, 身障停車格, 停車, 坡度), for anything that colour-codes a category. */
export const layerIconColors: Record<LayerIconName, string> = {
  pedestrian: palette.primary600,
  slope: palette.secondary700,
  'accessible-parking': palette.blue600,
  'entrance-ramp': palette.grey400,
  'friendly-store': palette.secondary500,
  'accessible-restroom': palette.primary800,
  'public-transit': palette.grey800,
  park: palette.green500,
  parking: palette.blue300,
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

/* ---------- UI-009 selection markers ---------- */

export const layerDotId = (name: LayerIconName) => `layer-dot-${name}`

/** `icon-image` for the small category dots shown for unselected markers while something is selected. */
export const layerDotExpression: ExpressionSpecification = [
  'match', ['get', 'kind'],
  ...Object.entries(kindIcons).flatMap(([kind, name]) => [kind, layerDotId(name)]),
  layerDotId('accessible-facilities'),
] as unknown as ExpressionSpecification

export const SELECTED_PIN_ID = 'map-selected-location'

/**
 * Dots: badge colour centre and outer ring with a thin white (map-marker-white) ring between,
 * 12 CSS px at icon-size 1. Pin: map-selected-location teardrop for non-facility picks.
 */
export function addSelectionImages(map: MapLibreMap) {
  const px = 24
  for (const name of layerIconNames) {
    const id = layerDotId(name)
    if (map.hasImage(id)) continue
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = px
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const disc = (radius: number, colour: string) => {
      ctx.beginPath()
      ctx.arc(px / 2, px / 2, radius, 0, Math.PI * 2)
      ctx.fillStyle = colour
      ctx.fill()
    }
    disc(11.5, layerIconColors[name])
    disc(8.5, semantic.mapMarkerWhite)
    disc(6.5, layerIconColors[name])
    map.addImage(id, ctx.getImageData(0, 0, px, px), { pixelRatio: 2 })
  }
  if (!map.hasImage(SELECTED_PIN_ID)) {
    const w = 56
    const h = 72
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.beginPath()
    ctx.moveTo(w / 2, h - 2)
    ctx.bezierCurveTo(w / 2, h - 2, 3, 40, 3, 26)
    ctx.arc(w / 2, 26, w / 2 - 3, Math.PI, 0)
    ctx.bezierCurveTo(w - 3, 40, w / 2, h - 2, w / 2, h - 2)
    ctx.closePath()
    ctx.fillStyle = semantic.mapSelectedLocation
    ctx.strokeStyle = semantic.mapMarkerWhite
    ctx.lineWidth = 3
    ctx.fill()
    ctx.stroke()
    ctx.beginPath()
    ctx.arc(w / 2, 26, 9, 0, Math.PI * 2)
    ctx.fillStyle = semantic.mapMarkerWhite
    ctx.fill()
    map.addImage(SELECTED_PIN_ID, ctx.getImageData(0, 0, w, h), { pixelRatio: 2 })
  }
}
