"""Bandingkan dua model (mis. Lead I vs Lead II) secara berpasangan pada pasien uji yang sama.

    python cloud/model/bandingkan_lead.py \\
        --a datasets/leadI.npz  --model-a artefak_leadI/cnn1d_ecg.keras \\
        --b datasets/leadII.npz --model-b artefak_leadII/cnn1d_ecg.keras \\
        --ptbxl-dir datasets/ptbxl --json docs/analisis_lead.json

Kedua dataset harus dibuat dari rekaman yang sama (prepare.py dengan --lead berbeda), sehingga split
pasien (seed sama) dan window ujinya identik. Selisih sensitivity dihitung per window yang sama, lalu
interval kepercayaan 95 % diperoleh dengan bootstrap per PASIEN (window dari satu pasien tidak independen).
Selisih yang intervalnya memuat nol tidak boleh dibaca sebagai "lebih baik".
"""
from __future__ import annotations

import argparse
import ast
import json
import sys
from collections import defaultdict
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from train_real import center_crop, patient_split  # noqa: E402

import tensorflow as tf  # noqa: E402


def load(path, cap=60, seed=42):
    d = np.load(path, allow_pickle=False)
    X, y, tag, pid, src, rec = (d[k] for k in ("X", "y", "tag", "pid", "src", "rec"))
    y = y.astype(np.int64)
    rng = np.random.default_rng(seed)          # pembatasan per (pasien, kondisi) persis seperti train_real.py
    keep = np.ones(len(y), bool)
    groups = defaultdict(list)
    for i, (p, t) in enumerate(zip(pid, tag)):
        groups[(p, t)].append(i)
    for (p, t), idx in groups.items():
        if len(idx) > cap and t not in ("vt", "vf"):
            keep[rng.choice(idx, len(idx) - cap, replace=False)] = False
    X, y, tag, pid, src, rec = (v[keep] for v in (X, y, tag, pid, src, rec))
    split, _ = patient_split(pid, y, tag, src, seed)
    te = split == "test"
    return X[te], y[te], tag[te], pid[te], src[te], rec[te]


def mi_subclasses(rec, ptbxl_dir):
    import pandas as pd
    db = pd.read_csv(Path(ptbxl_dir) / "ptbxl_database.csv", index_col="ecg_id")
    st = pd.read_csv(Path(ptbxl_dir) / "scp_statements.csv", index_col=0)
    sub = st[st.diagnostic_class == "MI"].diagnostic_subclass.to_dict()
    out = []
    for r in rec:
        if not str(r).startswith("ptbxl/"):
            out.append(set())
            continue
        codes = ast.literal_eval(db.loc[int(r.split("/")[1]), "scp_codes"])
        out.append({sub[c] for c, lk in codes.items() if c in sub and (lk >= 50 or lk == 0)})
    return out


def boot_diff(ok_a, ok_b, pid, n=2000, seed=0):
    """CI 95 % selisih (b - a) dengan resampling pasien."""
    rng = np.random.default_rng(seed)
    pats = np.unique(pid)
    idx = {p: np.flatnonzero(pid == p) for p in pats}
    diffs = []
    for _ in range(n):
        s = np.concatenate([idx[p] for p in rng.choice(pats, len(pats))])
        diffs.append(ok_b[s].mean() - ok_a[s].mean())
    return float(np.percentile(diffs, 2.5)), float(np.percentile(diffs, 97.5))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--a", required=True)
    ap.add_argument("--b", required=True)
    ap.add_argument("--model-a", required=True)
    ap.add_argument("--model-b", required=True)
    ap.add_argument("--label-a", default="Lead I")
    ap.add_argument("--label-b", default="Lead II")
    ap.add_argument("--ptbxl-dir", required=True)
    ap.add_argument("--json")
    a = ap.parse_args()
    XA, y, tag, pid, src, rec = load(a.a)
    XB, yB, _, pidB, _, recB = load(a.b)
    assert np.array_equal(rec, recB) and np.array_equal(y, yB), "window uji kedua dataset tidak sama"
    pa = tf.keras.models.load_model(a.model_a, compile=False).predict(center_crop(XA), batch_size=256, verbose=0).argmax(1)
    pb = tf.keras.models.load_model(a.model_b, compile=False).predict(center_crop(XB), batch_size=256, verbose=0).argmax(1)
    subs = mi_subclasses(rec, a.ptbxl_dir)

    rows = []

    def row(name, m, target):
        if m.sum() < 10:
            return
        ok_a = (pa[m] == target) if target is not None else (pa[m] == y[m])
        ok_b = (pb[m] == target) if target is not None else (pb[m] == y[m])
        lo, hi = boot_diff(ok_a.astype(float), ok_b.astype(float), pid[m])
        rows.append({"kelompok": name, "n": int(m.sum()), "pasien": int(len(np.unique(pid[m]))),
                     a.label_a: round(float(ok_a.mean()), 3), a.label_b: round(float(ok_b.mean()), 3),
                     "selisih": round(float(ok_b.mean() - ok_a.mean()), 3), "ci95": [round(lo, 3), round(hi, 3)]})

    row("akurasi keseluruhan", np.ones(len(y), bool), None)
    for c, nm in enumerate(["Normal", "Pra-Serangan", "Serangan"]):
        row(f"sensitivity {nm}", y == c, c)
    for t in ["stemi", "st_depression", "af", "cd", "pvc"]:
        m = tag == t
        if m.any():
            row(f"kondisi {t}", m, int(np.bincount(y[m]).argmax()))
    for s, nm in [("IMI", "infark inferior"), ("AMI", "infark anterior/anteroseptal"), ("LMI", "infark lateral")]:
        row(f"Serangan: {nm}", np.array([s in x for x in subs]) & (y == 2), 2)

    print(f"{'kelompok':<34}{'n':>6}{'pasien':>8}{a.label_a:>9}{a.label_b:>9}{'selisih':>9}   CI 95 % (bootstrap pasien)")
    for r in rows:
        sig = "" if r["ci95"][0] <= 0 <= r["ci95"][1] else "  *"
        print(f"{r['kelompok']:<34}{r['n']:>6}{r['pasien']:>8}{r[a.label_a]:>9.3f}{r[a.label_b]:>9.3f}"
              f"{r['selisih']:>+9.3f}   [{r['ci95'][0]:+.3f}, {r['ci95'][1]:+.3f}]{sig}")
    print("* interval tidak memuat nol")
    if a.json:
        Path(a.json).write_text(json.dumps(rows, indent=1, ensure_ascii=False))


if __name__ == "__main__":
    main()
