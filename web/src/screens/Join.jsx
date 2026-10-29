'use client';
import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { api } from '../api.js';
import { ErrorNote, Wordmark } from '../components/ui.jsx';
import { enablePushForContact, isIos, isStandalone, pushSupported } from '../push.js';

export default function Join() {
  const { code } = useParams();
  const [info, setInfo] = useState(null);
  const [status, setStatus] = useState('idle');
  const [err, setErr] = useState('');

  useEffect(() => {
    api(`/join/${code}`, { auth: false })
      .then((i) => {
        setInfo(i);
        if (i.notifications) setStatus('done');
      })
      .catch((e) => setErr(e.message));
  }, [code]);

  const enable = async () => {
    setErr('');
    setStatus('busy');
    try {
      await enablePushForContact(code);
      setStatus('done');
    } catch (e) {
      setErr(e.message);
      setStatus('idle');
    }
  };
  const test = async () => {
    const r = await api(`/join/${code}/uji`, { method: 'POST', auth: false }).catch((e) => setErr(e.message));
    if (r && !r.delivered) setErr('Notifikasi uji belum sampai. Coba nyalakan ulang notifikasi.');
  };

  return (
    <main className="page login">
      <header className="brand-panel"><Wordmark /></header>
      {err && !info && <p className="error">{err}</p>}
      {info && (
        <>
          <h1>Kontak darurat untuk {info.user_name}</h1>
          <p>
            {info.user_name} mendaftarkan Anda ({info.name}) sebagai kontak darurat CardioVest. Bila alatnya mendeteksi
            kondisi jantung kritis, ponsel ini menerima notifikasi berisi lokasi {info.user_name}, lengkap dengan tombol
            untuk mengabarkan bahwa Anda sudah menerimanya.
          </p>
          {!pushSupported() && isIos() && !isStandalone() && (
            <p className="note-warn">Di iPhone: ketuk Bagikan, lalu pilih “Tambahkan ke Layar Utama”, buka dari ikon itu, lalu buka tautan undangan ini lagi.</p>
          )}
          {status === 'done' ? (
            <>
              <p className="ok big">Notifikasi darurat aktif di ponsel ini.</p>
              <button className="btn wide" onClick={test}>Kirim notifikasi uji</button>
            </>
          ) : (
            <button className="btn primary wide" onClick={enable} disabled={status === 'busy'}>
              {status === 'busy' ? 'Mengaktifkan…' : 'Aktifkan notifikasi darurat'}
            </button>
          )}
          <ErrorNote error={err} />
          <p className="muted small">
            Anda tidak perlu membuat akun. Notifikasi hanya dikirim saat keadaan darurat. Data Anda yang disimpan hanya
            nama dan nomor yang didaftarkan {info.user_name}.
          </p>
        </>
      )}
    </main>
  );
}
