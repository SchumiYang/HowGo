from functools import cached_property
from math import cos, dist, radians

from shapely import LineString, Point, STRtree, transform, union_all
from shapely.geometry import shape

from .facilities import METERS_PER_DEGREE
from .osm_crossings import nearby_crossings
from .walkways import query_walkways


class RouteEvidence:
    def __init__(self, conn, coordinates):
        lon, lat = coordinates[0]
        lon_scale = METERS_PER_DEGREE * cos(radians(lat))
        lons, lats = zip(*coordinates)
        bounds = min(lons) - 0.0001, min(lats) - 0.0001, max(lons) + 0.0001, max(lats) + 0.0001
        features, _ = query_walkways(conn, bounds, ("11", "13"), limit=None)

        def project(x, y):
            return (x - lon) * lon_scale, (y - lat) * METERS_PER_DEGREE

        self.project = project
        self.unproject = lambda x, y: (x / lon_scale + lon, y / METERS_PER_DEGREE + lat)
        self.points = [project(*point) for point in coordinates]
        self.path = LineString(self.points)
        self.osm_crossings = list(nearby_crossings(bounds, project))
        self.sidewalks = []
        nearby_sidewalks = []
        self.sidewalk_widths = []
        crossings = []
        for feature in features:
            polygon = transform(shape(feature["geometry"]), project, interleaved=False)
            if not polygon.is_valid:
                continue
            if feature["properties"]["kind"] == "11":
                nearby_sidewalks.append(polygon)
                self.sidewalk_widths.append(feature["properties"].get("width"))
                if polygon.intersects(self.path):
                    self.sidewalks.append(polygon)
            elif polygon.intersects(self.path):
                crossings.append(polygon)
        self.sidewalk_index = STRtree(nearby_sidewalks)
        self.crossings = STRtree(crossings)

    def osm_crossing_positions(self):
        # Compare the actual routed edges with mapped crossing lines. A touch at a
        # junction or a nearby parallel sidewalk alone does not establish a crossing.
        buffers = STRtree([line.buffer(1, cap_style="flat") for line in self.osm_crossings])
        spans = {}
        offset = 0.0
        for a, b in zip(self.points, self.points[1:]):
            edge = LineString((a, b))
            if not edge.length:
                continue
            for index in buffers.query(edge, predicate="intersects"):
                line = self.osm_crossings[index]
                clipped = edge.intersection(buffers.geometries[index])
                runs = spans.setdefault(index, [])
                for part in getattr(clipped, "geoms", [clipped]):
                    if part.geom_type != "LineString" or part.length == 0:
                        continue
                    points = [Point(part.coords[0]), Point(part.coords[-1])]
                    if abs(line.project(points[0]) - line.project(points[1])) < 0.8 * part.length:
                        continue
                    start, end = sorted(offset + edge.project(point) for point in points)
                    if runs and abs(start - runs[-1][1]) <= 0.25:
                        runs[-1] = runs[-1][0], end
                    else:
                        runs.append((start, end))
            offset += edge.length
        return [(start, end) for runs in spans.values() for start, end in runs if end - start >= 4]

    @cached_property
    def crossing_positions(self):
        path = self.path
        positions = self.osm_crossing_positions()
        for index in self.crossings.query(path, predicate="intersects"):
            polygon = self.crossings.geometries[index]
            clipped = path.intersection(polygon)
            parts = list(clipped.geoms) if hasattr(clipped, "geoms") else [clipped]
            for part in parts:
                if part.geom_type != "LineString" or part.length < 4:
                    continue
                # Mere contact with the outline does not establish a crossing.
                if not polygon.contains(part.interpolate(0.5, normalized=True)):
                    continue
                a = path.project(Point(part.coords[0]))
                b = path.project(Point(part.coords[-1]))
                start, end = sorted((a, b))
                if end - start < 4 or start < 0.5 or path.length - end < 0.5:
                    continue
                if polygon.covers(path.interpolate(start - 0.5)) or polygon.covers(path.interpolate(end + 0.5)):
                    continue
                positions.append((start, end))
        merged = []
        for start, end in sorted(positions):
            if merged and start < merged[-1][1] - 0.5:
                merged[-1] = merged[-1][0], max(end, merged[-1][1])
            else:
                merged.append((start, end))
        return merged

    def metrics(self, facilities):
        sidewalk = self.path.intersection(union_all(self.sidewalks)).length if self.sidewalks else 0
        return {
            "sidewalk": round(sidewalk / max(self.path.length, 1), 3),
            "ramp": sum(item["properties"]["kind"] == "1" and item["properties"]["distance_m"] <= 4
                        for item in facilities),
            "crossing": len(self.crossing_positions),
        }

    def add_crossings(self, steps):
        lengths = [0.0]
        for a, b in zip(self.points, self.points[1:]):
            lengths.append(lengths[-1] + dist(a, b))
        for a, b in self.crossing_positions:
            for step in steps:
                start, end = lengths[step["from_index"]], lengths[step["to_index"]]
                first, last = max(a, start), min(b, end)
                if first < last:
                    step.setdefault("crossings", []).append({"at_m": round(first - start), "end_m": round(last - start)})


def preference_cost(distance, shortest, metrics, preferences):
    if not preferences:
        return distance
    per_km = 1000 / max(150, distance)
    quality = {
        "sidewalk": metrics["sidewalk"],
        "ramp": min(1, metrics["ramp"] * per_km / 12),
        "crossing": min(1, metrics["crossing"] * per_km / 5),
    }
    return distance / shortest - 0.45 * sum(quality[key] for key in preferences) / len(preferences)
