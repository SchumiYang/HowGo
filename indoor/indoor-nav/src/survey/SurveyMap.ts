/** North-up 2D MapLibre map of one level with the survey plan overlaid. */
import { GeoJSONSource, LngLatBounds, Map as MlMap, setWorkerUrl } from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'
import type { FeatureCollection } from 'geojson'
import type { StyleSpecification } from '@maplibre/maplibre-gl-style-spec'
import type { Frame } from '../geo/frame'
import type { VenueData } from '../data/types'
import { venueSources } from '../map/convert'
import { FONT_STACK, UNIT_COLORS } from '../map/style'
import { TP } from '../tokens'
import type { Direction, Plan, XY } from './session'
import { walkKey, walkPath } from './session'

setWorkerUrl(workerUrl)

const empty = { type: 'geojson' as const, data: { type: 'FeatureCollection' as const, features: [] } }
const unitFill = ['match', ['get', 'category'], ...Object.entries(UNIT_COLORS).flatMap(([k, v]) => [k, v[0]]), TP.white]

function style(): StyleSpecification {
  return {
    version: 8,
    sources: { units: empty, walls: empty, walks: empty, points: empty, sel: empty, next: empty },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': TP.grayscale50 } },
      { id: 'units', type: 'fill', source: 'units', paint: { 'fill-color': unitFill as never, 'fill-opacity': 0.6, 'fill-outline-color': TP.grayscale200 } },
      { id: 'walls', type: 'line', source: 'walls', filter: ['==', ['get', 'layer'], 'wall'], paint: { 'line-color': TP.grayscale500, 'line-width': 1 } },
      {
        id: 'walks', type: 'line', source: 'walks',
        layout: { 'line-cap': 'round' },
        paint: {
          'line-color': ['case', ['get', 'done'], TP.primary500, TP.grayscale300],
          'line-width': 4,
          // forward drawn on one side, reverse on the other
          'line-offset': ['case', ['==', ['get', 'dir'], 'forward'], -3, 3],
        },
      },
      {
        id: 'sel-walk', type: 'line', source: 'sel', filter: ['==', ['geometry-type'], 'LineString'],
        layout: { 'line-cap': 'round' },
        paint: { 'line-color': TP.orange500, 'line-width': 7, 'line-opacity': 0.8 },
      },
      {
        id: 'sel-start', type: 'circle', source: 'sel', filter: ['==', ['get', 'role'], 'start'],
        paint: { 'circle-radius': 9, 'circle-color': TP.orange500, 'circle-stroke-color': TP.white, 'circle-stroke-width': 2 },
      },
      {
        id: 'next-vertex', type: 'circle', source: 'next',
        paint: { 'circle-radius': 12, 'circle-color': TP.red500, 'circle-opacity': 0.85, 'circle-stroke-color': TP.white, 'circle-stroke-width': 3 },
      },
      {
        id: 'points', type: 'circle', source: 'points',
        paint: {
          'circle-radius': ['case', ['get', 'sel'], 11, 7],
          'circle-color': ['case', ['>', ['get', 'n'], 0], TP.primary500, TP.grayscale300],
          'circle-stroke-color': ['case', ['get', 'sel'], TP.orange500, TP.white],
          'circle-stroke-width': ['case', ['get', 'sel'], 4, 1.5],
        },
      },
      {
        id: 'points-n', type: 'symbol', source: 'points', filter: ['>', ['get', 'n'], 0],
        layout: { 'text-field': ['to-string', ['get', 'n']], 'text-font': FONT_STACK, 'text-size': 10, 'text-allow-overlap': true },
        paint: { 'text-color': TP.white },
      },
    ],
  }
}

export class SurveyMap {
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

  private async set(id: string, data: FeatureCollection) {
    await this.loaded
    ;(this.map.getSource(id) as GeoJSONSource | undefined)?.setData(data)
  }

  async setBase(data: VenueData, level: string, plan: Plan) {
    const one = { ...data, levels: data.levels.filter((l) => l.level.id === level) }
    const src = venueSources(one, this.frame)
    await this.set('units', src.units)
    await this.set('walls', src.walls)
    const b = new LngLatBounds()
    for (const p of plan.points) b.extend(this.frame.toLngLat(p.xy))
    for (const w of plan.walks) for (const c of w.coords) b.extend(this.frame.toLngLat(c))
    if (!b.isEmpty()) this.map.fitBounds(b, { padding: 24, animate: false })
  }

  setPlan(plan: Plan, scans: Map<string, number>, done: Set<string>, selPoint: string | null) {
    const ll = (p: XY) => this.frame.toLngLat(p)
    void this.set('points', {
      type: 'FeatureCollection',
      features: plan.points.map((p) => ({
        type: 'Feature', geometry: { type: 'Point', coordinates: ll(p.xy) },
        properties: { id: p.id, n: scans.get(p.id) ?? 0, sel: p.id === selPoint },
      })),
    })
    void this.set('walks', {
      type: 'FeatureCollection',
      features: plan.walks.flatMap((w) =>
        (['forward', 'reverse'] as const).map((dir) => ({
          type: 'Feature' as const, geometry: { type: 'LineString' as const, coordinates: w.coords.map(ll) },
          properties: { id: w.id, dir, done: done.has(walkKey(w.id, dir)) },
        })),
      ),
    })
  }

  setSelectedWalk(coords: XY[] | null, dir: Direction) {
    const ll = (p: XY) => this.frame.toLngLat(p)
    const path = coords ? walkPath(coords, dir) : []
    void this.set('sel', {
      type: 'FeatureCollection',
      features: path.length
        ? [
            { type: 'Feature', geometry: { type: 'LineString', coordinates: path.map(ll) }, properties: { role: 'line' } },
            { type: 'Feature', geometry: { type: 'Point', coordinates: ll(path[0]) }, properties: { role: 'start' } },
          ]
        : [],
    })
  }

  /** next corner to tap 「經過轉角」 at (walk recording) */
  setNextVertex(xy: XY | null) {
    void this.set('next', { type: 'FeatureCollection', features: xy ? [{ type: 'Feature', geometry: { type: 'Point', coordinates: this.frame.toLngLat(xy) }, properties: {} }] : [] })
  }

  resize() {
    this.map.resize()
  }
}
