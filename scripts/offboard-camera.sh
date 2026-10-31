#!/usr/bin/env bash
# Offboards a camera (spec docs/superpowers/specs/2026-10-30-camera-onboarding-design.md
# §4.3, §7): out of its cams-admin account first (the viewers stop listing it),
# then off this cam-proxy (configuration, stored password, certificate trust,
# PTZ positions, the camera's FTP upload when it pointed here), then checked.
#
#   CAMPROXY_URL=http://<proxy>:8480 CAMPROXY_ADMIN_TOKEN_FILE=<file> \
#     scripts/offboard-camera.sh --id <camera id> [--yes]
#
# cams-admin (optional; skipped without CAMS_ADMIN_URL): CAMS_ADMIN_URL,
# CAMS_ADMIN_DIAG_TOKEN_FILE (read), CAMS_ADMIN_OPS_TOKEN_FILE (scope
# offboard), --cams-admin-proxy prx_… (this proxy in cams-admin).
# Without --yes it asks for the camera id on a terminal. Recordings follow
# retention. Tokens reach curl only through files (mode 600, removed at exit),
# never on a command line or printed. Needs bash, curl and python3.
# One "ok …" or "FAIL …" line per step; exit 0 when all pass, 1 on a failure
# (leftovers included), 2 on a usage error.
set -euo pipefail

usage() { sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2; }
ok() { echo "ok $*"; }
fail() { echo "FAIL $*"; exit 1; }

ID='' YES=no PRX=''
while [ $# -gt 0 ]; do
  case "$1" in
    --id) ID=${2:-}; shift 2 ;;
    --yes) YES=yes; shift ;;
    --cams-admin-proxy) PRX=${2:-}; shift 2 ;;
    -h|--help) usage ;;
    *) echo "unknown option $1" >&2; usage ;;
  esac
done
[ -n "${CAMPROXY_URL:-}" ] && [ -r "${CAMPROXY_ADMIN_TOKEN_FILE:-}" ] || { echo "set CAMPROXY_URL and CAMPROXY_ADMIN_TOKEN_FILE" >&2; usage; }
[[ "$ID" =~ ^[a-z0-9][a-z0-9-]{0,31}$ ]] || { echo "--id (a camera id) is required" >&2; usage; }
CA=no
if [ -n "${CAMS_ADMIN_URL:-}" ]; then
  [ -r "${CAMS_ADMIN_DIAG_TOKEN_FILE:-}" ] && [ -r "${CAMS_ADMIN_OPS_TOKEN_FILE:-}" ] && [[ "$PRX" =~ ^prx_[0-9A-Z]{20}$ ]] || { echo "with CAMS_ADMIN_URL: CAMS_ADMIN_DIAG_TOKEN_FILE, CAMS_ADMIN_OPS_TOKEN_FILE and --cams-admin-proxy prx_…" >&2; usage; }
  CA=yes
fi
for tool in curl python3; do command -v "$tool" >/dev/null || { echo "needs $tool" >&2; exit 2; }; done
if [ "$YES" = no ]; then
  [ -t 0 ] || { echo "not a terminal: pass --yes" >&2; exit 2; }
  read -r -p "Remove camera $ID from this proxy$([ "$CA" = yes ] && echo ' and its cams-admin account')? Type its id: " answer
  [ "$answer" = "$ID" ] || fail "not confirmed"
fi

URL=${CAMPROXY_URL%/}
TMP=$(mktemp -d)
chmod 700 "$TMP"
trap 'rm -rf "$TMP"' EXIT
hdr() { (umask 077 && printf 'Authorization: Bearer %s\n' "$(tr -d '\r\n' <"$1")" >"$2"); }
hdr "$CAMPROXY_ADMIN_TOKEN_FILE" "$TMP/proxy"
if [ "$CA" = yes ]; then
  hdr "$CAMS_ADMIN_DIAG_TOKEN_FILE" "$TMP/diag"
  hdr "$CAMS_ADMIN_OPS_TOKEN_FILE" "$TMP/ops"
fi
STATUS=000
call() {
  STATUS=$(curl -sS -o "$TMP/body" -w '%{http_code}' --max-time 60 -X "$2" -H "@$1" "$3" 2>/dev/null) || STATUS=000
}
py() {
  python3 -I -c '
import json, sys
try:
    j = json.load(open(sys.argv[2]))
except Exception:
    j = None
v = eval(sys.argv[1], {"j": j, "json": json})
sys.stdout.write("" if v is None else v if isinstance(v, str) else json.dumps(v))
' "$1" "$TMP/body"
}
err() { py '(j or {}).get("error", "") if isinstance(j, dict) else ""'; }
# The registry row for this proxy's camera: "<accountId> <cam_…> <camsId>", or nothing.
row() {
  call "$TMP/diag" GET "$CAU/diag/cameras"
  [ "$STATUS" = 200 ] || fail "cams-admin diag (HTTP $STATUS $(err))"
  py '(lambda c: " ".join([c[0]["accountId"], c[0]["id"], c[0]["camsId"]]) if c else "")([c for c in (j.get("items", j) if isinstance(j, dict) else j) if c.get("proxyId") == "'"$PRX"'" and c.get("proxyCameraId") == "'"$ID"'"])'
}

# 1. cams-admin: out of the account.
if [ "$CA" = yes ]; then
  CAU=${CAMS_ADMIN_URL%/}/api/v1
  r=$(row)
  if [ -n "$r" ]; then
    read -r acc cam cid <<<"$r"
    call "$TMP/ops" DELETE "$CAU/accounts/$acc/cameras/$cam"
    [ "$STATUS" = 204 ] || [ "$STATUS" = 200 ] || fail "cams-admin: remove $cid (HTTP $STATUS $(err))"
    [ -z "$(row)" ] || fail "cams-admin: $cid still registered"
    ok "cams-admin: $cid removed from its account"
  else
    ok "cams-admin: $ID not registered"
  fi
fi

# 2. The proxy: everything it keeps for the camera.
call "$TMP/proxy" DELETE "$URL/control/cameras/$ID"
if [ "$STATUS" = 404 ]; then
  ok "proxy: nothing known about $ID"
else
  [ "$STATUS" = 200 ] || fail "proxy: remove $ID (HTTP $STATUS $(err))"
  ok "proxy: removed $(py '", ".join(j.get("removed", [])) or "nothing"')"
  left=$(py '"; ".join(j.get("leftovers", []))')
  [ -z "$left" ] || fail "proxy: left over (remove by hand): $left"
fi

# 3. Checked: the proxy no longer knows the camera, or (a single-camera
# proxy, whose config.json is never changed) keeps it idle without an address.
call "$TMP/proxy" GET "$URL/api/cameras/$ID"
if [ "$STATUS" = 404 ]; then
  ok "proxy: $ID gone"
elif [ "$STATUS" = 200 ] && [ -z "$(py 'j.get("address")')" ]; then
  ok "proxy: $ID idle, without an address (the proxy's own camera in config.json)"
else
  fail "proxy: $ID still listed (HTTP $STATUS)"
fi
