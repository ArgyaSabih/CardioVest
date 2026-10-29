"""Monitor terminal real-time untuk pipeline simulasi.

    python tools/monitor.py --host localhost --device-id cv-001
    MQTT_USER=<token flespi> python tools/monitor.py --host mqtt.flespi.io

Menampilkan: state FSM, alasan keputusan, vital (HR/sumber/SQI/GSR/akselerasi/GPS/jatuh),
hasil CNN terakhir, grafik ECG ringkas, laju data per topik, dan log alert/transisi.
Tekan Ctrl+C untuk keluar.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import threading
import time
from collections import deque
from pathlib import Path

import numpy as np
import paho.mqtt.client as mqtt
from rich.console import Group
from rich.layout import Layout
from rich.live import Live
from rich.panel import Panel
from rich.table import Table
from rich.text import Text

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "common"))
from heartsim_common import mqtt_auth
from heartsim_common.codec import decode

STATE_STYLE = {"NORMAL": "bold white on green4", "WARNING": "bold black on yellow3",
               "CRITICAL": "bold white on red3"}
BLOCKS = " ▁▂▃▄▅▆▇█"


class Monitor:
    def __init__(self, device_id: str):
        self.dev = device_id
        self.lock = threading.Lock()
        self.state: dict = {}
        self.vital: dict = {}
        self.inf: dict = {}
        self.sim: dict = {}
        self.lwt: dict = {}
        self.ecg = deque(maxlen=1750)
        self.log: deque[tuple[str, str, str, str]] = deque(maxlen=12)
        self.bytes: deque[tuple[float, str, int]] = deque(maxlen=5000)
        self.connected = False

    # ------------------------------------------------------------------ MQTT
    def on_connect(self, c, u, f, rc, p):
        self.connected = not rc.is_failure
        c.subscribe([(f"device/{self.dev}/#", 2), (f"sim/{self.dev}/status", 1)])

    def on_message(self, c, u, msg):
        kind = msg.topic.rsplit("/", 1)[-1]
        with self.lock:
            self.bytes.append((time.time(), kind, len(msg.payload)))
            try:
                if kind == "ecg":
                    p, _ = decode(msg.payload, self.dev)
                    if not p.buffered:
                        self.ecg.extend(p.samples.tolist())
                    return
                d = json.loads(msg.payload or b"{}")
            except Exception:  # noqa: BLE001
                return
            if kind == "state":
                if self.state.get("state") and d.get("state") != self.state.get("state"):
                    self._log("TRANSISI", f"{self.state.get('state')} -> {d['state']}: {d.get('reason', '')}",
                              STATE_STYLE.get(d["state"], ""))
                self.state = d
            elif kind == "vital":
                if not d.get("buffered"):
                    self.vital = d
            elif kind == "inference":
                if not d.get("late"):
                    self.inf = d
            elif kind == "alert":
                txt = f"{d.get('event_type')} conf={d.get('confidence', '-')} jatuh={d.get('fall_detected', '-')}"
                if d.get("gps"):
                    txt += f" gps={d['gps']['lat']},{d['gps']['lng']}"
                self._log("ALERT", txt, "bold red" if "critical" in str(d.get("event_type")) else "yellow")
            elif kind == "lwt":
                self.lwt = d
                self._log("LWT", d.get("status", "?") + (f" ({d['reason']})" if d.get("reason") else ""),
                          "cyan")
            elif kind == "status":
                if d.get("scenario") != self.sim.get("scenario") or d.get("phase") != self.sim.get("phase"):
                    self._log("SIM", f"{d.get('scenario')} / fase {d.get('phase', 0) + 1}: {d.get('phase_label')}",
                              "magenta")
                self.sim = d
            elif kind == "cmd":
                pass

    def _log(self, tag: str, text: str, style: str) -> None:
        self.log.appendleft((time.strftime("%H:%M:%S"), tag,
                             text if len(text) < 140 else text[:137] + "...", style))

    # ------------------------------------------------------------------ render
    def _sparkline(self, width: int, rows: int = 5) -> Text:
        if len(self.ecg) < 50:
            return Text("menunggu data ECG...", style="dim")
        x = np.asarray(self.ecg, dtype=float)
        bins = np.array_split(x, width)
        hi = np.array([b.max() for b in bins])
        lo, top = np.percentile(x, 1), np.percentile(x, 99.5)
        span = max(top - lo, 1)
        lvl = np.clip((hi - lo) / span, 0, 1) * rows * 8
        lines = []
        for r in range(rows - 1, -1, -1):
            s = "".join(BLOCKS[int(np.clip(v - r * 8, 0, 8))] for v in lvl)
            lines.append(s)
        return Text("\n".join(lines), style="green")

    def render(self) -> Layout:
        with self.lock:
            st, v, inf, sim = dict(self.state), dict(self.vital), dict(self.inf), dict(self.sim)
            logs = list(self.log)
            now = time.time()
            rates: dict[str, int] = {}
            for t, k, n in self.bytes:
                if now - t <= 30:
                    rates[k] = rates.get(k, 0) + n

        state = st.get("state", "?")
        online = self.lwt.get("status", "?")
        head = Table.grid(expand=True)
        head.add_column(ratio=1)
        head.add_column(ratio=2)
        head.add_row(Text(f"  {state}  ", style=STATE_STYLE.get(state, "reverse")),
                     Text(st.get("reason", "-"), style="bold"))
        since = st.get("since")
        head.add_row(Text(f"perangkat {self.dev}: {online}", style="cyan" if online == "online" else "red"),
                     Text(f"sejak {time.strftime('%H:%M:%S', time.localtime(since / 1000)) if since else '-'}"
                          f" | skenario: {sim.get('scenario', '-')} / fase {sim.get('phase', 0) + 1}: "
                          f"{sim.get('phase_label', '-')}"))
        head.add_row("", Text(f"ekspektasi: {sim.get('expected', '-')}", style="dim"))

        tv = Table(show_header=False, box=None, expand=True)
        tv.add_column(style="dim")
        tv.add_column()
        cal = st.get("calibration") or {}
        tv.add_row("HR", f"{v.get('hr', '-')} bpm  (sumber {v.get('hr_source', '-')}; PPG {v.get('hr_ppg', '-')}, "
                         f"ECG {v.get('hr_ecg', '-')})")
        tv.add_row("SQI PPG", str(v.get("sqi", "-")))
        cal_txt = ("terkalibrasi" if cal.get("calibrated")
                   else f"kalibrasi {cal.get('progress_s', 0)}/{cal.get('target_s', '?')} s")
        tv.add_row("GSR", f"{v.get('gsr', '-')} uS  (ambang {cal.get('threshold', '-')} uS, {cal_txt})")
        a = v.get("accel") or {}
        tv.add_row("Akselerasi", f"|a| = {a.get('mag', '-')} g   jatuh: {v.get('fall_detected', '-')}")
        g = v.get("gps")
        tv.add_row("GPS", "standby" if not g else (f"{g['lat']}, {g['lon']} (±{g['accuracy_m']} m)"
                                                   if g.get("fix") else "mencari satelit..."))
        tv.add_row("State lokal", str(v.get("local_state", "-")))

        ti = Table(show_header=False, box=None, expand=True)
        ti.add_column(style="dim")
        ti.add_column()
        probs = inf.get("probs") or [0, 0, 0]
        for name, p in zip(["Normal", "Pra-Serangan", "Serangan"], probs):
            bar = "█" * int(p * 30)
            ti.add_row(name, Text(f"{bar:<30} {p:.2f}", style="bold" if name == inf.get("class") else ""))
        val = inf.get("validators") or {}
        dec = inf.get("decision") or {}
        ti.add_row("Kelas", f"{inf.get('class', '-')} (p_conf {inf.get('p_conf', '-')}, "
                            f"{'diterima' if inf.get('accepted') else 'tidak diputuskan'})")
        ti.add_row("Validator", f"1_GSR={int(bool(val.get('ind_gsr')))} 1_HR={int(bool(val.get('ind_hr')))} "
                                f"{'TERDEGRADASI' if val.get('degraded') else 'independen'}")
        ti.add_row("Persistence", f"non-Normal {dec.get('consec_non_normal', '-')}/{dec.get('n_required', '-')}, "
                                  f"Normal {dec.get('consec_normal', '-')}")
        ti.add_row("Latensi", f"inferensi {inf.get('infer_ms', '-')} ms, proses {inf.get('process_latency_ms', '-')} ms")

        rate_txt = "  ".join(f"{k}: {n / 30:.0f} B/s" for k, n in sorted(rates.items()))
        width = max(40, min(160, shutil.get_terminal_size((120, 40)).columns - 6))

        tl = Table(show_header=False, box=None, expand=True)
        tl.add_column(style="dim", width=8)
        tl.add_column(width=9)
        tl.add_column()
        for ts, tag, text, style in logs:
            tl.add_row(ts, tag, Text(text, style=style))

        lay = Layout()
        lay.split_column(
            Layout(Panel(head, title="Status FSM (cloud)"), size=5),
            Layout(name="mid", size=10),
            Layout(Panel(self._sparkline(width), title=f"ECG 7 s terakhir  |  laju data: {rate_txt}"), size=7),
            Layout(Panel(tl, title="Log transisi / alert / simulator")),
        )
        lay["mid"].split_row(Layout(Panel(tv, title="Vital (device/+/vital)")),
                             Layout(Panel(ti, title="CNN 1D (device/+/inference)")))
        return lay


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default=os.getenv("MQTT_HOST", "localhost"))
    ap.add_argument("--port", type=int, default=int(os.getenv("MQTT_PORT", "1883")))
    ap.add_argument("--device-id", default=os.getenv("DEVICE_ID", "cv-001"))
    a = ap.parse_args()
    m = Monitor(a.device_id)
    c = mqtt_auth.make_client(f"monitor-{os.getpid()}")
    c.on_connect, c.on_message = m.on_connect, m.on_message
    c.connect_async(a.host, a.port, 30)
    c.loop_start()
    try:
        with Live(m.render(), refresh_per_second=4, screen=True) as live:
            while True:
                time.sleep(0.25)
                live.update(m.render())
    except KeyboardInterrupt:
        pass
    finally:
        c.loop_stop()


if __name__ == "__main__":
    main()
