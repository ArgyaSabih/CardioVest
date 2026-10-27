// Klien REST ke /api di origin yang sama. Di server CardioVest (Docker) /api dilayani Route Handlers;
// di Vercel /api diteruskan ke server CardioVest oleh rewrites di next.config.mjs.
export const API_URL = '';
// Socket.IO tidak bisa lewat rewrites Vercel, jadi di sana klien langsung ke server CardioVest.
export const REALTIME_URL = process.env.NEXT_PUBLIC_REALTIME_URL || undefined;

let token = null;
try {
  token = localStorage.getItem('cv_token');
} catch {
  token = null;
}

export function setToken(t) {
  token = t;
  try {
    if (t) localStorage.setItem('cv_token', t);
    else localStorage.removeItem('cv_token');
  } catch {
    /* penyimpanan diblokir: sesi hanya bertahan di memori */
  }
}
export const getToken = () => token;

export class ApiError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/**
 * queueable: perubahan kontak saat offline diantrekan Service Worker (Background Sync, Subbab 8.5.6)
 * dan dikirim otomatis saat koneksi pulih; fungsi ini lalu mengembalikan { queued: true }.
 */
export async function api(path, { method = 'GET', body, auth = true, queueable = false } = {}) {
  let res;
  try {
    res = await fetch(`${API_URL}/api${path}`, {
      method,
      headers: {
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...(auth && token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    if (queueable && navigator.serviceWorker?.controller) return { queued: true };
    throw new ApiError(0, 'Tidak ada koneksi ke server. Periksa internet ponsel.');
  }
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && auth) {
      setToken(null);
      window.dispatchEvent(new Event('cv:logout'));
    }
    if (res.status === 409 && data.code === 'belum_pairing') window.dispatchEvent(new Event('cv:belum-pairing'));
    throw new ApiError(res.status, data.error || `Server membalas ${res.status}`, data.code);
  }
  return data;
}
