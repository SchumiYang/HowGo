"""Leave-one-walk-out map sets for evaluating positioning on real survey data (there is no ground-truth test walk).

For every real walk X: build_radiomap.py + build_magmap.py with --exclude-walk X into build/lowo/<n>/, plus the
reconstructed positions of all walks (build/lowo/walk_tracks.json, from the full build) as the reference.
build/lowo/index.json lists the held-out walks. Replay them with `npm run eval:positioning` in indoor-nav.

Usage: py -3.12 -I tools/eval_lowo_maps.py [--exclude GLOB] [--only GLOB] [--allowlist FILE|none] [--out DIR]
"""
import argparse
import fnmatch
import glob
import json
import os
import shutil
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TOOLS = os.path.join(ROOT, 'tools')
OUT = os.path.join(ROOT, 'build', 'lowo')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--exclude', action='append', default=[], help='session id glob to skip (passed to the builders)')
    ap.add_argument('--only', default='*', help="walk key glob to hold out (default all)")
    ap.add_argument('--allowlist', default=None, help='WiFi allowlist file for build_radiomap.py (default: its default)')
    ap.add_argument('--group', action='store_true', help='build_radiomap.py --group')
    ap.add_argument('--out', default=OUT, help='output directory (default build/lowo)')
    args = ap.parse_args()
    ex = [a for e in args.exclude for a in ('--exclude', e)]
    out_dir = args.out
    shutil.rmtree(out_dir, ignore_errors=True)
    os.makedirs(out_dir)
    al = (['--allowlist', args.allowlist] if args.allowlist else []) + (['--group'] if args.group else [])
    run = lambda tool, *a: subprocess.run([sys.executable, '-I', os.path.join(TOOLS, tool), *a, *ex],
                                          check=True, stdout=subprocess.DEVNULL)
    run('build_magmap.py', '--quiet', '--out', os.path.join(out_dir, 'full'), '--tracks', os.path.join(out_dir, 'walk_tracks.json'))
    with open(os.path.join(out_dir, 'walk_tracks.json'), encoding='utf8') as f:
        tracks = json.load(f)
    files = {os.path.basename(p)[:-5]: p for p in glob.glob(os.path.join(ROOT, 'survey', 'raw', '*.json'))}
    index = []
    for n, key in enumerate(k for k in tracks if fnmatch.fnmatch(k, args.only)):
        d = os.path.join(out_dir, f'{n:02d}')
        pat = key.replace('[', '[[]')
        run('build_magmap.py', '--quiet', '--exclude-walk', pat, '--out', d, '--tracks', '')
        try:
            run('build_radiomap.py', '--quiet', '--exclude-walk', pat, '--out', d, *al)
        except subprocess.CalledProcessError:
            pass  # no fingerprints left: WiFi methods are skipped for this walk
        session = key.split('|')[0]
        index.append({'key': key, 'dir': os.path.basename(d), 'session_file': os.path.relpath(files[session], ROOT).replace('\\', '/'),
                      'area': tracks[key]['area']})
        print(f'{n:02d} {key}')
    with open(os.path.join(out_dir, 'index.json'), 'w', encoding='utf8') as f:
        json.dump(index, f, indent=1)
    print(f'-> {out_dir}')


if __name__ == '__main__':
    main()
