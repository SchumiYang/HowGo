"""Polygonize the wall layer into enclosed faces = candidate room polygons.

Reads data/tianmu/levels/<floor>/walls.geojson (layers wall + column + door) and
build/<floor>_classified.json (door closure segments). Door openings are closed with the
hinge -> closed-leaf segment, small gaps (< ~2*GAP) are bridged by buffering, and the free space
inside the outline is split into faces.

Output: build/<floor>_faces.geojson (Polygon, props {id, level, area_m2}) and build/<floor>_faces.png
Usage : python -I faces.py
"""
import json
import os

import numpy as np
from PIL import Image, ImageDraw
from shapely.geometry import LineString, Polygon, box, mapping
from shapely.ops import unary_union

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BUILD = os.path.join(ROOT, "build")
DATA = os.path.join(ROOT, "data", "tianmu", "levels")
GAP = 0.08          # m: buffer radius; closes gaps up to ~16 cm and fills wall double lines
MIN_AREA = 1.0      # m2
MIN_WIDTH = 0.5     # m: drop slivers thinner than this (wall cavities, partition gaps)


def faces(floor):
    fc = json.load(open(os.path.join(DATA, floor, "walls.geojson"), encoding="utf-8"))
    lines = [LineString(f["geometry"]["coordinates"]) for f in fc["features"]
             if f["properties"]["layer"] in ("wall", "column", "door")]
    cl = json.load(open(os.path.join(BUILD, f"{floor}_classified.json")))
    lines += [LineString(seg) for seg in cl["door_closures_m"]]
    barrier = unary_union([ln.buffer(GAP, resolution=4) for ln in lines])
    minx, miny, maxx, maxy = barrier.bounds
    free = box(minx - 1, miny - 1, maxx + 1, maxy + 1).difference(barrier)
    polys = list(free.geoms) if hasattr(free, "geoms") else [free]
    out = []
    for p in polys:
        # skip the exterior (touches the padded frame)
        if p.bounds[0] < minx - 0.5 or p.bounds[1] < miny - 0.5 or p.bounds[2] > maxx + 0.5 or p.bounds[3] > maxy + 0.5:
            continue
        p = p.buffer(GAP, join_style="mitre")       # give back the buffer: faces reach the wall lines
        if p.area < MIN_AREA or p.buffer(-MIN_WIDTH / 2).is_empty:
            continue
        p = p.simplify(0.03)
        out.append(p)
    out.sort(key=lambda p: (-p.centroid.y, p.centroid.x))
    feats = []
    for k, p in enumerate(out):
        feats.append({"type": "Feature",
                      "properties": {"id": f"{floor}-f{k:03d}", "level": floor, "area_m2": round(p.area, 2),
                                     "centroid": [round(p.centroid.x, 2), round(p.centroid.y, 2)]},
                      "geometry": json.loads(json.dumps(mapping(p)))})
    gj = {"type": "FeatureCollection", "name": f"tianmu-{floor}-faces",
          "properties": {"units": "m", "level": floor, "note": "candidate room polygons from wall polygonization"},
          "features": feats}
    json.dump(gj, open(os.path.join(BUILD, f"{floor}_faces.geojson"), "w", encoding="utf-8"), separators=(",", ":"))

    # preview: faces filled with random pastel colours over the walls
    x0, y0, x1, y1 = minx - 2, miny - 2, maxx + 2, maxy + 2
    s = 2000 / (x1 - x0)
    im = Image.new("RGB", (2000, int((y1 - y0) * s)), "white")
    d = ImageDraw.Draw(im)
    rng = np.random.default_rng(1)
    def px(c):
        return [((x - x0) * s, (y1 - y) * s) for x, y in c]
    for p in out:
        geoms = p.geoms if hasattr(p, "geoms") else [p]
        col = tuple(int(v) for v in rng.integers(150, 245, 3))
        for g in geoms:
            d.polygon(px(g.exterior.coords), fill=col)
            for hole in g.interiors:
                d.polygon(px(hole.coords), fill=(255, 255, 255))
    for ln in lines:
        d.line(px(ln.coords), fill=(0, 0, 0), width=1)
    for f in feats:
        if f["properties"]["area_m2"] > 8:
            cx, cy = f["properties"]["centroid"]
            d.text(((cx - x0) * s - 12, (y1 - cy) * s - 5), f"{f['properties']['area_m2']:.0f}", fill=(0, 0, 0))
    im.save(os.path.join(BUILD, f"{floor}_faces.png"))
    return out


if __name__ == "__main__":
    for fl in ("1F", "2F"):
        fs = faces(fl)
        a = sorted((p.area for p in fs), reverse=True)
        print(fl, len(fs), "faces; largest areas", [round(v, 1) for v in a[:8]])
