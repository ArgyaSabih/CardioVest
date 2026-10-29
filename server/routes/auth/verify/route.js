import { bad, json, route } from '#api';

export const POST = route(async (r) => {
  const uid = r.ctx.tokens.use(r.body?.token, 'verify');
  if (!uid) return bad('Tautan verifikasi tidak berlaku atau sudah kedaluwarsa.');
  r.ctx.users.verify(uid);
  return json({ ok: true });
});
