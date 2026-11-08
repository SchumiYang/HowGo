"""Generate the site-survey plan for WiFi fingerprinting (point survey) and magnetic mapping (walk survey).

- Survey points: every ~SPACING m along accessible corridor/door edges of the nav graph (plus their endpoints).
- Walks: straight corridor runs (chains of collinear corridor edges) to be walked end-to-end at a steady pace.

Output: data/tianmu/survey/<level>_plan.geojson (see SURVEY_SCHEMA.md)
Usage : python -I tools/survey_plan.py [--level 1F|2F]   (default 1F)
"""
import json
import math
import os
import sys

LEVEL = sys.argv[sys.argv.index('--level') + 1] if '--level' in sys.argv else '1F'
SPACING = 4.0
KEEP_M = 0.5  # an existing point within this distance of a sampled edge is kept as it is

# Straight corridor runs to walk for the magnetic map (node chains from nav.geojson, without the "1F-" prefix).
WALKS = [
    ('walk-west-s', '西側走廊（南段）', ['sw', 'w-fa', 'w-s']),
    ('walk-lobby', '門廳（繞 A101）', ['w-s', 'l-s', 'l-c', 'l-n', 'w-n']),
    ('walk-west-n', '西側走廊（北段）', ['w-n', 'w-54', 'nw']),
    ('walk-north', '北側走廊', ['n-14', 'n-m', 'n-acc', 'n-f', 'n-40', 'n-55', 'n-68', 'ne']),
    ('walk-east', '東側走廊', ['e-50', 'e-34', 'e-18']),  # closed at both ends (no link to ne / se)
    ('walk-south', '南側走廊', ['se', 's-60', 's-42', 's-25', 's-15', 'sw']),
]

# Extra coverage requested by the positioning engine: interiors (restrooms, lobby) and parallel walks in wide areas
# (west corridor is 6.7 m wide, lobby 7.6 m; the magnetic map is only trusted within ~1.5 m of a walked line).
EXTRA_POINTS = [
    ((23.6, 62.6), 'RT-ACC'), ((19.4, 58.0), 'RT-M'), ((19.4, 55.0), 'RT-M'), ((24.0, 58.0), 'RT-F'), ((24.0, 55.0), 'RT-F'),
    ((2.5, 27.0), 'lobby'), ((2.5, 34.0), 'lobby'), ((2.5, 41.0), 'lobby'), ((8.5, 13.0), 'corridor-west'),
    ((13.3, 13.0), 'corridor-west'), ((8.5, 52.0), 'corridor-west'), ((13.3, 52.0), 'corridor-west'),
]
EXTRA_WALKS = [
    ('walk-west-s-2', '西側走廊（南段）靠場館側', [[13.3, 5.0], [13.3, 23.0]]),
    ('walk-west-n-2', '西側走廊（北段）靠場館側', [[13.3, 44.5], [13.3, 62.0]]),
    ('walk-lobby-2', '門廳（靠外牆）', [[2.5, 25.0], [2.5, 43.0]]),
    # arena interior (court hall 14.3–72.2 x 13.6–53.3): one loop ~3 m inside the walls, starting at the NW corner door
    # (inner loop / diagonal walks were dropped at the user's request — the arena loop is the only arena walk)
    ('walk-arena-loop', '場館內一圈（比賽場周邊）', [[17.5, 50.0], [69.0, 50.0], [69.0, 17.0], [17.5, 17.0], [17.5, 50.0]]),
]

# 2F: corridors around the stands (node chains from author_2f.py; south-side ids are the mirrored "-s" nodes)
WALKS_2F = [
    ('walk-north', '北側走廊', ['nw', 'n-a', 'n-c', 'n-43', 'n-69', 'ne-n', 'ne']),
    ('walk-south', '南側走廊', ['nw-s', 'n-a-s', 'n-c-s', 'n-43-s', 'n-69-s', 'ne-n-s', 'ne-s']),
    ('walk-west', '西側走廊', ['nw', 'lw', 'w-55', 'w-34', 'w-55-s', 'lw-s', 'nw-s']),
    ('walk-east', '東側走廊', ['ne', 'e-55', 'e-34', 'e-55-s', 'ne-s']),
    # front walkway behind the court parapet: one loop from the NW lobby (repeat it the other way round)
    ('walk-front', '看台前走道一圈', ['nw', 'nw-c', 'wk-nw', 'wk-nw-n', 'wk-n43', 'wk-ne-n', 'wk-ne', 'wk-ne-e', 'wk-e34',
                                 'wk-ne-e-s', 'wk-ne-s', 'wk-ne-n-s', 'wk-n43-s', 'wk-nw-n-s', 'wk-nw-s', 'wk-nw-w-s',
                                 'wk-w34', 'wk-nw-w', 'wk-nw', 'nw-c', 'nw']),
]


def main():
    nav = json.load(open('data/tianmu/nav.geojson', encoding='utf-8'))['features']
    pos = {f['properties']['id']: f['geometry']['coordinates'] for f in nav if f['properties']['kind'] == 'node'}
    edges = [f['properties'] for f in nav if f['properties']['kind'] == 'edge']

    points, seen = [], []
    # keep the ids of an existing plan: recorded wifi points are merged across sessions by point_id, so adding an edge
    # must not renumber the points already surveyed (new points get fresh ids after the highest one)
    path = f'data/tianmu/survey/{LEVEL}_plan.geojson'
    old_ids = {}
    old_near = {}
    if os.path.exists(path):
        for f in json.load(open(path, encoding='utf-8'))['features']:
            if f['properties'].get('kind') == 'point':
                old_ids[tuple(f['geometry']['coordinates'])] = f['properties']['id']
                old_near[f['properties']['id']] = f['properties'].get('near')
    next_no = [max((int(i.rsplit('sp', 1)[1]) for i in old_ids.values()), default=0)]

    def add(p, src):
        if any(math.dist(p, q) < SPACING * 0.5 for q in seen):
            return
        seen.append(p)
        xy = [round(p[0], 2), round(p[1], 2)]
        pid = old_ids.get(tuple(xy))
        if pid is None:
            next_no[0] += 1
            pid = f'{LEVEL}-sp{next_no[0]:03d}'
        points.append({'type': 'Feature', 'geometry': {'type': 'Point', 'coordinates': xy},
                       'properties': {'kind': 'point', 'id': pid, 'level': LEVEL, 'near': src}})

    sampled = [e for e in edges if e['from'].startswith(LEVEL) and e['to'].startswith(LEVEL)  # skip connectors
               and e['accessible'] and e['type'] in ('corridor', 'door', 'ramp')
               and not ('-ar-' in e['from'] and '-ar-' in e['to'])]  # arena grid: open floor, not a corridor

    def seg_dist(p, a, b):
        dx, dy = b[0] - a[0], b[1] - a[1]
        t = max(0.0, min(1.0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / ((dx * dx + dy * dy) or 1e-12)))
        return math.dist(p, (a[0] + t * dx, a[1] + t * dy))

    # points of the existing plan that still lie on a sampled edge keep their id and position when the graph is
    # re-authored (nodes added / moved elsewhere); points left off the new edges (e.g. inside a wall) are dropped
    for (x, y), pid in sorted(old_ids.items(), key=lambda kv: kv[1]):
        if any(seg_dist((x, y), pos[e['from']], pos[e['to']]) <= KEEP_M for e in sampled):
            add([x, y], old_near.get(pid) or 'kept')

    for e in sampled:
        a, b = pos[e['from']], pos[e['to']]
        n = max(1, round(math.dist(a, b) / SPACING))
        for i in range(n + 1):
            add([a[0] + (b[0] - a[0]) * i / n, a[1] + (b[1] - a[1]) * i / n], f"{e['from']}~{e['to']}")

    for p, src in (EXTRA_POINTS if LEVEL == '1F' else []):
        add(list(p), src)

    walks = []
    for wid, name, chain in (WALKS + EXTRA_WALKS if LEVEL == '1F' else WALKS_2F):
        coords = chain if isinstance(chain[0], list) else [pos[f'{LEVEL}-{n}'] for n in chain]
        length = sum(math.dist(a, b) for a, b in zip(coords, coords[1:]))
        walks.append({'type': 'Feature', 'geometry': {'type': 'LineString', 'coordinates': coords},
                      'properties': {'kind': 'walk', 'id': f'{LEVEL}-{wid}', 'level': LEVEL, 'name': name,
                                     'length_m': round(length, 1)}})

    os.makedirs('data/tianmu/survey', exist_ok=True)
    with open(path, 'w', encoding='utf-8') as f:
        json.dump({'type': 'FeatureCollection', 'features': points + walks}, f, ensure_ascii=False, indent=1)
    print(path, len(points), 'points,', len(walks), 'walks, total walk length',
          round(sum(w['properties']['length_m'] for w in walks), 1), 'm')


if __name__ == '__main__':
    main()
