# Firmware ESP32: Early Warning System Deteksi Serangan Jantung (Capstone C-251)

Firmware rompi CardioVest. Alat mengirim EKG, vital, dan event ke broker MQTT (EMQX) lewat **WiFi sebagai jalur utama**
dan **GPRS SIM800L sebagai jalur cadangan**. Layanan cloud di Render menilai sinyalnya, dan debug viewer `/debug`
menampilkannya. Saat status CRITICAL, alat juga mengirim SMS berisi lokasi GPS ke kontak darurat.

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

#define GSM_ENABLE 1
#define GSM_APN "internet"
#define SMS_NUMBER "+62895364693939"

#define GPS_ENABLE 1
#define GPS_FALLBACK_LAT -7.765501
#define GPS_FALLBACK_LON 110.372210
```

`DEVICE_ID` harus sama dengan ID di variabel `DEVICES` Render (bawaan `cv-001`). APN `internet` dipakai untuk kartu
Telkomsel. `GPS_FALLBACK_*` hanya dipakai bila GPS belum pernah mendapat fix sama sekali.

| Parameter | Nilai | Arti |
|---|---|---|
| `WIFI_FAILOVER_S` | 15 | WiFi putus selama ini, alat pindah ke GPRS |
| `WIFI_RETURN_STABLE_S` | 10 | WiFi harus stabil selama ini sebelum alat kembali dari GPRS |
| `SMS_WAIT_GPS_S` | 45 | SMS darurat menunggu fix GPS paling lama selama ini |
| `SMS_AFTER_OFFLINE_S` | 30 | bila MQTT terputus selama ini saat CRITICAL, SMS langsung dikirim tanpa menunggu GPS |
| `SMS_RETRY_S`, `SMS_MAX_TRY` | 60, 3 | jeda dan jumlah percobaan ulang SMS |
| `GPS_PRIME_MS` | 300000 | GPS dibiarkan menyala setelah alat dinyalakan sampai fix pertama (maks. 5 menit) |

---

## 1. Persiapan Arduino IDE

1. Pasang **Arduino IDE 2.x**.
2. *File → Preferences → Additional boards manager URLs*, isi:
   `https://espressif.github.io/arduino-esp32/package_esp32_index.json`
3. *Tools → Board → Boards Manager* → pasang **esp32 by Espressif Systems versi 3.x**. Firmware diuji
   kompilasi pada 3.0.7.
4. *Tools → Manage Libraries*, pasang **MQTT** by Joel Gaehwiler (256dpi), versi 2.5.2. Library lain (WiFi,
   NetworkClientSecure, PPP, Wire, Preferences, LittleFS, HardwareSerial) sudah bawaan core ESP32 3.x. MAX30102,
   MPU6050, dan GPS dibaca langsung tanpa library sensor.
5. Pengaturan board: **ESP32 Dev Module**, *Partition Scheme*: **Default 4MB with spiffs** (dipakai LittleFS
   untuk buffer offline), *Upload Speed* 921600, Serial Monitor **115200 baud**. Program memakai ±93 % ruang
   aplikasi partisi bawaan. Bila nanti ruang kurang, pilih **No OTA (2MB APP/2MB SPIFFS)**.

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
| SIM800L (board biru 5 V) | TXD / RXD | GPIO16 / GPIO17 | UART1 (library PPP). Pin VDD board (bila ada) ke 3V3 sebagai acuan logika |
| GPS Neo-6M | TX / RX | GPIO19 / GPIO18 | UART2, 9600 baud |
| Buzzer | + (via transistor) | GPIO27 | 2 kHz (Waspada) / 4 kHz (Darurat) |
| LED dua warna | A / B (via resistor) | GPIO26 / GPIO25 | |
| Tombol reset | satu kaki ke GND | GPIO4 | pull-up internal; tahan **3 s** |

Pin RST SIM800L tidak wajib. Bila board punya pin RST, sambungkan ke GPIO23 lalu isi `PIN_GSM_RST 23`.

### Catu daya

```
Baterai Li-ion 9 V ──┬── XL4015 #1 (5,0 V) ──┬── ESP32 pin 5V
                     │                       ├── SIM800L 5V ─┐
                     │                       └── GPS VIN ────┴── kapasitor 1 mF ke GND
                     └── XL4015 #2 (3,3 V) ──── AD8232, MAX30102, MPU6050, GSR
```

Semua GND disatukan. Baterai dilepas dari rompi untuk diisi ulang memakai pengisi bawaannya, sehingga alat tidak
pernah terhubung ke jala-jala saat dipakai. XL4015 membutuhkan masukan di atas ±8 V; bila tegangan baterai turun di
bawahnya, rel 5 V dan 3,3 V ikut turun dan alat perlu diisi ulang.

Elektroda Lead I: RA di bawah klavikula kanan, LA di bawah klavikula kiri, RL di perut kanan bawah, memakai elektroda
gel Ag/AgCl sekali pakai dengan kancing jepret.

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
| NORMAL | kedip singkat tiap 3 s lewat WiFi, kedip ganda tiap 3 s lewat GSM, kedip tiap 1 s bila offline | mati |
| WARNING | kedip 1 Hz | 2 kHz, 250 ms tiap 2 s |
| CRITICAL | kedip 5 Hz | 4 kHz kontinu |

### Sensor per mode

| Sensor | Demo, NORMAL | Demo, WARNING | Demo, CRITICAL | Test |
|---|---|---|---|---|
| EKG AD8232 | menyala | menyala | menyala | menyala |
| IMU MPU6050 | menyala | menyala | menyala | menyala |
| PPG MAX30102 (HR, SpO2) | *shutdown* | menyala | menyala | menyala |
| GSR | hanya saat kalibrasi | menyala | menyala | menyala |
| GPS Neo-6M | tidur (kecuali 5 menit pertama) | tidur | menyala, lokasi dikirim | menyala, lokasi dikirim |

* **PPG** dimatikan lewat bit *shutdown* MAX30102 (register 0x09). Setelah menyala, HR dan SpO2 butuh sekitar
  5 detik sampai stabil. IR di bawah 50.000 dianggap tidak menempel.
* **SpO2** dihitung dari rasio AC/DC LED merah terhadap IR (R), lalu SpO2 = 110 − 25·R. Nilai ini hanya informasi di
  aplikasi dan bukan syarat CRITICAL.
* **GSR** dibaca hanya saat dibutuhkan. Kalibrasi baseline dipicu cloud dengan `{"cmd":"gsr_calibrate","seconds":35}`.
* **GPS** ditidurkan dengan perintah UBX RXM-PMREQ (mode *backup* u-blox) dan dibangunkan dengan mengirim byte ke pin
  RX modul. Setelah alat menyala, GPS dibiarkan bangun sampai fix pertama (maks. 5 menit) supaya data satelit tersimpan
  dan fix berikutnya lebih cepat. Bila saat CRITICAL belum ada fix, alat mengirim posisi terakhir yang tersimpan di NVS
  (`source: "terakhir"`) atau koordinat cadangan (`source: "statis"`). Begitu fix didapat, `source` berubah menjadi
  `"gps"` dan cloud mengirim pembaruan lokasi ke kontak darurat.
* **IMU** selalu menyala karena dipakai untuk τ adaptif gerak, Kalman adaptif, dan deteksi jatuh.

### Reset dan latch CRITICAL

* **Latch CRITICAL disimpan di NVS.** Status CRITICAL tetap aktif walaupun alat dimatikan, kehabisan baterai, atau
  tombol EN/RST ditekan. Saat menyala lagi, alat langsung CRITICAL dan cloud menyesuaikan.
* **Tombol GPIO4 ditahan 3 s** adalah satu-satunya cara melepas CRITICAL. Event `hardware_reset` dengan
  `reason: tombol` dikirim ke cloud.
* **Reset dari aplikasi web ditolak.** Perintah `clear_latch` dari cloud hanya dijalankan di mode Test.
* **Tombol EN/RST** saat NORMAL atau WARNING menyalakan ulang alat dalam status NORMAL dan mengirim `hardware_reset`
  dengan `reason: boot`.

### Koneksi

* **WiFi utama, GPRS cadangan.** Modem SIM800L dinyalakan saat boot dan tetap siaga (terdaftar di jaringan, tanpa
  sesi data). Bila WiFi putus lebih dari 15 detik, modem masuk mode data (PPP), MQTT tersambung ulang lewat GPRS, dan
  EKG dikirim dalam format biner *delta-encoded* (±263 B/s) agar muat di GPRS. Begitu WiFi kembali stabil 10 detik,
  sesi GPRS dihentikan dan MQTT kembali lewat WiFi. Jalur aktif dikirim di field `net` (`wifi`/`gsm`/`none`) dan
  tampil di debug viewer.
* **SMS darurat.** Satu SMS per kejadian CRITICAL dikirim ke `SMS_NUMBER` setelah GPS mendapat fix (maks. 45 detik
  menunggu), berisi waktu WIB dan tautan Google Maps. Bila koneksi data putus lebih dari 30 detik saat CRITICAL, SMS
  langsung dikirim. Penanda "SMS sudah terkirim" disimpan di NVS sehingga SMS tidak dikirim ulang setelah alat menyala
  ulang.
* **Offline**: ECG (biner), vital, dan event disimpan di LittleFS (maks. ~700 kB) dengan penanda `buffered=true`, lalu
  dikirim ulang saat koneksi pulih. Cloud menyimpan data tersebut tetapi tidak memakainya untuk menggerakkan FSM.
* **Sinkron waktu**: stempel waktu diambil dari NTP (lewat WiFi maupun GPRS).

Perintah Serial Monitor: `s` status (termasuk jalur jaringan, CSQ GSM, GPS), `p` on/off Serial Plotter EKG, `o` zoom
out, `i` zoom in, `r` tombol reset dari Serial, `c` hapus latch dan buffer (servis), `b` bunyi buzzer.

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

* SIM800L hanya mendukung jaringan 2G (GSM/GPRS). Jaringan 2G Telkomsel masih beroperasi, tetapi penghentiannya
  sedang dikaji operator. Bila 2G dimatikan, modul perlu diganti modul 4G (mis. SIM7600) dengan pin dan library yang sama.
* Pada GPRS, jabat tangan TLS butuh beberapa detik, sehingga perpindahan WiFi → GPRS memakan ±20–40 detik.
* Saat SMS dikirim ketika jalur aktif GPRS, sesi data berhenti sebentar (modem pindah ke mode perintah).
* Kalibrasi `ECG_GAIN` dan `GSR_ADC_NO_SKIN`, kestabilan timer 250 Hz saat WiFi aktif, dan konsumsi daya perlu
  diverifikasi di alat fisik.
* HR dari ECG pada VT (kompleks lebar multiform) cenderung terlalu rendah.
* SpO2 dari PPG di dada belum dikalibrasi klinis dan hanya ditampilkan sebagai informasi.
