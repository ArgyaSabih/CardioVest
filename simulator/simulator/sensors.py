"""Model sensor pendukung: MAX30102 (PPG/HR + SQI), GSR FZ3294, MPU6050, GPS Neo-6M.

Fall detection tiga fase dijalankan di sini (edge), sesuai BAB 8.6.
"""
from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np

from heartsim_common import config as C


# ------------------------------------------------------------------ GSR
class GsrSensor:
    """Konduktansi kulit: respons orde-1 menuju target + drift + derau."""

    def __init__(self, rng: np.random.Generator, baseline: float = 5.0, tau_s: float = 5.0):
        self.rng = rng
        self.value = baseline + rng.normal(0, 0.3)
        self.tau = tau_s
        self._drift = 0.0

    def step(self, target: float, dt: float) -> float:
        self._drift = 0.98 * self._drift + self.rng.normal(0, 0.03)
        self.value += (target - self.value) * (1 - math.exp(-dt / self.tau))
        self.value = max(0.3, self.value + self._drift * dt + self.rng.normal(0, 0.06))
        return round(self.value, 2)


# ------------------------------------------------------------------ PPG / HR
@dataclass
class HrReading:
    hr: float | None
    hr_source: str          # "PPG" | "ECG"
    hr_ppg: float | None
    hr_ecg: float | None
    sqi: float


def read_hr(rng: np.random.Generator, hr_true: float, sqi_target: float,
            hr_ecg: float | None) -> HrReading:
    """Pemilihan sumber HR sesuai Persamaan eq:hrsrc (BAB 4.5.2)."""
    sqi = float(np.clip(sqi_target + rng.normal(0, 0.04), 0, 1))
    if hr_true <= 0:                      # VF: tidak ada denyut perifer bermakna
        hr_ppg = None
        sqi = min(sqi, 0.1)
    elif sqi >= C.TAU_SQI:
        hr_ppg = hr_true + rng.normal(0, 1.5)
    else:
        hr_ppg = hr_true + rng.normal(0, 18)   # PPG tidak andal saat SQI rendah
    if sqi >= C.TAU_SQI and hr_ppg is not None:
        return HrReading(round(hr_ppg, 1), "PPG", round(hr_ppg, 1),
                         None if hr_ecg is None else round(hr_ecg, 1), round(sqi, 2))
    return HrReading(None if hr_ecg is None else round(hr_ecg, 1), "ECG",
                     None if hr_ppg is None else round(hr_ppg, 1),
                     None if hr_ecg is None else round(hr_ecg, 1), round(sqi, 2))


# ------------------------------------------------------------------ Akselerometer
class AccelSim:
    """Akselerasi tiga sumbu (g) pada 100 Hz, termasuk pola jatuh tiga fase."""

    def __init__(self, rng: np.random.Generator, fs: int = C.FS_ACCEL):
        self.rng = rng
        self.fs = fs
        self.n = 0
        self.mode = "rest"            # rest | walk | lying
        self._fall_t: float | None = None

    def trigger_fall(self) -> None:
        self._fall_t = self.n / self.fs

    def read(self, count: int) -> np.ndarray:
        out = np.empty((count, 3))
        for i in range(count):
            t = self.n / self.fs
            self.n += 1
            if self._fall_t is not None and t >= self._fall_t:
                dt = t - self._fall_t
                if dt < 0.20:                               # free-fall
                    v = np.array([0.05, 0.08, 0.20])
                elif dt < 0.23:                             # impak
                    v = np.array([1.2, 0.6, 3.4])
                elif dt < 0.50:                             # pantulan teredam
                    k = math.exp(-(dt - 0.23) * 12)
                    v = np.array([0.95, 0.1, 0.1]) + k * np.array([0.6, 0.4, 0.9])
                else:                                       # terbaring diam
                    self.mode = "lying"
                    self._fall_t = None
                    v = np.array([0.98, 0.06, 0.12])
            elif self.mode == "walk":
                v = np.array([0.15 * math.sin(2 * math.pi * 2 * t),
                              0.05 * math.sin(2 * math.pi * 1 * t),
                              1.0 + 0.30 * math.sin(2 * math.pi * 2 * t)])
            elif self.mode == "lying":
                v = np.array([0.98, 0.06, 0.12])
            else:
                v = np.array([0.02, 0.05, 0.99])
            out[i] = v + self.rng.normal(0, 0.012, 3)
        return out


class FallDetector:
    """Deteksi jatuh heuristik tiga fase: free-fall -> impak -> stillness (BAB 4.6, 8.6)."""

    IDLE, FREEFALL, WAIT_IMPACT, STILL = range(4)

    def __init__(self, fs: int = C.FS_ACCEL):
        self.fs = fs
        self.n = 0
        self.state = self.IDLE
        self._t_mark = 0.0
        self._t_impact = 0.0
        self._t_still = 0.0

    def update(self, samples: np.ndarray) -> bool:
        detected = False
        for ax, ay, az in samples:
            t = self.n / self.fs
            self.n += 1
            mag = math.sqrt(ax * ax + ay * ay + az * az)
            if self.state == self.IDLE:
                if mag < C.FALL_FREEFALL_G:
                    self.state, self._t_mark = self.FREEFALL, t
            elif self.state == self.FREEFALL:
                if mag >= C.FALL_FREEFALL_G:
                    dur_ms = (t - self._t_mark) * 1000
                    if C.FALL_FREEFALL_MIN_MS <= dur_ms <= C.FALL_FREEFALL_MAX_MS:
                        self.state, self._t_mark = self.WAIT_IMPACT, t
                        if mag > C.FALL_IMPACT_G:                 # impak di sampel yang sama
                            self.state = self.STILL
                            self._t_impact = self._t_still = t
                    else:
                        self.state = self.IDLE
            elif self.state == self.WAIT_IMPACT:
                if mag > C.FALL_IMPACT_G:
                    self.state = self.STILL
                    self._t_impact = self._t_still = t
                elif (t - self._t_mark) * 1000 > C.FALL_IMPACT_WINDOW_MS:
                    self.state = self.IDLE
            elif self.state == self.STILL:
                if abs(mag - 1.0) > C.FALL_STILL_TOL_G:
                    self._t_still = t
                    if t - self._t_impact > 5.0:
                        self.state = self.IDLE
                elif t - self._t_still >= C.FALL_STILL_MIN_S:
                    detected = True
                    self.state = self.IDLE
        return detected


# ------------------------------------------------------------------ GPS
class GpsSim:
    """Neo-6M: hanya aktif pada state CRITICAL; mensimulasikan time-to-first-fix."""

    def __init__(self, rng: np.random.Generator):
        self.rng = rng
        self.active = False
        self._fix_at: float | None = None
        self.lat = C.GPS_HOME_LAT
        self.lon = C.GPS_HOME_LON

    def set_active(self, on: bool, now: float) -> None:
        if on and not self.active:
            self._fix_at = now + self.rng.uniform(C.GPS_TTFF_MIN_S, C.GPS_TTFF_MAX_S)
        if not on:
            self._fix_at = None
        self.active = on

    def read(self, now: float) -> dict | None:
        if not self.active:
            return None
        if self._fix_at is None or now < self._fix_at:
            return {"fix": False, "sats": int(self.rng.integers(0, 4)),
                    "ttff_elapsed_s": None}
        # jitter ~ beberapa meter (1e-5 derajat ~ 1,1 m)
        lat = self.lat + self.rng.normal(0, 2.5e-5)
        lon = self.lon + self.rng.normal(0, 2.5e-5)
        return {"fix": True, "lat": round(lat, 6), "lon": round(lon, 6),
                "accuracy_m": round(float(self.rng.uniform(3.5, 9.0)), 1),
                "sats": int(self.rng.integers(6, 12))}
