# Deploy CardioVest: Oracle Cloud + Vercel

Setelah langkah sekali-jalan di bawah, alur kerja harian cukup:

```powershell
git add -A
git commit -m "pesan perubahan"
git push
```

Tidak ada Docker di laptop. Setiap `git push` ke branch `faza`:

| Bagian | Di mana | Kapan diperbarui |
|---|---|---|
| Tampilan web (`web/`) | Vercel | otomatis, ±1 menit setelah push |
| Broker MQTT, layanan cloud CNN + FSM, server API + realtime, simulator dataset | VM Oracle Cloud (gratis, menyala 24 jam) | otomatis, VM mengecek GitHub tiap menit lalu membangun ulang bagian yang berubah |

```
ESP32 / simulator ──MQTT 1883/8883──► Mosquitto ──► cloud (ONNX CNN + FSM) ──► SQLite
                                         │                                       │
                                         └──► server (API + Socket.IO + Web Push)◄┘
                                                      ▲ https://<ip>.sslip.io (Caddy, HTTPS otomatis)
                                                      │
   browser teman ──► https://<proyek>.vercel.app ─────┘  /api diteruskan, EKG realtime lewat WebSocket
```

---

## A. Sekali saja: siapkan VM Oracle Cloud

### 1. Buat VM

1. Daftar di <https://www.oracle.com/cloud/free/> (butuh kartu kredit untuk verifikasi, tidak ditagih
   selama memakai sumber daya *Always Free*). Pilih *home region* terdekat, misalnya Singapore.
2. Menu **Compute → Instances → Create instance**:
   - **Image**: Canonical Ubuntu 22.04 atau 24.04.
   - **Shape**: `VM.Standard.A1.Flex` (Ampere, 2 OCPU, 12 GB). Bila muncul *out of capacity*, pakai
     `VM.Standard.E2.1.Micro` (1 GB RAM). Keduanya *Always Free* dan cukup.
   - **SSH keys**: pilih *Generate a key pair for me*, lalu **unduh private key**.
3. Setelah status *Running*, catat **Public IP address**.

### 2. Buka port di jaringan Oracle

**Instance → Subnet → Security List (Default Security List) → Add Ingress Rules**, buat empat aturan:

| Source CIDR | IP Protocol | Destination Port |
|---|---|---|
| `0.0.0.0/0` | TCP | `80` |
| `0.0.0.0/0` | TCP | `443` |
| `0.0.0.0/0` | TCP | `1883` |
| `0.0.0.0/0` | TCP | `8883` |

Firewall di dalam VM dibuka otomatis oleh skrip setup.

### 3. Masuk ke VM dan jalankan setup

Dari PowerShell di laptop (ganti path kunci dan IP):

```powershell
ssh -i "$HOME\Downloads\ssh-key.key" ubuntu@IP_PUBLIK
```

Bila muncul *UNPROTECTED PRIVATE KEY FILE*, jalankan sekali:
`icacls "$HOME\Downloads\ssh-key.key" /inheritance:r /grant:r "$($env:USERNAME):R"`.

Di dalam VM:

```sh
sudo git clone -b faza https://github.com/ArgyaSabih/CardioVest.git /opt/cardiovest
sudo sh /opt/cardiovest/deploy/setup.sh
```

Skrip ini memasang swap, Docker, membuka firewall, membuat `deploy/.env` berisi kata sandi acak,
membuat akun MQTT, membangun semua layanan, lalu memasang pengecek GitHub tiap menit. Build pertama
butuh 5–10 menit. Di akhir, catat yang dicetak:

```
Kode pairing alat: cv-001:123456
Backend      : https://140-238-1-2.sslip.io
Akun MQTT    : cv-001 / xxxxxxxxxxxxxxxxxxxx
Vercel       : NEXT_PUBLIC_BACKEND_URL=https://140-238-1-2.sslip.io
               PROXY_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

Semua nilai itu bisa dilihat lagi kapan saja dengan `cv info`.
Alamat `*.sslip.io` adalah domain gratis yang otomatis menunjuk ke IP VM, sehingga HTTPS langsung jalan
tanpa membeli domain.

## B. Sekali saja: hubungkan Vercel

1. <https://vercel.com/new> → masuk dengan GitHub → **Import** repositori `ArgyaSabih/CardioVest`.
   Bila tidak muncul di daftar, tempel URL repositorinya (repositori publik bisa diimpor siapa saja).
2. **Root Directory**: `web`. Framework terdeteksi Next.js.
3. **Environment Variables**:

   | Nama | Nilai |
   |---|---|
   | `NEXT_PUBLIC_BACKEND_URL` | `https://<ip>.sslip.io` dari `cv info` |
   | `PROXY_SECRET` | dari `cv info` |

4. **Deploy**. Setelah selesai buka **Settings → Git → Production Branch**, isi `faza`, simpan.
   Mulai sekarang setiap push ke `faza` langsung memperbarui alamat utama
   `https://<proyek>.vercel.app`.
5. Beri tahu server alamat Vercel-nya (dipakai di tautan email, undangan kontak, dan notifikasi). Di VM:

   ```sh
   cv set PUBLIC_URL https://<proyek>.vercel.app
   ```

6. Cek: buka `https://<proyek>.vercel.app/api/health`. Jawaban yang benar:
   `{"ok":true,"mqtt":true,"cloud_db":true}`.

`NEXT_PUBLIC_BACKEND_URL` dibaca saat build. Bila nilainya diganti, lakukan **Redeploy** di Vercel.

## C. Sekali saja: arahkan ESP32 ke server

Di `firmware/cardiovest_c251/cardiovest_c251.ino`:

```c
#define MQTT_HOST "140-238-1-2.sslip.io"
#define MQTT_USE_TLS 0
#define MQTT_USER "cv-001"
#define MQTT_PASS "<Akun MQTT dari cv info>"
```

`MQTT_USE_TLS 1` (port 8883) juga sudah siap: sertifikat Let's Encrypt dipasang otomatis ke broker
beberapa menit setelah setup, dan rantainya berakar di ISRG Root X1.

Simulator dan ESP32 memakai ID yang sama (`cv-001`), jadi hanya satu yang boleh mengirim data. Pilih
sumbernya dengan `cv sumber hardware` (ESP32) atau `cv sumber dataset` (simulator), atau lewat
`POST /api/source` dari aplikasi. Pilihan ini tersimpan di broker dan tetap berlaku walau server
dibangun ulang.

## D. Sekali saja: siapkan git di laptop

Di PowerShell, dari folder proyek (`C:\Users\azfaz\Documents\Website\capstone-c03`):

```powershell
git config --global user.name "Nama Anda"
git config --global user.email "email-akun-github@contoh.com"
git init -b faza
git remote add origin https://github.com/ArgyaSabih/CardioVest.git
git fetch origin inge
git reset origin/inge
git status
git add -A
git commit -m "refactor: deploy tanpa docker lokal (Vercel + Oracle Cloud)"
git push -u origin faza
```

`git reset origin/inge` menjadikan branch `inge` sebagai titik awal tanpa mengubah file di folder,
sehingga `git status` hanya menampilkan perubahan dari restrukturisasi ini.

---

## Perintah di VM (`cv`)

| Perintah | Fungsi |
|---|---|
| `cv info` | alamat backend, akun MQTT, nilai untuk Vercel, status layanan |
| `cv logs` / `cv logs cloud` | log langsung semua layanan / satu layanan (`cloud`, `server`, `simulator`, `mosquitto`, `caddy`) |
| `cv update` | tarik commit terbaru dan bangun ulang sekarang, tanpa menunggu 1 menit |
| `cv restart server` | nyalakan ulang satu layanan |
| `cv set NAMA nilai` | ubah `deploy/.env` (mis. `TAU_CONF`, `SMTP_URL`, `CALIB_SECONDS`) lalu terapkan |
| `cv sumber hardware` / `cv sumber dataset` | pilih sumber EKG |
| `cv skenario serangan` | ganti skenario simulator (daftar di README utama bagian 3) |
| `cv reset` | tekan tombol reset simulator |
| `cv uji` / `cv uji serangan` | uji otomatis skenario |
| `cv ekspor` | ekspor database ke CSV di `/srv/cardiovest/cloud/export` |
| `cv alat daftar` / `cv alat tambah cv-002` / `cv alat kode-baru cv-001` / `cv alat lepas cv-001` | kelola alat dan kode pairing |

Riwayat build otomatis: `journalctl -u cardiovest-update -f`.

Data (akun, riwayat, database cloud, sertifikat) tersimpan di `/srv/cardiovest` dan tidak tersentuh
saat kode diperbarui. `RETENSI_HARI=30` menghapus EKG mentah yang lebih tua dari 30 hari supaya disk
tidak penuh; kejadian dan EKG di sekitarnya tetap disimpan.

## Pemecahan masalah

| Gejala | Solusi |
|---|---|
| `https://<ip>.sslip.io` tidak bisa dibuka | Port 80/443 belum dibuka di Security List Oracle (langkah A.2). Setelah dibuka: `cv restart caddy`. |
| Vercel `/api/health` menjawab 503 `NEXT_PUBLIC_BACKEND_URL belum diisi` | Isi variabel di Vercel lalu Redeploy. |
| Login di Vercel gagal terus "Terlalu banyak percobaan" | `PROXY_SECRET` di Vercel tidak sama dengan `cv info`. Samakan lalu Redeploy. |
| Grafik EKG tidak bergerak, status "Tidak terpantau" | `cv logs simulator`; pastikan sumber `dataset`, atau ESP32 menyala bila sumber `hardware`. |
| ESP32 tidak tersambung | Port 1883 belum dibuka (A.2), atau `MQTT_USER`/`MQTT_PASS` tidak sama dengan `cv info`. Lihat `cv logs mosquitto`. |
| Push terakhir belum tampil di VM | `journalctl -u cardiovest-update -n 50` untuk melihat error build, atau `cv update`. |
| VM kehabisan memori saat build (shape 1 GB) | Swap 2 GB sudah dibuat setup; jalankan `cv update` sekali lagi. |
