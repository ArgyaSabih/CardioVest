# Aplikasi CardioVest (tampilan, Next.js)

Aplikasi yang dibuka di ponsel oleh **User Utama** (pemakai rompi) dan **Kontak Darurat** (Halaman 1–6
di Bab 7–8 laporan): daftar akun, pairing alat, dashboard real-time, kontak darurat, riwayat, dan halaman
darurat. Folder ini hanya berisi tampilan dan dipasang di **Vercel**. Semua data, MQTT, Socket.IO, dan
Web Push ada di [`server/`](../server/README.md) yang berjalan di Hugging Face.

```
browser ──► Vercel (folder ini)
              ├─ halaman Next.js 16 (App Router, PWA)
              └─ proxy.js: /api/*  ──► server/ di Hugging Face (HTTPS)
browser ──────── Socket.IO /data/realtime ──► server/ di Hugging Face (EKG 250 Hz langsung, tanpa lewat Vercel)
```

## Isi folder

```
├── app/                     # halaman (App Router)
│   ├── layout.jsx, providers.jsx, manifest.js
│   ├── (app)/               #   Beranda, Riwayat, Kontak, Akun, Pasangkan (wajib login)
│   ├── masuk/, lupa-sandi/, atur-sandi/, verifikasi/
│   ├── darurat/[token]/     #   Halaman 6, tanpa akun
│   └── gabung/[code]/       #   undangan kontak darurat, tanpa akun
├── src/
│   ├── screens/             #   isi tiap halaman
│   ├── components/          #   pelat status, EKG, peta, ikon
│   ├── api.js               #   klien REST (/api) + alamat backend
│   ├── realtime.js          #   Socket.IO
│   ├── store.js             #   Redux Toolkit (auth + live)
│   ├── push.js, session.js
│   ├── styles.css           #   seluruh gaya, lihat DESIGN.md
│   └── sw.js                #   service worker (Workbox), dibundel ke public/sw.js saat build
├── public/debug/            # debug viewer tim (/debug): HTML + mqtt.js + Leaflet, langsung ke flespi
├── proxy.js                 # meneruskan /api ke backend + IP asli pengguna
├── scripts/build-sw.mjs
└── next.config.mjs, vercel.json, jsconfig.json
```

## Variabel lingkungan (Vercel)

| Nama | Isi |
|---|---|
| `NEXT_PUBLIC_BACKEND_URL` | opsional, alamat backend. Kosong = nilai di `src/backend.js` (`https://cardiovest.onrender.com`) |
| `PROXY_SECRET` | sama dengan secret di Hugging Face, supaya pembatas percobaan login memakai IP asli pengguna |

`NEXT_PUBLIC_BACKEND_URL` dibaca saat build: setelah mengubahnya, lakukan Redeploy. Langkah lengkap
memasang Vercel ada di [`deploy/README.md`](../deploy/README.md).

## Mengubah tampilan

Cukup edit, lalu `git add -A`, `git commit`, `git push`. Vercel membangun ulang otomatis.

Ingin melihat hasil di laptop sebelum push (opsional, butuh Node.js 22): buat `web/.env.local` berisi
`NEXT_PUBLIC_BACKEND_URL=https://namaanda-cardiovest.hf.space`, lalu

```powershell
cd web
npm install
npm run dev
```

Buka http://localhost:3000. Halaman lokal ini memakai backend asli di Hugging Face, jadi tidak perlu Docker.

## Sumber data EKG

`state.live.source` di Redux berisi `"dataset"` (simulator) atau `"hardware"` (ESP32), dan ikut
diperbarui lewat Socket.IO. Untuk tombol switch:

```js
await api('/source', { method: 'POST', body: { source: 'hardware' } });
await api('/scenario', { method: 'POST', body: { name: 'serangan' } });
const { scenario, scenarios } = await api('/scenario');
```

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
