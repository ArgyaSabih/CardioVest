import { json, route } from '@/lib/api';

export const dynamic = 'force-dynamic';

export const GET = route(async (r) => json({ key: r.ctx.vapidPublicKey }));
