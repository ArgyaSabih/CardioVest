import { bad, json, route, tooMany } from '#api';

export const GET = route(async (r) => {
  const sim = r.ctx.live(r.device).sim;
  return json({ scenario: sim?.scenario ?? null, title: sim?.title ?? null, scenarios: sim?.scenarios ?? {} });
}, { auth: true, paired: true });

export const POST = route(async (r) => {
  const limit = tooMany(r, 'scenario', 30);
  if (limit) return limit;
  const name = String(r.body?.name ?? '');
  const known = r.ctx.live(r.device).sim?.scenarios;
  if (!/^[a-z_]{2,32}$/.test(name) || (known && Object.keys(known).length && !(name in known))) return bad('Skenario tidak dikenal.');
  const out = r.ctx.simCommand(r.device, r.user, { cmd: 'skenario', name });
  if (!out.ok) return json({ error: out.error }, out.status);
  return json({ ok: true, scenario: name }, 202);
}, { auth: true, paired: true });
