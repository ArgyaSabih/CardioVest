// Uji 06 — SIM7600E-H (4G) berdiri sendiri. Library: TinyGSM.
// Wiring: TX modem -> GPIO26, RX modem -> GPIO27, GND bersama. Modem WAJIB diberi catu 5 V >= 2 A
// (lonjakan arus saat transmisi); jangan dari pin 3V3 ESP32.
// Perintah Serial Monitor: i = info & sinyal, g = buka koneksi data, t = uji TCP ke broker,
//                          s = kirim SMS uji, a = mode AT langsung (ketik perintah AT; '~' untuk keluar)
#define TINY_GSM_MODEM_SIM7600
#define TINY_GSM_RX_BUFFER 1024
#include <TinyGsmClient.h>

const char* APN = "internet";                // Telkomsel/XL: internet, Indosat: indosatgprs, Tri: 3data
const char* SMS_TO = "+6281200000000";       // ganti nomor Anda
const char* BROKER = "broker.hivemq.com";    // uji koneksi TCP publik
const int PWRKEY = -1;                       // isi pin bila PWRKEY dihubungkan

HardwareSerial SerialAT(1);
TinyGsm modem(SerialAT);
TinyGsmClient client(modem);
bool at_mode = false;

void info() {
  Serial.printf("Modem: %s\nIMEI: %s\nSIM status: %d\nOperator: %s\nSinyal CSQ: %d (0-31; >10 cukup)\nRegistrasi jaringan: %s\n",
                modem.getModemInfo().c_str(), modem.getIMEI().c_str(), modem.getSimStatus(), modem.getOperator().c_str(),
                modem.getSignalQuality(), modem.isNetworkConnected() ? "ya" : "tidak");
}

void setup() {
  Serial.begin(115200);
  SerialAT.begin(115200, SERIAL_8N1, 26, 27);
  if (PWRKEY >= 0) { pinMode(PWRKEY, OUTPUT); digitalWrite(PWRKEY, LOW); delay(600); digitalWrite(PWRKEY, HIGH); delay(3000); }
  Serial.println("Inisialisasi modem...");
  if (!modem.init()) { Serial.println("Modem tidak merespons AT. Periksa kabel TX/RX (silang), GND, dan catu 5 V."); }
  else info();
  Serial.println("Perintah: i g t s a");
}

void loop() {
  if (at_mode) {
    while (SerialAT.available()) Serial.write(SerialAT.read());
    while (Serial.available()) { char c = Serial.read(); if (c == '~') { at_mode = false; Serial.println("\n[keluar mode AT]"); } else SerialAT.write(c); }
    return;
  }
  if (!Serial.available()) return;
  char c = Serial.read();
  if (c == 'i') info();
  else if (c == 'g') {
    Serial.println("Menunggu jaringan..."); modem.waitForNetwork(60000);
    Serial.printf("GPRS/LTE %s, IP %s\n", modem.gprsConnect(APN) ? "tersambung" : "GAGAL", modem.getLocalIP().c_str());
  } else if (c == 't') {
    Serial.printf("TCP ke %s:1883 ... %s\n", BROKER, client.connect(BROKER, 1883) ? "BERHASIL" : "GAGAL");
    client.stop();
  } else if (c == 's') {
    Serial.printf("SMS ke %s: %s\n", SMS_TO, modem.sendSMS(SMS_TO, "Uji SMS perangkat C-251") ? "terkirim" : "GAGAL");
  } else if (c == 'a') { at_mode = true; Serial.println("[mode AT langsung; '~' untuk keluar]"); }
}
