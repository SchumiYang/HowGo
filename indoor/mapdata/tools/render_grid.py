"""Render a level's walls.geojson with a metre grid, for reading coordinates when authoring units / POIs / nav.

Usage: python -I tools/render_grid.py <level> <out.png> [x0 y0 x1 y1] [px_per_m]
"""
import json
import sys

from PIL import Image, ImageDraw, ImageFont

LAYER_COLORS = {
    'wall': (30, 30, 30), 'column': (200, 30, 30), 'door': (150, 60, 200), 'stairs': (40, 90, 220),
    'fixture': (0, 140, 130), 'court': (230, 140, 0), 'other': (170, 170, 170),
}


def main():
    level, out = sys.argv[1], sys.argv[2]
    box = [float(v) for v in sys.argv[3:7]] if len(sys.argv) >= 7 else [-15, -5, 88, 71]
    ppm = float(sys.argv[7]) if len(sys.argv) >= 8 else 20
    x0, y0, x1, y1 = box
    w, h = int((x1 - x0) * ppm), int((y1 - y0) * ppm)
    im = Image.new('RGB', (w, h), 'white')
    d = ImageDraw.Draw(im)
    font = ImageFont.truetype('arial.ttf', max(10, int(ppm * 0.45)))

    def px(p):
        return ((p[0] - x0) * ppm, (y1 - p[1]) * ppm)

    for gx in range(int(x0), int(x1) + 1):
        major = gx % 5 == 0
        d.line([px((gx, y0)), px((gx, y1))], fill=(255, 200, 200) if major else (235, 235, 245), width=1)
        if major:
            d.text((px((gx, y1))[0] + 2, 2), str(gx), fill=(220, 0, 0), font=font)
    for gy in range(int(y0), int(y1) + 1):
        major = gy % 5 == 0
        d.line([px((x0, gy)), px((x1, gy))], fill=(255, 200, 200) if major else (235, 235, 245), width=1)
        if major:
            d.text((2, px((x0, gy))[1] + 2), str(gy), fill=(220, 0, 0), font=font)

    walls = json.load(open(f'data/tianmu/levels/{level}/walls.geojson', encoding='utf-8'))
    for f in sorted(walls['features'], key=lambda f: f['properties']['layer'] != 'other'):
        layer = f['properties']['layer']
        pts = [px(p) for p in f['geometry']['coordinates']]
        if len(pts) >= 2:
            d.line(pts, fill=LAYER_COLORS.get(layer, (0, 0, 0)), width=2 if layer in ('wall', 'column') else 1)
    im.save(out)
    print(out, im.size)


if __name__ == '__main__':
    main()
