# Alarm palsu saat dipakai sehari-hari, dan berapa harga untuk menekannya

Skrip: `tools/uji_alarm_palsu.py` (alarm palsu), `tools/uji_sensitivitas.py` (yang terlewat),
`tools/kalibrasi_lapangan.py` (mengulang analisis yang sama dengan data alat sendiri).

## Ringkasnya

Model dan FSM yang sekarang lolos semua skenario simulator. Namun, ketika diberi ECG wearable dari
orang sehat yang sedang beraktivitas biasa, FSM menghasilkan sekitar **6 WARNING palsu per jam**. Kalau
angka ini terulang di alat CardioVest, keluarga akan berhenti memercayai notifikasinya dalam satu hari.

Penyebabnya bukan derau, karena 99,9% sinyal di uji ini berkualitas baik. Penyebabnya adalah CNN yang
membaca 23% window ECG normal dari alat wearable sebagai *Pra-Serangan* dan 6% sebagai *Serangan*.
Model dilatih dari ECG klinis 12-lead (PTB-XL) dengan elektroda di pergelangan, sedangkan alat wearable
merekam dari posisi lain, di badan yang bergerak. Pada data klinis set uji, hanya 12% window Normal yang
salah baca. Selisih inilah yang biasa disebut *domain shift*.

## Cara uji

18 rekaman BUT QDB (Bittium Faros 180), masing-masing 60 menit kontinu (total 18 jam, 18.468 window).
ECG diproses seperti di CardioVest (250 Hz, filter firmware, window 7 s/hop 3,5 s, gerbang kualitas,
CNN asli, DecisionEngine asli). Status gerak diambil dari akselerometer Faros dengan rumus yang sama
dengan `DecisionEngine.activity` (median simpangan baku |a| per detik selama 7 detik, ambang 0,08 g).
Selama 10% waktu, subjek terdeteksi bergerak.

BUT QDB tidak punya GSR dan HR PPG. Karena itu yang diukur adalah WARNING, yang memang tidak
membutuhkan validator. Subjek tidak sedang mengalami kejadian jantung, sehingga semua WARNING dihitung
palsu.

## Alarm palsu per jam

| Setelan | WARNING palsu / jam |
|---|---|
| τ 0,44, N = 2 (sekarang) | **5,7** |
| τ 0,44, N = 2, **N_pra = 4** | **1,95** |
| τ 0,44, N = 3 | 1,95 |
| τ 0,44, N = 3, N_pra = 6 | 1,06 |
| τ 0,50, N = 3, N_pra = 4 | 1,00 |
| τ 0,60, N = 3, N_pra = 6 | 0,45 |
| τ 0,70, N = 3, N_pra = 4 | 0,22 |

`N_pra` adalah setelan baru `PERSIST_N_PRE`, yaitu persistence khusus ketika window terakhir berkelas
Pra-Serangan. Default-nya 0, artinya sama dengan N, sehingga perilaku sesuai BAB 4 tidak berubah.

## Yang dikorbankan

**VT/VF.** Pada 53 episode VT/VF/flutter kontinu ≥ 20 s dari CUDB dan VFDB (sumber yang tidak dipakai
melatih model), semua setelan di atas, sampai τ 0,80, tetap mencapai WARNING dalam 30 detik pada
100% episode dan CRITICAL pada 98% episode (dengan anggapan validator positif). Latensi median:
10,5 s pada N = 2 dan 14,0 s pada N = 3. Model sangat yakin pada ritme ventrikel, jadi τ tidak
mengganggunya.

**STEMI dan iskemia.** Di sinilah τ menjadi mahal. Peluang satu window STEMI dari set uji PTB-XL
terbaca non-Normal di atas τ:

| τ | 0,44 | 0,50 | 0,60 | 0,70 | 0,80 |
|---|---|---|---|---|---|
| STEMI | 0,73 | 0,58 | 0,37 | 0,22 | 0,05 |
| Depresi ST | 0,73 | 0,63 | 0,15 | 0,02 | 0,00 |
| AF | 0,90 | 0,82 | 0,32 | 0,10 | 0,05 |
| Normal (salah baca) | 0,12 | 0,05 | 0,00 | 0,00 | 0,00 |

Dengan τ = 0,7, alarm palsu memang hampir hilang, tetapi kebanyakan serangan juga ikut terlewat. Jadi
menaikkan τ bukan solusi.

## Rekomendasi

1. **Pertimbangkan `PERSIST_N_PRE=4` sejak uji pertama.** Alarm palsu turun hampir sepertiganya
   (5,7 → 1,95 per jam), sensitivitas kelas Serangan tidak berubah sama sekali, dan Pra-Serangan hanya
   tertunda 7 detik. Iskemia dan AF tidak berubah fatal dalam hitungan detik. Keputusan ini mengubah
   parameter yang ditulis di laporan (N = 2 untuk semua kelas), jadi biarkan tim yang memutuskan.
   Bila dipakai, skenario `sqi_rendah` di `tools/uji_skenario.py` akan menunjukkan "/4 window", bukan
   "/3 window".
2. **Ukur ulang dengan alat sendiri sebelum memilih angka.** Elektroda kaos CardioVest tidak sama dengan
   Faros. Hasilnya bisa lebih baik (karena Lead I, sama dengan data latih) atau lebih buruk (karena
   elektroda kering bergeser). Caranya: pakai alat 6–8 jam saat sehat (duduk, jalan, kerja), lalu
   ```
   docker compose exec cloud python -c "import sqlite3; sqlite3.connect('/data/cardiovest.db').execute(\"VACUUM INTO '/export/cardiovest.db'\")"
   python tools/kalibrasi_lapangan.py --db data/export/cardiovest.db --dari "2026-11-02 08:00" --sampai "2026-11-02 16:00"
   ```
   Skrip ini memutar ulang semua window yang tersimpan dengan berbagai τ/N/N_pra, lalu menampilkan
   alarm palsu per jam di samping sensitivitas STEMI pada τ yang sama.
3. **Kalau tetap di atas 1 alarm palsu per 4 jam, perbaikannya ada di model.** Rekaman dari alat yang
   dipakai orang sehat adalah data Normal yang paling berharga, karena itulah domain yang belum pernah
   dilihat model. Beberapa jam rekaman dari beberapa orang, dicampur ke data latih kelas Normal
   (fine-tuning), biasanya jauh lebih efektif daripada mengutak-atik ambang. Tabel `ecg` di database
   cloud sudah menyimpan sampel mentah setiap paket.

## Batasan uji ini

- Posisi elektroda Faros berbeda dari Lead I. Angka di atas adalah perkiraan arah, bukan janji.
- Sensitivitas STEMI per window dari rekaman 10 detik tidak bisa langsung diubah menjadi peluang
  terdeteksinya satu kejadian. Window berturut-turut dari pasien yang sama saling berkorelasi, jadi
  p^N terlalu pesimis.
- CRITICAL palsu tidak bisa diukur tanpa GSR/HR. Dua validator itu adalah pengaman utama terhadap
  CRITICAL palsu dan tidak diuji di sini.
