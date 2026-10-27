import { json, route } from '@/lib/api';

export const dynamic = 'force-dynamic';

export const GET = route(async (r) =>
  json(r.ctx.cloud.trend(r.device, Date.now() - Math.min(72, Number(r.query.hours) || 24) * 3600_000)), { auth: true, paired: true });
