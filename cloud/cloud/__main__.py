"""Jalankan layanan cloud: python -m cloud [--db data/cardiovest.db]"""
from __future__ import annotations

import argparse
import logging
import signal
import sys

from heartsim_common import config as C

from .service import CloudService


def main() -> None:
    ap = argparse.ArgumentParser(description="Layanan cloud: inferensi CNN 1D + decision engine FSM")
    ap.add_argument("--host", default=C.MQTT_HOST)
    ap.add_argument("--port", type=int, default=C.MQTT_PORT)
    ap.add_argument("--db", default=C.env_str("DB_PATH", "data/cardiovest.db"))
    ap.add_argument("--model", default=None, help="path model .keras (default: cloud/model/artifacts)")
    a = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)-10s %(levelname)-8s %(message)s",
                        datefmt="%H:%M:%S", stream=sys.stdout)
    logging.getLogger("cloud").info(
        "konfigurasi: tau_conf=%.2f tau_gerak=%.2f (sd>%.2f g) N=%d N_degraded=%d M=%d HR=[%g,%g] GSR_abs=%g k=%g kalibrasi=%ds",
        C.TAU_CONF, max(C.TAU_CONF, C.TAU_CONF_MOTION), C.MOTION_SD_G, C.PERSIST_N, C.PERSIST_N_DEGRADED, C.HYSTERESIS_M, C.HR_LOW, C.HR_HIGH,
        C.GSR_ABS_HIGH, C.GSR_K, C.CALIB_SECONDS)
    svc = CloudService(a.host, a.port, a.db, a.model)
    signal.signal(signal.SIGTERM, lambda *_: svc.stop())
    try:
        svc.run()
    except KeyboardInterrupt:
        svc.stop()


if __name__ == "__main__":
    main()
