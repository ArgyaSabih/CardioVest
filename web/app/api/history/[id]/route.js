import { json, route } from '@/lib/api';

export const dynamic = 'force-dynamic';

// Halaman 5: detail kejadian
export const GET = route(async (r) => {
  const { cloud, notifLog, acks } = r.ctx;
  const ev = cloud.getEvent(r.device, Number(r.params.id));
  if (!ev) return json({ error: 'Kejadian tidak ditemukan.' }, 404);
  const to = Math.min(ev.end_ts ?? Date.now(), ev.start_ts + 30 * 60_000) + 60_000;
  const inf = cloud.triggerInference(r.device, ev.start_ts);
  return json({
    ...ev,
    class: inf?.cls ?? null,
    probs: inf ? [inf.p_normal, inf.p_pre, inf.p_attack] : null,
    transitions: cloud.transitions(r.device, ev.start_ts - 30_000, to), // WARNING pendahulu ikut terlihat
    vitals: cloud.vitals(r.device, ev.start_ts - 60_000, to).map((v) => ({ ts: v.ts, hr: v.hr, gsr: v.gsr, fall: !!v.fall_detected })),
    location: ev.lat != null ? { lat: ev.lat, lng: ev.lon } : null,
    notifications: notifLog.forEvent(r.device, ev.id),
    acks: acks.forEvent(r.device, ev.id),
  });
}, { auth: true, paired: true });
