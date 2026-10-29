import { json, route } from '#api';

export const GET = route(async (r) => json({ key: r.ctx.vapidPublicKey }));
