# cam-proxy on the multi-camera host (the mini PC)

This guide sets up the mini PC that runs one cam-proxy for several cameras on
a camera network of their own, behind the PC (spec
[2026-10-05-multi-camera-host-design](superpowers/specs/2026-10-05-multi-camera-host-design.md)
§14, plan `2026-10-05-multi-camera-p4-host-setup`). It was written before the
PC arrived: the scripts are tested, the rendered files were checked with
Debian 13's own tools in a container, and the sections that need the device
end in a **Result** paragraph that is filled in on the device.

Every host file (firewall, DHCP, NTP, sysctl, the camera-side interface,
Docker's `daemon.json`, compose and the proxy's first `config.json`) is
rendered from one description of the host, `host.json`, by
`scripts/host/render.ts`. Don't edit the rendered files on the host by hand:
change `host.json`, render again, and run `deploy/host/prepare-host.sh`.

Placeholders:

| Placeholder | Meaning |
|---|---|
| `<host-lan>` | the PC's LAN address (from the router's DHCP; e.g. 192.168.1.230) |
| `<user>` | the PC's login user (uid 1000, the same uid the container runs as) |
| `<mac-…>` | a device's MAC address, lower case with colons |

## What it is

- **The PC:** a mini PC of the Ryzen 5 3500U class (4 cores / 8 threads),
  8 GB RAM, an NVMe disk, **two Ethernet ports**: one to the LAN, one to the
  cameras' PoE switch.
- **The camera network `192.168.60.0/24`** sits behind the PC. The PC is its
  gateway, DHCP server and NTP server. The cameras can't reach the internet
  or the LAN; the LAN reaches them over a static route on the router.
- **A second GPS-208** PoE switch powers the cameras (the Pi keeps its own).
- **cams** stays in the cluster and reaches both the proxy (`<host-lan>`) and
  the cameras (over the route).

| Address | What |
|---|---|
| LAN side `enp1s0` | `<host-lan>` from the router's DHCP (no reservation: the router keeps an address per MAC) |
| camera side `enp2s0` | `192.168.60.1/24`, static |
| `192.168.60.2` | the GPS-208's management address (a fixed lease, or set by hand: §4) |
| `192.168.60.11`–`.29` | the cameras, fixed leases by MAC (cam3 → `.13`, cam4 → `.14`, …) |
| `192.168.60.100`–`.149` | a small dynamic pool for a new device until it has its lease |

The NIC names `enp1s0` and `enp2s0` are the guide's; the PC's may differ
(`ip -br link`), and `host.json` takes the real ones.

## 1. Install Debian 13

- **Debian 13 (trixie) netinst**, amd64. In tasksel pick only "SSH server"
  and "standard system utilities": no desktop.
- Leave the root password empty in the installer, so the first user, `<user>`
  (uid 1000), gets `sudo`.
- Let the installer configure the **LAN port** with DHCP (the one cabled to
  the router) and leave the camera port alone: the rendered
  `/etc/network/interfaces.d/enp2s0` configures it.
- SSH key auth, then no passwords:

  ```sh
  # on the PC, as <user>:
  mkdir -p ~/.ssh && chmod 700 ~/.ssh
  echo '<your public key>' >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys
  # after a key login works:
  echo 'PasswordAuthentication no' | sudo tee /etc/ssh/sshd_config.d/10-keys.conf
  sudo systemctl reload ssh
  ```

- Unattended security updates: `deploy/host/prepare-host.sh` installs
  `unattended-upgrades`, which Debian enables by default
  (`/etc/apt/apt.conf.d/20auto-upgrades`).
- Check the basics:

  ```sh
  ssh <user>@<host-lan> 'uname -m; . /etc/os-release; echo $PRETTY_NAME; ip -br link'
  ```

  Expect `x86_64`, `Debian GNU/Linux 13 (trixie)`, and two Ethernet links:
  note their names.

**Ubuntu Server 24.04 LTS** works too, with the same tools. Netplan replaces
`/etc/network/interfaces`: give the camera port `192.168.60.1/24` in a netplan
file instead of the rendered `interfaces.d` file, and keep systemd-resolved
off the camera side. `deploy/host/prepare-host.sh` is written for Debian and
refuses another system: on Ubuntu, do its steps by hand (Docker's repository
is `https://download.docker.com/linux/ubuntu`).

**Result:** _(on the device)_

## 2. Describe the host

`host.json` describes the host once. Start from
`deploy/host/host.example.json` (the first PC; its MACs are placeholders):

- `lan.iface`, `cameraNet.iface`: the real NIC names.
- `lan.subnet`: the home LAN (`192.168.1.0/24`).
- `lan.address`: the address the router keeps for the PC (by MAC; no
  reservation). It becomes an IP name of the proxy's certificate and is
  covered by the site CA (§13); if the router ever gives the PC another one,
  the Certificates card says so and `tls-ca-rotate` makes a new CA.
- `hostname`: also the site label of the site CA (`<camera>.<hostname>.internal`).
- `clusterCidrs`: the cluster's pod and service ranges, from the kube-setup
  session (k3s `--cluster-cidr` and `--service-cidr`; the defaults are
  `10.42.0.0/16` and `10.43.0.0/16`). The camera subnet must not overlap them
  or the LAN.
- `proxy.httpFromLan`: **`true` between P4 and P5** (Klaus, 2026-10-05):
  cams in the cluster reaches the proxy on `http://<host-lan>:8480` until the
  site CA of P5 brings HTTPS on 8443. P5 sets it back to `false`, the
  example's value.
- `proxy.passive`: the FTP passive range, at least 10 ports per camera.
- `leases`: one entry per device: the switch (`"role": "switch"`) and each
  camera (`"camera": { "id": "cam3", "poeSwitchPort": 1 }`). The MAC is on
  the device's label; the switch's is also in callcmd 101's `mac`
  ([poe-switch.md](poe-switch.md)).

`scripts/host/host-config.ts` refuses a description that would break the
network, naming the entry: the same NIC for both sides or a name that isn't
a plain interface name, a proxy port outside 1–65535, repeated or inside the
passive range, a lease outside the camera subnet, inside the
dynamic pool or on the host's own address, a duplicate MAC, address or camera
id, a camera subnet that overlaps the LAN or the cluster, a passive range too
small for the cameras.

Render, check and copy from the Mac (a cam-proxy checkout; the PC needs no
Node):

```sh
npx tsx scripts/host/render.ts host.json /tmp/rendered
bash scripts/host/validate-rendered.sh /tmp/rendered
scp host.json <user>@<host-lan>:/tmp/host.json
scp -r /tmp/rendered deploy/host/prepare-host.sh deploy/host/check-host.sh <user>@<host-lan>:/tmp/
ssh <user>@<host-lan> 'sudo install -d /srv/cam-proxy && sudo install -m 0644 /tmp/host.json /srv/cam-proxy/host.json'
```

The render prints the nine files it wrote. `scripts/host/validate-rendered.sh`
checks them with the host's own tools in throwaway Docker containers, without
touching the Mac's network: `nft -c` on the ruleset, `systemd-analyze verify`
on nftables.service with the forwarding drop-in, `dnsmasq --test` with
Debian's conf-dir, `chronyd -p`, `ifup` of the camera interface on a dummy
NIC, every sysctl key, `dockerd --validate` on `daemon.json`, and
`docker compose config`. Every line must say `PASS`.

Keep `host.json` with the PC (`/srv/cam-proxy/host.json`) and in your notes:
it is the record of every lease.

## 3. Prepare the host

```sh
ssh <user>@<host-lan>
sudo bash /tmp/prepare-host.sh --rendered /tmp/rendered
sudo bash /tmp/check-host.sh
```

`prepare-host.sh` installs nftables, dnsmasq, chrony, unattended-upgrades,
checks the rendered ruleset (`nft -c`) and refuses to go on when the camera
interface carries the default route or this SSH session (a swapped
`lan.iface`/`cameraNet.iface`: the run brings the camera side down and
readdresses it), then installs the rendered files, then Docker CE with the Compose plugin from Docker's
own apt repository (not Debian's `docker.io`), and starts the services. It is
idempotent: a second run prints `unchanged` for every file and restarts
nothing. A file is replaced only when it differs, `config.json` only when it
is absent (`kept` otherwise: the proxy's settings are yours after the first
start), and changes a failed run didn't apply stay pending for the next run
(also when the Docker install fails). A ruleset that `nft -c` refuses is
never placed. The firewall is loaded before `sysctl --system`; on a running
host a changed ruleset is reloaded atomically, and the SSH session survives
(established connections and SSH from the LAN are accepted). When a NIC is
renamed in `host.json`, the interface file rendered for the old name is
removed. `--dry-run` prints what it would do.

**Forwarding fails closed.** IPv4 forwarding is not in sysctl.d (systemd-sysctl
would turn it on at boot before the firewall). A drop-in of nftables.service
turns it on after the ruleset has loaded and off when the unit stops: a
ruleset that fails to load at boot leaves the host not routing at all.
Docker's own `ip-forward` is off too.

`check-host.sh` needs `sudo` (nft reads the ruleset only as root). It takes
the camera interface and its address from the installed files
(`/etc/dnsmasq.d/camera-net.conf`, `/etc/network/interfaces.d/<iface>`;
`--camera-iface` and `--camera-address` override them) and prints `PASS` or
`FAIL` per check: `ip_forward`, `docker-iptables` (`daemon.json`, a `DOCKER`
chain in any nftables table, or rules in the legacy iptables backend),
`nft-forward-drop`, `ruleset-loaded` (the loaded ruleset is exactly
`/etc/nftables.conf`, compared in an empty network namespace), `services`,
`chrony-synced` (may need a minute after the first start), `camera-address`,
`camera-ipv6-off`, and the number of DHCP leases.

What the rendered files do (spec §14.2):

| File | What |
|---|---|
| `/etc/nftables.conf` | the host's only ruleset, `table inet filter`. `forward` (policy drop): established/related; LAN → `192.168.60.0/24` on every port (HTTPS, RTSP, ONVIF, 9000 for the Reolink app); everything from the camera side dropped and counted (`cameras_dropped`). `input` (policy drop): established, loopback; from the LAN SSH and 8443 (8480 too while `httpFromLan`), ICMP echo; from the camera side DHCP (UDP 67), NTP (UDP 123), FTP (TCP 2121 and the passive range), ICMP echo. Invalid packets are dropped. `output`: accept. No masquerade anywhere: the cameras see the real LAN client, and their replies go back through the host |
| `/etc/dnsmasq.d/camera-net.conf` | DHCP on the camera side only (`interface=enp2s0`, `bind-interfaces`), no DNS (`port=0`, and no DNS server announced), the pool, one `infinite` lease per device, the host as gateway and NTP server |
| `/etc/chrony/conf.d/camera-net.conf` | serves time to `192.168.60.0/24`; `local stratum 10` keeps the cameras on a common time while the internet is down. The PC itself syncs from Debian's pools |
| `/etc/systemd/system/nftables.service.d/camera-net.conf` | `net.ipv4.ip_forward=1` after the ruleset has loaded, `0` when nftables stops (fails closed) |
| `/etc/sysctl.d/90-camera-net.conf` | no IPv6 forwarding, IPv6 off on the camera side; `rp_filter = 2` (loose) on the LAN side |
| `/etc/network/interfaces.d/enp2s0` | the camera side, static `192.168.60.1/24` |
| `/etc/docker/daemon.json` | `"iptables": false, "ip6tables": false, "ip-forward": false`, log rotation |
| `/srv/cam-proxy/compose.yaml` | cam-proxy with host networking (§8) |
| `/srv/cam-proxy/data/config.json` | the proxy's first config: the cameras with their addresses and switch ports, the switch, FTP with the same passive range as the firewall |

**Why Docker runs with `"iptables": false`:** every container here uses host
networking, so Docker needs no rules. With its default, Docker adds its own
chains and sets the FORWARD policy to drop, which silently breaks the routing
to the cameras. `prepare-host.sh` puts `daemon.json` in place before Docker
is installed, so its first start already reads it; `check-host.sh` fails when
a Docker package upgrade or a hand edit brings the rules back (a `DOCKER`
chain).

**Checked before the device (2026-10-05):** the files rendered from the
example passed `scripts/host/validate-rendered.sh` (Debian 13 container:
nftables, the nftables.service drop-in, dnsmasq, chrony, ifupdown, sysctl;
`dockerd --validate`; compose). `prepare-host.sh` ran for real in a Debian 13
container (systemctl and sysctl stubbed): the packages, Docker 29 and the
Compose plugin from Docker's trixie repository, the camera address on a dummy
`enp2s0`, the uid 1000 folders; a second run changed nothing. It then ran
again in a Debian 13 container booted with systemd (dummy `enp1s0`/`enp2s0`,
no network; apt stubbed, Docker a placeholder unit): nftables, dnsmasq and
chrony started, forwarding came on only with the ruleset, and `check-host.sh`
passed every check but `chrony-synced` (no internet there). A second run
changed and restarted nothing. A broken `/etc/nftables.conf` made the next
`systemctl restart nftables` fail and left forwarding at 0. With the default
route, or the SSH client's route, on `enp2s0` the run was refused. Against
real nft, `check-host.sh` failed on an added `DOCKER` chain and without root.

**Result:** _(on the device)_

## 4. The PoE switch (GPS-208) on 192.168.60.2

How a GPS-208 gets its address isn't recorded (spec §8.4). Connect it to the
camera port's side, then on the PC:

```sh
sudo journalctl -u dnsmasq -n 50 | grep DHCP
```

- **A `DHCPACK(enp2s0) 192.168.60.x <mac>` line:** it uses DHCP. Put its MAC
  into the `gps208` lease of `host.json`, render, run `prepare-host.sh`,
  power-cycle the switch; it then gets `192.168.60.2`.
- **Nothing:** it has a static factory default. Set `192.168.60.2/24` with
  gateway `192.168.60.1` in its web UI, from a laptop on the camera switch
  (or from the PC before the firewall is closed).

Then from the PC: `curl -s -o /dev/null -w '%{http_code}\n' http://192.168.60.2/`
answers `200`. From the LAN, its web UI is `http://192.168.60.2/` over the
route, like the cameras' pages.

- Its password goes into `config/.env` as `CAMPROXY_POE_SWITCH_PASSWORD`
  (§8); `config.json`'s `poeSwitch` (`sscpoe-web`, `192.168.60.2`, 8 ports)
  and each camera's `poeSwitch.port` come from `host.json`.
- **Log out of its web UI after use.** The switch allows one session at a
  time: a browser left logged in blocks the proxy's power-cycle
  (`409 switch_busy`), and for about 3 minutes after the tab is closed.
- It can't reach the internet (no cloud API), like the cameras.

**Result:** _(on the device: DHCP or static, its MAC)_

## 5. The router route

The home router, an ASUS **RT-AX86U** on stock firmware
**3.0.0.4.388_24436**, sends the camera subnet to the PC (spec §14.3):

1. Advanced Settings → **LAN** → tab **Route**.
2. **Enable static routes: Yes.**
3. Add one row:
   - **Network/Host IP:** `192.168.60.0`
   - **Netmask:** `255.255.255.0`
   - **Gateway:** `<host-lan>`
   - **Metric:** empty or `1`
   - **Interface:** `LAN`
4. **+**, then **Apply**.

**Double-check the Network field.** A typo that makes it a /24 over the LAN
itself (the first try on 2026-10-05 had `192.168.1.60`) sends the LAN's own
traffic to the gateway.

A LAN client without its own route sends camera traffic to the router, which
hairpins it back out to the PC; the camera's reply goes from the PC straight
to the client. The router may send ICMP redirects ("+N errors" in ping):
harmless, the client then goes to the PC directly.

**Pre-arrival test (Klaus, 2026-10-05, about 12:40):** with the Mac standing
in for the PC (`192.168.60.1` as an alias on its Wi-Fi interface `en0`, a
test server on port 8060, the route's gateway the Mac's LAN address), the Pi
reached it over the route: ping with 0 % loss, `curl http://192.168.60.1:8060/`
answered 200 in 14 ms. With the alias on `lo0` the requests arrived but macOS
sent no replies: a stand-in artifact, not the router. **The hairpin route
works on this router; the NAT fallback is not needed.** Still to run: the
same from a cluster node (§6).

**Result:** _(on the device: the route with the PC's address; whether it
survives a router reboot)_

## 6. Test the route on the device

Run this before anything else depends on the route. A camera at
`192.168.60.13` (cam3) is the example.

1. **From a LAN client** (the Mac), with no route of its own:

   ```sh
   ping -c 3 192.168.60.13
   curl -vk --connect-timeout 5 https://192.168.60.13/ -o /dev/null
   traceroute -n 192.168.60.13
   ```

   Expect 0 % loss, a TLS handshake and an HTTP answer, and the router, the
   PC, the camera in the traceroute (the router hop may be missing after an
   ICMP redirect).
2. **From a cluster node and from a pod in the cams namespace** (the
   kube-setup session runs these; `deploy/cluster/REQUEST.md`): the same three
   commands on a node, then the `curl` from a cams pod. k3s pods leave the
   cluster with the node's address, so the node test covers cams' path; the
   pod test needs the egress rule of the request first.
3. **The reply path on the PC**, during a `curl` from the Mac:

   ```sh
   sudo tcpdump -ni enp1s0 -c 10 host 192.168.60.13
   sudo tcpdump -ni enp2s0 -c 10 host <mac-lan-address>
   sudo conntrack -L -d 192.168.60.13 | head      # apt install conntrack
   ```

   Expect the SYN in on `enp1s0` and out on `enp2s0`, the SYN-ACK in on
   `enp2s0` and out on `enp1s0` straight to the client's MAC (not the
   router's), and the flow `ASSURED`.

**If replies are dropped,** look in this order:

1. The PC's firewall and forwarding: `sudo nft list ruleset` (the `forward`
   chain; `ct state established,related accept` must match the replies),
   `sudo nft list counter inet filter cameras_dropped`, `sysctl
   net.ipv4.ip_forward`.
2. `rp_filter`: `sysctl net.ipv4.conf.all.rp_filter net.ipv4.conf.enp1s0.rp_filter`.
   Strict mode (1) drops a client's packets that look like they belong on
   another interface; the rendered sysctl sets 2 (loose) on `enp1s0`, and
   the effective value is the larger of `all` and the interface's.
3. ICMP redirects: harmless if the client follows them. If the client
   ignores them while the router stops forwarding, the router would need
   `send_redirects` off (the stock UI probably doesn't offer it).
4. The router's LAN-to-LAN forwarding: if `tcpdump` on the PC shows no SYN at
   all, the router doesn't forward. Check that the route is in the router's
   routing table (Network Tools), and try with NAT acceleration off (LAN →
   Switch Control).
5. A client with a stateful firewall that drops the SYN-ACK because it comes
   from the PC's MAC (rare on the LAN).

Keep the route if steps 1 and 2 pass and it survives a router reboot;
otherwise use the fallbacks of §7 in order.

**Result:** _(on the device)_

## 7. If the route fails: the fallbacks, ranked

Not needed after the 2026-10-05 test; kept in case the device test differs.

1. **1:1 NAT on the host.** The PC takes one extra LAN address per camera
   (outside the router's DHCP pool) and DNATs/SNATs it to the camera. No
   client or router change; works for phones and the cluster. Costs: free LAN
   addresses to pick, the camera sees the PC as its client, the cameras'
   certificates get the LAN alias as a name, and RTSP/ONVIF answers that
   embed the camera's own address point at the camera network (cams doesn't
   use them).
2. **Static routes on the clients:** the cluster nodes (a kube-setup change in
   the nodes' network config) and the Mac. Symmetric and clean, but phones
   and other devices can't reach the cameras' web pages (only the proxy and
   cams).
3. **Port-forwards on the PC's one LAN address** (e.g. 8443+n → camera n
   :443): the simplest, but non-standard ports for every camera, a list to
   maintain, and only the forwarded ports work.

## 8. cam-proxy on the host

`/srv/cam-proxy` has the Pi's layout:

| Path | What |
|---|---|
| `compose.yaml` | rendered: the `:latest` image, host networking, `./data` as `/data`, `./config` as `/config`, every variable of `config/.env` |
| `config/.env` | the secrets (owner uid 1000, mode 600, in `config/` with mode 700) |
| `data/config.json` | rendered once (§3), then yours; the Settings page's changes go to `data/overrides.json` |
| `host.json` | the host description (§2) |

`config/.env`, without values:

```sh
CAMPROXY_TOKENS=
CAMPROXY_ADMIN_TOKEN=
# every camera's proxy-user password, or one per camera:
CAMPROXY_CAMERA_PASSWORD=
# CAMPROXY_CAMERA_PASSWORD_CAM3=
CAMPROXY_FTP_PASSWORD=
CAMPROXY_POE_SWITCH_PASSWORD=
# optional
CAMPROXY_GOOGLE_VISION_KEY=
CAMPROXY_AUDIT_TOKEN=
```

Copy the secrets without printing them (as for the Pi, docs/raspberry-pi.md
§3): pipe just those lines of a local file over SSH with `umask 077`.

- `CAMPROXY_TOKENS`, `CAMPROXY_ADMIN_TOKEN`: the same tokens as the Pi's
  (decision 6: one user with all rights).
- `CAMPROXY_CAMERA_PASSWORD`: the cameras' `proxy` user; a camera with its
  own password gets `CAMPROXY_CAMERA_PASSWORD_<ID>` (`CAM3` for `cam3`).
- `CAMPROXY_FTP_PASSWORD`: one password; each camera logs in as its own FTP
  user (its id), and only from its own address.
- There is no `CAMERA_HOST` or `PI_ADDRESS` here: the cameras' addresses and
  `ftp.publicHost` (`192.168.60.1`) are in `config.json`.

Start it:

```sh
cd /srv/cam-proxy && docker compose pull && docker compose up -d
curl -s http://127.0.0.1:8480/health      # {"ok":true,"version":"…"}
```

Per camera, once it has its lease:

1. In the camera's web UI (`https://192.168.60.13/` from the LAN, over the
   route), create the user `proxy` (administrator) with the password from
   `config/.env`. Log out afterwards.
2. In the admin UI, pick the camera and use "Point the camera's FTP here" on
   the Maintenance page.

The proxy's 8480 is reachable from loopback only, and from the LAN while
`httpFromLan` is `true` (P4 to P5). HTTPS on 8443 comes with the site CA
(§13). Two proxies on one data volume are not supported (§10).

**Result:** _(on the device)_

## 9. Checklist

The network checks of spec §15, run on the device. Each with its command and
the expected answer:

| Check | Command | Expected |
|---|---|---|
| The Mac reaches a camera's HTTPS | `curl -vk --connect-timeout 5 https://192.168.60.13/ -o /dev/null` (Mac) | a TLS handshake and an HTTP status |
| A cluster pod reaches a camera's HTTPS | the same `curl` from a cams pod (kube-setup session) | the same |
| The camera side has no internet | on a laptop on the camera switch (DHCP from the PC): `curl -m 5 http://example.com`, `nslookup example.com` | both fail |
| … and the drops are counted | `sudo nft list counter inet filter cameras_dropped` (PC) | the packet count grows |
| NTP from the host works | on the laptop: `sntp 192.168.60.1`; on the PC: `chronyc clients` | an answer; the cameras listed once they synced |
| FTP from a camera arrives | Maintenance → "Test the camera's FTP", then a motion event | the test passes; a clip under the camera's id |
| The route survives a router reboot | reboot the router, repeat the first line | the same answer |
| The PC's own checks | `sudo bash check-host.sh` | every line `PASS` |

**Result:** _(on the device)_

## 10. Operations

- **Updates:** `cd /srv/cam-proxy && docker compose pull && docker compose up -d`,
  together with the Pi after each release. Debian's security updates install
  themselves (unattended-upgrades); after a Docker package upgrade, run
  `sudo bash check-host.sh` (`docker-iptables`).
- **Backups:** `/srv/cam-proxy/data` (catalog, clips, archive, overrides),
  `config/.env`, `host.json`; with P5 also `data/tls` (the site CA).
- **Two proxies on one data volume are not supported.** The storage budget
  counts the whole volume, and two catalogs would evict each other's files.
  One proxy per host and data folder.
- **What blocking the cameras' internet means:** the Reolink app's cloud/P2P
  remote view and push notifications stop for these cameras, firmware update
  checks stop, and LAN discovery in the app doesn't cross the route (add a
  camera by IP: `192.168.60.x`, port 9000).
- **Adding a camera:** a lease in `host.json` (its MAC, an address in
  `.11`–`.29`, its id and switch port), render on the Mac,
  `scripts/host/validate-rendered.sh`, copy, `sudo bash prepare-host.sh
  --rendered /tmp/rendered` (dnsmasq restarts with the new lease; the existing
  `config.json` is kept), then add the camera in the Settings page or in
  `config.json`, and its `proxy` user and FTP (§8).
- **NTP:** the cameras get the PC as their NTP server by DHCP (option 42). A
  firmware that ignores it gets it by a whole-object `SetNtp` (P5; §12).

## 11. Sizing (measured)

The estimates of spec §9 for 4 cameras on a Zen+ core at about 3 GHz, with
the measured column filled on the device: first with 4 cam-sims on the PC
(stills on for all four, 30 minutes; `top`, `free -m`, `docker stats`), then
two compositions at once while they stream, then with the real cameras over a
day (the Status page's host figures, `host.stats: on`).

| Load | Estimate | Measured |
|---|---|---|
| go2rtc restream of a sub stream (no decode), per camera | < 1 % of a core | |
| FrameGrabber: decode 896×512 @ 10 fps + 1 still + 1 tile JPEG/s, per camera | 3–6 % of a core | |
| 4 cameras steady, in total | about a quarter of one core | |
| A composition's encode | several times real time on 1–2 threads; 2 at once leave ≥ 4 threads | |
| Memory | Node 300–500 MB, go2rtc ~50 MB, 4 grabbers ~40 MB each, 2 compositions ~200 MB each: well under 2 GB | |
| Disk per camera and day | 3–7 GB (stills ~2.1 GB, previews ~0.3 GB, sub clips 1–5 GB) | |
| Network, camera side | 4 × (1 Mbit/s + FTP bursts), + 8 Mbit/s per 4K viewer | |

**Result:** _(on the device)_

## 12. Camera measurements

Measured on a camera of this host, **never on cam1** (spec §15), with
`scripts/measure-camera.ts`. It refuses an address outside `192.168.60.0/24`,
reads `GetDevInfo`, `GetNtp`, `GetCertificateInfo` and the certificate the
camera serves, logs out, and prints JSON without the password. Run it from
the Mac over the route, with the password in a mode-600 file (never on the
command line):

```sh
CAMPROXY_CAMERA_PASSWORD_FILE=<file> npx tsx scripts/measure-camera.ts --host 192.168.60.13
CAMPROXY_CAMERA_PASSWORD_FILE=<file> npx tsx scripts/measure-camera.ts --host 192.168.60.13 --set-ntp 192.168.60.1
```

`--set-ntp` writes the whole `Ntp` object with only `enable` and `server`
changed, and reads it back.

- **`GetNtp` (the whole object):** _(on the device)_
- **`SetNtp` to `192.168.60.1` (before and after):** _(on the device)_
- **Importing a leaf of a name-constrained CA** (an RSA 2048 leaf of a
  throwaway test CA, pushed with the reolink workspace's `push_cert.py`;
  plan Task 10 step 8): _(on the device: accepted or refused, the served
  subject)_

Record them also in the Obsidian note *Cameras/Reolink API Behaviour* and as
a cam-sim issue (cam-sim mirrors the real camera: measure first).

## 13. TLS: the site CA

The host has its own certificate authority, inside cam-proxy (spec
2026-10-05-multi-camera-host-design §10). Nothing of it comes from the
cluster; the Pi doesn't have one (it keeps Let's Encrypt, `cam1-cert-push`).

**Turning it on.** The rendered `data/config.json` already has it:

```json
"server": { "tls": { "port": 8443 } },
"tls": { "site": "camhost1", "cameraSubnet": "192.168.60.0/24", "proxyAddresses": "<lan.address>,192.168.60.1" },
"ntp": { "server": "192.168.60.1" }
```

A host rendered before P5 adds these three by hand (or in the Settings
page); they need a restart of the process. On its first start the proxy
creates `data/tls/ca.pem` and `data/tls/ca.key` (mode 600): RSA 3072, ten
years, `CN=cam-proxy site CA camhost1`, with critical name constraints, so it
can only vouch for `camhost1.internal` and the names under it, the camera
subnet and the proxy's own two addresses. Then:

- **The proxy's certificate** (`proxy.camhost1.internal`, the LAN and
  camera-side addresses) serves HTTPS on 8443; renewed by itself.
- **Each camera's certificate** (`cam3.camhost1.internal`, its address; RSA
  2048, 397 days) is pushed to the camera within ten minutes of the start or
  of adding the camera, one camera at a time, never during an open event;
  renewed 30 days before expiry at 04:00 camera time. The camera's web server
  restarts for a few seconds during a push.
- **A camera that refuses the import** (the firmware answers 200 and keeps
  its certificate) shows `pinned` on the Certificates card with its own
  (factory) fingerprint; the proxy pins that certificate itself and cams pins
  the same. The next try is at the next 04:00, or "Push now".
- **A camera that served its leaf and then serves something else** (a factory
  reset, a replaced camera, or someone else on the camera network) is not
  pushed to by itself: the proxy refuses to talk to it, the card and the
  `certificates` health item say "serves an unexpected certificate". Check the
  camera (is it the one you expect, at its address?), then "Push now". A
  push binds its session to the certificate it read just before; the first
  push to a camera trusts what it serves at that moment (trust on first use),
  so add cameras while the camera network is yours alone.
- **FTPS** uses the proxy's certificate as read when the FTP server starts;
  after a rotation it picks up the new one at the next restart.
- **NTP:** the proxy sets each camera's NTP server to `192.168.60.1`
  (`GetNtp`, a whole-object `SetNtp`, read back) when it comes online, at most
  once an hour; the audit log has a `camera-ntp` record when it changed.

**Checking.** The CA and its constraints:

```sh
curl -s http://127.0.0.1:8480/tls/ca.pem | openssl x509 -noout -subject -ext nameConstraints
```

Each camera, verified against the CA by its name:

```sh
openssl s_client -connect 192.168.60.13:443 -servername cam3.camhost1.internal \
  -CAfile <(curl -s http://127.0.0.1:8480/tls/ca.pem) </dev/null 2>/dev/null | grep 'Verify return code'
# Verify return code: 0 (ok)
```

The proxy over HTTPS from the Mac:

```sh
curl -s http://<lan.address>:8480/tls/ca.pem > ca.pem   # or the card's "Download the CA"
curl --cacert ca.pem --resolve proxy.camhost1.internal:8443:<lan.address> https://proxy.camhost1.internal:8443/health
```

**Klaus's devices.** Installing the CA lets the browser open
`https://192.168.60.13/` (over the route) and the proxy's page without a
warning. The name constraints make that safe: the CA can't vouch for any
other site, even if its key leaked. macOS: open `ca.pem`, Keychain Access →
the certificate → Trust → "Always Trust". iOS: AirDrop or mail the file,
install the profile, then Settings → General → About → Certificate Trust
Settings → turn it on. Firefox has its own store (Settings → Certificates →
Import, "trust this CA to identify websites").

**cams.** The Certificates card shows the CA fingerprint (`SHA256:` and 64
upper-case hex digits; Copy fingerprint copies it plain). It goes into cams'
generator input as this proxy's `caFingerprint` (the cams P5 plan); cams then
reaches the proxy at `https://<lan.address>:8443` with servername
`proxy.camhost1.internal` and each camera with `<camId>.camhost1.internal`.

**Rotating the CA** (`POST /control/actions/tls-ca-rotate` with
`{"confirm":"rotate"}`, admin): a new CA, the old files kept as
`*.old-<time>` in `data/tls`, a new proxy certificate, and every camera
pushed again (a camera stays trusted through the previous CA until then, at
most 30 days; `tls-ca-drop-previous` ends that at once).

**Clearing a camera's trust** (`POST /control/cameras/<cam>/actions/camera-trust-clear`
with `{"confirm":"clear"}`, admin, audited): needed when a camera is replaced
on purpose and it should be treated as new; then "Push now" pushes its first
certificate (it trusts what the camera serves at that moment). Losing
`data/tls/cameras` entirely makes every camera new again: restore it from the
backup. Without it the
proxy keeps refusing a camera that serves an unexpected certificate, also
when `tls.site` is removed or the CA can't be loaded. Every cams pin of this proxy breaks: give cams the new
fingerprint (it accepts a list, so add the new one first). Needed after an
address change the CA doesn't cover (the Certificates card and the
`certificates` health item name the address).

**Backups.** `data/tls/` is part of the data backup. A restore without
`ca.key` is refused (the proxy keeps serving HTTP, the health item says
`ca.key is missing`): restore the key, or rotate.

**Result:** _(on the device: plan Task 14)_

