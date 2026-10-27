# Broker untuk uji lapangan (alat lewat 4G)

Broker di `mosquitto/mosquitto.conf` sengaja dibuat terbuka (anonim, tanpa TLS) supaya mudah dipakai di
laptop. Begitu alat tersambung lewat internet, siapa pun yang tahu IP server bisa membaca ECG pemakai
dan mengirim alarm palsu. Folder ini berisi versi tertutupnya.

| | Pengembangan | Produksi |
|---|---|---|
| Login | anonim | akun per perangkat + akun `cloud` + akun `web` |
| Port dari internet | 1883, 9001 | 8883 (MQTT TLS), 9443 (WebSocket TLS) |
| Hak akses | semua | perangkat hanya topiknya sendiri, `web` membaca semua dan hanya menulis `device/+/remote` (reset alarm) |

Isi ACL (`acl`): perangkat `cv-001` hanya bisa mengirim `ecg`, `vital`, `event`, dan `lwt` miliknya
sendiri, serta membaca `cmd` dan `state` miliknya. Alat yang dibobol tidak bisa mengirim data atas nama
alat lain, dan tidak bisa memalsukan `state`/`alert` yang dibaca keluarga.

## Langkah di server (sekali)

Server Linux dengan Docker Compose ≥ 2.24 dan port 8883/9443 terbuka.

```sh
# 1. akun: cloud, web, dan satu per alat. Kata sandi hanya ditampilkan sekali.
sh mosquitto/produksi/buat_akun.sh cv-001

# 2. sertifikat (pilih salah satu)
#    a) domain + Let's Encrypt: salin fullchain.pem -> certs/server.crt dan privkey.pem -> certs/server.key
#    b) CA sendiri (untuk IP publik atau domain tanpa Let's Encrypt):
sh mosquitto/produksi/buat_sertifikat.sh broker.contoh.id      # atau IP publik

# 3. isi .env
#    MQTT_PASS_CLOUD=...   (dari langkah 1)
#    MQTT_PASS_WEB=...     (dari langkah 1, untuk aplikasi)
#    WEB_DOMAIN=cardiovest.contoh.id   (domain aplikasi, untuk HTTPS lewat Caddy)

# 4. jalankan
docker compose -f docker-compose.yml -f docker-compose.produksi.yml up -d --build
```

Layanan cloud tersambung ke broker lewat jaringan internal docker (port 1883, tidak dibuka ke
internet), tetapi tetap memakai akun `cloud`.

## Di firmware (`config.h` + `ca_cert.h`)

```c
#define CONN_MODE    CONN_4G
#define MQTT_HOST    "broker.contoh.id"     // harus sama dengan nama di sertifikat
#define MQTT_USE_TLS 1                      // port otomatis 8883
#define MQTT_USER    "cv-001"               // = DEVICE_ID
#define MQTT_PASS    "<dari buat_akun.sh>"
```

- Let's Encrypt: `ca_cert.h` sudah berisi ISRG Root X1, tidak perlu diubah.
- CA sendiri: ganti isi `ca_cert.h` dengan isi `mosquitto/produksi/ca/ca.crt`.

Mode 4G + TLS butuh library **GovoroxSSLClient** (Library Manager) dan skema partisi
**"No OTA (2MB APP/2MB SPIFFS)"** di Arduino IDE (Tools → Partition Scheme), karena mbedTLS
menambah ukuran program. Di PlatformIO cukup `pio run -e 4g-tls`.

## Alat bantu dari laptop

Monitor, uji skenario, dan klien Python lain membaca variabel lingkungan berikut:

```sh
MQTT_HOST=broker.contoh.id MQTT_PORT=8883 MQTT_TLS=1 MQTT_CA=mosquitto/produksi/ca/ca.crt \
MQTT_USER=web MQTT_PASS=... python tools/monitor.py
```

Debug viewer: `http://localhost:8251/?ws=wss://broker.contoh.id:9443&user=web&pass=...`
(akun `web` hanya bisa membaca). Kalau memakai CA sendiri, browser harus memercayai `ca.crt` dulu.

## Yang sudah diuji

Konfigurasi ini sudah dijalankan di Mosquitto 2.0.20 dengan sertifikat dari `buat_sertifikat.sh`:
login anonim dan kata sandi salah ditolak, klien yang tidak memercayai CA ditolak, `cv-001` tidak bisa
menulis ke `device/cv-002/*` ataupun ke `state`/`alert`/`cmd` miliknya sendiri, `cv-001` tidak menerima
`cmd` milik `cv-002`, dan akun `web` bisa membaca lewat `wss://` tetapi hanya boleh menulis `device/+/remote`.

## Jangan lupa

- `passwd`, `certs/`, `ca/` sudah ada di `.gitignore`. Jangan dikirim lewat chat atau grup.
- `ca/ca.key` cukup disimpan di laptop salah satu anggota tim, tidak perlu ada di server.
- Bila alat hilang, jalankan ulang `buat_akun.sh` (semua kata sandi berganti), perbarui `.env`, lalu
  flash ulang alat yang masih dipakai.
