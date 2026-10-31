#!/usr/bin/env bash
# Onboards a camera on this cam-proxy and, optionally, in cams-admin (spec
# docs/superpowers/specs/2026-10-30-camera-onboarding-design.md §3, §7):
# probe → confirm the certificate → password → add → time / FTP → ready on
# the proxy → registered (adopted) in cams-admin → ready there too.
#
#   CAMPROXY_URL=http://<proxy>:8480 CAMPROXY_ADMIN_TOKEN_FILE=<file> \
#     scripts/onboard-camera.sh --find
#   CAMPROXY_URL=… CAMPROXY_ADMIN_TOKEN_FILE=… \
#     scripts/onboard-camera.sh --host <address[:port]> --id <camera id> [options] < password
#
# Options: --name <text>, --protocol https|http (https), --user <name> (admin),
# --fingerprint SHA256:<hex> (the certificate you confirmed; asked for on a
# terminal when missing), --ftp (clip uploads to this proxy), --time (set the
# camera's time zone), --port-https/-http/-rtsp/-onvif/-baichuan <n>,
# --wait <s> (120: how long to wait for ready).
# cams-admin (all optional; skipped without CAMS_ADMIN_URL): CAMS_ADMIN_URL,
# CAMS_ADMIN_DIAG_TOKEN_FILE (read), CAMS_ADMIN_OPS_TOKEN_FILE (scope onboard:
# adopts the camera; without it the account must adopt by itself),
# --cams-admin-proxy prx_… (this proxy in cams-admin), --cams-id <id>.
#
# The camera password is read from stdin (not echoed on a terminal). Tokens
# and the password reach curl only through files (mode 600, removed at exit);
# none is ever on a command line or printed. Needs bash, curl and python3.
# One "ok …" or "FAIL …" line per step; exit 0 when all pass, 1 on a failure,
# 2 on a usage error.
set -euo pipefail

usage() { sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2; }
ok() { echo "ok $*"; }
fail() { echo "FAIL $*"; exit 1; }

FIND=no HOST='' ID='' NAME='' PROTOCOL=https CUSER=admin FP='' FTP=no TIME=no WAIT=120 PRX='' CAMS_ID=''
PORTS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --find) FIND=yes; shift ;;
    --host) HOST=${2:-}; shift 2 ;;
    --id) ID=${2:-}; shift 2 ;;
    --name) NAME=${2:-}; shift 2 ;;
    --protocol) PROTOCOL=${2:-}; shift 2 ;;
    --user) CUSER=${2:-}; shift 2 ;;
    --fingerprint) FP=${2:-}; shift 2 ;;
    --ftp) FTP=yes; shift ;;
    --time) TIME=yes; shift ;;
    --wait) WAIT=${2:-}; shift 2 ;;
    --port-https|--port-http|--port-rtsp|--port-onvif|--port-baichuan) PORTS+=("${1#--port-}=${2:-}"); shift 2 ;;
    --cams-admin-proxy) PRX=${2:-}; shift 2 ;;
    --cams-id) CAMS_ID=${2:-}; shift 2 ;;
    -h|--help) usage ;;
    *) echo "unknown option $1" >&2; usage ;;
  esac
done
[ -n "${CAMPROXY_URL:-}" ] && [ -r "${CAMPROXY_ADMIN_TOKEN_FILE:-}" ] || { echo "set CAMPROXY_URL and CAMPROXY_ADMIN_TOKEN_FILE" >&2; usage; }
if [ "$FIND" = no ]; then
  [ -n "$HOST" ] && [[ "$ID" =~ ^[a-z0-9][a-z0-9-]{0,31}$ ]] || { echo "--host and --id (a camera id) are required" >&2; usage; }
  [ "$PROTOCOL" = https ] || [ "$PROTOCOL" = http ] || usage
  [[ "$WAIT" =~ ^[0-9]+$ ]] || usage
fi
CA=no
if [ -n "${CAMS_ADMIN_URL:-}" ]; then
  [ -r "${CAMS_ADMIN_DIAG_TOKEN_FILE:-}" ] && [[ "$PRX" =~ ^prx_[0-9A-Z]{20}$ ]] || { echo "with CAMS_ADMIN_URL: CAMS_ADMIN_DIAG_TOKEN_FILE and --cams-admin-proxy prx_…" >&2; usage; }
  CA=yes
fi
for tool in curl python3; do command -v "$tool" >/dev/null || { echo "needs $tool" >&2; exit 2; }; done

URL=${CAMPROXY_URL%/}
TMP=$(mktemp -d)
chmod 700 "$TMP"
trap 'rm -rf "$TMP"' EXIT
# printf is a shell builtin: a token is on no process's command line.
hdr() { (umask 077 && printf 'Authorization: Bearer %s\n' "$(tr -d '\r\n' <"$1")" >"$2"); }
hdr "$CAMPROXY_ADMIN_TOKEN_FILE" "$TMP/proxy"
if [ "$CA" = yes ]; then
  hdr "$CAMS_ADMIN_DIAG_TOKEN_FILE" "$TMP/diag"
  [ -r "${CAMS_ADMIN_OPS_TOKEN_FILE:-}" ] && hdr "$CAMS_ADMIN_OPS_TOKEN_FILE" "$TMP/ops"
fi

STATUS=000
# call HEADERFILE METHOD URL [BODYFILE]: STATUS and $TMP/body.
call() {
  local args=(-sS -o "$TMP/body" -w '%{http_code}' --max-time 60 -X "$2" -H "@$1")
  if [ $# -ge 4 ]; then args+=(-H 'Content-Type: application/json' --data-binary "@$4"); fi
  STATUS=$(curl "${args[@]}" "$3" 2>/dev/null) || STATUS=000
}
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
err() { py '(j or {}).get("error", "") if isinstance(j, dict) else ""'; }
# jsonfile FILE ARG…: a JSON object from KEY=text, KEY:=json and KEY@=file (that file's first line).
jsonfile() {
  local f=$1; shift
  (umask 077 && python3 -I -c '
import json, re, sys
o = {}
for a in sys.argv[2:]:
    k, op, v = re.match(r"([A-Za-z]+)(:=|@=|=)(.*)", a, re.S).groups()
    o[k] = json.loads(v) if op == ":=" else open(v).readline().rstrip("\r\n") if op == "@=" else v
open(sys.argv[1], "w").write(json.dumps(o))
' "$f" "$@")
}
ports_json() {
  local kv out='{}'
  for kv in ${PORTS[@]+"${PORTS[@]}"}; do
    out=$(python3 -I -c 'import json,sys; o=json.loads(sys.argv[1]); k,v=sys.argv[2].split("=",1); o[k]=int(v); print(json.dumps(o))' "$out" "$kv")
  done
  echo "$out"
}

# --find: what answers the ONVIF probe on this proxy's LAN.
if [ "$FIND" = yes ]; then
  echo '{}' >"$TMP/req"
  proxy POST /control/actions/find-camera "$TMP/req"
  [ "$STATUS" = 200 ] || fail "find-camera (HTTP $STATUS $(err))"
  py '"".join("   {} {} {}{}\n".format(d["useAddress"], d.get("model") or "-", d.get("name") or "-", " (configured here)" if d.get("current") else "") for d in j.get("devices", []))'
  ok "find-camera: $(py 'str(len(j.get("devices", [])))') found"
  exit 0
fi

PJ=$(ports_json)
# 1. Probe without a password: which ports answer, the certificate it serves.
jsonfile "$TMP/req" "host=$HOST" "protocol=$PROTOCOL" "user=$CUSER" "ports:=$PJ"
proxy POST /control/actions/camera-probe "$TMP/req"
[ "$STATUS" = 200 ] || fail "probe $HOST (HTTP $STATUS $(err))"
ok "probe $HOST: ports $(py '",".join(k for k, v in sorted(j["ports"].items()) if v) or "none"')"
SERVED=$(py '(j.get("certificate") or {}).get("fingerprint")')

# 2. The certificate: the one confirmed (--fingerprint, or typed yes on a terminal).
if [ "$PROTOCOL" = https ]; then
  [ -n "$SERVED" ] || fail "certificate: $HOST serves none on its https port"
  echo "   certificate $SERVED ($(py '(j.get("certificate") or {}).get("subject") or ""'))"
  if [ -n "$FP" ]; then
    [ "$FP" = "$SERVED" ] || fail "certificate: the camera serves $SERVED, not the given $FP"
  elif [ -t 0 ]; then
    read -r -p "   Is that the fingerprint the camera's own page shows? Type yes: " answer
    [ "$answer" = yes ] || fail "certificate not confirmed"
    FP=$SERVED
  else
    fail "certificate: give --fingerprint $SERVED once you checked it on the camera's own page"
  fi
  ok "certificate confirmed"
fi

# 3. The camera password, from stdin: into a file only.
if [ -t 0 ]; then
  read -r -s -p "   Camera password for $CUSER@$HOST: " pw
  echo
  (umask 077 && printf '%s\n' "$pw" >"$TMP/pw")
  unset pw
else
  (umask 077 && head -n 1 >"$TMP/pw")
fi
[ -s "$TMP/pw" ] && [ "$(wc -c <"$TMP/pw")" -gt 1 ] || fail "no camera password on stdin"

# 4. Add: the proxy logs in first; nothing is stored unless the camera accepts.
args=("id=$ID" "host=$HOST" "protocol=$PROTOCOL" "user=$CUSER" "password@=$TMP/pw" "ports:=$PJ" "ftp:=$([ "$FTP" = yes ] && echo true || echo false)")
[ -n "$NAME" ] && args+=("name=$NAME")
[ "$PROTOCOL" = https ] && args+=("trust:={\"fingerprint\":\"$FP\"}")
jsonfile "$TMP/req" "${args[@]}"
rm -f "$TMP/pw"
proxy POST /control/cameras "$TMP/req"
rm -f "$TMP/req"
[ "$STATUS" = 201 ] || fail "add $ID (HTTP $STATUS $(err))"
ok "add $ID$([ "$(py 'j.get("plaintext") is True')" = true ] && echo ' (http: the password crossed the network unencrypted)')"

# 5. Optional extras.
echo '{}' >"$TMP/req"
if [ "$TIME" = yes ]; then
  proxy POST "/control/cameras/$ID/actions/camera-time-set" "$TMP/req"
  [ "$STATUS" = 200 ] || fail "time (HTTP $STATUS $(err))"
  ok "time: $(py 'j.get("outcome")') $(py 'j.get("zone") or ""')"
fi
if [ "$FTP" = yes ]; then
  proxy POST "/control/cameras/$ID/actions/camera-ftp-setup" "$TMP/req"
  [ "$STATUS" = 200 ] || fail "FTP setup (HTTP $STATUS $(err))"
  ok "FTP: the camera uploads here"
fi

# 6. Ready on the proxy: the required steps all ok.
deadline=$((SECONDS + WAIT))
while :; do
  proxy GET "/control/cameras/$ID/onboarding"
  [ "$STATUS" = 200 ] && [ "$(py 'j.get("ready") is True')" = true ] && break
  [ $SECONDS -ge $deadline ] && break
  sleep 3
done
[ "$STATUS" = 200 ] || fail "onboarding status (HTTP $STATUS $(err))"
py '"\n".join(("   ok " if s.get("ok") is True else "   -- " if s.get("ok") is None else "   no ") + k + ": " + (s.get("detail") or "") for k, s in j["steps"].items())'
echo
[ "$(py 'j.get("ready") is True')" = true ] || fail "$ID not ready on the proxy after ${WAIT}s"
ok "$ID ready on the proxy"
[ "$CA" = yes ] || exit 0

# 7. cams-admin: registered (adopted by the ops token, or by the account itself).
CAU=${CAMS_ADMIN_URL%/}/api/v1
ACC='' CID=''
deadline=$((SECONDS + WAIT))
while :; do
  call "$TMP/diag" GET "$CAU/diag/cameras"
  if [ "$STATUS" = 200 ]; then
    found=$(py '(lambda c: c[0]["accountId"] + " " + c[0]["camsId"] if c else "")([c for c in (j.get("items", j) if isinstance(j, dict) else j) if c.get("proxyId") == "'"$PRX"'" and c.get("proxyCameraId") == "'"$ID"'"])')
    if [ -n "$found" ]; then ACC=${found% *}; CID=${found#* }; break; fi
  fi
  call "$TMP/diag" GET "$CAU/diag/proxies/$PRX/unregistered"
  if [ "$STATUS" = 200 ] && [ "$(py 'any(i.get("ref") == "'"$ID"'" for i in j.get("items", []))')" = true ] && [ -r "$TMP/ops" ]; then
    acc=$(py 'j["accountId"]')
    args=("proxyCameraId=$ID")
    [ -n "$CAMS_ID" ] && args+=("camsId=$CAMS_ID")
    [ -n "$NAME" ] && args+=("name=$NAME")
    jsonfile "$TMP/req" "${args[@]}"
    call "$TMP/ops" POST "$CAU/accounts/$acc/proxies/$PRX/adopt" "$TMP/req"
    [ "$STATUS" = 201 ] || fail "cams-admin adopt (HTTP $STATUS $(err))"
    ok "cams-admin: adopted as $(py 'j.get("camsId")')"
    continue
  fi
  [ $SECONDS -ge $deadline ] && fail "cams-admin: $ID not registered after ${WAIT}s$([ -r "$TMP/ops" ] || echo ' (no CAMS_ADMIN_OPS_TOKEN_FILE to adopt it, and the account did not adopt it by itself)')"
  sleep 3
done
ok "cams-admin: registered as $CID"

# 8. Ready in cams-admin: the proxy's report and every viewer.
deadline=$((SECONDS + WAIT))
while :; do
  call "$TMP/diag" GET "$CAU/diag/cameras/$CID/onboarding?accountId=$ACC"
  [ "$STATUS" = 200 ] && [ "$(py 'j.get("ready") is True')" = true ] && break
  [ $SECONDS -ge $deadline ] && fail "cams-admin: $CID not ready after ${WAIT}s (HTTP $STATUS; missing: $(py '", ".join((j or {}).get("missing") or [])'))"
  sleep 3
done
ok "cams-admin: $CID ready"
