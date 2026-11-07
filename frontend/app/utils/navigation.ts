type Coordinate = [number, number]
const METERS_PER_DEGREE = 111195

export function createRouteTracker(coordinates: number[][]) {
  const [lon, lat] = coordinates[0]!
  const lonScale = METERS_PER_DEGREE * Math.cos(lat! * Math.PI / 180)
  const project = ([x, y]: number[]) => [(x! - lon!) * lonScale, (y! - lat!) * METERS_PER_DEGREE] as Coordinate
  const points = coordinates.map(project)
  const cumulative = [0]
  for (let i = 1; i < points.length; i++) {
    const [ax, ay] = points[i - 1]!
    const [bx, by] = points[i]!
    cumulative.push(cumulative[i - 1]! + Math.hypot(bx - ax, by - ay))
  }

  function match(location: Coordinate, progress: number | null) {
    const [x, y] = project(location)
    let closest = { along: 0, distance: Infinity }
    for (let i = 1; i < points.length; i++) {
      const [ax, ay] = points[i - 1]!
      const [bx, by] = points[i]!
      const dx = bx - ax
      const dy = by - ay
      const length = cumulative[i]! - cumulative[i - 1]!
      if (!length) continue
      const fraction = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (length * length)))
      const along = cumulative[i - 1]! + length * fraction
      if (progress !== null && (along < progress - 35 || along > progress + 125)) continue
      const distance = Math.hypot(x - ax - dx * fraction, y - ay - dy * fraction)
      if (distance < closest.distance - (progress === null ? 6 : 1)) closest = { along, distance }
    }
    const [endX, endY] = points.at(-1)!
    return { ...closest, endDistance: Math.hypot(x - endX, y - endY) }
  }

  const total = cumulative.at(-1)!

  function pointAt(offset: number) {
    if (offset <= 0) return coordinates[0]!
    if (offset >= total) return coordinates.at(-1)!
    const end = cumulative.findIndex(distance => distance >= offset)
    const start = end - 1
    const ratio = (offset - cumulative[start]!) / (cumulative[end]! - cumulative[start]!)
    const [ax, ay] = coordinates[start]!
    const [bx, by] = coordinates[end]!
    return [ax! + (bx! - ax!) * ratio, ay! + (by! - ay!) * ratio]
  }

  function slice(from: number, to: number) {
    const start = Math.max(0, from)
    const end = Math.min(total, to)
    if (end <= start) return []
    const between = coordinates.filter((_, i) => cumulative[i]! > start && cumulative[i]! < end)
    return [pointAt(start), ...between, pointAt(end)]
  }

  return { cumulative, total, match, slice }
}
