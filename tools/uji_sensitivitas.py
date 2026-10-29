"""Sisi lain dari tools/uji_alarm_palsu.py: berapa yang TERLEWAT bila tau/N dinaikkan.

    python tools/uji_sensitivitas.py

1. Episode VT/VF/flutter kontinu dari CUDB + VFDB (kanal pertama saja, karena alat hanya punya
   satu lead). Tiap episode >= 20 s dijalankan dari state NORMAL melalui gerbang kualitas +
   DecisionEngine asli; dicatat apakah WARNING/CRITICAL tercapai dalam 30 s dan berapa lama.
   Validator HR dianggap positif (VT/VF > 120 bpm); validator GSR dianggap positif untuk batas atas.
2. Bank replay (subset acak set uji PTB-XL/MIT-BIH): peluang satu window STEMI/ST depresi/dll. terbaca
   non-Normal dengan keyakinan >= tau. Rekaman PTB-XL hanya 10 s, jadi persistence N tidak bisa
   diuji langsung; angka p^N (anggapan window independen) dicetak sebagai perkiraan kasar.
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import numpy as np
from scipy.signal import lfilter

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT / "common"), str(ROOT / "cloud"), str(ROOT / "tools")]
from analisis_sqi import FIR, NA, NB, PRE_S, WIN, _download_db  # noqa: E402
from cloud.decision_engine import DecisionEngine  # noqa: E402
from cloud.signal_quality import assess  # noqa: E402
from heartsim_common import config as C  # noqa: E402

HOP = C.HOP_SAMPLES
MODEL = Path(os.getenv("MODEL_PATH") or ROOT / "cloud" / "model" / "artifacts" / "cnn1d_ecg.keras")
FS = C.FS_ECG
GRID = [(C.TAU_CONF, 2), (C.TAU_CONF, 3), (0.5, 2), (0.5, 3), (0.6, 2), (0.6, 3), (0.7, 2), (0.7, 3), (0.8, 2), (0.8, 3)]
RHYTHM = {"(VF": "vf", "(VFIB": "vf", "(VFL": "vfl", "(VT": "vt"}


def episodes(cache: Path):
    import wfdb
    for db in ("cudb", "vfdb"):
        d = cache / db
        for r in _download_db(db, d):
            sig, _ = wfdb.rdsamp(str(d / r))
            x = sig[:, 0]
            ann = wfdb.rdann(str(d / r), "atr")
            cur, start, spans = None, 0, []
            for smp, sym, aux in zip(ann.sample, ann.symbol, ann.aux_note):
                aux = aux.strip("\x00 ")
                lab = "vf" if sym == "[" else "lain" if sym == "]" else RHYTHM.get(aux, "lain" if aux.startswith("(") else None)
                if lab is None:
                    continue
                if cur is not None:
                    spans.append((start, smp, cur))
                cur, start = lab, smp
            if cur is not None:
                spans.append((start, len(x), cur))
            for a, b, lab in spans:
                if lab in ("vf", "vfl", "vt") and (b - a) >= 20 * FS and a >= int(PRE_S * FS):
                    seg = x[a - int(PRE_S * FS):min(b, a + 60 * FS)]
                    if np.isnan(seg).any():
                        continue
                    y = lfilter(NB, NA, lfilter(FIR, 1.0, seg - seg[0]))[int(PRE_S * FS):]
                    yield f"{db}/{r}", lab, y


def main() -> None:
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--json", default=str(ROOT / "docs" / "uji_sensitivitas.json"))
    args = ap.parse_args()
    os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "2")
    import tensorflow as tf
    model = tf.keras.models.load_model(MODEL, compile=False)

    def predict(X):
        z = (X - X.mean(1, keepdims=True)) / (X.std(1, keepdims=True) + 1e-8)
        p = model.predict(z[..., None].astype(np.float32), verbose=0, batch_size=512)
        return p.argmax(1), p.max(1)

    cache = Path.home() / ".cache" / "cardiovest"
    eps = list(episodes(cache))
    res = {f"tau {t:.2f} N={n}": {"warning_30s": 0, "critical_30s": 0, "latensi_s": []} for t, n in GRID}
    for rec, lab, y in eps:
        X = np.array([y[s:s + WIN] for s in range(0, y.size - WIN + 1, HOP)])
        cls, conf = predict(X)
        ok = [assess(np.round(w * C.ECG_COUNTS_PER_MV).astype(np.int32)).ok for w in X]
        for t, n in GRID:
            r = res[f"tau {t:.2f} N={n}"]
            eng = DecisionEngine(tau_conf=t, n=n)
            hit_w = hit_c = None
            for i, (c, p, q) in enumerate(zip(cls, conf, ok)):
                if not q:
                    continue
                eng.step(int(c), float(p), True, True, False, False)
                t_end = (i * HOP + WIN) / FS
                if hit_w is None and eng.state != C.STATE_NORMAL:
                    hit_w = t_end
                if hit_c is None and eng.state == C.STATE_CRITICAL:
                    hit_c = t_end
            r["warning_30s"] += hit_w is not None and hit_w <= 30
            r["critical_30s"] += hit_c is not None and hit_c <= 30
            if hit_w is not None:
                r["latensi_s"].append(hit_w)
    n_ep = len(eps)
    print(f"== Episode VT/VF/flutter kontinu >= 20 s: {n_ep} episode dari "
          f"{len({e[0] for e in eps})} rekaman (CUDB + VFDB, kanal 1)")
    print(f"{'konfigurasi':<16}{'WARNING<=30s':>14}{'CRITICAL<=30s':>15}{'latensi median':>16}")
    out = {"episode_ventrikel": {"n": n_ep}}
    for k, r in res.items():
        lat = float(np.median(r["latensi_s"])) if r["latensi_s"] else None
        out["episode_ventrikel"][k] = {"warning_30s": r["warning_30s"] / n_ep, "critical_30s": r["critical_30s"] / n_ep,
                                       "latensi_median_s": lat}
        print(f"{k:<16}{r['warning_30s'] / n_ep:>14.0%}{r['critical_30s'] / n_ep:>15.0%}"
              f"{(f'{lat:.1f} s' if lat else '-'):>16}")

    b = np.load(ROOT / "dataset" / "dataset" / "replay_bank.npz")
    # hanya subset acak dari set uji: sebagian bank berisi window pilihan (demo) dan data latih
    keep = b["acak"].astype(bool) & (b["split"].astype(str) == "test")
    X = b["X"][keep, :WIN].astype(np.float64)
    tags = b["tag"].astype(str)[keep]
    cls, conf = predict(X)
    taus = sorted({t for t, _ in GRID})
    print(f"\n== Bank replay, subset acak set uji ({keep.sum()} window): P(window non-Normal dengan keyakinan >= tau); kolom p^2 / p^3 = perkiraan kasar")
    print(f"{'kondisi':<14}" + "".join(f"{f'tau {t:.2f}':>20}" for t in taus))
    out["bank"] = {}
    for tag in ["stemi", "st_depression", "cd", "af", "normal"]:      # VT/VF: lihat bagian 1
        m = tags == tag
        cells, row = [], {}
        for t in taus:
            p = float(np.mean((cls[m] != C.CLS_NORMAL) & (conf[m] >= t)))
            row[f"{t:.2f}"] = p
            cells.append(f"{p:.2f} ({p ** 2:.2f}/{p ** 3:.2f})")
        row["n"] = int(m.sum())
        out["bank"][tag] = row
        print(f"{tag:<10}{m.sum():>4}" + "".join(f"{c:>20}" for c in cells))
    print("(baris normal = alarm palsu per window pada rekaman klinis 12-lead yang diambil Lead I)")
    Path(args.json).write_text(json.dumps(out, indent=1, ensure_ascii=False))


if __name__ == "__main__":
    main()
