"""Indoor navigation API (/v1/indoor): venue data, admin edits, survey uploads, map builds and validation runs.

Port of the former indoor-nav/scripts/survey-server.mjs; the contract is indoor/mapdata/ADMIN_API.md.
mapdata/data/<venue>/** is the source of truth; every write keeps the previous version under mapdata/history/.
No auth: the write endpoints are for the local admin service only.
"""
import json
import math
import os
import re
import subprocess
import sys
import threading
import time
from datetime import datetime
from pathlib import Path

from fastapi import APIRouter, FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse
from starlette.concurrency import run_in_threadpool

router = APIRouter(prefix="/v1/indoor", tags=["indoor"])

REPO = Path(__file__).resolve().parents[2]
SAFE_ID = re.compile(r"[A-Za-z0-9_-]{1,80}")
LEVEL_ID = r"[A-Za-z0-9_-]{1,20}"
MAX_SURVEY = 150 * 1024 * 1024
MAX_DATA = 60 * 1024 * 1024
MAX_IMAGE = 30 * 1024 * 1024
FLOORPLAN_TYPES = {"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/svg+xml": "svg"}
MEDIA = {".json": "application/json", ".geojson": "application/geo+json", ".png": "image/png", ".jpg": "image/jpeg",
         ".jpeg": "image/jpeg", ".webp": "image/webp", ".svg": "image/svg+xml"}
SENSORS = ("accelerometer", "gyroscope", "magnetometer")


class IndoorError(Exception):
    def __init__(self, status, message, **extra):
        self.status, self.message, self.extra = status, message, extra


def install(app: FastAPI):
    """Mount the router; errors keep the admin client's `{ok: false, error}` shape."""
    app.include_router(router)

    @app.exception_handler(IndoorError)
    async def _indoor_error(_request, exc: IndoorError):
        return JSONResponse({"ok": False, "error": exc.message, **exc.extra}, status_code=exc.status,
                            headers={"Cache-Control": "no-store"})


def mapdata() -> Path:
    return Path(os.environ.get("HOWGO_INDOOR_MAPDATA") or REPO / "indoor" / "mapdata").resolve()


def data_dir() -> Path:
    return mapdata() / "data"


def raw_dir() -> Path:
    return mapdata() / "survey" / "raw"


def eval_dir() -> Path:
    return mapdata() / "survey" / "eval"


def no_store(obj, status=200):
    return JSONResponse(obj, status_code=status, headers={"Cache-Control": "no-store"})


# ---------- pure helpers (unit-tested) ----------

def safe_id(value) -> bool:
    return isinstance(value, str) and SAFE_ID.fullmatch(value) is not None


def editable_path(venue, path):
    """Paths the admin may PUT (relative to data/<venue>/); None if not allowed. Every segment is matched."""
    if not safe_id(venue) or not isinstance(path, str):
        return None
    if path in ("venue.json", "nav.geojson"):
        return path
    patterns = (
        rf"levels/{LEVEL_ID}/(units|pois|walls|walls3d)\.geojson",
        rf"levels/{LEVEL_ID}/floorplan\.json",
        r"positioning/[A-Za-z0-9_-][A-Za-z0-9_.-]{0,80}\.json",
        r"survey/[A-Za-z0-9_-][A-Za-z0-9_.-]{0,80}\.geojson",
    )
    if ".." not in path and any(re.fullmatch(p, path) for p in patterns):
        return path
    return None


def readable_path(venue, path):
    """Paths served by GET: the editable files plus other level layers (seating3d…) and floor plan images."""
    if editable_path(venue, path):
        return path
    if not safe_id(venue) or not isinstance(path, str) or ".." in path:
        return None
    if re.fullmatch(rf"levels/{LEVEL_ID}/[A-Za-z0-9_-]{{1,40}}\.geojson", path) or \
            re.fullmatch(rf"levels/{LEVEL_ID}/floorplan\.(png|jpg|jpeg|webp|svg)", path):
        return path
    return None


def validate_data_json(path, obj):
    """Error string for an admin PUT body, or None."""
    if not isinstance(obj, dict):
        return "top level must be a JSON object"
    if path.endswith(".geojson"):
        if obj.get("type") != "FeatureCollection" or not isinstance(obj.get("features"), list):
            return "not a FeatureCollection"
        seen = set()
        for i, f in enumerate(obj["features"]):
            if not isinstance(f, dict) or f.get("type") != "Feature":
                return f"features[{i}] is not a Feature"
            g = f.get("geometry")
            if g is not None and (not isinstance(g, dict) or not isinstance(g.get("type"), str)):
                return f"features[{i}] has a bad geometry"
            fid = (f.get("properties") or {}).get("id")
            if fid is None:
                continue
            key = json.dumps(fid)
            if key in seen:
                return f"duplicate id: {fid}"
            seen.add(key)
        return None
    if path == "venue.json":
        if not isinstance(obj.get("id"), str) or not isinstance(obj.get("levels"), list) or not obj.get("origin"):
            return "venue.json needs id, levels, origin"
        return None
    if path.endswith("/floorplan.json"):
        if not isinstance(obj.get("image"), str) or not re.fullmatch(r"floorplan\.(png|jpg|jpeg|webp|svg)", obj["image"]):
            return "floorplan.json: image must be floorplan.<png|jpg|webp|svg>"
        c = obj.get("corners")
        number = lambda v: isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)
        if not isinstance(c, list) or len(c) != 4 or not all(isinstance(p, list) and len(p) == 2 and all(map(number, p)) for p in c):
            return "floorplan.json: corners must be 4 [x, y] pairs"
    return None


def stamp(now=None):
    return (now or datetime.now()).strftime("%Y%m%d-%H%M%S")


def help_supports_all(text):
    """Does a builder's --help advertise `--level all`?"""
    return re.search(r"--level\b[\s\S]{0,300}?\ball\b", text or "", re.I) is not None


def build_commands(body, caps=None, walk_levels=("1F",)):
    """Builder argument lists for a POST /build body: ({cmds, warnings} | {error}).

    level 'all' (default) builds every level; '<L>' only that level. `caps` says whether the builders accept
    `--level all`; older ones build one level per run, so a lone non-1F radiomap (which would wipe 1F) is refused.
    """
    caps = caps or {"radiomapAll": False, "magmapAll": False}
    body = body if isinstance(body, dict) else {}
    targets = body.get("targets") or ["radiomap", "magmap"]
    o = body.get("options") or {}
    level = o.get("level", "all")
    if level is None:
        level = "all"
    if level != "all" and not (isinstance(level, str) and re.fullmatch(LEVEL_ID, level)):
        return {"error": "bad level"}
    exclude = [g for g in (o.get("exclude") or []) if isinstance(g, str) and re.fullmatch(r"[A-Za-z0-9_*?.|-]{1,120}", g)]
    levels = sorted({lv for lv in walk_levels if isinstance(lv, str) and re.fullmatch(LEVEL_ID, lv)})
    extra = lambda t: (["--walks-only"] if t == "radiomap" and o.get("walksOnly") else []) + [a for g in exclude for a in ("--exclude", g)]
    cmds, warnings = [], []
    for t in targets:
        if t == "radiomap":
            if caps.get("radiomapAll"):
                cmds.append({"target": t, "args": ["tools/build_radiomap.py", "--level", level, *extra(t)]})
            elif level in ("all", "1F"):
                cmds.append({"target": t, "args": ["tools/build_radiomap.py", "--level", "1F", *extra(t)]})
                if any(lv != "1F" for lv in levels):
                    warnings.append("build_radiomap.py 尚未支援多樓層：WiFi 指紋圖只建 1F")
            else:
                return {"error": f"build_radiomap.py 尚未支援多樓層：只建 {level} 會覆蓋 1F 的 WiFi 指紋圖，已拒絕"}
        elif t == "magmap":
            if level != "all":
                cmds.append({"target": t, "args": ["tools/build_magmap.py", "--level", level, *extra(t)]})
            elif caps.get("magmapAll"):
                cmds.append({"target": t, "args": ["tools/build_magmap.py", "--level", "all", *extra(t)]})
            else:
                for lv in levels or ["1F"]:
                    cmds.append({"target": t, "args": ["tools/build_magmap.py", "--level", lv, *extra(t)]})
        else:
            return {"error": f"unknown target: {t}"}
    return {"cmds": cmds, "warnings": warnings}


def parse_report_line(line):
    """Builders may print `REPORT {json}` or a bare JSON object line."""
    m = re.fullmatch(r"\s*(?:REPORT\s+)?(\{.*\})\s*", line)
    if not m:
        return None
    try:
        v = json.loads(m[1])
    except ValueError:
        return None
    return v if isinstance(v, dict) else None


def summarize_session(s, size, mtime):
    walks = s.get("walks") if isinstance(s.get("walks"), list) else []
    points = s.get("wifi_points") if isinstance(s.get("wifi_points"), list) else []
    device = s.get("device") or {}
    return {
        "session_id": s.get("session_id"),
        "device": {"model": device.get("model"), "platform": device.get("platform")},
        "purpose": s.get("purpose"),
        "synthetic": str(s.get("session_id") or "").startswith("synthetic"),
        "walks": len(walks), "points": len(points), "bytes": size, "mtime": mtime,
        "walk_list": [{
            "index": i, "walk_id": w.get("walk_id"), "direction": w.get("direction"), "level": w.get("level"),
            "path": w.get("path"), "t_start": w.get("t_start"), "t_end": w.get("t_end"), "marks": w.get("marks") or [],
            "n_mag": len((w.get("sensors") or {}).get("magnetometer") or []), "n_wifi": len(w.get("wifi_scans") or []),
            "n_baro": len((w.get("sensors") or {}).get("barometer") or []),
        } for i, w in enumerate(walks)],
    }


def percentile(sorted_values, q):
    if not sorted_values:
        return None
    return sorted_values[min(len(sorted_values) - 1, max(0, math.ceil(q * len(sorted_values)) - 1))]


def error_summary(errors):
    e = sorted(v for v in errors if isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v))
    return {"n": len(e), "median_m": percentile(e, .5), "p90_m": percentile(e, .9), "max_m": e[-1] if e else None}


def is_baro_sample(v):
    """[t (epoch ms), hPa]"""
    return (isinstance(v, list) and len(v) == 2
            and all(isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x) for x in v))


def validate_eval(r):
    if not isinstance(r, dict):
        return "not an object"
    if r.get("schema") != "tpnav-eval/0":
        return "bad schema"
    if not safe_id(r.get("run_id")):
        return "bad run_id"
    if not isinstance(r.get("checkpoints"), list):
        return "missing checkpoints"
    raw = r.get("raw")
    if raw is not None:
        sensors = raw.get("sensors") if isinstance(raw, dict) else None
        if not isinstance(sensors, dict):
            return "bad raw sensors"
        # optional (runs before 2026-11-08 have none): replayed through the engine's barometric floor detector
        baro = sensors.get("barometer")
        if baro is not None and not (isinstance(baro, list) and all(is_baro_sample(v) for v in baro)):
            return "bad raw barometer"
    return None


def validate_session(s):
    if not isinstance(s, dict) or s.get("schema") != "tpnav-survey/0":
        return f"bad schema: {s.get('schema') if isinstance(s, dict) else None}"
    if not safe_id(s.get("session_id")):
        return "bad session_id"
    if not isinstance(s.get("wifi_points"), list) or not isinstance(s.get("walks"), list):
        return "missing wifi_points / walks"
    return None


def walk_key(w):
    return w.get("walk_id"), w.get("direction"), w.get("t_start")


def merge_session(old, new):
    """Re-upload of a session (the phone re-sends the whole, growing session under the same id).

    The upload wins; walks only on the server are kept (the recorder never deletes a saved walk, so a missing one
    means the phone lost it). wifi_points come from the upload as-is, since the recorder can delete a point's scans.
    Returns (merged, number of walks kept from the server).
    """
    have = {walk_key(w) for w in new["walks"] if isinstance(w, dict)}
    kept = [w for w in old.get("walks") or [] if isinstance(w, dict) and walk_key(w) not in have]
    if not kept:
        return new, 0
    walks = sorted([*new["walks"], *kept], key=lambda w: w.get("t_start") or 0)
    return {**new, "walks": walks}, len(kept)


def local_to_lnglat(xy, origin, bearing_deg):
    """Local metres -> [lon, lat] (equirectangular tangent plane, as indoor-nav/src/geo/frame.ts)."""
    r = 6378137.0
    th = math.radians(bearing_deg)
    east = xy[0] * math.cos(th) + xy[1] * math.sin(th)
    north = -xy[0] * math.sin(th) + xy[1] * math.cos(th)
    lat0 = origin["lat"]
    return [origin["lng"] + math.degrees(east / (r * math.cos(math.radians(lat0)))), lat0 + math.degrees(north / r)]


def footprint_bbox(venue_dir: Path, levels):
    xs, ys = [], []
    for lv in levels:
        fc = read_json(venue_dir / "levels" / lv / "units.geojson")
        for f in (fc or {}).get("features", []):
            g = f.get("geometry") or {}
            polys = [g.get("coordinates")] if g.get("type") == "Polygon" else g.get("coordinates") if g.get("type") == "MultiPolygon" else []
            for rings in polys or []:
                for x, y, *_ in (rings or [[]])[0]:
                    xs.append(x)
                    ys.append(y)
    return (min(xs), min(ys), max(xs), max(ys)) if xs else None


def read_json(path: Path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


# ---------- file helpers ----------

def atomic_write(dst: Path, data: bytes):
    dst.parent.mkdir(parents=True, exist_ok=True)
    tmp = dst.with_name(f"{dst.name}.{os.getpid()}.{time.time_ns()}.tmp")
    tmp.write_bytes(data)
    os.replace(tmp, dst)


def backup(venue, rel, st=None):
    """Copy the current version to mapdata/history/<venue>/<stamp>/<rel> (no-op if it doesn't exist)."""
    src = data_dir() / venue / rel
    if not src.is_file():
        return None
    dst = mapdata() / "history" / venue / (st or stamp()) / rel
    dst.parent.mkdir(parents=True, exist_ok=True)
    dst.write_bytes(src.read_bytes())
    return dst


def parse_json(raw: bytes):
    try:
        return json.loads(raw)
    except ValueError:
        raise IndoorError(400, "invalid JSON")


async def read_body(request: Request, limit):
    size = int(request.headers.get("content-length") or 0)
    if size > limit:
        raise IndoorError(413, "body too large")
    chunks, total = [], 0
    async for chunk in request.stream():
        total += len(chunk)
        if total > limit:
            raise IndoorError(413, "body too large")
        chunks.append(chunk)
    return b"".join(chunks)


# ---------- venues ----------

@router.get("/venues")
def venues():
    out = []
    root = data_dir()
    for vdir in sorted(p for p in root.glob("*") if p.is_dir()) if root.is_dir() else []:
        v = read_json(vdir / "venue.json")
        if not v or not safe_id(v.get("id")) or not v.get("origin"):
            continue
        levels = sorted(v.get("levels") or [], key=lambda lv: lv.get("ordinal", 0))
        bearing = v.get("bearing_deg") or 0
        bbox = footprint_bbox(vdir, [lv["id"] for lv in levels if safe_id(lv.get("id"))])
        center_xy = ((bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2) if bbox else (0, 0)
        item = {
            "id": v["id"], "name": v.get("name"), "short_name": v.get("short_name"), "name_en": v.get("name_en"),
            "levels": [{"id": lv.get("id"), "name": lv.get("name"), "ordinal": lv.get("ordinal")} for lv in levels],
            "default_level": v.get("default_level"),
            "center": [round(c, 7) for c in local_to_lnglat(center_xy, v["origin"], bearing)],
        }
        entrance = entrance_of(vdir, v, bearing)
        if entrance:
            item["entrance"] = entrance
        out.append(item)
    return no_store(out)


def entrance_of(vdir: Path, v, bearing):
    """Main entrance: venue.json `default_start` / `entrance` node id, else a nav node named *ent-main*."""
    nav = read_json(vdir / "nav.geojson") or {}
    nodes = {f["properties"]["id"]: f for f in nav.get("features", [])
             if (f.get("geometry") or {}).get("type") == "Point" and (f.get("properties") or {}).get("kind") == "node"}
    wanted = v.get("entrance") or v.get("default_start")
    node = nodes.get(wanted) if isinstance(wanted, str) else None
    if node is None:
        node = next((f for k, f in sorted(nodes.items()) if "ent-main" in k and k.endswith("-out")), None) or \
            next((f for k, f in sorted(nodes.items()) if "ent-main" in k), None)
    if node is None:
        return None
    lon, lat = local_to_lnglat(node["geometry"]["coordinates"], v["origin"], bearing)
    return {"node": node["properties"]["id"], "level": node["properties"].get("level"), "coordinates": [round(lon, 7), round(lat, 7)]}


# ---------- data ----------

@router.get("/data/{venue}/{path:path}")
def get_data(venue: str, path: str):
    rel = readable_path(venue, path)
    if not rel:
        raise IndoorError(403, f"path not allowed: {path}")
    file = data_dir() / venue / rel
    if not file.is_file():
        raise IndoorError(404, "not found")
    return FileResponse(file, media_type=MEDIA.get(file.suffix.lower(), "application/octet-stream"), headers={"Cache-Control": "no-store"})


@router.put("/data/{venue}/{path:path}")
async def put_data(venue: str, path: str, request: Request):
    rel = editable_path(venue, path)
    if not rel:
        raise IndoorError(403, f"path not allowed: {path}")
    if not (data_dir() / venue).is_dir():
        raise IndoorError(404, f"unknown venue: {venue}")
    obj = parse_json(await read_body(request, MAX_DATA))
    return await run_in_threadpool(write_data, venue, rel, obj)


def write_data(venue, rel, obj):
    err = validate_data_json(rel, obj)
    if err:
        raise IndoorError(400, err)
    obj["source"] = "admin"
    file = data_dir() / venue / rel
    # keep the existing file's style: pretty (indent 1, like the python tools) unless it was compact
    pretty = rel in ("venue.json", "nav.geojson") or rel.endswith(("pois.geojson", "units.geojson"))
    try:
        with file.open(encoding="utf-8") as fh:
            pretty = "\n" in fh.read(200)
    except OSError:
        pass
    text = json.dumps(obj, ensure_ascii=False, indent=1 if pretty else None, separators=None if pretty else (",", ":"))
    hist = backup(venue, rel)
    data = text.encode("utf-8")
    atomic_write(file, data)
    return no_store({"ok": True, "bytes": len(data), "history": str(hist.relative_to(mapdata())).replace("\\", "/") if hist else None})


@router.post("/floorplan/{venue}/{level}")
async def post_floorplan(venue: str, level: str, request: Request):
    if not safe_id(venue) or not re.fullmatch(LEVEL_ID, level):
        raise IndoorError(400, "bad venue / level")
    ext = FLOORPLAN_TYPES.get((request.headers.get("content-type") or "").split(";")[0].strip())
    if not ext:
        raise IndoorError(415, "Content-Type must be image/png, image/jpeg, image/webp or image/svg+xml")
    if not (data_dir() / venue / "levels" / level).is_dir():
        raise IndoorError(404, f"unknown level: {venue}/{level}")
    raw = await read_body(request, MAX_IMAGE)
    if not raw:
        raise IndoorError(400, "empty body")
    rel = f"levels/{level}/floorplan.{ext}"

    def save():
        backup(venue, rel)
        atomic_write(data_dir() / venue / rel, raw)

    await run_in_threadpool(save)
    return no_store({"ok": True, "url": f"/api/v1/indoor/data/{venue}/{rel}", "path": rel, "bytes": len(raw)})


# ---------- survey ----------

@router.get("/survey/health")
def survey_health():
    return no_store({"ok": True})


@router.post("/survey")
async def post_survey(request: Request):
    raw = await read_body(request, MAX_SURVEY)
    return await run_in_threadpool(save_survey, raw)


def save_survey(raw: bytes):
    s = parse_json(raw)
    err = validate_session(s)
    if err:
        raise IndoorError(400, err)
    dst = raw_dir() / f"{s['session_id']}.json"
    kept = 0
    old = read_json(dst) if dst.is_file() else None
    if old:
        s, kept = merge_session(old, s)
    data = raw if not kept else json.dumps(s, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    atomic_write(dst, data)
    return no_store({"ok": True, "bytes": len(data), "walks": len(s["walks"]), "points": len(s["wifi_points"]), "kept_walks": kept})


_session_cache: dict[Path, tuple[tuple, dict]] = {}
_parsed_cache: dict[Path, tuple[tuple, dict]] = {}
_cache_lock = threading.Lock()


def list_sessions():
    out = []
    directory = raw_dir()
    for p in sorted(directory.glob("*.json")) if directory.is_dir() else []:
        try:
            st = p.stat()
            key = (st.st_size, st.st_mtime_ns)
            with _cache_lock:
                hit = _session_cache.get(p)
            if not hit or hit[0] != key:
                hit = (key, summarize_session(json.loads(p.read_bytes()), st.st_size, st.st_mtime * 1000))
                with _cache_lock:
                    _session_cache[p] = hit
            out.append(hit[1])
        except (OSError, ValueError) as exc:
            out.append({"session_id": p.stem, "error": str(exc)})
    return sorted(out, key=lambda s: s.get("mtime") or 0, reverse=True)


@router.get("/survey/sessions")
def survey_sessions():
    return no_store(list_sessions())


def slim(rows):
    """Sensor tuples rounded for transfer (t to 0.1 ms, values to 1e-4): ~40% smaller, irrelevant for replay."""
    return [[round(v, 1) if i == 0 else round(v, 4) if isinstance(v, float) else v for i, v in enumerate(r)] for r in rows]


@router.get("/survey/session/{session_id}")
def survey_walk(session_id: str, walk: int = 0):
    if not safe_id(session_id):
        raise IndoorError(400, "bad session id")
    p = raw_dir() / f"{session_id}.json"
    if not p.is_file():
        raise IndoorError(404, "no such session")
    st = p.stat()
    key = (st.st_size, st.st_mtime_ns)
    with _cache_lock:
        hit = _parsed_cache.get(p)
    if not hit or hit[0] != key:
        hit = (key, json.loads(p.read_bytes()))
        with _cache_lock:
            _parsed_cache.clear()  # a session is ~10 MB: keep only the last one parsed
            _parsed_cache[p] = hit
    s = hit[1]
    walks = s.get("walks") or []
    if not 0 <= walk < len(walks):
        raise IndoorError(404, "no such walk")
    w = walks[walk]
    sensors = {k: slim(v) if isinstance(v, list) else v for k, v in (w.get("sensors") or {}).items()}
    return no_store({"session_id": session_id, "device": s.get("device"), "walk": {**w, "sensors": sensors}})


# ---------- build ----------

LOG_LINES = 200
_job_lock = threading.Lock()
job = {"running": False, "jobId": None, "venue": None, "startedAt": None, "finishedAt": None, "exitCode": None,
       "log": [], "report": None}
_help_cache: dict[str, tuple[int, str]] = {}


def log_line(line):
    with _job_lock:
        job["log"].append(line)
        del job["log"][:-LOG_LINES]


def python_cmd():
    return [os.environ.get("HOWGO_INDOOR_PYTHON") or sys.executable, "-I"]


def builder_help(script):
    path = mapdata() / script
    try:
        mtime = path.stat().st_mtime_ns
    except OSError:
        return ""
    hit = _help_cache.get(script)
    if hit and hit[0] == mtime:
        return hit[1]
    try:
        out = subprocess.run([*python_cmd(), script, "--help"], cwd=mapdata(), capture_output=True, text=True,
                             encoding="utf-8", errors="replace", timeout=30).stdout
    except (OSError, subprocess.SubprocessError):
        return ""
    _help_cache[script] = (mtime, out)
    return out


def walk_levels_for(exclude):
    """Levels with walks in the sessions a build would use (not synthetic / evaluation / excluded / FAKE devices)."""
    ex = set(exclude or [])
    levels = set()
    for s in list_sessions():
        if s.get("error") or s.get("synthetic") or s.get("purpose") == "evaluation" or s.get("session_id") in ex \
                or re.match(r"FAKE", (s.get("device") or {}).get("model") or "", re.I):
            continue
        levels.update(w.get("level") or "1F" for w in s.get("walk_list") or [])
    return sorted(levels)


def run_one(target, args):
    cmd = [*python_cmd(), *args]
    log_line("$ " + " ".join(cmd))
    env = {**os.environ, "PYTHONIOENCODING": "utf-8", "PYTHONUNBUFFERED": "1"}
    try:
        proc = subprocess.Popen(cmd, cwd=mapdata(), stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                                encoding="utf-8", errors="replace", env=env)
    except OSError as exc:
        log_line(f"spawn failed: {exc}")
        return -1
    for line in proc.stdout:
        line = line.rstrip("\r\n")
        rep = parse_report_line(line)
        with _job_lock:
            if rep:
                job["report"][target] = {**job["report"].get(target, {}), **rep}
            else:
                v = re.match(r"\s*verdict\s+([^:]+):\s*(\S+)", line)
                if v:
                    job["report"].setdefault("verdicts", {})[f"{target} {v[1].strip()}"] = v[2]
        if not rep:
            log_line(line)
    return proc.wait()


def output_summary(venue):
    out = {}
    for f in sorted((data_dir() / venue / "positioning").glob("*.json")):
        j = read_json(f)
        if not isinstance(j, dict):
            continue
        item = {"built_at": j.get("built_at"), "sessions": j.get("sessions"), "synthetic": j.get("synthetic", False)}
        if isinstance(j.get("points"), list):
            item.update(points=len(j["points"]), bssids=len(j.get("bssids") or []))
        if isinstance(j.get("cells"), list):
            item.update(cells=len(j["cells"]), cell_m=j.get("cell_m"))
        out[f.name] = item
    return out


def run_build(venue, cmds):
    st = stamp()
    for f in (data_dir() / venue / "positioning").glob("*.json"):
        backup(venue, f"positioning/{f.name}", st)
    code = 0
    for c in cmds:
        code = run_one(c["target"], c["args"])
        log_line(f"[{c['target']}] exit {code}")
        if code != 0:
            break
    with _job_lock:
        job["report"]["outputs"] = output_summary(venue)
        job["report"]["verdict"] = "ok" if code == 0 else "failed"
        job.update(running=False, exitCode=code, finishedAt=int(time.time() * 1000))


@router.post("/build/{venue}")
async def post_build(venue: str, request: Request):
    if not safe_id(venue) or not (data_dir() / venue).is_dir():
        raise IndoorError(404, f"unknown venue: {venue}")
    if venue != "tianmu":  # the builders are hard-wired to data/tianmu
        raise IndoorError(400, "builders only support venue tianmu")
    raw = await read_body(request, 1_000_000)
    body = parse_json(raw) if raw.strip() else {}
    return await run_in_threadpool(start_build, venue, body)


def start_build(venue, body):
    with _job_lock:
        if job["running"]:
            raise IndoorError(409, "a build is already running", jobId=job["jobId"])
        job["running"] = True  # claim the slot before the slow --help checks
    try:
        exclude = ((body or {}).get("options") or {}).get("exclude") if isinstance(body, dict) else None
        caps = {"radiomapAll": help_supports_all(builder_help("tools/build_radiomap.py")),
                "magmapAll": help_supports_all(builder_help("tools/build_magmap.py"))}
        levels = walk_levels_for(exclude)
        plan = build_commands(body, caps, levels)
        if "error" in plan:
            raise IndoorError(400, plan["error"])
    except BaseException:
        with _job_lock:
            job["running"] = False
        raise
    with _job_lock:
        job.update(jobId=f"build-{stamp()}", venue=venue, startedAt=int(time.time() * 1000), finishedAt=None, exitCode=None, log=[],
                   report={"caps": caps, "walk_levels": levels, "level": ((body or {}).get("options") or {}).get("level", "all"),
                           "warnings": plan["warnings"]})
    for w in plan["warnings"]:
        log_line(f"WARNING: {w}")
    threading.Thread(target=run_build, args=(venue, plan["cmds"]), daemon=True).start()
    return no_store({"ok": True, "jobId": job["jobId"]})


@router.get("/build/{venue}/status")
def build_status(venue: str):
    with _job_lock:
        return no_store({**job, "log": "\n".join(job["log"])})


@router.get("/build/preview/{name}")
def build_preview(name: str):
    if not re.fullmatch(r"(radiomap|magmap)_[A-Za-z0-9_-]+\.png", name):
        raise IndoorError(404, "no preview")
    file = mapdata() / "build" / name
    if not file.is_file():
        raise IndoorError(404, "no preview")
    return FileResponse(file, media_type="image/png", headers={"Cache-Control": "no-store"})


# ---------- eval ----------

_eval_cache: dict[Path, tuple[tuple, dict]] = {}


@router.post("/eval")
async def post_eval(request: Request):
    r = parse_json(await read_body(request, 50_000_000))

    def save():
        err = validate_eval(r)
        if err:
            raise IndoorError(400, err)
        r.setdefault("summary", error_summary([(c or {}).get("error_m") for c in r["checkpoints"]]))
        atomic_write(eval_dir() / f"{r['run_id']}.json", json.dumps(r, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))
        return no_store({"ok": True})

    return await run_in_threadpool(save)


@router.get("/eval")
def list_evals():
    runs = []
    directory = eval_dir()
    for p in directory.glob("*.json") if directory.is_dir() else []:
        try:
            st = p.stat()
            key = (st.st_size, st.st_mtime_ns)
            hit = _eval_cache.get(p)
            if not hit or hit[0] != key:
                # runs may carry raw sensor data (MBs): parse once, keep only the summary
                r = json.loads(p.read_bytes())
                hit = (key, {
                    "run_id": r.get("run_id"), "venue": r.get("venue"), "device": r.get("device"), "engine": r.get("engine"),
                    "kind": r.get("kind") or "live",
                    "summary": r.get("summary") or error_summary([(c or {}).get("error_m") for c in r.get("checkpoints") or []]),
                    "checkpoints": len(r.get("checkpoints") or []), "raw_bytes": ((r.get("raw") or {}).get("stats") or {}).get("bytes"),
                    "baro_samples": len(((r.get("raw") or {}).get("sensors") or {}).get("barometer") or []),
                    "level_changes": len(r.get("level_changes") or []),
                    "mtime": st.st_mtime * 1000,
                })
                _eval_cache[p] = hit
            runs.append(hit[1])
        except (OSError, ValueError):
            continue
    return no_store(sorted(runs, key=lambda r: r["mtime"], reverse=True))

