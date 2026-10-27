import { bad, cleanPhone, json, PHONE, route } from '@/lib/api';

export const dynamic = 'force-dynamic';

// Halaman 3: kontak darurat (F-APP-4), maksimal 5

function validContact(body) {
  const name = String(body?.name ?? '').trim();
  const phone = cleanPhone(body?.phone);
  const relation = String(body?.relation ?? '').trim().slice(0, 40) || null;
  if (name.length < 2) return { error: bad('Nama minimal 2 huruf.') };
  if (!PHONE.test(phone)) return { error: bad('Nomor HP tidak valid, contoh +6281234567890.') };
  return { contact: { name, phone, relation } };
}
const withLink = (cfg, c) => ({ ...c, invite_url: `${cfg.publicUrl}/gabung/${c.invite_code}` });

export const GET = route(async (r) => json(r.ctx.contacts.ofUser(r.user.id).map((c) => withLink(r.ctx.cfg, c))), { auth: true });

export const POST = route(async (r) => {
  const { contacts, MAX_CONTACTS, cfg } = r.ctx;
  if (contacts.count(r.user.id) >= MAX_CONTACTS) return bad(`Maksimal ${MAX_CONTACTS} kontak darurat.`);
  const v = validContact(r.body);
  if (v.error) return v.error;
  return json(withLink(cfg, contacts.get(r.user.id, contacts.create(r.user.id, v.contact))), 201);
}, { auth: true });
