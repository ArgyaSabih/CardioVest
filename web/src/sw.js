import { BackgroundSyncPlugin } from 'workbox-background-sync';
import { ExpirationPlugin } from 'workbox-expiration';
import { registerRoute, setCatchHandler } from 'workbox-routing';
import { CacheFirst, NetworkFirst, NetworkOnly } from 'workbox-strategies';

const PAGES = 'halaman-v1';
const STATIC = 'statis-v1';
const API = 'api-24jam';
const KEEP = [PAGES, STATIC, API];
const WARM = ['/', '/riwayat', '/kontak', '/akun', '/masuk', '/pasangkan'];

async function warmUp() {
  const pages = await caches.open(PAGES);
  const statics = await caches.open(STATIC);
  const assets = new Set();
  await Promise.all(WARM.map(async (path) => {
    try {
      const res = await fetch(path, { credentials: 'same-origin' });
      if (!res.ok) return;
      const html = await res.clone().text();
      for (const m of html.matchAll(/["'(](\/_next\/static\/[^"'()\s]+)/g)) assets.add(m[1]);
      await pages.put(path, res);
    } catch {
    }
  }));
  await Promise.all([...assets].map((u) => statics.add(u).catch(() => {})));
}

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(warmUp());
});
self.addEventListener('activate', (e) => e.waitUntil((async () => {
  const names = await caches.keys();
  await Promise.all(names.filter((n) => !KEEP.includes(n) && !n.startsWith('workbox-')).map((n) => caches.delete(n)));
  await self.clients.claim();
})()));

registerRoute(
  ({ url, request }) => url.origin === self.location.origin
    && (url.pathname.startsWith('/_next/static/') || url.pathname.startsWith('/icons/') || request.destination === 'font'),
  new CacheFirst({ cacheName: STATIC, plugins: [new ExpirationPlugin({ maxEntries: 150, maxAgeSeconds: 30 * 24 * 3600 })] }),
);

registerRoute(
  ({ request, url }) => request.mode === 'navigate' && !/^\/(api|data)\//.test(url.pathname),
  new NetworkFirst({ cacheName: PAGES, networkTimeoutSeconds: 5, plugins: [new ExpirationPlugin({ maxEntries: 40 })] }),
);

registerRoute(
  ({ url, request }) => request.method === 'GET' && /^\/api\/(history|users\/me|contacts|status|trend)/.test(url.pathname),
  new NetworkFirst({ cacheName: API, networkTimeoutSeconds: 4, plugins: [new ExpirationPlugin({ maxEntries: 120, maxAgeSeconds: 24 * 3600 })] }),
);

const contactSync = new BackgroundSyncPlugin('perubahan-kontak', { maxRetentionTime: 24 * 60 });
for (const method of ['POST', 'PUT', 'DELETE']) {
  registerRoute(({ url }) => /^\/api\/contacts(\/\d+)?$/.test(url.pathname), new NetworkOnly({ plugins: [contactSync] }), method);
}

setCatchHandler(async ({ request }) => {
  if (request.mode === 'navigate') {
    const page = await caches.open(PAGES);
    const hit = (await page.match(request, { ignoreSearch: true })) || (await page.match('/'));
    if (hit) return hit;
  }
  return Response.error();
});

self.addEventListener('push', (event) => {
  let d = {};
  try {
    d = event.data ? event.data.json() : {};
  } catch {
    d = { title: 'CardioVest', body: event.data?.text() };
  }
  const kind = String(d.kind || '');
  const loud = kind === 'critical' || kind === 'critical_fall';
  event.waitUntil(
    self.registration.showNotification(d.title || 'CardioVest', {
      body: d.body || '',
      tag: d.tag || 'cv',
      renotify: true,
      requireInteraction: loud,
      vibrate: loud ? [500, 150, 500, 150, 900] : [200],
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      actions: d.ack ? [{ action: 'terima', title: 'Saya terima' }, { action: 'buka', title: 'Lihat lokasi' }] : [],
      data: { url: d.url || '/', ack: d.ack || null },
    }),
  );
});

async function openOrFocus(url) {
  const target = new URL(url, self.location.origin).href;
  const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const w of wins) {
    if ('navigate' in w && 'focus' in w) {
      await w.navigate(target).catch(() => {});
      return w.focus();
    }
  }
  return self.clients.openWindow(target);
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const { url, ack } = event.notification.data || {};
  event.waitUntil((async () => {
    if (event.action === 'terima' && ack) {
      await fetch(`/api/public/${ack.token}/ack`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ k: ack.k }),
      }).catch(() => {});
    }
    return openOrFocus(url || '/');
  })());
});
