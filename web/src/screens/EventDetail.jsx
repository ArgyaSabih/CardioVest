'use client';
import { Chart, Filler, LineController, LineElement, LinearScale, PointElement, Tooltip } from 'chart.js';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { api } from '../api.js';
import { StaticEcg } from '../components/EcgStrip.jsx';
import { LocationMap, mapsLink } from '../components/map.jsx';
import Icon from '../components/icons.jsx';
import { AckList, CLASS_TEXT, END_TEXT, ErrorNote, SignBar, fmtDuration, fmtTime, transitionText } from '../components/ui.jsx';

Chart.register(LineController, LineElement, PointElement, LinearScale, Tooltip, Filler);
const STATE_ID = { NORMAL: 'Normal', WARNING: 'Waspada', CRITICAL: 'Darurat' };
const AUDIENCE = { user: 'Anda', all: 'Anda dan kontak darurat' };
const KIND = { warning: 'Peringatan waspada', critical: 'Kabar darurat', critical_fall: 'Kabar terjatuh', critical_location: 'Lokasi', resolved: 'Kabar darurat selesai' };
const clock = (ts) => new Date(ts).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

function delivery(n) {
  if (!n.recipients) return 'belum ada ponsel yang menyalakan notifikasi';
  const ok = n.delivered === n.recipients ? `sampai di ${n.recipients} ponsel` : `sampai di ${n.delivered} dari ${n.recipients} ponsel`;
  return n.attempts > 1 ? `${ok} setelah ${n.attempts} kali coba` : ok;
}

function VitalsChart({ vitals, eventAt }) {
  const el = useRef(null);
  useEffect(() => {
    if (!vitals.length) return undefined;
    const t0 = eventAt;
    const pts = (k) => vitals.filter((v) => v[k] != null).map((v) => ({ x: (v.ts - t0) / 1000, y: v[k] }));
    const c = new Chart(el.current, {
      type: 'line',
      data: {
        datasets: [
          { label: 'Denyut (bpm)', data: pts('hr'), borderColor: '#111827', yAxisID: 'hr', pointRadius: 0, borderWidth: 2 },
          { label: 'Keringat (µS)', data: pts('gsr'), borderColor: '#8A94A6', yAxisID: 'gsr', pointRadius: 0, borderWidth: 2, borderDash: [5, 3] },
        ],
      },
      options: {
        animation: false,
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        scales: {
          x: { type: 'linear', title: { display: true, text: 'detik dari awal kejadian' }, ticks: { maxTicksLimit: 7 } },
          hr: { position: 'left', title: { display: true, text: 'denyut (bpm)', color: '#111827' } },
          gsr: { position: 'right', title: { display: true, text: 'keringat (µS)', color: '#5B6576' }, grid: { drawOnChartArea: false } },
        },
      },
      plugins: [{
        id: 'onset',
        afterDraw(chart) {
          const x = chart.scales.x.getPixelForValue(0);
          const { top, bottom } = chart.chartArea;
          chart.ctx.save();
          chart.ctx.strokeStyle = '#C8102E';
          chart.ctx.setLineDash([4, 4]);
          chart.ctx.beginPath();
          chart.ctx.moveTo(x, top);
          chart.ctx.lineTo(x, bottom);
          chart.ctx.stroke();
          chart.ctx.restore();
        },
      }],
    });
    return () => c.destroy();
  }, [vitals, eventAt]);
  return <div className="chart"><canvas ref={el} aria-label="Grafik denyut jantung dan GSR di sekitar kejadian" /></div>;
}

async function exportPdf(ev, name) {
  const { jsPDF } = await import('jspdf');
  const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'landscape' });
  const { fs, mv, mark_at: mark } = ev.ecg;
  doc.setFontSize(16);
  doc.text(`CardioVest - ${ev.type === 'critical' ? 'kejadian darurat' : 'peringatan dini'} - ${name}`, 12, 14);
  doc.setFontSize(10);
  const hr = ev.vitals.find((v) => v.ts >= ev.start_ts)?.hr;
  const lines = [
    `Mulai: ${new Date(ev.start_ts).toLocaleString('id-ID')}   Selesai: ${ev.end_ts ? new Date(ev.end_ts).toLocaleString('id-ID') : 'masih berlangsung'}`,
    `Klasifikasi EKG: ${CLASS_TEXT[ev.class] ?? '-'}   Keyakinan model tertinggi: ${ev.peak_conf != null ? Math.round(ev.peak_conf * 100) + '%' : '-'}   Denyut saat mulai: ${hr != null ? Math.round(hr) : '-'} bpm   Jatuh: ${ev.fall_detected ? 'ya' : 'tidak'}`,
    `Alasan sistem: ${ev.reason ?? '-'}`,
    'EKG 1 lead (Lead I), 25 mm/s, 10 mm/mV. Garis merah = awal kejadian. Prototipe penelitian, bukan alat medis tersertifikasi.',
  ];
  lines.forEach((l, i) => doc.text(doc.splitTextToSize(l, 270), 12, 22 + i * 5));
  const left = 12;
  const rowH = 34;
  for (let r = 0; r < 4; r++) {
    const top = 46 + r * (rowH + 3);
    for (let mm = 0; mm <= 250; mm++) {
      doc.setDrawColor(mm % 5 ? 246 : 229, mm % 5 ? 211 : 156, mm % 5 ? 211 : 156);
      doc.setLineWidth(mm % 5 ? 0.05 : 0.15);
      doc.line(left + mm, top, left + mm, top + rowH);
    }
    for (let mm = 0; mm <= rowH; mm++) {
      doc.setDrawColor(mm % 5 ? 246 : 229, mm % 5 ? 211 : 156, mm % 5 ? 211 : 156);
      doc.setLineWidth(mm % 5 ? 0.05 : 0.15);
      doc.line(left, top + mm, left + 250, top + mm);
    }
    const start = Math.max(0, mark - 20 * fs);
    const s0 = start + r * 10 * fs;
    const y = (v) => Math.max(top, Math.min(top + rowH, top + rowH / 2 - v * 10));
    doc.setDrawColor(26, 36, 51);
    doc.setLineWidth(0.25);
    for (let i = 1; i < 10 * fs && s0 + i < mv.length; i++) {
      const a = mv[s0 + i - 1];
      const b = mv[s0 + i];
      if (a != null && b != null) doc.line(left + ((i - 1) / fs) * 25, y(a), left + (i / fs) * 25, y(b));
    }
    if (mark >= s0 && mark < s0 + 10 * fs) {
      const x = left + ((mark - s0) / fs) * 25;
      doc.setDrawColor(200, 16, 46);
      doc.setLineWidth(0.4);
      doc.line(x, top, x, top + rowH);
    }
    doc.setFontSize(8);
    const t = Math.round((s0 - mark) / fs);
    doc.text(`${t} s s/d ${t + 10} s`, left + 251, top + 4);
  }
  doc.save(`cardiovest-${ev.type}-${new Date(ev.start_ts).toISOString().slice(0, 16).replace(/[:T]/g, '')}.pdf`);
}

export default function EventDetail() {
  const { id } = useParams();
  const [ev, setEv] = useState(null);
  const [zoom, setZoom] = useState(3);
  const [err, setErr] = useState('');
  const [name, setName] = useState('');

  useEffect(() => {
    Promise.all([api(`/history/${id}`), api(`/history/${id}/ecg`).catch(() => ({ fs: 250, mv: [], mark_at: 0 }))])
      .then(([e, ecg]) => setEv({ ...e, ecg }))
      .catch((e) => setErr(e.message));
    api('/users/me').then((m) => setName(m.user.name)).catch(() => {});
  }, [id]);

  if (err) return <ErrorNote error={err} />;
  if (!ev) return <p className="muted">Memuat…</p>;
  const dur = ((ev.end_ts ?? Date.now()) - ev.start_ts) / 1000;
  const hasEcg = ev.ecg.mv.some((v) => v != null);

  return (
    <>
      <Link href="/riwayat" className="link back">
        <Icon name="back" size={20} stroke={2.4} />
        Riwayat
      </Link>
      <SignBar tone={ev.type} icon={ev.type === 'critical' ? 'cross' : 'alert'} title={ev.type === 'critical' ? 'Kejadian darurat' : 'Kejadian waspada'} />
      <dl className="facts">
        <dt>Waktu</dt><dd>{fmtTime(ev.start_ts)}, {ev.end_ts ? fmtDuration(dur) : `berlangsung ${fmtDuration(dur)}`}</dd>
        <dt>Pola EKG</dt><dd>{CLASS_TEXT[ev.class] ?? 'diputuskan oleh alat'}{ev.peak_conf != null ? `, keyakinan tertinggi ${Math.round(ev.peak_conf * 100)}%` : ''}</dd>
        {ev.type === 'critical' && <><dt>Jatuh</dt><dd>{ev.fall_detected ? 'Ya, terdeteksi' : 'Tidak terdeteksi'}</dd></>}
        {ev.end_reason && <><dt>Berakhir</dt><dd>{END_TEXT[ev.end_reason] ?? ev.end_reason}</dd></>}
      </dl>

      <section className="block">
        <div className="row between">
          <h2>Rekaman EKG</h2>
          <div className="seg small" role="group" aria-label="Perbesaran">
            {[2, 3, 4].map((z) => <button key={z} aria-pressed={zoom === z} onClick={() => setZoom(z)}>{z === 2 ? 'Kecil' : z === 3 ? 'Sedang' : 'Besar'}</button>)}
          </div>
        </div>
        {!hasEcg && <p className="muted">Rekaman EKG untuk kejadian ini tidak tersedia.</p>}
        {hasEcg && <StaticEcg samples={ev.ecg.mv} fs={ev.ecg.fs} pxPerMm={zoom} markAt={ev.ecg.mark_at} />}
        <p className="muted small">Dimulai 20 detik sebelum kejadian. Garis merah menandai awalnya. Geser ke samping untuk melihat sisanya.</p>
      </section>

      {ev.probs && (
        <section className="block">
          <h2>Penilaian EKG oleh model</h2>
          <p className="muted small">Pada potongan EKG yang paling menentukan di kejadian ini. Hanya sebagai catatan untuk dokter, bukan diagnosis.</p>
          <div className="probs neutral">
            {['Normal', 'Pra-Serangan', 'Serangan'].map((k, i) => (
              <div key={k} className="prob">
                <span>{CLASS_TEXT[k]}</span>
                <span className="bar"><span className="fill" style={{ width: `${(ev.probs[i] ?? 0) * 100}%` }} /></span>
                <span className="num">{Math.round((ev.probs[i] ?? 0) * 100)}%</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {ev.vitals.length > 0 && (
        <section className="block">
          <h2>Denyut jantung dan keringat</h2>
          <VitalsChart vitals={ev.vitals} eventAt={ev.start_ts} />
        </section>
      )}

      {ev.transitions.length > 0 && (
        <section className="block">
          <h2>Urutan status</h2>
          <ol className="steps">
            {ev.transitions.map((t) => (
              <li key={t.ts} className={`to-${t.to_state.toLowerCase()}`}>
                <time>{clock(t.ts)}</time>
                {STATE_ID[t.from_state]} <Icon name="arrow" size={16} stroke={2.4} className="inline-icon" /> <strong>{STATE_ID[t.to_state]}</strong>
                <span className="why">{transitionText(t.to_state, t.reason)}</span>
              </li>
            ))}
          </ol>
          <details className="tech">
            <summary>Catatan sistem</summary>
            <ul className="plain small">
              {ev.transitions.map((t) => <li key={t.ts}><time>{clock(t.ts)}</time> {t.reason}</li>)}
            </ul>
          </details>
        </section>
      )}

      {ev.location && (
        <section className="block">
          <h2>Lokasi kejadian</h2>
          <LocationMap lat={ev.location.lat} lng={ev.location.lng} />
          <a className="link" href={mapsLink(ev.location.lat, ev.location.lng)} target="_blank" rel="noreferrer">Buka di Google Maps</a>
        </section>
      )}

      {(ev.notifications?.length > 0 || ev.acks?.length > 0) && (
        <section className="block">
          <h2>Siapa yang dikabari</h2>
          <ul className="plain">
            {ev.notifications.map((n) => (
              <li key={n.id}>
                <time>{clock(n.ts)}</time> {KIND[n.event_type] ?? n.event_type} untuk {AUDIENCE[n.audience] ?? n.audience}: {delivery(n)}.
                {n.error ? <span className="muted"> Gagal: {n.error}.</span> : null}
              </li>
            ))}
          </ul>
          <AckList acks={ev.acks} />
        </section>
      )}

      <button className="btn primary wide" disabled={!hasEcg} onClick={() => exportPdf(ev, name)}><Icon name="download" />Unduh PDF untuk dokter</button>
    </>
  );
}
