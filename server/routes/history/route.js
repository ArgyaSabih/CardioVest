import { json, route } from '#api';

export const GET = route(async (r) => {
  const { cloud } = r.ctx;
  const { type, from, to } = r.query;
  const rows = cloud.listEvents(r.device, {
    type: ['warning', 'critical'].includes(type) ? type : null, from, to, limit: Math.min(500, Number(r.query.limit) || 200),
  });
  return json(rows.map((e) => {
    const inf = cloud.triggerInference(r.device, e.start_ts);
    return { ...e, class: inf?.cls ?? null, confidence: e.peak_conf ?? inf?.p_conf ?? null };
  }));
}, { auth: true, paired: true });
