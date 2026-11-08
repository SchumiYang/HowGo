/** Types mirroring mapdata/SCHEMA.md (v0). Coordinates are local metres unless noted. */
import type { XY } from '../geo/frame'

export interface Level {
  id: string
  ordinal: number
  name: string
  elevation_m?: number
}

export interface Venue {
  id: string
  name: string
  name_en?: string
  origin: { lng: number; lat: number }
  bearing_deg: number
  levels: Level[]
  default_level?: string
}

export type WallLayer = 'wall' | 'column' | 'stairs' | 'fixture' | 'court' | 'door' | 'other'

export type UnitCategory =
  | 'room' | 'office' | 'shop'
  | 'restroom.male' | 'restroom.female' | 'restroom.accessible' | 'restroom.unisex'
  | 'stairs' | 'elevator' | 'corridor' | 'lobby' | 'court' | 'seating'
  | 'first_aid' | 'nonpublic' | 'walkway' | 'opening'

export type PoiCategory =
  | 'toilet.male' | 'toilet.female' | 'toilet.accessible'
  | 'elevator' | 'stairs' | 'entrance' | 'exit' | 'emergency_exit'
  | 'first_aid' | 'aed' | 'info' | 'qr_anchor'

export type EdgeType = 'corridor' | 'door' | 'stairs' | 'elevator' | 'ramp'

// ---- minimal GeoJSON (local metres) ----
export interface Feature<G, P> {
  type: 'Feature'
  id?: string | number
  geometry: G
  properties: P
}
export interface FeatureCollection<G, P> {
  type: 'FeatureCollection'
  features: Feature<G, P>[]
}
export interface PointGeom { type: 'Point'; coordinates: XY }
export interface LineGeom { type: 'LineString'; coordinates: XY[] }
export interface PolygonGeom { type: 'Polygon'; coordinates: XY[][] }
export interface MultiPolygonGeom { type: 'MultiPolygon'; coordinates: XY[][][] }

export interface WallProps { layer: WallLayer; level?: string }
export interface UnitProps {
  id: string
  level: string
  category: UnitCategory | string
  ref?: string | null
  name?: string | null
  name_en?: string | null
  accessible?: boolean | null
}
export interface PoiProps {
  id: string
  level: string
  category: PoiCategory | string
  name?: string | null
  name_en?: string | null
  unit_id?: string | null
  nav_node?: string | null
}
export interface NavNodeProps { kind: 'node'; id: string; level: string }
export interface NavEdgeProps {
  kind: 'edge'
  from: string
  to: string
  type: EdgeType | string
  accessible: boolean
  length_m: number
}

export type WallFeature = Feature<LineGeom, WallProps>
/** seating3d.geojson: stepped stands with PER-FEATURE heights (tiers rise away from the court; parapet at the edge) */
export type Seating3DFeature = Feature<PolygonGeom | MultiPolygonGeom, {
  kind: 'tier' | 'parapet' | string
  section?: string
  row?: number
  height_m: number
  base_m?: number
  level?: string
}>
/** walls3d.geojson: pre-built 0.2 m wall slabs + column squares, extruded to one uniform height */
export type Wall3DFeature = Feature<PolygonGeom | MultiPolygonGeom, { layer: 'wall' | 'column' | string; level?: string }>
export type UnitFeature = Feature<PolygonGeom | MultiPolygonGeom, UnitProps>
export type PoiFeature = Feature<PointGeom, PoiProps>
export type NavFeature = Feature<PointGeom, NavNodeProps> | Feature<LineGeom, NavEdgeProps>

export interface LevelData {
  level: Level
  walls: WallFeature[]
  /** false until the level's walls were fetched (only the initial level is loaded eagerly) */
  wallsLoaded: boolean
  /** extrusion slabs for the 2.5D map; empty when the level has no walls3d.geojson */
  walls3d: Wall3DFeature[]
  /** stepped stands for the 2.5D map (optional file; loaded with the walls) */
  seating3d?: Seating3DFeature[]
  units: UnitFeature[]
  pois: PoiFeature[]
}

export interface VenueData {
  venue: Venue
  /** sorted by ordinal ascending */
  levels: LevelData[]
  nav: NavFeature[]
  /** which optional files were found, for UI degradation + debug */
  available: { walls: boolean; walls3d: boolean; units: boolean; pois: boolean; nav: boolean }
}
