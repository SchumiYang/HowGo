from itertools import groupby
from math import ceil, cos, dist, hypot, isfinite, radians

from shapely import LineString, Point, STRtree, transform
from shapely.geometry import shape
from shapely.ops import substring

from .facilities import METERS_PER_DEGREE
from .walkways import query_walkways


MIN_SIDEWALK_WIDTH = 0.9

DIRECTIONS = {
    0: ("left", "左轉"), 1: ("right", "右轉"),
    2: ("left", "向左急轉"), 3: ("right", "向右急轉"),
    4: ("left", "向左微轉"), 5: ("right", "向右微轉"),
    6: ("straight", "直行"), 7: ("roundabout", "進入圓環"),
    8: ("roundabout", "離開圓環"), 9: ("uturn", "迴轉"),
    10: ("arrive", "抵達目的地"), 11: ("straight", "出發"),
    12: ("left", "靠左前進"), 13: ("right", "靠右前進"),
}
GUIDANCE_KINDS = ("11", "arcade", "12")
REASONS = {"11": "實體人行道", "arcade": "有整平紀錄的騎樓", "12": "標線型人行道"}
MAX_OFFSET = 10
MAX_GUIDED_POINT_OFFSET = 18
MIN_RUN_METERS = 16


def make_steps(properties, coordinates):
    steps = []
    for segment in (properties.get("segments") or []):
        for raw in (segment.get("steps") or []):
            try:
                start, end = raw["way_points"]
                distance = float(raw["distance"])
                action, label = DIRECTIONS.get(raw.get("type"), ("straight", "繼續前進"))
                if type(start) is not int or type(end) is not int:
                    continue
                if not (0 <= start <= end < len(coordinates) and isfinite(distance) and distance >= 0):
                    continue
                road = (raw.get("name") or "").strip()
            except (AttributeError, IndexError, KeyError, TypeError, ValueError):
                continue
            if road not in ("", "-") and action != "arrive":
                label = f"{label}，沿{road}前進"
            steps.append({
                "action": action, "instruction": label, "distance_m": distance,
                "from_index": start, "to_index": end,
            })
    return steps


def sample_evidence(path, distance, index, kinds):
    before, center, after = (path.interpolate(distance + offset) for offset in (-2, 0, 2))
    dx, dy = after.x - before.x, after.y - before.y
    norm = hypot(dx, dy)
    on_path = set(index.query(center, predicate="intersects"))
    hits = {}
    if on_path:
        kind = best_kind(kinds[i] for i in on_path)
        hits["along", kind] = {i for i in on_path if kinds[i] == kind}
    # A sharp bend or reversal does not give a reliable left/right reference.
    if norm < 3.8:
        return hits

    for side, sign in (("left", 1), ("right", -1)):
        offset_x, offset_y = -dy * sign / norm, dx * sign / norm
        ray = LineString([
            (center.x + offset_x * offset, center.y + offset_y * offset)
            for offset in (1.5, MAX_OFFSET)
        ])
        # A polygon containing the route is evidence for "along", not for both sides.
        matches = set(index.query(ray, predicate="intersects")) - on_path
        if matches:
            kind = best_kind(kinds[i] for i in matches)
            hits[side, kind] = {i for i in matches if kinds[i] == kind}
    return hits


def best_kind(kinds):
    return min(kinds, key=GUIDANCE_KINDS.index)


def step_guidance(path, index, kinds):
    length = path.length
    if length < 8:
        return []
    count = min(400, ceil((length - 4) / 3))
    spacing = (length - 4) / count
    samples = [sample_evidence(path, 2 + (i + 0.5) * spacing, index, kinds) for i in range(count)]

    runs = []
    for side, kind in sorted(set().union(*samples)):
        cursor = 0
        minimum = 8 if kind == "11" else MIN_RUN_METERS
        for matched, group in groupby((side, kind) in sample for sample in samples):
            size = sum(1 for _ in group)
            stop = cursor + size
            if matched and size >= 2:
                start_m = 2 + cursor * spacing if cursor else 0
                end_m = 2 + stop * spacing if stop < count else length
                if end_m - start_m >= minimum:
                    runs.append({
                        "side": side,
                        "reason": REASONS[kind],
                        "from_m": round(start_m, 2),
                        "to_m": round(end_m, 2) if stop < count else None,
                        **({"footprints": sorted(set().union(*(sample[side, kind] for sample in samples[cursor:stop])))}
                           if kind == "11" and side != "along" else {}),
                    })
            cursor = stop
    return runs


def add_walkway_guidance(conn, coordinates, steps, *, exclude_narrow=False):
    if not steps:
        return []
    origin_lon, origin_lat = coordinates[0]
    lon_scale = METERS_PER_DEGREE * cos(radians(origin_lat))
    lons, lats = zip(*coordinates)
    bounds = (
        min(lons) - MAX_OFFSET / lon_scale, min(lats) - MAX_OFFSET / METERS_PER_DEGREE,
        max(lons) + MAX_OFFSET / lon_scale, max(lats) + MAX_OFFSET / METERS_PER_DEGREE,
    )
    features, _ = query_walkways(conn, bounds, GUIDANCE_KINDS, limit=None)
    if exclude_narrow:
        features = [item for item in features if not (
            item["properties"]["kind"] == "11" and item["properties"].get("width", float("inf")) < MIN_SIDEWALK_WIDTH
        )]
    if not features:
        return []

    def project(x, y):
        return (x - origin_lon) * lon_scale, (y - origin_lat) * METERS_PER_DEGREE

    kinds = [feature["properties"]["kind"] for feature in features]
    index = STRtree([transform(shape(feature["geometry"]), project, interleaved=False) for feature in features])
    offsets = [0.0]
    for a, b in zip(coordinates, coordinates[1:]):
        offsets.append(offsets[-1] + dist(project(*a), project(*b)))
    guided = []
    for step in steps:
        start, end = step["from_index"], step["to_index"]
        if end <= start or step["action"] in ("arrive", "roundabout", "uturn"):
            continue
        if any(word in step["instruction"] for word in ("行穿線", "斑馬線", "穿越道", "階梯", "天橋", "地下道")):
            continue
        path = LineString([project(*point) for point in coordinates[start:end + 1]])
        runs = step_guidance(path, index, kinds)
        for run in runs:
            matches = run.pop("footprints", [])
            if matches:
                first = run["from_m"]
                last = path.length if run["to_m"] is None else min(path.length, run["to_m"])
                guided.append((offsets[start] + first, run["side"], substring(path, first, last),
                               [(index.geometries[i], features[i]["properties"].get("width")) for i in matches]))
        if runs:
            step["guidance_ranges"] = runs
            # Keep the single-range field for existing clients.
            step["guidance"] = max(runs, key=lambda row: (
                row["side"] == "along",
                (path.length if row["to_m"] is None else row["to_m"]) - row["from_m"],
            ))
    return guided


def guided_point_offset(section, side, footprints, point):
    if section.distance(point) > MAX_GUIDED_POINT_OFFSET:
        return None
    if not any(polygon.distance(point) <= 2 for polygon, _ in footprints):
        return None
    offset = section.project(point)
    a, center, b = (section.interpolate(at) for at in (
        max(0, offset - 2), offset, min(section.length, offset + 2),
    ))
    dx, dy = b.x - a.x, b.y - a.y
    norm = hypot(dx, dy)
    if not norm:
        return None
    px, py = point.x - center.x, point.y - center.y
    lateral = (dx * py - dy * px) / norm
    longitudinal = (dx * px + dy * py) / norm
    if (lateral if side == "left" else -lateral) >= .5 and abs(longitudinal) <= 3:
        return offset
    return None
