"""Penilaian kualitas sinyal ECG per window sebelum keputusan FSM.

Dua lapis:

1. Gerbang teknis (MEMBLOKIR keputusan). Hanya kegagalan yang pasti bukan sinyal jantung:
   * elektroda lepas: flag LO+/LO- AD8232 yang dibawa paket (bit1 header biner / "lead_off" JSON)
   * sinyal datar: rentang puncak-ke-puncak < 0,05 mV, atau > 1 s berturut-turut tanpa perubahan
   * derau: kSQI < 4 DAN pSQI < 0,5, yaitu tidak ada kompleks yang menonjol sekaligus daya tersebar
     di luar pita QRS. Satu indeks saja tidak cukup: VF juga berkurtosis rendah, tetapi dayanya
     terpusat di 3–7 Hz sehingga pSQI-nya tinggi (≥ 0,6 pada semua window VF/VT yang diuji).
   Window seperti ini tetap disimpan, tetapi tidak menggerakkan FSM, karena Z-score pada sinyal
   datar menghasilkan masukan CNN yang tidak bermakna dan bisa terbaca kelas apa pun.

2. Indeks SQI dari literatur (masing-masing TIDAK memblokir; hanya kombinasi di atas yang dipakai):
   * saturasi: porsi sampel di atas ±5 mV. Tidak memblokir: dengan penguatan AD8232 1100 dan ADC
     3,3 V, sinyal alat sudah terpotong di sekitar ±1,5 mV, sedangkan di VFDB aturan ini justru
     menahan window VT asli yang amplitudonya besar.
   * kSQI  : kurtosis sinyal; ECG bersih bersifat "runcing" (kurtosis > 5) [Li, Mark & Clifford 2008]
   * pSQI  : rasio daya 5–15 Hz terhadap 5–40 Hz, rentang wajar ±0,5–0,8 [Li dkk. 2008; Clifford dkk. 2012]
   * basSQI: 1 − daya 0–1 Hz / daya 0–40 Hz, mendekati 1 bila tidak ada baseline wander
   Ambang tunggal dari literatur tidak dipakai: kSQI < 5 menolak 100 % window VF di bank replay.
   Pengujian lengkap (bank replay, CUDB, VFDB, dan BUT QDB dari alat wearable) ada di
   docs/analisis_sqi.md dan bisa diulang dengan tools/analisis_sqi.py.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass

import numpy as np

from heartsim_common.config import ECG_COUNTS_PER_MV, FS_ECG

FLAT_PTP_MV = 0.05          # rentang minimum ECG yang masih bermakna
FLAT_RUN_S = 1.0            # durasi sampel identik berturut-turut yang dianggap datar
SAT_MV = 5.0                # ECG permukaan jarang melebihi ±5 mV
NOISE_KSQI = 4.0            # derau = kSQI < NOISE_KSQI dan pSQI < NOISE_PSQI
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
    """Kembalikan (kSQI, pSQI, basSQI). None bila sinyal terlalu datar untuk dihitung."""
    x = mv - mv.mean()
    sd = x.std()
    if sd < 1e-6:
        return None, None, None
    k = float(np.mean(x ** 4) / sd ** 4)                         # kurtosis Pearson (normal = 3)
    # periodogram berjendela Hann (numpy saja, tanpa dependensi scipy di image cloud)
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
        reason = "elektroda lepas (flag LO+/LO- AD8232): rapatkan kaos/elektroda"
    elif ptp < FLAT_PTP_MV or run_s > FLAT_RUN_S:
        reason = f"sinyal datar ({ptp:.3f} mV, {run_s:.1f} s tanpa perubahan): periksa elektroda/kabel"
    elif k is not None and ps is not None and k < NOISE_KSQI and ps < NOISE_PSQI:
        reason = (f"derau: tidak ada kompleks QRS yang menonjol (kSQI {k:.1f}) dan daya tersebar di luar "
                  f"pita QRS (pSQI {ps:.2f}); kemungkinan gerak atau kontak elektroda buruk")
    else:
        reason = ""
    return SignalQuality(ok=not reason, reason=reason, ptp_mv=ptp, flat_run_s=run_s, saturated=sat,
                         ksqi=k, psqi=ps, bassqi=bs)
