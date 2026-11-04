# Firmware ESP32: Early Warning System Deteksi Serangan Jantung (Capstone C-251)

Firmware rompi CardioVest. Alat mengirim EKG, vital, dan event ke broker MQTT (EMQX) lewat WiFi; layanan cloud di
Render menilai sinyalnya, dan debug viewer `/debug` menampilkannya.

```
firmware/
└── cardiovest_c251/
    └── cardiovest_c251.ino    # firmware utama (satu berkas, buka di Arduino IDE)
```

## Pengaturan

Semua pengaturan ada di bagian atas `cardiovest_c251.ino`:

```c
#define DEVICE_ID "cv-001"

#define WIFI_SSID "nama WiFi 2,4 GHz"
#define WIFI_PASS "sandi WiFi"

#define MQTT_HOST "xxxxxxxx.ala.asia-southeast1.emqxsl.com"
#define MQTT_USER "cardiovest"
#define MQTT_PASS "sandi broker"

#define GPS_STATIC_LAT -7.765501
#define GPS_STATIC_LON 110.372210
```

`DEVICE_ID` harus sama dengan ID di variabel `DEVICES` Render (bawaan `cv-001`). Koneksi hanya lewat WiFi 2,4 GHz,
dengan TLS ke port 8883 (`MQTT_USE_TLS 1`, wajib untuk EMQX Serverless).

---

## 1. Persiapan Arduino IDE

1. Pasang **Arduino IDE 2.x**.
2. *File → Preferences → Additional boards manager URLs*, isi:
   `https://espressif.github.io/arduino-esp32/package_esp32_index.json`
3. *Tools → Board → Boards Manager* → pasang **esp32 by Espressif Systems versi 3.x**. Firmware diuji
   kompilasi pada 3.0.7.
4. *Tools → Manage Libraries*, pasang **MQTT** by Joel Gaehwiler (256dpi), versi 2.5.2. Library lain (WiFi,
   WiFiClientSecure, Wire, Preferences, LittleFS) sudah bawaan core ESP32. MAX30102 dan MPU6050 dibaca langsung lewat
   register I²C, jadi tidak butuh library sensor.
5. Pengaturan board: **ESP32 Dev Module**, *Partition Scheme*: **Default 4MB with spiffs** (dipakai LittleFS
   untuk buffer offline), *Upload Speed* 921600, Serial Monitor **115200 baud**.

> Library **MQTT (256dpi)** dipilih alih-alih PubSubClient karena PubSubClient hanya bisa *publish* QoS 0,
> sedangkan rancangan BAB 8 mewajibkan QoS 1 untuk topik vital dan event.

---

## 2. Rangkaian (sesuai `#define PIN_*` di `.ino`)

| Komponen | Pin modul | Pin ESP32 | Catatan |
|---|---|---|---|
| AD8232 | OUTPUT / LO- / LO+ | GPIO34 / GPIO33 / GPIO32 | ADC1 (aman dipakai bersama WiFi) |
| MAX30102 | SDA / SCL | GPIO21 / GPIO22 | bus I²C bersama, alamat 0x57, LED merah dan IR |
| MPU6050 | SDA / SCL | GPIO21 / GPIO22 | alamat 0x68 (AD0 ke GND) |
| GSR FZ3294 | SIG | GPIO35 | ADC1, input-only |
| Catu GSR (opsional) | VCC lewat transistor | `PIN_GSR_POWER` | bawaan `-1` (tidak dipakai). Isi nomor pin bila catu GSR ingin benar-benar diputus saat mati |
| Buzzer | + (via transistor) | GPIO27 | 2 kHz (Waspada) / 4 kHz (Darurat) |
| LED dua warna | A / B (via resistor) | GPIO26 / GPIO25 | |
| Tombol reset | satu kaki ke GND | GPIO4 | pull-up internal; tahan **3 s** |

Elektroda Lead I: RA di bawah klavikula kanan, LA di bawah klavikula kiri, RL di perut kanan bawah. Resistor
seri 1 MΩ per jalur elektroda (BAB 8.5.2).

Modul GPS dan modem seluler tidak dipakai. Lokasi dikirim sebagai koordinat statis.

---

## 3. Urutan pengujian

1. Backend sudah berjalan di Render (lihat `deploy/README.md`).
2. Isi pengaturan di bagian atas `.ino`.
3. Upload, buka Serial Monitor 115200, lalu ketik `s` untuk status. Baris `MQTT: terhubung` berarti alat sudah
   masuk broker.
4. Uji elektroda dengan Serial Plotter (bagian 5) sebelum memakai cloud.
5. Buka `https://<vercel>/debug`. Jendela "Alat terputus" hilang sendiri begitu data alat masuk.

---

## 4. Perilaku perangkat

| State (dari cloud) | LED | Buzzer |
|---|---|---|
| NORMAL | kedip singkat tiap 3 s (tiap 1 s bila offline) | mati |
| WARNING | kedip 1 Hz | 2 kHz, 250 ms tiap 2 s |
| CRITICAL | kedip 5 Hz | 4 kHz kontinu |
| Mengisi daya (VBUS) | menyala tetap | – |

### Sensor per mode

| Sensor | Demo, NORMAL | Demo, WARNING | Demo, CRITICAL | Test |
|---|---|---|---|---|
| EKG AD8232 | menyala | menyala | menyala | menyala |
| IMU MPU6050 | menyala | menyala | menyala | menyala |
| PPG MAX30102 (HR, SpO2) | *shutdown* | menyala | menyala | menyala |
| GSR | hanya saat kalibrasi | menyala | menyala | menyala |
| Lokasi statis | tidak dikirim | tidak dikirim | dikirim | dikirim |

* **PPG** dimatikan lewat bit *shutdown* MAX30102 (register 0x09). Setelah menyala, HR dan SpO2 butuh sekitar
  5 detik sampai stabil. Field `ppg_on` di vital menandai status dayanya.
* **SpO2** dihitung dari rasio AC/DC LED merah terhadap IR (R), lalu SpO2 = 110 − 25·R. Nilai hanya dikirim bila
  kontak kulit ada dan SQI PPG ≥ 0,5. Pendekatan ini belum dikalibrasi klinis.
* **GSR** dibaca hanya saat dibutuhkan. Kalibrasi baseline dipicu cloud dengan perintah
  `{"cmd":"gsr_calibrate","seconds":35}` setelah alat menyala; selama itu GSR menyala walaupun status NORMAL.
  Field `gsr_on` di vital menandai status bacaannya.
* **IMU** selalu menyala karena dipakai untuk τ adaptif gerak, Kalman adaptif, dan deteksi jatuh.

### Reset

* **Tombol EN/RST di board**: alat menyala ulang dengan status NORMAL (tidak ada status yang disimpan), lalu
  mengirim event `hardware_reset` dengan `reason: boot` begitu tersambung. Cloud ikut kembali ke NORMAL dan meminta
  kalibrasi GSR baru. Sebelum event itu diterima cloud, perintah WARNING atau CRITICAL dari cloud diabaikan.
* **Tombol GPIO4 ditahan 3 s**: status langsung NORMAL dan event `hardware_reset` dengan `reason: tombol` dikirim.
* **Hentikan alarm di web**: cloud mengirim `clear_latch`.
* Selama CRITICAL, perintah state yang lebih rendah dari cloud diabaikan (latch). Latch hanya ada di RAM.

### Koneksi

* **Offline**: ECG, vital, dan event disimpan di LittleFS (maks. ~700 kB ≈ 10 menit) dengan penanda
  `buffered=true`, lalu dikirim ulang saat WiFi pulih. Antrean dibagi menjadi segmen 16 kB (`/ob/<n>.bin`).
  Cloud menyimpan data tersebut tetapi tidak memakainya untuk menggerakkan FSM.
* **Sinkron waktu**: stempel waktu diambil dari NTP. Paket yang dibuat sebelum jam tersinkron diberi penanda
  (bit2 header), lalu cloud memakai waktu terima paket. Cek `waktu_sinkron=1` pada perintah `s`.

Perintah Serial Monitor: `s` status, `p` on/off Serial Plotter EKG, `o` zoom out, `i` zoom in, `r` tombol reset dari
Serial, `c` hapus latch dan buffer (servis), `b` bunyi buzzer.

---

## 5. Serial Plotter

Ketik `p` di Serial Monitor, lalu buka *Tools → Serial Plotter*. Plotter menampilkan dua grafik terpisah:

| Label | Isi | Posisi |
|---|---|---|
| `EKG_mentah` | tegangan AD8232 sebelum filter digital, dikurangi titik tengah ADC 1,65 V lalu dibagi penguatan 1100 | atas, digeser +2,5 mV |
| `EKG_terfilter` | sinyal setelah DC blocker, FIR, notch, dan Kalman (sama dengan yang dikirim ke cloud) | bawah, sekitar 0 mV |
| `batas_atas`, `batas_bawah` | garis tetap 4,5 dan −1 mV supaya skala tidak melompat | – |

Serial Plotter Arduino IDE 2 hanya menampilkan 50 titik per layar. Bawaannya satu titik mewakili 20 sampel (80 ms),
jadi satu layar ±4 detik, mirip monitor rumah sakit. Tiap titik memakai sampel dengan simpangan terbesar di bloknya
supaya puncak QRS tidak hilang. `o` memperlebar sampai 50 sampel per titik (10 detik per layar), `i` mempersempit.

### Rantai pemrosesan EKG di perangkat
`ADC 250 Hz → mV (÷ ECG_GAIN 1100) → DC blocker 0,05 Hz → FIR band-pass 0,5–40 Hz fase linier (501 tap)
→ notch 50 Hz → Kalman adaptif (R naik saat bergerak) → Pan-Tompkins (HR) → int16 (1 mV = 500) → MQTT`

Setelah itu sinyal tidak difilter lagi: cloud, server, dan debug viewer menampilkan sampel yang dikirim alat apa
adanya. Debug viewer hanya mengatur skala tampilan (mm/mV) dan menaruh garis dasar di tengah layar.

FIR fase linier dipakai (sesuai "band-pass FIR" BAB 8.5.3) karena model CNN dilatih dengan data yang difilter
*zero-phase*. Pada pengujian dengan 84 rekaman asli pasien uji, filter IIR kausal hanya menghasilkan prediksi
yang sama dengan sinyal referensi pada 78 % kasus. Dengan FIR fase linier, angkanya naik menjadi 93 %.
Konsekuensinya ada tunda tambahan 1 s, dan tunda ini sudah dikoreksi pada stempel waktu paket.

---

## 6. Keterbatasan yang diketahui

* Kalibrasi `ECG_GAIN` dan `GSR_ADC_NO_SKIN`, kestabilan timer 250 Hz saat WiFi aktif, dan konsumsi daya perlu
  diuji di alat fisik.
* HR dari ECG pada VT (kompleks lebar multiform) cenderung terlalu rendah.
* SQI dan SpO2 PPG perlu dikalibrasi dengan sensor yang ditempel di dada (posisi rancangan), bukan di jari.
* Tanpa modem, tidak ada SMS darurat saat WiFi putus. Data tetap disimpan dan dikirim ulang begitu tersambung.
