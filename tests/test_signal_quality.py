"""Gerbang kualitas sinyal: ritme berbahaya tidak boleh tertahan, sinyal yang jelas rusak harus tertahan.

Angka lengkap pada data nyata (CUDB, VFDB, BUT QDB) ada di docs/analisis_sqi.md; uji ini memakai
bank replay yang ikut di repo supaya bisa jalan tanpa internet.
"""
from pathlib import Path

import numpy as np
import pytest

from cloud.signal_quality import assess
from heartsim_common import config as C

BANK = Path(__file__).resolve().parents[1] / "simulator" / "simulator" / "replay_bank.npz"


def counts(mv):
    return np.round(np.asarray(mv) * C.ECG_COUNTS_PER_MV).astype(np.int32)


@pytest.mark.skipif(not BANK.exists(), reason="bank replay tidak ada")
@pytest.mark.parametrize("tag", ["vf", "vt", "stemi", "st_depression", "af", "pvc", "normal"])
def test_bank_rhythms_pass_gate(tag):
    b = np.load(BANK)
    x = b["X"][b["tag"] == tag][:, :C.WINDOW_SAMPLES].astype(np.float64)
    blocked = [assess(counts(w)).reason for w in x if not assess(counts(w)).ok]
    assert not blocked, f"{len(blocked)}/{len(x)} window {tag} tertahan: {blocked[:2]}"


def test_broadband_noise_is_blocked():
    rng = np.random.default_rng(1)
    noise = rng.normal(0, 0.3, C.WINDOW_SAMPLES)            # derau putih ~ gesekan elektroda
    q = assess(counts(noise))
    assert not q.ok and q.reason.startswith("derau")


def test_vf_like_sine_is_not_noise():
    """VF kasar ~ osilasi 4–6 Hz: kurtosis rendah tetapi daya terpusat, tidak boleh dianggap derau."""
    t = np.arange(C.WINDOW_SAMPLES) / C.FS_ECG
    rng = np.random.default_rng(2)
    vf = 0.6 * np.sin(2 * np.pi * (5 + 0.3 * np.sin(2 * np.pi * 0.2 * t)) * t) + rng.normal(0, 0.03, t.size)
    q = assess(counts(vf))
    assert q.ok, q.reason
    assert q.ksqi < 4 and q.psqi > 0.5


def test_flat_and_lead_off():
    assert not assess(np.zeros(C.WINDOW_SAMPLES, np.int32)).ok
    rng = np.random.default_rng(3)
    ok_sig = counts(rng.normal(0, 0.3, C.WINDOW_SAMPLES))
    assert assess(ok_sig, lead_off=True).reason.startswith("elektroda lepas")
