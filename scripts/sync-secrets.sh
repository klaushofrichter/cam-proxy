#!/usr/bin/env bash
# Keeps cam-proxy's secrets in .env: generates the tokens when missing, rotates
# one on request. Prints key names only, never values.
#
#   scripts/sync-secrets.sh [--dry-run] [--rotate KEY]... [--env-file PATH]
#
# Generated: CAMPROXY_TOKENS (one client token; add more comma-separated),
#            CAMPROXY_ADMIN_TOKEN.
# Set by hand: CAMPROXY_CAMERA_PASSWORD (the proxy's camera user),
#              CAMPROXY_FTP_PASSWORD (when FTP intake is on).
# Syncing to GitHub and the cluster comes with deployment (plan phase 5).
set -euo pipefail

ENV_FILE="$(cd "$(dirname "$0")/.." && pwd)/.env"
DRY=0
ROTATE=()
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1 ;;
    --rotate) ROTATE+=("$2"); shift ;;
    --env-file) ENV_FILE="$2"; shift ;;
    *) echo "sync-secrets: unknown option $1" >&2; exit 2 ;;
  esac
  shift
done

[ -f "$ENV_FILE" ] || { [ "$DRY" = 1 ] || { touch "$ENV_FILE"; chmod 600 "$ENV_FILE"; }; }
has() { [ -f "$ENV_FILE" ] && grep -qE "^$1=.+" "$ENV_FILE"; }
rotating() { local k; for k in "${ROTATE[@]:-}"; do [ "$k" = "$1" ] && return 0; done; return 1; }
put() {
  local key=$1 value=$2 tmp
  tmp=$(mktemp)
  { grep -vE "^$key=" "$ENV_FILE" || true; printf '%s=%s\n' "$key" "$value"; } > "$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$ENV_FILE"
}
gen() { openssl rand -hex 32; }

for key in CAMPROXY_TOKENS CAMPROXY_ADMIN_TOKEN; do
  if ! has "$key" || rotating "$key"; then
    if [ "$DRY" = 1 ]; then echo "would generate $key"; else put "$key" "$(gen)"; echo "generated $key"; fi
  else
    echo "kept $key"
  fi
done
for key in CAMPROXY_CAMERA_PASSWORD; do
  has "$key" || echo "missing $key (set it by hand: the password of the proxy's camera user)"
done
