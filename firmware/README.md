# Firmware ESP32: Early Warning System Deteksi Serangan Jantung (Capstone C-251)

Firmware untuk perangkat wearable yang **menggantikan simulator** pada pipeline `CardioVest/`. Perangkat mengirim
data ke Mosquitto dengan topik, QoS, dan format payload yang sama persis dengan simulator. Layanan cloud
(CNN 1D + decision engine) dan debug viewer bisa langsung dipakai tanpa perubahan apa pun.

```
firmware/
├── cardiovest_c251/           # VERSI SATU BERKAS (Arduino IDE): isi placeholder ISI_* di bagian atas, lalu upload
├── cardiovest_esp32/          # FIRMWARE MODULAR (buka cardiovest_esp32.ino di Arduino IDE)
│   ├── config.h               #   <- satu-satunya berkas yang perlu diubah (WiFi/4G, broker, pin, modul aktif)
│   ├── app.cpp                #   setup() & loop(), perintah Serial Monitor
│   ├── ecg.*                  #   AD8232 250 Hz (timer), DC blocker + FIR band-pass + notch + Kalman, Pan-Tompkins
│   ├── sensors.*  algo.*      #   MPU6050 + deteksi jatuh 3 fase, MAX30102 HR + SQI, GSR
│   ├── gps.*                  #   Neo-6M, hanya aktif saat CRITICAL
│   ├── comm.*                 #   WiFi / 4G SIM7600, MQTT, sinkron waktu, SMS fallback
│   ├── offline_buffer.*       #   ring-buffer LittleFS saat tautan data putus
│   ├── state.*  alert.*       #   latch CRITICAL (NVS), buzzer/LED, tombol reset 3 s, kunci VBUS
│   ├── dsp.*  ecg_codec.*  payload.*   # filter, codec ECG biner/JSON, JSON vital/event
│   └── shared.*               #   tipe data & variabel lintas-task
├── uji_komponen/              # 8 SKETCH UJI BERDIRI SENDIRI (satu komponen per sketch)
│   ├── 01_ad8232_ecg  02_max30102_ppg  03_mpu6050_jatuh  04_gsr_fz3294
│   └── 05_gps_neo6m   06_sim7600_4g    07_buzzer_led_tombol  08_wifi_mqtt
└── tests_host/                # uji algoritma firmware di PC (g++), tanpa ESP32
```

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

## 2. Rangkaian (Tabel pemetaan pin BAB 8.5)

| Komponen | Pin modul | Pin ESP32 | Catatan |
|---|---|---|---|
| AD8232 | OUTPUT / LO- / LO+ | GPIO34 / GPIO32 / GPIO33 | ADC1 (aman dipakai bersama WiFi) |
| MAX30102 | SDA / SCL | GPIO21 / GPIO22 | bus I²C bersama, alamat 0x57 |
| MPU6050 | SDA / SCL | GPIO21 / GPIO22 | alamat 0x68 (AD0 ke GND) |
| GSR FZ3294 | SIG | GPIO35 | ADC1, input-only |
| GPS Neo-6M | TX / RX | GPIO16 / GPIO17 | UART2 9600 baud |
| SIM7600E-H | TX / RX | GPIO26 / GPIO27 | UART1 115200; **catu 5 V ≥ 2 A terpisah**, GND bersama |
| Buzzer | + (via transistor) | GPIO25 | PWM 2 kHz (Warning) / 4 kHz (Critical) |
| LED | anoda (via resistor) | GPIO2 | LED onboard juga dapat dipakai |
| Tombol reset | satu kaki ke GND | GPIO4 | pull-up internal; tahan **3 s** |
| Sensor VBUS | pembagi tegangan | GPIO39 | > 1,5 V dianggap sedang mengisi, akuisisi dikunci |

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
| `08_wifi_mqtt` | jalur WiFi → broker → cloud tanpa sensor | vital tiruan muncul di viewer `localhost:8251` |

### Langkah 2: firmware utama
1. Jalankan pipeline di laptop: `docker compose up -d` di folder `CardioVest` (lihat README utama).
2. **Hentikan simulator** agar tidak bentrok dengan perangkat asli yang memakai ID yang sama:
   `docker compose stop simulator`.
3. Buka `firmware/cardiovest_esp32/cardiovest_esp32.ino`, lalu ubah `config.h`:
   * `CONN_MODE CONN_WIFI`, `WIFI_SSID`, `WIFI_PASS`
   * `MQTT_HOST` = IP laptop di jaringan yang sama (PowerShell: `ipconfig` → IPv4 Address). Izinkan port
     1883 di Windows Firewall bila diminta.
   * `DEVICE_ID` harus sama dengan `.env` (default `cv-001`)
   * modul yang belum terpasang boleh dibiarkan aktif (dilewati otomatis bila tidak terdeteksi) atau
     dimatikan dengan `ENABLE_... 0`
4. Upload, buka Serial Monitor 115200, lalu ketik `s` untuk status.
5. Buka debug viewer `http://localhost:8251`. ECG, vital, dan keputusan CNN dari perangkat asli akan tampil.

### Langkah 3: mode 4G (lapangan)
* `CONN_MODE CONN_4G`, isi `GSM_APN` sesuai operator.
* Broker harus dapat diakses dari internet, misalnya Mosquitto di VPS (sesuai rancangan BAB 5.6) atau
  port-forward router ke laptop. Isi `MQTT_HOST` dengan IP publik atau domain.
* **Pakai TLS + akun begitu lewat internet.** Ikuti `mosquitto/produksi/README.md` (akun per alat, ACL,
  sertifikat), lalu isi `MQTT_USE_TLS 1`, `MQTT_USER` (= `DEVICE_ID`), dan `MQTT_PASS`. Port otomatis 8883.
  * Mode 4G memakai library **GovoroxSSLClient** (Library Manager) di atas TinyGsmClient, karena TinyGSM
    0.12 belum punya TLS untuk SIM7600. Mode WiFi memakai `WiFiClientSecure` bawaan core.
  * Sertifikat broker diverifikasi dengan `ca_cert.h` (default ISRG Root X1 untuk Let's Encrypt). Versi
    lama memakai `setInsecure()`, yang tetap terenkripsi tetapi bisa disadap siapa pun yang berada di
    tengah jalur. `MQTT_TLS_INSECURE 1` masih tersedia untuk mencoba, tetapi jangan dipakai di lapangan.
  * Pilih **Tools → Partition Scheme → "No OTA (2MB APP/2MB SPIFFS)"**. Dengan TLS, mode WiFi memakai 99 %
    partisi default, terlalu mepet untuk perubahan berikutnya.

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
  `SMS_NUMBERS` melalui SIM7600. Ini juga berlaku di mode WiFi selama `MODEM_PRESENT 1`.
* **Sinkron waktu.** Stempel waktu diambil dari NTP (WiFi) atau jam jaringan seluler (4G). Paket yang
  dibuat sebelum jam tersinkron diberi penanda (bit2 header), lalu cloud memakai waktu terima paket.
  Versi lama menganggap paket seperti ini "terlambat", sehingga FSM diam dan alarm tidak bisa menyala
  tanpa pesan galat apa pun. Cek `waktu_sinkron=1` pada perintah `s`.
* **Reset saat offline.** Tombol reset langsung membuat alat NORMAL. Event-nya disimpan di NVS
  (`reset_pend`) dan dikirim paling awal begitu tersambung lagi, sebelum alat berlangganan `cmd`.
  Selama event itu belum terkirim, perintah CRITICAL dari cloud (yang belum tahu ada reset) diabaikan.

Perintah Serial Monitor: `s` status, `p` on/off Serial Plotter ECG, `r` simulasi tombol reset, `c` hapus
latch CRITICAL dan buffer (servis).

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

## 5. Hasil verifikasi (tanpa perangkat keras)

| Uji | Hasil |
|---|---|
| Kompilasi `arduino-cli`, core esp32 3.0.7, ESP32 Dev Module (versi awal) | firmware utama (WiFi): flash 80 %, RAM 21 %; mode 4G, JSON+TLS, "hanya ECG", dan "tanpa ECG" juga lolos; 8 sketch uji lolos |
| Kompilasi PlatformIO (`platformio.ini`) setelah perbaikan | WiFi 91,5 % flash; 4G 43,5 %; 4G+TLS 35 % (partisi no OTA); WiFi+TLS 99 % partisi default, sehingga dipindah ke no OTA |
| `tests_host/test_firmware_algos.py` (algoritma C++ firmware dikompilasi g++) | **34/34 lulus** |
| · flag paket (buffered, lead-off, jam belum sinkron) biner & JSON → decoder cloud | identik untuk semua kombinasi |
| · buffer offline bersegmen (LittleFS distub ke folder) | FIFO 300 pesan lintas 17 segmen, reboot di tengah, pengirim gagal, penuh, migrasi berkas lama |
| · koefisien FIR vs `scipy.signal.firwin` | galat maks 4,5 × 10⁻⁸ |
| · redaman 50 Hz / baseline 0,05 Hz, penguatan 10 Hz | 0,001 / 0,08 / 0,99 |
| · HR Pan-Tompkins, ECG sintetis 60–180 bpm | galat ≤ 2,5 % |
| · HR Pan-Tompkins, rekaman asli selain VT | 46/48 galat < 12 % |
| · codec ECG biner/JSON firmware → decoder cloud | identik, 1,04 byte/sampel |
| · JSON vital/event firmware → penyimpanan & validator cloud | diterima tanpa perubahan |
| · deteksi jatuh firmware vs simulator | sama (jatuh 1×, berjalan/diam 0×) |
| · PPG: HR ±1 bpm, SQI bersih 0,73–0,88, derau gerak 0,31, tanpa kontak 0 | sesuai ambang τ_SQI 0,5 |
| `tests_host/test_firmware_model.py` (ECG melewati firmware lalu CNN) | prediksi sama dengan referensi pada 78/84 rekaman (92,9 %) |

**Belum diuji:** perilaku pada ESP32 dan sensor fisik, yaitu kalibrasi `ECG_GAIN` dan `GSR_ADC_NO_SKIN`,
kestabilan timer 250 Hz saat WiFi/4G aktif, konsumsi daya, serta TLS di ESP32 (konfigurasi broker
TLS + ACL sudah diuji dari sisi klien Python, lihat `mosquitto/produksi/README.md`). Uji ini perlu dilakukan dengan
`uji_komponen/` lalu firmware utama.

**Keterbatasan yang diketahui:**
* HR dari ECG pada VT MIT-BIH (kompleks lebar multiform) cenderung terlalu rendah, dengan hanya 4/8 rekaman
  bergalat < 12 %. Pada mode validator terdegradasi (SQI PPG rendah), indikator HR bisa terlambat aktif.
* SQI PPG dihitung dari rasio amplitudo denyut terhadap residu antar-periode. Ambang `TAU_SQI` perlu
  dikalibrasi dengan sensor yang ditempel di dada (posisi rancangan), bukan di jari.

Menjalankan uji di PC (butuh g++ dan library ArduinoJson di `~/Arduino/libraries`):
```bash
python firmware/tests_host/test_firmware_algos.py
python firmware/tests_host/test_firmware_model.py   # butuh TensorFlow + model cloud
```
