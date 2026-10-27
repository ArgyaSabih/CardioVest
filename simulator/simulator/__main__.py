"""Jalankan perangkat virtual.

    python -m simulator --scenario normal --payload json --interactive
"""
from __future__ import annotations

import argparse
import logging
import signal
import sys

from heartsim_common import config as C

from .device import VirtualDevice
from .scenarios import SCENARIOS


def main() -> None:
    ap = argparse.ArgumentParser(description="Simulator perangkat wearable deteksi serangan jantung")
    ap.add_argument("--host", default=C.MQTT_HOST)
    ap.add_argument("--port", type=int, default=C.MQTT_PORT)
    ap.add_argument("--device-id", default=C.DEVICE_ID)
    ap.add_argument("--scenario", default=C.env_str("SCENARIO", "normal"), choices=list(SCENARIOS))
    ap.add_argument("--payload", default=C.env_str("PAYLOAD_FORMAT", "json"), choices=["json", "binary"],
                    help="format payload ECG (biner = delta-encoding sesuai BAB 5.4.2)")
    ap.add_argument("--seed", type=int, default=None)
    ap.add_argument("--interactive", action="store_true", help="aktifkan prompt perintah (sim>)")
    ap.add_argument("--list", action="store_true", help="tampilkan daftar skenario lalu keluar")
    a = ap.parse_args()

    if a.list:
        for k, v in SCENARIOS.items():
            print(f"{k:<15} {v.title}\n{'':<15} ekspektasi: {v.expected}")
        return

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)-9s %(levelname)-7s %(message)s",
                        datefmt="%H:%M:%S", stream=sys.stdout)
    dev = VirtualDevice(a.device_id, a.host, a.port, a.payload, a.scenario, a.seed)
    signal.signal(signal.SIGTERM, lambda *_: dev.stop())
    if a.interactive:
        dev.start_repl()
    try:
        dev.run()
    except KeyboardInterrupt:
        dev.stop()


if __name__ == "__main__":
    main()
