// WhatsApp otomatis saat Darurat (revisi dosen 28-10-2026). Website tidak boleh menelepon tanpa sentuhan
// pengguna, jadi bantuan dipanggil dari server: begitu status CRITICAL, AmbulanMU dan semua kontak
// darurat langsung menerima pesan WhatsApp berisi nama, waktu, nomor, dan lokasi, tanpa ada yang menekan
// apa pun.
//
// Pengiriman lewat gateway Fonnte (https://docs.fonnte.com): POST https://api.fonnte.com/send dengan
// header Authorization = token perangkat, body target + message. Token dari dashboard Fonnte setelah
// nomor WhatsApp pengirim dihubungkan, diisi ke FONNTE_TOKEN. Tanpa token, pesan hanya dicetak ke log
// dan tercatat "belum aktif" di riwayat, supaya kelihatan apa yang akan terkirim.
import { cfg } from './config.js';
import { backoff } from './push.js';
import { notifLog } from './store.js';

const MAX_ATTEMPTS = 5;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const waConfigured = () => !!cfg.fonnteToken;

/** 0812..., +62812..., 62812... -> 62812... (format yang diterima WhatsApp). */
export const waNumber = (phone) => {
  const d = String(phone ?? '').replace(/\D/g, '');
  return d.startsWith('0') ? `62${d.slice(1)}` : d;
};

async function fonnte(target, message) {
  let res;
  try {
    res = await fetch('https://api.fonnte.com/send', {
      method: 'POST',
      headers: { Authorization: cfg.fonnteToken },
      body: new URLSearchParams({ target, message, countryCode: '62' }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    throw Object.assign(new Error(`jaringan: ${e.message}`), { retry: true });
  }
  const data = await res.json().catch(() => ({}));
  if (res.ok && data.status === true) return;
  throw Object.assign(new Error(data.reason || `HTTP ${res.status}`), { retry: res.status === 429 || res.status >= 500 });
}

let sender = fonnte;
/** Hanya untuk uji: ganti pengirim WhatsApp. */
export const _setWaSender = (fn) => {
  sender = fn;
};

async function sendOne(target, message) {
  for (let n = 0; n < MAX_ATTEMPTS; n++) {
    try {
      await sender(target, message);
      return { ok: true, attempts: n + 1 };
    } catch (e) {
      if (!e.retry || n === MAX_ATTEMPTS - 1) return { ok: false, attempts: n + 1, error: e.message };
      await sleep(backoff(n));
    }
  }
  return { ok: false, attempts: MAX_ATTEMPTS, error: 'gagal' };
}

/**
 * Kirim satu pesan per penerima. recipients: [{ name, phone, text }]. Hasilnya dicatat di log notifikasi
 * kejadian (audience "whatsapp"), sama seperti Web Push.
 */
export async function sendWhatsApp({ deviceId, eventId, eventType, recipients }) {
  const list = recipients.filter((p) => waNumber(p.phone).length >= 10);
  if (!list.length) return null;
  let res;
  if (!waConfigured()) {
    for (const p of list) console.log(`[wa] FONNTE_TOKEN kosong, tidak dikirim ke ${p.name} (${waNumber(p.phone)}):\n${p.text}`);
    res = list.map(() => ({ ok: false, attempts: 0, error: 'gateway WhatsApp belum diisi (FONNTE_TOKEN)' }));
  } else {
    res = await Promise.all(list.map((p) => sendOne(waNumber(p.phone), p.text)));
  }
  const r = {
    device_id: deviceId,
    event_id: eventId,
    event_type: eventType,
    audience: 'whatsapp',
    recipients: list.length,
    delivered: res.filter((x) => x.ok).length,
    attempts: res.reduce((m, x) => Math.max(m, x.attempts), 0),
    error: [...new Set(res.filter((x) => !x.ok).map((x) => x.error))].join('; ') || null,
  };
  notifLog.add(r);
  console.log(`[wa] ${deviceId} ${eventType}: ${r.delivered}/${r.recipients} terkirim${r.error ? ` (${r.error})` : ''}`);
  return r;
}
