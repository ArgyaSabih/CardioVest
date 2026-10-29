import { json, route, tooMany } from '@/lib/api';

export const dynamic = 'force-dynamic';

// Tombol "Matikan bunyi alat": buzzer di rompi diam, tetapi state Waspada/Darurat, LED, dan notifikasi
// tetap. Mengakhiri Darurat tetap lewat tombol reset di alat atau /api/reset (REMOTE_RESET). Perintah dikirim ke
// topik device/{id}/buzzer, satu-satunya topik yang boleh ditulis akun MQTT "web".
export const POST = route(async (r) => {
  const limit = tooMany(r, 'mute', 20);
  if (limit) return limit;
  const { live, mq, notifLog, cloud } = r.ctx;
  const L = live(r.device);
  const state = L.state?.state ?? 'NORMAL';
  if (state !== 'WARNING' && state !== 'CRITICAL') return json({ error: 'Alat tidak sedang berbunyi.' }, 409);
  if (L.online === false) {
    return json({ error: 'Alat sedang terputus, jadi bunyinya hanya bisa dihentikan dengan tombol reset di alat.' }, 409);
  }
  if (!mq.connected) return json({ error: 'Server sedang tidak tersambung ke alat. Coba lagi sebentar lagi.' }, 503);
  await new Promise((ok, fail) => mq.publish(`device/${r.device}/buzzer`, JSON.stringify({ cmd: 'mute', ts: Date.now() }), { qos: 1 }, (e) => (e ? fail(e) : ok())));
  const ev = cloud.openEvent(r.device);
  notifLog.add({
    device_id: r.device, event_id: ev?.id ?? null, event_type: 'mute', audience: 'device',
    recipients: 1, delivered: 1, attempts: 1, error: null,
  });
  console.log(`[web] ${r.user.email}: matikan bunyi ${r.device} (${state})`);
  return json({ ok: true, state });
}, { auth: true, paired: true });
