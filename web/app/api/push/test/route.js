import { json, route } from '@/lib/api';

export const dynamic = 'force-dynamic';

export const POST = route(async (r) => json(await r.ctx.dispatch({
  list: r.ctx.subs.forOwner('user', r.user.id), eventType: 'test', log: false,
  build: () => ({ title: 'Uji notifikasi CardioVest', body: 'Notifikasi berfungsi. Peringatan dari alat akan muncul seperti ini.', kind: 'test', url: '/', tag: 'uji' }),
})), { auth: true });
