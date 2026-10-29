import { json, route, withLink } from '#api';

export const POST = route(async (r) => {
  const { contacts, cfg } = r.ctx;
  const id = Number(r.params.id);
  if (!contacts.get(r.user.id, id)) return json({ error: 'Kontak tidak ditemukan.' }, 404);
  contacts.rotate(r.user.id, id);
  const c = contacts.get(r.user.id, id);
  return json(withLink(cfg, c));
}, { auth: true });
