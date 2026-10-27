// Uji 05 — GPS Neo-6M berdiri sendiri. Library: TinyGPSPlus.
// Wiring: TX GPS -> GPIO16, RX GPS -> GPIO17, VCC 5V (atau 3V3 sesuai modul), GND.
// Letakkan antena menghadap langit terbuka; cold start bisa sampai 60 s. Kirim 'n' untuk melihat NMEA mentah.
#include <TinyGPSPlus.h>
TinyGPSPlus gps;
bool raw = false;

void setup() {
  Serial.begin(115200);
  Serial2.begin(9600, SERIAL_8N1, 16, 17);
  Serial.println("Menunggu data NMEA dari Neo-6M...");
}

void loop() {
  while (Serial2.available()) { char c = Serial2.read(); gps.encode(c); if (raw) Serial.write(c); }
  while (Serial.available()) if (Serial.read() == 'n') raw = !raw;
  static uint32_t t = 0;
  if (millis() - t > 2000 && !raw) {
    t = millis();
    if (gps.charsProcessed() < 10) Serial.println("Tidak ada data dari GPS - periksa kabel TX/RX dan baud 9600");
    else if (!gps.location.isValid()) Serial.printf("Belum fix... satelit=%d\n", gps.satellites.value());
    else Serial.printf("FIX %.6f, %.6f | satelit %d | HDOP %.1f (~%.0f m) | https://maps.google.com/?q=%.6f,%.6f\n",
                       gps.location.lat(), gps.location.lng(), gps.satellites.value(), gps.hdop.hdop(),
                       gps.hdop.hdop() * 2.5, gps.location.lat(), gps.location.lng());
  }
}
