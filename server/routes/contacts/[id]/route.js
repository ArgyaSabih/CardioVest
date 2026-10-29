import { json, noContent, route, validContact, withLink } from '#api';

export const PUT = route(async (r) => {
  const { contacts, cfg } = r.ctx;
  const id = Number(r.params.id);
  if (!contacts.get(r.user.id, id)) return json({ error: 'Kontak tidak ditemukan.' }, 404);
  const v = validContact(r.body);
  if (v.error) return v.error;
  contacts.update(r.user.id, id, v.contact);
  return json(withLink(cfg, contacts.get(r.user.id, id)));
}, { auth: true });

export const DELETE = route(async (r) => {
  if (!r.ctx.contacts.remove(r.user.id, Number(r.params.id))) return json({ error: 'Kontak tidak ditemukan.' }, 404);
  return noContent();
}, { auth: true });
