import { json, publicEvent, route, tooMany } from '#api';

export const POST = route(async (r) => {
  const limit = tooMany(r, 'ack', 20);
  if (limit) return limit;
  const { devices, contacts, acks, io } = r.ctx;
  const p = publicEvent(r.ctx, r.params.token);
  if (p.error) return p.error;
  const { link, ev } = p;
  const owner = devices.ownerOf(link.device_id);
  const c = r.body?.k ? contacts.byCode(r.body.k) : null;
  const contact = c && c.user_id === owner?.id ? c : null;
  const name = contact?.name ?? (String(r.body?.name ?? '').trim().slice(0, 40) || 'Penerima tautan');
  acks.add(link.device_id, ev.id, contact?.id ?? null, name);
  const list = acks.forEvent(link.device_id, ev.id);
  io.to(`dev:${link.device_id}`).to(`pub:${r.params.token}`).emit('ack', { name, ts: Date.now(), acks: list });
  return json({ ok: true, acks: list.map((a) => ({ name: a.name, ts: a.ts })) });
});
