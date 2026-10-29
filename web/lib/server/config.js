// Semua pengaturan dari variabel lingkungan (lihat README.md).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const env = (k, d = '') => process.env[k] ?? d;

function json(k, fallback) {
  try {
    return JSON.parse(env(k, '')) ?? fallback;
  } catch {
    return fallback;
  }
}

/**
 * Daftar alat yang boleh dipasangkan: "cv-001:482913,cv-002:771204" (ID:kode pairing).
 * Kode pairing tertera di label/QR alat (lihat `npm run alat -- tambah cv-002`). DEVICE_ID +
 * KODE_PAIRING tetap diterima untuk satu alat.
 */
function deviceSeeds() {
  const list = env('DEVICES', '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const [id, code] = s.split(':');
      return { id: id.trim(), code: (code ?? '').trim() };
    });
  if (env('DEVICE_ID') && !list.some((d) => d.id === env('DEVICE_ID'))) list.push({ id: env('DEVICE_ID'), code: env('KODE_PAIRING') });
  return list.filter((d) => /^[A-Za-z0-9_-]{2,32}$/.test(d.id));
}

export const cfg = {
  port: Number(env('PORT', '8080')),
  mqttUrl: env('MQTT_URL', 'mqtt://localhost:1883'),
  mqttUser: env('MQTT_USER'),
  mqttPass: env('MQTT_PASS'),
  cloudDb: env('CLOUD_DB', '/cloud-data/cardiovest.db'),
  dataDir: env('DATA_DIR', './data'),
  publicUrl: env('PUBLIC_URL', '').replace(/\/$/, ''),
  // asal (origin) frontend lain yang boleh membuka Socket.IO, mis. domain Vercel: https://cardiovest.vercel.app
  // kontak utama darurat (revisi dosen 28-10-2026): selalu di urutan pertama, tidak bisa dihapus.
  // Nomor dari pdmjogja.org/ambulanmu (tujuan WhatsApp formulir AmbulanMU Kota Yogyakarta).
  ambulance: env('AMBULANCE_PHONE', '+6281319123637')
    ? { name: env('AMBULANCE_NAME', 'AmbulanMU Kota Yogyakarta'), phone: env('AMBULANCE_PHONE', '+6281319123637') }
    : null,
  // WhatsApp otomatis saat Darurat lewat gateway Fonnte (fonnte.com). Kosong = pesan hanya dicetak ke log.
  fonnteToken: env('FONNTE_TOKEN', ''),
  // rahasia bersama dengan proxy.js di Vercel; kosong = header IP dari Vercel tidak dipercaya
  proxySecret: env('PROXY_SECRET', ''),
  allowedOrigins: env('ALLOWED_ORIGINS', '').split(',').map((s) => s.trim().replace(/\/$/, '')).filter(Boolean),
  devices: deviceSeeds(),
  // tombol "Hentikan alarm" di beranda; 0 = hanya tombol fisik di alat yang bisa menghentikan CRITICAL
  remoteReset: env('REMOTE_RESET', '1') !== '0',
  // kontak awal opsional untuk alat pertama yang dipasangkan: [{"name":"Bu Sari","relation":"istri","phone":"+62812..."}]
  seedContacts: json('CONTACTS_JSON', []).filter((c) => c && c.phone),
  // email verifikasi & reset kata sandi; kosong = tautan dicetak ke log server (mode pengembangan)
  smtpUrl: env('SMTP_URL'),
  mailFrom: env('MAIL_FROM', 'CardioVest <no-reply@cardiovest.local>'),
  vapidSubject: env('VAPID_SUBJECT', 'mailto:admin@cardiovest.local'),
  pushBaseDelayMs: Number(env('PUSH_BASE_DELAY_MS', '1000')),
};

fs.mkdirSync(cfg.dataDir, { recursive: true });

/** Rahasia yang dibuat sekali lalu disimpan di DATA_DIR, supaya token login tetap sah setelah restart. */
function persisted(name, make) {
  const f = path.join(cfg.dataDir, name);
  try {
    return fs.readFileSync(f, 'utf8').trim();
  } catch {
    const v = make();
    fs.writeFileSync(f, v, { mode: 0o600 });
    return v;
  }
}

cfg.jwtSecret = env('WEB_JWT_SECRET') || persisted('jwt_secret', () => crypto.randomBytes(32).toString('hex'));
