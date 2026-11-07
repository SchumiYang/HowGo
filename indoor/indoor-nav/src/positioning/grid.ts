/**
 * Occupancy grid (default 0.25 m) for the particle filter's map constraint.
 *
 * free = cells inside walkable units, minus cells touched by blocking wall linework ('wall', 'column'), plus
 * capsules carved along nav edges (corridor / door / ramp). The CAD linework closes many real openings (glass
 * doors, door leaves drawn as wall), so the nav graph is the authority on where people can pass.
 * Moves are checked with an exact cell traversal (Amanatides–Woo), so a step can never jump over a wall.
 */
import type { NavFeature, UnitFeature, WallFeature } from '../data/types'
import type { XY } from '../geo/frame'

export const DEFAULT_WALKABLE = [
  'corridor', 'lobby', 'walkway', 'restroom.male', 'restroom.female', 'restroom.accessible', 'restroom.unisex',
  'elevator', 'first_aid',
  'court', // the arena floor hosts events (tianmu: CodeFest), so people walk there
]

export interface GridOptions {
  cell: number
  walkable: string[]
  /** enclosed units that block cells even where a walkable polygon overlaps them (1F: room A101 lies inside the
   *  west corridor polygon, leaving a 0.5 m drawing artifact between its wall and the arena wall); nav edges still
   *  carve their doorways */
  blockingCategories: string[]
  blockingLayers: string[]
  carveEdgeTypes: string[]
  carveRadius: number
  /** doors get a wider capsule: a cloud with ~1 m lateral spread must fit through */
  doorCarveRadius: number
  margin: number
}

export const DEFAULT_GRID: GridOptions = {
  cell: 0.25,
  walkable: DEFAULT_WALKABLE,
  blockingCategories: ['room', 'office', 'shop', 'nonpublic'],
  blockingLayers: ['wall', 'column'],
  carveEdgeTypes: ['corridor', 'door', 'ramp'],
  carveRadius: 0.6,
  doorCarveRadius: 1.0,
  margin: 1,
}

export interface GridSource {
  level: string
  units: UnitFeature[]
  walls: WallFeature[]
  nav?: NavFeature[]
}

export class OccupancyGrid {
  readonly x0: number
  readonly y0: number
  readonly cell: number
  readonly w: number
  readonly h: number
  /** 1 = free, row-major [j * w + i], j along +y */
  readonly free: Uint8Array

  constructor(x0: number, y0: number, cell: number, w: number, h: number) {
    this.x0 = x0
    this.y0 = y0
    this.cell = cell
    this.w = w
    this.h = h
    this.free = new Uint8Array(w * h)
  }

  static build(src: GridSource, opts: Partial<GridOptions> = {}): OccupancyGrid {
    const o = { ...DEFAULT_GRID, ...opts }
    const walkable = new Set(o.walkable)
    const polys: XY[][][] = []
    for (const u of src.units) {
      if (!walkable.has(u.properties.category)) continue
      if (u.geometry.type === 'Polygon') polys.push(u.geometry.coordinates)
      else polys.push(...u.geometry.coordinates)
    }
    const nodes = new Map<string, XY>()
    for (const f of src.nav ?? []) {
      if (f.properties.kind === 'node' && f.properties.level === src.level) nodes.set(f.properties.id, f.geometry.coordinates as XY)
    }
    const carve: [XY, XY, number][] = []
    for (const f of src.nav ?? []) {
      const p = f.properties
      if (p.kind !== 'edge' || !o.carveEdgeTypes.includes(p.type)) continue
      const a = nodes.get(p.from)
      const b = nodes.get(p.to)
      if (a && b) carve.push([a, b, p.type === 'door' ? o.doorCarveRadius : o.carveRadius])
    }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    const ext = ([x, y]: XY) => {
      minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y)
    }
    polys.forEach((p) => p[0].forEach(ext))
    carve.forEach(([a, b]) => (ext(a), ext(b)))
    if (!Number.isFinite(minX)) throw new Error(`positioning: no walkable units on level ${src.level}`)
    const m = o.margin + Math.max(o.carveRadius, o.doorCarveRadius)
    const x0 = Math.floor((minX - m) / o.cell) * o.cell
    const y0 = Math.floor((minY - m) / o.cell) * o.cell
    const g = new OccupancyGrid(x0, y0, o.cell, Math.ceil((maxX + m - x0) / o.cell), Math.ceil((maxY + m - y0) / o.cell))

    for (const rings of polys) g.fillPolygon(rings)
    const blockingUnits = new Set(o.blockingCategories)
    for (const u of src.units) {
      if (!blockingUnits.has(u.properties.category)) continue
      for (const rings of u.geometry.type === 'Polygon' ? [u.geometry.coordinates] : u.geometry.coordinates) g.fillPolygon(rings, 0)
    }
    const blocking = new Set(o.blockingLayers)
    for (const wl of src.walls) {
      if (!blocking.has(wl.properties.layer)) continue
      const c = wl.geometry.coordinates
      for (let k = 1; k < c.length; k++) {
        g.traverse(c[k - 1][0], c[k - 1][1], c[k][0], c[k][1], (i, j) => {
          if (i >= 0 && j >= 0 && i < g.w && j < g.h) g.free[j * g.w + i] = 0
          return true
        })
      }
    }
    for (const [a, b, r] of carve) g.carveCapsule(a, b, r)
    return g
  }

  /** scanline fill at cell centres (even–odd over all rings) */
  private fillPolygon(rings: XY[][], value = 1) {
    const xs: number[] = []
    for (let j = 0; j < this.h; j++) {
      const yc = this.y0 + (j + 0.5) * this.cell
      xs.length = 0
      for (const ring of rings) {
        for (let k = 0, l = ring.length - 1; k < ring.length; l = k++) {
          const [xa, ya] = ring[l]
          const [xb, yb] = ring[k]
          if ((ya > yc) !== (yb > yc)) xs.push(xa + ((yc - ya) / (yb - ya)) * (xb - xa))
        }
      }
      xs.sort((a, b) => a - b)
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const i0 = Math.max(0, Math.ceil((xs[k] - this.x0) / this.cell - 0.5))
        const i1 = Math.min(this.w - 1, Math.floor((xs[k + 1] - this.x0) / this.cell - 0.5))
        for (let i = i0; i <= i1; i++) this.free[j * this.w + i] = value
      }
    }
  }

  private carveCapsule(a: XY, b: XY, r: number) {
    const i0 = Math.max(0, Math.floor((Math.min(a[0], b[0]) - r - this.x0) / this.cell))
    const i1 = Math.min(this.w - 1, Math.ceil((Math.max(a[0], b[0]) + r - this.x0) / this.cell))
    const j0 = Math.max(0, Math.floor((Math.min(a[1], b[1]) - r - this.y0) / this.cell))
    const j1 = Math.min(this.h - 1, Math.ceil((Math.max(a[1], b[1]) + r - this.y0) / this.cell))
    const dx = b[0] - a[0]
    const dy = b[1] - a[1]
    const l2 = dx * dx + dy * dy || 1e-9
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const px = this.x0 + (i + 0.5) * this.cell
        const py = this.y0 + (j + 0.5) * this.cell
        const t = Math.max(0, Math.min(1, ((px - a[0]) * dx + (py - a[1]) * dy) / l2))
        if (Math.hypot(px - a[0] - t * dx, py - a[1] - t * dy) <= r) this.free[j * this.w + i] = 1
      }
    }
  }

  isFree(x: number, y: number): boolean {
    const i = Math.floor((x - this.x0) / this.cell)
    const j = Math.floor((y - this.y0) / this.cell)
    return i >= 0 && j >= 0 && i < this.w && j < this.h && this.free[j * this.w + i] === 1
  }

  /** Visit every cell the segment passes through (4-connected), in order; stops when visit returns false. */
  traverse(ax: number, ay: number, bx: number, by: number, visit: (i: number, j: number) => boolean): boolean {
    const gx = (ax - this.x0) / this.cell
    const gy = (ay - this.y0) / this.cell
    const ex = (bx - this.x0) / this.cell
    const ey = (by - this.y0) / this.cell
    let i = Math.floor(gx)
    let j = Math.floor(gy)
    const dx = ex - gx
    const dy = ey - gy
    const si = dx > 0 ? 1 : -1
    const sj = dy > 0 ? 1 : -1
    const tdx = dx !== 0 ? Math.abs(1 / dx) : Infinity
    const tdy = dy !== 0 ? Math.abs(1 / dy) : Infinity
    let tmx = dx !== 0 ? (dx > 0 ? i + 1 - gx : gx - i) * tdx : Infinity
    let tmy = dy !== 0 ? (dy > 0 ? j + 1 - gy : gy - j) * tdy : Infinity
    if (!visit(i, j)) return false
    let n = Math.abs(Math.floor(ex) - i) + Math.abs(Math.floor(ey) - j)
    while (n-- > 0) {
      if (tmx < tmy) {
        tmx += tdx
        i += si
      } else {
        tmy += tdy
        j += sj
      }
      if (!visit(i, j)) return false
    }
    return true
  }

  /** true if every cell on the segment is free */
  segmentFree(ax: number, ay: number, bx: number, by: number): boolean {
    const { w, h, free } = this
    return this.traverse(ax, ay, bx, by, (i, j) => i >= 0 && j >= 0 && i < w && j < h && free[j * w + i] === 1)
  }

  get freeCount(): number {
    let n = 0
    for (let k = 0; k < this.free.length; k++) n += this.free[k]
    return n
  }
}
