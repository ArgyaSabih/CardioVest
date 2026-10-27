import { cleanPhone, json, route, tooMany } from '@/lib/api';

export const dynamic = 'force-dynamic';

// F-APP-2: pairing alat dengan ID + kode pairing (ketik manual atau pindai QR label)
export const POST = route(async (r) => {
  const limit = tooMany(r, 'pair');
  if (limit) return limit;
  const { devices, contacts, checkSecret, cfg, MAX_CONTACTS } = r.ctx;
  const id = String(r.body?.device_id ?? '').trim();
  const code = String(r.body?.pairing_code ?? '').trim();
  if (r.device) return json({ error: `Akun ini sudah terpasang dengan ${r.device}. Lepaskan dulu di halaman Akun.` }, 409);
  const d = devices.raw(id);
  if (!d || !checkSecret(code, d.pair_hash)) return json({ error: 'ID alat atau kode pairing salah. Periksa label di alat.' }, 403);
  if (d.user_id) return json({ error: 'Alat ini sudah terpasang dengan akun lain.' }, 409);
  devices.pair(id, r.user.id);
  if (!contacts.count(r.user.id) && cfg.seedContacts.length && devices.all().filter((x) => x.user_id).length === 1) {
    cfg.seedContacts.slice(0, MAX_CONTACTS).forEach((c) => contacts.create(r.user.id, { ...c, phone: cleanPhone(c.phone) }));
  }
  console.log(`[web] ${r.user.email} dipasangkan dengan ${id}`);
  return json({ device: devices.ofUser(r.user.id) });
}, { auth: true });

export const DELETE = route(async (r) => {
  if (!r.ctx.checkSecret(r.body?.password ?? '', r.ctx.users.raw(r.user.id).pass_hash)) return json({ error: 'Kata sandi salah.' }, 403);
  r.ctx.devices.unpair(r.device);
  return json({ ok: true });
}, { auth: true, paired: true });
