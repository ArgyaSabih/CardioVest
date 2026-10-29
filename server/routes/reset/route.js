import { bad, json, route, tooMany } from '#api';

export const POST = route(async (r) => {
  const limit = tooMany(r, 'reset', 5);
  if (limit) return limit;
  if (r.body?.confirm !== true) return bad('Konfirmasi diperlukan untuk menghentikan alarm.');
  const out = r.ctx.remoteReset(r.device, r.user);
  if (!out.ok) return json({ error: out.error }, out.status);
  return json({ ok: true }, 202);
}, { auth: true, paired: true });
