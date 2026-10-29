'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import Icon from './icons.jsx';

// Teks status untuk User Utama (pemakai alat), Tabel 7.1. Satu kalimat pendek per status; tindakan ada
// di tombol. Kata "serangan jantung" tidak dipakai di layar pemakai karena sistem ini bukan alat
// diagnosis (7.3.1).
export const STATE_TEXT = {
  NORMAL: { cls: 'normal', icon: 'heart', word: 'Normal', line: 'Tidak ada tanda bahaya.' },
  WARNING: { cls: 'warning', icon: 'alert', word: 'Waspada', line: 'Detak jantung tidak biasa.' },
  CRITICAL: { cls: 'critical', icon: 'cross', word: 'Darurat', line: 'Keluarga sudah dikabari beserta lokasi Anda.' },
  // bukan state FSM: alat tidak mengirim data, jadi status jantung tidak diketahui
  UNMONITORED: { cls: 'unmonitored', icon: 'unlinked', word: 'Tidak terpantau', line: 'Alat tidak mengirim data.' },
};

export const CONNECTION_TEXT = {
  online: 'Alat terhubung',
  buffering: 'Mengirim data tertunda',
  offline: 'Alat terputus',
  unknown: 'Menunggu alat',
};

export function since(ts) {
  if (!ts) return '';
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 10) return 'baru saja';
  if (s < 60) return 'kurang dari semenit lalu';
  if (s < 3600) return `${Math.floor(s / 60)} menit lalu`;
  if (s < 86400) return `${Math.floor(s / 3600)} jam ${Math.floor((s % 3600) / 60)} menit lalu`;
  return fmtTime(ts);
}

/** Status yang ditampilkan: Normal tanpa data dari alat bukan Normal, melainkan "Tidak terpantau". */
export function displayState(state, connection) {
  const linked = connection === 'online' || connection === 'buffering';
  if (!linked && (state ?? 'NORMAL') === 'NORMAL') return 'UNMONITORED';
  return STATE_TEXT[state] ? state : 'NORMAL';
}

/**
 * Pelat status: seperti papan penunjuk rumah sakit, satu pelat berwarna penuh dengan piktogram dan satu
 * kata. Warna mengikuti LED tiga warna di alat (hijau, kuning, merah). Saat status berubah, pelat
 * "berputar" seperti papan putar (key berubah memicu animasi; mati bila reduced motion).
 */
export function StateBanner({ state, connection, sinceTs, lastSeen, line, children }) {
  const shown = displayState(state, connection);
  const t = STATE_TEXT[shown];
  const linked = connection === 'online' || connection === 'buffering';
  return (
    <section className={`plate plate-${t.cls}`} aria-labelledby="status-word">
      <div className="plate-face" key={shown}>
        <div className="plate-head">
          <span className="plate-icon"><Icon name={t.icon} size={34} stroke={2.6} /></span>
          {/* hanya kata status yang diumumkan pembaca layar; teks waktu berubah tiap 15 detik */}
          <h1 className="plate-word" id="status-word" aria-live={shown === 'CRITICAL' ? 'assertive' : 'polite'} aria-atomic="true">{t.word}</h1>
        </div>
        <p className="plate-line">{line ?? t.line}</p>
        {!linked && shown !== 'UNMONITORED' && (
          <p className="plate-offline">Alat terputus{lastSeen ? ` sejak ${since(lastSeen)}` : ''}.</p>
        )}
        {children}
        {shown !== 'NORMAL' && shown !== 'UNMONITORED' && sinceTs && <p className="plate-since">Mulai {since(sinceTs)}</p>}
      </div>
    </section>
  );
}

/**
 * Penanda koneksi di strip atas Beranda: piktogram + kata, bersudut seperti rambu. Garis EKG kecilnya
 * berdenyut mengikuti denyut pemakai (dibatasi 40–180 bpm) dan diam saat alat tidak terhubung.
 */
export function Connection({ connection, hr }) {
  const linked = connection === 'online' || connection === 'buffering';
  const beat = linked && hr ? `${(60 / Math.min(180, Math.max(40, hr))).toFixed(2)}s` : undefined;
  return (
    <span className={`conn conn-${connection}`} style={beat ? { '--beat': beat } : undefined} role="status">
      <Icon name={linked ? 'ecg' : 'unlinked'} size={22} stroke={2.4} />
      <span className="conn-text">{CONNECTION_TEXT[connection] ?? CONNECTION_TEXT.unknown}</span>
    </span>
  );
}

/** Strip judul halaman: papan penunjuk biru dengan piktogram, menggantikan judul halaman biasa. */
export function SignBar({ icon, title, children, tone = '', as: Tag = 'h1' }) {
  return (
    <header className={`signbar ${tone}`}>
      {icon && <Icon name={icon} size={26} stroke={2.4} />}
      <Tag className="signbar-title">{title}</Tag>
      {children && <div className="signbar-side">{children}</div>}
    </header>
  );
}

/** Tanda merek: garis EKG + nama, dipakai di strip atas Beranda dan halaman masuk. */
export function Wordmark({ small }) {
  return (
    <span className={`wordmark ${small ? 'small' : ''}`}>
      <svg viewBox="0 0 64 24" width={small ? 40 : 64} height={small ? 15 : 24} aria-hidden="true">
        <path d="M1 13h17l4-9 6 17 5-14 3 6h27" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinejoin="round" strokeLinecap="round" />
      </svg>
      CardioVest
    </span>
  );
}

const NAV = [
  ['/', 'Beranda', 'home'],
  ['/riwayat', 'Riwayat', 'clock'],
  ['/kontak', 'Kontak', 'people'],
  ['/akun', 'Akun', 'user'],
];

export function BottomNav() {
  const path = usePathname();
  return (
    <nav className="bottom-nav" aria-label="Navigasi utama">
      {NAV.map(([to, label, icon]) => {
        const active = to === '/' ? path === '/' : path === to || path.startsWith(`${to}/`);
        return (
          <Link key={to} href={to} className={active ? 'active' : ''} aria-current={active ? 'page' : undefined}>
            <Icon name={icon} size={26} stroke={2.2} />
            <span>{label}</span>
          </Link>
        );
      })}
    </nav>
  );
}

/** Disclaimer permanen di halaman aplikasi (Subbab 7.3.1). */
export function Disclaimer() {
  return <p className="disclaimer" role="note">Prototipe penelitian, bukan alat medis tersertifikasi.</p>;
}

export function ErrorNote({ error }) {
  if (!error) return null;
  return (
    <p className="error" role="alert">
      <Icon name="alert" size={22} stroke={2.4} />
      <span>{error}</span>
    </p>
  );
}

export const fmtTime = (d) =>
  new Date(d).toLocaleString('id-ID', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

export const fmtDuration = (s) => {
  if (s == null) return '';
  s = Math.round(s);
  if (s < 60) return `${s} detik`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m} menit` : `${Math.floor(m / 60)} jam ${m % 60} menit`;
};

const PhoneIcon = () => <Icon name="phone" size={24} stroke={2.2} />;

// Kontak utama darurat bila server tidak mengirim datanya (revisi dosen 28-10-2026)
export const DEFAULT_AMBULANCE = { name: 'AmbulanMU Kota Yogyakarta', phone: '+6281319123637' };
const shortName = (n) => n.replace(/\s+Kota Yogyakarta$/, '');
const digits = (p) => {
  const d = String(p).replace(/\D/g, '');
  return d.startsWith('0') ? `62${d.slice(1)}` : d;
};

/**
 * Tautan WhatsApp dengan pesan sudah terisi. Di ponsel dipakai skema whatsapp:// yang langsung membuka
 * aplikasi WhatsApp tanpa halaman perantara; di komputer wa.me.
 */
export function waLink(phone, text) {
  const q = `phone=${digits(phone)}&text=${encodeURIComponent(text)}`;
  const mobile = typeof navigator !== 'undefined' && /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  return mobile ? `whatsapp://send?${q}` : `https://wa.me/${digits(phone)}?text=${encodeURIComponent(text)}`;
}

export const mapsUrl = (g) => `https://www.google.com/maps?q=${g.lat.toFixed(6)},${g.lng.toFixed(6)}`;

/**
 * Tombol darurat, satu ketuk tanpa dialog di aplikasi: telepon AmbulanMU (tombol terbesar), WhatsApp
 * AmbulanMU dengan pesan dan lokasi sudah terisi, lalu telepon keluarga. 119 hanya cadangan.
 * `who` = nama pasien untuk isi pesan; `self` = dibuka oleh pasien sendiri (kalimat orang pertama).
 */
export function CallButtons({ ambulance, contacts, who, self = false, gps, callRef }) {
  const amb = ambulance ?? DEFAULT_AMBULANCE;
  const msg = [
    self ? `DARURAT. Saya ${who} butuh ambulans.` : `DARURAT. ${who} butuh ambulans.`,
    gps ? `Lokasi: ${mapsUrl(gps)}` : null,
  ].filter(Boolean).join('\n');
  return (
    <div className="em-actions">
      <a className="btn em-call" href={`tel:${amb.phone}`} ref={callRef}>
        <PhoneIcon />Telepon {shortName(amb.name)}
      </a>
      <a className="btn em-secondary em-wa" href={waLink(amb.phone, msg)}>
        <Icon name="chat" size={22} stroke={2.2} />WhatsApp {shortName(amb.name)}
      </a>
      {contacts?.length > 0 && (
        <div className="em-contacts">
          {contacts.map((c) => (
            <a key={c.phone} className="btn em-secondary" href={`tel:${c.phone}`}>
              <span>Telepon {c.name}{c.relation ? <span className="rel"> · {c.relation}</span> : null}</span>
            </a>
          ))}
        </div>
      )}
      <a className="em-alt" href="tel:119">Tidak tersambung? Telepon 119</a>
    </div>
  );
}

/** Bilah telepon yang menempel di atas navigasi saat tombol utama sudah tergulir keluar layar. */
export function StickyCall({ ambulance }) {
  const amb = ambulance ?? DEFAULT_AMBULANCE;
  return (
    <a className="sticky-call" href={`tel:${amb.phone}`}>
      <PhoneIcon />Telepon {shortName(amb.name)}
    </a>
  );
}

export function AckList({ acks }) {
  if (!acks?.length) return null;
  return (
    <ul className="acks" aria-label="Kontak yang sudah menerima kabar">
      {acks.map((a) => (
        <li key={`${a.name}-${a.ts}`}>
          <span><strong>{a.name}</strong> sudah menerima kabar</span>
          <span className="muted">{since(a.ts)}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Alasan transisi dari decision engine ditulis untuk tim ("gerbang cross-validation terpenuhi ...").
 * Pemakai dan dokter keluarga cukup membaca versi ini; teks asli tetap tersedia di "Catatan sistem".
 */
export function transitionText(to, reason = '') {
  const r = String(reason);
  const n = r.match(/persisten (\d+)\/(\d+)/);
  if (to === 'WARNING') {
    return n ? `Pola EKG tidak biasa terbaca ${n[1]} kali berturut-turut (sekitar ${Math.round(n[1] * 3.5)} detik).` : 'Pola EKG tidak biasa terbaca beberapa kali berturut-turut.';
  }
  if (to === 'CRITICAL') {
    if (/cross-validation/.test(r)) return 'EKG menunjukkan pola serangan, dan denyut jantung serta keringat ikut abnormal pada saat yang sama.';
    if (/latch|perangkat/.test(r)) return 'Alat sudah dalam kondisi darurat dan cloud mengikutinya.';
    return 'Tanda serangan jantung terdeteksi.';
  }
  if (to === 'NORMAL') {
    if (/jarak jauh/.test(r)) return 'Alarm dihentikan dari aplikasi.';
    if (/reset/.test(r)) return /tidak aktif|tidak terhubung/.test(r) ? 'Tombol reset di alat ditahan saat alat atau server sedang terputus.' : 'Tombol reset di alat ditahan 3 detik.';
    if (/histeresis|persisten/.test(r)) return 'EKG kembali normal beberapa kali berturut-turut.';
    if (/dipulihkan/.test(r)) return 'Status dipulihkan setelah server dinyalakan ulang.';
    return 'Kembali normal.';
  }
  return '';
}

// nilai end_reason yang ditulis layanan cloud -> bahasa pengguna
export const END_TEXT = {
  'eskalasi ke CRITICAL': 'meningkat menjadi darurat',
  'berubah ke WARNING': 'turun menjadi waspada',
  'reset tombol fisik': 'direset di alat',
  'reset dari aplikasi web': 'dihentikan dari aplikasi',
  'pulih (histeresis)': 'kembali normal',
};

export const CLASS_TEXT = { Normal: 'Normal', 'Pra-Serangan': 'Pra-serangan', Serangan: 'Serangan' };
