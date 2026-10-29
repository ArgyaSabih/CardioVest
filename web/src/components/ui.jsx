'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import Icon from './icons.jsx';

export const STATE_TEXT = {
  NORMAL: { cls: 'normal', icon: 'heart', word: 'Normal', line: 'Jantung Anda sedang dipantau. Tidak ada tanda bahaya.' },
  WARNING: { cls: 'warning', icon: 'alert', word: 'Waspada', line: 'Pola detak jantung Anda tidak biasa. Lakukan ini sekarang:' },
  CRITICAL: { cls: 'critical', icon: 'cross', word: 'Darurat', line: 'Telepon 119 sekarang. Keluarga sudah dikabari beserta lokasi Anda.' },
  UNMONITORED: { cls: 'unmonitored', icon: 'unlinked', word: 'Tidak terpantau', line: 'Alat tidak mengirim data. Jantung Anda sedang tidak dipantau.' },
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

export function displayState(state, connection) {
  const linked = connection === 'online' || connection === 'buffering';
  if (!linked && (state ?? 'NORMAL') === 'NORMAL') return 'UNMONITORED';
  return STATE_TEXT[state] ? state : 'NORMAL';
}

export function StateBanner({ state, connection, sinceTs, lastSeen, children }) {
  const shown = displayState(state, connection);
  const t = STATE_TEXT[shown];
  const linked = connection === 'online' || connection === 'buffering';
  return (
    <section className={`plate plate-${t.cls}`} aria-labelledby="status-word">
      <div className="plate-face" key={shown}>
        <div className="plate-head">
          <span className="plate-icon"><Icon name={t.icon} size={34} stroke={2.6} /></span>
          <h1 className="plate-word" id="status-word" aria-live={shown === 'CRITICAL' ? 'assertive' : 'polite'} aria-atomic="true">{t.word}</h1>
        </div>
        <p className="plate-line">{t.line}</p>
        {!linked && shown !== 'UNMONITORED' && (
          <p className="plate-offline">Alat terputus{lastSeen ? ` sejak ${since(lastSeen)}` : ''}. Status ini yang terakhir diketahui.</p>
        )}
        {children}
        {shown !== 'NORMAL' && shown !== 'UNMONITORED' && sinceTs && <p className="plate-since">Status ini mulai {since(sinceTs)}.</p>}
      </div>
    </section>
  );
}

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

export function SignBar({ icon, title, children, tone = '', as: Tag = 'h1' }) {
  return (
    <header className={`signbar ${tone}`}>
      {icon && <Icon name={icon} size={26} stroke={2.4} />}
      <Tag className="signbar-title">{title}</Tag>
      {children && <div className="signbar-side">{children}</div>}
    </header>
  );
}

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

export function Disclaimer() {
  return (
    <p className="disclaimer" role="note">
      CardioVest adalah prototipe penelitian, bukan alat medis tersertifikasi. Peringatan dari aplikasi adalah
      indikator kewaspadaan, bukan diagnosis. Bila ada nyeri dada, sesak, atau pingsan, langsung{' '}
      <a href="tel:119">telepon 119</a>.
    </p>
  );
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

export function CallButtons({ contacts, ambulance = true, callRef }) {
  return (
    <div className="em-actions">
      {ambulance && (
        <a className="btn em-call" href="tel:119" ref={callRef}>
          <PhoneIcon />Telepon ambulans 119
        </a>
      )}
      {contacts?.length > 0 && (
        <div className="em-contacts">
          {contacts.map((c) => (
            <a key={c.phone} className="btn em-secondary" href={`tel:${c.phone}`}>
              <span>Telepon {c.name}{c.relation ? <span className="rel"> · {c.relation}</span> : null}</span>
            </a>
          ))}
        </div>
      )}
      {ambulance && <a className="em-alt" href="tel:112">Ambulans tidak bisa dihubungi? Telepon 112</a>}
    </div>
  );
}

export function StickyCall() {
  return (
    <a className="sticky-call" href="tel:119">
      <PhoneIcon />Telepon ambulans 119
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

export const END_TEXT = {
  'eskalasi ke CRITICAL': 'meningkat menjadi darurat',
  'berubah ke WARNING': 'turun menjadi waspada',
  'reset tombol fisik': 'direset di alat',
  'reset dari aplikasi web': 'dihentikan dari aplikasi',
  'pulih (histeresis)': 'kembali normal',
};

export const CLASS_TEXT = { Normal: 'Normal', 'Pra-Serangan': 'Pra-serangan', Serangan: 'Serangan' };
