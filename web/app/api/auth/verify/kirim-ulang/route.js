import { json, route, tooMany } from '@/lib/api';

export const dynamic = 'force-dynamic';

export const POST = route(async (r) => {
  const limit = tooMany(r, 'verify', 5);
  if (limit) return limit;
  if (r.user.email_verified) return json({ ok: true });
  await r.ctx.verifyMail(r.user, r.ctx.tokens.issue(r.user.id, 'verify'));
  return json({ ok: true, email_sent: r.ctx.mailConfigured() });
}, { auth: true });
