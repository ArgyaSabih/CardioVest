import numpy as np

from heartsim_common.codec import EcgPacket, decode, encode
from heartsim_common.ecg_synth import EcgStream, to_counts


def _pkt(buffered=False):
    s = EcgStream(seed=3, morph="stemi", hr=120)
    return EcgPacket("hw-test", 7, 1_700_000_000_000, 250, to_counts(s.read(875)), buffered)


def test_json_roundtrip():
    p = _pkt()
    q, fmt = decode(encode(p, "json"))
    assert fmt == "json" and q.seq == 7 and np.array_equal(p.samples, q.samples)


def test_binary_roundtrip_and_size():
    p = _pkt(buffered=True)
    buf = encode(p, "binary")
    q, fmt = decode(buf, "hw-test")
    assert fmt == "binary" and q.buffered and q.t0 == p.t0
    assert np.array_equal(p.samples, q.samples)
    # delta encoding ~1,1 byte/sampel (BAB 5.4.2): harus jauh di bawah int16 mentah (2 byte)
    assert (len(buf) - 20) / p.n < 1.5


def test_binary_escape_large_jump():
    s = np.array([0, 1000, -1000, 5, 6], dtype=np.int16)
    q, _ = decode(encode(EcgPacket("x", 1, 0, 250, s), "binary"))
    assert np.array_equal(q.samples, s)


def test_legacy_hw_magic_still_decoded():
    """Paket dari firmware sebelum ganti nama (penanda 'HW') tetap diterima cloud."""
    import numpy as np
    from heartsim_common.codec import EcgPacket, decode, encode
    p = EcgPacket("cv-001", 7, 1_790_000_000_000, 250, np.arange(-40, 40, dtype=np.int16))
    buf = encode(p, "binary")
    assert buf[:2] == b"CV"
    q, fmt = decode(b"HW" + buf[2:])
    assert fmt == "binary" and q.seq == 7 and np.array_equal(q.samples, p.samples)
