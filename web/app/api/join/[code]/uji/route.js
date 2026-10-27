import { json, route, tooMany } from '@/lib/api';

export const dynamic = 'force-dynamic';

// tautan undangan: kontak menyalakan notifikasi darurat tanpa membuat akun
const unknown = () => json({ error: 'Tautan undangan tidak dikenal atau sudah diganti.' }, 404);

export const POST = route(async (r) => {
  const limit = tooMany(r, 'join');
  if (limit) return limit;
  const c = r.ctx.contacts.byCode(r.params.code);
  if (!c) return unknown();
  const name = r.ctx.users.byId(c.user_id)?.name;
  return json(await r.ctx.dispatch({
    list: r.ctx.subs.forOwner('contact', c.id), eventType: 'test', log: false,
    build: () => ({ title: 'Uji notifikasi CardioVest', body: `Ponsel ini akan dikabari bila ${name} dalam keadaan darurat.`, kind: 'test', url: `/gabung/${r.params.code}`, tag: 'uji' }),
  }));
});
