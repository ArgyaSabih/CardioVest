"""Uji otomatis seluruh skenario end-to-end (simulator -> broker -> cloud -> state).

Membutuhkan broker, layanan cloud, dan simulator yang sedang berjalan.

    python tools/uji_skenario.py                 # semua skenario (~15 menit)
    python tools/uji_skenario.py pra_serangan serangan

Setiap skenario diawali tombol reset dan skenario normal sampai state cloud kembali NORMAL
(min. 15 s, maks. 60 s), lalu transisi state dan alert dibandingkan dengan ekspektasi.

Dua penilaian dicetak:
  * PASS/FAIL ketat : urutan state dan alert persis sama dengan ekspektasi (uji alur sistem);
  * hasil klinis    : apakah kondisi yang disimulasikan terdeteksi pada tingkat yang benar
                      (tanpa alarm / WARNING / CRITICAL), dipakai untuk mode replay jujur
                      REPLAY_ONLY_CORRECT=0, ketika model boleh salah.
"""
from __future__ import annotations

import json
import os
import sys
import threading
import time

import paho.mqtt.client as mqtt

HOST = os.getenv("MQTT_HOST", "localhost")
PORT = int(os.getenv("MQTT_PORT", "1883"))
DEV = os.getenv("DEVICE_ID", "cv-001")

# nama: (durasi_uji_s, urutan state yang diharapkan [atau daftar alternatif], alert wajib, pemeriksaan tambahan)
CASES = {
    "normal": (35, ["NORMAL"], [], None),
    "artefak": (65, ["NORMAL"], [], None),
    "pra_serangan": (70, ["NORMAL", "WARNING", "NORMAL"], ["warning"], None),
    "pra_af": (70, ["NORMAL", "WARNING", "NORMAL"], ["warning"], None),
    "serangan": (45, ["NORMAL", "WARNING", "CRITICAL"], ["critical"], "latched"),
    "serangan_jatuh": (60, ["NORMAL", "WARNING", "CRITICAL"], ["critical", "critical_fall"], None),
    # window transisi (separuh sinus, separuh VT) wajar terbaca Pra-Serangan lebih dulu -> WARNING sesaat
    "serangan_vt": (35, [["NORMAL", "CRITICAL"], ["NORMAL", "WARNING", "CRITICAL"]], ["critical"], None),
    "sqi_rendah": (80, ["NORMAL", "WARNING", "NORMAL"], ["warning"], "degraded"),
    "putus_koneksi": (110, ["NORMAL", "WARNING", "CRITICAL"], ["critical"], "offline"),
    "reset_offline": (100, ["NORMAL", "WARNING", "CRITICAL", "NORMAL"], ["critical"], "reset_offline"),
    "elektroda_lepas": (45, ["NORMAL"], [], "lead_off"),
}


# tingkat respons yang diharapkan per skenario (untuk penilaian klinis)
LEVEL = {"normal": 0, "artefak": 0, "pra_serangan": 1, "pra_af": 1, "sqi_rendah": 1,
         "serangan": 2, "serangan_jatuh": 2, "serangan_vt": 2, "putus_koneksi": 2,
         "reset_offline": 2, "elektroda_lepas": 0}
RANK = {"NORMAL": 0, "WARNING": 1, "CRITICAL": 2}


def clinical(name, states):
    if states[0] != "NORMAL":
        return f"tidak dinilai (state awal {states[0]}: sinyal 'normal' saat stabilisasi tidak dikenali Normal)"
    want, got = LEVEL[name], max(RANK.get(s, 0) for s in states)
    if want == 0:
        return "benar: tanpa alarm" if got == 0 else f"ALARM PALSU ({'WARNING' if got == 1 else 'CRITICAL'})"
    if got == want:
        return "terdeteksi"
    if got == 0:
        return "TERLEWAT"
    return "terdeteksi sebagian (WARNING, bukan CRITICAL)" if got < want else "eskalasi berlebih (CRITICAL)"


class Recorder:
    def __init__(self):
        self.lock = threading.Lock()
        self.current = None
        self.reset()

    def reset(self):
        with self.lock:
            self.states: list[str] = []
            self.reasons: list[str] = []
            self.alerts: list[str] = []
            self.lwt: list[str] = []
            self.late = 0
            self.bad_signal = 0
            self.last_cmd: list[str] = []

    def on_message(self, c, u, msg):
        kind = msg.topic.rsplit("/", 1)[-1]
        try:
            d = json.loads(msg.payload or b"{}")
        except json.JSONDecodeError:
            return
        with self.lock:
            if kind == "state":
                self.current = d.get("state")
                if not self.states or self.states[-1] != d.get("state"):
                    self.states.append(d.get("state"))
                    self.reasons.append(d.get("reason", ""))
            elif kind == "alert":
                self.alerts.append(d.get("event_type"))
            elif kind == "lwt":
                self.lwt.append(d.get("status"))
            elif kind == "inference":
                self.late += bool(d.get("late"))
                self.bad_signal += d.get("signal_ok") is False
            elif kind == "cmd":
                self.last_cmd.append(d.get("state"))


def ctl(c, msg):
    c.publish(f"sim/{DEV}/control", json.dumps(msg), qos=1).wait_for_publish(5)


def main():
    names = sys.argv[1:] or list(CASES)
    rec = Recorder()
    c = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id=f"uji-{os.getpid()}")
    if os.getenv("MQTT_USER"):                 # broker produksi (lihat mosquitto/produksi)
        c.username_pw_set(os.getenv("MQTT_USER"), os.getenv("MQTT_PASS") or None)
    if os.getenv("MQTT_TLS") == "1":
        c.tls_set(ca_certs=os.getenv("MQTT_CA") or None)
    c.on_message = rec.on_message
    c.connect(HOST, PORT, 30)
    c.subscribe([(f"device/{DEV}/state", 1), (f"device/{DEV}/alert", 2), (f"device/{DEV}/lwt", 1),
                 (f"device/{DEV}/inference", 0), (f"device/{DEV}/cmd", 1)])
    c.loop_start()
    results = []
    for name in names:
        dur, exp_states, exp_alerts, extra = CASES[name]
        print(f"\n=== {name}: reset + stabilisasi (normal, 15-60 s), lalu uji {dur} s")
        ctl(c, {"cmd": "reset"})
        ctl(c, {"cmd": "scenario", "name": "normal"})
        t_end = time.time() + 60
        time.sleep(15)
        while rec.current != "NORMAL" and time.time() < t_end:
            time.sleep(1)
        start = rec.current or "NORMAL"
        if start != "NORMAL":
            print(f"    catatan: state awal {start} (belum pulih setelah 60 s)")
        rec.reset()
        with rec.lock:
            rec.states.append(start)
            rec.reasons.append("awal")
        ctl(c, {"cmd": "scenario", "name": name})
        time.sleep(dur)
        with rec.lock:
            states, alerts, reasons, lwt, late = list(rec.states), list(rec.alerts), list(rec.reasons), \
                list(rec.lwt), rec.late
            bad, cmds = rec.bad_signal, list(rec.last_cmd)
        alts = exp_states if isinstance(exp_states[0], list) else [exp_states]
        ok = states in alts and all(a in alerts for a in exp_alerts)
        note = ""
        if extra == "latched":
            ok &= states[-1] == "CRITICAL"
            note = "CRITICAL tetap terkunci"
        elif extra == "degraded":
            w = [r for r in reasons if "WARNING" in r or "persisten" in r]
            ok &= any("/3 window" in r for r in w)
            note = "N=3 (terdegradasi)" if any("/3 window" in r for r in w) else "N=3 TIDAK terlihat"
        elif extra == "offline":
            ok &= "offline" in lwt and "online" in lwt and late > 0
            note = f"LWT={lwt}, inferensi paket terlambat={late}"
        elif extra == "reset_offline":
            ok &= "reset" in reasons[-1] and "offline" in lwt and "online" in lwt
            note = f"alasan akhir: {reasons[-1][:60]}; cmd={cmds}"
        elif extra == "lead_off":
            ok &= bad >= 3
            note = f"{bad} window ditandai kualitas sinyal buruk"
        klin = clinical(name, states)
        results.append((name, ok, " -> ".join(states), ",".join(alerts) or "-", note, klin))
        print(f"    state : {' -> '.join(states)}")
        print(f"    alert : {alerts}")
        for r in reasons[1:]:
            print(f"    alasan: {r}")
        print(f"    hasil : {'PASS' if ok else 'FAIL'} {note}")
        print(f"    klinis: {klin}")
    ctl(c, {"cmd": "reset"})
    print("\nRINGKASAN")
    for name, ok, st, al, note, klin in results:
        print(f"  {'PASS' if ok else 'FAIL'}  {name:<15} {st:<35} alert[{al}] {note} | klinis: {klin}")
    c.loop_stop()
    sys.exit(0 if all(r[1] for r in results) else 1)


if __name__ == "__main__":
    main()
