# CardioVest
## Capstone C-251: Alat Monitoring dan Early Warning System Deteksi Serangan Jantung

Satu folder berisi seluruh sistem:

- **Software alat**: firmware ESP32 (`firmware/`), layanan cloud CNN 1D + FSM (`cloud/`), pemutar EKG
  dataset (`dataset/`), dan alat uji (`tools/`, `tests/`).
- **Aplikasi (UI/UX)**: tampilan Next.js (PWA) untuk User Utama dan Kontak Darurat (`web/`, dipasang di
  Vercel) dan server API + realtime (`server/`).
- **Deploy** (`deploy/`): demo gratis tanpa kartu kredit. Tampilan dan debug viewer di Vercel, layanan
  cloud + server + pemutar dataset EKG di Render, broker MQTT di EMQX Cloud.

Tidak perlu Docker di laptop. Setelah penyiapan sekali-jalan di [`deploy/README.md`](deploy/README.md),
cukup `git add -A`, `git commit`, `git push`: Vercel dan Render memperbarui diri otomatis.

Alurnya mengikuti rancangan BAB 1–11:

```
 ┌──────────────────────────┐   MQTT (QoS per topik)   ┌──────────────┐        ┌────────────────────────────────┐
 │ Rompi CardioVest (ESP32) │ ───────────────────────► │ Broker MQTT  │ ─────► │ Layanan cloud                  │
 │ ECG AD8232 250 Hz        │  device/{id}/ecg   (0)   │  8883 (TLS)  │        │  • sliding window 1750/875     │
 │ MAX30102 HR+SpO2 / GSR   │  device/{id}/vital (1)   │  EMQX Cloud  │        │  • CNN 1D ONNX (44.547 param.) │
 │ MPU6050, lokasi statis   │  device/{id}/event (1)   │              │ ◄───── │  • decision engine FSM S1/S2/S3│
 │ WiFi, jatuh 3 fase       │ ◄─ device/{id}/cmd (1)   │              │        │  • SQLite + mock notifikasi    │
 └──────────────────────────┘    device/{id}/lwt (1,R) └──────┬───────┘        └────────────────────────────────┘
                                                              │ device/{id}/state (1,R) · alert (2) · inference (0)
                                                              ▼
                                   server/ (API + Socket.IO + Web Push) ──► web/ di Vercel ──► ponsel keluarga
```

> **Sebelum uji di alat:** baca [checklist sebelum uji di alat](#12-checklist-sebelum-uji-di-alat).
>
> **Bagian laporan yang tidak lagi cocok dengan software** (τ 0,44, stack SQLite/Web Push, QoS, tombol
> reset, Tabel 6.4) beserta teks pengganti siap tempel ada di [`docs/penyesuaian_laporan.md`](docs/penyesuaian_laporan.md).

> **Batasan penting.** Model CNN 1D dilatih dengan PTB-XL + MIT-BIH (lead tunggal) dan sumber EKG Dataset memutar
> ulang rekaman asli pasien set uji. Sistem ini tetap purwarupa penelitian, bukan alat diagnosis. Performa model
> dan keterbatasannya dijelaskan di bagian [Model CNN 1D](#6-model-cnn-1d).

---

## 1. Struktur folder

```
CardioVest/
├── deploy/                     # README penyiapan + backend/ (Dockerfile dan run.sh untuk Render)
├── common/heartsim_common/     # modul bersama
│   ├── config.py               #   konstanta dari dokumen (fs, window, ambang, N, M, tau_conf, ...)
│   ├── topics.py               #   hierarki topik & QoS
│   ├── codec.py                #   payload ECG JSON / biner delta-encoding
│   └── ecg_synth.py            #   generator ECG sintetis (normal, depresi ST, AF, PVC, STEMI, VT, VF)
├── dataset/dataset/            # PEMUTAR EKG DATASET (sumber EKG "Dataset" di debug viewer)
│   ├── __main__.py             #   python -m dataset: kirim device/<id>/ecg_dataset saat sumber = dataset
│   ├── replay.py               #   pemutar rekaman asli (PTB-XL/MIT-BIH, pasien held-out)
│   └── replay_bank.npz         #   bank window replay (dibuat oleh train_real.py)
├── cloud/
│   ├── cloud/                  # LAYANAN CLOUD
│   │   ├── service.py          #   subscriber MQTT + antrean + orkestrasi
│   │   ├── windowing.py        #   sliding window overlap 50 %
│   │   ├── inference.py        #   Z-score -> CNN 1D (ONNX Runtime) -> softmax
│   │   ├── signal_quality.py   #   gerbang kualitas sinyal (lead-off, datar, derau) sebelum FSM
│   │   ├── decision_engine.py  #   FSM + persistence + histeresis + validator HR/GSR/SpO2 + kalibrasi GSR
│   │   ├── notifier.py         #   dispatcher notifikasi tiruan (aturan penerima + retry backoff)
│   │   ├── storage.py          #   repository SQLite (pengganti sementara InfluxDB + PostgreSQL)
│   │   └── export.py           #   ekspor data dummy ke CSV
│   └── model/
│       ├── datasets/           #   prepare.py (praproses PTB-XL + MIT-BIH), labels.py (pemetaan 3 kelas)
│       ├── train_real.py       #   pelatihan + evaluasi CNN 1D data nyata (arsitektur Tabel BAB 10)
│       ├── kalibrasi_tau.py    #   kalibrasi τ_conf: sweep window + simulasi FSM (README 6.3)
│       ├── ekspor_model.py     #   ekspor ke .h5 dan .onnx (luaran L2) + cek keluaran identik
│       ├── kurva_roc.py        #   kurva ROC per kelas pada set uji -> artifacts/roc.png
│       ├── train.py            #   pelatihan CNN 1D data sintetis (pembanding)
│       └── artifacts/          #   cnn1d_ecg.keras/.h5/.onnx, metrics.json, roc.png, grafik, split_pasien.csv
├── tools/
│   ├── monitor.py              # monitor terminal real-time
│   ├── kalibrasi_lapangan.py   # pilih tau/N dari data alat sendiri (setelah uji pakai)
│   ├── analisis_sqi.py         # uji gerbang kualitas pada CUDB, VFDB, BUT QDB
│   ├── uji_alarm_palsu.py      # alarm palsu per jam pada rekaman wearable BUT QDB
│   ├── uji_sensitivitas.py     # episode VT/VF kontinu + recall per window vs tau
├── firmware/                   # FIRMWARE ESP32: cardiovest_c251/ (Arduino IDE, satu berkas)
├── web/                        # TAMPILAN: Next.js 16 untuk Vercel, lihat web/README.md
├── server/                     # API + Socket.IO + MQTT + Web Push (Node.js 22), lihat server/README.md
├── docs/                       # penyesuaian_laporan.md, analisis_sqi.md, analisis_alarm_palsu.md, analisis_lead.md (+ angka mentah .json)
├── tests/                      # unit + integrasi: FSM, codec, layanan cloud, gerbang sinyal, retensi (pytest)
└── data/export/                # hasil ekspor CSV (dibuat otomatis)
```

---

## 2. Deploy dan alur kerja harian

Penyiapan sekali-jalan (EMQX, Render, Vercel, ESP32) ada di [`deploy/README.md`](deploy/README.md).
Setelah itu:

```powershell
git add -A
git commit -m "feat: ..."
git push
```

| Yang dilihat | Di mana |
|---|---|
| **Aplikasi CardioVest** | `https://<proyek>.vercel.app`. Daftar akun, lalu pasangkan alat `cv-001` dengan kode dari variabel `DEVICES` di Render |
| **Log** keputusan FSM dan mock FCM | tab **Logs** layanan Render |
| **Status layanan** | `https://<proyek>.vercel.app/api/health` |
| **Debug viewer** (EKG mentah, CNN, FSM, vital, switch Hardware/Dataset) | `https://<proyek>.vercel.app/debug` |
| **MQTT Explorer** (opsional) | host EMQX, port `8883`, *Encryption* aktif, username dan sandi broker |

### Sumber EKG dan reset lewat API

Paling mudah lewat debug viewer `/debug`. Lewat API (dari aplikasi, atau Console browser seperti di `deploy/README.md`):

| Aksi | Endpoint |
|---|---|
| hentikan alarm | `POST /api/reset` `{"confirm":true}` |
| EKG dari ESP32 | `POST /api/source` `{"source":"hardware"}` |
| EKG dari rekaman PTB-XL/MIT-BIH (vital tetap dari ESP32) | `POST /api/source` `{"source":"dataset","rekaman":"stemi"}` |


---

## 3. Mode alat dan sumber EKG

Sistem hanya bergerak bila rompi (ESP32) tersambung lewat WiFi. Di debug viewer `/debug` dipilih:

| Pilihan | Isi |
|---|---|
| **Demo** | mekanisme hemat energi sesuai rancangan, lihat tabel sensor di bawah |
| **Test** | semua sensor menyala terus dan lokasi selalu dikirim, untuk memeriksa tiap sensor |
| **Hardware** | EKG dari AD8232 di rompi |
| **Dataset** | EKG dari rekaman PTB-XL/MIT-BIH pasien held-out; HR, SpO2, GSR, gerak, dan lokasi tetap dari rompi |

Sensor yang menyala per mode dan state:

| Sensor | Demo, NORMAL | Demo, WARNING | Demo, CRITICAL | Test |
|---|---|---|---|---|
| EKG AD8232 | menyala | menyala | menyala | menyala |
| IMU MPU6050 (gerak, jatuh, τ adaptif) | menyala | menyala | menyala | menyala |
| PPG MAX30102 (HR, SpO2) | mati | menyala | menyala | menyala |
| GSR | hanya saat kalibrasi baseline | menyala | menyala | menyala |
| Lokasi statis −7,765501, 110,372210 | tidak dikirim | tidak dikirim | dikirim | dikirim |

Saat PPG mati, HR diambil dari EKG (Pan-Tompkins) dan tidak dihitung sebagai mode validator terdegradasi.

Jenis rekaman Dataset dan hasilnya:

| Kelompok | Rekaman | Mode Demo (CNN + FSM + validator rompi) | Mode Test (langsung label rekaman) |
|---|---|---|---|
| Normal | `normal` | tetap NORMAL | NORMAL |
| Pra-serangan | `st_depression`, `af`, `pvc`, `cd`, `svt` | WARNING setelah N = 2 window bila CNN yakin ≥ τ_warn, lalu pulih saat kembali Normal | WARNING |
| Serangan | `stemi`, `vt`, `vf` | WARNING; CRITICAL hanya bila validator rompi ikut tidak normal (1_HR ∧ 1_GSR ∧ 1_SpO2). Pemakai yang sehat dan duduk diam membuat status berhenti di WARNING | CRITICAL |

Di mode Test + Dataset, CNN tetap berjalan dan hasilnya tampil, tetapi state langsung mengikuti label rekaman tanpa
persistence dan validator. Berpindah ke rekaman lain langsung mengganti state (CRITICAL ikut dilepas). Keluar dari
kombinasi ini (ganti ke Demo atau ke Hardware) mengembalikan state ke NORMAL.

`POST /api/reset`, **Reset status** / **Hentikan alarm** (beranda web), tombol reset GPIO4 (tahan 3 s), dan tombol
EN/RST di board ESP32 mengembalikan sistem ke NORMAL dari state mana pun. BAB 4.5 hanya menyebut tombol fisik untuk
keluar dari CRITICAL; jalur web adalah tambahan dan bisa dimatikan dengan `REMOTE_RESET=0`.

---

## 4. Topik MQTT dan format payload

| Topik | QoS | Arah | Periode | Isi |
|---|---|---|---|---|
| `device/{id}/ecg` | 0 | perangkat → cloud | 3,5 s | 875 sampel ECG bersih baru (JSON atau biner delta) |
| `device/{id}/vital` | 1 | perangkat → cloud | 1 s | HR + sumber, HR PPG/ECG, SQI, SpO2, GSR, status daya PPG/GSR, akselerasi, jatuh, lokasi, state lokal |
| `device/{id}/event` | 1 | perangkat → cloud | saat perlu | `hardware_reset` dengan `reason` `boot` (tombol EN/RST, alat menyala) atau `tombol` (GPIO4) (ekstensi) |
| `device/{id}/remote` | 1 | web → cloud | saat perlu | `remote_reset` dari tombol "Hentikan alarm" di beranda (ekstensi; `REMOTE_RESET=0` mematikannya) |
| `device/{id}/lwt` | 1, retained | broker | otomatis | `online` / `offline` |
| `device/{id}/cmd` | 1 | cloud → perangkat | saat berubah | `set_state`, `clear_latch`, `set_mode`, `gsr_calibrate` (`{"cmd":"gsr_calibrate","seconds":35}`) |
| `device/{id}/state` | 1, retained | cloud → semua | berubah + heartbeat tiap window | state, alasan, sejak, GPS, info kalibrasi GSR |
| `device/{id}/alert` | 2 | cloud → semua | saat Warning/Critical | payload notifikasi (format BAB 8.6) |
| `device/{id}/inference` | 0 | cloud → semua | 3,5 s | kelas, probabilitas, p_conf, validator, keputusan, latensi (ekstensi) |
| `device/{id}/source` | 1, retained | web → cloud, dataset | saat berubah | sumber EKG `{"source":"hardware"}` atau `{"source":"dataset","rekaman":"vt"}` (ekstensi) |
| `device/{id}/ecg_dataset` | 0 | dataset → cloud | 3,5 s | EKG rekaman saat sumber = dataset, format sama dengan `ecg` (ekstensi) |

**Contoh `vital`:**
```json
{"device_id":"cv-001","ts":1790677951422,"hr":124.6,"hr_source":"PPG","hr_ppg":124.6,"hr_ecg":109.6,
 "sqi":0.85,"spo2":96.4,"gsr":13.83,"ppg_on":true,"gsr_on":true,
 "accel":{"x":0.018,"y":0.055,"z":0.985,"mag":0.986,"sd":0.012},"fall_detected":false,"fall_ts":null,
 "local_state":"WARNING","mode":"demo","gps":{"active":false,"fix":false},"buffered":false}
```

**Contoh `ecg` (JSON):** `{"device_id":"cv-001","seq":42,"t0":1790677900000,"fs":250,"n":875,"unit":"count (1 mV = 500)","samples":[12,15,...],"buffered":false}`

**Format biner (`PAYLOAD_FORMAT=binary`):** header 20 byte (`'CV'`, versi, flag, seq u32, t0 u64 ms, fs u16, n u16),
lalu sampel pertama int16 dan delta int8, dengan escape `0x80` + int16 untuk lonjakan QRS. Hasil uji: **≈ 921 byte per
paket (1,05 byte/sampel, ≈ 263 B/s)**, sesuai perkiraan 1,1 byte/sampel di BAB 5.4.2. Payload JSON berukuran ≈ 4 kB per paket.

**Contoh `alert` (Critical):**
```json
{"event_type":"critical","timestamp":1790677389568,"user_id":"user-001","device_id":"cv-001","state":"CRITICAL",
 "confidence":0.754,"class":"Serangan","hr":127.1,"hr_source":"PPG","gsr":15.95,"spo2":88.2,
 "validator_quality":"independen","fall_detected":false,"event_id":2,"gps":null,"message":"DARURAT: ..."}
```
Modul GPS tidak dipakai. Alat mengirim koordinat statis −7,765501, 110,372210 di field `gps` (mode Demo mulai
CRITICAL, mode Test selalu). Bila koordinat itu baru masuk setelah alert `critical`, cloud mengirim alert lanjutan
`critical_location`, dan `critical_fall` bila jatuh terdeteksi setelah CRITICAL. Saat reset, cloud mengirim `resolved`.

---

## 5. Decision engine (BAB 4.5, 5.5)

| Parameter | Nilai default | Variabel `.env` |
|---|---|---|
| Ambang kepercayaan τ_conf | 0,44 saat diam (p_conf < τ → "tidak diputuskan"; hasil kalibrasi, lihat 6.3) | `TAU_CONF` |
| Ambang kelas non-Normal τ_warn | 0,80: window Pra-Serangan/Serangan baru dihitung bila p_conf ≥ 0,80 (penekan alarm palsu) | `TAU_WARN` |
| τ adaptif gerak | 0,76 bila median `accel.sd` 7 s terakhir > 0,08 g (pengguna bergerak) | `TAU_CONF_MOTION`, `MOTION_SD_G` |
| Persistence S1→S2 | N = 2 window berturut-turut non-Normal | `PERSIST_N` |
| Mode validator terdegradasi (PPG menyala tetapi SQI < 0,5, HR dari ECG) | N = 3 | `PERSIST_N_DEGRADED`, `TAU_SQI` |
| Histeresis S2→S1 | N + M = 3 window Normal (M = 1) | `HYSTERESIS_M` |
| 1_HR | HR > 120 atau < 40 bpm (median 3 s terakhir) | `HR_HIGH`, `HR_LOW` |
| 1_GSR | GSR > min(max(μ + kσ, μ + 3 µS), 20 µS), k = 2,5. Baseline dikalibrasi saat NORMAL: cloud mengirim `gsr_calibrate` setelah alat menyala, alat menyalakan GSR selama `CALIB_SECONDS` + 5 s lalu mematikannya lagi (mode Demo). Bila belum terkalibrasi, ambang = 20 µS | `GSR_K`, `CALIB_SECONDS`, `GSR_ABS_HIGH`, `GSR_CALIB_RETRY_S` |
| 1_SpO2 | SpO2 < 90 % (median 3 s terakhir, dari rasio merah/IR MAX30102, hanya bila SQI PPG ≥ 0,5) | `SPO2_LOW` |
| Masuk S3 | kelas Serangan **∧** 1_HR **∧** 1_GSR **∧** 1_SpO2 (dari S1 tetap perlu persistence N) | – |
| Reset | `hardware_reset` dari perangkat berlaku di semua state (WARNING dan CRITICAL kembali NORMAL; pada NORMAL hanya penghitung persistence dibersihkan). Alat yang menyala ulang (tombol EN/RST) selalu mulai NORMAL dan mengirim `hardware_reset` dengan `reason: boot`; cloud ikut kembali ke NORMAL dan mengulang kalibrasi GSR. Reset dari beranda web juga berlaku di semua state bila `REMOTE_RESET=1` (default; `0` = hanya tombol fisik sesuai proposal) | `REMOTE_RESET` |
| Mode Test + Dataset | state = label rekaman (`normal` NORMAL, pra-serangan WARNING, serangan CRITICAL), tanpa persistence dan validator | – |

Beberapa keputusan implementasi yang belum diatur rinci di dokumen:
* Persistence dihitung **per inferensi** (hop 3,5 s), jadi N = 2 ≈ 7 s dan N+M = 3 ≈ 10,5 s.
* Window yang masih memuat sampel dari sebelum reset tidak ikut menggerakkan FSM, agar sistem tidak langsung
  kembali ke WARNING akibat sisa sinyal serangan.
* Paket hasil retransmisi buffer (`buffered=true` atau berumur > 15 s) tetap disimpan dan diinferensi, tetapi
  **tidak** mengubah state. Keputusan darurat hanya berdasar data terkini.
* Deteksi jatuh hanya menjadi metadata dan tidak memicu CRITICAL sendiri (keputusan poin 8).
* `accel.sd` adalah simpangan baku |a| seluruh sampel IMU (100 Hz) dalam satu periode vital. Field ini dikirim
  firmware. Bila tidak ada (perangkat lama), cloud memakai simpangan baku `accel.mag` antar-paket.
* Kalibrasi 30 s dipersingkat dari rancangan 10–30 menit supaya demo cepat. Ubah `CALIB_SECONDS` untuk pengujian nyata;
  alat otomatis menyalakan GSR selama durasi yang diminta cloud.
* SpO2 adalah tambahan di luar rancangan awal. Rumusnya pendekatan umum 110 − 25·R tanpa kalibrasi klinis, dan sensor
  di dada membuat angkanya kasar. SpO2 menjadi validator ketiga yang wajib ikut terpenuhi bersama HR dan GSR.
* Angka sistem di bagian 6.3 dihitung dengan gerbang lama (1_GSR ∧ 1_HR) sebelum SpO2 ditambahkan.

---

## 6. Model CNN 1D

### 6.1 Ringkasan
| Item | Nilai |
|---|---|
| Arsitektur | Tabel BAB 10.4: Conv 32/64/128 + BN + MaxPool, GAP, Dropout 0,3, Dense 64, Dropout 0,2, Softmax 3, **44.547 parameter** |
| Data | PTB-XL 1.0.3 (lead I, 100 Hz → 250 Hz) + MIT-BIH Arrhythmia 1.0.0 (MLII, 360 Hz → 250 Hz), band-pass 0,5–40 Hz |
| Integritas data | 87.203/87.203 berkas PTB-XL dan 704/704 berkas MIT-BIH cocok dengan `SHA256SUMS.txt` resmi PhysioNet (`datasets/VERIFIKASI_SHA256.txt`) |
| Input | window 7 s (1.750 sampel), crop acak dari window 10 s, Z-score per window |
| Split | 70/15/15 **inter-patient** (16.125 / 3.518 / 3.469 window; 11.699 / 2.508 / 2.508 pasien), dicek bebas kebocoran pasien |
| Pelatihan | Adam 1e-3, ReduceLROnPlateau(0,5; 5), EarlyStopping(10) — berhenti epoch 28, bobot terbaik epoch 18 |
| Penyeimbangan | class weight; maks. 60 window per (pasien, kondisi); VT/VF di-oversample 10× |

Pemetaan label (`cloud/model/datasets/labels.py`):
* **Normal**: PTB-XL NORM (likelihood ≥ 80) dengan ritme sinus tanpa temuan lain; MIT-BIH window ritme (N dengan seluruh beat N.
* **Pra-Serangan**: AF/flutter, SVT, PVC/bigemini/trigemini, blok konduksi (superclass CD), perubahan ST/T (superclass STTC, depresi ST, T terbalik).
* **Serangan**: infark miokard (superclass MI) serta pola injury/elevasi ST PTB-XL; VT dan VF/flutter ventrikel MIT-BIH.
* Dikecualikan: rekaman pacemaker, hipertrofi tanpa temuan lain, dan label ambigu (mis. MI dengan likelihood < 50).

### 6.2 Hasil pada set uji (3.469 window, 2.508 pasien yang tidak pernah dilihat saat pelatihan)
| Kelas | n | Sensitivity | Specificity | Precision | F1 |
|---|---|---|---|---|---|
| Normal | 1.337 | 0,819 | 0,784 | 0,704 | 0,757 |
| Pra-Serangan | 1.521 | 0,524 | 0,843 | 0,723 | 0,608 |
| Serangan | 611 | 0,498 | 0,823 | 0,375 | 0,428 |

Akurasi 63,3 %, macro-F1 0,597, AUC one-vs-rest 0,812. Confusion matrix, kurva training, dan grafik τ_conf ada di
`cloud/model/artifacts/`, dan rincian lengkapnya di `metrics.json`.

Sensitivity kelas Serangan PTB-XL per lokasi infark:

| Lokasi | n | Sensitivity |
|---|---|---|
| Lateral (LMI) | 15 | 0,73 |
| Anterior/anteroseptal (AMI) | 367 | 0,62 |
| Inferior (IMI) | 333 | 0,38 |

Pola ini sesuai fisiologi. Lead I merekam dinding lateral, sedangkan infark inferior terutama tampak di lead II, III,
dan aVF. **Keterbatasan terbesar model ini adalah konfigurasi lead tunggal (Lead I), bukan arsitekturnya.**

### 6.3 Kalibrasi τ_conf (default baru 0,44)
Skrip: `cloud/model/kalibrasi_tau.py`. Hasil: `artifacts/kalibrasi_tau.json` dan `artifacts/kalibrasi_tau.png`.

**Aturan pemilihan (BAB 4.4.4: maksimalkan Sensitivity, Specificity sebagai kendala minimum).** Nilai τ dipilih pada
set **validasi** dan dilaporkan pada set **uji**, sehingga angka uji tidak bias oleh proses pemilihan. Yang
dimaksimalkan adalah P(CRITICAL ≤ 60 s) pada episode Serangan. Dua kendala harus terpenuhi:
* spesifisitas efektif ≥ 80 % (Tabel target BAB 4.7);
* WARNING palsu ≤ 1 per jam pada pasien Normal (asumsi rancangan untuk menekan *alarm fatigue*).

Grid yang diuji adalah 0,34–0,94 dengan langkah 0,02, dan hasilnya **τ_conf = 0,44**.

**Kalibrasi model baik.** ECE pada validasi 0,040 dan pada uji 0,020. Jadi rendahnya cakupan pada τ = 0,75
**bukan** karena model terlalu "rendah diri". Model memang ragu pada sebagian besar rekaman lead tunggal, dan p_conf
mencerminkan peluang benar yang sebenarnya. Karena itu ambang perlu diturunkan; menskalakan ulang probabilitas
(*temperature scaling*) tidak menyelesaikan masalah ini.

**Tingkat window (set uji, 3.469 window × 3 posisi potongan).** "Efektif" berarti window yang tidak diputuskan
dihitung terlewat pada pasien sakit, dan dihitung tidak memicu alarm pada pasien Normal.

| τ_conf | Cakupan | Akurasi diterima | Sens. Serangan efektif | Sens. abnormal efektif (→ WARNING) | Spesifisitas efektif |
|---|---|---|---|---|---|
| 0 (tanpa gerbang) | 100 % | 62,8 % | 51,2 % | 79,0 % | 80,6 % |
| **0,44 (default baru)** | **88,4 %** | **66,2 %** | **47,6 %** (CI95 43,4–51,1) | **71,7 %** (67,3–75,8) | **90,0 %** (80,8–95,3) |
| 0,50 | 78,3 % | 68,2 % | 43,6 % | 62,4 % | 92,9 % |
| 0,60 | 48,6 % | 76,0 % | 30,3 % | 30,9 % | 98,8 % |
| 0,75 (default lama) | 19,0 % | 84,2 % | 10,6 % | 7,9 % | 99,7 % |
| 0,85 | 6,9 % | 93,0 % | 4,4 % | 2,7 % | 99,8 % |

CI95 dihitung dengan *bootstrap* per pasien (500 ulangan).

**Tingkat sistem (set uji: CNN + τ + FSM `decision_engine.py` apa adanya, N = 2, M = 1, episode 60 s).**

| τ_conf | P(CRITICAL ≤ 60 s) Serangan + validator positif | P(WARNING ≤ 60 s) Pra-Serangan | WARNING palsu per jam (Normal istirahat) | Pasien Normal tanpa WARNING palsu dalam 1 jam | CRITICAL palsu per jam (Normal + aktivitas, 1_GSR = 1_HR = 1) |
|---|---|---|---|---|---|
| 0 | 56,8 % | 75,2 % | 3,82 | 84,0 % | 17,5 |
| **0,44** | **52,6 %** | **68,8 %** | **1,45** | **90,0 %** | **8,3** |
| 0,50 | 47,3 % | 59,2 % | 0,36 | 94,0 % | 6,3 |
| 0,60 | 33,2 % | 31,2 % | 0,003 | 99,8 % | 0,42 |
| 0,75 | 12,8 % | 8,0 % | 0 | 100 % | 0 |

Saat sistem mendeteksi, median waktu ke CRITICAL adalah 7 s (dua window). Pada mode validator terdegradasi
(N = 3, τ = 0,44) median waktunya 10,5 s, P(CRITICAL ≤ 60 s) 52,2 %, dan WARNING palsu turun menjadi 0,62 per jam.

**Interpretasi**
1. τ = 0,75 terlalu konservatif untuk model ini. Spesifisitasnya hampir 100 %, tetapi hanya 1 dari 8 episode
   Serangan yang sampai ke CRITICAL dalam satu menit. Menurunkannya ke 0,44 menaikkan deteksi Serangan sekitar
   4 kali lipat (12,8 % → 52,6 %), sementara spesifisitas window tetap 90 %. Angka ini memenuhi target minimum
   (≥ 80 %) maupun target ideal (≥ 88 %) BAB 4.7.
2. Pada set uji, WARNING palsu (1,45 per jam) sedikit melampaui kendala yang dipenuhi pada validasi (0,98 per jam).
   Selisih validasi–uji ini wajar dan dilaporkan apa adanya. Bila *alarm fatigue* lebih diutamakan, **τ = 0,50**
   adalah alternatif konservatif: WARNING palsu 0,36 per jam, dengan deteksi Serangan 47 %.
3. **Sensitivity tetap jauh di bawah target 90 %** pada τ berapa pun. Pada τ = 0 pun, sensitivity window Serangan
   hanya 51 %. Ambang hanya menggeser titik operasi dan tidak menambah informasi. Batas atasnya ditentukan oleh model
   lead tunggal (lihat 6.2).
4. Pengaman kedua (cross-validation GSR + HR, sebelum SpO2 ditambahkan) hanya efektif bila validator benar-benar negatif. Pada uji tekanan,
   pasien Normal dibuat sedang berolahraga (HR > 120 dan GSR tinggi sepanjang jam). Dalam kondisi itu, setiap
   window Serangan palsu langsung menjadi CRITICAL (8,3 per jam pada τ = 0,44, angka tanpa artefak gerak). Olahraga
   hampir selalu disertai gerak, sehingga kasus ini ditangani τ adaptif gerak di bawah. Kasus HR dan GSR tinggi
   *tanpa* gerak (mis. stres emosional) tetap menjadi keterbatasan, dan perlu diuji dengan data GSR/HR nyata.
5. Asumsi simulasi: urutan window dalam satu episode diambil acak dari window pasien yang sama. Window berurutan
   nyata lebih berkorelasi, sehingga angka per jam adalah estimasi kasar, bukan pengukuran klinis.

#### τ adaptif gerak (0,76 saat pengguna bergerak)
Uji ulang dengan artefak gerak berat pada τ = 0,44 memperlihatkan konflik yang tidak terlihat pada data PTB-XL/MIT-BIH yang
bersih. Saat artefak gerak berat, model membaca ECG Normal sebagai **Serangan** pada 35–40 % window, dengan p_conf
sampai 0,79. Dulu τ = 0,75 menyaring window seperti ini, sedangkan τ = 0,44 meloloskannya.

**Solusi: τ dinaikkan hanya ketika IMU (MPU6050) menunjukkan pengguna sedang bergerak.**
* Indikator gerak adalah median `accel.sd` selama 7 s terakhir (sepanjang satu window ECG), dengan ambang
  > 0,08 g. Saat diam nilainya sekitar 0,01 g; saat berjalan 0,15–0,3 g.
* Median dipakai agar lonjakan sesaat saat jatuh tidak ikut menaikkan τ.

**Kalibrasi τ_gerak (tahap 3 `kalibrasi_tau.py`).**
* Data: rekaman validasi/uji diberi artefak gerak sintetis `heartsim_common.ecg_synth` (intensitas 0,6 dan 0,9).
* Episode: 45 s, mode terdegradasi N = 3.
* Aturan: τ terkecil yang membuat WARNING palsu < 5 % pada setiap intensitas gerak (BAB 6.2: *false alarm*
  akibat interferensi < 5 %).
* Hasil pada validasi: **τ_gerak = 0,76**. Grafik: `artifacts/kalibrasi_tau_gerak.png`.

Hasil pada set uji (rata-rata intensitas 0,6 dan 0,9):

| τ saat bergerak | WARNING palsu per episode artefak 45 s | CRITICAL palsu saat olahraga (HR dan GSR tinggi) | P(CRITICAL ≤ 60 s) bila serangan terjadi saat bergerak |
|---|---|---|---|
| 0,44 (tanpa adaptasi) | 40 % | 39 % | 51 % |
| 0,60 | 19 % | 19 % | 30 % |
| **0,76 (τ_gerak)** | **3,1–4,4 %** | **3,0–4,3 %** | **11–13 %** |

Konsekuensi yang perlu dicatat di laporan:
* Saat diam, sensitivitas tetap seperti tabel di atas (τ = 0,44).
* Saat bergerak, sistem sengaja lebih konservatif. Serangan yang terjadi *selama* aktivitas fisik terdeteksi jauh
  lebih jarang sampai pengguna berhenti bergerak. Begitu pengguna diam, terduduk, atau terjatuh lalu diam, τ
  kembali ke 0,44 dalam ±7 s.
* Ini adalah pengembangan rancangan di luar BAB 4.4.4, yang hanya menyebut satu τ_conf. Dasarnya adalah prinsip
  fusi multi-sensor BAB 3/4: IMU yang sudah ada dipakai untuk menilai keandalan ECG, sama seperti Kalman adaptif
  BAB 5.2 memakai |a| untuk menaikkan derau ukur.
* Artefak gerak di atas adalah model sintetis. Ambang 0,08 g dan τ_gerak perlu diverifikasi dengan rekaman ECG dan IMU
  nyata saat berjalan.

Menjalankan ulang (±3 menit, CPU; lingkungan Python yang sama dengan 6.5):
```powershell
python cloud\model\kalibrasi_tau.py --data ..\datasets\ecg_c251_250hz.npz
# opsi: --spec-min 0.88 (target ideal), --fa-max 0.5 (WARNING palsu per jam), --fa-motion 0.05 (artefak)
```
Nilai terpilih dicetak di akhir. Pasang dengan variabel `TAU_CONF` dan `TAU_CONF_MOTION` di Render.

### 6.4 Riwayat eksperimen (pemilihan model berdasarkan macro-F1 **validasi**, bukan uji)
| Percobaan | Perubahan | Val macro-F1 | Uji akurasi | Sensitivity Serangan (uji) |
|---|---|---|---|---|
| 1 | tanpa batas window per pasien | – (val berayun 0,45–0,64) | 0,642 | 0,555 |
| 2 | maks. 60 window per (pasien, kondisi) | 0,572 | 0,663 | 0,331 |
| **3 (dipakai)** | + oversampling VT/VF 10× | **0,584** | 0,633 | **0,498** |

Pada percobaan 1, 7 pasien MIT-BIH menyumbang sekitar 40 % window validasi, sehingga metrik berayun tajam antar-epoch.
Model data sintetis lama tetap tersimpan sebagai `cnn1d_ecg_sintetis.keras` beserta `metrics_sintetis.json`.

### 6.5 Mereproduksi pelatihan
```powershell
pip install -r cloud\model\requirements-train.txt
# 1) praproses (folder hasil unduhan s3://physionet-open; zip PhysioNet juga diterima)
python cloud\model\datasets\prepare.py --ptbxl ..\datasets\ptbxl --mitdb ..\datasets\mitdb --out ..\datasets\ecg_c251_250hz.npz
# 2) latih + evaluasi (~15 menit CPU); menulis model, metrik, grafik, dan bank replay dataset
python cloud\model\train_real.py --data ..\datasets\ecg_c251_250hz.npz --ptbxl-dir ..\datasets\ptbxl
# 3) ekspor ke ONNX (dipakai layanan cloud), lalu push; Render mengambilnya otomatis
python cloud\model\ekspor_model.py
git add -A; git commit -m "model: latih ulang"; git push
```
`--eval-only` mengevaluasi ulang model tersimpan tanpa melatih. `--cap-per-patient` dan `--oversample-rare`
mengatur penyeimbangan data. Untuk eksperimen tanpa menimpa model produksi, pakai `--out <folder>
--no-bank`. `prepare.py --lead II` mengambil Lead II PTB-XL; perbandingan Lead I vs Lead II (deteksi
infark inferior vs anterior) ada di [`docs/analisis_lead.md`](docs/analisis_lead.md), dan bisa diulang
dengan `cloud/model/bandingkan_lead.py`.

### 6.6 Sumber EKG Dataset: replay rekaman asli
Saat sumber EKG = Dataset, `python -m dataset` memutar ulang window 10 s dari **pasien set uji** sesuai jenis
rekaman yang dipilih (normal, depresi ST, AF, PVC, gangguan konduksi, SVT, STEMI, VT, VF). Nama rekaman tampil di
log Render.
* `REPLAY_ONLY_CORRECT=1` (default) hanya memakai window yang oleh model diklasifikasikan benar pada tiga posisi
  potongan, dengan p_conf ≥ τ_warn (0,80) untuk rekaman tidak normal dan ≥ maks(τ_conf; 0,60) untuk rekaman normal,
  agar window yang diputar memang bisa menggerakkan FSM. Bila suatu jenis rekaman tidak punya window setinggi itu,
  dipakai 5 window benar dengan keyakinan tertinggi; ini terjadi pada `st_depression` (keyakinan tertinggi 0,72),
  sehingga di mode Demo rekaman itu jarang mencapai WARNING. Ini **pemilihan untuk demo**, bukan ukuran performa.
  Ukuran performa ada di 6.2. Ambang bisa diubah dengan `REPLAY_MIN_CONF` dan `REPLAY_MIN_CONF_NORMAL`.
* Kondisi tanpa window "baik" di set uji diambil dari set validasi atau train, dan asalnya dicatat di `replay_bank.npz`.
  Ini terjadi pada VF (hanya rekaman 207, masuk train) dan sebagian besar VT.
* `REPLAY_ONLY_CORRECT=0` memakai **sampel acak** window held-out (60 per kondisi, tanpa tambahan window "baik"),
  termasuk yang salah diklasifikasikan model.

## 7. Data dummy dan ekspor CSV

Di Render Free data hanya bertahan sampai layanan menyala ulang. Untuk data laporan, jalankan
layanan cloud di laptop (bagian 8) lalu ekspor:

```powershell
python -m cloud.export --db data\cardiovest.db --out data\export
```

Hasilnya muncul di `data\export\`: `vitals.csv`, `inferences.csv`, `transitions.csv`, `events.csv`,
`notifications.csv`, `device_status.csv`, `ecg_samples.csv` (30 menit terakhir, count dan mV), serta `ringkasan.txt`
(laju data per topik, rata-rata latensi, jumlah transisi). File ini dapat dipakai untuk grafik laporan BAB pengujian.

---

## 8. Menjalankan di laptop (opsional)

Tidak diperlukan untuk deploy. Berguna untuk mencoba layanan cloud dengan rompi tanpa push. Butuh
Python 3.11 dan Mosquitto untuk Windows; `MQTT_HOST` di `.ino` diarahkan ke IP laptop dan `MQTT_USE_TLS 0`.

```powershell
py -3.11 -m venv .venv; .\.venv\Scripts\Activate.ps1
pip install -r cloud\requirements.txt -r dataset\requirements.txt rich pytest
$env:PYTHONPATH = "$PWD\common;$PWD\dataset;$PWD\cloud"
# terminal 1: mosquitto -v
# terminal 2:
python -m cloud --db data\cardiovest.db
# terminal 3:
python -m dataset
# terminal 4:
python tools\monitor.py
# unit test:
python -m pytest tests -q
```

Untuk tampilan saja, `cd web; npm install; npm run dev` memakai backend asli di Render (lihat `web/README.md`).

---

## 9. Aplikasi CardioVest (`web/`)

Aplikasi untuk User Utama dan Kontak Darurat (Halaman 1–6 di Bab 8.5.5): daftar akun, pairing alat
lewat QR, kontak darurat dengan tautan undangan, notifikasi berlapis (WARNING hanya ke pemakai,
CRITICAL ke pemakai dan semua kontak), halaman darurat dengan peta, riwayat, dan PDF untuk dokter.

Tampilan (`web/`) dipasang di Vercel; API, Socket.IO, MQTT, dan Web Push ada di `server/` di Render.
Rincian fitur ada di [`web/README.md`](web/README.md), endpoint dan CLI admin di
[`server/README.md`](server/README.md).

---

## 10. Pemecahan masalah

| Gejala | Penyebab / solusi |
|---|---|
| Aplikasi atau ESP32 tidak tersambung ke server | Lihat tabel pemecahan masalah di `deploy/README.md`. |
| State tidak pernah WARNING di awal | Cloud baru start: kalibrasi GSR 30 s berjalan, dan window pertama butuh 2 paket (7 s). |
| `model tidak ditemukan` | `cloud/model/artifacts/cnn1d_ecg.onnx` hilang. Jalankan `python cloud\model\ekspor_model.py` lalu push. |
| Tetap CRITICAL | Memang terkunci (latching). Tekan **Hentikan alarm** di beranda web, `POST /api/reset`, tombol reset GPIO4 (3 s), atau EN/RST. |
| Peta tidak muncul | Mode Demo hanya mengirim lokasi saat CRITICAL. Mode Test selalu mengirim. Tile peta perlu internet. |
| Alat asli tersambung tetapi state tidak pernah berubah | Lihat tab Logs di Render: bila "kualitas sinyal" ditolak, elektroda lepas atau sinyal datar. Bila log cloud berisi "jam perangkat belum tersinkron", itu normal di menit pertama (cloud memakai waktu terima). |
| Alarm palsu sering saat alat dipakai | Lihat `docs/analisis_alarm_palsu.md`, lalu jalankan `tools/kalibrasi_lapangan.py` dengan data alat sendiri. |
| Notifikasi web tidak muncul | Wajib HTTPS (kecuali localhost) dan izin notifikasi. iPhone: tambahkan ke Layar Utama dulu (iOS 16.4+). |

---

## 11. Firmware ESP32 (perangkat asli)

Folder `firmware/` berisi firmware Arduino IDE untuk ESP32 + AD8232 + MAX30102 + MPU6050 + GSR, tersambung lewat
WiFi. WiFi, alamat broker, dan akun MQTT ditulis langsung di bagian atas `cardiovest_c251.ino`.

Panduan pemasangan library, rangkaian, perintah Serial Monitor, dan Serial Plotter ada di `firmware/README.md`.


---

## 12. Checklist sebelum uji di alat

1. `python -m pytest tests -q` lolos.
2. Firmware: `DEVICE_ID`, WiFi, dan broker di bagian atas `.ino` benar; Serial Monitor `s` menunjukkan `waktu_sinkron=1`
   setelah ±1 menit.
3. Uji elektroda dulu tanpa cloud: Serial Plotter (`p`) harus menampilkan QRS jelas pada grafik mentah dan terfilter
   saat duduk diam.
   Lepas satu elektroda: log cloud di Render harus menunjukkan window ditolak karena kualitas sinyal dan state tetap NORMAL.
4. Tekan EN/RST saat status WARNING atau CRITICAL: alat dan cloud harus kembali NORMAL.
5. Pakai alat 6–8 jam saat sehat, lalu jalankan `tools/kalibrasi_lapangan.py`. Angka alarm palsu dari
   alat sendiri lebih bisa dipercaya daripada perkiraan di `docs/analisis_alarm_palsu.md`.
6. Kalibrasi baseline GSR untuk alat sungguhan: `CALIB_SECONDS=600` (10 menit, sesuai 5.5.3). Nilai 30 detik
   hanya untuk demo. Selama kalibrasi pemakai duduk tenang; GSR mati sendiri setelahnya.
7. Lewat internet: firmware sudah `MQTT_USE_TLS 1` (port 8883 EMQX).
8. `RETENSI_HARI=30` sudah aktif di Render (F-BE-4) agar disk tidak penuh oleh ECG mentah.
