#!/bin/sh
# Membuat berkas passwd Mosquitto berisi akun cloud, web, dan satu akun per perangkat.
#   sh mosquitto/produksi/buat_akun.sh cv-001 cv-002
# Kata sandi acak dicetak SEKALI di layar: salin ke .env (cloud/web) dan config.h (perangkat).
set -eu
cd "$(dirname "$0")"
[ $# -ge 1 ] || { echo "pakai: sh buat_akun.sh <device_id> [device_id ...]"; exit 1; }
acak() { head -c 18 /dev/urandom | base64 | tr -d '/+=' | cut -c1-20; }
umask 077
: > passwd.baru
echo "# --- simpan baik-baik, tidak ditampilkan lagi ---"
for u in cloud web "$@"; do
  p=$(acak)
  printf '%s:%s\n' "$u" "$p" >> passwd.baru
  case "$u" in
    cloud) echo "MQTT_PASS_CLOUD=$p   (.env)";;
    web)   echo "MQTT_PASS_WEB=$p     (.env)";;
    *)     echo "$u: #define MQTT_USER \"$u\" / #define MQTT_PASS \"$p\"   (firmware config.h;"
           echo "        untuk simulator demo di server: MQTT_PASS_SIMDEV=$p di .env)";;
  esac
done
# mosquitto_passwd -U meng-hash isi berkas "user:password"; dijalankan di image Mosquitto yang sama
docker run --rm -v "$PWD:/w" eclipse-mosquitto:2.0.20 sh -c \
  'chmod 0600 /w/passwd.baru && mosquitto_passwd -U /w/passwd.baru && mv /w/passwd.baru /w/passwd && chown 1883:1883 /w/passwd /w/acl && chmod 0600 /w/passwd && chmod 0640 /w/acl'
# acl kini milik user mosquitto (uid 1883); untuk mengeditnya pakai sudo
echo "passwd dibuat: $(pwd)/passwd"
