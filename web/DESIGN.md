---
name: CardioVest
description: Papan penunjuk rumah sakit di layar ponsel, untuk lansia yang memakai kaos pemantau jantung.
colors:
  sign-blue: "#0b3d91"
  sign-blue-press: "#072c6b"
  sign-tint: "#dde6f5"
  concrete: "#e9ebee"
  surface: "#ffffff"
  ink: "#111827"
  ink-muted: "#4b5563"
  line: "#cfd4db"
  line-strong: "#9aa3af"
  band-neutral: "#dfe3e8"
  led-green: "#12723f"
  led-green-tint: "#e3f1e8"
  led-amber: "#f2b705"
  amber-ink: "#241a00"
  warn-text: "#6b4a00"
  warn-tint: "#fff4cf"
  igd-red: "#c8102e"
  igd-red-deep: "#9e0c24"
  idle-gray: "#4b5563"
  ecg-paper: "#fff4f4"
  ecg-grid-minor: "#f6d3d3"
  ecg-grid-major: "#e59c9c"
typography:
  status:
    fontFamily: "Atkinson Hyperlegible, system-ui, sans-serif"
    fontSize: "2.6rem"
    fontWeight: 700
    lineHeight: 1
    letterSpacing: "-0.01em"
  status-critical:
    fontFamily: "Atkinson Hyperlegible, system-ui, sans-serif"
    fontSize: "3rem"
    fontWeight: 700
    lineHeight: 1
  sign-title:
    fontFamily: "Atkinson Hyperlegible, system-ui, sans-serif"
    fontSize: "1.45rem"
    fontWeight: 700
    lineHeight: 1.15
  heading:
    fontFamily: "Atkinson Hyperlegible, system-ui, sans-serif"
    fontSize: "1.3rem"
    fontWeight: 700
    lineHeight: 1.2
  body:
    fontFamily: "Atkinson Hyperlegible, system-ui, sans-serif"
    fontSize: "18px"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "Atkinson Hyperlegible, system-ui, sans-serif"
    fontSize: "0.9375rem"
    fontWeight: 700
    lineHeight: 1.3
  note:
    fontFamily: "Atkinson Hyperlegible, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.35
rounded:
  plate: "3px"
  control: "4px"
spacing:
  gutter: "16px"
  stack: "12px"
  section: "28px"
components:
  button-primary:
    backgroundColor: "{colors.sign-blue}"
    textColor: "{colors.surface}"
    rounded: "{rounded.control}"
    padding: "10px 18px"
    height: "52px"
  button-primary-hover:
    backgroundColor: "{colors.sign-blue-press}"
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.sign-blue}"
    rounded: "{rounded.control}"
    height: "52px"
  button-destructive:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.surface}"
    rounded: "{rounded.control}"
    height: "44px"
  button-emergency:
    backgroundColor: "{colors.igd-red-deep}"
    textColor: "{colors.surface}"
    rounded: "{rounded.control}"
    height: "72px"
  signbar:
    backgroundColor: "{colors.sign-blue}"
    textColor: "{colors.surface}"
    typography: "{typography.sign-title}"
    height: "60px"
  plate-normal:
    backgroundColor: "{colors.led-green}"
    textColor: "{colors.surface}"
    typography: "{typography.status}"
  plate-warning:
    backgroundColor: "{colors.led-amber}"
    textColor: "{colors.amber-ink}"
    typography: "{typography.status}"
  plate-critical:
    backgroundColor: "{colors.igd-red}"
    textColor: "{colors.surface}"
    typography: "{typography.status-critical}"
  plate-unmonitored:
    backgroundColor: "{colors.idle-gray}"
    textColor: "{colors.surface}"
  vital-plate:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    height: "52px"
  bottom-nav:
    backgroundColor: "{colors.sign-blue}"
    textColor: "{colors.surface}"
    height: "64px"
---

# Design System: CardioVest

## Overview

**Creative North Star: "Papan penunjuk rumah sakit yang Anda percaya."**

Pemakai CardioVest adalah lansia yang matanya mulai rabun dan membuka aplikasi siang hari di rumah.
Aplikasi ini meminjam bahasa rambu rumah sakit Indonesia, karena itulah bahasa visual kesehatan yang
paling akrab dan paling mudah dibaca bagi mereka: strip biru tua dengan huruf putih untuk arah, pelat
berwarna penuh untuk status, piktogram tebal, dan panah yang menunjuk tujuan. Warna pelat status sama
dengan LED tiga warna di alat, jadi apa yang menyala di dada sama dengan yang terlihat di layar.

Dunia ini menolak dua hal:
- dasbor petak-petak ala aplikasi SaaS;
- monitor bedside hitam dengan garis neon.

Satu-satunya ornamen adalah kertas EKG, karena ornamen itu berguna.

**Key Characteristics:**
- Satu pelat status selebar dinding, berisi satu kata, satu piktogram, dan satu kalimat tindakan.
- Strip papan penunjuk biru sebagai judul halaman, judul bagian, dan navigasi bawah.
- Daftar seperti papan direktori: kotak putih bergaris, panah biru menunjuk ke detail.
- Kontras tinggi di mana pun. Teks keterangan minimal 16 px.

## Colors

### Primary
- **Biru papan penunjuk (`sign-blue` #0b3d91):** strip, navigasi, tombol utama, tautan, dan cincin fokus.
  Biru tidak pernah dipakai untuk status.

### Status (warna LED alat)
- **Hijau LED (`led-green`):** pelat Normal, tanda "sudah menerima kabar", dan notifikasi aktif.
- **Kuning rambu (`led-amber`):** pelat Waspada. Teks di atasnya selalu `amber-ink`.
- **Merah IGD (`igd-red`, `igd-red-deep`):** hanya untuk pelat Darurat dan tombol telepon 119.
- **Abu pelat (`idle-gray`):** pelat "Tidak terpantau" saat alat tidak mengirim data.

### Neutral
- **Beton (`concrete`):** dasar halaman, seperti dinding koridor rumah sakit.
- **Putih (`surface`):** isi pelat kecil, daftar, dan formulir.
- **Tinta (`ink`):** teks, bingkai EKG, kepala hari di Riwayat, aksi yang merusak (hapus, lepas alat),
  pesan galat, dan catatan penting (`.note-warn`). Keterangan yang perlu perhatian ("belum diverifikasi")
  memakai `ink-muted` tebal, bukan kuning.
- **Pita netral (`band-neutral`):** pita "wajar saat istirahat" di grafik tren.

### Named Rules
**Aturan Satu Warna Satu Arti.** Merah hanya untuk Darurat, kuning hanya untuk Waspada, hijau hanya untuk
aman atau sudah. Aksi hapus dan pesan galat memakai tinta, bukan merah. Hiasan berwarna dilarang.

**Aturan Kertas EKG.** Grafik EKG selalu di atas kisi kertas EKG standar (25 mm/s, 10 mm/mV) dengan
bingkai tinta 3–4 px.

## Typography

**Huruf:** Atkinson Hyperlegible untuk semuanya, di-host sendiri lewat @fontsource. Huruf ini dirancang
untuk pembaca berpenglihatan rendah. Angka nol bergaris miring disengaja supaya 0 dan O tidak tertukar di
nomor HP. Ukuran dasar 18 px.

### Hierarchy
- **Status** (700, 2.6rem; Darurat 3rem): satu kata di pelat status.
- **Judul papan** (700, 1.45rem): strip biru di atas halaman.
- **Judul bagian** (700, 1.3rem; di Akun menjadi strip biru 1.15rem).
- **Isi** (400, 18 px, line-height 1.5).
- **Label** (700, 0.9375rem): kepala pelat vital dan label formulir.
- **Keterangan** (400, 1rem): batas bawah ukuran teks, kecuali label navigasi (0.875rem, tebal).

### Named Rules
**Aturan Angka Tabular.** Jam, tanggal, nomor HP, dan angka vital memakai `tabular-nums`.

## Layout

- **Kolom:** satu kolom, maksimal 480 px, gutter 16 px.
- **Layar lebar (≥520 px):** strip papan, panel merek, dan navigasi bawah tetap selebar layar
  (box-shadow + clip-path). Pelat status, EKG, dan isi lain tetap di kolom 480 px.
- **Pelat vital:** `flex: 1 1 6rem`, melipat sendiri di layar sempit dan saat zoom 200 %. Satuan turun ke
  bawah angka bila tidak muat.
- **Jarak:** antarbagian 28 px. Halaman memberi 112 px ruang di bawah untuk navigasi.

## Elevation & Depth

Rata. Kedalaman datang dari garis tepi: pelat punya garis tepi dalam putih 2 px seperti rambu, dan EKG
dibingkai tinta. Satu-satunya bayangan ada pada bilah 119 yang menempel saat menggulir
(`0 -4px 14px`), karena bilah itu benar-benar mengambang di atas isi.

## Shapes

- **Sudut:** 3 px untuk pelat dan strip, 4 px untuk tombol dan kotak isian. Rambu tidak bulat dan
  tidak berbentuk pil.
- **Piktogram (`components/icons.jsx`):** grid 24 px, garis 2,2–2,6 px, ujung bulat.

## Components

- **Pelat status (`.plate`):** piktogram dalam kotak bergaris, kata status, satu kalimat yang dimulai
  dengan tindakan, lalu tindakan untuk status itu. Saat status berubah, pelat berputar sekali seperti
  papan putar (rotateX 320 ms); gerak ini mati saat reduced motion.
- **Strip merek (Beranda):**
  - "CardioVest" di kiri.
  - Penanda koneksi (`Connection`) di kanan, berupa piktogram EKG yang berdenyut mengikuti denyut
    pemakai.
  - Saat terputus, penanda berubah menjadi label putih bersudut dengan piktogram terputus.
  - Di layar ≤360 px, kata "Alat terhubung" disembunyikan secara visual (tetap terbaca pembaca layar);
    kata "Alat terputus" selalu terlihat.
- **Strip papan (`SignBar`):** judul halaman dengan piktogram. Versi merah untuk kejadian Darurat, versi
  kuning untuk Waspada.
- **Tombol:**
  - Tinggi minimal 52 px, teks seimbang (`text-wrap: balance`).
  - Tombol utama biru penuh; tombol kedua bergaris biru.
  - Aksi merusak bergaris atau berisi tinta.
  - Di pelat kuning, tombol memakai `amber-ink`; di pelat merah, tombol 119 putih.
- **Darurat:**
  - Hanya satu tombol besar, yaitu 119 (72 px).
  - Kontak keluarga menjadi tombol sekunder, dan 112 menjadi tautan teks.
  - Bilah 119 menempel di atas navigasi saat tombol utama tergulir keluar layar.
- **Pelat vital:** kepala biru dengan piktogram, isi putih dengan angka atau kata ("Wajar", "Lebih
  banyak"). Kepala menjadi merah saat Darurat abnormal dan abu saat data lama.
- **Papan direktori:**
  - Kontak dan Riwayat ditampilkan dalam kotak putih bergaris 2 px, dengan panah biru di kanan.
  - Riwayat dikelompokkan per hari dengan kepala hari berwarna tinta.
  - Riwayat hanya berisi bahasa biasa; persentase model hanya ada di detail kejadian.
- **Konfirmasi (`.confirm`):** muncul di tempat, putih bergaris tinta, tombolnya menyebut aksinya.
- **Galat (`.error`):** tinta di atas putih dengan piktogram peringatan.
- **Navigasi bawah:** papan penunjuk biru. Tab aktif menjadi pelat putih dengan teks biru.
- **Disclaimer:** pelat kecil bergaris 2 px di bawah setiap halaman, dengan "telepon 119" yang bisa
  ditekan.

## Do's and Don'ts

**Do**
- Mulai setiap status dengan satu kalimat tindakan.
- Tampilkan "Tidak terpantau", bukan "Normal", saat alat tidak mengirim data.
- Pakai kata ("Wajar", "Tinggi") di samping warna.
- Pakai panah piktogram untuk menunjuk tujuan.

**Don't**
- Jangan pakai merah, kuning, atau hijau di luar artinya, termasuk untuk tombol hapus.
- Jangan pakai `confirm()` atau `prompt()` bawaan browser.
- Jangan pakai emoji atau karakter panah sebagai ikon.
- Jangan pakai bentuk pil, gradien, atau bayangan sebagai hiasan.
- Jangan menampilkan istilah sistem ("window", "cross-validation", "R(t)") atau persentase model di
  Beranda maupun daftar Riwayat.
