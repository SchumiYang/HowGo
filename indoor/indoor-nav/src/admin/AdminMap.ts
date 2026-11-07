/** North-up 2D map of one level with admin overlays (coverage, validation). Features are given in local metres. */
import { GeoJSONSource, ImageSource, LngLatBounds, Map as MlMap, setWorkerUrl } from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'
import type { Feature, FeatureCollection, Geometry } from 'geojson'
import type { LayerSpecification, StyleSpecification } from '@maplibre/maplibre-gl-style-spec'
import type { Frame, XY } from '../geo/frame'
import type { VenueData } from '../data/types'
import { venueSources } from '../map/convert'
import { UNIT_COLORS } from '../map/style'
import { TP } from '../tokens'

setWorkerUrl(workerUrl)

export type LocalGeom = { type: 'Point'; coordinates: XY } | { type: 'LineString'; coordinates: XY[] } | { type: 'Polygon'; coordinates: XY[][] }
export interface LocalFeature { geometry: LocalGeom; properties?: Record<string, unknown> }

export const OVERLAYS = ['ap', 'plan', 'gaps', 'walked', 'uncovered', 'mag', 'fp', 'truthpath', 'track', 'acc', 'cp', 'est', 'truth'] as const
export type Overlay = (typeof OVERLAYS)[number]

const empty = { type: 'geojson' as const, data: { type: 'FeatureCollection' as const, features: [] } }
const unitFill = ['match', ['get', 'category'], ...Object.entries(UNIT_COLORS).flatMap(([k, v]) => [k, v[0]]), TP.white]
const zr = (lo: number, hi: number) => ['interpolate', ['exponential', 2], ['zoom'], 18, lo, 22, hi]

/** |B| heat ramp (µT): blue (low) -> yellow -> red (high) */
export const MAG_RAMP: [number, string][] = [[25, '#2c7bb6'], [40, '#abd9e9'], [50, '#ffffbf'], [60, '#fdae61'], [80, '#d7191c']]

function style(): StyleSpecification {
  const layers: LayerSpecification[] = [
    { id: 'bg', type: 'background', paint: { 'background-color': TP.grayscale50 } },
    { id: 'units', type: 'fill', source: 'units', paint: { 'fill-color': unitFill as never, 'fill-opacity': 0.6, 'fill-outline-color': TP.grayscale200 } },
    // heatmap image layer ('heat', added on demand by setHeat) goes here: above floor fills, below walls
    { id: 'walls', type: 'line', source: 'walls', filter: ['==', ['get', 'layer'], 'wall'], paint: { 'line-color': TP.grayscale500, 'line-width': 1 } },
    {
      id: 'mag', type: 'circle', source: 'mag',
      paint: {
        'circle-radius': zr(2.5, 22) as never,
        'circle-color': ['interpolate', ['linear'], ['get', 'B'], ...MAG_RAMP.flat()] as never,
        'circle-opacity': 0.85,
      },
    },
    // planned survey walks with no recording: wide translucent red band under everything else
    { id: 'gaps', type: 'line', source: 'gaps', layout: { 'line-cap': 'round' }, paint: { 'line-color': TP.red500, 'line-width': 14, 'line-opacity': 0.3 } },
    { id: 'walked', type: 'line', source: 'walked', layout: { 'line-cap': 'round' }, paint: { 'line-color': ['coalesce', ['get', 'color'], TP.primary500] as never, 'line-width': 3, 'line-opacity': 0.75 } },
    { id: 'uncovered', type: 'line', source: 'uncovered', layout: { 'line-cap': 'round' }, paint: { 'line-color': TP.red500, 'line-width': 6, 'line-dasharray': [1, 1] } },
    // reference points (survey points / nav nodes): faint, small, only when zoomed in
    {
      id: 'plan', type: 'circle', source: 'plan', minzoom: 19,
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 19, 1.5, 22, 3.5] as never,
        'circle-color': TP.grayscale500, 'circle-opacity': 0.45, 'circle-stroke-width': 0,
      },
    },
    {
      id: 'ap', type: 'circle', source: 'ap',
      paint: { 'circle-radius': 9, 'circle-color': TP.white, 'circle-stroke-color': TP.grayscale900, 'circle-stroke-width': 3 },
    },
    {
      id: 'fp', type: 'circle', source: 'fp',
      paint: {
        // small data-point dots (the heatmap underneath carries the values)
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 18, 2, 21, 5] as never,
        'circle-color': ['match', ['get', 'src'], 'point', TP.primary700, TP.secondary500] as never,
        'circle-opacity': 0.8, 'circle-stroke-color': TP.white, 'circle-stroke-width': 1,
      },
    },
    { id: 'truthpath', type: 'line', source: 'truthpath', paint: { 'line-color': TP.orange500, 'line-width': 3, 'line-dasharray': [2, 1] } },
    { id: 'track', type: 'line', source: 'track', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': TP.primary600, 'line-width': 3 } },
    { id: 'acc', type: 'fill', source: 'acc', paint: { 'fill-color': TP.primary500, 'fill-opacity': 0.18, 'fill-outline-color': TP.primary600 } },
    { id: 'cp-line', type: 'line', source: 'cp', filter: ['==', ['geometry-type'], 'LineString'], paint: { 'line-color': TP.red500, 'line-width': 2 } },
    {
      id: 'cp-pt', type: 'circle', source: 'cp', filter: ['==', ['geometry-type'], 'Point'],
      paint: { 'circle-radius': 5, 'circle-color': ['match', ['get', 'role'], 'truth', TP.orange500, TP.primary700] as never, 'circle-stroke-color': TP.white, 'circle-stroke-width': 1.5 },
    },
    { id: 'est', type: 'circle', source: 'est', paint: { 'circle-radius': 8, 'circle-color': TP.primary700, 'circle-stroke-color': TP.white, 'circle-stroke-width': 3 } },
    {
      id: 'truth', type: 'circle', source: 'truth',
      paint: { 'circle-radius': 11, 'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-color': TP.orange500, 'circle-stroke-width': 4 },
    },
    { id: 'truth-dot', type: 'circle', source: 'truth', paint: { 'circle-radius': 2.5, 'circle-color': TP.orange500 } },
  ]
  const sources: StyleSpecification['sources'] = { units: empty, walls: empty }
  for (const o of OVERLAYS) sources[o] = empty
  return { version: 8, sources, layers }
}

const LAYERS_OF: Record<Overlay, string[]> = {
  ap: ['ap'], plan: ['plan'], gaps: ['gaps'], walked: ['walked'], uncovered: ['uncovered'], mag: ['mag'], fp: ['fp'], truthpath: ['truthpath'],
  track: ['track'], acc: ['acc'], cp: ['cp-line', 'cp-pt'], est: ['est'], truth: ['truth', 'truth-dot'],
}

export function circlePolygon(c: XY, r: number, n = 48): LocalGeom {
  const ring: XY[] = []
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * 2 * Math.PI
    ring.push([c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)])
  }
  return { type: 'Polygon', coordinates: [ring] }
}

export class AdminMap {
  readonly map: MlMap
  private loaded: Promise<void>
  private frame: Frame
  onTap: (xy: XY) => void = () => {}

  constructor(container: HTMLElement, frame: Frame) {
    this.frame = frame
    this.map = new MlMap({
      container, style: style(), center: [121.5346, 25.1157], zoom: 18,
      dragRotate: false, pitchWithRotate: false, touchPitch: false, maxPitch: 0,
      attributionControl: false, renderWorldCopies: false, maxZoom: 23, fadeDuration: 0,
    })
    this.map.touchZoomRotate.disableRotation()
    this.loaded = new Promise((r) => this.map.once('load', () => r()))
    this.map.on('click', (e) => this.onTap(this.frame.toLocal([e.lngLat.lng, e.lngLat.lat])))
  }

  private toGeo(g: LocalGeom): Geometry {
    const ll = (p: XY) => this.frame.toLngLat(p)
    if (g.type === 'Point') return { type: 'Point', coordinates: ll(g.coordinates) }
    if (g.type === 'LineString') return { type: 'LineString', coordinates: g.coordinates.map(ll) }
    return { type: 'Polygon', coordinates: g.coordinates.map((r) => r.map(ll)) }
  }

  private async setSource(id: string, data: FeatureCollection) {
    await this.loaded
    ;(this.map.getSource(id) as GeoJSONSource | undefined)?.setData(data)
  }

  async setBase(data: VenueData, level: string, fitTo?: XY[]) {
    const one = { ...data, levels: data.levels.filter((l) => l.level.id === level) }
    const src = venueSources(one, this.frame)
    await this.setSource('units', src.units)
    await this.setSource('walls', src.walls)
    const b = new LngLatBounds()
    if (fitTo?.length) for (const p of fitTo) b.extend(this.frame.toLngLat(p))
    else if (Number.isFinite(src.bbox[0])) {
      b.extend(this.frame.toLngLat([src.bbox[0], src.bbox[1]]))
      b.extend(this.frame.toLngLat([src.bbox[2], src.bbox[3]]))
    }
    if (!b.isEmpty()) this.map.fitBounds(b, { padding: 12, animate: false })
  }

  set(o: Overlay, features: LocalFeature[]) {
    void this.setSource(o, {
      type: 'FeatureCollection',
      features: features.map((f): Feature => ({ type: 'Feature', geometry: this.toGeo(f.geometry), properties: f.properties ?? {} })),
    })
  }

  async setVisible(o: Overlay, on: boolean) {
    await this.loaded
    for (const l of LAYERS_OF[o]) this.map.setLayoutProperty(l, 'visibility', on ? 'visible' : 'none')
  }

  /**
   * One image overlay for the heatmap (corners TL, TR, BR, BL in local metres); null removes it.
   * The image is only replaced when the caller passes a new URL (cached per selection by the caller).
   */
  async setHeat(heat: { url: string; corners: [XY, XY, XY, XY] } | null, opacity = 0.75) {
    await this.loaded
    const m = this.map
    if (!heat) {
      if (m.getLayer('heat')) m.removeLayer('heat')
      if (m.getSource('heat')) m.removeSource('heat')
      this.heatUrl = null
      return
    }
    const coordinates = heat.corners.map((c) => this.frame.toLngLat(c)) as [[number, number], [number, number], [number, number], [number, number]]
    const src = m.getSource('heat') as ImageSource | undefined
    if (!src) {
      m.addSource('heat', { type: 'image', url: heat.url, coordinates })
      m.addLayer({ id: 'heat', type: 'raster', source: 'heat', paint: { 'raster-opacity': opacity, 'raster-resampling': 'linear', 'raster-fade-duration': 0 } }, 'walls')
    } else if (this.heatUrl !== heat.url) {
      src.updateImage({ url: heat.url, coordinates })
    }
    this.heatUrl = heat.url
    m.setPaintProperty('heat', 'raster-opacity', opacity)
  }
  private heatUrl: string | null = null

  async setHeatOpacity(opacity: number) {
    await this.loaded
    if (this.map.getLayer('heat')) this.map.setPaintProperty('heat', 'raster-opacity', opacity)
  }

  resize() {
    this.map.resize()
  }

  destroy() {
    this.map.remove()
  }
}
