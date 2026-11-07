"""Stepped seating tiers for the 2.5D map (2F stands), from the seating units.

The photo from the court floor shows raked stands: a ~1.1 m parapet at the court edge, then rows stepping up away
from the court to a back wall. Each seating unit (category 'seating', prop `section` = north/south/west/east) is cut
into rows parallel to its court edge; row i (counted from the court) is a solid step of height (i + 1) * RISE.

Output: data/tianmu/levels/<level>/seating3d.geojson — Polygon features, props
  {kind: 'tier' | 'parapet', section, row, height_m, base_m}
Usage : python -I tools/seating3d.py
"""
import json
import os

LEVEL = '2F'
ROW_DEPTH = 0.9   # m, seat row depth
RISE = 0.5        # m per row (real ≈0.4; slightly exaggerated so the steps read in the default 3D view)
PARAPET_H = 1.1   # m, glass/steel balustrade at the court edge
PARAPET_W = 0.15  # m

# court-side direction per section: (axis, sign) — rows are counted from the court edge outward
# north stand: court is to the south (low y); south stand: court to the north; west: court to the east; east: to the west
COURT_SIDE = {'north': ('y', -1), 'south': ('y', 1), 'west': ('x', 1), 'east': ('x', -1)}


def clip(poly, axis, value, keep_greater):
    """Sutherland–Hodgman clip of a closed ring against the half-plane axis >= value (or <= value)."""
    i = 0 if axis == 'x' else 1
    inside = (lambda p: p[i] >= value) if keep_greater else (lambda p: p[i] <= value)
    out = []
    pts = poly[:-1] if poly[0] == poly[-1] else poly
    for a, b in zip(pts, pts[1:] + pts[:1]):
        if inside(a):
            out.append(a)
        if inside(a) != inside(b):
            t = (value - a[i]) / (b[i] - a[i])
            out.append([round(a[0] + (b[0] - a[0]) * t, 3), round(a[1] + (b[1] - a[1]) * t, 3)])
    return out + out[:1] if len(out) >= 3 else None


def main():
    units = json.load(open(f'data/tianmu/levels/{LEVEL}/units.geojson', encoding='utf-8'))['features']
    # front walkway (category 'walkway' with a section) sits between the parapet and row 1
    walk = {u['properties']['section']: u['geometry']['coordinates'][0] for u in units
            if u['properties'].get('category') == 'walkway' and u['properties'].get('section') in COURT_SIDE}
    feats = []
    for u in units:
        p = u['properties']
        if p.get('category') != 'seating' or p.get('section') not in COURT_SIDE:
            continue
        ring = u['geometry']['coordinates'][0]
        axis, sign = COURT_SIDE[p['section']]
        i = 0 if axis == 'x' else 1
        vals = [c[i] for c in ring]
        # court edge is the extreme on the court side; rows march away from it
        edge = max(vals) if sign > 0 else min(vals)
        far = min(vals) if sign > 0 else max(vals)
        depth = abs(far - edge)
        n_rows = max(1, round(depth / ROW_DEPTH))
        step = depth / n_rows
        direction = -sign  # outward from the court
        for r in range(n_rows):
            a = edge + direction * step * r
            b = edge + direction * step * (r + 1)
            lo, hi = min(a, b), max(a, b)
            band = clip(ring, axis, lo, True)
            band = band and clip(band, axis, hi, False)
            if band:
                feats.append({'type': 'Feature', 'geometry': {'type': 'Polygon', 'coordinates': [band]},
                              'properties': {'kind': 'tier', 'section': p['section'], 'row': r + 1,
                                             'height_m': round(RISE * (r + 1), 2), 'base_m': 0}})
        # parapet strip along the court edge (of the front walkway when there is one)
        pring = walk.get(p['section'], ring)
        pvals = [c[i] for c in pring]
        pedge = max(pvals) if sign > 0 else min(pvals)
        lo, hi = sorted((pedge, pedge + direction * PARAPET_W))
        strip = clip(pring, axis, lo, True)
        strip = strip and clip(strip, axis, hi, False)
        if strip:
            feats.append({'type': 'Feature', 'geometry': {'type': 'Polygon', 'coordinates': [strip]},
                          'properties': {'kind': 'parapet', 'section': p['section'], 'row': 0,
                                         'height_m': PARAPET_H, 'base_m': 0}})
    path = f'data/tianmu/levels/{LEVEL}/seating3d.geojson'
    with open(path, 'w', encoding='utf-8') as f:
        json.dump({'type': 'FeatureCollection', 'features': feats}, f, separators=(',', ':'))
    rows = {}
    for f in feats:
        if f['properties']['kind'] == 'tier':
            rows[f['properties']['section']] = max(rows.get(f['properties']['section'], 0), f['properties']['row'])
    print(path, len(feats), 'features; rows per section', rows)


if __name__ == '__main__':
    main()
