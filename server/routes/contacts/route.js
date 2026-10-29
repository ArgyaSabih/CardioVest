import { bad, json, route, validContact, withLink } from '#api';

export const GET = route(async (r) => json(r.ctx.contacts.ofUser(r.user.id).map((c) => withLink(r.ctx.cfg, c))), { auth: true });

export const POST = route(async (r) => {
  const { contacts, MAX_CONTACTS, cfg } = r.ctx;
  if (contacts.count(r.user.id) >= MAX_CONTACTS) return bad(`Maksimal ${MAX_CONTACTS} kontak darurat.`);
  const v = validContact(r.body);
  if (v.error) return v.error;
  return json(withLink(cfg, contacts.get(r.user.id, contacts.create(r.user.id, v.contact))), 201);
}, { auth: true });
