'use client';
import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { LocationMap } from './map.jsx';

const MODES = [['demo', 'Demo'], ['test', 'Test']];
const CLASSES = ['Normal', 'Pra-Serangan', 'Serangan'];
const label = (m) => (m === 'test' ? 'Test' : 'Demo');

export function ModeSwitch({ mode, deviceMode, disabled }) {
  const [busy, setBusy] = useState(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    if (busy && busy === mode) setBusy(null);
  }, [mode, busy]);

  useEffect(() => {
    if (!busy) return undefined;
    const t = setTimeout(() => {
      setBusy(null);
      setErr('Server belum menanggapi. Coba lagi.');
    }, 15_000);
    return () => clearTimeout(t);
  }, [busy]);

  const pick = async (m) => {
    if (m === mode || busy) return;
    setErr('');
    setBusy(m);
    try {
      await api('/mode', { method: 'POST', body: { mode: m } });
    } catch (e) {
      setBusy(null);
      setErr(e.message);
    }
  };

  const waiting = !busy && deviceMode && deviceMode !== mode;
  return (
    <section className="block mode-switch" aria-label="Mode alat">
      <h2>Mode alat</h2>
      <div className="seg" role="group" aria-label="Pilih mode">
        {MODES.map(([k, l]) => (
          <button key={k} type="button" aria-pressed={mode === k} disabled={disabled || !!busy} onClick={() => pick(k)}>{l}</button>
        ))}
      </div>
      <p className="muted small" role="status">
        {busy ? `Mengubah ke mode ${label(busy)}…`
          : waiting ? `Menunggu alat pindah ke mode ${label(mode)}…`
            : mode === 'test' ? 'Semua sensor berjalan bersamaan, termasuk GPS. Status tetap diputuskan dengan aturan yang sama seperti mode Demo.'
              : 'GPS siaga dan baru aktif saat status Darurat.'}
      </p>
      {err && <p className="state-note" role="alert">{err}</p>}
    </section>
  );
}

const num = (x, d = 1, unit = '') => (x == null || Number.isNaN(Number(x)) ? '–' : `${Number(x).toLocaleString('id-ID', { minimumFractionDigits: d, maximumFractionDigits: d })}${unit}`);
const pct = (x) => (x == null ? '–' : `${Math.round(x * 100)}%`);
const yes = (b, on = 'Ya', off = 'Tidak') => (b == null ? '–' : b ? on : off);

function Card({ title, ok, children }) {
  return (
    <div className="test-card">
      <h3>
        {title}
        {ok != null && <span className={`test-tag ${ok ? '' : 'off'}`}>{ok ? 'Aktif' : 'Tidak aktif'}</span>}
      </h3>
      <dl>{children}</dl>
    </div>
  );
}

const Row = ({ k, v }) => (
  <>
    <dt>{k}</dt>
    <dd>{v}</dd>
  </>
);

function beep() {
  try {
    const ctx = new AudioContext();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'square';
    o.frequency.value = 880;
    g.gain.value = 0.15;
    o.connect(g);
    g.connect(ctx.destination);
    o.start();
    o.stop(ctx.currentTime + 0.6);
    o.onended = () => ctx.close();
  } catch {
    return;
  }
}

function useFallAlarm(v) {
  const last = useRef(null);
  const [at, setAt] = useState(null);
  useEffect(() => {
    if (!v?.fall || !v.fall_ts || v.fall_ts === last.current) return;
    const first = last.current === null && Date.now() - v.fall_ts > 10_000;
    last.current = v.fall_ts;
    if (first) return;
    setAt(v.fall_ts);
    beep();
    setTimeout(beep, 800);
  }, [v?.fall, v?.fall_ts]);
  useEffect(() => {
    if (!at) return undefined;
    const t = setTimeout(() => setAt(null), 6000);
    return () => clearTimeout(t);
  }, [at]);
  return at;
}

export function TestPanel({ vital, fresh, inference, calibration, signal, state }) {
  const v = fresh ? vital : null;
  const fallAt = useFallAlarm(v);
  const s = v?.sensors;
  const a = v?.accel;
  const g = v?.gps;
  const inf = inference;
  const val = inf?.validators;
  const probs = Array.isArray(inf?.probs) ? inf.probs : null;
  const time = v?.ts ? new Date(v.ts).toLocaleTimeString('id-ID') : '–';

  return (
    <section className="block" aria-label="Data uji semua sensor">
      <h2>Data uji</h2>
      {!v && <p className="muted small">Menunggu data dari alat…</p>}
      {fallAt && (
        <p className="test-alarm" role="alert">Jatuh terdeteksi pukul {new Date(fallAt).toLocaleTimeString('id-ID')}</p>
      )}
      <div className="test-panel">
        <Card title="EKG (AD8232)" ok={s?.ecg}>
          <Row k="Denyut EKG" v={num(v?.hr_ecg, 1, ' bpm')} />
          <Row k="Elektroda" v={v ? (v.lead_off ? 'Lepas' : 'Menempel') : '–'} />
          <Row k="Kualitas sinyal" v={signal ? (signal.ok ? 'Baik' : signal.reason || 'Kurang') : '–'} />
        </Card>

        <Card title="PPG (MAX30102)" ok={s?.ppg}>
          <Row k="Denyut PPG" v={num(v?.hr_ppg, 1, ' bpm')} />
          <Row k="SQI" v={num(v?.sqi, 2)} />
          <Row k="Sumber denyut dipakai" v={v?.hr_source ?? '–'} />
          <Row k="Denyut dipakai" v={num(v?.hr, 1, ' bpm')} />
        </Card>

        <Card title="GSR" ok={s?.gsr}>
          <Row k="Konduktansi" v={num(v?.gsr, 2, ' µS')} />
          <Row k="Ambang" v={num(calibration?.threshold, 2, ' µS')} />
          <Row k="Kalibrasi" v={calibration ? (calibration.calibrated ? 'Selesai' : `${Math.round(calibration.progress_s)}/${calibration.target_s} s`) : '–'} />
          <Row k="Di atas ambang" v={yes(val?.ind_gsr)} />
        </Card>

        <Card title="IMU (MPU6050)" ok={s?.imu}>
          <Row k="x / y / z" v={a ? `${num(a.x, 2)} / ${num(a.y, 2)} / ${num(a.z, 2)} g` : '–'} />
          <Row k="|a|" v={num(a?.mag, 3, ' g')} />
          <Row k="Simpangan baku" v={num(a?.sd, 3, ' g')} />
          <Row k="Bergerak" v={yes(v?.moving)} />
          <Row k="Jatuh" v={yes(v?.fall)} />
        </Card>

        <Card title="GPS (Neo-6M)" ok={v ? !!g : null}>
          <Row k="Data NMEA" v={g ? (g.nmea === false ? 'Tidak ada, cek kabel' : 'Diterima') : '–'} />
          <Row k="Baud" v={g?.baud ?? '–'} />
          <Row k="Fix" v={g ? yes(g.fix) : '–'} />
          <Row k="Satelit" v={g?.sats ?? '–'} />
          <Row k="Lintang" v={g?.fix ? g.lat.toFixed(6) : '–'} />
          <Row k="Bujur" v={g?.fix ? g.lon.toFixed(6) : '–'} />
          <Row k="Akurasi" v={g?.fix ? num(g.accuracy_m, 1, ' m') : '–'} />
        </Card>

        {g?.fix && (
          <div className="test-card test-map">
            <h3>
              Lokasi terkini
              <a className="small" href={`https://www.google.com/maps?q=${g.lat},${g.lon}`} target="_blank" rel="noopener noreferrer">Buka di Google Maps</a>
            </h3>
            <LocationMap lat={g.lat} lng={g.lon} acc={g.accuracy_m} height={240} />
          </div>
        )}

        <Card title="Model CNN">
          <Row k="Kelas" v={inf?.class ?? '–'} />
          <Row k="Keyakinan" v={pct(inf?.p_conf)} />
          {probs && probs.map((p, i) => <Row key={CLASSES[i] ?? i} k={`P(${CLASSES[i] ?? i})`} v={pct(p)} />)}
          <Row k="Diputuskan" v={yes(inf?.accepted)} />
          <Row k="Alasan" v={inf?.reason ?? '–'} />
        </Card>

        <Card title="Status">
          <Row k="State cloud" v={state} />
          <Row k="State alat" v={v?.local_state ?? '–'} />
          <Row k="Mode alat" v={v?.mode ? label(v.mode) : '–'} />
          <Row k="Mengisi daya" v={v ? yes(v.charging) : '–'} />
          <Row k="Data terakhir" v={time} />
        </Card>
      </div>
    </section>
  );
}
