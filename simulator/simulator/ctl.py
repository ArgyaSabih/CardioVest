"""CLI pengendali simulator melalui MQTT (topik sim/{id}/control).

Contoh:
    python -m simulator.ctl daftar
    python -m simulator.ctl skenario serangan
    python -m simulator.ctl reset
    python -m simulator.ctl putus 45
    python -m simulator.ctl status
"""
from __future__ import annotations

import argparse
import json
import sys
import time

import paho.mqtt.client as mqtt

from heartsim_common import config as C, mqtt_auth
from heartsim_common import topics as T

from .scenarios import SCENARIOS


def main() -> None:
    ap = argparse.ArgumentParser(description="Kendalikan simulator perangkat")
    ap.add_argument("--host", default=C.MQTT_HOST)
    ap.add_argument("--port", type=int, default=C.MQTT_PORT)
    ap.add_argument("--device-id", default=C.DEVICE_ID)
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("daftar", help="daftar skenario")
    s = sub.add_parser("skenario", help="ganti skenario")
    s.add_argument("nama", choices=list(SCENARIOS))
    sub.add_parser("reset", help="tekan tombol hardware reset")
    p = sub.add_parser("putus", help="putuskan tautan data")
    p.add_argument("detik", type=float, nargs="?", default=45)
    sub.add_parser("status", help="minta simulator mencetak status")
    a = ap.parse_args()

    if a.cmd == "daftar":
        for k, v in SCENARIOS.items():
            print(f"{k:<15} {v.title}\n{'':<15} ekspektasi: {v.expected}")
        return

    msg = {"skenario": {"cmd": "scenario", "name": getattr(a, "nama", None)},
           "reset": {"cmd": "reset"},
           "putus": {"cmd": "putus", "detik": getattr(a, "detik", 45)},
           "status": {"cmd": "status"}}[a.cmd]
    c = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id=f"ctl-{int(time.time())}")
    mqtt_auth.apply(c)
    try:
        c.connect(a.host, a.port, 10)
    except OSError as e:
        sys.exit(f"tidak dapat terhubung ke broker {a.host}:{a.port}: {e}")
    c.loop_start()
    c.publish(T.sim_control(a.device_id), json.dumps(msg), qos=1).wait_for_publish(5)
    c.loop_stop()
    c.disconnect()
    print(f"terkirim ke {T.sim_control(a.device_id)}: {msg}")


if __name__ == "__main__":
    main()
