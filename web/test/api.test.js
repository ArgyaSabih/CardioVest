// Uji REST (Route Handlers Next.js) + Socket.IO + notifikasi berlapis lewat server.mjs terhadap database yang dibuat Repository cloud
// asli (fixtures/cloud.db, alat cv-001). Pengirim Web Push diganti tiruan supaya aturan penerima
// (8.6.5) dan retry bisa diperiksa tanpa internet.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { io as ioc } from 'socket.io-client';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cvgw-'));
fs.copyFileSync(new URL('./fixtures/cloud.db', import.meta.url), path.join(tmp, 'cloud.db'));
Object.assign(process.env, {
  PORT: '0', DATA_DIR: path.join(tmp, 'gw'), CLOUD_DB: path.join(tmp, 'cloud.db'),
  DEVICES: 'cv-001:246810,cv-002:135790', PROXY_SECRET: 'rahasia-uji', MQTT_URL: 'mqtt://127.0.0.1:1', PUSH_BASE_DELAY_MS: '1',
  CONTACTS_JSON: JSON.stringify([{ name: 'Bu Uji', relation: 'istri', phone: '+6281200000000' }]),
});
// butuh hasil `npm run build` (.next); server berjalan dalam mode produksi seperti di Docker
const { server, backend } = await import('../server.mjs');
const { mq, notify } = backend;
const { _setSender } = await import('../lib/server/push.js');
const { sentLog } = await import('../lib/server/mail.js');
let base;
let token;

before(async () => {
  if (!server.listening) await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  mq.end(true);
  server.close();
  setTimeout(() => process.exit(0), 200).unref();
});

const call = async (p, opt = {}, tok = token) => {
  const r = await fetch(base + p, {
    ...opt,
    body: opt.body ? JSON.stringify(opt.body) : undefined,
    headers: { 'content-type': 'application/json', ...(tok ? { authorization: `Bearer ${tok}` } : {}) },
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const anon = (p, opt) => call(p, opt, null);
const fakeSub = (id) => ({ endpoint: `https://push.contoh/${id}`, keys: { p256dh: 'p'.repeat(20), auth: 'a'.repeat(8) } });
const linkFrom = (text) => text.match(/\/(verifikasi|atur-sandi)\/([A-Za-z0-9_-]+)/)[2];

const akun = { name: 'Pak Uji', email: 'Uji@Contoh.id', phone: '+6281234567890', password: 'rahasia123', consent: true };

test('Halaman 1: daftar butuh persetujuan PDP, email unik, lalu email verifikasi terkirim', async () => {
  assert.equal((await anon('/api/auth/signup', { method: 'POST', body: { ...akun, consent: false } })).status, 400);
  assert.equal((await anon('/api/auth/signup', { method: 'POST', body: { ...akun, password: 'pendek' } })).status, 400);
  const r = await anon('/api/auth/signup', { method: 'POST', body: akun });
  assert.equal(r.status, 201);
  token = r.body.token;
  assert.equal((await anon('/api/auth/signup', { method: 'POST', body: akun })).status, 409);
  const me = await call('/api/users/me');
  assert.equal(me.body.user.email_verified, false);
  assert.ok(me.body.user.consent_ts > 0);
  assert.equal(me.body.device, null);
  const v = await anon('/api/auth/verify', { method: 'POST', body: { token: linkFrom(sentLog.at(-1).text) } });
  assert.equal(v.status, 200);
  assert.equal((await call('/api/users/me')).body.user.email_verified, true);
});

test('login, lupa & atur ulang kata sandi lewat tautan email', async () => {
  assert.equal((await anon('/api/auth/login', { method: 'POST', body: { email: 'uji@contoh.id', password: 'salah12345' } })).status, 401);
  assert.equal((await anon('/api/auth/forgot', { method: 'POST', body: { email: 'tidakada@contoh.id' } })).status, 200);
  await anon('/api/auth/forgot', { method: 'POST', body: { email: 'uji@contoh.id' } });
  const t = linkFrom(sentLog.at(-1).text);
  assert.equal((await anon('/api/auth/reset', { method: 'POST', body: { token: t, password: 'sandibaru123' } })).status, 200);
  assert.equal((await anon('/api/auth/reset', { method: 'POST', body: { token: t, password: 'sandibaru123' } })).status, 400); // sekali pakai
  const r = await anon('/api/auth/login', { method: 'POST', body: { email: 'uji@contoh.id', password: 'sandibaru123' } });
  assert.equal(r.status, 200);
  token = r.body.token;
});

test('F-APP-2: pairing dengan ID + kode, satu akun satu alat, alat tidak bisa diklaim dua akun', async () => {
  assert.equal((await call('/api/status')).body.code, 'belum_pairing');
  assert.equal((await call('/api/devices/pair', { method: 'POST', body: { device_id: 'cv-001', pairing_code: '000000' } })).status, 403);
  const r = await call('/api/devices/pair', { method: 'POST', body: { device_id: 'cv-001', pairing_code: '246810' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.device.device_id, 'cv-001');
  assert.equal((await call('/api/devices/pair', { method: 'POST', body: { device_id: 'cv-002', pairing_code: '135790' } })).status, 409);
  const lain = await anon('/api/auth/signup', { method: 'POST', body: { ...akun, email: 'lain@contoh.id' } });
  assert.equal((await call('/api/devices/pair', { method: 'POST', body: { device_id: 'cv-001', pairing_code: '246810' } }, lain.body.token)).status, 409);
});

test('status: event CRITICAL terbuka, tautan darurat, kontak awal dari CONTACTS_JSON', async () => {
  const r = await call('/api/status');
  assert.equal(r.status, 200);
  assert.equal(r.body.event.type, 'critical');
  assert.ok(r.body.event.public_token);
  assert.equal(r.body.user_name, 'Pak Uji');
  assert.deepEqual(r.body.contacts.map((c) => c.name), ['Bu Uji']);
  assert.equal(r.body.vital.hr, 109);
  assert.equal(r.body.connection, 'unknown');
});

test('Halaman 3: CRUD kontak, maksimal 5, undangan baru membatalkan tautan lama', async () => {
  assert.equal((await call('/api/contacts', { method: 'POST', body: { name: 'A', phone: '123' } })).status, 400);
  const a = await call('/api/contacts', { method: 'POST', body: { name: 'Mas Andi', relation: 'anak', phone: '0812-3456-7890' } });
  assert.equal(a.status, 201);
  assert.equal(a.body.phone, '081234567890');
  assert.match(a.body.invite_url, /\/gabung\//);
  const u = await call(`/api/contacts/${a.body.id}`, { method: 'PUT', body: { name: 'Mas Andi', relation: 'anak sulung', phone: '081234567890' } });
  assert.equal(u.body.relation, 'anak sulung');
  for (let i = 0; i < 3; i++) await call('/api/contacts', { method: 'POST', body: { name: `Kontak ${i}`, phone: `+62812000000${i}` } });
  assert.equal((await call('/api/contacts')).body.length, 5);
  assert.equal((await call('/api/contacts', { method: 'POST', body: { name: 'Keenam', phone: '+6281299999999' } })).status, 400);
  for (const c of (await call('/api/contacts')).body.filter((x) => x.name.startsWith('Kontak'))) {
    assert.equal((await call(`/api/contacts/${c.id}`, { method: 'DELETE' })).status, 204);
  }
  const old = a.body.invite_code;
  const r = await call(`/api/contacts/${a.body.id}/undangan-baru`, { method: 'POST' });
  assert.notEqual(r.body.invite_code, old);
  assert.equal((await anon(`/api/join/${old}`)).status, 404);
});

test('kontak menyalakan notifikasi lewat tautan undangan tanpa akun', async () => {
  const andi = (await call('/api/contacts')).body.find((c) => c.name === 'Mas Andi');
  assert.equal((await anon(`/api/join/${andi.invite_code}`)).body.user_name, 'Pak Uji');
  assert.equal((await anon(`/api/join/${andi.invite_code}/push`, { method: 'POST', body: { subscription: fakeSub('andi') } })).status, 200);
  assert.equal((await call('/api/contacts')).body.find((c) => c.id === andi.id).notifications, true);
});

test('8.6.5: WARNING hanya User Utama, CRITICAL User Utama + kontak, payload lengkap', async () => {
  await call('/api/push/subscribe', { method: 'POST', body: { subscription: fakeSub('utama') } });
  const sent = [];
  _setSender(async (sub, body) => {
    sent.push([sub.endpoint.split('/').pop(), JSON.parse(body)]);
  });
  await notify('cv-001', { event_type: 'warning', event_id: 1, state: 'WARNING', confidence: 0.7 });
  assert.deepEqual(sent.map((s) => s[0]), ['utama']);
  sent.length = 0;
  await notify('cv-001', { event_type: 'critical', event_id: 2, state: 'CRITICAL', confidence: 0.9, fall_detected: true, gps: { lat: -7.76, lng: 110.37, accuracy: 5 } });
  assert.deepEqual(sent.map((s) => s[0]).sort(), ['andi', 'utama']);
  for (const k of ['event_type', 'timestamp', 'user_id', 'device_id', 'state', 'confidence', 'gps', 'fall_detected']) assert.ok(k in sent[0][1], k);
  const andi = sent.find((s) => s[0] === 'andi')[1];
  assert.match(andi.url, /^\/darurat\/[^?]+\?k=/);
  assert.ok(andi.ack.token && andi.ack.k);
  sent.length = 0;
  await notify('cv-002', { event_type: 'critical', event_id: 9, state: 'CRITICAL' }); // alat belum dipasangkan
  assert.equal(sent.length, 0);
});

test('retry exponential backoff saat gagal sementara; langganan kedaluwarsa dihapus; semuanya tercatat', async () => {
  let n = 0;
  _setSender(async (sub) => {
    if (sub.endpoint.endsWith('andi')) throw Object.assign(new Error('gone'), { statusCode: 410 });
    if (++n < 3) throw Object.assign(new Error('sibuk'), { statusCode: 503 });
  });
  await notify('cv-001', { event_type: 'critical', event_id: 2, state: 'CRITICAL' });
  const last = (await call('/api/history/2')).body.notifications.at(-1);
  assert.deepEqual([last.recipients, last.delivered, last.attempts], [2, 1, 3]);
  assert.match(last.error, /kedaluwarsa/);
  assert.equal((await call('/api/contacts')).body.find((c) => c.name === 'Mas Andi').notifications, false);
});

test('Halaman 4–5: riwayat dengan filter tipe & tanggal, detail, EKG', async () => {
  const all = (await call('/api/history')).body;
  assert.equal(all.length, 2);
  assert.ok(all.every((e) => 'confidence' in e && 'class' in e));
  assert.deepEqual((await call('/api/history?type=critical')).body.map((e) => e.type), ['critical']);
  assert.equal((await call(`/api/history?from=${all[0].start_ts + 1}`)).body.length, 0);
  const crit = all.find((e) => e.type === 'critical');
  const d = (await call(`/api/history/${crit.id}`)).body;
  assert.ok(d.transitions.some((t) => t.to_state === 'CRITICAL'));
  assert.equal(d.fall_detected, true);
  const ecg = (await call(`/api/history/${crit.id}/ecg`)).body;
  assert.ok(ecg.mv.length > 5000 && ecg.mv.some((v) => v !== null));
  assert.ok(ecg.mark_at > 0 && ecg.mark_at < ecg.mv.length);
  assert.equal((await call('/api/history/999')).status, 404);
});

test('Halaman 6: tautan darurat tanpa login + tombol konfirmasi penerimaan (F-APP-5)', async () => {
  const st = (await call('/api/status')).body;
  const andi = (await call('/api/contacts')).body.find((c) => c.name === 'Mas Andi');
  const pub = await anon(`/api/public/${st.event.public_token}?k=${andi.invite_code}`);
  assert.equal(pub.status, 200);
  assert.equal(pub.body.active, true);
  assert.equal(pub.body.me.name, 'Mas Andi');
  assert.ok(pub.body.location.lat < 0);
  const ack = await anon(`/api/public/${st.event.public_token}/ack`, { method: 'POST', body: { k: andi.invite_code } });
  assert.deepEqual(ack.body.acks.map((a) => a.name), ['Mas Andi']);
  await anon(`/api/public/${st.event.public_token}/ack`, { method: 'POST', body: { k: andi.invite_code } });
  assert.equal((await call('/api/status')).body.event.acks.length, 1); // tidak dobel
  assert.equal((await anon('/api/public/salah')).status, 404);
});

test('socket /data/realtime: User Utama menerima status alatnya, tamu ditolak', async () => {
  const s = ioc(base, { path: '/data/realtime', auth: { token }, transports: ['websocket'] });
  const status = await new Promise((res, rej) => {
    s.on('status', res);
    s.on('connect_error', rej);
  });
  assert.equal(status.device_id, 'cv-001');
  s.close();
  const bad = ioc(base, { path: '/data/realtime', auth: {}, transports: ['websocket'], reconnection: false });
  assert.equal((await new Promise((res) => bad.on('connect_error', res))).message, 'unauthorized');
  bad.close();
});

test('Reset alarm dari web: butuh konfirmasi, hanya saat CRITICAL, dan diteruskan ke cloud lewat topik remote', async () => {
  const sent = [];
  const orig = mq.publish.bind(mq);
  const wasConnected = Object.getOwnPropertyDescriptor(mq, 'connected');
  mq.publish = (topic, payload, opt) => { sent.push({ topic, payload: JSON.parse(payload), opt }); };
  Object.defineProperty(mq, 'connected', { value: true, configurable: true });
  try {
    const L = backend.live('cv-001');
    const prev = L.state;
    L.state = { state: 'NORMAL' };
    assert.equal((await call('/api/reset', { method: 'POST', body: { confirm: true } })).status, 409);
    L.state = { state: 'CRITICAL' };
    assert.equal((await call('/api/reset', { method: 'POST', body: {} })).status, 400);
    assert.equal((await anon('/api/reset', { method: 'POST', body: { confirm: true } })).status, 401);
    const r = await call('/api/reset', { method: 'POST', body: { confirm: true } });
    assert.equal(r.status, 202);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].topic, 'device/cv-001/remote');
    assert.equal(sent[0].payload.type, 'remote_reset');
    assert.equal(sent[0].payload.by, 'Pak Uji');
    assert.equal(sent[0].opt.qos, 1);
    assert.equal((await call('/api/status')).body.remote_reset, true);
    L.state = prev;
  } finally {
    mq.publish = orig;
    if (wasConnected) Object.defineProperty(mq, 'connected', wasConnected);
    else delete mq.connected;
  }
});

test('lepas pairing butuh kata sandi', async () => {
  assert.equal((await call('/api/devices/pair', { method: 'DELETE', body: { password: 'salah' } })).status, 403);
  assert.equal((await call('/api/devices/pair', { method: 'DELETE', body: { password: 'sandibaru123' } })).status, 200);
  assert.equal((await call('/api/users/me')).body.device, null);
});

test('Vercel: IP pengguna dari proxy.js hanya dipercaya bila PROXY_SECRET cocok', async () => {
  const login = (headers) => fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ email: 'x@contoh.id', password: 'salahsalah' }),
  }).then((r) => r.status);
  // tiap pengguna punya IP sendiri: 12 percobaan dari 12 IP tidak ada yang diblokir
  for (let i = 0; i < 12; i++) assert.equal(await login({ 'x-cv-proxy-secret': 'rahasia-uji', 'x-cv-client-ip': `203.0.113.${i}` }), 401);
  // rahasia salah: header IP diabaikan, semua dihitung sebagai satu alamat dan akhirnya diblokir
  const codes = [];
  for (let i = 0; i < 12; i++) codes.push(await login({ 'x-cv-proxy-secret': 'tebakan', 'x-cv-client-ip': `198.51.100.${i}` }));
  assert.ok(codes.includes(429));
});
