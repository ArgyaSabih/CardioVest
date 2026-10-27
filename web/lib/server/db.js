// Akses BACA-SAJA ke database SQLite layanan cloud (node:sqlite bawaan Node 22, tanpa modul native).
// Cloud memakai mode WAL, jadi aman dibaca bersamaan dengan cloud yang menulis. Database bisa belum
// ada saat gateway menyala lebih dulu, jadi dibuka secara malas. Semua kueri dibatasi satu alat.
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { cfg } from './config.js';
import { COUNTS_PER_MV } from './codec.js';

let db = null;

function open() {
  if (db) return db;
  if (!fs.existsSync(cfg.cloudDb)) return null;
  db = new DatabaseSync(cfg.cloudDb, { readOnly: true });
  db.exec('PRAGMA busy_timeout = 3000');
  return db;
}

const all = (sql, ...args) => open()?.prepare(sql).all(...args) ?? [];
const get = (sql, ...args) => open()?.prepare(sql).get(...args) ?? null;

export const cloudDbReady = () => !!open();

// cloud menyimpan type = nama state ("WARNING"/"CRITICAL"); API memakai huruf kecil
const norm = (e) => e && { ...e, type: String(e.type).toLowerCase(), fall_detected: !!e.fall_detected };

/** Riwayat dengan filter tipe & rentang tanggal (Halaman 4). */
export function listEvents(dev, { type, from, to, limit = 100 } = {}) {
  const w = ['device_id=?'];
  const a = [dev];
  if (type) {
    w.push('UPPER(type)=?');
    a.push(String(type).toUpperCase());
  }
  if (from) {
    w.push('start_ts>=?');
    a.push(Number(from));
  }
  if (to) {
    w.push('start_ts<?');
    a.push(Number(to));
  }
  a.push(limit);
  return all(`SELECT * FROM events WHERE ${w.join(' AND ')} ORDER BY start_ts DESC LIMIT ?`, ...a).map(norm);
}

export const getEvent = (dev, id) => norm(get('SELECT * FROM events WHERE device_id=? AND id=?', dev, id));

export const openEvent = (dev) =>
  norm(get('SELECT * FROM events WHERE device_id=? AND end_ts IS NULL ORDER BY start_ts DESC LIMIT 1', dev));

export const transitions = (dev, from, to) =>
  all('SELECT ts, from_state, to_state, reason FROM transitions WHERE device_id=? AND ts BETWEEN ? AND ? ORDER BY ts', dev, from, to);

/** Kelas & keyakinan CNN pada window yang memicu kejadian (F-APP-6). */
export const triggerInference = (dev, startTs) =>
  get(`SELECT cls, p_conf, p_normal, p_pre, p_attack FROM inferences
       WHERE device_id=? AND accepted=1 AND ts<=? ORDER BY ts DESC LIMIT 1`, dev, startTs + 1000);

export const vitals = (dev, from, to) =>
  all(`SELECT ts, hr, hr_source, gsr, sqi, amag, fall_detected, gps_fix, lat, lon, gps_accuracy_m, local_state
       FROM vitals WHERE device_id=? AND ts BETWEEN ? AND ? ORDER BY ts`, dev, from, to);

export const lastVital = (dev) =>
  get('SELECT ts, hr, hr_source, gsr, sqi, fall_detected, lat, lon, gps_fix, local_state FROM vitals WHERE device_id=? ORDER BY ts DESC LIMIT 1', dev);

export const lastFix = (dev, from, to) =>
  get(`SELECT ts, lat, lon, gps_accuracy_m FROM vitals WHERE device_id=? AND gps_fix=1 AND ts BETWEEN ? AND ?
       ORDER BY ts DESC LIMIT 1`, dev, from, to);

/** Rata-rata per menit untuk grafik tren. */
export const trend = (dev, fromTs) =>
  all(`SELECT (ts/60000)*60000 AS t, ROUND(AVG(hr),1) AS hr, ROUND(AVG(gsr),2) AS gsr, MAX(fall_detected) AS fall
       FROM vitals WHERE device_id=? AND ts>=? GROUP BY ts/60000 ORDER BY t`, dev, fromTs);

/** Potongan ECG (mV) dari paket tersimpan; celah antar-paket diisi null supaya garis terputus jujur. */
export function ecgStrip(dev, from, to) {
  const rows = all('SELECT t0, fs, n, samples FROM ecg_packets WHERE device_id=? AND t0 BETWEEN ? AND ? ORDER BY t0', dev, from - 4000, to);
  if (!rows.length) return { t0: from, fs: 250, mv: [] };
  const fs_ = rows[0].fs;
  const t0 = rows[0].t0;
  const n = Math.max(0, Math.ceil(((to - t0) / 1000) * fs_));
  const mv = new Array(n).fill(null);
  for (const r of rows) {
    const b = Uint8Array.from(r.samples); // salinan: BLOB belum tentu sejajar 2 byte; int16 little-endian
    const s = new Int16Array(b.buffer, 0, b.length >> 1);
    const off = Math.round(((r.t0 - t0) / 1000) * fs_);
    for (let i = 0; i < s.length && off + i < n; i++) if (off + i >= 0) mv[off + i] = Math.round((s[i] / COUNTS_PER_MV) * 1000) / 1000;
  }
  return { t0, fs: fs_, mv };
}

export function closeDb() {
  db?.close();
  db = null;
}
