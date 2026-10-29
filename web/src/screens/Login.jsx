'use client';
// Halaman 1: Masuk / Daftar (F-APP-1), plus lupa kata sandi, atur ulang, dan verifikasi email.
import { useEffect, useState } from 'react';
import { useDispatch } from 'react-redux';
import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { DEMO, api, getToken, setToken } from '../api.js';
import { startSession } from '../session.js';
import { ErrorNote, Wordmark } from '../components/ui.jsx';

function Brand({ children }) {
  return (
    <header className="brand-panel">
      <h1><Wordmark /></h1>
      {children}
    </header>
  );
}

export default function Login() {
  const [tab, setTab] = useState('masuk');
  const [f, setF] = useState({ name: '', email: '', phone: '', password: '', confirm: '', consent: false });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const dispatch = useDispatch();
  const router = useRouter();
  // ?dari= diisi penjaga halaman privat; hanya jalur di aplikasi ini yang diterima
  const dari = useSearchParams().get('dari');
  const from = dari?.startsWith('/') && !dari.startsWith('//') ? dari : '/';
  const loggedIn = !!getToken();
  useEffect(() => {
    if (loggedIn) router.replace(from);
  }, [loggedIn, from, router]);
  if (loggedIn) return null;

  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  const submit = async (e) => {
    e.preventDefault();
    setErr('');
    if (tab === 'daftar' && f.password !== f.confirm) return setErr('Konfirmasi kata sandi tidak sama.');
    setBusy(true);
    try {
      const r = tab === 'masuk'
        ? await api('/auth/login', { method: 'POST', auth: false, body: { email: f.email, password: f.password } })
        : await api('/auth/signup', { method: 'POST', auth: false, body: { name: f.name, email: f.email, phone: f.phone || undefined, password: f.password, consent: f.consent } });
      setToken(r.token);
      const me = await startSession(dispatch);
      router.replace(me.device ? from : '/pasangkan');
    } catch (e2) {
      setErr(e2.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="page login">
      <Brand>
        <p className="muted">Kaos pemantau jantung yang mengabari keluarga saat darurat.</p>
      </Brand>
      {DEMO && (
        <p className="note-info">Mode demo: daftar dengan email apa saja. Alat <strong>cv-001</strong>, kode <strong>482913</strong>.</p>
      )}
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'masuk'} onClick={() => { setTab('masuk'); setErr(''); }}>Masuk</button>
        <button role="tab" aria-selected={tab === 'daftar'} onClick={() => { setTab('daftar'); setErr(''); }}>Daftar</button>
      </div>
      <form onSubmit={submit} className="form">
        {tab === 'daftar' && (
          <label>Nama lengkap<input value={f.name} onChange={set('name')} autoComplete="name" required minLength={2} /></label>
        )}
        <label>Email<input type="email" value={f.email} onChange={set('email')} autoComplete="email" required /></label>
        {tab === 'daftar' && (
          <label>
            Nomor HP <span className="muted small">(opsional)</span>
            <input type="tel" value={f.phone} onChange={set('phone')} placeholder="+6281234567890" autoComplete="tel" />
          </label>
        )}
        <label>
          Kata sandi
          <input type="password" value={f.password} onChange={set('password')} autoComplete={tab === 'masuk' ? 'current-password' : 'new-password'} required minLength={tab === 'daftar' ? 8 : 1} />
        </label>
        {tab === 'daftar' && (
          <>
            <label>Ulangi kata sandi<input type="password" value={f.confirm} onChange={set('confirm')} autoComplete="new-password" required /></label>
            <label className="consent">
              <input type="checkbox" checked={f.consent} onChange={set('consent')} required />
              <span>
                Saya setuju data kesehatan dan lokasi saya diproses, dan dikirim ke AmbulanMU serta kontak darurat saat
                darurat (UU No. 27/2022).
              </span>
            </label>
          </>
        )}
        <ErrorNote error={err} />
        <button className="btn primary" disabled={busy}>{busy ? 'Memproses…' : tab === 'masuk' ? 'Masuk' : 'Buat akun'}</button>
        {tab === 'masuk' && <Link href="/lupa-sandi" className="link">Lupa kata sandi?</Link>}
      </form>
      <p className="disclaimer">Prototipe penelitian, bukan alat medis tersertifikasi.</p>
    </main>
  );
}

export function Forgot() {
  const [email, setEmail] = useState('');
  const [done, setDone] = useState(false);
  const [err, setErr] = useState('');
  const submit = async (e) => {
    e.preventDefault();
    try {
      await api('/auth/forgot', { method: 'POST', auth: false, body: { email } });
      setDone(true);
    } catch (e2) {
      setErr(e2.message);
    }
  };
  return (
    <main className="page login">
      <Brand />
      <h2>Lupa kata sandi</h2>
      {done ? (
        <p className="ok">Bila email terdaftar, tautan sudah dikirim. Cek juga folder spam.</p>
      ) : (
        <form className="form" onSubmit={submit}>
          <label>Email akun<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" /></label>
          <ErrorNote error={err} />
          <button className="btn primary">Kirim tautan</button>
        </form>
      )}
      <Link href="/masuk" className="link">Kembali ke halaman masuk</Link>
    </main>
  );
}

export function ResetPassword() {
  const { token } = useParams();
  const [pw, setPw] = useState('');
  const [err, setErr] = useState('');
  const dispatch = useDispatch();
  const router = useRouter();
  const submit = async (e) => {
    e.preventDefault();
    try {
      const r = await api('/auth/reset', { method: 'POST', auth: false, body: { token, password: pw } });
      setToken(r.token);
      const me = await startSession(dispatch);
      router.replace(me.device ? '/' : '/pasangkan');
    } catch (e2) {
      setErr(e2.message);
    }
  };
  return (
    <main className="page login">
      <Brand />
      <h2>Buat kata sandi baru</h2>
      <form className="form" onSubmit={submit}>
        <label>Kata sandi baru<input type="password" value={pw} onChange={(e) => setPw(e.target.value)} minLength={8} required autoComplete="new-password" /></label>
        <ErrorNote error={err} />
        <button className="btn primary">Simpan dan masuk</button>
      </form>
    </main>
  );
}

export function Verify() {
  const { token } = useParams();
  const [state, setState] = useState('busy');
  const [err, setErr] = useState('');
  useEffect(() => {
    api('/auth/verify', { method: 'POST', auth: false, body: { token } })
      .then(() => setState('ok'))
      .catch((e) => {
        setErr(e.message);
        setState('err');
      });
  }, [token]);
  return (
    <main className="page login">
      <Brand />
      {state === 'busy' && <p className="muted">Memverifikasi…</p>}
      {state === 'ok' && <p className="ok big">Email terverifikasi. Terima kasih.</p>}
      {state === 'err' && <ErrorNote error={err} />}
      <Link href="/" className="btn primary wide">Buka CardioVest</Link>
    </main>
  );
}
