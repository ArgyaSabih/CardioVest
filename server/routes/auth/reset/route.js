import { bad, json, route } from '#api';

export const POST = route(async (r) => {
  if ((r.body?.password ?? '').length < 8) return bad('Kata sandi minimal 8 karakter.');
  const uid = r.ctx.tokens.use(r.body?.token, 'reset');
  if (!uid) return bad('Tautan atur ulang tidak berlaku atau sudah kedaluwarsa.');
  r.ctx.users.setPassword(uid, r.body.password);
  r.ctx.users.verify(uid);
  return json({ token: r.ctx.sign(uid) });
});
