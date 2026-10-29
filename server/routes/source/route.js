import { json, route, tooMany } from '#api';

export const GET = route(async (r) => json({ source: r.ctx.live(r.device).source, rekaman: r.ctx.live(r.device).rekaman }), { auth: true, paired: true });

export const POST = route(async (r) => {
  const limit = tooMany(r, 'source', 30);
  if (limit) return limit;
  const out = r.ctx.setSource(r.device, r.user, r.body?.source, r.body?.rekaman ?? null);
  if (!out.ok) return json({ error: out.error }, out.status);
  return json({ ok: true, source: r.body.source }, 202);
}, { auth: true, paired: true });
