"""Overlay extracted primitives (red) on the Pillow/GDI render (grey) of the EMF.
Usage: python -I overlay_check.py in.emf prims.json out.png [crop x0 y0 x1 y1 in device units]"""
import json, sys
from PIL import Image, ImageDraw, ImageChops

emf, pj, out = sys.argv[1:4]
r = json.load(open(pj))
im = Image.open(emf); im.load(dpi=2400); im = im.convert("RGB")
b = r["header"]["bounds"]
sx = im.width / (b[2] - b[0] + 1); sy = im.height / (b[3] - b[1] + 1)
ov = Image.new("RGB", im.size, "white"); dr = ImageDraw.Draw(ov)
for p in r["prims"]:
    pts = [((x - b[0]) * sx, (y - b[1]) * sy) for x, y in p["pts"]]
    if p["closed"]: pts.append(pts[0])
    dr.line(pts, fill=(255, 0, 0), width=1)
# grey render, red reconstruction: where they coincide we see dark red
base = im.convert("L").point(lambda v: 255 if v > 200 else 140).convert("RGB")
comb = ImageChops.multiply(base, ov)
if len(sys.argv) > 4:
    x0, y0, x1, y1 = map(float, sys.argv[4:8])
    comb = comb.crop((int(x0 * sx), int(y0 * sy), int(x1 * sx), int(y1 * sy)))
else:
    comb = comb.resize((comb.width // 3, comb.height // 3), Image.LANCZOS)
comb.save(out)
print(im.size, sx, sy)
