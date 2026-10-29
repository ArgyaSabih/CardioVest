'use client';
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { api } from '../api.js';
import Icon from '../components/icons.jsx';
import { END_TEXT, ErrorNote, SignBar, fmtDuration } from '../components/ui.jsx';

const DAY = 86_400_000;
const dayStart = (d) => (d ? new Date(`${d}T00:00:00`).getTime() : null);
const midnight = (ts) => new Date(new Date(ts).toDateString()).getTime();
const PERIODS = [['all', 'Semua'], ['7', '7 hari'], ['30', '30 hari'], ['custom', 'Pilih tanggal']];

function dayLabel(ts) {
  const diff = Math.round((midnight(Date.now()) - midnight(ts)) / DAY);
  if (diff === 0) return 'Hari ini';
  if (diff === 1) return 'Kemarin';
  const sameYear = new Date(ts).getFullYear() === new Date().getFullYear();
  return new Date(ts).toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'long', ...(sameYear ? {} : { year: 'numeric' }) });
}

function summary(e) {
  const parts = [e.end_ts ? fmtDuration((e.end_ts - e.start_ts) / 1000) : 'masih berlangsung'];
  if (e.end_ts) parts.push(END_TEXT[e.end_reason] ?? 'selesai');
  if (e.fall_detected) parts.push('terjatuh');
  return parts.join(', ');
}

export default function History() {
  const [type, setType] = useState('');
  const [period, setPeriod] = useState('all');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    const qs = new URLSearchParams();
    if (type) qs.set('type', type);
    if (period === '7' || period === '30') qs.set('from', midnight(Date.now()) - (Number(period) - 1) * DAY);
    if (period === 'custom') {
      if (from) qs.set('from', dayStart(from));
      if (to) qs.set('to', dayStart(to) + DAY);
    }
    setRows(null);
    setErr('');
    api(`/history?${qs}`).then(setRows).catch((e) => setErr(e.message));
  }, [type, period, from, to]);

  const days = useMemo(() => {
    const out = [];
    for (const e of rows ?? []) {
      const k = midnight(e.start_ts);
      if (out.at(-1)?.k !== k) out.push({ k, items: [] });
      out.at(-1).items.push(e);
    }
    return out;
  }, [rows]);
  const filtered = type || period !== 'all';

  return (
    <>
      <SignBar icon="clock" title="Riwayat" />
      <div className="filters">
        <div className="seg" role="group" aria-label="Jenis kejadian">
          {[['', 'Semua'], ['warning', 'Waspada'], ['critical', 'Darurat']].map(([v, l]) => (
            <button key={v} aria-pressed={type === v} onClick={() => setType(v)}>{l}</button>
          ))}
        </div>
        <div className="seg small" role="group" aria-label="Rentang waktu">
          {PERIODS.map(([v, l]) => (
            <button key={v} aria-pressed={period === v} onClick={() => setPeriod(v)}>{l}</button>
          ))}
        </div>
        {period === 'custom' && (
          <div className="date-range">
            <label>Dari<input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} /></label>
            <label>Sampai<input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} /></label>
          </div>
        )}
      </div>
      <ErrorNote error={err} />
      {rows === null && !err && <p className="muted">Memuat riwayat…</p>}
      {rows?.length === 0 && (
        filtered ? (
          <p className="empty"><strong>Tidak ada kejadian yang cocok.</strong>Coba pilih jenis atau rentang waktu lain.</p>
        ) : (
          <p className="empty">
            <strong>Belum pernah ada peringatan.</strong>
            Setiap kali status berubah menjadi Waspada atau Darurat, kejadiannya tercatat di sini lengkap dengan
            rekaman EKG yang bisa diunduh untuk dokter.
          </p>
        )
      )}
      {days.map((d) => (
        <section key={d.k} aria-label={dayLabel(d.k)}>
          <h2 className="day">{dayLabel(d.k)}</h2>
          <ol className="log">
            {d.items.map((e) => (
              <li key={e.id} className={`ev-${e.type}`}>
                <Link href={`/riwayat/${e.id}`}>
                  <time className="ev-time" dateTime={new Date(e.start_ts).toISOString()}>
                    {new Date(e.start_ts).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })}
                  </time>
                  <span className="ev-type"><span className="ev-chip"><Icon name={e.type === 'critical' ? 'cross' : 'alert'} size={16} stroke={2.6} /></span>{e.type === 'critical' ? 'Darurat' : 'Waspada'}</span>
                  <span className="ev-meta">
                    {summary(e)}
                  </span>
                  <Icon name="arrow" className="ev-go" size={22} stroke={2.4} />
                </Link>
              </li>
            ))}
          </ol>
        </section>
      ))}
    </>
  );
}
