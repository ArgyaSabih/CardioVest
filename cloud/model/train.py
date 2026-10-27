"""Pelatihan CNN 1D tiga kelas pada dataset ECG SINTETIS.

Arsitektur mengikuti Tabel 'Arsitektur CNN 1D' (BAB 10.4):
    Input(1750,1) -> [Conv1D(32,5)+BN+MaxPool] -> [Conv1D(64,5)+BN+MaxPool]
    -> [Conv1D(128,3)+BN] -> GAP -> Dropout(0.3) -> Dense(64) -> Dropout(0.2) -> Dense(3, softmax)
    Total parameter ~44.547

Strategi (BAB 10.4): Adam 1e-3, ReduceLROnPlateau(0.5, patience 5), EarlyStopping(patience 10),
class weight invers frekuensi, normalisasi Z-score per window.

Model ini HANYA untuk menguji pipeline dengan ECG sintetis dan disimpan sebagai
cnn1d_ecg_sintetis.keras. Model utama (cnn1d_ecg.keras) dilatih dengan PTB-XL + MIT-BIH melalui
train_real.py.

Contoh:
    python cloud/model/train.py --per-class 4000 --epochs 25
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "common"))

from heartsim_common.config import CLASSES, WINDOW_SAMPLES  # noqa: E402
from heartsim_common.ecg_synth import make_window  # noqa: E402

os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "2")
import tensorflow as tf  # noqa: E402

ART = Path(__file__).resolve().parent / "artifacts"


def zscore(x: np.ndarray) -> np.ndarray:
    return (x - x.mean(axis=-1, keepdims=True)) / (x.std(axis=-1, keepdims=True) + 1e-8)


def build_dataset(per_class: int, seed: int, imbalance: bool = True):
    rng = np.random.default_rng(seed)
    # Meniru ketidakseimbangan kelas dataset nyata (Normal dominan) -> class weight berperan
    counts = [per_class * 2, per_class, per_class] if imbalance else [per_class] * 3
    X, y = [], []
    for c, n in enumerate(counts):
        for _ in range(n):
            X.append(make_window(c, rng, WINDOW_SAMPLES))
            y.append(c)
    X = zscore(np.asarray(X, dtype=np.float32))[..., None]
    y = np.asarray(y, dtype=np.int64)
    p = rng.permutation(len(y))
    return X[p], y[p]


def build_model() -> tf.keras.Model:
    L = tf.keras.layers
    inp = L.Input(shape=(WINDOW_SAMPLES, 1), name="ecg")
    x = L.Conv1D(32, 5, activation="relu")(inp)
    x = L.BatchNormalization()(x)
    x = L.MaxPool1D(2)(x)
    x = L.Conv1D(64, 5, activation="relu")(x)
    x = L.BatchNormalization()(x)
    x = L.MaxPool1D(2)(x)
    x = L.Conv1D(128, 3, activation="relu")(x)
    x = L.BatchNormalization()(x)
    x = L.GlobalAveragePooling1D()(x)
    x = L.Dropout(0.30)(x)
    x = L.Dense(64, activation="relu")(x)
    x = L.Dropout(0.20)(x)
    out = L.Dense(3, activation="softmax", name="probs")(x)
    return tf.keras.Model(inp, out, name="cnn1d_ecg_3class")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--per-class", type=int, default=3000)
    ap.add_argument("--epochs", type=int, default=25)
    ap.add_argument("--batch", type=int, default=64)
    ap.add_argument("--seed", type=int, default=42)
    a = ap.parse_args()

    tf.keras.utils.set_random_seed(a.seed)
    t0 = time.time()
    X, y = build_dataset(a.per_class, a.seed)
    n = len(y)
    n_tr, n_va = int(0.70 * n), int(0.15 * n)
    Xtr, ytr = X[:n_tr], y[:n_tr]
    Xva, yva = X[n_tr:n_tr + n_va], y[n_tr:n_tr + n_va]
    Xte, yte = X[n_tr + n_va:], y[n_tr + n_va:]
    print(f"dataset {n} window dibuat dalam {time.time() - t0:.1f} s "
          f"(train {len(ytr)}, val {len(yva)}, test {len(yte)})")

    # w_c = N_total / (n_classes * N_c)
    cnt = np.bincount(ytr, minlength=3)
    cw = {c: float(len(ytr) / (3 * cnt[c])) for c in range(3)}
    print("class weight:", cw)

    model = build_model()
    model.compile(optimizer=tf.keras.optimizers.Adam(1e-3),
                  loss="sparse_categorical_crossentropy", metrics=["accuracy"])
    model.summary()
    cb = [
        tf.keras.callbacks.ReduceLROnPlateau(monitor="val_loss", factor=0.5, patience=5),
        tf.keras.callbacks.EarlyStopping(monitor="val_loss", patience=10, restore_best_weights=True),
    ]
    hist = model.fit(Xtr, ytr, validation_data=(Xva, yva), epochs=a.epochs,
                     batch_size=a.batch, class_weight=cw, callbacks=cb, verbose=2)

    prob = model.predict(Xte, verbose=0)
    pred = prob.argmax(1)
    cm = np.zeros((3, 3), dtype=int)
    for t_, p_ in zip(yte, pred):
        cm[t_, p_] += 1
    per_class = {}
    for c, name in enumerate(CLASSES):
        tp = cm[c, c]
        fn = cm[c].sum() - tp
        fp = cm[:, c].sum() - tp
        tn = cm.sum() - tp - fn - fp
        per_class[name] = {
            "sensitivity": round(float(tp / max(tp + fn, 1)), 4),
            "specificity": round(float(tn / max(tn + fp, 1)), 4),
            "precision": round(float(tp / max(tp + fp, 1)), 4),
        }
    metrics = {
        "catatan": "Dievaluasi pada ECG SINTETIS; bukan performa klinis.",
        "accuracy": round(float((pred == yte).mean()), 4),
        "confusion_matrix(baris=aktual, kolom=prediksi)": cm.tolist(),
        "kelas": CLASSES,
        "per_kelas": per_class,
        "parameter": int(model.count_params()),
        "epoch_dijalankan": len(hist.history["loss"]),
        "per_class_train": a.per_class,
    }
    ART.mkdir(parents=True, exist_ok=True)
    # disimpan dengan nama *_sintetis agar tidak menimpa model data nyata (train_real.py)
    model.save(ART / "cnn1d_ecg_sintetis.keras")
    (ART / "metrics_sintetis.json").write_text(json.dumps(metrics, indent=2, ensure_ascii=False))
    print(json.dumps(metrics, indent=2, ensure_ascii=False))
    print(f"model disimpan ke {ART / 'cnn1d_ecg_sintetis.keras'} (total {time.time() - t0:.0f} s)")
    print("Untuk memakainya di cloud: set MODEL_PATH=/app/cloud/model/artifacts/cnn1d_ecg_sintetis.keras")


if __name__ == "__main__":
    main()
