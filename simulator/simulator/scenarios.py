"""Skenario uji perangkat virtual.

Setiap skenario adalah urutan fase. Fase terakhir berdurasi None (berlangsung terus
sampai skenario diganti atau tombol reset ditekan). Skenario diturunkan dari
skenario penggunaan BAB 7.1.5 dan skenario uji decision engine BAB 10.6.
"""
from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class Phase:
    label: str                     # deskripsi singkat (tampil di log/monitor)
    morph: str = "normal"          # morfologi ECG (lihat ecg_synth.MORPH_CLASS)
    hr: float = 72.0               # HR ritme (bpm); 0 untuk VF
    duration: float | None = None  # detik; None = tak terbatas
    motion: float = 0.0            # 0..1, intensitas artefak gerak pada ECG
    accel: str = "rest"            # rest | walk
    sqi: float = 0.85              # indeks kualitas PPG (0..1)
    gsr: float = 5.0               # target konduktansi kulit (uS)
    hr_ecg_override: float | None = None  # HR semu dari Pan-Tompkins (artefak)
    fall_at: float | None = None   # detik sejak awal fase -> pola jatuh
    disconnect_at: float | None = None    # detik sejak awal fase -> tautan data putus
    disconnect_s: float = 45.0
    reset_at: float | None = None  # detik sejak awal fase -> tombol reset fisik ditekan (online/offline)
    lead_off: bool = False         # elektroda lepas: AD8232 LO+/LO- aktif, firmware mengirim 0 + flag


@dataclass(frozen=True)
class Scenario:
    name: str
    title: str
    expected: str
    phases: list[Phase] = field(default_factory=list)


NORMAL = Phase("Istirahat normal", "normal", 72)

SCENARIOS: dict[str, Scenario] = {s.name: s for s in [
    Scenario(
        "normal", "Normal saat istirahat (TC-01)",
        "State tetap NORMAL tanpa fluktuasi.",
        [NORMAL],
    ),
    Scenario(
        "artefak", "Artefak gerak ekstrem, HR semu 145 bpm (TC-02)",
        "HR validator positif karena artefak, tetapi CNN Normal dan GSR baseline "
        "-> state tetap NORMAL (false alarm ditekan).",
        [Phase("Istirahat", "normal", 72, duration=10),
         Phase("Berjalan cepat / artefak gerak", "normal", 92, duration=45, motion=0.9,
               accel="walk", sqi=0.25, gsr=5.8, hr_ecg_override=145),
         Phase("Istirahat kembali", "normal", 76)],
    ),
    Scenario(
        "pra_serangan", "Pra-serangan (depresi ST) lalu pulih (skenario 2 BAB 7)",
        "NORMAL -> WARNING setelah N=2 window, lalu kembali NORMAL setelah N+M=3 window Normal.",
        [Phase("Istirahat", "normal", 74, duration=10),
         Phase("Iskemia: depresi ST / T terbalik", "st_depression", 96, duration=35, gsr=8.0),
         Phase("Pulih setelah istirahat", "normal", 78)],
    ),
    Scenario(
        "pra_af", "Pra-serangan (fibrilasi atrium) lalu pulih",
        "NORMAL -> WARNING, lalu kembali NORMAL.",
        [Phase("Istirahat", "normal", 74, duration=10),
         Phase("Fibrilasi atrium", "af", 112, duration=35, gsr=7.5),
         Phase("Pulih", "normal", 80)],
    ),
    Scenario(
        "serangan", "Serangan terkonfirmasi: STEMI + HR 125 + lonjakan GSR (TC-03)",
        "NORMAL -> (WARNING) -> CRITICAL, terkunci sampai tombol reset ditekan; GPS aktif.",
        [Phase("Istirahat", "normal", 74, duration=10),
         Phase("Prodromal: depresi ST", "st_depression", 100, duration=14, gsr=9.0),
         Phase("STEMI + keringat dingin", "stemi", 125, gsr=23.0)],
    ),
    Scenario(
        "serangan_jatuh", "Serangan terkonfirmasi disertai jatuh (TC-04)",
        "CRITICAL + flag fall_detected=true pada payload alert.",
        [Phase("Istirahat", "normal", 74, duration=10),
         Phase("Prodromal: depresi ST", "st_depression", 100, duration=14, gsr=9.0),
         Phase("STEMI, pengguna terjatuh", "stemi", 126, gsr=23.5, fall_at=12)],
    ),
    Scenario(
        "serangan_vt", "Takikardia ventrikular, perfusi lemah (SQI rendah)",
        "HR diambil dari ECG (validator terdegradasi, N=3) -> CRITICAL.",
        [Phase("Istirahat", "normal", 74, duration=8),
         Phase("Takikardia ventrikular", "vt", 185, sqi=0.3, gsr=24.0)],
    ),
    Scenario(
        "sqi_rendah", "Kontak PPG buruk: mode validator terdegradasi",
        "HR bersumber dari ECG, N naik menjadi 3 window sebelum WARNING.",
        [Phase("Istirahat, PPG bergeser", "normal", 74, duration=10, sqi=0.3),
         Phase("Iskemia: depresi ST", "st_depression", 96, duration=40, sqi=0.3, gsr=8.0),
         Phase("Pulih", "normal", 78, sqi=0.3)],
    ),
    Scenario(
        "putus_koneksi", "Critical lalu tautan data putus 45 s (skenario 5 BAB 10)",
        "LWT offline, buffer lokal terisi, SMS darurat setelah 30 s, retransmisi saat pulih.",
        [Phase("Istirahat", "normal", 74, duration=10),
         Phase("Prodromal: depresi ST", "st_depression", 100, duration=14, gsr=9.0),
         Phase("STEMI, sinyal 4G hilang", "stemi", 125, gsr=23.0,
               disconnect_at=25, disconnect_s=45)],
    ),
    Scenario(
        "reset_offline", "CRITICAL, sinyal hilang, tombol reset ditekan saat offline",
        "Alat langsung NORMAL. Saat tersambung lagi event reset dikirim paling awal, cloud kembali NORMAL "
        "dan paket STEMI yang tertahan di buffer tidak mengunci alat lagi.",
        [Phase("Istirahat", "normal", 74, duration=10),
         Phase("Prodromal: depresi ST", "st_depression", 100, duration=14, gsr=9.0),
         Phase("STEMI, sinyal hilang, pertolongan datang", "stemi", 125, gsr=23.0,
               disconnect_at=25, disconnect_s=35, reset_at=40)],
    ),
    Scenario(
        "elektroda_lepas", "Elektroda lepas 25 s (kaos longgar), lalu terpasang lagi",
        "Paket membawa flag lead_off dan bernilai 0; cloud menyimpan window dengan alasan kualitas "
        "sinyal dan tidak menggerakkan FSM -> state tetap NORMAL, tanpa alarm palsu.",
        [Phase("Istirahat", "normal", 74, duration=10),
         Phase("Elektroda lepas / kaos longgar", "normal", 78, duration=25, lead_off=True),
         Phase("Elektroda terpasang kembali", "normal", 76)],
    ),
]}
