'use client';
import { useEffect, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { useRouter } from 'next/navigation';
import { api } from '../api.js';
import { startSession } from '../session.js';
import Icon from '../components/icons.jsx';
import { ErrorNote, SignBar, fmtTime } from '../components/ui.jsx';
import { currentSubscription, disablePush, enablePush, isIos, isStandalone, pushSupported } from '../push.js';
import { authActions } from '../store.js';

function Section({ title, icon, children }) {
  return (
    <section className="group">
      <h2 className="group-title">{icon && <Icon name={icon} size={22} stroke={2.4} />}{title}</h2>
      {children}
    </section>
  );
}

export default function Account() {
  const { user, device, emailConfigured } = useSelector((s) => s.auth);
  const dispatch = useDispatch();
  const router = useRouter();
  const [profile, setProfile] = useState({ name: user.name, phone: user.phone || '' });
  const [pw, setPw] = useState({ current_password: '', password: '' });
  const [sub, setSub] = useState(null);
  const [msg, setMsg] = useState({});
  const [err, setErr] = useState({});
  const [busy, setBusy] = useState(false);
  const [unpairing, setUnpairing] = useState(false);
  const [unpairPw, setUnpairPw] = useState('');

  useEffect(() => {
    currentSubscription().then(setSub).catch(() => {});
  }, []);

  const run = (key, fn) => async (e) => {
    e?.preventDefault?.();
    setErr({ ...err, [key]: '' });
    setMsg({ ...msg, [key]: '' });
    setBusy(true);
    try {
      const m = await fn();
      if (m) setMsg((x) => ({ ...x, [key]: m }));
    } catch (e2) {
      setErr((x) => ({ ...x, [key]: e2.message }));
    } finally {
      setBusy(false);
    }
  };

  const saveProfile = run('profil', async () => {
    const r = await api('/users/me', { method: 'PUT', body: profile });
    dispatch(authActions.user(r.user));
    return 'Profil disimpan.';
  });
  const savePw = run('sandi', async () => {
    await api('/users/me', { method: 'PUT', body: { ...profile, ...pw } });
    setPw({ current_password: '', password: '' });
    return 'Kata sandi diganti.';
  });
  const resend = run('email', async () => {
    await api('/auth/verify/kirim-ulang', { method: 'POST' });
    return emailConfigured ? 'Email verifikasi dikirim ulang. Periksa juga folder spam.' : 'Server belum dikonfigurasi untuk mengirim email; tautan verifikasi dicetak di log server.';
  });
  const pushOn = run('notif', async () => {
    setSub(await enablePush());
    return 'Notifikasi aktif di ponsel ini.';
  });
  const pushOff = run('notif', async () => {
    await disablePush();
    setSub(null);
    return 'Notifikasi dimatikan untuk ponsel ini.';
  });
  const pushTest = run('notif', async () => {
    const r = await api('/push/test', { method: 'POST' });
    return `Notifikasi uji terkirim ke ${r.delivered} dari ${r.recipients} ponsel Anda.`;
  });
  const unpair = run('alat', async () => {
    await api('/devices/pair', { method: 'DELETE', body: { password: unpairPw } });
    setUnpairPw('');
    setUnpairing(false);
    await startSession(dispatch);
    router.replace('/pasangkan');
    return null;
  });

  return (
    <>
      <SignBar icon="user" title="Akun" />

      <Section title="Notifikasi di ponsel ini" icon="bell">
        <p className="muted">Status Waspada hanya dikabarkan ke Anda. Status Darurat dikabarkan ke Anda dan semua kontak darurat.</p>
        {!pushSupported() && isIos() && !isStandalone() && (
          <p className="note-warn">Di iPhone: ketuk Bagikan, lalu pilih “Tambahkan ke Layar Utama”, lalu buka CardioVest dari ikon itu.</p>
        )}
        {sub ? (
          <div className="row">
            <span className="ok">Aktif</span>
            <button className="btn small" onClick={pushTest} disabled={busy}>Coba kirim</button>
            <button className="text-btn danger" onClick={pushOff} disabled={busy}>Matikan</button>
          </div>
        ) : (
          <button className="btn primary" onClick={pushOn} disabled={busy}>Nyalakan notifikasi</button>
        )}
        {msg.notif && <p className="ok">{msg.notif}</p>}
        <ErrorNote error={err.notif} />
      </Section>

      <Section title="Alat" icon="device">
        {device ? (
          <>
            <dl className="facts">
              <dt>ID alat</dt><dd>{device.device_id}</dd>
              <dt>Dipasangkan</dt><dd>{fmtTime(device.paired_ts)}</dd>
            </dl>
            {unpairing ? (
              <form className="confirm form" onSubmit={unpair}>
                <p>Setelah dilepas, aplikasi ini berhenti menampilkan data alat dan kontak tidak dikabari lagi. Masukkan kata sandi untuk melanjutkan.</p>
                <label>Kata sandi<input type="password" value={unpairPw} onChange={(e) => setUnpairPw(e.target.value)} autoComplete="current-password" required autoFocus /></label>
                <div className="row">
                  <button className="btn small danger solid" disabled={busy || !unpairPw}>Lepas alat</button>
                  <button type="button" className="text-btn" onClick={() => { setUnpairing(false); setUnpairPw(''); }}>Batal</button>
                </div>
              </form>
            ) : (
              <button className="text-btn danger" onClick={() => setUnpairing(true)}>Lepas alat dari akun</button>
            )}
          </>
        ) : (
          <button className="btn primary" onClick={() => router.push('/pasangkan')}>Pasangkan alat</button>
        )}
        <ErrorNote error={err.alat} />
      </Section>

      <Section title="Profil" icon="user">
        <form className="form" onSubmit={saveProfile}>
          <label>Nama<input value={profile.name} onChange={(e) => setProfile({ ...profile, name: e.target.value })} required minLength={2} /></label>
          <label>Nomor HP<input type="tel" value={profile.phone} onChange={(e) => setProfile({ ...profile, phone: e.target.value })} placeholder="+6281234567890" /></label>
          <p className="muted small">Email: {user.email} · {user.email_verified ? <span className="ok">terverifikasi</span> : <span className="warn">belum diverifikasi</span>}</p>
          {!user.email_verified && <button type="button" className="btn small" onClick={resend} disabled={busy}>Kirim ulang email verifikasi</button>}
          {msg.email && <p className="muted small">{msg.email}</p>}
          <ErrorNote error={err.email} />
          <button className="btn primary" disabled={busy}>Simpan profil</button>
          {msg.profil && <p className="ok">{msg.profil}</p>}
          <ErrorNote error={err.profil} />
        </form>
      </Section>

      <Section title="Kata sandi" icon="lock">
        <form className="form" onSubmit={savePw}>
          <label>Kata sandi sekarang<input type="password" value={pw.current_password} onChange={(e) => setPw({ ...pw, current_password: e.target.value })} autoComplete="current-password" required /></label>
          <label>Kata sandi baru<input type="password" value={pw.password} onChange={(e) => setPw({ ...pw, password: e.target.value })} autoComplete="new-password" minLength={8} required /></label>
          <button className="btn" disabled={busy}>Ganti kata sandi</button>
          {msg.sandi && <p className="ok">{msg.sandi}</p>}
          <ErrorNote error={err.sandi} />
        </form>
      </Section>

      {!isStandalone() && (
        <Section title="Pasang di layar utama" icon="download">
          <p className="muted">
            Dari layar utama, CardioVest terbuka seperti aplikasi biasa dan lebih cepat dibuka saat darurat.{' '}
            {isIos() ? 'Di Safari: ketuk Bagikan, lalu pilih Tambahkan ke Layar Utama.' : 'Di Chrome: buka menu titik tiga, lalu pilih Tambahkan ke layar utama.'}
          </p>
        </Section>
      )}

      <div className="group-end">
        <button className="btn wide" onClick={() => window.dispatchEvent(new Event('cv:logout'))}>Keluar dari akun</button>
        <p className="muted small" style={{ marginTop: 12 }}>Anda menyetujui pemrosesan data kesehatan pada {user.consent_ts ? fmtTime(user.consent_ts) : '-'}.</p>
      </div>
    </>
  );
}
