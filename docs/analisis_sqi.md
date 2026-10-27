# Gerbang kualitas sinyal ECG: apa yang ditahan, apa yang tidak boleh ditahan

Kode: `cloud/cloud/signal_quality.py`. Angka di dokumen ini bisa diulang dengan
`python tools/analisis_sqi.py` (hasil mentahnya ada di `docs/analisis_sqi.json`).

## Kenapa perlu gerbang

CNN selalu mengeluarkan salah satu dari tiga kelas, apa pun masukannya. Sebelum window dinormalisasi
Z-score, sinyal datar atau derau gesekan kaos tidak bisa dibedakan dari ECG. Akibatnya, kalau elektroda
lepas, cloud bisa saja "melihat" serangan jantung.

Masalahnya, gerbang yang terlalu rajin sama berbahayanya. Fibrilasi ventrikel (VF) memang tidak
berbentuk seperti ECG normal, jadi aturan SQI yang umum di literatur ikut menolaknya. Padahal VF
adalah ritme yang paling butuh alarm.

## Data uji

| Sumber | Isi | Dipakai untuk |
|---|---|---|
| Bank replay simulator | 1.414 window PTB-XL/MIT-BIH per kondisi | ritme klinis tidak boleh tertahan |
| CUDB (Creighton) + VFDB (MIT-BIH Malignant Ventricular Ectopy) | 56 rekaman, 1.044 window VF, 104 flutter, 1.385 VT, 1.618 derau beranotasi | VF/VT nyata dari sumber yang **tidak** dipakai melatih model |
| BUT QDB (Brno) | 18 rekaman Bittium Faros 180 saat aktivitas harian, kualitas dianotasi konsensus: kelas 1 (P-QRS-T jelas), 2 (QRS jelas), 3 (tidak layak dianalisis) | sinyal wearable sungguhan, termasuk yang rusak |

Window BUT QDB diturunkan ke 250 Hz lalu dilewatkan FIR 0,5–40 Hz 501 tap dan notch 50 Hz yang sama
dengan firmware, supaya yang dinilai mirip dengan yang benar-benar sampai di cloud.

## Temuan

**1. Ambang SQI tunggal dari literatur tidak bisa dipakai di sini.** Aturan kSQI < 5 (kurtosis, Li dkk.
2008) menolak 100% window VF di bank replay dan 97% window VF di CUDB/VFDB. pSQI di luar 0,5–0,8 menolak
semua VT. basSQI tidak berguna karena firmware sudah membuang baseline sebelum data dikirim.

**2. Gerbang lama terlalu longgar untuk sinyal wearable.** Aturan datar/lead-off/saturasi hanya menahan
6,8% window kelas 3. Di sisi lain, CNN membaca **77,9%** window kelas 3 itu sebagai *Serangan* dengan
keyakinan di atas τ = 0,44.

**3. Kombinasi dua indeks bisa memisahkan derau dari VF.** Derau gerak tidak punya puncak yang menonjol
(kSQI rendah) dan dayanya tersebar ke frekuensi tinggi (pSQI rendah). VF juga berkurtosis rendah, tetapi
dayanya terpusat di 3–7 Hz sehingga pSQI-nya tinggi. Median pSQI VF = 0,94, dengan persentil 10 = 0,82
di CUDB/VFDB. Aturan yang dipakai sekarang:

```
tahan bila  kSQI < 4  DAN  pSQI < 0,5
```

| | Ditahan sebelum | Ditahan sesudah |
|---|---|---|
| BUT QDB kelas 1 | 0% | 0% |
| BUT QDB kelas 2 | 0% | 0% |
| BUT QDB kelas 3 | 6,8% | **42,1%** |
| Bank: semua ritme (normal, iskemia, STEMI, AF, PVC, SVT, VT, VF) | 0% | 0% |
| CUDB/VFDB: VF | 0% | 0,3% (3 dari 1.044) |
| CUDB/VFDB: VT | 0,1% | 1,2% (17 dari 1.385) |

Window kelas 3 yang terbaca non-Normal *dan* lolos gerbang turun dari 79,6% ke 47,5%.

**4. Window VF/VT yang ikut tertahan tidak membuat alarm hilang.** Ketiga window VF yang tertahan adalah
window tunggal di tengah episode. Window VT yang tertahan juga paling banyak 2 berturut-turut. Di
`service.py`, window yang tertahan tidak ikut dihitung (bukan dianggap Normal), sehingga hitungan
persistence FSM tidak ter-reset. Efek terburuknya adalah alarm tertunda 3,5–7 detik. Uji episode
kontinu di `docs/analisis_alarm_palsu.md` memastikan hal ini: 100% episode VT/VF ≥ 20 s tetap mencapai
WARNING dalam 30 detik, dengan gerbang aktif.

**5. Saturasi tidak lagi memblokir.** Dengan penguatan AD8232 sebesar 1100 dan ADC 3,3 V, sinyal alat ini
sudah terpotong di sekitar ±1,5 mV, sehingga aturan "> 5% sampel melewati ±5 mV" tidak akan pernah
terpicu oleh alat. Di VFDB, aturan itu justru menahan 2 window VT asli yang amplitudonya besar. Nilainya
tetap dicatat di kolom `quality`.

## Yang belum terselesaikan

- Lebih dari separuh window kelas 3 masih lolos. Umumnya window ini masih punya puncak tajam (median
  kSQI 5,9), misalnya lonjakan gerak yang mirip QRS. Menangkapnya butuh informasi lain, seperti
  akselerometer (sudah dikirim alat) atau kecocokan dua detektor QRS (bSQI). Itu langkah berikutnya
  yang masuk akal.
- Derau beranotasi di VFDB (rekaman Holter rumah sakit) hampir tidak tertahan (0,7%). Polanya berbeda
  dari derau gerak wearable, jadi jangan menganggap gerbang ini menangkap semua jenis derau.
- Elektroda Faros tidak sama dengan Lead I kaos CardioVest. Ambang 4 dan 0,5 sebaiknya dicek ulang
  dengan rekaman alat sendiri. Kolom `quality` di tabel `inferences` sudah menyimpan kSQI dan pSQI tiap
  window untuk keperluan itu.

## Rujukan

- Li Q, Mark RG, Clifford GD. Robust heart rate estimation from multiple asynchronous noisy sources
  using signal quality indices and a Kalman filter. *Physiol Meas.* 2008;29(1):15–32.
- Clifford GD, Behar J, Li Q, Rezek I. Signal quality indices and data fusion for determining
  clinical acceptability of electrocardiograms. *Physiol Meas.* 2012;33(9):1419–1433.
- Orphanidou C, dkk. Signal-quality indices for the electrocardiogram and photoplethysmogram:
  derivation and applications to wireless monitoring. *IEEE J Biomed Health Inform.* 2015;19(3):832–838.
- Nemcova A, dkk. Brno University of Technology ECG Quality Database (BUT QDB), v1.0.0. PhysioNet, 2020.
- Nolle FM, dkk. CREI-GARD, a new concept in computerized arrhythmia monitoring systems. *Computers in
  Cardiology* 1986;13:515–518 (CUDB).
- Greenwald SD. *Development and analysis of a ventricular fibrillation detector.* Tesis M.S., MIT, 1986 (VFDB).
- Goldberger AL, dkk. PhysioBank, PhysioToolkit, and PhysioNet. *Circulation.* 2000;101(23):e215–e220.
