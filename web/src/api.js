export const API_URL = '';
export const REALTIME_URL = process.env.NEXT_PUBLIC_BACKEND_URL || undefined;

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
