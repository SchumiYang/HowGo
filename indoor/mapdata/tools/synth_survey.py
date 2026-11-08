"""Generate SYNTHETIC survey sessions (SURVEY_SCHEMA.md format) for 1F, to build and validate the positioning
stack before real survey data exists.

World model (deterministic for a given --seed):
- WiFi: 17 dual-band APs (one 2.4 GHz + one 5 GHz BSSID each) inside/around the building. Mean RSSI =
  log-distance path loss + per-crossing wall attenuation (crossings counted against the walls.geojson 'wall' layer)
  + a static, spatially smooth shadowing field per BSSID. Each scan adds temporal noise, deep fades, sensitivity
  cut-off and random dropouts, plus junk: phone hotspots (locally administered BSSIDs) and one-off far APs.
- Magnetic field: Earth field for Taipei (45 µT, inclination 36° down, declination −4.5°) + anomalies
  (vector Gaussian blobs at structural columns and random steel, plus smooth building-scale variation).
- Walker: ~1.2 m/s, ~1.8 Hz steps, phone flat (survey) or tilted 25° (test walk), stride sway; accelerometer
  (incl. gravity), gyroscope and magnetometer are rendered in the Android device frame at ~50 Hz with noise,
  gyro bias and magnetometer hard-iron residual per device.

Outputs (mapdata/survey/raw/, always prefixed `synthetic-` so they are never mistaken for real data):
- synthetic-survey-a.json   point survey (4 scans/point) + every plan walk forward and reverse (device A)
- synthetic-survey-b.json   every plan walk forward only, second device with a different magnetometer offset
- synthetic-survey-2f.json  2F point survey + every 2F plan walk forward and reverse (device A)
- synthetic-test.json       held-out evaluation walks with ground truth (`purpose: "evaluation"`, walk.truth);
                            map builders skip it. Walk 1 = main entrance -> accessible toilet, walk 2 = long loop,
                            walks 3–5 = out of the arena through the SW / NW / SE door, walks 6–8 = 1F -> elevator up ->
                            2F west corridor -> elevator down -> 1F (multi-level).

Usage: py -3.12 -I tools/synth_survey.py [--seed 7]
"""
import argparse
import heapq
import json
import math
import os

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VENUE_DIR = os.path.join(ROOT, 'data', 'tianmu')
RAW_DIR = os.path.join(ROOT, 'survey', 'raw')
LEVEL = '1F'

G = 9.80665
DT = 0.005                      # internal simulation step (200 Hz)
SENSOR_PERIOD_MS = 20.0         # ~50 Hz per sensor
EARTH_TOTAL_UT = 45.0
EARTH_INCL_DEG = 36.0
DECLINATION_DEG = -4.5          # Taipei, magnetic north is ~4.5° west of true north


# ---------------------------------------------------------------- geometry

def load_json(*parts):
    with open(os.path.join(VENUE_DIR, *parts), encoding='utf8') as f:
        return json.load(f)


def load_geometry(level=LEVEL):
    venue = load_json('venue.json')
    walls = load_json('levels', level, 'walls.geojson')['features']
    units = load_json('levels', level, 'units.geojson')['features']
    nav = load_json('nav.geojson')['features']
    plan = load_json('survey', f'{level}_plan.geojson')['features']
    segs, cols = [], {}
    for f in walls:
        c = f['geometry']['coordinates']
        layer = f['properties'].get('layer')
        if layer == 'wall':
            segs += [a + b for a, b in zip(c[:-1], c[1:])]
        elif layer == 'column':
            pts = np.array(c[:-1] if c[0] == c[-1] and len(c) > 2 else c, float)
            cx, cy = pts.mean(0)
            cols[(round(cx * 2) / 2, round(cy * 2) / 2)] = (cx, cy)
    nodes = {f['properties']['id']: tuple(f['geometry']['coordinates'])
             for f in nav if f['properties']['kind'] == 'node' and f['properties']['level'] == level}
    edges = [f['properties'] for f in nav if f['properties']['kind'] == 'edge']
    centroids = {}
    for f in units:
        ring = np.array(f['geometry']['coordinates'][0], float)
        centroids[f['properties']['id']] = tuple(ring[:-1].mean(0))
    return {
        'venue': venue, 'segs': np.array(segs, float), 'columns': np.array(list(cols.values()), float),
        'nodes': nodes, 'edges': edges, 'plan': plan, 'centroids': centroids, 'level': level,
    }


def count_crossings(a, p, segs):
    """Number of wall segments crossed by each segment a[k] -> p[k]. a, p: (K, 2)."""
    ax, ay, px, py = a[:, :1], a[:, 1:], p[:, :1], p[:, 1:]
    x1, y1, x2, y2 = (segs[:, i][None, :] for i in range(4))
    d1 = (px - ax) * (y1 - ay) - (py - ay) * (x1 - ax)
    d2 = (px - ax) * (y2 - ay) - (py - ay) * (x2 - ax)
    d3 = (x2 - x1) * (ay - y1) - (y2 - y1) * (ax - x1)
    d4 = (x2 - x1) * (py - y1) - (y2 - y1) * (px - x1)
    return ((d1 * d2 < 0) & (d3 * d4 < 0)).sum(1)


def shortest_path(geo, a, b):
    adj = {}
    for e in geo['edges']:
        if not e['accessible'] or e['from'] not in geo['nodes'] or e['to'] not in geo['nodes']:
            continue
        adj.setdefault(e['from'], []).append((e['to'], e['length_m']))
        adj.setdefault(e['to'], []).append((e['from'], e['length_m']))
    dist, prev, pq = {a: 0.0}, {}, [(0.0, a)]
    while pq:
        d, u = heapq.heappop(pq)
        if u == b:
            break
        if d > dist[u]:
            continue
        for v, w in adj.get(u, []):
            if d + w < dist.get(v, 1e18):
                dist[v], prev[v] = d + w, u
                heapq.heappush(pq, (d + w, v))
    path = [b]
    while path[-1] != a:
        path.append(prev[path[-1]])
    return path[::-1]


def route_xy(geo, waypoints):
    """Waypoints are nav node ids (joined by shortest accessible paths) or explicit [x, y] points (straight legs)."""
    ids, pts = [], []
    for k, wp in enumerate(waypoints):
        if isinstance(wp, str) and k and isinstance(waypoints[k - 1], str):
            seg = shortest_path(geo, waypoints[k - 1], wp)[1:]
            ids += seg
            pts += [list(geo['nodes'][i]) for i in seg]
        else:
            ids.append(wp if isinstance(wp, str) else f'({wp[0]},{wp[1]})')
            pts.append(list(geo['nodes'][wp]) if isinstance(wp, str) else list(wp))
    return ids, pts


# ---------------------------------------------------------------- world: magnetic field

class MagField:
    def __init__(self, geo, rng):
        beta = math.radians(DECLINATION_DEG - geo['venue'].get('bearing_deg', 0.0))  # clockwise from local +y
        h = EARTH_TOTAL_UT * math.cos(math.radians(EARTH_INCL_DEG))
        z = -EARTH_TOTAL_UT * math.sin(math.radians(EARTH_INCL_DEG))
        self.earth = np.array([h * math.sin(beta), h * math.cos(beta), z])
        blobs = []
        for cx, cy in geo['columns']:              # reinforced concrete columns
            blobs.append((cx, cy, rng.uniform(1.0, 2.2), rng.uniform(4.0, 15.0)))
        for _ in range(60):                         # steel doors, ducts, equipment
            blobs.append((rng.uniform(-8, 80), rng.uniform(-2, 69), rng.uniform(0.8, 2.5), rng.uniform(2.0, 9.0)))
        b = np.array(blobs)
        self.bx, self.by, self.bs = b[:, 0], b[:, 1], b[:, 2]
        dirs = rng.normal(size=(len(b), 3))
        dirs /= np.linalg.norm(dirs, axis=1, keepdims=True)
        self.bv = dirs * b[:, 3:4]
        # smooth building-scale variation (rebar grids, slab)
        self.waves = [(rng.uniform(0, 2 * np.pi), 2 * np.pi / rng.uniform(5, 20), rng.uniform(0, 2 * np.pi),
                       rng.normal(size=3) * 1.2) for _ in range(8)]

    def __call__(self, x, y):
        x, y = np.atleast_1d(x), np.atleast_1d(y)
        d2 = (x[:, None] - self.bx[None]) ** 2 + (y[:, None] - self.by[None]) ** 2
        w = np.exp(-0.5 * d2 / self.bs[None] ** 2)
        out = self.earth[None] + w @ self.bv
        for ang, k, ph, amp in self.waves:
            out += np.sin(k * (x * math.cos(ang) + y * math.sin(ang)) + ph)[:, None] * amp[None]
        return out


# ---------------------------------------------------------------- world: WiFi

OUIS = ['00:1d:aa', 'f0:9f:c2', '3c:84:6a', '70:4f:57', 'b4:fb:e4']


class WifiWorld:
    def __init__(self, geo, rng):
        c = geo['centroids']
        aps = [
            ('lobby', 3.5, 34.0, 3.0), ('west-s', 10.5, 12.0, 2.8), ('west-n', 10.5, 52.0, 2.8),
            ('north-w', 30.0, 66.5, 2.8), ('north-c', 50.0, 66.5, 2.8), ('north-e', 68.0, 66.5, 2.8),
            ('east-n', 74.0, 48.0, 2.8), ('east-s', 74.0, 20.0, 2.8), ('south-e', 60.0, 1.5, 2.8),
            ('south-w', 35.0, 1.5, 2.8), ('arena-w', 30.0, 33.0, 8.0), ('arena-e', 57.0, 33.0, 8.0),
            ('office-A109', *c['1F-A109'], 2.5), ('room-A101', *c['1F-A101'], 2.5),
            ('firstaid-A120', *c['1F-A120'], 2.5), ('room-A116', *c['1F-A116'], 2.5),
            ('room-A104', *c['1F-A104'], 2.5),
            # neighbours outside the building: legitimate, stable fingerprints
            ('outside-w', -28.0, 50.0, 6.0), ('outside-n', 40.0, 92.0, 8.0),
        ]
        self.segs = {LEVEL: geo['segs']}
        self.bssids = []        # one entry per BSSID
        self._add_aps(aps, rng, LEVEL)
        # junk the radiomap builder must drop
        self.hotspots = [
            {'bssid': 'da:a1:19:5c:33:01', 'ssid': 'iPhone', 'frequency': 2437},
            {'bssid': '8a:2f:c4:10:9e:77', 'ssid': 'AndroidAP_5G3F', 'frequency': 5745},
            {'bssid': '3e:71:0b:aa:41:d2', 'ssid': 'Galaxy A71 8812', 'frequency': 2462},
        ]

    def add_level(self, geo, rng):
        """Another floor: its walls and its own corridor APs. Upper floors hear lower-floor APs through the slab."""
        self.segs[geo['level']] = geo['segs']
        aps = [('2f-west', 2.0, 40.0, 2.8), ('2f-east', 82.0, 28.0, 2.8), ('2f-north', 43.0, 66.0, 2.8),
               ('2f-south', 43.0, 2.0, 2.8), ('2f-nw', 12.0, 56.0, 2.8)]
        self._add_aps(aps, rng, geo['level'], first=len(self.bssids) // 2)

    def _add_aps(self, aps, rng, level, first=0):
        ssids = ['UTaipei-WiFi', 'Tianmu-Gym', 'TPE-Free']
        for i, (name, x, y, z) in enumerate(aps, start=first):
            oui = OUIS[i % len(OUIS)]
            base = rng.integers(0, 2 ** 24)
            for band in ('2.4', '5'):
                last = (base + (0 if band == '2.4' else 1)) % 2 ** 24
                mac = oui + ':' + ':'.join(f'{(last >> s) & 0xff:02x}' for s in (16, 8, 0))
                freq = int(rng.choice([2412, 2437, 2462])) if band == '2.4' else int(rng.choice([5180, 5220, 5745, 5785]))
                self.bssids.append({
                    'ap': name, 'bssid': mac, 'ssid': ssids[i % 3], 'frequency': freq, 'band': band,
                    'pos': (x, y, z), 'level': level,
                    'p0': rng.uniform(-36, -30) - (7.0 if band == '5' else 0.0),
                    'n': rng.uniform(1.9, 2.3) + (0.15 if band == '5' else 0.0),
                    'wall_db': 2.6 if band == '2.4' else 3.6,     # per CAD line crossed (walls have 2 faces)
                    'shadow': [(rng.uniform(0, 2 * np.pi), 2 * np.pi / rng.uniform(3, 12), rng.uniform(0, 2 * np.pi),
                                rng.normal(0, 1.4)) for _ in range(6)],
                })

    def audible(self, level):
        """BSSID indices a receiver on `level` can hear (1F: only 1F APs, which keeps the 1F data unchanged)."""
        return [i for i, b in enumerate(self.bssids) if b['level'] == level or level != LEVEL]

    def mean_rssi(self, idx, xy, level=LEVEL):
        """Deterministic mean RSSI of BSSID idx at receiver positions xy (K, 2) on `level`."""
        b = self.bssids[idx]
        ax, ay, az = b['pos']
        floor = b['level'] != level
        d = np.sqrt((xy[:, 0] - ax) ** 2 + (xy[:, 1] - ay) ** 2 + (az - 1.2 + (5.0 if floor else 0.0)) ** 2)
        walls = count_crossings(np.repeat([[ax, ay]], len(xy), 0), xy, self.segs[level])
        r = b['p0'] - 10 * b['n'] * np.log10(np.maximum(d, 1.0)) - np.minimum(walls * b['wall_db'], 38.0) \
            - (18.0 if floor else 0.0)
        for ang, k, ph, amp in b['shadow']:
            r += amp * np.sin(k * (xy[:, 0] * math.cos(ang) + xy[:, 1] * math.sin(ang)) + ph)
        return r

    def scan(self, rng, pos_at, collected_at, boot_epoch_ms, device_offset_db=0.0, sweep_ms=3000, rx_level=LEVEL):
        """One scan completing at collected_at. pos_at(t_ms) -> (x, y) of the receiver (on `rx_level`)."""
        idx = self.audible(rx_level)
        t0 = collected_at - sweep_ms
        # 2.4 GHz channels are swept first, then 5 GHz
        times = np.array([t0 + sweep_ms * (rng.uniform(0.05, 0.45) if self.bssids[i]['band'] == '2.4' else rng.uniform(0.5, 0.95))
                          for i in idx])
        xy = np.array([pos_at(t) for t in times])
        res = []
        for j, i in enumerate(idx):
            mean = self.mean_rssi(i, xy[j:j + 1], rx_level)[0] + device_offset_db
            level = mean + rng.normal(0, 2.5) - (rng.uniform(5, 12) if rng.random() < 0.05 else 0.0)
            p_drop = 0.06 + 1.0 / (1.0 + math.exp((level + 87.0) / 2.5))
            if level < -94 or rng.random() < p_drop:
                continue
            b = self.bssids[i]
            res.append({'bssid': b['bssid'], 'ssid': b['ssid'], 'level': int(round(level)),
                        'frequency': b['frequency'], 'timestamp': int((times[j] - boot_epoch_ms) * 1000)})
        for h in self.hotspots:
            if rng.random() < 0.3:
                res.append({**h, 'level': int(rng.uniform(-80, -50)),
                            'timestamp': int((collected_at - rng.uniform(200, 2800) - boot_epoch_ms) * 1000)})
        if rng.random() < 0.08:
            mac = 'f8:32:e4:' + ':'.join(f'{v:02x}' for v in rng.integers(0, 256, 3))
            res.append({'bssid': mac, 'ssid': 'neighbour', 'level': -91, 'frequency': 2412,
                        'timestamp': int((collected_at - 1500 - boot_epoch_ms) * 1000)})
        rng.shuffle(res)
        return {'collected_at': int(collected_at), 'results': res}


# ---------------------------------------------------------------- walker + IMU

def rot_z(a):
    c, s = math.cos(a), math.sin(a)
    return np.array([[c, -s, 0], [s, c, 0], [0, 0, 1]])


def rot_x(a):
    c, s = math.cos(a), math.sin(a)
    return np.array([[1, 0, 0], [0, c, -s], [0, s, c]])


def rot_y(a):
    c, s = math.cos(a), math.sin(a)
    return np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]])


def smooth_noise(rng, s, sigma, lam_min, lam_max, k=4):
    out = np.zeros_like(s)
    for _ in range(k):
        out += np.sin(2 * np.pi * s / rng.uniform(lam_min, lam_max) + rng.uniform(0, 2 * np.pi))
    return out * sigma / math.sqrt(k / 2)


def make_trajectory(path, rng, wander_m, corner_r=0.8):
    """Dense smoothed ground-truth trajectory along the polyline: returns s, x, y (ds = 0.05 m)."""
    pts = np.array(path, float)
    seg = np.diff(pts, axis=0)
    seglen = np.hypot(seg[:, 0], seg[:, 1])
    cum = np.concatenate([[0], np.cumsum(seglen)])
    s = np.arange(0, cum[-1], 0.05)
    s = np.append(s, cum[-1])
    x, y = np.interp(s, cum, pts[:, 0]), np.interp(s, cum, pts[:, 1])
    k = int(corner_r / 0.05)
    if k > 0 and len(s) > 2 * k + 1:
        ker = np.ones(2 * k + 1) / (2 * k + 1)
        x = np.convolve(np.pad(x, k, mode='edge'), ker, 'valid')
        y = np.convolve(np.pad(y, k, mode='edge'), ker, 'valid')
    hx, hy = np.gradient(x), np.gradient(y)
    hn = np.hypot(hx, hy) + 1e-9
    nx, ny = -hy / hn, hx / hn
    taper = np.clip(np.minimum(s, s[-1] - s) / 2.0, 0, 1)
    w = smooth_noise(rng, s, wander_m, 4, 12) * taper
    x, y = x + nx * w, y + ny * w
    ds = np.hypot(np.diff(x), np.diff(y))
    return np.concatenate([[0], np.cumsum(ds)]), x, y


def simulate_walk(path, t_walk_start, rng, field, dev, walker, stand_before=1.5, stand_after=1.5):
    """Simulate one walk. Returns dict: sensors, truth (t, x, y), t_start, t_end, pos_at(t)."""
    s_tr, x_tr, y_tr = make_trajectory(path, rng, walker['wander_m'])
    L = s_tr[-1]
    v0, f0 = walker['speed'], walker['step_hz']
    step_len = v0 / f0
    # time grid
    n_est = int((stand_before + L / v0 * 1.3 + stand_after + 4) / DT)
    t = np.arange(n_est) * DT
    speed_var = 1 + 0.06 * np.sin(2 * np.pi * t / 7 + rng.uniform(0, 6.3))
    s = np.zeros(n_est)
    v = np.zeros(n_est)
    walking_end = None
    for i in range(1, n_est):
        tw = t[i] - stand_before
        if tw < 0:
            continue
        ramp = min(1.0, tw / 0.8)
        remaining = L - s[i - 1]
        ramp = min(ramp, max(0.15, remaining / 0.6))
        v[i] = v0 * speed_var[i] * ramp
        s[i] = min(L, s[i - 1] + v[i] * DT)
        if s[i] >= L and walking_end is None:
            walking_end = t[i]
            v[i] = 0
        if walking_end is not None:
            v[i] = 0
    n = int((walking_end + stand_after) / DT)
    t, s, v = t[:n], s[:n], v[:n]
    x, y = np.interp(s, s_tr, x_tr), np.interp(s, s_tr, y_tr)
    # heading along trajectory, held while standing
    hx, hy = np.interp(s + 0.3, s_tr, x_tr) - np.interp(s - 0.3, s_tr, x_tr), \
        np.interp(s + 0.3, s_tr, y_tr) - np.interp(s - 0.3, s_tr, y_tr)
    psi = np.unwrap(np.arctan2(hy, hx))
    k = int(0.4 / DT)                                    # body turns smoothly
    psi = np.convolve(np.pad(psi, k, mode='edge'), np.ones(2 * k + 1) / (2 * k + 1), 'valid')
    # gait
    walk_env = np.clip(v / (0.5 * v0), 0, 1)
    phase = np.cumsum(2 * np.pi * (v / step_len) * DT)
    a_v = walker['bounce'] * walk_env * (np.sin(phase) + 0.25 * np.sin(2 * phase + 0.5))
    a_f = 1.1 * walk_env * np.sin(phase - 0.8)
    a_l = 0.5 * walk_env * np.sin(phase / 2)
    yaw = psi + math.radians(3.0) * walk_env * np.sin(phase / 2) + smooth_noise(rng, t, math.radians(1.0), 2, 6)
    pitch = walker['pitch'] + math.radians(1.5) * walk_env * np.sin(phase) + smooth_noise(rng, t, math.radians(1.5), 2, 8)
    roll = math.radians(2.0) * walk_env * np.sin(phase / 2 + 0.3) + smooth_noise(rng, t, math.radians(1.5), 2, 8)
    R = np.array([rot_z(yaw[i] - math.pi / 2) @ rot_x(pitch[i]) @ rot_y(roll[i]) for i in range(n)])
    fwd = np.stack([np.cos(psi), np.sin(psi), np.zeros(n)], 1)
    right = np.stack([np.sin(psi), -np.cos(psi), np.zeros(n)], 1)
    f_world = a_f[:, None] * fwd + a_l[:, None] * right + (a_v + G)[:, None] * np.array([0, 0, 1.0])
    acc_d = np.einsum('nji,nj->ni', R, f_world)
    W = (np.einsum('nji,njk->nik', R[:-1], R[1:]) - np.einsum('nji,njk->nik', R[1:], R[:-1])) / (2 * DT)
    gyr_d = np.stack([W[:, 2, 1], W[:, 0, 2], W[:, 1, 0]], 1)
    gyr_d = np.vstack([gyr_d, gyr_d[-1:]])
    B_world = field(x, y)
    mag_d = np.einsum('nji,nj->ni', R, B_world)

    t0 = t_walk_start - stand_before * 1000.0      # epoch ms of t = 0

    def sample(arr, noise, bias, quant=None, phase_ms=0.0):
        out = []
        tk = phase_ms
        while tk < t[-1] * 1000:
            tk_j = tk + rng.normal(0, 1.5)
            i = min(n - 1, max(0, int(round(tk_j / 1000 / DT))))
            val = arr[i] + bias + rng.normal(0, noise, 3)
            if quant:
                val = np.round(val / quant) * quant
            out.append([round(t0 + tk_j, 2), *(round(float(c), 4) for c in val)])
            tk += SENSOR_PERIOD_MS
        return out

    sensors = {
        'accelerometer': sample(acc_d, 0.04, dev['acc_bias']),
        'gyroscope': sample(gyr_d, 0.008, dev['gyro_bias'], phase_ms=3.0),
        'magnetometer': sample(mag_d, 0.35, dev['hard_iron'], quant=0.15, phase_ms=7.0),
    }
    t_start = t0 + stand_before * 1000.0
    t_end = t0 + walking_end * 1000.0

    def pos_at(tq):
        tt = (tq - t0) / 1000.0
        return float(np.interp(tt, t, x)), float(np.interp(tt, t, y))

    # marks: surveyor taps when passing each interior path vertex (±0.3 s)
    pts = np.array(path, float)
    cum = np.concatenate([[0], np.cumsum(np.hypot(*np.diff(pts, axis=0).T))])
    marks = []
    for vi in range(1, len(path) - 1):
        frac = cum[vi] / cum[-1]
        ti = np.interp(frac * L, s[: int(walking_end / DT) + 1], t[: int(walking_end / DT) + 1])
        marks.append({'t': int(t0 + ti * 1000 + rng.normal(0, 300)), 'vertex': vi})
    step = int(0.1 / DT)
    truth = {'t': [round(t0 + tt * 1000, 1) for tt in t[::step]],
             'x': [round(float(a), 3) for a in x[::step]], 'y': [round(float(a), 3) for a in y[::step]],
             'heading_deg': [round(float((90 - math.degrees(a)) % 360), 1) for a in psi[::step]]}
    return {'sensors': sensors, 'truth': truth, 't_start': int(t_start), 't_end': int(t_end),
            't_rec_end': t0 + t[-1] * 1000, 'marks': marks, 'pos_at': pos_at}


# ---------------------------------------------------------------- sessions

DEVICE_A = {'model': 'SYNTH-A (survey)', 'platform': 'android', 'user_agent': 'synthetic',
            'hard_iron': np.array([0.6, 0.3, -0.8]), 'gyro_bias': np.array([0.0010, -0.0008, 0.0015]),
            'acc_bias': np.array([0.03, -0.02, 0.05]), 'rssi_offset': 0.0}
DEVICE_B = {'model': 'SYNTH-B (survey)', 'platform': 'android', 'user_agent': 'synthetic',
            'hard_iron': np.array([2.5, -1.8, 4.0]), 'gyro_bias': np.array([-0.0012, 0.0010, -0.0020]),
            'acc_bias': np.array([-0.04, 0.03, -0.06]), 'rssi_offset': -2.0}
DEVICE_T = {'model': 'SYNTH-T (navigation user)', 'platform': 'android', 'user_agent': 'synthetic',
            'hard_iron': np.array([1.5, -2.0, 3.0]), 'gyro_bias': np.array([0.0030, -0.0020, 0.0040]),
            'acc_bias': np.array([0.05, 0.04, -0.03]), 'rssi_offset': -3.0}
WALKER_SURVEY = {'speed': 1.2, 'step_hz': 1.8, 'pitch': 0.0, 'bounce': 2.6, 'wander_m': 0.2}
WALKER_TEST = {'speed': 1.1, 'step_hz': 1.85, 'pitch': math.radians(25), 'bounce': 2.3, 'wander_m': 0.15}


def device_json(dev):
    return {k: dev[k] for k in ('model', 'platform', 'user_agent')}


def walk_record(walk_id, direction, path, sim, scans, pose, extra=None, level=LEVEL):
    rec = {'walk_id': walk_id, 'level': level, 'direction': direction, 'path': path,
           't_start': sim['t_start'], 't_end': sim['t_end'], 'marks': sim['marks'], 'phone_pose': pose,
           'sensors': sim['sensors'], 'wifi_scans': scans}
    if extra:
        rec.update(extra)
    return rec


def survey_session(geo, field, wifi, rng, session_id, started_at, dev, with_points, directions):
    lv = geo['level']
    boot = started_at - 3 * 86400 * 1000
    t = started_at + 5000
    points, walks = [], []
    if with_points:
        for f in geo['plan']:
            if f['properties']['kind'] != 'point':
                continue
            px, py = f['geometry']['coordinates']
            sx, sy = px + rng.normal(0, 0.25), py + rng.normal(0, 0.25)   # where the surveyor actually stood
            scans = []
            for k in range(4):
                t += rng.uniform(4000, 6000)
                scans.append(wifi.scan(rng, lambda _t: (sx, sy), t, boot, dev['rssi_offset'], rx_level=lv))
            points.append({'point_id': f['properties']['id'], 'level': lv, 'x': px, 'y': py, 'scans': scans})
            t += rng.uniform(8000, 15000)   # walk to the next point
    for f in geo['plan']:
        if f['properties']['kind'] != 'walk':
            continue
        for direction in directions:
            path = f['geometry']['coordinates'] if direction == 'forward' else f['geometry']['coordinates'][::-1]
            t += 20000
            sim = simulate_walk(path, t, rng, field, dev, WALKER_SURVEY)
            scans, ts = [], sim['t_start'] - 1000 + rng.uniform(1000, 4000)
            while ts < sim['t_rec_end']:
                scans.append(wifi.scan(rng, sim['pos_at'], ts, boot, dev['rssi_offset'], rx_level=lv))
                ts += rng.uniform(4000, 6000)
            walks.append(walk_record(f['properties']['id'], direction, path, sim, scans, 'flat', level=lv))
            t = sim['t_rec_end']
    return {'schema': 'tpnav-survey/0', 'session_id': session_id, 'venue': 'tianmu', 'synthetic': True,
            'device': device_json(dev), 'started_at': started_at, 'wifi_points': points, 'walks': walks}


def test_session(geos, fields, wifi, rng, started_at):
    boot = started_at - 26 * 3600 * 1000
    walks = []
    t = started_at + 5000
    routes = [
        ('test-entrance-to-acc-toilet', ['1F-ent-main-out', '1F-rt-acc']),
        ('test-long-loop', ['1F-ent-main-out', '1F-sw', '1F-se', '1F-ne', '1F-rt-acc']),
        # live run 1 (2026-11-07, confirmed by the user): arena -> SW arena door -> west corridor -> around the
        # enclosed room A101 through the west lobby -> checkpoint 1F-w-n (11.0, 44.4)
        ('test-arena-to-west-corridor', ['1F-ar-c', '1F-ar-sw', '1F-d-ar-sw', '1F-w-fa', '1F-w-s', '1F-l-s', '1F-l-c',
                                         '1F-l-n', '1F-w-n']),
        # live runs 193516 / 193729 (2026-11-07): arena -> NW arena door -> north lobby
        ('test-arena-nw-door', ['1F-ar-c', '1F-ar-nw', '1F-d-ar-nw', '1F-w-54', '1F-nw', '1F-n-14']),
        # SE arena door -> east corridor, north
        ('test-arena-se-door', ['1F-ar-c', '1F-ar-se', '1F-d-ar-se', '1F-e-18', '1F-e-34']),
        # multi-level: north corridor -> elevator #2 up -> 2F west corridor -> elevator #1 down -> 1F south corridor
        ('test-ml-1F-to-el2', ['1F-n-40', '1F-n-14', '1F-nw', '1F-el2']),
        ('test-ml-2F-west', ['2F-el2', '2F-nw', '2F-w-55', '2F-w-34', '2F-w-55-s', '2F-nw-s', '2F-el1']),
        ('test-ml-1F-from-el1', ['1F-el1', '1F-sw', '1F-s-15', '1F-s-25', '1F-s-42']),
    ]
    for walk_id, waypoints in routes:
        lv = waypoints[0][:2]
        geo, field = geos[lv], fields[lv]
        ids, path = route_xy(geo, waypoints)
        sim = simulate_walk(path, t + 3000, rng, field, DEVICE_T, WALKER_TEST, stand_before=3.0, stand_after=2.0)
        rec_start = sim['t_start'] - 3000
        # navigation phone: Android foreground throttling = 4 scans per 2 min; a scan takes ~6 s.
        # The app asks every 8 s; throttled requests return the cached previous result (not fresh).
        scans, fresh_times, ts = [], [], rec_start + 6000
        while ts < sim['t_rec_end']:
            recent = [f for f in fresh_times if ts - f < 120000]
            if len(recent) < 4:
                scans.append(wifi.scan(rng, sim['pos_at'], ts, boot, DEVICE_T['rssi_offset'], sweep_ms=4000, rx_level=lv))
                fresh_times.append(ts)
            elif scans:
                scans.append({**scans[-1], 'collected_at': int(ts), 'cached': True})
            ts += 8000
        walks.append(walk_record(walk_id, 'forward', path, sim, scans, 'flat',
                                 {'route_nodes': ids, 'truth': sim['truth'], 'phone_pitch_deg': 25}, level=lv))
        t = sim['t_rec_end'] + 30000
    return {'schema': 'tpnav-survey/0', 'session_id': 'synthetic-test', 'venue': 'tianmu', 'synthetic': True,
            'purpose': 'evaluation', 'device': device_json(DEVICE_T), 'started_at': started_at,
            'wifi_points': [], 'walks': walks,
            'notes': 'Held-out evaluation walks with ground truth (walk.truth at 10 Hz). Map builders skip this file. '
                     'Cached (throttled) scan deliveries are marked cached: true and must not count as fresh.'}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--seed', type=int, default=7)
    args = ap.parse_args()
    rng_world = np.random.default_rng(args.seed)
    geo = load_geometry()
    field = MagField(geo, rng_world)
    wifi = WifiWorld(geo, rng_world)
    # 2F: its own geometry, field and corridor APs, from separate random streams (1F data stays unchanged)
    rng_2f = np.random.default_rng(args.seed + 100)
    geo2 = load_geometry('2F')
    field2 = MagField(geo2, rng_2f)
    wifi.add_level(geo2, rng_2f)
    os.makedirs(RAW_DIR, exist_ok=True)
    base = 1794030000000
    sessions = [
        survey_session(geo, field, wifi, np.random.default_rng(args.seed + 1), 'synthetic-survey-a', base,
                       DEVICE_A, True, ('forward', 'reverse')),
        survey_session(geo, field, wifi, np.random.default_rng(args.seed + 2), 'synthetic-survey-b', base + 7200000,
                       DEVICE_B, False, ('forward',)),
        test_session({'1F': geo, '2F': geo2}, {'1F': field, '2F': field2}, wifi, np.random.default_rng(args.seed + 3),
                     base + 14400000),
        survey_session(geo2, field2, wifi, np.random.default_rng(args.seed + 4), 'synthetic-survey-2f', base + 21600000,
                       DEVICE_A, True, ('forward', 'reverse')),
    ]
    for s in sessions:
        out = os.path.join(RAW_DIR, s['session_id'] + '.json')
        with open(out, 'w', encoding='utf8') as f:
            json.dump(s, f, separators=(',', ':'))
        n_scans = sum(len(p['scans']) for p in s['wifi_points']) + sum(len(w['wifi_scans']) for w in s['walks'])
        dur = sum((w['t_end'] - w['t_start']) / 1000 for w in s['walks'])
        print(f"{out}: {len(s['wifi_points'])} points, {len(s['walks'])} walks ({dur:.0f} s walking), "
              f"{n_scans} scans, {os.path.getsize(out) / 1e6:.1f} MB")
    # world truth, for debugging the builders (not used by the engine)
    truth = {'aps': [{k: b[k] for k in ('ap', 'bssid', 'band', 'pos', 'level')} for b in wifi.bssids],
             'earth_field_local_uT': field.earth.round(2).tolist()}
    os.makedirs(os.path.join(ROOT, 'build'), exist_ok=True)
    with open(os.path.join(ROOT, 'build', 'synthetic_world.json'), 'w', encoding='utf8') as f:
        json.dump(truth, f, indent=1)


if __name__ == '__main__':
    main()
