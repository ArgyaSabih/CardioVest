# Bagian laporan yang perlu disesuaikan dengan software

Catatan ini membandingkan laporan V3.1 dengan kode di paket ini. Isinya hal yang di laporan tertulis
satu cara, sementara di software jalan dengan cara lain, atau laporan saling bertentangan sendiri.
Setiap poin berisi lokasinya, apa yang berbeda, lalu teks usulan yang bisa langsung ditempel (atau
diedit dulu sesuai gaya tim).

Urutannya dari yang paling mungkin ditanyakan penguji.

---

## 1. Target performa model (Tabel 6.4) belum tercapai

**Lokasi:** 6.x, Tabel 6.4 dan paragraf sesudahnya.

Target di tabel ditulis sebagai target minimum, tetapi hasil uji inter-patient model produksi berada
di bawahnya untuk metrik klasifikasi. Lebih aman ditulis terbuka daripada ditemukan penguji sendiri.
Metrik non-klasifikasi (ukuran, latensi, metode validasi) sudah memenuhi.

Usulan tabel tambahan (Tabel 6.4a, atau digabung sebagai kolom "Hasil"):

| Parameter | Target | Hasil uji | Status |
|---|---|---|---|
| Sensitivity kelas Serangan | ≥ 90 % | 49,8 % | belum |
| Specificity kelas Serangan | ≥ 80 % | 82,3 % | tercapai |
| Akurasi 3 kelas | ≥ 85 % | 63,3 % | belum |
| F1 makro | ≥ 0,85 | 0,597 | belum |
| AUC-ROC makro (satu-lawan-semua) | ≥ 0,90 | 0,81 (per kelas: Normal 0,88; Pra 0,81; Serangan 0,76) | belum |
| Ukuran model | ≤ 50 MB | 0,6 MB (.keras), 0,18 MB (.onnx), 44.547 parameter | tercapai |
| Latensi komputasi model | < 50 ms | 2,7–3,2 ms per window (CPU) | tercapai |
| Metode validasi | inter-patient | inter-patient 70/15/15, 3.469 window uji dari 2.508 pasien | tercapai |

Sumber angka: `cloud/model/artifacts/metrics.json` dan `HASIL_UJI.md`. Kurva ROC per kelas ada di
`roc.png`/`roc.json`, dihitung dengan `kurva_roc.py` pada dataset yang disiapkan ulang dengan split
pasien yang sama (3.483 window), jadi AUC makronya sedikit berbeda (0,817 vs 0,812).

Teks usulan sesudah tabel:

> Evaluasi pada set uji inter-patient (pasien yang tidak pernah dilihat saat pelatihan) menghasilkan
> akurasi 63,3 % dan F1 makro 0,597, dengan sensitivity kelas Serangan 49,8 %. Angka ini di bawah
> target Tabel 6.4. Penyebab utamanya adalah sumber data: kelas Serangan dari PTB-XL berisi pola
> infark yang tidak membedakan infark akut dan lama, dan hanya Lead I yang dipakai karena itulah lead
> yang direkam elektroda kaos CardioVest. Di sisi lain, ritme ventrikel yang paling cepat fatal
> (VT/VF) tetap terdeteksi dengan baik: 98 % episode VT/VF kontinu dari CUDB dan VFDB, dua basis data
> yang tidak dipakai melatih model, mencapai CRITICAL dalam 30 detik. Karena itu target ≥ 90 % kami
> pertahankan sebagai arah pengembangan, dengan rencana fine-tuning memakai rekaman alat sendiri dan
> penambahan data kelas Serangan yang berlabel akut.

Kalau tim memilih menurunkan target, jangan diubah diam-diam. Tulis alasannya.

---

## 2. Nilai τ_conf 0,44, bukan 0,70–0,85

**Lokasi:** 4.4.4, kalimat "Nilai τconf dikalibrasi empiris dengan target awal 0,70–0,85".
Disebut juga di F-BE-2 (Tabel 7.3).

Software memakai τ_conf = 0,44 (saat diam) dan 0,76 (saat pengguna bergerak). Angka ini dipilih
dengan `cloud/model/kalibrasi_tau.py` di set validasi, lalu dilaporkan di set uji.

Teks usulan, ditambahkan setelah kalimat target awal:

> Kalibrasi pada set validasi menunjukkan bahwa rentang awal tersebut terlalu ketat untuk model
> tiga kelas ini. Pada τ = 0,70, hanya 22 % window STEMI yang masih terbaca non-Normal, sehingga
> sebagian besar serangan akan terlewat. Ambang dipilih dengan aturan: memaksimalkan peluang
> CRITICAL dalam 60 detik pada episode Serangan, dengan syarat specificity efektif ≥ 0,80 dan
> WARNING palsu ≤ 1 per jam. Hasilnya τ_conf = 0,44, yang menerima 88 % window dengan galat kalibrasi
> (ECE) 0,02 pada set uji. Saat IMU mendeteksi gerak (median simpangan baku akselerasi 7 detik
> terakhir > 0,08 g), ambang dinaikkan ke 0,76 karena artefak gerak adalah sumber utama klasifikasi
> keliru. Kedua nilai dapat diubah tanpa melatih ulang model.

Grafik pendukung: `cloud/model/artifacts/kalibrasi_tau.png` dan `kalibrasi_tau_gerak.png`.

---

## 3. Tech stack di Tabel 5.8 berbeda dengan yang dibangun

**Lokasi:** 5.x, paragraf sebelum Tabel 5.8, Tabel 5.8, Tabel 5.x ringkasan keputusan (baris
"Aplikasi: PWA + FCM; ... InfluxDB"), 5.x paragraf "InfluxDB dan PostgreSQL", F-BE-4, F-BE-5,
8.6.5 (FCM multicast), Tabel biaya (Netlify/Vercel).

Perbedaannya:

| Lapisan | Laporan | Software | Alasan |
|---|---|---|---|
| Layanan inferensi + FSM | (tidak spesifik) | Python 3.11, TensorFlow, paho-mqtt | satu bahasa dengan pelatihan model |
| Basis data | PostgreSQL + InfluxDB | SQLite mode WAL, satu berkas `cardiovest.db` | cukup untuk satu VPS dan beberapa alat; tanpa server basis data terpisah |
| Backend aplikasi | Node.js + Express | Node.js 22, Next.js 16: API di Route Handlers, ditambah server kustom (`server.mjs`) untuk MQTT, Socket.IO, dan Web Push | Express tidak dipakai lagi; satu proyek untuk halaman dan API |
| Push notification | Firebase Cloud Messaging | Web Push standar (VAPID), pustaka `web-push` | tanpa akun Firebase; tetap jalan di Chrome Android dan Safari iOS 16.4+ |
| Frontend | React (PWA) | Next.js 16 App Router + React 19 + Redux Toolkit (tetap PWA) | |
| Hosting frontend | Vercel | Vercel **atau** VPS yang sama. Di Vercel, `/api` diteruskan ke VPS oleh `proxy.js` | bagian yang harus hidup terus (MQTT, Socket.IO, SQLite) tidak bisa berjalan di Vercel |
| Reverse proxy/HTTPS | (tidak disebut) | Caddy 2 (sertifikat Let's Encrypt otomatis) | |
| Email | (tidak disebut) | SMTP opsional (nodemailer) | verifikasi akun dan lupa sandi |

Teks usulan pengganti paragraf penyimpanan:

> Untuk tahap prototipe, data relasional dan deret waktu disimpan dalam satu basis data SQLite mode
> WAL. Seluruh akses melalui lapisan repository (`cloud/cloud/storage.py`), sehingga migrasi ke
> PostgreSQL dan InfluxDB/TimescaleDB pada skala produksi cukup dengan mengganti implementasi
> lapisan tersebut. Dengan ECG 250 Hz, satu alat menghasilkan sekitar 45–60 MB data per hari, masih
> jauh di bawah kapasitas VPS yang direncanakan.

Teks usulan untuk push notification (5.x dan 8.6.5):

> Notifikasi dikirim memakai protokol Web Push standar dengan autentikasi VAPID. Protokol ini sama
> dengan yang dipakai FCM di balik layar pada Chrome Android, tetapi tidak membutuhkan proyek
> Firebase dan juga bekerja di Safari iOS 16.4+ untuk PWA yang dipasang di layar utama. Setiap
> langganan dikirimi notifikasi secara terpisah (bukan multicast), sehingga hasil tiap penerima
> dapat dicatat dan dicoba ulang sendiri-sendiri.

Kalau dosen pembimbing meminta tetap FCM, pengirim di `web/lib/server/push.js` cukup diganti.
Bagian lain (siapa menerima apa, retry, log) tidak berubah.

---

## 4. QoS ECG ditulis berbeda di tiga tempat

**Lokasi:** 2.6.2 dan 3.5.2 menulis QoS 0 untuk stream ECG. 6.2.5 menulis QoS 1 dan menyebut QoS 0
"tidak aman untuk data medis".

Software memakai QoS 0 untuk ECG, QoS 1 untuk vital/state/event, QoS 2 untuk alert
(`common/heartsim_common/topics.py`, `firmware/cardiovest_esp32/comm.cpp`). Data ECG tidak hilang saat
koneksi putus karena firmware menyimpannya di buffer lokal 10 menit dan mengirim ulang dengan flag
`buffered`. Satu window yang hilang di tengah koneksi normal hanya menunda keputusan 3,5 detik.

Teks usulan pengganti kalimat di 6.2.5:

> Stream ECG dikirim dengan QoS 0 karena volumenya tinggi dan satu paket yang hilang hanya menunda
> satu keputusan (3,5 detik). Keandalan saat koneksi terputus tidak bergantung pada QoS, melainkan
> pada buffer lokal 10 menit di ESP32 yang dikirim ulang begitu koneksi pulih. Data vital dan status
> dikirim dengan QoS 1, sedangkan pesan alert dengan QoS 2 karena tidak boleh hilang maupun terduplikasi.

Sekalian: 2.6.2 memberi contoh topik `ecg/device001/raw`, padahal F-BE-1 dan software memakai
`device/{id}/ecg`. Ganti contohnya menjadi `device/cv-001/ecg` dan `device/cv-001/alert`.

---

## 5. Tombol reset: pin EN dan "2 detik"

**Lokasi:**
- 8.7.1: "Jalur reset melalui pin EN memotong kedua loop ini secara hardware-level."
- 7.1.5 (storyboard): "tombol reset hardware ditekan selama minimal 2 detik".

F-HW-6 dan Bab 8.5 menetapkan tombol di GPIO4 yang ditahan 3 detik, dan begitu juga firmware.
Pin EN me-restart ESP32, bukan mereset state FSM, dan restart akan menghapus buffer serta memutus
sambungan modem. Jadi kalimat 8.7.1 bukan sekadar beda istilah.

Teks usulan 8.7.1:

> Jalur reset melalui tombol GPIO4 yang ditahan 3 detik memotong kedua loop ini: firmware
> menghentikan buzzer, mengembalikan state lokal ke Normal, dan mengirim event reset ke cloud
> (QoS 1) agar FSM di cloud ikut kembali ke Normal.

Di 7.1.5 cukup ganti "minimal 2 detik" menjadi "3 detik".

---

## 6. Kalibrasi baseline GSR: 30 detik di demo, 10–30 menit di laporan

**Lokasi:** 5.5.3 dan Tabel 4.3.

Rumus μ + k·σ sudah dipakai (k = 2,5), lengkap dengan batas aman 20 µS dan HR 120/40 bpm dari
Tabel 4.3. Bedanya, durasi kalibrasi default `CALIB_SECONDS=30` supaya demo tidak menunggu lama.
Untuk alat sungguhan, isi `CALIB_SECONDS=600` (10 menit) atau lebih di `.env`. Tidak perlu mengubah
laporan. Cukup sebutkan di bab pengujian bahwa demo memakai kalibrasi dipersingkat.

---

## 7. Keterbatasan Lead I untuk infark inferior

**Lokasi:** subbab keterbatasan / analisis risiko (Bab 5 atau bagian penutup).

Model produksi (Lead I) hanya mengenali 38 % window infark inferior, dibanding 62 % infark anterior.
Percobaan berpasangan di `docs/analisis_lead.md` (latih ulang dengan data dan split yang sama) menunjukkan
Lead II menaikkan infark inferior dari 0,42 ke 0,71, tetapi menurunkan infark anterior dari 0,64 ke 0,49.

Teks usulan:

> Konfigurasi Lead I dipilih karena paling stabil pada kaos (kedua elektroda di dada atas). Konsekuensinya,
> infark dinding inferior paling sulit dikenali: sensitivity pada set uji hanya 0,38, dibanding
> 0,62 untuk infark anterior. Percobaan berpasangan dengan Lead II (data dan pasien sama) menaikkan
> deteksi infark inferior dari 0,42 menjadi 0,71, tetapi menurunkan infark anterior dari 0,64 menjadi 0,49. Tidak ada
> satu lead yang unggul di semua kategori, sehingga pengembangan berikutnya yang paling menjanjikan
> adalah kanal kedua (Lead I + Lead II), bukan memindahkan elektroda.

---

## 8. Alarm palsu dan persistence khusus Pra-Serangan

**Lokasi:** 4.5 (temporal persistence), bisa juga Bab 6 pengujian.

Pada 18 jam rekaman wearable BUT QDB (orang sehat beraktivitas), setelan laporan (τ 0,44, N = 2)
menghasilkan 5,7 WARNING palsu per jam. Software menyediakan `PERSIST_N_PRE`, yaitu jumlah window
yang dibutuhkan khusus bila kelasnya Pra-Serangan. Default 0, artinya sama dengan N, jadi perilaku
sesuai laporan. Dengan `PERSIST_N_PRE=4`, alarm palsu turun ke 1,95 per jam tanpa mengubah
sensitivity kelas Serangan sama sekali. Detailnya ada di `docs/analisis_alarm_palsu.md`.

Ini keputusan tim. Kalau dipakai, tambahkan kalimat berikut di 4.5:

> Untuk kelas Pra-Serangan (iskemia, AF), yang tidak berubah fatal dalam hitungan detik, persistence
> diperpanjang menjadi 4 window (sekitar 14 detik). Kelas Serangan tetap memakai N = 2.

---

## 9. Retensi data (F-BE-4)

**Lokasi:** Tabel 7.3, F-BE-4 "retensi minimal 30 hari".

Sudah diterapkan: `RETENSI_HARI` di `.env`. Nilai 0 berarti simpan selamanya (default). Kalau diisi,
nilai di bawah 30 otomatis dinaikkan ke 30. ECG, vital, dan inferensi lama dihapus tiap 6 jam.
Event, log transisi, log notifikasi, dan ECG ±2 menit di sekitar setiap event tidak pernah dihapus,
sehingga riwayat dan PDF tetap bisa dibuka. Laporan tidak perlu diubah.

---

## 10. Endpoint REST memakai awalan /api

**Lokasi:** 8.5.5 (Halaman 1–6) dan 8.5.6.

Laporan menulis `/auth/login`, `/auth/signup`, `/contacts`, `/history/{id}/ecg`, `/users/me`.
Di software semuanya ada, dengan awalan `/api` (misalnya `/api/auth/login`) supaya tidak bentrok
dengan rute halaman seperti `/riwayat` dan `/kontak`. WebSocket tetap `/data/realtime`.

Cukup tambahkan satu kalimat di awal 8.5.5:

> Seluruh endpoint REST pada subbab ini berada di bawah awalan `/api`; misalnya `/auth/login`
> diakses sebagai `/api/auth/login`.

Endpoint yang ada di software tetapi belum disebut di laporan (bisa dimasukkan ke F-BE-6 bila perlu):
`/api/auth/verify`, `/api/auth/forgot`, `/api/auth/reset`, `/api/devices/pair`, `/api/status`,
`/api/trend`, `/api/public/:token` dan `/api/public/:token/ack` (Halaman 6 untuk kontak tanpa akun),
`/api/join/:code` (undangan kontak darurat), `/api/push/*`.

---

## 11. Fitur akun yang ditambahkan

**Lokasi:** Tabel 7.4 (F-APP-1) dan 8.5.5 Halaman 1.

Software menambahkan beberapa hal yang belum tertulis. Semuanya wajar untuk aplikasi dengan data
kesehatan, jadi sebaiknya disebut:

- **Verifikasi email dan lupa kata sandi.** Butuh SMTP (misalnya sandi aplikasi Gmail). Kalau SMTP
  tidak diisi, tautan dicetak di log server, sehingga demo tetap jalan tanpa email.
- **Persetujuan pemrosesan data** wajib dicentang saat daftar, dan waktunya disimpan (UU PDP 27/2022).
- **Pairing alat** dengan memindai QR di label alat (`CARDIOVEST:<id>:<kode>`) atau mengetik kode.
  Kode disimpan sebagai hash. Satu alat hanya bisa dipasangkan ke satu akun, dan melepasnya butuh
  kata sandi.
- **Kontak darurat tanpa akun.** User Utama menambah kontak, lalu mengirim tautan undangan lewat
  WhatsApp. Kontak membuka tautan itu sekali untuk menyalakan notifikasi. Saat CRITICAL, kontak menekan
  "Saya terima" dan User Utama melihatnya langsung di beranda. Ini mewujudkan "tombol konfirmasi
  penerimaan" di storyboard 7.1.5.

Teks usulan tambahan untuk F-APP-1:

> Pendaftaran memerlukan persetujuan pemrosesan data kesehatan. Email diverifikasi melalui tautan,
> dan kata sandi dapat diatur ulang melalui email. Kata sandi dan kode pairing disimpan dalam bentuk
> hash scrypt.

---

## Ringkasan cepat

| # | Bagian laporan | Jenis | Perlu diubah? |
|---|---|---|---|
| 1 | Tabel 6.4 | hasil di bawah target | ya, tambah kolom hasil + penjelasan |
| 2 | 4.4.4, F-BE-2 | τ berbeda | ya, tambah paragraf kalibrasi |
| 3 | Tabel 5.8, 5.x, 8.6.5, F-BE-5 | stack berbeda | ya |
| 4 | 2.6.2, 3.5.2, 6.2.5 | laporan bertentangan sendiri | ya, samakan ke QoS 0 + buffer |
| 5 | 8.7.1, 7.1.5 | bertentangan dengan F-HW-6 | ya, dua kalimat |
| 6 | 5.5.3 | durasi kalibrasi demo | cukup disebut di bab uji |
| 7 | keterbatasan | temuan baru | disarankan |
| 8 | 4.5 | opsi baru | keputusan tim |
| 9 | F-BE-4 | sudah sesuai | tidak |
| 10 | 8.5.5 | awalan /api | satu kalimat |
| 11 | F-APP-1 | fitur tambahan | disarankan |
