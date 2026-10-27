"""Lapisan penyimpanan (repository) berbasis SQLite.

Dipakai sebagai pengganti sementara InfluxDB (deret waktu) + PostgreSQL (relasional) pada
rancangan BAB 5.6. Seluruh akses melalui kelas Repository, sehingga penggantian ke
InfluxDB/PostgreSQL cukup dengan membuat implementasi baru berantarmuka sama.

Tabel:
  vitals          : data 1 Hz (HR, sumber HR, SQI, GSR, akselerasi, jatuh, GPS)
  ecg_packets     : segmen ECG 875 sampel (BLOB int16 little-endian)
  inferences      : hasil CNN per window + snapshot validator + keputusan FSM
  transitions     : log transisi state (audit trail)
  events          : episode WARNING / CRITICAL (awal, akhir, puncak, jatuh, lokasi)
  notifications   : log dispatch notifikasi (mock FCM)
  device_status   : online/offline (LWT)
"""
from __future__ import annotations

import json
import sqlite3
import threading
from pathlib import Path

import numpy as np

SCHEMA = """
CREATE TABLE IF NOT EXISTS vitals (
  id INTEGER PRIMARY KEY, device_id TEXT, ts INTEGER, hr REAL, hr_source TEXT, hr_ppg REAL,
  hr_ecg REAL, sqi REAL, gsr REAL, ax REAL, ay REAL, az REAL, amag REAL, fall_detected INTEGER,
  gps_fix INTEGER, lat REAL, lon REAL, gps_accuracy_m REAL, local_state TEXT, buffered INTEGER);
CREATE INDEX IF NOT EXISTS ix_vitals_ts ON vitals(device_id, ts);
CREATE TABLE IF NOT EXISTS ecg_packets (
  id INTEGER PRIMARY KEY, device_id TEXT, seq INTEGER, t0 INTEGER, fs INTEGER, n INTEGER,
  samples BLOB, payload_format TEXT, payload_bytes INTEGER, buffered INTEGER, received_ts INTEGER);
CREATE INDEX IF NOT EXISTS ix_ecg_t0 ON ecg_packets(device_id, t0);
CREATE TABLE IF NOT EXISTS inferences (
  id INTEGER PRIMARY KEY, device_id TEXT, ts INTEGER, window_t0 INTEGER, seq INTEGER,
  cls TEXT, p_conf REAL, p_normal REAL, p_pre REAL, p_attack REAL, infer_ms REAL,
  process_latency_ms REAL, late INTEGER, accepted INTEGER, state TEXT, reason TEXT,
  validators TEXT);
CREATE INDEX IF NOT EXISTS ix_inf_ts ON inferences(device_id, ts);
CREATE TABLE IF NOT EXISTS transitions (
  id INTEGER PRIMARY KEY, device_id TEXT, ts INTEGER, from_state TEXT, to_state TEXT, reason TEXT);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY, device_id TEXT, type TEXT, start_ts INTEGER, end_ts INTEGER,
  peak_conf REAL, fall_detected INTEGER, lat REAL, lon REAL, reason TEXT);
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY, device_id TEXT, ts INTEGER, event_type TEXT, recipients TEXT,
  payload TEXT, status TEXT, attempts INTEGER);
CREATE TABLE IF NOT EXISTS device_status (
  id INTEGER PRIMARY KEY, device_id TEXT, ts INTEGER, status TEXT, reason TEXT);
"""


class Repository:
    def __init__(self, path: str | Path):
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        self.path = str(path)
        self._db = sqlite3.connect(self.path, check_same_thread=False, isolation_level=None)
        self._db.execute("PRAGMA journal_mode=WAL")
        self._db.executescript(SCHEMA)
        self._lock = threading.Lock()
        self._migrate()

    def _migrate(self) -> None:
        """Tambah kolom baru pada database lama tanpa menghapus data."""
        cols = {r[1] for r in self._db.execute("PRAGMA table_info(inferences)")}
        for name, typ in (("signal_ok", "INTEGER"), ("quality", "TEXT"), ("clock_unsynced", "INTEGER")):
            if name not in cols:
                self._db.execute(f"ALTER TABLE inferences ADD COLUMN {name} {typ}")
        cols = {r[1] for r in self._db.execute("PRAGMA table_info(events)")}
        if "end_reason" not in cols:
            self._db.execute("ALTER TABLE events ADD COLUMN end_reason TEXT")

    def _exec(self, sql: str, args: tuple = ()) -> int:
        with self._lock:
            cur = self._db.execute(sql, args)
            return cur.lastrowid

    # ------------------------------------------------------------------ tulis
    def save_vital(self, v: dict) -> None:
        a = v.get("accel") or {}
        g = v.get("gps") or {}
        self._exec(
            "INSERT INTO vitals(device_id,ts,hr,hr_source,hr_ppg,hr_ecg,sqi,gsr,ax,ay,az,amag,"
            "fall_detected,gps_fix,lat,lon,gps_accuracy_m,local_state,buffered)"
            " VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (v.get("device_id"), v.get("ts"), v.get("hr"), v.get("hr_source"), v.get("hr_ppg"),
             v.get("hr_ecg"), v.get("sqi"), v.get("gsr"), a.get("x"), a.get("y"), a.get("z"),
             a.get("mag"), int(bool(v.get("fall_detected"))), int(bool(g.get("fix"))),
             g.get("lat"), g.get("lon"), g.get("accuracy_m"), v.get("local_state"),
             int(bool(v.get("buffered")))))

    def save_ecg(self, p, fmt: str, nbytes: int, received_ts: int) -> None:
        self._exec(
            "INSERT INTO ecg_packets(device_id,seq,t0,fs,n,samples,payload_format,payload_bytes,"
            "buffered,received_ts) VALUES(?,?,?,?,?,?,?,?,?,?)",
            (p.device_id, p.seq, p.t0, p.fs, p.n, p.samples.astype("<i2").tobytes(), fmt, nbytes,
             int(p.buffered), received_ts))

    def save_inference(self, row: dict) -> None:
        probs = row["probs"]
        self._exec(
            "INSERT INTO inferences(device_id,ts,window_t0,seq,cls,p_conf,p_normal,p_pre,p_attack,"
            "infer_ms,process_latency_ms,late,accepted,state,reason,validators,signal_ok,quality,"
            "clock_unsynced) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (row["device_id"], row["ts"], row["window_t0"], row["seq"], row["class"], row["p_conf"],
             probs[0], probs[1], probs[2], row["infer_ms"], row.get("process_latency_ms"),
             int(row["late"]), int(row.get("accepted", False)), row.get("state"), row.get("reason"),
             json.dumps(row.get("validators")), int(row.get("signal_ok", True)),
             json.dumps(row.get("quality")), int(bool(row.get("clock_unsynced")))))

    def save_transition(self, device_id: str, ts: int, a: str, b: str, reason: str) -> None:
        self._exec("INSERT INTO transitions(device_id,ts,from_state,to_state,reason) VALUES(?,?,?,?,?)",
                   (device_id, ts, a, b, reason))

    def open_event(self, device_id: str, typ: str, ts: int, conf: float, reason: str) -> int:
        return self._exec("INSERT INTO events(device_id,type,start_ts,peak_conf,fall_detected,reason)"
                          " VALUES(?,?,?,?,0,?)", (device_id, typ, ts, conf, reason))

    def update_event(self, event_id: int, **fields) -> None:
        if not fields:
            return
        cols = ",".join(f"{k}=?" for k in fields)
        self._exec(f"UPDATE events SET {cols} WHERE id=?", (*fields.values(), event_id))

    def save_notification(self, device_id: str, ts: int, event_type: str, recipients: list,
                          payload: dict, status: str, attempts: int) -> None:
        self._exec("INSERT INTO notifications(device_id,ts,event_type,recipients,payload,status,attempts)"
                   " VALUES(?,?,?,?,?,?,?)", (device_id, ts, event_type, json.dumps(recipients),
                                              json.dumps(payload), status, attempts))

    def save_status(self, device_id: str, ts: int, status: str, reason: str | None) -> None:
        self._exec("INSERT INTO device_status(device_id,ts,status,reason) VALUES(?,?,?,?)",
                   (device_id, ts, status, reason))

    # ------------------------------------------------------------------ retensi (F-BE-4)
    def prune(self, keep_days: int, now_ms: int, event_margin_ms: int = 120_000) -> dict:
        """Hapus data mentah yang lebih tua dari keep_days hari.

        Yang dihapus: vitals, ecg_packets, inferences, device_status. Yang TIDAK pernah dihapus:
        events, transitions, notifications (log audit kecil), dan ECG/vital di sekitar setiap event
        (± event_margin_ms) supaya grafik di riwayat tetap bisa dibuka. keep_days <= 0 berarti mati.
        """
        if keep_days <= 0:
            return {}
        cutoff = now_ms - keep_days * 86_400_000
        keep = ("NOT EXISTS (SELECT 1 FROM events e WHERE e.device_id={t}.device_id AND {col} BETWEEN"
                " e.start_ts-? AND COALESCE(e.end_ts, e.start_ts)+?)")
        out = {}
        for table, col in (("ecg_packets", "t0"), ("vitals", "ts"), ("inferences", "ts")):
            sql = (f"DELETE FROM {table} WHERE {col} < ? AND "
                   + keep.format(t=table, col=f"{table}.{col}"))
            with self._lock:
                out[table] = self._db.execute(sql, (cutoff, event_margin_ms, event_margin_ms)).rowcount
        with self._lock:
            out["device_status"] = self._db.execute("DELETE FROM device_status WHERE ts < ?", (cutoff,)).rowcount
            if sum(out.values()):
                self._db.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        return out

    # ------------------------------------------------------------------ baca
    def last_state(self, device_id: str) -> tuple[str, int] | None:
        """State FSM terakhir yang tercatat (to_state, ts) untuk pemulihan setelah cloud restart."""
        _, rows = self.query("SELECT to_state, ts FROM transitions WHERE device_id=? ORDER BY id DESC LIMIT 1",
                             (device_id,))
        return (rows[0][0], int(rows[0][1])) if rows else None

    def open_event_of(self, device_id: str) -> tuple[int, str, float] | None:
        """Event WARNING/CRITICAL yang belum ditutup (id, type, peak_conf)."""
        _, rows = self.query("SELECT id, type, COALESCE(peak_conf, 0) FROM events WHERE device_id=?"
                             " AND end_ts IS NULL ORDER BY id DESC LIMIT 1", (device_id,))
        return (int(rows[0][0]), rows[0][1], float(rows[0][2])) if rows else None

    def query(self, sql: str, args: tuple = ()) -> tuple[list[str], list[tuple]]:
        with self._lock:
            cur = self._db.execute(sql, args)
            return [d[0] for d in cur.description], cur.fetchall()

    def ecg_range(self, device_id: str, t_from: int, t_to: int) -> tuple[np.ndarray, np.ndarray]:
        """Rekonstruksi ECG (waktu ms, nilai count) pada rentang waktu; untuk playback event."""
        _, rows = self.query("SELECT t0,fs,samples FROM ecg_packets WHERE device_id=? AND t0>=? AND t0<=?"
                             " ORDER BY t0", (device_id, t_from, t_to))
        ts, xs = [], []
        for t0, fs, blob in rows:
            s = np.frombuffer(blob, dtype="<i2")
            ts.append(t0 + np.arange(s.size) * 1000.0 / fs)
            xs.append(s)
        if not xs:
            return np.zeros(0), np.zeros(0, dtype=np.int16)
        return np.concatenate(ts), np.concatenate(xs)
