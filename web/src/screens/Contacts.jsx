'use client';
// Halaman 3: Manajemen kontak darurat (F-APP-4). AmbulanMU selalu menjadi kontak utama (revisi dosen
// 28-10-2026) dan tidak bisa dihapus; di bawahnya maksimal 5 kontak keluarga. Perubahan saat offline
// diantrekan Service Worker (Background Sync) dan dikirim otomatis begitu ada koneksi.
import { useEffect, useState } from 'react';
import { useSelector } from 'react-redux';
import { api } from '../api.js';
import Icon from '../components/icons.jsx';
import { DEFAULT_AMBULANCE, ErrorNote, SignBar } from '../components/ui.jsx';

const empty = { name: '', phone: '', relation: '' };
const fullUrl = (u) => (u.startsWith('http') ? u : `${window.location.origin}${u}`);

export default function Contacts() {
  const { ambulance, whatsapp } = useSelector((s) => s.auth);
  const amb = ambulance ?? DEFAULT_AMBULANCE;
  const [list, setList] = useState(null);
  const [form, setForm] = useState(empty);
  const [editing, setEditing] = useState(null); // id | 'new' | null
  const [err, setErr] = useState('');
  const [note, setNote] = useState('');
  const [copied, setCopied] = useState(null);
  const [confirm, setConfirm] = useState(null); // { id, kind: 'hapus' | 'tautan' }

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
      if (r?.queued) setNote('Offline. Perubahan dikirim begitu ada koneksi.');
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
    if (r?.queued) setNote('Offline. Penghapusan dikirim begitu ada koneksi.');
    load();
  };

  const share = async (c) => {
    const text = `Halo ${c.name}, Anda saya daftarkan sebagai kontak darurat CardioVest. Buka tautan ini dan izinkan notifikasi supaya dikabari beserta lokasi saya saat darurat: ${fullUrl(c.invite_url)}`;
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
      {editing !== 'new' && editing !== null && (
        <button type="button" className="text-btn" onClick={() => setConfirm({ id: editing, kind: 'tautan' })}>Buat tautan undangan baru</button>
      )}
    </form>
  );

  const renewBox = (c) => (
    <div className="confirm neutral" role="group" aria-label="Konfirmasi">
      <p>Tautan lama {c.name} berhenti berlaku.</p>
      <div className="row">
        <button className="btn small primary" onClick={() => { renew(c); setEditing(null); }}>Buat tautan baru</button>
        <button className="text-btn" onClick={() => setConfirm(null)}>Batal</button>
      </div>
    </div>
  );

  const status = (c) => {
    if (c.notifications) return { on: true, text: 'Notifikasi aktif' };
    if (c.joined) return { on: false, text: 'Notifikasi belum dinyalakan' };
    return { on: false, text: 'Undangan belum dibuka' };
  };

  return (
    <>
      <SignBar icon="people" title="Kontak darurat" />
      {note && <p className="note-info">{note}</p>}
      <ul className="contacts">
        <li className="contact contact-main">
          <div>
            <div className="contact-tag">Kontak utama</div>
            <div className="contact-name">{amb.name}</div>
            <div className="contact-phone">{amb.phone}</div>
            <div className={`status-line ${whatsapp ? 'on' : 'off'}`}>
              {whatsapp ? 'Dikabari otomatis lewat WhatsApp saat Darurat' : 'Ditelepon dari tombol Darurat'}
            </div>
          </div>
          <div className="contact-actions">
            <a className="btn small" href={`tel:${amb.phone}`}><Icon name="phone" size={20} />Telepon</a>
          </div>
        </li>
        {list?.map((c) => {
          if (editing === c.id) return <li key={c.id} className="contact">{confirm?.id === c.id ? null : formEl}{confirm?.id === c.id && renewBox(c)}</li>;
          const st = status(c);
          return (
            <li key={c.id} className="contact">
              <div>
                <div className="contact-name">{c.name}{c.relation && <span> · {c.relation}</span>}</div>
                <div className="contact-phone">{c.phone}</div>
                <div className={`status-line ${st.on ? 'on' : 'off'}`}>{st.text}</div>
              </div>
              {confirm?.id === c.id ? (
                <div className="confirm" role="group" aria-label="Konfirmasi">
                  <p>Hapus {c.name}?</p>
                  <div className="row">
                    <button className="btn small danger solid" onClick={() => remove(c)}>Hapus</button>
                    <button className="text-btn" onClick={() => setConfirm(null)}>Batal</button>
                  </div>
                </div>
              ) : (
                <div className="contact-actions">
                  <button className={`btn small ${st.on ? '' : 'primary'}`} onClick={() => share(c)}>
                    {copied === c.id ? 'Undangan disalin' : st.on ? 'Kirim ulang undangan' : 'Kirim undangan'}
                  </button>
                  <button className="text-btn" onClick={() => { setConfirm(null); setEditing(c.id); setForm({ name: c.name, phone: c.phone, relation: c.relation || '' }); }}>Ubah</button>
                  <button className="text-btn danger" onClick={() => setConfirm({ id: c.id, kind: 'hapus' })}>Hapus</button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {list === null && !err && <p className="muted">Memuat…</p>}
      {editing === 'new' ? formEl : list && list.length < 5 && editing === null && (
        <button className="btn wide" onClick={() => { setEditing('new'); setForm(empty); }}><Icon name="plus" />Tambah kontak keluarga</button>
      )}
      {list?.length >= 5 && <p className="muted small">Maksimal 5 kontak keluarga.</p>}
      {editing === null && <ErrorNote error={err} />}
    </>
  );
}
