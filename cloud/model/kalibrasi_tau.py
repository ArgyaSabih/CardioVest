"""Kalibrasi ambang kepercayaan tau_conf (BAB 4.4.4, Tabel target performa BAB 4.7).

    python cloud/model/kalibrasi_tau.py --data datasets/ecg_c251_250hz.npz

Aturan BAB 4.4.4: "kalibrasi tau_conf diprioritaskan memaksimalkan Sensitivity dengan Specificity
sebagai kendala minimum". Ambang DIPILIH pada set VALIDASI dan hanya DILAPORKAN pada set UJI,
sehingga angka uji tidak bias oleh proses pemilihan.

Dua tingkat analisis:

1. Tingkat window (keluaran CNN + gerbang tau). Window yang p_conf < tau "tidak diputuskan".
     Sens_Serangan_efektif = P(diterima & prediksi Serangan | Serangan)
     Sens_abnormal_efektif = P(diterima & prediksi non-Normal | non-Normal)    (memicu WARNING)
     Spesifisitas_efektif  = 1 - P(diterima & prediksi non-Normal | Normal)    (alarm palsu potensial)
   Window "tidak diputuskan" pada pasien Normal dihitung benar (tidak memicu apa pun), sedangkan
   pada pasien sakit dihitung terlewat. Inilah trade-off yang diatur tau.

2. Tingkat sistem (CNN + tau + FSM cloud.decision_engine apa adanya). Episode disusun dari
   window-window milik PASIEN dan KONDISI yang sama (tiga posisi potongan 7 s per rekaman 10 s),
   sehingga korelasi antar-window dalam satu pasien ikut terbawa:
     * Serangan + validator positif (1_GSR = 1_HR = 1) -> P(CRITICAL <= 60 s), waktu ke CRITICAL
     * Serangan, validator negatif                     -> P(WARNING <= 60 s)
     * Pra-Serangan                                    -> P(WARNING <= 60 s)
     * Normal (istirahat, validator negatif)            -> masuk WARNING palsu per jam
     * Normal + aktivitas fisik (1_GSR = 1_HR = 1)      -> CRITICAL palsu per jam
   Asumsi: urutan window dalam episode diambil acak dari kumpulan window pasien tersebut;
   window berurutan nyata lebih berkorelasi, sehingga angka per jam adalah estimasi kasar.

3. tau adaptif gerak (tau_motion). Saat IMU mendeteksi aktivitas, artefak gerak membuat model membaca ECG
   Normal sebagai Serangan. Window uji/validasi diberi artefak gerak yang SAMA dengan simulator
   (EcgStream, motion 0,6 dan 0,9), lalu diukur per tau (mode terdegradasi N = 3, seperti saat bergerak SQI PPG
   turun):
     * WARNING palsu dalam episode artefak 45 s (Normal, 1_HR = 1 karena HR semu, 1_GSR = 0)
     * CRITICAL palsu dalam episode 45 s (Normal + olahraga: 1_HR = 1_GSR = 1)
     * P(CRITICAL <= 60 s) bila serangan terjadi SAAT bergerak (biaya sensitivitas)
   tau_motion = tau terkecil (>= tau_conf) dengan WARNING palsu <= 5 % pada setiap intensitas gerak
   (BAB 6.2: false alarm akibat interferensi < 5 %), dipilih pada validasi.

Keluaran: artifacts/kalibrasi_tau.json, artifacts/kalibrasi_tau.png, artifacts/kalibrasi_tau_gerak.png
"""
from __future__ import annotations

import argparse
import json
import sys
from collections import defaultdict
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(ROOT / "cloud"))
sys.path.insert(0, str(ROOT / "common"))
sys.path.insert(0, str(HERE))

from train_real import ART, SEG, WIN, patient_split, zscore  # noqa: E402

import tensorflow as tf  # noqa: E402

from cloud.decision_engine import DecisionEngine  # noqa: E402
from heartsim_common import config as C  # noqa: E402
from heartsim_common.ecg_synth import EcgStream  # noqa: E402

HOP_S = 3.5
WIN_PER_HOUR = int(3600 / HOP_S)          # 1.028 window per jam
EP_WIN = int(60 / HOP_S)                  # 17 window = 60 s
TAUS = np.round(np.arange(0.34, 0.951, 0.02), 2)
CROPS = (0, (SEG - WIN) // 2, SEG - WIN)


# ------------------------------------------------------------------ data
def load_split(path, seed=42, cap=60):
    """Identik dengan train_real.main(): pembatasan per (pasien, kondisi) lalu split inter-patient."""
    d = np.load(path, allow_pickle=False)
    X, y, tag, pid, src = (d[k] for k in ("X", "y", "tag", "pid", "src"))
    y = y.astype(np.int64)
    if cap > 0:
        rng = np.random.default_rng(seed)
        keep = np.ones(len(y), bool)
        groups = defaultdict(list)
        for i, (p, t) in enumerate(zip(pid, tag)):
            groups[(p, t)].append(i)
        for (p, t), idx in groups.items():
            if len(idx) > cap and t not in ("vt", "vf"):
                keep[rng.choice(idx, len(idx) - cap, replace=False)] = False
        X, y, tag, pid, src = (v[keep] for v in (X, y, tag, pid, src))
    split, _ = patient_split(pid, y, tag, src, seed)
    return X, y, tag, pid, src, split


def predict_crops(model, X):
    """Probabilitas pada tiga posisi potongan 7 s -> (n, 3 potongan, 3 kelas)."""
    out = []
    for st in CROPS:
        out.append(model.predict(zscore(X[:, st:st + WIN].astype(np.float32))[..., None],
                                 batch_size=512, verbose=0))
    return np.stack(out, 1)


# ------------------------------------------------------------------ tingkat window
def window_metrics(prob, y, tau):
    pred, conf = prob.argmax(-1), prob.max(-1)
    acc = conf >= tau
    yy = np.broadcast_to(y[:, None], pred.shape)
    nrm, att, abn = yy == 0, yy == 2, yy != 0
    fp = acc & (pred != 0) & nrm
    return {
        "tau": float(tau),
        "cakupan": float(acc.mean()),
        "akurasi_diterima": float((pred[acc] == yy[acc]).mean()) if acc.any() else 0.0,
        "sens_serangan_efektif": float((acc & (pred == 2) & att).sum() / max(att.sum(), 1)),
        "sens_abnormal_efektif": float((acc & (pred != 0) & abn).sum() / max(abn.sum(), 1)),
        "spesifisitas_efektif": float(1 - fp.sum() / max(nrm.sum(), 1)),
        "serangan_dianggap_normal": float((acc & (pred == 0) & att).sum() / max(att.sum(), 1)),
    }


# ------------------------------------------------------------------ tingkat sistem
def run_episode(pred, conf, tau, ind_gsr, ind_hr, n_win, rng, degraded=False):
    """Satu episode: urutan n_win window acak dari kumpulan window (pred, conf) satu pasien."""
    eng = DecisionEngine(tau_conf=tau)
    k = rng.integers(0, len(pred), n_win)
    t_warn = t_crit = None
    warn_entries = crit_entries = 0
    for i, j in enumerate(k):
        d = eng.step(int(pred[j]), float(conf[j]), ind_gsr, ind_hr, degraded)
        if d.changed and d.state == C.STATE_WARNING:
            warn_entries += 1
            t_warn = t_warn if t_warn is not None else i
        if d.changed and d.state == C.STATE_CRITICAL:
            crit_entries += 1
            t_crit = t_crit if t_crit is not None else i
            t_warn = t_warn if t_warn is not None else i
            eng.hardware_reset()        # pada simulasi Normal: hitung tiap alarm palsu lalu reset
    return t_warn, t_crit, warn_entries, crit_entries


def groups_of(mask, pid, tag, pred, conf):
    g = defaultdict(list)
    for i in np.where(mask)[0]:
        g[(pid[i], tag[i])].append(i)
    return [(pred[idx].ravel(), conf[idx].ravel()) for idx in g.values()]


def system_metrics(prob, y, tag, pid, taus, n_rep=6, seed=0, degraded=False):
    pred, conf = prob.argmax(-1), prob.max(-1)
    g_att = groups_of(y == 2, pid, tag, pred, conf)
    g_pre = groups_of(y == 1, pid, tag, pred, conf)
    g_nrm = groups_of(y == 0, pid, tag, pred, conf)
    out = []
    for tau in taus:
        rng = np.random.default_rng(seed)
        crit, crit_t, warn_att, warn_pre = [], [], [], []
        for p, c in g_att:
            for _ in range(n_rep):
                _, tc, _, _ = run_episode(p, c, tau, True, True, EP_WIN, rng, degraded)
                crit.append(tc is not None)
                if tc is not None:
                    crit_t.append((tc + 1) * HOP_S)
                tw, _, _, _ = run_episode(p, c, tau, False, False, EP_WIN, rng, degraded)
                warn_att.append(tw is not None)
        for p, c in g_pre:
            for _ in range(n_rep):
                tw, _, _, _ = run_episode(p, c, tau, False, False, EP_WIN, rng, degraded)
                warn_pre.append(tw is not None)
        # Normal: satu jam per pasien (sampel 400 pasien agar cepat)
        sel = rng.choice(len(g_nrm), min(400, len(g_nrm)), replace=False)
        fw, fc, any_fw = [], [], []
        for s in sel:
            p, c = g_nrm[s]
            _, _, w, _ = run_episode(p, c, tau, False, False, WIN_PER_HOUR, rng, degraded)
            _, _, _, k = run_episode(p, c, tau, True, True, WIN_PER_HOUR, rng, degraded)
            fw.append(w); fc.append(k); any_fw.append(w > 0)
        out.append({
            "tau": float(tau),
            "p_critical_60s_serangan": float(np.mean(crit)),
            "median_waktu_critical_s": float(np.median(crit_t)) if crit_t else None,
            "p_warning_60s_serangan_tanpa_validator": float(np.mean(warn_att)),
            "p_warning_60s_pra_serangan": float(np.mean(warn_pre)),
            "warning_palsu_per_jam_normal": float(np.mean(fw)),
            "pasien_normal_bebas_warning_palsu_1jam": float(1 - np.mean(any_fw)),
            "critical_palsu_per_jam_normal_aktivitas": float(np.mean(fc)),
        })
    return out


def bootstrap_ci(prob, y, pid, tau, n=500, seed=0):
    """CI 95 % bootstrap per PASIEN untuk metrik window pada tau terpilih."""
    rng = np.random.default_rng(seed)
    up = np.unique(pid)
    idx_of = defaultdict(list)
    for i, p in enumerate(pid):
        idx_of[p].append(i)
    keys = ("sens_serangan_efektif", "sens_abnormal_efektif", "spesifisitas_efektif")
    vals = {k: [] for k in keys}
    for _ in range(n):
        ps = rng.choice(up, len(up), replace=True)
        ii = np.concatenate([idx_of[p] for p in ps])
        m = window_metrics(prob[ii], y[ii], tau)
        for k in keys:
            vals[k].append(m[k])
    return {k: [round(float(np.percentile(v, 2.5)), 4), round(float(np.percentile(v, 97.5)), 4)]
            for k, v in vals.items()}


def ece(prob, y, bins=10):
    conf, pred = prob.max(-1).ravel(), prob.argmax(-1).ravel()
    yy = np.broadcast_to(y[:, None], prob.shape[:2]).ravel()
    e = 0.0
    edges = np.linspace(1 / 3, 1, bins + 1)
    for a, b in zip(edges[:-1], edges[1:]):
        m = (conf >= a) & (conf < b if b < 1 else conf <= b)
        if m.any():
            e += m.mean() * abs((pred[m] == yy[m]).mean() - conf[m].mean())
    return round(float(e), 4)


# ------------------------------------------------------------------ pemilihan
def choose(win_val, sys_val, spec_min, fa_max):
    """Maksimalkan P(CRITICAL<=60 s) pada episode Serangan (lalu sens. window Serangan) dengan kendala:
    spesifisitas efektif window >= spec_min DAN WARNING palsu pada Normal <= fa_max per jam."""
    best = None
    for w, s in zip(win_val, sys_val):
        ok = w["spesifisitas_efektif"] >= spec_min and s["warning_palsu_per_jam_normal"] <= fa_max
        if not ok:
            continue
        key = (round(s["p_critical_60s_serangan"], 3), w["sens_serangan_efektif"], w["tau"])
        if best is None or key > best[0]:
            best = (key, w["tau"])
    return None if best is None else best[1]


# ------------------------------------------------------------------ tau adaptif gerak
MOTIONS = (0.6, 0.9)
EP_ART = int(45 / HOP_S)                  # 12 window = fase artefak 45 s skenario simulator


def add_artefact(X, motion, seed=0):
    """Tambahkan artefak gerak simulator (heartsim_common.ecg_synth) ke tiap rekaman 10 s (mV)."""
    rng = np.random.default_rng(seed)
    out = X.astype(np.float32).copy()
    for i in range(len(out)):
        s = EcgStream(fs=250, seed=int(rng.integers(1 << 31)), morph="normal", noise_mv=0.004, motion=motion)
        off = int(rng.integers(0, 10 ** 6))
        out[i] += s._continuous(np.arange(off, off + out.shape[1]))
    return out


def artefact_metrics(model, X, y, tag, pid, taus, seed=0, n_rep=4):
    """Per intensitas gerak dan per tau: alarm palsu pada Normal + artefak, deteksi Serangan + artefak."""
    res = {}
    for mot in MOTIONS:
        m_n, m_a = y == 0, y == 2
        pn = predict_crops(model, add_artefact(X[m_n], mot, seed))
        pa = predict_crops(model, add_artefact(X[m_a], mot, seed + 1))
        g_n = groups_of(np.ones(m_n.sum(), bool), pid[m_n], tag[m_n], pn.argmax(-1), pn.max(-1))
        g_a = groups_of(np.ones(m_a.sum(), bool), pid[m_a], tag[m_a], pa.argmax(-1), pa.max(-1))
        rows = []
        for tau in taus:
            rng = np.random.default_rng(seed)
            fw, fc, det = [], [], []
            for p, c in g_n:
                for _ in range(n_rep):
                    tw, _, _, _ = run_episode(p, c, tau, False, True, EP_ART, rng, degraded=True)
                    _, tc, _, _ = run_episode(p, c, tau, True, True, EP_ART, rng, degraded=True)
                    fw.append(tw is not None); fc.append(tc is not None)
            for p, c in g_a:
                for _ in range(n_rep):
                    _, tc, _, _ = run_episode(p, c, tau, True, True, EP_WIN, rng, degraded=True)
                    det.append(tc is not None)
            rows.append({"tau": float(tau), "warning_palsu_45s": float(np.mean(fw)),
                         "critical_palsu_45s_olahraga": float(np.mean(fc)),
                         "p_critical_60s_serangan_saat_gerak": float(np.mean(det))})
        res[f"motion_{mot}"] = {"prediksi_normal_dengan_artefak": np.bincount(pn.argmax(-1).ravel(), minlength=3)
                                .astype(float).__truediv__(pn[..., 0].size).round(4).tolist(),
                                "per_tau": rows}
        print(f"  artefak motion={mot}: distribusi prediksi Normal+artefak = "
              f"{res[f'motion_{mot}']['prediksi_normal_dengan_artefak']}", flush=True)
    return res


def choose_motion(art_val, tau_conf, fa_max=0.05):
    taus = [r["tau"] for r in next(iter(art_val.values()))["per_tau"]]
    for i, t in enumerate(taus):
        if t < tau_conf:
            continue
        if all(v["per_tau"][i]["warning_palsu_45s"] <= fa_max for v in art_val.values()):
            return t
    return None


def plot_motion(art_val, art_te, tau_conf, tau_motion, path):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    fig, ax = plt.subplots(1, 2, figsize=(12, 4.2))
    styles = {0.6: "-", 0.9: "--"}
    for a, (key, title) in zip(ax, (("warning_palsu_45s", "WARNING palsu (Normal + artefak gerak, 45 s)"),
                                    ("p_critical_60s_serangan_saat_gerak", "P(CRITICAL ≤ 60 s) serangan saat bergerak"))):
        for mot in MOTIONS:
            for data, lab, alpha in ((art_val, "val", 1.0), (art_te, "uji", 0.45)):
                rows = data[f"motion_{mot}"]["per_tau"]
                a.plot([r["tau"] for r in rows], [r[key] for r in rows], styles[mot], alpha=alpha,
                       c="#2471a3" if key.startswith("warning") else "#c0392b",
                       label=f"gerak {mot} ({lab})")
        a.axvline(tau_conf, c="k", lw=.8, ls=":")
        a.axvline(tau_motion, c="k", lw=1.2)
        a.text(tau_conf, 0.97, f" τ_conf {tau_conf:.2f}", fontsize=7.5, va="top")
        a.text(tau_motion, 0.90, f" τ_gerak {tau_motion:.2f}", fontsize=8, va="top")
        if key.startswith("warning"):
            a.axhline(0.05, c="#2471a3", lw=.8, ls="-.")
            a.text(0.45, 0.06, "target < 5 % (BAB 6.2)", fontsize=7, color="#2471a3")
        a.set_title(title, fontsize=10); a.set_xlabel("τ saat gerak"); a.set_ylim(0, 1.0); a.grid(alpha=.3)
        a.legend(fontsize=7.5, loc="upper right" if key.startswith("warning") else "lower left")
    fig.tight_layout()
    fig.savefig(path, dpi=130)


def plot(win_val, sys_val, win_te, tau_sel, tau_old, spec_min, path):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    t = [w["tau"] for w in win_val]
    fig, ax = plt.subplots(1, 2, figsize=(12, 4.4))
    a = ax[0]
    a.plot(t, [w["sens_serangan_efektif"] for w in win_val], "-", c="#c0392b", label="Sens. Serangan efektif (val)")
    a.plot(t, [w["sens_abnormal_efektif"] for w in win_val], "-", c="#e67e22", label="Sens. abnormal efektif (val)")
    a.plot(t, [w["spesifisitas_efektif"] for w in win_val], "-", c="#2471a3", label="Spesifisitas efektif (val)")
    a.plot(t, [w["cakupan"] for w in win_val], ":", c="#7f8c8d", label="Cakupan (val)")
    a.plot(t, [w["sens_serangan_efektif"] for w in win_te], "--", c="#c0392b", alpha=.5, label="Sens. Serangan (uji)")
    a.plot(t, [w["spesifisitas_efektif"] for w in win_te], "--", c="#2471a3", alpha=.5, label="Spesifisitas (uji)")
    a.axhline(spec_min, c="#2471a3", lw=.8, ls="-.")
    a.set_title("Tingkat window (CNN + gerbang τ_conf)")
    a.set_xlabel("τ_conf"); a.set_ylim(0, 1.02); a.grid(alpha=.3)
    a = ax[1]
    a.plot(t, [s["p_critical_60s_serangan"] for s in sys_val], "-", c="#c0392b", label="P(CRITICAL ≤ 60 s) | Serangan")
    a.plot(t, [s["p_warning_60s_pra_serangan"] for s in sys_val], "-", c="#e67e22", label="P(WARNING ≤ 60 s) | Pra-Serangan")
    a.plot(t, [s["pasien_normal_bebas_warning_palsu_1jam"] for s in sys_val], "-", c="#2471a3",
           label="Pasien Normal tanpa WARNING palsu / jam")
    a2 = a.twinx()
    a2.plot(t, [s["warning_palsu_per_jam_normal"] for s in sys_val], ":", c="#2471a3", label="WARNING palsu / jam (kanan)")
    a2.set_ylabel("WARNING palsu per jam"); a2.set_yscale("symlog", linthresh=0.1)
    a.set_title("Tingkat sistem (CNN + τ + FSM, validasi)")
    a.set_xlabel("τ_conf"); a.set_ylim(0, 1.02); a.grid(alpha=.3)
    h1, l1 = a.get_legend_handles_labels(); h2, l2 = a2.get_legend_handles_labels()
    a.legend(h1 + h2, l1 + l2, fontsize=7.5, loc="lower left")
    for x in ax:
        x.axvline(tau_sel, c="k", lw=1.2)
        x.axvline(tau_old, c="k", lw=.8, ls="--")
        x.text(tau_sel, 1.0, f" τ={tau_sel:.2f}", fontsize=8, va="top")
        x.text(tau_old, 0.04, f" lama {tau_old:.2f}", fontsize=7, va="bottom")
    ax[0].legend(fontsize=7.5, loc="lower left")
    fig.tight_layout()
    fig.savefig(path, dpi=130)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", type=Path, required=True)
    ap.add_argument("--model", type=Path, default=ART / "cnn1d_ecg.keras")
    ap.add_argument("--spec-min", type=float, default=0.80, help="kendala spesifisitas (BAB 4.7: >= 80 %%)")
    ap.add_argument("--fa-max", type=float, default=1.0, help="maks. WARNING palsu per jam pada Normal")
    ap.add_argument("--tau-old", type=float, default=0.75)
    ap.add_argument("--fa-motion", type=float, default=0.05,
                    help="maks. P(WARNING palsu) per episode artefak gerak (BAB 6.2: < 5 %%)")
    a = ap.parse_args()

    X, y, tag, pid, src, split = load_split(a.data)
    model = tf.keras.models.load_model(a.model, compile=False)
    res = {"aturan": ("maksimalkan P(CRITICAL<=60 s | Serangan) lalu sensitivitas Serangan efektif, "
                      f"dengan kendala spesifisitas efektif >= {a.spec_min} dan WARNING palsu <= {a.fa_max}/jam; "
                      "dipilih pada VALIDASI, dilaporkan pada UJI"),
           "fsm": {"N": C.PERSIST_N, "N_degraded": C.PERSIST_N_DEGRADED, "M": C.HYSTERESIS_M,
                   "hop_s": HOP_S, "episode_s": EP_WIN * HOP_S}}
    cache = {}
    for sp in ("val", "test"):
        m = split == sp
        prob = predict_crops(model, X[m])
        cache[sp] = (prob, y[m], tag[m], pid[m])
        print(f"{sp}: {m.sum()} window x 3 potongan, ECE={ece(prob, y[m])}", flush=True)

    win = {sp: [window_metrics(cache[sp][0], cache[sp][1], t) for t in TAUS] for sp in cache}
    sys_val = system_metrics(*cache["val"], TAUS)
    tau_sel = choose(win["val"], sys_val, a.spec_min, a.fa_max)
    if tau_sel is None:
        raise SystemExit("tidak ada tau yang memenuhi kendala; longgarkan --spec-min/--fa-max")
    print("tau terpilih (validasi):", tau_sel, flush=True)

    report_taus = sorted({0.0, 0.5, 0.6, tau_sel, a.tau_old, 0.85})
    sys_te = system_metrics(*cache["test"], report_taus, n_rep=10, seed=1)
    sys_te_deg = system_metrics(*cache["test"], [tau_sel], n_rep=10, seed=2, degraded=True)
    win_te_rep = [window_metrics(cache["test"][0], cache["test"][1], t) for t in report_taus]
    res.update({
        "tau_terpilih": tau_sel,
        "ece": {sp: ece(cache[sp][0], cache[sp][1]) for sp in cache},
        "validasi": {"window": win["val"], "sistem": sys_val},
        "uji": {"window": win_te_rep, "sistem": sys_te,
                "sistem_terdegradasi_N3": sys_te_deg,
                "ci95_bootstrap_pasien": bootstrap_ci(cache["test"][0], cache["test"][1], cache["test"][3], tau_sel)},
    })

    # ---- tahap 3: tau adaptif gerak
    print("analisis artefak gerak (validasi)...", flush=True)
    taus_m = [t for t in TAUS if t >= tau_sel]
    art_val = artefact_metrics(model, X[split == "val"], y[split == "val"], tag[split == "val"],
                               pid[split == "val"], taus_m, seed=0)
    tau_motion = choose_motion(art_val, tau_sel, a.fa_motion)
    if tau_motion is None:
        tau_motion = max(taus_m)
    print("tau_gerak terpilih (validasi):", tau_motion, flush=True)
    print("analisis artefak gerak (uji)...", flush=True)
    art_te = artefact_metrics(model, X[split == "test"], y[split == "test"], tag[split == "test"],
                              pid[split == "test"], taus_m, seed=10)
    res["tau_gerak"] = {"aturan": f"tau terkecil >= tau_conf dengan WARNING palsu <= {a.fa_motion} per episode "
                                  "artefak 45 s pada setiap intensitas gerak; dipilih pada validasi",
                        "tau_gerak_terpilih": tau_motion, "validasi": art_val, "uji": art_te}
    plot_motion(art_val, art_te, tau_sel, tau_motion, ART / "kalibrasi_tau_gerak.png")
    for mot in MOTIONS:
        for r in art_te[f"motion_{mot}"]["per_tau"]:
            if r["tau"] in (tau_sel, tau_motion):
                print(f"  UJI gerak {mot} tau={r['tau']}: " + "  ".join(f"{k}={v:.3f}" for k, v in r.items() if k != "tau"))

    def r4(o):
        if isinstance(o, float):
            return round(o, 4)
        if isinstance(o, dict):
            return {k: r4(v) for k, v in o.items()}
        if isinstance(o, list):
            return [r4(v) for v in o]
        return o
    (ART / "kalibrasi_tau.json").write_text(json.dumps(r4(res), indent=2, ensure_ascii=False))
    plot(win["val"], sys_val, win["test"], tau_sel, a.tau_old, a.spec_min, ART / "kalibrasi_tau.png")

    print("\nUJI (window):")
    for w in win_te_rep:
        print("  " + "  ".join(f"{k}={v:.3f}" for k, v in w.items()))
    print("UJI (sistem):")
    for s in sys_te:
        print("  " + "  ".join(f"{k}={v:.3f}" if isinstance(v, float) else f"{k}={v}" for k, v in s.items()))
    print("CI95:", res["uji"]["ci95_bootstrap_pasien"])


if __name__ == "__main__":
    main()
