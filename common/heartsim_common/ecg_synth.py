from __future__ import annotations

from collections import deque

import numpy as np

MORPH_CLASS = {
    "normal": 0,
    "st_depression": 1,
    "af": 1,
    "pvc": 1,
    "stemi": 2,
    "vt": 2,
    "vf": 2,
}
CLASS_MORPHS = {
    0: ["normal"],
    1: ["st_depression", "af", "pvc"],
    2: ["stemi", "vt", "vf"],
}
HR_RANGE = {
    "normal": (52, 110),
    "st_depression": (60, 115),
    "af": (75, 145),
    "pvc": (55, 100),
    "stemi": (65, 135),
    "vt": (140, 220),
    "vf": (0, 0),
}


class EcgStream:

    def __init__(self, fs: int = 250, seed: int | None = None,
                 morph: str = "normal", hr: float = 72.0, motion: float = 0.0,
                 noise_mv: float = 0.015, amp_scale: float = 1.0):
        self.fs = fs
        self.rng = np.random.default_rng(seed)
        self.morph = morph
        self.hr = hr
        self.motion = motion
        self.noise_mv = noise_mv
        self.amp_scale = amp_scale
        self._buf = np.zeros(0)
        self._emitted = 0
        self._next_r = 0.4 * fs
        self._pending_comp = False
        self._r_peaks: deque[int] = deque(maxlen=64)
        self._phases = self.rng.uniform(0, 2 * np.pi, 8)
        self._motion_state = 0.0
        self._last_mf = 0.0

    def set_rhythm(self, morph: str | None = None, hr: float | None = None,
                   motion: float | None = None) -> None:
        if morph is not None:
            if morph not in MORPH_CLASS:
                raise ValueError(f"morfologi tidak dikenal: {morph}")
            self.morph = morph
        if hr is not None:
            self.hr = float(hr)
        if motion is not None:
            self.motion = float(motion)

    def _rr_seconds(self) -> float:
        base = 60.0 / max(self.hr, 20.0)
        if self.morph == "af":
            return float(np.clip(base * (1 + self.rng.normal(0, 0.18)), 0.33, 1.6))
        if self.morph == "vt":
            return float(base * (1 + self.rng.normal(0, 0.015)))
        return float(base * (1 + self.rng.normal(0, 0.03)))

    def _beat_waves(self, rr: float, is_pvc: bool) -> list[tuple[float, float, float]]:
        j = lambda a: a * (1 + self.rng.normal(0, 0.04))
        tq = 0.26 * np.sqrt(rr)
        m = self.morph
        if m == "vt":
            return [(0.0, j(1.5), 0.040), (0.075, j(-0.6), 0.035), (0.22, j(-0.35), 0.055)]
        if is_pvc:
            return [(0.0, j(1.45), 0.034), (0.065, j(-0.45), 0.030), (0.30, j(-0.40), 0.060)]
        waves = []
        if m != "af":
            waves.append((-0.17, j(0.12), 0.022))
        q_amp = -0.30 if m == "stemi" else -0.10
        waves += [
            (-0.035, j(q_amp), 0.010),
            (0.0, j(1.00 if m == "stemi" else 1.10), 0.010),
            (0.035, j(-0.25), 0.010),
        ]
        if m == "st_depression":
            waves += [(0.12 * np.sqrt(rr) + 0.02, j(-0.17), 0.050), (tq, j(-0.14), 0.050)]
        elif m == "stemi":
            waves += [(0.11 * np.sqrt(rr) + 0.02, j(0.38), 0.060), (tq, j(0.55), 0.060)]
        else:
            waves.append((tq, j(0.28), 0.045))
        return waves

    def _render_beat(self, r_idx: float, waves) -> None:
        fs = self.fs
        start = int(r_idx - 0.45 * fs)
        end = int(r_idx + 0.75 * fs)
        need = end - self._emitted
        if need > self._buf.size:
            self._buf = np.concatenate([self._buf, np.zeros(need - self._buf.size + fs)])
        idx = np.arange(max(start, self._emitted), end)
        t = (idx - r_idx) / fs
        seg = np.zeros(idx.size)
        for off, amp, sig in waves:
            seg += amp * np.exp(-((t - off) ** 2) / (2 * sig ** 2))
        self._buf[idx - self._emitted] += seg * self.amp_scale
        self._r_peaks.append(int(round(r_idx)))

    def _schedule_until(self, end_idx: int) -> None:
        while self._next_r < end_idx + self.fs:
            rr = self._rr_seconds()
            if self.morph == "vf":
                self._next_r += rr * self.fs if self.hr > 0 else 0.5 * self.fs
                continue
            is_pvc = False
            if self.morph == "pvc" and not self._pending_comp and self.rng.random() < 0.28:
                is_pvc = True
                self._next_r -= 0.35 * rr * self.fs
                self._pending_comp = True
            elif self._pending_comp:
                self._next_r += 0.35 * rr * self.fs
                self._pending_comp = False
            self._render_beat(self._next_r, self._beat_waves(rr, is_pvc))
            self._next_r += rr * self.fs

    def _continuous(self, idx: np.ndarray) -> np.ndarray:
        t = idx / self.fs
        ph = self._phases
        x = self.rng.normal(0, self.noise_mv, idx.size)
        x += 0.04 * np.sin(2 * np.pi * 0.22 * t + ph[0])
        if self.morph == "af":
            x += 0.05 * np.sin(2 * np.pi * 6.1 * t + ph[1] + 0.8 * np.sin(2 * np.pi * 0.4 * t))
        if self.morph == "vf":
            env = 0.45 * (1 + 0.45 * np.sin(2 * np.pi * 0.28 * t + ph[2]))
            x += env * (np.sin(2 * np.pi * 4.6 * t + ph[3])
                        + 0.7 * np.sin(2 * np.pi * 5.9 * t + ph[4] + 0.6 * np.sin(2 * np.pi * 0.5 * t))
                        + 0.4 * np.sin(2 * np.pi * 7.1 * t + ph[5])) * self.amp_scale
        if self.motion > 0:
            m = self.motion
            x += 0.35 * m * np.sin(2 * np.pi * 1.8 * t + ph[6])
            w = self.rng.normal(0, 1, idx.size)
            k = np.ones(12) / 12
            burst = np.convolve(w, k, mode="same") * 0.35 * m
            x += burst
            spikes = self.rng.random(idx.size) < 0.004 * m
            x[spikes] += self.rng.normal(0, 0.6 * m, spikes.sum())
        return x

    def read(self, n: int) -> np.ndarray:
        end = self._emitted + n
        self._schedule_until(end)
        if self._buf.size < n:
            self._buf = np.concatenate([self._buf, np.zeros(n - self._buf.size)])
        idx = np.arange(self._emitted, end)
        out = self._buf[:n] + self._continuous(idx)
        self._buf = self._buf[n:]
        self._emitted = end
        return out

    @property
    def sample_index(self) -> int:
        return self._emitted

    @property
    def rhythm_hr(self) -> float:
        return 0.0 if self.morph == "vf" else float(self.hr)

    def hr_from_rr(self, window_s: float = 5.0) -> float | None:
        if self.morph == "vf":
            return float(self.rng.normal(275, 20))
        lo = self._emitted - window_s * self.fs
        peaks = [p for p in self._r_peaks if lo <= p < self._emitted]
        if len(peaks) < 2:
            return None
        return float(60.0 * self.fs / np.mean(np.diff(peaks)))


def to_counts(mv: np.ndarray, counts_per_mv: int = 500) -> np.ndarray:
    return np.clip(np.round(mv * counts_per_mv), -32768, 32767).astype(np.int16)


def make_window(cls: int, rng: np.random.Generator, n: int = 1750, fs: int = 250) -> np.ndarray:
    morph = rng.choice(CLASS_MORPHS[cls])
    lo, hi = HR_RANGE[morph]
    hr = rng.uniform(lo, hi) if hi > 0 else 0
    motion = 0.0
    if rng.random() < 0.30:
        motion = rng.uniform(0.2, 1.0)
    s = EcgStream(fs=fs, seed=int(rng.integers(1 << 31)), morph=morph, hr=hr, motion=motion,
                  noise_mv=rng.uniform(0.008, 0.05), amp_scale=rng.uniform(0.6, 1.4))
    s.read(int(rng.integers(fs // 2, 3 * fs)))
    return s.read(n)
