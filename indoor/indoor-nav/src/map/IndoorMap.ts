import { GeoJSONSource, ImageSource, LngLat, LngLatBounds, Map as MlMap, setWorkerUrl, type MapMouseEvent, type MapTouchEvent, type PaddingOptions } from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'
import type { ExpressionSpecification } from '@maplibre/maplibre-gl-style-spec'
import type { Frame, XY } from '../geo/frame'
import { emptyBBox, extendBBox, isValidBBox, type BBox } from '../geo/geometry'
import type { VenueData } from '../data/types'
import type { Route } from '../routing/route'
import { routeSources, venueSources } from './convert'
import type { FloorplanOverlay } from './floorplan'
import { accuracyOpacity, circleRing, wedgeRing } from './markers'
import { registerIcons } from './icons'
import { BASE_FILTERS, baseStyle, LEVEL_LAYERS, PITCH_3D, SRC } from './style'

setWorkerUrl(workerUrl)

export interface MapPick {
  kind: 'tap' | 'longpress'
  level: string
  xy: XY
  /** topmost unit / POI under the pointer on the current level */
  unitId?: string
  poiId?: string
}

const MAX_PITCH = 60
/** margin around the building in the home fit (px) */
const FIT_MARGIN_PX = 10
/** the building fit never zooms in past this (small venues / tiny screens) */
const BUILDING_MAX_ZOOM = 20
const LONGPRESS_MS = 550
const LONGPRESS_SLOP_PX = 10

export class IndoorMap {
  readonly map: MlMap
  private frame: Frame | null = null
  private level = ''
  private bbox: BBox = emptyBBox()
  private venueId = ''
  private is3d = false
  private meShown: { level: string; xy: XY } | null = null
  private meAnim = 0
  private venueBearing = 0
  private floorplanUrl: string | null = null
  private controls: { right: number; bottom: number } | null = null
  /** pitch used by fits in 3D: the default, or the last pitch the user dragged to */
  private pitch3d = PITCH_3D
  private insets: PaddingOptions = { top: 24, bottom: 24, left: 24, right: 24 }
  private loaded: Promise<void>
  onPick: (p: MapPick) => void = () => {}
  onCamera: (c: { bearing: number; pitch: number }) => void = () => {}
  /** the user dragged the map (used to pause follow mode) */
  onUserPan: () => void = () => {}

  constructor(container: HTMLElement, bearingDeg = 0) {
    this.map = new MlMap({
      container,
      style: baseStyle(),
      center: [121.5645, 25.0375],
      zoom: 17,
      bearing: bearingDeg,
      // Rotation: two-finger rotate (touch), right-/ctrl-drag (desktop). Pitch gestures
      // (two-finger vertical drag, right-drag) only in 3D: setView3D toggles touchPitch and maxPitch.
      // Turn instructions are relative to the walking direction, so rotation doesn't affect them.
      maxPitch: MAX_PITCH,
      pitchWithRotate: true,
      dragRotate: true,
      touchPitch: true,
      attributionControl: false,
      renderWorldCopies: false,
      maxZoom: 23,
      fadeDuration: 0,
    })
    this.loaded = new Promise((resolve) => this.map.once('load', () => resolve()))
    const emitCamera = () => this.onCamera({ bearing: this.map.getBearing(), pitch: this.map.getPitch() })
    this.map.on('rotate', emitCamera)
    this.map.on('pitch', emitCamera)
    this.map.on('moveend', emitCamera)
    // remember a user-chosen 3D pitch for later fits
    this.map.on('pitchend', () => {
      if (this.is3d && this.map.getPitch() > 5) this.pitch3d = this.map.getPitch()
    })
    this.map.on('styleimagemissing', () => registerIcons(this.map))
    this.loaded.then(() => registerIcons(this.map))
    this.bindPointer()
  }

/**
   * 2D / 3D view. 3D = extruded walls + pitched camera; 2D = flat walls, pitch 0 (accessibility,
   * low-end devices). Only sets state + wall visibility; callers refit to apply the camera.
   */
  async setView3D(on: boolean) {
    const m = this.map
    this.is3d = on
    if (on) {
      this.pitch3d = PITCH_3D // switching to 3D restores the default pitch
      m.setMaxPitch(MAX_PITCH)
      m.touchPitch.enable()
    } else {
      m.touchPitch.disable()
      // lock pitch at 0 once the refit has flattened the view (setting it now would jump)
      const lock = () => !this.is3d && m.setMaxPitch(0)
      if (m.getPitch() === 0) lock()
      else m.once('pitchend', lock)
    }
    await this.loaded
    for (const id of ['walls-3d', 'seating-3d', 'seating-parapet-3d']) m.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none')
  }

  /**
   * Raster floor plan (floorplan.json) as an image overlay. Main app: under the unit fills
   * (default `before`); the admin puts it above them to compare with the walls. Same URL ->
   * only corners / opacity are updated (cheap enough for dragging during calibration).
   */
  async setFloorplan(fp: FloorplanOverlay | null, before = 'units-fill') {
    await this.loaded
    const m = this.map
    if (!fp || !this.frame) {
      if (m.getLayer('floorplan')) m.removeLayer('floorplan')
      if (m.getSource('floorplan')) m.removeSource('floorplan')
      this.floorplanUrl = null
      return
    }
    const coordinates = fp.corners.map((c) => this.frame!.toLngLat(c)) as [[number, number], [number, number], [number, number], [number, number]]
    const src = m.getSource('floorplan') as ImageSource | undefined
    if (src && this.floorplanUrl === fp.url) src.setCoordinates(coordinates)
    else {
      if (m.getLayer('floorplan')) m.removeLayer('floorplan')
      if (src) m.removeSource('floorplan')
      m.addSource('floorplan', { type: 'image', url: fp.url, coordinates })
      m.addLayer({ id: 'floorplan', type: 'raster', source: 'floorplan', paint: { 'raster-opacity': fp.opacity, 'raster-fade-duration': 0 } }, m.getLayer(before) ? before : undefined)
      this.floorplanUrl = fp.url
    }
    m.setPaintProperty('floorplan', 'raster-opacity', fp.opacity)
  }

  /** Animate back to north-up, keeping pitch and centre. */
  resetNorth() {
    this.map.easeTo({ bearing: 0, duration: 400 })
  }

  /** Space taken by UI overlays, so fits keep content visible. */
  setInsets(p: PaddingOptions) {
    this.insets = p
  }

  /**
   * Set (or refresh, e.g. after a level's walls were lazy-loaded) the venue sources. Only the
   * first call for a venue moves the camera.
   */
  async setVenue(data: VenueData, frame: Frame) {
    await this.loaded
    const first = this.venueId !== data.venue.id
    this.venueId = data.venue.id
    this.frame = frame
    if (first) {
      this.map.setBearing(data.venue.bearing_deg) // later refreshes keep the user's rotation
      this.venueBearing = data.venue.bearing_deg
    }
    const s = venueSources(data, frame)
    this.bbox = s.bbox
    this.src(SRC.units).setData(s.units)
    this.src(SRC.labels).setData(s.labels)
    this.src(SRC.walls).setData(s.walls)
    this.src(SRC.walls3d).setData(s.walls3d)
    this.src(SRC.seating3d).setData(s.seating3d)
    this.src(SRC.columns).setData(s.columns)
    this.src(SRC.pois).setData(s.pois)
    if (isValidBBox(this.bbox)) {
      const pad = 600 // m of slack around the building for panning (generous: pitched views see far)
      const b = this.lngLatBounds([this.bbox[0] - pad, this.bbox[1] - pad, this.bbox[2] + pad, this.bbox[3] + pad])
      this.map.setMaxBounds(b)
      if (first) this.fitBuilding(false)
    }
  }

  async setLevel(level: string) {
    await this.loaded
    this.level = level
    const on: ExpressionSpecification = ['==', ['get', 'level'], level]
    for (const id of LEVEL_LAYERS) {
      const base = BASE_FILTERS[id]
      this.map.setFilter(id, base ? ['all', base, on] : on)
    }
  }

  /** Blue dot. `heading` is a compass bearing in degrees (clockwise from north). */
  /**
   * The position dot. `heading`: compass bearing in degrees (the cone is map-aligned, so it stays
   * correct at any map rotation). `accuracy` (m) sizes the halo. With `animate`, moves on the same
   * level glide over ~200 ms instead of jumping.
   */
  async setMe(me: { level: string; xy: XY; accuracy?: number } | null, heading: number | null = null, animate = false) {
    await this.loaded
    if (!this.frame) return
    cancelAnimationFrame(this.meAnim)
    const f = this.frame
    const draw = (xy: XY) => {
      const features: GeoJSON.Feature[] = []
      if (me) {
        const level = me.level
        const acc = me.accuracy ?? 2
        const ll = (ring: XY[]) => [ring.map((p) => f.toLngLat(p))]
        // accuracy and heading live on the ground plane (metres), so pitch / bearing apply to them
        features.push({ type: 'Feature', geometry: { type: 'Polygon', coordinates: ll(circleRing(xy, acc)) }, properties: { level, kind: 'acc', opacity: accuracyOpacity(acc) } })
        if (heading != null) {
          const local = heading - this.venueBearing // compass -> clockwise from local +y
          features.push({ type: 'Feature', geometry: { type: 'Polygon', coordinates: ll(wedgeRing(xy, local)) }, properties: { level, kind: 'cone' } })
        }
        features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: f.toLngLat(xy) }, properties: { level, kind: 'dot' } })
      }
      this.src(SRC.me).setData({ type: 'FeatureCollection', features })
      this.meShown = me ? { level: me.level, xy } : null
    }
    const from = this.meShown
    if (!me || !animate || !from || from.level !== me.level) return draw(me?.xy ?? [0, 0])
    const t0 = performance.now()
    const step = () => {
      const k = Math.min(1, (performance.now() - t0) / 200)
      const e = k * (2 - k) // ease-out
      draw([from.xy[0] + (me.xy[0] - from.xy[0]) * e, from.xy[1] + (me.xy[1] - from.xy[1]) * e])
      if (k < 1) this.meAnim = requestAnimationFrame(step)
    }
    step()
  }

  /** Keep the dot in view while navigating (no zoom change). */
  follow(xy: XY) {
    if (!this.frame) return
    const { top = 0, bottom = 0, left = 0, right = 0 } = this.insets
    this.map.easeTo({ center: this.frame.toLngLat(xy), offset: [(left - right) / 2, (top - bottom) / 2], duration: 300 })
  }

  async setRoute(route: Route | null, levelName: (id: string) => string, destLabel?: string) {
    await this.loaded
    if (!this.frame) return
    const s = routeSources(route, this.frame, levelName, destLabel)
    this.src(SRC.route).setData(s.lines)
    this.src(SRC.routePts).setData(s.points)
  }

  /**
   * Fit the whole building into the visible map area (above the bottom sheet). The floating
   * controls only cover the top-right corner, so two placements are tried — beside the controls
   * (full height) and below them (full width) — and the one giving the larger zoom wins. On a
   * portrait phone a wide building usually fits best below the controls.
   */
  fitBuilding(animate = true) {
    if (!isValidBBox(this.bbox) || !this.frame) return
    const m = FIT_MARGIN_PX
    const bottom = Math.max(m, (this.insets.bottom ?? 0) - 8)
    const z = this.controls
    const options: PaddingOptions[] = z
      ? [
          { top: m, left: m, bottom, right: z.right + m }, // beside the controls
          { top: z.bottom + m, left: m, bottom, right: m }, // below the controls
        ]
      : [{ top: m, left: m, bottom, right: m }]
    const pitch = this.is3d ? this.pitch3d : 0
    let best: { center: LngLat; zoom: number } | null = null
    for (const p of options) {
      const cam = this.fitCamera(this.bbox, p, pitch, BUILDING_MAX_ZOOM)
      if (cam && (!best || cam.zoom > best.zoom)) best = cam
    }
    if (!best) return
    const target = { ...best, pitch, bearing: this.map.getBearing() }
    if (animate) this.map.easeTo({ ...target, duration: 500 })
    else this.map.jumpTo(target)
  }

  /** Space taken by the floating control column (top-right), in px from the right / top edges. */
  setControlsZone(z: { right: number; bottom: number } | null) {
    this.controls = z
  }

  /**
   * Fit the given local points (e.g. the route part on one level). Extra room for the destination
   * pin + label: they stand ~60 px above their point and the label is ~90 px wide.
   */
  fitPoints(points: XY[], animate = true) {
    if (!points.length) return
    const b = points.reduce((bb, p) => extendBBox(bb, p), emptyBBox())
    const minSize = 28 // m: keep some context around short routes
    const cx = (b[0] + b[2]) / 2
    const cy = (b[1] + b[3]) / 2
    const hw = Math.max(minSize, b[2] - b[0]) / 2
    const hh = Math.max(minSize, b[3] - b[1]) / 2
    const { top = 0, left = 0, right = 0 } = this.insets
    this.fitLocal([cx - hw, cy - hh, cx + hw, cy + hh], animate, { ...this.insets, top: top + 56, left: left + 40, right: right + 40 })
  }

  /** Centre on a local point; `bearing` (compass degrees) optionally rotates the map (course-up). */
  flyTo(xy: XY, zoom?: number, bearing?: number) {
    if (!this.frame) return
    // `offset` instead of `padding`: padding passed to easeTo persists on the map and would
    // then be added to later fitBounds paddings
    const { top = 0, bottom = 0, left = 0, right = 0 } = this.insets
    this.map.easeTo({
      center: this.frame.toLngLat(xy),
      zoom: zoom ?? Math.max(this.map.getZoom(), 19),
      offset: [(left - right) / 2, (top - bottom) / 2],
      ...(bearing == null ? {} : { bearing }),
      duration: 500,
    })
  }

  resize() {
    this.map.resize()
  }

  destroy() {
    this.map.remove()
  }

  // ---------------------------------------------------------------------------

  private src(id: string) {
    return this.map.getSource(id) as GeoJSONSource
  }

  private lngLatBounds([x0, y0, x1, y1]: BBox): LngLatBounds {
    const b = new LngLatBounds()
    for (const p of [[x0, y0], [x1, y0], [x1, y1], [x0, y1]] as XY[]) b.extend(this.frame!.toLngLat(p))
    return b
  }

  private fitLocal(bb: BBox, animate: boolean, padding: PaddingOptions = this.insets) {
    if (!this.frame) return
    // fits keep the user's current bearing; pitch is the view's (0 in 2D, last 3D pitch in 3D)
    const pitch = this.is3d ? this.pitch3d : 0
    const cam = this.fitCamera(bb, padding, pitch)
    if (!cam) return
    const target = { ...cam, pitch, bearing: this.map.getBearing() }
    if (animate) this.map.easeTo({ ...target, duration: 500 })
    else this.map.jumpTo(target)
  }

  /**
   * Camera that fits a local bbox inside the padded viewport at the current bearing and the given
   * pitch. fitBounds/cameraForBounds assume a flat view and fit an axis-aligned lng/lat box (loose
   * when rotated), so: start from that, then iterate on the projected bbox corners, adjusting zoom
   * and centre until they sit inside the padding.
   */
  private fitCamera(bb: BBox, padding: PaddingOptions, pitch: number, maxZoom = 21): { center: LngLat; zoom: number } | null {
    const m = this.map
    const bearing = m.getBearing()
    const flat = m.cameraForBounds(this.lngLatBounds(bb), { padding, bearing, maxZoom })
    if (!flat?.center || flat.zoom == null) return null

    const { top = 0, bottom = 0, left = 0, right = 0 } = padding
    // the footprint is fitted; wall tops at the far edge stand only a few px above it at this scale
    const topPad = top + (pitch > 0 ? 4 : 0)
    const w = m.getContainer().clientWidth - left - right
    const h = m.getContainer().clientHeight - topPad - bottom
    const corners = ([[bb[0], bb[1]], [bb[2], bb[1]], [bb[2], bb[3]], [bb[0], bb[3]]] as XY[]).map((p) => this.frame!.toLngLat(p))
    const saved = { center: m.getCenter(), zoom: m.getZoom(), pitch: m.getPitch(), bearing }
    m.jumpTo({ center: flat.center, zoom: flat.zoom, pitch, bearing })
    for (let i = 0; i < 8; i++) {
      const pts = corners.map((c) => m.project(c))
      const xs = pts.map((p) => p.x)
      const ys = pts.map((p) => p.y)
      const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]
      const dz = Math.log2(Math.min(w / (x1 - x0), h / (y1 - y0)))
      const dx = (x0 + x1) / 2 - (left + w / 2)
      const dy = (y0 + y1) / 2 - (topPad + h / 2)
      const c = m.project(m.getCenter())
      m.jumpTo({ center: m.unproject([c.x + dx, c.y + dy]), zoom: Math.min(maxZoom, m.getZoom() + dz) })
      if (Math.abs(dz) < 0.01 && Math.abs(dx) < 1 && Math.abs(dy) < 1) break
    }
    const out = { center: m.getCenter(), zoom: m.getZoom() }
    m.jumpTo(saved)
    return out
  }

  private toPick(kind: MapPick['kind'], point: { x: number; y: number }, lngLat: { lng: number; lat: number }): MapPick | null {
    if (!this.frame || !this.level) return null
    const pick: MapPick = { kind, level: this.level, xy: this.frame.toLocal([lngLat.lng, lngLat.lat]) }
    const hits = this.map.queryRenderedFeatures([point.x, point.y], { layers: ['pois', 'units-fill'] })
    for (const h of hits) {
      const id = h.properties?.id as string | undefined
      if (!id) continue
      if (h.layer.id === 'pois' && !pick.poiId) pick.poiId = id
      if (h.layer.id === 'units-fill' && !pick.unitId) pick.unitId = id
    }
    return pick
  }

  private bindPointer() {
    const m = this.map
    m.on('dragstart', () => this.onUserPan())
    let timer: ReturnType<typeof setTimeout> | null = null
    let startPt: { x: number; y: number } | null = null
    let lastLongpress = 0
    const cancel = () => {
      if (timer) clearTimeout(timer)
      timer = null
    }
    const fireLongpress = (point: { x: number; y: number }, lngLat: { lng: number; lat: number }) => {
      if (Date.now() - lastLongpress < 800) return // touch long-press may also emit contextmenu
      lastLongpress = Date.now()
      const p = this.toPick('longpress', point, lngLat)
      if (p) this.onPick(p)
    }
    m.on('touchstart', (e: MapTouchEvent) => {
      cancel()
      if (e.points.length !== 1) return
      startPt = e.point
      const { point, lngLat } = e
      timer = setTimeout(() => {
        timer = null
        fireLongpress(point, lngLat)
      }, LONGPRESS_MS)
    })
    m.on('touchmove', (e: MapTouchEvent) => {
      if (!startPt || e.points.length !== 1 || Math.hypot(e.point.x - startPt.x, e.point.y - startPt.y) > LONGPRESS_SLOP_PX) cancel()
    })
    m.on('touchend', cancel)
    m.on('touchcancel', cancel)
    m.on('zoomstart', cancel)
    m.on('contextmenu', (e: MapMouseEvent) => {
      e.preventDefault()
      fireLongpress(e.point, e.lngLat)
    })
    m.on('click', (e: MapMouseEvent) => {
      if (Date.now() - lastLongpress < 800) return
      const p = this.toPick('tap', e.point, e.lngLat)
      if (p) this.onPick(p)
    })
  }
}
