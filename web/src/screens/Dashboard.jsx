'use client';
// Halaman 2: Beranda real-time (F-APP-3) untuk User Utama.
// Urutannya mengikuti kebutuhan pemakai, bukan urutan pipeline: status dan tindakan dulu, lalu sinyal,
// lalu angka yang ia pahami. Probabilitas model dan alasan teknis ada di detail kejadian (Riwayat).
import { useEffect, useRef, useState } from 'react';
import { useSelector } from 'react-redux';
import Link from 'next/link';
import { api } from '../api.js';
import DemoPanel from '../components/DemoPanel.jsx';
import { LiveEcg } from '../components/EcgStrip.jsx';
import Icon from '../components/icons.jsx';
import { AckList, CallButtons, Connection, StateBanner, StickyCall, Wordmark, displayState, since } from '../components/ui.jsx';

const REST_LO = 60; // pita "wajar saat istirahat" di grafik tren
const REST_HI = 100;

function HrTrend({ nowHr }) {
  const [pts, setPts] = useState(null);
  useEffect(() => {
    const load = () => api('/trend?hours=6').then(setPts).catch(() => setPts([]));
    load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, []);
  const hr = [...(pts || [])];
  if (hr.filter((p) => p.hr != null).length < 2) return null;
  if (nowHr) hr.push({ t: Date.now(), hr: nowHr }); // ujung grafik = angka di atas, bukan data 30 detik lalu
  const W = 320;
  const H = 96;
  const t0 = hr[0].t;
  const t1 = hr.at(-1).t;
  const vals = hr.filter((p) => p.hr != null).map((p) => p.hr);
  const lo = Math.min(50, ...vals) - 5;
  const hi = Math.max(110, ...vals) + 5;
  const x = (t) => ((t - t0) / Math.max(1, t1 - t0)) * W;
  const y = (v) => H - ((v - lo) / (hi - lo)) * H;
  let d = '';
  let prev = null;
  for (const p of hr) {
    if (p.hr == null) { // menit tanpa angka denyut: garis diputus, tidak disambung
      prev = null;
      continue;
    }
    const gap = !prev || p.t - prev.t > 5 * 60_000; // alat mati > 5 menit: putus garis
    d += `${gap ? 'M' : 'L'}${x(p.t).toFixed(1)},${y(p.hr).toFixed(1)}`;
    prev = p;
  }
  const max = Math.max(...vals);
  const min = Math.min(...vals);
  return (
    <section className="block">
      <h2>Denyut 6 jam terakhir</h2>
      <div className="trend-wrap">
        <svg className="trend" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img"
          aria-label={`Denyut 6 jam terakhir antara ${Math.round(min)} dan ${Math.round(max)} kali per menit`}>
          <rect x="0" width={W} y={y(REST_HI)} height={y(REST_LO) - y(REST_HI)} className="trend-band" />
          <path d={d} fill="none" stroke="#111827" strokeWidth="1.8" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
        </svg>
        <span className="trend-tick" style={{ top: `${(y(REST_HI) / H) * 100}%` }}>{REST_HI}</span>
        <span className="trend-tick" style={{ top: `${(y(REST_LO) / H) * 100}%` }}>{REST_LO}</span>
      </div>
      <div className="row between muted small">
        <span>{new Date(t0).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })}</span>
        <span>sekarang</span>
      </div>
    </section>
  );
}

function ResetAlarm({ allowed }) {
  const [ask, setAsk] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const send = async () => {
    setBusy(true);
    setErr('');
    try {
      await api('/reset', { method: 'POST', body: { confirm: true } });
      setTimeout(() => {
        setBusy(false);
        setAsk(false);
        setErr('Alat belum menanggapi. Coba lagi, atau tahan tombol reset di alat 3 detik.');
      }, 15_000);
    } catch (e) {
      setErr(e.message);
      setBusy(false);
    }
  };
  if (!allowed) return <p className="state-note">Sudah ditolong? Tahan tombol reset di alat 3 detik.</p>;
  return (
    <div className="reset-alarm">
      <p className="state-note">Sudah ditolong? Hentikan alarm di sini, atau tahan tombol reset di alat 3 detik.</p>
      {!ask && !busy && (
        <button type="button" className="btn danger wide" onClick={() => setAsk(true)}>Hentikan alarm</button>
      )}
      {ask && !busy && (
        <>
          <p className="state-note strong">Hanya bila pertolongan sudah datang.</p>
          <button type="button" className="btn danger solid wide" onClick={send}>Ya, hentikan alarm</button>
          <button type="button" className="btn ghost wide" onClick={() => setAsk(false)}>Batal</button>
        </>
      )}
      {busy && <p className="state-note" role="status">Menunggu alat…</p>}
      {err && <p className="state-note" role="alert">{err}</p>}
    </div>
  );
}

/**
 * Tombol "Matikan bunyi alat" saat rompi berbunyi (Waspada/Darurat). Yang diam hanya buzzer; status,
 * LED, dan kabar ke keluarga tetap. Alat sendiri yang mengonfirmasi lewat data vital (buzzer_muted).
 */
function MuteButton({ muted, state, linked }) {
  const [sentAt, setSentAt] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    setSentAt(null);
    setErr('');
  }, [state]);
  useEffect(() => {
    if (!sentAt || muted) return undefined;
    const t = setTimeout(() => {
      setSentAt(null);
      setErr('Alat belum menjawab. Coba lagi.');
    }, 10_000);
    return () => clearTimeout(t);
  }, [sentAt, muted]);
  if (!linked) return null;
  if (muted) {
    return (
      <p className="state-note mute-done">
        <Icon name="mute" size={22} stroke={2.4} />
        {state === 'CRITICAL' ? 'Bunyi alat dimatikan. Darurat tetap aktif.' : 'Bunyi alat dimatikan.'}
      </p>
    );
  }
  const send = async () => {
    setErr('');
    setSentAt(Date.now());
    try {
      await api('/devices/mute', { method: 'POST' });
    } catch (e) {
      setSentAt(null);
      setErr(e.message);
    }
  };
  return (
    <div className="mute">
      <button className="btn em-secondary" onClick={send} disabled={!!sentAt}>
        <Icon name="mute" size={22} stroke={2.4} />{sentAt ? 'Mematikan bunyi…' : 'Matikan bunyi alat'}
      </button>
      {err && <p className="state-note strong" role="alert">{err}</p>}
    </div>
  );
}

// Penilaian denyut berasal dari cloud (validator HR); layar hanya menuliskannya.
function hrRead(hr, flagged) {
  if (hr == null || flagged == null) return { word: null, abn: false };
  return flagged ? { word: 'Tidak biasa', abn: true } : { word: 'Wajar', abn: false };
}

export default function Dashboard() {
  const live = useSelector((s) => s.live);
  const { user, whatsapp } = useSelector((s) => s.auth);
  const [, tick] = useState(0);
  const callRef = useRef(null);
  const [callHidden, setCallHidden] = useState(false);
  const prevState = useRef(live.state);
  const [endedAt, setEndedAt] = useState(null);

  useEffect(() => {
    const t = setInterval(() => tick((x) => x + 1), 15_000);
    return () => clearInterval(t);
  }, []);

  // penutup kejadian: setelah Waspada/Darurat kembali Normal, beri tahu bahwa kejadiannya tersimpan
  useEffect(() => {
    if (live.state === 'NORMAL' && (prevState.current === 'WARNING' || prevState.current === 'CRITICAL')) setEndedAt(Date.now());
    if (live.state !== 'NORMAL') setEndedAt(null);
    prevState.current = live.state;
  }, [live.state]);

  const v = live.vital;
  const val = live.inference?.validators;
  const cal = live.calibration;
  const linked = live.connection === 'online' || live.connection === 'buffering';
  const shown = displayState(live.state, live.connection);
  const critical = live.state === 'CRITICAL';
  const warning = live.state === 'WARNING';
  const fresh = linked && v && !v.stale;
  const amb = live.ambulance;

  // bilah telepon AmbulanMU menempel bila tombol utama sudah tergulir keluar layar
  useEffect(() => {
    if (!critical || !callRef.current) {
      setCallHidden(false);
      return undefined;
    }
    const io = new IntersectionObserver(([e]) => setCallHidden(!e.isIntersecting), { rootMargin: '0px 0px -72px 0px' });
    io.observe(callRef.current);
    return () => io.disconnect();
  }, [critical]);

  const hr = hrRead(v?.hr ? Math.round(v.hr) : null, val?.ind_hr);
  const gsrWord = !v || v.gsr == null ? null
    : cal && !cal.calibrated ? '…'
      : val?.ind_gsr ? 'Lebih banyak' : 'Biasa';
  const moveWord = !v ? null : v.fall ? 'Jatuh' : v.moving == null ? null : v.moving ? 'Bergerak' : 'Diam';
  const staleNote = v?.ts ? `Terakhir ${since(v.ts)}` : 'Belum ada data';

  return (
    <>
      <header className="signbar brand">
        <Wordmark small />
        <span className="signbar-side"><Connection connection={live.connection} hr={fresh ? v?.hr : null} /></span>
      </header>
      <StateBanner
        state={live.state}
        connection={live.connection}
        sinceTs={live.since}
        lastSeen={v?.ts}
        line={critical ? `${whatsapp && amb ? `${amb.name.replace(/ Kota Yogyakarta$/, '')} dan keluarga` : 'Keluarga'} sudah dikabari beserta lokasi Anda.` : undefined}
      >
        {shown === 'UNMONITORED' && (
          <ol className="state-steps">
            <li>Pakai kaos dan nyalakan alat.</li>
            <li>Periksa baterai.</li>
          </ol>
        )}

        {warning && (
          <div className="warning-actions">
            <ol className="state-steps big">
              <li>Hentikan aktivitas.</li>
              <li>Duduk.</li>
              <li>Tarik napas pelan.</li>
            </ol>
            <MuteButton muted={!!v?.buzzer_muted} state={live.state} linked={linked} />
            <p className="state-note strong">Dada nyeri atau sesak?</p>
            <CallButtons ambulance={amb} who={user?.name} self gps={null} />
          </div>
        )}

        {critical && (
          <div className="critical-actions">
            <CallButtons ambulance={amb} contacts={live.contacts} who={user?.name} self gps={live.gps} callRef={callRef} />
            <AckList acks={live.event?.acks} />
            <MuteButton muted={!!v?.buzzer_muted} state={live.state} linked={linked} />
            <p className="state-note">{live.gps ? 'Lokasi terkirim.' : 'Mencari sinyal GPS…'}</p>
            <ResetAlarm allowed={live.remoteReset && linked} />
            <p className="state-stranger">Menemukan ponsel ini? Pemiliknya butuh ambulans. Tekan tombol telepon di atas.</p>
          </div>
        )}
      </StateBanner>

      {endedAt && Date.now() - endedAt < 10 * 60_000 && (
        <p className="note-info">Kejadian tadi tersimpan di <Link href="/riwayat">Riwayat</Link>.</p>
      )}

      <LiveEcg
        stale={!linked}
        overlay={
          live.leadOff ? 'Elektroda lepas atau longgar. Rapatkan kaos ke dada.'
            : !linked ? `Rekaman terakhir, ${v?.ts ? since(v.ts) : 'sebelum alat terputus'}`
              : live.signal?.ok === false ? 'Sinyal kurang bersih. Kurangi gerakan.'
                : null
        }
      />

      <section className={`vitals ${fresh ? '' : 'is-stale'}`} aria-label="Tanda vital">
        <div className={`vital ${fresh && hr.abn ? 'abn' : ''}`}>
          <span className="vital-label"><Icon name="pulse" size={18} stroke={2.4} />Denyut</span>
          <span className="vital-value">{v?.hr ? Math.round(v.hr) : '–'}<small>/menit</small></span>
          <span className="vital-note">{!fresh ? staleNote : hr.word ?? (v?.hr ? '\u00a0' : 'Menunggu data')}</span>
        </div>
        <div className={`vital ${fresh && val?.ind_gsr ? 'abn' : ''}`}>
          <span className="vital-label"><Icon name="drop" size={18} stroke={2.4} />Keringat</span>
          <span className="vital-value word">{gsrWord ?? '–'}</span>
          <span className="vital-note">
            {fresh && cal && !cal.calibrated ? 'Mengenali pola Anda' : '\u00a0'}
          </span>
        </div>
        <div className={`vital ${fresh && v?.fall ? 'abn' : ''}`}>
          <span className="vital-label"><Icon name="walk" size={18} stroke={2.4} />Gerakan</span>
          <span className="vital-value word">{moveWord ?? '–'}</span>
          <span className="vital-note">{'\u00a0'}</span>
        </div>
      </section>

      <HrTrend nowHr={fresh ? v?.hr : null} />
      <DemoPanel />

      {!live.contacts.length && (
        <p className="note-warn">
          Belum ada kontak keluarga. <Link className="inline-action" href="/kontak">Tambah</Link>
        </p>
      )}
      {!live.connected && <p className="offline-note" role="status">Terputus dari server. Menyambung lagi…</p>}
      {critical && callHidden && <StickyCall ambulance={amb} />}
    </>
  );
}
