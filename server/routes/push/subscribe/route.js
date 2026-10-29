import { bad, json, route } from '#api';

const validSub = (s) => s?.endpoint && s?.keys?.p256dh && s?.keys?.auth;

export const POST = route(async (r) => {
  if (!validSub(r.body?.subscription)) return bad('Data langganan tidak lengkap.');
  r.ctx.subs.add(r.body.subscription, 'user', r.user.id, String(r.body.label ?? '').slice(0, 60));
  return json({ ok: true });
}, { auth: true });

export const DELETE = route(async (r) => {
  if (r.body?.endpoint) r.ctx.subs.remove(r.body.endpoint);
  return json({ ok: true });
}, { auth: true });
