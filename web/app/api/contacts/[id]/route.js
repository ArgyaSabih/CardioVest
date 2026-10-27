import { bad, cleanPhone, json, noContent, PHONE, route } from '@/lib/api';

export const dynamic = 'force-dynamic';

function validContact(body) {
  const name = String(body?.name ?? '').trim();
  const phone = cleanPhone(body?.phone);
  const relation = String(body?.relation ?? '').trim().slice(0, 40) || null;
  if (name.length < 2) return { error: bad('Nama minimal 2 huruf.') };
  if (!PHONE.test(phone)) return { error: bad('Nomor HP tidak valid, contoh +6281234567890.') };
  return { contact: { name, phone, relation } };
}
const withLink = (cfg, c) => ({ ...c, invite_url: `${cfg.publicUrl}/gabung/${c.invite_code}` });

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
