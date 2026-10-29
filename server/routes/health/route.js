import { json, route } from '#api';

export const GET = route(async (r) => json({ ok: true, mqtt: r.ctx.mq.connected, cloud_db: r.ctx.cloud.cloudDbReady() }));
