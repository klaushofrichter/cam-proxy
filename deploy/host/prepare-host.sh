#!/bin/bash
# Prepares the multi-camera host (Debian 13) for cam-proxy and its camera
# network (docs/multi-camera-host.md, spec 2026-10-05-multi-camera-host-design §14).
# Run as root after rendering the host files:
#   (on the Mac) npx tsx scripts/host/render.ts host.json /tmp/rendered, copy it over
#   sudo bash prepare-host.sh --rendered /tmp/rendered
# Refuses a ruleset nft won't load and a camera interface that carries the
# default route or this SSH session; forwarding comes on only with the
# ruleset (the nftables.service drop-in).
# Idempotent: a second run changes nothing. --dry-run prints the commands;
# --files-only installs only the files (no packages, no services).
# ROOT=<dir> puts every target under <dir> (tests).
set -euo pipefail

RENDERED=''
DRY=0
FILES_ONLY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --rendered) RENDERED=$2; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    --files-only) FILES_ONLY=1; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[ -n "$RENDERED" ] && [ -d "$RENDERED" ] || { echo "--rendered <dir> (the output of scripts/host/render.ts) is required" >&2; exit 2; }
ROOT=${ROOT:-}
if [ "$(id -u)" -ne 0 ] && [ -z "${PREPARE_HOST_ALLOW_NON_ROOT:-}" ]; then echo "run with sudo" >&2; exit 1; fi
# Debian 13 only (Ubuntu 24.04 works with netplan instead of ifupdown: by
# hand, docs/multi-camera-host.md §1). $ROOT/etc/os-release: tests.
ID=debian
VERSION_CODENAME=trixie
# shellcheck disable=SC1091
[ -r "$ROOT/etc/os-release" ] && . "$ROOT/etc/os-release"
if [ "$ID" != debian ]; then echo "prepare-host.sh is written for Debian (this is $ID): see docs/multi-camera-host.md §1" >&2; exit 1; fi

run() { if [ "$DRY" = 1 ]; then echo "+ $*"; else "$@"; fi; }
CHANGED=()

# One rendered file into place: only when it differs (cmp), with its mode.
place() {
  local rel=$1 mode=$2 keep=${3:-}
  local src="$RENDERED/$rel" dst="$ROOT/$rel"
  if [ -n "$keep" ] && [ -e "$dst" ]; then echo "kept $rel"; return; fi
  if [ -e "$dst" ] && cmp -s "$src" "$dst"; then echo "unchanged $rel"; return; fi
  # mkdir + install -m: BSD install (a Mac running the tests) has no -D.
  if [ "$DRY" = 1 ]; then echo "+ install -m $mode $src $dst"; else mkdir -p "$(dirname "$dst")" && install -m "$mode" "$src" "$dst"; fi
  echo "changed $rel"
  CHANGED+=("$rel")
}

if [ "$FILES_ONLY" = 0 ]; then
  echo "== packages"
  run apt-get update
  run apt-get install -y nftables dnsmasq chrony unattended-upgrades ca-certificates curl
fi

echo "== checks"
# The rendered ruleset is checked before it replaces the installed one: a
# broken ruleset is never placed (nftables.service would fail at the next boot).
# --files-only (staging, tests) checks only where nft can: it needs
# CAP_NET_ADMIN even to check.
if [ "$FILES_ONLY" = 0 ] || echo 'table inet probe {}' | nft -c -f - >/dev/null 2>&1; then
  run nft -c -f "$RENDERED/etc/nftables.conf"
else
  echo "skipped: nft -c (no nft, or not allowed to check without root; --files-only)"
fi
# The camera side must not be the interface this host is reached by: the run
# brings it down and readdresses it.
CAM_IFACE=$(sed -n 's/^interface=//p' "$RENDERED/etc/dnsmasq.d/camera-net.conf" | head -1)
carries() { # <iface> <ip route output>: whether the route goes out of <iface>
  echo "$2" | grep -E "dev $1( |\$)" >/dev/null
}
if command -v ip >/dev/null; then
  if carries "$CAM_IFACE" "$(ip route show default 2>/dev/null)"; then
    echo "refused: $CAM_IFACE carries the default route; the camera side must be the other NIC (host.json cameraNet.iface)" >&2; exit 1
  fi
  SSH_PEER=${SSH_CLIENT:-}; SSH_PEER=${SSH_PEER%% *}
  if [ -n "$SSH_PEER" ] && carries "$CAM_IFACE" "$(ip route get "$SSH_PEER" 2>/dev/null)"; then
    echo "refused: $CAM_IFACE carries this SSH session ($SSH_PEER); the camera side must be the other NIC (host.json cameraNet.iface)" >&2; exit 1
  fi
elif [ "$DRY" = 0 ] && [ "$FILES_ONLY" = 0 ]; then
  echo "refused: no ip command to check the routes" >&2; exit 1
fi
# An interface that carries the default route or the SSH session is never brought down.
safe_down() {
  local i=$1
  command -v ip >/dev/null || return 1
  carries "$i" "$(ip route show default 2>/dev/null)" && return 1
  [ -n "${SSH_CLIENT:-}" ] && carries "$i" "$(ip route get "${SSH_CLIENT%% *}" 2>/dev/null)" && return 1
  return 0
}

# The files go in before Docker is installed: its first start must already
# read "iptables": false (otherwise it adds its own chains and sets FORWARD to
# drop, and the routing breaks until nftables flushes them).
echo "== files"
place etc/nftables.conf 0755
place etc/systemd/system/nftables.service.d/camera-net.conf 0644
place etc/dnsmasq.d/camera-net.conf 0644
place etc/chrony/conf.d/camera-net.conf 0644
place etc/sysctl.d/90-camera-net.conf 0644
for f in "$RENDERED"/etc/network/interfaces.d/*; do place "etc/network/interfaces.d/$(basename "$f")" 0644; done
# A renamed NIC: the interface file rendered for the old name goes.
for f in "$ROOT"/etc/network/interfaces.d/*; do
  [ -f "$f" ] || continue
  n=$(basename "$f")
  [ -e "$RENDERED/etc/network/interfaces.d/$n" ] && continue
  grep -q '^# Rendered by scripts/host/render.ts' "$f" || continue
  run rm -f "$f"
  echo "removed etc/network/interfaces.d/$n"
  CHANGED+=("etc/network/interfaces.d/$n")
done
place etc/docker/daemon.json 0644
place srv/cam-proxy/compose.yaml 0644
place srv/cam-proxy/data/config.json 0644 keep

# Changes not yet applied survive a failed run (here, while installing Docker,
# or in the services step): the next run finds the files unchanged but still
# applies them.
PENDING="$ROOT/var/lib/cam-proxy-host/pending"
if [ "$DRY" = 0 ]; then
  if [ -f "$PENDING" ]; then while read -r rel; do [ -n "$rel" ] && CHANGED+=("$rel"); done < "$PENDING"; fi
  mkdir -p "$(dirname "$PENDING")"
  printf '%s\n' ${CHANGED[@]+"${CHANGED[@]}"} | sort -u | grep -v '^$' > "$PENDING.tmp" || true
  mv "$PENDING.tmp" "$PENDING"
  CHANGED=()
  while read -r rel; do CHANGED+=("$rel"); done < "$PENDING"
fi

[ "$FILES_ONLY" = 1 ] && exit 0

echo "== Docker from Docker's repository (not Debian's docker.io)"
if [ ! -f "$ROOT/etc/apt/sources.list.d/docker.list" ]; then
  run install -m 0755 -d "$ROOT/etc/apt/keyrings"
  run curl -fsSL https://download.docker.com/linux/debian/gpg -o "$ROOT/etc/apt/keyrings/docker.asc"
  LINE="deb [arch=$(dpkg --print-architecture 2>/dev/null || echo amd64) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian ${VERSION_CODENAME} stable"
  if [ "$DRY" = 1 ]; then echo "+ echo '$LINE' > $ROOT/etc/apt/sources.list.d/docker.list"; else echo "$LINE" > "$ROOT/etc/apt/sources.list.d/docker.list"; fi
  run apt-get update
fi
run apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

echo "== services"
# ${CHANGED[@]+…}: an empty array under set -u (bash 3.2 on a Mac).
has() { for c in ${CHANGED[@]+"${CHANGED[@]}"}; do case "$c" in $1) return 0 ;; esac; done; return 1; }
# The camera side gets its address before dnsmasq starts (bind-interfaces
# needs it). ifdown first, so a changed file takes effect; an interface that
# carries the default route or the SSH session is never brought down.
for rel in ${CHANGED[@]+"${CHANGED[@]}"}; do
  case "$rel" in
    etc/network/interfaces.d/*)
      n=$(basename "$rel")
      if [ "$DRY" = 1 ] || safe_down "$n"; then run ifdown --force "$n" 2>/dev/null || true; fi
      if [ -e "$RENDERED/$rel" ]; then run ifup "$n"; fi
      ;;
  esac
done
# The ruleset first, then sysctl: no window without the firewall. IPv4
# forwarding is switched on by nftables.service itself once the ruleset is
# loaded (the rendered drop-in), never by sysctl.d: a ruleset that fails to
# load leaves the host not routing.
# A unit started here loads everything; one already running reloads the
# ruleset atomically (a restart only for a changed drop-in, which applies
# only at start).
WAS_ACTIVE=$(systemctl is-active nftables 2>/dev/null || true)
run systemctl daemon-reload
run systemctl enable --now nftables
if [ "$WAS_ACTIVE" = active ]; then
  if has 'etc/systemd/system/nftables.service.d/*'; then run systemctl restart nftables
  elif has 'etc/nftables.conf'; then run systemctl reload nftables
  fi
fi
run sysctl --system
run systemctl enable --now dnsmasq chrony
has 'etc/dnsmasq.d/*' && run systemctl restart dnsmasq
has 'etc/chrony/*' && run systemctl restart chrony
has 'etc/docker/daemon.json' && run systemctl restart docker
echo "== /srv/cam-proxy for uid 1000 (the container's user)"
run install -d -o 1000 -g 1000 -m 0755 "$ROOT/srv/cam-proxy" "$ROOT/srv/cam-proxy/data"
run install -d -o 1000 -g 1000 -m 0700 "$ROOT/srv/cam-proxy/config"
[ "$DRY" = 0 ] && rm -f "$PENDING"
echo "done: run sudo bash deploy/host/check-host.sh"
