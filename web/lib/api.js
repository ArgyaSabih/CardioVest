// Pembungkus Route Handlers (app/api). Logika tiap endpoint ada di berkas route.js masing-masing; objek
// backend (database, MQTT, Socket.IO, Web Push) dibuat sekali oleh server.mjs dan diambil dari
// globalThis, sehingga Route Handlers dan Socket.IO berbagi data yang sama.
// Di Vercel backend tidak ada: permintaan /api sudah diteruskan ke server CardioVest oleh rewrites,
// jadi kode di sini hanya berjalan di server yang menjalankan server.mjs.

export const json = (data, status = 200) => Response.json(data, { status });
export const noContent = () => new Response(null, { status: 204 });
export const bad = (msg) => json({ error: msg }, 400);

const MAX_BODY = 32 * 1024;

/**
 * route(fn, { auth, paired }) -> handler Next.js.
 * fn menerima { req, body, params, query, ip, ctx, user, device } dan mengembalikan Response.
 */
export function route(fn, { auth = false, paired = false } = {}) {
  return async (req, context) => {
    const ctx = globalThis.__cardiovest;
    if (!ctx) return json({ error: 'Backend CardioVest tidak berjalan di server ini. Jalankan lewat server.mjs.' }, 503);
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

/** Pembatas percobaan: mengembalikan Response 429 bila sudah melewati batas, atau null. */
export const tooMany = (r, kind, max = 10) =>
  r.ctx.limited(kind, r.ip, max) ? json({ error: 'Terlalu banyak percobaan. Coba lagi 10 menit lagi.' }, 429) : null;

export const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const PHONE = /^\+?[0-9]{8,15}$/;
export const cleanPhone = (p) => String(p ?? '').replace(/[\s()-]/g, '');

