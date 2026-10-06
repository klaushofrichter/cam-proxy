#!/bin/bash
# Checks the multi-camera host after prepare-host.sh (docs/multi-camera-host.md).
# Prints PASS/FAIL per check; exit 1 when any check fails. Read-only; run it
# with sudo (nft reads the ruleset only as root). The camera interface and its
# address come from the installed files (/etc/dnsmasq.d/camera-net.conf and
# /etc/network/interfaces.d/<iface>); --camera-iface/--camera-address override.
set -uo pipefail
# No `grep -q` at the end of a pipe: it exits early, the writer gets SIGPIPE,
# and pipefail turns a match into a failure.
IFACE=''
ADDR=''
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

[ -n "$IFACE" ] || IFACE=$(sed -n 's/^interface=//p' "$ROOT/etc/dnsmasq.d/camera-net.conf" 2>/dev/null | head -1)
[ -n "$IFACE" ] && [ -z "$ADDR" ] && ADDR=$(sed -n 's/^[[:space:]]*address[[:space:]]\{1,\}//p' "$ROOT/etc/network/interfaces.d/$IFACE" 2>/dev/null | head -1)
if [ -z "$IFACE" ] || [ -z "$ADDR" ]; then
  fail camera-config 'no interface= in /etc/dnsmasq.d/camera-net.conf; pass --camera-iface and --camera-address'
fi

[ "$(sysctl -n net.ipv4.ip_forward 2>/dev/null)" = 1 ] && pass ip_forward || fail ip_forward 'net.ipv4.ip_forward is not 1 (nftables.service turns it on once the ruleset is loaded)'

# Without root nft reads nothing, and "no DOCKER chain" would be a false PASS.
if RULESET=$(nft list ruleset 2>/dev/null); then NFT_OK=1; else NFT_OK=0; fail nft-read 'nft list ruleset failed (run with sudo)'; fi

# Docker's rules: in any nftables table (the iptables-nft backend: filter,
# nat, ip6), or in the legacy iptables backend.
if [ "$NFT_OK" = 0 ]; then
  fail docker-iptables 'not checked: nft could not read the ruleset'
elif ! grep -Eq '"iptables"[[:space:]]*:[[:space:]]*false' "$ROOT/etc/docker/daemon.json" 2>/dev/null; then
  fail docker-iptables '/etc/docker/daemon.json must have "iptables": false (Docker would set FORWARD to drop and break the routing)'
elif nft list chain ip filter DOCKER >/dev/null 2>&1 || echo "$RULESET" | grep 'chain DOCKER' >/dev/null; then
  fail docker-iptables 'a DOCKER chain exists: Docker added its own rules; restart docker after fixing daemon.json, then restart nftables'
elif { iptables-legacy-save 2>/dev/null; ip6tables-legacy-save 2>/dev/null; true; } | grep DOCKER >/dev/null; then
  fail docker-iptables 'Docker rules in the legacy iptables backend (iptables-legacy-save); restart docker after fixing daemon.json, then reboot or flush them'
else
  pass docker-iptables
fi

if [ "$NFT_OK" = 1 ] && echo "$RULESET" | grep -A3 'chain forward' | grep 'policy drop' >/dev/null; then pass nft-forward-drop; else fail nft-forward-drop 'the forward chain must have policy drop (nft list ruleset)'; fi

# The loaded ruleset is /etc/nftables.conf (nothing added, nothing stale):
# the file is loaded in an empty network namespace and both listings are
# compared without the counters' values.
norm() { sed -E 's/packets [0-9]+ bytes [0-9]+//; s/[[:space:]]+$//' | grep -v '^$'; }
if [ "$NFT_OK" = 0 ]; then
  fail ruleset-loaded 'not checked: nft could not read the ruleset'
elif ! FROMFILE=$(unshare -n sh -c "nft -f '$ROOT/etc/nftables.conf' && nft list ruleset" 2>&1); then
  fail ruleset-loaded "/etc/nftables.conf does not load: $FROMFILE"
elif [ "$(echo "$RULESET" | norm)" = "$(echo "$FROMFILE" | norm)" ]; then
  pass ruleset-loaded
else
  fail ruleset-loaded 'the loaded ruleset differs from /etc/nftables.conf (sudo systemctl reload nftables; nft list ruleset)'
fi

BAD=''
for s in nftables dnsmasq chrony docker; do [ "$(systemctl is-active "$s" 2>/dev/null)" = active ] || BAD="$BAD $s"; done
[ -z "$BAD" ] && pass services || fail services "not active:$BAD"

chronyc -n sources 2>/dev/null | grep '^\^\*' >/dev/null && pass chrony-synced || fail chrony-synced 'chrony has no selected source (chronyc -n sources)'

if [ -n "$IFACE" ] && [ -n "$ADDR" ]; then
  ip -4 -o addr show dev "$IFACE" 2>/dev/null | grep "inet $ADDR" >/dev/null && pass camera-address || fail camera-address "$IFACE has no $ADDR"
  if [ "$(sysctl -n "net.ipv6.conf.$IFACE.disable_ipv6" 2>/dev/null)" = 1 ] && [ -z "$(ip -6 -o addr show dev "$IFACE" 2>/dev/null)" ]; then
    pass camera-ipv6-off
  else
    fail camera-ipv6-off "$IFACE must have IPv6 off (net.ipv6.conf.$IFACE.disable_ipv6 = 1, no inet6 address)"
  fi
fi

LEASES=0
[ -f "$ROOT/var/lib/misc/dnsmasq.leases" ] && LEASES=$(wc -l < "$ROOT/var/lib/misc/dnsmasq.leases" | tr -d ' ')
echo "INFO dnsmasq-leases: $LEASES active leases"
exit $FAILED
