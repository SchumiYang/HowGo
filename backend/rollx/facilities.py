import math
import os
import sqlite3
from contextlib import closing, contextmanager
from pathlib import Path

FACILITY_TYPES = {
    "1": "斜坡道", "3": "無障礙電梯", "4": "公園",
    "7": "捷運站及公園無障礙出入口", "8": "友善店家", "9": "無障礙廁所",
    "14": "身障設施", "15": "路邊停車場", "16": "路邊停車格",
    "18": "公車站", "20": "捷運站", "accessible-parking": "身心障礙停車格",
}
ROUTE_FACILITY_TYPES = ("1", "7", "9")
COVERAGE = (121.42, 24.94, 121.68, 25.23)
RADIUS_METERS = 20
METERS_PER_DEGREE = math.pi * 6_371_008.8 / 180
DEFAULT_DB_PATH = Path(__file__).resolve().parent.parent / "data" / "facilities.sqlite"


def db_path():
    return Path(os.environ.get("ROLLX_DB_PATH", DEFAULT_DB_PATH)).resolve()


@contextmanager
def read_database():
    with closing(sqlite3.connect(f"{db_path().as_uri()}?mode=ro", uri=True)) as conn:
        conn.row_factory = sqlite3.Row
        yield conn


def query_facilities(conn, bounds, types, limit=None, *, sloped_only=False):
    if sloped_only and not any(row[1] == "slope" for row in conn.execute("PRAGMA table_info(facilities)")):
        return []
    west, south, east, north = bounds
    query = f"""
        SELECT f.*
        FROM facility_index AS i JOIN facilities AS f ON f.rowid = i.id
        WHERE i.east >= ? AND i.west <= ? AND i.north >= ? AND i.south <= ?
          AND f.lon BETWEEN ? AND ? AND f.lat BETWEEN ? AND ?
          AND f.kind IN ({",".join("?" for _ in types)})
          {"AND f.slope > 0" if sloped_only else ""}
        ORDER BY f.id
    """
    params = [west, east, south, north, west, east, south, north, *types]
    if limit is not None:
        query += " LIMIT ?"
        params.append(limit)
    return conn.execute(query, params).fetchall()


def measurement(record, key):
    try:
        value = float(record.get(key))
    except (TypeError, ValueError):
        return None
    return value if math.isfinite(value) and value >= 0 else None


def feature(row, distance=None):
    properties = {
        "kind": row["kind"],
        "label": FACILITY_TYPES[row["kind"]],
        "name": row["name"],
    }
    for key in ("width", "slope"):
        if key in row.keys() and row[key] is not None:
            properties[key] = row[key]
    if row["kind"] == "accessible-parking":
        properties["source"] = "臺北市停車管理工程處"
    if distance is not None:
        properties["distance_m"] = round(distance, 1)
    return {
        "type": "Feature",
        "id": row["id"],
        "geometry": {"type": "Point", "coordinates": [row["lon"], row["lat"]]},
        "properties": properties,
    }


def distance_to_segment(point, start, end):
    dx, dy = end[0] - start[0], end[1] - start[1]
    length_squared = dx * dx + dy * dy
    if not length_squared:
        return math.dist(point, start)
    along = ((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) / length_squared
    along = max(0, min(1, along))
    return math.dist(point, (start[0] + along * dx, start[1] + along * dy))


def route_facilities(conn, coordinates):
    origin_lon, origin_lat = coordinates[0][:2]
    lon_scale = METERS_PER_DEGREE * math.cos(math.radians(origin_lat))

    def project(lon, lat, *_):
        return ((lon - origin_lon) * lon_scale, (lat - origin_lat) * METERS_PER_DEGREE)

    lon_padding = RADIUS_METERS / lon_scale
    lat_padding = RADIUS_METERS / METERS_PER_DEGREE
    matches = {}

    # Query each segment's small bounding box instead of scanning the entire route envelope.
    for start, end in zip(coordinates, coordinates[1:]):
        bounds = (
            min(start[0], end[0]) - lon_padding,
            min(start[1], end[1]) - lat_padding,
            max(start[0], end[0]) + lon_padding,
            max(start[1], end[1]) + lat_padding,
        )
        projected_start, projected_end = project(*start), project(*end)
        for row in query_facilities(conn, bounds, ROUTE_FACILITY_TYPES):
            distance = distance_to_segment(project(row["lon"], row["lat"]), projected_start, projected_end)
            previous = matches.get(row["id"])
            if distance <= RADIUS_METERS and (previous is None or distance < previous[0]):
                matches[row["id"]] = (distance, row)
    return [feature(row, distance) for distance, row in sorted(matches.values(), key=lambda match: match[0])]
