# Firmware ESP32: Early Warning System Deteksi Serangan Jantung (Capstone C-251)

Firmware rompi CardioVest. Alat mengirim EKG, vital, dan event ke broker MQTT (EMQX); layanan cloud di Render
menilai sinyalnya, dan debug viewer `/debug` menampilkannya.

```
firmware/
├── cardiovest_c251/
│   ├── cardiovest_c251.ino    # firmware utama (satu berkas, buka di Arduino IDE)
│   ├── rahasia.contoh.h       # contoh pengaturan pribadi, ikut git
│   └── rahasia.h              # pengaturan pribadi: WiFi, broker, nomor SMS (TIDAK ikut git)
└── uji_komponen/              # sketch uji berdiri sendiri, satu komponen per sketch
    ├── 01_ad8232_ecg  02_max30102_ppg  03_mpu6050_jatuh  04_gsr_fz3294
    └── 05_gps_neo6m   06_sim7600_4g    07_buzzer_led_tombol  08_wifi_mqtt
```

## Pengaturan

Semua nilai pribadi hanya ada di `rahasia.h`; `.ino` tidak berisi sandi atau nomor telepon. Buat sekali dengan
menyalin `rahasia.contoh.h` menjadi `rahasia.h` di folder yang sama, lalu isi:

```c
#define WIFI_SSID "nama WiFi 2,4 GHz"
#define WIFI_PASS "sandi WiFi"

#define MQTT_HOST "xxxxxxxx.ala.asia-southeast1.emqxsl.com"
#define MQTT_USER "cardiovest"
#define MQTT_PASS "sandi broker"

#define SMS_NOMOR {"+62812xxxxxxx", "+62813xxxxxxx"}
```

Bila `rahasia.h` belum ada, Arduino IDE berhenti dengan galat `rahasia.h: No such file or directory`. Pengaturan
yang tidak rahasia (ID alat, mode WiFi/4G, pin, TLS) tetap di bagian atas `.ino`. `DEVICE_ID` harus sama dengan ID
di variabel `DEVICES` Render (bawaan `cv-001`).

---

## 1. Persiapan Arduino IDE

1. Pasang **Arduino IDE 2.x**.
2. *File → Preferences → Additional boards manager URLs*, isi:
   `https://espressif.github.io/arduino-esp32/package_esp32_index.json`
3. *Tools → Board → Boards Manager* → pasang **esp32 by Espressif Systems versi 3.x**. Firmware diuji
   kompilasi pada 3.0.7. Kode sudah menyediakan cabang untuk API core 2.x, tetapi cabang itu belum dikompilasi.
4. *Tools → Manage Libraries*, pasang:

| Library (nama di Library Manager) | Versi diuji | Dipakai oleh |
|---|---|---|
| **MQTT** by Joel Gaehwiler (256dpi) | 2.5.2 | komunikasi (QoS 1, Last Will, retained) |
| **TinyGSM** by Volodymyr Shymanskyy | 0.12.0 | SIM7600E-H |
| **GovoroxSSLClient** by V Govorovski | 1.3.2 | TLS lewat 4G (hanya bila `MQTT_USE_TLS 1` + `CONN_4G`) |
| **SparkFun MAX3010x Pulse and Proximity Sensor Library** | 1.1.2 | MAX30102 |
| **TinyGPSPlus** by Mikal Hart | 1.1.0 | Neo-6M |
| **ArduinoJson** by Benoit Blanchon | 7.2.1 | payload JSON |

   Library MPU6050 tidak diperlukan (register dibaca langsung). LittleFS, Preferences, WiFi, dan Wire sudah
   bawaan core ESP32.
5. Pengaturan board: **ESP32 Dev Module**, *Partition Scheme*: **Default 4MB with spiffs** (dipakai LittleFS
   untuk buffer offline), *Upload Speed* 921600, Serial Monitor **115200 baud**.

> Library **MQTT (256dpi)** dipilih alih-alih PubSubClient karena PubSubClient hanya bisa *publish* QoS 0,
> sedangkan rancangan BAB 8 mewajibkan QoS 1 untuk topik vital dan event.

---

## 2. Rangkaian (sesuai `#define PIN_*` di `.ino`)

| Komponen | Pin modul | Pin ESP32 | Catatan |
|---|---|---|---|
| AD8232 | OUTPUT / LO- / LO+ | GPIO34 / GPIO33 / GPIO32 | ADC1 (aman dipakai bersama WiFi) |
| MAX30102 | SDA / SCL | GPIO21 / GPIO22 | bus I²C bersama, alamat 0x57 |
| MPU6050 | SDA / SCL | GPIO21 / GPIO22 | alamat 0x68 (AD0 ke GND) |
| GSR FZ3294 | SIG | GPIO35 | ADC1, input-only |
| GPS Neo-6M | TX / RX | GPIO19 / GPIO18 | UART2 9600 baud |
| SIM7600E-H | TX / RX | GPIO16 / GPIO17 | UART1 115200; **catu 5 V ≥ 2 A terpisah**, GND bersama |
| Buzzer | + (via transistor) | GPIO27 | 2 kHz (Waspada) / 4 kHz (Darurat) |
| LED dua warna | A / B (via resistor) | GPIO26 / GPIO25 | |
| Tombol reset | satu kaki ke GND | GPIO4 | pull-up internal; tahan **3 s** |

Elektroda Lead I: RA di bawah klavikula kanan, LA di bawah klavikula kiri, RL di perut kanan bawah. Resistor
seri 1 MΩ per jalur elektroda (BAB 8.5.2).

---

## 3. Urutan pengujian yang disarankan

### Langkah 1: uji tiap komponen sendiri-sendiri (`uji_komponen/`)
Setiap sketch berdiri sendiri: tidak bergantung pada firmware utama maupun sensor lain, jadi komponen yang
bermasalah dapat diisolasi.

| Sketch | Yang diperiksa | Tampilan |
|---|---|---|
| `01_ad8232_ecg` | bentuk ECG, lead-off, HR | Serial Plotter (`ecg_uV`, `lead_off`), `h` untuk HR |
| `02_max30102_ppg` | deteksi sensor, kontak kulit, HR PPG | Serial Plotter + HR tiap detik |
| `03_mpu6050_jatuh` | |a|, deteksi jatuh 3 fase | jatuhkan modul ke bantal ±30 cm lalu diamkan 2 s |
| `04_gsr_fz3294` | konduktansi kulit, **kalibrasi** | lepas dari kulit lalu kirim `c` → catat nilai ke `GSR_ADC_NO_SKIN` |
| `05_gps_neo6m` | NMEA, fix, satelit, HDOP | di luar ruangan, cold start ≤ 60 s |
| `06_sim7600_4g` | AT, sinyal, registrasi, data, SMS | perintah `i g t s a` |
| `07_buzzer_led_tombol` | pola alarm, tombol 3 s, VBUS | perintah `0 1 2 3` |
| `08_wifi_mqtt` | jalur WiFi → broker tanpa sensor (broker lokal tanpa TLS) | vital tiruan muncul di `tools/monitor.py` |

### Langkah 2: firmware utama
1. Backend sudah berjalan di Render (lihat `deploy/README.md`).
2. Isi `rahasia.h` (bagian Pengaturan di atas).
3. Buka `firmware/cardiovest_c251/cardiovest_c251.ino`, upload, buka Serial Monitor 115200, lalu ketik `s`
   untuk status. Baris `MQTT: terhubung` berarti alat sudah masuk broker.
4. Buka `https://<vercel>/debug`. Jendela "Alat terputus" hilang sendiri begitu data alat masuk.

### Langkah 3: mode 4G (lapangan)
* `CONN_MODE CONN_4G`, isi `GSM_APN` sesuai operator.
* Broker EMQX sudah dapat diakses dari internet.
* TLS sudah aktif (`MQTT_USE_TLS 1`, port 8883), wajib untuk EMQX Serverless. `MQTT_TLS_INSECURE 1`
  berarti koneksi tetap terenkripsi tetapi sertifikat broker tidak diperiksa.
  * Mode 4G memakai library **GovoroxSSLClient** (Library Manager) di atas TinyGsmClient, karena TinyGSM
    0.12 belum punya TLS untuk SIM7600. Mode WiFi memakai `WiFiClientSecure` bawaan core.
  * Pilih **Tools → Partition Scheme → "No OTA (2MB APP/2MB SPIFFS)"** bila ruang flash tidak cukup.

---

## 4. Perilaku perangkat

| State (dari cloud) | LED | Buzzer | GPS |
|---|---|---|---|
| NORMAL | kedip singkat tiap 3 s (tiap 1 s bila offline) | mati | mati |
| WARNING | kedip 1 Hz | 2 kHz, 250 ms tiap 2 s | mati |
| CRITICAL | kedip 5 Hz | 4 kHz kontinu | **aktif**, koordinat dikirim di vital |
| Mengisi daya (VBUS) | menyala tetap | – | – |

* **Latch CRITICAL** disimpan di NVS. Setelah restart perangkat tetap CRITICAL, dan perintah cloud yang lebih
  rendah diabaikan. Jalan keluarnya **tombol reset ditahan 3 s** (mengirim event `hardware_reset` ke cloud) atau
  perintah `clear_latch` dari cloud setelah tombol **Hentikan alarm** di web ditekan (firmware v6 ke atas).
* **Offline**: ECG, vital, dan event disimpan di LittleFS (maks. ~700 kB ≈ 10 menit) dengan penanda
  `buffered=true`, lalu dikirim ulang saat koneksi pulih. Antrean dibagi menjadi segmen 16 kB (`/ob/<n>.bin`)
  sehingga setiap byte hanya ditulis sekali. Versi lama menyalin ulang seluruh sisa antrean setiap 10
  pesan, yang lambat dan mempercepat aus flash. Isi antrean lama (`/obuf.bin`) dimigrasikan otomatis. Cloud menyimpan data tersebut tetapi tidak
  memakainya untuk menggerakkan FSM.
* **SMS fallback**: bila CRITICAL dan offline lebih dari 30 s, SMS berisi jam dan tautan Google Maps dikirim ke
  `SMS_NOMOR` (di `rahasia.h`) melalui SIM7600. Ini juga berlaku di mode WiFi selama `MODEM_TERPASANG 1`.
* **Sinkron waktu.** Stempel waktu diambil dari NTP (WiFi) atau jam jaringan seluler (4G). Paket yang
  dibuat sebelum jam tersinkron diberi penanda (bit2 header), lalu cloud memakai waktu terima paket.
  Versi lama menganggap paket seperti ini "terlambat", sehingga FSM diam dan alarm tidak bisa menyala
  tanpa pesan galat apa pun. Cek `waktu_sinkron=1` pada perintah `s`.
* **Reset saat offline.** Tombol reset langsung membuat alat NORMAL. Event-nya disimpan di NVS
  (`reset_pend`) dan dikirim paling awal begitu tersambung lagi, sebelum alat berlangganan `cmd`.
  Selama event itu belum terkirim, perintah CRITICAL dari cloud (yang belum tahu ada reset) diabaikan.

Perintah Serial Monitor: `s` status, `p` on/off Serial Plotter ECG, `r` tombol reset dari Serial, `c` hapus
latch CRITICAL dan buffer (servis), `b` bunyi buzzer.

### Rantai pemrosesan ECG di perangkat
`ADC 250 Hz → mV (÷ ECG_GAIN 1100) → DC blocker 0,05 Hz → FIR band-pass 0,5–40 Hz fase linier (501 tap)
→ notch 50 Hz → Kalman adaptif (R naik saat bergerak) → Pan-Tompkins (HR) → int16 (1 mV = 500) → MQTT`

FIR fase linier dipakai (sesuai "band-pass FIR" BAB 8.5.3) karena model CNN dilatih dengan data yang difilter
*zero-phase*. Pada pengujian dengan 84 rekaman asli pasien uji, filter IIR kausal hanya menghasilkan prediksi
yang sama dengan sinyal referensi pada 78 % kasus. Dengan FIR fase linier, angkanya naik menjadi 93 %.
Konsekuensinya ada tunda tambahan 1 s, dan tunda ini sudah dikoreksi pada stempel waktu paket. Latensi deteksi
terburuk menjadi ±7,4 s, masih di bawah batas 10 s. Beban komputasinya sekitar 125 ribu MAC/s, kecil untuk ESP32
240 MHz.

---

## 5. Keterbatasan yang diketahui

* Belum diuji menyeluruh di ESP32 dan sensor fisik: kalibrasi `ECG_GAIN` dan `GSR_ADC_NO_SKIN`, kestabilan
  timer 250 Hz saat WiFi/4G aktif, dan konsumsi daya. Uji dengan `uji_komponen/` lalu firmware utama.
* HR dari ECG pada VT (kompleks lebar multiform) cenderung terlalu rendah. Pada mode validator terdegradasi
  (SQI PPG rendah), indikator HR bisa terlambat aktif.
* SQI PPG dihitung dari rasio amplitudo denyut terhadap residu antar-periode. Ambang `TAU_SQI` perlu
  dikalibrasi dengan sensor yang ditempel di dada (posisi rancangan), bukan di jari.
