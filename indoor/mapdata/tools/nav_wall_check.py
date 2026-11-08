"""Check that nav edges don't run through blocking walls.

positioning/grid.ts blocks the cells under every 'wall' / 'column' line of walls.geojson and then carves capsules along
nav edges (corridor / door / ramp), so an edge that crosses a wall opens a hole in it for the particles, and the route
(and the position snapped to it) is drawn through the wall. An edge may touch walls only near its ends (a door node
sits in the opening, a POI node inside its room): each end is trimmed by TRIM_M before testing.

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
    edges = {}
    for c in found:
        edges.setdefault((c['level'], c['edge'], c['type']), []).append(c)
    for (lv, e, t), cs in sorted(edges.items()):
        print(f'{lv} {e:28s} {t:9s} {len(cs)} crossing(s) at ' + ', '.join(f"({c['at'][0]}, {c['at'][1]}) {c['layer']}#{c['wall']}" for c in cs[:6]))
    print(f'{len(edges)} edge(s), {len(found)} crossing(s)')
    if args.png:
        render(args.data, args.level, args.png, [c for c in found if c['level'] == args.level])
    sys.exit(1 if found else 0)


if __name__ == '__main__':
    main()
