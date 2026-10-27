// Uji 04 — GSR FZ3294 berdiri sendiri. Wiring: SIG->GPIO35, VCC 3V3, GND.
// LANGKAH KALIBRASI: lepaskan elektroda dari kulit, catat nilai "adc" rata-rata, lalu isi
// GSR_ADC_NO_SKIN di config.h firmware utama (dan di sini). Setelah itu pasang ke jari/telapak.
const int PIN_GSR = 35;
float GSR_ADC_NO_SKIN = 2048;   // ganti dengan hasil kalibrasi

void setup() {
  Serial.begin(115200);
  analogReadResolution(12);
  analogSetPinAttenuation(PIN_GSR, ADC_11db);
  Serial.println("GSR siap. Kirim 'c' untuk mengambil pembacaan saat ini sebagai kalibrasi tanpa kulit.");
}

void loop() {
  uint32_t acc = 0;
  for (int i = 0; i < 20; ++i) { acc += analogRead(PIN_GSR); delay(2); }
  float a = acc / 20.0f;
  float us = NAN;
  if (a < GSR_ADC_NO_SKIN - 5) us = 1e6f / (((4096.0f + 2 * a) * 10000.0f) / (GSR_ADC_NO_SKIN - a));
  Serial.printf("adc:%.0f konduktansi_uS:%.2f\n", a, isnan(us) ? 0.0f : us);
  while (Serial.available()) if (Serial.read() == 'c') { GSR_ADC_NO_SKIN = a; Serial.printf("# kalibrasi GSR_ADC_NO_SKIN = %.0f\n", a); }
  delay(60);   // ~10 Hz
}
