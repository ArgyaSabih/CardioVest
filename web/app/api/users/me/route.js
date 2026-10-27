import { bad, cleanPhone, json, PHONE, route } from '@/lib/api';

export const dynamic = 'force-dynamic';

export const GET = route(async (r) =>
  json({ user: r.user, device: r.ctx.devices.ofUser(r.user.id), email_configured: r.ctx.mailConfigured() }), { auth: true });

export const PUT = route(async (r) => {
  const { users, checkSecret } = r.ctx;
  const { name, password, current_password: cur } = r.body ?? {};
  const phone = cleanPhone(r.body?.phone);
  if (name != null && name.trim().length < 2) return bad('Nama minimal 2 huruf.');
  if (phone && !PHONE.test(phone)) return bad('Nomor HP tidak valid, contoh +6281234567890.');
  if (password) {
    if (password.length < 8) return bad('Kata sandi baru minimal 8 karakter.');
    if (!checkSecret(cur ?? '', users.raw(r.user.id).pass_hash)) return json({ error: 'Kata sandi lama salah.' }, 403);
    users.setPassword(r.user.id, password);
  }
  users.update(r.user.id, { name: name?.trim(), phone: phone || null });
  return json({ user: users.byId(r.user.id) });
}, { auth: true });
