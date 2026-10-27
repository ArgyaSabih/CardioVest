"""Pelatihan CNN 1D tiga kelas pada PTB-XL + MIT-BIH (hasil prepare.py).

    python cloud/model/train_real.py --data datasets/ecg_c251_250hz.npz --epochs 40

Mengikuti BAB 10.4:
  * arsitektur Tabel 'Arsitektur CNN 1D' (dipakai ulang dari train.py, 44.547 parameter)
  * input 1.750 sampel @ 250 Hz (7 s), Z-score per window
  * split 70/15/15 inter-patient, terstratifikasi per pasien
  * augmentasi: derau Gaussian sigma 0,05, baseline wander f < 0,5 Hz, pergeseran waktu (crop acak)
  * Adam 1e-3, ReduceLROnPlateau(0,5; patience 5), EarlyStopping(patience 10), class weight

Keluaran (cloud/model/artifacts/):
  cnn1d_ecg.keras            model baru (model sintetis lama dicadangkan sebagai cnn1d_ecg_sintetis.keras)
  metrics.json               metrik uji lengkap (per kelas, per sumber, per kondisi, analisis tau_conf)
  confusion_matrix.png, training_curves.png, tau_conf.png
  history.csv, split_pasien.csv
dan bank replay simulator: simulator/simulator/replay_bank.npz (window dari pasien set uji).
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import time
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(ROOT / "common"))
sys.path.insert(0, str(HERE))

os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "2")
import tensorflow as tf  # noqa: E402

from train import build_model  # noqa: E402  arsitektur identik

CLASSES = ["Normal", "Pra-Serangan", "Serangan"]
WIN, SEG, FS = 1750, 2500, 250
ART = HERE / "artifacts"
TAG_RANK = ["vf", "vt", "af", "svt", "pvc", "cd", "st_depression", "stemi", "normal"]


# ============================================================== split inter-patient
def patient_split(pid, y, tag, src, seed=42, ratios=(0.70, 0.15, 0.15)):
    """Bagi PASIEN ke train/val/test. Strata = (sumber, kelas terberat, tag paling langka).
    Strata dengan < 3 pasien seluruhnya masuk train (mis. VF MIT-BIH hanya dari rekaman 207)."""
    rng = np.random.default_rng(seed)
    info = defaultdict(lambda: {"cls": 0, "tags": set(), "src": ""})
    for p, c, t, s in zip(pid, y, tag, src):
        d = info[p]
        d["cls"] = max(d["cls"], int(c))
        d["tags"].add(str(t))
        d["src"] = str(s)
    strata = defaultdict(list)
    for p, d in info.items():
        rare = min(d["tags"], key=lambda t: TAG_RANK.index(t) if t in TAG_RANK else 99)
        strata[(d["src"], d["cls"], rare)].append(p)
    assign = {}
    for key in sorted(strata):
        ps = sorted(strata[key])
        rng.shuffle(ps)
        n = len(ps)
        if n < 3:
            n_te = n_va = 0
        else:
            n_te = max(1, int(round(ratios[2] * n)))
            n_va = max(1, int(round(ratios[1] * n)))
        for i, p in enumerate(ps):
            assign[p] = "test" if i < n_te else "val" if i < n_te + n_va else "train"
    return np.array([assign[p] for p in pid]), assign


# ============================================================== data generator
def zscore(x):
    return (x - x.mean(axis=-1, keepdims=True)) / (x.std(axis=-1, keepdims=True) + 1e-8)


def center_crop(X):
    s = (SEG - WIN) // 2
    return zscore(X[:, s:s + WIN].astype(np.float32))[..., None]


class Augmented(tf.keras.utils.Sequence):
    def __init__(self, X, y, batch=64, seed=0, **kw):
        super().__init__(**kw)
        self.X, self.y, self.batch = X, y, batch
        self.rng = np.random.default_rng(seed)
        self.idx = np.arange(len(y))
        self.t = np.arange(WIN) / FS
        self.on_epoch_end()

    def __len__(self):
        return int(np.ceil(len(self.idx) / self.batch))

    def on_epoch_end(self):
        self.rng.shuffle(self.idx)

    def __getitem__(self, i):
        b = self.idx[i * self.batch:(i + 1) * self.batch]
        st = self.rng.integers(0, SEG - WIN + 1, len(b))                       # geser waktu
        x = np.stack([self.X[j, s:s + WIN] for j, s in zip(b, st)]).astype(np.float32)
        x = zscore(x)
        x *= self.rng.uniform(0.85, 1.15, (len(b), 1))
        f = self.rng.uniform(0.05, 0.5, (len(b), 1))                          # baseline wander
        x += self.rng.uniform(0, 0.3, (len(b), 1)) * np.sin(2 * np.pi * f * self.t + self.rng.uniform(0, 6.3, (len(b), 1)))
        x += self.rng.normal(0, 0.05, x.shape)                                 # derau Gaussian
        return x[..., None], self.y[b]


# ============================================================== metrik
def per_class_metrics(yt, yp):
    cm = np.zeros((3, 3), int)
    for a, b in zip(yt, yp):
        cm[a, b] += 1
    out = {}
    for c, n in enumerate(CLASSES):
        tp = cm[c, c]; fn = cm[c].sum() - tp; fp = cm[:, c].sum() - tp; tn = cm.sum() - tp - fn - fp
        se = tp / max(tp + fn, 1); sp = tn / max(tn + fp, 1); pr = tp / max(tp + fp, 1)
        out[n] = {"n": int(cm[c].sum()), "sensitivity": round(se, 4), "specificity": round(sp, 4),
                  "precision": round(pr, 4), "f1": round(2 * pr * se / max(pr + se, 1e-9), 4)}
    acc = float(np.trace(cm) / max(cm.sum(), 1))
    return cm, out, round(acc, 4), round(float(np.mean([v["f1"] for v in out.values()])), 4)


def evaluate(model, X, y, tag, src):
    prob = model.predict(center_crop(X), batch_size=256, verbose=0)
    pred = prob.argmax(1)
    conf = prob.max(1)
    cm, pc, acc, mf1 = per_class_metrics(y, pred)
    res = {"n": int(len(y)), "accuracy": acc, "macro_f1": mf1, "confusion_matrix": cm.tolist(),
           "per_kelas": pc}
    try:
        from sklearn.metrics import roc_auc_score
        res["auc_ovr_macro"] = round(float(roc_auc_score(y, prob, multi_class="ovr")), 4)
    except Exception:  # noqa: BLE001
        pass
    res["per_sumber"] = {}
    for s in np.unique(src):
        m = src == s
        _, pcs, a_s, f_s = per_class_metrics(y[m], pred[m])
        res["per_sumber"][str(s)] = {"n": int(m.sum()), "accuracy": a_s, "macro_f1": f_s, "per_kelas": pcs}
    res["per_kondisi"] = {}
    for t in np.unique(tag):
        m = tag == t
        res["per_kondisi"][str(t)] = {"n": int(m.sum()), "kelas": CLASSES[int(np.bincount(y[m]).argmax())],
                                     "benar": round(float((pred[m] == y[m]).mean()), 4)}
    res["tau_conf"] = []
    for tau in (0.0, 0.44, 0.50, 0.60, 0.70, 0.75, 0.80, 0.85):
        acc_m = conf >= tau
        yt, yp = y[acc_m], pred[acc_m]
        att = yt == 2
        res["tau_conf"].append({
            "tau": tau, "cakupan": round(float(acc_m.mean()), 4),
            "akurasi_diterima": round(float((yt == yp).mean()) if len(yt) else 0, 4),
            "sensitivity_serangan_efektif": round(float(((pred == 2) & acc_m & (y == 2)).sum() / max((y == 2).sum(), 1)), 4),
            "sensitivity_serangan_diterima": round(float((yp[att] == 2).mean()) if att.any() else 0, 4)})
    return res, prob


def eval_synthetic(model, n_per=60, seed=7):
    """Seberapa cocok model data nyata terhadap ECG sintetis simulator lama."""
    from heartsim_common.ecg_synth import CLASS_MORPHS, MORPH_CLASS, make_window
    rng = np.random.default_rng(seed)
    out = {}
    for c in range(3):
        for m in CLASS_MORPHS[c]:
            X = []
            for _ in range(n_per):
                X.append(make_window(c, rng))
            pred = model.predict(zscore(np.asarray(X, np.float32))[..., None], verbose=0).argmax(1)
            out[m] = round(float((pred == MORPH_CLASS[m]).mean()), 3)
    return out


# ============================================================== plot
def plots(hist, cm, taus, out):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    ink, grid, c1, c2 = "#1f2a36", "#d8dee6", "#1f4e79", "#c0504d"
    plt.rcParams.update({"font.size": 10, "axes.edgecolor": grid, "axes.labelcolor": ink,
                         "xtick.color": ink, "ytick.color": ink})
    fig, ax = plt.subplots(1, 2, figsize=(11, 3.8))
    ep = np.arange(1, len(hist["loss"]) + 1)
    ax[0].plot(ep, hist["loss"], color=c1, label="train"); ax[0].plot(ep, hist["val_loss"], color=c2, label="validasi")
    ax[0].set_title("Loss (categorical cross-entropy)"); ax[0].set_xlabel("epoch"); ax[0].legend(frameon=False)
    ax[1].plot(ep, hist["accuracy"], color=c1, label="train"); ax[1].plot(ep, hist["val_accuracy"], color=c2, label="validasi")
    ax[1].set_title("Akurasi"); ax[1].set_xlabel("epoch"); ax[1].legend(frameon=False)
    for a in ax:
        a.grid(color=grid, lw=0.6); a.spines[["top", "right"]].set_visible(False)
    fig.tight_layout(); fig.savefig(out / "training_curves.png", dpi=160); plt.close(fig)

    cmn = cm / np.maximum(cm.sum(1, keepdims=True), 1)
    fig, ax = plt.subplots(figsize=(5.2, 4.4))
    ax.imshow(cmn, cmap="Blues", vmin=0, vmax=1)
    for i in range(3):
        for j in range(3):
            ax.text(j, i, f"{cm[i, j]}\n({cmn[i, j]:.1%})", ha="center", va="center",
                    color="white" if cmn[i, j] > 0.6 else ink, fontsize=9)
    ax.set_xticks(range(3), CLASSES); ax.set_yticks(range(3), CLASSES)
    ax.set_xlabel("Prediksi"); ax.set_ylabel("Aktual"); ax.set_title("Confusion matrix set uji (inter-patient)")
    fig.tight_layout(); fig.savefig(out / "confusion_matrix.png", dpi=160); plt.close(fig)

    fig, ax = plt.subplots(figsize=(6, 3.6))
    t = [r["tau"] for r in taus[1:]]
    ax.plot(t, [r["cakupan"] for r in taus[1:]], "o-", color=c1, label="cakupan (prediksi diterima)")
    ax.plot(t, [r["akurasi_diterima"] for r in taus[1:]], "s-", color=c2, label="akurasi pada yang diterima")
    ax.plot(t, [r["sensitivity_serangan_efektif"] for r in taus[1:]], "^-", color="#6b7f3a", label="sensitivity Serangan efektif")
    ax.set_xlabel("tau_conf"); ax.set_ylim(0, 1.02); ax.grid(color=grid, lw=0.6); ax.legend(frameon=False, fontsize=8)
    ax.set_title("Pengaruh ambang kepercayaan tau_conf"); ax.spines[["top", "right"]].set_visible(False)
    fig.tight_layout(); fig.savefig(out / "tau_conf.png", dpi=160); plt.close(fig)


# ============================================================== bank replay
def build_replay_bank(model, X, y, tag, rec, hr, split, out_path, per_tag=60, min_ok=10,
                      tau=0.44, seed=1):
    """Bank window untuk mode replay simulator.

    Urutan sumber per kondisi: set UJI (pasien held-out) -> validasi -> train. Window dari split
    berikutnya hanya ditambahkan bila window uji yang terklasifikasi benar dengan p_conf >= tau
    kurang dari `min_ok` (mis. VT hanya 1 pasien uji, VF hanya ada di rekaman 207 yang masuk train).
    Asal split, prediksi, dan confidence setiap window disimpan agar dapat dilaporkan apa adanya."""
    rng = np.random.default_rng(seed)
    # Replay memutar window 10 s berulang, sehingga model melihat berbagai potongan 7 s.
    # Window dinilai "baik" hanya bila benar dan yakin (>= tau) pada TIGA posisi potongan.
    preds, confs = [], []
    for st in (0, (SEG - WIN) // 2, SEG - WIN):
        pr = model.predict(zscore(X[:, st:st + WIN].astype(np.float32))[..., None], batch_size=256, verbose=0)
        preds.append(pr.argmax(1)); confs.append(pr.max(1))
    preds, confs = np.stack(preds), np.stack(confs)
    pred = preds[1]
    conf = np.where((preds == y).all(0), confs.min(0), 0.0)     # 0 bila ada potongan yang salah
    good = (pred == y) & (conf >= tau)
    sel = []
    for t in np.unique(tag):
        n_ok = 0
        for sp in ("test", "val", "train"):
            m = np.where((tag == t) & (split == sp))[0]
            if not len(m):
                continue
            pick = rng.choice(m, min(per_tag, len(m)), replace=False)   # sampel acak (tak bias)
            ok_extra = np.setdiff1d(m[good[m]], pick)            # seluruh window 'baik' ikut (maks. 150)
            sel.extend((i, sp, True) for i in pick)
            sel.extend((i, sp, False) for i in ok_extra[:150])
            pick = np.concatenate([pick, ok_extra[:150]])
            n_ok += int(good[pick].sum())
            if n_ok >= min_ok:
                break
    idx = np.array([i for i, _, _ in sel])
    np.savez_compressed(
        out_path, X=X[idx].astype(np.float16), y=y[idx].astype(np.int8), tag=tag[idx], rec=rec[idx],
        hr=hr[idx].astype(np.float32), split=np.array([s for _, s, _ in sel]),
        acak=np.array([a for _, _, a in sel]),
        pred=pred[idx].astype(np.int8), conf=conf[idx].astype(np.float32), fs=FS)
    return Counter((str(tag[i]), s, "benar" if good[i] else "salah") for i, s, _ in sel)


def mi_location(model, X, y, rec, src, ptbxl_dir):
    """Sensitivity kelas Serangan PTB-XL per lokasi infark (subclass diagnostik PTB-XL)."""
    import ast
    import pandas as pd
    db = pd.read_csv(Path(ptbxl_dir) / "ptbxl_database.csv", index_col="ecg_id")
    st = pd.read_csv(Path(ptbxl_dir) / "scp_statements.csv", index_col=0)
    sub = st[st.diagnostic_class == "MI"].diagnostic_subclass.to_dict()
    m = (y == 2) & (src == "ptbxl")
    pred = model.predict(center_crop(X[m]), batch_size=256, verbose=0).argmax(1)
    res = defaultdict(lambda: [0, 0])
    for r, p in zip(rec[m], pred):
        codes = ast.literal_eval(db.loc[int(r.split("/")[1]), "scp_codes"])
        subs = {sub[c] for c, lk in codes.items() if c in sub and (lk >= 50 or lk == 0)} or {"INJ/STE"}
        for s_ in subs:
            res[s_][0] += 1
            res[s_][1] += int(p == 2)
    nama = {"AMI": "anterior/anteroseptal", "IMI": "inferior", "LMI": "lateral", "PMI": "posterior",
            "INJ/STE": "pola injury/elevasi ST"}
    return {k: {"lokasi": nama.get(k, k), "n": n, "sensitivity": round(ok / n, 4)}
            for k, (n, ok) in sorted(res.items(), key=lambda kv: -kv[1][0])}


# ============================================================== main
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", type=Path, required=True)
    ap.add_argument("--epochs", type=int, default=40)
    ap.add_argument("--batch", type=int, default=64)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--cap-per-patient", type=int, default=60,
                    help="maks. window per (pasien, kondisi); 0 = tanpa batas (VT/VF tidak dibatasi)")
    ap.add_argument("--bank", type=Path, default=ROOT / "simulator" / "simulator" / "replay_bank.npz")
    ap.add_argument("--ptbxl-dir", type=Path, default=None,
                    help="folder PTB-XL (berisi ptbxl_database.csv) untuk analisis lokasi infark")
    ap.add_argument("--oversample-rare", type=int, default=10, help="faktor pengulangan window VT/VF di train")
    ap.add_argument("--out", type=Path, default=ART,
                    help="folder keluaran model & metrik (default artifacts/, dipakai layanan cloud)")
    ap.add_argument("--no-bank", action="store_true", help="jangan perbarui bank replay simulator")
    ap.add_argument("--eval-only", action="store_true",
                    help="lewati pelatihan; evaluasi ulang model tersimpan (history.csv dipakai ulang)")
    a = ap.parse_args()
    out = a.out
    tf.keras.utils.set_random_seed(a.seed)
    t0 = time.time()

    d = np.load(a.data, allow_pickle=False)
    X, y, tag, pid, src, rec, hr = (d[k] for k in ("X", "y", "tag", "pid", "src", "rec", "hr"))
    y = y.astype(np.int64)
    if a.cap_per_patient > 0:
        # MIT-BIH: 30 menit rekaman menghasilkan ratusan window dari SATU pasien. Tanpa pembatasan,
        # segelintir pasien mendominasi set validasi/uji sehingga metrik berayun tajam antar-epoch.
        rng = np.random.default_rng(a.seed)
        keep = np.ones(len(y), bool)
        groups = defaultdict(list)
        for i, (p, t) in enumerate(zip(pid, tag)):
            groups[(p, t)].append(i)
        for (p, t), idx in groups.items():
            if len(idx) > a.cap_per_patient and t not in ("vt", "vf"):
                drop = rng.choice(idx, len(idx) - a.cap_per_patient, replace=False)
                keep[drop] = False
        X, y, tag, pid, src, rec, hr = (v[keep] for v in (X, y, tag, pid, src, rec, hr))
        print(f"pembatasan {a.cap_per_patient} window per (pasien, kondisi): {keep.sum()} dari {len(keep)} window")
    split, assign = patient_split(pid, y, tag, src, a.seed)
    for s in ("train", "val", "test"):
        m = split == s
        print(f"{s:<5}: {m.sum():6d} window, {len({p for p, v in assign.items() if v == s}):5d} pasien, "
              f"kelas={np.bincount(y[m], minlength=3).tolist()}")
    # pastikan tidak ada kebocoran pasien antar-split
    for s1, s2 in (("train", "val"), ("train", "test"), ("val", "test")):
        assert not (set(pid[split == s1]) & set(pid[split == s2])), "kebocoran pasien!"

    tr, va, te = split == "train", split == "val", split == "test"
    cnt = np.bincount(y[tr], minlength=3)
    cw = {c: float(tr.sum() / (3 * max(cnt[c], 1))) for c in range(3)}
    print("class weight:", cw)

    if a.eval_only:
        model = tf.keras.models.load_model(out / "cnn1d_ecg.keras", compile=False)
        import csv
        with open(out / "history.csv") as f:
            rows_h = list(csv.DictReader(f))
        hist = type("H", (), {"history": {k: [float(r[k]) for r in rows_h] for k in rows_h[0] if k != "epoch"}})()
        prev = json.loads((out / "metrics.json").read_text()).get("pelatihan", {})
    else:
        prev = {}
        model = build_model()
        model.compile(optimizer=tf.keras.optimizers.Adam(1e-3), loss="sparse_categorical_crossentropy",
                      metrics=["accuracy"])
        cb = [tf.keras.callbacks.ReduceLROnPlateau(monitor="val_loss", factor=0.5, patience=5, verbose=1),
              tf.keras.callbacks.EarlyStopping(monitor="val_loss", patience=10, restore_best_weights=True,
                                               verbose=1)]
        tr_idx = np.where(tr)[0]
        if a.oversample_rare > 1:
            # VT/VF hanya ~1 % data Serangan; tanpa oversampling model nyaris tidak mengenalinya
            rare = tr_idx[np.isin(tag[tr_idx], ["vt", "vf"])]
            tr_idx = np.concatenate([tr_idx] + [rare] * (a.oversample_rare - 1))
            print(f"oversampling VT/VF x{a.oversample_rare}: {len(rare)} -> {len(rare) * a.oversample_rare} window")
        gen = Augmented(X[tr_idx], y[tr_idx], a.batch, a.seed)
        hist = model.fit(gen, validation_data=(center_crop(X[va]), y[va]), epochs=a.epochs,
                         class_weight=cw, callbacks=cb, verbose=2)

    res, _ = evaluate(model, X[te], y[te], tag[te], src[te])
    res_val, _ = evaluate(model, X[va], y[va], tag[va], src[va])
    syn = eval_synthetic(model)
    print(json.dumps({"uji": {k: res[k] for k in ("accuracy", "macro_f1", "per_kelas")}}, indent=2))
    print("kecocokan dengan ECG sintetis:", syn)

    out.mkdir(exist_ok=True)
    old = out / "cnn1d_ecg.keras"
    backup = out / "cnn1d_ecg_sintetis.keras"
    if old.exists() and not backup.exists():
        shutil.copy2(old, backup)
        if (out / "metrics.json").exists():
            shutil.copy2(out / "metrics.json", out / "metrics_sintetis.json")
    import csv
    if not a.eval_only:
        model.save(old)
        with open(out / "history.csv", "w", newline="") as f:
            w = csv.writer(f)
            keys = list(hist.history)
            w.writerow(["epoch"] + keys)
            for i in range(len(hist.history["loss"])):
                w.writerow([i + 1] + [float(hist.history[k][i]) for k in keys])
    with open(out / "split_pasien.csv", "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["pid", "split"])
        w.writerows(sorted(assign.items()))
    metrics = {
        "catatan": ("Dilatih pada PTB-XL (lead I, 100 Hz -> 250 Hz) + MIT-BIH (MLII, 360 Hz -> 250 Hz), "
                    "split inter-patient 70/15/15. Kelas Serangan PTB-XL = pola infark (akut/lama tidak dibedakan)."),
        "dataset": {"berkas": a.data.name, "window": int(len(y)), "cap_per_pasien": a.cap_per_patient,
                    "per_split": {s: int((split == s).sum()) for s in ("train", "val", "test")},
                    "pasien_per_split": {s: sum(v == s for v in assign.values()) for s in ("train", "val", "test")},
                    "kelas_total": np.bincount(y, minlength=3).tolist(),
                    "kondisi_total": {str(k): int(v) for k, v in Counter(tag.tolist()).items()}},
        "pelatihan": {"epoch_dijalankan": len(hist.history["loss"]), "oversample_vt_vf": a.oversample_rare,
                      "epoch_terbaik": int(np.argmin(hist.history["val_loss"]) + 1), "class_weight": cw,
                      "parameter": int(model.count_params()),
                      "durasi_s": prev.get("durasi_s", round(time.time() - t0))},
        "uji": res, "validasi": {k: res_val[k] for k in ("accuracy", "macro_f1", "per_kelas")},
        "kecocokan_ecg_sintetis": syn,
    }
    if a.ptbxl_dir:
        metrics["uji"]["serangan_per_lokasi_infark"] = mi_location(model, X[te], y[te], rec[te], src[te], a.ptbxl_dir)
    (out / "metrics.json").write_text(json.dumps(metrics, indent=2, ensure_ascii=False))
    plots(hist.history, np.array(res["confusion_matrix"]), res["tau_conf"], out)
    if not a.no_bank:
        bank = build_replay_bank(model, X, y, tag, rec, hr, split, a.bank)
        print("bank replay:", dict(bank))
    print(f"selesai dalam {time.time() - t0:.0f} s; model -> {old}")


if __name__ == "__main__":
    main()
