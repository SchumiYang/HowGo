import gzip
import json
from itertools import chain

WALKWAY_TYPES = {
    "11": "人行道", "12": "標線型人行道", "13": "行穿線", "arcade": "騎樓整平路段",
}

WALKWAY_SCHEMA = """
CREATE TABLE walkways (
    id TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, name TEXT NOT NULL, geometry TEXT NOT NULL, width REAL, slope REAL
);
CREATE VIRTUAL TABLE walkway_index USING rtree(id, west, east, south, north);
"""


def load_walkways(path):
    if not path.exists():
        return []
    with gzip.open(path, "rt", encoding="utf-8") as file:
        data = json.load(file)
    if data["type"] != "FeatureCollection":
        raise ValueError("通行空間快照應為 GeoJSON FeatureCollection")
    rows = []
    for feature in data["features"]:
        geometry = feature["geometry"]
        if geometry["type"] not in ("Polygon", "MultiPolygon"):
            raise ValueError("通行空間圖層需要面圖資")
        props = feature["properties"]
        if props["kind"] not in WALKWAY_TYPES:
            raise ValueError("通行空間快照含未知類別")
        polygons = geometry["coordinates"] if geometry["type"] == "MultiPolygon" else [geometry["coordinates"]]
        points = list(chain.from_iterable(chain.from_iterable(polygons)))
        lons, lats = zip(*points)
        rows.append((
            feature["id"], props["kind"], props["name"],
            json.dumps(geometry, separators=(",", ":")), props.get("width"), props.get("slope"),
            min(lons), max(lons), min(lats), max(lats),
        ))
    return rows


def write_walkways(conn, rows):
    for row in rows:
        cursor = conn.execute("INSERT INTO walkways VALUES (?, ?, ?, ?, ?, ?)", row[:6])
        conn.execute("INSERT INTO walkway_index VALUES (?, ?, ?, ?, ?)", (cursor.lastrowid, *row[6:]))


def query_walkways(conn, bounds, kinds, limit, *, sloped_only=False):
    if not conn.execute("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'walkways'").fetchone():
        return [], False
    if sloped_only and not any(row[1] == "slope" for row in conn.execute("PRAGMA table_info(walkways)")):
        return [], False
    west, south, east, north = bounds
    features = []
    truncated = False
    for kind in kinds:
        rows = conn.execute(f"""
            SELECT w.*
            FROM walkway_index AS i JOIN walkways AS w ON w.rowid = i.id
            WHERE i.east >= ? AND i.west <= ? AND i.north >= ? AND i.south <= ?
              AND w.kind = ?
              {"AND w.slope > 0" if sloped_only else ""}
            ORDER BY w.id
            LIMIT ?
        """, (west, east, south, north, kind, limit + 1 if limit is not None else -1)).fetchall()
        truncated |= limit is not None and len(rows) > limit
        for row in rows[:limit]:
            properties = {"kind": kind, "label": WALKWAY_TYPES[kind], "name": row["name"]}
            for key in ("width", "slope"):
                if key in row.keys() and row[key] is not None:
                    properties[key] = row[key]
            features.append({
                "type": "Feature",
                "id": row["id"],
                "geometry": json.loads(row["geometry"]),
                "properties": properties,
            })
    return features, truncated
