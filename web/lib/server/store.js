// Data milik gateway (bukan milik cloud): akun User Utama, alat & pairing, kontak darurat, langganan
// Web Push, log notifikasi, tautan darurat publik, dan konfirmasi penerimaan dari kontak.
import crypto from 'node:crypto';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { cfg } from './config.js';

export const db = new DatabaseSync(path.join(cfg.dataDir, 'gateway.db'));
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA busy_timeout = 3000');
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, phone TEXT,
  pass_hash TEXT NOT NULL, email_verified INTEGER NOT NULL DEFAULT 0, consent_ts INTEGER, created_ts INTEGER);
CREATE TABLE IF NOT EXISTS devices (
  device_id TEXT PRIMARY KEY, pair_hash TEXT NOT NULL, user_id INTEGER UNIQUE, paired_ts INTEGER, created_ts INTEGER);
CREATE TABLE IF NOT EXISTS tokens (
  token TEXT PRIMARY KEY, user_id INTEGER NOT NULL, kind TEXT NOT NULL, expires_ts INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS contacts (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, name TEXT NOT NULL, relation TEXT, phone TEXT NOT NULL,
  invite_code TEXT NOT NULL UNIQUE, created_ts INTEGER, joined_ts INTEGER);
CREATE TABLE IF NOT EXISTS push_subs (
  endpoint TEXT PRIMARY KEY, sub TEXT NOT NULL, owner_type TEXT NOT NULL, owner_id INTEGER NOT NULL,
  label TEXT, created_ts INTEGER);
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY, ts INTEGER, device_id TEXT, event_id INTEGER, event_type TEXT, audience TEXT,
  recipients INTEGER, delivered INTEGER, attempts INTEGER, error TEXT);
CREATE TABLE IF NOT EXISTS public_links (
  token TEXT PRIMARY KEY, device_id TEXT NOT NULL, event_id INTEGER NOT NULL, created_ts INTEGER,
  UNIQUE(device_id, event_id));
CREATE TABLE IF NOT EXISTS acks (
  id INTEGER PRIMARY KEY, device_id TEXT, event_id INTEGER, contact_id INTEGER, name TEXT, ts INTEGER,
  UNIQUE(device_id, event_id, contact_id));
`);

const rand = (n = 9) => crypto.randomBytes(n).toString('base64url');
const now = () => Date.now();

// ------------------------------------------------------------------ hash (scrypt bawaan Node)
export function hashSecret(pw) {
  const salt = crypto.randomBytes(16);
  return `scrypt$${salt.toString('base64')}$${crypto.scryptSync(String(pw), salt, 32).toString('base64')}`;
}
export function checkSecret(pw, stored) {
  const [, s, h] = String(stored ?? '').split('$');
  if (!s || !h) return false;
  const want = Buffer.from(h, 'base64');
  const got = crypto.scryptSync(String(pw), Buffer.from(s, 'base64'), want.length);
  return crypto.timingSafeEqual(want, got);
}

// ------------------------------------------------------------------ pengguna
const pubUser = (u) => u && {
  id: u.id, name: u.name, email: u.email, phone: u.phone, email_verified: !!u.email_verified, consent_ts: u.consent_ts,
};
export const users = {
  byEmail: (email) => db.prepare('SELECT * FROM users WHERE email=?').get(String(email).toLowerCase().trim()),
  byId: (id) => pubUser(db.prepare('SELECT * FROM users WHERE id=?').get(id)),
  raw: (id) => db.prepare('SELECT * FROM users WHERE id=?').get(id),
  create: ({ name, email, phone, password }) =>
    Number(db.prepare('INSERT INTO users(name,email,phone,pass_hash,consent_ts,created_ts) VALUES(?,?,?,?,?,?)')
      .run(name.trim(), email.toLowerCase().trim(), phone || null, hashSecret(password), now(), now()).lastInsertRowid),
  update: (id, { name, phone }) =>
    db.prepare('UPDATE users SET name=COALESCE(?,name), phone=? WHERE id=?').run(name ?? null, phone ?? null, id),
  setPassword: (id, pw) => db.prepare('UPDATE users SET pass_hash=? WHERE id=?').run(hashSecret(pw), id),
  verify: (id) => db.prepare('UPDATE users SET email_verified=1 WHERE id=?').run(id),
};

// token sekali pakai untuk verifikasi email (24 jam) dan reset kata sandi (1 jam)
export const tokens = {
  issue: (userId, kind) => {
    db.prepare('DELETE FROM tokens WHERE user_id=? AND kind=?').run(userId, kind);
    const t = rand(24);
    db.prepare('INSERT INTO tokens(token,user_id,kind,expires_ts) VALUES(?,?,?,?)')
      .run(t, userId, kind, now() + (kind === 'reset' ? 3600_000 : 24 * 3600_000));
    return t;
  },
  use: (token, kind) => {
    const r = db.prepare('SELECT * FROM tokens WHERE token=? AND kind=?').get(String(token), kind);
    if (!r || r.expires_ts < now()) return null;
    db.prepare('DELETE FROM tokens WHERE token=?').run(r.token);
    return r.user_id;
  },
};

// ------------------------------------------------------------------ alat & pairing (F-APP-2: satu akun satu alat)
export const devices = {
  /** Daftarkan/ubah kode pairing. Alat yang sudah dipasangkan tidak diubah kodenya dari .env. */
  upsert: (id, code, { force = false } = {}) => {
    const d = db.prepare('SELECT * FROM devices WHERE device_id=?').get(id);
    if (!d) return db.prepare('INSERT INTO devices(device_id,pair_hash,created_ts) VALUES(?,?,?)').run(id, hashSecret(code), now());
    if (force || (!d.user_id && !checkSecret(code, d.pair_hash))) db.prepare('UPDATE devices SET pair_hash=? WHERE device_id=?').run(hashSecret(code), id);
    return null;
  },
  get: (id) => db.prepare('SELECT device_id, user_id, paired_ts FROM devices WHERE device_id=?').get(id),
  raw: (id) => db.prepare('SELECT * FROM devices WHERE device_id=?').get(id),
  all: () => db.prepare('SELECT device_id, user_id, paired_ts FROM devices ORDER BY device_id').all(),
  ofUser: (uid) => db.prepare('SELECT device_id, paired_ts FROM devices WHERE user_id=?').get(uid) ?? null,
  ownerOf: (id) => {
    const d = db.prepare('SELECT user_id FROM devices WHERE device_id=?').get(id);
    return d?.user_id ? users.byId(d.user_id) : null;
  },
  pair: (id, uid) => db.prepare('UPDATE devices SET user_id=?, paired_ts=? WHERE device_id=?').run(uid, now(), id),
  unpair: (id) => db.prepare('UPDATE devices SET user_id=NULL, paired_ts=NULL WHERE device_id=?').run(id),
};

// ------------------------------------------------------------------ kontak darurat (F-APP-4, maks. 5)
export const MAX_CONTACTS = 5;
const subCount = db.prepare("SELECT COUNT(*) AS n FROM push_subs WHERE owner_type='contact' AND owner_id=?");
const pubContact = (c) => c && {
  id: c.id, user_id: c.user_id, name: c.name, relation: c.relation, phone: c.phone, invite_code: c.invite_code,
  joined: !!c.joined_ts, notifications: subCount.get(c.id).n > 0,
};
export const contacts = {
  ofUser: (uid) => db.prepare('SELECT * FROM contacts WHERE user_id=? ORDER BY id').all(uid).map(pubContact),
  get: (uid, id) => pubContact(db.prepare('SELECT * FROM contacts WHERE id=? AND user_id=?').get(id, uid)),
  byCode: (code) => pubContact(db.prepare('SELECT * FROM contacts WHERE invite_code=?').get(String(code))),
  count: (uid) => db.prepare('SELECT COUNT(*) AS n FROM contacts WHERE user_id=?').get(uid).n,
  create: (uid, { name, relation, phone }) =>
    Number(db.prepare('INSERT INTO contacts(user_id,name,relation,phone,invite_code,created_ts) VALUES(?,?,?,?,?,?)')
      .run(uid, name.trim(), relation || null, phone, rand(), now()).lastInsertRowid),
  update: (uid, id, { name, relation, phone }) =>
    db.prepare('UPDATE contacts SET name=?, relation=?, phone=? WHERE id=? AND user_id=?').run(name.trim(), relation || null, phone, id, uid),
  remove: (uid, id) => {
    const c = contacts.get(uid, id);
    if (!c) return false;
    db.prepare("DELETE FROM push_subs WHERE owner_type='contact' AND owner_id=?").run(id);
    db.prepare('DELETE FROM contacts WHERE id=?').run(id);
    return true;
  },
  /** Kode undangan baru; ponsel yang memakai tautan lama tidak lagi menerima notifikasi. */
  rotate: (uid, id) => {
    db.prepare("DELETE FROM push_subs WHERE owner_type='contact' AND owner_id=?").run(id);
    db.prepare('UPDATE contacts SET invite_code=?, joined_ts=NULL WHERE id=? AND user_id=?').run(rand(), id, uid);
  },
  markJoined: (id) => db.prepare('UPDATE contacts SET joined_ts=COALESCE(joined_ts, ?) WHERE id=?').run(now(), id),
};

// ------------------------------------------------------------------ langganan Web Push
export const subs = {
  /**
   * Penerima untuk satu alat (8.6.5 langkah 3): 'user' = hanya User Utama (WARNING),
   * 'all' = User Utama + seluruh kontak darurat pemilik alat (CRITICAL).
   */
  forDevice: (deviceId, audience) => {
    const d = devices.get(deviceId);
    if (!d?.user_id) return [];
    const rows = db.prepare(`SELECT s.endpoint, s.sub, s.owner_type, s.owner_id, c.invite_code
        FROM push_subs s LEFT JOIN contacts c ON s.owner_type='contact' AND c.id=s.owner_id
        WHERE (s.owner_type='user' AND s.owner_id=?) OR (? = 'all' AND s.owner_type='contact' AND c.user_id=?)`)
      .all(d.user_id, audience, d.user_id);
    return rows.map((r) => ({ endpoint: r.endpoint, owner_type: r.owner_type, owner_id: r.owner_id, invite_code: r.invite_code, ...JSON.parse(r.sub) }));
  },
  forOwner: (type, id) =>
    db.prepare('SELECT endpoint, sub FROM push_subs WHERE owner_type=? AND owner_id=?').all(type, id)
      .map((r) => ({ endpoint: r.endpoint, ...JSON.parse(r.sub) })),
  add: (sub, ownerType, ownerId, label = '') =>
    db.prepare('INSERT OR REPLACE INTO push_subs(endpoint, sub, owner_type, owner_id, label, created_ts) VALUES(?,?,?,?,?,?)')
      .run(sub.endpoint, JSON.stringify(sub), ownerType, ownerId, label, now()),
  remove: (endpoint) => db.prepare('DELETE FROM push_subs WHERE endpoint=?').run(endpoint),
};

// ------------------------------------------------------------------ log notifikasi (8.6.5 langkah 6)
export const notifLog = {
  add: (r) =>
    db.prepare('INSERT INTO notifications(ts,device_id,event_id,event_type,audience,recipients,delivered,attempts,error) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(now(), r.device_id, r.event_id ?? null, r.event_type, r.audience, r.recipients, r.delivered, r.attempts, r.error ?? null),
  forEvent: (deviceId, eventId) => db.prepare('SELECT * FROM notifications WHERE device_id=? AND event_id=? ORDER BY ts').all(deviceId, eventId),
};

// ------------------------------------------------------------------ tautan darurat & konfirmasi penerimaan
export function publicTokenFor(deviceId, eventId) {
  const row = db.prepare('SELECT token FROM public_links WHERE device_id=? AND event_id=?').get(deviceId, eventId);
  if (row) return row.token;
  const token = rand(12);
  db.prepare('INSERT INTO public_links(token, device_id, event_id, created_ts) VALUES(?,?,?,?)').run(token, deviceId, eventId, now());
  return token;
}
export const linkOf = (token) => db.prepare('SELECT device_id, event_id, created_ts FROM public_links WHERE token=?').get(String(token)) ?? null;

export const acks = {
  /** F-APP-5: kontak menekan "Saya terima". contactId null = penerima tanpa tautan undangan. */
  add: (deviceId, eventId, contactId, name) =>
    db.prepare('INSERT OR IGNORE INTO acks(device_id,event_id,contact_id,name,ts) VALUES(?,?,?,?,?)')
      .run(deviceId, eventId, contactId ?? null, name, now()),
  forEvent: (deviceId, eventId) => db.prepare('SELECT name, ts, contact_id FROM acks WHERE device_id=? AND event_id=? ORDER BY ts').all(deviceId, eventId),
};
