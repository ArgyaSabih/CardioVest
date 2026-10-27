"""Retensi F-BE-4: data mentah lama dihapus, ECG di sekitar event tetap ada."""
import numpy as np

from cloud.storage import Repository
from heartsim_common.codec import EcgPacket

DAY = 86_400_000


def _pkt(t0):
    return EcgPacket(device_id="cv-001", seq=t0 // 3500, t0=t0, fs=250, samples=np.zeros(875, np.int16))


def test_prune_keeps_event_ecg_and_recent(tmp_path):
    repo = Repository(tmp_path / "db.sqlite")
    now = 100 * DAY
    old, ev, recent = now - 40 * DAY, now - 35 * DAY, now - 2 * DAY
    for t in (old, ev, ev + 3500, recent):
        repo.save_ecg(_pkt(t), "biner", 100, t)
        repo.save_vital({"device_id": "cv-001", "ts": t})
    eid = repo.open_event("cv-001", "CRITICAL", ev, 0.9, "uji")
    repo.update_event(eid, end_ts=ev + 3500)

    assert repo.prune(0, now) == {}
    out = repo.prune(30, now)
    assert out["ecg_packets"] == 1 and out["vitals"] == 1
    _, rows = repo.query("SELECT t0 FROM ecg_packets ORDER BY t0")
    assert [r[0] for r in rows] == [ev, ev + 3500, recent]
    _, rows = repo.query("SELECT COUNT(*) FROM events")
    assert rows[0][0] == 1
