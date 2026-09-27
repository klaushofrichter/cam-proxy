#!/usr/bin/env bash
# Downloads MediaMTX (RTSP for cam-sim), checksum-verified, into a directory
# (default: tools/). Prints the binary's path. Linux and macOS, amd64/arm64.
#   scripts/install-mediamtx.sh [dir]      MEDIAMTX_VERSION overrides the version
set -euo pipefail
VERSION=${MEDIAMTX_VERSION:-v1.21.1}
DIR=${1:-"$(cd "$(dirname "$0")/.." && pwd)/tools"}
case "$(uname -s)" in Linux) os=linux ;; Darwin) os=darwin ;; *) echo "unsupported OS" >&2; exit 1 ;; esac
case "$(uname -m)" in x86_64|amd64) arch=amd64 ;; arm64|aarch64) arch=arm64 ;; *) echo "unsupported CPU" >&2; exit 1 ;; esac
f="mediamtx_${VERSION}_${os}_${arch}.tar.gz"
u="https://github.com/bluenviron/mediamtx/releases/download/${VERSION}"
mkdir -p "$DIR"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
curl -fsSL -o "$tmp/$f" "$u/$f"
curl -fsSL -o "$tmp/checksums.sha256" "$u/checksums.sha256"
want=$(grep "[ *]$f\$" "$tmp/checksums.sha256" | cut -d' ' -f1)
got=$( (sha256sum "$tmp/$f" 2>/dev/null || shasum -a 256 "$tmp/$f") | cut -d' ' -f1)
[ -n "$want" ] && [ "$want" = "$got" ] || { echo "checksum mismatch for $f" >&2; exit 1; }
tar -xzf "$tmp/$f" -C "$DIR" mediamtx
echo "$DIR/mediamtx"
