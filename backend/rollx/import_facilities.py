import argparse
import hashlib
import json
import sqlite3
import tempfile
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path

from .facilities import DEFAULT_DB_PATH, FACILITY_TYPES, ROUTE_FACILITY_TYPES, db_path, measurement, read_database

from .walkways import WALKWAY_SCHEMA, load_walkways, write_walkways

DEFAULT_SOURCE_DIR = DEFAULT_DB_PATH.parent / "source"
DATASET_URL = "https://data.taipei/dataset/detail?id=2b58f15a-dec6-4b9d-91be-4eaccfda5ae7"

SCHEMA = """
CREATE TABLE facilities (
    id TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, name TEXT NOT NULL,
    lon REAL NOT NULL, lat REAL NOT NULL, width REAL, slope REAL
);
CREATE VIRTUAL TABLE facility_index USING rtree(id, west, east, south, north);
CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
"""


def clean(kind, records):
    if not isinstance(records, list):
        raise ValueError(f"{kind} 類資料應為 JSON 陣列")
    west, south, east, north = 121.35, 24.86, 121.75, 25.31
    facilities = {}
    for record in records:
        if not isinstance(record, dict) or str(record.get("kind")) != kind:
            continue
        try:
            lon, lat = float(record["lon"]), float(record["lat"])
        except (KeyError, TypeError, ValueError):
            continue
        if west <= lat <= east and south <= lon <= north:
            lon, lat = lat, lon
        if not (west <= lon <= east and south <= lat <= north):
            continue
        source_name = record.get("kname")
        name = (source_name.strip() if isinstance(source_name, str) else "") or FACILITY_TYPES[kind]
        # The API provides no stable ID for these categories.
        digest = hashlib.sha256(f"{kind}|{name}|{lon:.6f}|{lat:.6f}".encode()).hexdigest()[:24]
        facility_id = f"{kind}-{digest}"
        width, slope = measurement(record, "width"), measurement(record, "slope")
        if kind == "1" and (width, slope) == (0, 0):
            width, slope = None, None
        facilities[facility_id] = (facility_id, kind, name, lon, lat, width, slope)
    if not facilities:
        raise ValueError(f"{kind} 類沒有有效資料，保留上一版快照")
    return list(facilities.values())


def publish_snapshot(source_dir=DEFAULT_SOURCE_DIR):
    target = db_path()
    target.parent.mkdir(parents=True, exist_ok=True)
    imported_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
    rows = []
    empty_types = []
    for kind, label in FACILITY_TYPES.items():
        source_file = source_dir / f"facility-{kind}.json"
        if not source_file.exists() and kind not in ROUTE_FACILITY_TYPES:
            if target.exists():
                with read_database() as conn:
                    if conn.execute("SELECT 1 FROM facilities WHERE kind = ? LIMIT 1", (kind,)).fetchone():
                        raise ValueError(f"缺少 {label} 快照，保留上一版 SQLite")
            empty_types.append(kind)
            continue
        records = json.loads(source_file.read_text(encoding="utf-8-sig"))
        if records == []:
            if target.exists():
                with read_database() as conn:
                    if conn.execute("SELECT 1 FROM facilities WHERE kind = ? LIMIT 1", (kind,)).fetchone():
                        raise ValueError(f"快照沒有 {label} 資料，保留上一版 SQLite")
            empty_types.append(kind)
            print(f"{label}：快照未提供點位")
            continue
        cleaned = clean(kind, records)
        rows.extend(cleaned)
        print(f"{label}：保留 {len(cleaned)} / {len(records)} 筆")
    walkway_rows = load_walkways(source_dir / "walkways.geojson.gz")
    version = hashlib.sha256(json.dumps(sorted(rows), ensure_ascii=False).encode())
    for row in walkway_rows:
        version.update(json.dumps(row, ensure_ascii=False).encode())
    metadata = {
        "source": "輪行臺北設施資料",
        "source_url": DATASET_URL,
        "version": version.hexdigest()[:16],
        "imported_at": imported_at,
        "empty_types": ",".join(empty_types),
    }

    # Build the full snapshot in the same directory, then replace it atomically.
    with tempfile.TemporaryDirectory(dir=target.parent) as temp_dir:
        snapshot = Path(temp_dir) / "facilities.sqlite"
        with closing(sqlite3.connect(snapshot)) as conn, conn:
            conn.executescript(SCHEMA + WALKWAY_SCHEMA)
            conn.executemany("INSERT INTO facilities VALUES (?, ?, ?, ?, ?, ?, ?)", rows)
            conn.execute("INSERT INTO facility_index SELECT rowid, lon, lon, lat, lat FROM facilities")
            write_walkways(conn, walkway_rows)
            conn.executemany("INSERT INTO metadata VALUES (?, ?)", metadata.items())
        snapshot.replace(target)
    print(f"已發布 {len(rows)} 筆設施點與 {len(walkway_rows)} 筆通行空間至 {target}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="從本機 JSON 重建輪行臺北設施 SQLite 快照")
    parser.add_argument(
        "--source-dir", type=Path, default=DEFAULT_SOURCE_DIR,
        help="JSON 快照所在資料夾，預設 backend/data/source",
    )
    args = parser.parse_args()
    try:
        publish_snapshot(args.source_dir)
    except (OSError, KeyError, TypeError, ValueError, sqlite3.Error) as error:
        parser.exit(1, f"匯入失敗：{error}\n")
