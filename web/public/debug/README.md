# Debug viewer

Halaman statis di `https://<vercel>/debug`, tanpa build. Ubah berkasnya, `git push`, selesai.

```
web/public/debug/
├── index.html        # struktur halaman: panel kendali kiri, papan data kanan, jendela koneksi
├── style.css         # token warna, tipografi, tata letak, tema gelap
├── config.js         # dibuat otomatis saat build (alamat backend), tidak ikut git
├── js/
│   ├── main.js       # titik masuk: menerima pesan alat dan mengisi tampilan
│   ├── presence.js   # status koneksi server, broker, alat + jendela "Alat terputus"
│   ├── controls.js   # Mode alat, Sumber EKG, Jenis rekaman, tombol Jalankan/Jeda
│   ├── connection.js # Socket.IO ke backend (namespace /debug)
│   ├── ecg.js        # dekoder paket EKG dan grafik kertas EKG
│   ├── map.js        # peta GPS (Leaflet)
│   ├── log.js        # riwayat kejadian
│   └── labels.js     # teks label, nama state, format angka dan waktu
└── vendor/           # socket.io client, Leaflet
```

## Alur data

Backend meneruskan pesan MQTT alat ke browser lewat Socket.IO `/debug`:

| Event | Isi | Dipakai oleh |
|---|---|---|
| `m` | `(topic, payload)` mentah: `ecg`, `vital`, `inference`, `state`, `alert`, `lwt`, `source` | `main.js`, handler sesuai bagian akhir topik |
| `presence` | `{ broker, device, seen }`: broker tersambung, alat mengirim data dalam 10 detik terakhir, waktu terakhir terlihat | `presence.js` |

EKG, vital, dan inferensi hanya ditampilkan saat tampilan berjalan. Jendela koneksi menutup seluruh halaman
(`inert`) sampai `presence.device` bernilai `true`.

Perintah dari halaman dikirim dengan `conn.send({ type, ... })`:

| type | isi | efek |
|---|---|---|
| `mode` | `mode: "demo" \| "test"` | perintah mode ke alat lewat layanan cloud |
| `source` | `source: "hardware" \| "dataset"`, `rekaman` | sumber EKG, disimpan retained di broker |

## Menambah tampilan

1. Tambahkan elemen dengan `id` di `index.html` (pakai pola `panel` atau `facts` yang sudah ada).
2. Isi elemen itu di handler yang sesuai di `main.js`, mis. `handlers.vital`.
3. Teks label baru ditaruh di `labels.js` supaya konsisten.

Menambah jenis rekaman: tambahkan `<label class="rek">` di grup yang sesuai di `index.html` (`value` = nama
morfologi di `replay_bank.npz`, `data-name` = nama lengkap), lalu tambahkan nilainya ke `REKAMAN` di
`server/lib/backend.js` dan `dataset/dataset/__main__.py`.

## Desain

| Token | Terang | Gelap | Pemakaian |
|---|---|---|---|
| `--page` / `--surface` | `#f3f4f7` / `#ffffff` | `#10141c` / `#181e2b` | latar halaman / panel |
| `--ink` / `--ink-soft` | `#1a2233` / `#5b6475` | `#e8ecf4` / `#a3abbd` | teks utama / keterangan; pilihan yang aktif |
| `--action` | `#2448c4` | `#8fb0ff` | satu-satunya tombol aksi: Jalankan |
| `--focus` | `#2f5bd3` | `#8fb0ff` | fokus keyboard, pilihan yang belum diterapkan |
| `--paper`, `--grid-minor`, `--grid-major` | `#fff6f6`, `#f6d3d6`, `#e9a3ab` | `#1c1719`, `#35242a`, `#5c3039` | kertas EKG (1 mm dan 5 mm) |
| `--ok` / `--warn` / `--crit` | `#1f8a5b` / `#b7791f` / `#c8323c` | `#3dbe84` / `#e3a33b` / `#f0535d` | Normal / Waspada / Darurat, juga warna grup rekaman |

Aturan tombol: pilihan (Mode, Sumber) berbentuk kartu dengan tanda centang, rekaman berbentuk chip berwarna
sesuai tingkat bahaya, dan hanya **Jalankan** yang berwarna penuh. Huruf: Atkinson Hyperlegible Next, sama dengan
aplikasi keluarga. Teks memakai huruf kecil biasa (sentence case), angka memakai format Indonesia (koma desimal).

Grafik EKG mengikuti kertas EKG standar: 25 mm/s, 10 mm/mV. Bila sinyal terlalu besar, skala turun
otomatis ke 5 atau 2,5 mm/mV dan tertulis di bawah grafik.

Mencoba di laptop tanpa Vercel: `cd web`, `npm install`, `npm run dev`, buka `http://localhost:3000/debug`.
