"""Check that nav edges don't run through blocking walls.

positioning/grid.ts blocks the cells under every 'wall' / 'column' line of walls.geojson and then carves capsules along
nav edges (corridor / door / ramp), so an edge that crosses a wall opens a hole in it for the particles, and the route
(and the position snapped to it) is drawn through the wall. An edge may touch walls only near its ends (a door node
sits in the opening, a POI node inside its room): each end is trimmed by TRIM_M before testing.
Because of that trim, a node placed ON a wall line would hide a crossing; so a node lying on a blocking line is an
error unless it is a declared opening (DECLARED_OPENINGS: openings the CAD draws closed, each with its reason).

Usage : py -3.12 -I tools/nav_wall_check.py [--level 1F] [--png OUT.png]   (exit 1 when an edge crosses a wall)
Import: crossings(data_dir) -> [{edge, level, type, at: [x, y], wall: feature index in walls.geojson, layer}]
"""
import argparse
import json
import math
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, 'data', 'tianmu')
BLOCKING = ('wall', 'column')
TRIM_M = 0.6
CHECK_TYPES = ('corridor', 'door', 'ramp', 'stairs')  # elevator edges are vertical connectors
ON_WALL_M = 0.12

# Door nodes that sit on a line the CAD draws as a blocking wall, i.e. real openings drawn closed. Keep each one
# explained; a node on a wall line that is not listed here is reported, and so is a listed node that no longer sits
# on a wall (stale entry).
DECLARED_OPENINGS = {
    # doors confirmed on site but not drawn in the CAD (user, 2026-11-08 「有門」; position assumed: centred on the
    # corridor). If only one end turns out to have a door, drop the other here and in author_1f.py.
    '1F-d-e-n': 'east corridor north door, confirmed on site, not drawn in CAD',
    '1F-d-e-s': 'east corridor south door in the diagonal end wall, confirmed on site, not drawn in CAD',
    '1F-d-e-s2': 'east corridor south door into the SE lobby (y=4.4 wall), confirmed on site, not drawn in CAD',
    # elevator door leaves drawn as a wall line across the shaft opening
    '1F-d-el2': 'elevator #2 door leaf drawn as wall', '2F-d-el2': 'elevator #2 door leaf drawn as wall',
    # door frame line drawn across the doorway
    '1F-d-acc': 'accessible toilet doorway line', '2F-d-acc': 'accessible toilet doorway line',
    '2F-d-acc-s': 'accessible toilet doorway line',
    '2F-f-in': 'female restroom inner partition doorway line',
    '1F-d-stD': 'stair D door in the SE lobby wall (not drawn)',
    # 2F outdoor-stair vestibules: single glazing line with mullions (door in it not drawn), facade door to the stair
    '2F-w-box': 'glazed vestibule front', '2F-w-box-s': 'glazed vestibule front',
    '2F-out-door': 'facade door to the outdoor stair', '2F-out-door-s': 'facade door to the outdoor stair',
}


def seg_dist(p, a, b):
    dx, dy = b[0] - a[0], b[1] - a[1]
    t = max(0.0, min(1.0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / ((dx * dx + dy * dy) or 1e-12)))
    return math.dist(p, (a[0] + t * dx, a[1] + t * dy))


def node_issues(data_dir=DATA, level=None):
    """Nodes on a blocking wall line that are not declared openings, and declared openings that are not on one."""
    nav, _, walls = load(data_dir)
    out = []
    for f in nav:
        pr = f['properties']
        if pr['kind'] != 'node' or (level and pr['level'] != level):
            continue
        p = f['geometry']['coordinates']
        hit = next((wi for wi, w in walls.get(pr['level'], []) if any(
            seg_dist(p, a, b) < ON_WALL_M for a, b in zip(w['geometry']['coordinates'], w['geometry']['coordinates'][1:]))), None)
        if hit is not None and pr['id'] not in DECLARED_OPENINGS:
            out.append({'node': pr['id'], 'level': pr['level'], 'at': p, 'wall': hit, 'issue': 'node on a wall line, not a declared opening'})
        elif hit is None and pr['id'] in DECLARED_OPENINGS:
            out.append({'node': pr['id'], 'level': pr['level'], 'at': p, 'wall': None, 'issue': 'declared opening not on a wall (stale entry)'})
    return out


def seg_intersection(p, q, a, b):
    """Intersection point of segments pq and ab, or None (collinear overlaps count as crossing at their midpoint)."""
    rx, ry = q[0] - p[0], q[1] - p[1]
    sx, sy = b[0] - a[0], b[1] - a[1]
    den = rx * sy - ry * sx
    qpx, qpy = a[0] - p[0], a[1] - p[1]
    if abs(den) < 1e-12:
        if abs(qpx * ry - qpy * rx) > 1e-9:
            return None
        rr = rx * rx + ry * ry or 1e-12
        t0 = (qpx * rx + qpy * ry) / rr
        t1 = t0 + (sx * rx + sy * ry) / rr
        lo, hi = max(0.0, min(t0, t1)), min(1.0, max(t0, t1))
        if lo > hi:
            return None
        t = (lo + hi) / 2
        return (p[0] + t * rx, p[1] + t * ry)
    t = (qpx * sy - qpy * sx) / den
    u = (qpx * ry - qpy * rx) / den
    if 0 <= t <= 1 and 0 <= u <= 1:
        return (p[0] + t * rx, p[1] + t * ry)
    return None


def trimmed(a, b, trim=TRIM_M):
    L = math.dist(a, b)
    if L <= 2 * trim:
        return None
    f = trim / L
    return ((a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f), (b[0] - (b[0] - a[0]) * f, b[1] - (b[1] - a[1]) * f))


def load(data_dir):
    nav = json.load(open(os.path.join(data_dir, 'nav.geojson'), encoding='utf-8'))['features']
    level_of = {f['properties']['id']: f['properties']['level'] for f in nav if f['properties']['kind'] == 'node'}
    walls = {}
    for lv in sorted(set(level_of.values())):
        p = os.path.join(data_dir, 'levels', lv, 'walls.geojson')
        if os.path.exists(p):
            walls[lv] = [(i, f) for i, f in enumerate(json.load(open(p, encoding='utf-8'))['features'])
                         if f['properties'].get('layer') in BLOCKING]
    return nav, level_of, walls


def crossings(data_dir=DATA, level=None):
    nav, level_of, walls = load(data_dir)
    out = []
    for f in nav:
        pr = f['properties']
        if pr['kind'] != 'edge' or pr['type'] not in CHECK_TYPES:
            continue
        lv = level_of.get(pr['from'])
        if lv != level_of.get(pr['to']) or (level and lv != level):
            continue
        c = f['geometry']['coordinates']
        for k in range(1, len(c)):
            # interior vertices of a polyline edge are real points on the path: only the edge's two ends are trimmed
            a = c[k - 1] if k > 1 else None
            b = c[k] if k < len(c) - 1 else None
            seg = (c[k - 1], c[k])
            if a is None or b is None:
                L = math.dist(*seg)
                if L <= TRIM_M * (int(a is None) + int(b is None)):
                    continue
                fa = TRIM_M / L if a is None else 0.0
                fb = TRIM_M / L if b is None else 0.0
                p0, p1 = seg
                seg = ((p0[0] + (p1[0] - p0[0]) * fa, p0[1] + (p1[1] - p0[1]) * fa),
                       (p1[0] - (p1[0] - p0[0]) * fb, p1[1] - (p1[1] - p0[1]) * fb))
            for wi, w in walls.get(lv, []):
                wc = w['geometry']['coordinates']
                for j in range(1, len(wc)):
                    x = seg_intersection(seg[0], seg[1], wc[j - 1], wc[j])
                    if x:
                        out.append({'edge': f"{pr['from']}~{pr['to']}", 'level': lv, 'type': pr['type'],
                                    'at': [round(x[0], 2), round(x[1], 2)], 'wall': wi, 'layer': w['properties']['layer']})
    return out


def render(data_dir, level, path, marks=None, scale=12):
    """PNG: blocking walls (dark), other linework (light), nav edges (blue), crossings (red)."""
    from PIL import Image, ImageDraw
    nav, level_of, _ = load(data_dir)
    allw = json.load(open(os.path.join(data_dir, 'levels', level, 'walls.geojson'), encoding='utf-8'))['features']
    pts = [p for w in allw for p in w['geometry']['coordinates']]
    x0, y0 = min(p[0] for p in pts) - 2, min(p[1] for p in pts) - 2
    x1, y1 = max(p[0] for p in pts) + 2, max(p[1] for p in pts) + 2
    W, H = int((x1 - x0) * scale), int((y1 - y0) * scale)
    img = Image.new('RGB', (W, H), 'white')
    d = ImageDraw.Draw(img)
    T = lambda p: ((p[0] - x0) * scale, (y1 - p[1]) * scale)
    for w in allw:
        blocking = w['properties'].get('layer') in BLOCKING
        d.line([T(p) for p in w['geometry']['coordinates']], fill=(40, 40, 40) if blocking else (205, 205, 205), width=2 if blocking else 1)
    bad = {m['edge'] for m in (marks or [])}
    for f in nav:
        pr = f['properties']
        if pr['kind'] == 'edge' and level_of.get(pr['from']) == level and level_of.get(pr['to']) == level:
            e = f"{pr['from']}~{pr['to']}"
            d.line([T(p) for p in f['geometry']['coordinates']], fill=(220, 40, 40) if e in bad else (40, 120, 220), width=4 if e in bad else 3)
        elif pr['kind'] == 'node' and pr['level'] == level:
            x, y = T(f['geometry']['coordinates'])
            d.ellipse([x - 4, y - 4, x + 4, y + 4], fill=(40, 120, 220))
    for m in marks or []:
        x, y = T(m['at'])
        d.ellipse([x - 7, y - 7, x + 7, y + 7], outline=(220, 0, 0), width=3)
    d.text((10, 10), f'{level}: {len(bad)} nav edges crossing walls, {len(marks or [])} crossings', fill=(220, 0, 0) if bad else (0, 120, 0))
    img.save(path)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--level')
    ap.add_argument('--data', default=DATA)
    ap.add_argument('--png', help='render the level (needs --level)')
    args = ap.parse_args()
    found = crossings(args.data, args.level)
    issues = node_issues(args.data, args.level)
    for n in issues:
        print(f"{n['level']} {n['node']} at {n['at']}: {n['issue']}" + (f" (wall #{n['wall']})" if n['wall'] is not None else ''))
    edges = {}
    for c in found:
        edges.setdefault((c['level'], c['edge'], c['type']), []).append(c)
    for (lv, e, t), cs in sorted(edges.items()):
        print(f'{lv} {e:28s} {t:9s} {len(cs)} crossing(s) at ' + ', '.join(f"({c['at'][0]}, {c['at'][1]}) {c['layer']}#{c['wall']}" for c in cs[:6]))
    print(f'{len(edges)} edge(s), {len(found)} crossing(s)')
    if args.png:
        render(args.data, args.level, args.png, [c for c in found if c['level'] == args.level])
    sys.exit(1 if found or issues else 0)


if __name__ == '__main__':
    main()
