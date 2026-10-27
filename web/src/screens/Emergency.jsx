'use client';
// Halaman 6: tampilan notifikasi Critical untuk kontak darurat (F-APP-5, F-APP-7). Dibuka dari notifikasi
// atau tautan yang dibagikan, tanpa akun. Parameter ?k=<kode undangan> menandai siapa yang membuka,
// sehingga tombol "Saya sudah menerima kabar ini" tercatat atas nama kontak tersebut.
import { useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import { io } from 'socket.io-client';
import { REALTIME_URL, api } from '../api.js';
import { LocationMap, mapsLink } from '../components/map.jsx';
import Icon from '../components/icons.jsx';
import { AckList, CallButtons, ErrorNote, Wordmark, since } from '../components/ui.jsx';

export default function Emergency() {
  const { token } = useParams();
  const params = useSearchParams();
  const k = params.get('k');
  const [ev, setEv] = useState(null);
  const [err, setErr] = useState('');
  const [name, setName] = useState('');
  const [acking, setAcking] = useState(false);
  const [, tick] = useState(0);

  useEffect(() => {
    const load = () => api(`/public/${token}${k ? `?k=${encodeURIComponent(k)}` : ''}`, { auth: false }).then(setEv).catch((e) => setErr(e.message));
    load();
    const poll = setInterval(load, 20_000);
    const t = setInterval(() => tick((x) => x + 1), 5_000);
    const s = io(REALTIME_URL, { path: '/data/realtime', auth: { publicToken: token }, transports: ['websocket', 'polling'] });
    s.on('location', (p) => setEv((e) => (e ? { ...e, location: p, trail: [...(e.trail || []), p] } : e)));
    s.on('fall', () => setEv((e) => (e ? { ...e, fall_detected: true } : e)));
    s.on('state', () => load());
    s.on('ack', (p) => setEv((e) => (e ? { ...e, acks: p.acks } : e)));
    s.on('online', (p) => setEv((e) => (e ? { ...e, device_online: p.online } : e)));
    return () => {
      clearInterval(poll);
      clearInterval(t);
      s.disconnect();
    };
  }, [token, k]);

  const ack = async () => {
    setAcking(true);
    try {
      const r = await api(`/public/${token}/ack`, { method: 'POST', auth: false, body: k ? { k } : { name } });
      setEv((e) => ({ ...e, acks: r.acks }));
    } catch (e) {
      setErr(e.message);
    } finally {
      setAcking(false);
    }
  };

  if (err && !ev) return <main className="page"><p className="error">{err}</p></main>;
  if (!ev) return <main className="page center muted">Memuat…</main>;

  const active = ev.active;
  const who = ev.user_name;
  const loc = ev.location;
  const myName = ev.me?.name;
  const iAcked = ev.acks?.some((a) => a.name === (myName || name.trim()));
  return (
    <main className={`page emergency ${active ? 'is-active' : 'is-ended'}`}>
      <header className="signbar brand"><Wordmark small /><span className="signbar-side">Kabar darurat</span></header>
      <section className={`plate ${active ? 'plate-critical' : 'plate-ended'}`}>
        <div className="plate-head">
          <span className="plate-icon"><Icon name={active ? 'cross' : 'check'} size={34} stroke={2.6} /></span>
          <h1 className="plate-word long">{active ? `${who} butuh pertolongan` : `Keadaan darurat ${who} sudah diakhiri`}</h1>
        </div>
        <p className="plate-line">
          {active
            ? `CardioVest mendeteksi tanda bahaya pada jantung ${who} ${since(ev.started_at)}. EKG, denyut jantung, dan keringatnya sama-sama tidak biasa.`
            : `${ev.end_reason === 'reset dari aplikasi web' ? 'Alarm dihentikan dari aplikasi' : 'Tombol reset di alat ditekan'} ${since(ev.ended_at)}. Pastikan ${who} sudah mendapat pertolongan.`}
        </p>
        {ev.fall_detected && active && <p className="plate-flag">Sensor gerak mencatat {who} terjatuh.</p>}
      </section>

      {active && (
        <section className="ack-box">
          {iAcked ? (
            <p className="ok">Terima kasih{myName ? `, ${myName}` : ''}. {who} dan kontak lain bisa melihat bahwa Anda sudah menerima kabar ini.</p>
          ) : (
            <>
              {!myName && (
                <label className="form">Nama Anda<input value={name} onChange={(e) => setName(e.target.value)} placeholder="mis. Bu Sari" /></label>
              )}
              <button className="btn primary wide" onClick={ack} disabled={acking || (!myName && name.trim().length < 2)}>
                {acking ? 'Mengirim…' : 'Saya sudah menerima kabar ini'}
              </button>
            </>
          )}
          <AckList acks={ev.acks} />
        </section>
      )}

      {active && <CallButtons contacts={ev.user_phone ? [{ name: who, phone: ev.user_phone }] : []} />}

      <section className="block">
        <h2>Lokasi {active ? 'terkini' : 'terakhir'}</h2>
        {loc ? (
          <>
            <LocationMap lat={loc.lat} lng={loc.lng} acc={loc.acc} trail={ev.trail} height={320} />
            <a className="btn primary wide" href={mapsLink(loc.lat, loc.lng)} target="_blank" rel="noreferrer">Petunjuk arah di Google Maps</a>
            <p className="muted small">
              {loc.acc ? `Akurasi sekitar ${Math.round(loc.acc)} m. ` : ''}
              {loc.ts ? `Diperbarui ${since(loc.ts)}.` : ''}
            </p>
          </>
        ) : (
          <p className="muted">GPS alat sedang mencari sinyal satelit. Peta muncul begitu koordinat diterima. Di dalam gedung, GPS bisa butuh beberapa menit.</p>
        )}
      </section>

      <ErrorNote error={err} />
      <p className="muted small">
        {ev.device_online === false
          ? 'Alat sedang tidak terhubung ke internet. Bila putus lebih dari 30 detik, alat mengirim SMS berisi lokasi terakhir.'
          : 'Alat terhubung ke server.'}
        {ev.hr ? ` Denyut terakhir ${Math.round(ev.hr)} bpm.` : ''}
      </p>
      <p className="disclaimer">CardioVest adalah prototipe penelitian, bukan alat medis tersertifikasi. Selalu hubungi layanan gawat darurat.</p>
    </main>
  );
}
