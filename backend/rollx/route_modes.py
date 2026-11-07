from itertools import accumulate
from math import dist

from shapely import union_all
from shapely.ops import substring

from .directions import MAX_OFFSET, MIN_SIDEWALK_WIDTH
from .maneuvers import merge_spans

# Width values in the bundled sidewalk snapshot are in metres.
COMFORTABLE_SIDEWALK_WIDTH = 1.5
SHORT_STAIR_METERS = 8


def route_stairs(properties, evidence):
    offsets = list(accumulate((dist(a, b) for a, b in zip(evidence.points, evidence.points[1:])), initial=0.0))
    values = properties.get("extras", {}).get("waytype", {}).get("values")
    if values is None:
        return None
    return merge_spans(
        (offsets[start], offsets[end]) for start, end, kind in values
        if kind == 8 and 0 <= start < end < len(offsets)
    )


def sidewalk_grade(width):
    if width is None:
        return None
    if width < MIN_SIDEWALK_WIDTH:
        return "blocked"
    return "comfortable" if width >= COMFORTABLE_SIDEWALK_WIDTH else "limited"


def walkway_quality(evidence, guides):
    comfortable, limited, blocked = [], [], []
    path = evidence.path
    for polygon, width in zip(evidence.sidewalk_index.geometries, evidence.sidewalk_widths):
        grade = sidewalk_grade(width)
        if grade == "blocked":
            if path.intersection(polygon).length >= 3:
                blocked.append(polygon)
        elif grade is not None and path.intersects(polygon):
            (comfortable if grade == "comfortable" else limited).append(path.intersection(polygon))

    # The centreline can have a sidewalk on one or both sides. Count only the
    # portion supported by the matched footprint, and count both sides once.
    for _, _, section, footprints in guides:
        for polygon, width in footprints:
            grade = sidewalk_grade(width)
            if grade in ("comfortable", "limited"):
                overlap = section.intersection(polygon.buffer(MAX_OFFSET))
                (comfortable if grade == "comfortable" else limited).append(overlap)
    good = union_all(comfortable)
    fair = union_all(limited).difference(good.buffer(.05))
    return {
        "comfortable_m": round(good.length),
        "limited_m": round(fair.length),
        "blocked_m": round(path.intersection(union_all(blocked)).length),
    }, blocked


def staircase_barriers(evidence, stairs):
    return [
        substring(evidence.path, start, end).buffer(1.5, cap_style="flat")
        for start, end in stairs
    ]
