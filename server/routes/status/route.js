import { json, route } from '#api';

export const GET = route(async (r) => json(r.ctx.statusOf(r.device, r.user)), { auth: true, paired: true });
