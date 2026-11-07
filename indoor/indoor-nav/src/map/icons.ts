import type { Map as MlMap } from 'maplibre-gl'
import { TP } from '../tokens'

/**
 * POI icons drawn on a canvas at runtime (no sprite sheet, works offline).
 * Paths use a 24x24 viewBox; `fill` paths are white unless a color is given.
 *
 * Accessibility-first scope: only toilets, elevators and stairs are shown. Stairs carry a
 * "not step-free" mark so users see why the accessible route avoids them.
 */
interface IconPath {
  d: string
  mode?: 'fill' | 'stroke'
  color?: string
}
interface IconSpec {
  bg: string
  paths: IconPath[]
  notStepFree?: boolean
}

const HEAD = (cx: number, cy: number, r: number) => `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0z`
const WHEELCHAIR: IconPath[] = [
  { d: HEAD(11, 4.2, 1.9) },
  { d: 'M11 7.5v6h5l2.5 5.5', mode: 'stroke' },
  { d: 'M8.5 11a5.2 5.2 0 1 0 7 6.6', mode: 'stroke' },
]

const ICONS: Record<string, IconSpec> = {
  'toilet.accessible': { bg: TP.primary500, paths: WHEELCHAIR },
  'toilet.male': { bg: TP.primary700, paths: [{ d: HEAD(12, 4.8, 2.2) }, { d: 'M9 8.5h6l1 7h-2.2v6h-3.6v-6H8z' }] },
  'toilet.female': { bg: TP.red600, paths: [{ d: HEAD(12, 4.8, 2.2) }, { d: 'M10 8.5h4l3 8h-3.1v5h-3.8v-5H7z' }] },
  elevator: {
    bg: TP.primary600,
    paths: [{ d: 'M5 3h14v18H5z', mode: 'stroke' }, { d: 'M8.5 10.5L12 6l3.5 4.5z' }, { d: 'M8.5 13.5L12 18l3.5-4.5z' }],
  },
  stairs: { bg: TP.grayscale500, paths: [{ d: 'M3.5 19.5h4.5v-4.5h4.5v-4.5h4.5V6h3.5', mode: 'stroke' }], notStepFree: true },
}

/** Map icon id for a POI category, or null if the category is not rendered. */
export const poiIcon = (category: string) => (category in ICONS ? `poi-${category}` : null)

const PR = 2 // device pixel ratio of the generated images
const SIZE = 32 // css px

/** CanvasRenderingContext2D.roundRect needs Safari 16+; fall back to a plain rect. */
function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  if (typeof ctx.roundRect === 'function') ctx.roundRect(x, y, w, h, r)
  else ctx.rect(x, y, w, h)
}

function drawIcon(spec: IconSpec): HTMLCanvasElement {
  const px = SIZE * PR
  const c = document.createElement('canvas')
  c.width = c.height = px
  const ctx = c.getContext('2d')!
  ctx.scale(PR, PR)
  // badge with white ring + soft shadow
  ctx.shadowColor = 'rgba(0,0,0,0.25)'
  ctx.shadowBlur = 2
  ctx.shadowOffsetY = 0.5
  ctx.fillStyle = TP.white
  ctx.beginPath()
  roundRect(ctx, 1.5, 1.5, SIZE - 3, SIZE - 3, 8)
  ctx.fill()
  ctx.shadowColor = 'transparent'
  ctx.fillStyle = spec.bg
  ctx.beginPath()
  roundRect(ctx, 3, 3, SIZE - 6, SIZE - 6, 6.5)
  ctx.fill()

  ctx.save()
  const inner = SIZE - 6
  const s = (inner * 0.8) / 24
  ctx.translate(3 + (inner - 24 * s) / 2, 3 + (inner - 24 * s) / 2)
  ctx.scale(s, s)
  ctx.lineWidth = 2.2
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  for (const p of spec.paths) {
    const path = new Path2D(p.d)
    if (p.mode === 'stroke') {
      ctx.strokeStyle = p.color ?? TP.white
      ctx.stroke(path)
    } else {
      ctx.fillStyle = p.color ?? TP.white
      ctx.fill(path)
    }
  }
  ctx.restore()

  if (spec.notStepFree) {
    // small "no wheelchair access" disc in the corner: red with a white slash
    const r = 6.5
    const cx = SIZE - r - 0.5
    const cy = SIZE - r - 0.5
    ctx.fillStyle = TP.white
    ctx.beginPath()
    ctx.arc(cx, cy, r + 1.2, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = TP.red600
    ctx.beginPath()
    ctx.arc(cx, cy, r, 0, Math.PI * 2)
    ctx.fill()
    ctx.strokeStyle = TP.white
    ctx.lineWidth = 1.8
    ctx.lineCap = 'round'
    ctx.beginPath()
    ctx.moveTo(cx - r * 0.55, cy - r * 0.55)
    ctx.lineTo(cx + r * 0.55, cy + r * 0.55)
    ctx.stroke()
  }
  return c
}

/** Destination pin (red500 teardrop, white ring + dot); anchored at its tip. */
function drawPin(): ImageData {
  const w = 30
  const h = 40
  const c = document.createElement('canvas')
  c.width = w * PR
  c.height = h * PR
  const ctx = c.getContext('2d')!
  ctx.scale(PR, PR)
  const pin = new Path2D('M15 39C15 39 3 24.5 3 15a12 12 0 0 1 24 0c0 9.5-12 24-12 24z')
  ctx.shadowColor = 'rgba(0,0,0,0.3)'
  ctx.shadowBlur = 2
  ctx.fillStyle = TP.red500
  ctx.fill(pin)
  ctx.shadowColor = 'transparent'
  ctx.strokeStyle = TP.white
  ctx.lineWidth = 2
  ctx.stroke(pin)
  ctx.fillStyle = TP.white
  ctx.beginPath()
  ctx.arc(15, 15, 4.5, 0, Math.PI * 2)
  ctx.fill()
  return ctx.getImageData(0, 0, w * PR, h * PR)
}

export function registerIcons(map: MlMap) {
  for (const [cat, spec] of Object.entries(ICONS)) {
    const id = `poi-${cat}`
    if (!map.hasImage(id)) map.addImage(id, drawIcon(spec).getContext('2d')!.getImageData(0, 0, SIZE * PR, SIZE * PR), { pixelRatio: PR })
  }
  if (!map.hasImage('dest-pin')) map.addImage('dest-pin', drawPin(), { pixelRatio: PR })
}

const urlCache = new Map<string, string>()
/** The same POI badge as a data URL, for the HTML UI (falls back to the elevator badge). */
export function iconDataUrl(category: string): string {
  let url = urlCache.get(category)
  if (!url) urlCache.set(category, (url = drawIcon(ICONS[category] ?? ICONS.elevator).toDataURL()))
  return url
}
