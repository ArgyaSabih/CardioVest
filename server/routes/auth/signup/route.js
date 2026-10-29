import { bad, cleanPhone, EMAIL, json, PHONE, route, tooMany } from '#api';

export const POST = route(async (r) => {
  const limit = tooMany(r, 'signup');
  if (limit) return limit;
  const { users, tokens, verifyMail, mailConfigured, sign } = r.ctx;
  const { name = '', email = '', password = '', consent } = r.body ?? {};
  const phone = cleanPhone(r.body?.phone);
  if (consent !== true) return bad('Persetujuan pemrosesan data kesehatan wajib dicentang (UU No. 27/2022).');
  if (name.trim().length < 2) return bad('Nama minimal 2 huruf.');
  if (!EMAIL.test(email)) return bad('Format email tidak valid.');
  if (password.length < 8) return bad('Kata sandi minimal 8 karakter.');
  if (phone && !PHONE.test(phone)) return bad('Nomor HP tidak valid, contoh +6281234567890.');
  if (users.byEmail(email)) return json({ error: 'Email sudah terdaftar. Silakan masuk.' }, 409);
  const id = users.create({ name, email, phone, password });
  await verifyMail(users.byId(id), tokens.issue(id, 'verify')).catch((e) => console.warn('[email]', e.message));
  return json({ token: sign(id), email_sent: mailConfigured() }, 201);
});
