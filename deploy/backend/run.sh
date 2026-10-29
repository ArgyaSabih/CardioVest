#!/usr/bin/env bash
set -u

APP="$(cd "$(dirname "$0")/../.." && pwd)"
DATA="${DATA_ROOT:-$HOME/data}"
BRANCH="${BRANCH:-faza}"
CHECK_EVERY="${CHECK_EVERY:-60}"
cd "$APP"

if [ -n "${MQTT_HOST:-}" ] && [ -z "${MQTT_URL:-}" ]; then
  export MQTT_PORT="${MQTT_PORT:-8883}" MQTT_TLS="${MQTT_TLS:-1}"
  if [ "$MQTT_TLS" = 1 ]; then
    export MQTT_URL="mqtts://$MQTT_HOST:$MQTT_PORT"
  else
    export MQTT_URL="mqtt://$MQTT_HOST:$MQTT_PORT"
  fi
fi
export PYTHONPATH="$APP/common:$APP/cloud:$APP/dataset"
export PORT="${PORT:-10000}"
export DEVICES="${DEVICES:-cv-001:}"
export ALLOWED_ORIGINS="${ALLOWED_ORIGINS:-https://*.vercel.app,http://localhost:3000}"
export RETENSI_HARI="${RETENSI_HARI:-30}"

deps() {
  pip install -q --no-cache-dir -r cloud/requirements.txt -r dataset/requirements.txt
  local lock
  lock=$(sha1sum server/package-lock.json | cut -d' ' -f1)
  if [ ! -d server/node_modules ] || [ "$lock" != "$(cat "$HOME/.npm-lock" 2>/dev/null)" ]; then
    (cd server && npm ci --omit=dev --no-audit --no-fund) && echo "$lock" > "$HOME/.npm-lock"
  fi
}

keep() {
  local name=$1
  shift
  while true; do
    "$@"
    echo "[run] $name berhenti, dinyalakan ulang dalam 3 detik"
    sleep 3
  done
}

stop_all() {
  local p kids
  for p in $(jobs -p); do
    kids=$(pgrep -P "$p")
    kill "$p" 2>/dev/null
    [ -n "$kids" ] && kill $kids 2>/dev/null
  done
  sleep 4
}

echo "[run] commit $(git log -1 --format='%h %s')"
deps
mkdir -p "$DATA/cloud" "$DATA/server"

keep server env DATA_DIR="$DATA/server" CLOUD_DB="$DATA/cloud/cardiovest.db" \
  node --disable-warning=ExperimentalWarning server/main.js &
keep cloud python -m cloud --db "$DATA/cloud/cardiovest.db" &
keep dataset python -m dataset &

while true; do
  sleep "$CHECK_EVERY"
  git fetch -q origin "$BRANCH" || continue
  if [ "$(git rev-parse HEAD)" != "$(git rev-parse FETCH_HEAD)" ]; then
    echo "[run] commit baru di $BRANCH, memperbarui"
    stop_all
    git reset -q --hard FETCH_HEAD
    exec bash "$APP/deploy/backend/run.sh"
  fi
done
