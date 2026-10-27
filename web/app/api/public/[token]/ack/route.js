import { json, route, tooMany } from '@/lib/api';

export const dynamic = 'force-dynamic';

// Halaman 6: tautan darurat publik untuk kontak, tanpa login (F-APP-5, F-APP-7)
function publicEvent(ctx, token) {
  const l = ctx.linkOf(token);
  const ev = l && ctx.cloud.getEvent(l.device_id, l.event_id);
  if (!ev) return { error: json({ error: 'Tautan darurat tidak dikenal atau sudah tidak berlaku.' }, 404) };
  if (ev.end_ts && Date.now() - ev.end_ts > 24 * 3600_000) return { error: json({ error: 'Tautan darurat ini sudah kedaluwarsa.' }, 410) };
  return { link: l, ev };
}

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
