import { json, route, tooMany } from '#api';

export const POST = route(async (r) => {
  const limit = tooMany(r, 'forgot', 5);
  if (limit) return limit;
  const u = r.ctx.users.byEmail(r.body?.email ?? '');
  if (u) await r.ctx.resetMail(u, r.ctx.tokens.issue(u.id, 'reset')).catch((e) => console.warn('[email]', e.message));
  return json({ ok: true });
});
