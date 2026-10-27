// Uji 02 — MAX30102 (PPG) berdiri sendiri. Library: "SparkFun MAX3010x Pulse and Proximity Sensor Library".
// Wiring: SDA->GPIO21, SCL->GPIO22, VIN 3V3, GND. Tempelkan sensor ke kulit dada/jari dengan tekanan ringan.
// Serial Plotter (115200) menampilkan IR ter-DC-removal; Serial Monitor menampilkan HR tiap detik.
#include <Wire.h>
#include "MAX30105.h"
#include "heartRate.h"

MAX30105 ppg;
float dc = 0, bpm_avg = 0;
long last_beat = 0;
uint32_t last_print = 0;

void setup() {
  Serial.begin(115200);
  Wire.begin(21, 22);
  if (!ppg.begin(Wire, I2C_SPEED_FAST)) {
    Serial.println("MAX30102 TIDAK terdeteksi di 0x57 - periksa kabel SDA/SCL dan daya.");
    while (true) delay(1000);
  }
  ppg.setup(0x1F, 8, 2, 400, 411, 16384);   // 50 sampel/s efektif (sama dengan firmware utama)
  Serial.println("MAX30102 OK");
}

void loop() {
  ppg.check();
  while (ppg.available()) {
    uint32_t ir = ppg.getFIFOIR();
    ppg.nextSample();
    dc = dc == 0 ? ir : 0.95f * dc + 0.05f * ir;
    bool contact = ir > 50000;
    if (contact && checkForBeat(ir)) {
      long d = millis() - last_beat;
      last_beat = millis();
      float bpm = 60000.0f / d;
      if (bpm > 30 && bpm < 220) bpm_avg = bpm_avg == 0 ? bpm : 0.8f * bpm_avg + 0.2f * bpm;
    }
    Serial.printf("ir_ac:%.0f kontak:%d\n", contact ? dc - ir : 0.0f, contact ? 200 : 0);
  }
  if (millis() - last_print > 1000) {
    last_print = millis();
    Serial.printf("# HR PPG = %.1f bpm (DC IR = %.0f; < 50000 berarti tidak menempel)\n", bpm_avg, dc);
  }
}
