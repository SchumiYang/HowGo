import gzip
import json
import re
from functools import lru_cache
from pathlib import Path

from shapely import LineString, Point, STRtree, box, transform
from shapely.geometry import shape

from .facilities import FACILITY_TYPES, feature, query_facilities
from .walkways import WALKWAY_TYPES, query_walkways


SNAPSHOT = Path(__file__).resolve().parents[1] / "data" / "source" / "osm-slopes.json.gz"
INCLINE_NUMBER = re.compile(r"([+-]?\d+(?:\.\d+)?)\s*(%|°)?")
# Match the same walkway without treating the whole street as a barrier.
POINT_TOLERANCE_M = 1.5
LINE_TOLERANCE_M = 0.8


@lru_cache(maxsize=1)
def osm_slope_index():
    try:
        with gzip.open(SNAPSHOT, "rt", encoding="utf-8") as source:
            entries = json.load(source)
    except FileNotFoundError:
        entries = []
    return entries, STRtree([LineString(coordinates) for _, _, coordinates in entries])


def slope_features(conn, bounds):
    for row in query_facilities(conn, bounds, FACILITY_TYPES, sloped_only=True):
        item = feature(row)
        item["properties"]["source"] = "臺北市交通局"
        yield item
    polygons, _ = query_walkways(conn, bounds, WALKWAY_TYPES, limit=None, sloped_only=True)
    yield from polygons
    entries, index = osm_slope_index()
    for i in index.query(box(*bounds), predicate="intersects"):
        way_id, incline, coordinates = entries[i]
        properties = {"kind": "slope", "label": "坡段", "source": "OpenStreetMap"}
        match = INCLINE_NUMBER.fullmatch(incline)
        if match and match[2] != "°":
            properties["slope"] = abs(float(match[1]))
        else:
            properties["incline"] = incline
        yield {
            "type": "Feature", "id": f"osm-slope-{way_id}",
            "geometry": {"type": "LineString", "coordinates": coordinates},
            "properties": properties,
        }


def slope_barriers(conn, coordinates, evidence):
    lons, lats = zip(*coordinates)
    bounds = min(lons) - .00004, min(lats) - .00004, max(lons) + .00004, max(lats) + .00004
    barriers = []
    for item in slope_features(conn, bounds):
        geometry = transform(shape(item["geometry"]), evidence.project, interleaved=False)
        if geometry.geom_type == "Point":
            if evidence.path.distance(geometry) <= POINT_TOLERANCE_M:
                barriers.append(geometry.buffer(POINT_TOLERANCE_M + .5, quad_segs=4))
        elif geometry.geom_type == "LineString":
            corridor = geometry.buffer(LINE_TOLERANCE_M, cap_style="flat")
            overlap = evidence.path.intersection(corridor)
            for part in getattr(overlap, "geoms", [overlap]):
                if part.geom_type != "LineString" or part.length < min(3, .7 * geometry.length):
                    continue
                a, b = Point(part.coords[0]), Point(part.coords[-1])
                if abs(geometry.project(a) - geometry.project(b)) >= .8 * part.length:
                    barriers.append(corridor.simplify(.15))
                    break
        elif geometry.is_valid and evidence.path.relate_pattern(geometry, "1********"):
            barriers.append(geometry)
    return [transform(item, evidence.unproject, interleaved=False) for item in barriers]


def export_osm_slopes(pbf):
    import osmium

    rows = []
    for way in osmium.FileProcessor(pbf, osmium.osm.NODE | osmium.osm.WAY).with_locations():
        if not way.is_way() or way.tags.get("highway") in (None, "steps", "construction", "proposed"):
            continue
        incline = way.tags.get("incline", "").strip().lower()
        number = INCLINE_NUMBER.fullmatch(incline)
        if not (incline in ("up", "down", "up/down", "steep", "yes") or (number and float(number[1]))):
            continue
        if not all(node.location.valid() for node in way.nodes):
            continue
        points = [(round(node.lon, 7), round(node.lat, 7)) for node in way.nodes]
        if len(set(points)) >= 2:
            rows.append((way.id, incline, points))
    with gzip.open(SNAPSHOT, "wt", encoding="utf-8") as target:
        json.dump(rows, target, separators=(",", ":"))
    print(f"Saved {len(rows)} OSM incline ways")


if __name__ == "__main__":
    from argparse import ArgumentParser
    parser = ArgumentParser(description="Export incline tags from the local ORS road network")
    parser.add_argument("pbf")
    export_osm_slopes(parser.parse_args().pbf)
