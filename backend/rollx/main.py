import logging
import os
import re
import sqlite3
from contextlib import asynccontextmanager
from itertools import accumulate
from math import cos, dist, hypot, radians
from typing import Annotated, Literal

import httpx
from fastapi import FastAPI, HTTPException, Query, Request
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool
from shapely import Point, get_parts, transform, union_all
from shapely.geometry import mapping, shape

from .facilities import (
    COVERAGE, FACILITY_TYPES, METERS_PER_DEGREE, RADIUS_METERS, ROUTE_FACILITY_TYPES, feature, query_facilities, read_database, route_facilities,
)
from .directions import MAX_GUIDED_POINT_OFFSET, MAX_OFFSET, add_walkway_guidance, guided_point_offset, make_steps
from .import_facilities import DATASET_URL
from .maneuvers import guided_ramps, route_maneuvers, sidewalk_spans
from .osm_crossings import crossing_features
from .places import search_places
from .route_preferences import RouteEvidence, preference_cost
from .slopes import slope_barriers, slope_features
from .walkways import WALKWAY_TYPES, query_walkways

Coordinate = tuple[Annotated[float, Field(ge=-180, le=180)], Annotated[float, Field(ge=-90, le=90)]]
MAX_FACILITIES_PER_TYPE = 1500
DEFAULT_SNAP_METERS = 50
EXTENDED_SNAP_METERS = 120
logger = logging.getLogger("uvicorn.error")


@asynccontextmanager
async def lifespan(app):
    base_url = os.environ.get("ORS_BASE_URL", "http://127.0.0.1:8080/ors").rstrip("/")
    async with httpx.AsyncClient(base_url=base_url + "/", timeout=15) as client:
        app.state.router = client
        yield


app = FastAPI(title="Roll X API", lifespan=lifespan)


class RouteRequest(BaseModel):
    start: Coordinate
    end: Coordinate
    preferences: set[Literal["sidewalk", "ramp", "crossing"]] = Field(default_factory=set)


class RouteNotFound(Exception):
    pass


class SlopedRoutes(Exception):
    def __init__(self, barriers):
        self.barriers = barriers


def fail(status, code, message, **details):
    raise HTTPException(status, detail={"code": code, "message": message, **details})


def feature_collection(features):
    return {"type": "FeatureCollection", "features": features}


def unverified_walkways(properties, evidence):
    # ORS waytype 7 includes mapped footways, pedestrian streets and crossings.
    ways = (properties.get("extras") or {}).get("waytype", {}).get("values") or []
    footways = []
    for row in ways:
        if not isinstance(row, list) or len(row) != 3:
            continue
        start, end, kind = row
        if kind == 7 and type(start) is int and type(end) is int and 0 <= start < end < len(evidence.points):
            footways.append((start, end))
    if not footways:
        return []

    offsets = list(accumulate((dist(a, b) for a, b in zip(evidence.points, evidence.points[1:])), initial=0.0))
    confirmed = sorted(evidence.crossing_positions + sidewalk_spans(evidence.path, evidence.sidewalks))
    spans = []
    for start, stop in footways:
        cursor, end = offsets[start], offsets[stop]
        for a, b in confirmed:
            if a >= end:
                break
            if a - cursor >= 12:
                spans.append((cursor, a))
            cursor = max(cursor, b)
        if end - cursor >= 12:
            spans.append((cursor, end))
    return [{"at_m": round(a, 1), "end_m": round(b, 1)} for a, b in spans]


def route_highlights(conn, coordinates, evidence, nearby, guides, matched_ramps):
    # Show the ramp records used in the instructions as well as points close to the route.
    ramps = {item["id"]: item for item in nearby
             if item["properties"]["kind"] == "1" and item["properties"]["distance_m"] <= 4}
    guided_ids = {item["id"] for _, _, item in matched_ramps}
    ramps.update((item["id"], item) for _, _, item in matched_ramps)
    features = [{**item, "properties": {**item["properties"], "route_context": "ramp",
                                       "guided": item["id"] in guided_ids}}
                for item in ramps.values()]
    lons, lats = zip(*coordinates)
    # Include the far edge of the sidewalk identified by the instructions.
    margin = MAX_GUIDED_POINT_OFFSET / 100_000
    bounds = min(lons) - margin, min(lats) - margin, max(lons) + margin, max(lats) + margin
    for item in slope_features(conn, bounds):
        geometry = item["geometry"]
        if geometry["type"] == "Point":
            points = [geometry["coordinates"]]
        elif geometry["type"] == "LineString":
            points = [geometry["coordinates"][0], geometry["coordinates"][-1]]
        else:
            points = [shape(geometry).representative_point().coords[0]]
        for point in points:
            projected = Point(evidence.project(*point))
            guided = geometry["type"] == "Point" and any(
                guided_point_offset(section, side, footprints, projected) is not None
                for _, side, section, footprints in guides
            )
            if guided or evidence.path.distance(projected) <= 8:
                features.append({
                    "type": "Feature", "geometry": {"type": "Point", "coordinates": point},
                    "properties": {**item["properties"], "kind": "slope", "label": "指引側坡度點" if guided else "沿途坡度點位",
                                   "route_context": "slope", "guided": guided},
                })

    if evidence.sidewalks:
        corridor = evidence.path.buffer(4, cap_style="flat")
        for sidewalk in evidence.sidewalks:
            if sidewalk.intersection(evidence.path).length < 2:
                continue
            for polygon in get_parts(sidewalk.intersection(corridor)):
                if polygon.geom_type != "Polygon" or polygon.intersection(evidence.path).length < 2:
                    continue
                geometry = transform(polygon, evidence.unproject, interleaved=False)
                features.append({
                    "type": "Feature", "geometry": mapping(geometry),
                    "properties": {"kind": "11", "label": "路線行經人行道", "route_context": "sidewalk"},
                })
    for _, side, section, footprints in guides:
        corridor = section.buffer(MAX_OFFSET + 3, cap_style="flat")
        label = "指引側實體人行道"
        for footprint in footprints:
            for polygon in get_parts(footprint.intersection(corridor)):
                if polygon.geom_type != "Polygon":
                    continue
                geometry = transform(polygon, evidence.unproject, interleaved=False)
                features.append({
                    "type": "Feature", "geometry": mapping(geometry),
                    "properties": {"kind": "11", "label": label, "route_context": "guided-sidewalk",
                                   "side": "左側" if side == "left" else "右側"},
                })
    return feature_collection(features)


def choose_route(candidates, preferences):
    shortest = min(item[1] for item in candidates)
    with read_database() as conn:
        choices = []
        barriers = []
        for route, distance, duration, coordinates in candidates:
            evidence = RouteEvidence(conn, coordinates)
            obstacles = slope_barriers(conn, coordinates, evidence)
            if obstacles:
                barriers.extend(obstacles)
                continue
            nearby = route_facilities(conn, coordinates)
            metrics = evidence.metrics(nearby)
            score = preference_cost(distance, shortest, metrics, preferences)
            choices.append((score, distance, duration, coordinates, route, nearby, evidence, metrics))
        if not choices:
            raise SlopedRoutes(barriers)
        _, distance, duration, coordinates, route, nearby, evidence, metrics = min(choices, key=lambda item: item[0])
        steps = make_steps(route["properties"], coordinates)
        guides = add_walkway_guidance(conn, coordinates, steps)
        evidence.add_crossings(steps)
        matched_ramps = list(guided_ramps(evidence, guides, nearby))
        maneuvers = route_maneuvers(evidence, steps, nearby, matched_ramps)
        unverified = unverified_walkways(route["properties"], evidence)
        highlights = route_highlights(conn, coordinates, evidence, nearby, guides, matched_ramps)
        empty_types = conn.execute("SELECT value FROM metadata WHERE key = 'empty_types'").fetchone()
    return distance, duration, coordinates, nearby, steps, maneuvers, metrics, unverified, highlights, (
        empty_types[0].split(",") if empty_types else []
    )


def parse_candidate(route):
    geometry = route["geometry"]
    coordinates = [parse_route_point(point) for point in geometry["coordinates"]]
    summary = route["properties"]["summary"]
    distance, duration = float(summary["distance"]), float(summary["duration"])
    if geometry["type"] != "LineString" or len(coordinates) < 2 or not (0 < distance < float("inf") and 0 <= duration < float("inf")):
        raise ValueError
    return route, distance, duration, coordinates


@app.get("/v1/places")
def places(q: Annotated[str, Query(min_length=2, max_length=80)]):
    try:
        return {"results": search_places(q)}
    except (OSError, sqlite3.Error):
        fail(503, "PLACES_UNAVAILABLE", "本機地點搜尋資料尚未載入。")


@app.get("/v1/meta")
def meta():
    try:
        with read_database() as conn:
            snapshot = dict(conn.execute("SELECT key, value FROM metadata").fetchall())
    except sqlite3.Error:
        snapshot = None
    empty_types = snapshot.get("empty_types", "").split(",") if snapshot else []
    return {
        "empty_types": [kind for kind in empty_types if kind],
        "coverage": COVERAGE, "facility_types": FACILITY_TYPES,
        "radius_m": RADIUS_METERS, "source_url": DATASET_URL, "snapshot": snapshot,
    }


def parse_bbox(bbox):
    try:
        west, south, east, north = map(float, bbox.split(","))
        if not (-180 <= west < east <= 180 and -90 <= south < north <= 90):
            raise ValueError
    except ValueError:
        fail(422, "INVALID_BBOX", "地圖範圍需依序提供西、南、東、北。")
    return west, south, east, north


@app.get("/v1/facilities")
def facilities(bbox: str, types: Annotated[list[str] | None, Query()] = None):
    bounds = parse_bbox(bbox)
    selected_types = list(dict.fromkeys(types or FACILITY_TYPES))
    if len(selected_types) > len(FACILITY_TYPES) or any(kind not in FACILITY_TYPES for kind in selected_types):
        fail(422, "INVALID_TYPE", "包含未支援的設施類別。")
    try:
        with read_database() as conn:
            per_type_limit = MAX_FACILITIES_PER_TYPE
            groups = [query_facilities(conn, bounds, [kind], per_type_limit + 1)
                      for kind in dict.fromkeys(selected_types)]
    except sqlite3.Error:
        fail(503, "DATA_UNAVAILABLE", "設施資料尚未載入。")
    return {
        **feature_collection([feature(row) for rows in groups for row in rows[:per_type_limit]]),
        "truncated": any(len(rows) > per_type_limit for rows in groups),
    }


@app.get("/v1/walkways")
def walkways(bbox: str, types: Annotated[list[str] | None, Query()] = None):
    bounds = parse_bbox(bbox)
    kinds = list(dict.fromkeys(types or (*WALKWAY_TYPES, "osm-crossing")))
    if any(kind not in WALKWAY_TYPES and kind != "osm-crossing" for kind in kinds):
        fail(422, "INVALID_TYPE", "包含未支援的通行空間類別。")
    try:
        with read_database() as conn:
            city_types = [kind for kind in kinds if kind in WALKWAY_TYPES]
            features, truncated = query_walkways(conn, bounds, city_types, limit=900)
        if "osm-crossing" in kinds:
            osm_features, osm_truncated = crossing_features(bounds, limit=1200)
            features.extend(osm_features)
            truncated |= osm_truncated
    except sqlite3.Error:
        fail(503, "DATA_UNAVAILABLE", "通行空間圖資尚未載入。")
    return {**feature_collection(features), "truncated": truncated}


@app.get("/v1/slopes")
def slopes(bbox: str):
    bounds = parse_bbox(bbox)
    try:
        with read_database() as conn:
            features = list(slope_features(conn, bounds))
        for item in features:
            if item["geometry"]["type"] in ("Polygon", "MultiPolygon"):
                item["geometry"] = mapping(shape(item["geometry"]).representative_point())
                item["properties"]["source"] = "臺北市交通局"
        return feature_collection(features)
    except sqlite3.Error:
        fail(503, "DATA_UNAVAILABLE", "坡度圖資尚未載入。")


def route_access_points(start, end, coordinates):
    access_points = {}
    for name, requested, connected in (
        ("start", start, coordinates[0]), ("end", end, coordinates[-1]),
    ):
        lon, lat = requested
        lon_scale = cos(radians(lat)) * METERS_PER_DEGREE
        offset = hypot((connected[0] - lon) * lon_scale, (connected[1] - lat) * METERS_PER_DEGREE)
        if offset > DEFAULT_SNAP_METERS:
            access_points[name] = {"coordinates": connected, "offset_m": round(offset)}
    return access_points


@app.post("/v1/routes")
async def routes(payload: RouteRequest, request: Request):
    west, south, east, north = COVERAGE
    if any(not (west <= lon <= east and south <= lat <= north) for lon, lat in (payload.start, payload.end)):
        fail(422, "OUTSIDE_COVERAGE", "請在臺北示範範圍內選點。")
    if payload.start == payload.end:
        fail(422, "SAME_POINT", "起點與終點需為不同位置。")

    headers = {}
    api_key = os.environ.get("ORS_API_KEY")
    if api_key:
        headers["Authorization"] = api_key
    try:
        radiuses = [DEFAULT_SNAP_METERS, DEFAULT_SNAP_METERS]
        options = {
            "coordinates": [payload.start, payload.end],
            "radiuses": radiuses,
            "instructions": True,
            "extra_info": ["waytype"],
            "options": {"avoid_features": ["steps"]},
        }
        if payload.preferences:
            options["alternative_routes"] = {"target_count": 3, "weight_factor": 1.5, "share_factor": 0.75}
        router = request.app.state.router
        avoided = []
        while True:
            response = await router.post("v2/directions/wheelchair/geojson", json=options, headers=headers)
            error = response.json().get("error", {}) if response.status_code == 404 else {}
            if avoided and error.get("code") in (2009, 2010):
                raise SlopedRoutes(avoided)
            if error.get("code") == 2010:
                match = re.search(r"\bcoordinate ([01]):", error.get("message") or "")
                if match:
                    index = int(match[1])
                    if radiuses[index] == DEFAULT_SNAP_METERS:
                        radiuses[index] = EXTENDED_SNAP_METERS
                        continue
                    endpoint, label = ("start", "起點") if index == 0 else ("end", "終點")
                    fail(404, "UNROUTABLE_ENDPOINT",
                         f"{label}附近找不到可接上的輪椅路線，請改選附近出入口或道路。",
                         endpoint=endpoint)
            if response.status_code in (400, 404) and "alternative_routes" in options:
                # Some installations or long requests do not support alternatives.
                options.pop("alternative_routes")
                continue
            if error.get("code") in (2009, 2010):
                raise RouteNotFound
            response.raise_for_status()
            candidates = [parse_candidate(route) for route in response.json()["features"]]
            if not candidates:
                if avoided:
                    raise SlopedRoutes(avoided)
                raise RouteNotFound
            try:
                selected = await run_in_threadpool(choose_route, candidates, payload.preferences)
                break
            except SlopedRoutes as exc:
                if len(avoided) >= 2:
                    raise
                avoided.append(union_all(exc.barriers))
                options["options"]["avoid_polygons"] = mapping(union_all(avoided))
    except SlopedRoutes:
        fail(404, "NO_SLOPE_FREE_ROUTE", "目前找不到能避開已知坡段的輪椅路線。")
    except sqlite3.Error:
        fail(503, "DATA_UNAVAILABLE", "設施資料尚未載入。")
    except RouteNotFound:
        fail(404, "NO_ROUTE", "查不到輪椅步行路線，請調整起終點。")
    except httpx.ConnectError:
        logger.warning("Roll X could not connect to ORS")
        fail(503, "ROUTER_UNAVAILABLE", "無法連線到路由服務，請確認 openrouteservice 已啟動。")
    except httpx.TimeoutException:
        logger.warning("Roll X timed out waiting for ORS")
        fail(503, "ROUTER_UNAVAILABLE", "路由服務回應逾時，請稍後再試。")
    except httpx.HTTPStatusError as exc:
        logger.warning("ORS returned HTTP %d", exc.response.status_code)
        fail(503, "ROUTER_UNAVAILABLE", "路由服務暫時無法使用。")
    except (httpx.HTTPError, KeyError, IndexError, TypeError, ValueError, AttributeError) as exc:
        logger.warning("Roll X could not read the ORS response (%s)", type(exc).__name__)
        fail(503, "ROUTER_UNAVAILABLE", "路由服務回應異常，請稍後再試。")

    distance, duration, coordinates, nearby, steps, maneuvers, metrics, unverified, highlights, empty_types = selected
    access_points = route_access_points(payload.start, payload.end, coordinates)
    if "end" in access_points:
        for step in (*steps, *maneuvers):
            if step["action"] == "arrive":
                step["instruction"] = "抵達目的地附近的路網接點"
    counts = dict.fromkeys(ROUTE_FACILITY_TYPES, 0)
    for item in nearby:
        counts[item["properties"]["kind"]] += 1
    return {
        "route": {"type": "Feature", "geometry": {"type": "LineString", "coordinates": coordinates},
                  "properties": {}},
        "distance_m": distance, "duration_s": duration, "steps": steps, "maneuvers": maneuvers,
        "access_points": access_points, "highlights": highlights,
        "candidate_count": len(candidates), "evidence": metrics, "unverified_walkways": unverified,
        "radius_m": RADIUS_METERS, "total": len(nearby), "counts": counts,
        "facilities": feature_collection(nearby),
        "empty_types": [kind for kind in empty_types if kind],
    }


def parse_route_point(point):
    lon, lat = map(float, point[:2])
    if not (120 <= lon <= 123 and 24 <= lat <= 26):
        raise ValueError
    return lon, lat
