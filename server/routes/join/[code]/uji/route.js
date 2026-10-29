import { json, route, tooMany, unknownInvite } from '#api';

export const POST = route(async (r) => {
  const limit = tooMany(r, 'join');
  if (limit) return limit;
  const c = r.ctx.contacts.byCode(r.params.code);
  if (!c) return unknownInvite();
  const name = r.ctx.users.byId(c.user_id)?.name;
  return json(await r.ctx.dispatch({
    list: r.ctx.subs.forOwner('contact', c.id), eventType: 'test', log: false,
    build: () => ({ title: 'Uji notifikasi CardioVest', body: `Ponsel ini akan dikabari bila ${name} dalam keadaan darurat.`, kind: 'test', url: `/gabung/${r.params.code}`, tag: 'uji' }),
  }));
});
