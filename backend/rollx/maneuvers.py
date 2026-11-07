from math import atan2, degrees, dist

from shapely import Point, union_all
from shapely.ops import substring

from .directions import REASONS, guided_point_offset


PHYSICAL_SIDEWALK = REASONS["11"]
SHORT_UNCOVERED_METERS = 15


def is_turn(path, before, at, after, action, instruction):
    if before == at or at == after:
        return False
    a, b, c = (path.interpolate(offset) for offset in (before, at, after))
    ux, uy = b.x - a.x, b.y - a.y
    vx, vy = c.x - b.x, c.y - b.y
    angle = degrees(atan2(ux * vy - uy * vx, ux * vx + uy * vy))
    minimum = 25 if instruction.startswith(("靠左", "靠右")) else 16
    return abs(angle) >= 150 or (angle if action == "left" else -angle) >= minimum


def sidewalk_spans(path, sidewalks):
    if not sidewalks:
        return []
    overlap = path.intersection(union_all(sidewalks))
    spans = []
    for part in getattr(overlap, "geoms", [overlap]):
        if part.geom_type == "LineString" and part.length > 0:
            spans.append(sorted(path.project(Point(point)) for point in (part.coords[0], part.coords[-1])))
    merged = []
    for start, end in sorted(spans):
        if merged and start <= merged[-1][1] + 2:
            merged[-1] = merged[-1][0], max(end, merged[-1][1])
        else:
            merged.append((start, end))
    return [(0 if start <= 2 else start, end) for start, end in merged if end - start >= 8]


def merge_spans(spans):
    merged = []
    for first, last in sorted(spans):
        if merged and first <= merged[-1][1] + 0.02:
            merged[-1] = merged[-1][0], max(last, merged[-1][1])
        else:
            merged.append((first, last))
    return merged


def summarize_coverage(spans, length):
    covered = sum(last - first for first, last in spans)
    return covered > 0.8 * length or (covered >= 0.7 * length and length - covered <= SHORT_UNCOVERED_METERS)


def describe_coverage(spans, start, end):
    if len(spans) != 1:
        return "部分路段"
    first, last = spans[0]
    if first - start <= 2 and end - last <= 2:
        return "全段"
    if first - start <= 2:
        return f"前約 {round(last - start)} 公尺"
    return f"約第 {round(first - start)}–{round(last - start)} 公尺"


def guided_ramps(evidence, guides, facilities):
    points = [(item, Point(evidence.project(*item["geometry"]["coordinates"])))
              for item in facilities if item["properties"]["kind"] == "1"]
    for start, side, section, footprints in guides:
        for item, point in points:
            offset = guided_point_offset(section, side, footprints, point)
            if offset is not None:
                yield start + offset, side, item


def route_maneuvers(evidence, steps, facilities, matched_ramps=()):
    path = evidence.path
    lengths = [0.0]
    for a, b in zip(evidence.points, evidence.points[1:]):
        lengths.append(lengths[-1] + dist(a, b))

    events = []
    guidance_ranges = []
    step_offsets = sorted({0.0, path.length, *(lengths[step["from_index"]] for step in steps)})
    neighbors = {at: (max(before, at - 8), min(after, at + 8))
                 for before, at, after in zip(step_offsets, step_offsets[1:], step_offsets[2:])}
    for step in steps:
        offset = lengths[step["from_index"]]
        action = step["action"]
        instruction = step["instruction"]
        if action in ("left", "right"):
            before, after = neighbors.get(offset, (offset, offset))
            if is_turn(path, before, offset, after, action, instruction):
                events.append((offset, 0, offset, action, instruction, ""))
        elif action not in ("straight", "arrive"):
            events.append((offset, 0, offset, action, instruction, ""))

        for guidance in step.get("guidance_ranges") or ([step["guidance"]] if "guidance" in step else []):
            start = offset + guidance["from_m"]
            end = lengths[step["to_index"]]
            if guidance["to_m"] is not None:
                end = min(end, offset + guidance["to_m"])
            if end > start:
                guidance_ranges.append((start, end, guidance["side"], guidance["reason"]))

    for start, end in evidence.crossing_positions:
        events.append((start, 1, end, "crossing", "走行人穿越道", ""))

    ramp_points = [Point(evidence.project(*item["geometry"]["coordinates"])) for item in facilities
                   if item["properties"]["kind"] == "1"]
    sidewalks = sidewalk_spans(path, evidence.sidewalks)
    for start, end in sidewalks:
        if start:
            entry = path.interpolate(start)
            approach = substring(path, start, min(end, start + 8))
            connected = [evidence.sidewalk_index.geometries[index]
                         for index in evidence.sidewalk_index.query(approach, predicate="intersects")]
            ramp = any(entry.distance(point) <= 8 and approach.distance(point) <= 3
                       and any(polygon.distance(point) <= 2 for polygon in connected)
                       for point in ramp_points)
            note = "人行道接點附近有無障礙坡道紀錄" if ramp else ""
            events.append((start, 2, start, "sidewalk", "上實體人行道", note))

    instructions = []

    def add(start, end, action, instruction, note=""):
        position = path.interpolate(start)
        row = {
            "at_m": round(start, 1), "end_m": round(end, 1), "action": action,
            "instruction": instruction, "position": evidence.unproject(position.x, position.y),
        }
        if note:
            row["note"] = note
        instructions.append(row)

    def add_straight(start, end):
        def clip(left, right):
            return max(start, left), min(end, right)

        ranges = {}
        for left, right, side, reason in guidance_ranges:
            first, last = clip(left, right)
            if last - first >= 1 and (side, reason) != ("along", PHYSICAL_SIDEWALK):
                ranges.setdefault((side, reason), []).append((first, last))
        ranges = {key: merge_spans(spans) for key, spans in ranges.items()}

        on_sidewalk = [(a, b) for a, b in (clip(left, right) for left, right in sidewalks) if a < b]
        length = end - start
        if any(a <= start and end <= b for a, b in on_sidewalk):
            add(start, end, "straight", "直行", "沿實體人行道前進")
            return

        left = ranges.get(("left", PHYSICAL_SIDEWALK), [])
        right = ranges.get(("right", PHYSICAL_SIDEWALK), [])
        both = merge_spans((max(a, c), min(b, d)) for a, b in left for c, d in right if max(a, c) < min(b, d))

        if left or right or on_sidewalk:
            if summarize_coverage(both, length):
                note = "兩側有實體人行道"
            elif left and right:
                note = "兩側各有部分實體人行道"
            elif left or right:
                label, spans = ("左側", left) if left else ("右側", right)
                if summarize_coverage(spans, length):
                    note = f"{label}有實體人行道"
                else:
                    note = f"{describe_coverage(spans, start, end)}{label}有實體人行道"
            elif summarize_coverage(on_sidewalk, length):
                note = "沿途有實體人行道"
            else:
                note = f"{describe_coverage(on_sidewalk, start, end)}沿實體人行道前進"

            ramps = [
                at - start for at, side, _ in matched_ramps
                if any(first - .02 <= at <= last + .02 for first, last in (left if side == "left" else right))
            ]
            if any(offset <= 8 for offset in ramps):
                note += "，起段附近有坡道紀錄"
            elif ramps:
                note += "，沿線有無障礙坡道紀錄"
        elif ranges:
            side, reason = max(ranges, key=lambda key: sum(b - a for a, b in ranges[key]))
            coverage = describe_coverage(ranges[(side, reason)], start, end)
            if side == "along":
                note = f"{coverage}沿{reason}前進"
            else:
                label = "左側" if side == "left" else "右側"
                note = f"{coverage}{label}有{reason}"
        else:
            note = ""
        add(start, end, "straight", "直行", note)

    cursor = 0.0
    ordered = sorted(events)
    for index, (start, _, end, action, instruction, note) in enumerate(ordered):
        if action == "crossing" and index + 1 < len(ordered):
            after, _, _, next_action, next_instruction, _ = ordered[index + 1]
            if next_action in ("left", "right") and abs(after - end) <= 2:
                note = f"通過後{next_instruction}"
        if start > cursor + 0.5:
            add_straight(cursor, start)
        add(start, end, action, instruction, note)
        cursor = max(cursor, end)
    if path.length > cursor + 0.5:
        add_straight(cursor, path.length)
    add(path.length, path.length, "arrive", "抵達目的地")
    return instructions
