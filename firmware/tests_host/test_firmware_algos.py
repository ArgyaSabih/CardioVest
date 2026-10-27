"""Uji algoritma firmware ESP32 di PC dengan kompilasi native (g++), tanpa perangkat keras.

    python firmware/tests_host/test_firmware_algos.py

Yang diuji:
  1. Filter: koefisien FIR = scipy.firwin, redaman 50 Hz & baseline, penguatan pita lolos
  2. Pan-Tompkins: HR hasil firmware vs HR sebenarnya (ECG sintetis + rekaman asli bank replay)
  3. Codec ECG biner & JSON firmware (C++) didekode oleh codec cloud (Python) -> harus identik;
     JSON vital/event firmware (ArduinoJson) diterima penyimpanan & validator cloud
  4. Deteksi jatuh firmware vs simulator (pola jatuh, berjalan, diam)
  5. PPG: HR dan SQI pada sinyal bersih, berderau, dan tanpa kontak kulit
  6. Buffer offline bersegmen (LittleFS distub ke folder sementara)
"""
from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
FW = HERE.parent / "cardiovest_esp32"
ROOT = HERE.parents[1]
sys.path[:0] = [str(ROOT / "common"), str(ROOT / "simulator")]

from heartsim_common.codec import decode  # noqa: E402
from heartsim_common.ecg_synth import EcgStream  # noqa: E402
from simulator.sensors import AccelSim, FallDetector  # noqa: E402

TMP = Path(tempfile.mkdtemp())
BIN = TMP / "host_test"
# ArduinoJson (header-only): folder library Arduino, dapat diganti lewat variabel lingkungan ARDUINOJSON
import os  # noqa: E402
ARDUINOJSON = os.getenv("ARDUINOJSON", str(Path.home() / "Arduino" / "libraries" / "ArduinoJson" / "src"))
FS, GAIN, HOP = 250, 1100.0, 875
results: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str) -> None:
    results.append((name, ok, detail))
    print(f"{'PASS' if ok else 'FAIL'}  {name}: {detail}")


def build() -> None:
    cmd = ["g++", "-O2", "-std=c++17", f"-I{HERE / 'stub'}", f"-I{FW}", str(HERE / "host_test.cpp"),
           str(FW / "dsp.cpp"), str(FW / "algo.cpp"), str(FW / "ecg_codec.cpp"), str(FW / "payload.cpp"),
           str(HERE / "host_stubs.cpp"), f"-I{ARDUINOJSON}", "-o", str(BIN)]
    subprocess.run(cmd, check=True)


def run(mode: str, data, *extra) -> str:
    f = TMP / f"{mode}.txt"
    np.savetxt(f, np.asarray(data), fmt="%.6f")
    return subprocess.run([str(BIN), mode, str(f), *map(str, extra)], capture_output=True, text=True,
                          check=True).stdout


def ecg_chain(mv_electrode: np.ndarray, rng) -> tuple[np.ndarray, list[float]]:
    """Tegangan elektroda (mV) -> tegangan pin ADC AD8232 (mV) -> firmware."""
    t = np.arange(mv_electrode.size) / FS
    pin = 1500 + GAIN * (mv_electrode + 0.03 * np.sin(2 * np.pi * 50 * t)     # interferensi jala-jala
                         + 0.15 * np.sin(2 * np.pi * 0.2 * t))                 # baseline wander
    pin = np.clip(np.round(pin + rng.normal(0, 2, pin.size)), 0, 3100)       # ADC 12-bit terkalibrasi
    out = run("ecg", pin)
    y = np.array([float(l[2:]) for l in out.splitlines() if l.startswith("Y ")])
    hr = [float(l[3:]) for l in out.splitlines() if l.startswith("HR ")]
    return y, hr


def test_filters() -> None:
    from scipy.signal import firwin
    h_fw = np.array([float(v) for v in run("fircoef", [0]).split()])
    h_ref = firwin(h_fw.size, [0.5, 40], pass_zero=False, fs=FS)
    err = float(np.max(np.abs(h_fw - h_ref)))
    check("koefisien FIR firmware = scipy firwin", err < 1e-5, f"{h_fw.size} tap, galat maks {err:.1e}")
    for f0, lo, hi, label in [(50, 0, 0.1, "redaman 50 Hz"), (10, 0.9, 1.1, "pita lolos 10 Hz"),
                              (0.05, 0, 0.2, "redaman baseline 0,05 Hz")]:
        t = np.arange(30 * FS) / FS
        pin = 1500 + GAIN * 0.5 * np.sin(2 * np.pi * f0 * t)
        out = run("ecg", pin)
        y = np.array([float(l[2:]) for l in out.splitlines() if l.startswith("Y ")])[-10 * FS:]
        gain = (y.max() - y.min()) / 1.0
        check(f"filter {label}", lo <= gain <= hi, f"penguatan {gain:.3f}")


def test_pan_tompkins() -> None:
    rng = np.random.default_rng(3)
    errs = []
    for morph, hr in [("normal", 60), ("normal", 75), ("normal", 110), ("st_depression", 95),
                      ("stemi", 125), ("af", 110), ("vt", 180)]:
        s = EcgStream(seed=int(rng.integers(1e6)), morph=morph, hr=hr)
        _, est = ecg_chain(s.read(30 * FS), rng)
        est = [h for h in est[-10:] if h > 0]
        med = float(np.median(est)) if est else -1
        errs.append(abs(med - hr) / hr)
        check(f"Pan-Tompkins sintetis {morph} {hr} bpm", abs(med - hr) / hr < 0.08 if morph != "af" else abs(med - hr) / hr < 0.15,
              f"HR firmware {med:.1f} bpm")
    bank = ROOT / "simulator" / "simulator" / "replay_bank.npz"
    if not bank.exists():
        return
    d = np.load(bank)
    ok_all = tot_all = 0
    for tag in ("normal", "st_depression", "af", "pvc", "cd", "stemi", "vt"):
        idx = np.where((d["tag"] == tag) & np.isfinite(d["hr"]))[0][:8]
        ok = 0
        for i in idx:
            _, est = ecg_chain(np.tile(d["X"][i].astype(np.float32), 3), rng)   # 30 s
            est = [h for h in est[-10:] if h > 0]
            med = float(np.median(est)) if est else -1
            ok += abs(med - d["hr"][i]) / d["hr"][i] < 0.12
        print(f"      rekaman asli {tag:<14} {ok}/{len(idx)} galat HR < 12 %")
        if tag != "vt":
            ok_all += ok
            tot_all += len(idx)
    # VT (MIT-BIH 203/205, kompleks lebar multiform) dilaporkan terpisah sebagai keterbatasan
    check("Pan-Tompkins rekaman asli selain VT (PTB-XL/MIT-BIH)", ok_all / max(tot_all, 1) >= 0.9,
          f"{ok_all}/{tot_all} rekaman dengan galat HR < 12 %")


def test_codec() -> None:
    rng = np.random.default_rng(5)
    s = EcgStream(seed=9, morph="stemi", hr=120)
    samples = np.clip(np.round(s.read(HOP) * 500), -32768, 32767).astype(int)
    samples[100] += 3000                                                    # paksa escape
    for flags in (0, 1, 2, 4, 7):                 # bit0 buffered, bit1 lead_off, bit2 jam belum sinkron
        buffered, lead_off, unsynced = bool(flags & 1), bool(flags & 2), bool(flags & 4)
        seq, t0 = int(rng.integers(1, 1 << 31)), 1790700000123
        out = TMP / f"pkt{flags}.bin"
        run("codec", [seq, t0, flags, *samples], out)
        pkt, fmt = decode(out.read_bytes(), "cv-001")
        same = (fmt == "binary" and pkt.seq == seq and pkt.t0 == t0 and pkt.buffered == buffered
                and pkt.lead_off == lead_off and pkt.clock_unsynced == unsynced
                and np.array_equal(pkt.samples.astype(int), samples))
        check(f"codec biner flag={flags:03b}", same, f"{out.stat().st_size} byte, {out.stat().st_size / HOP:.2f} B/sampel")
        js = json.loads((TMP / f"pkt{flags}.bin.json").read_bytes())
        pkt2, fmt2 = decode(json.dumps(js).encode())
        check(f"codec JSON flag={flags:03b}",
              fmt2 == "json" and pkt2.seq == seq and np.array_equal(pkt2.samples.astype(int), samples)
              and pkt2.buffered == buffered and pkt2.lead_off == lead_off and pkt2.clock_unsynced == unsynced,
              f"kunci: {sorted(js)[:6]}...")


def test_offline_buffer() -> None:
    """offline_buffer.cpp dengan stub LittleFS di atas folder sementara: FIFO lintas segmen, reboot di
    tengah pengiriman, pengirim gagal, kapasitas penuh, migrasi berkas versi lama."""
    exe = TMP / "obuf_test"
    subprocess.run(["g++", "-O1", "-std=c++17", f"-I{HERE / 'stub'}", f"-I{FW}", str(HERE / "obuf_test.cpp"),
                    str(FW / "offline_buffer.cpp"), "-o", str(exe)], check=True)
    r = subprocess.run([str(exe), str(TMP / "lfs")], capture_output=True, text=True)
    check("buffer offline bersegmen", r.returncode == 0,
          r.stdout.strip() or (r.stderr.strip().splitlines() or ["gagal"])[-1])


def test_vital_json_cloud() -> None:
    """JSON vital firmware harus diterima penyimpanan & validator cloud apa adanya."""
    sys.path.insert(0, str(ROOT / "cloud"))
    from cloud.decision_engine import ValidatorState
    from cloud.storage import Repository
    cases = {
        "lengkap, PPG baik": [1, 118.4, 0.82, 1, 23.5, 1, 0.02, 0.05, 0.99, 1, 1, 1, -7.765512, 110.371934, 121.0, 2],
        "PPG buruk -> HR dari ECG": [1, 90.0, 0.2, 1, 6.1, 1, 0, 0, 1, 0, 0, 0, 0, 0, 135.0, 0],
        "sensor tidak ada": [0, -1, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, -1, 0],
    }
    repo = Repository(TMP / "cloud.db")
    for name, vals in cases.items():
        lines = run("vital", vals).strip().splitlines()
        v, ev = json.loads(lines[0]), json.loads(lines[1])
        repo.save_vital(v)
        vs = ValidatorState(calib_seconds=1)
        vs.add(v, "NORMAL")
        snap = vs.evaluate()
        exp_src = "PPG" if vals[0] and vals[2] >= 0.5 else "ECG"
        ok = (v["hr_source"] == exp_src and v["local_state"] in ("NORMAL", "CRITICAL")
              and (v["gps"] is None) == (vals[10] == 0) and ev["type"] == "hardware_reset")
        if vals[11]:
            ok &= abs(v["gps"]["lat"] - vals[12]) < 1e-6
        check(f"vital JSON firmware -> cloud ({name})", ok,
              f"hr={v['hr']} sumber={v['hr_source']} gsr={v['gsr']} ind_hr={snap.ind_hr} gps={v['gps']}")


def test_fall() -> None:
    for mode, fall, secs in [("rest", True, 8), ("walk", False, 40), ("rest", False, 20)]:
        rng = np.random.default_rng(1)
        a = AccelSim(rng)
        a.mode = mode
        if fall:
            a.read(100)
            a.trigger_fall()
        acc = a.read(secs * 100)
        mag = np.linalg.norm(acc, axis=1)
        fw = [l for l in run("fall", mag).splitlines() if l.startswith("FALL")]
        py = FallDetector()
        py_hits = sum(py.update(acc[i:i + 10]) for i in range(0, len(acc), 10))
        check(f"deteksi jatuh ({mode}{', jatuh' if fall else ''})",
              len(fw) == int(fall) and py_hits == int(fall), f"firmware {len(fw)}x, simulator {py_hits}x")


def test_ppg() -> None:
    rng = np.random.default_rng(7)
    fs = 50
    for label, hr, noise, dc, expect_good in [("bersih", 72, 15, 110000, True), ("bersih", 115, 15, 110000, True),
                                               ("bersih + HRV 5 %", 68, 30, 110000, True),
                                               ("derau gerak", 80, 900, 110000, False),
                                               ("tanpa kontak", 70, 15, 20000, False)]:
        t = np.arange(40 * fs) / fs
        inst = hr * (1 + (0.05 * np.sin(2 * np.pi * 0.1 * t) if "HRV" in label else 0 * t))
        ph = 2 * np.pi * np.cumsum(inst / 60) / fs
        pulse = 0.6 * np.sin(ph) + 0.25 * np.sin(2 * ph + 0.8)            # morfologi PPG sederhana
        ir = dc - 900 * pulse + rng.normal(0, noise, t.size) + 300 * np.sin(2 * np.pi * 0.15 * t)
        out = run("ppg", np.round(ir))
        rows = [l.split() for l in out.splitlines() if l.startswith("HR")][-10:]
        hrs = [float(r[1]) for r in rows if float(r[1]) > 0]
        sqi = float(np.median([float(r[3]) for r in rows]))
        est = float(np.median(hrs)) if hrs else -1
        if expect_good:
            ok = sqi >= 0.5 and abs(est - hr) / hr < 0.06
        else:
            ok = sqi < 0.5
        check(f"PPG {label} {hr} bpm", ok, f"HR {est:.1f} bpm, SQI {sqi:.2f}")


if __name__ == "__main__":
    build()
    test_filters()
    test_pan_tompkins()
    test_codec()
    test_offline_buffer()
    test_vital_json_cloud()
    test_fall()
    test_ppg()
    n_ok = sum(ok for _, ok, _ in results)
    print(f"\n{n_ok}/{len(results)} uji lulus")
    sys.exit(0 if n_ok == len(results) else 1)
