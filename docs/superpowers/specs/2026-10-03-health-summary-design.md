# Health summary: Pi figures, thresholds, Status page cards, local API (design)

Status: approved by Klaus, 2026-10-03. This is part A of the e-paper display
design (`~/Development/reolink/epaper-display-design.md`, outside this repo),
copied here as this repository's spec. Part B, the Python display service
(`cam-proxy-pi-display`, a separate public repo), is built from the local API
below and is not part of cam-proxy; see the reolink design for it.

The exact JSON of `GET /api/local/health` is fixed in the plan,
`docs/superpowers/plans/2026-10-03-health-summary.md` ("The API schema").

## Goal

A small always-on display on the cam-proxy Pi answers "is everything fine?" at
a glance. Everything it shows is also on the admin UI's Status page, and both
use the same thresholds (one summary function), so the display and the GUI
never disagree. cam-proxy computes the figures and the problem flags, shows
them on the Status page, and serves them on a local read-only API. It does not
depend on the display.

## Decisions (Klaus, 2026-10-03)

- Keys: on the left side of the landscape display; the **bottom key is Update**, the other three are pages.
- New repo, **public**, `cam-proxy-pi-display`.
- Everything on the display is also on the proxy's Status page; a triggered threshold shows **red** there.
- Problem-triggered redraws: yes, rate-limited.
- Thresholds: disk 90 %, temperature 75 °C, FTP stall as cam-proxy defines it (6 h).
- A proxy API for the script, local and read-only; no key if a key is complicated.

## Design (part A)

### A1. Host figures, platform-aware

cam-proxy also runs in the cluster (and could run on other hosts), so every host figure is optional. A figure that can't be read is `null`, is left off the GUI and the display, and is never a problem. Thresholds only apply to figures that exist.

Two kinds:

- **Everywhere: the data volume.** Disk used/free of the proxy's data dir (`statfs`): meaningful on any platform, because it is the proxy's own storage (on the Pi 11 % of 228.6 GB; in the cluster its volume). The disk threshold applies everywhere.
- **Only on a Raspberry Pi: the host.** Detected by `/proc/cpuinfo` `Model : Raspberry Pi …` (visible inside the container; `/proc/device-tree` is not). Then, all read inside the container (checked on the Pi 2026-10-03):
  - model ("Raspberry Pi 4 Model B Rev 1.5");
  - CPU temperature, hwmon `cpu_thermal` `temp1_input` (53.6 °C);
  - under-voltage, hwmon `rpi_volt` `in0_lcrit_alarm` (0 = fine);
  - memory `/proc/meminfo`, uptime `/proc/uptime`, load `/proc/loadavg`.

  These describe the host only because the proxy runs with `network_mode: host` on the Pi. In a cluster pod, `/proc/meminfo`, uptime and load would describe the node, not the pod, which is misleading, so they are **not** shown off a Pi.
- Setting `host.stats`: `auto` (default: on when a Pi is detected), `on`, `off`.

A new module collects them every minute (cheap file reads; no shell-outs).

### A2. Health summary with thresholds

One function builds a summary from the existing status and the host figures. Each item has a value, a display text, and `problem: true/false`:

| Item | Problem when |
|---|---|
| camera | offline |
| live stream | down (while enabled) |
| events intake | not subscribed |
| camera FTP upload | camera's FTP off, or the FTP stall check says stalled (6 h) |
| storage | paused (low free space) |
| disk (data volume, every platform) | ≥ 90 % used |
| CPU temperature (Pi only) | ≥ 75 °C |
| under-voltage (Pi only) | the alarm is set |
| last inventory | its last run failed (informational otherwise) |
| version | never a problem; the installed version string, e.g. `v2026.10.03.1` |

Thresholds become settings (`health.diskPercent` default 90, `health.tempC` default 75), editable on the Settings page like the others, audited like other settings changes. The FTP stall keeps its existing setting.

### A3. Status page

- A new **"Health"** card at the top of the Status page: one line per summary item, red when `problem`, plus "All OK" / "N problems". It repeats some information from other cards on purpose: it is the at-a-glance view, the same as the display's Overview.
- The existing cards mark the same items red where they show them (camera, stream, FTP, storage), so the colour is consistent.
- The data-volume disk goes on the Storage card (everywhere) and in the Health card.
- **A "Pi" card**, only when running on a Raspberry Pi: model, CPU temperature, under-voltage, memory, uptime, load, disk; red past the thresholds. Off a Pi the card isn't shown at all (no empty card), and the Health card leaves out the Pi lines.

### A4. Local API

`GET /api/local/health` returns the summary as JSON (items, values, problem flags, thresholds, the proxy version, `generatedAt`).

- **No key, loopback only**: answered only when the socket's remote address is `127.0.0.1` or `::1`. With `network_mode: host`, the display service on the Pi connects from loopback. Everything else gets 404 (not 401, so the route isn't advertised).
- The check uses the TCP socket's address only, never `X-Forwarded-For` or `trust proxy`. Tests cover a LAN address, a spoofed forwarding header, and IPv4-mapped IPv6 (`::ffff:127.0.0.1`).
- The response carries no secrets: no tokens, no passwords, no FTP settings. Camera model and firmware are included; they are visible on the camera's own LAN UI anyway.
- Read-only, GET only, no CSRF surface; documented in the API docs as "local only".
- Fallback if loopback ever proves unreliable (a future bridge network): a read-only `health` token in the config. Not built now.

## Tests

- Unit tests for each problem rule and the thresholds; the host figures from
  fixtures (a Pi and a non-Pi `/proc` and `/sys`); the loopback guard (a LAN
  address, a spoofed forwarding header, IPv4-mapped IPv6); no secrets in the
  answer.
- The Health card, the Pi card and the red marks in e2e.

## Settled (Klaus, 2026-10-03, second round)

- The Overview on a long press of the bottom key, as above.
- A separate "Pi" card on the Status page, only when running on a Pi.
- cam-proxy runs in the cluster too: host figures are optional and Pi-only (A1); the local API works everywhere (in a pod it answers only the pod itself).
