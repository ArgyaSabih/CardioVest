"""Uji integrasi layanan cloud tanpa broker dan tanpa TensorFlow.

Model CNN diganti model palsu yang hasilnya bisa diatur, sehingga yang diuji murni alur layanan:
penyusunan window, gerbang FSM, penyimpanan, dan pemulihan state. Uji di berkas ini lahir dari
temuan saat menyiapkan uji di alat nyata (lihat CHANGELOG.md).
"""
import json
import time

import numpy as np
import pytest

from heartsim_common import config as C
from heartsim_common.codec import EcgPacket, decode, encode
from heartsim_common.ecg_synth import EcgStream, to_counts


class FakeModel:
    """Pengganti CnnInference: kelas & keyakinan ditentukan uji."""

    def __init__(self, *_, **__):
        self.cls, self.conf, self.calls = C.CLS_NORMAL, 0.95, 0

    def predict(self, window):
        self.calls += 1
        probs = [0.0, 0.0, 0.0]
        probs[self.cls] = self.conf
        return self.cls, self.conf, probs, 1.0


@pytest.fixture
def svc(tmp_path, monkeypatch):
    import cloud.service as S

    monkeypatch.setattr(S, "CnnInference", FakeModel)
    s = S.CloudService("localhost", 1, str(tmp_path / "hw.db"))
    s.published = []
    s._pub = lambda dev, kind, obj, retain=False: s.published.append((kind, obj))
    s.notifier.dispatch = lambda *a, **k: None
    return s


def ecg_payload(seq, t0, lead_off=False, fmt="binary", flat=False):
    if flat:
        x = np.zeros(C.HOP_SAMPLES, np.int16)
    else:
        x = to_counts(EcgStream(seed=seq, hr=75).read(C.HOP_SAMPLES), C.ECG_COUNTS_PER_MV)
    p = EcgPacket("cv-t", seq, t0, C.FS_ECG, x, extra={"lead_off": lead_off} if fmt == "json" else {})
    p.lead_off = lead_off
    return encode(p, fmt)


def vital(ts, **kw):
    v = {"device_id": "cv-t", "ts": ts, "hr": 72, "hr_source": "PPG", "sqi": 0.9, "gsr": 5.0,
         "accel": {"x": 0, "y": 0, "z": 1, "mag": 1, "sd": 0.01}, "local_state": "NORMAL", "buffered": False}
    v.update(kw)
    return json.dumps(v).encode()


def now():
    return int(time.time() * 1000)


def feed(svc, n, t_start=None, **kw):
    """Kirim n paket ECG berurutan; kembalikan baris inferensi yang dipublikasikan."""
    t0 = now() - n * 3500 if t_start is None else t_start
    for i in range(n):
        svc.handle_ecg("cv-t", ecg_payload(i, t0 + i * 3500, **kw), now())
    return [o for k, o in svc.published if k == "inference"]


# ---------------------------------------------------------------- lead-off
def test_lead_off_flag_survives_binary_payload():
    p = EcgPacket("x", 1, 1_790_000_000_000, 250, np.zeros(875, np.int16))
    p.lead_off = True
    q, fmt = decode(encode(p, "binary"))
    assert fmt == "binary" and q.lead_off


def test_lead_off_window_does_not_move_fsm(svc):
    svc.model.cls, svc.model.conf = C.CLS_PRE, 0.95
    rows = feed(svc, 4, lead_off=True)
    assert rows and not any(r["accepted"] for r in rows)
    assert "elektroda" in rows[-1]["reason"]
    assert svc.ctx("cv-t").engine.state == C.STATE_NORMAL


def test_flat_signal_without_flag_is_not_classified(svc):
    """Perangkat lama / JSON tanpa flag: sinyal datar tetap tidak boleh diputuskan CNN."""
    svc.model.cls, svc.model.conf = C.CLS_ATTACK, 0.99
    rows = feed(svc, 4, flat=True)
    assert rows and not any(r["accepted"] for r in rows)
    assert svc.ctx("cv-t").engine.state == C.STATE_NORMAL


# ---------------------------------------------------------------- jam belum sinkron
def test_unsynced_device_clock_still_drives_fsm(svc):
    """Sebelum NTP / jam seluler tersinkron, t0 perangkat bernilai milidetik sejak boot.
    Dulu semua paket dianggap 'terlambat' sehingga alarm tidak pernah bisa menyala."""
    svc.model.cls, svc.model.conf = C.CLS_PRE, 0.95
    rows = feed(svc, 3, t_start=5_000)
    assert any(r["accepted"] for r in rows)
    assert svc.ctx("cv-t").engine.state == C.STATE_WARNING
    assert rows[-1]["clock_unsynced"]


# ---------------------------------------------------------------- pemulihan state setelah restart
def test_cloud_restart_restores_critical(tmp_path, monkeypatch):
    import cloud.service as S

    monkeypatch.setattr(S, "CnnInference", FakeModel)
    db = str(tmp_path / "hw.db")
    a = S.CloudService("localhost", 1, db)
    a.published = []
    a._pub = lambda dev, kind, obj, retain=False: a.published.append((kind, obj))
    a.notifier.dispatch = lambda *x, **k: None
    d = a.ctx("cv-t")
    for i in range(3):
        a.handle_vital("cv-t", vital(now(), hr=130, gsr=25.0))
    a.model.cls, a.model.conf = C.CLS_ATTACK, 0.95
    feed(a, 3)
    assert d.engine.state == C.STATE_CRITICAL

    b = S.CloudService("localhost", 1, db)            # layanan cloud restart
    b.published = []
    b._pub = lambda dev, kind, obj, retain=False: b.published.append((kind, obj))
    b.notifier.dispatch = lambda *x, **k: None
    d2 = b.ctx("cv-t")
    assert d2.engine.state == C.STATE_CRITICAL and d2.event_id is not None
    # belum ada perintah ke alat sebelum latch perangkat terkonfirmasi
    assert not any(k == "cmd" for k, _ in b.published)
    b.handle_vital("cv-t", vital(now(), local_state="CRITICAL"))
    assert d2.engine.state == C.STATE_CRITICAL
    assert any(k == "cmd" and o["state"] == "CRITICAL" for k, o in b.published)


def test_reset_pressed_while_cloud_down(tmp_path, monkeypatch):
    """CRITICAL tersimpan di database, tetapi tombol reset ditekan saat cloud mati:
    vital pertama melaporkan NORMAL, jadi cloud menutup event alih-alih mengunci alat lagi."""
    import cloud.service as S

    monkeypatch.setattr(S, "CnnInference", FakeModel)
    db = str(tmp_path / "hw.db")
    a = S.CloudService("localhost", 1, db)
    a._pub = lambda *x, **k: None
    a.notifier.dispatch = lambda *x, **k: None
    d = a.ctx("cv-t")
    a._apply_transition(d, d.engine.adopt_critical("uji").dict(), 0.9, "Serangan", None)
    b = S.CloudService("localhost", 1, db)
    b.published = []
    b._pub = lambda dev, kind, obj, retain=False: b.published.append((kind, obj))
    b.handle_vital("cv-t", vital(now(), local_state="NORMAL"))
    d2 = b.ctx("cv-t")
    assert d2.engine.state == C.STATE_NORMAL and d2.event_id is None
    assert not any(k == "cmd" and o["state"] == "CRITICAL" for k, o in b.published)
    _, rows = b.repo.query("SELECT end_ts FROM events")
    assert all(r[0] is not None for r in rows)


def test_device_latch_is_adopted_when_cloud_forgot(svc):
    """Perangkat masih CRITICAL (latch NVS) tetapi cloud baru (database kosong): cloud harus ikut
    CRITICAL dan membuka event, bukan menampilkan NORMAL kepada keluarga."""
    svc.handle_vital("cv-t", vital(now(), local_state="CRITICAL"))
    d = svc.ctx("cv-t")
    assert d.engine.state == C.STATE_CRITICAL and d.event_id is not None
    assert any(k == "alert" and o["event_type"] == "critical" for k, o in svc.published)


# ---------------------------------------------------------------- reset saat alat offline
def _critical(svc):
    d = svc.ctx("cv-t")
    svc._apply_transition(d, d.engine.adopt_critical("uji").dict(), 0.9, "Serangan", None)
    svc.published.clear()
    return d


def test_reconnect_does_not_relatch_before_reset_arrives(svc):
    """Ditemukan oleh skenario reset_offline: saat alat tersambung lagi, cloud dulu langsung mengirim
    cmd CRITICAL (sinkronisasi). Perintah itu berpacu dengan event reset yang dikirim alat setelah
    LWT online, dan bisa mengunci alat lagi setelah reset."""
    d = _critical(svc)
    svc.handle_lwt("cv-t", b'{"status":"offline"}')
    svc.handle_lwt("cv-t", b'{"status":"online"}')
    assert not any(k == "cmd" and o["state"] == "CRITICAL" for k, o in svc.published)
    svc.handle_event("cv-t", json.dumps({"type": "hardware_reset", "ts": now()}).encode())
    svc.handle_vital("cv-t", vital(now(), local_state="NORMAL"))
    assert d.engine.state == C.STATE_NORMAL
    assert not any(k == "cmd" and o["state"] == "CRITICAL" for k, o in svc.published)


def test_reconnect_with_latched_device_confirms_critical(svc):
    d = _critical(svc)
    svc.handle_lwt("cv-t", b'{"status":"online"}')
    svc.handle_vital("cv-t", vital(now(), local_state="CRITICAL"))
    assert d.engine.state == C.STATE_CRITICAL
    assert any(k == "cmd" and o["state"] == "CRITICAL" for k, o in svc.published)
    assert "tersambung lagi" in d.last_reason


# ---------------------------------------------------------------- reset dari aplikasi web
def _remote(who="Pengguna Uji"):
    return json.dumps({"type": "remote_reset", "by": who, "ts": now()}).encode()


def test_remote_reset_clears_critical_and_commands_device(svc):
    svc.handle_vital("cv-t", vital(now(), local_state="CRITICAL"))
    d = svc.ctx("cv-t")
    assert d.engine.state == C.STATE_CRITICAL
    svc.published.clear()
    svc.handle_remote("cv-t", _remote())
    assert d.engine.state == C.STATE_NORMAL
    assert any(k == "cmd" and o["cmd"] == "clear_latch" for k, o in svc.published)
    res = [o for k, o in svc.published if k == "alert" and o["event_type"] == "resolved"]
    assert res and res[0]["source"] == "remote"
    _, rows = svc.repo.query("SELECT end_reason FROM events ORDER BY id DESC LIMIT 1")
    assert rows[0][0] == "reset dari aplikasi web"


def test_remote_reset_clears_warning_and_normal(svc):
    d = svc.ctx("cv-t")
    d.engine.state = C.STATE_WARNING
    svc.published.clear()
    svc.handle_remote("cv-t", _remote())
    assert d.engine.state == C.STATE_NORMAL
    assert any(k == "cmd" and o["cmd"] == "clear_latch" for k, o in svc.published)
    assert d.remote_clear_at == 0
    svc.published.clear()
    svc.handle_remote("cv-t", _remote())
    assert d.engine.state == C.STATE_NORMAL


def test_hardware_reset_event_clears_warning(svc):
    d = svc.ctx("cv-t")
    d.engine.state = C.STATE_WARNING
    svc.handle_event("cv-t", json.dumps({"type": "hardware_reset", "ts": now()}).encode())
    assert d.engine.state == C.STATE_NORMAL


def test_remote_reset_disabled_by_flag(svc, monkeypatch):
    svc.handle_vital("cv-t", vital(now(), local_state="CRITICAL"))
    d = svc.ctx("cv-t")
    monkeypatch.setattr(C, "REMOTE_RESET", 0)
    svc.handle_remote("cv-t", _remote())
    assert d.engine.state == C.STATE_CRITICAL


def test_remote_reset_retries_until_device_releases_latch(svc, monkeypatch):
    svc.handle_vital("cv-t", vital(now(), local_state="CRITICAL"))
    d = svc.ctx("cv-t")
    svc.handle_remote("cv-t", _remote())
    svc.published.clear()
    d.remote_clear_sent -= 6000
    svc.handle_vital("cv-t", vital(now(), local_state="CRITICAL"))
    assert d.engine.state == C.STATE_NORMAL
    assert any(k == "cmd" and o["cmd"] == "clear_latch" for k, o in svc.published)
    svc.handle_vital("cv-t", vital(now(), local_state="NORMAL"))
    assert d.remote_clear_at == 0 and d.engine.state == C.STATE_NORMAL


def test_remote_reset_gives_up_when_device_never_clears(svc, monkeypatch):
    svc.handle_vital("cv-t", vital(now(), local_state="CRITICAL"))
    d = svc.ctx("cv-t")
    svc.handle_remote("cv-t", _remote())
    d.remote_clear_at -= (C.REMOTE_CLEAR_GIVEUP_S + 1) * 1000
    d.reset_recv -= 20_000
    svc.handle_vital("cv-t", vital(now(), local_state="CRITICAL"))
    assert d.engine.state == C.STATE_CRITICAL
