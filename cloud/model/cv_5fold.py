"""Validasi silang 5-fold berbasis PASIEN (kriteria sukses minimum 6.3.1, strategi Subbab 5.3.3).

    python cloud/model/cv_5fold.py --data datasets/ecg_c251_250hz.npz --out artefak_cv

Tiap pasien hanya muncul di satu fold uji. Untuk fold k: fold k = uji; dari pasien sisanya ±15 %
diambil sebagai validasi (early stopping), sisanya latih. Arsitektur, augmentasi, pembatasan window
per pasien, oversampling VT/VF, dan class weight sama persis dengan train_real.py, sehingga angka
rata-rata ± simpangan baku di sini menggambarkan kestabilan model produksi, bukan model lain.

Hasil per fold disimpan segera (cv_metrics.json), jadi skrip bisa dihentikan lalu dilanjutkan:
fold yang sudah selesai tidak dilatih ulang. Strata dengan < 5 pasien (mis. VF MIT-BIH yang hanya
dari satu rekaman) selalu masuk data latih dan tidak pernah diuji; ini dicatat di keluaran.
"""
from __future__ import annotations

import argparse
import json
import time
from collections import defaultdict
from pathlib import Path

import numpy as np

import train_real as T  # noqa: E402  (impor TF + arsitektur + augmentasi yang sama)

tf = T.tf


def cap_per_patient(pid, tag, cap, seed):
    rng = np.random.default_rng(seed)
    keep = np.ones(len(pid), bool)
    groups = defaultdict(list)
    for i, (p, t) in enumerate(zip(pid, tag)):
        groups[(p, t)].append(i)
    for (p, t), idx in groups.items():
        if len(idx) > cap and t not in ("vt", "vf"):
            keep[rng.choice(idx, len(idx) - cap, replace=False)] = False
    return keep


def fold_assignment(pid, y, tag, src, k=5, seed=42):
    """Pasien -> fold 0..k-1 secara terstratifikasi; -1 = selalu latih (strata terlalu kecil)."""
    rng = np.random.default_rng(seed)
    info = defaultdict(lambda: {"cls": 0, "tags": set(), "src": ""})
    for p, c, t, s in zip(pid, y, tag, src):
        d = info[p]
        d["cls"] = max(d["cls"], int(c))
        d["tags"].add(str(t))
        d["src"] = str(s)
    strata = defaultdict(list)
    for p, d in info.items():
        rare = min(d["tags"], key=lambda t: T.TAG_RANK.index(t) if t in T.TAG_RANK else 99)
        strata[(d["src"], d["cls"], rare)].append(p)
    fold = {}
    offset = 0
    for key in sorted(strata):
        ps = sorted(strata[key])
        rng.shuffle(ps)
        if len(ps) < k:
            for p in ps:
                fold[p] = -1
            continue
        for i, p in enumerate(ps):
            fold[p] = (i + offset) % k
        offset += len(ps)          # sebar sisa pembagian ke fold berbeda antar-strata
    return fold


def auc_per_class(y, prob):
    from sklearn.metrics import roc_auc_score
    return {T.CLASSES[c]: round(float(roc_auc_score(y == c, prob[:, c])), 4) for c in range(3)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--folds", type=int, default=5)
    ap.add_argument("--epochs", type=int, default=40)
    ap.add_argument("--batch", type=int, default=64)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--cap-per-patient", type=int, default=60)
    ap.add_argument("--oversample-rare", type=int, default=10)
    a = ap.parse_args()
    a.out.mkdir(parents=True, exist_ok=True)
    res_path = a.out / "cv_metrics.json"
    done = json.loads(res_path.read_text()) if res_path.exists() else {"folds": {}}

    d = np.load(a.data, allow_pickle=False)
    X, y, tag, pid, src = (d[k] for k in ("X", "y", "tag", "pid", "src"))
    y = y.astype(np.int64)
    keep = cap_per_patient(pid, tag, a.cap_per_patient, a.seed)
    X, y, tag, pid, src = (v[keep] for v in (X, y, tag, pid, src))
    fold = fold_assignment(pid, y, tag, src, a.folds, a.seed)
    fw = np.array([fold[p] for p in pid])
    done["catatan"] = {"window": int(len(y)), "pasien": len(fold),
                       "pasien_selalu_latih": sum(v == -1 for v in fold.values()),
                       "window_selalu_latih": int((fw == -1).sum())}

    for k in range(a.folds):
        if str(k) in done["folds"]:
            print(f"fold {k}: sudah ada, dilewati")
            continue
        t0 = time.time()
        tf.keras.utils.set_random_seed(a.seed + k)
        te = fw == k
        rest = ~te
        # validasi = ±15 % pasien dari sisa (pakai patient_split yang sama, ambil bagian 'val'+'test')
        sp, _ = T.patient_split(pid[rest], y[rest], tag[rest], src[rest], a.seed + k, ratios=(0.85, 0.15, 0.0))
        idx_rest = np.flatnonzero(rest)
        va = np.zeros(len(y), bool)
        va[idx_rest[sp == "val"]] = True
        tr = rest & ~va
        cnt = np.bincount(y[tr], minlength=3)
        cw = {c: float(tr.sum() / (3 * max(cnt[c], 1))) for c in range(3)}
        tr_idx = np.flatnonzero(tr)
        rare = tr_idx[np.isin(tag[tr_idx], ["vt", "vf"])]
        tr_idx = np.concatenate([tr_idx] + [rare] * (a.oversample_rare - 1))
        model = T.build_model()
        model.compile(optimizer=tf.keras.optimizers.Adam(1e-3), loss="sparse_categorical_crossentropy", metrics=["accuracy"])
        cb = [tf.keras.callbacks.ReduceLROnPlateau(monitor="val_loss", factor=0.5, patience=5, verbose=0),
              tf.keras.callbacks.EarlyStopping(monitor="val_loss", patience=10, restore_best_weights=True, verbose=0)]
        hist = model.fit(T.Augmented(X[tr_idx], y[tr_idx], a.batch, a.seed + k),
                         validation_data=(T.center_crop(X[va]), y[va]), epochs=a.epochs,
                         class_weight=cw, callbacks=cb, verbose=2)
        r, prob = T.evaluate(model, X[te], y[te], tag[te], src[te])
        done["folds"][str(k)] = {
            "n_uji": int(te.sum()), "n_latih": int(tr.sum()), "n_validasi": int(va.sum()),
            "pasien_uji": len({p for p in pid[te]}),
            "epoch": len(hist.history["loss"]), "durasi_s": round(time.time() - t0),
            "accuracy": r["accuracy"], "macro_f1": r["macro_f1"], "auc_ovr_macro": r.get("auc_ovr_macro"),
            "auc_per_kelas": auc_per_class(y[te], prob), "per_kelas": r["per_kelas"],
            "confusion_matrix": r["confusion_matrix"],
        }
        res_path.write_text(json.dumps(done, indent=1, ensure_ascii=False))
        print(f"fold {k}: acc {r['accuracy']:.3f}  sens Serangan {r['per_kelas']['Serangan']['sensitivity']:.3f}  "
              f"({time.time() - t0:.0f} s)", flush=True)

    fs = [done["folds"][str(k)] for k in range(a.folds) if str(k) in done["folds"]]
    if len(fs) == a.folds:
        def agg(get):
            v = np.array([get(f) for f in fs], float)
            return {"rata2": round(float(v.mean()), 4), "sd": round(float(v.std(ddof=1)), 4),
                    "min": round(float(v.min()), 4), "maks": round(float(v.max()), 4)}
        s = {"accuracy": agg(lambda f: f["accuracy"]), "macro_f1": agg(lambda f: f["macro_f1"]),
             "auc_ovr_macro": agg(lambda f: f["auc_ovr_macro"])}
        for c in T.CLASSES:
            s[f"sensitivity_{c}"] = agg(lambda f, c=c: f["per_kelas"][c]["sensitivity"])
            s[f"specificity_{c}"] = agg(lambda f, c=c: f["per_kelas"][c]["specificity"])
            s[f"auc_{c}"] = agg(lambda f, c=c: f["auc_per_kelas"][c])
        done["ringkasan"] = s
        res_path.write_text(json.dumps(done, indent=1, ensure_ascii=False))
        for k_, v in s.items():
            print(f"{k_:<28} {v['rata2']:.3f} ± {v['sd']:.3f}  [{v['min']:.3f}–{v['maks']:.3f}]")


if __name__ == "__main__":
    main()
