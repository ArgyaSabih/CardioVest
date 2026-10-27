// Uji 01 — AD8232 (ECG) berdiri sendiri.
// Wiring: OUTPUT->GPIO34, LO- ->GPIO32, LO+ ->GPIO33, 3V3, GND. Elektroda RA/LA/RL (Lead I).
// Buka Tools > Serial Plotter (115200): garis "ecg_uV" = sinyal terfilter, "lead_off" = elektroda lepas.
// Ketik 'h' di Serial Monitor untuk menampilkan HR.
#include <Arduino.h>

const int PIN_OUT = 34, PIN_LO_M = 32, PIN_LO_P = 33;
const float FS = 250.0f, GAIN = 1100.0f;

struct Biquad {
  float b0, b1, b2, a1, a2, z1 = 0, z2 = 0;
  void set(float B0, float B1, float B2, float A0, float A1, float A2) { b0 = B0 / A0; b1 = B1 / A0; b2 = B2 / A0; a1 = A1 / A0; a2 = A2 / A0; }
  void hp(float f) { float w = 2 * PI * f / FS, c = cosf(w), al = sinf(w) / 1.4142f; set((1 + c) / 2, -(1 + c), (1 + c) / 2, 1 + al, -2 * c, 1 - al); }
  void lp(float f) { float w = 2 * PI * f / FS, c = cosf(w), al = sinf(w) / 1.4142f; set((1 - c) / 2, 1 - c, (1 - c) / 2, 1 + al, -2 * c, 1 - al); }
  void notch(float f) { float w = 2 * PI * f / FS, c = cosf(w), al = sinf(w) / 60; set(1, -2 * c, 1, 1 + al, -2 * c, 1 - al); }
  float run(float x) { float y = b0 * x + z1; z1 = b1 * x - a1 * y + z2; z2 = b2 * x - a2 * y; return y; }
} hp, nt, lp;

volatile bool tick = false;
hw_timer_t* timer;
void IRAM_ATTR onTimer() { tick = true; }

float last_y = 0, peak_thr = 0.3f; uint32_t last_beat = 0, n = 0; float hr = 0;

void setup() {
  Serial.begin(115200);
  pinMode(PIN_LO_M, INPUT); pinMode(PIN_LO_P, INPUT);
  analogReadResolution(12);
  analogSetPinAttenuation(PIN_OUT, ADC_11db);
  hp.hp(0.5); nt.notch(50); lp.lp(40);
#if ESP_ARDUINO_VERSION_MAJOR >= 3
  timer = timerBegin(1000000); timerAttachInterrupt(timer, &onTimer); timerAlarm(timer, 4000, true, 0);
#else
  timer = timerBegin(0, 80, true); timerAttachInterrupt(timer, &onTimer, true); timerAlarmWrite(timer, 4000, true); timerAlarmEnable(timer);
#endif
}

void loop() {
  if (!tick) return;
  tick = false;
  n++;
  bool lo = digitalRead(PIN_LO_M) || digitalRead(PIN_LO_P);
  float mv = analogReadMilliVolts(PIN_OUT) / GAIN;
  float y = lo ? 0 : lp.run(nt.run(hp.run(mv)));
  // deteksi R sederhana: ambang adaptif 60 % dari puncak terakhir, refraktori 250 ms
  peak_thr = max(0.05f, peak_thr * 0.999f);
  if (y > peak_thr && last_y <= peak_thr && millis() - last_beat > 250) {
    if (last_beat) hr = 0.8f * hr + 0.2f * (60000.0f / (millis() - last_beat));
    last_beat = millis();
  }
  if (y > peak_thr / 0.6f) peak_thr = 0.6f * y;
  last_y = y;
  if (n % 2 == 0) Serial.printf("ecg_uV:%.0f lead_off:%d\n", y * 1000, lo ? 500 : 0);  // 125 Hz ke plotter
  while (Serial.available()) if (Serial.read() == 'h') Serial.printf("# HR = %.1f bpm\n", hr);
}
