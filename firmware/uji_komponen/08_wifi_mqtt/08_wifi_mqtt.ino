// Uji 08 — WiFi + MQTT ke layanan cloud (docker compose) berdiri sendiri, TANPA sensor.
// Mengirim vital tiruan berformat sama dengan firmware utama ke device/<id>/vital tiap 1 s,
// menerbitkan LWT online/offline, dan mencetak perintah dari device/<id>/cmd.
// Library: MQTT (Joel Gaehwiler / 256dpi), ArduinoJson.
// Cek di debug viewer (http://localhost:8251) atau `docker compose run --rm monitor`.
#include <WiFi.h>
#include <MQTT.h>
#include <ArduinoJson.h>
#include <time.h>

const char* SSID = "NAMA_WIFI";
const char* PASS = "PASSWORD_WIFI";
const char* BROKER = "192.168.1.10";      // IP laptop yang menjalankan docker compose (cek ipconfig)
const char* DEV = "cv-001";

WiFiClient net;
MQTTClient mqtt(2048);
char t_vital[48], t_lwt[48], t_cmd[48];

void onMsg(String& topic, String& payload) { Serial.printf("CMD dari cloud: %s\n", payload.c_str()); }

uint64_t now_ms() { struct timeval tv; gettimeofday(&tv, nullptr); return (uint64_t)tv.tv_sec * 1000 + tv.tv_usec / 1000; }

void connect() {
  while (WiFi.status() != WL_CONNECTED) { Serial.print("."); delay(500); }
  Serial.printf("\nWiFi OK, IP %s\n", WiFi.localIP().toString().c_str());
  mqtt.setWill(t_lwt, "{\"status\":\"offline\",\"reason\":\"uji terputus\"}", true, 1);
  while (!mqtt.connect("uji-esp32")) { Serial.printf("MQTT gagal (rc %d), ulangi...\n", mqtt.returnCode()); delay(2000); }
  mqtt.publish(t_lwt, "{\"status\":\"online\"}", true, 1);
  mqtt.subscribe(t_cmd, 1);
  Serial.println("MQTT terhubung ke broker");
}

void setup() {
  Serial.begin(115200);
  snprintf(t_vital, sizeof(t_vital), "device/%s/vital", DEV);
  snprintf(t_lwt, sizeof(t_lwt), "device/%s/lwt", DEV);
  snprintf(t_cmd, sizeof(t_cmd), "device/%s/cmd", DEV);
  WiFi.begin(SSID, PASS);
  configTime(0, 0, "pool.ntp.org");
  mqtt.begin(BROKER, 1883, net);
  mqtt.onMessage(onMsg);
  connect();
}

void loop() {
  mqtt.loop();
  if (!mqtt.connected()) connect();
  static uint32_t t = 0;
  if (millis() - t < 1000) return;
  t = millis();
  JsonDocument d;
  d["device_id"] = DEV; d["ts"] = now_ms();
  d["hr"] = 72 + random(-2, 3); d["hr_source"] = "PPG"; d["hr_ppg"] = d["hr"]; d["hr_ecg"] = nullptr;
  d["sqi"] = 0.8; d["gsr"] = 5.0 + random(0, 20) / 100.0;
  JsonObject a = d["accel"].to<JsonObject>(); a["x"] = 0; a["y"] = 0; a["z"] = 1; a["mag"] = 1;
  d["fall_detected"] = false; d["fall_ts"] = nullptr; d["local_state"] = "NORMAL"; d["gps"] = nullptr; d["buffered"] = false;
  char buf[512]; size_t n = serializeJson(d, buf);
  bool ok = mqtt.publish(t_vital, buf, n, false, 1);
  Serial.printf("vital %s: %s\n", ok ? "terkirim" : "GAGAL", buf);
}
