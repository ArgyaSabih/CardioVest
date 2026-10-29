# Debug viewer

Halaman statis di `https://<vercel>/debug`, tanpa build. Ubah berkasnya, `git push`, selesai.

```
web/public/debug/
├── index.html        # struktur halaman (semua elemen dan id)
├── style.css         # token warna, tipografi, tata letak, tema gelap
├── config.js         # dibuat otomatis saat build (alamat backend), tidak ikut git
├── js/
│   ├── main.js       # titik masuk: menerima pesan dan mengisi tampilan
│   ├── controls.js   # Mode alat, Sumber EKG, Jenis rekaman, tombol Jalankan/Jeda
│   ├── connection.js # Socket.IO ke backend (namespace /debug)
│   ├── ecg.js        # dekoder paket EKG dan grafik kertas EKG
│   ├── map.js        # peta GPS (Leaflet)
│   ├── log.js        # riwayat kejadian
│   └── labels.js     # semua teks label, nama state, format angka
└── vendor/           # socket.io client, Leaflet
```

## Alur data

Backend meneruskan pesan MQTT alat ke browser lewat Socket.IO `/debug` sebagai `(topic, payload)`.
`main.js` memilih handler berdasarkan bagian akhir topik: `ecg`, `vital`, `inference`, `state`,
`alert`, `lwt`, `source`, dan `status` (simulator). EKG, vital, dan inferensi hanya ditampilkan
saat tampilan berjalan.

Perintah dari halaman dikirim dengan `conn.send({ type, ... })`:

| type | isi | efek |
|---|---|---|
| `mode` | `mode: "demo" \| "test"` | perintah mode ke alat lewat layanan cloud |
| `source` | `source: "hardware" \| "dataset"`, `rekaman` | sumber EKG, disimpan retained di broker |
| `sim` | `cmd: {...}` | perintah simulator (hanya bila `SIMULATOR=1`) |

## Menambah tampilan

1. Tambahkan elemen dengan `id` di `index.html` (pakai pola `panel` atau `facts` yang sudah ada).
2. Isi elemen itu di handler yang sesuai di `main.js`, mis. `handlers.vital`.
3. Teks label baru ditaruh di `labels.js` supaya konsisten.

## Desain

| Token | Terang | Gelap | Pemakaian |
|---|---|---|---|
| `--page` / `--surface` | `#f5f6f8` / `#ffffff` | `#12161f` / `#1a2030` | latar halaman / panel |
| `--ink` / `--ink-soft` | `#1a2233` / `#5b6475` | `#e8ecf4` / `#a3abbd` | teks utama / keterangan |
| `--paper`, `--grid-minor`, `--grid-major` | `#fff6f6`, `#f6d3d6`, `#e9a3ab` | `#1c1719`, `#35242a`, `#5c3039` | kertas EKG (1 mm dan 5 mm) |
| `--ok` / `--warn` / `--crit` | `#1f8a5b` / `#b7791f` / `#c8323c` | `#3dbe84` / `#e3a33b` / `#f0535d` | Normal / Waspada / Darurat |
| `--focus` | `#2f5bd3` | `#8fb0ff` | fokus keyboard, tanda pilihan belum diterapkan |

Huruf: Atkinson Hyperlegible Next, sama dengan aplikasi keluarga. Teks memakai huruf kecil biasa
(sentence case), angka memakai format Indonesia (koma desimal).

Grafik EKG mengikuti kertas EKG standar: 25 mm/s, 10 mm/mV. Bila sinyal terlalu besar, skala turun
otomatis ke 5 atau 2,5 mm/mV dan tertulis di bawah grafik.

Mencoba di laptop tanpa Vercel: `cd web`, `npm install`, `npm run dev`, buka `http://localhost:3000/debug`.
