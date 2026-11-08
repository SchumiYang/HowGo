"""Drop CAD text strokes / dimension lines from published walls.geojson (the app never draws them).

The full linework is kept in build/<level>_walls_full.geojson for reference.
Usage: python -I tools/slim_walls.py
"""
import collections
import json
import os
import shutil

DROP = {'text', 'dim'}  # 'other' features carry a `kind`; text strokes are kind=text


def main():
    for level in ('1F', '2F'):
        path = f'data/tianmu/levels/{level}/walls.geojson'
        full = f'build/{level}_walls_full.geojson'
        # a walls.geojson still carrying text strokes was just written by build_map.py: it is the new full linework
        current = json.load(open(path, encoding='utf-8'))
        if not os.path.exists(full) or any(f['properties'].get('kind') in DROP for f in current['features']):
            shutil.copyfile(path, full)
        data = json.load(open(full, encoding='utf-8'))
        before = collections.Counter(f['properties'].get('kind') or f['properties']['layer'] for f in data['features'])
        data['features'] = [f for f in data['features']
                            if f['properties']['layer'] not in DROP and f['properties'].get('kind') not in DROP]
        with open(path, 'w', encoding='utf-8') as fp:
            json.dump(data, fp, ensure_ascii=False, separators=(',', ':'))
        print(level, dict(before), '->', len(data['features']), 'features,',
              os.path.getsize(full) // 1024, 'KB ->', os.path.getsize(path) // 1024, 'KB')


if __name__ == '__main__':
    main()
