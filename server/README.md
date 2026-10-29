# Server CardioVest (API + realtime)

Bagian aplikasi yang harus hidup terus, berjalan di Render bersama layanan cloud dan
pemutar dataset EKG ([`deploy/`](../deploy/README.md)). Satu proses Node.js 22 tanpa framework:

- **REST** `/api/*`: akun, pairing, kontak, riwayat, tautan darurat, Web Push.
- **Socket.IO** `/data/realtime`: status, vital, inferensi, dan EKG 250 Hz ke browser.
- **MQTT**: membaca `device/+/*` dari layanan cloud, menulis `device/+/remote` (reset alarm),
  `device/+/source` (sumber EKG, retained), dan `sim/+/control` (skenario, hanya bila `SIMULATOR=1`).
- **Socket.IO** `/debug`: data mentah alat untuk debug viewer, tanpa login.
- **Web Push** berlapis: WARNING hanya ke User Utama, CRITICAL ke User Utama + semua kontak, retry
  backoff 1–32 s.
- Database: `gateway.db` (akun, alat, kontak, langganan push, log notifikasi) dan membaca
  `cardiovest.db` milik layanan cloud.

Server tidak pernah mengubah state alat secara langsung. Keputusan tetap di layanan cloud.

## Isi folder

```
├── main.js            # server HTTP + router routes/ + Socket.IO
├── routes/            # satu folder per endpoint, [param] untuk bagian dinamis
│   └── contacts/[id]/route.js   -> PUT/DELETE /api/contacts/:id
├── lib/
│   ├── api.js         # route(): body, login, pairing, galat; validasi bersama (import dari '#api')
│   ├── backend.js     # MQTT + Socket.IO + aturan notifikasi
│   ├── store.js       # gateway.db
│   ├── db.js          # baca cardiovest.db (cloud)
│   ├── push.js, mail.js, codec.js, config.js
│   └── alat.js        # CLI admin alat + label QR
└── test/              # uji node --test (fixture dibuat dari kode Python proyek)
```

Menambah endpoint: buat `routes/<nama>/route.js` yang mengekspor `GET`/`POST`/`PUT`/`DELETE`:

```js
import { json, route } from '#api';

export const GET = route(async (r) => json({ halo: r.user.name }), { auth: true });
```

`r` berisi `body`, `params`, `query`, `ip`, `user`, `device`, dan `ctx` (semua objek backend). Router
memuat folder `routes/` otomatis saat server menyala.

## Endpoint

| Kelompok | Endpoint |
|---|---|
| Akun | `POST /auth/signup`, `/auth/login`, `/auth/verify`, `/auth/verify/kirim-ulang`, `/auth/forgot`, `/auth/reset` · `GET`/`PUT /users/me` |
| Alat | `POST`/`DELETE /devices/pair` · `GET /status` · `GET /trend` · `POST /reset` (`{"confirm":true}`) · `POST /mode` |
| Demo | `GET`/`POST /source` (`{"source":"dataset","rekaman":"stemi"}` atau `{"source":"hardware"}`) · `GET`/`POST /scenario` (`{"name":"serangan"}`) |
| Kontak | `GET`/`POST /contacts` · `PUT`/`DELETE /contacts/:id` · `POST /contacts/:id/undangan-baru` |
| Undangan kontak (tanpa akun) | `GET /join/:code` · `POST /join/:code/push` · `POST /join/:code/uji` |
| Riwayat | `GET /history?type=&from=&to=` · `GET /history/:id` · `GET /history/:id/ecg` |
| Halaman 6 (tanpa akun) | `GET /public/:token?k=` · `POST /public/:token/ack` |
| Notifikasi | `GET /push/key` · `POST`/`DELETE /push/subscribe` · `POST /push/test` |
| Lain | `GET /health` |

Event Socket.IO: `status`, `state`, `vital`, `ecg`, `inference`, `location`, `fall`, `online`, `alert`,
`ack`, `source`.

## Variabel lingkungan

Diatur di **Environment** layanan Render.

| Nama | Isi |
|---|---|
| `DEVICES` | alat yang boleh dipasangkan, `ID:kode6digit`, dipisah koma |
| `PUBLIC_URL` | alamat Vercel, untuk tautan email, undangan, dan notifikasi |
| `ALLOWED_ORIGINS` | asal yang boleh membuka Socket.IO, `*` sebagai wildcard: `https://*.vercel.app,http://localhost:3000` |
| `PROXY_SECRET` | sama dengan di Vercel |
| `SMTP_URL`, `MAIL_FROM` | email verifikasi dan lupa sandi. Kosong = isi email dicetak ke log. Gmail: `smtps://akun%40gmail.com:sandiaplikasi@smtp.gmail.com:465` |
| `CONTACTS_JSON` | opsional, kontak awal untuk akun pertama yang pairing |
| `SIMULATOR` | `1` = jalankan alat virtual penuh (bawaan `0`) |
| `REMOTE_RESET` | `0` = tombol "Hentikan alarm" di aplikasi dimatikan |

## Mengelola alat (peran Admin)

Alat yang boleh dipasangkan diatur lewat variabel `DEVICES` di Render, mis. `cv-001:123456,cv-002:654321`. Tidak ada
halaman admin di web, supaya tidak ada yang bisa diserang dari internet.

Label QR `CARDIOVEST:<id>:<kode>` untuk ditempel di rompi dibuat di laptop:

```powershell
cd server
npm install
npm run alat -- tambah cv-001 123456
```

Labelnya tersimpan di `server/data/label-cv-001.svg`.

## Uji

```sh
cd server
npm install
npm test
```
