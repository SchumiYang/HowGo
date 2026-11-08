"""Hand-authored 1F data for 天母體育館: units, POIs, nav graph (+ venue.json).

Accessibility-first scope (see DESIGN.md / SCHEMA.md): restrooms (esp. accessible), elevators, stairs, entrances,
plus room polygons with signage refs (A1xx, from the 1F directory sign photo) for the map look.
Coordinates are local metres read off build/1F_preview.png / tools/render_grid.py; refine here and re-run.

Usage: python -I tools/author_1f.py   (writes data/tianmu/..., build/1F_authored.png)
"""
import json
import math
import os
import sys

from PIL import Image, ImageDraw, ImageFont

OUT = 'data/tianmu'
LEVEL = '1F'


def rect(x0, y0, x1, y1):
    return [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]


def half_ellipse_west(cx, cy, rx, ry, n=16):
    """Room A101: straight east wall at x=cx, arc bulging west."""
    pts = [[cx, cy - ry]]
    for i in range(n + 1):
        a = -math.pi / 2 - math.pi * i / n
        pts.append([round(cx + rx * math.cos(a), 2), round(cy + ry * math.sin(a), 2)])
    pts.append([cx, cy - ry])
    return pts


def chamfer_rect(x0, y0, x1, y1, c):
    return [[x0 + c, y0], [x1 - c, y0], [x1, y0 + c], [x1, y1 - c], [x1 - c, y1], [x0 + c, y1], [x0, y1 - c], [x0, y0 + c], [x0 + c, y0]]


# --- units -----------------------------------------------------------------------------------------------
# (id, category, ref, name, polygon, extra props)
UNITS = [
    # walkable
    ('corridor-west', 'corridor', None, None, rect(7.6, 3.8, 14.3, 63.8), {}),
    ('lobby-main', 'lobby', None, '門廳', rect(0.0, 23.6, 7.6, 44.1), {}),
    ('lobby-nw', 'corridor', None, None, rect(7.6, 61.5, 17.3, 67.5), {}),
    ('corridor-north', 'corridor', None, '走廊', rect(13.2, 63.8, 78.4, 67.5), {}),
    ('corridor-east', 'corridor', None, '走廊', rect(72.2, 3.8, 75.3, 63.8), {}),
    ('corridor-south', 'corridor', None, '走廊', rect(7.6, 0.4, 78.4, 3.8), {}),
    ('lobby-sw', 'corridor', None, None, rect(7.6, 0.4, 14.3, 6.3), {}),
    ('platform-west', 'walkway', None, '入口平台', rect(-9.0, 24.0, 0.0, 44.0), {'accessible': True}),
    # arena: events (e.g. CodeFest) are held on the court floor, so it is walkable and routable via its 3 corner doors
    ('arena', 'court', None, '比賽場', chamfer_rect(14.3, 13.6, 72.2, 53.3, 3.0), {'accessible': True}),
    # restrooms — the point of this app
    ('RT-ACC', 'restroom.accessible', None, '無障礙廁所', rect(22.1, 61.4, 25.2, 63.8), {'accessible': True, 'name_en': 'Accessible restroom'}),
    ('RT-M', 'restroom.male', None, '男廁', rect(17.3, 53.4, 21.6, 63.8), {'name_en': "Men's restroom"}),
    ('RT-F', 'restroom.female', None, '女廁',
     [[21.6, 53.4], [26.7, 53.4], [26.7, 63.8], [25.2, 63.8], [25.2, 61.4], [21.6, 61.4], [21.6, 53.4]], {'name_en': "Women's restroom"}),
    # elevators (both marked ♿ on the drawing)
    ('EL-2', 'elevator', '#2', '電梯 2', rect(11.0, 64.4, 13.2, 66.7), {'accessible': True}),
    ('EL-1', 'elevator', '#1', '電梯 1', rect(11.0, 0.8, 13.2, 3.2), {'accessible': True}),
    # stairs (not step-free)
    ('ST-A', 'stairs', 'A梯', 'A梯', rect(0.0, 61.5, 7.6, 67.5), {'accessible': False}),
    ('ST-B', 'stairs', 'B梯', 'B梯', rect(78.4, 61.3, 85.6, 67.6), {'accessible': False}),
    ('ST-C', 'stairs', 'C梯', 'C梯', rect(0.0, 0.0, 7.6, 6.3), {'accessible': False}),
    ('ST-D', 'stairs', 'D梯', 'D梯', rect(78.4, 0.4, 85.6, 6.3), {'accessible': False}),
    # rooms with signage refs (directory sign photo; all refs confirmed on site 2026-11-07)
    ('A101', 'room', 'A101', None, half_ellipse_west(13.75, 33.8, 6.5, 5.9), {'ref_verified': True}),
    ('A102', 'room', 'A102', '貴賓室', rect(0.0, 44.1, 7.6, 50.2), {'ref_verified': True}),
    ('A104', 'room', 'A104', '裁判及紀錄人員室', rect(0.0, 54.0, 7.6, 61.5), {'ref_verified': True}),
    ('A109', 'office', 'A109', '大會辦公室', rect(33.1, 53.4, 48.1, 63.8), {'ref_verified': True}),
    ('A115', 'room', 'A115', '休息室及更衣室', rect(55.0, 3.8, 63.6, 13.6), {'ref_verified': True}),
    ('A116', 'room', 'A116', '休息室及更衣室', rect(47.0, 3.8, 55.0, 13.6), {'ref_verified': True}),
    ('A117', 'room', 'A117', '休息室及更衣室', rect(28.5, 3.8, 36.3, 13.6), {'ref_verified': True}),
    ('A118', 'room', 'A118', '休息室及更衣室', rect(21.5, 3.8, 28.5, 13.6), {'ref_verified': True}),
    ('A119', 'room', 'A119', '報到處及選手等候休息室', rect(0.0, 9.3, 7.6, 13.8), {'ref_verified': True}),
    ('A120', 'first_aid', 'A120', '急救站', rect(0.0, 13.8, 7.6, 19.8), {'ref_verified': True}),
    # non-public blocks (grey on the sign)
    ('NP-ticket', 'nonpublic', None, '售票室', rect(0.0, 19.8, 7.6, 23.6), {}),
    ('NP-doping', 'nonpublic', None, '藥檢室', rect(0.0, 6.3, 7.6, 9.3), {}),
    ('NP-wc-staff', 'nonpublic', None, None, rect(0.0, 50.2, 7.6, 54.0), {}),
    ('NP-mgmt', 'nonpublic', None, '管理及資訊室', rect(26.7, 53.4, 33.1, 63.8), {}),
    ('NP-power', 'nonpublic', None, '自設發電室', rect(48.1, 53.4, 63.5, 63.8), {}),
    ('NP-telecom', 'nonpublic', None, '電信室', rect(63.5, 53.4, 67.2, 63.8), {}),
    ('NP-shower-1', 'nonpublic', None, '淋浴間', rect(17.0, 3.8, 21.5, 13.6), {}),
    ('NP-shower-2', 'nonpublic', None, '淋浴間', rect(36.3, 3.8, 47.0, 13.6), {}),
    ('NP-shower-3', 'nonpublic', None, '淋浴間', rect(63.6, 3.8, 68.8, 13.6), {}),
    ('NP-east', 'nonpublic', None, '機房', rect(75.3, 6.3, 85.6, 61.3), {}),
]

# --- nav graph -------------------------------------------------------------------------------------------
NODES = {
    # west corridor (centreline x=11) and main lobby around A101
    # A101 blocks the west corridor, so the route detours through the lobby on one straight line (x=5.5)
    # to keep turn-by-turn steps simple; the main entrance joins that line at l-c.
    'w-fa': (11.0, 18.7), 'w-s': (11.0, 23.6), 'l-s': (5.5, 27.0), 'l-c': (5.5, 34.0),
    'l-n': (5.5, 41.0), 'w-n': (11.0, 44.4), 'w-54': (11.0, 54.0),
    # NW / SW junctions sit south (north) of the elevator shafts: 'nw'/'sw' east of the diagonal wall stub at the shaft
    # corner, '-w' west of it (stairs, side entrance), '-e' east of the column at the shaft (into the north / south
    # corridor); straight links from one hub cut the stub, the shaft corner and the column (nav_wall_check.py)
    'nw': (11.7, 62.2), 'nw-w': (9.6, 62.2), 'nw-e': (14.9, 62.2),
    'sw': (11.7, 5.4), 'sw-w': (9.6, 5.4), 'sw-e': (14.9, 5.4),
    # north corridor (y=65.6)
    'n-14': (14.6, 65.6), 'n-m': (17.9, 65.6), 'n-acc': (24.0, 65.6), 'n-f': (26.0, 65.6), 'n-40': (40.6, 65.6),
    'n-55': (55.0, 65.6), 'n-68': (68.0, 65.6), 'ne': (73.7, 65.0),
    # east corridor (x=73.7) and south corridor (y=2.1)
    'e-50': (73.7, 50.0), 'e-34': (73.7, 34.0), 'e-18': (73.7, 18.0),
    # se: inside the double door from the south corridor into the SE lobby (stair D, SE exterior door); se-l its middle
    'se': (72.35, 2.35), 'se-l': (75.4, 2.6),
    # East corridor end doors: DOOR CONFIRMED ON SITE, NOT DRAWN IN CAD (user, 2026-11-08: 「有門」, position not
    # given). The CAD closes both ends with full walls; each door node sits in that wall, centred on the corridor
    # (x=73.7), and is listed in nav_wall_check.DECLARED_OPENINGS. North: wall under the north corridor (y=61.7).
    # South: the route crosses two walls - the diagonal end wall (y 10-13) and the SE lobby's north wall (y=4.4).
    'd-e-n': (73.7, 61.74), 'd-e-s': (73.7, 11.76), 'd-e-s2': (73.7, 4.43),
    's-60': (60.0, 2.1), 's-42': (42.0, 2.1), 's-25': (25.0, 2.1), 's-15': (15.0, 2.1),
    # doors / destinations
    'd-m': (17.9, 63.8), 'rt-m': (19.2, 60.5),
    'd-acc': (24.0, 63.8), 'rt-acc': (23.6, 62.6),
    'd-f': (26.0, 63.8), 'f-in': (26.0, 61.0), 'rt-f': (24.0, 58.0),
    # elevator door nodes sit on the shaft opening (the CAD draws the door leaf as a wall line), cars at their centre
    'el2': (12.2, 65.4), 'd-el2': (12.2, 64.34), 'el1': (12.2, 2.27), 'd-el1': (12.2, 3.5),
    # stair nodes = the landing just inside the stair door (the line to the old core centre cut the flights' wall)
    'd-stA': (8.6, 62.6), 'stA': (7.2, 63.1), 'd-stC': (9.0, 5.2), 'stC': (7.2, 4.5),
    'd-stB': (78.4, 64.4), 'stB': (79.6, 63.4), 'd-stD': (78.4, 3.2), 'stD': (79.6, 3.0),
    # main entrance: the step-free door is the swing door north of the two revolving doors (between those runs a
    # mullion); the ramp platform outside is level with it
    'ent-main': (0.13, 36.25), 'ent-main-out': (-4.0, 36.25),
    # side entrances: door nodes in the facade opening (the outer facade line is drawn across the doorway); the NW
    # outside node lies between the first two porch outlines (y=68.59 / 68.9), not on one
    'ent-nw': (9.5, 67.4), 'ent-nw-out': (9.5, 68.75), 'ent-sw': (9.5, 0.45), 'ent-sw-out': (9.5, -0.8),
    'd-fa': (7.6, 18.7), 'fa': (4.0, 16.8),
    # arena doors (from the 1F door layer: NW, SW, SE; there is no NE door); the open floor is a grid, see ARENA_GRID
    'd-ar-nw': (16.0, 51.6), 'd-ar-sw': (16.0, 15.9), 'd-ar-se': (70.0, 15.9),
}

# doors confirmed on site but missing from the CAD (their nodes and edges get door_source = UNDRAWN_DOOR)
UNDRAWN_DOOR = 'confirmed on site, not drawn in CAD'
UNDRAWN_DOORS = {'d-e-n', 'd-e-s', 'd-e-s2'}

# (from, to, type, accessible)
EDGES = [
    ('sw', 'w-fa', 'corridor', True), ('w-fa', 'w-s', 'corridor', True), ('w-s', 'l-s', 'corridor', True),
    ('l-s', 'l-c', 'corridor', True), ('l-c', 'l-n', 'corridor', True), ('l-n', 'w-n', 'corridor', True),
    ('w-n', 'w-54', 'corridor', True), ('w-54', 'nw', 'corridor', True),
    ('nw', 'nw-w', 'corridor', True), ('nw', 'nw-e', 'corridor', True), ('nw-e', 'n-14', 'corridor', True),
    ('n-14', 'n-m', 'corridor', True), ('n-m', 'n-acc', 'corridor', True), ('n-acc', 'n-f', 'corridor', True),
    ('n-f', 'n-40', 'corridor', True), ('n-40', 'n-55', 'corridor', True), ('n-55', 'n-68', 'corridor', True),
    ('n-68', 'ne', 'corridor', True), ('e-50', 'e-34', 'corridor', True),
    ('e-34', 'e-18', 'corridor', True), ('se', 's-60', 'corridor', True), ('se', 'se-l', 'corridor', True),
    # east corridor ends: doors confirmed on site, not drawn in the CAD (see the nodes above)
    ('ne', 'd-e-n', 'door', True), ('d-e-n', 'e-50', 'door', True),
    ('e-18', 'd-e-s', 'door', True), ('d-e-s', 'd-e-s2', 'door', True), ('d-e-s2', 'se-l', 'door', True),
    ('s-60', 's-42', 'corridor', True), ('s-42', 's-25', 'corridor', True), ('s-25', 's-15', 'corridor', True),
    ('s-15', 'sw-e', 'corridor', True), ('sw-e', 'sw', 'corridor', True), ('sw', 'sw-w', 'corridor', True),
    # restrooms
    ('n-m', 'd-m', 'door', True), ('d-m', 'rt-m', 'corridor', True),
    ('n-acc', 'd-acc', 'door', True), ('d-acc', 'rt-acc', 'corridor', True),
    ('n-f', 'd-f', 'door', True), ('d-f', 'f-in', 'corridor', True), ('f-in', 'rt-f', 'corridor', True),
    # elevators
    ('nw', 'd-el2', 'door', True), ('d-el2', 'el2', 'door', True),
    ('sw', 'd-el1', 'door', True), ('d-el1', 'el1', 'door', True),
    # stairs (stair cores are destinations; climbing is not step-free)
    ('nw-w', 'd-stA', 'door', True), ('d-stA', 'stA', 'stairs', False),
    ('sw-w', 'd-stC', 'door', True), ('d-stC', 'stC', 'stairs', False),
    ('ne', 'd-stB', 'door', True), ('d-stB', 'stB', 'stairs', False),
    ('se', 'd-stD', 'door', True), ('d-stD', 'stD', 'stairs', False),
    # entrances (main entrance has 行動不便坡道 on the platform; side doors confirmed step-free on site)
    ('l-c', 'ent-main', 'door', True), ('ent-main', 'ent-main-out', 'ramp', True),
    ('nw-w', 'ent-nw', 'door', True), ('ent-nw', 'ent-nw-out', 'door', True),
    ('sw-w', 'ent-sw', 'door', True), ('ent-sw', 'ent-sw-out', 'door', True),
    # first aid
    ('w-fa', 'd-fa', 'door', True), ('d-fa', 'fa', 'corridor', True),
    # arena
    ('w-54', 'd-ar-nw', 'door', True), ('d-ar-nw', 'ar-nw', 'door', True),
    ('w-fa', 'd-ar-sw', 'door', True), ('d-ar-sw', 'ar-sw', 'door', True),
    ('e-18', 'd-ar-se', 'door', True), ('d-ar-se', 'ar-se', 'door', True),
]

# Arena open floor: a grid of nodes (~6.4 m apart) linked to all 8 neighbours, so routes across the court are
# near-straight instead of riding a perimeter/diagonal skeleton. Corner and centre nodes keep their old ids
# (ar-sw/se/nw/ne/c), which the positioning test walks use.
ARENA_X = [17.5 + i * (69.0 - 17.5) / 8 for i in range(9)]
ARENA_Y = [17.2 + j * (50.0 - 17.2) / 5 for j in range(6)]
ARENA_ALIAS = {(0, 0): 'ar-sw', (8, 0): 'ar-se', (0, 5): 'ar-nw', (8, 5): 'ar-ne'}


def _arena_id(i, j):
    return ARENA_ALIAS.get((i, j), f'ar-{i}-{j}')


for _i, _x in enumerate(ARENA_X):
    for _j, _y in enumerate(ARENA_Y):
        NODES[_arena_id(_i, _j)] = (round(_x, 2), round(_y, 2))
        for _di, _dj in ((1, 0), (0, 1), (1, 1), (1, -1)):
            if 0 <= _i + _di < len(ARENA_X) and 0 <= _j + _dj < len(ARENA_Y):
                EDGES.append((_arena_id(_i, _j), _arena_id(_i + _di, _j + _dj), 'corridor', True))
NODES['ar-c'] = (43.2, 33.5)
EDGES += [('ar-c', _arena_id(i, j), 'corridor', True) for i, j in ((3, 2), (4, 2), (3, 3), (4, 3), (5, 2), (5, 3))]

# --- POIs ------------------------------------------------------------------------------------------------
# (id, category, name, point, unit_id, nav_node, extra)
POIS = [
    ('poi-rt-acc', 'toilet.accessible', '無障礙廁所', (23.6, 62.6), 'RT-ACC', 'rt-acc', {}),
    ('poi-rt-m', 'toilet.male', '男廁', (19.2, 60.5), 'RT-M', 'rt-m', {}),
    ('poi-rt-f', 'toilet.female', '女廁', (24.0, 58.0), 'RT-F', 'rt-f', {}),
    ('poi-el-2', 'elevator', '電梯 2（A梯旁）', (12.1, 65.5), 'EL-2', 'el2', {'capacity': '15人', 'speed': '45 m/min'}),
    ('poi-el-1', 'elevator', '電梯 1（C梯旁）', (12.1, 2.1), 'EL-1', 'el1', {'capacity': '15人', 'speed': '45 m/min'}),
    ('poi-st-a', 'stairs', 'A梯', (4.0, 64.5), 'ST-A', 'stA', {}),
    ('poi-st-b', 'stairs', 'B梯', (82.0, 64.4), 'ST-B', 'stB', {}),
    ('poi-st-c', 'stairs', 'C梯', (4.0, 3.0), 'ST-C', 'stC', {}),
    ('poi-st-d', 'stairs', 'D梯', (82.0, 3.2), 'ST-D', 'stD', {}),
    ('poi-ent-main', 'entrance', '主入口', (-4.0, 34.0), None, 'ent-main-out', {'accessible': True}),
    ('poi-ent-nw', 'emergency_exit', '救護出口', (9.5, 68.6), None, 'ent-nw-out', {'accessible': True}),
    ('poi-ent-sw', 'entrance', '側門（C梯旁）', (9.5, -0.8), None, 'ent-sw-out', {'accessible': True}),
    ('poi-fa', 'first_aid', '急救站', (4.0, 16.8), 'A120', 'fa', {}),
]


def fc(features):
    return {'type': 'FeatureCollection', 'features': features}


def write(path, data):
    # Once the admin web has edited a file (top-level "source": "admin"), these bootstrap scripts must not clobber it.
    if os.path.exists(path) and '--force' not in sys.argv:
        try:
            if json.load(open(path, encoding='utf-8')).get('source') == 'admin':
                print('skip (edited in admin; use --force to overwrite):', path)
                return
        except (ValueError, AttributeError):
            pass
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
    print('wrote', path)


def main():
    nid = lambda n: f'{LEVEL}-{n}'
    units = [{'type': 'Feature', 'geometry': {'type': 'Polygon', 'coordinates': [poly]},
              'properties': {'id': nid(uid), 'level': LEVEL, 'category': cat, **({'ref': ref} if ref else {}),
                             **({'name': name} if name else {}), **extra}}
             for uid, cat, ref, name, poly, extra in UNITS]
    pois = [{'type': 'Feature', 'geometry': {'type': 'Point', 'coordinates': list(pt)},
             'properties': {'id': nid(pid), 'level': LEVEL, 'category': cat, 'name': name,
                            **({'unit_id': nid(unit)} if unit else {}), 'nav_node': nid(node), **extra}}
            for pid, cat, name, pt, unit, node, extra in POIS]

    for a, b, *_ in EDGES:
        assert a in NODES and b in NODES, (a, b)
    undrawn = lambda n: {'door_source': UNDRAWN_DOOR} if n in UNDRAWN_DOORS else {}
    nav = [{'type': 'Feature', 'geometry': {'type': 'Point', 'coordinates': list(p)},
            'properties': {'kind': 'node', 'id': nid(n), 'level': LEVEL, **undrawn(n)}} for n, p in NODES.items()]
    for a, b, typ, acc in EDGES:
        pa, pb = NODES[a], NODES[b]
        nav.append({'type': 'Feature', 'geometry': {'type': 'LineString', 'coordinates': [list(pa), list(pb)]},
                    'properties': {'kind': 'edge', 'from': nid(a), 'to': nid(b), 'type': typ, 'accessible': acc,
                                   'length_m': round(math.dist(pa, pb), 2), **(undrawn(a) or undrawn(b))}})

    venue = {
        'id': 'tianmu', 'name': '臺北市立大學天母體育館', 'name_en': 'UTaipei Tianmu Gymnasium',
        # Georeferenced from the OSM building footprint (way 262941451, 88.5 x 70.9 m roof outline, -0.39 deg):
        # main enclosure (86.0 x 67.6 m) centred on it. Cross-checked against the site map screenshot (north = up).
        'origin': {'lng': 121.5346582, 'lat': 25.1156940}, 'bearing_deg': -0.39, 'georeferenced': True,
        'levels': [{'id': '1F', 'ordinal': 0, 'name': '1F', 'elevation_m': 0},
                   {'id': '2F', 'ordinal': 1, 'name': '2F', 'elevation_m': 5.0}],
        'default_level': '1F',
    }
    write(f'{OUT}/venue.json', venue)
    write(f'{OUT}/levels/{LEVEL}/units.geojson', fc(units))
    write(f'{OUT}/levels/{LEVEL}/pois.geojson', fc(pois))
    write(f'{OUT}/nav.geojson', fc(nav))
    render(units, pois)


COLORS = {'corridor': '#FFFFFF', 'lobby': '#FFFFFF', 'walkway': '#F1F3F4', 'court': '#DBF1F5', 'room': '#F8E3BC',
          'office': '#F8E3BC', 'first_aid': '#F8E3BC', 'restroom.male': '#DBF1F5', 'restroom.female': '#DBF1F5',
          'restroom.accessible': '#5AB4C5', 'elevator': '#B4E2EA', 'stairs': '#CAD1D5', 'nonpublic': '#E3E7E9'}


def render(units, pois, ppm=14, box=(-15, -5, 88, 71)):
    x0, y0, x1, y1 = box
    im = Image.new('RGB', (int((x1 - x0) * ppm), int((y1 - y0) * ppm)), '#F1F3F4')
    d = ImageDraw.Draw(im)
    font = ImageFont.truetype('msjh.ttc', 13)
    px = lambda p: ((p[0] - x0) * ppm, (y1 - p[1]) * ppm)
    for u in units:
        d.polygon([px(p) for p in u['geometry']['coordinates'][0]], fill=COLORS.get(u['properties']['category'], '#FFF'))
    walls = json.load(open(f'{OUT}/levels/{LEVEL}/walls.geojson', encoding='utf-8'))
    for f in walls['features']:
        if f['properties']['layer'] in ('wall', 'column', 'door', 'stairs'):
            d.line([px(p) for p in f['geometry']['coordinates']], fill='#475259', width=1)
    for u in units:
        p = u['properties']
        label = p.get('ref') or p.get('name')
        if label and p['category'] not in ('corridor', 'walkway'):
            xs = [c[0] for c in u['geometry']['coordinates'][0]]; ys = [c[1] for c in u['geometry']['coordinates'][0]]
            d.text(px(((min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2)), label, fill='#AD7B2B', font=font, anchor='mm')
    nav = json.load(open(f'{OUT}/nav.geojson', encoding='utf-8'))
    for f in nav['features']:
        g = f['geometry']
        if g['type'] == 'LineString':
            d.line([px(p) for p in g['coordinates']], fill='#356C77' if f['properties']['accessible'] else '#D45251', width=3)
    for f in nav['features']:
        if f['geometry']['type'] == 'Point':
            x, y = px(f['geometry']['coordinates'])
            d.ellipse([x - 3, y - 3, x + 3, y + 3], fill='#356C77')
    for p in pois:
        x, y = px(p['geometry']['coordinates'])
        d.ellipse([x - 6, y - 6, x + 6, y + 6], outline='#C2332F', width=2)
    im.save('build/1F_authored.png')
    print('wrote build/1F_authored.png', im.size)


if __name__ == '__main__':
    main()
