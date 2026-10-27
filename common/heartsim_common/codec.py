"""Pengodean payload segmen ECG.

Dua format didukung:
1. JSON (default, mudah di-debug):
   {"device_id", "seq", "t0", "fs", "n", "unit", "samples": [int16...], "buffered"}
2. Biner delta-encoded (BAB 5.4.2, BAB 10.5):
   header  : magic 'CV' (versi lama 'HW' tetap diterima) | ver u8 | flags u8 | seq u32 | t0 u64 (ms) | fs u16 | n u16
   body    : sampel pertama int16, lalu delta antar-sampel:
             int8 bila -127..127, selain itu escape 0x80 + int16 (big-endian)
   flags   : bit0 = buffered (hasil retransmisi ring-buffer)
             bit1 = lead_off (ada sampel saat elektroda AD8232 lepas; sampel tsb. bernilai 0)
             bit2 = clock_unsynced (jam perangkat belum tersinkron NTP/seluler; t0 = ms sejak boot)

Cloud mendeteksi format otomatis: JSON selalu diawali '{', biner diawali 'CV' (atau 'HW').
"""
from __future__ import annotations

import json
import struct
from dataclasses import dataclass, field

import numpy as np

MAGIC = b"CV"
LEGACY_MAGIC = b"HW"            # firmware/prototipe sebelum ganti nama ke CardioVest; tetap diterima
VERSION = 1
F_BUFFERED, F_LEAD_OFF, F_CLOCK_UNSYNCED = 0x01, 0x02, 0x04
_HDR = struct.Struct(">2sBBIQHH")  # 20 byte
ESCAPE = 0x80


@dataclass
class EcgPacket:
    device_id: str
    seq: int
    t0: int                 # epoch ms sampel pertama
    fs: int
    samples: np.ndarray     # int16
    buffered: bool = False
    extra: dict = field(default_factory=dict)
    lead_off: bool = False          # elektroda lepas pada sebagian/seluruh paket
    clock_unsynced: bool = False    # t0 berasal dari jam perangkat yang belum tersinkron

    @property
    def n(self) -> int:
        return int(self.samples.size)


# ---------------------------------------------------------------- JSON
def encode_json(p: EcgPacket) -> bytes:
    obj = {
        "device_id": p.device_id,
        "seq": p.seq,
        "t0": p.t0,
        "fs": p.fs,
        "n": p.n,
        "unit": "count (1 mV = 500)",
        "samples": p.samples.astype(int).tolist(),
        "buffered": p.buffered,
        "lead_off": p.lead_off,
        "time_valid": not p.clock_unsynced,
    }
    obj.update(p.extra)
    return json.dumps(obj, separators=(",", ":")).encode()


# ---------------------------------------------------------------- biner
def encode_binary(p: EcgPacket) -> bytes:
    s = p.samples.astype(np.int32)
    flags = ((F_BUFFERED if p.buffered else 0) | (F_LEAD_OFF if p.lead_off else 0)
             | (F_CLOCK_UNSYNCED if p.clock_unsynced else 0))
    out = bytearray(_HDR.pack(MAGIC, VERSION, flags,
                              p.seq & 0xFFFFFFFF, p.t0, p.fs, p.n))
    if p.n == 0:
        return bytes(out)
    out += struct.pack(">h", int(s[0]))
    for d in np.diff(s):
        d = int(d)
        if -127 <= d <= 127:
            out += struct.pack(">b", d)
        else:
            d = max(-32768, min(32767, d))
            out.append(ESCAPE)
            out += struct.pack(">h", d)
    return bytes(out)


def decode_binary(buf: bytes, device_id: str = "") -> EcgPacket:
    magic, ver, flags, seq, t0, fs, n = _HDR.unpack_from(buf, 0)
    if magic not in (MAGIC, LEGACY_MAGIC) or ver != VERSION:
        raise ValueError("payload biner tidak dikenal")
    pos = _HDR.size
    samples = np.empty(n, dtype=np.int32)
    if n:
        samples[0] = struct.unpack_from(">h", buf, pos)[0]
        pos += 2
        for i in range(1, n):
            b = buf[pos]
            if b == ESCAPE:
                d = struct.unpack_from(">h", buf, pos + 1)[0]
                pos += 3
            else:
                d = struct.unpack_from(">b", buf, pos)[0]
                pos += 1
            samples[i] = samples[i - 1] + d
    return EcgPacket(device_id, seq, t0, fs, samples.astype(np.int16), bool(flags & F_BUFFERED),
                     lead_off=bool(flags & F_LEAD_OFF), clock_unsynced=bool(flags & F_CLOCK_UNSYNCED))


# ---------------------------------------------------------------- umum
def encode(p: EcgPacket, fmt: str = "json") -> bytes:
    return encode_binary(p) if fmt == "binary" else encode_json(p)


def decode(buf: bytes, device_id: str = "") -> tuple[EcgPacket, str]:
    """Kembalikan (paket, format)."""
    if buf[:2] in (MAGIC, LEGACY_MAGIC):
        return decode_binary(buf, device_id), "binary"
    obj = json.loads(buf)
    samples = np.asarray(obj["samples"], dtype=np.int16)
    known = ("device_id", "seq", "t0", "fs", "n", "unit", "samples", "buffered", "lead_off", "time_valid")
    extra = {k: v for k, v in obj.items() if k not in known}
    return EcgPacket(obj.get("device_id", device_id), int(obj["seq"]), int(obj["t0"]),
                     int(obj["fs"]), samples, bool(obj.get("buffered", False)), extra,
                     lead_off=bool(obj.get("lead_off", False)),
                     clock_unsynced=not bool(obj.get("time_valid", True))), "json"
