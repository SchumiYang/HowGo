"""Build the magnetic map of one level from survey walks (SURVEY_SCHEMA.md §2 -> §3).

Per walk:
- positions from tools/walktrack.py: step-proportional arc length along walk.path, anchored at t_start / t_end and
  at gyro-detected corners (marks only as a fallback; their `vertex` field is a tap count, not a vertex);
- registration: each walk's |B| profile along the plan is cross-correlated with the other recordings of the same
  plan walk and shifted by the best lag (|lag| <= MAX_SHIFT_M, only if the correlation clearly improves);
- gravity (up) unit vector from the zero-phase low-passed accelerometer; orientation-invariant features per
  magnetometer sample: B = |m|, Bv = m · u_up (northern hemisphere: negative), Bh = sqrt(B² − Bv²);
- features low-passed (0.5 s moving average) and binned onto a CELL_M grid restricted to walkable units.
Across walks: per-session device offsets (median difference vs the all-session map, iterated) are subtracted, then
every recording contributes its own cell mean with equal weight (forward and reverse are averaged).

Report: per area (corridors / arena) forward-vs-reverse RMS and correlation for three position models (old mark
interpolation, steps+corners, + registration), spatial std, cross-device RMS, device offsets.

Output: data/tianmu/positioning/magmap_<level>.json, build/magmap_<level>.png, build/walk_tracks.json (reconstructed
        positions, used by the leave-one-walk-out evaluation)
Usage : py -3.12 -I tools/build_magmap.py [--include-synthetic | --synthetic-only] [--level all|1F|2F] [--cell 0.5] [--exclude GLOB]
        [--exclude-walk 'SESSION|WALK|DIRECTION|N' (globs ok, repeatable)] [--out DIR] [--tracks FILE]
"""
import argparse
import fnmatch
import glob
import importlib.util
import json
import os
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

# keep in sync with indoor-nav/src/positioning/grid.ts DEFAULT_WALKABLE
WALKABLE = {'corridor', 'lobby', 'walkway', 'restroom.male', 'restroom.female', 'restroom.accessible',
            'restroom.unisex', 'elevator', 'first_aid', 'court'}
GRID_X0, GRID_Y0 = -15.0, -5.0          # grid origin (local metres); cell i covers [x0 + i*c, x0 + (i+1)*c)
GRID_W_M, GRID_H_M = 110.0, 80.0
GRAVITY_TAU_S = 1.0
FEATURE_SMOOTH_S = 0.5
FEATURES = ('B', 'Bv', 'Bh')
DEFAULT_LEVEL = '1F'     # level of walks recorded without one (sessions before multi-level surveys)
PROFILE_BIN_M = 0.5
MAX_SHIFT_M = 3.0
MIN_CORR_GAIN = 0.03


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


def walk_keys(session):
    """'session|walk_id|direction|n' for every walk (n counts repeats of the same walk + direction)."""
    seen = {}
    for w in session.get('walks') or []:
        k = (w['walk_id'], w.get('direction', 'forward'))
        n = seen[k] = seen.get(k, -1) + 1
        yield f"{session['session_id']}|{w['walk_id']}|{k[1]}|{n}", w


def legacy_arc_length(walk, times):
    """The old model (constant speed between t_start / marks-as-vertex / t_end), only for the comparison report."""
    pts = np.array(walk['path'], float)
    cum = np.concatenate([[0], np.cumsum(np.hypot(*np.diff(pts, axis=0).T))])
    kt, ks = [walk['t_start']], [0.0]
    for m in sorted(walk.get('marks') or [], key=lambda m: m['t']):
        v = m.get('vertex')
        if v is not None and 0 < v < len(pts) - 1 and kt[-1] < m['t'] < walk['t_end'] and cum[v] > ks[-1]:
            kt.append(m['t'])
            ks.append(cum[v])
    kt.append(walk['t_end'])
    ks.append(cum[-1])
    return np.interp(times, kt, ks)


def moving_average(t_ms, v, win_s):
    """Centered moving average by time window (v: (N,) or (N, k))."""
    c = np.cumsum(np.concatenate([np.zeros((1,) + v.shape[1:]), v]), axis=0)
    lo = np.searchsorted(t_ms, t_ms - win_s * 500, 'left')
    hi = np.searchsorted(t_ms, t_ms + win_s * 500, 'right')
    n = (hi - lo).reshape((-1,) + (1,) * (v.ndim - 1))
    return (c[hi] - c[lo]) / n


def walk_features(walk):
    """-> (t, features (N, 3)) of the magnetometer samples inside [t_start, t_end], or None."""
    acc = walktrack.sensor(walk, 'accelerometer')
    mag = walktrack.sensor(walk, 'magnetometer')
    if len(acc) < 50 or len(mag) < 50:
        return None
    up_acc = walktrack.gravity_up(acc, GRAVITY_TAU_S)
    up = np.stack([np.interp(mag[:, 0], acc[:, 0], up_acc[:, i]) for i in range(3)], 1)
    up /= np.linalg.norm(up, axis=1, keepdims=True)
    m = mag[:, 1:]
    B = np.linalg.norm(m, axis=1)
    Bv = (m * up).sum(1)
    Bh = np.sqrt(np.maximum(B ** 2 - Bv ** 2, 0))
    feats = moving_average(mag[:, 0], np.stack([B, Bv, Bh], 1), FEATURE_SMOOTH_S)
    sel = (mag[:, 0] >= walk['t_start']) & (mag[:, 0] <= walk['t_end'])
    return (mag[sel, 0], feats[sel]) if sel.sum() >= 10 else None


def walkable_mask(level, cell):
    with open(os.path.join(VENUE_DIR, 'levels', level, 'units.geojson'), encoding='utf8') as f:
        units = json.load(f)['features']
    W, H = int(GRID_W_M / cell), int(GRID_H_M / cell)
    im = Image.new('L', (W, H), 0)
    d = ImageDraw.Draw(im)
    for u in units:
        if u['properties'].get('category') not in WALKABLE:
            continue
        polys = [u['geometry']['coordinates']] if u['geometry']['type'] == 'Polygon' else u['geometry']['coordinates']
        for poly in polys:
            d.polygon([((x - GRID_X0) / cell, (y - GRID_Y0) / cell) for x, y in poly[0]], fill=1)
    m = np.array(im, bool)       # [row = y index, col = x index]
    grown = m.copy()             # tolerate walks hugging a unit edge (one cell)
    grown[1:] |= m[:-1]
    grown[:-1] |= m[1:]
    grown[:, 1:] |= m[:, :-1]
    grown[:, :-1] |= m[:, 1:]
    return grown


def area_of(walk_id):
    return 'arena' if 'arena' in walk_id else 'corridors'


def plan_coord(r, s):
    """arc length along the walk -> arc length along the plan LineString (reverse walks run backwards)."""
    return s if r['direction'] == 'forward' else r['L'] - s


def profile(r, s_key, offset=0.0):
    """Mean features per PROFILE_BIN_M bin of plan arc length: dict bin -> (3,) array."""
    u = plan_coord(r, r[s_key])
    b = np.floor(u / PROFILE_BIN_M).astype(int)
    out = {}
    for k in np.unique(b):
        out[int(k)] = r['f'][b == k].mean(0) - offset
    return out


def corr_at_lag(a, b, lag):
    """Pearson correlation of |B| between profiles a and b with b shifted by lag bins."""
    common = [k for k in a if k + lag in b]
    if len(common) < 10:
        return -1.0
    x = np.array([a[k][0] for k in common])
    y = np.array([b[k + lag][0] for k in common])
    if x.std() < 1e-6 or y.std() < 1e-6:
        return -1.0
    return float(np.corrcoef(x, y)[0, 1])


def mean_profile(profiles):
    acc = {}
    for p in profiles:
        for k, v in p.items():
            acc.setdefault(k, []).append(v)
    return {k: np.mean(v, 0) for k, v in acc.items()}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--include-synthetic', action='store_true')
    ap.add_argument('--synthetic-only', action='store_true', help='only synthetic-* sessions (evaluation maps)')
    ap.add_argument('--level', default='all', help="'all' (default): every level that has walks; or one level")
    ap.add_argument('--cell', type=float, default=0.5)
    ap.add_argument('--exclude', action='append', default=[], help='session id glob to skip (repeatable)')
    ap.add_argument('--exclude-walk', action='append', default=[], help="'SESSION|WALK|DIRECTION|N' glob (repeatable)")
    ap.add_argument('--no-register', action='store_true', help='skip the cross-correlation shift')
    ap.add_argument('--out', default=OUT_DIR, help='output directory (default data/tianmu/positioning)')
    ap.add_argument('--tracks', default=os.path.join(BUILD_DIR, 'walk_tracks.json'), help="reconstructed walk positions ('' = none)")
    ap.add_argument('--quiet', action='store_true')
    args = ap.parse_args()
    listed = excluded_walks()
    if listed and not args.quiet:
        print(f'excluding {len(listed)} walk(s) listed in survey/exclude_walks.txt')
    args.exclude_walk = args.exclude_walk + listed
    sessions = load_sessions('only' if args.synthetic_only else args.include_synthetic, args.exclude)
    if args.level == 'all':
        levels = sorted({w.get('level') or DEFAULT_LEVEL for s in sessions for w in s.get('walks') or []})
        if not levels:
            raise SystemExit(f'no walks in {len(sessions)} session(s); nothing written')
    else:
        levels = [args.level]
    tracks = {}
    for level in levels:
        if len(levels) > 1 and not args.quiet:
            print(f'===== {level}')
        build_level(args, level, sessions, tracks)
    if args.tracks:
        os.makedirs(os.path.dirname(args.tracks), exist_ok=True)
        with open(args.tracks, 'w', encoding='utf8') as f:
            json.dump(tracks, f, separators=(',', ':'))
        if not args.quiet:
            print(f'-> {args.tracks}')


def build_level(args, level, sessions, tracks):
    """Magnetic map of one level -> <out>/magmap_<level>.json; adds the level's reconstructed walks to tracks."""
    cell = args.cell
    say = (lambda *a: None) if args.quiet else print
    mask = walkable_mask(level, cell)
    recs = []
    for s in sessions:
        for key, w in walk_keys(s):
            if (w.get('level') or DEFAULT_LEVEL) != level or any(fnmatch.fnmatch(key, p) for p in args.exclude_walk):
                continue
            r = walk_features(w)
            if r is None:
                say(f'  skip {key}: no usable sensor data')
                continue
            tr = walktrack.WalkTrack(w)
            t, f = r
            recs.append({'key': key, 'session': s['session_id'], 'model': (s.get('device') or {}).get('model'),
                         'walk_id': w['walk_id'], 'direction': w.get('direction', 'forward'), 'walk': w, 'track': tr,
                         'L': float(tr.cum[-1]), 't': t, 'f': f, 's_legacy': legacy_arc_length(w, t),
                         's_track': tr.arc_length(t), 'shift': 0.0})
            say(f'  {key}: {tr.summary()}')
    if not recs:
        raise SystemExit(f'{level}: no usable walks in {len(sessions)} session(s) (synthetic excluded unless --include-synthetic)'
                         '; nothing written')

    # ---- registration: shift each recording along the plan to best match the other recordings of the same walk
    for r in recs:
        r['s_reg'] = r['s_track'].copy()
    groups = {}
    for r in recs:
        groups.setdefault(r['walk_id'], []).append(r)
    max_lag = int(MAX_SHIFT_M / PROFILE_BIN_M)
    if not args.no_register:
        for _ in range(2):
            for wid, g in groups.items():
                if len(g) < 2:
                    continue
                for r in g:
                    ref = mean_profile([profile(o, 's_reg') for o in g if o is not r])
                    p = profile(r, 's_reg')
                    c0 = corr_at_lag(ref, p, 0)
                    lags = [(corr_at_lag(ref, p, lag), lag) for lag in range(-max_lag, max_lag + 1)]
                    cb, lb = max(lags)
                    if lb != 0 and cb - c0 >= MIN_CORR_GAIN:
                        # p[k + lb] matches ref[k]: move this recording by −lb bins along the plan
                        du = -lb * PROFILE_BIN_M
                        r['shift'] += du
                        r['s_reg'] = r['s_reg'] + (du if r['direction'] == 'forward' else -du)
                # gauge: recordings of one walk shift by zero on average
                mean_shift = np.mean([r['shift'] for r in g])
                for r in g:
                    du = -mean_shift
                    r['shift'] += du
                    r['s_reg'] = r['s_reg'] + (du if r['direction'] == 'forward' else -du)
    for r in recs:
        s = np.clip(r['s_reg'], 0, r['L'])
        tr = r['track']
        r['x'], r['y'] = np.interp(s, tr.cum, tr.pts[:, 0]), np.interp(s, tr.cum, tr.pts[:, 1])

    # ---- grid cells per recording
    outside = total = 0
    for r in recs:
        i = np.floor((r['x'] - GRID_X0) / cell).astype(int)
        j = np.floor((r['y'] - GRID_Y0) / cell).astype(int)
        ok = (i >= 0) & (j >= 0) & (i < mask.shape[1]) & (j < mask.shape[0])
        ok[ok] &= mask[j[ok], i[ok]]
        total += len(ok)
        outside += int((~ok).sum())
        cells = {}
        for ii, jj, ff in zip(i[ok], j[ok], r['f'][ok]):
            a = cells.setdefault((ii, jj), [np.zeros(3), 0])
            a[0] += ff
            a[1] += 1
        r['cells'] = {k: v[0] / v[1] for k, v in cells.items()}
        r['n'] = {k: v[1] for k, v in cells.items()}

    # ---- per-session device offsets (iterate: global map <-> offsets)
    sess_ids = sorted({r['session'] for r in recs})
    offsets = {s: np.zeros(3) for s in sess_ids}

    def combine(selected):
        acc = {}
        for r in selected:
            for k, v in r['cells'].items():
                a = acc.setdefault(k, [np.zeros(3), 0, 0, set()])
                a[0] += v - offsets[r['session']]
                a[1] += 1
                a[2] += r['n'][k]
                a[3].add(r['session'])
        return {k: (a[0] / a[1], a[1], a[2], a[3]) for k, a in acc.items()}

    if len(sess_ids) > 1:
        for _ in range(8):
            glob_map = combine(recs)
            for s in sess_ids:
                diffs = [v - offsets[s] - glob_map[k][0] for r in recs if r['session'] == s for k, v in r['cells'].items()
                         if len(glob_map[k][3]) > 1]
                if len(diffs) >= 20:
                    offsets[s] = offsets[s] + np.median(np.array(diffs), axis=0)
            mean_off = np.mean([offsets[s] for s in sess_ids], axis=0)
            for s in sess_ids:
                offsets[s] = offsets[s] - mean_off
    final = combine(recs)

    # ---- repeatability report per area and position model
    say(f"sessions: {', '.join(sess_ids)}")
    say(f'recordings: {len(recs)}; samples outside walkable units dropped: {outside}/{total}')
    vals = np.array([v[0] for v in final.values()])
    sp_std = vals.std(0)
    say(f'cells: {len(final)} ({cell} m) ~ {len(final) * cell:.0f} m; recordings per cell: '
        f'median {np.median([v[1] for v in final.values()]):.0f}')

    def pair_stats(s_key):
        """forward-vs-reverse (and repeat) comparisons of plan-coordinate profiles, offset-corrected."""
        out = {}
        for wid, g in groups.items():
            fw = [r for r in g if r['direction'] == 'forward']
            rv = [r for r in g if r['direction'] == 'reverse']
            if not fw or not rv:
                continue
            a = mean_profile([profile(r, s_key, offsets[r['session']]) for r in fw])
            b = mean_profile([profile(r, s_key, offsets[r['session']]) for r in rv])
            common = [k for k in a if k in b]
            if len(common) < 10:
                continue
            d = np.array([a[k] - b[k] for k in common])
            out[wid] = {'rms': np.sqrt((d ** 2).mean(0)), 'corr': corr_at_lag(a, b, 0), 'n': len(common),
                        'std': np.array([a[k] for k in common]).std(0)}
        return out

    models = [('marks (old)', 's_legacy'), ('steps+corners', 's_track'), ('+registration', 's_reg')]
    report = {}
    for name, key in models:
        ps = pair_stats(key)
        for area in ('corridors', 'arena'):
            sel = [v for wid, v in ps.items() if area_of(wid) == area]
            if not sel:
                continue
            w = np.array([v['n'] for v in sel], float)
            rms = np.sqrt((np.array([v['rms'] ** 2 for v in sel]) * w[:, None]).sum(0) / w.sum())
            corr = float((np.array([v['corr'] for v in sel]) * w).sum() / w.sum())
            std = np.sqrt((np.array([v['std'] ** 2 for v in sel]) * w[:, None]).sum(0) / w.sum())
            report.setdefault(area, {})[name] = {'rms_B': round(float(rms[0]), 2), 'rms_Bv': round(float(rms[1]), 2),
                                                 'corr_B': round(corr, 2), 'std_B': round(float(std[0]), 2),
                                                 'm': int(w.sum() * PROFILE_BIN_M)}
    say('repeatability, forward vs reverse (offset-corrected), per area:')
    for area, rows in report.items():
        for name, v in rows.items():
            ratio = v['std_B'] / max(v['rms_B'], 1e-6)
            say(f"  {area:9s} {name:15s} over {v['m']:4d} m: RMS B {v['rms_B']:5.2f} uT, Bv {v['rms_Bv']:5.2f} uT, "
                f"corr {v['corr_B']:.2f}, spatial std B {v['std_B']:5.2f} uT (signal/noise {ratio:.1f})")
        best = rows.get('+registration') or rows.get('steps+corners')
        if best:
            ratio = best['std_B'] / max(best['rms_B'], 1e-6)
            v = 'GOOD' if ratio >= 2.5 else 'MARGINAL' if ratio >= 1.5 else 'POOR'
            rows['verdict'] = v
            say(f'  verdict {area}: {v}')
    # per-recording consistency: |B| RMS against the mean of the other recordings of the same walk
    consistency = {}
    for wid, g in groups.items():
        if len(g) < 2:
            continue
        for r in g:
            ref = mean_profile([profile(o, 's_reg', offsets[o['session']]) for o in g if o is not r])
            p = profile(r, 's_reg', offsets[r['session']])
            common = [k for k in p if k in ref]
            if len(common) >= 10:
                consistency[r['key']] = round(float(np.sqrt(np.mean([(p[k][0] - ref[k][0]) ** 2 for k in common]))), 2)
    if consistency:
        med = float(np.median(list(consistency.values())))
        worst = sorted(consistency.items(), key=lambda kv: -kv[1])[:5]
        say(f'per-recording |B| RMS vs the other recordings of the same walk: median {med:.2f} uT; worst: '
            + ', '.join(f"{k.split('|', 1)[1]} [{k.split('|')[0][-5:]}] {v:.2f}" for k, v in worst))
        for k, v in consistency.items():
            if v > 2 * med:
                say(f'  WARNING {k}: {v:.2f} uT (> 2x median) - check it, or drop it with --exclude-walk')
    shifts = [(r['key'], r['shift']) for r in recs if abs(r['shift']) > 1e-9]
    if shifts:
        say('registration shifts (m): ' + ', '.join(f"{k.split('|', 1)[1]} {v:+.1f}" for k, v in shifts))
    xdev = {}
    for a in range(len(sess_ids)):
        for b in range(a + 1, len(sess_ids)):
            A = combine([r for r in recs if r['session'] == sess_ids[a]])
            Bm = combine([r for r in recs if r['session'] == sess_ids[b]])
            common = [k for k in A if k in Bm]
            if len(common) >= 10:
                d = np.array([A[k][0] - Bm[k][0] for k in common])
                rms = np.sqrt((d ** 2).mean(0))
                xdev[f'{sess_ids[a]}|{sess_ids[b]}'] = {f: round(float(rms[i]), 2) for i, f in enumerate(FEATURES)}
                say(f'cross-device [{sess_ids[a]} vs {sess_ids[b]}] after offsets, {len(common)} cells: RMS '
                    + ', '.join(f'{f} {rms[i]:.2f} uT' for i, f in enumerate(FEATURES)))
    for s in sess_ids:
        say(f'device offset {s}: ' + ', '.join(f'{f} {offsets[s][i]:+.2f}' for i, f in enumerate(FEATURES)))

    cells_out = []
    for (i, j), (v, nw, ns, _) in sorted(final.items(), key=lambda kv: (kv[0][1], kv[0][0])):
        cells_out.append({'x': round(GRID_X0 + (i + 0.5) * cell, 2), 'y': round(GRID_Y0 + (j + 0.5) * cell, 2),
                          'B': round(float(v[0]), 2), 'Bv': round(float(v[1]), 2), 'Bh': round(float(v[2]), 2),
                          'n': int(ns), 'walks': int(nw)})
    best_rms = {area: rows.get('+registration', rows.get('steps+corners', {})).get('rms_B') for area, rows in report.items()}
    out = {
        'schema': 'tpnav-magmap/0', 'venue': 'tianmu', 'level': level, 'built_at': int(time.time() * 1000),
        'sessions': sess_ids,
        'synthetic': any(s.startswith('synthetic-') for s in sess_ids),
        'cell_m': cell, 'grid_origin': [GRID_X0, GRID_Y0],
        'features': {'B': '|B| uT', 'Bv': 'B · u_up uT, u_up = low-passed accelerometer direction (up); '
                                        'negative in the northern hemisphere', 'Bh': 'sqrt(B² − Bv²) uT'},
        'device_offsets': {s: {'model': next(r['model'] for r in recs if r['session'] == s),
                               **{f: round(float(offsets[s][i]), 2) for i, f in enumerate(FEATURES)}}
                           for s in sess_ids},
        'offset_note': 'Per-session offsets were subtracted (gauge: mean offset of all sessions = 0). Phones differ '
                       'by a few uT; the engine estimates a per-device bias online.',
        'stats': {'cells': len(cells_out), 'spatial_std': {f: round(float(sp_std[i]), 2) for i, f in enumerate(FEATURES)},
                  'repeatability': report, 'fwd_rev_rms_B': best_rms, 'recording_rms_B': consistency, 'cross_session_rms': xdev,
                  'excluded_walks': args.exclude_walk},
        'cells': cells_out,
    }
    os.makedirs(args.out, exist_ok=True)
    out_path = os.path.join(args.out, f'magmap_{level}.json')
    with open(out_path, 'w', encoding='utf8') as f:
        json.dump(out, f, ensure_ascii=False, separators=(',', ':'))
    say(f'-> {out_path}')
    if args.tracks:
        for r in recs:
            w = r['walk']
            t = np.arange(w['t_start'], w['t_end'], 100.0)
            s = np.clip(r['track'].arc_length(t) + (r['shift'] if r['direction'] == 'forward' else -r['shift']), 0, r['L'])
            tr = r['track']
            tracks[r['key']] = {'walk_id': r['walk_id'], 'direction': r['direction'], 'area': area_of(r['walk_id']), 'level': level,
                                't': [round(float(v), 1) for v in t],
                                'x': [round(float(v), 2) for v in np.interp(s, tr.cum, tr.pts[:, 0])],
                                'y': [round(float(v), 2) for v in np.interp(s, tr.cum, tr.pts[:, 1])]}
    if not args.quiet:
        say(f'-> {preview(cells_out, level, cell)}')


RAMP = [(0.0, (68, 1, 84)), (0.25, (59, 82, 139)), (0.5, (33, 145, 140)), (0.75, (94, 201, 98)), (1.0, (253, 231, 37))]


def ramp(t):
    t = min(1.0, max(0.0, t))
    for (t0, c0), (t1, c1) in zip(RAMP[:-1], RAMP[1:]):
        if t <= t1:
            u = (t - t0) / (t1 - t0)
            return tuple(int(c0[k] + u * (c1[k] - c0[k])) for k in range(3))
    return RAMP[-1][1]


def preview(cells, level, cell):
    x0, y0, x1, y1, sc = -15, -5, 90, 72, 8
    W, H = int((x1 - x0) * sc), int((y1 - y0) * sc)
    with open(os.path.join(VENUE_DIR, 'levels', level, 'walls.geojson'), encoding='utf8') as f:
        walls = [ft for ft in json.load(f)['features'] if ft['properties'].get('layer') in ('wall', 'column')]
    panels = []
    for feat in ('B', 'Bv'):
        im = Image.new('RGB', (W, H), 'white')
        d = ImageDraw.Draw(im)
        px = lambda x, y: ((x - x0) * sc, (y1 - y) * sc)
        for ft in walls:
            d.line([px(*c) for c in ft['geometry']['coordinates']], fill=(200, 200, 200), width=1)
        v = np.array([c[feat] for c in cells])
        lo, hi = np.percentile(v, 2), np.percentile(v, 98)
        h = cell * sc / 2
        for c in cells:
            x, y = px(c['x'], c['y'])
            d.rectangle([x - h, y - h, x + h, y + h], fill=ramp((c[feat] - lo) / max(hi - lo, 1e-6)))
        d.text((10, 8), f'{level} magnetic map: {feat} (uT)  {lo:.1f} (purple) .. {hi:.1f} (yellow)', fill='black')
        for k in range(101):
            d.line([(10 + k * 2, 26), (10 + k * 2, 36)], fill=ramp(k / 100), width=2)
        panels.append(im)
    out = Image.new('RGB', (W * 2 + 10, H), 'white')
    out.paste(panels[0], (0, 0))
    out.paste(panels[1], (W + 10, 0))
    os.makedirs(BUILD_DIR, exist_ok=True)
    path = os.path.join(BUILD_DIR, f'magmap_{level}.png')
    out.save(path)
    return path


if __name__ == '__main__':
    main()
