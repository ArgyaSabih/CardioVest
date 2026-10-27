# Aplikasi CardioVest (Next.js)

Aplikasi yang dibuka di ponsel oleh **User Utama** (pemakai rompi) dan **Kontak Darurat**. Sesuai
Bab 7–8 laporan: daftar akun, pairing alat, dashboard real-time, kontak darurat, riwayat, dan halaman
notifikasi Critical (Halaman 1–6).

Folder ini bagian dari proyek CardioVest dan dijalankan bersama software alat (Mosquitto + layanan
cloud) dari `docker-compose.yml` di folder utama.

```
rompi ──MQTT──> Mosquitto ──> layanan cloud (CNN + FSM) ──> cardiovest.db
                    │                                            │ baca saja
                    └── akun "web" (baca saja) ──> server.mjs ◄──┘
                                                     │  Next.js: halaman + /api (Route Handlers)
                                                     │  Socket.IO /data/realtime
                                                     ├──> aplikasi (PWA) di ponsel User Utama
                                                     └──> Web Push ke User Utama + Kontak Darurat
```

Semuanya satu proyek Next.js 16 (App Router). `server.mjs` menjalankan Next.js bersama bagian yang
harus hidup terus: pelanggan MQTT, Socket.IO, dan pengirim Web Push. Bagian itu tidak bisa berjalan
di layanan serverless, jadi ada dua cara memasang aplikasi ini (lihat [Vercel](#vercel) di bawah).

Server **tidak pernah** mengirim perintah ke alat. Keputusan tetap di layanan cloud, dan CRITICAL
hanya bisa dilepas dengan tombol di rompi (F-HW-6, tahan 3 detik).

## Isi folder

```
├── app/                         # Next.js App Router
│   ├── layout.jsx, providers.jsx#   kerangka HTML, Redux, sesi login, service worker
│   ├── (app)/                   #   halaman User Utama: Beranda, Riwayat, Kontak, Akun, Pasangkan (wajib login)
│   ├── masuk/, lupa-sandi/, atur-sandi/, verifikasi/
│   ├── darurat/[token]/         #   Halaman 6, tanpa akun
│   ├── gabung/[code]/           #   undangan kontak darurat, tanpa akun
│   ├── manifest.js              #   manifest PWA
│   └── api/**/route.js          #   REST: akun, pairing, kontak, riwayat, tautan darurat, push
├── src/                         # kode browser
│   ├── screens/                 #   isi tiap halaman (Login, Pair, Dashboard, Contacts, History, EventDetail, Emergency, Join, Account)
│   ├── components/              #   pelat status, EKG, peta, ikon
│   ├── api.js, realtime.js, push.js, session.js, store.js (Redux Toolkit)
│   ├── styles.css               #   seluruh gaya, lihat DESIGN.md
│   └── sw.js                    #   service worker (Workbox), dibundel ke public/sw.js saat build
├── lib/
│   ├── api.js                   # pembungkus Route Handlers: login, pairing, batas ukuran, galat
│   └── server/                  # backend yang hidup terus (Node.js 22)
│       ├── backend.js           #   MQTT + Socket.IO + aturan notifikasi berlapis
│       ├── store.js             #   akun, alat, kontak, langganan push, log notifikasi, konfirmasi
│       ├── push.js              #   kirim Web Push + retry backoff (8.6.5)
│       ├── mail.js              #   email verifikasi & lupa sandi (SMTP opsional)
│       ├── db.js                #   kueri ke cardiovest.db milik cloud (baca saja)
│       ├── codec.js             #   dekoder paket ECG biner (sama dengan firmware & Python)
│       └── alat.js              #   CLI admin: daftar alat, kode pairing, label QR
├── server.mjs                   # titik masuk di Docker/VPS: Next.js + backend dalam satu proses
├── proxy.js                     # khusus Vercel: meneruskan /api ke server CardioVest
├── next.config.mjs, vercel.json
├── scripts/build-sw.mjs
├── test/                        # 18 uji (node --test)
├── Dockerfile                   # build Next.js lalu jalankan server.mjs (satu image)
├── Caddyfile                    # HTTPS untuk produksi (dipakai docker-compose.produksi.yml di folder utama)
└── docs/tangkapan_layar/        # tangkapan layar tiap halaman
```

## Menjalankan di laptop

Dari folder utama proyek (bukan folder ini):

```powershell
docker compose up -d --build
```

Buka http://localhost:8252, daftar akun, lalu pasangkan alat dengan ID `cv-001` dan kode `482913`.
Kode itu berasal dari `DEVICES=cv-001:482913` di `.env` folder utama. Kalau `DEVICES` dikosongkan
kodenya (`cv-001:`), kode acak dibuat sekali dan tercetak di `docker compose logs web`.

Mengubah kode aplikasi lalu ingin melihat hasilnya: `docker compose up -d --build web`.

### Mengembangkan tanpa membangun ulang image

Butuh Node.js 22.13 atau lebih baru. Broker dan layanan cloud tetap dari Docker; aplikasinya
dijalankan langsung dari folder ini dengan hot reload. Database cloud ada di volume Docker, jadi
salin dulu supaya halaman Riwayat berisi:

```powershell
docker compose up -d mosquitto cloud simulator              # dari folder utama
docker compose cp cloud:/data/cardiovest.db web\cloud-dev.db # salinan; ulangi bila ingin riwayat terbaru
cd web
npm install
$env:MQTT_URL="mqtt://localhost:1883"; $env:CLOUD_DB="cloud-dev.db"; $env:DEVICES="cv-001:482913"
npm run dev                                                  # http://localhost:8080
```

Di macOS/Linux: `MQTT_URL=mqtt://localhost:1883 CLOUD_DB=cloud-dev.db DEVICES=cv-001:482913 npm run dev`.
Data akun saat pengembangan tersimpan di `web/data/` (tidak ikut git).

### Variabel di `.env` folder utama

| Variabel | Isi |
|---|---|
| `DEVICES` | alat yang boleh dipasangkan, `ID:kode6digit`, dipisah koma. ID harus sama dengan `DEVICE_ID` di firmware. Kode kosong = dibuat acak |
| `WEB_PORT` | port di laptop (default 8252) |
| `CONTACTS_JSON` | opsional, kontak awal untuk akun pertama yang pairing: `[{"name":"Bu Sari","relation":"istri","phone":"+62812..."}]` |
| `SMTP_URL` | opsional, untuk email verifikasi dan lupa sandi. Kosong = isi email dicetak ke log |
| `MAIL_FROM` | alamat pengirim email |
| `PUBLIC_URL` | alamat publik, dipakai di tautan email dan notifikasi |
| `WEB_DOMAIN`, `MQTT_PASS_WEB` | hanya untuk produksi (lihat bawah) |
| `ALLOWED_ORIGINS`, `PROXY_SECRET` | hanya bila tampilan dipasang di Vercel (lihat bawah) |

Untuk Gmail, pakai **sandi aplikasi** (Akun Google → Keamanan → Verifikasi 2 langkah → Sandi aplikasi),
bukan sandi akun: `SMTP_URL=smtps://namaakun%40gmail.com:sandiaplikasi@smtp.gmail.com:465`.

## Mengelola alat (peran Admin)

Peran Admin di Tabel 7.1 dijalankan lewat CLI, bukan lewat aplikasi, supaya tidak ada halaman admin
yang bisa diserang dari internet.

```sh
docker compose exec web npm run alat -- daftar
docker compose exec web npm run alat -- tambah cv-002        # alat baru, kode acak
docker compose exec web npm run alat -- kode-baru cv-001     # ganti kode (yang lama tidak berlaku)
docker compose exec web npm run alat -- lepas cv-001         # lepas dari akun pemiliknya
```

Setiap `tambah`/`kode-baru` menulis label `label-<id>.svg` berisi QR `CARDIOVEST:<id>:<kode>`.
Ambil dengan `docker compose cp web:/data/label-cv-001.svg .`, cetak, lalu tempel di rompi.

## Alur pemakaian

1. **User Utama daftar** (Halaman 1). Persetujuan pemrosesan data wajib dicentang (UU PDP 27/2022).
   Email verifikasi dikirim, tetapi aplikasi tetap bisa dipakai sebelum diverifikasi.
2. **Pasangkan alat**: pindai QR di label atau ketik ID + kode. Satu alat untuk satu akun.
3. **Tambah kontak darurat** (Halaman 4, maksimal 5). Kontak **tidak perlu akun**. Tiap kontak punya
   tautan undangan yang dikirim lewat WhatsApp. Kontak membukanya sekali dan menekan "Aktifkan
   notifikasi darurat".
4. **Nyalakan notifikasi** di menu Akun. Di iPhone, tambahkan ke Layar Utama dulu (iOS 16.4+).
5. Saat alat mendeteksi sesuatu:
   - **WARNING** → hanya ke User Utama ("istirahat dulu").
   - **CRITICAL** → User Utama dan semua kontak, berisi lokasi GPS dan status jatuh. Kontak membuka
     Halaman 6 tanpa login, bisa menelepon 119/112 atau User Utama, dan menekan **"Saya terima"**.
     Konfirmasi itu langsung muncul di beranda User Utama.
   - Kegagalan kirim dicoba sampai 5 kali dengan jeda 1, 2, 4, 8 detik + jitter (maksimal 32 s). Setiap
     percobaan dicatat dan bisa dilihat di detail kejadian.
6. **Riwayat** (Halaman 5): filter jenis dan tanggal. Detail kejadian berisi EKG 20 detik sebelum
   sampai 20 detik sesudah, kelas CNN, urutan status, siapa saja yang dikirimi notifikasi, siapa yang
   sudah mengonfirmasi, dan tombol unduh PDF untuk dokter.

## Endpoint

Semua REST di bawah `/api`, real-time lewat Socket.IO di `/data/realtime`.

| Kelompok | Endpoint |
|---|---|
| Akun | `POST /auth/signup`, `/auth/login`, `/auth/verify`, `/auth/verify/kirim-ulang`, `/auth/forgot`, `/auth/reset` · `GET`/`PUT /users/me` |
| Alat | `POST`/`DELETE /devices/pair` · `GET /status` · `GET /trend` · `POST /reset` (hentikan alarm CRITICAL; body `{"confirm":true}`, dimatikan oleh `REMOTE_RESET=0`) |
| Kontak | `GET`/`POST /contacts` · `PUT`/`DELETE /contacts/:id` · `POST /contacts/:id/undangan-baru` |
| Undangan kontak (tanpa akun) | `GET /join/:code` · `POST /join/:code/push` · `POST /join/:code/uji` |
| Riwayat | `GET /history?type=&from=&to=` · `GET /history/:id` · `GET /history/:id/ecg` |
| Halaman 6 (tanpa akun) | `GET /public/:token?k=` · `POST /public/:token/ack` |
| Notifikasi | `GET /push/key` · `POST`/`DELETE /push/subscribe` · `POST /push/test` |
| Lain | `GET /health` |

## Lewat internet

Notifikasi push dan pemasangan PWA hanya jalan di HTTPS (kecuali `localhost`). Di VPS:

```sh
# 1) broker produksi + akun cloud/web/alat: lihat mosquitto/produksi/README.md
# 2) .env folder utama: WEB_DOMAIN=cardiovest.contoh.id, MQTT_PASS_CLOUD=..., MQTT_PASS_WEB=...
docker compose -f docker-compose.yml -f docker-compose.produksi.yml up -d --build
```

Domain harus sudah mengarah ke IP server dan port 80/443 terbuka. Caddy mengurus sertifikat sendiri.

## Vercel

Vercel hanya menjalankan fungsi yang hidup sebentar per permintaan. Pelanggan MQTT, koneksi
Socket.IO, dan berkas SQLite tidak bisa tinggal di sana. Karena itu pembagiannya begini:

- **VPS** tetap menjalankan semuanya seperti di bagian sebelumnya (Docker + Caddy), misalnya di
  `https://api.cardiovest.contoh.id`.
- **Vercel** menyajikan halaman. Setiap permintaan `/api/...` diteruskan `proxy.js` ke VPS, jadi bagi
  browser semuanya tetap satu domain (login, service worker, dan Background Sync tidak berubah).
  Hanya Socket.IO yang tersambung langsung ke VPS.

Langkahnya:

1. Buat `PROXY_SECRET`, string acak panjang, misalnya dari `openssl rand -hex 32`.
2. Di `.env` VPS:
   ```
   WEB_DOMAIN=api.cardiovest.contoh.id
   PUBLIC_URL=https://cardiovest.vercel.app        # alamat Vercel: dipakai di tautan email dan notifikasi
   ALLOWED_ORIGINS=https://cardiovest.vercel.app   # yang boleh membuka Socket.IO; pisahkan dengan koma
   PROXY_SECRET=<string tadi>
   ```
   lalu `docker compose -f docker-compose.yml -f docker-compose.produksi.yml up -d --build`.
3. Di Vercel: impor repositori, pilih **Root Directory** `web`. Framework terdeteksi sebagai Next.js
   dan `vercel.json` sudah mengatur perintah build. Isi Environment Variables:

   | Variabel | Isi |
   |---|---|
   | `CARDIOVEST_API` | `https://api.cardiovest.contoh.id` |
   | `NEXT_PUBLIC_REALTIME_URL` | `https://api.cardiovest.contoh.id` |
   | `PROXY_SECRET` | string yang sama dengan di VPS |

4. Deploy. Cek `https://cardiovest.vercel.app/api/health`; jawabannya harus datang dari VPS
   (`"mqtt": true`).

`NEXT_PUBLIC_REALTIME_URL` dibaca saat build, jadi bila nilainya diganti, deploy ulang. Tanpa
`PROXY_SECRET`, server di VPS menganggap semua pengguna datang dari IP Vercel, dan pembatas
percobaan login bisa memblokir semua orang sekaligus.

## Uji

```sh
npm ci
npm run build    # uji API berjalan lewat server.mjs dalam mode produksi, jadi butuh hasil build
npm test         # 18 uji: dekoder ECG, akun, pairing, kontak, notifikasi berlapis, retry, ack, IP dari Vercel
```

Fixture uji dibuat dari kode Python proyek ini (`common/heartsim_common/codec.py`, `cloud/cloud/storage.py`), jadi bila format
payload atau skema database berubah di sana, uji ini ikut gagal dan perlu dibuat ulang.

## Desain

Tampilannya memakai bahasa **papan penunjuk rumah sakit**:
- strip biru tua dengan huruf putih untuk judul dan navigasi;
- pelat status berwarna penuh, dengan warna yang sama dengan LED tiga warna di alat (Normal hijau,
  Waspada kuning, Darurat merah seperti papan IGD, Tidak terpantau abu-abu);
- piktogram tebal;
- daftar seperti papan direktori.

Arah ini dipilih karena laporan meminta tipografi besar, kontras tinggi, dan navigasi sederhana untuk
lansia, plus indikator hijau/kuning/merah yang menonjol di atas.

Aturan lengkap ada di [`DESIGN.md`](DESIGN.md). Token mesinnya ada di `.impeccable/design.json` di folder
utama, dan fakta produknya di `PRODUCT.md`.

Tangkapan layar tiap halaman (lebar 390 px dan desktop) ada di `docs/tangkapan_layar/`.

## Batasan

- Notifikasi FCM di `cloud/notifier.py` masih tiruan untuk log. Jalur notifikasi
  yang sungguhan adalah Web Push dari aplikasi ini.
- Belum ada SMS/WhatsApp dari server. Saat offline lebih dari 30 detik dalam kondisi CRITICAL, alat
  mengirim SMS sendiri lewat SIM7600.
- SQLite cukup untuk puluhan alat. Untuk skala lebih besar, lihat `docs/penyesuaian_laporan.md`.
