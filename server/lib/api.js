export const json = (data, status = 200) => Response.json(data, { status });
export const noContent = () => new Response(null, { status: 204 });
export const bad = (msg) => json({ error: msg }, 400);

const MAX_BODY = 32 * 1024;

export function route(fn, { auth = false, paired = false } = {}) {
  return async (req, context) => {
    const ctx = globalThis.__cardiovest;
    if (!ctx) return json({ error: 'Backend CardioVest belum siap.' }, 503);
    const params = (await context?.params) ?? {};
    let body = null;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      if (Number(req.headers.get('content-length') || 0) > MAX_BODY) return json({ error: 'Permintaan terlalu besar.' }, 413);
      body = await req.json().catch(() => null);
    }
    const r = {
      req, body, params, ctx,
      query: Object.fromEntries(new URL(req.url).searchParams),
      ip: req.headers.get('x-cv-ip') || 'tidak-diketahui',
      user: null,
      device: null,
    };
    if (auth) {
      r.user = ctx.userFromAuth(req.headers.get('authorization'));
      if (!r.user) return json({ error: 'Sesi berakhir. Silakan masuk lagi.' }, 401);
      r.device = ctx.devices.ofUser(r.user.id)?.device_id ?? null;
    }
    if (paired && !r.device) return json({ error: 'Akun belum dipasangkan dengan alat.', code: 'belum_pairing' }, 409);
    try {
      return await fn(r);
    } catch (e) {
      console.error('[api]', req.method, new URL(req.url).pathname, e);
      return json({ error: 'Terjadi kesalahan di server. Coba lagi sebentar lagi.' }, 500);
    }
  };
}

export const tooMany = (r, kind, max = 10) =>
  r.ctx.limited(kind, r.ip, max) ? json({ error: 'Terlalu banyak percobaan. Coba lagi 10 menit lagi.' }, 429) : null;

export const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const PHONE = /^\+?[0-9]{8,15}$/;
export const cleanPhone = (p) => String(p ?? '').replace(/[\s()-]/g, '');


export function validContact(body) {
  const name = String(body?.name ?? '').trim();
  const phone = cleanPhone(body?.phone);
  const relation = String(body?.relation ?? '').trim().slice(0, 40) || null;
  if (name.length < 2) return { error: bad('Nama minimal 2 huruf.') };
  if (!PHONE.test(phone)) return { error: bad('Nomor HP tidak valid, contoh +6281234567890.') };
  return { contact: { name, phone, relation } };
}

export const withLink = (cfg, c) => ({ ...c, invite_url: `${cfg.publicUrl}/gabung/${c.invite_code}` });

export const unknownInvite = () => json({ error: 'Tautan undangan tidak dikenal atau sudah diganti.' }, 404);

export function publicEvent(ctx, token) {
  const l = ctx.linkOf(token);
  const ev = l && ctx.cloud.getEvent(l.device_id, l.event_id);
  if (!ev) return { error: json({ error: 'Tautan darurat tidak dikenal atau sudah tidak berlaku.' }, 404) };
  if (ev.end_ts && Date.now() - ev.end_ts > 24 * 3600_000) return { error: json({ error: 'Tautan darurat ini sudah kedaluwarsa.' }, 410) };
  return { link: l, ev };
}
