import { bad, json, route, tooMany } from '@/lib/api';

export const dynamic = 'force-dynamic';

// tautan undangan: kontak menyalakan notifikasi darurat tanpa membuat akun
const unknown = () => json({ error: 'Tautan undangan tidak dikenal atau sudah diganti.' }, 404);

export const POST = route(async (r) => {
  const limit = tooMany(r, 'join');
  if (limit) return limit;
  const c = r.ctx.contacts.byCode(r.params.code);
  if (!c) return unknown();
  const s = r.body?.subscription;
  if (!s?.endpoint || !s?.keys?.p256dh || !s?.keys?.auth) return bad('Data langganan tidak lengkap.');
  r.ctx.subs.add(s, 'contact', c.id, String(r.body.label ?? '').slice(0, 60));
  r.ctx.contacts.markJoined(c.id);
  return json({ ok: true });
});
