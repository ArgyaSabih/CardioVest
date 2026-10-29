"""Layanan cloud: subscriber MQTT -> sliding window -> CNN 1D -> decision engine -> publish.

Alur (BAB 5.4.2, BAB 8.2):
  device/+/ecg    -> WindowAssembler -> CnnInference -> DecisionEngine -> state/alert/cmd
  device/+/vital  -> ValidatorState (HR, GSR, SQI, kalibrasi baseline) + pembaruan lokasi/jatuh
  device/+/event  -> hardware reset (S3 -> S1)
  device/+/lwt    -> status online/offline

Antrean internal (queue.Queue) berperan sebagai message queue di antara broker dan
layanan inferensi, sehingga pemrosesan tidak memblokir thread jaringan MQTT.
"""
from __future__ import annotations

import json
import logging
import queue
import threading
import time
from dataclasses import dataclass, field

import paho.mqtt.client as mqtt

from heartsim_common import config as C, mqtt_auth
from heartsim_common import topics as T
from heartsim_common.codec import decode

from .decision_engine import DecisionEngine, ValidatorState
from .inference import CnnInference
from .notifier import MockNotifier
from .signal_quality import assess
from .storage import Repository
from .windowing import WindowAssembler

log = logging.getLogger("cloud")

# Epoch ms di bawah ini berarti jam perangkat belum tersinkron (millis sejak boot, bukan waktu nyata)
MIN_VALID_EPOCH_MS = 1_600_000_000_000


def now_ms() -> int:
    return int(time.time() * 1000)


@dataclass
class DeviceCtx:
    device_id: str
    engine: DecisionEngine = field(default_factory=DecisionEngine)
    validators: ValidatorState = field(default_factory=ValidatorState)
    live: WindowAssembler = field(default_factory=WindowAssembler)
    late: WindowAssembler = field(default_factory=WindowAssembler)
    state_since: int = field(default_factory=now_ms)
    last_reason: str = "inisialisasi"
    event_id: int | None = None
    event_peak: float = 0.0
    event_gps_sent: bool = False
    event_fall_sent: bool = False
    last_gps: dict | None = None
    online: bool = False
    reset_ts: int = 0
    reset_recv: int = 0                 # waktu cloud saat event reset diterima
    last_decision: dict | None = None
    restored: str | None = None         # state yang dipulihkan dari database, menunggu konfirmasi perangkat
    restored_why: str = ""              # alasan state ditahan: "layanan cloud restart" / "perangkat tersambung lagi"
    clock_warned: bool = False
    quality: dict | None = None
    reset_source: str = "device"
    remote_clear_at: int = 0            # waktu reset jarak jauh; >0 = menunggu alat melepas latch
    remote_clear_sent: int = 0
    mode: str = C.MODE_DEMO
    mode_req_at: int = 0
    mode_sent: int = 0


class CloudService:
    def __init__(self, host: str = C.MQTT_HOST, port: int = C.MQTT_PORT,
                 db_path: str = "data/cardiovest.db", model_path: str | None = None):
        self.host, self.port = host, port
        self.repo = Repository(db_path)
        self.model = CnnInference(model_path)
        self.notifier = MockNotifier(self.repo, C.USER_ID)
        self.devices: dict[str, DeviceCtx] = {}
        self.jobs: queue.Queue = queue.Queue(maxsize=1000)
        # Sesi persisten: bila layanan cloud mati sebentar, broker menyimpan pesan QoS 1/2 (vital,
        # event tombol reset) dan mengirimkannya saat cloud tersambung lagi. Dengan clean_session=True,
        # event reset yang ditekan selama cloud mati hilang dan alat bisa terkunci CRITICAL lagi.
        self.client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2,
                                  client_id=C.env_str("CLOUD_CLIENT_ID", "cloud-inference"),
                                  clean_session=False)
        mqtt_auth.apply(self.client)
        self.client.on_connect = self._on_connect
        self.client.on_message = self._on_message
        self.client.reconnect_delay_set(1, 30)
        self._running = True

    # ------------------------------------------------------------------ MQTT
    def _on_connect(self, c, userdata, flags, reason_code, props):
        if reason_code.is_failure:
            log.error("gagal terhubung ke broker: %s", reason_code)
            return
        log.info("terhubung ke broker %s:%s; berlangganan device/+/{ecg,vital,event,lwt,remote}", self.host, self.port)
        c.subscribe([("device/+/ecg", 0), ("device/+/vital", 1), ("device/+/event", 1),
                     ("device/+/lwt", 1), ("device/+/remote", 1)])

    def _on_message(self, c, userdata, msg):
        try:
            self.jobs.put_nowait((msg.topic, msg.payload, now_ms()))
        except queue.Full:
            log.error("antrean penuh; pesan %s dibuang", msg.topic)

    def _pub(self, device_id: str, kind: str, obj: dict, retain: bool = False) -> None:
        self.client.publish(T.t(device_id, kind), json.dumps(obj, separators=(",", ":")),
                            qos=T.QOS[kind], retain=retain)

    # ------------------------------------------------------------------ helper
    def ctx(self, device_id: str) -> DeviceCtx:
        if device_id not in self.devices:
            d = DeviceCtx(device_id)
            self.devices[device_id] = d
            log.info("perangkat terdeteksi: %s", device_id)
            last = self.repo.last_state(device_id)
            if last and last[0] != C.STATE_NORMAL:
                # Layanan cloud restart di tengah episode: lanjutkan state & event yang masih terbuka
                d.engine.restore(last[0])
                d.state_since = last[1]
                ev = self.repo.open_event_of(device_id)
                if ev:
                    d.event_id, _, d.event_peak = ev
                if last[0] == C.STATE_CRITICAL:
                    # Tombol reset bisa saja ditekan ketika cloud mati. Tunggu vital pertama: latch NVS
                    # perangkat menentukan apakah CRITICAL masih berlaku (lihat handle_vital).
                    d.restored = last[0]
                    d.restored_why = "layanan cloud restart"
                d.last_reason = f"dipulihkan dari database setelah layanan cloud restart ({last[0]})"
                log.warning("%s: state %s dipulihkan dari database (event %s)", device_id, last[0], d.event_id)
            self._publish_state(d)
            if not d.restored:
                self._pub(device_id, "cmd", {"cmd": "set_state", "state": d.engine.state, "ts": now_ms()})
        return self.devices[device_id]

    def _state_obj(self, d: DeviceCtx) -> dict:
        return {
            "device_id": d.device_id,
            "state": d.engine.state,
            "since": d.state_since,
            "reason": d.last_reason,
            "online": d.online,
            "mode": d.mode,
            "gps": d.last_gps if d.engine.state == C.STATE_CRITICAL or d.mode == C.MODE_TEST else None,
            "calibration": d.validators.calibration_info(),
            "signal": d.quality,
            "ts": now_ms(),
        }

    def _publish_state(self, d: DeviceCtx) -> None:
        self._pub(d.device_id, "state", self._state_obj(d), retain=True)

    def _alert_payload(self, d: DeviceCtx, event_type: str, conf: float, cls: str | None,
                       vals: dict | None) -> dict:
        v = d.validators.latest() or {}
        p = {
            "event_type": event_type,
            "timestamp": now_ms(),
            "user_id": C.USER_ID,
            "device_id": d.device_id,
            "state": d.engine.state,
            "confidence": round(conf, 3),
            "class": cls,
            "hr": (vals or {}).get("hr", v.get("hr")),
            "hr_source": (vals or {}).get("hr_source", v.get("hr_source")),
            "gsr": (vals or {}).get("gsr", v.get("gsr")),
            "validator_quality": "terdegradasi (HR dari ECG)" if (vals or {}).get("degraded") else "independen",
            "fall_detected": bool(v.get("fall_detected")),
            "event_id": d.event_id,
        }
        if event_type.startswith("critical"):
            g = d.last_gps
            p["gps"] = ({"lat": g["lat"], "lng": g["lon"], "accuracy": g.get("accuracy_m")}
                        if g and g.get("fix") else None)
            p["message"] = ("DARURAT: indikasi serangan jantung terkonfirmasi multi-sensor. "
                            "Segera hubungi 119 / ambulans dan menuju lokasi pengguna.")
        else:
            p["message"] = "Terdeteksi pola EKG mencurigakan. Hentikan aktivitas dan beristirahat."
        return p

    # ------------------------------------------------------------------ transisi
    def _apply_transition(self, d: DeviceCtx, dec: dict, conf: float, cls: str | None,
                          vals: dict | None) -> None:
        ts = now_ms()
        a, b = dec["prev_state"], dec["state"]
        d.state_since = ts
        self.repo.save_transition(d.device_id, ts, a, b, dec["reason"])
        lvl = logging.CRITICAL if b == C.STATE_CRITICAL else logging.WARNING
        log.log(lvl, "TRANSISI %s: %s -> %s | %s", d.device_id, a, b, dec["reason"])

        # setiap transisi menutup episode lama (WARNING yang naik ke CRITICAL menjadi episode baru)
        if d.event_id is not None:
            by_reset = dec["reason"].startswith(("hardware reset", "reset jarak jauh"))
            end_reason = {C.STATE_CRITICAL: "eskalasi ke CRITICAL", C.STATE_WARNING: "berubah ke WARNING",
                          C.STATE_NORMAL: (("reset dari aplikasi web" if d.reset_source == "remote" else "reset tombol fisik")
                                           if by_reset else "pulih (histeresis)")}[b]
            self.repo.update_event(d.event_id, end_ts=ts, end_reason=end_reason)
            d.event_id = None
        if b in (C.STATE_WARNING, C.STATE_CRITICAL):
            d.event_id = self.repo.open_event(d.device_id, b, ts, conf, dec["reason"])
            d.event_peak = conf
            d.event_gps_sent = False
            d.event_fall_sent = False

        self._publish_state(d)
        self._pub(d.device_id, "cmd", {"cmd": "set_state", "state": b, "ts": ts})
        if b in (C.STATE_WARNING, C.STATE_CRITICAL):
            et = b.lower()
            payload = self._alert_payload(d, et, conf, cls, vals)
            if b == C.STATE_CRITICAL and payload.get("fall_detected"):
                d.event_fall_sent = True
            if payload.get("gps"):
                d.event_gps_sent = True
            self._pub(d.device_id, "alert", payload)
            self.notifier.dispatch(et, d.device_id, payload)
        elif b == C.STATE_NORMAL and a == C.STATE_CRITICAL:
            remote = d.reset_source == "remote"
            self._pub(d.device_id, "alert", {"event_type": "resolved", "timestamp": ts,
                                             "device_id": d.device_id, "state": b,
                                             "source": "remote" if remote else "device",
                                             "message": ("Status CRITICAL diakhiri dari aplikasi web."
                                                         if remote else
                                                         "Status CRITICAL diakhiri melalui tombol reset "
                                                         "perangkat (pertolongan telah tiba).")})

    # ------------------------------------------------------------------ handler
    def handle_ecg(self, device_id: str, payload: bytes, recv_ms: int) -> None:
        d = self.ctx(device_id)
        pkt, fmt = decode(payload, device_id)
        dur_ms = int(pkt.n * 1000 / pkt.fs)
        # Jam perangkat belum tersinkron (NTP/jam seluler gagal): t0 = ms sejak boot. Paket live tetap
        # diproses dengan waktu terima cloud. Dulu paket seperti ini dianggap "terlambat" sehingga FSM
        # tidak pernah bergerak dan alarm tidak bisa menyala tanpa ada pesan galat apa pun.
        clock_bad = pkt.clock_unsynced or pkt.t0 < MIN_VALID_EPOCH_MS or pkt.t0 > recv_ms + 120_000
        if clock_bad:
            if not d.clock_warned:
                d.clock_warned = True
                log.warning("%s: jam perangkat belum tersinkron (t0=%d); memakai waktu terima cloud",
                            device_id, pkt.t0)
            if not pkt.buffered:
                pkt.t0 = recv_ms - dur_ms
        elif d.clock_warned:
            d.clock_warned = False
            log.info("%s: jam perangkat sudah tersinkron", device_id)
        self.repo.save_ecg(pkt, fmt, len(payload), recv_ms)
        t_end = pkt.t0 + dur_ms
        age_s = (recv_ms - t_end) / 1000
        late = pkt.buffered or age_s > C.LATE_PACKET_S
        res = (d.late if late else d.live).push(pkt)
        if res is None:
            return
        window, w_t0 = res
        quality = assess(window, lead_off=res.lead_off)
        d.quality = quality.dict()
        cls, conf, probs, infer_ms = self.model.predict(window)
        row = {
            "device_id": device_id, "ts": now_ms(), "window_t0": w_t0, "seq": pkt.seq,
            "class": C.CLASSES[cls], "class_idx": cls, "probs": probs, "p_conf": round(conf, 4),
            "infer_ms": infer_ms, "late": late, "payload_format": fmt, "payload_bytes": len(payload),
            "signal_ok": quality.ok, "quality": quality.dict(), "clock_unsynced": clock_bad,
        }
        before_reset = (recv_ms - 2 * dur_ms < d.reset_recv) if clock_bad else (w_t0 < d.reset_ts)
        if late:
            row.update(accepted=False, state=d.engine.state,
                       reason="paket hasil retransmisi buffer: disimpan, tidak menggerakkan FSM")
        elif not quality.ok:
            row.update(accepted=False, state=d.engine.state,
                       reason=f"tidak diputuskan, kualitas sinyal: {quality.reason}")
            d.last_reason = row["reason"]
        elif before_reset:
            row.update(accepted=False, state=d.engine.state,
                       reason="window memuat sampel sebelum hardware reset: tidak menggerakkan FSM")
        else:
            snap = d.validators.evaluate()
            dec = d.engine.step(cls, conf, snap.ind_gsr, snap.ind_hr, snap.degraded, snap.motion).dict()
            row.update(accepted=dec["accepted"], state=dec["state"], reason=dec["reason"],
                       validators=snap.dict(), decision=dec)
            d.last_reason = dec["reason"]
            d.last_decision = dec
            if dec["changed"]:
                self._apply_transition(d, dec, conf, C.CLASSES[cls], snap.dict())
            elif d.event_id is not None and conf > d.event_peak and cls != C.CLS_NORMAL:
                d.event_peak = conf
                self.repo.update_event(d.event_id, peak_conf=conf)
        row["process_latency_ms"] = now_ms() - t_end  # transmisi + antre + inferensi + keputusan
        if not late and not row.get("decision", {}).get("changed"):
            # heartbeat state retained per window: alasan & progres kalibrasi selalu segar bagi klien
            self._publish_state(d)
        self.repo.save_inference(row)
        self._pub(device_id, "inference", row)
        log.info("%s seq=%d %-12s p=%.2f [%s] %5.1f ms | %s%s", device_id, pkt.seq, C.CLASSES[cls],
                 conf, ",".join(f"{p:.2f}" for p in probs), infer_ms, row["state"],
                 " (late)" if late else "")

    def handle_vital(self, device_id: str, payload: bytes) -> None:
        d = self.ctx(device_id)
        v = json.loads(payload)
        v.setdefault("device_id", device_id)
        self.repo.save_vital(v)
        self._reconcile_latch(d, v)
        self._reconcile_mode(d, v)
        d.validators.add(v, d.engine.state)
        g = v.get("gps")
        if g and g.get("fix") and not v.get("buffered"):
            d.last_gps = g
        if d.engine.state != C.STATE_CRITICAL or d.event_id is None or v.get("buffered"):
            return
        # pembaruan informasi pada event CRITICAL yang sedang berlangsung
        if g and g.get("fix") and not d.event_gps_sent:
            d.event_gps_sent = True
            self.repo.update_event(d.event_id, lat=g["lat"], lon=g["lon"])
            p = self._alert_payload(d, "critical_location", d.event_peak, None, None)
            self._pub(device_id, "alert", p)
            self.notifier.dispatch("critical_location", device_id, p)
            self._publish_state(d)
        if v.get("fall_detected") and not d.event_fall_sent:
            d.event_fall_sent = True
            self.repo.update_event(d.event_id, fall_detected=1)
            p = self._alert_payload(d, "critical_fall", d.event_peak, None, None)
            self._pub(device_id, "alert", p)
            self.notifier.dispatch("critical_fall", device_id, p)

    def _reconcile_mode(self, d: DeviceCtx, v: dict) -> None:
        if v.get("buffered"):
            return
        m = v.get("mode")
        if m not in C.MODES:
            return
        t = now_ms()
        if d.mode_req_at:
            if m == d.mode:
                d.mode_req_at = 0
                log.info("%s: mode %s aktif di perangkat", d.device_id, m)
            elif t - d.mode_req_at >= C.MODE_GIVEUP_S * 1000:
                log.warning("%s: perangkat tidak menanggapi perintah mode %s, tetap %s", d.device_id, d.mode, m)
                d.mode_req_at = 0
                d.mode = m
                self._publish_state(d)
            elif t - d.mode_sent >= C.MODE_RETRY_S * 1000:
                d.mode_sent = t
                self._pub(d.device_id, "cmd", {"cmd": "set_mode", "mode": d.mode, "ts": t})
        elif m != d.mode:
            d.mode = m
            self._publish_state(d)

    def _set_mode(self, d: DeviceCtx, e: dict) -> None:
        m = str(e.get("mode") or "").lower()
        if m not in C.MODES:
            return
        who = str(e.get("by") or "aplikasi web")[:60]
        t = now_ms()
        changed = m != d.mode
        d.mode = m
        d.mode_req_at = d.mode_sent = t
        log.warning("%s: mode %s diminta oleh %s", d.device_id, m, who)
        self._pub(d.device_id, "cmd", {"cmd": "set_mode", "mode": m, "by": who, "ts": t})
        if changed:
            self._reset_remote(d, f"pergantian mode ke {m.capitalize()} oleh {who}")
        else:
            self._publish_state(d)

    def _reconcile_latch(self, d: DeviceCtx, v: dict) -> None:
        """Samakan state cloud dengan latch CRITICAL perangkat (field local_state pada vital)."""
        if v.get("buffered"):
            return
        local = v.get("local_state")
        if d.restored == C.STATE_CRITICAL:
            d.restored = None
            if local == C.STATE_CRITICAL:
                d.last_reason = f"CRITICAL dikonfirmasi latch perangkat setelah {d.restored_why}"
                log.warning("%s: %s", d.device_id, d.last_reason)
                self._publish_state(d)
                self._pub(d.device_id, "cmd", {"cmd": "set_state", "state": C.STATE_CRITICAL, "ts": now_ms()})
            else:
                # Latch perangkat sudah kosong: tombol reset ditekan ketika layanan cloud mati
                dec = d.engine.hardware_reset().dict()
                dec["reason"] = ("perangkat sudah direset (tombol fisik) ketika layanan cloud tidak aktif"
                                 if d.restored_why == "layanan cloud restart" else
                                 "perangkat sudah direset (tombol fisik) ketika tidak terhubung")
                d.reset_recv = now_ms()
                d.reset_source = "device"
                d.last_reason = dec["reason"]
                self._apply_transition(d, dec, 0.0, None, None)
            return
        if d.remote_clear_at:
            if local != C.STATE_CRITICAL:
                d.remote_clear_at = 0
            elif local == C.STATE_CRITICAL and d.engine.state != C.STATE_CRITICAL:
                t = now_ms()
                if t - d.remote_clear_at < C.REMOTE_CLEAR_GIVEUP_S * 1000:
                    if t - d.remote_clear_sent >= C.REMOTE_CLEAR_RETRY_S * 1000:
                        d.remote_clear_sent = t
                        self._pub(d.device_id, "cmd", {"cmd": "clear_latch", "state": C.STATE_NORMAL, "ts": t})
                        log.warning("%s: alat belum melepas latch, clear_latch dikirim ulang", d.device_id)
                    return
                d.remote_clear_at = 0
                log.error("%s: alat tidak melepas latch setelah reset jarak jauh (firmware lama?)", d.device_id)
        if (local == C.STATE_CRITICAL and d.engine.state != C.STATE_CRITICAL
                and now_ms() - d.reset_recv > 10_000):
            dec = d.engine.adopt_critical(
                "perangkat melaporkan latch CRITICAL yang tidak tercatat di cloud "
                "(mis. database cloud baru); state disamakan").dict()
            d.last_reason = dec["reason"]
            log.critical("%s: %s", d.device_id, dec["reason"])
            self._apply_transition(d, dec, 0.0, None, None)

    def handle_event(self, device_id: str, payload: bytes) -> None:
        d = self.ctx(device_id)
        e = json.loads(payload)
        if e.get("type") != "hardware_reset":
            return
        d.restored = None
        d.remote_clear_at = 0
        dec = d.engine.hardware_reset().dict()
        d.reset_source = "device"
        d.reset_ts = int(e.get("ts", now_ms()))
        d.reset_recv = now_ms()
        d.last_reason = dec["reason"]
        log.info("%s: hardware reset diterima -> %s", device_id, dec["reason"])
        if dec["changed"]:
            self._apply_transition(d, dec, 0.0, None, None)
        else:
            self._pub(device_id, "cmd", {"cmd": "set_state", "state": d.engine.state, "ts": now_ms()})

    def handle_remote(self, device_id: str, payload: bytes) -> None:
        d = self.ctx(device_id)
        try:
            e = json.loads(payload or b"{}")
        except json.JSONDecodeError:
            return
        if e.get("type") == "set_mode":
            self._set_mode(d, e)
            return
        if e.get("type") != "remote_reset":
            return
        who = str(e.get("by") or "aplikasi web")[:60]
        if not C.REMOTE_RESET:
            log.warning("%s: reset jarak jauh dari %s ditolak (REMOTE_RESET=0)", device_id, who)
            return
        self._reset_remote(d, who)

    def _reset_remote(self, d: DeviceCtx, who: str) -> None:
        device_id = d.device_id
        d.restored = None
        was_critical = d.engine.state == C.STATE_CRITICAL
        dec = d.engine.remote_reset(who).dict()
        d.reset_source = "remote"
        d.reset_ts = d.reset_recv = now_ms()
        d.remote_clear_at = d.reset_ts if was_critical else 0
        d.remote_clear_sent = d.reset_ts
        d.last_reason = dec["reason"]
        log.warning("%s: %s", device_id, dec["reason"])
        self._pub(device_id, "cmd", {"cmd": "clear_latch", "state": C.STATE_NORMAL, "by": who, "ts": d.reset_ts})
        if dec["changed"]:
            self._apply_transition(d, dec, 0.0, None, None)
        else:
            self._publish_state(d)

    def handle_lwt(self, device_id: str, payload: bytes) -> None:
        d = self.ctx(device_id)
        try:
            s = json.loads(payload or b"{}")
        except json.JSONDecodeError:
            return
        status = s.get("status", "unknown")
        d.online = status == "online"
        self.repo.save_status(device_id, now_ms(), status, s.get("reason"))
        (log.info if d.online else log.warning)("%s: status perangkat %s %s", device_id, status.upper(),
                                                f"({s['reason']})" if s.get("reason") else "")
        self._publish_state(d)
        if d.online:  # sinkronkan state ke perangkat yang baru tersambung
            if d.engine.state == C.STATE_CRITICAL:
                # Jangan langsung memerintahkan CRITICAL: tombol reset mungkin ditekan selama alat offline.
                # Alat mengirim event reset itu tepat setelah LWT online, dan perintah CRITICAL yang berpacu
                # dengannya bisa mengunci alat lagi. Tunggu vital pertama yang membawa latch perangkat.
                d.restored = C.STATE_CRITICAL
                d.restored_why = "perangkat tersambung lagi"
            else:
                self._pub(device_id, "cmd", {"cmd": "set_state", "state": d.engine.state, "ts": now_ms()})

    # ------------------------------------------------------------------ worker
    def _prune(self) -> None:
        """Retensi F-BE-4, dijalankan sekali saat mulai lalu tiap 6 jam dari thread worker."""
        try:
            out = self.repo.prune(C.RETENSI_HARI, now_ms())
            if any(out.values()):
                log.info("retensi %d hari: baris dihapus %s", C.RETENSI_HARI, out)
        except Exception:  # noqa: BLE001
            log.exception("retensi gagal")

    def _worker(self) -> None:
        next_prune = 0.0
        while self._running:
            if C.RETENSI_HARI and time.monotonic() >= next_prune:
                self._prune()
                next_prune = time.monotonic() + 6 * 3600
            try:
                topic, payload, recv = self.jobs.get(timeout=0.5)
            except queue.Empty:
                continue
            p = T.parse(topic)
            if not p:
                continue
            dev, kind = p
            try:
                if kind == "ecg":
                    self.handle_ecg(dev, payload, recv)
                elif kind == "vital":
                    self.handle_vital(dev, payload)
                elif kind == "event":
                    self.handle_event(dev, payload)
                elif kind == "lwt":
                    self.handle_lwt(dev, payload)
                elif kind == "remote":
                    self.handle_remote(dev, payload)
            except Exception:  # noqa: BLE001  layanan tidak boleh mati karena satu pesan rusak
                log.exception("gagal memproses %s", topic)

    def run(self) -> None:
        threading.Thread(target=self._worker, daemon=True).start()
        self.client.connect_async(self.host, self.port, keepalive=30)
        self.client.loop_forever(retry_first_connection=True)

    def stop(self) -> None:
        self._running = False
        self.client.disconnect()
