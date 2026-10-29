#include <Wire.h>
#include <math.h>

#define PIN_SDA 21
#define PIN_SCL 22
#define I2C_HZ 100000
#define MAX_ADDR 0x57
#define LED_ARUS_AWAL 0x1F
#define KONTAK_MIN 50000
#define JENUH 262143
#define TAU_SQI 0.50f
#define DURASI_LAJU_MS 5000
#define DURASI_SINYAL_MS 10000
#define TUNGGU_KONTAK_MS 20000
#define TUNGGU_LEPAS_MS 10000

#define REG_INT_STATUS1 0x00
#define REG_FIFO_WR 0x04
#define REG_FIFO_OVF 0x05
#define REG_FIFO_RD 0x06
#define REG_FIFO_DATA 0x07
#define REG_FIFO_CFG 0x08
#define REG_MODE 0x09
#define REG_SPO2_CFG 0x0A
#define REG_LED_RED 0x0C
#define REG_LED_IR 0x0D
#define REG_TEMP_INT 0x1F
#define REG_TEMP_FRAC 0x20
#define REG_TEMP_EN 0x21
#define REG_REV_ID 0xFE
#define REG_PART_ID 0xFF

#define NILAI_FIFO_CFG 0x70
#define NILAI_MODE 0x03
#define NILAI_SPO2_CFG 0x6F

#define FS_PPG 50
#define JENDELA 250

enum Mode { MODE_DIAM, MODE_ALIR, MODE_PLOT };

struct Cuplikan {
  uint32_t red;
  uint32_t ir;
};

struct Pengolah {
  float dc = 0, sm = 0, p1 = 0, p2 = 0, amp = 0, lembah = 0;
  uint32_t pk_terakhir = 0;
  float rr[8] = { 0 };
  int rr_i = 0, rr_n = 0;
  bool kontak = false;
  float buf[JENDELA] = { 0 };
  int bi = 0, bn = 0;
  float ac = 0;

  void reset() {
    dc = sm = p1 = p2 = amp = lembah = 0;
    pk_terakhir = 0;
    rr_i = rr_n = 0;
    kontak = false;
    bi = bn = 0;
    ac = 0;
  }

  void tambah(uint32_t ir, uint32_t t) {
    kontak = ir > KONTAK_MIN;
    if (!kontak) {
      dc = ir;
      bn = 0;
      rr_n = 0;
      ac = 0;
      return;
    }
    dc = dc == 0 ? ir : 0.95f * dc + 0.05f * ir;
    ac = -((float)ir - dc);
    sm = 0.6f * sm + 0.4f * ac;
    buf[bi] = sm;
    bi = (bi + 1) % JENDELA;
    if (bn < JENDELA) bn++;
    if (p1 > p2 && p1 >= sm && p1 > 0.5f * amp && t - pk_terakhir > 300) {
      if (pk_terakhir) {
        float rr_d = (t - pk_terakhir) / 1000.0f;
        if (rr_d > 0.27f && rr_d < 2.0f) {
          rr[rr_i] = rr_d;
          rr_i = (rr_i + 1) % 8;
          if (rr_n < 8) rr_n++;
        }
      }
      pk_terakhir = t;
      lembah = p1;
    }
    if (sm < lembah) lembah = sm;
    amp = fmaxf(0.97f * amp, fabsf(sm));
    p2 = p1;
    p1 = sm;
  }

  float median_rr() const {
    if (rr_n < 3) return NAN;
    float s[8];
    for (int i = 0; i < rr_n; i++) s[i] = rr[i];
    for (int i = 1; i < rr_n; i++) {
      float v = s[i];
      int j = i - 1;
      while (j >= 0 && s[j] > v) {
        s[j + 1] = s[j];
        j--;
      }
      s[j + 1] = v;
    }
    return (rr_n & 1) ? s[rr_n / 2] : 0.5f * (s[rr_n / 2 - 1] + s[rr_n / 2]);
  }

  float hr() const {
    float m = median_rr();
    return isnan(m) ? NAN : 60.0f / m;
  }

  float pp() const {
    if (bn < 10) return 0;
    float lo = buf[0], hi = buf[0];
    for (int i = 1; i < bn; i++) {
      if (buf[i] < lo) lo = buf[i];
      if (buf[i] > hi) hi = buf[i];
    }
    return hi - lo;
  }

  float sqi() const {
    float m = median_rr();
    if (bn < JENDELA || isnan(m)) return NAN;
    int T = (int)lroundf(m * FS_PPG);
    if (T < 5 || T > JENDELA / 2) return NAN;
    static float x[JENDELA];
    for (int i = 0; i < JENDELA; i++) x[i] = buf[(bi + i) % JENDELA];
    float mean = 0;
    for (int i = 0; i < JENDELA; i++) mean += x[i];
    mean /= JENDELA;
    float var = 0;
    for (int i = 0; i < JENDELA; i++) var += (x[i] - mean) * (x[i] - mean);
    float sd = sqrtf(var / JENDELA);
    if (sd < 1e-3f) return 0;
    float res = 0;
    int n = 0;
    for (int i = T; i < JENDELA; i++) {
      float d = x[i] - x[i - T];
      res += d * d;
      n++;
    }
    float rms = sqrtf(res / n);
    float q = 1.0f - rms / (1.4142f * sd);
    return q < 0 ? 0 : (q > 1 ? 1 : q);
  }
};

struct Statistik {
  uint32_t n = 0;
  double jml_ir = 0, jml_red = 0;
  uint32_t min_ir = 0xFFFFFFFF, max_ir = 0, min_red = 0xFFFFFFFF, max_red = 0;
  uint32_t jenuh = 0;
  uint32_t nol = 0;
  void reset() { *this = Statistik(); }
  void tambah(const Cuplikan& c) {
    n++;
    jml_ir += c.ir;
    jml_red += c.red;
    if (c.ir < min_ir) min_ir = c.ir;
    if (c.ir > max_ir) max_ir = c.ir;
    if (c.red < min_red) min_red = c.red;
    if (c.red > max_red) max_red = c.red;
    if (c.ir >= JENUH || c.red >= JENUH) jenuh++;
    if (c.ir == 0 && c.red == 0) nol++;
  }
  float mean_ir() const { return n ? jml_ir / n : 0; }
  float mean_red() const { return n ? jml_red / n : 0; }
};

static Pengolah pg;
static Mode mode = MODE_DIAM;
static uint8_t arus_led = LED_ARUS_AWAL;
static bool sensor_siap = false;
static uint32_t gagal_i2c = 0;
static uint32_t overflow_total = 0;
static bool batal = false;
static int n_lulus = 0, n_gagal = 0, n_peringatan = 0;
static uint32_t cetak_terakhir = 0;
static uint32_t hitung_detik = 0;
static float dc_red = 0;

bool tulis(uint8_t reg, uint8_t val) {
  Wire.beginTransmission(MAX_ADDR);
  Wire.write(reg);
  Wire.write(val);
  bool ok = Wire.endTransmission() == 0;
  if (!ok) gagal_i2c++;
  return ok;
}

bool baca(uint8_t reg, uint8_t* buf, uint8_t n) {
  Wire.beginTransmission(MAX_ADDR);
  Wire.write(reg);
  if (Wire.endTransmission(false) != 0) {
    gagal_i2c++;
    return false;
  }
  if (Wire.requestFrom((uint8_t)MAX_ADDR, n) != n) {
    gagal_i2c++;
    return false;
  }
  for (uint8_t i = 0; i < n; i++) buf[i] = Wire.read();
  return true;
}

bool baca1(uint8_t reg, uint8_t* v) {
  return baca(reg, v, 1);
}

bool ada_di_bus(uint8_t addr) {
  Wire.beginTransmission(addr);
  return Wire.endTransmission() == 0;
}

void hasil(const char* nama, int status, const char* detail) {
  const char* label = status == 0 ? "LULUS " : (status == 1 ? "PERINGATAN" : "GAGAL ");
  if (status == 0) n_lulus++;
  else if (status == 1) n_peringatan++;
  else n_gagal++;
  Serial.printf("[%s] %-34s %s\n", label, nama, detail);
}

bool sensor_init(uint8_t arus) {
  sensor_siap = false;
  if (!tulis(REG_MODE, 0x40)) return false;
  for (int i = 0; i < 20; i++) {
    delay(10);
    uint8_t m = 0xFF;
    if (baca1(REG_MODE, &m) && !(m & 0x40)) break;
  }
  bool ok = tulis(REG_FIFO_CFG, NILAI_FIFO_CFG);
  ok = ok && tulis(REG_MODE, NILAI_MODE);
  ok = ok && tulis(REG_SPO2_CFG, NILAI_SPO2_CFG);
  ok = ok && tulis(REG_LED_RED, arus);
  ok = ok && tulis(REG_LED_IR, arus);
  ok = ok && tulis(REG_FIFO_WR, 0x00);
  ok = ok && tulis(REG_FIFO_OVF, 0x00);
  ok = ok && tulis(REG_FIFO_RD, 0x00);
  if (ok) {
    arus_led = arus;
    sensor_siap = true;
    pg.reset();
  }
  return ok;
}

int baca_fifo(Cuplikan* out, int kap, bool* ok) {
  uint8_t wr = 0, rd = 0, ovf = 0;
  *ok = false;
  if (!baca1(REG_FIFO_WR, &wr) || !baca1(REG_FIFO_RD, &rd) || !baca1(REG_FIFO_OVF, &ovf)) return 0;
  *ok = true;
  int n = (wr - rd) & 0x1F;
  if (ovf > 0) {
    overflow_total += ovf;
    if (n == 0) n = 32;
  }
  if (n > kap) n = kap;
  int dapat = 0;
  for (int i = 0; i < n; i++) {
    uint8_t b[6];
    if (!baca(REG_FIFO_DATA, b, 6)) {
      *ok = false;
      break;
    }
    out[dapat].red = (((uint32_t)b[0] << 16) | ((uint32_t)b[1] << 8) | b[2]) & 0x3FFFF;
    out[dapat].ir = (((uint32_t)b[3] << 16) | ((uint32_t)b[4] << 8) | b[5]) & 0x3FFFF;
    dapat++;
  }
  return dapat;
}

void cek_batal() {
  while (Serial.available()) {
    int c = Serial.read();
    if (c == 'x' || c == 'X') batal = true;
  }
}

uint32_t kumpulkan(uint32_t ms, Statistik* st, bool reset_pengolah) {
  if (reset_pengolah) pg.reset();
  if (st) st->reset();
  uint32_t mulai = millis();
  uint32_t total = 0;
  Cuplikan c[32];
  while (millis() - mulai < ms && !batal) {
    bool ok;
    int n = baca_fifo(c, 32, &ok);
    for (int i = 0; i < n; i++) {
      if (st) st->tambah(c[i]);
      pg.tambah(c[i].ir, millis());
    }
    total += n;
    cek_batal();
    delay(20);
  }
  return total;
}

bool tunggu_kontak(bool harus_ada, uint32_t batas_ms) {
  uint32_t mulai = millis();
  uint32_t stabil = 0;
  Cuplikan c[32];
  uint32_t cetak = 0;
  while (millis() - mulai < batas_ms && !batal) {
    bool ok;
    int n = baca_fifo(c, 32, &ok);
    for (int i = 0; i < n; i++) {
      pg.tambah(c[i].ir, millis());
      bool ada = c[i].ir > KONTAK_MIN;
      if (ada == harus_ada) {
        if (!stabil) stabil = millis();
      } else {
        stabil = 0;
      }
    }
    if (stabil && millis() - stabil > 1500) return true;
    if (millis() - cetak > 1000 && n > 0) {
      cetak = millis();
      Serial.printf("  IR = %lu (batas kontak %d)\n", (unsigned long)c[n - 1].ir, KONTAK_MIN);
    }
    cek_batal();
    delay(20);
  }
  return false;
}

void cetak_daftar_i2c() {
  Serial.println("Pindai bus I2C:");
  int jumlah = 0;
  for (uint8_t a = 1; a < 127; a++) {
    if (ada_di_bus(a)) {
      const char* nama = "tidak dikenal";
      if (a == 0x57) nama = "MAX30102 (PPG) atau EEPROM modul";
      else if (a == 0x68 || a == 0x69) nama = "MPU6050 (IMU)";
      else if (a == 0x3C || a == 0x3D) nama = "OLED";
      else if (a == 0x76 || a == 0x77) nama = "BME/BMP";
      Serial.printf("  0x%02X  %s\n", a, nama);
      jumlah++;
    }
  }
  if (!jumlah) Serial.println("  tidak ada perangkat. Periksa SDA/SCL, daya 3V3, GND, dan resistor pull-up.");
}

void cetak_register() {
  const uint8_t daftar[] = { REG_INT_STATUS1, REG_FIFO_WR, REG_FIFO_OVF, REG_FIFO_RD, REG_FIFO_CFG, REG_MODE, REG_SPO2_CFG, REG_LED_RED, REG_LED_IR, REG_REV_ID, REG_PART_ID };
  Serial.println("Register MAX30102:");
  for (uint8_t r : daftar) {
    uint8_t v = 0;
    if (baca1(r, &v)) Serial.printf("  0x%02X = 0x%02X\n", r, v);
    else Serial.printf("  0x%02X = gagal dibaca\n", r);
  }
}

bool baca_suhu(float* c) {
  if (!tulis(REG_TEMP_EN, 0x01)) return false;
  uint32_t mulai = millis();
  uint8_t v = 1;
  while (millis() - mulai < 200) {
    delay(10);
    if (baca1(REG_TEMP_EN, &v) && !(v & 0x01)) break;
  }
  uint8_t bi = 0, bf = 0;
  if (!baca1(REG_TEMP_INT, &bi) || !baca1(REG_TEMP_FRAC, &bf)) return false;
  *c = (int8_t)bi + (bf & 0x0F) * 0.0625f;
  return true;
}

void uji_lengkap() {
  char s[160];
  batal = false;
  n_lulus = n_gagal = n_peringatan = 0;
  gagal_i2c = 0;
  overflow_total = 0;
  Serial.println();
  Serial.println("=== UJI LENGKAP MAX30102 ===");
  Serial.println("Ketik x kapan saja untuk membatalkan.");

  if (!ada_di_bus(MAX_ADDR)) {
    hasil("1. Sensor di alamat 0x57", 2, "tidak ada respons. Periksa SDA/SCL, VIN 3V3, GND");
    cetak_daftar_i2c();
    Serial.println("Uji dihentikan karena sensor tidak terdeteksi.");
    return;
  }
  hasil("1. Sensor di alamat 0x57", 0, "ACK diterima");

  uint8_t part = 0, rev = 0;
  if (!baca1(REG_PART_ID, &part)) {
    hasil("2. Part ID", 2, "gagal membaca register 0xFF");
    return;
  }
  baca1(REG_REV_ID, &rev);
  snprintf(s, sizeof(s), "Part ID 0x%02X, revisi 0x%02X", part, rev);
  if (part == 0x15) hasil("2. Part ID = MAX30102 (0x15)", 0, s);
  else if (part == 0x11) {
    hasil("2. Part ID = MAX30102 (0x15)", 2, "modul ini MAX30100 (0x11), bukan MAX30102");
    return;
  } else {
    hasil("2. Part ID = MAX30102 (0x15)", 2, s);
    return;
  }

  if (!sensor_init(arus_led)) {
    hasil("3. Inisialisasi dan konfigurasi", 2, "gagal menulis register");
    return;
  }
  {
    uint8_t a = 0, b = 0, c = 0, d = 0, e = 0;
    baca1(REG_FIFO_CFG, &a);
    baca1(REG_MODE, &b);
    baca1(REG_SPO2_CFG, &c);
    baca1(REG_LED_RED, &d);
    baca1(REG_LED_IR, &e);
    bool cocok = a == NILAI_FIFO_CFG && b == NILAI_MODE && c == NILAI_SPO2_CFG && d == arus_led && e == arus_led;
    snprintf(s, sizeof(s), "FIFO=%02X MODE=%02X SPO2=%02X LED_R=%02X LED_IR=%02X", a, b, c, d, e);
    hasil("3. Inisialisasi dan konfigurasi", cocok ? 0 : 2, s);
  }

  float suhu = 0;
  if (baca_suhu(&suhu)) {
    snprintf(s, sizeof(s), "%.2f C", suhu);
    hasil("4. Sensor suhu die", (suhu > 10 && suhu < 50) ? 0 : 1, s);
  } else {
    hasil("4. Sensor suhu die", 1, "gagal dibaca");
  }
  sensor_init(arus_led);

  Serial.printf("Mengukur laju sampel selama %d detik...\n", DURASI_LAJU_MS / 1000);
  Statistik st;
  uint32_t mulai = millis();
  uint32_t jumlah = kumpulkan(DURASI_LAJU_MS, &st, true);
  if (batal) {
    Serial.println("Dibatalkan.");
    return;
  }
  float detik = (millis() - mulai) / 1000.0f;
  float laju = jumlah / detik;
  snprintf(s, sizeof(s), "%.1f sampel/s (target %d)", laju, FS_PPG);
  hasil("5. Laju sampel FIFO", (laju > FS_PPG * 0.85f && laju < FS_PPG * 1.15f) ? 0 : 2, s);

  snprintf(s, sizeof(s), "%lu kali", (unsigned long)overflow_total);
  hasil("6. FIFO overflow", overflow_total == 0 ? 0 : 1, s);

  snprintf(s, sizeof(s), "gagal I2C selama uji: %lu", (unsigned long)gagal_i2c);
  hasil("7. Stabilitas I2C", gagal_i2c == 0 ? 0 : (gagal_i2c < 5 ? 1 : 2), s);

  snprintf(s, sizeof(s), "IR rata-rata %.0f, RED rata-rata %.0f", st.mean_ir(), st.mean_red());
  if (st.n == 0 || st.nol == st.n) hasil("8. LED menyala dan ADC terbaca", 2, "semua nilai 0, LED tidak menyala atau ADC mati");
  else if (st.jenuh > 0) hasil("8. LED menyala dan ADC terbaca", 1, "ADC jenuh tanpa jari, kurangi arus LED atau hindari cahaya luar");
  else hasil("8. LED menyala dan ADC terbaca", 0, s);

  Serial.printf("\nTempelkan jari atau sensor ke kulit dengan tekanan ringan (maks %d detik)...\n", TUNGGU_KONTAK_MS / 1000);
  pg.reset();
  if (!tunggu_kontak(true, TUNGGU_KONTAK_MS)) {
    if (batal) {
      Serial.println("Dibatalkan.");
      return;
    }
    hasil("9. Deteksi kontak (IR > batas)", 1, "tidak ada kontak terdeteksi, uji kualitas sinyal dilewati");
  } else {
    hasil("9. Deteksi kontak (IR > batas)", 0, "kontak terdeteksi stabil");
    Serial.printf("Tahan diam selama %d detik. Jangan bergerak...\n", DURASI_SINYAL_MS / 1000);
    jumlah = kumpulkan(DURASI_SINYAL_MS, &st, false);
    if (batal) {
      Serial.println("Dibatalkan.");
      return;
    }
    float dc = st.mean_ir();
    float pp = pg.pp();
    float pi = dc > 0 ? 100.0f * pp / dc : 0;
    float hr = pg.hr();
    float q = pg.sqi();

    snprintf(s, sizeof(s), "DC IR %.0f (min %lu, maks %lu)", dc, (unsigned long)st.min_ir, (unsigned long)st.max_ir);
    if (st.jenuh > 0) hasil("10. Tingkat sinyal IR", 2, "jenuh, turunkan arus LED (perintah -)");
    else if (dc < KONTAK_MIN * 1.5f) hasil("10. Tingkat sinyal IR", 1, "terlalu rendah, naikkan arus LED (perintah +) atau tekan lebih rapat");
    else if (dc > 200000) hasil("10. Tingkat sinyal IR", 1, "mendekati jenuh, turunkan arus LED");
    else hasil("10. Tingkat sinyal IR", 0, s);

    snprintf(s, sizeof(s), "p-p %.0f count, PI %.2f %%", pp, pi);
    hasil("11. Amplitudo denyut (AC)", pi >= 0.1f ? 0 : (pi >= 0.03f ? 1 : 2), s);

    if (isnan(hr)) hasil("12. Detak jantung terdeteksi", 2, "belum ada denyut stabil, kulit kurang rapat atau sensor bergerak");
    else {
      snprintf(s, sizeof(s), "%.1f bpm", hr);
      hasil("12. Detak jantung terdeteksi", (hr >= 40 && hr <= 180) ? 0 : 1, s);
    }

    if (isnan(q)) hasil("13. SQI (kualitas sinyal)", 1, "belum cukup data untuk menghitung SQI");
    else {
      snprintf(s, sizeof(s), "%.2f (ambang firmware %.2f)", q, TAU_SQI);
      hasil("13. SQI (kualitas sinyal)", q >= TAU_SQI ? 0 : 1, s);
    }

    Serial.printf("\nAngkat jari dari sensor (maks %d detik)...\n", TUNGGU_LEPAS_MS / 1000);
    if (tunggu_kontak(false, TUNGGU_LEPAS_MS)) hasil("14. Deteksi lepas kontak", 0, "IR turun di bawah batas");
    else if (!batal) hasil("14. Deteksi lepas kontak", 1, "IR tetap di atas batas, ada cahaya luar atau batas KONTAK_MIN terlalu rendah");
  }

  Serial.println();
  Serial.printf("RINGKASAN: %d lulus, %d peringatan, %d gagal\n", n_lulus, n_peringatan, n_gagal);
  if (n_gagal == 0 && n_peringatan == 0) Serial.println("Modul MAX30102 siap dipakai di firmware utama.");
  else if (n_gagal == 0) Serial.println("Modul berfungsi. Periksa peringatan di atas sebelum dipakai.");
  else Serial.println("Ada pengujian yang gagal. Perbaiki sebelum dipasang ke firmware utama.");
  sensor_init(arus_led);
}

void sapuan_led() {
  batal = false;
  const uint8_t daftar[] = { 0x05, 0x0F, 0x1F, 0x2F, 0x3F, 0x5F, 0x7F, 0xAF, 0xFF };
  Serial.println();
  Serial.println("=== SAPUAN ARUS LED ===");
  Serial.println("Tempelkan sensor ke posisi pemakaian dan tahan diam. Ketik x untuk batal.");
  delay(2000);
  float terbaik_pi = -1;
  uint8_t terbaik = arus_led;
  Serial.println("arus  mA     DC_IR    DC_RED   p-p_IR    PI(%)  status");
  for (uint8_t a : daftar) {
    if (batal) break;
    if (!sensor_init(a)) {
      Serial.printf("0x%02X gagal inisialisasi\n", a);
      continue;
    }
    kumpulkan(1000, nullptr, true);
    Statistik st;
    kumpulkan(4000, &st, false);
    float dc = st.mean_ir();
    float pp = pg.pp();
    float pi = dc > 0 ? 100.0f * pp / dc : 0;
    const char* status = "ok";
    if (st.jenuh > 0 || dc > 200000) status = "jenuh";
    else if (dc < KONTAK_MIN) status = "tanpa kontak";
    else if (pi > terbaik_pi) {
      terbaik_pi = pi;
      terbaik = a;
    }
    Serial.printf("0x%02X  %5.1f  %7.0f  %7.0f  %7.0f  %6.2f  %s\n", a, a * 0.2f, dc, st.mean_red(), pp, pi, status);
  }
  if (terbaik_pi < 0) Serial.println("Tidak ada arus yang menghasilkan sinyal valid. Periksa penempelan sensor.");
  else Serial.printf("Rekomendasi: LED_ARUS_AWAL 0x%02X (%.1f mA), PI %.2f %%\n", terbaik, terbaik * 0.2f, terbaik_pi);
  sensor_init(batal ? arus_led : (terbaik_pi < 0 ? arus_led : terbaik));
  Serial.printf("Arus aktif sekarang 0x%02X.\n", arus_led);
}

void ubah_arus(int arah) {
  int baru = (int)arus_led + arah * (arus_led < 0x20 ? 0x04 : 0x10);
  if (baru < 0x02) baru = 0x02;
  if (baru > 0xFF) baru = 0xFF;
  if (sensor_init((uint8_t)baru)) Serial.printf("Arus LED = 0x%02X (%.1f mA)\n", arus_led, arus_led * 0.2f);
  else Serial.println("Gagal mengubah arus LED.");
}

void bantuan() {
  Serial.println();
  Serial.println("=== UJI MODUL MAX30102 ===");
  Serial.println("t  uji lengkap otomatis (14 pengujian, sekitar 45 detik)");
  Serial.println("s  aliran data tiap detik (IR, RED, kontak, HR, SQI)");
  Serial.println("p  keluaran untuk Serial Plotter (ketik d untuk berhenti)");
  Serial.println("l  sapuan arus LED dan rekomendasi arus terbaik");
  Serial.println("+  naikkan arus LED     -  turunkan arus LED");
  Serial.println("i  pindai bus I2C       g  tampilkan register");
  Serial.println("r  inisialisasi ulang   d  berhenti ke mode diam");
  Serial.println("x  batalkan pengujian yang sedang berjalan");
  Serial.println("h  bantuan ini");
}

void layani_fifo_mode() {
  if (!sensor_siap) return;
  Cuplikan c[32];
  bool ok;
  int n = baca_fifo(c, 32, &ok);
  for (int i = 0; i < n; i++) {
    pg.tambah(c[i].ir, millis());
    dc_red = dc_red == 0 ? c[i].red : 0.95f * dc_red + 0.05f * c[i].red;
    if (mode == MODE_PLOT) {
      float red_ac = pg.kontak ? dc_red - (float)c[i].red : 0.0f;
      Serial.printf("ir_ac:%.0f,red_ac:%.0f,kontak:%d\n", pg.kontak ? pg.ac : 0.0f, red_ac, pg.kontak ? 200 : 0);
    }
  }
  if (mode == MODE_ALIR && millis() - cetak_terakhir >= 1000 && n > 0) {
    cetak_terakhir = millis();
    float hr = pg.hr();
    float q = pg.sqi();
    char hs[16], qs[16];
    if (isnan(hr)) snprintf(hs, sizeof(hs), "-");
    else snprintf(hs, sizeof(hs), "%.1f", hr);
    if (isnan(q)) snprintf(qs, sizeof(qs), "-");
    else snprintf(qs, sizeof(qs), "%.2f", q);
    Serial.printf("t=%lus IR=%lu RED=%lu kontak=%s HR=%s SQI=%s gagal_i2c=%lu overflow=%lu\n", (unsigned long)(++hitung_detik), (unsigned long)c[n - 1].ir, (unsigned long)c[n - 1].red, pg.kontak ? "ya" : "tidak", hs, qs, (unsigned long)gagal_i2c, (unsigned long)overflow_total);
  }
}

void setup() {
  Serial.begin(115200);
  delay(500);
  Wire.begin(PIN_SDA, PIN_SCL);
  Wire.setClock(I2C_HZ);
  Wire.setTimeOut(50);
  bantuan();
  if (!ada_di_bus(MAX_ADDR)) {
    Serial.println();
    Serial.printf("PERINGATAN: tidak ada perangkat di 0x%02X (SDA=GPIO%d, SCL=GPIO%d).\n", MAX_ADDR, PIN_SDA, PIN_SCL);
    cetak_daftar_i2c();
  } else if (sensor_init(LED_ARUS_AWAL)) {
    Serial.printf("\nMAX30102 terdeteksi dan diinisialisasi, arus LED 0x%02X. Ketik t untuk uji lengkap.\n", arus_led);
  } else {
    Serial.println("\nMAX30102 terdeteksi tetapi inisialisasi gagal. Ketik t untuk diagnosis.");
  }
}

void loop() {
  while (Serial.available()) {
    int c = Serial.read();
    if (c == '\r' || c == '\n' || c == ' ') continue;
    switch (c) {
      case 't': case 'T':
        mode = MODE_DIAM;
        uji_lengkap();
        break;
      case 's': case 'S':
        mode = MODE_ALIR;
        hitung_detik = 0;
        cetak_terakhir = millis();
        if (!sensor_siap) sensor_init(arus_led);
        Serial.println("Mode aliran. Ketik d untuk berhenti.");
        break;
      case 'p': case 'P':
        mode = MODE_PLOT;
        if (!sensor_siap) sensor_init(arus_led);
        break;
      case 'l': case 'L':
        mode = MODE_DIAM;
        sapuan_led();
        break;
      case '+':
        ubah_arus(1);
        break;
      case '-':
        ubah_arus(-1);
        break;
      case 'i': case 'I':
        cetak_daftar_i2c();
        break;
      case 'g': case 'G':
        cetak_register();
        break;
      case 'r': case 'R':
        if (sensor_init(arus_led)) Serial.println("Sensor diinisialisasi ulang.");
        else Serial.println("Inisialisasi ulang gagal. Periksa kabel dan daya.");
        break;
      case 'd': case 'D':
        mode = MODE_DIAM;
        Serial.println("Mode diam.");
        break;
      case 'h': case 'H': case '?':
        bantuan();
        break;
      default:
        break;
    }
  }
  layani_fifo_mode();
  delay(20);
}
