# Lead I atau Lead II? Pengaruh posisi elektroda pada deteksi

Laporan tim memakai Lead I (elektroda di kiri-kanan dada atas kaos). Model produksi juga dilatih dari
Lead I PTB-XL. Model itu paling lemah pada infark **inferior**, dengan sensitivity 0,38. Pertanyaannya:
apakah memindahkan satu elektroda ke posisi Lead II (kanan atas → kiri bawah perut) akan membantu?

## Cara uji

- Dua dataset dari rekaman yang **sama** (`prepare.py --lead I` dan `--lead II`, PTB-XL records100 +
  MIT-BIH MLII). Satu-satunya perbedaan adalah lead PTB-XL yang diambil.
- Dilatih dengan `train_real.py` yang sama: seed sama, split pasien sama (3.483 window uji dari
  2.507 pasien yang tidak dilihat saat latihan).
- Dibandingkan berpasangan, window demi window, dengan `cloud/model/bandingkan_lead.py`. Interval
  kepercayaan 95% dihitung dengan bootstrap per pasien.
- Latih ulang Lead I mereproduksi model produksi dengan dekat (akurasi 0,630 vs 0,633), jadi pembandingnya adil.

## Hasil pada set uji PTB-XL + MIT-BIH

Selisih = Lead II − Lead I pada window yang sama. Tanda ✱ berarti interval 95% tidak memuat nol.

| Kelompok | n window (pasien) | Lead I | Lead II | Selisih | CI 95% |
|---|---|---|---|---|---|
| Akurasi keseluruhan | 3.483 (2.507) | 0,630 | 0,655 | +0,025 | [+0,001; +0,049] ✱ |
| Sensitivity Normal | 1.351 (1.049) | 0,806 | 0,821 | +0,015 | [−0,007; +0,036] |
| Sensitivity Pra-Serangan | 1.521 (997) | 0,518 | 0,545 | +0,027 | [−0,020; +0,079] |
| Sensitivity Serangan | 611 (535) | 0,520 | 0,563 | +0,043 | [−0,015; +0,102] |
| Depresi ST | 511 (456) | 0,448 | 0,546 | +0,098 | [+0,032; +0,162] ✱ |
| Gangguan konduksi (CD) | 470 (328) | 0,419 | 0,355 | −0,064 | [−0,132; −0,003] ✱ |
| AF | 288 (136) | 0,677 | 0,663 | −0,014 | [−0,096; +0,148] |
| PVC | 223 (97) | 0,686 | 0,785 | +0,099 | [−0,037; +0,222] |
| **Infark inferior** | 333 (294) | **0,417** | **0,709** | **+0,291** | [+0,211; +0,367] ✱ |
| **Infark anterior/anteroseptal** | 367 (325) | **0,635** | **0,485** | **−0,150** | [−0,217; −0,083] ✱ |
| Infark lateral | 15 (13) | 0,667 | 0,267 | −0,400 | [−0,667; −0,125] ✱ (sampel sangat kecil) |

## Hasil pada data lain

| | Lead I | Lead II |
|---|---|---|
| Episode VT/VF kontinu CUDB+VFDB, CRITICAL ≤ 30 s (τ 0,44, N=2) | 98% | 100% |
| WARNING palsu per jam, 18 jam wearable BUT QDB (τ 0,44, N=2) | 6,35 | 7,63 |
| idem, N=3 | 2,84 | 4,18 |

Catatan: posisi elektroda alat Faros di BUT QDB tidak diketahui, jadi baris alarm palsu tidak bisa
memihak lead mana pun. Model produksi Lead I sendiri memberi 5,85 di uji yang sama, sehingga variasi
antar-pelatihan sudah sekitar 10%.

## Kesimpulan

**Lead II tidak lebih baik secara umum. Ia memindahkan titik buta model.** Infark inferior yang paling
sering terlewat oleh Lead I (0,42) naik menjadi 0,71. Sebaliknya, infark anterior turun dari 0,63 ke
0,49, dan infark lateral ikut turun (meski datanya sangat sedikit). Pola ini cocok dengan anatomi:
dinding inferior jantung "dilihat" oleh lead II, III, dan aVF, sedangkan dinding lateral/anterior atas
lebih terlihat dari lead I dan aVL. Untuk kelas Serangan secara keseluruhan, selisihnya (+0,04) belum
bisa dibedakan dari kebetulan.

Rekomendasi:

1. **Model produksi tetap Lead I**, sesuai rancangan laporan dan posisi elektroda kaos yang sudah
   dibuat. Mengganti lead berarti menukar satu jenis infark yang terlewat dengan jenis lain, bukan
   perbaikan yang jelas.
2. **Bila hardware masih bisa diubah, dua lead jauh lebih menjanjikan daripada memilih salah satu.**
   Dengan Lead I dan Lead II terekam bersamaan (dua modul AD8232 berbagi elektroda RA, kanal kedua di
   pin ADC1 yang masih kosong seperti GPIO 36/39), keempat lead ekstremitas lainnya bisa dihitung tanpa
   elektroda tambahan (III = II − I, aVF = II − I/2, dst. menurut hukum Einthoven). Model dua kanal
   kemungkinan menutup kedua titik buta sekaligus. Ini perlu dibuktikan dengan pelatihan baru, dan
   jalurnya sudah ada (`prepare.py` tinggal mengambil dua kanal).
3. **Sebutkan keterbatasan ini di laporan.** "Sensitivity infark inferior sekitar 0,4 karena memakai Lead I"
   adalah temuan yang jujur dan bisa dipertanggungjawabkan saat sidang, apalagi disertai data
   pembandingnya.

## Batasan

- Satu kali pelatihan per lead. Variasi antar-pelatihan (sekitar ±2 poin akurasi) bisa sebesar
  sebagian selisih yang kecil; karena itu yang dipercaya hanya selisih dengan interval yang tidak
  memuat nol.
- Lead II di kaos berarti satu elektroda di perut kiri bawah, yang lebih mudah bergeser saat duduk dan
  membungkuk. Artefak gerak Lead II pada kaos belum diukur.
- Kelas Serangan PTB-XL mencampur infark akut dan lama.
