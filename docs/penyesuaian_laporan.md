# Status akhir software terhadap laporan

Dokumen ini mencatat keputusan akhir tim setelah alat dirakit dan diuji, sebagai acuan penulisan dokumen C-501.
Semua poin di bawah sudah diterapkan di kode dan sudah ditulis ulang di C-501 (BAB 3 subbab perubahan metode, BAB 4,
dan BAB 5). Dokumen C-251 tidak diubah.

## Perangkat keras

| Bagian | C-251 | Akhir | Alasan |
|---|---|---|---|
| Konektivitas | modul 4G SIM7600E-H/SIM7670G | WiFi utama + GPRS SIM800L (board biru 5 V) cadangan + SMS | biaya modul dan ketersediaan; WiFi cukup untuk pemakaian di rumah, GPRS menutup kondisi di luar jangkauan WiFi |
| Lokasi | GPS Neo-6M saat CRITICAL | sama, ditambah posisi terakhir/koordinat cadangan sebelum fix | lokasi tetap terkirim walau fix belum didapat |
| Catu daya | 4×18650 1S4P + TP4056 + boost + XL4015 | baterai Li-ion 9 V (pengisi terpisah) + 2×XL4015 (5,0 V dan 3,3 V) + kapasitor 1 mF di rel modem | rel 5 V untuk SIM800L, GPS, dan ESP32 tanpa konverter boost |
| Pembatas arus elektroda | resistor seri 1 MΩ | tidak dipakai | keselamatan ditopang catu baterai dan isolasi galvanik |
| Penguncian saat mengisi | deteksi VBUS GPIO39 | dihapus | baterai dilepas dari rompi saat diisi |
| Elektroda | Ag/AgCl basah | Ag/AgCl gel sekali pakai, kancing jepret | – |
| LED | tiga warna | LED dua warna (GPIO26/25) | – |

## Software dan logika keputusan

| Bagian | C-251 | Akhir |
|---|---|---|
| τ_conf | 0,70–0,85 | 0,44 saat diam, 0,76 saat bergerak (kalibrasi `cloud/model/kalibrasi_tau.py`) |
| τ_warn | – | sama dengan τ_conf |
| Persistence | N = 2 untuk semua kelas | N = 2 untuk Serangan, N_pra = 4 untuk Pra-Serangan |
| Gerbang CRITICAL | Serangan ∧ GSR ∧ HR | sama; SpO2 hanya informasi |
| Gerbang kualitas sinyal | – | kSQI < 4 ∧ pSQI < 0,5 ditolak sebelum FSM |
| Reset CRITICAL | tombol fisik, latch di NVS | sama; reset dari web dimatikan (`REMOTE_RESET=0`) |
| Kalibrasi GSR | 10–30 menit | 30 detik (demo dan pengujian) |
| Filter band-pass | FIR (BAB 5) / IIR Butterworth (BAB 8, 10) | FIR fase linier 501 tap |
| Evaluasi model | 5-fold patient-independent | hold-out inter-patient 70/15/15 |
| Basis data | PostgreSQL + InfluxDB | SQLite mode WAL |
| Notifikasi | FCM | Web Push VAPID + SMS dari alat |
| Backend | Node.js + Express | Node.js 22 + Next.js 16 (tampilan) di Vercel, API di Render |
| Format EKG | biner delta | JSON lewat WiFi, biner delta lewat GPRS dan buffer offline |

Angka hasil uji model dan analisis ada di `cloud/model/artifacts/metrics.json`, `docs/analisis_*.md`, dan
`docs/uji_*.json`.
