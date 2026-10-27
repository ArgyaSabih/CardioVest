# DESIGN.md — Debug Viewer

Arah visual: **industrial/utilitarian clinical monitor**. Viewer ini alat debug untuk tim, bukan PWA pengguna akhir.

## Token
| Token | Gelap | Terang | Pemakaian |
|---|---|---|---|
| `--bg` | `#0e1412` | `#f3f5f2` | latar halaman (netral hijau tertint) |
| `--panel` | `#131b18` | `#fbfcfa` | bidang seksi |
| `--line` | `#22302b` | `#d9e0dc` | garis pemisah, grid ECG |
| `--ink` / `--ink-2` / `--ink-3` | `#e4ece8` / `#9db0a8` / `#6b7f77` | `#15201b` / `#4a5a53` / `#6f7f78` | teks utama / sekunder / label |
| `--trace` | `#5ee8a0` | `#0f8a4d` | satu-satunya aksen: jejak ECG & batang probabilitas teratas |
| `--normal` `--warning` `--critical` | `#2fae6d` `#e2b340` `#e5484d` | sama | warna state FSM (semantik, bukan dekorasi) |

## Tipografi
- Geist (UI) + Geist Mono (angka, timestamp, payload). Maksimal dua keluarga.
- Angka vital besar 30 px/600; label 13 px `--ink-3`.

## Tata letak
- Kontainer `max-width: 1400px`, gutter 16 px. Grid 1.7fr / 1fr, runtuh ke satu kolom di < 900 px.
- Data ditampilkan sebagai baris `divide` (tanpa kartu bersarang).
- Banner state: garis kiri 6 px berwarna state; CRITICAL berdenyut (dimatikan oleh `prefers-reduced-motion`).

## Gerak
- Hanya transisi `width` batang probabilitas (0,35 s, cubic-bezier(.2,.8,.2,1)) dan `transform` tombol saat ditekan.
- ECG digambar di canvas sebagai sweep 250 Hz (≥ 10 fps sesuai spesifikasi PWA).

Last updated: 2026-09-29 — pembuatan awal.
