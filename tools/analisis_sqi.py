"""Analisis gerbang kualitas sinyal (cloud/cloud/signal_quality.py) pada data nyata.

    python tools/analisis_sqi.py                      # bank replay + BUT QDB (unduh ~35 MB sekali)
    python tools/analisis_sqi.py --tanpa-butqdb       # bank replay saja, tanpa internet

Dua sumber data:

1. Bank replay dataset (dataset/dataset/replay_bank.npz): rekaman PTB-XL/MIT-BIH/CUDB per
   kondisi (normal, ST depresi, STEMI, AF, PVC, SVT, VT, VF). Pertanyaannya: apakah gerbang atau
   ambang SQI dari literatur ikut menolak ritme berbahaya?
2. BUT QDB (Brno University of Technology ECG Quality Database, PhysioNet): rekaman wearable 24 jam
   dari Bittium Faros 180 saat aktivitas harian, dengan anotasi kualitas konsensus:
     kelas 1  semua gelombang (P, QRS, T) jelas
     kelas 2  QRS jelas, deteksi QRS masih andal
     kelas 3  QRS tidak bisa dideteksi andal, sinyal tidak layak dianalisis
   Window 7 s diambil dari dalam segmen berlabel lewat HTTP Range (tanpa mengunduh 174 MB per
   rekaman), diturunkan ke 250 Hz, lalu dilewatkan FIR 0,5–40 Hz 501 tap dan notch 50 Hz seperti
   firmware, supaya yang dinilai mirip dengan yang benar-benar diterima cloud.

Bila model CNN tersedia, prediksinya pada window kelas 3 juga dihitung: seberapa sering derau
terbaca "Serangan" atau "Pra-Serangan" dengan keyakinan di atas tau.
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
from scipy.signal import firwin, iirnotch, lfilter, resample_poly

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT / "common"), str(ROOT / "cloud")]
from cloud.signal_quality import assess  # noqa: E402
from heartsim_common import config as C  # noqa: E402

BUTQDB = "https://physionet-open.s3.amazonaws.com/butqdb/1.0.0"
FS_SRC, FS = 1000, C.FS_ECG
WIN = C.WINDOW_SAMPLES                      # 1750 sampel = 7 s
PRE_S = 2.5                                 # data sebelum window untuk "memanaskan" filter kausal
PER_CLASS = 40                              # window per kelas per rekaman
FIR = firwin(501, [0.5, 40], pass_zero=False, fs=FS)
NB, NA = iirnotch(50, 30, FS)

# ambang literatur (Li, Mark & Clifford 2008; Clifford dkk. 2012; Orphanidou dkk. 2015)
LIT = {"kSQI < 5": lambda q: q["ksqi"] is not None and q["ksqi"] < 5,
       "pSQI di luar 0,5–0,8": lambda q: q["psqi"] is not None and not (0.5 <= q["psqi"] <= 0.8),
       "basSQI < 0,95": lambda q: q["bassqi"] is not None and q["bassqi"] < 0.95}


def http(url: str, rng: tuple[int, int] | None = None, tries: int = 5) -> bytes:
    req = urllib.request.Request(url)
    if rng:
        req.add_header("Range", f"bytes={rng[0]}-{rng[1]}")
    for i in range(tries):
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return r.read()
        except OSError:
            if i == tries - 1:
                raise
            time.sleep(1 + 2 * i)
    raise RuntimeError("tidak tercapai")


def butqdb_windows(cache: Path, seed: int = 7) -> dict:
    if cache.exists():
        d = np.load(cache)
        return {k: d[k] for k in d.files}
    recs = sorted({l.split("/")[0] for l in http(f"{BUTQDB}/RECORDS").decode().split() if l.endswith("_ECG")})
    rng = np.random.default_rng(seed)
    jobs = []
    for rec in recs:
        hea = http(f"{BUTQDB}/{rec}/{rec}_ECG.hea").decode().splitlines()
        n_total = int(hea[0].split()[3])
        f = hea[1].split()
        gain, base = float(f[2].split("(")[0]), float(f[2].split("(")[1].split(")")[0])
        rows = list(csv.reader(http(f"{BUTQDB}/{rec}/{rec}_ANN.csv").decode().splitlines()))
        segs = [(int(r[9]), int(r[10]), int(r[11])) for r in rows if len(r) >= 12 and r[9].strip()]
        need = int((WIN / FS + PRE_S) * FS_SRC)
        for cls in (1, 2, 3):
            cand = [(a, b) for a, b, c in segs if c == cls and b - a >= need]
            if not cand:
                continue
            w = np.array([b - a - need for a, b in cand], float)
            for i in rng.choice(len(cand), size=PER_CLASS, p=w / w.sum()):
                a, b = cand[i]
                s0 = int(rng.integers(a, b - need)) - 1          # anotasi berbasis 1
                if s0 >= 0 and s0 + need <= n_total:
                    jobs.append((rec, cls, s0, need, gain, base))

    def fetch(j):
        rec, cls, s0, need, gain, base = j
        raw = http(f"{BUTQDB}/{rec}/{rec}_ECG.dat", (2 * s0, 2 * (s0 + need) - 1))
        mv = (np.frombuffer(raw, "<i2").astype(np.float64) - base) / gain / 1000.0
        return rec, cls, mv

    out = {"x": [], "cls": [], "rec": []}
    with ThreadPoolExecutor(6) as ex:
        for rec, cls, mv in ex.map(fetch, jobs):
            y = resample_poly(mv, 1, FS_SRC // FS)
            y = lfilter(NB, NA, lfilter(FIR, 1.0, y - y[0]))[-WIN:]
            out["x"].append(y.astype(np.float32))
            out["cls"].append(cls)
            out["rec"].append(rec)
    d = {"x": np.stack(out["x"]), "cls": np.array(out["cls"], np.int8), "rec": np.array(out["rec"])}
    cache.parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(cache, **d)
    return d


def _download_db(db: str, dest: Path) -> list[str]:
    dest.mkdir(parents=True, exist_ok=True)
    base = f"https://physionet-open.s3.amazonaws.com/{db}/1.0.0"
    recs = http(f"{base}/RECORDS").decode().split()
    jobs = [(r, e) for r in recs for e in ("hea", "dat", "atr") if not (dest / f"{r}.{e}").exists()]

    def get(j):
        r, e = j
        (dest / f"{r}.{e}").write_bytes(http(f"{base}/{r}.{e}"))
    with ThreadPoolExecutor(6) as ex:
        list(ex.map(get, jobs))
    return recs


def ventricular_windows(cache_dir: Path) -> dict:
    """Window 7 s VF / flutter ventrikel / VT / derau dari CUDB (Creighton) dan VFDB (MIT-BIH Malignant
    Ventricular Ectopy). Keduanya 250 Hz, jadi tidak perlu resampling; tetap lewat FIR + notch firmware."""
    import wfdb
    rhythm = {"(VF": "vf", "(VFIB": "vf", "(VFL": "vfl", "(VT": "vt", "(NOISE": "derau", "(N": "normal"}
    out = {"x": [], "tag": [], "rec": []}
    pre = int(PRE_S * FS)
    for db in ("cudb", "vfdb"):
        d = cache_dir / db
        for r in _download_db(db, d):
            sig, _ = wfdb.rdsamp(str(d / r))
            ann = wfdb.rdann(str(d / r), "atr")
            spans, cur, start = [], None, 0
            for smp, sym, aux in zip(ann.sample, ann.symbol, ann.aux_note):
                aux = aux.strip("\x00 ")
                lab = None
                if sym == "[":
                    lab = "vf"                   # CUDB: awal episode VF/flutter
                elif sym == "]":
                    lab = "normal"
                elif aux in rhythm:
                    lab = rhythm[aux]
                elif aux.startswith("("):
                    lab = "lain"
                if lab is not None:
                    if cur is not None:
                        spans.append((start, smp, cur))
                    cur, start = lab, smp
            if cur is not None:
                spans.append((start, sig.shape[0], cur))
            for a, b, lab in spans:
                if lab not in ("vf", "vfl", "vt", "derau"):
                    continue
                for s0 in range(a + pre, b - WIN + 1, WIN):
                    for ch in range(sig.shape[1]):
                        x = sig[s0 - pre:s0 + WIN, ch]
                        if np.isnan(x).any():
                            continue
                        y = lfilter(NB, NA, lfilter(FIR, 1.0, x - x[0]))[-WIN:]
                        out["x"].append(y.astype(np.float32))
                        out["tag"].append(lab)
                        out["rec"].append(f"{db}/{r}")
    return {"x": np.stack(out["x"]), "tag": np.array(out["tag"]), "rec": np.array(out["rec"])}


def qualities(windows_mv: np.ndarray) -> list[dict]:
    return [assess(np.round(w * C.ECG_COUNTS_PER_MV).astype(np.int32)).dict() for w in windows_mv]


def auc(pos: np.ndarray, neg: np.ndarray) -> float:
    """AUC Mann-Whitney: peluang skor kelas positif > skor kelas negatif."""
    pos, neg = pos[~np.isnan(pos)], neg[~np.isnan(neg)]
    r = np.argsort(np.argsort(np.concatenate([pos, neg]))) + 1
    return float((r[: pos.size].sum() - pos.size * (pos.size + 1) / 2) / (pos.size * neg.size))


def col(qs: list[dict], k: str) -> np.ndarray:
    return np.array([np.nan if q[k] is None else q[k] for q in qs], float)


def summarize(name: str, qs: list[dict]) -> dict:
    r = {"n": len(qs), "gerbang_blok": float(np.mean([not q["ok"] for q in qs]))}
    for k in ("ksqi", "psqi", "bassqi", "ptp_mv"):
        v = col(qs, k)
        r[k] = [round(float(np.nanpercentile(v, p)), 3) for p in (10, 50, 90)] if np.isfinite(v).any() else None
    for lab, fn in LIT.items():
        r[lab] = float(np.mean([fn(q) for q in qs]))
    return r


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--tanpa-butqdb", action="store_true")
    ap.add_argument("--cache", default=str(Path.home() / ".cache" / "cardiovest" / "butqdb_windows.npz"))
    ap.add_argument("--json", default=str(ROOT / "docs" / "analisis_sqi.json"))
    a = ap.parse_args()
    report: dict = {"bank": {}, "butqdb": {}}

    bank = np.load(ROOT / "dataset" / "dataset" / "replay_bank.npz")
    X, tags = bank["X"][:, :WIN].astype(np.float64), bank["tag"].astype(str)
    print("== Bank replay (window 7 s pertama tiap rekaman)")
    print(f"{'kondisi':<14}{'n':>5}{'diblok':>8}{'kSQI p10/p50/p90':>22}{'pSQI p50':>10}"
          f"{'kSQI<5':>9}{'pSQI luar':>11}{'basSQI<.95':>12}")
    for t in ["normal", "st_depression", "stemi", "cd", "af", "pvc", "svt", "vt", "vf"]:
        s = summarize(t, qualities(X[tags == t]))
        report["bank"][t] = s
        print(f"{t:<14}{s['n']:>5}{s['gerbang_blok']:>8.1%}{str(s['ksqi']):>22}{s['psqi'][1]:>10.2f}"
              f"{s['kSQI < 5']:>9.1%}{s['pSQI di luar 0,5–0,8']:>11.1%}{s['basSQI < 0,95']:>12.1%}")

    if not a.tanpa_butqdb:
        v = ventricular_windows(Path(a.cache).parent)
        qv = qualities(v["x"].astype(np.float64))
        print(f"\n== CUDB + VFDB (aritmia ventrikel nyata, {len(set(v['rec']))} rekaman, tiap kanal dihitung)")
        print(f"{'ritme':<8}{'n':>6}{'diblok':>8}{'kSQI p10/p50/p90':>22}{'pSQI p10/p50':>14}{'kSQI<5':>9}")
        for t in ("vf", "vfl", "vt", "derau"):
            qs = [q for q, k in zip(qv, v["tag"]) if k == t]
            if not qs:
                continue
            s_ = summarize(t, qs)
            report.setdefault("ventrikel", {})[t] = s_
            print(f"{t:<8}{s_['n']:>6}{s_['gerbang_blok']:>8.1%}{str(s_['ksqi']):>22}"
                  f"{str(s_['psqi'][:2]):>14}{s_['kSQI < 5']:>9.1%}")

        d = butqdb_windows(Path(a.cache))
        qs_all = qualities(d["x"].astype(np.float64))
        print(f"\n== BUT QDB ({len(set(d['rec']))} rekaman Faros 180, {len(qs_all)} window 7 s)")
        print(f"{'kelas':<8}{'n':>5}{'diblok':>8}{'kSQI p10/p50/p90':>22}{'pSQI p50':>10}"
              f"{'kSQI<5':>9}{'pSQI luar':>11}{'basSQI<.95':>12}")
        for c in (1, 2, 3):
            qs = [q for q, k in zip(qs_all, d["cls"]) if k == c]
            s = summarize(f"kelas {c}", qs)
            report["butqdb"][f"kelas_{c}"] = s
            print(f"{c:<8}{s['n']:>5}{s['gerbang_blok']:>8.1%}{str(s['ksqi']):>22}{s['psqi'][1]:>10.2f}"
                  f"{s['kSQI < 5']:>9.1%}{s['pSQI di luar 0,5–0,8']:>11.1%}{s['basSQI < 0,95']:>12.1%}")
        bad = d["cls"] == 3
        report["butqdb"]["auc_kelas3"] = {}
        for k, sign in (("ksqi", -1), ("psqi", -1), ("bassqi", -1), ("ptp_mv", 1)):
            v = sign * col(qs_all, k)
            report["butqdb"]["auc_kelas3"][k] = round(auc(v[bad], v[~bad]), 3)
        print("AUC pemisahan kelas 3 vs 1+2:", report["butqdb"]["auc_kelas3"])

        model_path = ROOT / "cloud" / "model" / "artifacts" / "cnn1d_ecg.keras"
        if model_path.exists():
            os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "2")
            import tensorflow as tf
            m = tf.keras.models.load_model(model_path, compile=False)
            z = d["x"].astype(np.float32)
            z = (z - z.mean(1, keepdims=True)) / (z.std(1, keepdims=True) + 1e-8)
            p = m.predict(z[..., None], verbose=0, batch_size=256)
            cls, conf = p.argmax(1), p.max(1)
            ok = np.array([q["ok"] for q in qs_all])
            report["butqdb"]["cnn"] = {}
            print(f"\nCNN pada window BUT QDB (tau {C.TAU_CONF}; tau gerak {C.TAU_CONF_MOTION})")
            for c in (1, 2, 3):
                m_ = d["cls"] == c
                abn = (cls != C.CLS_NORMAL) & m_
                r = {"abnormal_tau": float(np.mean(conf[abn] >= C.TAU_CONF) * abn.sum() / m_.sum()),
                     "abnormal_tau_gerak": float(np.mean(conf[abn] >= C.TAU_CONF_MOTION) * abn.sum() / m_.sum()),
                     "serangan_tau": float(np.mean((cls[m_] == C.CLS_ATTACK) & (conf[m_] >= C.TAU_CONF))),
                     "abnormal_tau_lolos_gerbang": float(np.mean((cls[m_] != C.CLS_NORMAL)
                                                                & (conf[m_] >= C.TAU_CONF) & ok[m_]))}
                report["butqdb"]["cnn"][f"kelas_{c}"] = {k: round(v, 3) for k, v in r.items()}
                print(f"  kelas {c}: non-Normal >= tau {r['abnormal_tau']:.1%} | >= tau gerak "
                      f"{r['abnormal_tau_gerak']:.1%} | Serangan >= tau {r['serangan_tau']:.1%} | "
                      f"non-Normal & lolos gerbang {r['abnormal_tau_lolos_gerbang']:.1%}")

    Path(a.json).write_text(json.dumps(report, indent=1, ensure_ascii=False))
    print(f"\nringkasan disimpan: {a.json}")


if __name__ == "__main__":
    main()
