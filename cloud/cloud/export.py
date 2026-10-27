"""Ekspor data dummy dari SQLite ke CSV.

    python -m cloud.export --db data/cardiovest.db --out data/export

Menghasilkan:
  vitals.csv, inferences.csv, transitions.csv, events.csv, notifications.csv, device_status.csv,
  ecg_samples.csv (t_ms, nilai count, nilai mV; seluruh sampel berurutan, dapat dibatasi --ecg-minutes),
  ringkasan.txt (statistik singkat, termasuk laju data per topik)
"""
from __future__ import annotations

import argparse
import csv
import time
from pathlib import Path

from heartsim_common.config import ECG_COUNTS_PER_MV

from .storage import Repository

TABLES = {
    "vitals": "SELECT * FROM vitals ORDER BY ts",
    "inferences": "SELECT * FROM inferences ORDER BY ts",
    "transitions": "SELECT * FROM transitions ORDER BY ts",
    "events": "SELECT * FROM events ORDER BY start_ts",
    "notifications": "SELECT * FROM notifications ORDER BY ts",
    "device_status": "SELECT * FROM device_status ORDER BY ts",
}
TS_COLS = {"ts", "t0", "start_ts", "end_ts", "window_t0", "received_ts"}


def iso(ms) -> str:
    if ms is None:
        return ""
    return time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(ms / 1000)) + f".{int(ms) % 1000:03d}"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default="data/cardiovest.db")
    ap.add_argument("--out", default="data/export")
    ap.add_argument("--ecg-minutes", type=float, default=30, help="batas durasi ECG terakhir yang diekspor")
    a = ap.parse_args()
    repo = Repository(a.db)
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)

    for name, sql in TABLES.items():
        cols, rows = repo.query(sql)
        ts_idx = [i for i, c in enumerate(cols) if c in TS_COLS]
        with open(out / f"{name}.csv", "w", newline="", encoding="utf-8") as f:
            w = csv.writer(f)
            w.writerow(cols + [f"{cols[i]}_waktu" for i in ts_idx])
            for r in rows:
                w.writerow(list(r) + [iso(r[i]) for i in ts_idx])
        print(f"{name:<14} {len(rows):>7} baris -> {out / (name + '.csv')}")

    _, last = repo.query("SELECT device_id, MAX(t0) FROM ecg_packets GROUP BY device_id")
    n_ecg = 0
    with open(out / "ecg_samples.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["device_id", "t_ms", "waktu", "count", "mV"])
        for dev, tmax in last:
            if tmax is None:
                continue
            ts, xs = repo.ecg_range(dev, int(tmax - a.ecg_minutes * 60_000), int(tmax))
            for t, x in zip(ts, xs):
                w.writerow([dev, int(t), iso(t), int(x), round(int(x) / ECG_COUNTS_PER_MV, 4)])
            n_ecg += len(xs)
    print(f"{'ecg_samples':<14} {n_ecg:>7} sampel -> {out / 'ecg_samples.csv'}")

    lines = []
    _, r = repo.query("SELECT MIN(t0), MAX(t0), COUNT(*), SUM(payload_bytes), payload_format FROM ecg_packets"
                      " GROUP BY payload_format")
    for tmin, tmax, n, b, fmt in r:
        dur = max((tmax - tmin) / 1000 + 3.5, 1)
        lines.append(f"ECG ({fmt}): {n} paket, {b} byte, ~{b / dur:.0f} B/s payload "
                     f"(~{b / dur * 86400 * 30 / 1e6:.0f} MB/bulan kontinu, belum termasuk overhead TCP/TLS/MQTT)")
    _, r = repo.query("SELECT cls, COUNT(*), AVG(p_conf), AVG(infer_ms), AVG(process_latency_ms) FROM inferences"
                      " WHERE late=0 GROUP BY cls")
    for cls, n, pc, im, pl in r:
        lines.append(f"Inferensi {cls:<12}: {n} window, p_conf rata-rata {pc:.3f}, "
                     f"inferensi {im:.1f} ms, latensi proses {pl or 0:.0f} ms")
    _, r = repo.query("SELECT from_state, to_state, COUNT(*) FROM transitions GROUP BY 1,2")
    for a_, b_, n in r:
        lines.append(f"Transisi {a_} -> {b_}: {n}x")
    (out / "ringkasan.txt").write_text("\n".join(lines), encoding="utf-8")
    print("\n".join(lines))


if __name__ == "__main__":
    main()
