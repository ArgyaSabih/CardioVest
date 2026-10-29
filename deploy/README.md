# Deploy CardioVest: Vercel + Render + flespi

Semuanya gratis dan tanpa kartu kredit. Alur kerja harian:

```powershell
git add -A
git commit -m "pesan perubahan"
git push
```

| Bagian | Di mana | Setelah `git push` |
|---|---|---|
| Aplikasi keluarga (`web/`) dan debug viewer (`/debug`) | **Vercel** | dibangun ulang otomatis, ±1 menit |
| Layanan cloud CNN + FSM, server API + realtime, pemutar dataset EKG | **Render** (Docker, paket Free) | backend mengecek GitHub tiap menit, mengambil commit baru, lalu menyalakan ulang layanan |
| Broker MQTT | **flespi** (paket Free, akun pribadi) | tidak berubah |

```
ESP32 ──MQTT 1883/8883──► flespi ◄──WSS 443── backend Render (cloud + server + dataset)
                                                   ▲  https://cardiovest.onrender.com
                                                   │  /api diteruskan, data realtime lewat WebSocket
     browser tim/keluarga ──► https://capstone-c03.vercel.app         (aplikasi)
                              https://capstone-c03.vercel.app/debug   (debug viewer)
```

Tidak ada data simulasi: dashboard dan debug viewer hanya bergerak bila ESP32 tersambung, atau bila sumber
EKG sengaja dipilih **Dataset** di debug viewer.

Render paket Free tertidur bila 15 menit tidak ada pengunjung, dan isi disknya terhapus setiap kali
layanan menyala ulang (akun, pairing, dan riwayat ikut hilang). Membuka aplikasi atau `/debug`
membangunkannya dalam ±1 menit, dan selama halaman itu terbuka backend tetap bangun.

---

## A. Broker MQTT di flespi

1. Daftar di <https://flespi.io> (paket **Free**).
2. Menu **Tokens** → salin token. Token dipakai sebagai *username* MQTT, kata sandi dikosongkan.

## B. Backend di Render

1. <https://dashboard.render.com> → **New → Web Service → Public Git Repository** →
   `https://github.com/ArgyaSabih/CardioVest`.
2. Isi: **Branch** `faza`, **Language** Docker, **Dockerfile Path** `deploy/backend/Dockerfile`,
   **Instance Type** Free.
3. **Environment**:

   | Nama | Isi |
   |---|---|
   | `FLESPI_TOKEN` | token dari langkah A |
   | `PROXY_SECRET` | string acak panjang, sama persis dengan di Vercel |
   | `DEVICES` | `cv-001:123456` (ID alat : kode pairing 6 digit) |
   | `PUBLIC_URL` | alamat Vercel, mis. `https://capstone-c03.vercel.app` |

   Opsional: `SIMULATOR=1` (alat virtual penuh untuk latihan tanpa ESP32), `TAU_CONF`, `TAU_WARN`,
   `CALIB_SECONDS`, `SMTP_URL`, dan parameter lain di README utama. Setiap perubahan membuat layanan
   menyala ulang.

4. Cek `https://cardiovest.onrender.com/api/health` → `{"ok":true,"mqtt":true,"cloud_db":true}`.
   Tab **Logs** di Render menampilkan log cloud, server, dan dataset.

## C. Aplikasi di Vercel

Vercel terhubung ke repositori `AzfazakiHakimi/capstone-c03`, branch `faza`, **Root Directory** `web`.

| Variabel | Isi |
|---|---|
| `PROXY_SECRET` | sama persis dengan di Render |
| `NEXT_PUBLIC_BACKEND_URL` | opsional. Kosong = `https://cardiovest.onrender.com` (tertulis di `web/src/backend.js`) |

Isi sebagai variabel biasa (jangan centang *Sensitive*). Bila muncul *already exists*, edit variabel
yang sudah ada lewat **⋯ → Edit**. Setiap perubahan variabel butuh **Deployments → ⋯ → Redeploy**.

## D. Git di laptop

`git push` dikirim ke dua repositori sekaligus: `ArgyaSabih/CardioVest` (tim dan Render) dan
`AzfazakiHakimi/capstone-c03` (Vercel). Cek dengan `git remote -v`: satu baris `fetch` dan dua baris
`push`.

## E. ESP32

`MQTT_HOST` di `firmware/cardiovest_c251/cardiovest_c251.ino` sudah `mqtt.flespi.io`. Token disimpan di
`firmware/cardiovest_c251/rahasia.h` (salinan `rahasia.contoh.h`, tidak ikut git):

```c
#define MQTT_USER "<FLESPI_TOKEN>"
#define MQTT_PASS ""
```

Untuk koneksi terenkripsi, ubah `MQTT_USE_TLS 1` dan `MQTT_TLS_INSECURE 1` di `.ino` (port 8883).

---

## Debug viewer (`/debug`)

Tampilan realtime untuk tim: EKG di atas kertas EKG (25 mm/s), detak jantung, GSR, kualitas sinyal,
probabilitas CNN, keputusan FSM, gerak dan sensor, GPS, dan riwayat kejadian. Tanpa login atau token.

| Kontrol | Fungsi |
|---|---|
| **Mode alat**: Demo / Test | Test menyalakan semua sensor termasuk GPS |
| **Sumber EKG**: Hardware / Dataset | Hardware = EKG dari ESP32. Dataset = EKG dari rekaman PTB-XL/MIT-BIH, jenisnya dipilih di **Jenis rekaman**. HR, GSR, gerak, dan GPS tetap dari ESP32 |
| **Jalankan** / **Jeda** | Jalankan menerapkan pilihan lalu menampilkan data. Jeda menghentikan tampilan |

Mengubah pilihan menjeda tampilan dan menandai pilihan dengan titik biru. Pilihan baru dikirim saat
**Jalankan** ditekan. EKG dari Dataset diproses seperti EKG alat (CNN, FSM, riwayat, notifikasi), dan
pilihannya tersimpan di broker; kembalikan ke **Hardware** setelah selesai menguji.

Alat lain: tambahkan `?device=cv-002` di belakang alamat. Struktur kode dan cara mengembangkannya:
[`web/public/debug/README.md`](../web/public/debug/README.md).

## API untuk aplikasi

```js
const kirim = (p, body) => fetch('/api' + p, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + localStorage.cv_token }, body: JSON.stringify(body) }).then((r) => r.json());

kirim('/source', { source: 'dataset', rekaman: 'stemi' });
kirim('/source', { source: 'hardware' });
kirim('/reset', { confirm: true });
```

Jenis rekaman: `normal`, `st_depression`, `af`, `pvc`, `cd`, `svt`, `stemi`, `vt`, `vf`.
`/scenario` hanya berlaku bila `SIMULATOR=1`.

## Pemecahan masalah

| Gejala | Solusi |
|---|---|
| Log Render berisi `[mqtt] Not authorized` | `FLESPI_TOKEN` salah atau kosong. |
| Halaman menampilkan "Membangunkan server", atau `/api/health` berisi halaman HTML | Render sedang bangun dari tidur, tunggu ±1 menit. |
| Login gagal "Terlalu banyak percobaan" | `PROXY_SECRET` di Vercel dan Render tidak sama. |
| Akun hilang setelah beberapa waktu | Normal untuk Render Free: disk terhapus saat layanan menyala ulang. Daftar ulang. |
| EKG diam, alat "offline" | ESP32 belum tersambung. Di flespi **MQTT Board** cek koneksi `dev-cv-001`, dan pastikan sumber EKG Hardware. |
| Push terakhir belum terlihat di backend | Tunggu 1–2 menit; Logs Render menulis `[run] commit baru di faza`. Bisa juga **Manual Deploy** di Render. |
