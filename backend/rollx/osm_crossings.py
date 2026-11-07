import gzip
import json
from argparse import ArgumentParser
from functools import lru_cache
from pathlib import Path

from shapely import LineString, STRtree, box, transform


SNAPSHOT = Path(__file__).resolve().parents[1] / "data" / "source" / "osm-crossings.json.gz"


@lru_cache(maxsize=1)
def crossing_index():
    try:
        with gzip.open(SNAPSHOT, "rt", encoding="utf-8") as source:
            return STRtree([LineString(points) for points in json.load(source)])
    except FileNotFoundError:
        return STRtree([])


def nearby_crossings(bounds, project):
    index = crossing_index()
    for match in index.query(box(*bounds)):
        yield transform(index.geometries[match], project, interleaved=False)


def crossing_features(bounds, limit):
    index = crossing_index()
    matches = sorted(index.query(box(*bounds), predicate="intersects"))
    return [{
        "type": "Feature",
        "id": f"osm-crossing-{match}",
        "geometry": {"type": "LineString", "coordinates": list(index.geometries[match].coords)},
        "properties": {"kind": "osm-crossing", "label": "行人穿越道", "name": "", "source": "OpenStreetMap"},
    } for match in matches[:limit]], len(matches) > limit


def export_crossings(pbf, output):
    import osmium

    crossings = []
    for way in osmium.FileProcessor(pbf, osmium.osm.NODE | osmium.osm.WAY).with_locations():
        if not way.is_way():
            continue
        tags = way.tags
        if tags.get("highway") not in ("footway", "path") or tags.get("footway") != "crossing":
            continue
        if tags.get("crossing") == "no" or not all(node.location.valid() for node in way.nodes):
            continue
        points = [(round(node.lon, 7), round(node.lat, 7)) for node in way.nodes]
        if len(set(points)) >= 2:
            crossings.append(points)
    with gzip.open(output, "wt", encoding="utf-8") as target:
        json.dump(crossings, target, separators=(",", ":"))
    print(f"Saved {len(crossings)} OSM crossing ways")


if __name__ == "__main__":
    parser = ArgumentParser(description="Export mapped crossing ways from the local ORS PBF")
    parser.add_argument("pbf")
    parser.add_argument("--output", type=Path, default=SNAPSHOT)
    args = parser.parse_args()
    export_crossings(args.pbf, args.output)
