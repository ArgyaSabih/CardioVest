#!/bin/sh
set -eu

main() {
  cd "$(dirname "$0")/.."
  compose="docker compose -f deploy/docker-compose.yml"
  env_get() { sed -n "s/^$1=//p" deploy/.env | tail -n 1 | tr -d '"'; }
  sim_ctl() {
    $compose exec -T mosquitto mosquitto_pub -h localhost -u web -P "$(env_get MQTT_PASS_WEB)" \
      -t "sim/$(env_get DEVICE_ID)/control" -q 1 -m "$1"
  }
  case "${1:-info}" in
    info)
      echo "Backend      : https://$(env_get DOMAIN)"
      echo "Branch       : $(env_get BRANCH) @ $(git log -1 --format='%h %s')"
      echo "MQTT (ESP32) : $(env_get DOMAIN) port 1883, atau 8883 dengan TLS"
      echo "Akun MQTT    : $(env_get DEVICE_ID) / $(env_get MQTT_PASS_DEVICE)"
      echo "Vercel       : NEXT_PUBLIC_BACKEND_URL=https://$(env_get DOMAIN)"
      echo "               PROXY_SECRET=$(env_get PROXY_SECRET)"
      $compose ps --format 'table {{.Service}}\t{{.Status}}'
      ;;
    log | logs) shift; $compose logs -f --tail=100 "$@" ;;
    status) $compose ps ;;
    restart) shift; $compose restart "$@" ;;
    update) sh deploy/update.sh --paksa ;;
    set)
      [ $# -eq 3 ] || { echo "pakai: cv set NAMA nilai"; exit 1; }
      if grep -q "^$2=" deploy/.env; then sed -i "s|^$2=.*|$2=$3|" deploy/.env; else echo "$2=$3" >> deploy/.env; fi
      $compose up -d
      echo "$2 disimpan"
      ;;
    alat) shift; $compose exec server node --disable-warning=ExperimentalWarning lib/alat.js "$@" ;;
    skenario)
      [ -n "${2:-}" ] || { echo "pakai: cv skenario NAMA (lihat README bagian 3)"; exit 1; }
      sim_ctl "{\"cmd\":\"skenario\",\"name\":\"$2\"}"
      echo "skenario -> $2"
      ;;
    reset) sim_ctl '{"cmd":"reset"}'; echo "tombol reset ditekan" ;;
    uji) shift; $compose exec -e MQTT_USER=web -e "MQTT_PASS=$(env_get MQTT_PASS_WEB)" simulator python /app/tools/uji_skenario.py "$@" ;;
    ekspor)
      $compose exec cloud python -m cloud.export --db /data/cardiovest.db --out /data/export
      echo "hasil: $(env_get DATA_ROOT)/cloud/export"
      ;;
    sumber)
      [ "${2:-}" = hardware ] || [ "${2:-}" = dataset ] || { echo "pakai: cv sumber hardware|dataset"; exit 1; }
      $compose exec -T mosquitto mosquitto_pub -h localhost -u web -P "$(env_get MQTT_PASS_WEB)" \
        -t "sim/$(env_get DEVICE_ID)/source" -q 1 -r -m "$2"
      echo "sumber data -> $2"
      ;;
    *)
      echo "perintah:"
      echo "  cv info                      alamat, akun MQTT, isi untuk Vercel, status layanan"
      echo "  cv logs [layanan]            log langsung (cloud, server, simulator, mosquitto, caddy)"
      echo "  cv restart [layanan]         nyalakan ulang"
      echo "  cv update                    tarik commit terbaru dan bangun ulang sekarang"
      echo "  cv set NAMA nilai            ubah deploy/.env lalu terapkan"
      echo "  cv sumber hardware|dataset   pilih sumber EKG: ESP32 atau simulator dataset"
      echo "  cv skenario NAMA             ganti skenario simulator"
      echo "  cv reset                     tekan tombol reset simulator"
      echo "  cv uji [skenario ...]        uji otomatis skenario"
      echo "  cv ekspor                    ekspor database ke CSV"
      echo "  cv alat daftar|tambah|kode-baru|lepas [id]"
      ;;
  esac
}

main "$@"
