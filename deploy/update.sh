#!/bin/sh
set -eu

main() {
  cd "$(dirname "$0")/.."
  env_get() { sed -n "s/^$1=//p" deploy/.env | tail -n 1 | tr -d '"'; }
  branch=$(env_get BRANCH)
  domain=$(env_get DOMAIN)
  data=$(env_get DATA_ROOT)
  compose="docker compose -f deploy/docker-compose.yml"

  git fetch -q origin "$branch"
  if [ "$(git rev-parse HEAD)" != "$(git rev-parse FETCH_HEAD)" ] || [ "${1:-}" = "--paksa" ]; then
    git reset -q --hard FETCH_HEAD
    echo "[update] $(date '+%F %T') membangun $(git log -1 --format='%h %s')"
    $compose up -d --build --remove-orphans
    docker image prune -f >/dev/null
  fi

  crt=$(find "$data/caddy/caddy/certificates" -name "$domain.crt" 2>/dev/null | head -n 1)
  [ -n "$crt" ] || return 0
  key="${crt%.crt}.key"
  certs="$data/mosquitto/certs"
  if ! cmp -s "$crt" "$certs/server.crt" || ! cmp -s "$key" "$certs/server.key"; then
    install -o 1883 -g 1883 -m 0644 "$crt" "$certs/server.crt"
    install -o 1883 -g 1883 -m 0600 "$key" "$certs/server.key"
    if [ -f "$data/mosquitto/conf.d/tls.conf" ]; then
      $compose kill -s HUP mosquitto >/dev/null
    else
      install -o 1883 -g 1883 -m 0644 deploy/mosquitto/tls.conf "$data/mosquitto/conf.d/tls.conf"
      $compose restart mosquitto >/dev/null
    fi
    echo "[update] sertifikat MQTT TLS diperbarui"
  fi
}

main "$@"
exit 0
