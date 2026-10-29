from __future__ import annotations

import json
import logging
import signal
import sys
import threading
import time

from heartsim_common import config as C
from heartsim_common import mqtt_auth
from heartsim_common import topics as T
from heartsim_common.codec import EcgPacket, encode
from heartsim_common.ecg_synth import to_counts

from .replay import ReplayStream, bank_available

log = logging.getLogger("dataset")

REKAMAN = ("normal", "st_depression", "af", "pvc", "cd", "svt", "stemi", "vt", "vf")


def now_ms() -> int:
    return int(time.time() * 1000)


class DatasetEcg:
    def __init__(self, host: str = C.MQTT_HOST, port: int = C.MQTT_PORT):
        self.host, self.port = host, port
        self.fmt = C.env_str("PAYLOAD_FORMAT", "json")
        self.active: dict[str, dict] = {}
        self.lock = threading.Lock()
        self._running = True
        self.client = mqtt_auth.make_client(f"dataset-ecg-{int(time.time())}")
        self.client.on_connect = self._on_connect
        self.client.on_message = self._on_message
        self.client.reconnect_delay_set(1, 30)

    def _on_connect(self, c, userdata, flags, reason_code, props):
        if reason_code.is_failure:
            log.error("gagal terhubung ke broker: %s", reason_code)
            return
        log.info("terhubung ke broker %s:%s; menunggu perangkat yang memilih sumber dataset", self.host, self.port)
        c.subscribe(T.t("+", "source"), 1)

    def _on_message(self, c, userdata, msg):
        p = T.parse(msg.topic)
        if not p:
            return
        dev = p[0]
        try:
            v = json.loads(msg.payload or b"{}")
        except json.JSONDecodeError:
            v = {"source": msg.payload.decode(errors="ignore").strip()}
        if not isinstance(v, dict):
            v = {}
        with self.lock:
            if v.get("source") != "dataset":
                if self.active.pop(dev, None):
                    log.info("%s: sumber hardware, dataset berhenti", dev)
                return
            rek = str(v.get("rekaman") or "normal")
            if rek not in REKAMAN:
                rek = "normal"
            cur = self.active.get(dev)
            if cur is None:
                self.active[dev] = {"stream": ReplayStream(fs=C.FS_ECG, morph=rek, hr=0), "rekaman": rek, "seq": 0}
            elif cur["rekaman"] != rek:
                cur["stream"].set_rhythm(morph=rek)
                cur["rekaman"] = rek
            log.info("%s: EKG dari dataset (%s, %s)", dev, rek, self.active[dev]["stream"].current_rec)

    def run(self) -> None:
        self.client.connect_async(self.host, self.port, keepalive=30)
        self.client.loop_start()
        nxt = time.monotonic() + C.HOP_SECONDS
        while self._running:
            time.sleep(max(0.0, nxt - time.monotonic()))
            nxt += C.HOP_SECONDS
            with self.lock:
                items = list(self.active.items())
            for dev, st in items:
                mv = st["stream"].read(C.HOP_SAMPLES)
                t0 = now_ms() - int(C.HOP_SAMPLES * 1000 / C.FS_ECG)
                pkt = EcgPacket(dev, st["seq"], t0, C.FS_ECG, to_counts(mv, C.ECG_COUNTS_PER_MV))
                st["seq"] += 1
                self.client.publish(T.t(dev, "ecg_dataset"), encode(pkt, self.fmt), qos=T.QOS["ecg_dataset"])
        self.client.loop_stop()
        self.client.disconnect()

    def stop(self) -> None:
        self._running = False


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)-9s %(levelname)-7s %(message)s",
                        datefmt="%H:%M:%S", stream=sys.stdout)
    if not bank_available():
        log.error("replay_bank.npz tidak ditemukan; sumber dataset tidak tersedia")
        return
    svc = DatasetEcg()
    signal.signal(signal.SIGTERM, lambda *_: svc.stop())
    try:
        svc.run()
    except KeyboardInterrupt:
        svc.stop()


if __name__ == "__main__":
    main()
