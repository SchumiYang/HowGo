"""Classify EMF primitives into layers, calibrate to metres, register 2F to 1F, write outputs.

Inputs : build/<floor>_prims.json  (from emf_extract.py, device units)
Outputs: build/transform.json, build/columns.json, build/calibration.json, build/<floor>.svg,
         build/<floor>_preview.png, build/<floor>_classified.json, data/tianmu/levels/<floor>/walls.geojson
Usage  : python -I build_map.py
"""
import json
import math
import os
from collections import Counter, defaultdict

import numpy as np
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BUILD = os.path.join(ROOT, "build")
DATA = os.path.join(ROOT, "data", "tianmu", "levels")
FLOORS = ["1F", "2F"]
COURT_M = (28.0, 15.0)        # FIBA court, inside edges of boundary lines
HALL_M = (57.62, 39.00)       # dimension annotations 5762 / 3900 (cm), arena hall interior
# Linework the classifier calls 'wall' that is not a wall, judged on the plan (metres, after calibration): every
# 'wall' primitive lying entirely inside the box gets the class instead. Keep each entry explained.
NOT_WALLS = {
    "1F": [
        # curved outline 1.9 m in front of the main entrance facade, closed against the facade with no door in it:
        # the canopy / eave edge above the ramp platform (the entrance doors are in the facade line x = 0)
        ((-2.0, 27.3, -1.0, 40.2), "canopy"),
    ],
}

LAYER_COLORS = {"wall": (20, 20, 20), "column": (200, 30, 30), "stairs": (30, 110, 220),
                "fixture": (0, 150, 140), "court": (230, 130, 0), "door": (160, 60, 200),
                "other": (175, 175, 175)}
# internal classes -> schema layer
CLASS_TO_LAYER = {"wall": "wall", "column": "column", "stairs": "stairs", "fixture": "fixture",
                  "court": "court", "door": "door", "text": "other", "dim": "other", "hatch": "other",
                  "seating": "other", "canopy": "other"}


# ----------------------------------------------------------------------------- geometry helpers
def load(floor):
    r = json.load(open(os.path.join(BUILD, f"{floor}_prims.json")))
    prims = []
    for p in r["prims"]:
        a = np.array(p["pts"], float)
        if p["closed"] and len(a) > 2 and not np.allclose(a[0], a[-1]):
            a = np.vstack([a, a[:1]])
        prims.append({"a": a, "closed": p["closed"], "w": p["width"], "idx": p["idx"],
                      "mn": a.min(0), "mx": a.max(0)})
    return r["header"], prims


def seg_info(p):
    """For 2-point (or collinear) primitives: (p0, p1, length, angle_deg in [0,180))."""
    a = p["a"]
    d = a[-1] - a[0]
    L = float(np.hypot(*d))
    ang = math.degrees(math.atan2(d[1], d[0])) % 180.0
    return a[0], a[-1], L, ang


def is_straight(p, tol):
    a = p["a"]
    if len(a) == 2:
        return True
    d = a[-1] - a[0]
    L = np.hypot(*d)
    if L < 1e-9:
        return False
    n = np.array([-d[1], d[0]]) / L
    return float(np.abs((a - a[0]) @ n).max()) < tol


def fit_circle(a):
    x, y = a[:, 0], a[:, 1]
    A = np.c_[2 * x, 2 * y, np.ones(len(a))]
    b = x * x + y * y
    (cx, cy, c), *_ = np.linalg.lstsq(A, b, rcond=None)
    r = math.sqrt(max(c + cx * cx + cy * cy, 0))
    res = np.abs(np.hypot(x - cx, y - cy) - r).max()
    return cx, cy, r, res


def umeyama(src, dst, scale=True):
    """Similarity dst ~ s R src + t."""
    ms, md = src.mean(0), dst.mean(0)
    xs, xd = src - ms, dst - md
    U, D, Vt = np.linalg.svd(xd.T @ xs / len(src))
    S = np.eye(2)
    if np.linalg.det(U) * np.linalg.det(Vt) < 0:
        S[1, 1] = -1
    R = U @ S @ Vt
    s = (D * np.diag(S)).sum() / xs.var(0).sum() if scale else 1.0
    t = md - s * R @ ms
    return s, R, t


# ----------------------------------------------------------------------------- columns (scale free)
def find_columns(prims):
    """Columns = axis-aligned closed squares; drawn as concentric pairs on a grid."""
    sq = []
    for i, p in enumerate(prims):
        if not p["closed"] or len(p["a"]) != 5:
            continue
        w, h = p["mx"] - p["mn"]
        if w > 2 and abs(w - h) < 0.06 * w:
            sq.append((i, (w + h) / 2, (p["mn"] + p["mx"]) / 2))
    # concentric pairs -> find the dominant (inner, outer) size combo
    cent = np.array([s[2] for s in sq])
    pairs = []
    for k, (i, side, c) in enumerate(sq):
        d = np.hypot(*(cent - c).T)
        for m in np.where((d < 0.3) & (np.arange(len(sq)) != k))[0]:
            if sq[m][1] > side * 1.1:
                pairs.append((round(side, 0), round(sq[m][1], 0)))
    (s_in, s_out), _ = Counter(pairs).most_common(1)[0]
    sizes = [s_in, s_out]
    cand = [(i, side, c) for i, side, c in sq if min(abs(side - s) for s in sizes) < 0.8]
    # report the measured mean side of each size class rather than the rounded vote key
    sizes = [float(np.mean([side for _, side, _ in cand if abs(side - s) < 0.8])) for s in sizes]
    # merge concentric squares into one column
    cols = []
    for i, side, c in cand:
        for col in cols:
            if np.hypot(*(col["c"] - c)) < 0.3 * s_out:
                col["members"].append(i)
                break
        else:
            cols.append({"c": c.copy(), "members": [i]})
    # grid alignment: keep columns sharing x or y with >=2 others
    C = np.array([c["c"] for c in cols])
    keep = []
    for k, c in enumerate(C):
        nx = (np.abs(C[:, 0] - c[0]) < 0.4 * s_out).sum() - 1
        ny = (np.abs(C[:, 1] - c[1]) < 0.4 * s_out).sum() - 1
        if nx >= 2 or ny >= 2:
            keep.append(cols[k])
    return keep, sizes


# ----------------------------------------------------------------------------- calibration (1F)
def calibrate_court(prims):
    """Find the court: closed rectangle with aspect ~28.1/15.1, then inner edges of boundary lines."""
    best = None
    for p in prims:
        if not p["closed"] or len(p["a"]) != 5:
            continue
        w, h = p["mx"] - p["mn"]
        if h > 0 and abs(w / h - 28.1 / 15.1) < 0.02 * 1.86 and w > 100:
            if best is None or w < best[0]:
                best = (w, p)
    _, rp = best
    x0, y0 = rp["mn"]
    x1, y1 = rp["mx"]
    tol = 0.006 * (x1 - x0)          # ~ 17 cm
    vs, hs, hseg = [], [], []
    for p in prims:
        if len(p["a"]) != 2:
            continue
        q0, q1, L, ang = seg_info(p)
        if L < 0.3 * (y1 - y0):
            continue
        if abs(ang - 90) < 0.5:
            vs.append(q0[0])
        elif ang < 0.5 or ang > 179.5:
            hs.append(q0[1])
            hseg.append((q0[1], min(q0[0], q1[0]), max(q0[0], q1[0])))
    vs, hs = np.array(vs), np.array(hs)
    left = vs[np.abs(vs - x0) < tol]
    right = vs[np.abs(vs - x1) < tol]
    top = hs[np.abs(hs - y0) < tol]
    bot = hs[np.abs(hs - y1) < tol]
    # the inner vertical edges are not drawn as separate segments: the inner horizontal edge lines
    # (top-most-inner / bottom-most-inner) run exactly between them, so take their x extent
    xs_in = [(a, b) for y, a, b in hseg if abs(y - top.max()) < 0.05 or abs(y - bot.min()) < 0.05]
    in_left = min(a for a, b in xs_in)
    in_right = max(b for a, b in xs_in)
    left = np.r_[left, in_left]
    right = np.r_[right, in_right]
    inner = (in_right - in_left, bot.min() - top.max())
    outer = (right.max() - left.min(), bot.max() - top.min())
    return {"court_box_dev": [float(x0), float(y0), float(x1), float(y1)],
            "edge_lines_x": sorted(set(np.round(np.r_[left, right], 2).tolist())),
            "edge_lines_y": sorted(set(np.round(np.r_[top, bot], 2).tolist())),
            "inner_dev": [float(v) for v in inner], "outer_dev": [float(v) for v in outer],
            "px_per_m_x": inner[0] / COURT_M[0], "px_per_m_y": inner[1] / COURT_M[1],
            "px_per_m_outer_x": outer[0] / (COURT_M[0] + 0.1), "px_per_m_outer_y": outer[1] / (COURT_M[1] + 0.1)}


def calibrate_hall(prims, court_box):
    """Dimension lines = the single long horizontal / vertical lines inside the hall that span
    nearly wall-to-wall; measure interior wall faces at their ends."""
    cx0, cy0, cx1, cy1 = court_box
    segs = []
    for i, p in enumerate(prims):
        if len(p["a"]) == 2:
            q0, q1, L, ang = seg_info(p)
            segs.append((i, q0, q1, L, ang))
    # horizontal dim line: longest horizontal 2-pt line above the court whose x-span contains the court
    hcand = [s for s in segs if (s[4] < 0.2 or s[4] > 179.8) and min(s[1][0], s[2][0]) < cx0 - 50
             and max(s[1][0], s[2][0]) > cx1 + 50 and s[1][1] < cy0]
    vcand = [s for s in segs if abs(s[4] - 90) < 0.2 and min(s[1][1], s[2][1]) < cy0 - 50
             and max(s[1][1], s[2][1]) > cy1 + 50 and s[1][0] > cx1]
    # pick the single (no parallel partner within 3 px) ones nearest to the court
    def single(s, cands):
        return not any(o is not s and abs(o[3] - s[3]) < 0.05 * s[3] and
                       np.hypot(*(o[1] - s[1])) < 3 for o in cands)
    hd = min((s for s in hcand if single(s, hcand)), key=lambda s: cy0 - s[1][1])
    vd = min((s for s in vcand if single(s, vcand)), key=lambda s: s[1][0] - cx1)
    hy = hd[1][1]
    xl, xr = sorted([hd[1][0], hd[2][0]])
    vx = vd[1][0]
    yt, yb = sorted([vd[1][1], vd[2][1]])
    # wall faces: vertical lines spanning y=hy near xl / xr ; horizontal lines spanning x=vx near yt / yb
    near = 12.0  # px (~1 m)
    lf = [s[1][0] for s in segs if abs(s[4] - 90) < 0.3 and abs(s[1][0] - xl) < near
          and min(s[1][1], s[2][1]) <= hy <= max(s[1][1], s[2][1]) and s[0] != vd[0]]
    rf = [s[1][0] for s in segs if abs(s[4] - 90) < 0.3 and abs(s[1][0] - xr) < near
          and min(s[1][1], s[2][1]) <= hy <= max(s[1][1], s[2][1]) and s[0] != vd[0]]
    tf = [s[1][1] for s in segs if (s[4] < 0.3 or s[4] > 179.7) and abs(s[1][1] - yt) < near
          and min(s[1][0], s[2][0]) <= vx <= max(s[1][0], s[2][0]) and s[0] != hd[0]]
    bf = [s[1][1] for s in segs if (s[4] < 0.3 or s[4] > 179.7) and abs(s[1][1] - yb) < near
          and min(s[1][0], s[2][0]) <= vx <= max(s[1][0], s[2][0]) and s[0] != hd[0]]
    interior = (min(rf) - max(lf), min(bf) - max(tf))
    outer = (max(rf) - min(lf), max(bf) - min(tf))
    return {"dim_line_h_dev": [xl, hy, xr, hy], "dim_line_v_dev": [vx, yt, vx, yb],
            "dim_line_idx": [hd[0], vd[0]],
            "wall_faces_x_left": sorted(lf), "wall_faces_x_right": sorted(rf),
            "wall_faces_y_top": sorted(tf), "wall_faces_y_bottom": sorted(bf),
            "interior_dev": list(interior), "outer_dev": list(outer),
            "dim_line_len_dev": [xr - xl, yb - yt],
            "px_per_m_x": interior[0] / HALL_M[0], "px_per_m_y": interior[1] / HALL_M[1],
            "px_per_m_dimline_x": (xr - xl) / HALL_M[0], "px_per_m_dimline_y": (yb - yt) / HALL_M[1],
            "hall_box_dev": [max(lf), max(tf), min(rf), min(bf)]}


# ----------------------------------------------------------------------------- classification
def classify(prims, S, columns, floor, hall_box=None, court_box=None, dim_idx=(), doors_out=None):
    """S = device px per metre. Returns list of class names. If doors_out is a list, appends
    (hinge, closed_end) device points per door leaf: the segment closing the door opening."""
    n = len(prims)
    cls = [None] * n
    size = np.array([np.max(p["mx"] - p["mn"]) / S for p in prims])
    for i, p in enumerate(prims):
        if size[i] < 0.02:
            cls[i] = "junk"
    for col in columns:
        for i in col["members"]:
            cls[i] = "column"
    for i in dim_idx:
        cls[i] = "dim"

    # doors: leaf = thin closed rectangle 0.5-1.7 m long; swing = open polyline (coarse arc) starting
    # at the leaf's free end whose points all stay ~leaf-length from the hinge
    ends = []   # (hinge, free_end, length, leaf index)
    for i, p in enumerate(prims):
        a = p["a"]
        if cls[i] or not p["closed"] or len(a) != 5:
            continue
        e = np.hypot(*np.diff(a[:4], axis=0, append=a[:1]).T)
        long_, short = max(e), min(e)
        if not (0.5 * S < long_ < 1.7 * S and short < 0.12 * S):
            continue
        k = int(np.argmin(e))                      # a short edge: a[k] -> a[k+1]
        m0 = (a[k] + a[(k + 1) % 4]) / 2
        m1 = (a[(k + 2) % 4] + a[(k + 3) % 4]) / 2
        ends += [(m0, m1, long_, i), (m1, m0, long_, i)]
    if ends:
        F = np.array([e[1] for e in ends])
        for i, p in enumerate(prims):
            a = p["a"]
            if cls[i] or p["closed"] or not 3 <= len(a) <= 40 or size[i] > 2.0:
                continue
            for end in (a[0], a[-1]):
                dd = np.hypot(*(F - end).T)
                k = int(np.argmin(dd))
                if dd[k] > 0.15 * S:
                    continue
                hinge, free, L, li = ends[k]
                r = np.hypot(*(a - hinge).T)
                if np.all(np.abs(r - L) < 0.2 * L):
                    cls[i] = cls[li] = "door"
                    if doors_out is not None:
                        other = a[-1] if end is a[0] else a[0]
                        doors_out.append((hinge.tolist(), other.tolist()))
                    break

    # stairs: >=5 parallel equal-length straight segments 0.8-4 m long spaced 0.22-0.40 m
    groups = defaultdict(list)
    for i, p in enumerate(prims):
        if cls[i] or len(p["a"]) > 3 or not is_straight(p, 0.02 * S):
            continue
        q0, q1, L, ang = seg_info(p)
        Lm = L / S
        if not 0.8 < Lm < 4.5:
            continue
        a_r = math.radians(ang)
        u = np.array([math.cos(a_r), math.sin(a_r)])
        nrm = np.array([-u[1], u[0]])
        s0, s1 = sorted([q0 @ u, q1 @ u])
        key = (round(ang / 2) % 90, round(s0 / S / 0.25), round(s1 / S / 0.25))
        groups[key].append((float((q0 @ nrm) / S), i))
    for key, items in groups.items():
        if len(items) < 5:
            continue
        items.sort()
        run = [items[0]]
        for it in items[1:] + [(1e9, -1)]:
            gap = it[0] - run[-1][0]
            if 0.2 < gap < 0.42:
                run.append(it)
            elif gap <= 0.2 and it[1] >= 0:
                continue   # double line of the same tread
            else:
                if len(run) >= 5:
                    for _, j in run:
                        cls[j] = "stairs"
                run = [it]

    # 1F arena floor: everything strictly inside the hall interior is court marking
    if hall_box is not None:
        hx0, hy0, hx1, hy1 = hall_box
        m = 0.4 * S
        for i, p in enumerate(prims):
            if cls[i]:
                continue
            if p["mn"][0] > hx0 + m and p["mx"][0] < hx1 - m and p["mn"][1] > hy0 + m and p["mx"][1] < hy1 - m:
                cls[i] = "court_tmp"

    # text: consecutive runs (drawing order) of small open strokes in a compact cluster
    small = [cls[i] in (None, "court_tmp") and not prims[i]["closed"] and size[i] < 2.0 for i in range(n)]
    runs, cur, box = [], [], None
    gap = 0.5 * S
    for i in range(n):
        p = prims[i]
        if small[i]:
            if cur and (p["mn"][0] > box[2] + gap or p["mx"][0] < box[0] - gap or
                        p["mn"][1] > box[3] + gap or p["mx"][1] < box[1] - gap):
                runs.append(cur)
                cur = []
            if not cur:
                box = [*p["mn"], *p["mx"]]
            box = [min(box[0], p["mn"][0]), min(box[1], p["mn"][1]), max(box[2], p["mx"][0]), max(box[3], p["mx"][1])]
            cur.append(i)
        elif cls[i] == "junk":
            continue
        elif cur:
            runs.append(cur)
            cur = []
    if cur:
        runs.append(cur)
    text_boxes = []

    def signature(run):
        A = np.vstack([prims[i]["a"] for i in run])
        w, h = (A.max(0) - A.min(0)) / S
        return (len(run), round(w / 0.05), round(h / 0.05))
    sig_count = Counter(signature(r) for r in runs if len(r) >= 3)
    for run in runs:
        if len(run) < 3:
            continue
        # repeated identical compact clusters containing a curve = fixtures (WC pans, urinals, basins)
        if sig_count[signature(run)] >= 3 and any(len(prims[i]["a"]) >= 8 for i in run):
            A = np.vstack([prims[i]["a"] for i in run])
            if np.max(A.max(0) - A.min(0)) / S < 1.2:
                for i in run:
                    cls[i] = "fixture"
                continue
        A = np.vstack([prims[i]["a"] for i in run])
        w, h = (A.max(0) - A.min(0)) / S
        sizes = size[run]
        # straight long strokes dominating -> not text (wall stubs, partitions)
        lo, hi = max(min(w, h), 0.05), max(w, h, 0.05)
        dense = len(run) / max(w * h, 0.05) > 2.0 or (len(run) >= 4 and len(run) * lo / hi > 2.5)
        # sanitary fixtures (WC pans, basins, urinals) are also runs of small strokes, but are
        # drawn mostly with many-vertex curves and are compact rather than laid out in a line
        npts = np.array([len(prims[i]["a"]) for i in run])
        lens = np.array([np.hypot(*np.diff(prims[i]["a"], axis=0).T).sum() for i in run])
        curvy = lens[npts >= 8].sum() / max(lens.sum(), 1e-9)
        if curvy > 0.5 and hi / lo < 2.5 and hi < 1.6:
            for i in run:
                cls[i] = "fixture"
            continue
        if lo <= 2.2 and np.median(sizes) < 1.0 and dense:
            for i in run:
                cls[i] = "text"
            text_boxes.append((*A.min(0), *A.max(0)))
    # closed glyph parts (e.g. small boxes inside CJK characters) lying inside a text cluster
    if text_boxes:
        TB = np.array(text_boxes)
        m = 0.1 * S
        for i, p in enumerate(prims):
            if cls[i] is None and p["closed"] and size[i] < 0.6:
                if np.any((p["mn"][0] > TB[:, 0] - m) & (p["mx"][0] < TB[:, 2] + m) &
                          (p["mn"][1] > TB[:, 1] - m) & (p["mx"][1] < TB[:, 3] + m)):
                    cls[i] = "text"

    # hatch / shaft crosses / void X: diagonal straight singles (no parallel partner) longer than 1.5 m
    segs = [(i, *seg_info(prims[i])) for i in range(n)
            if cls[i] is None and is_straight(prims[i], 0.02 * S) and len(prims[i]["a"]) <= 3]
    diag = [s for s in segs if 3 < (s[4] % 90) < 87 and s[3] / S > 1.5]
    for s in diag:
        i, q0, q1, L, ang = s
        u = (q1 - q0) / L
        nrm = np.array([-u[1], u[0]])
        partner = False
        for t in diag:
            if t[0] == i or abs(t[4] - ang) > 1.0:
                continue
            off = abs((t[1] - q0) @ nrm) / S
            along = (t[1] - q0) @ u, (t[2] - q0) @ u
            if 0.03 < off < 0.6 and max(along) > 0 and min(along) < L:
                partner = True
                break
        if not partner:
            cls[i] = "hatch"

    # box of a shaft / void / overhead-equipment X: the single-line outline whose corners are the ends of two crossing
    # hatch diagonals. It is a symbol (often drawn across real walls and corridors, e.g. the 1F east corridor), not a
    # wall; the real walls around it are double lines and stay. Elevator cars are drawn the same way.
    xs = [s for s in diag if cls[s[0]] == "hatch"]
    boxes = []
    for a_i in range(len(xs)):
        for b_i in range(a_i + 1, len(xs)):
            (_, p0, p1, la, ang_a), (_, q0, q1, lb, ang_b) = xs[a_i], xs[b_i]
            if abs(la - lb) > 0.05 * max(la, lb) or abs(ang_a - ang_b) < 5:
                continue
            if np.hypot(*((p0 + p1) / 2 - (q0 + q1) / 2)) > 0.15 * S:
                continue  # not crossing at their midpoints
            P = np.array([p0, p1, q0, q1])
            boxes.append((P.min(0), P.max(0)))
    # a closed rectangle with a single corner-to-corner hatch diagonal (1F elevator car #1) is the same symbol
    for _, p0, p1, _, _ in xs:
        mn, mx = np.minimum(p0, p1), np.maximum(p0, p1)
        for i, p in enumerate(prims):
            if cls[i] is None and p["closed"] and len(p["a"]) == 5 and \
                    np.all(np.abs(p["mn"] - mn) < 0.12 * S) and np.all(np.abs(p["mx"] - mx) < 0.12 * S):
                boxes.append((mn, mx))
                break
    tol = 0.12 * S
    for mn, mx in boxes:
        for i, p in enumerate(prims):
            if cls[i] is not None or size[i] < 0.5 or np.any(p["mn"] < mn - tol) or np.any(p["mx"] > mx + tol):
                continue
            a = p["a"]
            on_edge = np.minimum(np.minimum(np.abs(a[:, 0] - mn[0]), np.abs(a[:, 0] - mx[0])),
                                 np.minimum(np.abs(a[:, 1] - mn[1]), np.abs(a[:, 1] - mx[1])))
            if np.all(on_edge < tol):
                cls[i] = "hatch"

    # fixtures: remaining small closed shapes and small curvy polylines
    for i, p in enumerate(prims):
        if cls[i] is not None:
            continue
        if p["closed"] and size[i] < 1.6:
            cls[i] = "fixture"
        elif not p["closed"] and len(p["a"]) >= 6 and size[i] < 1.2:
            cls[i] = "fixture"

    for i in range(n):
        if cls[i] == "court_tmp":
            cls[i] = "court"
        elif cls[i] is None:
            cls[i] = "court" if floor == "1F" and court_box is not None and inside(prims[i], court_box, 3 * S) else "wall"
    return cls


def enclosure(prims, cls, C, S):
    """Exterior wall faces outside the outermost strong column lines (>= 4 columns per line)."""
    def lines(v):
        v = np.sort(v)
        groups = [[v[0]]]
        for x in v[1:]:
            if x - groups[-1][-1] < 0.3 * S:
                groups[-1].append(x)
            else:
                groups.append([x])
        return [np.mean(g) for g in groups if len(g) >= 4]
    gx, gy = lines(C[:, 0]), lines(C[:, 1])
    walls = [seg_info(p) for p, c in zip(prims, cls) if c == "wall" and len(p["a"]) == 2]
    vert = [(q0[0], L) for q0, q1, L, ang in walls if abs(ang - 90) < 0.5 and L > 2 * S]
    hor = [(q0[1], L) for q0, q1, L, ang in walls if (ang < 0.5 or ang > 179.5) and L > 2 * S]
    xmin = min(x for x, L in vert if gx[0] - 1.2 * S < x <= gx[0])
    xmax = max(x for x, L in vert if gx[-1] <= x < gx[-1] + 1.2 * S)
    ymin = min(y for y, L in hor if gy[0] - 1.2 * S < y <= gy[0])
    ymax = max(y for y, L in hor if gy[-1] <= y < gy[-1] + 1.2 * S)
    return xmin, xmax, ymin, ymax


def inside(p, box, m):
    return p["mn"][0] > box[0] - m and p["mx"][0] < box[2] + m and p["mn"][1] > box[1] - m and p["mx"][1] < box[3] + m


# ----------------------------------------------------------------------------- outputs
def to_m(T, a):
    return a @ T[:, :2].T + T[:, 2]


def write_geojson(floor, prims, cls, T):
    feats = []
    for p, c in zip(prims, cls):
        if c == "junk":
            continue
        coords = np.round(to_m(T, p["a"]), 2)
        if c == "wall":
            for (x0, y0, x1, y1), kind in NOT_WALLS.get(floor, []):
                if coords[:, 0].min() >= x0 and coords[:, 0].max() <= x1 and coords[:, 1].min() >= y0 and coords[:, 1].max() <= y1:
                    c = kind
        layer = CLASS_TO_LAYER[c]
        # drop consecutive duplicates after rounding
        keep = np.r_[True, np.any(np.diff(coords, axis=0) != 0, axis=1)]
        coords = coords[keep]
        if len(coords) < 2:
            continue
        props = {"layer": layer}
        if c in ("text", "dim", "hatch", "seating", "canopy"):
            props["kind"] = c
        feats.append({"type": "Feature", "properties": props,
                      "geometry": {"type": "LineString", "coordinates": coords.tolist()}})
    os.makedirs(os.path.join(DATA, floor), exist_ok=True)
    with open(os.path.join(DATA, floor, "walls.geojson"), "w", encoding="utf-8") as f:
        json.dump({"type": "FeatureCollection", "name": f"tianmu-{floor}-walls",
                   "properties": {"units": "m", "level": floor}, "features": feats}, f, separators=(",", ":"))
    return Counter(ft["properties"]["layer"] for ft in feats)


def write_svg(floor, prims, cls, T, view):
    x0, y0, x1, y1 = view
    order = ["other", "court", "fixture", "stairs", "door", "wall", "column"]
    by = defaultdict(list)
    for p, c in zip(prims, cls):
        if c == "junk":
            continue
        a = to_m(T, p["a"])
        d = "M" + " L".join(f"{x:.2f},{-y:.2f}" for x, y in a)
        by[CLASS_TO_LAYER[c]].append(d)
    vb = f"{x0:.2f} {-y1:.2f} {x1 - x0:.2f} {y1 - y0:.2f}"
    out = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{vb}" '
           f'width="{(x1 - x0) * 20:.0f}" height="{(y1 - y0) * 20:.0f}">',
           f'<!-- Tianmu gymnasium {floor}. Units: metres, local frame (origin = SW corner of 1F building '
           f'outline, y up). SVG y = -y_local. Toggle layers via the <g id> groups. -->',
           f'<rect x="{x0:.2f}" y="{-y1:.2f}" width="{x1 - x0:.2f}" height="{y1 - y0:.2f}" fill="white"/>',
           '<g fill="none" stroke-linecap="round" stroke-linejoin="round">']
    widths = {"wall": 0.08, "column": 0.08, "door": 0.04, "stairs": 0.04, "fixture": 0.03, "court": 0.05, "other": 0.03}
    for layer in order:
        r, g, b = LAYER_COLORS[layer]
        out.append(f'<g id="{layer}" stroke="rgb({r},{g},{b})" stroke-width="{widths[layer]}">')
        out += [f'<path d="{d}"/>' for d in by[layer]]
        out.append("</g>")
    out.append("</g></svg>")
    open(os.path.join(BUILD, f"{floor}.svg"), "w", encoding="utf-8").write("\n".join(out))


def render_preview(floor, prims, cls, T, view, path, width=2000, only=None, crop=None, cols_m=None, title=""):
    x0, y0, x1, y1 = crop if crop else view
    s = width / (x1 - x0)
    hgt = int((y1 - y0) * s)
    band = 0 if crop else 40
    im = Image.new("RGB", (width, hgt + band), "white")
    d = ImageDraw.Draw(im)

    def px(x, y):
        return ((x - x0) * s, (y1 - y) * s)
    order = ["other", "court", "fixture", "stairs", "door", "wall", "column"]
    for layer in order:
        for p, c in zip(prims, cls):
            if c == "junk" or CLASS_TO_LAYER[c] != layer or (only and c not in only):
                continue
            pts = [px(x, y) for x, y in to_m(T, p["a"])]
            d.line(pts, fill=LAYER_COLORS[layer], width=2 if layer in ("wall", "column") else 1)
    if cols_m is not None:
        for x, y in cols_m:
            X, Y = px(x, y)
            d.ellipse([X - 3, Y - 3, X + 3, Y + 3], outline=(255, 0, 0))
    try:
        font = ImageFont.truetype("arial.ttf", 18)
    except OSError:
        font = ImageFont.load_default()
    if not crop:
        # axes at origin and 10 m scale bar
        ox, oy = px(0, 0)
        d.line([(ox, oy), (ox + 5 * s, oy)], fill=(220, 0, 0), width=3)
        d.line([(ox, oy), (ox, oy - 5 * s)], fill=(0, 160, 0), width=3)
        d.text((ox + 5 * s + 4, oy - 10), "x", fill=(220, 0, 0), font=font)
        d.text((ox - 4, oy - 5 * s - 24), "y", fill=(0, 160, 0), font=font)
        d.text((ox + 4, oy + 4), "(0,0)", fill=(0, 0, 0), font=font)
        # bottom band: legend, title, 10 m scale bar
        ly = hgt + 10
        lx = 10
        for layer in order[::-1]:
            d.rectangle([lx, ly + 4, lx + 22, ly + 14], fill=LAYER_COLORS[layer])
            d.text((lx + 28, ly), layer, fill=(0, 0, 0), font=font)
            lx += 110
        d.text((lx + 10, ly), title, fill=(0, 0, 0), font=font)
        bx = width - 10 * s - 70
        d.rectangle([bx, ly + 4, bx + 10 * s, ly + 12], fill=(0, 0, 0))
        for k in range(0, 11, 5):
            d.line([(bx + k * s, ly), (bx + k * s, ly + 16)], fill=(0, 0, 0), width=2)
        d.text((bx + 10 * s + 8, ly), "10 m", fill=(0, 0, 0), font=font)
    im.save(path)


# ----------------------------------------------------------------------------- main
def main():
    data = {f: load(f) for f in FLOORS}
    cols_dev = {}
    for f in FLOORS:
        cols, sizes = find_columns(data[f][1])
        cols_dev[f] = (cols, sizes)
        print(f, "columns:", len(cols), "square sizes (px)", sizes)

    # ---- scale calibration on 1F
    P1 = data["1F"][1]
    court = calibrate_court(P1)
    hall = calibrate_hall(P1, court["court_box_dev"])
    S1 = (court["px_per_m_x"] + court["px_per_m_y"]) / 2
    S_hall = (hall["px_per_m_x"] + hall["px_per_m_y"]) / 2
    calib = {"court": court, "hall": hall, "S1_px_per_m_used": S1,
             "discrepancy_pct": 100 * (S_hall - S1) / S1}
    print("court px/m x=%.4f y=%.4f | hall interior px/m x=%.4f y=%.4f | discrepancy %.2f%%" % (
        court["px_per_m_x"], court["px_per_m_y"], hall["px_per_m_x"], hall["px_per_m_y"], calib["discrepancy_pct"]))

    # ---- register 2F columns to 1F columns (similarity, device -> device)
    C1 = np.array([c["c"] for c in cols_dev["1F"][0]])
    C2 = np.array([c["c"] for c in cols_dev["2F"][0]])

    def grid_spacing(C):
        """Median gap between consecutive distinct column lines (x and y)."""
        gaps = []
        for k in (0, 1):
            v = np.sort(C[:, k])
            lines = [v[0]]
            for x in v[1:]:
                if x - lines[-1] > 3:
                    lines.append(x)
            gaps += np.diff(lines).tolist()
        gaps = np.array(gaps)
        # most common gap = the regular bay width
        votes = [(np.abs(gaps - g) < 0.01 * g).sum() for g in gaps]
        g0 = gaps[int(np.argmax(votes))]
        return float(np.median(gaps[np.abs(gaps - g0) < 0.01 * g0]))
    s0 = grid_spacing(C1) / grid_spacing(C2)
    best = None
    # translation search: try aligning every 2F column to every 1F column at scale s0, score inliers
    for j in range(len(C2)):
        for k in range(len(C1)):
            t = C1[k] - s0 * C2[j]
            Q = s0 * C2 + t
            d = np.hypot(Q[:, None, 0] - C1[None, :, 0], Q[:, None, 1] - C1[None, :, 1]).min(1)
            score = (d < 0.5 * S1).sum()
            if best is None or score > best[0]:
                best = (score, t)
    s, R, t = s0, np.eye(2), best[1]
    for _ in range(20):
        Q = s * C2 @ R.T + t
        d = np.hypot(Q[:, None, 0] - C1[None, :, 0], Q[:, None, 1] - C1[None, :, 1])
        nn = d.argmin(1)
        ok = d[np.arange(len(C2)), nn] < 0.5 * S1
        # one-to-one
        s, R, t = umeyama(C2[ok], C1[nn[ok]])
    Q = s * C2 @ R.T + t
    d = np.hypot(Q[:, None, 0] - C1[None, :, 0], Q[:, None, 1] - C1[None, :, 1])
    nn = d.argmin(1)
    res = d[np.arange(len(C2)), nn]
    ok = res < 0.5 * S1
    rms_m = float(np.sqrt((res[ok] ** 2).mean()) / S1)
    rot_deg = math.degrees(math.atan2(R[1, 0], R[0, 0]))
    reg = {"scale_2F_to_1F_device": float(s), "rotation_deg": rot_deg, "t_dev": t.tolist(),
           "matched": int(ok.sum()), "n_cols_1F": len(C1), "n_cols_2F": len(C2),
           "rms_m": rms_m, "max_m": float(res[ok].max() / S1),
           "unmatched_2F_dev": C2[~ok].round(1).tolist()}
    S2 = S1 / s    # 2F device px per metre (1F_dev = s * 2F_dev)
    print("register: s=%.5f rot=%.4f deg matched %d/%d (1F has %d) rms %.3f m max %.3f m" % (
        s, rot_deg, ok.sum(), len(C2), len(C1), rms_m, reg["max_m"]))

    # ---- classify
    cls = {}
    doors = {"1F": [], "2F": []}
    cls["1F"] = classify(P1, S1, cols_dev["1F"][0], "1F", hall_box=hall["hall_box_dev"],
                         court_box=court["court_box_dev"], dim_idx=hall["dim_line_idx"], doors_out=doors["1F"])
    cls["2F"] = classify(data["2F"][1], S2, cols_dev["2F"][0], "2F", doors_out=doors["2F"])

    # ---- frame: origin = bottom-left of the 1F building outline bbox. The outline is the main
    # enclosure: exterior wall faces just outside the outermost column grid lines (the detached
    # entrance platforms / outdoor stairs west, north and south are outside it).
    xmin, xmax, ymin, ymax = enclosure(P1, cls["1F"], C1, S1)
    A = np.array([[xmin, ymin], [xmax, ymax]])
    T1 = np.array([[1 / S1, 0, -xmin / S1], [0, -1 / S1, ymax / S1]])
    # 2F: dev2 -> dev1 = s R x + t, then T1
    M2 = np.c_[s * R, t]
    T2 = T1[:, :2] @ M2
    T2 = np.c_[T2[:, :2], T1[:, :2] @ M2[:, 2] + T1[:, 2]]
    T = {"1F": T1, "2F": T2}
    ext1 = to_m(T1, A)
    W, H = ext1.max(0)
    print("1F extent %.2f x %.2f m" % (W, H))
    exts = {}
    for f in FLOORS:
        B = np.vstack([p["a"] for p, c in zip(data[f][1], cls[f]) if c != "junk"])
        Bm = to_m(T[f], B)
        exts[f] = (Bm.min(0).tolist(), Bm.max(0).tolist())
    view = (min(e[0][0] for e in exts.values()) - 2, min(e[0][1] for e in exts.values()) - 2,
            max(e[1][0] for e in exts.values()) + 2, max(e[1][1] for e in exts.values()) + 2)

    tr = {"frame": "metres, x right / y up on 1F drawing, origin = bottom-left of 1F building outline bbox",
          "source_units": "EMF device units (after world transform), i.e. the unit of the EMF header bounds",
          "apply": "[x_m, y_m] = A @ [x_dev, y_dev] + b ; matrix stored as [[a11,a12,b1],[a21,a22,b2]]"}
    for f in FLOORS:
        hdr = data[f][0]
        tr[f] = {"device_to_m": T[f].tolist(), "emf_base_world_xform": hdr["set_xforms"][0] if hdr["set_xforms"] else None,
                 "emf_bounds": hdr["bounds"], "px_per_m": S1 if f == "1F" else S2,
                 "extent_m_all_geometry": exts[f]}
    tr["2F"]["registration"] = reg
    json.dump(tr, open(os.path.join(BUILD, "transform.json"), "w"), indent=1)
    json.dump(calib, open(os.path.join(BUILD, "calibration.json"), "w"), indent=1, default=float)

    colsj = {}
    for f in FLOORS:
        Cm = to_m(T[f], np.array([c["c"] for c in cols_dev[f][0]]))
        colsj[f] = {"count": len(Cm), "square_sides_m": [v / (S1 if f == "1F" else S2) for v in cols_dev[f][1]],
                    "centres": np.round(Cm, 3).tolist()}
    colsj["registration"] = reg
    json.dump(colsj, open(os.path.join(BUILD, "columns.json"), "w"), indent=1)

    for f in FLOORS:
        P = data[f][1]
        counts = write_geojson(f, P, cls[f], T[f])
        print(f, "class counts", dict(Counter(cls[f])), "-> geojson layers", dict(counts))
        write_svg(f, P, cls[f], T[f], view)
        render_preview(f, P, cls[f], T[f], view, os.path.join(BUILD, f"{f}_preview.png"),
                       cols_m=to_m(T[f], np.array([c["c"] for c in cols_dev[f][0]])),
                       title=f"{f}   building outline {W:.1f} m x {H:.1f} m   (red circles = column centres)")
        json.dump({"classes": cls[f], "idx": [p["idx"] for p in P],
                   "door_closures_m": [to_m(T[f], np.array(dc)).round(3).tolist() for dc in doors[f]]},
                  open(os.path.join(BUILD, f"{f}_classified.json"), "w"))
    # registration check: both floors' walls + columns overlaid
    vx0, vy0, vx1, vy1 = view
    sc = 2000 / (vx1 - vx0)
    im = Image.new("RGB", (2000, int((vy1 - vy0) * sc)), "white")
    dd = ImageDraw.Draw(im)
    for f, colr in (("1F", (0, 0, 0)), ("2F", (0, 120, 255))):
        for p, c in zip(data[f][1], cls[f]):
            if c in ("wall", "column"):
                a = to_m(T[f], p["a"])
                dd.line([((x - vx0) * sc, (vy1 - y) * sc) for x, y in a], fill=colr, width=1)
    im.save(os.path.join(BUILD, "registration_check.png"))
    return data, cls, T, (W, H)


if __name__ == "__main__":
    main()
