'use client';
import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { ErrorNote, SignBar } from '../components/ui.jsx';

const empty = { name: '', phone: '', relation: '' };
const fullUrl = (u) => (u.startsWith('http') ? u : `${window.location.origin}${u}`);

export default function Contacts() {
  const [list, setList] = useState(null);
  const [form, setForm] = useState(empty);
  const [editing, setEditing] = useState(null);
  const [err, setErr] = useState('');
  const [note, setNote] = useState('');
  const [copied, setCopied] = useState(null);
  const [confirm, setConfirm] = useState(null);

  const load = () => api('/contacts').then(setList).catch((e) => setErr(e.message));
  useEffect(() => {
    load();
  }, []);

  const save = async (e) => {
    e.preventDefault();
    setErr('');
    setNote('');
    try {
      const r = editing === 'new'
        ? await api('/contacts', { method: 'POST', body: form, queueable: true })
        : await api(`/contacts/${editing}`, { method: 'PUT', body: form, queueable: true });
      if (r?.queued) setNote('Sedang offline. Perubahan disimpan dan dikirim otomatis begitu ada koneksi.');
      setEditing(null);
      setForm(empty);
      load();
    } catch (e2) {
      setErr(e2.message);
    }
  };

  const remove = async (c) => {
    setConfirm(null);
    const r = await api(`/contacts/${c.id}`, { method: 'DELETE', queueable: true }).catch((e) => setErr(e.message));
    if (r?.queued) setNote('Sedang offline. Penghapusan dikirim otomatis begitu ada koneksi.');
    load();
  };

  const share = async (c) => {
    const text = `Halo ${c.name}, saya mendaftarkan Anda sebagai kontak darurat CardioVest. Buka tautan ini lalu izinkan notifikasi, supaya Anda dikabari beserta lokasi saya bila kondisi jantung saya kritis: ${fullUrl(c.invite_url)}`;
    if (navigator.share) {
      navigator.share({ text }).catch(() => {});
    } else {
      await navigator.clipboard?.writeText(text);
      setCopied(c.id);
    }
  };

  const renew = async (c) => {
    setConfirm(null);
    await api(`/contacts/${c.id}/undangan-baru`, { method: 'POST' }).catch((e) => setErr(e.message));
    load();
  };

  const formEl = (
    <form className={editing === 'new' ? 'form block' : 'form'} onSubmit={save}>
      <label>Nama<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required minLength={2} /></label>
      <label>Nomor HP<input type="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="+6281234567890" required /></label>
      <label>Hubungan<input value={form.relation} onChange={(e) => setForm({ ...form, relation: e.target.value })} placeholder="Anak, pasangan, tetangga…" /></label>
      <ErrorNote error={err} />
      <div className="row">
        <button className="btn primary">{editing === 'new' ? 'Simpan kontak' : 'Simpan perubahan'}</button>
        <button type="button" className="btn ghost" onClick={() => { setEditing(null); setErr(''); }}>Batal</button>
      </div>
    </form>
  );

  const status = (c) => {
    if (c.notifications) return { on: true, text: 'Notifikasi darurat aktif di ponselnya' };
    if (c.joined) return { on: false, text: 'Sudah membuka undangan, tapi notifikasinya belum dinyalakan' };
    return { on: false, text: 'Belum membuka undangan' };
  };

  return (
    <>
      <SignBar icon="people" title="Kontak darurat" />
      <p className="muted">
        Saat status Darurat, semua orang di sini dikabari beserta lokasi Anda. Mereka tidak perlu membuat akun,
        cukup membuka undangan sekali dan menyalakan notifikasi.
      </p>
      {note && <p className="note-info">{note}</p>}
      {list === null && !err && <p className="muted">Memuat kontak…</p>}
      {list?.length === 0 && editing === null && (
        <p className="empty"><strong>Belum ada kontak darurat.</strong>Pilih orang yang paling cepat bisa datang, misalnya keluarga serumah atau tetangga.</p>
      )}
      <ul className="contacts">
        {list?.map((c) => {
          if (editing === c.id) return <li key={c.id} className="contact">{formEl}</li>;
          const st = status(c);
          return (
            <li key={c.id} className="contact">
              <div>
                <div className="contact-name">{c.name}{c.relation && <span> · {c.relation}</span>}</div>
                <div className="contact-phone">{c.phone}</div>
                <div className={`status-line ${st.on ? 'on' : 'off'}`}>{st.text}</div>
              </div>
              {confirm?.id === c.id ? (
                <div className={`confirm ${confirm.kind === 'tautan' ? 'neutral' : ''}`} role="group" aria-label="Konfirmasi">
                  <p>
                    {confirm.kind === 'hapus'
                      ? `Hapus ${c.name}? Ponselnya tidak akan dikabari lagi saat darurat.`
                      : `Buat tautan undangan baru untuk ${c.name}? Tautan lama berhenti berlaku, dan ${c.name} perlu membuka tautan baru untuk menyalakan notifikasi lagi.`}
                  </p>
                  <div className="row">
                    {confirm.kind === 'hapus'
                      ? <button className="btn small danger solid" onClick={() => remove(c)}>Hapus {c.name}</button>
                      : <button className="btn small primary" onClick={() => renew(c)}>Buat tautan baru</button>}
                    <button className="text-btn" onClick={() => setConfirm(null)}>Batal</button>
                  </div>
                </div>
              ) : (
                <div className="contact-actions">
                  <button className={`btn small ${st.on ? '' : 'primary'}`} onClick={() => share(c)}>
                    {copied === c.id ? 'Pesan undangan disalin' : st.on ? 'Kirim ulang undangan' : 'Kirim undangan'}
                  </button>
                  <button className="text-btn" onClick={() => { setEditing(c.id); setForm({ name: c.name, phone: c.phone, relation: c.relation || '' }); }}>Ubah</button>
                  <button className="text-btn" onClick={() => setConfirm({ id: c.id, kind: 'tautan' })}>Tautan baru</button>
                  <button className="text-btn danger" onClick={() => setConfirm({ id: c.id, kind: 'hapus' })}>Hapus</button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {editing === 'new' ? formEl : list && list.length < 5 && editing === null && (
        <button className="btn wide" onClick={() => { setEditing('new'); setForm(empty); }}>Tambah kontak</button>
      )}
      {list?.length >= 5 && <p className="muted small">Sudah 5 kontak, batas maksimal. Hapus salah satu untuk menambah yang baru.</p>}
      {editing === null && <ErrorNote error={err} />}
      <p className="muted small block">
        Bila internet di alat putus saat darurat, alat mengirim SMS sendiri lewat kartu SIM-nya. Nomor tujuan SMS
        itu disetel saat alat dipasang, terpisah dari daftar ini, jadi pastikan isinya sama.
      </p>
    </>
  );
}
