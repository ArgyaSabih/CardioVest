"""Praproses PTB-XL + MIT-BIH menjadi satu berkas dataset window 10 s @ 250 Hz, Lead I / MLII.

    python cloud/model/datasets/prepare.py \
        --ptbxl  datasets/ptb-xl-a-large-publicly-available-electrocardiography-dataset-1.0.3.zip \
        --mitdb  datasets/mit-bih-arrhythmia-database-1.0.0.zip \
        --out    datasets/ecg_c251_250hz.npz

Argumen --ptbxl / --mitdb boleh berupa berkas zip PhysioNet atau folder hasil ekstraksi.

Langkah (BAB 10.4 'Setup eksperimen'):
  * PTB-XL: records100 (100 Hz, 10 s) lead I -> resample ke 250 Hz (2.500 sampel).
    Versi 100 Hz dipilih karena pita sinyal perangkat hanya 0,5-40 Hz (AD8232 + filter digital),
    sehingga informasi di atas 50 Hz tidak dibutuhkan dan ukuran unduhan jauh lebih kecil.
  * MIT-BIH: kanal MLII 360 Hz -> 250 Hz, dipotong window 10 s dengan stride 5 s.
    Rekaman ber-pacemaker (102, 104, 107, 217) dikecualikan.
  * Band-pass Butterworth 0,5-40 Hz (zero-phase), satuan tetap mV.
  * Label tiga kelas + tag morfologi: lihat labels.py.

Keluaran .npz: X float16 [N, 2500] (mV), y int8, tag, pid (id pasien untuk split inter-patient),
src, rec, hr (bpm per window), fold (strat_fold PTB-XL; -1 untuk MIT-BIH).
Pelatihan memotong window 7 s (1.750 sampel) secara acak dari window 10 s (augmentasi geser waktu).
"""
from __future__ import annotations

import argparse
import sys
import time
import zipfile
from collections import Counter
from pathlib import Path

import numpy as np
import pandas as pd
import wfdb
from scipy.signal import butter, find_peaks, resample_poly, sosfiltfilt

sys.path.insert(0, str(Path(__file__).resolve().parent))
from labels import CLASS_NAMES, MIT_PACED, MIT_SAME_SUBJECT, mitdb_window_label, ptbxl_label  # noqa: E402

FS = 250
SEG = 2500                     # 10 s
SOS = butter(2, [0.5, 40], btype="bandpass", fs=FS, output="sos")


def bandpass(x: np.ndarray) -> np.ndarray:
    return sosfiltfilt(SOS, x).astype(np.float32)


def estimate_hr(x: np.ndarray, fs: int = FS) -> float:
    """Estimasi HR kasar (Pan-Tompkins ringkas) untuk metadata bank replay."""
    d = np.diff(x) ** 2
    w = np.convolve(d, np.ones(int(0.15 * fs)) / (0.15 * fs), mode="same")
    if w.max() <= 0:
        return float("nan")
    pk, _ = find_peaks(w, height=0.3 * np.percentile(w, 99), distance=int(0.25 * fs))
    if len(pk) < 3:
        return float("nan")
    return float(np.clip(60 * fs / np.median(np.diff(pk)), 20, 320))


# ------------------------------------------------------------------ akses zip / folder
def materialize(src: Path, work: Path, needed) -> Path:
    """Ekstrak hanya anggota zip yang dibutuhkan; kembalikan folder akar dataset."""
    if src.is_dir():
        return src
    work.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(src) as z:
        names = z.namelist()
        todo = [n for n in names if needed(n) and not (work / n).exists()]
        print(f"  ekstrak {len(todo)} berkas dari {src.name} ke {work} ...", flush=True)
        for i, n in enumerate(todo):
            z.extract(n, work)
            if i and i % 5000 == 0:
                print(f"    {i}/{len(todo)}", flush=True)
        roots = {n.split("/")[0] for n in names if "/" in n}
    return work / sorted(roots)[0] if len(roots) == 1 else work


# ------------------------------------------------------------------ PTB-XL
PTBXL_LEADS = ["I", "II", "III", "AVR", "AVL", "AVF", "V1", "V2", "V3", "V4", "V5", "V6"]


def load_ptbxl(src: Path, work: Path, limit: int | None = None, start: int = 0, lead: str = "I"):
    root = materialize(src, work / "ptbxl",
                       lambda n: n.endswith(".csv") or "/records100/" in n or n.startswith("records100/"))
    if not (root / "ptbxl_database.csv").exists():
        cands = list(root.rglob("ptbxl_database.csv"))
        if not cands:
            raise FileNotFoundError("ptbxl_database.csv tidak ditemukan")
        root = cands[0].parent
    db = pd.read_csv(root / "ptbxl_database.csv", index_col="ecg_id")
    st = pd.read_csv(root / "scp_statements.csv", index_col=0)
    diag_class = st[st.diagnostic == 1].diagnostic_class.dropna().to_dict()
    X, rows = [], []
    t0, skipped = time.time(), Counter()
    items = list(db.iterrows())
    items = items[start:start + limit] if limit else items[start:]
    for i, (ecg_id, r) in enumerate(items):
        lab = ptbxl_label(r.scp_codes, diag_class)
        if lab is None:
            skipped["tidak berlabel/dikecualikan"] += 1
            continue
        try:
            sig, meta = wfdb.rdsamp(str(root / r.filename_lr), channels=[PTBXL_LEADS.index(lead.upper())])
        except Exception:  # noqa: BLE001
            skipped["gagal dibaca"] += 1
            continue
        x = sig[:, 0].astype(np.float64)
        if not np.isfinite(x).all() or np.ptp(x) < 0.05:
            skipped["sinyal datar/NaN"] += 1
            continue
        x = bandpass(resample_poly(x, 5, 2))[:SEG]           # 100 Hz -> 250 Hz
        if x.size < SEG:
            skipped["terlalu pendek"] += 1
            continue
        X.append(x.astype(np.float16))
        rows.append((lab[0], lab[1], f"ptbxl:{int(r.patient_id)}", "ptbxl", f"ptbxl/{ecg_id}",
                     estimate_hr(x), int(r.strat_fold)))
        if i % 2000 == 0:
            print(f"  PTB-XL {start + i}/{start + len(items)} ({time.time() - t0:.0f} s)", flush=True)
    print(f"  PTB-XL selesai: {len(X)} rekaman dipakai; dilewati: {dict(skipped)}", flush=True)
    return X, rows


# ------------------------------------------------------------------ MIT-BIH
def rhythm_track(ann, n: int, ratio: float) -> np.ndarray:
    """Array label ritme per sampel (250 Hz) dari aux_note '(XXX'."""
    track = np.full(n, "", dtype=object)
    cur, start = "(N", 0
    for s, a in zip(ann.sample, ann.aux_note):
        a = (a or "").strip("\x00").strip()
        if a.startswith("("):
            p = int(s * ratio)
            track[start:p] = cur
            cur, start = a, p
    track[start:] = cur
    return track


def load_mitdb(src: Path, work: Path, stride_s: float = 5.0):
    root = materialize(src, work / "mitdb", lambda n: n.endswith((".hea", ".dat", ".atr")))
    heas = sorted(root.rglob("*.hea"))
    recs = sorted({h.stem for h in heas if h.stem.isdigit()})
    base = heas[0].parent
    X, rows, stats = [], [], Counter()
    for rec in recs:
        if rec in MIT_PACED:
            continue
        sig, meta = wfdb.rdsamp(str(base / rec))
        names = meta["sig_name"]
        ch = names.index("MLII") if "MLII" in names else 0
        x = bandpass(resample_poly(sig[:, ch].astype(np.float64), 25, 36))   # 360 -> 250 Hz
        ann = wfdb.rdann(str(base / rec), "atr")
        ratio = FS / meta["fs"]
        track = rhythm_track(ann, x.size, ratio)
        bs = (ann.sample * ratio).astype(int)
        sym = np.asarray(ann.symbol)
        pid = f"mitdb:{MIT_SAME_SUBJECT.get(rec, rec)}"
        step = int(stride_s * FS)
        rare_step = int(1.0 * FS)   # VT/VF sangat jarang: window diambil tiap 1 s (tumpang tindih)
        for a in range(0, x.size - SEG, rare_step):
            regular = a % step == 0
            b = a + SEG
            m = (bs >= a) & (bs < b)
            w_sym = list(sym[m])
            if any(s in ("~", "|", "Q") for s in w_sym):
                stats["noise/artefak"] += regular
                continue
            cover = Counter(track[a:b])
            cover = {k: v / SEG for k, v in cover.items()}
            beats = [s for s in w_sym if s.isalpha() or s in ("!", "/")]
            lab = mitdb_window_label(cover, beats)
            if lab is None or (not regular and lab[1] not in ("vt", "vf")):
                if lab is None and regular:
                    stats["tidak berlabel"] += 1
                continue
            rpk = bs[m & np.isin(sym, list("NLRBAaJSVrFejnE/f!"))]
            hr = float(60 * FS / np.median(np.diff(rpk))) if len(rpk) >= 3 else estimate_hr(x[a:b])
            if lab[1] == "vf":
                hr = estimate_hr(x[a:b])
            X.append(x[a:b].astype(np.float16))
            rows.append((lab[0], lab[1], pid, "mitdb", f"mitdb/{rec}@{a / FS:.0f}s", hr, -1))
        print(f"  MIT-BIH {rec}: total window {len(X)}", flush=True)
    print(f"  MIT-BIH selesai: {len(X)} window; dilewati: {dict(stats)}", flush=True)
    return X, rows


def save(out: Path, X, rows) -> None:
    cols = list(zip(*rows))
    out.parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(
        out, X=np.stack(X), y=np.asarray(cols[0], np.int8), tag=np.asarray(cols[1]), pid=np.asarray(cols[2]),
        src=np.asarray(cols[3]), rec=np.asarray(cols[4]), hr=np.asarray(cols[5], np.float32),
        fold=np.asarray(cols[6], np.int8), fs=FS)


def merge(parts: list[Path], out: Path) -> None:
    ds = [np.load(p, allow_pickle=False) for p in parts]
    keys = ("X", "y", "tag", "pid", "src", "rec", "hr", "fold")
    np.savez_compressed(out, **{k: np.concatenate([d[k] for d in ds]) for k in keys}, fs=FS)
    d = np.load(out)
    y, src, tag = d["y"], d["src"], d["tag"]
    for s_ in ("ptbxl", "mitdb"):
        m = src == s_
        cnt = Counter(zip(y[m].tolist(), tag[m].tolist()))
        print(f"  {s_}: " + ", ".join(f"{CLASS_NAMES[c]}/{t_}={n}" for (c, t_), n in sorted(cnt.items())))
    print(f"gabungan: {d['X'].shape} -> {out}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--ptbxl", type=Path)
    ap.add_argument("--mitdb", type=Path)
    ap.add_argument("--out", type=Path, default=Path("datasets/ecg_c251_250hz.npz"))
    ap.add_argument("--lead", default="I", choices=["I", "II"],
                    help="lead PTB-XL yang diambil (alat memakai Lead I; II untuk perbandingan penempatan "
                         "elektroda). MIT-BIH selalu MLII")
    ap.add_argument("--work", type=Path, default=None, help="folder ekstraksi (default: di samping --out)")
    ap.add_argument("--part", choices=["all", "ptbxl", "mitdb"], default="all",
                    help="proses sebagian saja (untuk dijalankan bertahap)")
    ap.add_argument("--start", type=int, default=0, help="indeks rekaman PTB-XL awal (mode bertahap)")
    ap.add_argument("--limit-ptbxl", type=int, default=None, help="jumlah rekaman PTB-XL yang diproses")
    ap.add_argument("--merge", type=Path, nargs="+", help="gabungkan beberapa berkas bagian menjadi --out")
    a = ap.parse_args()
    if a.merge:
        merge(a.merge, a.out)
        return
    work = a.work or a.out.parent / "_extract"
    t = time.time()
    X, rows = [], []
    if a.part in ("all", "ptbxl"):
        print("[PTB-XL]", flush=True)
        x1, r1 = load_ptbxl(a.ptbxl, work, a.limit_ptbxl, a.start, a.lead)
        X += x1; rows += r1
    if a.part in ("all", "mitdb"):
        print("[MIT-BIH]", flush=True)
        x2, r2 = load_mitdb(a.mitdb, work)
        X += x2; rows += r2
    save(a.out, X, rows)
    print(f"selesai: {len(X)} window -> {a.out} dalam {time.time() - t:.0f} s")


if __name__ == "__main__":
    main()
