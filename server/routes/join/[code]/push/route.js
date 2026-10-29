import { bad, json, route, tooMany, unknownInvite } from '#api';

export const POST = route(async (r) => {
  const limit = tooMany(r, 'join');
  if (limit) return limit;
  const c = r.ctx.contacts.byCode(r.params.code);
  if (!c) return unknownInvite();
  const s = r.body?.subscription;
  if (!s?.endpoint || !s?.keys?.p256dh || !s?.keys?.auth) return bad('Data langganan tidak lengkap.');
  r.ctx.subs.add(s, 'contact', c.id, String(r.body.label ?? '').slice(0, 60));
  r.ctx.contacts.markJoined(c.id);
  return json({ ok: true });
});
