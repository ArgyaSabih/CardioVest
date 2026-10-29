import { json, publicEvent, route } from '#api';

export const GET = route(async (r) => {
  const { cloud, live, devices, contacts, acks } = r.ctx;
  const p = publicEvent(r.ctx, r.params.token);
  if (p.error) return p.error;
  const { link, ev } = p;
  const L = live(link.device_id);
  const owner = devices.ownerOf(link.device_id);
  const active = !ev.end_ts;
  const fix = (active && L.trail.at(-1)) || (() => {
    const f = cloud.lastFix(link.device_id, ev.start_ts - 60_000, ev.end_ts ?? Date.now());
    return f && { lat: f.lat, lng: f.lon, acc: f.gps_accuracy_m, ts: f.ts };
  })() || (ev.lat != null ? { lat: ev.lat, lng: ev.lon } : null);
  const me = r.query.k ? contacts.byCode(r.query.k) : null;
  return json({
    user_name: owner?.name ?? 'Pemakai CardioVest',
    user_phone: owner?.phone ?? null,
    active,
    started_at: ev.start_ts,
    ended_at: ev.end_ts,
    end_reason: ev.end_reason ?? null,
    fall_detected: ev.fall_detected,
    location: fix,
    trail: active ? L.trail : [],
    device_online: L.online,
    hr: active ? L.vital?.hr ?? null : null,
    acks: acks.forEvent(link.device_id, ev.id).map((a) => ({ name: a.name, ts: a.ts })),
    me: me && me.user_id === owner?.id ? { name: me.name } : null,
  });
});
