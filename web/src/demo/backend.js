// Mode demo: seluruh server CardioVest ditiru di browser, supaya aplikasi bisa dibuka di Vercel tanpa VPS,
// MQTT, maupun database. Dipakai bila NEXT_PUBLIC_CV_DEMO=1 (lihat next.config.mjs).
//
//   demoFetch(method, path, body, token) -> { status, data }   pengganti fetch ke /api
//   subscribe(fn)                                                pengganti Socket.IO (event yang sama)
//   scenario(nama)                                               tombol simulasi di Beranda
//
// Data (akun, kontak, riwayat) disimpan di localStorage browser ini. Alat cv-001 dengan kode 482913
// ditiru oleh simulator kecil di bawah: EKG sintetis, denyut, keringat, GPS, dan alur status
// Normal -> Waspada -> Darurat yang sama dengan layanan cloud (2 window untuk Waspada, terkunci sampai
// tombol reset). Tidak ada model CNN, notifikasi push, atau WhatsApp yang sungguhan.
import { FS, ecgStream, eventStrip } from './ecg.js';

const KEY = 'cv_demo_v1';
const DEVICE = 'cv-001';
const CODE = '482913';
const AMBULANCE = { name: 'AmbulanMU Kota Yogyakarta', phone: '+6281319123637' };
const HOME = { lat: -7.7655, lng: 110.3719 };
const MAX_CONTACTS = 5;
const now = () => Date.now();
const DAY = 86_400_000;
const WINDOW_MS = 3500; // panjang hop window EKG di cloud

// ------------------------------------------------------------------ penyimpanan
let db = null;
const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('cv_demo') : null;

function seed() {
  const t = now();
  const d3 = t - 3 * DAY + 2 * 3600_000;
  const d1 = t - DAY - 5 * 3600_000;
  return {
    v: 1,
    seq: 10,
    users: [],
    device: { device_id: DEVICE, code: CODE, user_id: null, paired_ts: null },
    contacts: [],
    transitions: [
      { ts: d3, from_state: 'NORMAL', to_state: 'WARNING', reason: 'persisten 2/2 window non-Normal (Pra-Serangan)' },
      { ts: d3 + 95_000, from_state: 'WARNING', to_state: 'NORMAL', reason: 'pulih (histeresis 3 window Normal)' },
      { ts: d1, from_state: 'NORMAL', to_state: 'WARNING', reason: 'persisten 2/2 window non-Normal (Serangan)' },
      { ts: d1 + 7_000, from_state: 'WARNING', to_state: 'CRITICAL', reason: 'gerbang cross-validation terpenuhi (Serangan, 1_GSR=1, 1_HR=1)' },
      { ts: d1 + 7_000 + 6 * 60_000, from_state: 'CRITICAL', to_state: 'NORMAL', reason: 'reset tombol fisik R(t)=1 dari perangkat' },
    ],
    events: [
      ev(1, 'warning', d3, d3 + 95_000, 'pulih (histeresis)', { cls: 'Pra-Serangan', probs: [0.21, 0.66, 0.13], peak: 0.66, before: 'normal', after: 'pre', hr: 97 }),
      ev(2, 'warning', d1, d1 + 7_000, 'eskalasi ke CRITICAL', { cls: 'Serangan', probs: [0.12, 0.31, 0.57], peak: 0.57, before: 'normal', after: 'attack', hr: 122 }),
      ev(3, 'critical', d1 + 7_000, d1 + 7_000 + 6 * 60_000, 'reset tombol fisik', {
        cls: 'Serangan', probs: [0.04, 0.1, 0.86], peak: 0.86, before: 'attack', after: 'attack', hr: 128,
        fall: true, lat: HOME.lat + 0.0004, lon: HOME.lng - 0.0006, token: 'demo-kemarin',
      }),
    ],
  };
}

function ev(id, type, start, end, endReason, o) {
  return {
    id, type, start_ts: start, end_ts: end, end_reason: endReason, fall_detected: !!o.fall, peak_conf: o.peak,
    lat: o.lat ?? null, lon: o.lon ?? null, cls: o.cls, probs: o.probs, token: o.token ?? null,
    seed: id * 97, before: o.before, after: o.after, hr: o.hr, acks: [], notifications: [], trail: [],
  };
}

function data() {
  if (db) return db;
  try {
    db = JSON.parse(localStorage.getItem(KEY));
  } catch {
    db = null;
  }
  if (!db || db.v !== 1) {
    db = seed();
    save();
  }
  return db;
}

function save(broadcast = true) {
  try {
    localStorage.setItem(KEY, JSON.stringify(db));
  } catch {
    /* penyimpanan penuh atau diblokir: data hanya bertahan di memori */
  }
  if (broadcast) channel?.postMessage({ type: 'db' });
}

// tab lain (mis. halaman darurat keluarga) mengubah data: baca ulang
channel?.addEventListener('message', (m) => {
  if (m.data?.type === 'db') db = null;
  if (m.data?.type === 'ack' && live.event && m.data.eventId === live.event.id) {
    emit('ack', { name: m.data.name, ts: now(), acks: m.data.acks });
  }
});

const nextId = () => ++data().seq;
const code = () => Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6);

// ------------------------------------------------------------------ simulator alat
const listeners = new Set();
export function subscribe(fn) {
  listeners.add(fn);
  start();
  return () => {
    listeners.delete(fn);
  };
}
const emit = (name, payload) => listeners.forEach((fn) => fn(name, payload));

const stream = ecgStream(11);
const live = {
  state: 'NORMAL', since: now(), reason: null, online: true, scenario: 'normal', fall: false,
  hr: 72, gsr: 5.6, nonNormal: 0, normalRun: 0, gps: null, trail: [], event: null, startedAt: now(),
};
const SCEN = {
  normal: { kind: 'normal', hr: 72, gsr: 5.6 },
  waspada: { kind: 'pre', hr: 96, gsr: 6.4 },
  darurat: { kind: 'attack', hr: 126, gsr: 14.5 },
  jatuh: { kind: 'attack', hr: 128, gsr: 15.2 },
};

let timer = null;
let tick = 0;
function start() {
  if (timer || typeof window === 'undefined') return;
  timer = setInterval(step, 1000);
}

function paired() {
  return data().device.user_id != null;
}

function step() {
  if (!paired() || !live.online) return;
  tick++;
  const target = SCEN[live.scenario] ?? SCEN.normal;
  live.hr += (target.hr - live.hr) * 0.25 + (Math.random() - 0.5) * 1.6;
  live.gsr += (target.gsr - live.gsr) * 0.2 + (Math.random() - 0.5) * 0.12;
  const t = now();
  const vital = {
    ts: t, hr: Math.round(live.hr * 10) / 10, hr_source: 'PPG', sqi: 0.86, gsr: Math.round(live.gsr * 100) / 100,
    fall: live.fall, lead_off: false, local_state: live.state, moving: false,
    buzzer_muted: live.mutedFor === live.state && live.state !== 'NORMAL',
  };
  live.vital = vital;
  emit('vital', vital);
  if (live.state === 'CRITICAL' && live.gps) {
    const g = { lat: live.gps.lat + (Math.random() - 0.5) * 0.00002, lng: live.gps.lng + (Math.random() - 0.5) * 0.00002, acc: 6, ts: t };
    if (tick % 5 === 0) location(g);
  }
  // window EKG tiap 3,5 detik (dibulatkan ke 3 atau 4 detik bergantian)
  if (tick % 7 === 0 || tick % 7 === 4) window_(t);
}

function window_(t) {
  const target = SCEN[live.scenario] ?? SCEN.normal;
  stream.set(target.kind, live.hr);
  const n = Math.round((WINDOW_MS / 1000) * FS);
  emit('ecg', { t0: t - WINDOW_MS, fs: FS, mv: stream.next(n), lead_off: false });
  const cls = target.kind === 'normal' ? 'Normal' : target.kind === 'pre' ? 'Pra-Serangan' : 'Serangan';
  const probs = cls === 'Normal' ? [0.9, 0.07, 0.03] : cls === 'Pra-Serangan' ? [0.2, 0.68, 0.12] : [0.05, 0.11, 0.84];
  const indHr = live.hr > 120 || live.hr < 40;
  const indGsr = live.gsr > 11;
  live.inference = {
    ts: t, class: cls, p_conf: Math.max(...probs), probs, accepted: true, reason: null, signal_ok: true, signal_reason: null,
    validators: { hr: live.vital?.hr, gsr: live.vital?.gsr, ind_hr: indHr, ind_gsr: indGsr, degraded: false, motion: false },
  };
  emit('inference', live.inference);
  fsm(cls, indHr && indGsr);
}

/** Alur status sama dengan decision engine cloud: N=2 window non-Normal -> Waspada, Serangan + 1_HR + 1_GSR -> Darurat (terkunci). */
function fsm(cls, gate) {
  if (live.state === 'CRITICAL') return; // hanya tombol reset (atau Hentikan alarm) yang melepas
  if (cls === 'Normal') {
    live.nonNormal = 0;
    if (live.state === 'WARNING' && ++live.normalRun >= 3) transition('NORMAL', 'pulih (histeresis 3 window Normal)', 'pulih (histeresis)');
    return;
  }
  live.normalRun = 0;
  live.nonNormal++;
  if (live.state === 'NORMAL' && live.nonNormal >= 2) transition('WARNING', `persisten 2/2 window non-Normal (${cls})`);
  else if (live.state === 'WARNING' && cls === 'Serangan' && gate && live.nonNormal >= 4) {
    transition('CRITICAL', 'gerbang cross-validation terpenuhi (Serangan, 1_GSR=1, 1_HR=1)', 'eskalasi ke CRITICAL');
  }
}

function transition(to, reason, endReason) {
  const d = data();
  const t = now();
  const from = live.state;
  d.transitions.push({ ts: t, from_state: from, to_state: to, reason });
  if (live.event) {
    const e = d.events.find((x) => x.id === live.event.id);
    if (e) Object.assign(e, { end_ts: t, end_reason: endReason ?? (to === 'NORMAL' ? 'pulih (histeresis)' : null) });
    live.event = null;
  }
  live.state = to;
  live.mutedFor = null; // state berubah: alat berbunyi lagi
  live.since = t;
  live.reason = reason;
  if (to === 'WARNING' || to === 'CRITICAL') {
    const target = SCEN[live.scenario] ?? SCEN.normal;
    const id = nextId();
    const e = ev(id, to === 'CRITICAL' ? 'critical' : 'warning', t, null, null, {
      cls: target.kind === 'pre' ? 'Pra-Serangan' : 'Serangan', probs: live.inference?.probs ?? [0.1, 0.3, 0.6],
      peak: live.inference?.p_conf ?? 0.6, before: from === 'NORMAL' ? 'normal' : target.kind, after: target.kind, hr: Math.round(live.hr),
      token: to === 'CRITICAL' ? `demo-${code()}` : null,
    });
    const families = d.contacts.filter((c) => c.user_id === d.device.user_id);
    e.notifications.push({ id: nextId(), ts: t, event_type: e.type, audience: to === 'CRITICAL' ? 'all' : 'user',
      recipients: (pushOn() ? 1 : 0) + (to === 'CRITICAL' ? families.filter((c) => c.notifications).length : 0),
      delivered: (pushOn() ? 1 : 0) + (to === 'CRITICAL' ? families.filter((c) => c.notifications).length : 0), attempts: 1, error: null });
    if (to === 'CRITICAL') {
      e.notifications.push({ id: nextId(), ts: t, event_type: 'critical', audience: 'whatsapp', recipients: 1 + families.length,
        delivered: 0, attempts: 0, error: 'mode demo, pesan tidak dikirim' });
    }
    d.events.push(e);
    live.event = { id, type: e.type, start_ts: t, fall_detected: false, public_token: e.token, acks: [] };
    emit('alert', { event_type: e.type, event_id: id, state: to, timestamp: t });
    localNotify(to);
    if (to === 'CRITICAL') {
      live.gps = null;
      setTimeout(() => {
        if (live.state === 'CRITICAL') location({ lat: HOME.lat, lng: HOME.lng, acc: 6, ts: now() });
      }, 3000);
      if (live.scenario === 'jatuh') setTimeout(fall, 5000);
    }
  } else {
    live.gps = null;
    live.trail = [];
    live.fall = false;
    if (from === 'CRITICAL') emit('alert', { event_type: 'resolved', state: 'NORMAL', timestamp: t });
  }
  save();
  emit('state', stateObj());
}

function location(g) {
  live.gps = g;
  live.trail = [...live.trail.slice(-359), g];
  emit('location', g);
  const e = live.event && data().events.find((x) => x.id === live.event.id);
  if (e) {
    if (e.lat == null) Object.assign(e, { lat: g.lat, lon: g.lng });
    e.trail = live.trail.slice(-60);
    e.location = g;
    save();
  }
}

function fall() {
  if (live.state !== 'CRITICAL') return;
  live.fall = true;
  const e = live.event && data().events.find((x) => x.id === live.event.id);
  if (e) {
    e.fall_detected = true;
    live.event.fall_detected = true;
    save();
  }
  emit('fall', { ts: now() });
}

const stateObj = () => ({
  state: live.state, since: live.since, reason: live.reason, gps: live.state === 'CRITICAL' ? live.gps : null,
  calibration: { calibrated: true, progress_s: 30, target_s: 30 }, signal: { ok: true, reason: null }, ts: now(),
});

/** Tombol simulasi di Beranda (mode demo). */
export function scenario(name) {
  start();
  if (name === 'putus') {
    live.online = false;
    emit('online', { online: false, connection: 'offline' });
    return;
  }
  if (name === 'sambung') {
    live.online = true;
    emit('online', { online: true, connection: 'online' });
    return;
  }
  if (name === 'reset') {
    live.scenario = 'normal';
    live.nonNormal = 0;
    if (live.state !== 'NORMAL') transition('NORMAL', 'reset tombol fisik R(t)=1 dari perangkat', 'reset tombol fisik');
    return;
  }
  live.scenario = name;
  live.fall = false;
  if (!live.online) scenario('sambung');
}
export const currentScenario = () => ({ scenario: live.scenario, state: live.state, online: live.online });

// ------------------------------------------------------------------ notifikasi lokal (pengganti Web Push)
const PUSH_KEY = 'cv_demo_push';
export const pushOn = () => {
  try {
    return localStorage.getItem(PUSH_KEY) === '1';
  } catch {
    return false;
  }
};
export function setPush(on) {
  try {
    if (on) localStorage.setItem(PUSH_KEY, '1');
    else localStorage.removeItem(PUSH_KEY);
  } catch {
    /* abaikan */
  }
}
export async function localNotify(state, title, body) {
  if (!pushOn() || typeof Notification === 'undefined' || Notification.permission !== 'granted') return false;
  const t = title ?? (state === 'CRITICAL' ? 'DARURAT' : state === 'WARNING' ? 'Waspada' : 'CardioVest');
  const b = body ?? (state === 'CRITICAL' ? 'Tanda bahaya pada jantung. Ketuk untuk menelepon AmbulanMU.' : 'Pola detak jantung tidak biasa. Duduk dan tarik napas pelan.');
  const opts = { body: b, icon: '/icons/icon-192.png', tag: `demo-${state}`, data: { url: '/' } };
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    if (reg) await reg.showNotification(t, opts);
    else new Notification(t, opts); // eslint-disable-line no-new
    return true;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------ API tiruan
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE = /^\+?[0-9]{8,15}$/;
const cleanPhone = (p) => String(p ?? '').replace(/[\s()-]/g, '');
const ok = (data, status = 200) => ({ status, data });
const fail = (status, error, extra = {}) => ({ status, data: { error, ...extra } });

const pubUser = (u) => u && { id: u.id, name: u.name, email: u.email, phone: u.phone ?? null, email_verified: false, consent_ts: u.consent_ts };
const userOf = (token) => {
  const m = /^demo\.(\d+)$/.exec(String(token || ''));
  return m ? data().users.find((u) => u.id === Number(m[1])) ?? null : null;
};
const deviceOf = (u) => {
  const d = data().device;
  return d.user_id === u.id ? { device_id: d.device_id, paired_ts: d.paired_ts } : null;
};
const contactsOf = (u) => data().contacts.filter((c) => c.user_id === u.id);
const withLink = (c) => ({ ...c, invite_url: `/gabung/${c.invite_code}` });
const evOut = (e) => ({
  id: e.id, device_id: DEVICE, type: e.type, start_ts: e.start_ts, end_ts: e.end_ts, end_reason: e.end_reason,
  fall_detected: !!e.fall_detected, peak_conf: e.peak_conf, lat: e.lat, lon: e.lon, reason: null,
});

function statusOf(u) {
  const d = data();
  const e = live.event;
  const critical = live.state === 'CRITICAL';
  return {
    device_id: DEVICE, user_name: u.name, user_phone: u.phone ?? null,
    state: live.state, since: live.since, reason: live.reason, signal: { ok: true, reason: null },
    calibration: { calibrated: true, progress_s: 30, target_s: 30 },
    online: live.online, connection: live.online ? 'online' : 'offline',
    vital: live.vital ?? null, inference: live.inference ?? null,
    gps: critical ? live.gps : null, trail: critical ? live.trail : [],
    event: e ? { ...e, acks: d.events.find((x) => x.id === e.id)?.acks ?? [] } : null,
    ambulance: AMBULANCE,
    contacts: contactsOf(u).map((c) => ({ name: c.name, relation: c.relation, phone: c.phone })),
    cloud_db: true,
    remote_reset: true,
  };
}

function vitalsFor(e) {
  const out = [];
  const to = Math.min(e.end_ts ?? now(), e.start_ts + 30 * 60_000) + 60_000;
  const base = 72;
  for (let t = e.start_ts - 60_000, i = 0; t <= to; t += 1000, i++) {
    const after = t >= e.start_ts && (!e.end_ts || t <= e.end_ts);
    const hr = after ? e.hr + Math.sin(i / 7) * 2 : base + Math.sin(i / 9) * 2;
    const gsr = after ? (e.type === 'critical' ? 14.2 : 6.8) + Math.sin(i / 11) * 0.4 : 5.6 + Math.sin(i / 13) * 0.2;
    out.push({ ts: t, hr: Math.round(hr * 10) / 10, gsr: Math.round(gsr * 100) / 100, fall: !!e.fall_detected && t === e.start_ts + 5000 });
  }
  return out;
}

const KIND_HR = (kind, hr) => ({ kind, hr: kind === 'normal' ? 72 : hr });

const PARAM_ROUTES = [
  '/contacts/:x', '/contacts/:x/undangan-baru', '/join/:x', '/join/:x/push', '/join/:x/uji',
  '/history/:x', '/history/:x/ecg', '/public/:x', '/public/:x/ack',
];

export async function demoFetch(method, path, body, token) {
  const d = data();
  const [p, qs] = path.split('?');
  const q = Object.fromEntries(new URLSearchParams(qs || ''));
  const seg = p.split('/').filter(Boolean);
  const u = userOf(token);
  const needUser = () => (u ? null : fail(401, 'Sesi berakhir. Silakan masuk lagi.'));
  const needDevice = () => needUser() ?? (deviceOf(u) ? null : fail(409, 'Akun belum dipasangkan dengan alat.', { code: 'belum_pairing' }));
  let route = `${method} ${p}`;
  let x = null;
  for (const pat of PARAM_ROUTES) {
    const m = new RegExp(`^${pat.replace(':x', '([^/]+)')}$`).exec(p);
    if (m) {
      route = `${method} ${pat}`;
      x = decodeURIComponent(m[1]);
      break;
    }
  }

  switch (route) {
    case 'GET /health': return ok({ ok: true, mqtt: true, cloud_db: true, demo: true });
    case 'POST /auth/signup': {
      const name = String(body?.name ?? '').trim();
      const email = String(body?.email ?? '').toLowerCase().trim();
      const phone = cleanPhone(body?.phone);
      if (body?.consent !== true) return fail(400, 'Persetujuan pemrosesan data kesehatan wajib dicentang (UU No. 27/2022).');
      if (name.length < 2) return fail(400, 'Nama minimal 2 huruf.');
      if (!EMAIL.test(email)) return fail(400, 'Format email tidak valid.');
      if (String(body?.password ?? '').length < 8) return fail(400, 'Kata sandi minimal 8 karakter.');
      if (phone && !PHONE.test(phone)) return fail(400, 'Nomor HP tidak valid, contoh +6281234567890.');
      if (d.users.some((v) => v.email === email)) return fail(409, 'Email sudah terdaftar. Silakan masuk.');
      const id = nextId();
      d.users.push({ id, name, email, phone: phone || null, password: body.password, consent_ts: now() });
      save();
      return ok({ token: `demo.${id}`, email_sent: false }, 201);
    }
    case 'POST /auth/login': {
      const v = d.users.find((w) => w.email === String(body?.email ?? '').toLowerCase().trim());
      if (!v || v.password !== body?.password) return fail(401, 'Email atau kata sandi salah.');
      return ok({ token: `demo.${v.id}` });
    }
    case 'POST /auth/verify': return ok({ ok: true });
    case 'POST /auth/verify/kirim-ulang': return needUser() ?? ok({ ok: true, email_sent: false });
    case 'POST /auth/forgot': return ok({ ok: true });
    case 'POST /auth/reset': return fail(400, 'Atur ulang kata sandi tidak tersedia di mode demo.');
    case 'GET /users/me':
      return needUser() ?? ok({ user: pubUser(u), device: deviceOf(u), email_configured: false, ambulance: AMBULANCE, whatsapp_configured: false, demo: true });
    case 'PUT /users/me': {
      const e = needUser();
      if (e) return e;
      const phone = cleanPhone(body?.phone);
      if (body?.name != null && String(body.name).trim().length < 2) return fail(400, 'Nama minimal 2 huruf.');
      if (phone && !PHONE.test(phone)) return fail(400, 'Nomor HP tidak valid, contoh +6281234567890.');
      if (body?.password) {
        if (body.password.length < 8) return fail(400, 'Kata sandi baru minimal 8 karakter.');
        if (body.current_password !== u.password) return fail(403, 'Kata sandi lama salah.');
        u.password = body.password;
      }
      if (body?.name) u.name = String(body.name).trim();
      u.phone = phone || null;
      save();
      return ok({ user: pubUser(u) });
    }
    case 'POST /devices/pair': {
      const e = needUser();
      if (e) return e;
      if (deviceOf(u)) return fail(409, `Akun ini sudah terpasang dengan ${DEVICE}. Lepaskan dulu di halaman Akun.`);
      if (String(body?.device_id).trim() !== DEVICE || String(body?.pairing_code).trim() !== CODE) {
        return fail(403, 'ID alat atau kode pairing salah. Periksa label di alat.');
      }
      if (d.device.user_id) return fail(409, 'Alat ini sudah terpasang dengan akun lain.');
      Object.assign(d.device, { user_id: u.id, paired_ts: now() });
      save();
      start();
      return ok({ device: deviceOf(u) });
    }
    case 'DELETE /devices/pair': {
      const e = needDevice();
      if (e) return e;
      if (body?.password !== u.password) return fail(403, 'Kata sandi salah.');
      Object.assign(d.device, { user_id: null, paired_ts: null });
      save();
      return ok({ ok: true });
    }
    case 'GET /status': return needDevice() ?? ok(statusOf(u));
    case 'POST /reset': {
      // tombol "Hentikan alarm": sama dengan REMOTE_RESET=1 di server
      const e = needDevice();
      if (e) return e;
      if (body?.confirm !== true) return fail(400, 'Konfirmasi diperlukan untuk menghentikan alarm.');
      if (live.state !== 'CRITICAL') return fail(409, 'Status alat saat ini bukan Darurat.');
      setTimeout(() => {
        live.scenario = 'normal';
        live.nonNormal = 0;
        transition('NORMAL', `reset jarak jauh dari ${u.name}`, 'reset dari aplikasi web');
      }, 1200);
      return ok({ ok: true }, 202);
    }
    case 'POST /devices/mute': {
      const e = needDevice();
      if (e) return e;
      if (live.state !== 'WARNING' && live.state !== 'CRITICAL') return fail(409, 'Alat tidak sedang berbunyi.');
      if (!live.online) return fail(409, 'Alat sedang terputus, jadi bunyinya hanya bisa dihentikan dengan tombol reset di alat.');
      live.mutedFor = live.state;
      const r = live.event && d.events.find((v) => v.id === live.event.id);
      if (r) {
        r.notifications.push({ id: nextId(), ts: now(), event_type: 'mute', audience: 'device', recipients: 1, delivered: 1, attempts: 1, error: null });
        save();
      }
      return ok({ ok: true, state: live.state });
    }
    case 'GET /contacts': return needUser() ?? ok(contactsOf(u).map(withLink));
    case 'POST /contacts': case 'PUT /contacts/:x': {
      const e = needUser();
      if (e) return e;
      const id = Number(x);
      const old = method === 'PUT' ? d.contacts.find((c) => c.id === id && c.user_id === u.id) : null;
      if (method === 'PUT' && !old) return fail(404, 'Kontak tidak ditemukan.');
      if (method === 'POST' && contactsOf(u).length >= MAX_CONTACTS) return fail(400, `Maksimal ${MAX_CONTACTS} kontak darurat.`);
      const name = String(body?.name ?? '').trim();
      const phone = cleanPhone(body?.phone);
      if (name.length < 2) return fail(400, 'Nama minimal 2 huruf.');
      if (!PHONE.test(phone)) return fail(400, 'Nomor HP tidak valid, contoh +6281234567890.');
      const relation = String(body?.relation ?? '').trim().slice(0, 40) || null;
      if (old) Object.assign(old, { name, phone, relation });
      const c = old ?? { id: nextId(), user_id: u.id, name, phone, relation, invite_code: code(), joined: false, notifications: false };
      if (!old) d.contacts.push(c);
      save();
      return ok(withLink(c), old ? 200 : 201);
    }
    case 'DELETE /contacts/:x': {
      const e = needUser();
      if (e) return e;
      const i = d.contacts.findIndex((c) => c.id === Number(x) && c.user_id === u.id);
      if (i < 0) return fail(404, 'Kontak tidak ditemukan.');
      d.contacts.splice(i, 1);
      save();
      return { status: 204, data: null };
    }
    case 'POST /contacts/:x/undangan-baru': {
      const e = needUser();
      if (e) return e;
      const c = d.contacts.find((v) => v.id === Number(x) && v.user_id === u.id);
      if (!c) return fail(404, 'Kontak tidak ditemukan.');
      Object.assign(c, { invite_code: code(), joined: false, notifications: false });
      save();
      return ok(withLink(c));
    }
    case 'GET /join/:x': case 'POST /join/:x/push': case 'POST /join/:x/uji': {
      const c = d.contacts.find((v) => v.invite_code === x);
      if (!c) return fail(404, 'Tautan undangan tidak dikenal atau sudah diganti.');
      const owner = d.users.find((v) => v.id === c.user_id);
      if (method === 'GET') return ok({ name: c.name, user_name: owner?.name, notifications: c.notifications });
      if (seg[2] === 'push') {
        Object.assign(c, { joined: true, notifications: true });
        save();
        return ok({ ok: true });
      }
      const sent = await localNotify('TEST', 'Uji notifikasi CardioVest', `Ponsel ini akan dikabari bila ${owner?.name} dalam keadaan darurat.`);
      return ok({ recipients: 1, delivered: sent ? 1 : 0, attempts: 1 });
    }
    case 'GET /history': {
      const e = needDevice();
      if (e) return e;
      let rows = [...d.events].sort((a, b) => b.start_ts - a.start_ts);
      if (q.type === 'warning' || q.type === 'critical') rows = rows.filter((r) => r.type === q.type);
      if (q.from) rows = rows.filter((r) => r.start_ts >= Number(q.from));
      if (q.to) rows = rows.filter((r) => r.start_ts < Number(q.to));
      return ok(rows.map((r) => ({ ...evOut(r), class: r.cls, confidence: r.peak_conf })));
    }
    case 'GET /history/:x': case 'GET /history/:x/ecg': {
      const e = needDevice();
      if (e) return e;
      const r = d.events.find((v) => v.id === Number(x));
      if (!r) return fail(404, 'Kejadian tidak ditemukan.');
      if (seg[2] === 'ecg') {
        const mv = eventStrip(r.seed, KIND_HR(r.before, r.hr), KIND_HR(r.after, r.hr));
        return ok({ t0: r.start_ts - 20_000, fs: FS, mv, mark_at: 20 * FS });
      }
      const to = Math.min(r.end_ts ?? now(), r.start_ts + 30 * 60_000) + 60_000;
      return ok({
        ...evOut(r), class: r.cls, probs: r.probs,
        transitions: d.transitions.filter((t) => t.ts >= r.start_ts - 30_000 && t.ts <= to),
        vitals: vitalsFor(r), location: r.lat != null ? { lat: r.lat, lng: r.lon } : null,
        notifications: r.notifications, acks: r.acks,
      });
    }
    case 'GET /trend': {
      const e = needDevice();
      if (e) return e;
      const hours = Math.min(72, Number(q.hours) || 24);
      const out = [];
      const t1 = Math.floor(now() / 60_000) * 60_000;
      for (let t = t1 - hours * 3600_000, i = 0; t < t1; t += 60_000, i++) {
        out.push({ t, hr: Math.round((72 + 6 * Math.sin(i / 40) + 3 * Math.sin(i / 7)) * 10) / 10, gsr: 5.6, fall: 0 });
      }
      return ok(out);
    }
    case 'GET /public/:x': case 'POST /public/:x/ack': {
      const r = d.events.find((v) => v.token === x);
      if (!r) return fail(404, 'Tautan darurat tidak dikenal atau sudah tidak berlaku.');
      if (r.end_ts && now() - r.end_ts > 24 * 3600_000 && r.token !== 'demo-kemarin') return fail(410, 'Tautan darurat ini sudah kedaluwarsa.');
      const owner = d.users.find((v) => v.id === d.device.user_id) ?? d.users[0];
      const me = (method === 'GET' ? q.k : body?.k) ? d.contacts.find((c) => c.invite_code === (method === 'GET' ? q.k : body.k)) : null;
      if (method === 'POST') {
        const name = me?.name ?? (String(body?.name ?? '').trim().slice(0, 40) || 'Penerima tautan');
        r.acks.push({ name, ts: now(), contact_id: me?.id ?? null });
        save();
        channel?.postMessage({ type: 'ack', eventId: r.id, name, acks: r.acks });
        if (live.event?.id === r.id) emit('ack', { name, ts: now(), acks: r.acks });
        return ok({ ok: true, acks: r.acks.map((a) => ({ name: a.name, ts: a.ts })) });
      }
      const active = !r.end_ts;
      return ok({
        user_name: owner?.name ?? 'Pemakai CardioVest', user_phone: owner?.phone ?? null, ambulance: AMBULANCE,
        active, started_at: r.start_ts, ended_at: r.end_ts, end_reason: r.end_reason, fall_detected: !!r.fall_detected,
        location: r.location ?? (r.lat != null ? { lat: r.lat, lng: r.lon } : null), trail: active ? r.trail : [],
        device_online: true, hr: null, acks: r.acks.map((a) => ({ name: a.name, ts: a.ts })), me: me ? { name: me.name } : null,
      });
    }
    case 'GET /push/key': return ok({ key: '' });
    case 'POST /push/subscribe': setPush(true); return ok({ ok: true });
    case 'DELETE /push/subscribe': setPush(false); return ok({ ok: true });
    case 'POST /push/test': {
      const sent = await localNotify('TEST', 'Uji notifikasi CardioVest', 'Notifikasi berfungsi. Peringatan dari alat akan muncul seperti ini.');
      return ok({ recipients: 1, delivered: sent ? 1 : 0, attempts: 1 });
    }
    default:
      return fail(404, 'Endpoint tidak dikenal.');
  }
}
