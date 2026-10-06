#!/bin/bash
# Checks the multi-camera host after prepare-host.sh (docs/multi-camera-host.md).
# Prints PASS/FAIL per check; exit 1 when any check fails. Read-only; run it
# with sudo (nft reads the ruleset only as root).
set -uo pipefail
IFACE=enp2s0
ADDR=192.168.60.1/24
while [ $# -gt 0 ]; do
  case "$1" in
    --camera-iface) IFACE=$2; shift 2 ;;
    --camera-address) ADDR=$2; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
ROOT=${ROOT:-}
FAILED=0
pass() { echo "PASS $1"; }
fail() { echo "FAIL $1: $2"; FAILED=1; }

[ "$(sysctl -n net.ipv4.ip_forward 2>/dev/null)" = 1 ] && pass ip_forward || fail ip_forward 'net.ipv4.ip_forward is not 1'

# Without root nft reads nothing, and "no DOCKER chain" would be a false PASS.
if RULESET=$(nft list ruleset 2>/dev/null); then NFT_OK=1; else NFT_OK=0; fail nft-read 'nft list ruleset failed (run with sudo)'; fi

if [ "$NFT_OK" = 0 ]; then
  fail docker-iptables 'not checked: nft could not read the ruleset'
elif ! grep -Eq '"iptables"[[:space:]]*:[[:space:]]*false' "$ROOT/etc/docker/daemon.json" 2>/dev/null; then
  fail docker-iptables '/etc/docker/daemon.json must have "iptables": false (Docker would set FORWARD to drop and break the routing)'
elif nft list chain ip filter DOCKER >/dev/null 2>&1; then
  fail docker-iptables 'a DOCKER chain exists: Docker added its own rules; restart docker after fixing daemon.json, then reload nftables'
else
  pass docker-iptables
fi

if [ "$NFT_OK" = 1 ] && echo "$RULESET" | grep -A3 'chain forward' | grep -q 'policy drop'; then pass nft-forward-drop; else fail nft-forward-drop 'the forward chain must have policy drop (nft list ruleset)'; fi

BAD=''
for s in nftables dnsmasq chrony docker; do [ "$(systemctl is-active "$s" 2>/dev/null)" = active ] || BAD="$BAD $s"; done
[ -z "$BAD" ] && pass services || fail services "not active:$BAD"

chronyc -n sources 2>/dev/null | grep -q '^\^\*' && pass chrony-synced || fail chrony-synced 'chrony has no selected source (chronyc -n sources)'

ip -4 -o addr show dev "$IFACE" 2>/dev/null | grep -q "inet $ADDR" && pass camera-address || fail camera-address "$IFACE has no $ADDR"

LEASES=0
[ -f "$ROOT/var/lib/misc/dnsmasq.leases" ] && LEASES=$(wc -l < "$ROOT/var/lib/misc/dnsmasq.leases" | tr -d ' ')
echo "INFO dnsmasq-leases: $LEASES active leases"
exit $FAILED
