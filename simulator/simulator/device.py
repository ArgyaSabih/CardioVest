"""Perangkat wearable virtual: pengganti ESP32 + AD8232 + MAX30102 + GSR + MPU6050 + GPS + modem 4G.

Perilaku yang ditiru (BAB 5.4, 8.2, 8.5):
  * ECG bersih 250 Hz dikirim tiap 3,5 s (875 sampel baru) ke device/{id}/ecg (QoS 0)
  * Vital (HR + sumber HR, SQI, GSR, akselerasi, flag jatuh, GPS) tiap 1 s ke device/{id}/vital (QoS 1)
  * Last Will retained di device/{id}/lwt
  * Mencerminkan state dari cloud (device/{id}/cmd) -> buzzer/LED/GPS lokal
  * Tombol hardware reset -> device/{id}/event
  * Ring-buffer >= 10 menit saat tautan data putus, retransmisi saat pulih
  * SMS darurat (disimulasikan) bila CRITICAL & offline > 30 s
"""
from __future__ import annotations

import json
import logging
import queue
import threading
import time
from collections import deque

import numpy as np
import paho.mqtt.client as mqtt

from heartsim_common import config as C, mqtt_auth
from heartsim_common import topics as T
from heartsim_common.codec import EcgPacket, encode
from heartsim_common.ecg_synth import EcgStream, to_counts

from .replay import ReplayStream, bank_available
from .scenarios import SCENARIOS, Phase, Scenario
from .sensors import AccelSim, FallDetector, GpsSim, GsrSensor, read_hr

log = logging.getLogger("perangkat")

LOCAL_ACTIONS = {
    C.STATE_NORMAL: "LED hijau, buzzer mati, GPS standby",
    C.STATE_WARNING: "LED kuning, buzzer mode 1 (nada santai, intermiten)",
    C.STATE_CRITICAL: "LED merah berkedip, buzzer mode 2 (keras, kontinu), GPS aktif",
}


def now_ms() -> int:
    return int(time.time() * 1000)


class VirtualDevice:
    def __init__(self, device_id: str = C.DEVICE_ID, host: str = C.MQTT_HOST,
                 port: int = C.MQTT_PORT, payload_format: str = "json",
                 scenario: str = "normal", seed: int | None = None):
        self.device_id = device_id
        self.host, self.port = host, port
        self.fmt = payload_format
        self.rng = np.random.default_rng(seed)
        # sumber ECG: 'replay' (rekaman asli pasien set uji) atau 'synthetic' (generator Gaussian)
        src = C.env_str("ECG_SOURCE", "replay")
        if src == "replay" and not bank_available():
            log.warning("bank replay tidak ditemukan; memakai ECG sintetis")
            src = "synthetic"
        self.ecg_source = src
        seed_ecg = int(self.rng.integers(1 << 31))
        self.ecg = (ReplayStream(fs=C.FS_ECG, seed=seed_ecg) if src == "replay"
                    else EcgStream(fs=C.FS_ECG, seed=seed_ecg))
        log.info("sumber ECG: %s", src)
        self.gsr = GsrSensor(self.rng)
        self.accel = AccelSim(self.rng)
        self.fall = FallDetector()
        self.gps = GpsSim(self.rng)
        self.test_mode = False

        self.local_state = C.STATE_NORMAL
        # sama dengan firmware (NVS "reset_pend"): reset ditekan tetapi event belum sampai ke cloud
        self.reset_pending = False
        self._reset_ts = 0
        self.seq = 0
        self.t_start_ms = now_ms()
        self.fall_flag_until = 0.0
        self.fall_ts: int | None = None
        self.last_accel = np.array([0.0, 0.0, 1.0])
        self._mag_buf: list[float] = []       # |a| sejak vital terakhir (accel.sd)

        self.commands: queue.Queue = queue.Queue()
        maxlen = int(C.OFFLINE_BUFFER_MINUTES * 60 / C.HOP_SECONDS + C.OFFLINE_BUFFER_MINUTES * 60)
        self.buffer: deque = deque(maxlen=maxlen)
        self.offline_until = 0.0
        self.offline_since: float | None = None
        self.sms_sent = False
        self.bytes_sent = {"ecg": 0, "vital": 0}

        self._scenario: Scenario = SCENARIOS["normal"]
        self._phase_idx = 0
        self._phase_start = time.monotonic()
        self._phase_events_done: set[str] = set()
        self._running = True
        self.active = C.env_str("SIM_SOURCE", "dataset").lower() != "hardware"
        self._started = False
        self._ctl_ready = threading.Event()
        self._client = self._make_client()
        self._ctl = self._make_ctl_client()
        self.set_scenario(scenario)

    # ============================================================ MQTT
    def _make_client(self) -> mqtt.Client:
        c = mqtt_auth.make_client(f"dev-{self.device_id}", user=C.env_str("MQTT_USER", "") or None)
        c.will_set(T.t(self.device_id, "lwt"),
                   json.dumps({"status": "offline", "reason": "koneksi terputus tak terduga"}),
                   qos=1, retain=True)
        c.on_connect = self._on_connect
        c.on_disconnect = self._on_disconnect
        c.on_message = self._on_message
        c.reconnect_delay_set(1, 30)   # spesifikasi reconnect <= 30 s
        return c

    def _make_ctl_client(self) -> mqtt.Client:
        c = mqtt_auth.make_client(f"sim-{self.device_id}", user=C.env_str("MQTT_USER", "") or None)
        c.on_connect = self._on_ctl_connect
        c.on_message = self._on_message
        c.reconnect_delay_set(1, 30)
        return c

    def _on_ctl_connect(self, c, userdata, flags, reason_code, props):
        if reason_code.is_failure:
            log.error("kanal kendali simulator gagal terhubung: %s", reason_code)
            return
        c.subscribe([(T.sim_control(self.device_id), 1), (T.sim_source(self.device_id), 1)])
        self._publish_status()
        self._ctl_ready.set()

    def set_source(self, source: str) -> None:
        if source not in ("hardware", "dataset"):
            log.warning("sumber tidak dikenal: %s (pilih hardware atau dataset)", source)
            return
        active = source == "dataset"
        if active == self.active:
            return
        self.active = active
        if not self._started:
            return
        if active:
            log.info("SUMBER -> dataset: simulator mengirim data sebagai %s", self.device_id)
            self.buffer.clear()
            self._connect_device()
        else:
            log.info("SUMBER -> hardware: simulator berhenti, ESP32 %s yang mengirim data", self.device_id)
            if self._client.is_connected():
                self._client.publish(T.t(self.device_id, "lwt"),
                                     json.dumps({"status": "offline", "reason": "beralih ke hardware", "ts": now_ms()}),
                                     qos=1, retain=True).wait_for_publish(2)
            self._client.disconnect()
            self._client.loop_stop()
        self._publish_status()

    def _connect_device(self) -> None:
        self._client.connect_async(self.host, self.port, keepalive=15)
        self._client.loop_start()

    def _on_connect(self, c, userdata, flags, reason_code, props):
        if reason_code.is_failure:
            log.error("gagal terhubung ke broker: %s", reason_code)
            return
        log.info("terhubung ke broker %s:%s", self.host, self.port)
        c.publish(T.t(self.device_id, "lwt"),
                  json.dumps({"status": "online", "ts": now_ms()}), qos=1, retain=True)
        self._send_pending_reset(c)    # harus mendahului subscribe cmd, sama seperti firmware
        c.subscribe(T.t(self.device_id, "cmd"), 1)

    def _on_disconnect(self, c, userdata, flags, reason_code, props):
        if time.monotonic() >= self.offline_until:
            log.warning("terputus dari broker (%s); mencoba ulang...", reason_code)

    def _on_message(self, c, userdata, msg):
        if msg.topic == T.sim_source(self.device_id):
            self.commands.put(("control", {"cmd": "sumber", "value": msg.payload.decode(errors="ignore").strip().lower()}))
            return
        try:
            data = json.loads(msg.payload or b"{}")
        except json.JSONDecodeError:
            return
        if msg.topic.endswith("/cmd"):
            self.commands.put(("cloud_cmd", data))
        else:
            self.commands.put(("control", data))

    @property
    def online(self) -> bool:
        return time.monotonic() >= self.offline_until and self._client.is_connected()

    def _publish(self, kind: str, obj) -> None:
        """Publish atau simpan ke ring-buffer bila offline."""
        if not self.online:
            self.buffer.append((kind, obj))
            return
        self._send(kind, obj)

    def _send(self, kind: str, obj) -> None:
        if kind == "ecg":
            payload = encode(obj, self.fmt)
        else:
            payload = json.dumps(obj, separators=(",", ":"))
        info = self._client.publish(T.t(self.device_id, kind), payload, qos=T.QOS[kind])
        if info.rc != mqtt.MQTT_ERR_SUCCESS:
            self.buffer.append((kind, obj))
        else:
            self.bytes_sent[kind] = self.bytes_sent.get(kind, 0) + len(payload)

    def _flush_buffer(self) -> None:
        n = len(self.buffer)
        if not n:
            return
        log.info("tautan pulih: meretransmisikan %d pesan dari ring-buffer", n)
        while self.buffer and self.online:
            kind, obj = self.buffer.popleft()
            if kind == "ecg":
                obj.buffered = True
            elif isinstance(obj, dict):
                obj["buffered"] = True
            self._send(kind, obj)
            time.sleep(0.01)

    def _publish_status(self) -> None:
        ph = self.phase
        st = {
            "device_id": self.device_id,
            "scenario": self._scenario.name,
            "scenario_title": self._scenario.title,
            "expected": self._scenario.expected,
            "phase": self._phase_idx,
            "phase_label": ph.label,
            "morph": ph.morph,
            "local_state": self.local_state,
            "payload_format": self.fmt,
            "ecg_source": self.ecg_source,
            "ecg_record": getattr(self.ecg, "current_rec", "sintetis"),
            "scenarios": {k: v.title for k, v in SCENARIOS.items()},
            "source": "dataset" if self.active else "hardware",
            "ts": now_ms(),
        }
        ctl = getattr(self, "_ctl", None)
        if ctl is not None and ctl.is_connected():
            ctl.publish(T.sim_status(self.device_id), json.dumps(st), qos=1, retain=True)

    # ============================================================ skenario
    @property
    def phase(self) -> Phase:
        return self._scenario.phases[self._phase_idx]

    def set_scenario(self, name: str) -> bool:
        if name not in SCENARIOS:
            log.error("skenario '%s' tidak dikenal. Pilihan: %s", name, ", ".join(SCENARIOS))
            return False
        self._scenario = SCENARIOS[name]
        self._enter_phase(0)
        log.info("SKENARIO -> %s: %s", name, self._scenario.title)
        log.info("  ekspektasi: %s", self._scenario.expected)
        return True

    def _enter_phase(self, idx: int) -> None:
        self._phase_idx = idx
        self._phase_start = time.monotonic()
        self._phase_events_done = set()
        ph = self.phase
        self.ecg.set_rhythm(ph.morph, ph.hr, ph.motion)
        if self.accel.mode != "lying" or ph.accel == "walk":
            self.accel.mode = ph.accel
        log.info("  fase %d: %s (ECG=%s, HR=%s, sumber=%s)", idx + 1, ph.label, ph.morph, ph.hr,
                 getattr(self.ecg, "current_rec", "sintetis"))
        self._publish_status()

    def _update_phase(self) -> None:
        ph = self.phase
        el = time.monotonic() - self._phase_start
        if ph.duration is not None and el >= ph.duration and self._phase_idx + 1 < len(self._scenario.phases):
            self._enter_phase(self._phase_idx + 1)
            return
        if ph.fall_at is not None and el >= ph.fall_at and "fall" not in self._phase_events_done:
            self._phase_events_done.add("fall")
            log.info("  [simulasi] pengguna kehilangan keseimbangan dan terjatuh")
            self.accel.trigger_fall()
        if ph.disconnect_at is not None and el >= ph.disconnect_at and "disc" not in self._phase_events_done:
            self._phase_events_done.add("disc")
            self.drop_link(ph.disconnect_s)
        if ph.reset_at is not None and el >= ph.reset_at and "reset" not in self._phase_events_done:
            self._phase_events_done.add("reset")
            log.info("  [simulasi] petugas menekan tombol reset di alat")
            self.press_reset()

    # ============================================================ aksi
    def drop_link(self, seconds: float) -> None:
        """Simulasikan hilangnya sinyal 4G (socket ditutup tanpa DISCONNECT -> LWT terkirim)."""
        log.warning("TAUTAN DATA PUTUS selama %.0f s (broker akan menerbitkan LWT)", seconds)
        self.offline_until = time.monotonic() + seconds
        self.offline_since = time.monotonic()
        self.sms_sent = False
        self._client.loop_stop()
        sock = self._client.socket()
        if sock is not None:
            try:
                sock.close()
            except OSError:
                pass

    def _restore_link(self) -> None:
        log.info("sinyal 4G kembali; menyambung ulang ke broker...")
        try:
            self._client.reconnect()
        except OSError as e:
            log.error("reconnect gagal: %s", e)
        self._client.loop_start()
        self.offline_since = None
        for _ in range(50):
            if self._client.is_connected():
                break
            time.sleep(0.1)
        for _ in range(30):                # event reset tertunda dikirim on_connect lebih dulu
            if not self.reset_pending:
                break
            time.sleep(0.1)
        self._flush_buffer()

    def _send_pending_reset(self, c: mqtt.Client | None = None) -> None:
        """Kirim event reset yang tertunda. Tidak lewat ring-buffer: event ini harus sampai ke cloud
        sebelum perintah apa pun diterima, supaya CRITICAL lama dari cloud tidak mengunci alat lagi."""
        if not self.reset_pending:
            return
        c = c or self._client
        ev = {"device_id": self.device_id, "type": "hardware_reset", "hold_s": 3.0,
              "ts": self._reset_ts, "local_state": self.local_state}
        info = c.publish(T.t(self.device_id, "event"), json.dumps(ev, separators=(",", ":")), qos=1)
        if info.rc == mqtt.MQTT_ERR_SUCCESS:
            self.reset_pending = False
            log.info("event hardware_reset terkirim ke cloud")

    def press_reset(self) -> None:
        """Tombol hardware reset ditahan >= 3 s (F-HW-6). Sama seperti firmware: state lokal
        langsung NORMAL, event dikirim sekarang atau, bila offline, paling awal saat tersambung lagi."""
        log.info("TOMBOL RESET HARDWARE ditekan (tahan 3 s)")
        self._reset_ts = now_ms()
        self.reset_pending = True
        if self.local_state != C.STATE_NORMAL:
            log.info("STATE LOKAL %s -> NORMAL | aksi: %s", self.local_state, LOCAL_ACTIONS[C.STATE_NORMAL])
            self.local_state = C.STATE_NORMAL
            self.gps.set_active(self.test_mode, time.monotonic())
        if self.online:
            self._send_pending_reset()
        else:
            log.info("offline: event reset disimpan, dikirim pertama kali saat koneksi pulih")
        self.accel.mode = "rest"
        self.fall_flag_until = 0.0
        self.set_scenario("normal")   # pertolongan telah tiba, kondisi distabilkan

    def remote_clear(self) -> None:
        """Perintah clear_latch dari cloud (tombol reset di aplikasi web). Berbeda dengan tombol fisik,
        cloud sudah mengubah state-nya sendiri, jadi tidak ada event reset yang dikirim balik."""
        if self.local_state == C.STATE_NORMAL:
            return
        log.info("STATE LOKAL %s -> NORMAL | reset dari aplikasi web", self.local_state)
        self.local_state = C.STATE_NORMAL
        self.gps.set_active(self.test_mode, time.monotonic())
        self.accel.mode = "rest"
        self.fall_flag_until = 0.0
        self.set_scenario("normal")
        self._publish_status()

    def _apply_cloud_state(self, state: str) -> None:
        if state not in C.STATES or state == self.local_state:
            return
        # aturan latch firmware (state.cpp): CRITICAL hanya bisa dilepas tombol fisik, dan CRITICAL dari
        # cloud diabaikan selama event reset belum diterima cloud
        if state == C.STATE_CRITICAL and self.reset_pending:
            log.info("CRITICAL dari cloud diabaikan: event reset belum diterima cloud")
            return
        if self.local_state == C.STATE_CRITICAL:
            log.info("perintah %s dari cloud diabaikan: CRITICAL terkunci sampai tombol reset", state)
            return
        prev, self.local_state = self.local_state, state
        log.info("STATE LOKAL %s -> %s | aksi: %s", prev, state, LOCAL_ACTIONS[state])
        self.gps.set_active(state == C.STATE_CRITICAL or self.test_mode, time.monotonic())
        self._publish_status()

    def _apply_mode(self, mode: str) -> None:
        test = mode == C.MODE_TEST
        if test == self.test_mode:
            return
        self.test_mode = test
        log.info("MODE %s", C.MODE_TEST if test else C.MODE_DEMO)
        self.gps.set_active(test or self.local_state == C.STATE_CRITICAL, time.monotonic())

    def _handle_command(self, kind: str, data: dict) -> None:
        if kind == "cloud_cmd":
            if data.get("cmd") == "set_state":
                self._apply_cloud_state(data.get("state", ""))
            elif data.get("cmd") == "clear_latch":
                self.remote_clear()
            elif data.get("cmd") == "set_mode":
                self._apply_mode(str(data.get("mode", "")))
            return
        cmd = str(data.get("cmd", "")).lower()
        if cmd in ("scenario", "skenario"):
            self.set_scenario(str(data.get("name", "")))
        elif cmd == "reset":
            self.press_reset()
        elif cmd in ("putus", "disconnect"):
            self.drop_link(float(data.get("detik", data.get("seconds", 45))))
        elif cmd in ("source", "sumber"):
            self.set_source(str(data.get("value", data.get("nilai", ""))).lower())
        elif cmd == "status":
            self._publish_status()
            self.print_status()
        else:
            log.warning("perintah tidak dikenal: %s", data)

    def print_status(self) -> None:
        el = time.monotonic() - self._phase_start
        log.info("status: skenario=%s fase=%d(%s, %.0f s) state_lokal=%s online=%s buffer=%d "
                 "byte ecg=%d vital=%d", self._scenario.name, self._phase_idx + 1, self.phase.label,
                 el, self.local_state, self.online, len(self.buffer),
                 self.bytes_sent["ecg"], self.bytes_sent["vital"])

    # ============================================================ siklus sensor
    def _tick_accel(self) -> None:
        a = self.accel.read(C.FS_ACCEL // 10)       # 100 ms data
        self.last_accel = a.mean(axis=0)
        # |a| seluruh sampel IMU sejak vital terakhir -> accel.sd (indikator aktivitas untuk tau adaptif)
        self._mag_buf.extend(np.linalg.norm(a, axis=1).tolist())
        if self.fall.update(a):
            self.fall_flag_until = time.monotonic() + C.FALL_FLAG_HOLD_S
            self.fall_ts = now_ms()
            log.warning("JATUH TERDETEKSI (free-fall -> impak -> stillness)")

    def _make_vital(self) -> dict:
        ph = self.phase
        now = time.monotonic()
        hr_ecg = ph.hr_ecg_override + self.rng.normal(0, 3) if ph.hr_ecg_override else self.ecg.hr_from_rr()
        if ph.lead_off:
            hr_ecg = None                  # Pan-Tompkins tidak mendapat sinyal
        hr_true = 0.0 if ph.morph == "vf" else self.ecg.rhythm_hr
        r = read_hr(self.rng, hr_true, ph.sqi, hr_ecg)
        ax, ay, az = (round(float(v), 3) for v in self.last_accel)
        mag_buf, self._mag_buf = self._mag_buf, []
        vital = {
            "device_id": self.device_id,
            "ts": now_ms(),
            "hr": r.hr, "hr_source": r.hr_source, "hr_ppg": r.hr_ppg, "hr_ecg": r.hr_ecg,
            "sqi": r.sqi,
            "gsr": self.gsr.step(ph.gsr, C.VITAL_PERIOD_S),
            "accel": {"x": ax, "y": ay, "z": az,
                      "mag": round(float(np.linalg.norm(self.last_accel)), 3),
                      "sd": round(float(np.std(mag_buf)), 3) if mag_buf else None},
            "fall_detected": now < self.fall_flag_until,
            "fall_ts": self.fall_ts if now < self.fall_flag_until else None,
            "local_state": self.local_state,
            "mode": C.MODE_TEST if self.test_mode else C.MODE_DEMO,
            "lead_off": ph.lead_off,
            "gps": self.gps.read(now),
            "buffered": False,
        }
        return vital

    def _make_ecg(self) -> EcgPacket:
        idx0 = self.ecg.sample_index
        mv = self.ecg.read(C.HOP_SAMPLES)
        lead_off = self.phase.lead_off
        if lead_off:
            mv = np.zeros_like(mv)     # firmware mengeluarkan 0 selama LO+/LO- aktif
        # stempel waktu dijangkarkan ke jam dinding saat paket selesai dikumpulkan, supaya
        # latensi proses di cloud (terima - akhir paket) tidak bernilai negatif akibat drift timer
        t0 = now_ms() - int(C.HOP_SAMPLES * 1000 / C.FS_ECG)
        pkt = EcgPacket(self.device_id, self.seq, t0, C.FS_ECG, to_counts(mv, C.ECG_COUNTS_PER_MV))
        pkt.lead_off = lead_off
        self.seq += 1
        return pkt

    def _check_sms_fallback(self) -> None:
        if self.offline_since is None or self.sms_sent or self.local_state != C.STATE_CRITICAL:
            return
        if time.monotonic() - self.offline_since > C.SMS_FALLBACK_AFTER_S:
            g = self.gps.read(time.monotonic()) or {}
            loc = (f"https://maps.google.com/?q={g['lat']},{g['lon']}" if g.get("fix")
                   else f"(GPS belum fix) perkiraan {C.GPS_HOME_LAT},{C.GPS_HOME_LON}")
            text = (f"DARURAT: indikasi serangan jantung pada pengguna perangkat {self.device_id} "
                    f"pukul {time.strftime('%H:%M:%S')}. Lokasi: {loc}")
            log.critical("[SMS FALLBACK via AT+CMGS] ke seluruh kontak darurat: %s", text)
            self.sms_sent = True

    # ============================================================ loop utama
    def run(self) -> None:
        self._ctl.connect_async(self.host, self.port, keepalive=30)
        self._ctl.loop_start()
        if self._ctl_ready.wait(10):
            time.sleep(1)
        while not self.commands.empty():
            self._handle_command(*self.commands.get_nowait())
        self._started = True
        if self.active:
            self._connect_device()
        self._publish_status()
        t_next_accel = t_next_vital = time.monotonic()
        t_next_ecg = time.monotonic() + C.HOP_SECONDS
        t_next_status = time.monotonic() + 10
        try:
            while self._running:
                now = time.monotonic()
                while not self.commands.empty():
                    self._handle_command(*self.commands.get_nowait())
                if not self.active:
                    time.sleep(0.2)
                    t_next_accel = t_next_vital = time.monotonic()
                    t_next_ecg = t_next_accel + C.HOP_SECONDS
                    continue
                if self.offline_since is not None and now >= self.offline_until:
                    self._restore_link()
                self._update_phase()
                if now >= t_next_accel:
                    self._tick_accel()
                    t_next_accel += 0.1
                if now >= t_next_vital:
                    self._publish("vital", self._make_vital())
                    t_next_vital += C.VITAL_PERIOD_S
                if now >= t_next_ecg:
                    self._publish("ecg", self._make_ecg())
                    t_next_ecg += C.HOP_SECONDS
                if now >= t_next_status:
                    self._publish_status()
                    t_next_status += 10
                self._check_sms_fallback()
                time.sleep(max(0.0, min(t_next_accel, t_next_vital, t_next_ecg) - time.monotonic()))
        finally:
            if self._client.is_connected():
                self._client.publish(T.t(self.device_id, "lwt"),
                                     json.dumps({"status": "offline", "reason": "dimatikan pengguna",
                                                 "ts": now_ms()}), qos=1, retain=True).wait_for_publish(2)
                self._client.disconnect()
            self._client.loop_stop()
            self._ctl.disconnect()
            self._ctl.loop_stop()

    def stop(self) -> None:
        self._running = False

    # ============================================================ REPL
    def start_repl(self) -> None:
        def loop():
            help_txt = ("perintah: skenario <nama> | daftar | reset | putus [detik] | status | keluar")
            print(help_txt)
            while self._running:
                try:
                    line = input("sim> ").strip()
                except (EOFError, KeyboardInterrupt):
                    break
                if not line:
                    continue
                p = line.split()
                if p[0] in ("skenario", "scenario") and len(p) > 1:
                    self.commands.put(("control", {"cmd": "scenario", "name": p[1]}))
                elif p[0] == "daftar":
                    for k, v in SCENARIOS.items():
                        print(f"  {k:<15} {v.title}")
                elif p[0] == "reset":
                    self.commands.put(("control", {"cmd": "reset"}))
                elif p[0] == "putus":
                    self.commands.put(("control", {"cmd": "putus",
                                                   "detik": float(p[1]) if len(p) > 1 else 45}))
                elif p[0] == "status":
                    self.commands.put(("control", {"cmd": "status"}))
                elif p[0] in ("keluar", "exit", "quit"):
                    self.stop()
                else:
                    print(help_txt)

        threading.Thread(target=loop, daemon=True).start()
