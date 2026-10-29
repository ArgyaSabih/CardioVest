# Server CardioVest (API + realtime)

Bagian aplikasi yang harus hidup terus, berjalan di VM bersama broker dan layanan cloud
([`deploy/`](../deploy/README.md)). Satu proses Node.js 22 tanpa framework:

- **REST** `/api/*`: akun, pairing, kontak, riwayat, tautan darurat, Web Push.
- **Socket.IO** `/data/realtime`: status, vital, inferensi, dan EKG 250 Hz ke browser.
- **MQTT** (akun `web`): membaca `device/+/*` dari layanan cloud, menulis `device/+/remote` (reset alarm)
  dan `sim/+/source` (pilih sumber data).
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
├── test/              # uji node --test (fixture dibuat dari kode Python proyek)
└── Dockerfile
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
| Sumber data | `GET /source` · `POST /source` (`{"source":"dataset"}` atau `{"source":"hardware"}`) |
| Kontak | `GET`/`POST /contacts` · `PUT`/`DELETE /contacts/:id` · `POST /contacts/:id/undangan-baru` |
| Undangan kontak (tanpa akun) | `GET /join/:code` · `POST /join/:code/push` · `POST /join/:code/uji` |
| Riwayat | `GET /history?type=&from=&to=` · `GET /history/:id` · `GET /history/:id/ecg` |
| Halaman 6 (tanpa akun) | `GET /public/:token?k=` · `POST /public/:token/ack` |
| Notifikasi | `GET /push/key` · `POST`/`DELETE /push/subscribe` · `POST /push/test` |
| Lain | `GET /health` |

Event Socket.IO: `status`, `state`, `vital`, `ecg`, `inference`, `location`, `fall`, `online`, `alert`,
`ack`, `source`.

## Variabel lingkungan

Di VM semuanya diatur lewat `deploy/.env` (`cv set NAMA nilai`).

| Nama | Isi |
|---|---|
| `DEVICES` | alat yang boleh dipasangkan, `ID:kode6digit`, dipisah koma |
| `PUBLIC_URL` | alamat Vercel, untuk tautan email, undangan, dan notifikasi |
| `ALLOWED_ORIGINS` | asal yang boleh membuka Socket.IO, `*` sebagai wildcard: `https://*.vercel.app,http://localhost:3000` |
| `PROXY_SECRET` | sama dengan di Vercel |
| `SMTP_URL`, `MAIL_FROM` | email verifikasi dan lupa sandi. Kosong = isi email dicetak ke log (`cv logs server`). Gmail: `smtps://akun%40gmail.com:sandiaplikasi@smtp.gmail.com:465` |
| `CONTACTS_JSON` | opsional, kontak awal untuk akun pertama yang pairing |
| `REMOTE_RESET` | `0` = tombol "Hentikan alarm" di aplikasi dimatikan |

## Mengelola alat (peran Admin)

Lewat CLI di VM, bukan halaman web, supaya tidak ada halaman admin yang bisa diserang:

```sh
cv alat daftar
cv alat tambah cv-002        # alat baru, kode acak
cv alat kode-baru cv-001     # ganti kode, yang lama tidak berlaku
cv alat lepas cv-001         # lepas dari akun pemiliknya
```

Label QR `CARDIOVEST:<id>:<kode>` tersimpan di `/srv/cardiovest/server/label-<id>.svg`. Unduh ke laptop:
`scp -i <kunci> ubuntu@<ip>:/srv/cardiovest/server/label-cv-002.svg .`

## Uji

```sh
cd server
npm install
npm test
```
