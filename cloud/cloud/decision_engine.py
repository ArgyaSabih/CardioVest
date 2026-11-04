from __future__ import annotations

import statistics
from collections import deque
from dataclasses import asdict, dataclass

from heartsim_common import config as C


@dataclass
class ValidatorSnapshot:
    hr: float | None
    hr_source: str
    sqi: float | None
    gsr: float | None
    gsr_threshold: float
    gsr_calibrated: bool
    ind_gsr: bool
    ind_hr: bool
    degraded: bool
    motion: bool = False
    activity_g: float | None = None
    spo2: float | None = None
    ind_spo2: bool = False

    def dict(self) -> dict:
        return asdict(self)


class ValidatorState:

    def __init__(self, calib_seconds: int = C.CALIB_SECONDS, k: float = C.GSR_K):
        self.vitals: deque[dict] = deque(maxlen=20)
        self.calib_seconds = calib_seconds
        self.k = k
        self._calib: list[float] = []
        self._calib_start: int | None = None
        self._calib_last: int | None = None
        self.mu: float | None = None
        self.sigma: float | None = None
        self.gsr_threshold = C.GSR_ABS_HIGH
        self.calibrated = False

    def add(self, v: dict, state: str) -> None:
        if v.get("buffered"):
            return
        self.vitals.append(v)
        g = v.get("gsr")
        if self.calibrated or g is None or state != C.STATE_NORMAL:
            return
        gap = C.GSR_CALIB_GAP_S * 1000
        if self._calib_last is not None and v["ts"] - self._calib_last > gap:
            self._calib, self._calib_start = [], None
        self._calib_last = v["ts"]
        if self._calib_start is None:
            self._calib_start = v["ts"]
        self._calib.append(float(g))
        if v["ts"] - self._calib_start >= self.calib_seconds * 1000 and len(self._calib) >= 5:
            self.mu = statistics.fmean(self._calib)
            self.sigma = statistics.pstdev(self._calib)
            thr = max(self.mu + self.k * self.sigma, self.mu + C.GSR_MIN_MARGIN)
            self.gsr_threshold = round(min(thr, C.GSR_ABS_HIGH), 2)
            self.calibrated = True

    def calibrating(self, now: int) -> bool:
        return (not self.calibrated and self._calib_last is not None
                and now - self._calib_last <= C.GSR_CALIB_GAP_S * 1000)

    def calibration_info(self) -> dict:
        progress = 0.0
        if self._calib_start is not None and self.vitals:
            progress = min(self.calib_seconds, (self.vitals[-1]["ts"] - self._calib_start) / 1000)
        return {"calibrated": self.calibrated,
                "mu": None if self.mu is None else round(self.mu, 3),
                "sigma": None if self.sigma is None else round(self.sigma, 3),
                "k": self.k, "threshold": self.gsr_threshold,
                "progress_s": round(progress, 1), "target_s": self.calib_seconds}

    def latest(self) -> dict | None:
        return self.vitals[-1] if self.vitals else None

    def evaluate(self) -> ValidatorSnapshot:
        recent = list(self.vitals)[-3:]
        hrs = [v["hr"] for v in recent if v.get("hr") is not None]
        gsrs = [v["gsr"] for v in recent[-2:] if v.get("gsr") is not None]
        spo2s = [v["spo2"] for v in recent if v.get("spo2") is not None]
        last = recent[-1] if recent else {}
        hr = round(statistics.median(hrs), 1) if hrs else None
        gsr = round(statistics.fmean(gsrs), 2) if gsrs else None
        spo2 = round(statistics.median(spo2s), 1) if spo2s else None
        hr_source = last.get("hr_source", "PPG")
        activity = self.activity()
        return ValidatorSnapshot(
            hr=hr, hr_source=hr_source, sqi=last.get("sqi"), gsr=gsr,
            gsr_threshold=self.gsr_threshold, gsr_calibrated=self.calibrated,
            ind_gsr=gsr is not None and gsr > self.gsr_threshold,
            ind_hr=hr is not None and (hr > C.HR_HIGH or hr < C.HR_LOW),
            degraded=hr_source == "ECG" and last.get("ppg_on", True) is not False,
            motion=activity is not None and activity > C.MOTION_SD_G,
            activity_g=None if activity is None else round(activity, 3),
            spo2=spo2,
            ind_spo2=spo2 is not None and spo2 < C.SPO2_LOW,
        )

    def activity(self) -> float | None:
        recent = list(self.vitals)[-C.MOTION_WINDOW_S:]
        acc = [v.get("accel") or {} for v in recent]
        sds = [a["sd"] for a in acc if a.get("sd") is not None]
        if sds:
            return float(statistics.median(sds))
        mags = [a["mag"] for a in acc if a.get("mag") is not None]
        return float(statistics.pstdev(mags)) if len(mags) >= 3 else None


@dataclass
class Decision:
    state: str
    prev_state: str
    changed: bool
    accepted: bool
    reason: str
    n_required: int
    consec_non_normal: int
    consec_normal: int

    def dict(self) -> dict:
        return asdict(self)


class DecisionEngine:
    def __init__(self, tau_conf: float = C.TAU_CONF, n: int = C.PERSIST_N,
                 n_degraded: int = C.PERSIST_N_DEGRADED, m: int = C.HYSTERESIS_M,
                 tau_motion: float | None = None, n_pre: int | None = None,
                 tau_warn: float | None = None):
        self.tau_conf = tau_conf
        self.tau_motion = max(tau_conf, C.TAU_CONF_MOTION if tau_motion is None else tau_motion)
        self.tau_warn = max(tau_conf, C.TAU_WARN if tau_warn is None else tau_warn)
        self.n = n
        self.n_pre = C.PERSIST_N_PRE if n_pre is None else n_pre
        self.n_degraded = n_degraded
        self.m = m
        self.state = C.STATE_NORMAL
        self.consec_non_normal = 0
        self.consec_normal = 0

    def _decision(self, prev: str, accepted: bool, reason: str, n_req: int) -> Decision:
        return Decision(self.state, prev, self.state != prev, accepted, reason, n_req,
                        self.consec_non_normal, self.consec_normal)

    def step(self, cls: int, p_conf: float, ind_gsr: bool, ind_hr: bool,
             degraded: bool = False, motion: bool = False, ind_spo2: bool = False) -> Decision:
        prev = self.state
        n_req = self.n_degraded if degraded else self.n
        tau = self.tau_motion if motion else self.tau_conf
        if p_conf < tau:
            name = "tau_gerak" if motion else "tau_conf"
            return self._decision(prev, False,
                                  f"tidak diputuskan: p_conf {p_conf:.2f} < {name} {tau:.2f}"
                                  + (" (pengguna bergerak)" if motion else ""), n_req)
        if cls != C.CLS_NORMAL and p_conf < self.tau_warn:
            return self._decision(prev, False,
                                  f"tidak diputuskan: {C.CLASSES[cls]} p_conf {p_conf:.2f} < tau_warn {self.tau_warn:.2f}",
                                  n_req)

        if cls == C.CLS_NORMAL:
            self.consec_normal += 1
            self.consec_non_normal = 0
        else:
            self.consec_non_normal += 1
            self.consec_normal = 0

        cls_name = C.CLASSES[cls]
        gate = cls == C.CLS_ATTACK and ind_hr and ind_gsr and ind_spo2
        if cls == C.CLS_PRE and self.n_pre:
            n_req = max(n_req, self.n_pre)
        val_txt = f"1_HR={int(ind_hr)}, 1_GSR={int(ind_gsr)}, 1_SpO2={int(ind_spo2)}"

        if self.state == C.STATE_CRITICAL:
            reason = "CRITICAL terkunci (latching); menunggu hardware reset"
        elif self.state == C.STATE_NORMAL:
            if self.consec_non_normal >= n_req:
                if gate:
                    self.state = C.STATE_CRITICAL
                    reason = (f"{cls_name} persisten {self.consec_non_normal}/{n_req} window "
                              f"dan cross-validation terpenuhi ({val_txt})")
                else:
                    self.state = C.STATE_WARNING
                    reason = (f"{cls_name} persisten {self.consec_non_normal}/{n_req} window"
                              + (f"; validator belum lengkap ({val_txt})" if cls == C.CLS_ATTACK else ""))
            elif cls != C.CLS_NORMAL:
                reason = f"{cls_name} {self.consec_non_normal}/{n_req} window (persistence belum terpenuhi)"
            else:
                reason = "Normal"
        else:
            if gate:
                self.state = C.STATE_CRITICAL
                reason = f"gerbang cross-validation terpenuhi: Serangan, {val_txt}"
            elif self.consec_normal >= n_req + self.m:
                self.state = C.STATE_NORMAL
                reason = f"Normal persisten {self.consec_normal}/{n_req + self.m} window (histeresis)"
            elif cls == C.CLS_NORMAL:
                reason = f"Normal {self.consec_normal}/{n_req + self.m} window menuju pemulihan"
            else:
                reason = f"tetap WARNING: {cls_name}" + (f" ({val_txt})" if cls == C.CLS_ATTACK else "")
        return self._decision(prev, True, reason, n_req)

    def restore(self, state: str) -> None:
        if state in C.STATES:
            self.state = state
            self.consec_non_normal = self.consec_normal = 0

    def adopt_critical(self, reason: str) -> Decision:
        prev = self.state
        self.state = C.STATE_CRITICAL
        self.consec_non_normal = self.consec_normal = 0
        return self._decision(prev, True, reason, self.n)

    def force(self, state: str, reason: str) -> Decision:
        prev = self.state
        self.state = state
        self.consec_non_normal = self.consec_normal = 0
        return self._decision(prev, True, reason, self.n)

    def _reset(self, why: str) -> Decision:
        prev = self.state
        self.state = C.STATE_NORMAL
        self.consec_non_normal = 0
        self.consec_normal = 0
        if prev == C.STATE_NORMAL:
            return self._decision(prev, False, f"{why}; sudah NORMAL", self.n)
        return self._decision(prev, True, why, self.n)

    def remote_reset(self, who: str = "aplikasi web") -> Decision:
        return self._reset(f"reset jarak jauh dari {who}")

    def hardware_reset(self, boot: bool = False) -> Decision:
        return self._reset("alat dinyalakan ulang (tombol EN/RST)" if boot
                           else "hardware reset R(t)=1 dari perangkat")
