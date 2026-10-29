# Deploy demo CardioVest: Vercel + Hugging Face/Render + flespi

Semuanya gratis dan tanpa kartu kredit. Setelah penyiapan sekali-jalan di bawah, alur kerja harian cukup:

```powershell
git add -A
git commit -m "pesan perubahan"
git push
```

| Bagian | Di mana | Setelah `git push` |
|---|---|---|
| Tampilan web (`web/`) | **Vercel** | dibangun ulang otomatis, ±1 menit |
| Layanan cloud CNN + FSM, server API + realtime | **Hugging Face Space** (2 vCPU, 16 GB) atau **Render** (cadangan, 512 MB) | backend mengecek GitHub tiap menit, mengambil commit baru, lalu menyalakan ulang layanan |
| Broker MQTT | **flespi** (broker publik gratis, akun pribadi) | tidak berubah |

```
ESP32 ──MQTT 1883/8883──► flespi ◄──WSS 443── backend Render / Hugging Face (cloud + server)
                                                        ▲  https://<user>-cardiovest.hf.space
                                                        │  /api diteruskan, EKG realtime lewat WebSocket
       browser teman ──► https://<proyek>.vercel.app ───┘
                         https://<proyek>.vercel.app/debug ──WebSocket──► backend (debug viewer)
```

Secara bawaan **tidak ada data simulasi**: dashboard dan debug viewer hanya bergerak bila ESP32 benar-benar
tersambung dan mengirim data. Simulator dataset bisa dinyalakan untuk latihan dengan variabel
`SIMULATOR=1` di backend.

Ini mode **demo**: akun, pairing, dan riwayat terhapus setiap kali Space menyala ulang (misalnya setelah
dibangun ulang atau tertidur). Commit biasa tidak menghapus data, karena layanan hanya dinyalakan ulang
di dalam container yang sama. Space gratis tertidur bila 48 jam tidak dibuka; membuka alamatnya
membangunkannya lagi dalam 1–2 menit.

---

## A. Broker MQTT di flespi (sekali)

1. Daftar di <https://flespi.io> (email atau Google, paket **Free**).
2. Menu **Tokens** → salin token yang ada (*Master token*), atau buat token baru. Token ini dipakai
   sebagai *username* MQTT; kata sandinya dikosongkan.

Semua topik di akun flespi Anda terpisah dari pengguna flespi lain. Batas paket Free (50 koneksi,
20.000 pesan per menit) jauh di atas kebutuhan satu rompi.

## B. Backend di Hugging Face (sekali)

1. Daftar di <https://huggingface.co/join>.
2. <https://huggingface.co/new-space>:
   - **Space name**: `cardiovest`
   - **SDK**: Docker → **Blank**
   - **Hardware**: CPU basic (free)
   - **Visibility**: **Public** (Vercel dan browser perlu bisa mengaksesnya; kode dan isi token tetap
     tersembunyi)
3. Di Space yang baru: **Files → Add file → Upload files**, unggah `deploy/backend/Dockerfile` dan
   `deploy/backend/README.md` dari repo ini (timpa README bawaan), lalu **Commit**.
4. **Settings → Variables and secrets**, tambahkan:

   | Jenis | Nama | Isi |
   |---|---|---|
   | Secret | `FLESPI_TOKEN` | token dari langkah A |
   | Secret | `PROXY_SECRET` | string acak panjang buatan Anda, mis. 40 huruf/angka |
   | Secret | `DEVICES` | `cv-001:123456` (ID alat : kode pairing 6 digit pilihan Anda) |
   | Variable | `PUBLIC_URL` | alamat Vercel (isi setelah langkah C, mis. `https://cardiovest.vercel.app`) |

5. Tab **Logs** menampilkan proses build (5–10 menit pertama kali), lalu log layanan. Tanda berhasil:

   ```
   [server] CardioVest di port 7860; alat terdaftar: cv-001
   [mqtt] tersambung ke wss://mqtt.flespi.io
   cloud      INFO     cv-001 seq=1 Normal ...
   ```

   Alamat backend: `https://<username-hf>-cardiovest.hf.space` (juga terlihat di menu **⋮ → Embed this
   Space → Direct URL**). Membukanya menampilkan `{"ok":true,"service":"cardiovest-server"}`.

Variabel opsional lain: `SIMULATOR=1` (nyalakan simulator dataset; bawaan mati), `SIM_SOURCE=hardware`,
`SCENARIO=serangan`, `TAU_CONF`, `TAU_WARN`, `CALIB_SECONDS`, `SMTP_URL`, dan semua parameter di
README utama. Setiap perubahan variabel membuat Space menyala ulang.

## B2. Cadangan: backend di Render

Pakai ini bila Hugging Face sedang bermasalah. Dockerfile-nya sama.

1. Daftar di <https://dashboard.render.com/register> dengan GitHub.
2. **New → Web Service → Public Git Repository**, tempel
   `https://github.com/ArgyaSabih/CardioVest`, **Connect**.
3. Isi:
   - **Name**: `cardiovest`
   - **Branch**: `faza`
   - **Language**: Docker
   - **Dockerfile Path**: `deploy/backend/Dockerfile`
   - **Instance Type**: Free
4. **Environment Variables**: `FLESPI_TOKEN`, `PROXY_SECRET`, `DEVICES` (dan nanti `PUBLIC_URL`),
   sama seperti tabel di langkah B.4.
5. **Deploy Web Service**. Alamat backend: `https://cardiovest-xxxx.onrender.com` (tertulis di atas
   halaman layanan). Tab **Logs** menampilkan log yang sama seperti di Hugging Face.

Perbedaannya dengan Hugging Face: Render gratis tertidur setelah **15 menit** tanpa pengunjung (EKG
realtime di browser yang sedang terbuka membuatnya tetap bangun), dan CPU-nya kecil. Untuk demo cukup:
buka aplikasi ±1 menit sebelum mulai.

## C. Tampilan di Vercel (sekali)

1. <https://vercel.com/new> → masuk dengan GitHub → **Import** `ArgyaSabih/CardioVest`
   (repositori publik; bila tidak muncul, tempel URL-nya).
2. **Root Directory**: `web`.
3. **Environment Variables**:

   | Nama | Isi |
   |---|---|
   | `PROXY_SECRET` | sama persis dengan di backend (Render/Hugging Face) |
   | `NEXT_PUBLIC_BACKEND_URL` | opsional. Kosong = `https://cardiovest.onrender.com` (tertulis di `web/src/backend.js`). Isi alamat `hf.space` bila pindah ke Hugging Face |

   Isi sebagai variabel biasa (jangan centang *Sensitive*), centang ketiga environment (Production,
   Preview, Development). Bila muncul *already exists*, variabel itu sudah pernah dibuat: cari di
   **Settings → Environment Variables**, klik **⋯ → Edit**, ubah nilainya, **Save**.

4. **Deploy**. Lalu **Settings → Git → Production Branch** = `faza`, simpan.
5. Isi `PUBLIC_URL` di Hugging Face dengan alamat Vercel ini (langkah B.4).
6. Cek `https://<proyek>.vercel.app/api/health` → `{"ok":true,"mqtt":true,"cloud_db":true}`.

Setiap kali variabel di Vercel diubah, lakukan **Deployments → ⋯ → Redeploy** supaya nilainya terpakai.

## D. ESP32 ke flespi

`MQTT_HOST` di `firmware/cardiovest_c251/cardiovest_c251.ino` sudah `mqtt.flespi.io`. Token disimpan
terpisah supaya tidak ikut ter-push ke GitHub (repositorinya publik): salin
`firmware/cardiovest_c251/rahasia.contoh.h` menjadi `rahasia.h` di folder yang sama, lalu isi tokennya.
`rahasia.h` sudah masuk `.gitignore`.

```c
#define MQTT_USER "<FLESPI_TOKEN>"
#define MQTT_PASS ""
```

Untuk koneksi terenkripsi, ubah `MQTT_USE_TLS 1` dan `MQTT_TLS_INSECURE 1` di `.ino` (port 8883,
sertifikat tidak diverifikasi).

Bila simulator dinyalakan (`SIMULATOR=1`), simulator dan ESP32 memakai ID yang sama (`cv-001`), jadi
hanya satu yang boleh mengirim data. Pilihan sumber disimpan di broker:

```js
await api('/source', { method: 'POST', body: { source: 'hardware' } });
await api('/source', { method: 'POST', body: { source: 'dataset' } });
```

---

## Debug viewer (`/debug`)

`https://<proyek>.vercel.app/debug` menampilkan data alat secara realtime: EKG 250 Hz, vital (HR, SQI,
GSR, akselerasi, sensor, I2C), probabilitas CNN tiap window, keputusan FSM, kualitas sinyal, GPS, dan log
LWT/alert/transisi. Tidak perlu login atau token: data diambil dari backend. Selama halaman ini terbuka,
backend Render tidak tertidur.

| Tombol | Fungsi |
|---|---|
| **Demo / Test** | mode alat (Test: semua sensor termasuk GPS aktif) |
| **Hardware / Dataset** | sumber sinyal EKG. Hardware = EKG dari ESP32. Dataset = EKG dari rekaman PTB-XL/MIT-BIH (pilih jenisnya di kotak sebelahnya); HR, GSR, akselerasi, dan GPS **tetap dari ESP32** |
| **Jalankan** | menerapkan pilihan di atas lalu mulai menampilkan data |

Setiap kali Demo/Test, Hardware/Dataset, atau jenis rekaman diganti, tampilan berhenti dan pilihan baru
**belum dikirim**. Pilihan baru diterapkan saat **Jalankan** ditekan.

EKG dari Dataset diperlakukan seperti EKG alat: dinilai CNN + FSM, tersimpan di riwayat, dan bisa memicu
notifikasi Waspada/Darurat ke aplikasi keluarga. Pilihan sumber tersimpan di broker, jadi tetap berlaku
walau backend menyala ulang; kembalikan ke **Hardware** setelah selesai menguji.

Alat lain: tambahkan `?device=cv-002` di belakang alamat.

## Mengendalikan dari aplikasi

Sumber EKG juga bisa diganti lewat API (misalnya untuk tombol di aplikasi PWA nanti):

```js
const kirim = (p, body) => fetch('/api' + p, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + localStorage.cv_token }, body: JSON.stringify(body) }).then((r) => r.json());

kirim('/source', { source: 'dataset', rekaman: 'stemi' });
kirim('/source', { source: 'hardware' });
kirim('/reset', { confirm: true });
```

Jenis rekaman: `normal`, `st_depression`, `af`, `pvc`, `cd`, `svt`, `stemi`, `vt`, `vf`.
`/scenario` hanya berlaku bila simulator alat penuh dinyalakan (`SIMULATOR=1`).

## Pemecahan masalah

| Gejala | Solusi |
|---|---|
| Log backend berisi `[mqtt] Not authorized` / `Connection refused` | `FLESPI_TOKEN` salah atau kosong. Perbaiki di Settings; Space menyala ulang sendiri. |
| Vercel `/api/health` menampilkan halaman HTML | Backend sedang tertidur atau dibangun. Buka alamat `hf.space`/`onrender.com`, tunggu 1–2 menit. |
| Login gagal "Terlalu banyak percobaan" | `PROXY_SECRET` di Vercel dan HF tidak sama. |
| Setelah demo kemarin harus daftar ulang | Normal untuk mode demo: Space menyala ulang dan data terhapus. |
| Grafik EKG diam, status "Tidak terpantau" | ESP32 belum tersambung. Cek di `/debug` apakah titik "perangkat" hijau, dan di flespi **MQTT Board** apakah ada koneksi `dev-cv-001`. Pastikan sumber EKG = Hardware bila memakai ESP32. |
| ESP32 tidak tersambung | Cek `MQTT_USER` = token flespi, `MQTT_PASS` kosong. Di flespi **MQTT Board** terlihat koneksi aktif. |
| Push terakhir belum terlihat | Tunggu 1–2 menit; tab Logs HF menulis `[run] commit baru di faza`. Bila `requirements.txt` berubah, layanan butuh waktu lebih lama menyala. |
| `Dockerfile` di HF perlu diubah | Jarang. Unggah ulang `deploy/backend/Dockerfile`, atau **Settings → Factory rebuild**. |
