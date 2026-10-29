import { json, route } from '#api';

export const GET = route(async (r) => {
  const ev = r.ctx.cloud.getEvent(r.device, Number(r.params.id));
  if (!ev) return json({ error: 'Kejadian tidak ditemukan.' }, 404);
  const strip = r.ctx.cloud.ecgStrip(r.device, ev.start_ts - 20_000, ev.start_ts + 20_000);
  return json({ ...strip, mark_at: Math.max(0, Math.round(((ev.start_ts - strip.t0) / 1000) * strip.fs)) });
}, { auth: true, paired: true });
