"""Build the WiFi fingerprint radiomap from survey sessions (SURVEY_SCHEMA.md §2 -> §3).

Fingerprints:
- every wifi_points entry (scans merged across sessions by point_id; ad-hoc points kept separate), and
- every walk wifi_scan, placed at the walk position at mid-sweep (collected_at - SCAN_LAG_MS), positions from
  tools/walktrack.py (step-proportional arc length anchored at gyro-detected corners).
Filtering: BSSIDs with the locally-administered bit set (phone hotspots, randomized MACs), hotspot-looking SSIDs,
results older than STALE_MS within a scan (cached), cached (repeated) scans, and BSSIDs seen in < MIN_SCANS scans.

Output: data/tianmu/positioning/wifi_radiomap.json (+ build/radiomap_<level>.png coverage preview)
Usage : py -3.12 -I tools/build_radiomap.py [--include-synthetic | --synthetic-only] [--level all|1F|2F] [--exclude GLOB] [--walks-only] [--walk-bin 3] [--out DIR]
        [--exclude-walk 'SESSION|WALK|DIRECTION|N' (globs ok, repeatable)]
        (synthetic-* sessions are excluded unless --include-synthetic; sessions with purpose "evaluation" always are)
        Every level goes into the one file; --level X rebuilds only X and merges it into the existing file.
"""
import argparse
import fnmatch
import glob
import importlib.util
import json
import os
import re
import time

import numpy as np
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW_DIR = os.path.join(ROOT, 'survey', 'raw')
VENUE_DIR = os.path.join(ROOT, 'data', 'tianmu')
OUT_DIR = os.path.join(VENUE_DIR, 'positioning')
BUILD_DIR = os.path.join(ROOT, 'build')

_spec = importlib.util.spec_from_file_location('walktrack', os.path.join(os.path.dirname(os.path.abspath(__file__)), 'walktrack.py'))
walktrack = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(walktrack)

MIN_SCANS = 2            # drop BSSIDs seen in fewer scans overall
STALE_MS = 10000         # drop results last seen this long before the newest result of the same scan
SCAN_LAG_MS = 2500       # walk scans: position at mid-sweep
WALK_BIN_M = 3.0         # walk scans are merged per cell of this size
DEFAULT_LEVEL = '1F'     # level of survey records without one (sessions before multi-level surveys)
HOTSPOT_SSID = re.compile(
    r"iphone|ipad|androidap|android_|galaxy|huawei|honor|oppo|redmi|xiaomi|\bmi \d|vivo|realme|oneplus|pixel|"
    r"direct-|hotspot|'s |的", re.I)


def excluded_walks():
    """Walk key globs from survey/exclude_walks.txt (bad recordings kept out of every build)."""
    path = os.path.join(ROOT, 'survey', 'exclude_walks.txt')
    if not os.path.exists(path):
        return []
    with open(path, encoding='utf8') as f:
        return [ln.split('#', 1)[0].strip() for ln in f if ln.split('#', 1)[0].strip()]


def load_sessions(include_synthetic, exclude=()):
    """Raw sessions to build from: synthetic-* only on request (include_synthetic True, or 'only'); evaluation sessions, survey-tool test uploads
    (device model FAKE-*) and --exclude globs are skipped."""
    out = []
    for path in sorted(glob.glob(os.path.join(RAW_DIR, '*.json'))):
        name = os.path.basename(path)[:-5]
        synthetic = name.startswith('synthetic-')
        if (synthetic and not include_synthetic) or (include_synthetic == 'only' and not synthetic)                 or any(fnmatch.fnmatch(name, p) for p in exclude):
            continue
        with open(path, encoding='utf8') as f:
            s = json.load(f)
        if s.get('purpose') == 'evaluation':
            continue
        if str((s.get('device') or {}).get('model', '')).upper().startswith('FAKE'):
            print(f'  skip {name}: test upload (device {s["device"]["model"]})')
            continue
        out.append(s)
    return out


def locally_administered(bssid):
    try:
        return bool(int(bssid.split(':')[0], 16) & 0x02)
    except ValueError:
        return True


def walk_keys(session):
    """'session|walk_id|direction|n' for every walk (n counts repeats of the same walk + direction)."""
    seen = {}
    for w in session.get('walks') or []:
        k = (w['walk_id'], w.get('direction', 'forward'))
        n = seen[k] = seen.get(k, -1) + 1
        yield f"{session['session_id']}|{w['walk_id']}|{k[1]}|{n}", w


def ap_key(bssid, frequency, group=True):
    """Radio key. One physical radio broadcasts several SSIDs on virtual BSSIDs that differ only in the low nibble
    of the last octet (campus: ..:30–35) or, for locally administered ones, only in the first octet's admin bits
    (CodeFest E/F: 22:6a:1b:93:bc:19 / 26:6a:1b:93:bc:19). Key = first 5 octets + high nibble of the last (octets
    2–6 when locally administered) + band. Neighbouring radios share 5 octets (38:17:c3:99:db:7x / :dx), so the
    last octet matters. Must match indoor-nav/src/positioning/wifi.ts apKey()."""
    b = bssid.lower()
    if not group:
        return b
    f = frequency or 0
    band = '2.4' if f < 3000 else '5' if f < 5925 else '6'
    o = b.split(':')
    return (':'.join(o[1:]) if locally_administered(b) else ':'.join(o[:5]) + ':' + o[5][0]) + '|' + band


def load_allowlist(path):
    """[(kind, value)] from survey/wifi_allowlist.txt: 'prefix <ssid start>', 'regex <pattern>', 'bssid <mac or
    mac prefix>'; '#' comments. Missing file or no entries -> None (= every AP except phone hotspots)."""
    if not path or path == 'none' or not os.path.exists(path):
        return None
    out = []
    with open(path, encoding='utf8') as f:
        for ln in f:
            ln = ln.split('#', 1)[0].strip()
            if not ln:
                continue
            kind, _, val = ln.partition(' ')
            if kind not in ('prefix', 'regex', 'bssid') or not val.strip():
                raise SystemExit(f'{path}: bad line {ln!r} (use prefix / regex / bssid)')
            out.append((kind, val.strip() if kind != 'bssid' else val.strip().lower()))
    return out or None


def allowed(rules, ssid, bssid):
    for kind, val in rules:
        if (kind == 'prefix' and ssid.startswith(val)) or (kind == 'regex' and re.search(val, ssid))                 or (kind == 'bssid' and bssid.lower().startswith(val)):
            return True
    return False


def clean_scan(scan, prev_key, keep, key_of):
    """-> (dict radio key -> mean level, key) or (None, key) for a cached repeat. Drops stale results and APs that
    keep(result) rejects; virtual BSSIDs of one radio are averaged."""
    res = scan.get('results') or []
    key = tuple(sorted((r['bssid'], r.get('timestamp')) for r in res))
    if scan.get('cached') or (prev_key is not None and key == prev_key) or not res:
        return None, key
    ts = [r['timestamp'] for r in res if r.get('timestamp')]
    newest = max(ts) if ts else None
    acc = {}
    for r in res:
        if not keep(r):
            continue
        if newest is not None and r.get('timestamp') and (newest - r['timestamp']) / 1000 > STALE_MS:
            continue
        acc.setdefault(key_of(r), []).append(r['level'])
    return {k: float(np.mean(v)) for k, v in acc.items()}, key


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--include-synthetic', action='store_true')
    ap.add_argument('--synthetic-only', action='store_true', help='only synthetic-* sessions (evaluation maps)')
    ap.add_argument('--level', default='all',
                    help="'all' (default) rebuilds every level; a single level is rebuilt and MERGED into the existing file")
    ap.add_argument('--exclude', action='append', default=[], help='session id glob to skip (repeatable)')
    ap.add_argument('--walks-only', action='store_true', help='ignore wifi_points (what-if: walk-only survey)')
    ap.add_argument('--exclude-walk', action='append', default=[], help="'SESSION|WALK|DIRECTION|N' glob (repeatable)")
    ap.add_argument('--walk-bin', type=float, default=WALK_BIN_M, help='merge walk scans into cells of this size (m); 0 = keep single scans')
    ap.add_argument('--quiet', action='store_true')
    ap.add_argument('--allowlist', default=os.path.join(ROOT, 'survey', 'wifi_allowlist.txt'),
                    help="SSID/BSSID allowlist file ('none' = all APs except phone hotspots)")
    ap.add_argument('--group', action='store_true',
                    help='merge the virtual BSSIDs of one radio (ap_key). Off by default: on the tianmu walk survey '
                         'it made WiFi worse (LOWO WkNN median 7.4 -> 9.4 m), duplicates evidently help')
    ap.add_argument('--out', default=OUT_DIR, help='output directory (default data/tianmu/positioning)')
    args = ap.parse_args()
    listed = excluded_walks()
    if listed and not args.quiet:
        print(f'excluding {len(listed)} walk(s) listed in survey/exclude_walks.txt')
    args.exclude_walk = args.exclude_walk + listed

    sessions = load_sessions('only' if args.synthetic_only else args.include_synthetic, args.exclude)
    if not sessions:
        raise SystemExit(f'no sessions in {RAW_DIR} (synthetic excluded: pass --include-synthetic)')

    rules = load_allowlist(args.allowlist)
    group = args.group
    key_of = lambda r: ap_key(r['bssid'], r.get('frequency'), group)
    all_scans = [sc for s_ in sessions for p in s_.get('wifi_points') or [] for sc in p.get('scans') or []] +                 [sc for s_ in sessions for w in s_.get('walks') or [] for sc in w.get('wifi_scans') or []]
    if rules:
        # a radio is allowed if any of its BSSIDs carries an allowed SSID (its hidden-SSID BSSID comes along)
        ok_keys = {key_of(r) for sc in all_scans for r in sc.get('results') or []
                   if allowed(rules, r.get('ssid') or '', r['bssid'])}
        use_ap = lambda r: key_of(r) in ok_keys
    else:
        use_ap = lambda r: not locally_administered(r['bssid'].lower()) and not HOTSPOT_SSID.search(r.get('ssid') or '')

    fps = {}      # id -> {x, y, src, scans: [dict]}
    ap_meta = {}
    dropped = {'local_admin': set(), 'filtered': set()}
    for s in sessions:
        sid = s['session_id']
        for i, p in enumerate([] if args.walks_only else s.get('wifi_points') or []):
            lv = p.get('level') or DEFAULT_LEVEL
            if args.level != 'all' and lv != args.level:
                continue
            fid = p.get('point_id') or f'{sid}-adhoc{i:03d}'
            fp = fps.setdefault(fid, {'x': [], 'y': [], 'src': 'point', 'scans': [], 'level': lv})
            prev = None
            for sc in p.get('scans') or []:
                clean, prev = clean_scan(sc, prev, use_ap, key_of)
                if clean:
                    fp['scans'].append(clean)
                    fp['x'].append(p['x'])
                    fp['y'].append(p['y'])
        for key, w in walk_keys(s):
            lv = w.get('level') or DEFAULT_LEVEL
            if (args.level != 'all' and lv != args.level) or any(fnmatch.fnmatch(key, p) for p in args.exclude_walk):
                continue
            prev = None
            track = None
            for k, sc in enumerate(w.get('wifi_scans') or []):
                clean, prev = clean_scan(sc, prev, use_ap, key_of)
                t = sc['collected_at'] - SCAN_LAG_MS
                if not clean or not (w['t_start'] <= t <= w['t_end']):
                    continue
                track = track or walktrack.WalkTrack(w)
                x, y = track.positions([t])
                fps[f"{key}|{k:03d}"] = {'x': [float(x[0])], 'y': [float(y[0])], 'src': 'walk', 'scans': [clean], 'level': lv}
        for sc in [sc for p in s.get('wifi_points') or [] for sc in p.get('scans') or []] +                   [sc for w in s.get('walks') or [] for sc in w.get('wifi_scans') or []]:
            for r in sc.get('results') or []:
                b = r['bssid'].lower()
                if not use_ap(r):
                    dropped['local_admin' if locally_administered(b) else 'filtered'].add(b)
                    continue
                m = ap_meta.setdefault(key_of(r), {'ssids': set(), 'bssids': set(), 'frequency': r.get('frequency')})
                m['ssids'].add(r.get('ssid') or '')
                m['bssids'].add(b)

    fps = {k: v for k, v in fps.items() if v['scans']}
    if args.walk_bin > 0:
        # merge single walk scans (from every recording and direction) into WALK_BIN cells: one scan taken while
        # walking is smeared over 5–8 m and misses weak APs at random; averaging several gives usable means/detect
        binned = {}
        for k in [k for k, v in fps.items() if v['src'] == 'walk']:
            v = fps.pop(k)
            c = (v['level'], int(np.floor(v['x'][0] / args.walk_bin)), int(np.floor(v['y'][0] / args.walk_bin)))
            b = binned.setdefault(c, {'x': [], 'y': [], 'src': 'walk', 'scans': [], 'level': v['level']})
            b['x'] += v['x']
            b['y'] += v['y']
            b['scans'] += v['scans']
        for c, b in binned.items():
            fps[f'walkbin|{c[0]}|{c[1]}|{c[2]}'] = b
    seen = {}
    for fp in fps.values():
        for sc in fp['scans']:
            for b in sc:
                seen[b] = seen.get(b, 0) + 1
    keep = sorted(b for b, n in seen.items() if n >= MIN_SCANS)
    rare = sorted(b for b, n in seen.items() if n < MIN_SCANS)

    points = []
    for fid, fp in fps.items():
        n = len(fp['scans'])
        aps = {}
        for b in keep:
            vals = [sc[b] for sc in fp['scans'] if b in sc]
            if vals:
                aps[b] = {'mean': round(float(np.mean(vals)), 1), 'std': round(float(np.std(vals)), 1),
                          'detect': round(len(vals) / n, 2)}
        if aps:
            points.append({'id': fid, 'level': fp['level'], 'x': round(float(np.mean(fp['x'])), 2),
                           'y': round(float(np.mean(fp['y'])), 2), 'n_scans': n, 'src': fp['src'], 'aps': aps})
    if not points:
        raise SystemExit(f'no usable WiFi fingerprints in {len(sessions)} session(s); nothing written')

    def temper(pts):
        # how much the engine should trust WiFi (likelihood tempering): static multi-scan survey points are reliable;
        # single scans taken while walking are 10–20 m off at times (tianmu LOWO eval)
        return 0.25 if sum(p['src'] == 'point' for p in pts) >= 0.5 * len(pts) else 0.05

    levels = sorted({p['level'] for p in points})
    level_params = {lv: {'likelihood_temper': temper([p for p in points if p['level'] == lv]),
                         'points': sum(1 for p in points if p['level'] == lv and p['src'] == 'point'),
                         'walk_bins': sum(1 for p in points if p['level'] == lv and p['src'] == 'walk')} for lv in levels}
    ap_info = {b: {'ssids': sorted(ap_meta[b]['ssids']), 'bssids': sorted(ap_meta[b]['bssids']),
                   'frequency': ap_meta[b]['frequency'], 'n_scans': seen[b]} for b in keep}
    session_ids = [s['session_id'] for s in sessions]
    os.makedirs(args.out, exist_ok=True)
    out_path = os.path.join(args.out, 'wifi_radiomap.json')
    if args.level != 'all' and os.path.exists(out_path):
        # merge: keep the other levels of the existing radiomap
        with open(out_path, encoding='utf8') as f:
            old = json.load(f)
        if (old.get('params') or {}).get('ap_grouping', 'none') != ('radio/v1' if group else 'none'):
            raise SystemExit('the existing radiomap was built with a different --group setting: rebuild all levels')
        others = [p for p in old.get('points') or [] if (p.get('level') or DEFAULT_LEVEL) != args.level]
        points = others + points
        used = {b for p in others for b in p['aps']}
        keep = sorted(set(keep) | used)
        ap_info = {**{b: v for b, v in (old.get('ap_info') or {}).items() if b in used}, **ap_info}
        old_levels = (old.get('params') or {}).get('levels') or {}
        for lv in {p.get('level') or DEFAULT_LEVEL for p in others} - set(old_levels):
            old_levels[lv] = {'likelihood_temper': (old.get('params') or {}).get('likelihood_temper', 0.05)}
        level_params = {**{k: v for k, v in old_levels.items() if k != args.level}, **level_params}
        levels = sorted(level_params)
        session_ids = sorted(set(old.get('sessions') or []) | set(session_ids))
    out = {
        'schema': 'tpnav-radiomap/0', 'venue': 'tianmu', 'levels': levels,
        'built_at': int(time.time() * 1000), 'sessions': session_ids,
        'synthetic': any(s.get('synthetic') or s['session_id'].startswith('synthetic-') for s in sessions),
        'params': {'min_scans': MIN_SCANS, 'stale_ms': STALE_MS, 'scan_lag_ms': SCAN_LAG_MS, 'missing_dbm': -100,
                   'walk_bin_m': args.walk_bin,
                   # 'radio/v1': bssids below are radio keys (see ap_key); the engine groups scan results the same way
                   'ap_grouping': 'radio/v1' if group else 'none',
                   'allowlist': {'file': os.path.relpath(args.allowlist, ROOT).replace(os.sep, '/'), 'rules': [f'{k} {v}' for k, v in rules]}
                   if rules else None,
                   # per level: the WiFi weight for the engine (likelihood tempering) and fingerprint counts
                   'levels': level_params,
                   'likelihood_temper': temper(points)},
        'bssids': keep,
        'ap_info': ap_info,
        'points': points,
    }
    with open(out_path, 'w', encoding='utf8') as f:
        json.dump(out, f, ensure_ascii=False, separators=(',', ':'))

    # ---- report
    if args.quiet:
        return
    n_pt = [p for p in points if p['src'] == 'point']
    n_wk = [p for p in points if p['src'] == 'walk']
    strong = np.array([sum(1 for a in p['aps'].values() if a['detect'] >= 0.5) for p in points]) if points else np.zeros(1)
    print(f"sessions: {', '.join(out['sessions'])}")
    print(f"allowlist: {', '.join(out['params']['allowlist']['rules']) if rules else 'none (all APs except phone hotspots)'}")
    print(f'APs kept: {len(keep)} {"radios" if group else "BSSIDs"} from {sum(len(ap_meta[b]["bssids"]) for b in keep)} BSSIDs  '
          f'(dropped BSSIDs: {len(dropped["local_admin"])} locally-administered, {len(dropped["filtered"])} filtered; '
          f'{len(rare)} {"radios" if group else "BSSIDs"} seen in <{MIN_SCANS} scans)')
    print(f'fingerprints: {len(n_pt)} survey points + {len(n_wk)} walk-scan cells')
    for lv, lp in out['params']['levels'].items():
        lpts = [p for p in out['points'] if (p.get('level') or DEFAULT_LEVEL) == lv]
        st = [sum(1 for a in p['aps'].values() if a['detect'] >= 0.5) for p in lpts] or [0]
        print(f"  {lv}: {sum(p['src'] == 'point' for p in lpts)} survey points + {sum(p['src'] == 'walk' for p in lpts)} "
              f"walk-scan cells, APs heard reliably per fingerprint median {np.median(st):.0f}, WiFi weight "
              f"{lp['likelihood_temper']}" + ('' if args.level in ('all', lv) else '   (kept from the existing file)'))
    print(f'APs per fingerprint with detect>=0.5: min {strong.min()} / median {np.median(strong):.0f} / max {strong.max()}')
    if n_pt:
        few = [p['id'] for p in n_pt if p['n_scans'] < 3]
        weak = [p['id'] for p in n_pt if sum(1 for a in p['aps'].values() if a['detect'] >= 0.5) < 4]
        print(f'survey points: scans/point min {min(p["n_scans"] for p in n_pt)}, '
              f'median {np.median([p["n_scans"] for p in n_pt]):.0f}')
        if few:
            print(f'  WARNING {len(few)} points with <3 scans: {", ".join(few[:12])}{" ..." if len(few) > 12 else ""}')
        if weak:
            print(f'  WARNING {len(weak)} points hear <4 APs reliably: {", ".join(weak[:12])}')
    print(f'-> {out_path}')
    for lv in out['levels']:
        preview([p for p in out['points'] if (p.get('level') or DEFAULT_LEVEL) == lv], lv)


def preview(points, level):
    walls_path = os.path.join(VENUE_DIR, 'levels', level, 'walls.geojson')
    x0, y0, x1, y1, sc = -15, -5, 90, 72, 8
    W, H = int((x1 - x0) * sc), int((y1 - y0) * sc)
    im = Image.new('RGB', (W, H), 'white')
    d = ImageDraw.Draw(im)
    px = lambda x, y: ((x - x0) * sc, (y1 - y) * sc)
    if os.path.exists(walls_path):
        with open(walls_path, encoding='utf8') as f:
            for ft in json.load(f)['features']:
                if ft['properties'].get('layer') in ('wall', 'column'):
                    d.line([px(*c) for c in ft['geometry']['coordinates']], fill=(190, 190, 190), width=1)
    for p in points:
        n = sum(1 for a in p['aps'].values() if a['detect'] >= 0.5)
        t = min(1.0, n / 15)
        col = (int(230 * (1 - t)), int(60 + 150 * t), 60)
        r = 5 if p['src'] == 'point' else 3
        x, y = px(p['x'], p['y'])
        d.ellipse([x - r, y - r, x + r, y + r], fill=col)
    d.text((10, 10), f'{level} radiomap: dot colour = APs heard reliably (red 0 -> green 15+); big = survey point', fill='black')
    os.makedirs(BUILD_DIR, exist_ok=True)
    im.save(os.path.join(BUILD_DIR, f'radiomap_{level}.png'))


if __name__ == '__main__':
    main()
