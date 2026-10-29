import { json, route, unknownInvite } from '#api';

export const GET = route(async (r) => {
  const c = r.ctx.contacts.byCode(r.params.code);
  if (!c) return unknownInvite();
  return json({ name: c.name, user_name: r.ctx.users.byId(c.user_id)?.name, notifications: c.notifications });
});
