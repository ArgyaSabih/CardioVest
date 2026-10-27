import { bad, json, route, tooMany } from '@/lib/api';

export const dynamic = 'force-dynamic';

// Tombol "Hentikan alarm" di beranda User Utama. Permintaan hanya diteruskan ke cloud; status baru berubah
// setelah cloud memerintahkan alat melepas kunci CRITICAL dan menerbitkan state NORMAL lewat Socket.IO.
export const POST = route(async (r) => {
  const limit = tooMany(r, 'reset', 5);
  if (limit) return limit;
  if (r.body?.confirm !== true) return bad('Konfirmasi diperlukan untuk menghentikan alarm.');
  const out = r.ctx.remoteReset(r.device, r.user);
  if (!out.ok) return json({ error: out.error }, out.status);
  return json({ ok: true }, 202);
}, { auth: true, paired: true });
