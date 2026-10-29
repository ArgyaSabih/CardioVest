import { bad, json, route, tooMany } from '#api';

export const POST = route(async (r) => {
  const limit = tooMany(r, 'mode', 30);
  if (limit) return limit;
  const mode = r.body?.mode;
  if (mode !== 'demo' && mode !== 'test') return bad('Mode harus demo atau test.');
  const out = r.ctx.setMode(r.device, r.user, mode);
  if (!out.ok) return json({ error: out.error }, out.status);
  return json({ ok: true, mode }, 202);
}, { auth: true, paired: true });
