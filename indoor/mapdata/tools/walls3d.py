"""Build extrudable wall/column polygons for the 2.5D map (MapLibre fill-extrusion).

walls.geojson only has LineStrings (CAD wall faces, usually drawn as two parallel lines per wall).
Each wall segment becomes a thin quad (THICKNESS m, centred on the line); per source feature the quads are
merged into one MultiPolygon. Columns are already closed squares and are used as-is.
Door openings are gaps in the wall linework, so they stay open after extrusion.

Output: data/tianmu/levels/<level>/walls3d.geojson — props {layer: wall|column}. All walls share one height,
chosen by the app (the goal is visible partitions and a 3D feel, not real storey heights).
Usage : python -I tools/walls3d.py
"""
import json
import math
import os

THICKNESS = 0.2   # m; two face-lines ~0.2–0.3 m apart read as one solid wall
MIN_SEG = 0.05    # m; skip degenerate segments


def quad(a, b, t):
    dx, dy = b[0] - a[0], b[1] - a[1]
    n = math.hypot(dx, dy)
    ox, oy = -dy / n * t / 2, dx / n * t / 2
    ring = [[a[0] + ox, a[1] + oy], [b[0] + ox, b[1] + oy], [b[0] - ox, b[1] - oy], [a[0] - ox, a[1] - oy]]
    ring.append(ring[0])
    return [[[round(x, 3), round(y, 3)] for x, y in ring]]


def inside(p, ring):
    x, y = p
    hit = False
    for (x1, y1), (x2, y2) in zip(ring, ring[1:]):
        if (y1 > y) != (y2 > y) and x < x1 + (y - y1) * (x2 - x1) / (y2 - y1):
            hit = not hit
    return hit


def stand_rings(level):
    """Seating units (+ the front walkway strips): their row linework is drawn as 'wall' in the CAD but the stands are
    stepped (seating3d.py)."""
    path = f'data/tianmu/levels/{level}/units.geojson'
    if not os.path.exists(path):
        return []
    units = json.load(open(path, encoding='utf-8'))['features']
    return [u['geometry']['coordinates'][0] for u in units if u['properties'].get('category') == 'seating'
            or (u['properties'].get('category') == 'walkway' and u['properties'].get('section'))]


def main():
    for level in ('1F', '2F'):
        src = json.load(open(f'data/tianmu/levels/{level}/walls.geojson', encoding='utf-8'))
        stands = stand_rings(level)

        def in_stand(a, b, inset=0.4):
            # deep inside the union of stand rings (seat + walkway share an edge, so probe around the midpoint)
            mid = ((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)
            probes = [mid, (mid[0] - inset, mid[1]), (mid[0] + inset, mid[1]), (mid[0], mid[1] - inset), (mid[0], mid[1] + inset)]
            return all(any(inside(q, r) for r in stands) for q in probes)

        out = []
        for f in src['features']:
            layer = f['properties']['layer']
            coords = f['geometry']['coordinates']
            if layer == 'wall':
                polys = [quad(a, b, THICKNESS) for a, b in zip(coords, coords[1:])
                         if math.dist(a, b) > MIN_SEG and not in_stand(a, b)]
                if polys:
                    out.append({'type': 'Feature', 'geometry': {'type': 'MultiPolygon', 'coordinates': polys},
                                'properties': {'layer': 'wall'}})
            elif layer == 'column' and len(coords) >= 4 and coords[0] == coords[-1]:
                out.append({'type': 'Feature', 'geometry': {'type': 'Polygon', 'coordinates': [[[round(x, 3), round(y, 3)] for x, y in coords]]},
                            'properties': {'layer': 'column'}})
        path = f'data/tianmu/levels/{level}/walls3d.geojson'
        with open(path, 'w', encoding='utf-8') as fp:
            json.dump({'type': 'FeatureCollection', 'features': out}, fp, separators=(',', ':'))
        n_quads = sum(len(f['geometry']['coordinates']) for f in out if f['geometry']['type'] == 'MultiPolygon')
        print(level, len(out), 'features,', n_quads, 'wall quads,', os.path.getsize(path) // 1024, 'KB')


if __name__ == '__main__':
    main()
