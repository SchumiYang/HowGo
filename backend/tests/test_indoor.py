import json
import math
import time
from urllib.parse import quote

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from rollx import indoor

VENUE = {
    "id": "tv", "name": "Test Venue", "origin": {"lng": 121.5, "lat": 25.1}, "bearing_deg": 0, "default_level": "1F",
    "levels": [{"id": "1F", "ordinal": 0, "name": "1F"}, {"id": "2F", "ordinal": 1, "name": "2F"}],
}


def fc(features, **extra):
    return {"type": "FeatureCollection", "features": features, **extra}


def square(x0, y0, x1, y1, **props):
    return {"type": "Feature", "geometry": {"type": "Polygon", "coordinates": [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]]},
            "properties": props}


def point(x, y, **props):
    return {"type": "Feature", "geometry": {"type": "Point", "coordinates": [x, y]}, "properties": props}


@pytest.fixture
def mapdata(tmp_path, monkeypatch):
    root = tmp_path / "mapdata"
    v = root / "data" / "tv"
    (v / "levels" / "1F").mkdir(parents=True)
    (v / "levels" / "2F").mkdir(parents=True)
    (v / "venue.json").write_text(json.dumps(VENUE), encoding="utf-8")
    (v / "nav.geojson").write_text(json.dumps(fc([point(0, 5, kind="node", id="1F-ent-main-out", level="1F")]), indent=1), encoding="utf-8")
    (v / "levels" / "1F" / "units.geojson").write_text(json.dumps(fc([square(0, 0, 100, 60, id="u1", category="corridor")]), indent=1), encoding="utf-8")
    (v / "levels" / "1F" / "pois.geojson").write_text(json.dumps(fc([point(1, 1, id="p1", category="elevator")]), indent=1), encoding="utf-8")
    (v / "levels" / "2F" / "seating3d.geojson").write_text(json.dumps(fc([])), encoding="utf-8")
    monkeypatch.setenv("HOWGO_INDOOR_MAPDATA", str(root))
    return root


@pytest.fixture
def client(mapdata):
    app = FastAPI()
    indoor.install(app)
    return TestClient(app)


def session(session_id="20261108-100000-a71", walks=(), points=()):
    return {"schema": "tpnav-survey/0", "session_id": session_id, "venue": "tv", "device": {"model": "SM-A716B"},
            "started_at": 1, "wifi_points": list(points), "walks": list(walks)}


def walk(t_start, walk_id="1F-walk-a", level="1F"):
    return {"walk_id": walk_id, "level": level, "direction": "forward", "path": [[0, 0], [10, 0]], "t_start": t_start,
            "t_end": t_start + 1000, "marks": [], "phone_pose": "flat",
            "sensors": {"accelerometer": [[t_start, 0.123456789, 0, 9.8]], "gyroscope": [], "magnetometer": [[t_start, 1, 2, 3]]},
            "wifi_scans": []}


# ---------- venues ----------

def test_venues_center_and_entrance(client):
    r = client.get("/v1/indoor/venues")
    assert r.status_code == 200
    [v] = r.json()
    assert v["id"] == "tv" and [lv["id"] for lv in v["levels"]] == ["1F", "2F"]
    lon, lat = v["center"]
    # footprint centre (50, 30) m east / north of the origin
    assert lon == pytest.approx(121.5 + math.degrees(50 / (6378137 * math.cos(math.radians(25.1)))), abs=1e-6)
    assert lat == pytest.approx(25.1 + math.degrees(30 / 6378137), abs=1e-6)
    assert v["entrance"]["node"] == "1F-ent-main-out"


# ---------- data ----------

def test_data_get_and_images(client, mapdata):
    assert client.get("/v1/indoor/data/tv/venue.json").json()["id"] == "tv"
    assert client.get("/v1/indoor/data/tv/levels/2F/seating3d.geojson").status_code == 200
    assert client.get("/v1/indoor/data/tv/levels/1F/walls.geojson").status_code == 404
    png = b"\x89PNG\r\n\x1a\nfake"
    r = client.post("/v1/indoor/floorplan/tv/1F", content=png, headers={"Content-Type": "image/png"})
    assert r.status_code == 200 and r.json()["url"] == "/api/v1/indoor/data/tv/levels/1F/floorplan.png"
    img = client.get("/v1/indoor/data/tv/levels/1F/floorplan.png")
    assert img.content == png and img.headers["content-type"] == "image/png"
    assert client.post("/v1/indoor/floorplan/tv/9F", content=png, headers={"Content-Type": "image/png"}).status_code == 404
    assert client.post("/v1/indoor/floorplan/tv/1F", content=png, headers={"Content-Type": "text/html"}).status_code == 415


@pytest.mark.parametrize("path", [
    "../venue.json", "levels/../venue.json", "levels/1F/../../x.geojson", "levels/1F/other.txt", "/etc/passwd",
    "levels\\1F\\units.geojson", "positioning/../venue.json", "survey/../../survey/raw/x.json", "levels/1F/sub/units.geojson",
    "venue.json\x00", "C:/Windows/win.ini",
])
def test_path_traversal_rejected(client, path):
    for method in ("get", "put"):
        # percent-encoded so the HTTP client doesn't normalise the dots away before the server sees them
        r = getattr(client, method)(f"/v1/indoor/data/tv/{quote(path, safe='')}", **({"json": {}} if method == "put" else {}))
        assert r.status_code in (403, 404), (method, path, r.status_code)
        assert r.json()["ok"] is False


def test_path_helpers():
    assert indoor.editable_path("tv", "levels/1F/pois.geojson")
    assert indoor.editable_path("tv", "levels/2F/seating3d.geojson") is None  # read-only layer
    assert indoor.readable_path("tv", "levels/2F/seating3d.geojson")
    assert indoor.editable_path("..", "venue.json") is None
    assert indoor.readable_path("tv", "positioning/..json") is None


def test_put_validation_history_and_source(client, mapdata):
    url = "/v1/indoor/data/tv/levels/1F/pois.geojson"
    pois = client.get(url).json()
    pois["features"].append(point(2, 2, id="p2", category="toilet.accessible", name="無障礙廁所"))
    r = client.put(url, json=pois)
    assert r.status_code == 200 and r.json()["ok"]
    saved = (mapdata / "data/tv/levels/1F/pois.geojson").read_text(encoding="utf-8")
    assert '"source": "admin"' in saved and "無障礙廁所" in saved and saved.startswith("{\n")
    assert list((mapdata / "history" / "tv").glob("*/levels/1F/pois.geojson"))
    # validation
    dup = fc([point(0, 0, id="a"), point(1, 1, id="a")])
    assert client.put(url, json=dup).json()["error"].startswith("duplicate id")
    assert client.put(url, json={"type": "Feature"}).status_code == 400
    assert client.put(url, content=b"{nope", headers={"Content-Type": "application/json"}).json()["error"] == "invalid JSON"
    assert client.put("/v1/indoor/data/tv/venue.json", json={"id": "tv"}).status_code == 400
    corners = [[0, 0], [1, 0], [1, 1], [0, 1]]
    assert client.put("/v1/indoor/data/tv/levels/1F/floorplan.json", json={"image": "floorplan.png", "corners": corners}).status_code == 200
    assert client.put("/v1/indoor/data/tv/levels/1F/floorplan.json", json={"image": "../x.png", "corners": corners}).status_code == 400
    assert client.put("/v1/indoor/data/nope/venue.json", json=VENUE).status_code == 404


# ---------- survey ----------

def test_survey_upload_merge_and_walk(client, mapdata):
    assert client.get("/v1/indoor/survey/health").json() == {"ok": True}
    s1 = session(walks=[walk(1000)], points=[{"point_id": "1F-sp001", "level": "1F", "x": 1, "y": 2, "scans": []}])
    r = client.post("/v1/indoor/survey", content=json.dumps(s1))
    assert r.json() == {"ok": True, "bytes": len(json.dumps(s1)), "walks": 1, "points": 1, "kept_walks": 0}
    # the phone re-sends the grown session: idempotent replace, a new walk added
    s2 = session(walks=[walk(1000), walk(5000, "2F-walk-b", "2F")], points=[])
    assert client.post("/v1/indoor/survey", json=s2).json()["kept_walks"] == 0
    # an upload that lost a walk keeps the server's copy; points follow the upload (the recorder can delete them)
    s3 = session(walks=[walk(9000)], points=[])
    r = client.post("/v1/indoor/survey", json=s3).json()
    assert r["kept_walks"] == 2 and r["walks"] == 3
    stored = json.loads((mapdata / "survey/raw/20261108-100000-a71.json").read_text(encoding="utf-8"))
    assert [w["t_start"] for w in stored["walks"]] == [1000, 5000, 9000] and stored["wifi_points"] == []

    [summary] = client.get("/v1/indoor/survey/sessions").json()
    assert summary["walks"] == 3 and [w["level"] for w in summary["walk_list"]] == ["1F", "2F", "1F"]
    assert "sensors" not in summary["walk_list"][0] and summary["walk_list"][0]["n_baro"] == 0
    w = client.get("/v1/indoor/survey/session/20261108-100000-a71", params={"walk": 0}).json()["walk"]
    assert w["sensors"]["accelerometer"][0][1] == 0.1235
    assert client.get("/v1/indoor/survey/session/20261108-100000-a71", params={"walk": 9}).status_code == 404

    assert client.post("/v1/indoor/survey", json={**s1, "session_id": "../x"}).json()["error"] == "bad session_id"
    assert client.post("/v1/indoor/survey", json={**s1, "schema": "x"}).status_code == 400


# ---------- eval ----------

def test_eval_round_trip(client):
    run = {"schema": "tpnav-eval/0", "run_id": "20261108-1000-a71", "venue": "tv", "device": {"model": "a71"},
           "engine": {"maps": {}}, "checkpoints": [{"error_m": 1}, {"error_m": 3}, {"error_m": None}]}
    assert client.post("/v1/indoor/eval", json=run).json() == {"ok": True}
    [item] = client.get("/v1/indoor/eval").json()
    assert item["summary"] == {"n": 2, "median_m": 1, "p90_m": 3, "max_m": 3}
    assert item["baro_samples"] == 0 and item["level_changes"] == 0
    assert client.post("/v1/indoor/eval", json={**run, "run_id": "../x"}).status_code == 400


def test_eval_raw_barometer(client, mapdata):
    raw = {"sensors": {"accelerometer": [[1000.5, 0, 0, 9.8]], "gyroscope": [], "magnetometer": [],
                       "barometer": [[1000.0, 1009.87], [2000.0, 1009.41]]},
           "wifi_scans": [], "unavailable": [], "stats": {"samples": 3, "scans": 0, "bytes": 120}}
    run = {"schema": "tpnav-eval/0", "run_id": "20261108-1100-pixel9a", "venue": "tv", "device": {"model": "Pixel 9a"},
           "engine": {"maps": {}}, "checkpoints": [{"t": 2000, "level": "2F", "estimate_level": "2F", "error_m": 1.5}],
           "level_changes": [{"t": 1900, "from": "1F", "to": "2F", "source": "barometer", "confidence": 0.8,
                              "connector": "2F-el2"}], "raw": raw}
    assert client.post("/v1/indoor/eval", json=run).json() == {"ok": True}
    stored = json.loads((mapdata / "survey/eval/20261108-1100-pixel9a.json").read_text(encoding="utf-8"))
    assert stored["raw"]["sensors"]["barometer"] == [[1000.0, 1009.87], [2000.0, 1009.41]]
    assert stored["level_changes"][0]["source"] == "barometer"
    [item] = client.get("/v1/indoor/eval").json()
    assert item["baro_samples"] == 2 and item["level_changes"] == 1
    # older runs (no barometer, A71 reporting it unavailable) still save
    old = {**run, "run_id": "20261107-1000-a71", "raw": {**raw, "sensors": {k: v for k, v in raw["sensors"].items() if k != "barometer"},
                                                         "unavailable": ["barometer"]}}
    assert client.post("/v1/indoor/eval", json=old).json() == {"ok": True}
    bad = {**run, "raw": {**raw, "sensors": {**raw["sensors"], "barometer": [[1000.0, "x"]]}}}
    assert client.post("/v1/indoor/eval", json=bad).json()["error"] == "bad raw barometer"
    assert client.post("/v1/indoor/eval", json={**run, "raw": {"sensors": None}}).json()["error"] == "bad raw sensors"


# ---------- build ----------

FAKE_BUILDER = """import sys
if '--help' in sys.argv:
    print("  --level LEVEL   'all' (default) or one level")
    sys.exit(0)
print('building', ' '.join(sys.argv[1:]))
print('  verdict corridors: GOOD')
print('REPORT {"cells": 7}')
"""


def test_build_runs_tools_one_at_a_time(client, mapdata):
    tools = mapdata / "tools"
    tools.mkdir()
    for name in ("build_radiomap.py", "build_magmap.py"):
        (tools / name).write_text(FAKE_BUILDER, encoding="utf-8")
    (mapdata / "data" / "tianmu").mkdir(parents=True)
    r = client.post("/v1/indoor/build/tianmu", json={"targets": ["radiomap", "magmap"]})
    assert r.status_code == 200
    for _ in range(100):
        st = client.get("/v1/indoor/build/tianmu/status").json()
        if not st["running"]:
            break
        time.sleep(0.1)
    assert st["exitCode"] == 0 and st["report"]["verdict"] == "ok"
    assert st["report"]["caps"] == {"radiomapAll": True, "magmapAll": True}
    assert st["report"]["magmap"] == {"cells": 7} and st["report"]["verdicts"]["radiomap corridors"] == "GOOD"
    assert "-I tools/build_radiomap.py --level all" in st["log"] and "-I tools/build_magmap.py --level all" in st["log"]
    assert client.post("/v1/indoor/build/tv", json={}).status_code == 400


def test_build_commands():
    old = {"radiomapAll": False, "magmapAll": False}
    new = {"radiomapAll": True, "magmapAll": True}
    cmds = indoor.build_commands({"options": {"walksOnly": True, "exclude": ["synthetic-*", "bad;rm"]}}, new, ["1F", "2F"])["cmds"]
    assert cmds == [
        {"target": "radiomap", "args": ["tools/build_radiomap.py", "--level", "all", "--walks-only", "--exclude", "synthetic-*"]},
        {"target": "magmap", "args": ["tools/build_magmap.py", "--level", "all", "--exclude", "synthetic-*"]},
    ]
    r = indoor.build_commands({}, old, ["2F", "1F"])
    assert [" ".join(c["args"][:3]) for c in r["cmds"]] == [
        "tools/build_radiomap.py --level 1F", "tools/build_magmap.py --level 1F", "tools/build_magmap.py --level 2F"]
    assert r["warnings"]
    assert "error" in indoor.build_commands({"options": {"level": "2F"}}, old)
    assert "error" in indoor.build_commands({"targets": ["rm"]})
    assert indoor.help_supports_all("  --level LEVEL   'all' (default)")
    assert not indoor.help_supports_all("  --level LEVEL\n  --exclude EXCLUDE  glob to skip")
    assert indoor.error_summary([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, None]) == {"n": 10, "median_m": 5, "p90_m": 9, "max_m": 10}
