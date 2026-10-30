#!/usr/bin/env bash
# Checks a pan/tilt/zoom camera through a cam-proxy's PTZ API (spec
# docs/superpowers/specs/2026-10-30-ptz-capabilities-design.md §8.3): moves
# each direction briefly, zooms, focuses, saves a test position, moves away,
# goes back, renames, deletes, and checks a position can be saved again.
# THE CAMERA MOVES while this runs. It touches only positions it created and
# puts the camera back where it was (its start position, zoom included).
#
#   CAMPROXY_URL=http://<proxy>:8480 CAMPROXY_TOKEN=<client token> scripts/ptz-real-check.sh <cam>
#
# Needs bash, curl and node. The token reaches curl only through a header file
# (mode 600, removed at exit); it is never on a command line or printed.
# One "ok …" or "FAIL …" line per step; exit 0 when all pass, 1 on the first
# failure, 2 when the camera can't be checked (no PTZ, offline, no room).
# PTZ_CHECK_PAUSE_S (0.7) and PTZ_CHECK_SETTLE_S (3) set the waits.
set -euo pipefail

CAM=${1:-}
if [ -z "$CAM" ] || [ -z "${CAMPROXY_URL:-}" ] || [ -z "${CAMPROXY_TOKEN:-}" ]; then
  echo "usage: CAMPROXY_URL=http://<proxy>:8480 CAMPROXY_TOKEN=<client token> $0 <cam>" >&2
  exit 2
fi
for tool in curl node; do
  command -v "$tool" >/dev/null || { echo "usage: $0 needs $tool" >&2; exit 2; }
done

URL=${CAMPROXY_URL%/}
PAUSE=${PTZ_CHECK_PAUSE_S:-0.7}
SETTLE=${PTZ_CHECK_SETTLE_S:-3}
RUN=$(date +%s)
TMP=$(mktemp -d)
chmod 700 "$TMP"
HDR="$TMP/auth"
# printf is a shell builtin: the token is on no process's command line.
(umask 077 && printf 'Authorization: Bearer %s\n' "$CAMPROXY_TOKEN" >"$HDR")
unset CAMPROXY_TOKEN

STATUS=000
CREATED=() # ids this run created and has not deleted yet
START=''

ok() { echo "ok $*"; }
fail() { echo "FAIL $*"; exit 1; }
cannot() { echo "FAIL $*"; exit 2; }

# api METHOD PATH [JSON]: STATUS and $TMP/body. PATH is below /api/cameras/<cam>.
api() {
  local args=(-sS -o "$TMP/body" -w '%{http_code}' --max-time 30 -X "$1" -H "@$HDR")
  if [ $# -ge 3 ]; then args+=(-H 'Content-Type: application/json' --data-binary "$3"); fi
  STATUS=$(curl "${args[@]}" "$URL/api/cameras/$CAM$2" 2>/dev/null) || STATUS=000
}

# js EXPR: EXPR over the last body as `j` (null when empty); strings printed bare.
js() {
  node -e '
    const fs = require("fs");
    let j = null;
    try { const s = fs.readFileSync(process.argv[2], "utf8"); j = s ? JSON.parse(s) : null; } catch { j = null; }
    const v = new Function("j", "return (" + process.argv[1] + ")")(j);
    process.stdout.write(v === undefined || v === null ? "" : typeof v === "string" ? v : JSON.stringify(v));
  ' "$1" "$TMP/body"
}

# A JSON body from key=value pairs (values are strings, or numbers when numeric).
body() {
  node -e '
    const o = {};
    for (const kv of process.argv.slice(1)) { const i = kv.indexOf("="); const v = kv.slice(i + 1); o[kv.slice(0, i)] = /^-?\d+$/.test(v) ? Number(v) : v; }
    process.stdout.write(JSON.stringify(o));
  ' "$@"
}

err() { js 'j && j.error ? j.error : ""'; }

# expect CODE WHAT: the last call answered CODE, else FAIL.
expect() {
  [ "$STATUS" = "$1" ] || fail "$2 (HTTP $STATUS $(err))"
  ok "$2"
}

forget() {
  local keep=() id
  for id in "${CREATED[@]}"; do [ "$id" = "$1" ] || keep+=("$id"); done
  CREATED=(${keep[@]+"${keep[@]}"})
}

exists() {
  api GET /ptz/positions
  [ "$STATUS" = 200 ] && [ "$(js "j.positions.some((p) => p.id === '$1') ? 'yes' : 'no'")" = yes ]
}

# At exit, whatever happened: stop, back to the start view, and remove every
# position this run created that still exists (the start one last: it may be Home).
cleanup() {
  local rc=$? id
  set +e
  if [ ${#CREATED[@]} -gt 0 ]; then
    api POST /ptz/stop
    if [ -n "$START" ] && exists "$START"; then
      api POST "/ptz/positions/$START/go"
      sleep "$SETTLE"
    fi
    for id in "${CREATED[@]}"; do
      [ "$id" = "$START" ] && continue
      api DELETE "/ptz/positions/$id"
      echo "cleanup: removed a test position (HTTP $STATUS)"
    done
    if [ -n "$START" ] && exists "$START"; then
      api DELETE "/ptz/positions/$START"
      echo "cleanup: removed the start position (HTTP $STATUS)"
    fi
  fi
  rm -rf "$TMP"
  exit "$rc"
}
trap cleanup EXIT

# 1. A PTZ camera, online, that can store positions.
api GET ''
[ "$STATUS" = 200 ] || cannot "camera $CAM: HTTP $STATUS $(err)"
[ "$(js 'j.capabilities && j.capabilities.ptz && j.online === true ? "yes" : "no"')" = yes ] || cannot "camera $CAM: not a PTZ camera / offline"
[ "$(js 'j.capabilities.ptz.positions ? "yes" : "no"')" = yes ] || cannot "camera $CAM: can't store positions"
FOCUS=$(js 'j.capabilities.ptz.focus === true ? "yes" : "no"')
ZOOM=$(js 'j.capabilities.ptz.zoom === true ? "yes" : "no"')
ok "camera $CAM has PTZ and is online"

# 2. Room for two positions of our own.
api GET /ptz/positions
expect 200 "list positions"
[ "$(js 'j.max - j.positions.length >= 2 ? "yes" : "no"')" = yes ] || cannot "camera $CAM: fewer than two free positions (this check deletes only what it created)"

# 3. Where the camera points now, to come back to.
api POST /ptz/positions "$(body "name=ptz-check start $RUN")"
expect 201 "save the start position"
START=$(js 'j.id')
CREATED+=("$START")

# 4. Each direction, zoom, focus, stop.
for d in left right up down left-up left-down right-up right-down; do
  api POST /ptz/move "$(body "direction=$d" speed=5 durationMs=400)"
  expect 204 "move $d"
  sleep "$PAUSE"
done
if [ "$ZOOM" = yes ]; then
  for d in in out; do
    api POST /ptz/zoom "$(body "direction=$d" durationMs=400)"
    expect 204 "zoom $d"
    sleep "$PAUSE"
  done
fi
if [ "$FOCUS" = yes ]; then
  for d in far near; do
    api POST /ptz/focus "$(body "direction=$d" durationMs=400)"
    expect 204 "focus $d sent"
    sleep "$PAUSE"
  done
fi
api POST /ptz/stop
expect 204 "stop"

# 5. Save, move away, go back, rename, delete, save again.
api POST /ptz/positions "$(body "name=ptz-check test $RUN")"
expect 201 "save a test position"
TEST=$(js 'j.id')
CREATED+=("$TEST")
api POST /ptz/move "$(body direction=left speed=5 durationMs=1500)"
expect 204 "move away"
sleep "$PAUSE"
api POST "/ptz/positions/$TEST/go"
expect 204 "go back to the test position"
sleep "$SETTLE"
api PATCH "/ptz/positions/$TEST" "$(body "name=ptz-check renamed $RUN")"
expect 200 "rename the test position"
api GET /ptz/positions
expect 200 "list positions"
[ "$(js "j.positions.some((p) => p.id === '$TEST' && p.name === 'ptz-check renamed $RUN') ? 'yes' : 'no'")" = yes ] || fail "the list shows the new name"
ok "the list shows the new name"
api DELETE "/ptz/positions/$TEST"
expect 204 "delete the test position"
forget "$TEST"
api GET /ptz/positions
[ "$(js "j.positions.some((p) => p.id === '$TEST') ? 'yes' : 'no'")" = no ] || fail "the test position is gone"
ok "the test position is gone"
api POST /ptz/positions "$(body "name=ptz-check again $RUN")"
expect 201 "a position can be saved again"
AGAIN=$(js 'j.id')
CREATED+=("$AGAIN")
api DELETE "/ptz/positions/$AGAIN"
expect 204 "delete it"
forget "$AGAIN"

# 6. Back to where the camera was, and remove the start position.
api POST "/ptz/positions/$START/go"
expect 204 "back to the start position"
sleep "$SETTLE"
api DELETE "/ptz/positions/$START"
expect 204 "delete the start position"
forget "$START"
START=''
ok "done: the camera is back where it was"
