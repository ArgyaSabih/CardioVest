"""Perkiraan alarm palsu saat alat dipakai sehari-hari, memakai rekaman wearable BUT QDB.

    python tools/uji_alarm_palsu.py              # 18 rekaman x 60 menit (unduh ~170 MB sekali)
    python tools/uji_alarm_palsu.py --menit 20   # lebih cepat

BUT QDB direkam dengan Bittium Faros 180 (ECG 1 lead 1000 Hz + akselerometer 100 Hz) saat subjek
beraktivitas bebas. Potongan kontinu tiap rekaman diproses seperti di CardioVest:
  ECG  -> 250 Hz -> FIR 0,5–40 Hz + notch 50 Hz (sama dengan firmware) -> window 7 s, hop 3,5 s
  ACC  -> simpangan baku |a| per detik -> median 7 detik terakhir (= DecisionEngine.activity)
  CNN asli + gerbang kualitas + DecisionEngine asli (tau, tau gerak, N, M sesuai config)

Validator GSR/HR tidak ada di BUT QDB, jadi uji ini mengukur:
  * WARNING palsu per jam  (WARNING tidak butuh validator; cukup N window non-Normal berturut-turut)
  * batas atas CRITICAL palsu per jam, dengan anggapan terburuk validator selalu positif (mis. sedang
    olahraga berat: HR > 120 dan berkeringat). Setelah CRITICAL engine di-reset agar hitungan lanjut.
Subjek BUT QDB tidak sedang serangan jantung, jadi setiap WARNING/CRITICAL dihitung palsu. Lead dan
posisi elektroda Faros tidak sama dengan Lead I CardioVest; anggap angka ini perkiraan kasar.
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import sys
from pathlib import Path

import numpy as np
from scipy.signal import lfilter, resample_poly

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT / "common"), str(ROOT / "cloud"), str(ROOT / "tools")]
from analisis_sqi import BUTQDB, FIR, FS, FS_SRC, NA, NB, WIN, http  # noqa: E402
from cloud.decision_engine import DecisionEngine  # noqa: E402
from cloud.signal_quality import assess  # noqa: E402
from heartsim_common import config as C  # noqa: E402

HOP = C.HOP_SAMPLES
MODEL = Path(os.getenv("MODEL_PATH") or ROOT / "cloud" / "model" / "artifacts" / "cnn1d_ecg.keras")


def load_stretch(rec: str, minutes: int, cache: Path, rng) -> dict:
    f = cache / f"{rec}_{minutes}m.npz"
    if f.exists():
        d = np.load(f)
        return {k: d[k] for k in d.files}
    hea = http(f"{BUTQDB}/{rec}/{rec}_ECG.hea").decode().splitlines()
    n_total = int(hea[0].split()[3])
    gain, base = float(hea[1].split()[2].split("(")[0]), float(hea[1].split()[2].split("(")[1].split(")")[0])
    ahea = http(f"{BUTQDB}/{rec}/{rec}_ACC.hea").decode().splitlines()
    ag = [(float(l.split()[2].split("(")[0]), float(l.split()[2].split("(")[1].split(")")[0])) for l in ahea[1:4]]
    n = minutes * 60 * FS_SRC
    # mulai di bagian yang dianotasi konsensus (kelas != 0)
    rows = list(csv.reader(http(f"{BUTQDB}/{rec}/{rec}_ANN.csv").decode().splitlines()))
    segs = [(int(r[9]) - 1, int(r[10]), int(r[11])) for r in rows if len(r) >= 12 and r[9].strip()]
    lo = min(a for a, _, c in segs if c)
    hi = min(max(b for _, b, c in segs if c), n_total) - n
    s0 = int(rng.integers(lo, max(lo + 1, hi)))
    s0 = (s0 // 10) * 10
    chunks = []
    step = 1_000_000
    for a in range(s0, s0 + n, step):
        b = min(a + step, s0 + n)
        chunks.append(np.frombuffer(http(f"{BUTQDB}/{rec}/{rec}_ECG.dat", (2 * a, 2 * b - 1)), "<i2"))
    ecg = (np.concatenate(chunks).astype(np.float64) - base) / gain / 1000.0
    a0, an = s0 // 10, n // 10
    raw = np.frombuffer(http(f"{BUTQDB}/{rec}/{rec}_ACC.dat", (6 * a0, 6 * (a0 + an) - 1)), "<i2").reshape(-1, 3)
    acc = np.stack([(raw[:, i] - ag[i][1]) / ag[i][0] / 1000.0 for i in range(3)], 1)   # g
    lab = np.zeros(n // FS_SRC, np.int8)                    # kelas kualitas per detik
    for a, b, c in segs:
        lo_s, hi_s = max(a, s0), min(b, s0 + n)
        if hi_s > lo_s:
            lab[(lo_s - s0) // FS_SRC:(hi_s - s0) // FS_SRC] = c
    d = {"ecg": ecg.astype(np.float32), "acc": acc.astype(np.float32), "lab": lab, "s0": np.int64(s0)}
    cache.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(f, **d)
    return d


def windows(d: dict):
    y = resample_poly(d["ecg"].astype(np.float64), 1, FS_SRC // FS)
    y = lfilter(NB, NA, lfilter(FIR, 1.0, y - y[0]))
    mag = np.linalg.norm(d["acc"], axis=1)
    sd_s = mag[: mag.size // 100 * 100].reshape(-1, 100).std(1)          # simpangan baku |a| per detik
    starts = range(int(2.5 * FS), y.size - WIN + 1, HOP)                 # lewati pemanasan filter
    X, act, lab = [], [], []
    for s in starts:
        X.append(y[s:s + WIN])
        t_end = (s + WIN) // FS
        act.append(float(np.median(sd_s[max(0, t_end - C.MOTION_WINDOW_S):t_end])))
        lab.append(int(np.bincount(d["lab"][s // FS:t_end], minlength=4).argmax()))
    return np.array(X), np.array(act), np.array(lab)


def run_fsm(cls, conf, motion, ok, use_gate: bool, n: int, validators: bool, tau: float = C.TAU_CONF):
    eng = DecisionEngine(n=n, tau_conf=tau)
    warn = crit = 0
    warn_windows = 0
    for c, p, m, q in zip(cls, conf, motion, ok):
        if use_gate and not q:
            continue                                    # sama dengan service: window dilewati
        dec = eng.step(int(c), float(p), validators, validators, False, bool(m))
        if dec.changed and dec.state == C.STATE_WARNING:
            warn += 1
        if dec.changed and dec.state == C.STATE_CRITICAL:
            crit += 1
            eng.hardware_reset()
        warn_windows += eng.state == C.STATE_WARNING
    return warn, crit, warn_windows


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--menit", type=int, default=60)
    ap.add_argument("--cache", default=str(Path.home() / ".cache" / "cardiovest" / "butqdb_kontinu"))
    ap.add_argument("--json", default=str(ROOT / "docs" / "uji_alarm_palsu.json"))
    a = ap.parse_args()
    os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "2")
    import tensorflow as tf
    model = tf.keras.models.load_model(MODEL, compile=False)

    recs = sorted({l.split("/")[0] for l in http(f"{BUTQDB}/RECORDS").decode().split() if l.endswith("_ECG")})
    rng = np.random.default_rng(11)
    configs = [("tanpa gerbang, N=2 (kode asli)", False, C.PERSIST_N, C.TAU_CONF),
               ("dengan gerbang, N=2", True, C.PERSIST_N, C.TAU_CONF),
               ("dengan gerbang, N=3", True, 3, C.TAU_CONF),
               ("dengan gerbang, N=4", True, 4, C.TAU_CONF)]
    configs += [(f"gerbang, N={n}, tau {t:.2f}", True, n, t) for t in (0.6, 0.7, 0.8, 0.9) for n in (2, 3, 4)]
    tot = {k: [0, 0, 0] for k, *_ in configs}
    hours = 0.0
    per_rec = []
    allstat = {"n": 0, "blok": 0, "motion": 0, "lab": np.zeros(4, int)}
    print(f"{'rekaman':<8}{'menit':>6}{'gerak':>7}{'kls3':>6}{'diblok':>8} | WARNING palsu (tanpa gerbang -> gerbang N=2/3/4)")
    for rec in recs:
        d = load_stretch(rec, a.menit, Path(a.cache), rng)
        X, act, lab = windows(d)
        z = (X - X.mean(1, keepdims=True)) / (X.std(1, keepdims=True) + 1e-8)
        p = model.predict(z[..., None].astype(np.float32), verbose=0, batch_size=512)
        cls, conf = p.argmax(1), p.max(1)
        ok = np.array([assess(np.round(w * C.ECG_COUNTS_PER_MV).astype(np.int32)).ok for w in X])
        motion = act > C.MOTION_SD_G
        h = len(X) * HOP / FS / 3600
        hours += h
        row = {"rekaman": rec, "jam": round(h, 3), "gerak": float(motion.mean()), "kelas3": float((lab == 3).mean()),
               "diblok": float((~ok).mean())}
        allstat["n"] += len(X)
        allstat["blok"] += int((~ok).sum())
        allstat["motion"] += int(motion.sum())
        allstat["lab"] += np.bincount(lab, minlength=4)
        ws = []
        trig = (cls != C.CLS_NORMAL) & (conf >= C.TAU_CONF)
        allstat.setdefault("pemicu", np.zeros(3, int))
        allstat["pemicu"] += np.bincount(cls[trig], minlength=3)
        for name, gate, n, tau in configs:
            w, _, _ = run_fsm(cls, conf, motion, ok, gate, n, validators=False, tau=tau)
            _, c, _ = run_fsm(cls, conf, motion, ok, gate, n, validators=True, tau=tau)
            tot[name][0] += w
            tot[name][1] += c
            row[name] = {"warning": w, "critical_terburuk": c}
            ws.append(w)
        per_rec.append(row)
        print(f"{rec:<8}{h * 60:>6.0f}{row['gerak']:>7.0%}{row['kelas3']:>6.0%}{row['diblok']:>8.0%} | "
              + " / ".join(map(str, ws[:4])))

    print(f"\nTotal {hours:.1f} jam, {allstat['n']} window; bergerak {allstat['motion'] / allstat['n']:.0%}, "
          f"kelas kualitas 1/2/3 = {allstat['lab'][1:] / allstat['lab'][1:].sum()}, "
          f"diblok gerbang {allstat['blok'] / allstat['n']:.1%}")
    pm = allstat["pemicu"]
    print(f"window non-Normal >= tau: Pra-Serangan {pm[1]}, Serangan {pm[2]} "
          f"({(pm[1] + pm[2]) / allstat['n']:.1%} dari semua window)")
    print(f"{'konfigurasi':<34}{'WARNING/jam':>12}{'CRITICAL/jam (terburuk)':>26}")
    summary = {}
    for name, *_ in configs:
        w, c, _ = tot[name]
        summary[name] = {"warning_per_jam": round(w / hours, 2), "critical_terburuk_per_jam": round(c / hours, 2)}
        print(f"{name:<34}{w / hours:>12.2f}{c / hours:>26.2f}")
    Path(a.json).write_text(json.dumps({"jam": round(hours, 2), "ringkasan": summary,
                                        "pemicu_pra_serangan": int(pm[1]), "pemicu_serangan": int(pm[2]), "per_rekaman": per_rec},
                                       indent=1, ensure_ascii=False))


if __name__ == "__main__":
    main()
