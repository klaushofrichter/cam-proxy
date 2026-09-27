#!/usr/bin/env bash
# Installs go2rtc (the camera's single RTSP connection, restreamed locally)
# into a folder, default ./tools, and prints the binary's path.
#
#   scripts/install-go2rtc.sh [dir]
#
# The checksums are pinned here. go2rtc publishes none, so they were taken
# from the v1.9.14 release downloads on 2026-09-27 (trust on first use).
set -euo pipefail

VERSION=v1.9.14
DIR=${1:-"$(cd "$(dirname "$0")/.." && pwd)/tools"}
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) ASSET=go2rtc_mac_arm64.zip; SUM=919b78adc759d6b3883d1e1b2ac915ac0985bb903ff1897b4d228527bd64690c ;;
  Darwin-x86_64) ASSET=go2rtc_mac_amd64.zip; SUM=9b0b9a27a4dc3a5b8b93376e7e8fc2787c6af624a512842622be84aec0171c7a ;;
  Linux-aarch64 | Linux-arm64) ASSET=go2rtc_linux_arm64; SUM=359fabade8a7a51e81a55fe6df6b0ef81764a5e1d63179577534eaaa71904b50 ;;
  Linux-x86_64) ASSET=go2rtc_linux_amd64; SUM=32d616af226bd731678ffde328b94cfb94e30339bfefc469cfb76323144615a6 ;;
  *) echo "install-go2rtc: unsupported platform $(uname -s)-$(uname -m)" >&2; exit 2 ;;
esac

BIN="$DIR/go2rtc"
if [ -x "$BIN" ] && "$BIN" -version 2>/dev/null | grep -q "${VERSION#v}"; then echo "$BIN"; exit 0; fi
mkdir -p "$DIR"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
curl -sSfL -o "$TMP/$ASSET" "https://github.com/AlexxIT/go2rtc/releases/download/$VERSION/$ASSET"
if command -v sha256sum >/dev/null; then GOT=$(sha256sum "$TMP/$ASSET" | cut -d' ' -f1); else GOT=$(shasum -a 256 "$TMP/$ASSET" | cut -d' ' -f1); fi
[ "$GOT" = "$SUM" ] || { echo "install-go2rtc: checksum mismatch for $ASSET" >&2; exit 1; }
case "$ASSET" in
  *.zip) (cd "$TMP" && unzip -q "$ASSET" go2rtc) && mv "$TMP/go2rtc" "$BIN" ;;
  *) mv "$TMP/$ASSET" "$BIN" ;;
esac
chmod +x "$BIN"
echo "$BIN"
