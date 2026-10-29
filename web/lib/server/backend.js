// Inti backend CardioVest yang harus hidup terus (Subbab 5.7, 8.5.5, 8.6.5):
//   MQTT (akun "web", hanya baca)  -> cache status per alat + Socket.IO (/data/realtime) + Web Push berlapis
//   SQLite cloud (baca saja)       -> riwayat kejadian, potongan EKG, tren
//   SQLite aplikasi                -> akun, pairing alat, kontak darurat, langganan push, log notifikasi
// Koneksi seperti ini tidak bisa berjalan di fungsi serverless, jadi dijalankan oleh server kustom
// (server.mjs). Route Handlers Next.js di app/api/ memakai objek yang sama lewat globalThis.__cardiovest.
// Backend tidak pernah mengubah state alat: keputusan tetap di layanan cloud. CRITICAL dilepas dengan tombol
// fisik di alat (F-HW-6) atau, bila REMOTE_RESET=1, lewat permintaan reset dari beranda User Utama yang
// diteruskan ke cloud (topik device/{id}/remote) dan baru berlaku setelah cloud memerintahkan alat.
// Perintah langsung ke alat hanya "matikan bunyi" (app/api/devices/mute, topik device/{id}/buzzer):
// buzzer diam, state tetap.
import crypto from 'node:crypto';
import fs from 'node:fs';
import jwt from 'jsonwebtoken';
import mqtt from 'mqtt';
import { Server } from 'socket.io';
import { cfg } from './config.js';
import { decodeEcg, toMv } from './codec.js';
import * as cloud from './db.js';
import { mailConfigured, resetMail, verifyMail } from './mail.js';
import { dispatch, vapidPublicKey } from './push.js';
import { sendWhatsApp, waConfigured } from './wa.js';
import { denganLayanan } from '../layanan-darurat.js';
import {
  MAX_CONTACTS, acks, checkSecret, contacts, devices, linkOf, notifLog, publicTokenFor, subs, tokens, users,
} from './store.js';

const now = () => Date.now();

// ------------------------------------------------------------------ alat terdaftar
export function seedDevices() {
  for (const d of cfg.devices) {
    const code = d.code || String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
    if (devices.upsert(d.id, code) && !d.code) {
      console.warn(`[web] alat ${d.id} terdaftar dengan kode pairing ${code}. Catat sekarang (hanya tampil sekali), ` +
        'atau buat label QR: npm run alat -- kode-baru ' + d.id);
    }
  }
}

// ------------------------------------------------------------------ cache status langsung per alat
const liveMap = new Map();
export const live = (id) => {
  if (!liveMap.has(id)) liveMap.set(id, { state: null, online: null, onlineSince: null, vital: null, inference: null, trail: [], buffering: 0 });
  return liveMap.get(id);
};

const slimState = (s) =>
  s && {
    state: s.state,
    since: s.since,
    reason: s.reason,
    gps: s.gps?.fix ? denganLayanan({ lat: s.gps.lat, lng: s.gps.lon, acc: s.gps.accuracy_m }) : null,
    calibration: s.calibration ?? null,
    signal: s.signal ? { ok: s.signal.ok, reason: s.signal.reason } : null,
    ts: s.ts,
  };

const slimVital = (v) => ({
  ts: v.ts,
  hr: v.hr,
  hr_source: v.hr_source,
  sqi: v.sqi,
  gsr: v.gsr,
  fall: !!v.fall_detected,
  lead_off: !!v.lead_off,
  buzzer_muted: !!v.buzzer_muted,
  local_state: v.local_state,
  moving: v.accel?.sd != null ? v.accel.sd > 0.08 : null,
});

/** online / offline / buffering (F-APP-3): buffering = alat baru tersambung lagi dan mengirim data tertahan. */
export function connection(L) {
  if (L.online === false) return 'offline';
  if (L.online && now() - L.buffering < 10_000) return 'buffering';
  return L.online ? 'online' : 'unknown';
}

export function statusOf(dev, user) {
  const L = live(dev);
  const s = slimState(L.state);
  const ev = cloud.openEvent(dev);
  const critical = s?.state === 'CRITICAL';
  return {
    device_id: dev,
    user_name: user.name,
    user_phone: user.phone,
    state: s?.state ?? 'NORMAL',
    since: s?.since ?? null,
    reason: s?.reason ?? null,
    signal: s?.signal ?? null,
    calibration: s?.calibration ?? null,
    online: L.online,
    connection: connection(L),
    vital: L.vital ?? (cloud.lastVital(dev) && { ...cloud.lastVital(dev), stale: true }),
    inference: L.inference,
    gps: critical ? (L.trail.at(-1) ?? s?.gps ?? null) : null,
    trail: critical ? L.trail : [],
    event: ev ? {
      id: ev.id, type: ev.type, start_ts: ev.start_ts, fall_detected: ev.fall_detected,
      public_token: ev.type === 'critical' ? publicTokenFor(dev, ev.id) : null,
      acks: acks.forEvent(dev, ev.id),
    } : null,
    ambulance: cfg.ambulance,
    contacts: contacts.ofUser(user.id).map((c) => ({ name: c.name, relation: c.relation, phone: c.phone })),
    cloud_db: cloud.cloudDbReady(),
    remote_reset: cfg.remoteReset,
  };
}

// ------------------------------------------------------------------ sesi & pembatas percobaan
export const sign = (uid) => jwt.sign({ uid }, cfg.jwtSecret, { expiresIn: '60d' });

/** Header Authorization -> pengguna, atau null bila token tidak sah / akun hilang. */
export function userFromAuth(header) {
  try {
    const p = jwt.verify(String(header || '').replace(/^Bearer /, ''), cfg.jwtSecret);
    return users.byId(p.uid) ?? null;
  } catch {
    return null;
  }
}

// 10 kali per 10 menit per IP per jenis
const attempts = new Map();
export function limited(kind, ip, max = 10) {
  const key = `${kind}:${ip}`;
  const a = attempts.get(key) ?? { n: 0, t: now() };
  if (now() - a.t > 600_000) Object.assign(a, { n: 0, t: now() });
  a.n++;
  attempts.set(key, a);
  return a.n > max;
}
export const clearLimit = (kind, ip) => attempts.delete(`${kind}:${ip}`);

// ------------------------------------------------------------------ notifikasi berlapis (8.6.5)
const link = (p) => (cfg.publicUrl ? `${cfg.publicUrl}${p}` : p);
export function composeAlert(dev, a) {
  const owner = devices.ownerOf(dev);
  if (!owner) return null;
  const name = owner.name;
  const base = {
    // komponen wajib payload (8.6.5 langkah 2)
    event_type: a.event_type, timestamp: a.timestamp ?? now(), user_id: owner.id, device_id: dev,
    state: a.state, confidence: a.confidence ?? null, event_id: a.event_id ?? null, fall_detected: !!a.fall_detected,
    tag: `ev${a.event_id ?? 'x'}${a.event_type}`.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32),
    kind: a.event_type,
  };
  if (a.event_type === 'warning') {
    return { audience: 'user', urgent: true, build: () => ({ ...base,
      title: 'Waspada',
      body: 'Pola detak jantung Anda tidak biasa. Hentikan aktivitas, duduk, dan tarik napas pelan.',
      url: link('/') }) };
  }
  if (a.event_type?.startsWith('critical')) {
    const token = a.event_id ? publicTokenFor(dev, a.event_id) : null;
    const titles = { critical: `DARURAT: ${name}`, critical_fall: `DARURAT: ${name} terjatuh`, critical_location: `Lokasi ${name} sudah tersedia` };
    const bodies = {
      critical: 'Tanda bahaya pada jantung. Ketuk untuk menelepon AmbulanMU dan melihat lokasi.',
      critical_fall: 'Sensor gerak mencatat jatuh saat keadaan darurat. Ketuk untuk melihat lokasi.',
      critical_location: 'GPS alat sudah mendapat koordinat. Ketuk untuk petunjuk arah.',
    };
    return { audience: 'all', urgent: true, build: (sub) => ({ ...base, gps: a.gps ?? null,
      title: titles[a.event_type] ?? titles.critical, body: bodies[a.event_type] ?? bodies.critical,
      // kontak membuka halaman darurat publik dengan kodenya (untuk tombol "Saya terima");
      // User Utama membuka beranda yang sudah menampilkan keadaan darurat
      url: link(sub.owner_type === 'contact' && token ? `/darurat/${token}?k=${sub.invite_code}` : '/'),
      ack: sub.owner_type === 'contact' && token ? { token, k: sub.invite_code } : null }) };
  }
  if (a.event_type === 'resolved') {
    return { audience: 'all', urgent: false, build: () => ({ ...base,
      title: `Keadaan darurat ${name} diakhiri`,
      body: a.source === 'remote' ? 'Alarm dihentikan dari aplikasi.' : 'Tombol reset di alat sudah ditekan.', url: link('/') }) };
  }
  return null;
}

// ------------------------------------------------------------------ WhatsApp otomatis (revisi dosen)
const clockWib = (ts) => new Intl.DateTimeFormat('id-ID', { timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit' }).format(ts);
const mapsUrl = (g) => `https://www.google.com/maps?q=${g.lat.toFixed(6)},${g.lng.toFixed(6)}`;
// tautan halaman darurat hanya berguna bila alamatnya bisa dibuka dari ponsel lain
const reachable = () => cfg.publicUrl && !/\/\/(localhost|127\.|0\.0\.0\.0)/.test(cfg.publicUrl);
const waLocated = new Set(); // kejadian yang pesan pertamanya sudah berisi lokasi

/** Pesan WhatsApp per penerima untuk satu peringatan, atau [] bila jenis ini tidak dikirim lewat WA. */
export function composeWhatsApp(dev, a) {
  const owner = devices.ownerOf(dev);
  if (!owner || !a.event_type || a.event_type === 'warning') return [];
  const name = owner.name;
  const family = contacts.ofUser(owner.id);
  const amb = cfg.ambulance;
  const key = `${dev}:${a.event_id}`;
  const gps = a.gps?.lat != null ? { lat: a.gps.lat, lng: a.gps.lng ?? a.gps.lon } : live(dev).trail.at(-1) ?? null;
  const token = a.event_id ? publicTokenFor(dev, a.event_id) : null;
  const page = (c) => (reachable() && token ? `${cfg.publicUrl}/darurat/${token}${c ? `?k=${c.invite_code}` : ''}` : null);
  const where = gps ? `Lokasi: ${mapsUrl(gps)}` : 'Lokasi: menyusul, GPS alat masih mencari sinyal.';
  const lines = (...xs) => xs.filter(Boolean).join('\n');
  const at = clockWib(a.timestamp ?? now());

  if (a.event_type === 'critical') {
    if (gps) waLocated.add(key);
    const fell = a.fall_detected ? ' dan terjatuh' : '';
    const out = family.map((c) => ({ name: c.name, phone: c.phone, text: lines(
      `DARURAT CardioVest`,
      `${name} diduga mengalami serangan jantung${fell} pukul ${at} WIB.${amb ? ` ${amb.name} sudah dikabari.` : ''}`,
      where,
      owner.phone && `Telepon ${name}: ${owner.phone}`,
      page(c) && `Lokasi terkini: ${page(c)}`,
    ) }));
    if (amb) out.unshift({ name: amb.name, phone: amb.phone, text: lines(
      `DARURAT CardioVest`,
      `${name} diduga mengalami serangan jantung${fell} pukul ${at} WIB. Mohon kirim ambulans.`,
      where,
      owner.phone && `Telepon pasien: ${owner.phone}`,
      family[0] && `Keluarga: ${family[0].name}, ${family[0].phone}`,
      page(null) && `Lokasi terkini: ${page(null)}`,
    ) });
    return out;
  }
  const everyone = [...(amb ? [{ name: amb.name, phone: amb.phone }] : []), ...family.map((c) => ({ name: c.name, phone: c.phone }))];
  if (a.event_type === 'critical_location') {
    if (!gps || waLocated.has(key)) return [];
    waLocated.add(key);
    return everyone.map((p) => ({ ...p, text: lines(`CardioVest: lokasi ${name} sudah ditemukan.`, `Lokasi: ${mapsUrl(gps)}`) }));
  }
  if (a.event_type === 'critical_fall') {
    return everyone.map((p) => ({ ...p, text: lines(`CardioVest: ${name} terjatuh pukul ${at} WIB. Keadaan darurat masih berlangsung.`, gps && `Lokasi: ${mapsUrl(gps)}`) }));
  }
  if (a.event_type === 'resolved') {
    waLocated.delete(key);
    return family.map((c) => ({ name: c.name, phone: c.phone, text: `CardioVest: alarm darurat ${name} dimatikan dari alat pukul ${at} WIB.` }));
  }
  return [];
}

// ------------------------------------------------------------------ Socket.IO + MQTT, dipasang ke server HTTP
export function startBackend(server) {
  seedDevices();

  const io = new Server(server, {
    path: '/data/realtime',
    serveClient: false,
    destroyUpgrade: false, // upgrade lain (mis. hot reload Next.js saat dev) jangan diputus
    cors: { origin: cfg.allowedOrigins.length ? cfg.allowedOrigins : false },
  });
  io.use((socket, next) => {
    const { token, publicToken } = socket.handshake.auth ?? {};
    try {
      if (token) {
        const u = users.byId(jwt.verify(token, cfg.jwtSecret).uid);
        const d = u && devices.ofUser(u.id);
        if (!d) throw new Error('belum pairing');
        socket.data = { room: `dev:${d.device_id}`, device: d.device_id, user: u };
        return next();
      }
      const l = publicToken && linkOf(publicToken);
      if (l) {
        socket.data = { room: `pub:${publicToken}`, device: l.device_id, public: true };
        return next();
      }
    } catch {
      /* jatuh ke penolakan */
    }
    next(new Error('unauthorized'));
  });
  io.on('connection', (socket) => {
    socket.join(socket.data.room);
    if (socket.data.public) socket.join(`devpub:${socket.data.device}`);
    else socket.emit('status', statusOf(socket.data.device, socket.data.user));
  });
  const toFamily = (dev) => io.to(`dev:${dev}`);
  const toAll = (dev) => io.to(`dev:${dev}`).to(`devpub:${dev}`);

  const mq = mqtt.connect(cfg.mqttUrl, {
    clientId: `web-${Math.random().toString(16).slice(2, 8)}`,
    username: cfg.mqttUser || undefined,
    password: cfg.mqttPass || undefined,
    reconnectPeriod: 2000,
    ca: process.env.MQTT_CA ? fs.readFileSync(process.env.MQTT_CA) : undefined,
  });
  mq.on('connect', () => {
    console.log(`[mqtt] tersambung ke ${cfg.mqttUrl}`);
    mq.subscribe(['state', 'alert', 'vital', 'ecg', 'inference', 'lwt'].map((k) => `device/+/${k}`), { qos: 1 });
  });
  mq.on('error', (e) => console.warn('[mqtt]', e.message));

  async function notify(dev, a) {
    const m = composeAlert(dev, a);
    if (!m) return;
    const wa = composeWhatsApp(dev, a);
    const whatsapp = wa.length ? sendWhatsApp({ deviceId: dev, eventId: a.event_id ?? null, eventType: a.event_type, recipients: wa }) : null;
    const r = await dispatch({ deviceId: dev, audience: m.audience, build: m.build, urgent: m.urgent, eventId: a.event_id ?? null, eventType: a.event_type });
    console.log(`[push] ${dev} ${a.event_type} -> ${m.audience === 'user' ? 'User Utama' : 'User Utama + kontak'}: ${r.delivered}/${r.recipients} terkirim, ${r.attempts} percobaan`);
    await whatsapp;
  }

  const handlers = {
    state(dev, s) {
      const L = live(dev);
      const prev = L.state?.state;
      L.state = s;
      if (s.state !== 'CRITICAL') L.trail = [];
      else if (s.gps?.fix && !L.trail.length) L.trail.push(denganLayanan({ lat: s.gps.lat, lng: s.gps.lon, acc: s.gps.accuracy_m, ts: now() }));
      toFamily(dev).emit('state', slimState(s));
      if (prev && prev !== s.state) io.to(`devpub:${dev}`).emit('state', { state: s.state });
    },
    lwt(dev, m) {
      const L = live(dev);
      L.online = m.status === 'online';
      L.onlineSince = now();
      toAll(dev).emit('online', { online: L.online, connection: connection(L), reason: m.reason ?? null });
    },
    vital(dev, v) {
      const L = live(dev);
      if (v.buffered) {
        // data lama dari antrean offline: hanya untuk riwayat, tetapi status koneksi menjadi "buffering"
        if (now() - L.buffering > 3000) toFamily(dev).emit('online', { online: true, connection: 'buffering' });
        L.buffering = now();
        return;
      }
      L.vital = slimVital(v);
      toFamily(dev).emit('vital', L.vital);
      const g = v.gps;
      if (L.state?.state === 'CRITICAL' && g?.fix) {
        const p = denganLayanan({ lat: g.lat, lng: g.lon, acc: g.accuracy_m, ts: v.ts });
        const last = L.trail.at(-1);
        if (!last || Math.hypot(last.lat - p.lat, last.lng - p.lng) > 2e-5 || p.ts - last.ts > 30_000) {
          L.trail.push(p);
          if (L.trail.length > 360) L.trail.shift();
          toAll(dev).emit('location', p);
        }
      }
      if (v.fall_detected) toAll(dev).emit('fall', { ts: v.ts });
    },
    inference(dev, r) {
      if (r.late) return;
      const L = live(dev);
      L.inference = {
        ts: r.ts,
        class: r.class,
        p_conf: r.p_conf,
        probs: r.probs,
        accepted: r.accepted,
        reason: r.reason,
        signal_ok: r.signal_ok !== false,
        signal_reason: r.quality?.reason || null,
        validators: r.validators
          ? { hr: r.validators.hr, gsr: r.validators.gsr, ind_hr: r.validators.ind_hr, ind_gsr: r.validators.ind_gsr,
            degraded: r.validators.degraded, motion: r.validators.motion }
          : null,
      };
      toFamily(dev).emit('inference', L.inference);
    },
    alert(dev, a) {
      toFamily(dev).emit('alert', a);
      notify(dev, a).catch((e) => console.warn('[push]', e.message));
    },
  };

  mq.on('message', (topic, buf) => {
    const [, dev, kind] = topic.split('/');
    if (!devices.get(dev)) return; // alat yang tidak terdaftar diabaikan
    try {
      if (kind === 'ecg') {
        const p = decodeEcg(buf);
        if (p.buffered) live(dev).buffering = now();
        else toFamily(dev).emit('ecg', { t0: p.t0, fs: p.fs, mv: toMv(p.samples), lead_off: p.leadOff });
        return;
      }
      if (!buf.length) return;
      handlers[kind]?.(dev, JSON.parse(buf.toString()));
    } catch (e) {
      console.warn(`[mqtt] payload ${kind} dari ${dev} tidak terbaca: ${e.message}`);
    }
  });

  /** Teruskan permintaan "hentikan alarm" ke cloud. Hanya sah saat status CRITICAL dan REMOTE_RESET aktif. */
  function remoteReset(dev, user) {
    if (!cfg.remoteReset) return { ok: false, status: 403, error: 'Menghentikan alarm dari aplikasi dimatikan. Tahan tombol reset di alat selama 3 detik.' };
    if (live(dev).state?.state !== 'CRITICAL') return { ok: false, status: 409, error: 'Status alat saat ini bukan Darurat.' };
    if (!mq.connected) return { ok: false, status: 503, error: 'Server belum tersambung ke broker. Coba lagi sebentar lagi.' };
    mq.publish(`device/${dev}/remote`, JSON.stringify({ type: 'remote_reset', by: user.name, user_id: user.id, ts: now() }), { qos: 1 });
    console.warn(`[reset] ${dev}: permintaan hentikan alarm dari ${user.name} diteruskan ke cloud`);
    return { ok: true, status: 202 };
  }

  // semua yang dibutuhkan Route Handlers (app/api) — satu instans untuk seluruh proses
  const ctx = {
    cfg, cloud, users, tokens, devices, contacts, subs, acks, notifLog, linkOf, publicTokenFor, checkSecret,
    MAX_CONTACTS, dispatch, vapidPublicKey, waConfigured, mailConfigured, verifyMail, resetMail,
    live, connection, statusOf, sign, userFromAuth, limited, clearLimit, io, mq, notify, remoteReset,
  };
  globalThis.__cardiovest = ctx;
  return ctx;
}
