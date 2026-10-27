// Uji 03 — MPU6050 + deteksi jatuh tiga fase (free-fall -> impak -> stillness), berdiri sendiri.
// Wiring: SDA->GPIO21, SCL->GPIO22, VCC 3V3, GND. Tanpa library tambahan.
// Uji: jatuhkan modul (di atas bantal) dari ~30 cm lalu biarkan diam 2 s -> "JATUH TERDETEKSI".
#include <Wire.h>
const uint8_t ADDR = 0x68;
const float LSB = 4096.0f;  // +-8 g

enum { IDLE, FREEFALL, WAIT_IMPACT, STILL } st = IDLE;
uint32_t t_mark = 0, t_impact = 0, t_still = 0;

bool fall_update(float mag, uint32_t t) {
  switch (st) {
    case IDLE: if (mag < 0.5f) { st = FREEFALL; t_mark = t; } break;
    case FREEFALL:
      if (mag >= 0.5f) {
        uint32_t d = t - t_mark;
        if (d >= 70 && d <= 300) { st = WAIT_IMPACT; t_mark = t; if (mag > 2.5f) { st = STILL; t_impact = t_still = t; } }
        else st = IDLE;
      }
      break;
    case WAIT_IMPACT:
      if (mag > 2.5f) { st = STILL; t_impact = t_still = t; } else if (t - t_mark > 150) st = IDLE;
      break;
    case STILL:
      if (fabsf(mag - 1.0f) > 0.3f) { t_still = t; if (t - t_impact > 5000) st = IDLE; }
      else if (t - t_still >= 2000) { st = IDLE; return true; }
      break;
  }
  return false;
}

void wr(uint8_t r, uint8_t v) { Wire.beginTransmission(ADDR); Wire.write(r); Wire.write(v); Wire.endTransmission(); }

void setup() {
  Serial.begin(115200);
  Wire.begin(21, 22);
  Wire.setClock(400000);
  Wire.beginTransmission(ADDR);
  if (Wire.endTransmission() != 0) { Serial.println("MPU6050 TIDAK terdeteksi di 0x68"); while (true) delay(1000); }
  wr(0x6B, 0x00); wr(0x1A, 0x03); wr(0x1C, 0x10);
  Serial.println("MPU6050 OK (+-8 g, 100 Hz)");
}

void loop() {
  static uint32_t next = millis();
  if ((int32_t)(millis() - next) < 0) return;
  next += 10;
  Wire.beginTransmission(ADDR); Wire.write(0x3B); Wire.endTransmission(false);
  Wire.requestFrom((int)ADDR, 6);
  int16_t x = (Wire.read() << 8) | Wire.read(), y = (Wire.read() << 8) | Wire.read(), z = (Wire.read() << 8) | Wire.read();
  float ax = x / LSB, ay = y / LSB, az = z / LSB, mag = sqrtf(ax * ax + ay * ay + az * az);
  if (fall_update(mag, millis())) Serial.println("# >>> JATUH TERDETEKSI <<<");
  static int k = 0;
  if (++k % 2 == 0) Serial.printf("mag_g:%.3f ax:%.2f ay:%.2f az:%.2f fase:%d\n", mag, ax, ay, az, (int)st);
}
