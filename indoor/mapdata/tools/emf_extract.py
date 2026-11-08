"""Extract vector primitives from an EMF file.

Walks every record, tracks world transform (SETWORLDTRANSFORM, MODIFYWORLDTRANSFORM
modes 1-4, SAVEDC/RESTOREDC), object table (pens, brushes, stock objects) and emits
every drawn primitive in device units (the unit of the EMF header `bounds`) with its
pen colour / width and closed flag.

Usage:  python -I emf_extract.py in.emf out.json
Output: {"header": {...}, "prims": [{"pts": [[x,y],...], "closed": bool,
         "color": "#rrggbb", "width": float (device units), "style": int,
         "rec": int (record type), "idx": int (record index)}], "unhandled": {type: count}}
"""
import json
import math
import struct
import sys
from collections import Counter

STOCK_NAMES = {
    0: "WHITE_BRUSH", 1: "LTGRAY_BRUSH", 2: "GRAY_BRUSH", 3: "DKGRAY_BRUSH", 4: "BLACK_BRUSH",
    5: "NULL_BRUSH", 6: "WHITE_PEN", 7: "BLACK_PEN", 8: "NULL_PEN", 10: "OEM_FIXED_FONT",
    11: "ANSI_FIXED_FONT", 12: "ANSI_VAR_FONT", 13: "SYSTEM_FONT", 14: "DEVICE_DEFAULT_FONT",
    15: "DEFAULT_PALETTE", 16: "SYSTEM_FIXED_FONT", 17: "DEFAULT_GUI_FONT", 18: "DC_BRUSH", 19: "DC_PEN",
}
STOCK_PENS = {6: (0xFFFFFF, 0.0, 0), 7: (0x000000, 0.0, 0), 8: (None, 0.0, 5)}

IDENT = (1.0, 0.0, 0.0, 1.0, 0.0, 0.0)  # eM11 eM12 eM21 eM22 eDx eDy


def mul(a, b):
    """Return a*b for XFORMs (row-vector convention: p' = p * M)."""
    a11, a12, a21, a22, ax, ay = a
    b11, b12, b21, b22, bx, by = b
    return (a11 * b11 + a12 * b21, a11 * b12 + a12 * b22,
            a21 * b11 + a22 * b21, a21 * b12 + a22 * b22,
            ax * b11 + ay * b21 + bx, ax * b12 + ay * b22 + by)


def apply(m, pts):
    m11, m12, m21, m22, dx, dy = m
    return [(x * m11 + y * m21 + dx, x * m12 + y * m22 + dy) for x, y in pts]


def colorref(c):
    r, g, b = c & 0xFF, (c >> 8) & 0xFF, (c >> 16) & 0xFF
    return "#%02x%02x%02x" % (r, g, b)


def bezier(p0, p1, p2, p3, n=12):
    out = []
    for i in range(1, n + 1):
        t = i / n
        u = 1 - t
        out.append((u ** 3 * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t ** 3 * p3[0],
                    u ** 3 * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t ** 3 * p3[1]))
    return out


def ellipse_pts(l, t, r, b, a0=0.0, a1=2 * math.pi, n=48):
    cx, cy, rx, ry = (l + r) / 2, (t + b) / 2, abs(r - l) / 2, abs(b - t) / 2
    k = max(4, int(n * abs(a1 - a0) / (2 * math.pi)))
    return [(cx + rx * math.cos(a0 + (a1 - a0) * i / k), cy - ry * math.sin(a0 + (a1 - a0) * i / k))
            for i in range(k + 1)]


def extract(path):
    d = open(path, "rb").read()
    hdr = struct.unpack_from("<4i4i", d, 8)
    dev = struct.unpack_from("<2i2i", d, 72)
    header = {"bounds": hdr[:4], "frame_01mm": hdr[4:], "device_px": dev[:2], "device_mm": dev[2:]}

    xf = IDENT
    objs = {}
    pen = (0x000000, 0.0, 0)
    brush = None
    stack = []
    cur = (0.0, 0.0)  # current position, logical units
    path_active = False
    path_figs = []
    fig = None
    prims = []
    unhandled = Counter()
    header["set_xforms"] = []  # absolute transforms (SETWORLDTRANSFORM / MWT_SET), in order

    def emit(lpts, closed, rec, idx, xform=None):
        m = xform or xf
        if pen[0] is None or len(lpts) < 2:
            return
        dpts = apply(m, lpts)
        scale = math.sqrt(abs(m[0] * m[3] - m[1] * m[2]))
        prims.append({"pts": [[round(x, 4), round(y, 4)] for x, y in dpts], "closed": bool(closed),
                      "color": colorref(pen[0]), "width": round(pen[1] * scale, 4), "style": pen[2],
                      "rec": rec, "idx": idx})

    def figure_add(lpts, rec, idx, closed=False):
        """Route geometry to the open path bracket or straight to output."""
        nonlocal fig
        if path_active:
            if fig is None:
                fig = {"pts": [cur], "closed": False}
                path_figs.append(fig)
            fig["pts"].extend(lpts)
        else:
            emit([cur] + list(lpts), closed, rec, idx)

    off = 0
    idx = 0
    while off < len(d):
        t, size = struct.unpack_from("<II", d, off)
        body = off + 8
        if t == 14:  # EOF
            break
        if t in (86, 87, 85, 88, 89):  # POLYGON16, POLYLINE16, POLYBEZIER16, POLYBEZIERTO16, POLYLINETO16
            n = struct.unpack_from("<I", d, body + 16)[0]
            raw = struct.unpack_from("<%dh" % (2 * n), d, body + 20)
            pts = list(zip(raw[0::2], raw[1::2]))
            if t == 85:
                out = [pts[0]]
                for i in range(1, n - 2, 3):
                    out += bezier(out[-1], pts[i], pts[i + 1], pts[i + 2])
                pts = out
                (path_figs.append({"pts": pts, "closed": False}) if path_active else emit(pts, False, t, idx))
            elif t in (88, 89):
                if t == 88:
                    out = []
                    p = cur
                    for i in range(0, n - 2, 3):
                        seg = bezier(p, pts[i], pts[i + 1], pts[i + 2])
                        out += seg
                        p = seg[-1]
                    pts = out
                figure_add(pts, t, idx)
                cur = pts[-1]
            elif path_active:
                path_figs.append({"pts": pts, "closed": t == 86})
            else:
                emit(pts, t == 86, t, idx)
        elif t in (2, 3, 4, 5, 6):  # 32-bit variants
            n = struct.unpack_from("<I", d, body + 16)[0]
            raw = struct.unpack_from("<%di" % (2 * n), d, body + 20)
            pts = list(zip(raw[0::2], raw[1::2]))
            if t == 4:
                out = [pts[0]]
                for i in range(1, n - 2, 3):
                    out += bezier(out[-1], pts[i], pts[i + 1], pts[i + 2])
                pts = out
            if t in (5, 6):
                figure_add(pts, t, idx)
                cur = pts[-1]
            elif path_active:
                path_figs.append({"pts": pts, "closed": t == 2})
            else:
                emit(pts, t == 2, t, idx)
        elif t in (90, 91, 7, 8):  # POLYPOLYLINE16, POLYPOLYGON16, POLYPOLYLINE, POLYPOLYGON
            npolys, cpts = struct.unpack_from("<II", d, body + 16)
            counts = struct.unpack_from("<%dI" % npolys, d, body + 24)
            p = body + 24 + 4 * npolys
            fmt = "h" if t in (90, 91) else "i"
            raw = struct.unpack_from("<%d%s" % (2 * cpts, fmt), d, p)
            allp = list(zip(raw[0::2], raw[1::2]))
            k = 0
            for c in counts:
                pts = allp[k:k + c]
                k += c
                closed = t in (91, 8)
                (path_figs.append({"pts": pts, "closed": closed}) if path_active else emit(pts, closed, t, idx))
        elif t == 27:  # MOVETOEX
            cur = struct.unpack_from("<ii", d, body)
            fig = None
        elif t == 54:  # LINETO
            p = struct.unpack_from("<ii", d, body)
            figure_add([p], t, idx)
            cur = p
        elif t == 61:  # CLOSEFIGURE
            if fig is not None:
                fig["closed"] = True
                fig = None
        elif t in (43, 42):  # RECTANGLE, ELLIPSE
            l, tp, r, b = struct.unpack_from("<4i", d, body)
            pts = [(l, tp), (r, tp), (r, b), (l, b)] if t == 43 else ellipse_pts(l, tp, r, b)
            (path_figs.append({"pts": pts, "closed": True}) if path_active else emit(pts, True, t, idx))
        elif t in (45, 46, 47, 55):  # ARC, CHORD, PIE, ARCTO
            l, tp, r, b, xs, ys, xe, ye = struct.unpack_from("<8i", d, body)
            cx, cy = (l + r) / 2, (tp + b) / 2
            a0 = math.atan2(-(ys - cy), xs - cx)
            a1 = math.atan2(-(ye - cy), xe - cx)
            if a1 <= a0:
                a1 += 2 * math.pi  # counter-clockwise (default arc direction)
            pts = ellipse_pts(l, tp, r, b, a0, a1)
            if t == 47:
                pts = [(cx, cy)] + pts
            if t == 55:
                figure_add(pts, t, idx)
                cur = pts[-1]
            elif path_active:
                path_figs.append({"pts": pts, "closed": t != 45})
            else:
                emit(pts, t != 45, t, idx)
        elif t == 59:  # BEGINPATH
            path_active, path_figs, fig = True, [], None
        elif t == 60:  # ENDPATH
            path_active, fig = False, None
        elif t in (64, 63, 62):  # STROKEPATH, STROKEANDFILLPATH, FILLPATH
            for f in path_figs:
                if t == 62:  # fill only: still record outline, marked by width -1
                    saved = pen
                    pen = (brush if brush is not None else 0, -1.0, 0)
                    emit(f["pts"], True, t, idx)
                    pen = saved
                else:
                    emit(f["pts"], f["closed"] or t == 63, t, idx)
            path_figs = []
        elif t == 35:  # SETWORLDTRANSFORM
            xf = struct.unpack_from("<6f", d, body)
            header["set_xforms"].append(list(xf))
        elif t == 36:  # MODIFYWORLDTRANSFORM
            m = struct.unpack_from("<6f", d, body)
            mode = struct.unpack_from("<I", d, body + 24)[0]
            if mode == 1:
                xf = IDENT
            elif mode == 2:
                xf = mul(m, xf)
            elif mode == 3:
                xf = mul(xf, m)
            elif mode == 4:
                xf = m
                header["set_xforms"].append(list(m))
            else:
                unhandled["MWT_mode_%d" % mode] += 1
        elif t == 33:  # SAVEDC
            stack.append((xf, pen, brush, cur))
        elif t == 34:  # RESTOREDC
            n = struct.unpack_from("<i", d, body)[0]
            if n < 0 and len(stack) >= -n:
                st = stack[n]
                del stack[n:]
                xf, pen, brush, cur = st
            else:
                unhandled["RESTOREDC_%d" % n] += 1
        elif t == 95:  # EXTCREATEPEN
            ih = struct.unpack_from("<I", d, body)[0]
            style, width, bstyle, color = struct.unpack_from("<4I", d, body + 20)
            objs[ih] = ("pen", (color & 0xFFFFFF, float(width), style) if (style & 0xF) != 5 else (None, 0.0, 5))
        elif t == 38:  # CREATEPEN
            ih, style, wx, wy, color = struct.unpack_from("<5I", d, body)
            objs[ih] = ("pen", (color & 0xFFFFFF, float(wx), style) if (style & 0xF) != 5 else (None, 0.0, 5))
        elif t == 39:  # CREATEBRUSHINDIRECT
            ih, bstyle, color, hatch = struct.unpack_from("<4I", d, body)
            objs[ih] = ("brush", None if bstyle == 1 else color & 0xFFFFFF)
        elif t == 37:  # SELECTOBJECT
            ih = struct.unpack_from("<I", d, body)[0]
            if ih & 0x80000000:
                s = ih & 0x7FFFFFFF
                if s in STOCK_PENS:
                    pen = STOCK_PENS[s]
                elif s <= 5:
                    brush = None if s == 5 else [0xFFFFFF, 0xC0C0C0, 0x808080, 0x404040, 0][s]
            elif ih in objs:
                kind, val = objs[ih]
                if kind == "pen":
                    pen = val
                else:
                    brush = val
            else:
                unhandled["SELECT_missing"] += 1
        elif t == 40:  # DELETEOBJECT
            objs.pop(struct.unpack_from("<I", d, body)[0], None)
        elif t in (1, 13, 18, 19, 20, 21, 22, 24, 25, 28, 30, 58, 70, 82, 98, 115, 76):
            pass  # header / state that does not affect vector geometry (76 BITBLT = background)
        else:
            unhandled[t] += 1
        off += size
        idx += 1
    return {"header": header, "prims": prims, "unhandled": {str(k): v for k, v in unhandled.items()}}


if __name__ == "__main__":
    res = extract(sys.argv[1])
    with open(sys.argv[2], "w") as f:
        json.dump(res, f)
    c = Counter((p["color"], p["width"]) for p in res["prims"])
    print(len(res["prims"]), "prims; unhandled:", res["unhandled"])
    for k, v in c.most_common(40):
        print(" ", k, v)
