import { api } from './api.js';

export const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
export const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent);
export const isStandalone = () => window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true;

export function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || process.env.NODE_ENV === 'development') return Promise.resolve(null);
  return navigator.serviceWorker.register('/sw.js').catch(() => null);
}

function b64ToBytes(b64) {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

export async function currentSubscription() {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.getRegistration();
  return (await reg?.pushManager.getSubscription()) ?? null;
}

async function subscribe() {
  if (!pushSupported()) {
    throw new Error(isIos() && !isStandalone()
      ? 'Di iPhone, notifikasi baru bisa dinyalakan setelah aplikasi ditambahkan ke Layar Utama (Bagikan → Tambahkan ke Layar Utama), lalu dibuka dari ikon itu.'
      : 'Browser ini tidak mendukung notifikasi push. Pakai Chrome atau Firefox terbaru.');
  }
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('Izin notifikasi ditolak. Aktifkan lagi dari pengaturan situs di browser.');
  const reg = (await navigator.serviceWorker.getRegistration()) || (await registerServiceWorker());
  if (!reg) throw new Error('Service worker belum aktif. Muat ulang halaman lalu coba lagi.');
  await navigator.serviceWorker.ready;
  const { key } = await api('/push/key', { auth: false });
  return (await reg.pushManager.getSubscription())
    || (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(key) }));
}

const label = () => {
  const ua = navigator.userAgent;
  const m = ua.match(/\(([^;)]+);[^)]*?([A-Za-z0-9 -]+)\sBuild/) || ua.match(/\(([^)]+)\)/);
  return (m?.[2] || m?.[1] || 'ponsel').slice(0, 60);
};

export async function enablePush() {
  const sub = await subscribe();
  await api('/push/subscribe', { method: 'POST', body: { subscription: sub.toJSON(), label: label() } });
  return sub;
}

export async function enablePushForContact(code) {
  const sub = await subscribe();
  await api(`/join/${code}/push`, { method: 'POST', auth: false, body: { subscription: sub.toJSON(), label: label() } });
  return sub;
}

export async function disablePush() {
  const sub = await currentSubscription();
  if (!sub) return;
  await api('/push/subscribe', { method: 'DELETE', body: { endpoint: sub.endpoint } }).catch(() => {});
  await sub.unsubscribe();
}
