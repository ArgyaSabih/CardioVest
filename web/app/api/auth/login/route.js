import { json, route, tooMany } from '@/lib/api';

export const dynamic = 'force-dynamic';

export const POST = route(async (r) => {
  const limit = tooMany(r, 'login');
  if (limit) return limit;
  const { users, checkSecret, sign, clearLimit } = r.ctx;
  const u = users.byEmail(r.body?.email ?? '');
  if (!u || !checkSecret(r.body?.password ?? '', u.pass_hash)) return json({ error: 'Email atau kata sandi salah.' }, 401);
  clearLimit('login', r.ip);
  return json({ token: sign(u.id) });
});
