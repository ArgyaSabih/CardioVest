import { json, route } from '@/lib/api';

export const dynamic = 'force-dynamic';

// tautan undangan: kontak menyalakan notifikasi darurat tanpa membuat akun
const unknown = () => json({ error: 'Tautan undangan tidak dikenal atau sudah diganti.' }, 404);

export const GET = route(async (r) => {
  const c = r.ctx.contacts.byCode(r.params.code);
  if (!c) return unknown();
  return json({ name: c.name, user_name: r.ctx.users.byId(c.user_id)?.name, notifications: c.notifications });
});
