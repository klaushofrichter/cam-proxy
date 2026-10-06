#!/bin/bash
# Checks the files scripts/host/render.ts rendered with the real tools of the
# host, before they go to the device (docs/multi-camera-host.md §2):
#   npx tsx scripts/host/render.ts host.json /tmp/rendered
#   bash scripts/host/validate-rendered.sh /tmp/rendered
# Runs on any machine with Docker (a Mac too). Everything happens inside
# throwaway containers: a Debian 13 one (its own network namespace, with
# dummy interfaces named like the host's NICs) for nftables, dnsmasq, chrony,
# ifupdown and sysctl, docker:dind for daemon.json; the compose file is
# checked by `docker compose config` on a copy. Nothing is applied to the
# machine it runs on. Prints PASS/FAIL per check; exit 1 when any fails.
set -uo pipefail

DIR=${1:-}
if [ -z "$DIR" ] || [ ! -d "$DIR" ]; then
  echo "usage: bash scripts/host/validate-rendered.sh <rendered dir> (the output of scripts/host/render.ts)" >&2
  exit 2
fi
DIR=$(cd "$DIR" && pwd)
IMAGE=cam-proxy-host-check:debian13
FAILED=0

# The interface names come from the rendered files themselves.
CAM_IFACE=$(sed -n 's/^interface=//p' "$DIR/etc/dnsmasq.d/camera-net.conf" | head -1)
LAN_IFACE=$(sed -n 's/^net\.ipv4\.conf\.\([^.]*\)\.rp_filter.*/\1/p' "$DIR/etc/sysctl.d/90-camera-net.conf" | head -1)
CAM_ADDR=$(sed -n 's/^ *address //p' "$DIR/etc/network/interfaces.d/$CAM_IFACE" 2>/dev/null | head -1)

docker build -q -t "$IMAGE" - >/dev/null <<'EOF' || { echo "FAIL image: docker build of the Debian 13 check image failed"; exit 1; }
FROM debian:13
RUN apt-get update -qq \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends nftables dnsmasq chrony ifupdown iproute2 procps >/dev/null \
 && rm -rf /var/lib/apt/lists/*
EOF

# One container run: each check prints its own PASS/FAIL line.
RESULT=$(docker run --rm --network none --cap-add NET_ADMIN -e CAM_IFACE="$CAM_IFACE" -e LAN_IFACE="$LAN_IFACE" -e CAM_ADDR="$CAM_ADDR" -v "$DIR:/r:ro" "$IMAGE" bash -c '
  ok() { echo "PASS $1"; }
  bad() { echo "FAIL $1: $2"; }
  ip link add "$LAN_IFACE" type dummy && ip link add "$CAM_IFACE" type dummy

  if out=$(nft -c -f /r/etc/nftables.conf 2>&1); then ok nftables; else bad nftables "$(echo "$out" | head -5)"; fi

  cp /r/etc/dnsmasq.d/*.conf /etc/dnsmasq.d/
  # The conf-dir argument of Debian'"'"'s dnsmasq service.
  if out=$(dnsmasq --test -7 /etc/dnsmasq.d,.dpkg-dist,.dpkg-old,.dpkg-new 2>&1); then ok dnsmasq; else bad dnsmasq "$out"; fi

  cp /r/etc/chrony/conf.d/*.conf /etc/chrony/conf.d/
  if out=$(chronyd -p 2>&1) && echo "$out" | grep -q "^allow "; then ok chrony; else bad chrony "$(echo "$out" | tail -3)"; fi

  cp /r/etc/network/interfaces.d/* /etc/network/interfaces.d/
  if out=$(ifup "$CAM_IFACE" 2>&1) && ip -4 -o addr show dev "$CAM_IFACE" | grep -q "inet $CAM_ADDR"; then ok interfaces; else bad interfaces "$out"; fi

  # Every key exists (interface keys on the dummy NICs); /proc/sys is read-only here.
  missing=""
  while IFS="=" read -r k v; do
    k=$(echo "$k" | tr -d " "); [ -z "$k" ] && continue; case "$k" in \#*) continue ;; esac
    sysctl -n "$k" >/dev/null 2>&1 || missing="$missing $k"
  done < /r/etc/sysctl.d/90-camera-net.conf
  if [ -z "$missing" ]; then ok sysctl; else bad sysctl "unknown keys:$missing"; fi
' 2>&1)
echo "$RESULT"
echo "$RESULT" | grep -q '^PASS sysctl' || FAILED=1
echo "$RESULT" | grep -q '^FAIL' && FAILED=1

if out=$(docker run --rm --entrypoint dockerd -v "$DIR/etc/docker:/r:ro" docker:dind --validate --config-file /r/daemon.json 2>&1); then
  echo "PASS docker-daemon"
else
  echo "FAIL docker-daemon: $out"; FAILED=1
fi

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
cp "$DIR/srv/cam-proxy/compose.yaml" "$TMP/" && mkdir -p "$TMP/config" && : > "$TMP/config/.env"
if out=$(docker compose -f "$TMP/compose.yaml" config -q 2>&1); then echo "PASS compose"; else echo "FAIL compose: $out"; FAILED=1; fi

exit $FAILED
