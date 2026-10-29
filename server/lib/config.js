import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const env = (k, d = '') => process.env[k] ?? d;

function json(k, fallback) {
  try {
    return JSON.parse(env(k, '')) ?? fallback;
  } catch {
    return fallback;
  }
}

function deviceSeeds() {
  const list = env('DEVICES', '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const [id, code] = s.split(':');
      return { id: id.trim(), code: (code ?? '').trim() };
    });
  if (env('DEVICE_ID') && !list.some((d) => d.id === env('DEVICE_ID'))) list.push({ id: env('DEVICE_ID'), code: env('KODE_PAIRING') });
  return list.filter((d) => /^[A-Za-z0-9_-]{2,32}$/.test(d.id));
}

export const cfg = {
  port: Number(env('PORT', '8080')),
  mqttUrl: env('MQTT_URL', 'mqtt://localhost:1883'),
  mqttUser: env('MQTT_USER'),
  mqttPass: env('MQTT_PASS'),
  cloudDb: env('CLOUD_DB', '/cloud-data/cardiovest.db'),
  dataDir: env('DATA_DIR', './data'),
  publicUrl: env('PUBLIC_URL', '').replace(/\/$/, ''),
  proxySecret: env('PROXY_SECRET', ''),
  allowedOrigins: env('ALLOWED_ORIGINS', '').split(',').map((s) => s.trim().replace(/\/$/, '')).filter(Boolean),
  devices: deviceSeeds(),
  remoteReset: env('REMOTE_RESET', '1') !== '0',
  simulator: env('SIMULATOR', '1') !== '0',
  seedContacts: json('CONTACTS_JSON', []).filter((c) => c && c.phone),
  smtpUrl: env('SMTP_URL'),
  mailFrom: env('MAIL_FROM', 'CardioVest <no-reply@cardiovest.local>'),
  vapidSubject: env('VAPID_SUBJECT', 'mailto:admin@cardiovest.local'),
  pushBaseDelayMs: Number(env('PUSH_BASE_DELAY_MS', '1000')),
};

fs.mkdirSync(cfg.dataDir, { recursive: true });

function persisted(name, make) {
  const f = path.join(cfg.dataDir, name);
  try {
    return fs.readFileSync(f, 'utf8').trim();
  } catch {
    const v = make();
    fs.writeFileSync(f, v, { mode: 0o600 });
    return v;
  }
}

const originPatterns = cfg.allowedOrigins.map((o) => new RegExp(`^${o.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[a-z0-9-]+')}$`, 'i'));
export const originAllowed = (origin) => !origin || originPatterns.some((p) => p.test(origin));

cfg.jwtSecret = env('WEB_JWT_SECRET') || persisted('jwt_secret', () => crypto.randomBytes(32).toString('hex'));
