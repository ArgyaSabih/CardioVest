// Server CardioVest: Next.js (halaman + Route Handlers di app/api) dan backend yang harus hidup terus
// (Socket.IO di /data/realtime, pelanggan MQTT, Web Push) dalam satu proses Node.
//   npm run dev                -> mode pengembangan (hot reload)
//   npm run build && npm start -> produksi (dipakai Docker)
// Di Vercel file ini tidak dipakai: Vercel hanya menyajikan halaman, dan /api diteruskan ke server ini
// oleh proxy.js (lihat README.md).
import crypto from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cfg } from './lib/server/config.js';
import { startBackend } from './lib/server/backend.js';

const dir = path.dirname(fileURLToPath(import.meta.url));
const dev = process.argv.includes('--dev');
process.env.NODE_ENV = dev ? 'development' : 'production';
const { default: next } = await import('next');

const app = next({ dev, dir, hostname: '0.0.0.0', port: cfg.port });
const handle = app.getRequestHandler();
await app.prepare();

// IP klien untuk pembatas percobaan login/pairing. X-Forwarded-For hanya dipercaya bila permintaan datang
// dari proxy di jaringan lokal (Caddy, Docker). Permintaan yang diteruskan Vercel (proxy.js) membawa
// IP pengguna di X-CV-Client-IP, dan header itu hanya dipercaya bila PROXY_SECRET-nya cocok.
const secret = cfg.proxySecret ? Buffer.from(cfg.proxySecret) : null;
function fromVercel(req) {
  const given = Buffer.from(String(req.headers['x-cv-proxy-secret'] || ''));
  return !!secret && given.length === secret.length && crypto.timingSafeEqual(given, secret);
}
const PRIVATE = /^(::1|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::ffff:(127|10|192\.168|172\.(1[6-9]|2\d|3[01]))\.|f[cd])/i;
function clientIp(req) {
  if (fromVercel(req) && req.headers['x-cv-client-ip']) return String(req.headers['x-cv-client-ip']).slice(0, 64);
  const remote = req.socket.remoteAddress || '';
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return PRIVATE.test(remote) && fwd ? fwd : remote;
}

const server = http.createServer((req, res) => {
  req.headers['x-cv-ip'] = clientIp(req);
  delete req.headers['x-cv-proxy-secret'];
  handle(req, res);
});
const backend = startBackend(server);
if (dev) {
  // hot reload Next.js memakai WebSocket di server yang sama; /data/realtime milik Socket.IO
  const upgrade = app.getUpgradeHandler?.();
  if (upgrade) server.on('upgrade', (req, socket, head) => { if (!req.url.startsWith('/data/realtime')) upgrade(req, socket, head); });
}

await new Promise((r) => server.listen(cfg.port, r));
console.log(`[web] CardioVest di port ${server.address().port} (${dev ? 'dev' : 'produksi'}); alat terdaftar: ${backend.devices.all().map((d) => d.device_id).join(', ') || '-'}`);

export { server, backend, app };
