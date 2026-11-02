#!/usr/bin/env bash
# Gives a configured camera its new address on this cam-proxy (after the DHCP
# router handed out another one), without offboarding it: its password,
# certificate trust and PTZ positions stay.
# Where: run on your workstation, not on the proxy host.
#
#   CAMPROXY_URL=http://<proxy>:8480 CAMPROXY_ADMIN_TOKEN_FILE=<file> \
#     scripts/readdress-camera.sh --id <camera id> --find
#   CAMPROXY_URL=… CAMPROXY_ADMIN_TOKEN_FILE=… \
#     scripts/readdress-camera.sh --id <camera id> --host <address[:port]> [--wait <s>]
#
# --find lists what answers the proxy's ONVIF probe and, when exactly one
# camera of this camera's model is not configured here, suggests its address.
# --host: the proxy checks that the camera there is the same one (its pinned
# certificate, a login with the password the proxy already has, the model it
# last reported), then writes the address where it keeps it (CAMERA_HOST in
# the .env file, or overrides.json) and restarts that camera's side.
# --wait <s> (60): how long to wait for the camera to come online.
# cams-admin (optional; skipped without CAMS_ADMIN_URL): after the proxy took
# the address, the camera's host there too (PATCH, scope registry), unless it
# is from-proxy (the viewers reach it through the proxy). Needs
# CAMS_ADMIN_DIAG_TOKEN_FILE (read), CAMS_ADMIN_OPS_TOKEN_FILE and
# --cams-admin-proxy prx_… (this proxy in cams-admin). A cams-admin failure is
# a FAIL line; the proxy keeps the new address.
#
# Tokens reach curl only through header files (mode 600, removed at exit);
# none is ever on a command line or printed. No camera password is
# sent. Needs bash, curl and python3. One "ok …" or "FAIL …" line per step;
# exit 0 when all pass, 1 on a failure, 2 on a usage error.
set -euo pipefail

usage() { sed -n '2,29p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2; }
ok() { echo "ok $*"; }
fail() { echo "FAIL $*"; exit 1; }

FIND=no HOST='' ID='' WAIT=60 PRX=''
while [ $# -gt 0 ]; do
  case "$1" in
    --find) FIND=yes; shift ;;
    --host) HOST=${2:-}; shift 2 ;;
    --id) ID=${2:-}; shift 2 ;;
    --wait) WAIT=${2:-}; shift 2 ;;
    --cams-admin-proxy) PRX=${2:-}; shift 2 ;;
    -h|--help) usage ;;
    *) echo "unknown option $1" >&2; usage ;;
  esac
done
[ -n "${CAMPROXY_URL:-}" ] && [ -r "${CAMPROXY_ADMIN_TOKEN_FILE:-}" ] || { echo "set CAMPROXY_URL and CAMPROXY_ADMIN_TOKEN_FILE" >&2; usage; }
[[ "$ID" =~ ^[a-z0-9][a-z0-9-]{0,31}$ ]] || { echo "--id (a camera id) is required" >&2; usage; }
if [ "$FIND" = yes ]; then
  [ -z "$HOST" ] || { echo "--find or --host, not both" >&2; usage; }
else
  [ -n "$HOST" ] || { echo "--host or --find is required" >&2; usage; }
fi
[[ "$WAIT" =~ ^[0-9]+$ ]] || usage
CA=no
if [ -n "${CAMS_ADMIN_URL:-}" ] && [ "$FIND" = no ]; then
  [ -r "${CAMS_ADMIN_DIAG_TOKEN_FILE:-}" ] && [ -r "${CAMS_ADMIN_OPS_TOKEN_FILE:-}" ] && [[ "$PRX" =~ ^prx_[0-9A-Z]{20}$ ]] || { echo "with CAMS_ADMIN_URL: CAMS_ADMIN_DIAG_TOKEN_FILE, CAMS_ADMIN_OPS_TOKEN_FILE and --cams-admin-proxy prx_…" >&2; usage; }
  CA=yes
fi
for tool in curl python3; do command -v "$tool" >/dev/null || { echo "needs $tool" >&2; exit 2; }; done

URL=${CAMPROXY_URL%/}
TMP=$(mktemp -d)
chmod 700 "$TMP"
trap 'rm -rf "$TMP"' EXIT
# printf is a shell builtin: the token is on no process's command line.
hdr() { (umask 077 && printf 'Authorization: Bearer %s\n' "$(tr -d '\r\n' <"$1")" >"$2"); }
hdr "$CAMPROXY_ADMIN_TOKEN_FILE" "$TMP/proxy"
if [ "$CA" = yes ]; then
  hdr "$CAMS_ADMIN_DIAG_TOKEN_FILE" "$TMP/diag"
  hdr "$CAMS_ADMIN_OPS_TOKEN_FILE" "$TMP/ops"
fi

STATUS=000
# call HEADERFILE METHOD URL [BODYFILE]: STATUS and $TMP/body.
call() {
  local args=(-sS -o "$TMP/body" -w '%{http_code}' --max-time 60 -X "$2" -H "@$1")
  if [ $# -ge 4 ]; then args+=(-H 'Content-Type: application/json' --data-binary "@$4"); fi
  STATUS=$(curl "${args[@]}" "$3" 2>/dev/null) || STATUS=000
}
# proxy METHOD PATH [BODYFILE]
proxy() { call "$TMP/proxy" "$1" "$URL$2" ${3:+"$3"}; }
# py EXPR [FILE]: EXPR over the JSON in FILE (the last body) as j; strings bare, the rest as JSON.
py() {
  python3 -I -c '
import json, sys
try:
    j = json.load(open(sys.argv[2]))
except Exception:
    j = None
v = eval(sys.argv[1], {"j": j, "json": json})
sys.stdout.write("" if v is None else v if isinstance(v, str) else json.dumps(v))
' "$1" "${2:-$TMP/body}"
}
err() { py '((j.get("error") or "") + (": " + j["detail"] if j.get("detail") else "")) if isinstance(j, dict) else ""'; }

# --find: what answers the ONVIF probe, and the one camera of this model not configured here.
if [ "$FIND" = yes ]; then
  proxy GET "/control/cameras/$ID/status"
  [ "$STATUS" = 200 ] || fail "camera $ID (HTTP $STATUS $(err))"
  MODEL=$(py '(j.get("camera") or {}).get("model") or ""')
  echo '{}' >"$TMP/req"
  proxy POST /control/actions/find-camera "$TMP/req"
  [ "$STATUS" = 200 ] || fail "find-camera (HTTP $STATUS $(err))"
  py '"".join("   {} {} {}{}\n".format(d["useAddress"], d.get("model") or "-", d.get("name") or "-", " (configured here)" if d.get("current") else "") for d in j.get("devices", []))'
  ok "find-camera: $(py 'str(len(j.get("devices", [])))') found"
  if [ -z "$MODEL" ]; then
    echo "   no suggestion: $ID's model is not known (it has not answered since the proxy started)"
    exit 0
  fi
  match=$(MODEL=$MODEL py '[d["useAddress"] for d in j.get("devices", []) if not d.get("current") and (d.get("model") or "").lower() == __import__("os").environ["MODEL"].lower()]')
  n=$(printf '%s' "$match" | python3 -I -c 'import json,sys; print(len(json.load(sys.stdin)))')
  if [ "$n" = 1 ]; then
    addr=$(printf '%s' "$match" | python3 -I -c 'import json,sys; print(json.load(sys.stdin)[0])')
    ok "suggestion: --id $ID --host $addr (the one $MODEL not configured here)"
  else
    echo "   no suggestion: $n cameras of model $MODEL not configured here"
  fi
  exit 0
fi

# --host: the proxy checks the camera there and writes the address.
python3 -I -c 'import json,sys; open(sys.argv[1], "w").write(json.dumps({"host": sys.argv[2]}))' "$TMP/req" "$HOST"
proxy PUT "/control/cameras/$ID/host" "$TMP/req"
[ "$STATUS" = 200 ] || fail "readdress $ID (HTTP $STATUS $(err))"
TO=$(py 'j.get("to")')
CHANGED=yes
if [ "$(py 'j.get("outcome")')" = unchanged ]; then
  ok "$ID: already at $TO"
  CHANGED=no
else ok "$ID: $(py 'j.get("from")') -> $(py 'j.get("to")') ($(py 'j.get("stored")'); $(py '"same model " + j["identity"]["model"] if j["identity"]["checked"] == "model" else "no model known: checked by its certificate trust and login"')$([ "$(py 'j.get("plaintext") is True')" = true ] && echo '; http: the login crossed the network unencrypted' || true))"
fi

# cams-admin: the camera's host there too (also when the proxy had it already: a retry after a failure).
RC=0
if [ "$CA" = no ]; then
  echo "-- cams-admin: not updated (CAMS_ADMIN_URL not set)"
else
  CAU=${CAMS_ADMIN_URL%/}/api/v1
  call "$TMP/diag" GET "$CAU/diag/cameras"
  if [ "$STATUS" != 200 ]; then
    echo "FAIL cams-admin: camera list (HTTP $STATUS $(err)); the proxy keeps $TO"; RC=1
  else
    PRX=$PRX ID=$ID py '[c for c in (j.get("items", []) if isinstance(j, dict) else []) if c.get("proxyId") == __import__("os").environ["PRX"] and c.get("proxyCameraId") == __import__("os").environ["ID"]]' >"$TMP/cam"
    if [ "$(py 'len(j)' "$TMP/cam")" != 1 ]; then
      echo "FAIL cams-admin: no camera for $ID on $PRX; the proxy keeps $TO"; RC=1
    else
      CID=$(py 'j[0]["camsId"]' "$TMP/cam")
      OLD=$(py 'j[0].get("host") or ""' "$TMP/cam")
      if [ "$OLD" = from-proxy ]; then
        ok "cams-admin: $CID reaches the camera through the proxy (host from-proxy), nothing to change"
      elif [ "$OLD" = "$TO" ]; then
        ok "cams-admin: $CID already at $TO"
      else
        python3 -I -c 'import json,sys; c=json.load(open(sys.argv[1]))[0]; open(sys.argv[2], "w").write(json.dumps({"host": sys.argv[3], "version": c["rowVersion"]}))' "$TMP/cam" "$TMP/req" "$TO"
        call "$TMP/ops" PATCH "$CAU/accounts/$(py 'j[0]["accountId"]' "$TMP/cam")/cameras/$(py 'j[0]["id"]' "$TMP/cam")" "$TMP/req"
        if [ "$STATUS" = 200 ]; then
          ok "cams-admin: $CID host $OLD -> $TO"
        else
          echo "FAIL cams-admin: update $CID (HTTP $STATUS $(err)); the proxy keeps $TO"; RC=1
        fi
      fi
    fi
  fi
fi
[ "$CHANGED" = yes ] || exit $RC

# Online at the new address.
deadline=$((SECONDS + WAIT))
while :; do
  proxy GET "/control/cameras/$ID/status"
  [ "$STATUS" = 200 ] && [ "$(py '(j.get("camera") or {}).get("online") is True')" = true ] && break
  [ $SECONDS -ge $deadline ] && fail "$ID not online after ${WAIT}s (HTTP $STATUS)"
  sleep 2
done
ok "$ID online"
exit $RC
