"""Reconstruct where the surveyor was during a survey walk (shared by build_radiomap.py and build_magmap.py; they
load it by explicit file path, so it works under `python -I`).

Arc length along walk.path is driven by detected steps (not constant speed), anchored at:
- t_start (s = 0) and t_end (s = path length);
- corners: for every path vertex where the plan turns by >= MIN_TURN_DEG, the moment the gyroscope yaw (projected on
  gravity) shows that turn, searched around the time predicted by step-proportional progress;
- marks, only as a fallback for a corner the gyro could not confirm. The survey tool numbers marks by tap count
  ("經過轉角（第 N 點）") while plans contain straight-through vertices, so a mark's `vertex` is not trusted — only
  its time is, matched to the nearest unconfirmed corner.
Between anchors the position advances in proportion to the step count (pauses and speed changes are handled).
"""
import math

import numpy as np

G = 9.80665
MIN_TURN_DEG = 25.0
MARK_REACTION_S = 0.4


def _biquad(kind, fc, fs, q=1 / math.sqrt(2)):
    w = 2 * math.pi * fc / fs
    c, alpha = math.cos(w), math.sin(w) / (2 * q)
    a0 = 1 + alpha
    if kind == 'low':
        b = [(1 - c) / 2 / a0, (1 - c) / a0, (1 - c) / 2 / a0]
    else:
        b = [(1 + c) / 2 / a0, -(1 + c) / a0, (1 + c) / 2 / a0]
    return b, [-2 * c / a0, (1 - alpha) / a0]


def _lfilter(b, a, x):
    y = [0.0] * len(x)
    x1 = x2 = y1 = y2 = 0.0
    b0, b1, b2 = b
    a1, a2 = a
    for i, v in enumerate(x):
        o = b0 * v + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
        x2, x1, y2, y1 = x1, v, y1, o
        y[i] = o
    return y


def filtfilt(kind, fc, fs, x):
    b, a = _biquad(kind, fc, fs)
    x = np.asarray(x, float)
    x0 = x[0]
    y = _lfilter(b, a, (x - x0).tolist())
    y = _lfilter(b, a, y[::-1])[::-1]
    return np.array(y) + (x0 if kind == 'low' else 0.0)


def lowpass_zero_phase(t_ms, v, tau_s):
    """First-order IIR low-pass run forward and backward (irregular sampling)."""
    dt = np.abs(np.diff(t_ms)) / 1000.0
    a = dt / (tau_s + dt)
    out = v.astype(float).tolist()
    for i in range(1, len(out)):
        out[i] = out[i - 1] + a[i - 1] * (out[i] - out[i - 1])
    for i in range(len(out) - 2, -1, -1):
        out[i] = out[i + 1] + a[i] * (out[i] - out[i + 1])
    return np.array(out)


def sensor(walk, name, pad_ms=3000):
    """Sorted samples of one sensor, trimmed to the walk (sessions may contain stale samples from before t_start)."""
    arr = np.array((walk.get('sensors') or {}).get(name) or [], float).reshape(-1, 4)
    if not len(arr):
        return arr
    arr = arr[np.argsort(arr[:, 0], kind='stable')]
    keep = (arr[:, 0] >= walk['t_start'] - pad_ms) & (arr[:, 0] <= walk['t_end'] + pad_ms)
    return arr[keep]


def gravity_up(acc, tau_s=1.0):
    """Unit 'up' vectors (device frame) at the accelerometer timestamps."""
    g = np.stack([lowpass_zero_phase(acc[:, 0], acc[:, i], tau_s) for i in (1, 2, 3)], 1)
    return g / np.linalg.norm(g, axis=1, keepdims=True)


def detect_steps(acc):
    """Step times (ms): peaks of the zero-phase band-passed |a| (0.9–3 Hz), adaptive threshold, >= 0.3 s apart."""
    if len(acc) < 50:
        return np.zeros(0)
    # phones switch accelerometer rate mid-recording (A71: 50 <-> 125 Hz when another listener asks for more),
    # so filter on a uniform 50 Hz clock rather than a rate estimated once
    fs = 50.0
    t = np.arange(acc[0, 0], acc[-1, 0], 1000.0 / fs)
    m = np.interp(t, acc[:, 0], np.linalg.norm(acc[:, 1:], axis=1)) - G
    s = filtfilt('low', 3.0, fs, filtfilt('high', 0.9, fs, m))
    cand = np.where((s[1:-1] > s[:-2]) & (s[1:-1] >= s[2:]) & (s[1:-1] > 0.4))[0] + 1
    if not len(cand):
        return np.zeros(0)
    thr = max(0.4, 0.4 * np.median(s[cand]))
    cand = cand[s[cand] > thr]
    chosen = []
    for i in sorted(cand, key=lambda i: -s[i]):           # non-maximum suppression, 0.3 s
        if all(abs(t[i] - t[j]) >= 300 for j in chosen):
            chosen.append(i)
    return np.sort(t[chosen])


def integrate_yaw(gyr, acc, up):
    """Relative yaw (rad, CCW +) at the gyroscope timestamps."""
    u = np.stack([np.interp(gyr[:, 0], acc[:, 0], up[:, i]) for i in range(3)], 1)
    rate = (gyr[:, 1:] * u).sum(1)
    dt = np.clip(np.diff(gyr[:, 0], prepend=gyr[0, 0]) / 1000.0, 0, 0.2)
    return np.cumsum(rate * dt)


def _wrap(a):
    return (a + math.pi) % (2 * math.pi) - math.pi


class WalkTrack:
    def __init__(self, walk):
        self.walk = walk
        pts = np.array(walk['path'], float)
        self.pts = pts
        self.cum = np.concatenate([[0], np.cumsum(np.hypot(*np.diff(pts, axis=0).T))])
        t0, t1 = walk['t_start'], walk['t_end']
        acc, gyr = sensor(walk, 'accelerometer'), sensor(walk, 'gyroscope')
        steps = detect_steps(acc) if len(acc) else np.zeros(0)
        self.steps = steps[(steps > t0) & (steps < t1)]
        self.cnt_t = np.concatenate([[t0], self.steps, [t1]])
        self.cnt_v = np.concatenate([[0.0], np.arange(1, len(self.steps) + 1), [float(len(self.steps))]])
        self.anchors = [(float(t0), 0.0), (float(t1), float(self.cum[-1]))]
        self.corners = []        # (vertex, t, source)
        self.mark_delays = []    # mark t − gyro corner t (s), for marks near a confirmed corner
        headings = np.arctan2(np.diff(pts[:, 1]), np.diff(pts[:, 0]))
        turns = [(v, _wrap(headings[v] - headings[v - 1])) for v in range(1, len(pts) - 1)]
        self.turn_vertices = [(v, d) for v, d in turns if abs(math.degrees(d)) >= MIN_TURN_DEG]
        yaw_t = yaw = None
        if len(gyr) > 50 and len(acc) > 50:
            yaw_t, yaw = gyr[:, 0], integrate_yaw(gyr, acc, gravity_up(acc))
        marks = sorted(m['t'] for m in walk.get('marks') or [] if t0 < m['t'] < t1)
        used_marks = set()
        for v, d in self.turn_vertices:
            t_pred = float(self._time_at_s(self.cum[v]))
            lo_t = float(self._time_at_s(self.cum[v - 1]))
            hi_t = float(self._time_at_s(self.cum[v + 1]))
            half = min(max(0.35 * min(t_pred - lo_t, hi_t - t_pred), 3000.0), 15000.0)
            win = (max(t_pred - half, self._prev_anchor_t(t_pred) + 500), min(t_pred + half, self._next_anchor_t(t_pred) - 500))
            tc = self._find_turn(yaw_t, yaw, d, win) if yaw is not None and win[1] > win[0] else None
            if tc is not None:
                self._add_anchor(tc, self.cum[v])
                self.corners.append((v, tc, 'gyro'))
                near = [m for m in marks if abs(m - tc) < 4000]
                if near:
                    self.mark_delays.append((min(near, key=lambda m: abs(m - tc)) - tc) / 1000)
                continue
            cands = [m for m in marks if win[0] <= m <= win[1] and m not in used_marks]
            if cands:
                m = min(cands, key=lambda m: abs(m - t_pred))
                used_marks.add(m)
                self._add_anchor(m - MARK_REACTION_S * 1000, self.cum[v])
                self.corners.append((v, m - MARK_REACTION_S * 1000, 'mark'))

    # ---- progress model
    def _prev_anchor_t(self, t):
        return max(a for a, _ in self.anchors if a <= t) if any(a <= t for a, _ in self.anchors) else self.anchors[0][0]

    def _next_anchor_t(self, t):
        return min(a for a, _ in self.anchors if a >= t) if any(a >= t for a, _ in self.anchors) else self.anchors[-1][0]

    def _add_anchor(self, t, s):
        self.anchors = sorted(self.anchors + [(float(t), float(s))])

    def _count(self, t):
        return np.interp(t, self.cnt_t, self.cnt_v)

    def arc_length(self, times):
        times = np.atleast_1d(np.asarray(times, float))
        ta = np.array([a for a, _ in self.anchors])
        sa = np.array([s for _, s in self.anchors])
        ca = self._count(ta)
        c = self._count(times)
        k = np.clip(np.searchsorted(ta, times, 'right') - 1, 0, len(ta) - 2)
        dc = ca[k + 1] - ca[k]
        dt = np.maximum(ta[k + 1] - ta[k], 1e-6)
        frac = np.where(dc >= 2, (c - ca[k]) / np.maximum(dc, 1e-9), (times - ta[k]) / dt)
        return sa[k] + np.clip(frac, 0, 1) * (sa[k + 1] - sa[k])

    def _time_at_s(self, s):
        grid = np.linspace(self.anchors[0][0], self.anchors[-1][0], 2000)
        return np.interp(s, self.arc_length(grid), grid)

    def positions(self, times):
        s = self.arc_length(times)
        return np.interp(s, self.cum, self.pts[:, 0]), np.interp(s, self.cum, self.pts[:, 1])

    # ---- corner detection
    @staticmethod
    def _find_turn(yaw_t, yaw, d, win, h_ms=1500.0):
        g = np.arange(win[0], win[1], 50.0)
        if len(g) < 3:
            return None
        D = np.interp(g + h_ms, yaw_t, yaw) - np.interp(g - h_ms, yaw_t, yaw)
        sgn = 1.0 if d > 0 else -1.0
        i = int(np.argmax(sgn * D))
        if not (0.5 * abs(d) <= sgn * D[i] <= 1.8 * abs(d)):
            return None
        tb, ta = g[i] - h_ms, g[i] + h_ms
        yb, ya = np.interp(tb, yaw_t, yaw), np.interp(ta, yaw_t, yaw)
        seg = np.arange(tb, ta, 20.0)
        y = np.interp(seg, yaw_t, yaw)
        mid = (yb + ya) / 2
        cross = np.where(sgn * (y - mid) >= 0)[0]
        return float(seg[cross[0]]) if len(cross) else float(g[i])

    def summary(self):
        n_turn = len(self.turn_vertices)
        gyro = sum(1 for c in self.corners if c[2] == 'gyro')
        mark = sum(1 for c in self.corners if c[2] == 'mark')
        dur = (self.walk['t_end'] - self.walk['t_start']) / 1000
        out = f'{len(self.steps)} steps ({len(self.steps) / max(dur, 1e-6):.2f}/s), corners {gyro} gyro + {mark} mark / {n_turn}'
        if self.mark_delays:
            out += f', tap delay vs gyro {np.mean(self.mark_delays):+.1f} s'
        return out
