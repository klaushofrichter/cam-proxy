# cam-proxy on a Raspberry Pi

This guide sets up cam-proxy on a Raspberry Pi next to a real camera, and moves
an existing proxy's data to it. It was written from the first install on
2026-09-29: a Pi 4 serving the RLC-1224A "Den" (cam1), replacing a proxy that
ran on a Mac. Addresses are placeholders:

| Placeholder | Meaning |
|---|---|
| `<pi>` | the Pi's LAN address |
| `<camera>` | the camera's LAN address |
| `<user>` | the Pi's login user (uid 1000, the same uid the container runs as) |

## What you need

- **A Raspberry Pi 4B with 4 GB** and a 64-bit Raspberry Pi OS. The first
  install used Debian 13 (trixie), written with Raspberry Pi Imager, with SSH
  and the user set in the Imager.
- **An SSD on a USB 3 (blue) port.** The first install used a Samsung 850 EVO
  on an ASMedia USB-SATA bridge (174c:55aa), which runs in UAS mode without
  errors.
  - **Boot from the SSD**, with no SD card: the Imager can write straight to
    the SSD.
  - If the disk drops under load, turn UAS off for that adapter:
    `usb-storage.quirks=<vid>:<pid>:u` in `/boot/firmware/cmdline.txt`, with
    `vid:pid` from `lsusb`.
- **Wired Ethernet**, on the camera's LAN. Wi-Fi works as a fallback, but the
  camera streams to the proxy all the time and uploads every clip.
- **A stable address.** The camera's FTP uploads and cams both use it. A DHCP
  reservation for the Ethernet port's MAC works, or a router that gives the same
  MAC the same address after a restart (the home router does; the Pi has no
  reservation).

The desktop can stay on. The proxy uses about 5% of the CPU, and 3.2 GiB of
memory stay free.

## 1. Access

From the machine you work on, add your SSH key to the Pi, so nothing needs
the password:

```sh
# on the Pi, as <user>:
mkdir -p ~/.ssh && chmod 700 ~/.ssh
echo '<your public key>' >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys
```

Check the basics:

```sh
ssh <user>@<pi> 'uname -m; . /etc/os-release; echo $PRETTY_NAME; findmnt -n -o SOURCE /; timedatectl | grep -E "zone|synchronized"'
```

You should see `aarch64`, the root filesystem on `/dev/sda2` (the SSD), the
camera's time zone, and `System clock synchronized: yes`.

## 2. Prepare the Pi (Docker)

[`scripts/prepare-pi.sh`](../scripts/prepare-pi.sh) does the root steps in one
run:
- `apt full-upgrade`;
- Docker Engine and the Compose plugin, from Docker's Debian repository;
- `<user>` in the `docker` group;
- container logs capped at 10 MB × 3;
- the memory cgroup (`cgroup_enable=memory` in `/boot/firmware/cmdline.txt`):
  Raspberry Pi kernels ship without it, so without it `docker stats` shows no
  memory and memory limits don't work;
- `/srv/cam-proxy`, `/srv/cam-proxy/data` and `/srv/cam-proxy/config`
  (mode 700: the one settings file), owned by `<user>`;
- then a reboot.

```sh
scp scripts/prepare-pi.sh <user>@<pi>:
ssh -t <user>@<pi> 'sudo bash ~/prepare-pi.sh'
```

After the reboot, check that `docker compose version` works without `sudo`.

## 3. Install the proxy

The Pi uses the repository's [`compose.yaml`](../compose.yaml): host
networking (the camera connects to the FTP server on 2121 and the passive
ports, and Find camera's ONVIF probe reaches the LAN), the `:latest` image,
`./data` as `/data`, every variable of `config/.env` (`env_file: config/.env`),
and `./config` as `/config` with `CAMPROXY_ENV_FILE=/config/.env`, so
Settings → Find camera can write the camera's address into it. It mounts the
`config` folder, not the file: a rename can't replace a file mounted on its
own, and the backups (the last 5) go next to it.

compose.yaml has no `${…}` substitutions at all, and the settings file is not
`/srv/cam-proxy/.env` (which compose would read for substitutions): the
container can write `config/.env`, so nothing in it may change how compose
starts the container (its image, volumes or user). Don't add a `.env` next to
compose.yaml, and don't link one to `config/.env`.

```sh
scp compose.yaml <user>@<pi>:/srv/cam-proxy/compose.yaml
```

**`/srv/cam-proxy/data/config.json`**: everything but the two addresses,
which come from `.env`. Everything else can stay at its default.

```json
{
  "camera": { "id": "cam1", "name": "Den", "protocol": "https",
              "tlsName": "cam1.skylar.technology", "user": "proxy" },
  "server": { "dataDir": "/data" },
  "stills": { "enabled": true, "stream": "sub" },
  "storage": { "maxBytes": 161061273600, "minFreeBytes": 21474836480 },
  "ftp": { "enabled": true, "port": 2121, "passive": "30000-30009",
           "tls": true, "stream": "sub" }
}
```

- There's no `go2rtc.binary`: the image has go2rtc on its `PATH`.
- `storage.maxBytes`: the first install uses 150 GiB of the 229 GB disk, and
  keeps 20 GiB free.
- `camera.host`, `ftp.publicHost` and `server.publicUrl` may stay in
  config.json, but `CAMERA_HOST` and `PI_ADDRESS` win over them (and over the
  Settings page's overrides).

**`/srv/cam-proxy/config/.env`** (owner uid 1000, the container's user, mode
600, in `config/` with mode 700): the one file for the Pi, the secrets and
the two addresses (and, when cams runs on the Pi too, cams' variables:
cams' docs/pi-demo.md). Without values:

```sh
# The camera and this Pi (addresses; no port for PI_ADDRESS).
CAMERA_HOST=<camera>
PI_ADDRESS=<pi>
# cam-proxy's secrets
CAMPROXY_TOKENS=
CAMPROXY_ADMIN_TOKEN=
CAMPROXY_CAMERA_PASSWORD=
CAMPROXY_FTP_PASSWORD=
# optional
CAMPROXY_GOOGLE_VISION_KEY=
CAMPROXY_AUDIT_TOKEN=
CAMPROXY_POE_SWITCH_PASSWORD=
# cams on the Pi (cams docs/pi-demo.md)
CAMS_LOGIN_TOKEN=
COOKIE_SECRET=
```

- `CAMERA_HOST`: the camera's LAN address (optional `:port`), for its HTTP
  API, ONVIF, RTSP and Baichuan; it sets `camera.host`. Settings → Find
  camera → "Use this address" rewrites this line.
- `PI_ADDRESS`: the Pi's LAN address. It sets `ftp.publicHost` (the address
  the camera is told to connect to for passive data) and `server.publicUrl`
  (`http://<PI_ADDRESS>:8480`, what cams links to).
- The startup log line `config_env` shows what they set:
  `docker logs cam-proxy-cam-proxy-1 2>&1 | grep config_env`.
- `CAMPROXY_TOKENS` and `CAMPROXY_ADMIN_TOKEN`: when this Pi replaces another
  proxy, use the same tokens, and cams keeps working without new tokens.
- `CAMPROXY_CAMERA_PASSWORD`: the camera's `proxy` user.
- `CAMPROXY_FTP_PASSWORD`: what the camera logs in with.
- `CAMPROXY_GOOGLE_VISION_KEY` (optional): the Google Vision key for
  analytics (README, Analytics). Without it analytics stays off. After adding
  it, recreate the container (`docker compose up -d --force-recreate`), then
  switch analytics on with a small monthly limit on the Settings page. cam1's
  Pi has it since 2026-09-30.
- `CAMPROXY_AUDIT_TOKEN` (optional): a read-only token for `GET
  /control/audit` (docs/audit-log.md). Leave it unset until a poller exists;
  the admin token reads the audit log too.
- `CAMPROXY_POE_SWITCH_PASSWORD` (optional): the PoE switch's web password,
  for "Power-cycle camera" ([poe-switch.md](poe-switch.md)). Set it together
  with `camera.poeSwitch` in `config.json` (cam1: `sscpoe-web`,
  `192.168.1.217`, port 8), then recreate the container. Without it the
  power-cycle answers 409 `not_configured`.

Copy the secrets without printing them. For example, pipe just those lines of
a local `.env` over SSH (then add `CAMERA_HOST` and `PI_ADDRESS` on the Pi):

```sh
grep -E '^CAMPROXY_(TOKENS|ADMIN_TOKEN|CAMERA_PASSWORD|FTP_PASSWORD|GOOGLE_VISION_KEY|AUDIT_TOKEN|POE_SWITCH_PASSWORD)=' .env \
  | ssh <user>@<pi> 'umask 077; cat > /srv/cam-proxy/config/.env'
```

Start it:

```sh
ssh <user>@<pi> 'cd /srv/cam-proxy && docker compose pull && docker compose up -d'
curl -s http://<pi>:8480/health     # {"ok":true,"version":"…"}
```

`GET /control/status` (admin token) should then show:
- the camera `online`;
- `intake.onvif` `subscribed`;
- `stream.up`;
- `ftp.listening`.

## 4. Moving data from another proxy (optional)

This keeps the history: stills, previews, clips and the catalog.

1. **Copy the bulk while the old proxy still runs** (on the first install:
   3.8 GB in 84 s):
   ```sh
   rsync -a --exclude 'catalog.sqlite*' <old dataDir>/ <user>@<pi>:/srv/cam-proxy/data/
   ```
2. **Stop the old proxy with SIGTERM.** It flushes the stills and checkpoints
   the catalog, so only `catalog.sqlite` is left.
3. **Copy again**, catalog included. `--exclude config.json` keeps the Pi's
   config from being deleted:
   ```sh
   rsync -a --delete --exclude config.json <old dataDir>/ <user>@<pi>:/srv/cam-proxy/data/
   ```
4. **Rewrite the clip paths.** The catalog stores absolute paths in
   `clips.path` and `clips.snapshot`. No other column holds paths.
   ```sh
   ssh <user>@<pi> 'cd /srv/cam-proxy/data && python3 -' <<'EOF'
   import sqlite3
   db = sqlite3.connect("catalog.sqlite")
   old = "<old dataDir>/"          # e.g. /Volumes/SSD-WDBlack-1T/Media/cam/
   n = db.execute("update clips set path = replace(path, ?, '/data/'), snapshot = replace(snapshot, ?, '/data/')", (old, old)).rowcount
   db.commit()
   print(n, "rows;", db.execute("select count(*) from clips where path like ?", (old + "%",)).fetchone()[0], "left;",
         db.execute("pragma integrity_check").fetchone()[0])
   EOF
   ```
5. **Start the Pi** (`docker compose up -d`), and download an old clip to check.

## 5. Point the camera and cams at the Pi

- **Camera FTP:** the Maintenance page's "Point the camera's FTP here" sets the
  camera's FTP server to `PI_ADDRESS` (a whole-object `GetFtpV20` →
  `SetFtpV20`, re-read, logout), and "Test the camera's FTP" runs the
  camera's `TestFtp`; the proxy's `ftp.lastUpload` then shows the test.
- **cams:** the camera's `proxy.url` in the `cams-cameras` Secret becomes
  `http://<pi>:8480`. The tokens stay the same when they were kept.
  - cams reads the Secret when it starts, so replace its pod.
  - cams has no egress NetworkPolicy, so the cluster needs no change to reach
    the Pi.
- **Check that it worked:**
  - cams' Timeline and live events for the camera work;
  - `camproxy_sse_clients` on `http://<pi>:8480/metrics` is 1 (cams' relay);
  - the next recording shows `clip_indexed` in `docker logs`.

## Moving to the config/ layout (an install from before 2026-10-04)

The settings file moves from `/srv/cam-proxy/.env` to
`/srv/cam-proxy/config/.env`; compose.yaml no longer substitutes anything.

```sh
cd /srv/cam-proxy
# 1. Back up the old file and the config (mode 600, never printed).
umask 077
cp -p .env .env.pre-config-$(date +%Y%m%d)
cp -p data/config.json data/config.json.pre-config-$(date +%Y%m%d)
# 2. The folder and the file: owner uid 1000 (the container's user).
install -d -m 0700 config
mv .env config/.env && chmod 600 config/.env
ls -ln config/.env            # owner 1000, -rw-------
# 3. The two addresses (if not there yet), then the new compose.yaml.
grep -q '^CAMERA_HOST=' config/.env || echo 'CAMERA_HOST=<camera>' >> config/.env
grep -q '^PI_ADDRESS=' config/.env || echo 'PI_ADDRESS=<pi>' >> config/.env
#    (copy the repository's compose.yaml to /srv/cam-proxy/compose.yaml)
docker compose pull && docker compose up -d
docker compose logs --since 2m | grep config_env
```

- If `<user>` is not uid 1000: `sudo chown -R 1000:1000 config`.
- `CAMPROXY_DATA` is gone: the data folder is always `./data`.
- `camera.host`, `ftp.publicHost` and `server.publicUrl` may stay in
  `data/config.json`; the two variables win over them.
- Keep the backups until the proxy runs; they hold the secrets (mode 600).
- When cams runs on the Pi too, its `cams/.env` becomes a link to
  `../config/.env` (cams' docs/pi-demo.md).

## On the road (another LAN)

Only `/srv/cam-proxy/config/.env` changes; cams follows cam-proxy (it takes the
camera's address from it).

1. **The Pi's new address** (whatever the new LAN gives it): set
   `PI_ADDRESS=<new pi>` in `config/.env`, then restart (`docker compose restart`, or
   "Restart proxy" on the Maintenance page at the new address: cam-proxy reads
   the file at start). Then "Point the camera's FTP here", or the camera keeps
   uploading to the old address.
2. **The camera's new address:** Settings → **Find camera** lists the ONVIF
   devices on the LAN (address, name, model; the current camera is marked).
   **Use this address** writes `CAMERA_HOST=<address>` into `config/.env` (a
   backup `.env.bak-<time>` next to it; the last 5 are kept) and restarts the
   proxy; sign in again. A device whose answer came from another address than
   it names is flagged "address mismatch", and the address it answered from
   is the one written.
   Without `CAMPROXY_ENV_FILE` the page shows the line to add by hand.
3. **"Point the camera's FTP here"** on the Maintenance page, once the camera
   answers at its new address.

Nothing else: cams reads the camera's address from cam-proxy, and the camera's
certificate still checks offline as long as it hasn't expired.

## Operating it

| Task | Command (in `/srv/cam-proxy`) |
|---|---|
| Update to the newest release | `docker compose pull && docker compose up -d` |
| Logs | `docker logs --since 10m cam-proxy-cam-proxy-1` |
| Restart | `docker compose restart` |
| Status | `curl -s http://<pi>:8480/health`, then `/control/status` with the admin token |
| Load | `docker stats --no-stream`, `vcgencmd measure_temp`, `vcgencmd get_throttled` (0x0 = fine) |
| Health | the Status page's Health and Pi cards, or on the Pi itself `curl -s http://127.0.0.1:8480/api/local/health` (no key; answered to loopback only) |

- **Restarts:** the container restarts by itself (`restart: unless-stopped`)
  and comes back after a reboot, because Docker starts at boot. Tested on
  2026-09-29: after `reboot`, the proxy was healthy within 5 s of the Pi coming
  back, with the camera up and ONVIF subscribed, and cams reconnected on its own.
  Nothing else needs to autostart.
- **Restart from the UI or the API:** the Maintenance page's "Restart proxy"
  (`POST /control/actions/restart-proxy`) stops the proxy gracefully, as
  `docker compose stop` would, and exits with code 0; `restart:
  unless-stopped` starts the container again. If the stop hangs for 15 s the
  proxy exits anyway. Admin sessions end with the process, so the page asks
  you to sign in again. "Reboot camera" reboots the camera instead; the
  container keeps running.
- **Stopping:** `compose.yaml` gives the container 20 s to stop
  (`stop_grace_period`), not Docker's default 10 s. That is time to end a
  running encode and to store a Vision call that is still in flight (up to
  its 10 s timeout).
- **Updates:** nothing updates the Pi on its own. A release to `production`
  updates only the cluster, so pull on the Pi after a release.
- **The Pi card:** on a Pi the Status page shows a Pi card (model, CPU
  temperature, under-voltage, memory, uptime, load, disk), and the Health card
  flags the disk from `health.diskPercent` (90 %) and the CPU temperature from
  `health.tempC` (75 °C). The proxy reads them inside the container: the model
  from `/proc/cpuinfo`, the temperature and the under-voltage alarm from the
  hwmon sensors `cpu_thermal` and `rpi_volt` in `/sys/class/hwmon`, memory,
  uptime and load from `/proc`. These describe the Pi only because the
  container runs with `network_mode: host` (and shares the host's `/proc`
  figures for memory and load); `host.stats` (`auto`, `on`, `off`) switches
  them. `GET /api/local/health` serves the same summary to a process on the Pi
  (the e-paper display), without a key, from `127.0.0.1` only. That trust
  assumes nothing on the Pi (or in a pod) forwards outside traffic from
  `127.0.0.1`: no local reverse proxy, tunnel or sidecar in front of the
  proxy, or it would hand its callers the local API.
- **Memory:** with the memory cgroup on (see step 2), `docker stats` shows
  the proxy at about 350–390 MiB of the 3.7 GiB. On a Pi prepared before the
  script did this, `docker stats` shows `0B`: add `cgroup_enable=memory` to the
  single line of `/boot/firmware/cmdline.txt` and reboot.
