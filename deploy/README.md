# Deploy demo CardioVest: Vercel + Hugging Face + flespi

Semuanya gratis dan tanpa kartu kredit. Setelah penyiapan sekali-jalan di bawah, alur kerja harian cukup:

```powershell
git add -A
git commit -m "pesan perubahan"
git push
```

| Bagian | Di mana | Setelah `git push` |
|---|---|---|
| Tampilan web (`web/`) | **Vercel** | dibangun ulang otomatis, ±1 menit |
| Layanan cloud CNN + FSM, server API + realtime, simulator dataset | **Hugging Face Space** (Docker, 2 vCPU, 16 GB) | Space mengecek GitHub tiap menit, mengambil commit baru, lalu menyalakan ulang layanan |
| Broker MQTT | **flespi** (broker publik gratis, akun pribadi) | tidak berubah |

```
ESP32 ──MQTT 1883/8883──► flespi ◄──WSS 443── Hugging Face Space (cloud + server + simulator)
                                                        ▲  https://<user>-cardiovest.hf.space
                                                        │  /api diteruskan, EKG realtime lewat WebSocket
       browser teman ──► https://<proyek>.vercel.app ───┘
```

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
3. Di Space yang baru: **Files → Add file → Upload files**, unggah `deploy/hf/Dockerfile` dan
   `deploy/hf/README.md` dari repo ini (timpa README bawaan), lalu **Commit**.
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

Variabel opsional lain: `SIMULATOR=0` (simulator tidak dijalankan sama sekali), `SIM_SOURCE=hardware`,
`SCENARIO=serangan`, `TAU_CONF`, `TAU_WARN`, `CALIB_SECONDS`, `SMTP_URL`, dan semua parameter di
README utama. Setiap perubahan variabel membuat Space menyala ulang.

## C. Tampilan di Vercel (sekali)

1. <https://vercel.com/new> → masuk dengan GitHub → **Import** `ArgyaSabih/CardioVest`
   (repositori publik; bila tidak muncul, tempel URL-nya).
2. **Root Directory**: `web`.
3. **Environment Variables**:

   | Nama | Isi |
   |---|---|
   | `NEXT_PUBLIC_BACKEND_URL` | `https://<username-hf>-cardiovest.hf.space` |
   | `PROXY_SECRET` | sama persis dengan di Hugging Face |

4. **Deploy**. Lalu **Settings → Git → Production Branch** = `faza`, simpan.
5. Isi `PUBLIC_URL` di Hugging Face dengan alamat Vercel ini (langkah B.4).
6. Cek `https://<proyek>.vercel.app/api/health` → `{"ok":true,"mqtt":true,"cloud_db":true}`.

`NEXT_PUBLIC_BACKEND_URL` dibaca saat build. Bila diganti, lakukan **Redeploy** di Vercel.

## D. ESP32 ke flespi

Di `firmware/cardiovest_c251/cardiovest_c251.ino`:

```c
#define MQTT_HOST "mqtt.flespi.io"
#define MQTT_USE_TLS 0
#define MQTT_TLS_INSECURE 0
#define MQTT_USER "<FLESPI_TOKEN>"
#define MQTT_PASS ""
```

Untuk koneksi terenkripsi, pakai `MQTT_USE_TLS 1` dan `MQTT_TLS_INSECURE 1` (port 8883, sertifikat
tidak diverifikasi).

Simulator dan ESP32 memakai ID yang sama (`cv-001`), jadi hanya satu yang boleh mengirim data. Pilihan
sumber disimpan di broker dan tetap berlaku walau Space menyala ulang:

```js
await api('/source', { method: 'POST', body: { source: 'hardware' } });
await api('/source', { method: 'POST', body: { source: 'dataset' } });
```

---

## Mengendalikan demo

Selama tombolnya belum ada di aplikasi, perintah bisa diketik di **Console** browser (F12) saat sudah
masuk ke aplikasi di Vercel:

```js
const kirim = (p, body) => fetch('/api' + p, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + localStorage.cv_token }, body: JSON.stringify(body) }).then((r) => r.json());

kirim('/source', { source: 'hardware' });
kirim('/source', { source: 'dataset' });
kirim('/scenario', { name: 'serangan' });
kirim('/scenario', { name: 'normal' });
kirim('/reset', { confirm: true });
```

Daftar skenario: `GET /api/scenario`, atau README utama bagian 3.

## Pemecahan masalah

| Gejala | Solusi |
|---|---|
| Log HF berisi `[mqtt] Not authorized` / `Connection refused` | `FLESPI_TOKEN` salah atau kosong. Perbaiki di Settings; Space menyala ulang sendiri. |
| Vercel `/api/health` menjawab 503 `NEXT_PUBLIC_BACKEND_URL belum diisi` | Isi variabel di Vercel lalu Redeploy. |
| Vercel `/api/health` menampilkan halaman HTML | Space sedang tertidur atau dibangun. Buka alamat `hf.space`, tunggu 1–2 menit. |
| Login gagal "Terlalu banyak percobaan" | `PROXY_SECRET` di Vercel dan HF tidak sama. |
| Setelah demo kemarin harus daftar ulang | Normal untuk mode demo: Space menyala ulang dan data terhapus. |
| Grafik EKG diam, status "Tidak terpantau" | Sumber `hardware` tetapi ESP32 mati, atau sebaliknya. Ganti sumber. |
| ESP32 tidak tersambung | Cek `MQTT_USER` = token flespi, `MQTT_PASS` kosong. Di flespi **MQTT Board** terlihat koneksi aktif. |
| Push terakhir belum terlihat | Tunggu 1–2 menit; tab Logs HF menulis `[run] commit baru di faza`. Bila `requirements.txt` berubah, layanan butuh waktu lebih lama menyala. |
| `Dockerfile` di HF perlu diubah | Jarang. Unggah ulang `deploy/hf/Dockerfile`, atau **Settings → Factory rebuild**. |
