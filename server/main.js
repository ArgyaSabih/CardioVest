import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { cfg } from './lib/config.js';
import { startBackend } from './lib/backend.js';

const ROUTES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'routes');
const MAX_BODY = 32 * 1024;
const PRIVATE = /^(::1|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::ffff:(127|10|192\.168|172\.(1[6-9]|2\d|3[01]))\.|f[cd])/i;
const secret = cfg.proxySecret ? Buffer.from(cfg.proxySecret) : null;

async function loadRoutes() {
  const files = fs.readdirSync(ROUTES_DIR, { recursive: true }).filter((f) => path.basename(f) === 'route.js');
  const routes = await Promise.all(files.map(async (f) => {
    const segs = path.dirname(f).split(path.sep).filter((s) => s && s !== '.');
    return { segs, mod: await import(pathToFileURL(path.join(ROUTES_DIR, f)).href) };
  }));
  return routes.sort((a, b) => b.segs.filter((s) => !s.startsWith('[')).length - a.segs.filter((s) => !s.startsWith('[')).length);
}

function match(routes, pathname) {
  const parts = pathname.split('/').filter(Boolean).map(decodeURIComponent);
  for (const r of routes) {
    if (r.segs.length !== parts.length) continue;
    const params = {};
    if (r.segs.every((s, i) => (s.startsWith('[') ? ((params[s.slice(1, -1)] = parts[i]), true) : s === parts[i]))) return { ...r, params };
  }
  return null;
}

function fromVercel(req) {
  const given = Buffer.from(String(req.headers['x-cv-proxy-secret'] || ''));
  return !!secret && given.length === secret.length && crypto.timingSafeEqual(given, secret);
}

function clientIp(req) {
  if (fromVercel(req) && req.headers['x-cv-client-ip']) return String(req.headers['x-cv-client-ip']).slice(0, 64);
  const remote = req.socket.remoteAddress || '';
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return PRIVATE.test(remote) && fwd ? fwd : remote;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size <= MAX_BODY) chunks.push(c);
    });
    req.on('end', () => (size > MAX_BODY ? reject(Object.assign(new Error('terlalu besar'), { status: 413 })) : resolve(Buffer.concat(chunks))));
    req.on('error', reject);
  });
}

const send = (res, status, data) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
};

const routes = await loadRoutes();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/data/realtime')) return;
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (url.pathname === '/') return send(res, 200, { ok: true, service: 'cardiovest-server' });
  if (!url.pathname.startsWith('/api/')) return send(res, 404, { error: 'Tidak ditemukan.' });
  const hit = match(routes, url.pathname.slice(4));
  const handler = hit?.mod[req.method === 'HEAD' ? 'GET' : req.method];
  if (!hit) return send(res, 404, { error: 'Endpoint tidak dikenal.' });
  if (!handler) return send(res, 405, { error: 'Metode tidak didukung.' });
  if (Number(req.headers['content-length'] || 0) > MAX_BODY) return send(res, 413, { error: 'Permintaan terlalu besar.' });
  try {
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (k !== 'x-cv-proxy-secret') headers.set(k, Array.isArray(v) ? v.join(', ') : v);
    headers.set('x-cv-ip', clientIp(req));
    const hasBody = !['GET', 'HEAD'].includes(req.method);
    const request = new Request(url, { method: req.method, headers, body: hasBody ? await readBody(req) : undefined });
    const response = await handler(request, { params: hit.params });
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(req.method === 'HEAD' ? undefined : Buffer.from(await response.arrayBuffer()));
  } catch (e) {
    if (e.status === 413) return send(res, 413, { error: 'Permintaan terlalu besar.' });
    console.error('[api]', req.method, url.pathname, e);
    if (!res.headersSent) send(res, 500, { error: 'Terjadi kesalahan di server.' });
  }
});

const backend = startBackend(server);
await new Promise((r) => server.listen(cfg.port, r));
console.log(`[server] CardioVest di port ${server.address().port}; alat terdaftar: ${backend.devices.all().map((d) => d.device_id).join(', ') || '-'}`);

const stop = () => {
  backend.mq.end(true);
  backend.io.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);

export { server, backend };
