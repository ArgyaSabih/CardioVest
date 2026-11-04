from __future__ import annotations

from dataclasses import asdict, dataclass

import numpy as np

from heartsim_common.config import ECG_COUNTS_PER_MV, FS_ECG

FLAT_PTP_MV = 0.05
FLAT_RUN_S = 1.0
SAT_MV = 5.0
NOISE_KSQI = 4.0
NOISE_PSQI = 0.5


@dataclass
class SignalQuality:
    ok: bool
    reason: str
    ptp_mv: float
    flat_run_s: float
    saturated: float
    ksqi: float | None
    psqi: float | None
    bassqi: float | None

    def dict(self) -> dict:
        return {k: (round(v, 3) if isinstance(v, float) else v) for k, v in asdict(self).items()}


def _longest_constant_run(x: np.ndarray) -> int:
    if x.size < 2:
        return x.size
    same = np.concatenate([[False], np.diff(x) == 0, [False]])
    edges = np.flatnonzero(np.diff(same.astype(np.int8)))
    if edges.size == 0:
        return 1
    return int((edges[1::2] - edges[::2]).max()) + 1


def _band_power(f: np.ndarray, p: np.ndarray, lo: float, hi: float) -> float:
    m = (f >= lo) & (f < hi)
    return float(p[m].sum())


def spectral_sqi(mv: np.ndarray, fs: int = FS_ECG) -> tuple[float | None, float | None, float | None]:
    x = mv - mv.mean()
    sd = x.std()
    if sd < 1e-6:
        return None, None, None
    k = float(np.mean(x ** 4) / sd ** 4)
    f = np.fft.rfftfreq(x.size, 1 / fs)
    p = np.abs(np.fft.rfft(x * np.hanning(x.size))) ** 2
    p540 = _band_power(f, p, 5, 40)
    p040 = _band_power(f, p, 0, 40)
    psqi = _band_power(f, p, 5, 15) / p540 if p540 > 0 else None
    bassqi = 1 - _band_power(f, p, 0, 1) / p040 if p040 > 0 else None
    return k, psqi, bassqi


def assess(window_counts: np.ndarray, lead_off: bool = False, fs: int = FS_ECG,
           counts_per_mv: float = ECG_COUNTS_PER_MV, with_sqi: bool = True) -> SignalQuality:
    mv = window_counts.astype(np.float64) / counts_per_mv
    ptp = float(np.ptp(mv)) if mv.size else 0.0
    run_s = _longest_constant_run(window_counts) / fs
    sat = float(np.mean(np.abs(mv) > SAT_MV)) if mv.size else 0.0
    k = ps = bs = None
    if with_sqi and ptp >= FLAT_PTP_MV:
        k, ps, bs = spectral_sqi(mv, fs)

    if lead_off:
        reason = "elektroda lepas (LO+/LO-)"
    elif ptp < FLAT_PTP_MV or run_s > FLAT_RUN_S:
        reason = f"sinyal datar ({ptp:.3f} mV, konstan {run_s:.1f} s)"
    elif k is not None and ps is not None and k < NOISE_KSQI and ps < NOISE_PSQI:
        reason = f"derau (kSQI {k:.1f}, pSQI {ps:.2f})"
    else:
        reason = ""
    return SignalQuality(ok=not reason, reason=reason, ptp_mv=ptp, flat_run_s=run_s, saturated=sat,
                         ksqi=k, psqi=ps, bassqi=bs)
