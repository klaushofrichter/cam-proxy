#!/bin/bash
# Prepares a Raspberry Pi (Raspberry Pi OS / Debian, 64-bit) for cam-proxy.
# Run once as the user who will run the proxy: sudo bash prepare-pi.sh
# See docs/raspberry-pi.md.
# - updates the system;
# - installs Docker Engine and the Compose plugin from Docker's Debian repository;
# - lets that user use Docker without sudo;
# - limits container logs (the SSD is the only disk);
# - creates /srv/cam-proxy, owned by that user (uid 1000 on Raspberry Pi OS,
#   the same uid the container runs as);
# - reboots at the end (new kernel, and the docker group needs a new login).
set -euo pipefail

[ "$(id -u)" -eq 0 ] || { echo "run with sudo"; exit 1; }
USER_NAME=${SUDO_USER:?run with sudo from the login of the user who runs the proxy}

echo "== system update"
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get -y full-upgrade

echo "== Docker repository"
apt-get install -y ca-certificates curl
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
. /etc/os-release
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian ${VERSION_CODENAME} stable" \
  > /etc/apt/sources.list.d/docker.list
apt-get update

echo "== Docker"
DEBIAN_FRONTEND=noninteractive apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
mkdir -p /etc/docker
cat > /etc/docker/daemon.json <<'JSON'
{
  "log-driver": "json-file",
  "log-opts": { "max-size": "10m", "max-file": "3" }
}
JSON
systemctl enable docker containerd
systemctl restart docker
usermod -aG docker "$USER_NAME"

echo "== cam-proxy folder"
install -d -o "$USER_NAME" -g "$USER_NAME" -m 0750 /srv/cam-proxy
install -d -o "$USER_NAME" -g "$USER_NAME" -m 0750 /srv/cam-proxy/data

echo "== check"
docker --version
docker compose version
docker run --rm hello-world | grep -m1 "Hello from Docker"

echo "== done; rebooting in 10 s (Ctrl-C to reboot later yourself)"
sleep 10
reboot
