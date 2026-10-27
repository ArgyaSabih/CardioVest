import { json, route } from '@/lib/api';

export const dynamic = 'force-dynamic';

export const POST = route(async (r) => {
  const { contacts, cfg } = r.ctx;
  const id = Number(r.params.id);
  if (!contacts.get(r.user.id, id)) return json({ error: 'Kontak tidak ditemukan.' }, 404);
  contacts.rotate(r.user.id, id);
  const c = contacts.get(r.user.id, id);
  return json({ ...c, invite_url: `${cfg.publicUrl}/gabung/${c.invite_code}` });
}, { auth: true });
