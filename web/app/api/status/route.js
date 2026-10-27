import { json, route } from '@/lib/api';

export const dynamic = 'force-dynamic';

export const GET = route(async (r) => json(r.ctx.statusOf(r.device, r.user)), { auth: true, paired: true });
