"""Kurva ROC dan AUC per kelas (luaran L2 laporan) pada set uji inter-patient.

    python cloud/model/kurva_roc.py --data datasets/ecg_c251_250hz.npz

Split pasien direkonstruksi persis seperti train_real.py (seed dan pembatasan window sama), lalu
model produksi diuji pada window uji. Hasil: artifacts/roc.png dan artifacts/roc.json.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from bandingkan_lead import load  # noqa: E402
from train_real import CLASSES, center_crop  # noqa: E402

import tensorflow as tf  # noqa: E402


def roc(y_true: np.ndarray, score: np.ndarray):
    order = np.argsort(-score)
    y = y_true[order]
    tp = np.concatenate([[0], np.cumsum(y)])
    fp = np.concatenate([[0], np.cumsum(1 - y)])
    tpr, fpr = tp / max(1, y.sum()), fp / max(1, (1 - y).sum())
    return fpr, tpr, float(np.trapezoid(tpr, fpr))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True)
    ap.add_argument("--model", default=str(HERE / "artifacts" / "cnn1d_ecg.keras"))
    a = ap.parse_args()
    X, y, *_ = load(a.data)
    p = tf.keras.models.load_model(a.model, compile=False).predict(center_crop(X), batch_size=256, verbose=0)
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    fig, ax = plt.subplots(figsize=(5.2, 5))
    out = {"n_window_uji": int(len(y)), "auc_per_kelas": {}}
    for c, (name, col) in enumerate(zip(CLASSES, ["#1f7a4d", "#e0a400", "#c8102e"])):
        fpr, tpr, auc = roc((y == c).astype(int), p[:, c])
        out["auc_per_kelas"][name] = round(auc, 4)
        ax.plot(fpr, tpr, color=col, lw=2, label=f"{name} (AUC {auc:.3f})")
    out["auc_makro"] = round(float(np.mean(list(out["auc_per_kelas"].values()))), 4)
    ax.plot([0, 1], [0, 1], ls="--", color="#999", lw=1)
    ax.set(xlabel="False positive rate (1 − specificity)", ylabel="True positive rate (sensitivity)",
           title="ROC satu-lawan-semua, set uji inter-patient")
    ax.legend(loc="lower right", frameon=False)
    ax.grid(alpha=0.25)
    fig.tight_layout()
    fig.savefig(HERE / "artifacts" / "roc.png", dpi=150)
    (HERE / "artifacts" / "roc.json").write_text(json.dumps(out, indent=1, ensure_ascii=False))
    print(json.dumps(out, indent=1, ensure_ascii=False))


if __name__ == "__main__":
    main()
