'use client';
// Halaman 2: Beranda real-time (F-APP-3) untuk User Utama.
// Urutannya mengikuti kebutuhan pemakai, bukan urutan pipeline: status dan tindakan dulu, lalu sinyal,
// lalu angka yang ia pahami. Probabilitas model dan alasan teknis ada di detail kejadian (Riwayat).
import { useEffect, useRef, useState } from 'react';
import { useSelector } from 'react-redux';
import Link from 'next/link';
import { api } from '../api.js';
import { LiveEcg } from '../components/EcgStrip.jsx';
import Icon from '../components/icons.jsx';
import { AckList, CallButtons, Connection, StateBanner, StickyCall, Wordmark, displayState, since } from '../components/ui.jsx';

const HR_HIGH = 120; // sama dengan HR_HIGH / HR_LOW di layanan cloud (Tabel 4.3)
const HR_LOW = 40;
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
  const hr = (pts || []).filter((p) => p.hr != null);
  if (hr.length < 5) return null;
  if (nowHr) hr.push({ t: Date.now(), hr: nowHr }); // ujung grafik = angka di atas, bukan data 30 detik lalu
  const W = 320;
  const H = 96;
  const t0 = hr[0].t;
  const t1 = hr.at(-1).t;
  const lo = Math.min(50, ...hr.map((p) => p.hr)) - 5;
  const hi = Math.max(110, ...hr.map((p) => p.hr)) + 5;
  const x = (t) => ((t - t0) / Math.max(1, t1 - t0)) * W;
  const y = (v) => H - ((v - lo) / (hi - lo)) * H;
  let d = '';
  hr.forEach((p, i) => {
    const gap = i && p.t - hr[i - 1].t > 5 * 60_000; // alat mati > 5 menit: putus garis
    d += `${!i || gap ? 'M' : 'L'}${x(p.t).toFixed(1)},${y(p.hr).toFixed(1)}`;
  });
  const max = Math.max(...hr.map((p) => p.hr));
  const min = Math.min(...hr.map((p) => p.hr));
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
        <span>pita abu-abu: wajar saat istirahat</span>
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
        setErr('Alat belum menanggapi. Coba lagi, atau tahan tombol reset di alat selama 3 detik.');
      }, 15_000);
    } catch (e) {
      setErr(e.message);
      setBusy(false);
    }
  };
  if (!allowed) {
    return <p className="state-note">Setelah pertolongan datang, tahan tombol reset di alat selama 3 detik untuk menghentikan alarm.</p>;
  }
  return (
    <div className="reset-alarm">
      {!ask && !busy && (
        <button type="button" className="btn danger wide" onClick={() => setAsk(true)}>Hentikan alarm</button>
      )}
      {ask && !busy && (
        <>
          <p className="state-note strong">Hentikan alarm hanya bila pertolongan sudah datang dan keadaan sudah aman.</p>
          <button type="button" className="btn danger solid wide" onClick={send}>Ya, hentikan alarm</button>
          <button type="button" className="btn ghost wide" onClick={() => setAsk(false)}>Batal</button>
        </>
      )}
      {busy && <p className="state-note" role="status">Menghentikan alarm… menunggu alat menanggapi.</p>}
      {err && <p className="state-note" role="alert">{err}</p>}
      <p className="state-note">Bisa juga dengan menahan tombol reset di alat selama 3 detik.</p>
    </div>
  );
}

function hrRead(hr, flagged) {
  if (hr == null) return { word: null, abn: false };
  if (hr > HR_HIGH) return { word: 'Tinggi', abn: true };
  if (hr < HR_LOW) return { word: 'Rendah', abn: true };
  return flagged ? { word: 'Tidak biasa', abn: true } : { word: 'Wajar', abn: false };
}

export default function Dashboard() {
  const live = useSelector((s) => s.live);
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
  const firstContact = live.contacts?.[0];

  // bilah 119 menempel bila tombol utama sudah tergulir keluar layar
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
    : cal && !cal.calibrated ? 'Dikenali…'
      : val?.ind_gsr ? 'Lebih banyak' : 'Biasa';
  const moveWord = !v ? null : v.fall ? 'Jatuh' : v.moving == null ? null : v.moving ? 'Bergerak' : 'Diam';
  const staleNote = v?.ts ? `Terakhir ${since(v.ts)}` : 'Belum ada data';

  const dec = (x) => x.toLocaleString('id-ID', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

  return (
    <>
      <header className="signbar brand">
        <Wordmark small />
        <span className="signbar-side"><Connection connection={live.connection} hr={fresh ? v?.hr : null} /></span>
      </header>
      <StateBanner state={live.state} connection={live.connection} sinceTs={live.since} lastSeen={v?.ts}>
        {shown === 'UNMONITORED' && (
          <ol className="state-steps">
            <li>Pastikan kaos CardioVest dipakai dan alatnya menyala.</li>
            <li>Periksa baterai, lalu tunggu satu menit.</li>
            <li>Data selama terputus tersimpan di alat sampai ±10 menit dan terkirim begitu tersambung lagi.</li>
          </ol>
        )}

        {warning && (
          <div className="warning-actions">
            <ol className="state-steps big">
              <li>Hentikan aktivitas.</li>
              <li>Duduk.</li>
              <li>Tarik napas pelan.</li>
            </ol>
            <p className="state-note strong">Bila dada terasa nyeri atau sesak:</p>
            <a className="btn primary" href="tel:119"><Icon name="phone" />Telepon 119</a>
            {firstContact && (
              <a className="btn" href={`tel:${firstContact.phone}`}><Icon name="phone" />Telepon {firstContact.name}</a>
            )}
            <p className="state-note">
              Keluarga belum dikabari. Mereka dikabari otomatis beserta lokasi Anda bila status menjadi Darurat.
            </p>
          </div>
        )}

        {critical && (
          <div className="critical-actions">
            <CallButtons contacts={live.contacts} callRef={callRef} />
            {live.event?.acks?.length ? (
              <AckList acks={live.event.acks} />
            ) : (
              <p className="state-note">Begitu ada keluarga yang membuka kabarnya, namanya muncul di sini.</p>
            )}
            {live.fall && <p className="state-note">Keluarga juga diberi tahu bahwa Anda terjatuh.</p>}
            {live.gps ? (
              <p className="state-note">
                Lokasi Anda sudah terkirim{live.gps.acc ? ` (akurasi sekitar ${Math.round(live.gps.acc)} m)` : ''}.
              </p>
            ) : (
              <p className="state-note">GPS sedang mencari sinyal. Lokasi dikirim ke keluarga begitu didapat.</p>
            )}
            {!linked && (
              <p className="state-note">Bila alat terputus lebih dari 30 detik, alat mengirim SMS berisi lokasi ke keluarga.</p>
            )}
            <ResetAlarm allowed={live.remoteReset && linked} />
            <details className="state-more">
              <summary>Kenapa status ini Darurat?</summary>
              <p>EKG, denyut jantung, dan keringat Anda sama-sama menunjukkan tanda bahaya pada jantung pada saat yang sama.</p>
              {live.event?.public_token && (
                <p><Link href={`/darurat/${live.event.public_token}`}>Buka halaman darurat yang dilihat keluarga</Link></p>
              )}
            </details>
            <p className="state-stranger">
              Bukan pemilik ponsel ini? Pemiliknya mungkin mengalami gangguan jantung. Telepon 119.
            </p>
          </div>
        )}
      </StateBanner>

      {endedAt && Date.now() - endedAt < 10 * 60_000 && (
        <p className="note-info">
          Kejadian tadi sudah selesai dan tersimpan di <Link href="/riwayat">Riwayat</Link>, lengkap dengan rekaman EKG-nya.
        </p>
      )}
      {live.connection === 'buffering' && (
        <p className="note-info">Alat baru tersambung lagi dan sedang mengirim data yang tertunda. Riwayat lengkap sebentar lagi.</p>
      )}

      <LiveEcg
        leadOff={live.leadOff}
        stale={!linked}
        overlay={
          live.leadOff ? 'Elektroda lepas. Rapatkan kaos ke dada.'
            : !linked ? `Rekaman terakhir, ${v?.ts ? since(v.ts) : 'sebelum alat terputus'}`
              : live.signal?.ok === false ? 'Sinyal kurang bersih karena banyak bergerak atau kaos kurang menempel. Pemeriksaan ditunda sebentar.'
                : null
        }
      />

      <section className={`vitals ${fresh ? '' : 'is-stale'}`} aria-label="Tanda vital">
        <div className={`vital ${fresh && hr.abn ? 'abn' : ''}`}>
          <span className="vital-label"><Icon name="pulse" size={18} stroke={2.4} />Denyut</span>
          <span className="vital-value">{v?.hr ? Math.round(v.hr) : '–'}<small>/menit</small></span>
          <span className="vital-note">{!fresh ? staleNote : hr.word ?? 'Menunggu data'}</span>
        </div>
        <div className={`vital ${fresh && val?.ind_gsr ? 'abn' : ''}`}>
          <span className="vital-label"><Icon name="drop" size={18} stroke={2.4} />Keringat</span>
          <span className="vital-value word">{gsrWord ?? '–'}</span>
          <span className="vital-note">
            {!fresh ? staleNote
              : cal && !cal.calibrated ? `Mengenali pola Anda (${Math.round(cal.progress_s)} dari ${cal.target_s} detik)`
                : `${val?.ind_gsr ? 'Lebih dari biasanya' : 'Seperti biasanya'}${v?.gsr != null ? ` (indeks ${dec(v.gsr)})` : ''}`}
          </span>
        </div>
        <div className={`vital ${fresh && v?.fall ? 'abn' : ''}`}>
          <span className="vital-label"><Icon name="walk" size={18} stroke={2.4} />Gerakan</span>
          <span className="vital-value word">{moveWord ?? '–'}</span>
          <span className="vital-note">{!fresh ? staleNote : v?.fall ? (critical ? 'Keluarga diberi tahu' : 'Tercatat') : '\u00a0'}</span>
        </div>
      </section>

      <HrTrend nowHr={fresh ? v?.hr : null} />

      {!live.contacts.length && (
        <p className="note-warn">
          Belum ada kontak darurat, jadi saat darurat tidak ada yang dikabari.{' '}
          <Link className="inline-action" href="/kontak">Tambahkan kontak</Link>
        </p>
      )}
      {!live.connected && <p className="offline-note" role="status">Ponsel ini terputus dari server. Menyambung lagi…</p>}
      {critical && callHidden && <StickyCall />}
    </>
  );
}
