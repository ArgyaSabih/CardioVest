from __future__ import annotations

import os
from pathlib import Path

import numpy as np
from scipy.signal import resample

from heartsim_common.ecg_synth import MORPH_CLASS, EcgStream

BANK_PATH = Path(__file__).resolve().parent / "replay_bank.npz"


def bank_available(path: Path | None = None) -> bool:
    return (path or BANK_PATH).exists()


class ReplayStream:
    def __init__(self, fs: int = 250, seed: int | None = None, bank_path: Path | None = None,
                 only_correct: bool | None = None, morph: str = "normal", hr: float = 72.0,
                 motion: float = 0.0):
        d = np.load(bank_path or BANK_PATH, allow_pickle=False)
        if int(d["fs"]) != fs:
            raise ValueError("fs bank replay tidak sama dengan fs perangkat")
        self.fs = fs
        self.X = d["X"].astype(np.float32)
        self.y = d["y"].astype(int)
        self.tag = d["tag"].astype(str)
        self.rec = d["rec"].astype(str)
        self.hr_bank = d["hr"].astype(float)
        tau = float(os.getenv("TAU_CONF", "0.44"))
        tau_warn = max(tau, float(os.getenv("TAU_WARN", "0.80")))
        min_normal = float(os.getenv("REPLAY_MIN_CONF_NORMAL", str(max(tau, 0.60))))
        min_abnormal = float(os.getenv("REPLAY_MIN_CONF", str(tau_warn)))
        self.min_conf = min_abnormal
        if "pred" in d.files:
            correct = d["pred"] == d["y"]
            conf = d["conf"].astype(float)
            need = np.where(self.y == 0, min_normal, min_abnormal)
            self.ok = correct & (conf >= need)
            for t in np.unique(self.tag):
                m = (self.tag == t) & correct
                if m.any() and not (self.ok & (self.tag == t)).any():
                    best = np.where(m)[0][np.argsort(conf[m])[-5:]]
                    self.ok[best] = True
        else:
            self.ok = np.ones(len(self.y), bool)
        acak = d["acak"].astype(bool) if "acak" in d.files else np.ones(len(self.y), bool)
        split = d["split"].astype(str) if "split" in d.files else np.full(len(self.y), "test")
        self.unbiased = acak.copy()
        for t in np.unique(self.tag):
            m = (self.tag == t) & acak
            if (m & (split == "test")).any():
                self.unbiased[m & (split != "test")] = False
        if only_correct is None:
            only_correct = os.getenv("REPLAY_ONLY_CORRECT", "1") != "0"
        self.only_correct = only_correct
        self.rng = np.random.default_rng(seed)
        self._noise = EcgStream(fs=fs, seed=seed, morph="normal", noise_mv=0.004)
        self._buf = np.zeros(0)
        self._emitted = 0
        self._seg = None
        self.morph, self.hr, self.motion = morph, hr, motion
        self.current_rec = ""
        self._seg_hr = hr
        self._choose()

    def _candidates(self) -> np.ndarray:
        base = self.unbiased
        if self.only_correct and (self.ok & (self.tag == self.morph)).any():
            base = self.ok
        m = base & (self.tag == self.morph)
        if not m.any():
            m = base & (self.y == MORPH_CLASS.get(self.morph, 0))
        return np.where(m)[0]

    def _choose(self) -> None:
        idx = self._candidates()
        hr = np.nan_to_num(self.hr_bank[idx], nan=999)
        if self.hr > 0:
            diff = np.abs(hr - self.hr)
            near = idx[diff <= max(diff.min() + 3, 0.1 * self.hr)]
        else:
            near = idx
        i = int(self.rng.choice(near))
        seg = self.X[i].copy()
        seg_hr = self.hr_bank[i]
        if self.morph != "vf" and self.hr > 0 and np.isfinite(seg_hr) and seg_hr > 0:
            f = self.hr / seg_hr
            if 0.9 <= f <= 1.1 and abs(f - 1) > 0.02:
                seg = resample(seg, int(round(seg.size / f)))
                seg_hr *= f
        self._seg = seg
        self._seg_hr = float(seg_hr) if np.isfinite(seg_hr) else float(self.hr)
        self.current_rec = str(self.rec[i])
        self._append(seg, crossfade=True)

    def _append(self, seg: np.ndarray, crossfade: bool) -> None:
        k = int(0.2 * self.fs)
        if crossfade and self._buf.size >= k:
            w = np.linspace(0, 1, k)
            self._buf[-k:] = self._buf[-k:] * (1 - w) + seg[:k] * w
            self._buf = np.concatenate([self._buf, seg[k:]])
        else:
            self._buf = np.concatenate([self._buf, seg])

    def set_rhythm(self, morph: str | None = None, hr: float | None = None,
                   motion: float | None = None) -> None:
        changed = False
        if morph is not None and morph != self.morph:
            self.morph, changed = morph, True
        if hr is not None and hr != self.hr:
            self.hr, changed = float(hr), True
        if motion is not None:
            self.motion = float(motion)
            self._noise.set_rhythm(motion=self.motion)
        if changed:
            keep = int(0.2 * self.fs)
            self._buf = self._buf[:keep]
            self._choose()

    def read(self, n: int) -> np.ndarray:
        while self._buf.size < n + int(0.2 * self.fs):
            self._append(self._seg, crossfade=True)
        out = self._buf[:n].copy()
        self._buf = self._buf[n:]
        idx = np.arange(self._emitted, self._emitted + n)
        out += self._noise._continuous(idx)
        self._emitted += n
        return out

    @property
    def sample_index(self) -> int:
        return self._emitted

    @property
    def rhythm_hr(self) -> float:
        return 0.0 if self.morph == "vf" else self._seg_hr

    def hr_from_rr(self, window_s: float = 5.0) -> float | None:
        if self.morph == "vf":
            return float(self.rng.normal(275, 20))
        return float(self._seg_hr + self.rng.normal(0, 1.5))
