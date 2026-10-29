#include <Arduino.h>
#include <Wire.h>
#include <math.h>
#include <sys/time.h>
#include <time.h>
#include <Preferences.h>
#include <LittleFS.h>
#include "esp_arduino_version.h"
#include "esp_log.h"

#define DEVICE_ID "cv-001"

#define CONN_WIFI 1
#define CONN_4G 2
#define CONN_MODE CONN_WIFI

#define WIFI_SSID "Wokwi 2.4G"
#define WIFI_PASS "wokwiwokwok24"

#if __has_include("rahasia.h")
#include "rahasia.h"
#endif

#ifndef MQTT_HOST
#define MQTT_HOST "icdc5921.ala.asia-southeast1.emqxsl.com"
#endif
#define MQTT_USE_TLS 1
#define MQTT_TLS_INSECURE 1
#define MQTT_PORT (MQTT_USE_TLS ? 8883 : 1883)
#ifndef MQTT_USER
#define MQTT_USER "cardiovest"
#endif
#ifndef MQTT_PASS
#define MQTT_PASS "cardiovest"
#endif

#define MODEM_TERPASANG 0
#define MODEM_SIM7600 0
#define MODEM_BAUD 115200
#define GSM_APN "internet"
#define GSM_USER ""
#define GSM_PASS ""
#define GSM_SIM_PIN ""

#define SMS_FALLBACK 1
#define SMS_NOMOR {"+6282222216470", "+62895364693939"}

#define PIN_LED_A 26
#define PIN_LED_B 25
#define PIN_BUZZER 27
#define PIN_GPS_RX 19
#define PIN_GPS_TX 18
#define PIN_MODEM_RX 16
#define PIN_MODEM_TX 17
#define PIN_MODEM_PWRKEY -1
#define PIN_ECG_OUT 34
#define PIN_ECG_LO_MINUS 33
#define PIN_ECG_LO_PLUS 32
#define PIN_GSR 35
#define PIN_I2C_SDA 21
#define PIN_I2C_SCL 22
#define PIN_TOMBOL_RESET 4
#define PIN_VBUS_SENSE -1

#define ECG_GAIN 1100.0f
#define GSR_ADC_NO_SKIN 2048
#define GSR_R_REF 10000.0f
#define PPG_MIN_DC 50000
#define TAU_SQI 0.50f

#define I2C_CLOCK_HZ 100000

#define ECG_PAYLOAD_BINARY 0
#define DEBUG_LOG 1

#define ECG_FS 250
#define ECG_HOP 875
#define ECG_COUNTS_PER_MV 500
#define NOTCH_HZ 50.0f
#define ECG_FIR_TAPS 501
#define KALMAN_Q 0.01f
#define KALMAN_R0 0.08f
#define KALMAN_R_MOTION 40.0f
#define SQI_WINDOW_S 5

#define FALL_JOLT_G 1.8f
#define FALL_DIP_G 0.5f
#define FALL_DIP_MIN_MS 40
#define FALL_COOLDOWN_MS 3000
#define FALL_FLAG_HOLD_MS 10000

#define RESET_HOLD_MS 3000
#define SMS_AFTER_OFFLINE_MS 30000
#define RECONNECT_MAX_MS 30000
#define OFFLINE_BUFFER_MAX_KB 700
#define OBUF_SEGMENT_BYTES (16 * 1024)
#define VBUS_THRESHOLD_MV 1500
#define SESSION_LIMIT_HOURS 8

#define USE_MODEM ((CONN_MODE == CONN_4G) || MODEM_TERPASANG)

#if USE_MODEM
#if MODEM_SIM7600
#define TINY_GSM_MODEM_SIM800
#else
#define TINY_GSM_MODEM_SIM7600
#endif
#define TINY_GSM_RX_BUFFER 1024
#include <TinyGsmClient.h>
#endif

#if CONN_MODE == CONN_WIFI
#include <WiFi.h>
#include "esp_wifi.h"
#if MQTT_USE_TLS
#include <WiFiClientSecure.h>
#endif
#elif MQTT_USE_TLS
#include <SSLClient.h>
#endif

#include <MQTT.h>

#if DEBUG_LOG
#define LOGF(fmt, ...) Serial.printf("[%8lu] " fmt "\n", (unsigned long)millis(), ##__VA_ARGS__)
#else
#define LOGF(fmt, ...) \
  do                   \
  {                    \
  } while (0)
#endif

enum DevState : uint8_t
{
  ST_NORMAL = 0,
  ST_WARNING = 1,
  ST_CRITICAL = 2
};
enum EventType : uint8_t
{
  EV_HARDWARE_RESET = 1
};
enum BufKind : uint8_t
{
  BUF_ECG = 1,
  BUF_VITAL = 2,
  BUF_EVENT = 3
};

struct EcgPacket
{
  uint32_t seq;
  uint64_t t0_ms;
  bool lead_off;
  bool clock_ok;
  int16_t s[ECG_HOP];
};

struct RawSample
{
  uint16_t mv;
  uint8_t lead_off;
};

struct Vitals
{
  bool ppg_ok = false;
  float hr_ppg = NAN;
  float sqi = 0;
  bool ecg_ok = false;
  bool gsr_ok = false;
  float gsr_us = NAN;
  bool imu_ok = false;
  float ax = 0, ay = 0, az = 1, amag = 1, amag_sd = 0;
  bool fall_detected = false;
  uint64_t fall_ts = 0;
  bool lead_off = false;
  bool charging = false;
  bool session_limit = false;
};

struct GpsFix
{
  bool active = false;
  bool fix = false;
  double lat = 0, lon = 0;
  float accuracy_m = 0;
  float hdop = 0;
  int sats = 0;
  bool nmea = false;
  long baud = 0;
};

struct SensorPresence
{
  bool imu = false;
  bool ppg = false;
  bool gsr = false;
  uint8_t imu_addr = 0;
  uint8_t imu_who = 0;
  uint8_t ppg_id = 0;
};

typedef bool (*ObufSender)(BufKind kind, const uint8_t *data, uint16_t len);

static const float PI_F = 3.14159265358979f;

volatile DevState g_state = ST_NORMAL;
volatile float g_motion = 0;
volatile bool g_net_online = false;
volatile bool g_charging = false;
volatile bool g_lead_off = false;
QueueHandle_t q_ecg_packets = nullptr;
QueueHandle_t q_events = nullptr;

static Vitals s_vitals;
static portMUX_TYPE s_adc_mux = portMUX_INITIALIZER_UNLOCKED;
static volatile uint32_t s_gsr_sum = 0, s_gsr_n = 0;
static volatile int s_vbus_mv = 0;
static volatile uint32_t s_adc_fail = 0;
static SemaphoreHandle_t s_vmutex = nullptr;
static SensorPresence s_has;

const char *stateName(DevState s)
{
  if (s == ST_WARNING)
    return "WARNING";
  if (s == ST_CRITICAL)
    return "CRITICAL";
  return "NORMAL";
}

DevState stateFromName(const char *s)
{
  if (!s)
    return ST_NORMAL;
  if (!strcmp(s, "CRITICAL"))
    return ST_CRITICAL;
  if (!strcmp(s, "WARNING"))
    return ST_WARNING;
  return ST_NORMAL;
}

bool time_valid()
{
  return time(nullptr) > 1700000000;
}

uint64_t now_ms()
{
  struct timeval tv;
  gettimeofday(&tv, nullptr);
  return (uint64_t)tv.tv_sec * 1000ULL + tv.tv_usec / 1000;
}

void time_set_epoch(time_t epoch_s)
{
  struct timeval tv = {epoch_s, 0};
  settimeofday(&tv, nullptr);
}

void vitals_lock()
{
  xSemaphoreTake(s_vmutex, portMAX_DELAY);
}

void vitals_unlock()
{
  xSemaphoreGive(s_vmutex);
}

Vitals vitals_get()
{
  vitals_lock();
  Vitals v = s_vitals;
  vitals_unlock();
  return v;
}

class Biquad
{
public:
  void notch(float fs, float f0, float q)
  {
    float w = 2 * PI_F * f0 / fs, c = cosf(w), al = sinf(w) / (2 * q);
    set(1, -2 * c, 1, 1 + al, -2 * c, 1 - al);
  }
  float process(float x)
  {
    float y = b0_ * x + z1_;
    z1_ = b1_ * x - a1_ * y + z2_;
    z2_ = b2_ * x - a2_ * y;
    return y;
  }
  void reset()
  {
    z1_ = 0;
    z2_ = 0;
  }

private:
  void set(float b0, float b1, float b2, float a0, float a1, float a2)
  {
    b0_ = b0 / a0;
    b1_ = b1 / a0;
    b2_ = b2 / a0;
    a1_ = a1 / a0;
    a2_ = a2 / a0;
    z1_ = 0;
    z2_ = 0;
  }
  float b0_ = 1, b1_ = 0, b2_ = 0, a1_ = 0, a2_ = 0, z1_ = 0, z2_ = 0;
};

class DcBlocker
{
public:
  DcBlocker(float fs, float fc) : r_(1.0f - 2.0f * PI_F * fc / fs) {}
  float process(float x)
  {
    float y = x - x1_ + r_ * y1_;
    x1_ = x;
    y1_ = y;
    return y;
  }

private:
  float r_, x1_ = 0, y1_ = 0;
};

class FirBandpass
{
public:
  static const int MAX_TAPS = 751;
  void design(float fs, float f1, float f2, int taps)
  {
    if (taps > MAX_TAPS)
      taps = MAX_TAPS;
    if (taps % 2 == 0)
      taps--;
    n_ = taps;
    float a = f1 / fs, b = f2 / fs;
    int m = (taps - 1) / 2;
    for (int i = 0; i < taps; ++i)
    {
      float k = (float)(i - m);
      float w = 0.54f - 0.46f * cosf(2 * PI_F * i / (taps - 1));
      h_[i] = w * (2 * b * sinc(2 * b * k) - 2 * a * sinc(2 * a * k));
    }
    float fc = 0.5f * (a + b), re = 0, im = 0;
    for (int i = 0; i < taps; ++i)
    {
      re += h_[i] * cosf(2 * PI_F * fc * i);
      im -= h_[i] * sinf(2 * PI_F * fc * i);
    }
    float g = sqrtf(re * re + im * im);
    for (int i = 0; i < taps; ++i)
      h_[i] /= g;
    for (int i = 0; i < MAX_TAPS; ++i)
      buf_[i] = 0;
    idx_ = 0;
  }
  float process(float x)
  {
    buf_[idx_] = x;
    float acc = 0;
    int j = idx_;
    for (int i = 0; i < n_; ++i)
    {
      acc += h_[i] * buf_[j];
      if (--j < 0)
        j = n_ - 1;
    }
    if (++idx_ >= n_)
      idx_ = 0;
    return acc;
  }
  int delaySamples() const { return (n_ - 1) / 2; }

private:
  static float sinc(float x)
  {
    return fabsf(x) < 1e-9f ? 1.0f : sinf(PI_F * x) / (PI_F * x);
  }
  float h_[MAX_TAPS] = {0};
  float buf_[MAX_TAPS] = {0};
  int n_ = 1, idx_ = 0;
};

class AdaptiveKalman
{
public:
  AdaptiveKalman(float q, float r0, float k_motion) : q_(q), r0_(r0), km_(k_motion) {}
  float update(float z, float motion)
  {
    if (!init_)
    {
      x_ = z;
      p_ = 1;
      init_ = true;
    }
    float r = r0_ * (1.0f + km_ * fmaxf(motion, 0.0f));
    p_ += q_;
    float k = p_ / (p_ + r);
    x_ += k * (z - x_);
    p_ *= (1 - k);
    return x_;
  }

private:
  float q_, r0_, km_, x_ = 0, p_ = 1;
  bool init_ = false;
};

class PanTompkins
{
public:
  explicit PanTompkins(int fs) : fs_(fs)
  {
    win_ = (int)(0.150f * fs);
    if (win_ > 64)
      win_ = 64;
    refractory_ = (int)(0.25f * fs);
  }
  bool update(float x)
  {
    for (int i = 4; i > 0; --i)
      xbuf_[i] = xbuf_[i - 1];
    xbuf_[0] = x;
    float d = (2 * xbuf_[0] + xbuf_[1] - xbuf_[3] - 2 * xbuf_[4]) / 8.0f;
    float sq = d * d;
    mwi_sum_ += sq - mwi_buf_[mwi_idx_];
    mwi_buf_[mwi_idx_] = sq;
    mwi_idx_ = (mwi_idx_ + 1) % win_;
    float m = mwi_sum_ / win_;
    n_++;
    bool beat = false;
    if (prev_ > prev2_ && prev_ >= m && n_ > (uint32_t)(3 * fs_))
    {
      float pk = prev_;
      if (pk > thr_ && (n_ - last_peak_n_) > (uint32_t)refractory_)
      {
        spki_ = 0.125f * pk + 0.875f * spki_;
        if (last_peak_n_ > 0)
          addRR((float)(n_ - last_peak_n_) / fs_);
        last_peak_n_ = n_;
        beat = true;
      }
      else
      {
        npki_ = 0.125f * pk + 0.875f * npki_;
        if (pk > 0.5f * thr_ && pk > sb_val_ && (n_ - last_peak_n_) > (uint32_t)refractory_)
        {
          sb_val_ = pk;
          sb_n_ = n_;
        }
      }
      thr_ = npki_ + 0.25f * (spki_ - npki_);
    }
    if (rr_count_ >= 2 && sb_n_ > last_peak_n_)
    {
      float avg = 0;
      for (int i = 0; i < rr_count_; ++i)
        avg += rr_[i];
      avg /= rr_count_;
      if ((n_ - last_peak_n_) > (uint32_t)(1.66f * avg * fs_))
      {
        addRR((float)(sb_n_ - last_peak_n_) / fs_);
        spki_ = 0.25f * sb_val_ + 0.75f * spki_;
        thr_ = npki_ + 0.25f * (spki_ - npki_);
        last_peak_n_ = sb_n_;
        sb_val_ = 0;
        beat = true;
      }
    }
    if (beat && last_peak_n_ == n_)
    {
      sb_val_ = 0;
      sb_n_ = 0;
    }
    if (n_ > (uint32_t)fs_ && n_ <= (uint32_t)(3 * fs_))
    {
      if (m > spki_)
        spki_ = m;
      thr_ = 0.3f * spki_;
    }
    if (n_ > (uint32_t)(3 * fs_) && (n_ - last_peak_n_) > (uint32_t)(2 * fs_) && (n_ % fs_) == 0)
    {
      spki_ *= 0.5f;
      thr_ = npki_ + 0.25f * (spki_ - npki_);
    }
    prev2_ = prev_;
    prev_ = m;
    return beat;
  }
  float heartRate() const
  {
    if (rr_count_ < 3 || n_ - last_peak_n_ > (uint32_t)(3 * fs_))
      return NAN;
    float v[8];
    for (int i = 0; i < rr_count_; ++i)
      v[i] = rr_[i];
    for (int i = 1; i < rr_count_; ++i)
    {
      float t = v[i];
      int j = i - 1;
      while (j >= 0 && v[j] > t)
      {
        v[j + 1] = v[j];
        --j;
      }
      v[j + 1] = t;
    }
    float hr_calc = 60.0f / v[rr_count_ / 2];

    // VALIDASI INSTAN: Tetap luluskan indikasi VT / Bradikardia (30–220 BPM), abaikan hanya jika noise tak wajar (>220 BPM)
    if (hr_calc < 30.0f || hr_calc > 220.0f)
    {
      return NAN;
    }
    return hr_calc;
  }
  uint32_t samplesSinceBeat() const { return n_ - last_peak_n_; }

private:
  void addRR(float rr)
  {
    if (rr <= 0.25f || rr >= 2.2f)
      return;
    rr_[rr_idx_] = rr;
    rr_idx_ = (rr_idx_ + 1) % 8;
    if (rr_count_ < 8)
      rr_count_++;
  }
  int fs_, win_, refractory_;
  float xbuf_[5] = {0};
  float mwi_buf_[64] = {0};
  int mwi_idx_ = 0;
  float mwi_sum_ = 0;
  float spki_ = 0, npki_ = 0, thr_ = 0;
  float prev_ = 0, prev2_ = 0;
  uint32_t n_ = 0, last_peak_n_ = 0;
  float sb_val_ = 0;
  uint32_t sb_n_ = 0;
  float rr_[8] = {0};
  int rr_count_ = 0, rr_idx_ = 0;
};

class FallDetector
{
public:
  bool update(float mag, uint32_t t)
  {
    if (fired_ && t - last_ < FALL_COOLDOWN_MS)
      return false;
    if (mag > FALL_JOLT_G)
      return hit(t);
    if (mag < FALL_DIP_G)
    {
      if (!dipping_)
      {
        dipping_ = true;
        dip_start_ = t;
      }
      else if (t - dip_start_ >= FALL_DIP_MIN_MS)
      {
        return hit(t);
      }
    }
    else
    {
      dipping_ = false;
    }
    return false;
  }

private:
  bool hit(uint32_t t)
  {
    fired_ = true;
    last_ = t;
    dipping_ = false;
    return true;
  }
  bool fired_ = false, dipping_ = false;
  uint32_t last_ = 0, dip_start_ = 0;
};

class PpgProcessor
{
public:
  static const int FS = 50;
  static const int N = FS * SQI_WINDOW_S;
  void add(uint32_t ir, uint32_t t_ms)
  {
    contact_ = ir > PPG_MIN_DC;
    if (!contact_)
    {
      dc_ = ir;
      buf_n_ = 0;
      rr_n_ = 0;
      return;
    }
    dc_ = (dc_ == 0) ? ir : 0.95f * dc_ + 0.05f * ir;
    float ac = -((float)ir - dc_);
    sm_ = 0.6f * sm_ + 0.4f * ac;
    buf_[buf_i_] = sm_;
    buf_i_ = (buf_i_ + 1) % N;
    if (buf_n_ < N)
      buf_n_++;
    if (p1_ > p2_ && p1_ >= sm_ && p1_ > 0.5f * amp_ && t_ms - last_pk_ > 300)
    {
      if (last_pk_)
      {
        float rr = (t_ms - last_pk_) / 1000.0f;
        if (rr > 0.27f && rr < 2.0f)
        {
          rr_[rr_i_] = rr;
          rr_i_ = (rr_i_ + 1) % 8;
          if (rr_n_ < 8)
            rr_n_++;
        }
      }
      pk_amp_ = 0.8f * pk_amp_ + 0.2f * (p1_ - trough_);
      last_pk_ = t_ms;
      trough_ = p1_;
    }
    if (sm_ < trough_)
      trough_ = sm_;
    amp_ = fmaxf(0.97f * amp_, fabsf(sm_));
    p2_ = p1_;
    p1_ = sm_;
  }
  float hr() const
  {
    if (!contact_ || rr_n_ < 3)
      return NAN;
    float s = 0;
    for (int i = 0; i < rr_n_; ++i)
      s += rr_[i];
    return 60.0f * rr_n_ / s;
  }
  float sqi() const
  {
    float h = hr();
    if (!contact_ || buf_n_ < N / 2 || pk_amp_ <= 0 || isnan(h))
      return 0;
    int t = (int)lroundf(FS * 60.0f / h);
    if (t < 5 || t >= buf_n_ - 5)
      return 0;
    float acc = 0;
    int cnt = 0;
    for (int k = t; k < buf_n_; ++k)
    {
      float d = at(k) - at(k - t);
      acc += d * d;
      cnt++;
    }
    float resid = sqrtf(acc / cnt) + 1e-3f;
    float ratio = pk_amp_ / resid;
    return ratio / (ratio + 4.0f);
  }

private:
  float at(int k) const { return buf_[(buf_i_ - buf_n_ + k + 2 * N) % N]; }
  bool contact_ = false;
  float dc_ = 0, sm_ = 0, p1_ = 0, p2_ = 0, amp_ = 0, trough_ = 0, pk_amp_ = 0;
  uint32_t last_pk_ = 0;
  float buf_[N] = {0};
  int buf_i_ = 0, buf_n_ = 0;
  float rr_[8] = {0};
  int rr_i_ = 0, rr_n_ = 0;
};

static Preferences s_nvs;
static volatile bool s_reset_pending = false;
static volatile bool s_test_mode = false;

void set_state(DevState s)
{
  if (s == g_state)
    return;
  DevState prev = g_state;
  g_state = s;
  LOGF("STATE %s -> %s", stateName(prev), stateName(s));
}

void state_begin()
{
  s_nvs.begin("cardiovest", false);
  s_reset_pending = s_nvs.getBool("reset_pend", false);
  if (s_reset_pending)
    LOGF("STATE: event reset sebelumnya belum terkirim, dikirim saat online");
  
  // SELALU PAKSA KE ST_NORMAL SAAT POWER ON / REBOOT
  s_nvs.putBool("crit_latch", false);
  g_state = ST_NORMAL;
  LOGF("STATE: Perangkat dihidupkan ulang -> Status di-reset ke NORMAL");
  s_test_mode = s_nvs.getBool("test_mode", false);
  LOGF("MODE: %s", s_test_mode ? "test" : "demo");
}

void mode_apply(bool test)
{
  if (test == s_test_mode)
    return;
  s_test_mode = test;
  s_nvs.putBool("test_mode", test);
  LOGF("MODE: %s", test ? "test (semua sensor aktif)" : "demo (GPS siaga)");
}

void state_apply_cloud(DevState s)
{
  if (s == ST_CRITICAL && s_reset_pending && g_state != ST_CRITICAL)
  {
    LOGF("STATE: CRITICAL dari cloud diabaikan, event reset belum diterima cloud");
    return;
  }
  if (g_state == ST_CRITICAL && s != ST_CRITICAL)
  {
    LOGF("STATE: perintah %s dari cloud diabaikan, CRITICAL terkunci", stateName(s));
    return;
  }
  if (s == ST_CRITICAL)
    s_nvs.putBool("crit_latch", true);
  set_state(s);
}

bool state_remote_clear()
{
  s_nvs.putBool("crit_latch", false);
  if (g_state != ST_CRITICAL)
    return false;
  set_state(ST_NORMAL);
  return true;
}

bool state_hardware_reset()
{
  bool was_critical = (g_state == ST_CRITICAL);
  s_nvs.putBool("crit_latch", false);
  s_nvs.putBool("reset_pend", true);
  s_reset_pending = true;
  set_state(ST_NORMAL);
  return was_critical;
}

bool state_reset_pending()
{
  return s_reset_pending;
}

void state_reset_delivered()
{
  if (!s_reset_pending)
    return;
  s_reset_pending = false;
  s_nvs.putBool("reset_pend", false);
}

static volatile uint16_t s_beep_freq = 0;
static volatile uint32_t s_beep_until = 0;

void buzzer_tone(uint16_t f)
{
  if (PIN_BUZZER < 0)
    return;
#if ESP_ARDUINO_VERSION_MAJOR >= 3
  ledcWriteTone(PIN_BUZZER, f);
#else
  ledcWriteTone(0, f);
#endif
}

void leds(bool a, bool b)
{
  if (PIN_LED_A >= 0)
    digitalWrite(PIN_LED_A, a ? HIGH : LOW);
  if (PIN_LED_B >= 0)
    digitalWrite(PIN_LED_B, b ? HIGH : LOW);
}

void alert_beep(uint16_t freq, uint16_t ms)
{
  s_beep_freq = freq;
  s_beep_until = millis() + ms;
}

bool vbus_present()
{
  if (PIN_VBUS_SENSE < 0)
    return false;
  return s_vbus_mv > VBUS_THRESHOLD_MV;
}

void task_alert_local(void *)
{
  uint32_t btn_down_at = 0;
  bool btn_handled = false;
  uint16_t cur_tone = 0;
  uint32_t session_start = millis();
  bool session_warned = false;
  bool was_charging = false;
  for (;;)
  {
    uint32_t t = millis();
    bool chg = vbus_present();
    if (chg != was_charging)
    {
      g_charging = chg;
      was_charging = chg;
      LOGF("SAFETY: %s", chg ? "pengisian daya terdeteksi, akuisisi ECG dikunci" : "pengisian selesai, akuisisi dilanjutkan");
      if (!chg)
      {
        session_start = t;
        session_warned = false;
      }
    }
    if (!session_warned && t - session_start > (uint32_t)SESSION_LIMIT_HOURS * 3600000UL)
    {
      session_warned = true;
      vitals_lock();
      s_vitals.session_limit = true;
      vitals_unlock();
      LOGF("SAFETY: pemakaian lebih dari %d jam, ganti elektroda dan periksa kulit", SESSION_LIMIT_HOURS);
    }
    if (PIN_TOMBOL_RESET >= 0)
    {
      bool pressed = digitalRead(PIN_TOMBOL_RESET) == LOW;
      if (pressed)
      {
        if (!btn_down_at)
          btn_down_at = t;
        if (!btn_handled && t - btn_down_at >= RESET_HOLD_MS)
        {
          btn_handled = true;
          bool was_crit = state_hardware_reset();
          EventType ev = EV_HARDWARE_RESET;
          xQueueSend(q_events, &ev, 0);
          alert_beep(3000, 150);
          LOGF("TOMBOL RESET ditahan %d s: %s", RESET_HOLD_MS / 1000, was_crit ? "CRITICAL dibersihkan" : "event reset dikirim");
        }
      }
      else
      {
        btn_down_at = 0;
        btn_handled = false;
      }
    }
    DevState s = g_state;
    uint16_t tone = 0;
    bool la = false, lb = false;
    if (chg)
    {
      la = true;
      lb = true;
      tone = 0; // Silenkan buzzer saat diisi daya
    }
    else if (s == ST_CRITICAL)
    {
      bool ph = (t / 100) % 2;
      la = ph;
      lb = !ph;
      tone = 4000;
    }
    else if (s == ST_WARNING)
    {
      lb = (t / 500) % 2;
      tone = ((t / 250) % 8 == 0) ? 2000 : 0;
    }
    else
    {
      la = g_net_online ? (t % 3000) < 60 : (t % 1000) < 60;
    }
    if (t < s_beep_until)
      tone = s_beep_freq;
    leds(la, lb);
    if (tone != cur_tone)
    {
      buzzer_tone(tone);
      cur_tone = tone;
    }
    vTaskDelay(pdMS_TO_TICKS(20));
  }
}

void alert_begin()
{
  if (PIN_LED_A >= 0)
    pinMode(PIN_LED_A, OUTPUT);
  if (PIN_LED_B >= 0)
    pinMode(PIN_LED_B, OUTPUT);
  leds(false, false);
  if (PIN_BUZZER >= 0)
  {
#if ESP_ARDUINO_VERSION_MAJOR >= 3
    ledcAttach(PIN_BUZZER, 2000, 10);
#else
    ledcSetup(0, 2000, 10);
    ledcAttachPin(PIN_BUZZER, 0);
#endif
    buzzer_tone(0);
  }
  if (PIN_TOMBOL_RESET >= 0)
    pinMode(PIN_TOMBOL_RESET, INPUT_PULLUP);
  if (PIN_VBUS_SENSE >= 0)
    analogSetPinAttenuation(PIN_VBUS_SENSE, ADC_11db);
  xTaskCreatePinnedToCore(task_alert_local, "alert", 3072, nullptr, 3, nullptr, 1);
}

static QueueHandle_t q_raw = nullptr;
static TaskHandle_t h_acq = nullptr;
static hw_timer_t *s_timer = nullptr;
static volatile bool s_ecg_active = false;
static volatile bool s_plot = false;
static volatile float s_hr_ecg = NAN;
static PanTompkins s_pt(ECG_FS);
static FirBandpass s_fir;
static EcgPacket s_pkt_build;

void IRAM_ATTR on_ecg_timer()
{
  BaseType_t woken = pdFALSE;
  if (h_acq)
    vTaskNotifyGiveFromISR(h_acq, &woken);
  if (woken)
    portYIELD_FROM_ISR();
}

void task_ecg_acquire(void *)
{
  uint32_t k = 0;
  uint16_t last_mv = 0;
  for (;;)
  {
    ulTaskNotifyTake(pdTRUE, portMAX_DELAY);
    k++;
    if (k % 25 == 0)
    {
      uint32_t g = analogRead(PIN_GSR);
      if (g > 0)
      {
        portENTER_CRITICAL(&s_adc_mux);
        s_gsr_sum = s_gsr_sum + g;
        s_gsr_n = s_gsr_n + 1;
        portEXIT_CRITICAL(&s_adc_mux);
      }
    }
    if (PIN_VBUS_SENSE >= 0 && k % ECG_FS == 0)
    {
      uint32_t vb = analogReadMilliVolts(PIN_VBUS_SENSE);
      if (vb > 0)
        s_vbus_mv = vb;
    }
    RawSample r;
    r.lead_off = digitalRead(PIN_ECG_LO_PLUS) || digitalRead(PIN_ECG_LO_MINUS);
    uint32_t mv = analogReadMilliVolts(PIN_ECG_OUT);
    if (mv == 0)
    {
      mv = analogReadMilliVolts(PIN_ECG_OUT);
      if (mv == 0)
      {
        mv = last_mv;
        s_adc_fail = s_adc_fail + 1;
      }
    }
    last_mv = (uint16_t)mv;
    r.mv = (uint16_t)mv;
    if (g_charging)
      r.lead_off = 2;
    if (xQueueSend(q_raw, &r, 0) != pdTRUE)
    {
      RawSample dump;
      xQueueReceive(q_raw, &dump, 0);
      xQueueSend(q_raw, &r, 0);
    }
  }
}

void task_ecg_filter(void *)
{
  DcBlocker dc(ECG_FS, 0.05f);
  Biquad nt;
  nt.notch(ECG_FS, NOTCH_HZ, 30.0f);
  
  // BANDPASS FIR: 0.5 Hz - 30 Hz untuk meredam muscle artifact
  s_fir.design(ECG_FS, 0.5f, 30.0f, ECG_FIR_TAPS);
  
  // ADAPTIVE KALMAN FILTER
  AdaptiveKalman kf(KALMAN_Q, KALMAN_R0, KALMAN_R_MOTION);
  uint64_t group_delay_ms = (uint64_t)s_fir.delaySamples() * 1000ULL / ECG_FS;
  uint16_t idx = 0;
  uint32_t seq = 0;
  bool any_lead_off = false;
  uint32_t lo_run = 0;
  for (;;)
  {
    RawSample r;
    if (xQueueReceive(q_raw, &r, portMAX_DELAY) != pdTRUE)
      continue;
    float y;
    g_lead_off = (r.lead_off == 1);
    if (r.lead_off)
    {
      y = 0;
      if (++lo_run == ECG_FS)
        nt.reset();
      any_lead_off = true;
    }
    else
    {
      lo_run = 0;
      float mv = (float)r.mv / ECG_GAIN;
      float x = nt.process(s_fir.process(dc.process(mv)));
      y = kf.update(x, g_motion);
      if (s_pt.update(y))
        s_hr_ecg = s_pt.heartRate();
    }
    if (s_pt.samplesSinceBeat() > 3 * ECG_FS)
      s_hr_ecg = NAN;
    if (s_plot)
      Serial.println(y * 1000.0f, 1);
    float c = y * ECG_COUNTS_PER_MV;
    s_pkt_build.s[idx++] = (int16_t)constrain(lroundf(c), -32768, 32767);
    if (idx >= ECG_HOP)
    {
      s_pkt_build.t0_ms = now_ms() - (uint64_t)ECG_HOP * 1000ULL / ECG_FS - group_delay_ms;
      s_pkt_build.seq = seq++;
      s_pkt_build.lead_off = any_lead_off;
      s_pkt_build.clock_ok = time_valid();
      if (xQueueSend(q_ecg_packets, &s_pkt_build, 0) != pdTRUE)
      {
        EcgPacket *dump = (EcgPacket *)malloc(sizeof(EcgPacket));
        if (dump)
        {
          xQueueReceive(q_ecg_packets, dump, 0);
          free(dump);
        }
        xQueueSend(q_ecg_packets, &s_pkt_build, 0);
      }
      idx = 0;
      any_lead_off = false;
    }
  }
}

void ecg_begin()
{
  esp_log_level_set("adc_oneshot", ESP_LOG_NONE);
  pinMode(PIN_ECG_LO_PLUS, INPUT);
  pinMode(PIN_ECG_LO_MINUS, INPUT);
  analogReadResolution(12);
  analogSetPinAttenuation(PIN_ECG_OUT, ADC_11db);
  q_raw = xQueueCreate(ECG_FS, sizeof(RawSample));
  xTaskCreatePinnedToCore(task_ecg_filter, "ecg_filter", 4096, nullptr, 4, nullptr, 1);
  xTaskCreatePinnedToCore(task_ecg_acquire, "ecg_acq", 3072, nullptr, 5, &h_acq, 1);
#if ESP_ARDUINO_VERSION_MAJOR >= 3
  s_timer = timerBegin(1000000);
  timerAttachInterrupt(s_timer, &on_ecg_timer);
  timerAlarm(s_timer, 1000000 / ECG_FS, true, 0);
#else
  s_timer = timerBegin(0, 80, true);
  timerAttachInterrupt(s_timer, &on_ecg_timer, true);
  timerAlarmWrite(s_timer, 1000000 / ECG_FS, true);
  timerAlarmEnable(s_timer);
#endif
  s_ecg_active = true;
  LOGF("ECG: AD8232 aktif di GPIO%d, %d Hz", PIN_ECG_OUT, ECG_FS);
}

bool i2c_write(uint8_t addr, uint8_t reg, uint8_t val)
{
  Wire.beginTransmission(addr);
  Wire.write(reg);
  Wire.write(val);
  return Wire.endTransmission() == 0;
}

bool i2c_read(uint8_t addr, uint8_t reg, uint8_t *buf, uint8_t n)
{
  Wire.beginTransmission(addr);
  Wire.write(reg);
  if (Wire.endTransmission(false) != 0)
    return false;
  if (Wire.requestFrom(addr, n) != n)
    return false;
  for (uint8_t i = 0; i < n; i++)
    buf[i] = Wire.read();
  return true;
}

bool i2c_present(uint8_t addr)
{
  Wire.beginTransmission(addr);
  return Wire.endTransmission() == 0;
}

static char s_i2c_scan[64] = "belum dipindai";

void i2c_scan()
{
  char buf[64];
  int n = 0;
  buf[0] = 0;
  for (uint8_t a = 0x08; a < 0x78; a++)
  {
    if (!i2c_present(a))
      continue;
    if (n < (int)sizeof(buf) - 6)
      n += snprintf(buf + n, sizeof(buf) - n, n ? " 0x%02X" : "0x%02X", a);
  }
  if (!n)
    snprintf(buf, sizeof(buf), "kosong");
  if (strcmp(buf, s_i2c_scan))
  {
    memcpy(s_i2c_scan, buf, sizeof(buf));
    LOGF("I2C SDA=GPIO%d SCL=GPIO%d: %s", PIN_I2C_SDA, PIN_I2C_SCL, s_i2c_scan);
  }
}

bool mpu_begin()
{
  uint8_t addr = 0;
  if (i2c_present(0x68))
    addr = 0x68;
  else if (i2c_present(0x69))
    addr = 0x69;
  if (!addr)
    return false;
  uint8_t who = 0;
  if (!i2c_read(addr, 0x75, &who, 1))
    return false;
  bool ok = i2c_write(addr, 0x6B, 0x00) && i2c_write(addr, 0x1A, 0x03) && i2c_write(addr, 0x1C, 0x10);
  if (!ok)
    return false;
  s_has.imu_addr = addr;
  s_has.imu_who = who;
  return true;
}

bool mpu_read(float &ax, float &ay, float &az)
{
  uint8_t b[6];
  if (!i2c_read(s_has.imu_addr, 0x3B, b, 6))
    return false;
  int16_t x = (int16_t)((b[0] << 8) | b[1]);
  int16_t y = (int16_t)((b[2] << 8) | b[3]);
  int16_t z = (int16_t)((b[4] << 8) | b[5]);
  ax = x / 4096.0f;
  ay = y / 4096.0f;
  az = z / 4096.0f;
  return true;
}

bool max_begin()
{
  uint8_t id = 0;
  if (!i2c_read(0x57, 0xFF, &id, 1))
    return false;
  s_has.ppg_id = id;
  if (id != 0x15)
    return false;
  i2c_write(0x57, 0x09, 0x40);
  delay(100);
  bool ok = i2c_write(0x57, 0x08, 0x70);
  ok = ok && i2c_write(0x57, 0x09, 0x03);
  ok = ok && i2c_write(0x57, 0x0A, 0x6F);
  ok = ok && i2c_write(0x57, 0x0C, 0x3F);
  ok = ok && i2c_write(0x57, 0x0D, 0x3F);
  ok = ok && i2c_write(0x57, 0x04, 0x00);
  ok = ok && i2c_write(0x57, 0x05, 0x00);
  ok = ok && i2c_write(0x57, 0x06, 0x00);
  return ok;
}

int max_read_ir(uint32_t *out, int cap, bool *ok)
{
  uint8_t wr = 0, rd = 0;
  *ok = false;
  if (!i2c_read(0x57, 0x04, &wr, 1) || !i2c_read(0x57, 0x06, &rd, 1))
    return 0;
  *ok = true;
  int n = (wr - rd) & 0x1F;
  if (n > cap)
    n = cap;
  int got = 0;
  for (int i = 0; i < n; i++)
  {
    uint8_t b[6];
    if (!i2c_read(0x57, 0x07, b, 6))
    {
      *ok = false;
      break;
    }
    out[got++] = (((uint32_t)b[3] << 16) | ((uint32_t)b[4] << 8) | b[5]) & 0x3FFFF;
  }
  return got;
}

float gsr_adc_to_us(float a)
{
  if (a >= GSR_ADC_NO_SKIN - 5)
    return NAN;
  float r = ((4096.0f + 2.0f * a) * GSR_R_REF) / (GSR_ADC_NO_SKIN - a);
  return r > 0 ? 1e6f / r : NAN;
}

bool gsr_take_adc(float *adc)
{
  portENTER_CRITICAL(&s_adc_mux);
  uint32_t sum = s_gsr_sum, n = s_gsr_n;
  s_gsr_sum = 0;
  s_gsr_n = 0;
  portEXIT_CRITICAL(&s_adc_mux);
  if (n == 0)
    return false;
  *adc = (float)sum / n;
  return true;
}

static PpgProcessor s_ppgp;
static volatile float s_gsr_adc_last = NAN;

void task_sensor_aux(void *)
{
  FallDetector fall;
  TickType_t last = xTaskGetTickCount();
  uint32_t tick = 0, fall_until = 0;
  float sx = 0, sy = 0, sz = 0, sm = 0, smm = 0;
  int sn = 0;
  float ax_m = 0, ay_m = 0, az_m = 1, amag = 1, amag_sd = 0;
  uint64_t fall_ts = 0;
  float gsr_ema = NAN;
  uint32_t ir[32];
  int imu_fail = 0;
  int ppg_fail = 0;
  uint32_t ppg_pause_until = 0;
  uint32_t imu_pause_until = 0;
  uint32_t probe_at = 5000;
  for (;;)
  {
    vTaskDelayUntil(&last, pdMS_TO_TICKS(10));
    uint32_t t = millis();
    tick++;
    if (t >= probe_at && (!s_has.ppg || !s_has.imu))
    {
      probe_at = t + 5000;
      i2c_scan();
      if (!s_has.ppg && (s_has.ppg = max_begin()))
        LOGF("PPG: MAX30102 terdeteksi, LED merah dan IR menyala");
      if (!s_has.imu && (s_has.imu = mpu_begin()))
        LOGF("IMU: terdeteksi di 0x%02X", s_has.imu_addr);
    }
    if (s_has.imu && t >= imu_pause_until)
    {
      float ax, ay, az;
      if (mpu_read(ax, ay, az))
      {
        imu_fail = 0;
        float mag = sqrtf(ax * ax + ay * ay + az * az);
        g_motion = 0.9f * g_motion + 0.1f * fabsf(mag - 1.0f);
        sx += ax;
        sy += ay;
        sz += az;
        sm += mag;
        smm += mag * mag;
        sn++;
        if (fall.update(mag, t))
        {
          fall_until = t + FALL_FLAG_HOLD_MS;
          fall_ts = now_ms();
          if (s_test_mode)
            alert_beep(2500, 800);
          LOGF("IMU: JATUH TERDETEKSI (|a| = %.2f g)", mag);
        }
      }
      else if (++imu_fail >= 10)
      {
        imu_fail = 0;
        imu_pause_until = t + 3000;
        LOGF("IMU: I2C gagal berulang, coba ulang 3 s lagi");
        if (mpu_begin())
          LOGF("IMU: tersambung ulang");
      }
    }
    if (s_has.ppg && (tick % 2 == 0) && t >= ppg_pause_until)
    {
      bool ok = true;
      int n = max_read_ir(ir, 32, &ok);
      for (int i = 0; i < n; i++)
        s_ppgp.add(ir[i], t);
      if (!ok && ++ppg_fail >= 10)
      {
        ppg_fail = 0;
        ppg_pause_until = t + 5000;
        LOGF("PPG: I2C gagal berulang, jeda 5 s");
      }
      else if (ok)
      {
        ppg_fail = 0;
      }
    }
    float gsr_adc;
    if (s_has.gsr && (tick % 10 == 0) && gsr_take_adc(&gsr_adc))
    {
      float g = gsr_adc_to_us(gsr_adc);
      s_gsr_adc_last = gsr_adc;
      if (isnan(g))
        gsr_ema = NAN;
      else
        gsr_ema = isnan(gsr_ema) ? g : 0.7f * gsr_ema + 0.3f * g;
    }
    if (tick % 100 == 0)
    {
      if (sn)
      {
        ax_m = sx / sn;
        ay_m = sy / sn;
        az_m = sz / sn;
        float mean = sm / sn;
        amag_sd = sqrtf(fmaxf(smm / sn - mean * mean, 0.0f));
      }
      amag = sqrtf(ax_m * ax_m + ay_m * ay_m + az_m * az_m);
      bool imu_ok = s_has.imu && sn > 0;
      sx = sy = sz = sm = smm = 0;
      sn = 0;
      bool falling = t < fall_until;
      vitals_lock();
      s_vitals.imu_ok = imu_ok;
      s_vitals.ax = ax_m;
      s_vitals.ay = ay_m;
      s_vitals.az = az_m;
      s_vitals.amag = amag;
      s_vitals.amag_sd = amag_sd;
      s_vitals.ppg_ok = s_has.ppg;
      s_vitals.hr_ppg = s_ppgp.hr();
      s_vitals.sqi = s_ppgp.sqi();
      s_vitals.gsr_ok = s_has.gsr && !isnan(gsr_ema);
      s_vitals.gsr_us = gsr_ema;
      s_vitals.fall_detected = falling;
      s_vitals.fall_ts = falling ? fall_ts : 0;
      vitals_unlock();
    }
  }
}

void sensors_begin()
{
  Wire.begin(PIN_I2C_SDA, PIN_I2C_SCL);
  Wire.setClock(I2C_CLOCK_HZ);
  Wire.setTimeOut(50);
  i2c_scan();
  s_has.imu = mpu_begin();
  if (s_has.imu)
    LOGF("IMU: terdeteksi di 0x%02X, WHO_AM_I 0x%02X, rentang 8 g", s_has.imu_addr, s_has.imu_who);
  else
    LOGF("IMU: tidak terdeteksi di 0x68 atau 0x69, dilewati");
  s_has.ppg = max_begin();
  if (s_has.ppg)
    LOGF("PPG: MAX30102 terdeteksi, 50 Hz");
  else if (s_has.ppg_id == 0x11)
    LOGF("PPG: terdeteksi MAX30100 (bukan MAX30102), PPG dilewati");
  else if (s_has.ppg_id)
    LOGF("PPG: chip di 0x57 ber-ID 0x%02X, bukan MAX30102 (0x15)", s_has.ppg_id);
  else
    LOGF("PPG: MAX30102 tidak terdeteksi di 0x57, dicoba lagi tiap 5 s");
  analogSetPinAttenuation(PIN_GSR, ADC_11db);
  s_has.gsr = true;
  LOGF("GSR: FZ3294 di GPIO%d", PIN_GSR);
  xTaskCreatePinnedToCore(task_sensor_aux, "sensor_aux", 4096, nullptr, 3, nullptr, 1);
}

HardwareSerial SerialGPS(1);
static const long GPS_BAUD[] = {9600, 38400, 4800, 57600, 115200};
static portMUX_TYPE s_gps_mux = portMUX_INITIALIZER_UNLOCKED;
static GpsFix s_gps_fix;
static int s_gps_baud_idx = 0;
static char s_gps_line[128];
static int s_gps_len = 0;
static double s_gps_lat = 0, s_gps_lon = 0;
static int s_gps_quality = 0, s_gps_sats = 0;
static float s_gps_hdop = 0;
static bool s_gps_rmc_valid = false;
static uint32_t s_gps_last_valid = 0;

bool nmea_checksum_ok(const char *s)
{
  const char *star = strchr(s, '*');
  if (s[0] != '$' || star == NULL || strlen(star) < 3)
    return false;
  uint8_t cs = 0;
  for (const char *p = s + 1; p < star; p++)
    cs ^= (uint8_t)*p;
  char hex[3] = {star[1], star[2], 0};
  return cs == (uint8_t)strtol(hex, NULL, 16);
}

int nmea_split(char *s, char *f[], int maks)
{
  int n = 0;
  f[n++] = s;
  for (char *p = s; *p && n < maks; p++)
  {
    if (*p == ',' || *p == '*')
    {
      *p = 0;
      f[n++] = p + 1;
    }
  }
  return n;
}

double nmea_degrees(const char *v, const char *dir)
{
  if (v[0] == 0)
    return 0;
  double x = atof(v);
  int d = (int)(x / 100);
  double h = d + (x - d * 100) / 60.0;
  if (dir[0] == 'S' || dir[0] == 'W')
    h = -h;
  return h;
}

void nmea_process(char *s)
{
  if (!nmea_checksum_ok(s))
    return;
  s_gps_last_valid = millis();
  char *f[25];
  int n = nmea_split(s, f, 25);
  if (strlen(f[0]) < 6)
    return;
  const char *type = f[0] + 3;
  if (!strcmp(type, "GGA") && n >= 10)
  {
    s_gps_quality = atoi(f[6]);
    s_gps_sats = atoi(f[7]);
    s_gps_hdop = atof(f[8]);
    if (s_gps_quality > 0)
    {
      s_gps_lat = nmea_degrees(f[2], f[3]);
      s_gps_lon = nmea_degrees(f[4], f[5]);
    }
  }
  else if (!strcmp(type, "RMC") && n >= 10)
  {
    s_gps_rmc_valid = (f[2][0] == 'A');
  }
}

void task_gps(void *)
{
  uint32_t last_baud_change = millis();
  for (;;)
  {
    int budget = 512;
    while (SerialGPS.available() && budget-- > 0)
    {
      char c = (char)SerialGPS.read();
      if (c == '$')
        s_gps_len = 0;
      if (c == '\r')
        continue;
      if (c == '\n')
      {
        s_gps_line[s_gps_len] = 0;
        if (s_gps_len > 6)
          nmea_process(s_gps_line);
        s_gps_len = 0;
        continue;
      }
      if (s_gps_len < (int)sizeof(s_gps_line) - 1)
        s_gps_line[s_gps_len++] = c;
    }
    uint32_t now = millis();
    bool locked = s_gps_last_valid && now - s_gps_last_valid < 10000;
    if (!locked && now - last_baud_change > 3000)
    {
      last_baud_change = now;
      s_gps_baud_idx = (s_gps_baud_idx + 1) % 5;
      SerialGPS.updateBaudRate(GPS_BAUD[s_gps_baud_idx]);
      s_gps_len = 0;
    }
    GpsFix f;
    f.active = (g_state == ST_CRITICAL) || s_test_mode;
    f.fix = locked && s_gps_quality > 0 && s_gps_rmc_valid;
    f.nmea = locked;
    f.baud = GPS_BAUD[s_gps_baud_idx];
    f.hdop = s_gps_hdop;
    f.lat = s_gps_lat;
    f.lon = s_gps_lon;
    f.sats = s_gps_sats;
    f.accuracy_m = s_gps_hdop * 2.5f;
    portENTER_CRITICAL(&s_gps_mux);
    s_gps_fix = f;
    portEXIT_CRITICAL(&s_gps_mux);
    vTaskDelay(pdMS_TO_TICKS(50));
  }
}

GpsFix gps_get()
{
  portENTER_CRITICAL(&s_gps_mux);
  GpsFix f = s_gps_fix;
  portEXIT_CRITICAL(&s_gps_mux);
  return f;
}

void gps_begin()
{
  SerialGPS.setRxBufferSize(1024);
  SerialGPS.begin(GPS_BAUD[0], SERIAL_8N1, PIN_GPS_RX, PIN_GPS_TX);
  xTaskCreatePinnedToCore(task_gps, "gps", 4096, nullptr, 2, nullptr, 0);
  LOGF("GPS: Neo-6M di RX%d TX%d, baud dideteksi otomatis", PIN_GPS_RX, PIN_GPS_TX);
}

static const char *OB_DIR = "/ob";
static const char *OB_HEAD = "/ob/head";
static bool s_ob_ok = false;
static SemaphoreHandle_t s_ob_mx = nullptr;
static uint32_t s_ob_head = 0, s_ob_tail = 0, s_ob_head_off = 0, s_ob_tail_size = 0;
static size_t s_ob_pending = 0;
static uint8_t s_ob_rec[6144];

void ob_seg_path(uint32_t n, char *out, size_t cap)
{
  snprintf(out, cap, "%s/%lu.bin", OB_DIR, (unsigned long)n);
}

size_t ob_file_size(const char *p)
{
  if (!LittleFS.exists(p))
    return 0;
  File f = LittleFS.open(p, "r");
  size_t n = f ? f.size() : 0;
  if (f)
    f.close();
  return n;
}

void ob_save_head()
{
  File f = LittleFS.open(OB_HEAD, "w");
  if (!f)
    return;
  uint8_t b[8];
  for (int i = 0; i < 4; ++i)
  {
    b[i] = s_ob_head >> (24 - 8 * i);
    b[4 + i] = s_ob_head_off >> (24 - 8 * i);
  }
  f.write(b, 8);
  f.close();
}

void ob_load_head(uint32_t min_seg)
{
  s_ob_head = min_seg;
  s_ob_head_off = 0;
  File f = LittleFS.open(OB_HEAD, "r");
  if (!f)
    return;
  uint8_t b[8];
  if (f.read(b, 8) == 8)
  {
    uint32_t h = 0, o = 0;
    for (int i = 0; i < 4; ++i)
    {
      h = (h << 8) | b[i];
      o = (o << 8) | b[4 + i];
    }
    char p[32];
    ob_seg_path(h, p, sizeof(p));
    if (LittleFS.exists(p) && o <= ob_file_size(p))
    {
      s_ob_head = h;
      s_ob_head_off = o;
    }
  }
  f.close();
}

void ob_scan()
{
  uint32_t lo = UINT32_MAX, hi = 0;
  bool any = false;
  File dir = LittleFS.open(OB_DIR);
  if (dir && dir.isDirectory())
  {
    for (File f = dir.openNextFile(); f; f = dir.openNextFile())
    {
      const char *nm = f.name();
      const char *base = strrchr(nm, '/');
      base = base ? base + 1 : nm;
      char *end = nullptr;
      unsigned long n = strtoul(base, &end, 10);
      if (end && !strcmp(end, ".bin"))
      {
        any = true;
        if (n < lo)
          lo = n;
        if (n > hi)
          hi = n;
      }
      f.close();
    }
  }
  if (dir)
    dir.close();
  if (!any)
  {
    s_ob_head = s_ob_tail = s_ob_head_off = s_ob_tail_size = 0;
    s_ob_pending = 0;
    return;
  }
  ob_load_head(lo);
  if (s_ob_head < lo || s_ob_head > hi)
  {
    s_ob_head = lo;
    s_ob_head_off = 0;
  }
  s_ob_tail = hi;
  char p[32];
  ob_seg_path(s_ob_tail, p, sizeof(p));
  s_ob_tail_size = ob_file_size(p);
  s_ob_pending = 0;
  for (uint32_t n = s_ob_head; n <= s_ob_tail; ++n)
  {
    ob_seg_path(n, p, sizeof(p));
    s_ob_pending += ob_file_size(p);
  }
  s_ob_pending -= s_ob_head_off;
}

void obuf_begin()
{
  s_ob_mx = xSemaphoreCreateMutex();
  s_ob_ok = LittleFS.begin(true);
  if (s_ob_ok)
  {
    if (!LittleFS.exists(OB_DIR))
      LittleFS.mkdir(OB_DIR);
    ob_scan();
  }
  LOGF("BUFFER: LittleFS %s, antrean tersimpan %u byte", s_ob_ok ? "siap" : "GAGAL", (unsigned)s_ob_pending);
}

size_t obuf_size()
{
  return s_ob_ok ? s_ob_pending : 0;
}

void obuf_clear()
{
  if (!s_ob_ok)
    return;
  xSemaphoreTake(s_ob_mx, portMAX_DELAY);
  char p[32];
  for (uint32_t n = s_ob_head; n <= s_ob_tail; ++n)
  {
    ob_seg_path(n, p, sizeof(p));
    LittleFS.remove(p);
  }
  LittleFS.remove(OB_HEAD);
  s_ob_head = s_ob_tail = s_ob_head_off = s_ob_tail_size = 0;
  s_ob_pending = 0;
  xSemaphoreGive(s_ob_mx);
}

bool obuf_push(BufKind kind, const uint8_t *data, uint16_t len)
{
  if (!s_ob_ok)
    return false;
  xSemaphoreTake(s_ob_mx, portMAX_DELAY);
  bool ok = false;
  size_t rec = (size_t)len + 3;
  if (s_ob_pending + rec <= (size_t)OFFLINE_BUFFER_MAX_KB * 1024)
  {
    if (s_ob_tail_size > 0 && s_ob_tail_size + rec > OBUF_SEGMENT_BYTES)
    {
      s_ob_tail++;
      s_ob_tail_size = 0;
    }
    char p[32];
    ob_seg_path(s_ob_tail, p, sizeof(p));
    File f = LittleFS.open(p, "a");
    if (f)
    {
      uint8_t h[3] = {(uint8_t)kind, (uint8_t)(len >> 8), (uint8_t)len};
      ok = f.write(h, 3) == 3 && f.write(data, len) == len;
      f.close();
      if (ok)
      {
        s_ob_tail_size += rec;
        s_ob_pending += rec;
      }
    }
  }
  xSemaphoreGive(s_ob_mx);
  return ok;
}

int obuf_flush(ObufSender send, int max_records)
{
  if (!s_ob_ok || s_ob_pending == 0)
    return 0;
  xSemaphoreTake(s_ob_mx, portMAX_DELAY);
  int sent = 0;
  bool failed = false;
  char p[32];
  while (sent < max_records && !failed && s_ob_pending > 0)
  {
    ob_seg_path(s_ob_head, p, sizeof(p));
    File in = LittleFS.open(p, "r");
    if (!in)
    {
      if (s_ob_head >= s_ob_tail)
      {
        s_ob_pending = 0;
        break;
      }
      s_ob_head++;
      s_ob_head_off = 0;
      continue;
    }
    in.seek(s_ob_head_off);
    while (sent < max_records && in.available() >= 3)
    {
      uint8_t h[3];
      in.read(h, 3);
      uint16_t len = (h[1] << 8) | h[2];
      if (len > sizeof(s_ob_rec) || in.read(s_ob_rec, len) != len)
      {
        s_ob_pending -= min((size_t)s_ob_pending, (size_t)(in.size() - s_ob_head_off));
        s_ob_head_off = in.size();
        break;
      }
      if (!send((BufKind)h[0], s_ob_rec, len))
      {
        failed = true;
        break;
      }
      s_ob_head_off += 3 + len;
      s_ob_pending -= min((size_t)s_ob_pending, (size_t)(3 + len));
      sent++;
    }
    bool done = !in.available();
    in.close();
    if (!done || failed)
      break;
    LittleFS.remove(p);
    if (s_ob_head >= s_ob_tail)
    {
      s_ob_tail++;
      s_ob_head = s_ob_tail;
      s_ob_head_off = 0;
      s_ob_tail_size = 0;
      s_ob_pending = 0;
      break;
    }
    s_ob_head++;
    s_ob_head_off = 0;
  }
  ob_save_head();
  xSemaphoreGive(s_ob_mx);
  if (sent)
    LOGF("BUFFER: %d pesan dikirim ulang, sisa %u byte", sent, (unsigned)s_ob_pending);
  return sent;
}

void put_u16(uint8_t *b, uint16_t v)
{
  b[0] = v >> 8;
  b[1] = v;
}

void put_u32(uint8_t *b, uint32_t v)
{
  for (int i = 0; i < 4; ++i)
    b[i] = v >> (24 - 8 * i);
}

void put_u64(uint8_t *b, uint64_t v)
{
  for (int i = 0; i < 8; ++i)
    b[i] = v >> (56 - 8 * i);
}

size_t encode_ecg_binary(const EcgPacket &p, bool buffered, uint8_t *o, size_t cap)
{
  if (cap < 20 + 2 + (size_t)ECG_HOP * 3)
    return 0;
  o[0] = 'C';
  o[1] = 'V';
  o[2] = 1;
  o[3] = (buffered ? 0x01 : 0) | (p.lead_off ? 0x02 : 0) | (p.clock_ok ? 0 : 0x04);
  put_u32(o + 4, p.seq);
  put_u64(o + 8, p.t0_ms);
  put_u16(o + 16, ECG_FS);
  put_u16(o + 18, ECG_HOP);
  size_t n = 20;
  put_u16(o + n, (uint16_t)p.s[0]);
  n += 2;
  for (int i = 1; i < ECG_HOP; ++i)
  {
    int32_t d = (int32_t)p.s[i] - (int32_t)p.s[i - 1];
    if (d >= -127 && d <= 127)
    {
      o[n++] = (uint8_t)(int8_t)d;
    }
    else
    {
      if (d > 32767)
        d = 32767;
      if (d < -32768)
        d = -32768;
      o[n++] = 0x80;
      put_u16(o + n, (uint16_t)(int16_t)d);
      n += 2;
    }
  }
  return n;
}

size_t encode_ecg_json(const EcgPacket &p, bool buffered, char *o, size_t cap)
{
  int n = snprintf(o, cap,
                   "{\"device_id\":\"%s\",\"seq\":%lu,\"t0\":%llu,\"fs\":%d,\"n\":%d,"
                   "\"unit\":\"count (1 mV = 500)\",\"buffered\":%s,\"lead_off\":%s,\"time_valid\":%s,\"samples\":[",
                   DEVICE_ID, (unsigned long)p.seq, (unsigned long long)p.t0_ms, ECG_FS, ECG_HOP,
                   buffered ? "true" : "false", p.lead_off ? "true" : "false", p.clock_ok ? "true" : "false");
  for (int i = 0; i < ECG_HOP && n > 0 && (size_t)n < cap - 8; ++i)
    n += snprintf(o + n, cap - n, i ? ",%d" : "%d", p.s[i]);
  if (n <= 0 || (size_t)n >= cap - 3)
    return 0;
  n += snprintf(o + n, cap - n, "]}");
  return n;
}

void json_add(char *out, size_t cap, int *n, const char *fmt, ...)
{
  if (*n < 0 || (size_t)*n >= cap)
    return;
  va_list ap;
  va_start(ap, fmt);
  int w = vsnprintf(out + *n, cap - *n, fmt, ap);
  va_end(ap);
  *n = (w < 0) ? -1 : *n + w;
}

const char *json_num(char *buf, size_t cap, float v, int decimals)
{
  if (isnan(v) || isinf(v))
    return "null";
  snprintf(buf, cap, "%.*f", decimals, v);
  return buf;
}

const char *json_bool(bool b)
{
  return b ? "true" : "false";
}

size_t encode_vital_json(const Vitals &v, float hr_ecg, const GpsFix &g, bool buffered, char *out, size_t cap)
{
  char a[20], b[20], c[20], d[20], e[20];
  bool ppg_good = v.ppg_ok && !isnan(v.hr_ppg) && v.sqi >= TAU_SQI;
  float hr = ppg_good ? v.hr_ppg : hr_ecg;
  float gsr = (v.gsr_ok && !isnan(v.gsr_us)) ? v.gsr_us : NAN;
  int n = 0;
  json_add(out, cap, &n, "{\"device_id\":\"%s\",\"ts\":%llu,", DEVICE_ID, (unsigned long long)now_ms());
  json_add(out, cap, &n, "\"hr\":%s,\"hr_source\":\"%s\",\"hr_ppg\":%s,\"hr_ecg\":%s,\"sqi\":%s,\"gsr\":%s,",
           json_num(a, sizeof(a), hr, 1), ppg_good ? "PPG" : "ECG", json_num(b, sizeof(b), v.hr_ppg, 1),
           json_num(c, sizeof(c), hr_ecg, 1), json_num(d, sizeof(d), v.sqi, 2), json_num(e, sizeof(e), gsr, 2));
  if (v.imu_ok)
  {
    char sx[16], sy[16], sz[16], sm[16], sd[16];
    json_add(out, cap, &n, "\"accel\":{\"x\":%s,\"y\":%s,\"z\":%s,\"mag\":%s,\"sd\":%s},",
             json_num(sx, sizeof(sx), v.ax, 3), json_num(sy, sizeof(sy), v.ay, 3), json_num(sz, sizeof(sz), v.az, 3),
             json_num(sm, sizeof(sm), v.amag, 3), json_num(sd, sizeof(sd), v.amag_sd, 3));
  }
  else
  {
    json_add(out, cap, &n, "\"accel\":null,");
  }
  if (v.fall_detected)
    json_add(out, cap, &n, "\"fall_detected\":true,\"fall_ts\":%llu,", (unsigned long long)v.fall_ts);
  else
    json_add(out, cap, &n, "\"fall_detected\":false,\"fall_ts\":null,");
  json_add(out, cap, &n, "\"local_state\":\"%s\",\"mode\":\"%s\",", stateName(g_state), s_test_mode ? "test" : "demo");
  if (!g.active)
  {
    json_add(out, cap, &n, "\"gps\":null,");
  }
  else if (g.fix)
  {
    json_add(out, cap, &n, "\"gps\":{\"fix\":true,\"sats\":%d,\"lat\":%.6f,\"lon\":%.6f,\"accuracy_m\":%.1f,\"hdop\":%.1f,\"nmea\":true,\"baud\":%ld},",
             g.sats, g.lat, g.lon, g.accuracy_m, g.hdop, g.baud);
  }
  else
  {
    json_add(out, cap, &n, "\"gps\":{\"fix\":false,\"sats\":%d,\"nmea\":%s,\"baud\":%ld},", g.sats, json_bool(g.nmea), g.baud);
  }
  json_add(out, cap, &n, "\"buffered\":%s,\"lead_off\":%s,\"charging\":%s,\"session_limit\":%s,",
           json_bool(buffered), json_bool(v.lead_off), json_bool(v.charging), json_bool(v.session_limit));
  json_add(out, cap, &n, "\"i2c\":\"%s\",\"ppg_id\":%u,", s_i2c_scan, (unsigned)s_has.ppg_id);
  json_add(out, cap, &n, "\"sensors\":{\"ecg\":%s,\"ppg\":%s,\"gsr\":%s,\"imu\":%s}}",
           json_bool(v.ecg_ok), json_bool(v.ppg_ok), json_bool(v.gsr_ok), json_bool(v.imu_ok));
  return (n < 0 || (size_t)n >= cap) ? 0 : (size_t)n;
}

size_t encode_event_json(EventType e, char *out, size_t cap)
{
  int n = snprintf(out, cap, "{\"device_id\":\"%s\",\"type\":\"%s\",\"hold_s\":%.1f,\"ts\":%llu,\"local_state\":\"%s\"}",
                   DEVICE_ID, e == EV_HARDWARE_RESET ? "hardware_reset" : "unknown", RESET_HOLD_MS / 1000.0,
                   (unsigned long long)now_ms(), stateName(g_state));
  return (n < 0 || (size_t)n >= cap) ? 0 : (size_t)n;
}

#if MQTT_USE_TLS && !MQTT_TLS_INSECURE
static const char MQTT_CA_CERT[] =
    "-----BEGIN CERTIFICATE-----\n"
    "MIIFazCCA1OgAwIBAgIRAIIQz7DSQONZRGPgu2OCiwAwDQYJKoZIhvcNAQELBQAw\n"
    "TzELMAkGA1UEBhMCVVMxKTAnBgNVBAoTIEludGVybmV0IFNlY3VyaXR5IFJlc2Vh\n"
    "cmNoIEdyb3VwMRUwEwYDVQQDEwxJU1JHIFJvb3QgWDEwHhcNMTUwNjA0MTEwNDM4\n"
    "WhcNMzUwNjA0MTEwNDM4WjBPMQswCQYDVQQGEwJVUzEpMCcGA1UEChMgSW50ZXJu\n"
    "ZXQgU2VjdXJpdHkgUmVzZWFyY2ggR3JvdXAxFTATBgNVBAMTDElTUkcgUm9vdCBY\n"
    "MTCCAiIwDQYJKoZIhvcNAQEBBQADggIPADCCAgoCggIBAK3oJHP0FDfzm54rVygc\n"
    "h77ct984kIxuPOZXoHj3dcKi/vVqbvYATyjb3miGbESTtrFj/RQSa78f0uoxmyF+\n"
    "0TM8ukj13Xnfs7j/EvEhmkvBioZxaUpmZmyPfjxwv60pIgbz5MDmgK7iS4+3mX6U\n"
    "A5/TR5d8mUgjU+g4rk8Kb4Mu0UlXjIB0ttov0DiNewNwIRt18jA8+o+u3dpjq+sW\n"
    "T8KOEUt+zwvo/7V3LvSye0rgTBIlDHCNAymg4VMk7BPZ7hm/ELNKjD+Jo2FR3qyH\n"
    "B5T0Y3HsLuJvW5iB4YlcNHlsdu87kGJ55tukmi8mxdAQ4Q7e2RCOFvu396j3x+UC\n"
    "B5iPNgiV5+I3lg02dZ77DnKxHZu8A/lJBdiB3QW0KtZB6awBdpUKD9jf1b0SHzUv\n"
    "KBds0pjBqAlkd25HN7rOrFleaJ1/ctaJxQZBKT5ZPt0m9STJEadao0xAH0ahmbWn\n"
    "OlFuhjuefXKnEgV4We0+UXgVCwOPjdAvBbI+e0ocS3MFEvzG6uBQE3xDk3SzynTn\n"
    "jh8BCNAw1FtxNrQHusEwMFxIt4I7mKZ9YIqioymCzLq9gwQbooMDQaHWBfEbwrbw\n"
    "qHyGO0aoSCqI3Haadr8faqU9GY/rOPNk3sgrDQoo/"
    "/fb4hVC1CLQJ13hef4Y53CI\n"
    "rU7m2Ys6xt0nUW7/vGT1M0NPAgMBAAGjQjBAMA4GA1UdDwEB/wQEAwIBBjAPBgNV\n"
    "HRMBAf8EBTADAQH/MB0GA1UdDgQWBBR5tFnme7bl5AFzgAiIyBpY9umbbjANBgkq\n"
    "hkiG9w0BAQsFAAOCAgEAVR9YqbyyqFDQDLHYGmkgJykIrGF1XIpu+ILlaS/V9lZL\n"
    "ubhzEFnTIZd+50xx+7LSYK05qAvqFyFWhfFQDlnrzuBZ6brJFe+GnY+EgPbk6ZGQ\n"
    "3BebYhtF8GaV0nxvwuo77x/Py9auJ/GpsMiu/X1+mvoiBOv/2X/qkSsisRcOj/KK\n"
    "NFtY2PwByVS5uCbMiogziUwthDyC3+6WVwW6LLv3xLfHTjuCvjHIInNzktHCgKQ5\n"
    "ORAzI4JMPJ+GslWYHb4phowim57iaztXOoJwTdwJx4nLCgdNbOhdjsnvzqvHu7Ur\n"
    "TkXWStAmzOVyyghqpZXjFaH3pO3JLF+l+/+sKAIuvtd7u+Nxe5AW0wdeRlN8NwdC\n"
    "jNPElpzVmbUq4JUagEiuTDkHzsxHpFKVK7q4+63SM1N95R1NbdWhscdCb+ZAJzVc\n"
    "oyi3B43njTOQ5yOf+1CceWxG1bQVs5ZufpsMljq4Ui0/1lvh+wjChP4kqKOJ2qxq\n"
    "4RgqsahDYVvTH9w7jXbyLeiNdd8XM2w9U/t7y0Ff/9yi0GE44Za4rF2LN9d11TPA\n"
    "mRGunUHBcnWEvgJBQl9nJEiU0Zsnvgc/ubhPgXRR4Xq37Z0j4r7g1SgEEzwxA57d\n"
    "emyPxgcYxn/eR44/KJ4EBs+lVDR3veyJm+kXQ99b21/+jh5Xos1AnX5iItreGCc=\n"
    "-----END CERTIFICATE-----\n";
#endif

#if USE_MODEM
HardwareSerial SerialAT(2);
TinyGsm modem(SerialAT);
#endif

#if CONN_MODE == CONN_WIFI
#if MQTT_USE_TLS
WiFiClientSecure net;
#else
WiFiClient net;
#endif
#else
TinyGsmClient gsm_tcp(modem);
#if MQTT_USE_TLS
SSLClient net(&gsm_tcp);
#else
TinyGsmClient &net = gsm_tcp;
#endif
#endif

MQTTClient mqtt(8192);

static char T_ECG[48], T_VITAL[48], T_EVENT[48], T_LWT[48], T_CMD[48];
static bool s_modem_ok = false;
static int s_modem_csq = -1;
static uint32_t s_offline_since = 0;
static bool s_sms_sent = false;
static uint32_t s_next_mqtt_try = 0, s_backoff = 1000;
static uint32_t s_tx_bytes = 0, s_tx_ecg = 0, s_tx_vital = 0;
static uint8_t s_bin[20 + 2 + ECG_HOP * 3];
static char s_json[7168];
static EcgPacket s_pkt_send;

void tls_setup()
{
#if MQTT_USE_TLS
#if MQTT_TLS_INSECURE
  net.setInsecure();
  LOGF("TLS: sertifikat broker TIDAK diverifikasi, jangan dipakai di lapangan");
#else
  net.setCACert(MQTT_CA_CERT);
#endif
#if CONN_MODE == CONN_4G
  net.setHandshakeTimeout(30);
#endif
#endif
}

#if USE_MODEM
bool modem_begin()
{
  SerialAT.setRxBufferSize(1024);
  SerialAT.begin(MODEM_BAUD, SERIAL_8N1, PIN_MODEM_RX, PIN_MODEM_TX);
  if (PIN_MODEM_PWRKEY >= 0)
  {
    pinMode(PIN_MODEM_PWRKEY, OUTPUT);
    digitalWrite(PIN_MODEM_PWRKEY, LOW);
    delay(600);
    digitalWrite(PIN_MODEM_PWRKEY, HIGH);
    delay(3000);
  }
  LOGF("MODEM: inisialisasi %s di RX%d TX%d, %d baud", MODEM_SIM7600 ? "SIM7600" : "SIM800L", PIN_MODEM_RX, PIN_MODEM_TX, MODEM_BAUD);
  if (!modem.init() && !modem.restart())
  {
    LOGF("MODEM: tidak merespons AT, periksa kabel TX RX dan catu daya 2 A");
    return false;
  }
  LOGF("MODEM: %s", modem.getModemInfo().c_str());
  if (strlen(GSM_SIM_PIN) && modem.getSimStatus() != 3)
    modem.simUnlock(GSM_SIM_PIN);
  s_modem_csq = modem.getSignalQuality();
  LOGF("MODEM: sinyal CSQ %d", s_modem_csq);
  return true;
}
#endif

#if CONN_MODE == CONN_WIFI
void wifi_scan_report()
{
  LOGF("WIFI: memindai jaringan 2,4 GHz di sekitar");
  int n = WiFi.scanNetworks(false, true);
  bool found = false;
  for (int i = 0; i < n; i++)
  {
    String ssid = WiFi.SSID(i);
    bool same = ssid == WIFI_SSID;
    if (same)
      found = true;
    LOGF("WIFI:   %-32s kanal %2d  %4d dBm%s", ssid.length() ? ssid.c_str() : "(tersembunyi)", WiFi.channel(i), WiFi.RSSI(i), same ? "  <- cocok" : "");
  }
  if (n <= 0)
    LOGF("WIFI: tidak ada jaringan terlihat");
  else if (!found)
    LOGF("WIFI: %s TIDAK terlihat. ESP32 hanya bisa 2,4 GHz, cek huruf besar kecil SSID", WIFI_SSID);
  WiFi.scanDelete();
}
#endif

bool network_ensure()
{
#if CONN_MODE == CONN_WIFI
  static uint32_t last_try = 0;
  static uint32_t last_scan = 0;
  static bool started = false;
  wl_status_t st = WiFi.status();
  if (st == WL_CONNECTED)
  {
    static bool reported = false;
    if (!reported)
    {
      reported = true;
      LOGF("WIFI: tersambung, IP %s, RSSI %d dBm", WiFi.localIP().toString().c_str(), WiFi.RSSI());
    }
    return true;
  }
  if (!started)
  {
    started = true;
    last_try = millis();
    WiFi.persistent(false);
    WiFi.disconnect(true, true);
    delay(200);
    WiFi.mode(WIFI_STA);
    esp_wifi_set_country_code("ID", true);
    WiFi.setSleep(false);
    WiFi.setAutoReconnect(true);
    
    wifi_scan_report();
    last_scan = millis();
    LOGF("WIFI: menyambung ke %s", WIFI_SSID);
    WiFi.begin(WIFI_SSID, WIFI_PASS);
  }
  else if (millis() - last_try > 10000)
  {
    last_try = millis();
    LOGF("WIFI: belum tersambung (status %d), mencoba reconnect...", (int)st);
    WiFi.disconnect();
    delay(200);
    WiFi.begin(WIFI_SSID, WIFI_PASS);
  }
  return false;
#else
  if (!s_modem_ok)
    return false;
  if (!modem.isNetworkConnected())
  {
    LOGF("4G: menunggu registrasi jaringan");
    if (!modem.waitForNetwork(5000))
      return false;
  }
  if (!modem.isGprsConnected())
  {
    LOGF("4G: membuka koneksi data APN %s", GSM_APN);
    if (!modem.gprsConnect(GSM_APN, GSM_USER, GSM_PASS))
      return false;
    s_modem_csq = modem.getSignalQuality();
    LOGF("4G: IP %s, sinyal CSQ %d", modem.getLocalIP().c_str(), s_modem_csq);
  }
  return true;
#endif
}

void time_sync()
{
  static uint32_t last = 0;
  static bool started = false;
  if (time_valid())
    return;
  if (last && millis() - last < 5000)
    return;
  last = millis();
#if CONN_MODE == CONN_WIFI
  if (!started)
  {
    configTime(0, 0, "pool.ntp.org", "time.google.com");
    started = true;
  }
#else
  if (!started)
  {
    modem.NTPServerSync("pool.ntp.org", 0);
    started = true;
  }
  int y, mo, d, h, mi, s;
  float tz;
  if (modem.getNetworkTime(&y, &mo, &d, &h, &mi, &s, &tz) && y > 2023)
  {
    struct tm t = {};
    t.tm_year = y - 1900;
    t.tm_mon = mo - 1;
    t.tm_mday = d;
    t.tm_hour = h;
    t.tm_min = mi;
    t.tm_sec = s;
    time_set_epoch(mktime(&t) - (time_t)(tz * 3600));
  }
#endif
  if (time_valid())
    LOGF("WAKTU: tersinkron, epoch %lu", (unsigned long)time(nullptr));
}

void on_mqtt_message(String &topic, String &payload)
{
  if (topic != T_CMD)
    return;
  const char *p = payload.c_str();
  if (strstr(p, "\"clear_latch\""))
  {
    bool was_critical = state_remote_clear();
    if (was_critical)
      alert_beep(3000, 150);
    LOGF("CMD: clear_latch dari cloud (reset dari aplikasi): %s", was_critical ? "CRITICAL dibersihkan" : "tidak ada latch");
    return;
  }
  if (strstr(p, "\"set_mode\""))
  {
    const char *m = strstr(p, "\"mode\"");
    if (m && (m = strchr(m + 6, '"')))
      mode_apply(!strncmp(m + 1, "test\"", 5));
    return;
  }
  if (!strstr(p, "\"set_state\""))
    return;
  const char *k = strstr(p, "\"state\"");
  if (!k)
    return;
  k = strchr(k + 7, '"');
  if (!k)
    return;
  char val[16];
  int i = 0;
  for (k++; *k && *k != '"' && i < (int)sizeof(val) - 1; k++)
    val[i++] = *k;
  val[i] = 0;
  state_apply_cloud(stateFromName(val));
}

bool publish_kind(BufKind k, const uint8_t *data, uint16_t len)
{
  if (!mqtt.connected())
    return false;
  const char *topic = k == BUF_ECG ? T_ECG : k == BUF_VITAL ? T_VITAL
                                                            : T_EVENT;
  int qos = k == BUF_ECG ? 0 : 1;
  bool ok = mqtt.publish(topic, (const char *)data, len, false, qos);
  if (ok)
  {
    s_tx_bytes += len;
    if (k == BUF_ECG)
      s_tx_ecg++;
    else if (k == BUF_VITAL)
      s_tx_vital++;
  }
  return ok;
}

bool send_pending_reset()
{
  if (!state_reset_pending() || !mqtt.connected())
    return false;
  static char b[256];
  size_t n = encode_event_json(EV_HARDWARE_RESET, b, sizeof(b));
  if (!publish_kind(BUF_EVENT, (uint8_t *)b, n))
    return false;
  state_reset_delivered();
  LOGF("EVENT: hardware_reset diterima broker");
  return true;
}

void mqtt_ensure()
{
  if (mqtt.connected())
    return;
  if (g_net_online)
  {
    g_net_online = false;
    s_offline_since = millis();
    LOGF("MQTT: terputus");
  }
  if ((int32_t)(millis() - s_next_mqtt_try) < 0)
    return;
  LOGF("MQTT: menyambung ke %s:%d", MQTT_HOST, MQTT_PORT);
  mqtt.setWill(T_LWT, "{\"status\":\"offline\",\"reason\":\"koneksi terputus tak terduga\"}", true, 1);
  const char *user = strlen(MQTT_USER) ? MQTT_USER : nullptr;
  const char *pass = strlen(MQTT_PASS) ? MQTT_PASS : nullptr;
  if (mqtt.connect("dev-" DEVICE_ID, user, pass))
  {
    char buf[96];
    snprintf(buf, sizeof(buf), "{\"status\":\"online\",\"ts\":%llu}", (unsigned long long)now_ms());
    mqtt.publish(T_LWT, buf, strlen(buf), true, 1);
    send_pending_reset();
    mqtt.subscribe(T_CMD, 1);
    g_net_online = true;
    s_offline_since = 0;
    s_sms_sent = false;
    s_backoff = 1000;
    LOGF("MQTT: terhubung, subscribe %s", T_CMD);
  }
  else
  {
    s_next_mqtt_try = millis() + s_backoff;
    LOGF("MQTT: gagal (err %d, rc %d), coba lagi %lu ms", mqtt.lastError(), mqtt.returnCode(), (unsigned long)s_backoff);
    s_backoff = min((uint32_t)(s_backoff * 2), (uint32_t)RECONNECT_MAX_MS);
  }
}

void handle_ecg(const EcgPacket &p)
{
#if ECG_PAYLOAD_BINARY
  size_t n = encode_ecg_binary(p, false, s_bin, sizeof(s_bin));
  if (g_net_online && publish_kind(BUF_ECG, s_bin, n))
    return;
  s_bin[3] |= 0x01;
  obuf_push(BUF_ECG, s_bin, n);
#else
  size_t n = encode_ecg_json(p, false, s_json, sizeof(s_json));
  if (g_net_online && publish_kind(BUF_ECG, (uint8_t *)s_json, n))
    return;
  n = encode_ecg_json(p, true, s_json, sizeof(s_json));
  obuf_push(BUF_ECG, (uint8_t *)s_json, n);
#endif
}

void handle_vital()
{
  Vitals v = vitals_get();
  v.ecg_ok = s_ecg_active;
  v.lead_off = g_lead_off;
  v.charging = g_charging;
  float hr_ecg = (v.ecg_ok && !v.lead_off) ? s_hr_ecg : NAN;
  GpsFix g = gps_get();

  // EVALUASI DARURAT INSTAN: Bebas False Alarm via Cross Validation SQI + IMU
  bool signal_valid = !v.lead_off && (v.sqi >= TAU_SQI) && (v.amag_sd < 0.6f);
  if (signal_valid && !isnan(hr_ecg))
  {
    // Jika sinyal bersih & HR terdeteksi di luar batas ekstrem -> Pemicuan Darurat Seketika (0 Detik Delay)
    if (hr_ecg < 40.0f || hr_ecg > 160.0f)
    {
      if (g_state != ST_CRITICAL)
      {
        set_state(ST_CRITICAL);
        s_nvs.putBool("crit_latch", true);
        LOGF("ANOMALI INSTAN: Deteksi Serangan Jantung (HR=%.1f BPM). State -> CRITICAL", hr_ecg);
      }
    }
  }

  static char live[1024], buf[1024];
  size_t n1 = encode_vital_json(v, hr_ecg, g, false, live, sizeof(live));
  if (g_net_online && publish_kind(BUF_VITAL, (uint8_t *)live, n1))
    return;
  size_t n2 = encode_vital_json(v, hr_ecg, g, true, buf, sizeof(buf));
  obuf_push(BUF_VITAL, (uint8_t *)buf, n2);
}

void handle_event(EventType e)
{
  if (e == EV_HARDWARE_RESET)
  {
    if (g_net_online)
      send_pending_reset();
    return;
  }
  static char b[256];
  size_t n = encode_event_json(e, b, sizeof(b));
  if (g_net_online && publish_kind(BUF_EVENT, (uint8_t *)b, n))
    return;
  obuf_push(BUF_EVENT, (uint8_t *)b, n);
}

void sms_fallback()
{
#if SMS_FALLBACK && USE_MODEM
  if (g_state != ST_CRITICAL)
  {
    s_sms_sent = false;
    return;
  }
  if (s_sms_sent || g_net_online || !s_offline_since || !s_modem_ok)
    return;
  if (millis() - s_offline_since < SMS_AFTER_OFFLINE_MS)
    return;
  GpsFix g = gps_get();
  char text[200];
  time_t now = time(nullptr) + 7 * 3600;
  struct tm tm;
  gmtime_r(&now, &tm);
  if (g.fix)
    snprintf(text, sizeof(text), "DARURAT: indikasi serangan jantung pada pengguna alat %s pukul %02d:%02d WIB. Lokasi: maps.google.com/?q=%.6f,%.6f",
             DEVICE_ID, tm.tm_hour, tm.tm_min, g.lat, g.lon);
  else
    snprintf(text, sizeof(text), "DARURAT: indikasi serangan jantung pada pengguna alat %s pukul %02d:%02d WIB. Lokasi GPS belum tersedia.",
             DEVICE_ID, tm.tm_hour, tm.tm_min);
  const char *numbers[] = SMS_NOMOR;
  for (const char *num : numbers)
  {
    if (strstr(num, "ISI"))
      continue;
    bool ok = modem.sendSMS(num, text);
    LOGF("SMS DARURAT ke %s: %s", num, ok ? "terkirim" : "GAGAL");
  }
  s_sms_sent = true;
#endif
}

void task_mqtt_publish(void *)
{
  uint32_t next_vital = millis() + 1000;
  uint32_t next_reset_retry = 0, next_flush = 0;
  for (;;)
  {
    bool net_up = network_ensure();
    if (net_up)
    {
      time_sync();
      mqtt_ensure();
      if (mqtt.connected())
        mqtt.loop();
    }
    else if (g_net_online || !s_offline_since)
    {
      if (g_net_online)
        LOGF("JARINGAN: hilang");
      g_net_online = false;
      if (!s_offline_since)
        s_offline_since = millis();
    }
    while (xQueueReceive(q_ecg_packets, &s_pkt_send, 0) == pdTRUE)
      handle_ecg(s_pkt_send);
    EventType ev;
    while (xQueueReceive(q_events, &ev, 0) == pdTRUE)
      handle_event(ev);
    if ((int32_t)(millis() - next_vital) >= 0)
    {
      next_vital += 1000;
      handle_vital();
    }
    if (g_net_online && state_reset_pending() && (int32_t)(millis() - next_reset_retry) >= 0)
    {
      next_reset_retry = millis() + 5000;
      send_pending_reset();
    }
    if (g_net_online && (int32_t)(millis() - next_flush) >= 0)
    {
      next_flush = millis() + 200;
      if (obuf_size() > 0)
        obuf_flush(publish_kind, 10);
    }
    sms_fallback();
    vTaskDelay(pdMS_TO_TICKS(10));
  }
}

void comm_begin()
{
  snprintf(T_ECG, sizeof(T_ECG), "device/%s/ecg", DEVICE_ID);
  snprintf(T_VITAL, sizeof(T_VITAL), "device/%s/vital", DEVICE_ID);
  snprintf(T_EVENT, sizeof(T_EVENT), "device/%s/event", DEVICE_ID);
  snprintf(T_LWT, sizeof(T_LWT), "device/%s/lwt", DEVICE_ID);
  snprintf(T_CMD, sizeof(T_CMD), "device/%s/cmd", DEVICE_ID);
  obuf_begin();
#if USE_MODEM
  s_modem_ok = modem_begin();
#endif
  tls_setup();
  mqtt.begin(MQTT_HOST, MQTT_PORT, net);
  mqtt.setKeepAlive(15);
  mqtt.setTimeout(5000);
  mqtt.onMessage(on_mqtt_message);
  s_offline_since = millis();
  xTaskCreatePinnedToCore(task_mqtt_publish, "mqtt_pub", 8192, nullptr, 2, nullptr, 0);
  LOGF("KOMUNIKASI: %s, broker %s:%d%s, ECG %s", CONN_MODE == CONN_WIFI ? "WiFi" : "4G", MQTT_HOST, MQTT_PORT,
       MQTT_USE_TLS ? " TLS" : "", ECG_PAYLOAD_BINARY ? "biner" : "JSON");
}

void print_status()
{
  Vitals v = vitals_get();
  GpsFix g = gps_get();
  Serial.printf("\n=== STATUS %s ===\n", DEVICE_ID);
  Serial.printf("state=%s mode=%s online=%d waktu_sinkron=%d buffer=%u B terkirim ecg=%lu vital=%lu byte=%lu\n",
                stateName(g_state), s_test_mode ? "test" : "demo", g_net_online, time_valid(), (unsigned)obuf_size(), (unsigned long)s_tx_ecg,
                (unsigned long)s_tx_vital, (unsigned long)s_tx_bytes);
  Serial.printf("modem=%d CSQ=%d | ECG lead_off=%d HR_ecg=%.1f adc_gagal=%lu | PPG %s HR=%.1f SQI=%.2f | GSR %.2f uS (ADC %.0f)\n",
                s_modem_ok, s_modem_csq, g_lead_off, s_hr_ecg, (unsigned long)s_adc_fail, s_has.ppg ? "on" : "off", v.hr_ppg, v.sqi, v.gsr_us, s_gsr_adc_last);
  Serial.printf("I2C: %s\n", s_i2c_scan);
  Serial.printf("IMU %s |a|=%.3f g sd=%.3f g jatuh=%d | mengisi=%d | GPS fix=%d %.6f,%.6f sat=%d baud=%ld | heap=%u B\n\n",
                s_has.imu ? "on" : "off", v.amag, v.amag_sd, v.fall_detected, g_charging, g.fix, g.lat, g.lon, g.sats,
                GPS_BAUD[s_gps_baud_idx], (unsigned)ESP.getFreeHeap());
}

void setup()
{
  Serial.begin(115200);
  delay(300);
  Serial.println();
  Serial.println("==============================================================");
  Serial.println(" CardioVest C-251: Early Warning System Deteksi Serangan Jantung");
  Serial.printf(" perangkat %s | Arduino-ESP32 %d.x\n", DEVICE_ID, ESP_ARDUINO_VERSION_MAJOR);
  Serial.println(" perintah: s status | p plot ECG | r reset | c hapus latch dan buffer | b bunyi uji");
  Serial.println("==============================================================");
  s_vmutex = xSemaphoreCreateMutex();
  q_ecg_packets = xQueueCreate(8, sizeof(EcgPacket));
  q_events = xQueueCreate(8, sizeof(EventType));
  state_begin();
  alert_begin();
  sensors_begin();
  gps_begin();
  ecg_begin();
  comm_begin();
  alert_beep(2500, 120);
  LOGF("SETUP selesai");
}

void loop()
{
  static uint32_t last_status = 0;
  while (Serial.available())
  {
    char c = Serial.read();
    if (c == 's')
    {
      print_status();
    }
    else if (c == 'p')
    {
      s_plot = !s_plot;
    }
    else if (c == 'r')
    {
      state_hardware_reset();
      EventType ev = EV_HARDWARE_RESET;
      xQueueSend(q_events, &ev, 0);
      LOGF("SERIAL: reset manual");
    }
    else if (c == 'c')
    {
      state_hardware_reset();
      obuf_clear();
      state_reset_delivered();
      LOGF("SERIAL: latch CRITICAL dan buffer offline dihapus");
    }
    else if (c == 'b')
    {
      alert_beep(2000, 300);
    }
  }
#if DEBUG_LOG
  if (!s_plot && millis() - last_status > 30000)
  {
    last_status = millis();
    print_status();
  }
#endif
  delay(50);
}