"""Kalibrasi tau / N dari data alat CardioVest sendiri (dijalankan setelah uji pakai).

    # di VM: salinan database yang konsisten (termasuk isi WAL), lalu unduh dengan scp ke data/export/
    cd /opt/cardiovest && docker compose -f deploy/docker-compose.yml exec cloud python -c "import sqlite3; sqlite3.connect('/data/cardiovest.db').execute(\"VACUUM INTO '/data/export/cardiovest.db'\")"
    python tools/kalibrasi_lapangan.py --db data/export/cardiovest.db --dari "2026-11-02 08:00" --sampai "2026-11-02 14:00"

Pakai rentang waktu ketika pemakai SEHAT (tidak ada kejadian jantung): setiap WARNING/CRITICAL di
rentang itu adalah alarm palsu. Skrip memutar ulang semua window yang tersimpan di tabel inferences
(kelas, keyakinan, validator GSR/HR, status gerak, hasil gerbang kualitas) melalui DecisionEngine
dengan kombinasi tau, N, dan PERSIST_N_PRE yang berbeda, lalu membandingkan alarm palsu per jam
dengan sensitivitas dari docs/uji_sensitivitas.json (data klinis, bukan dari alat ini).

Tidak perlu TensorFlow; cukup Python + numpy.
"""
from __future__ import annotations

import argparse
import json
import sqlite3
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT / "common"), str(ROOT / "cloud")]
from cloud.decision_engine import DecisionEngine  # noqa: E402
from heartsim_common import config as C  # noqa: E402

CLS = {name: i for i, name in enumerate(C.CLASSES)}


def ms(text: str | None) -> int | None:
    return None if not text else int(datetime.fromisoformat(text).timestamp() * 1000)


def load(db: str, device: str, t_from: int | None, t_to: int | None) -> list[dict]:
    con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    cols = {r[1] for r in con.execute("PRAGMA table_info(inferences)")}
    has_q = "signal_ok" in cols
    q = ("SELECT window_t0, cls, p_conf, validators, " + ("signal_ok" if has_q else "1") +
         " FROM inferences WHERE device_id=? AND late=0")
    args: list = [device]
    if t_from:
        q += " AND window_t0>=?"
        args.append(t_from)
    if t_to:
        q += " AND window_t0<?"
        args.append(t_to)
    rows = []
    for t0, cls, conf, vals, ok in con.execute(q + " ORDER BY window_t0", args):
        v = json.loads(vals) if vals and vals != "null" else {}
        rows.append({"t0": t0, "cls": CLS.get(cls, 0), "conf": conf or 0.0, "ok": bool(ok),
                     "gsr": bool(v.get("ind_gsr")), "hr": bool(v.get("ind_hr")),
                     "degraded": bool(v.get("degraded")), "motion": bool(v.get("motion"))})
    return rows


def replay(rows, tau, n, n_pre):
    e = DecisionEngine(tau_conf=tau, n=n, n_pre=n_pre)
    warn = crit = 0
    for r in rows:
        if not r["ok"]:
            continue
        d = e.step(r["cls"], r["conf"], r["gsr"], r["hr"], r["degraded"], r["motion"])
        if d.changed and d.state == C.STATE_WARNING:
            warn += 1
        if d.changed and d.state == C.STATE_CRITICAL:
            crit += 1
            e.hardware_reset()
    return warn, crit


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", required=True)
    ap.add_argument("--device", default=C.DEVICE_ID)
    ap.add_argument("--dari", help="awal rentang sehat, mis. '2026-11-02 08:00' (waktu lokal)")
    ap.add_argument("--sampai")
    a = ap.parse_args()
    rows = load(a.db, a.device, ms(a.dari), ms(a.sampai))
    if len(rows) < 20:
        sys.exit(f"hanya {len(rows)} window di rentang itu; rekam minimal beberapa jam")
    # jam efektif = jumlah window x hop (celah ketika alat mati tidak ikut dihitung)
    hours = len(rows) * C.HOP_SECONDS / 3600
    n_bad = sum(not r["ok"] for r in rows)
    n_mot = sum(r["motion"] for r in rows)
    print(f"{a.device}: {len(rows)} window = {hours:.1f} jam efektif; ditahan gerbang kualitas "
          f"{n_bad / len(rows):.1%}; bergerak {n_mot / len(rows):.0%}")
    for name, i in CLS.items():
        k = [r for r in rows if r["cls"] == i]
        print(f"  {name:<14} {len(k) / len(rows):6.1%} window"
              + (f", keyakinan median {sorted(r['conf'] for r in k)[len(k) // 2]:.2f}" if k else ""))

    sens_path = ROOT / "docs" / "uji_sensitivitas.json"
    sens = json.loads(sens_path.read_text())["bank"] if sens_path.exists() else {}

    def stemi_at(tau):
        row = sens.get("stemi", {})
        keys = sorted(row, key=lambda k: abs(float(k) - tau) if k != "n" else 9)
        return row.get(keys[0]) if keys and keys[0] != "n" else None

    print(f"\n{'tau':>5}{'N':>3}{'N_pra':>6}{'WARNING/jam':>13}{'CRITICAL/jam':>14}{'STEMI/window*':>15}")
    best = []
    for tau in (C.TAU_CONF, 0.5, 0.6, 0.7):
        for n in (2, 3):
            for n_pre in (0, 4, 6):
                w, c = replay(rows, tau, n, n_pre)
                s = stemi_at(tau)
                best.append((w / hours, -(s or 0), tau, n, n_pre))
                print(f"{tau:>5.2f}{n:>3}{(n_pre or n):>6}{w / hours:>13.2f}{c / hours:>14.2f}"
                      f"{(f'{s:.2f}' if s is not None else '-'):>15}")
    print("* peluang satu window STEMI (PTB-XL set uji) terbaca non-Normal pada tau tsb; makin kecil, makin"
          "\n  lambat/jarang serangan terdeteksi. VT/VF tidak terpengaruh tau sampai 0,8 (docs/uji_sensitivitas.json).")
    ok = [b for b in best if b[0] <= 0.25]
    if ok:
        w, s, tau, n, n_pre = sorted(ok, key=lambda b: (b[1], b[0]))[0]
        print(f"\nKandidat: TAU_CONF={tau:.2f} PERSIST_N={n} PERSIST_N_PRE={n_pre} "
              f"(<= 1 alarm palsu per 4 jam dengan sensitivitas STEMI tertinggi di tabel)")
    else:
        print("\nTidak ada kombinasi dengan alarm palsu <= 1 per 4 jam: masalahnya ada di model, bukan "
              "setelan FSM.\nKumpulkan rekaman alat ini untuk fine-tuning (lihat docs/analisis_alarm_palsu.md).")


if __name__ == "__main__":
    main()
