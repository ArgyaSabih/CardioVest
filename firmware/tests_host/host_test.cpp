// Uji algoritma firmware di PC (tanpa ESP32). Dipanggil oleh test_firmware_algos.py.
//   host_test ecg   <in.txt>  : sampel keluaran AD8232 (mV di pin ADC, 250 Hz) -> rantai filter + Pan-Tompkins
//                               keluaran: baris "HR <bpm>" tiap 1 s dan "Y <mV>" per sampel terfilter
//   host_test fircoef <dummy> : koefisien FIR band-pass (dibandingkan dengan scipy.signal.firwin)
//   host_test vital <in.txt> : JSON vital + event firmware (ArduinoJson) untuk diuji terhadap cloud
//   host_test codec <in.txt> <out.bin> : "seq t0 buffered" lalu 875 sampel int16 -> paket biner
//   host_test fall  <in.txt>  : |a| (g) 100 Hz -> waktu deteksi jatuh (ms)
//   host_test ppg   <in.txt>  : IR MAX30102 50 Hz -> "HR <bpm> SQI <0..1>" tiap 1 s
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <vector>
#include "dsp.h"
#include "algo.h"
#include "ecg_codec.h"
#include "payload.h"

static std::vector<double> read_nums(const char* path) {
  std::vector<double> v; FILE* f = fopen(path, "r"); double x;
  while (f && fscanf(f, "%lf", &x) == 1) v.push_back(x);
  if (f) fclose(f);
  return v;
}

int main(int argc, char** argv) {
  if (argc < 3) return 2;
  std::vector<double> in = read_nums(argv[2]);
  if (!strcmp(argv[1], "ecg")) {
    DcBlocker dc(ECG_FS); Biquad nt; nt.notch(ECG_FS, NOTCH_HZ);
    static FirBandpass fir; fir.design(ECG_FS, 0.5f, 40.0f, ECG_FIR_TAPS);
    AdaptiveKalman kf(KALMAN_Q, KALMAN_R0, KALMAN_R_MOTION);
    PanTompkins pt(ECG_FS);
    for (size_t i = 0; i < in.size(); ++i) {
      float x = nt.process(fir.process(dc.process((float)in[i] / ECG_GAIN)));
      float y = kf.update(x, 0.0f);
      if (pt.update(y)) printf("B %zu\n", i);
      printf("Y %.5f\n", y);
      if (i % ECG_FS == ECG_FS - 1) { float h = pt.heartRate(); printf("HR %.2f\n", isnan(h) ? -1.0f : h); }
    }
  } else if (!strcmp(argv[1], "fircoef")) {
    static FirBandpass fir; fir.design(ECG_FS, 0.5f, 40.0f, ECG_FIR_TAPS);
    for (int i = 0; i < ECG_FIR_TAPS; ++i) printf("%.9g\n", fir.coef(i));
  } else if (!strcmp(argv[1], "vital")) {
    // in: ppg_ok hr_ppg sqi gsr_ok gsr imu_ok ax ay az fall gps_active gps_fix lat lon hr_ecg state
    Vitals v; v.ppg_ok = in[0]; v.hr_ppg = in[1] < 0 ? NAN : in[1]; v.sqi = in[2];
    v.gsr_ok = in[3]; v.gsr_us = in[4]; v.imu_ok = in[5]; v.ax = in[6]; v.ay = in[7]; v.az = in[8];
    v.amag = sqrtf(v.ax * v.ax + v.ay * v.ay + v.az * v.az); v.fall_detected = in[9]; v.fall_ts = in[9] ? 1790699999000ULL : 0;
    GpsFix g; g.active = in[10]; g.fix = in[11]; g.lat = in[12]; g.lon = in[13]; g.accuracy_m = 5.2f; g.sats = 8;
    g_state = (DevState)(int)in[15];
    static char out[1024];
    size_t n = encode_vital_json(v, in[14] < 0 ? NAN : in[14], g, false, out, sizeof(out));
    fwrite(out, 1, n, stdout);
    n = encode_event_json(EV_HARDWARE_RESET, out, sizeof(out));
    printf("\n"); fwrite(out, 1, n, stdout);
  } else if (!strcmp(argv[1], "codec")) {
    static EcgPacket p; p.seq = (uint32_t)in[0]; p.t0_ms = (uint64_t)in[1]; bool buf = in[2] != 0;
    int fl = (int)in[2];                       // bit0 buffered, bit1 lead_off, bit2 jam belum sinkron
    buf = fl & 1; p.lead_off = fl & 2; p.clock_ok = !(fl & 4);
    for (int i = 0; i < ECG_HOP; ++i) p.s[i] = (int16_t)in[3 + i];
    static uint8_t out[20 + 2 + ECG_HOP * 3];
    size_t n = encode_ecg_binary(p, buf, out, sizeof(out));
    FILE* f = fopen(argv[3], "wb"); fwrite(out, 1, n, f); fclose(f);
    static char js[8192];
    size_t m = encode_ecg_json(p, buf, js, sizeof(js));
    f = fopen((std::string(argv[3]) + ".json").c_str(), "wb"); fwrite(js, 1, m, f); fclose(f);
  } else if (!strcmp(argv[1], "fall")) {
    FallDetector fd;
    for (size_t i = 0; i < in.size(); ++i) if (fd.update((float)in[i], (uint32_t)(i * 10))) printf("FALL %zu\n", i * 10);
  } else if (!strcmp(argv[1], "ppg")) {
    PpgProcessor p;
    for (size_t i = 0; i < in.size(); ++i) {
      p.add((uint32_t)in[i], (uint32_t)(i * 20));
      if (i % 50 == 49) { float h = p.hr(); printf("HR %.2f SQI %.3f\n", isnan(h) ? -1.0f : h, p.sqi()); }
    }
  }
  return 0;
}
