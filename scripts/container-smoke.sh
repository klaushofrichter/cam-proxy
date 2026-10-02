#!/usr/bin/env bash
# Builds the image and checks it the way the cluster runs it: as uid 1000,
# config.json mounted read-only, a fresh /data volume, secrets from the
# environment (throwaway values, never printed).
#
#   scripts/container-smoke.sh [image-tag]     (default cam-proxy:smoke)
set -euo pipefail
cd "$(dirname "$0")/.."

IMAGE=${1:-cam-proxy:smoke}
NAME=camproxy-smoke-$$
VOL=camproxy-smoke-data-$$
TMP=$(mktemp -d)
PORT=${CAMPROXY_SMOKE_PORT:-18490}
cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker volume rm "$VOL" >/dev/null 2>&1 || true
  rm -rf "$TMP"
}
trap cleanup EXIT
fail() { echo "container smoke: FAIL: $*" >&2; docker logs "$NAME" 2>&1 | tail -20 >&2 || true; exit 1; }

docker build -q --build-arg APP_VERSION=smoke -t "$IMAGE" . >/dev/null

# The binaries the proxy supervises, for this architecture.
docker run --rm --entrypoint go2rtc "$IMAGE" -version >/dev/null || fail "go2rtc does not run"
docker run --rm --entrypoint ffmpeg "$IMAGE" -version >/dev/null || fail "ffmpeg does not run"
[ "$(docker run --rm --entrypoint id "$IMAGE" -u)" = 1000 ] || fail "not running as uid 1000"

# A camera that isn't there: the proxy must start and serve anyway, with a
# read-only root filesystem and /tmp as tmpfs, as in the cluster.
cat > "$TMP/config.json" <<'JSON'
{ "server": { "dataDir": "/data", "logLevel": "warn" },
  "camera": { "host": "127.0.0.1:9", "protocol": "http", "statusPollS": 30 },
  "stills": { "enabled": true } }
JSON
chmod 644 "$TMP/config.json"
CLIENT=$(openssl rand -hex 32)
ADMIN=$(openssl rand -hex 32)
docker volume create "$VOL" >/dev/null
CAMPROXY_TOKENS=$CLIENT CAMPROXY_ADMIN_TOKEN=$ADMIN CAMPROXY_CAMERA_PASSWORD=none \
  docker run -d --name "$NAME" -p "127.0.0.1:$PORT:8480" --read-only --tmpfs /tmp:size=16m \
  -e CAMPROXY_TOKENS -e CAMPROXY_ADMIN_TOKEN -e CAMPROXY_CAMERA_PASSWORD \
  -e CAMPROXY_CONFIG=/config/config.json -v "$TMP/config.json:/config/config.json:ro" \
  -v "$VOL:/data" "$IMAGE" >/dev/null

health=''
for _ in $(seq 1 60); do
  health=$(curl -sf "http://127.0.0.1:$PORT/health" || true)
  [ -n "$health" ] && break
  [ "$(docker inspect -f '{{.State.Running}}' "$NAME")" = true ] || fail "the container exited"
  sleep 0.5
done
# /health also carries startedAt (a restart's "back" check); compare the fixed fields only.
case "$health" in
  '{"ok":true,"version":"smoke",'*'"startedAt":'[0-9]*'}') ;;
  *) fail "health: ${health:-no answer}" ;;
esac
[ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/api/cameras")" = 401 ] || fail "/api without a token is not 401"
[ "$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $CLIENT" "http://127.0.0.1:$PORT/api/cameras")" = 200 ] || fail "/api with the token is not 200"
[ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/")" = 200 ] || fail "the admin UI is not served"
docker exec "$NAME" test -s /data/catalog.sqlite || fail "no catalog in /data"
for _ in $(seq 1 20); do docker exec "$NAME" pgrep -x go2rtc >/dev/null && break; sleep 0.5; done
docker exec "$NAME" pgrep -x go2rtc >/dev/null || fail "go2rtc is not running"
echo "container smoke: ok"
