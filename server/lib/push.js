import fs from 'node:fs';
import path from 'node:path';
import webpush from 'web-push';
import { cfg } from './config.js';
import { notifLog, subs } from './store.js';

const keyFile = path.join(cfg.dataDir, 'vapid.json');
let keys;
if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  keys = { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
} else {
  try {
    keys = JSON.parse(fs.readFileSync(keyFile, 'utf8'));
  } catch {
    keys = webpush.generateVAPIDKeys();
    fs.writeFileSync(keyFile, JSON.stringify(keys), { mode: 0o600 });
  }
}
webpush.setVapidDetails(cfg.vapidSubject, keys.publicKey, keys.privateKey);

export const vapidPublicKey = keys.publicKey;

const MAX_ATTEMPTS = 5;
const MAX_WAIT_MS = 32_000;
export const backoff = (n, base = cfg.pushBaseDelayMs) => Math.min(MAX_WAIT_MS, base * 2 ** n + Math.random() * base * 0.5);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const retryable = (e) => !e.statusCode || e.statusCode === 429 || e.statusCode >= 500;

let sender = (sub, body, opts) => webpush.sendNotification(sub, body, opts);
export const _setSender = (fn) => {
  sender = fn;
};

async function sendOne(sub, body, opts) {
  for (let n = 0; n < MAX_ATTEMPTS; n++) {
    try {
      await sender(sub, body, opts);
      return { ok: true, attempts: n + 1 };
    } catch (e) {
      if ([404, 410].includes(e.statusCode)) {
        subs.remove(sub.endpoint);
        return { ok: false, attempts: n + 1, error: `langganan kedaluwarsa (${e.statusCode})` };
      }
      if (!retryable(e) || n === MAX_ATTEMPTS - 1) return { ok: false, attempts: n + 1, error: e.statusCode ? `HTTP ${e.statusCode}` : e.message };
      await sleep(backoff(n));
    }
  }
  return { ok: false, attempts: MAX_ATTEMPTS, error: 'gagal' };
}

export async function dispatch({ deviceId, audience, build, urgent = false, eventId = null, eventType, list, log = true }) {
  const targets = list ?? subs.forDevice(deviceId, audience);
  const res = await Promise.all(targets.map((s) => {
    const payload = build(s);
    const opts = { TTL: urgent ? 3600 : 600, urgency: urgent ? 'high' : 'normal', topic: payload.tag?.slice(0, 32) };
    return sendOne(s, JSON.stringify(payload), opts);
  }));
  const r = {
    device_id: deviceId,
    event_id: eventId,
    event_type: eventType,
    audience: audience ?? 'langsung',
    recipients: targets.length,
    delivered: res.filter((x) => x.ok).length,
    attempts: res.reduce((m, x) => Math.max(m, x.attempts), 0),
    error: [...new Set(res.filter((x) => !x.ok).map((x) => x.error))].join('; ') || null,
  };
  if (log) notifLog.add(r);
  return r;
}
