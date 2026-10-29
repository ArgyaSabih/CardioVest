#!/bin/sh
set -eu

main() {
  [ "$(id -u)" = 0 ] || { echo "Jalankan dengan sudo: sudo sh deploy/setup.sh"; exit 1; }
  cd "$(dirname "$0")/.."
  [ "$(pwd)" = /opt/cardiovest ] || { echo "Repo harus di-clone ke /opt/cardiovest"; exit 1; }
  env_get() { sed -n "s/^$1=//p" deploy/.env | tail -n 1 | tr -d '"'; }
  rnd() { head -c 48 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | cut -c1-"$1"; }

  echo "== 1/6 swap 2 GB"
  if [ -z "$(swapon --show)" ]; then
    fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
    grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  fi

  echo "== 2/6 Docker"
  command -v docker >/dev/null || curl -fsSL https://get.docker.com | sh
  systemctl enable --now docker >/dev/null

  echo "== 3/6 firewall (80, 443, 1883, 8883)"
  for p in 80 443 1883 8883; do
    iptables -C INPUT -p tcp --dport "$p" -j ACCEPT 2>/dev/null || iptables -I INPUT 1 -p tcp --dport "$p" -j ACCEPT
  done
  command -v netfilter-persistent >/dev/null || DEBIAN_FRONTEND=noninteractive apt-get install -y -q iptables-persistent >/dev/null
  netfilter-persistent save >/dev/null 2>&1 || true
  if command -v ufw >/dev/null && ufw status | grep -q active; then
    for p in 80 443 1883 8883; do ufw allow "$p/tcp" >/dev/null; done
  fi

  echo "== 4/6 konfigurasi deploy/.env"
  if [ ! -f deploy/.env ]; then
    ip=$(curl -fsS https://api.ipify.org)
    domain="$(echo "$ip" | tr . -).sslip.io"
    code=$(shuf -i 100000-999999 -n 1)
    sed -e "s|^BRANCH=.*|BRANCH=$(git rev-parse --abbrev-ref HEAD)|" \
        -e "s|^DOMAIN=.*|DOMAIN=$domain|" \
        -e "s|^PUBLIC_URL=.*|PUBLIC_URL=${VERCEL_URL:-}|" \
        -e "s|^PROXY_SECRET=.*|PROXY_SECRET=$(rnd 40)|" \
        -e "s|^MQTT_PASS_CLOUD=.*|MQTT_PASS_CLOUD=$(rnd 24)|" \
        -e "s|^MQTT_PASS_WEB=.*|MQTT_PASS_WEB=$(rnd 24)|" \
        -e "s|^MQTT_PASS_DEVICE=.*|MQTT_PASS_DEVICE=$(rnd 20)|" \
        -e "s|^DEVICES=.*|DEVICES=cv-001:$code|" \
        deploy/env.example > deploy/.env
    chmod 600 deploy/.env
  fi

  echo "== 5/6 data dan akun MQTT"
  data=$(env_get DATA_ROOT)
  mkdir -p "$data/mosquitto/conf.d" "$data/mosquitto/certs" "$data/mosquitto/data" "$data/cloud" "$data/server" "$data/caddy"
  printf 'cloud:%s\nweb:%s\n%s:%s\n' "$(env_get MQTT_PASS_CLOUD)" "$(env_get MQTT_PASS_WEB)" \
    "$(env_get DEVICE_ID)" "$(env_get MQTT_PASS_DEVICE)" > "$data/mosquitto/passwd"
  docker run --rm -v "$data/mosquitto:/m" eclipse-mosquitto:2.0.20 mosquitto_passwd -U /m/passwd
  chown -R 1883:1883 "$data/mosquitto"
  chmod 600 "$data/mosquitto/passwd"

  echo "== 6/6 build pertama dan auto-update"
  install -m 0644 deploy/cardiovest-update.service deploy/cardiovest-update.timer /etc/systemd/system/
  printf '#!/bin/sh\nexec sudo sh /opt/cardiovest/deploy/cv.sh "$@"\n' > /usr/local/bin/cv
  chmod 755 /usr/local/bin/cv
  sh deploy/update.sh --paksa
  systemctl daemon-reload
  systemctl enable --now cardiovest-update.timer >/dev/null

  printf 'Menunggu sertifikat HTTPS'
  i=0
  while [ $i -lt 30 ] && ! curl -fsS "https://$(env_get DOMAIN)/" >/dev/null 2>&1; do printf '.'; sleep 5; i=$((i + 1)); done
  echo
  sh deploy/update.sh
  echo
  echo "Selesai. Kode pairing alat: $(env_get DEVICES)"
  sh deploy/cv.sh info
}

main "$@"
exit 0
