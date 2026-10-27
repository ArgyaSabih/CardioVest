// Uji 07 — buzzer, LED, tombol reset, dan deteksi VBUS berdiri sendiri.
// Wiring: buzzer (via transistor) -> GPIO25, LED -> GPIO2, tombol GPIO4 ke GND (pull-up internal),
//         pembagi tegangan VBUS -> GPIO39.
// Perintah: 1 = pola NORMAL, 2 = WARNING (2 kHz intermiten), 3 = CRITICAL (4 kHz kontinu), 0 = diam.
const int BUZ = 25, LED = 2, BTN = 4, VBUS = 39;
int mode = 1;
uint32_t down_at = 0;

void tone_hz(int f) {
#if ESP_ARDUINO_VERSION_MAJOR >= 3
  ledcWriteTone(BUZ, f);
#else
  ledcWriteTone(0, f);
#endif
}

void setup() {
  Serial.begin(115200);
  pinMode(LED, OUTPUT);
  pinMode(BTN, INPUT_PULLUP);
#if ESP_ARDUINO_VERSION_MAJOR >= 3
  ledcAttach(BUZ, 2000, 10);
#else
  ledcSetup(0, 2000, 10); ledcAttachPin(BUZ, 0);
#endif
  tone_hz(0);
  Serial.println("Perintah: 0 1 2 3. Tahan tombol 3 s untuk uji reset.");
}

void loop() {
  uint32_t t = millis();
  while (Serial.available()) { char c = Serial.read(); if (c >= '0' && c <= '3') { mode = c - '0'; Serial.printf("mode %d\n", mode); } }
  int f = 0; bool on = false;
  if (mode == 1) on = (t % 3000) < 60;
  if (mode == 2) { on = (t / 500) % 2; f = ((t / 250) % 8 == 0) ? 2000 : 0; }
  if (mode == 3) { on = (t / 100) % 2; f = 4000; }
  digitalWrite(LED, on);
  static int cur = -1; if (f != cur) { tone_hz(f); cur = f; }

  bool pressed = digitalRead(BTN) == LOW;
  if (pressed && !down_at) down_at = t;
  if (!pressed && down_at) { Serial.printf("tombol dilepas setelah %lu ms%s\n", (unsigned long)(t - down_at), t - down_at >= 3000 ? " -> RESET VALID" : ""); down_at = 0; }
  static uint32_t pv = 0;
  if (t - pv > 2000) { pv = t; Serial.printf("VBUS GPIO39 = %lu mV (> 1500 dianggap mengisi)\n", (unsigned long)analogReadMilliVolts(VBUS)); }
  delay(10);
}
