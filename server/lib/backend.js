import crypto from 'node:crypto';
import fs from 'node:fs';
import jwt from 'jsonwebtoken';
import mqtt from 'mqtt';
import { Server } from 'socket.io';
import { cfg, originAllowed } from './config.js';
import { decodeEcg, toMv } from './codec.js';
import * as cloud from './db.js';
import { mailConfigured, resetMail, verifyMail } from './mail.js';
import { dispatch, vapidPublicKey } from './push.js';
import {
  MAX_CONTACTS, acks, checkSecret, contacts, devices, linkOf, notifLog, publicTokenFor, subs, tokens, users,
} from './store.js';

const now = () => Date.now();
export const REKAMAN = ['normal', 'st_depression', 'af', 'pvc', 'cd', 'svt', 'stemi', 'vt', 'vf'];

export function seedDevices() {
  for (const d of cfg.devices) {
    const code = d.code || String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
    if (devices.upsert(d.id, code) && !d.code) {
      console.warn(`[web] alat ${d.id} terdaftar dengan kode pairing ${code}. Catat sekarang (hanya tampil sekali), ` +
        'atau buat label QR: npm run alat -- kode-baru ' + d.id);
    }
  }
}

const liveMap = new Map();
export const live = (id) => {
  if (!liveMap.has(id)) liveMap.set(id, { state: null, online: null, onlineSince: null, vital: null, inference: null, trail: [], buffering: 0, source: 'hardware', rekaman: null, seen: 0 });
  return liveMap.get(id);
};

const slimState = (s) =>
  s && {
    state: s.state,
    mode: s.mode === 'test' ? 'test' : 'demo',
    since: s.since,
    reason: s.reason,
    gps: s.gps?.fix ? { lat: s.gps.lat, lng: s.gps.lon, acc: s.gps.accuracy_m } : null,
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
  fall_ts: v.fall_ts ?? null,
  lead_off: !!v.lead_off,
  local_state: v.local_state,
  moving: v.accel?.sd != null ? v.accel.sd > 0.08 : null,
  mode: v.mode ?? null,
  hr_ppg: v.hr_ppg ?? null,
  hr_ecg: v.hr_ecg ?? null,
  accel: v.accel ?? null,
  gps: v.gps ?? null,
  sensors: v.sensors ?? null,
  i2c: v.i2c ?? null,
  charging: !!v.charging,
});

export const SEEN_MS = 10_000;
export const deviceLive = (L) => L.seen > 0 && now() - L.seen < SEEN_MS;

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
    mode: s?.mode ?? 'demo',
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
    contacts: contacts.ofUser(user.id).map((c) => ({ name: c.name, relation: c.relation, phone: c.phone })),
    cloud_db: cloud.cloudDbReady(),
    remote_reset: cfg.remoteReset,
    source: L.source,
    rekaman: L.rekaman,
  };
}

export const sign = (uid) => jwt.sign({ uid }, cfg.jwtSecret, { expiresIn: '60d' });

export function userFromAuth(header) {
  try {
    const p = jwt.verify(String(header || '').replace(/^Bearer /, ''), cfg.jwtSecret);
    return users.byId(p.uid) ?? null;
  } catch {
    return null;
  }
}

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

const link = (p) => (cfg.publicUrl ? `${cfg.publicUrl}${p}` : p);
export function composeAlert(dev, a) {
  const owner = devices.ownerOf(dev);
  if (!owner) return null;
  const name = owner.name;
  const base = {
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
      critical: 'Tanda bahaya pada jantung terdeteksi oleh EKG, denyut, dan keringat. Telepon 119, ketuk untuk lokasi.',
      critical_fall: 'Sensor gerak mencatat jatuh saat keadaan darurat. Ketuk untuk melihat lokasi.',
      critical_location: 'GPS alat sudah mendapat koordinat. Ketuk untuk petunjuk arah.',
    };
    return { audience: 'all', urgent: true, build: (sub) => ({ ...base, gps: a.gps ?? null,
      title: titles[a.event_type] ?? titles.critical, body: bodies[a.event_type] ?? bodies.critical,
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

export function startBackend(server) {
  seedDevices();

  const io = new Server(server, {
    path: '/data/realtime',
    serveClient: false,
    cors: { origin: (origin, cb) => cb(null, originAllowed(origin)) },
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
    mq.subscribe(['state', 'alert', 'vital', 'ecg', 'ecg_dataset', 'source', 'inference', 'lwt', 'event'].map((k) => `device/+/${k}`), { qos: 1 });
    debug.presenceAll();
  });
  mq.on('close', () => debug.presenceAll());
  mq.on('error', (e) => console.warn('[mqtt]', e.message));

  async function notify(dev, a) {
    const m = composeAlert(dev, a);
    if (!m) return;
    const r = await dispatch({ deviceId: dev, audience: m.audience, build: m.build, urgent: m.urgent, eventId: a.event_id ?? null, eventType: a.event_type });
    console.log(`[push] ${dev} ${a.event_type} -> ${m.audience === 'user' ? 'User Utama' : 'User Utama + kontak'}: ${r.delivered}/${r.recipients} terkirim, ${r.attempts} percobaan`);
  }

  const handlers = {
    state(dev, s) {
      const L = live(dev);
      const prev = L.state?.state;
      L.state = s;
      if (s.state !== 'CRITICAL') L.trail = [];
      else if (s.gps?.fix && !L.trail.length) L.trail.push({ lat: s.gps.lat, lng: s.gps.lon, acc: s.gps.accuracy_m, ts: now() });
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
        if (now() - L.buffering > 3000) toFamily(dev).emit('online', { online: true, connection: 'buffering' });
        L.buffering = now();
        return;
      }
      L.vital = slimVital(v);
      toFamily(dev).emit('vital', L.vital);
      const g = v.gps;
      if (L.state?.state === 'CRITICAL' && g?.fix) {
        const p = { lat: g.lat, lng: g.lon, acc: g.accuracy_m, ts: v.ts };
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

  function markSeen(dev, kind, buf, retained) {
    const L = live(dev);
    const was = deviceLive(L);
    if (kind === 'lwt') {
      let st = null;
      try {
        st = JSON.parse(buf.toString()).status;
      } catch {
        st = null;
      }
      if (st === 'offline') L.seen = 0;
      else if (st === 'online' && !retained) L.seen = now();
    } else if (!retained && ['vital', 'ecg', 'event'].includes(kind)) L.seen = now();
    if (was !== deviceLive(L)) debug.presence(dev);
  }

  mq.on('message', (topic, buf, packet) => {
    const [, dev, kind] = topic.split('/');
    if (!devices.get(dev)) return;
    const L = live(dev);
    markSeen(dev, kind, buf, packet?.retain);
    if (kind === 'event') return;
    if (kind === 'source') {
      let v = {};
      try {
        v = buf.length ? JSON.parse(buf.toString()) : {};
      } catch {
        v = { source: buf.toString().trim() };
      }
      L.source = v?.source === 'dataset' ? 'dataset' : 'hardware';
      L.rekaman = L.source === 'dataset' ? String(v.rekaman || 'normal') : null;
      toFamily(dev).emit('source', { source: L.source, rekaman: L.rekaman });
      debug.relay(topic, buf);
      return;
    }
    if (kind === 'ecg' || kind === 'ecg_dataset') {
      if ((kind === 'ecg_dataset') !== (L.source === 'dataset')) return;
      debug.relay(`device/${dev}/ecg`, buf);
    } else debug.relay(topic, buf);
    try {
      if (kind === 'ecg' || kind === 'ecg_dataset') {
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

  function remoteReset(dev, user) {
    if (!cfg.remoteReset) return { ok: false, status: 403, error: 'Menghentikan alarm dari aplikasi dimatikan. Tahan tombol reset di alat selama 3 detik.' };
    if (!live(dev).state) return { ok: false, status: 409, error: 'Status alat belum diterima dari server.' };
    if (!mq.connected) return { ok: false, status: 503, error: 'Server belum tersambung ke broker. Coba lagi sebentar lagi.' };
    mq.publish(`device/${dev}/remote`, JSON.stringify({ type: 'remote_reset', by: user.name, user_id: user.id, ts: now() }), { qos: 1 });
    console.warn(`[reset] ${dev}: permintaan hentikan alarm dari ${user.name} diteruskan ke cloud`);
    return { ok: true, status: 202 };
  }

  function setSource(dev, user, source, rekaman) {
    if (source !== 'dataset' && source !== 'hardware') return { ok: false, status: 400, error: 'Sumber harus dataset atau hardware.' };
    if (rekaman != null && !REKAMAN.includes(rekaman)) return { ok: false, status: 400, error: 'Rekaman dataset tidak dikenal.' };
    if (!mq.connected) return { ok: false, status: 503, error: 'Server belum tersambung ke broker. Coba lagi sebentar lagi.' };
    const body = { source, rekaman: source === 'dataset' ? rekaman || 'normal' : null, by: user.name, ts: now() };
    mq.publish(`device/${dev}/source`, JSON.stringify(body), { qos: 1, retain: true });
    console.log(`[sumber] ${dev}: ${source}${body.rekaman ? ` (${body.rekaman})` : ''} dipilih oleh ${user.name}`);
    return { ok: true, status: 202 };
  }

  const debug = startDebug();

  function startDebug() {
    const nsp = io.of('/debug');
    const last = new Map();
    const KEEP = new Set(['state', 'lwt', 'source', 'vital', 'inference']);
    const presenceOf = (dev) => {
      const L = live(dev);
      return { broker: mq.connected, device: deviceLive(L), seen: L.seen || null, ts: now() };
    };
    const shown = new Map();
    setInterval(() => {
      for (const d of devices.all()) {
        const on = deviceLive(live(d.device_id));
        if (shown.get(d.device_id) !== on) debug.presence(d.device_id);
      }
    }, 1000).unref();
    nsp.on('connection', (socket) => {
      socket.on('watch', (dev) => {
        if (typeof dev !== 'string' || !devices.get(dev)) return socket.emit('galat', 'Alat tidak terdaftar di server.');
        for (const r of socket.rooms) if (r !== socket.id) socket.leave(r);
        socket.join(`dbg:${dev}`);
        socket.data.dev = dev;
        socket.emit('presence', presenceOf(dev));
        for (const [t, b] of last) if (t.split('/')[1] === dev) socket.emit('m', t, b);
      });
      socket.on('cmd', (c) => {
        const dev = socket.data.dev;
        if (!dev || !c || typeof c !== 'object') return;
        const who = { name: 'debug viewer', id: null };
        if (c.type === 'mode') setMode(dev, who, c.mode);
        else if (c.type === 'source') setSource(dev, who, c.source, c.rekaman ?? null);
      });
    });
    return {
      presence(dev) {
        const p = presenceOf(dev);
        shown.set(dev, p.device);
        nsp.to(`dbg:${dev}`).emit('presence', p);
      },
      presenceAll() {
        for (const d of devices.all()) this.presence(d.device_id);
      },
      relay(topic, buf) {
        const [, dev, kind] = topic.split('/');
        if (KEEP.has(kind)) {
          if (buf.length) last.set(topic, buf);
          else last.delete(topic);
        }
        nsp.to(`dbg:${dev}`).emit('m', topic, buf);
      },
    };
  }

  function setMode(dev, user, mode) {
    if (mode !== 'demo' && mode !== 'test') return { ok: false, status: 400, error: 'Mode harus demo atau test.' };
    if (!mq.connected) return { ok: false, status: 503, error: 'Server belum tersambung ke broker. Coba lagi sebentar lagi.' };
    mq.publish(`device/${dev}/remote`, JSON.stringify({ type: 'set_mode', mode, by: user.name, user_id: user.id, ts: now() }), { qos: 1 });
    console.log(`[mode] ${dev}: mode ${mode} diminta oleh ${user.name}`);
    return { ok: true, status: 202 };
  }

  const ctx = {
    cfg, cloud, users, tokens, devices, contacts, subs, acks, notifLog, linkOf, publicTokenFor, checkSecret,
    MAX_CONTACTS, dispatch, vapidPublicKey, mailConfigured, verifyMail, resetMail,
    live, connection, statusOf, sign, userFromAuth, limited, clearLimit, io, mq, notify, remoteReset, setMode, setSource,
  };
  globalThis.__cardiovest = ctx;
  return ctx;
}
