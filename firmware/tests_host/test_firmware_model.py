"""Apakah sinyal hasil rantai filter FIRMWARE tetap dikenali model CNN 1D di cloud?

Rekaman asli bank replay (pasien held-out) -> tegangan pin AD8232 (+ interferensi 50 Hz, baseline
wander, derau ADC) -> rantai filter firmware (host_test, C++) -> count int16 -> window 7 s -> CNN.
Hasil dibandingkan dengan prediksi model pada rekaman yang sama tanpa melewati firmware.

    python firmware/tests_host/test_firmware_model.py
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path[:0] = [str(HERE), str(ROOT / "common"), str(ROOT / "simulator"), str(ROOT / "cloud")]
os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "3")

import test_firmware_algos as T  # noqa: E402
from cloud.inference import CnnInference  # noqa: E402

CLASSES = ["Normal", "Pra-Serangan", "Serangan"]
FIR_TAPS = 501


def main() -> None:
    T.build()
    model = CnnInference()
    d = np.load(ROOT / "simulator" / "simulator" / "replay_bank.npz")
    rng = np.random.default_rng(11)
    agree = same_as_label_fw = same_as_label_ref = n = 0
    rows = []
    for tag in ("normal", "st_depression", "af", "pvc", "stemi", "vt", "vf"):
        idx = np.where(d["tag"] == tag)[0][:12]
        for i in idx:
            x = d["X"][i].astype(np.float32)
            ref = model.predict(np.round(x[375:375 + 1750] * 500))[0]
            y, _ = T.ecg_chain(np.tile(x, 3), rng)                   # 30 s lewat firmware
            s = 5000 + 375 + (FIR_TAPS - 1) // 2                     # siklus ketiga, dikoreksi tunda FIR
            win = np.round(y[s:s + 1750] * 500)
            fw = model.predict(win)[0]
            agree += fw == ref
            same_as_label_fw += fw == d["y"][i]
            same_as_label_ref += ref == d["y"][i]
            n += 1
            rows.append((tag, CLASSES[ref], CLASSES[fw]))
    print(f"prediksi sama (firmware vs tanpa firmware): {agree}/{n} = {agree / n:.1%}")
    print(f"benar vs label  tanpa firmware: {same_as_label_ref / n:.1%}   lewat firmware: {same_as_label_fw / n:.1%}")
    for tag in dict.fromkeys(r[0] for r in rows):
        rr = [r for r in rows if r[0] == tag]
        print(f"  {tag:<14} sama {sum(a == b for _, a, b in rr)}/{len(rr)}")
    sys.exit(0 if agree / n >= 0.8 else 1)


if __name__ == "__main__":
    main()
