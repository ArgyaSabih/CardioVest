"""Penyusunan sliding window 1.750 sampel dengan hop 875 (overlap 50 %, BAB 4.7).

Perangkat mengirim 875 sampel baru tiap 3,5 s. Window = paket sebelumnya + paket saat ini,
hanya bila nomor urut (seq) berurutan; celah (paket QoS 0 hilang) memulai ulang penyusunan.
"""
from __future__ import annotations

import numpy as np

from heartsim_common.codec import EcgPacket
from heartsim_common.config import HOP_SAMPLES, WINDOW_SAMPLES


class Window(tuple):
    """(sampel int16, t0_window_ms) + atribut tambahan; tetap bisa di-unpack sebagai 2-tuple."""

    lead_off: bool = False
    clock_unsynced: bool = False


class WindowAssembler:
    def __init__(self):
        self._prev: EcgPacket | None = None
        self.gaps = 0

    def reset(self) -> None:
        self._prev = None

    def push(self, p: EcgPacket) -> Window | None:
        """Kembalikan Window (window int16, t0_window_ms) atau None bila belum lengkap.

        Window.lead_off bernilai True bila salah satu dari dua paket membawa flag elektroda lepas."""
        prev, self._prev = self._prev, p
        if prev is None or p.n != HOP_SAMPLES:
            return None
        if p.seq != prev.seq + 1:
            if p.seq > prev.seq + 1:
                self.gaps += 1
            return None
        w = np.concatenate([prev.samples, p.samples])
        assert w.size == WINDOW_SAMPLES
        out = Window((w, prev.t0))
        out.lead_off = bool(getattr(prev, "lead_off", False) or getattr(p, "lead_off", False))
        out.clock_unsynced = bool(getattr(prev, "clock_unsynced", False) or getattr(p, "clock_unsynced", False))
        return out
