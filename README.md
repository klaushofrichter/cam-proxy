# cam-proxy

[![Release](https://img.shields.io/github/v/release/klaushofrichter/cam-proxy?label=release&color=blue)](https://github.com/klaushofrichter/cam-proxy/releases)
[![PR checks](https://github.com/klaushofrichter/cam-proxy/actions/workflows/pr-checks.yml/badge.svg)](https://github.com/klaushofrichter/cam-proxy/actions/workflows/pr-checks.yml)
[![Build and publish image](https://github.com/klaushofrichter/cam-proxy/actions/workflows/build-push.yml/badge.svg?branch=main)](https://github.com/klaushofrichter/cam-proxy/actions/workflows/build-push.yml)
[![Release and deploy](https://github.com/klaushofrichter/cam-proxy/actions/workflows/release.yml/badge.svg?branch=production)](https://github.com/klaushofrichter/cam-proxy/actions/workflows/release.yml)
[![Dependabot](https://img.shields.io/badge/dependabot-enabled-025E8C?logo=dependabot&logoColor=white)](https://github.com/klaushofrichter/cam-proxy/security/dependabot)

<!-- The release badge is the newest tag, which the release job cuts after the
     cluster rollout. Dependabot is a static badge (it has no status endpoint);
     alerts and security updates are on in the repository settings, version
     updates come from .github/dependabot.yml. No version numbers in the text
     below: they go stale; the badge and the releases page carry them. -->

A gateway next to a Reolink camera (RLC-1224A). It becomes the camera's only
client, keeps what matters, and serves it through a clean API with a live,
resumable Server-Sent Events stream. Apps such as
[cams](https://github.com/klaushofrichter/cams) no longer depend on the
camera's quirks (one search at a time, few logins, broken downloads, no push).

**Status:** built and released (see the release badge above):
- camera status and ONVIF events, with a polling fallback;
- the event catalog and the resumable SSE stream;
- stills and preview sprites through go2rtc;
- clips by FTP(S);
- storage management;
- recordings from the camera's SD card, over Baichuan;
- inventory checks and repairs (stills, clips, events);
- optional Google Vision analytics;
- the Archive: clips kept apart from retention, with metadata and labels;
- the health summary (Status page, `GET /api/local/health`);
- the client and control APIs and the admin UI.

It runs in the k3s cluster next to `cam2`, and
[cams](https://github.com/klaushofrichter/cams) uses it (the SSE relay,
Timeline, and clips and thumbnails from the proxy first). It also runs on a
Raspberry Pi 4 next to the real camera ([docs/raspberry-pi.md](docs/raspberry-pi.md)).
See the [design spec](docs/superpowers/specs/2026-09-27-cam-proxy-design.md)
and the [requirements](docs/requirements.md).

Targets:
- **Production:** the k3s cluster next to `cam2` (a
  [cam-sim](https://github.com/klaushofrichter/cam-sim) simulated camera),
  <https://cam-proxy.skylar.technology> (LAN only).
- **Production:** a Raspberry Pi 4 next to the real camera (cam1, "Den"),
  since 2026-09-29, with Docker and [`compose.yaml`](compose.yaml). Setup and
  operation: [docs/raspberry-pi.md](docs/raspberry-pi.md).

A Mac runs it for development on `localhost:8480`.

## Related repos

- [cams](https://github.com/klaushofrichter/cams): the camera viewer. It reads
  this proxy's client API (`/api`, with a client token) for events, stills,
  clips and SD recordings; see [cams integration](#cams-integration).
- [cam-sim](https://github.com/klaushofrichter/cam-sim): the camera simulator.
  It is the camera in this repo's tests (a release tarball in `package.json`)
  and `cam2`, the camera of the cluster instance.
- [cam-proxy-pi-display](https://github.com/klaushofrichter/cam-proxy-pi-display):
  the e-paper status display on the Pi. It reads only
  [`GET /api/local/health`](#control-api-and-admin-ui), which answers loopback
  callers without a key; this proxy doesn't depend on it.

## Contents

- [Quick start (Mac, against cam-sim)](#quick-start-mac-against-cam-sim)
- [Configuration](#configuration)
- [Client API](#client-api)
- [Stills and previews](#stills-and-previews)
- [Clips (FTP)](#clips-ftp)
- [Recordings (SD card)](#recordings-sd-card)
- [Analytics (optional)](#analytics-optional)
- [Storage management](#storage-management)
- [Archive](#archive)
- [Event stream (SSE)](#event-stream-sse)
- [Camera name](#camera-name)
- [Control API and admin UI](#control-api-and-admin-ui)
- [Audit log](#audit-log)
- [Metrics](#metrics)
- [Deployment](#deployment)
- [Development](#development)
- [cams integration](#cams-integration)
- [Operating the cluster](#operating-the-cluster)

## Quick start (Mac, against cam-sim)

**Requirements:**
- **Node 26 or later** (`engines` in `package.json`). The catalog uses the
  built-in `node:sqlite`, so older versions don't run it. On the Mac that is
  Homebrew's `node`; the container image has its own.
- **ffmpeg** on the `PATH` (`brew install ffmpeg`).

```sh
npm ci
scripts/install-go2rtc.sh          # go2rtc 1.9.14 into tools/ (checksums pinned)
npm run build                      # server and admin UI
scripts/sync-secrets.sh            # generates the tokens and the FTP password into .env
```

Start a cam-sim with a `proxy` user (in its own checkout):

```sh
CAMSIM_USERS='proxy:admin:<password>' CAMSIM_CONTROL_TOKEN='<token>' CAMSIM_WEB_UI=true npm run dev
```

Point the proxy at it with a `config.json` in this folder:

```json
{ "camera": { "host": "127.0.0.1:8080", "protocol": "http", "onvifPort": 8000, "rtspPort": 8554 },
  "go2rtc": { "binary": "tools/go2rtc" } }
```

Add `CAMPROXY_CAMERA_PASSWORD=<password>` to `.env`, then run `npm run dev`.
The admin UI is at <http://localhost:8480>; sign in with
`CAMPROXY_ADMIN_TOKEN`.

### The macOS firewall and node

A camera that uploads clips connects **to** the Mac: the FTP port (2121) and
the passive ports (30000-30009). With the macOS firewall on, those connections
are dropped silently unless the node binary is allowed to accept incoming
connections. The camera's FTP test then answers `-454`, and the server logs
no connection at all. cam-sim in the same process, and the tests, don't need
this: they connect over localhost.

The firewall allows a binary by its **real path**, which includes the Node
version. After every `brew upgrade node`, allow the new binary again:

```sh
readlink -f "$(which node)"   # e.g. /opt/homebrew/Cellar/node/26.8.1/bin/node
sudo /usr/libexec/ApplicationFirewall/socketfilterfw --add "$(readlink -f "$(which node)")" \
  --unblockapp "$(readlink -f "$(which node)")"
/usr/libexec/ApplicationFirewall/socketfilterfw --listapps   # check: "Allow incoming connections"
```

Or use System Settings → Network → Firewall → Options → **+**, and remove
the entries of old versions there. Only that node binary is allowed; the
firewall stays on. The Pi and the cluster don't have this step (Docker).

## Configuration

**One file, `config.json`, holds every setting that isn't a secret.** Secrets
come only from the environment.

- **Where:** `./config.json`, or the path in `CAMPROXY_CONFIG`.
  `config.example.json` shows every setting with its default, and
  `config.schema.json` lets editors check the file.
- **Defaults:** the file needs only what differs, usually the camera.
- **Validation:** an unknown key or a bad value stops the start, naming the
  setting (e.g. `stills.intervall: unknown setting`).
- **Changed in the admin UI** (or `PUT /control/config`): the change is stored
  as an override in `<dataDir>/overrides.json`. The effective value is
  default, then file, then override, then the environment (below). A value
  equal to what the setting has without an override (config.json's, else the
  default) is not stored: saving it removes the override, also when a whole
  group is sent (`{"camera":{"poeSwitch":{…, "ports": 8}}}` stores no
  `ports`). An override's **Reset** button names what it goes back to ("Reset
  – 90 days"; "(config.json)" when the file sets it), and for an unset state
  what that means ("Reset – none (no PoE switch: power-cycle off)", "Reset –
  not set (PoE switch control off: no switch address)"; the texts are the
  `unset` entries in `src/config/schema.ts`). An override equal to that value
  (kept by an older version) has no Reset button: its badge reads "override =
  default" (or "= config.json"), with a tooltip that Reset would change
  nothing. **Reset to defaults** (shown while any override is set) removes
  them all at once after a confirmation listing each change, and the
  overrides equal to the default as one "no change in effect" line
  (`DELETE /control/config`, one `config-change` record).
- **From the environment** (the Pi's one `.env`, [docs/raspberry-pi.md](docs/raspberry-pi.md)):
  `CAMERA_HOST` (or `CAMPROXY_CAMERA_HOST`) sets the one camera's host (`cameras.<id>.host`; address or
  name, optional `:port`), and `PI_ADDRESS` (or `CAMPROXY_PI_ADDRESS`; address
  or name, no port) sets `ftp.publicHost` and `server.publicUrl`
  (`http://<PI_ADDRESS>:<server.port>`). They win over overrides and
  config.json, show read-only ("set in .env") on the Settings page, and an
  override of them answers 400. With `CAMPROXY_ENV_FILE` (the mounted `.env`),
  cam-proxy reads these two keys from that file at every start, and the file
  wins over the process environment (a restarted container keeps its old
  environment); nothing else is read from it. The startup line `config_env`
  names what the environment set (addresses only).
- **Live or restart:** most settings apply at once. Camera, go2rtc, stills,
  previews, the ONVIF subscription settings and most FTP settings (all but
  `ftp.stream`, `ftp.stalledHours` and `ftp.maxGB`) apply after a restart; the `restart` action
  applies them without restarting the process. `server.port` and
  `server.dataDir` need a new process.

| Group | Settings (defaults) |
|---|---|
| `server` | `port` (8480), `dataDir` (`data`, relative to the config file), `logLevel` (`info`), `publicUrl` (where people reach this proxy; reported in `/api/cameras` as `publicUrl`, so cams can link to it), `trustProxy` (0: none; behind the cluster ingress 1, so rate limits count clients by X-Forwarded-For) |
| `camera` | one camera (or `cameras`, a list: [Several cameras](#several-cameras)): `id` (`cam1`), `name` (`Den`; only the fallback until the camera's own name is read, see [Camera name](#camera-name)), `host` (without it the camera waits idle), `protocol` (`https`), `tlsName`, `webUiUrl` (the camera's own web page, linked from the admin UI; default `https://<host>/`, `none` for no link), `user` (`proxy`), `onvifPort` (8000), `rtspPort` (554), `baichuanPort` (9000, recordings over TCP; applies at the next connection), `statusPollS` (30); `poeSwitch`: the camera's PoE switch for a power-cycle, `model` (`none`; `sscpoe-web` for the STEAMEMO GPS-208 and kin), `host` (its address, optional `:port`), `port` (the switch port the camera is on, 1–48), `ports` (8: the switch's PoE port count), `offSeconds` (10, 5–60). The `poeSwitch` settings apply at once; see [docs/poe-switch.md](docs/poe-switch.md) |
| `events` | `onvif.subscribeMin` (10), `onvif.pullTimeoutS` (30), `poll.enabled` (true), `poll.intervalS` (2), `poll.afterOnvifDownS` (60), `maxOpenMin` (10) |
| `retention` | `stillsDays` (7), `previewsDays` (14), `clipsDays` (7), `eventsDays` (30), `auditDays` (90), `streamLogDays` (7), `intervalMin` (60) |
| `storage` | `maxPercent` (85) or `maxBytes`, `minFreeBytes` (2 GB), `keepHours` (per kind: `stills` 24, `clips` 24, `previews` 72) |
| `sse` | `maxClients` (50), `queuePerClient` (1000), `pingS` (15) |
| `go2rtc` | `binary` (`go2rtc`), `rtspPort` (18554), `apiPort` (11984); both listen on 127.0.0.1 only; `url` (reserved, not used yet: for a go2rtc that runs as its own container) |
| `stills` | `enabled` (true), `stream` (`sub`), `intervalS` (1), `size` (`896x512`), `quality` (5), `maxGB` |
| `previews` | `tileSize` (`160x90`), `grid` (`10x6`), `quality` (7), `maxGB` |
| `ftp` | `enabled` (false), `port` (2121), `passive` (`30000-30009`), `publicHost` (the address the camera connects to), `user` (`camera`), `tls` (true), `certFile`/`keyFile` (else a self-signed certificate), `stream` (`main`), `stalledHours` (6, 1–72: the Status page warns when no clip arrived for this long while the camera recorded events; applies at once, no restart), `maxGB` |
| `health` | `diskPercent` (90, 50–99): the data volume's used percent from which the health summary (the Status page's Health card, `GET /api/local/health`) flags a problem; `tempC` (75, 40–95): the CPU temperature (°C, on a Raspberry Pi) from which it does. Both apply at once |
| `host` | `stats` (`auto`): read the host figures (CPU temperature, under-voltage, memory, uptime, load) for the Pi card and the health summary; `auto` on a Raspberry Pi only (detected from `/proc/cpuinfo`), `on`, or `off`. Off a Pi, memory and load in a container would describe the node, not the proxy. Applies at once |
| `recordings` | `cacheMB` (2048, 64–1,048,576): size cap of the recordings cache; least recently used files go first, and they are the first to go when the storage budget is exceeded. Applies at the next fetch or storage run |
| `composition` | `font`: the font file for the text of composed clips; default the first of DejaVu Sans (the container) or Arial (macOS) that exists |
| `archive` | `enabled` (true): take new clips into the [Archive](#archive) (reading, editing, deleting and its daily cleanup go on when off); `warnPercent` (50, 1–99): the Archive's share of the data volume above which the Status card and the health summary warn (no limit). Both apply at once |
| `analytics` | `kinds.person` (true), `kinds.vehicle` and `kinds.pet` (false), `googleVision.enabled` (false), `.monthlyLimit` (0), `.dailyCap` (0), `.checksPerDay` (10, 0–1000; still checks by hand, 0 = none); see [Analytics](#analytics-optional) |

| Secret (environment, or `<NAME>_FILE`) | |
|---|---|
| `CAMPROXY_TOKENS` | client tokens, comma-separated, at least 32 characters each (a second token allows rotation without downtime) |
| `CAMPROXY_ADMIN_TOKEN` | the control API and admin UI; different from every client token |
| `CAMPROXY_CAMERA_PASSWORD` | the password of the proxy's camera user (`camera.user`); the default for every camera |
| `CAMPROXY_CAMERA_PASSWORD_<ID>` | optional: one camera's own password (the id upper-cased, `-` → `_`, e.g. `CAMPROXY_CAMERA_PASSWORD_CAM_3`); without a default, every camera needs one |
| `CAMPROXY_FTP_PASSWORD` | the camera's FTP login to the proxy; required when `ftp.enabled` |
| `CAMPROXY_AUDIT_TOKEN` | optional: a read-only token for `GET /control/audit`; 32+ characters, different from the other tokens |
| `CAMPROXY_POE_SWITCH_PASSWORD` | optional: the PoE switch's web password, for the camera power-cycle (`camera.poeSwitch`); never logged, returned or audited |

`scripts/sync-secrets.sh` generates the tokens and the FTP password into
`.env` (mode 600), `--rotate <KEY>` replaces one, and it prints names only.
It refuses a file others can read and values with an inline comment.
`--only local|github|kube|all` limits which targets it writes to, and
`--dry-run` shows what it would do without writing or applying anything. For
the cluster, a separate file holds cam2's values and the kube settings
(`.env.example` lists them): `--env-file .env.cluster --only all` sets the
repo secret `KUBE_SETUP_DEPLOY_TOKEN` and applies the Secret
`cam-proxy-secrets` (values on stdin or in a private temporary file, never in
arguments).

### Several cameras

One proxy can serve several cameras (spec
[2026-10-05-multi-camera-host-design](docs/superpowers/specs/2026-10-05-multi-camera-host-design.md),
phase 1). Today's one-camera `config.json` with a `camera` object keeps
working unchanged: it is read as a list of one at every start, and never
rewritten. [config.cameras.example.json](config.cameras.example.json) shows
the new form:

- **`cameras`**: a list in config.json; its order is the display order.
  Settings paths and overrides use the id: `cameras.cam4.stills.intervalS`.
  Ids are unique, `^[a-z0-9][a-z0-9-]{0,31}$`; `camera` and `cameras` together
  are an error. A new camera's `name` and `ftp.user` default to its id.
- **Per camera:** `id`, `name`, `host`, `protocol`, `tlsName`, `webUiUrl`,
  `user`, `onvifPort`, `rtspPort`, `baichuanPort`, `statusPollS`,
  `poeSwitch.port`, `ftp.user`, and these overrides of a host default (absent:
  the host value): `stills.enabled`, `stills.stream`, `stills.intervalS`,
  `ftp.enabled`, `ftp.stream`, `analytics.kinds.*`, `events.poll.enabled`.
  Everything else is host-wide.
- **`poeSwitch`** (host-wide): `model`, `host`, `ports`, `offSeconds`; each
  camera names its `poeSwitch.port`. A legacy `camera.poeSwitch` is read
  that way; overrides with legacy paths (`camera.statusPollS`,
  `camera.poeSwitch.host`, `ftp.user`) are read translated and written back
  in the new form on the next save. `GET /control/config` shows the new
  paths (a legacy file's values are marked "config.json (legacy camera)").
- **Supervision:** each camera runs on its own; a camera that fails to start
  retries after 5 s, doubling to 5 min, and the others never wait for it. A
  camera without an address waits idle (`error: "no_address"`): the proxy no
  longer refuses to start. A request for a camera that is restarting answers
  `503 camera_restarting` with `Retry-After`; an unknown camera 404.
- **API:** `GET /api/cameras` lists every camera in config order, each with
  `error` (null when fine) and `features` (`["sse-cam-list"]`); `GET
  /api/stream?cam=a,b` filters to several cameras; the health summary keeps
  schema 1 with the first camera on top, adds `cameras[]`, and aggregates the
  camera, stream, events and FTP items over the cameras. `GET /control/cameras`
  gives each camera's status block; the admin UI shows a camera picker.
  Audit records name their camera (`labels.camera`) only when they concern
  one. The image rate limit grows with the number of cameras.
- **Camera actions** name their camera: `POST
  /control/cameras/<id>/actions/<name>` or `?cam=<id>` on
  `/control/actions/<name>`, and `PUT /control/cameras/<id>/name`; without
  one, a proxy with several cameras answers `400 camera_required` (one camera:
  as before). `restart` with a camera restarts that camera's side (without one: every
  camera side, applying pending restart settings); host actions have no
  camera route. The admin UI sends them for the camera picked in the top bar.
- **Not yet (phase 2):** per-camera settings in the admin UI, FTP for more
  than one camera (a config error until per-camera FTP users exist), one shared go2rtc
  (until then camera *i* uses `go2rtc.rtspPort`/`apiPort` + 100 × *i*), and a
  shared recordings cache (each camera gets an equal share of `cacheMB`).
  `CAMERA_HOST` with several cameras is a config error.
- **Tests:** `npm run test:e2e:multi` runs the admin UI against three cam-sims
  behind one proxy.

## Client API

Base URL `http://<host>:8480/api`. Every request needs
`Authorization: Bearer <token>`: a client token, the admin token, or an admin
UI session.
- A missing or wrong token answers 401 `{"error":"unauthorized"}`.
- A token in the URL (`?token=`, `?access_token=`) answers 400
  `{"error":"token_in_url"}`.

Any one client may send 1200 requests a minute, plus 6000 image requests
(stills, sprites and clip files — `clips/<id>.mp4` and `clips/<id>.jpg` — a
day on a timeline is up to 1440 sprites; a recording file once it is cached,
while one not yet cached counts as a normal request); more answer 429
`{"error":"rate_limited"}`. Timestamps are unix milliseconds. The full schema is in
[openapi.yaml](openapi.yaml).

```sh
api() { curl -s -H "Authorization: Bearer $CAMPROXY_TOKEN" "http://localhost:8480/api$1"; }
api /cameras
# [{"id":"cam1","name":"Backyard Left","online":true,"lastEventTs":1790000000000,"stream":{"up":true,"lastFrameTs":1790000000000},"publicUrl":null,"address":"192.168.1.20","error":null,"features":["sse-cam-list"]}]
# address: the camera's host as the proxy runs it (cams reaches the camera there)
# every camera of this proxy, config order; error: null when fine; features: what this proxy supports (sse-cam-list: ?cam=a,b)
api /cameras/cam1   # the same entry for one camera (404 for another id)
api '/cameras/cam1/events?kind=person&limit=10'
# [{"id":12,"kind":"person","source":"onvif","start":1790000000000,"end":1790000004000,"endReason":"state"}]
```

- `GET /api/cameras`: the camera and whether it answers; `stream` is `null`
  only when stills are off; `lastEventTs` is the newest live (non-recovered)
  event's start.
- `GET /api/cameras/{cam}/events?from&to&kind&limit`: events, newest first,
  at most 1000.
  - `source` is `onvif`, `poll` for the fallback, or `recovered`: added
    afterwards from the camera's SD recordings by the events repair (#75),
    never sent over SSE, never analysed; its start and end are the
    recording's, pre- and post-record included.
  - `endReason` is `state` (the camera said so), `timeout` (still open after
    `events.maxOpenMin`), `restart` (the proxy stopped while it was open) or
    `recovered`.
- `GET /api/cameras/{cam}/analyses?from&to`: the analyses of events that
  start in the range (at most one day), oldest first, at most 1000, in the
  `analysis` stream message's shape without `objects`.
- `GET /api/cameras/{cam}/recordings?from&to&stream` or `?date&stream`: the
  recordings on the camera's SD card that overlap the range (unix ms, at most
  48 hours) or of one camera-local day (`date=YYYY-MM-DD`; not with
  `from`/`to`); `stream` `sub` or `main`, required. By start:
  `[{id, start, end, stream, size, kinds, clipId}]`. See
  [Recordings (SD card)](#recordings-sd-card).
- `GET /api/cameras/{cam}/recordings/days?month=YYYY-MM`: `{month, days}`,
  the camera-local days of that month with recordings.
- `GET|HEAD /api/cameras/{cam}/recordings/{id}`: one recording as MP4, with
  `Range`; `HEAD` never downloads from the camera.
- `GET /health`: the process is up (no auth).

## Stills and previews

go2rtc holds the one RTSP connection to the camera's sub stream (H.264
896×512, 10 fps) and restreams it on 127.0.0.1. One ffmpeg reads the restream
and writes, from the same decode, a still every `stills.intervalS` and a
preview tile. ffmpeg and go2rtc are restarted with backoff if they exit.

**On disk** (UTC days): `data/stills/<cam>/YYYY/MM/DD/HHMM.pack` holds one
minute of stills, and `data/previews/<cam>/YYYY/MM/DD/HHMM.jpg` plus
`HHMM.json` hold the minute's sprite sheet and its sidecar.
- **Packs:** the JPEGs back to back, then a JSON footer (interval, size,
  quality, one `[offset, length]` per slot), its length and the magic `CPK1`.
- **Sprites:** a `grid` of tiles, with missing seconds dark.

Both record the settings they were made with, so changing the interval or
size keeps older minutes readable. A minute interrupted by a restart is merged
when the proxy comes back.
- **Recovery:** if no still arrives for 10 s, the stream is reported down.
  ffmpeg is restarted, which also covers a stream that stalls silently. On the real camera a still is about 24 KB, about
2 GB a day.

| Route | |
|---|---|
| `GET /api/cameras/{cam}/extent` | how far back content goes: `{clips, stills, previews}`, the oldest of each (unix ms, or null) |
| `GET /api/cameras/{cam}/stills?from&to` | timestamps with a still (at most a day) |
| `GET /api/cameras/{cam}/stills/{ts}.jpg` | one still; `immutable` caching once its minute is complete |
| `GET /api/cameras/{cam}/previews?from&to` | `[{minute, cols, rows, tileW, tileH, intervalS, present, url}]` |
| `GET /api/cameras/{cam}/previews/{minute}.jpg` | one minute's sprite sheet |

A browser scrubbing a day loads one sprite per minute and shows a tile with
CSS (`background-position`). The admin UI's **Timeline** page does this. The
SSE type `still` announces each new still live, only to clients that ask with
`types=still`, without an id and without replay.

## Clips (FTP)

The camera uploads each recording it makes on motion or an AI detection to
the proxy's own upload-only FTP(S) server (`ftp.enabled`, password
`CAMPROXY_FTP_PASSWORD`). The server accepts logins, explicit TLS
(`AUTH TLS`, `PROT P`), passive mode, folders and `STOR`, and nothing else:
no downloads, listings or deletes. Paths stay inside its folder, at most 4
sessions, 500 MB a file, and 5 failed logins a minute close the connection.
Commands run one at a time per session; `SIZE` always answers 550 (there is
nothing to download), and absolute and relative upload paths both land in the
upload folder. While storage is paused, `STOR` answers 452.

- **Index:** a finished upload named `<Name>_00_YYYYMMDDHHMMSS.mp4` (the
  camera's local time) becomes UTC with the camera's time zone and DST rule
  (`GetTime`), is checked with ffprobe (anything that isn't a video is
  dropped), and is stored as `data/clips/<cam>/YYYY/MM/DD/HHMM-<start>.mp4`.
  The camera's `.jpg` becomes the clip's snapshot. The camera names it after
  the event, 3–5 s after the clip's own name (the clip starts with the
  pre-record; measured on cam1 2026-09-30), so a picture goes to the clip
  that started last at most 10 s before it, whichever arrives first; on
  startup, clips without one are paired from the stored pictures. A `clip`
  stream message follows, with the live events the clip covers (never a
  recovered one: SSE carries none). One clip often
  covers several events: the camera extends a recording while events keep
  coming, and ends it `postRec` (its "Post-Motion Record", 15 s on cam1)
  after the last one.
- **Camera setup:** `POST /control/actions/camera-ftp-setup` writes the
  camera's whole FTP object (the proxy at `ftp.publicHost`, uploads on
  motion and people/vehicle/pet detections, all hours).
  `camera-ftp-test` asks the camera to connect (`{ok, rspCode}`), and
  `camera-ftp-off` sets `enable` to 0 with the rest kept; with the FTP
  password configured it also writes the proxy's FTP user and password (the
  camera's answer shows them masked, e.g. `ca**ra`). The Maintenance
  page has the three buttons.
- **Health (#93):** the proxy reads the camera's FTP settings (`GetFtpV20`,
  never the password) when the camera comes online and every 5 minutes
  after, and after each setup or off. The Status page's FTP card shows
  "Camera upload" and turns red, with an alert and a "Point the camera's FTP
  here" button, when the upload is off (`enable` 0 with a server set, or no
  server after clips arrived before), when it points somewhere else (its
  port or user, or its server and more, differ from what
  `camera-ftp-setup` writes), or when no clip arrived for
  `ftp.stalledHours` (6) while the camera recorded motion, person, vehicle
  or pet events (events of the last 10 minutes don't count yet; a quiet day
  is no warning). Only another server name (port and user match: perhaps
  another name for this proxy; compared trimmed and in lower case, no DNS)
  is amber. A camera that has no FTP server set and never sent a clip (a
  fresh or reset camera) shows the amber warning "FTP upload isn't set up
  on the camera", with the same button, and is a problem in the health
  summary (the Health card's FTP line and the card's "Camera upload" line
  are red), but writes no audit record and no stall warning. The
  time of the last clip is kept when retention deletes the clip. An
  intentional `camera-ftp-off` stays red while `ftp.enabled` is true in
  the proxy; set `ftp.enabled: false` to silence it. Each change of the
  camera's FTP state is an audit record (`camera-check`), and `/metrics` has
  `camproxy_camera_ftp_enabled`, `camproxy_clips_stalled` and
  `camproxy_clips_last_received_timestamp_seconds`. On 2026-10-01 the
  upload had been off for 37 hours unnoticed.
- **API:** `GET /api/cameras/{cam}/clips?from&to` (at most 31 days) lists
  `{id, start, end, stream, size, events, url, snapshotUrl}`;
  `/clips/{id}.mp4` serves the file with HTTP Range, `/clips/{id}.jpg` the
  snapshot. The admin UI's Clips page plays them.
- **Composed clips:** `POST /api/cameras/{cam}/compositions`
  `{clipId, span?, preS, postS, size, badge, timeZone?}` composes a clip with a
  pre-/post-roll (whole seconds, −3600…3600 each; a negative one cuts). The
  rolls apply to `span` (`{start, end}` in unix ms: the recording the viewer
  chose, e.g. cams's SD-card file, which the proxy's FTP copy can outlast),
  else to the clip itself; the span must overlap the clip by at least 1 s,
  and at least 1 s of it must remain. The result is at
  most 300 s, 120 s at `1080p` (encoding time on a Pi 4: about 3 minutes
  either way, estimated); a longer one is a 400 `invalid` with `detail`
  `at most 300 s (5:00)`. Each second comes from the clip,
  another clip, that second's still, or a "No recording" card; still and card
  seconds can carry a "STILLS 1 FPS" badge. H.264 10 fps, sizes `sd`, `360p`,
  `720p`, `1080p`. One encoding runs at a time (3 may wait); poll
  `GET …/compositions/{id}` for progress, fetch `…/{id}.mp4`, and
  `DELETE …/{id}` cancels. A job nobody polls for 30 s stops, and results
  are removed after 15 minutes, and one running over 10 minutes fails. Each clip
  part and each run of stills and cards is a small encode of its own (two
  encoder threads, at nice 10 so the stills and the stream keep their CPU), joined without encoding again: about 120 MB peak at SD,
  280 MB at 1080p. Cards show the time in `timeZone` (the viewer's), else the
  process's. The font comes from `composition.font`, else DejaVu Sans (the
  container) or Arial (macOS).
- **Around a second** (cams #179): `{at, preS, postS, size, badge,
  timeZone?}` instead of `{clipId, span?}` composes the window
  `[at − preS, at + 1 s + postS]` (rolls 0…3600, the same limits: −10/+10 is
  21 s) from the FTP clips where they cover it and the stills elsewhere.
  `at` is a whole second, not in the future and not older than the stills
  and clips kept; the window must have ended. A window no clip or still
  covers is a 409 `nothing_to_compose`. `dryRun: true` (either anchor)
  answers 200 `{start, end, durationS, seconds: {clip, still, card}, clips}`
  without a job. Real requests are limited to 10 a minute per client and
  audited (`composition`).
- **Firewall:** the camera connects to the proxy, on `ftp.port` and the
  `ftp.passive` ports. On a Mac with the firewall on, node must be allowed
  to accept incoming connections, again after each Homebrew node upgrade
  (see [The macOS firewall and node](#the-macos-firewall-and-node)).

## Recordings (SD card)

The camera keeps about 7 days of recordings on its SD card, in both streams
(main at 12 MP, sub at 896×512). cam-proxy lists them and serves any of them
as MP4, also the ones FTP never delivered.

- **List:** `GET /api/cameras/:cam/recordings?from=&to=&stream=sub|main`
  (unix ms, `to` not before `from`, at most 48 hours) answers `[{id, start,
  end, stream, size, kinds, clipId}]`, from the camera's HTTP `Search` (one
  per camera-local day the range touches, one at a time, each kept 30 s).
  `?date=YYYY-MM-DD&stream=` instead lists one camera-local day, in the same
  shape (`date` and `from`/`to` together are a 400).
  A camera Search finds the recordings that start on its day, so a recording
  that starts before midnight and runs into the next day is only in the day
  before's Search: both forms also read the day before (the day before the
  range's first day), and keep its midnight-crossing recordings. Once that
  day has been over for 5 minutes and none of its recordings is still being
  written, that tail is final and kept 15 minutes, so a day view in that time
  costs one Search per stream after the first. An SD-card format or overwrite,
  or a camera reboot the proxy didn't start, can leave it stale for up to 15
  minutes.
  `kinds` comes from the file name's trigger flags; `clipId` is the proxy's
  FTP copy of the same recording (same stream, start within 5 s), or null.
  Recordings still being written are left out.
- **Days:** `GET /api/cameras/:cam/recordings/days?month=YYYY-MM` answers
  `{month, days}` (kept 5 minutes). cams uses it for its calendar, so every
  camera Search goes through this proxy.
- **File:** `GET /api/cameras/:cam/recordings/:id`. The first request fetches
  the file over Reolink's Baichuan protocol (TCP `camera.baichuanPort`, 9000)
  and streams it while it arrives: a 15 MB main file takes about 2 s on the
  LAN. Later requests come from the cache (`<dataDir>/recordings/<cam>/`).
  - **One download at a time per camera.** Parallel requests for one id share
    one download, and a late joiner is served from the cache. A viewer who
    stops reading (a paused `<video>`) is dropped after 5 s while the cache
    keeps filling; its next `Range` comes from the cache.
  - **Range** is served from the cache (a `Range` request waits for the
    download, then reads the file), except `Range: bytes=0-` on a file not
    yet cached (how a `<video>` opens): it streams while it arrives, as 200
    with the whole file. A `Range` on a file that can't be cached (the disk
    is paused, the file is larger than `recordings.cacheMB`, or there is no
    room beside the files being read) gets the whole file with 200; several ranges in one header also get the
    whole file with 200; a range wholly past the end answers 416 without a
    download. The `ETag` is the id and size (stable); `If-None-Match` answers
    304 and `If-Range` is honoured.
  - **HEAD never downloads:** it answers from the list (or the cache).
  - **A cached file is served while the camera is offline.**
- **Why Baichuan:** the RLC-1224A refuses every HTTP `cmd=Download` since
  2026-10-01, while Baichuan downloads of the same files work (findings in
  the spec, `docs/superpowers/specs/2026-10-02-baichuan-recordings-design.md`).
  The client is ours (`src/camera/baichuan/`), ported from reolink_aio and its
  PR #186 (MIT, see `THIRD_PARTY_NOTICES`). It logs in as `camera.user` (the
  `proxy` user is admin level) with `CAMPROXY_CAMERA_PASSWORD`, keeps one
  connection and closes it after 20 s without a request; the camera allows 12
  Baichuan connections in all. After a rejected login it waits 15 s before it
  tries again, so a wrong password can't lock the account. A camera reboot or
  power-cycle resets the session, as does a change of `camera.baichuanPort`.
- **Cache:** `recordings.cacheMB` (2048). The cache counts in the storage
  budget as the kind `recordings`, and it is the first to go when the budget
  needs room, least recently used first. A file being read is never deleted.
  Below `storage.minFreeBytes` files are streamed without being kept.
- **Errors:** 400 `invalid` (a bad id, `to` before `from`, more than 48
  hours, a bad `date`, `month` or `stream`, `date` with `from`/`to`); 404 `unknown_recording`; 503
  `camera_offline` (the status poller says offline, or no connection to the
  camera could be made); 502 `recordings_unavailable` with `reason` `refused`,
  `auth`, `timeout`, `protocol`, `offline` (the connection was lost during the
  transfer) or `search_failed` (the list's Search); 503
  `recordings_unavailable` with `reason` `busy` and `Retry-After: 5` when more
  camera Searches wait than the proxy queues (one runs, 8 wait; requests for
  the same day share one Search; a waiting Search whose requests have all
  gone is dropped). After the first byte the
  headers are gone, so a failure cuts the connection and the client sees a
  short body.
- **Status:** the Status page's "Recordings (SD card)" card shows the last
  download's result and the cache fill: amber for `timeout` and `offline`, red
  for `auth`, `refused` and `protocol`, grey for `not_found` (the camera
  overwrote the file) and before the first download; an inventory repair's
  download says "inventory repair". `/control/status` has
  `recordings` (`last.priority`: `high` for a viewer's download, `low` for a
  repair's); the metric is
  `camproxy_recording_downloads_total{cam,stream,result,priority}`, and the disk gauges
  have `kind="recordings"`. Reading or downloading a recording writes no audit
  record.
- **Network:** the Pi reaches the real camera's port 9000 on the LAN. In the
  cluster, cam2 (cam-sim) offers a Service port 9000 and cam-proxy's egress
  allows it (kube-setup, see `deploy/cluster/REQUEST.md`).

## Analytics (optional)

Off by default. When on, the proxy sends the still of a person, vehicle or pet
event to Google Vision (object localization) and keeps the objects it finds, a
second opinion on the camera's label. The admin UI shows it as a "✦ Vision"
tag on the Events page, a mark on the Timeline's minutes, and a picture with
boxes. Motion-only events are never analysed.
How it works end to end (the flow, the summary, unmapped objects, the API,
privacy and cost): [docs/analytics.md](docs/analytics.md).

- **Settings** (Settings page, or `PUT /control/config`):
  `analytics.kinds.person` (default on), `.vehicle` and `.pet` (off);
  `analytics.googleVision.enabled` (off), `.monthlyLimit` (0 = no calls,
  max 100000), `.dailyCap` (0 = no daily cap, max 10000) and
  `.checksPerDay` (default 10, 0 = no still checks, max 1000).
- **Key and URL:** `CAMPROXY_GOOGLE_VISION_KEY` in the environment (a secret,
  never in config.json or the UI; the UI shows it masked) and optionally
  `CAMPROXY_GOOGLE_VISION_URL` (default `https://vision.googleapis.com`;
  `http://` only to localhost, since the key travels in a header; the e2e
  tests point it at a mock). Without a key the switch stays disabled.
- **Key set on the Settings page:** the Analytics card has a "Google Vision
  key" field (or `PUT /control/secrets/google-vision-key`). It replaces the
  key in use at once, whether it came from the environment or was set there
  before, and lifts an invalid-key pause. It is kept in memory only: never
  written to disk, the config or the logs, and never returned. **It is not
  saved: a restart of the proxy process restores the configured key (or
  none).** The "Restart camera side" action keeps it. While it is in use the
  card says "Manual key active (AIza…wXyZ)", and `GET /control/analytics`
  reports `keySource: manual` (else `env` or `none`). Each set is an audit
  record, `secret-override`, with the first and last four characters only.
- **Limits:** a call is made only while both the monthly limit and the daily
  cap allow it (calendar month and day in camera time). The count is this
  proxy's own: proxies that share a key share Google's budget, so keep their
  limits' total within it.
- **Cost (as measured 2026-09-30):** Google's first 1,000 units a month are
  free per feature; object localization is one unit per image, then $2.25 per
  1,000 (Google's price list, checked 2026-09-30). The Settings card shows
  the estimate for the monthly limit.
- **Still checks (cams #179):** cams can ask Vision about any second that has
  a still (`POST /api/cameras/{cam}/still-checks {at}`). The answer is a
  check, stored apart from events for 30 days with its JPEG
  (`data/still-checks/<cam>/check-<id>.jpg`); the same second again is answered
  from the stored check (or from an event's analysis of that still) without a
  call. Checks count toward the monthly limit and the daily cap, and at most
  `checksPerDay` a camera day. Each request is audited (`still-check`). See
  [docs/analytics.md](docs/analytics.md#still-checks).
- **Summary:** each analysis keeps persons, vehicles and pets only, mapped
  by Open Images class id ([docs/analytics-classes.md](docs/analytics-classes.md)).
  Boxes of the same category that overlap by more than 90% are merged, the highest score first.
  It appears on the events list (`analysis.summary`), in the `analysis`
  stream message and in `GET /api/cameras/{cam}/analyses`. Objects that
  don't map are counted: the Status page lists the top 20, and
  `GET`/`DELETE /control/analytics/unmapped` list and clear them.
- **Stored:** the result per event in SQLite, a copy of the analysed JPEG in
  `data/analytics/<cam>/<eventId>.jpg` (stills are kept 7 days, events 30),
  and the usage per day for 400 days. An analysis goes with its event.
- **API:** the events list carries `analysis`; `GET
  /api/cameras/{cam}/events/{id}/analysis` (and `analysis.jpg`), an `analysis`
  stream message, and `GET /control/analytics` for state and usage; still
  checks (`…/still-checks`, the `still-check` stream message) and the
  client-token budget `GET /api/cameras/{cam}/analytics`. See
  [openapi.yaml](openapi.yaml).
- **Live check, by hand only:** `CAMPROXY_GOOGLE_VISION_KEY=... npx tsx
  scripts/analytics-live.ts a.jpg b.jpg` sends up to `LIMIT` (default 5)
  images to the real service and prints the time and objects. Never run it in
  CI.
- **Where the key is:** cam2's proxy in the cluster has no key (Klaus,
  2026-09-30), so analytics stays off there; an admin can give it one with
  the Settings field until its next restart. The Pi gets the key in
  `/srv/cam-proxy/config/.env`; restart it with `docker compose up -d`, then turn it
  on in Settings with a small monthly limit.

## Storage management

Two limits apply, and whichever is reached first wins:
- **Age per kind:** `retention.stillsDays` (7), `previewsDays` (14),
  `clipsDays`, `eventsDays` (30), `streamLogDays`, in whole UTC days.
- **Size budget:** `storage.maxPercent` (85 % of the disk) or
  `storage.maxBytes`, catalog included, and optional per-kind caps
  (`stills.maxGB`, …). Over budget, the oldest hour goes first: stills, then
  clips, then previews; the recordings cache goes before all of them, least
  recently used first. The newest `storage.keepHours` of a kind are never
  deleted for the budget.

The audit folder counts toward the budget and is never deleted to make room; only `retention.auditDays` removes it.

**Hard floor:** below `storage.minFreeBytes` (2 GB) free, stills stop being
written, counted as `camproxy_stills_missing_total`, and uploaded clips are
dropped. Writing resumes on its
own when space is back.

The storage run is hourly (`retention.intervalMin`). `POST
/control/actions/retention-run` runs it now, and `{"dryRun":true}` previews
what it would delete. Clips are deleted with their catalog rows; partial
uploads in `data/ftp/.incoming` are never counted, and go after a day.
`/control/stats` shows usage per kind, growth per day,
days until full and whether writing is paused.

The [Archive](#archive) is outside all of this: neither age nor the budget
touches it, and it isn't counted in the budget.

## Archive

cams's Save dialog stores a clip in the proxy's Archive: the composition it
would download (`source.type: composition`), or the camera's own file (the SD
card's recording, `recording`, or the proxy's FTP copy, `clip`), with a name,
labels (Pet, Person, Vehicle, SD, 4K and custom ones), a retention (365 days,
or forever), the metadata of its window (events, Vision analyses and still
checks, camera, quality, duration, size) and a thumbnail (#157's detection or
Vision still, else the first frame). Files go to
`<dataDir>/archive/<camera>/<id>/` (`clip.mp4`, `thumb.jpg`, `meta.json`).

- Outside retention and the storage budget; a clip that would not leave
  `storage.minFreeBytes` free is refused (507 `insufficient_space`).
- A daily cleanup at 03:30 camera time removes clips past their retention.
- The Status page's Archive card shows count, size, share of the disk, free
  disk, oldest and newest, and the next cleanup; above `archive.warnPercent`
  (50 %) of the disk it warns, and so does the health summary's `archive`
  item (the Pi's e-paper display). No limit.
- Maintenance → "Clear the Archive…" deletes everything once the number of
  clips is typed.
- API (client token): `POST /api/cameras/{cam}/archive`, `GET /api/archive`
  (filters, sorting, paging), `GET|PATCH|DELETE /api/archive/{id}`,
  `POST /api/archive/delete`, `GET /api/archive/{id}/video` (Range),
  `/thumbnail`, `/metadata`, `GET /api/archive/zip?ids=…` (a streamed ZIP),
  `GET /api/archive/status`, the SSE type `archive`. Every change is audited
  (`archive-add`, `-update`, `-delete`, `-clear`, `-expire`).

The API contract and operating notes: [docs/archive.md](docs/archive.md).

## Event stream (SSE)

`GET /api/stream?cam&types&kinds&since`: a Server-Sent Events stream that
never loses anything within the retention (default 7 days).

- **Resume:** every message carries an `id`. On reconnect, browsers send
  `Last-Event-ID` themselves, and other clients use `?since=<id>`. The proxy
  replays everything newer, then continues live, also after a restart.
- **Too far behind:** if the resume point is older than the retention, the
  first message is `event: reset` with `{"oldestId":N}`. Reload through the
  REST API, then continue.
- **Types:**
  - `camera-event`: `{cam, eventId, kind, phase: start|end, ts, source}`; an
    `end` may carry `reason: timeout|restart` (state changes carry none);
  - `camera-status`: `{cam, online, reason, clockOffsetMs}`, plus
    `stream: up|down` when the stills stream changes;
  - `clip`: `{cam, clipId, start, end, stream, size, codec, events, url,
    snapshotUrl}` when an uploaded clip is indexed;
  - `analysis`: `{eventId, kind, start, end, provider, status, reason,
    stillTs, summary, objects}` when an event's analysis is stored. Messages
    from before this version lack `kind`, `start`, `end`, `stillTs` and
    `summary` (the stream keeps 7 days): treat a missing `summary` as
    unknown, not as "nothing found";
  - `camera`: `{cam, name}` once per change of the camera's name (a rename
    through `PUT /control/camera/name` or one made in the Reolink app or the
    camera's web UI, seen by the status poll; also the first read after a
    start when it differs from the name clients were last told);
  - `archive`: `{cam, action: add|update|delete|clear|expire, ids, items}`
    for every change to the [Archive](#archive) (`items` with add and update);
  - `annotation`: reserved, not sent yet;
  - `still`: `{cam, ts, url, sprite, tile}` (the still's URL, its minute's
    sprite sheet, and the tile index within it); only when named in `types`,
    because it fires every second.
- **Filters:** `types` and `kinds` (e.g. `kinds=person,vehicle`) are comma
  lists; so is `cam` (`cam=cam3,cam5`: those cameras; empties are ignored, an
  unknown id matches nothing). One stream carries every camera's messages,
  each with `cam`, and one cursor covers them all.
- **Keep-alive and backpressure:**
  - a `: ping` every 15 s, and `retry: 3000`;
  - a client that can't keep up is disconnected, and resumes from its last id;
  - at most `sse.maxClients` clients (503 beyond).

```sh
curl -N -H "Authorization: Bearer $CAMPROXY_TOKEN" 'http://localhost:8480/api/stream?types=camera-event'
# id: 41
# event: camera-event
# data: {"cam":"cam1","eventId":12,"kind":"person","phase":"start","ts":1790000000000,"source":"onvif"}
```

A camera person detection also sets motion, as on the real camera, so both
arrive.

## Camera name

The camera stores its name (camera-name design): `GetDevName`, `GetDevInfo`'s
`name` and the OSD text are one value on the camera. The status poll reads it
(every `camera.statusPollS`), and the proxy reports it as `name` in
`GET /api/cameras` and `/api/cameras/:cam`, `camera.name` in
`GET /control/status` and `camera.name` in `GET /api/local/health` (the field
was there before; it is the camera-reported name now). The configured
`camera.name` is only the fallback while the camera has not been read since
the proxy started.

`PUT /control/camera/name` renames it: the proxy checks the camera's rules,
writes `SetDevName` (the whole `DevName` object), reads `GetDevName` back and
answers that name. The rules, measured on the RLC-1224A (firmware
v3.2.0.6011): 1 to 31 characters; ASCII letters, digits, space and
`- ( ) + = [ ] { }`; no leading or trailing space
(`^[A-Za-z0-9()+=\[\]{}-](?:[A-Za-z0-9 ()+=\[\]{}-]{0,29}[A-Za-z0-9()+=\[\]{}-])?$`, the
same list as cams, in `src/camera/name-rules.ts`). Each change, also one made
in the Reolink app, reaches stream clients once as a `camera` message.

## Control API and admin UI

`/control` needs the admin token, or an admin UI session (except
`GET /control/audit` and `GET /control/audit/summary`, which also take the audit token).
- A client token answers 403 `{"error":"admin_only"}`.
- Writes with the session cookie need `X-CamProxy-UI: 1`.

| Route | |
|---|---|
| `GET /control/status` | `{version, camera (incl. name (the camera's name; the configured `camera.name` until the camera was read), nameSource: camera\|config, webUiUrl, serial, reboot: {kind: reboot\|powercycle, requestedAt, confirmed, phase: power-cycling\|rebooting\|back\|not-back, offAt, endedAt, downSec} or null, and poeSwitch: {model, host, port, ports, offSeconds, passwordSet, configured, busy, last}), intake, sse, stream: {enabled, up, go2rtcUp, lastFrameTs}, retention, storage: {paused}, ftp: {enabled, listening, port, tls, publicHost, passwordSet, lastUpload, lastClip, clips, failures, camera: {state: on\|off\|elsewhere\|unknown, checkedAt, enable, server, port, user, mismatch, error} or null, stalled: {stalled, hours, lastClip, events} or null}, recordings: {last: {at, result, stream, bytes, ms, priority (high: a viewer, low: an inventory repair)} or null (the last recording download over Baichuan), cache: {bytes, files, capBytes}}, analytics: [{…, keyMasked, keySource}], analyticsUnmapped, health, archive (as `GET /api/archive/status`)}` |
| `PUT /control/camera/name` | `{"name":"Backyard Left"}`: renames the camera on the camera itself ([Camera name](#camera-name)). 200 `{name}` (the name read back from the camera); 400 `{"error":"invalid_name","reason":…}` by the camera's rules (the camera is not asked) or refused by the camera (rspCode -54, -56); 503 `{"error":"camera_offline"}`; 502 `camera_error`. Admin token, or an admin session with `X-CamProxy-UI: 1`. Audited as `camera-name` |
| `GET /control/stats` | `{disk: {catalog, audit, stills, previews, clips, recordings}` (each `{bytes, files, oldest, newest, growthPerDay}`), `events, stream, sse, storage}` |
| `GET /control/config` | every setting: `{value, source, env?, restart, pending, next?, type, resetTo?}` (`source`: `default`, `file`, `override` or `env`; `env`: the variable that sets it; `type`: `integer`, `boolean` or `string`; `resetTo`, on an override: `{value, source: file\|default, same?, means?}`, what removing it goes back to; `same: true` when that is the override's own value, `means` what an unset target (not set, none, off, 0 = none) does); secrets never appear |
| `PUT /control/config` | overrides, e.g. `{"sse":{"pingS":10}}`; a value equal to config.json's or the default is not stored (it removes that override); a bad value answers 400 naming it, and nothing is written; so does a setting the environment sets (`camera.host: set in .env (CAMERA_HOST)`) |
| `PUT /control/secrets/google-vision-key` | `{"key":"..."}` (20 to 200 printable ASCII characters, no spaces; else 400 `invalid`): sets the Google Vision key in memory only, at once, until the process restarts; answers `{keySource: "manual", keyMasked, replaced}`, never the key; audited as `secret-override` |
| `DELETE /control/config/{path}` | removes one override |
| `DELETE /control/config` | removes every override at once (Reset to defaults); answers the new view; one `config-change` record with `reset: "all"` |
| `POST /control/actions/{name}` | `onvif-resubscribe`, `restart` (202, started: reconnects to the camera and applies restart settings; the process runs on); `camera-test`, `retention-run` (`{"dryRun":true}` previews); `camera-ftp-setup`, `camera-ftp-test` (409 `not_configured` without `ftp.publicHost` or the FTP password), `camera-ftp-off` (409 `not_configured` only without the FTP password when the camera shows its FTP user or password masked: it would write them back masked); any camera call that fails answers 502 `camera_error` |
| `POST /control/actions/camera-reboot` | reboots the camera (offline about a minute; every camera token becomes invalid). 202 `{confirmed}`: `false` when the camera dropped the connection after receiving the request; 429 `too_soon` (with `Retry-After`) within 120 s of the last reboot or power-cycle, or while one is being sent; 502 with the camera error code (`camera_offline`, `camera_auth_failed` or `camera_error`) when the request never reached the camera. The proxy rides it out: it drops its camera token, ONVIF re-subscribes on its own, and `/control/status` shows `camera.reboot` until the camera answers again or 5 minutes pass. Audited as `camera-reboot` |
| `POST /control/actions/camera-powercycle` | power-cycles the camera through its PoE switch (`camera.poeSwitch`): logs in to the switch, checks that the camera's port has PoE on and draws power, cuts it for `offSeconds`, turns it on again and logs out (always). Once the PoE-off request is sent, any failure turns PoE on again (retried for about 60 s) and answers 502 `switch_error` with `poeOff: true` and `turnedOn`. 202 `{offAt, onAt, watts}` once PoE is back on; 409 `not_configured` (no switch, or no `CAMPROXY_POE_SWITCH_PASSWORD`), `switch_busy` (someone is logged in to the switch's web UI) or `no_power` (the port has PoE off or draws 0 W: nothing is switched); 502 `switch_auth` (a wrong password), `switch_unreachable` or `switch_error`; 429 as `camera-reboot` (the 120 s cooldown is shared). `/control/status` shows `camera.reboot` with `kind: powercycle`, `power-cycling` while PoE is off, then `rebooting` until the camera answers. Audited as `camera-powercycle`. See [docs/poe-switch.md](docs/poe-switch.md) |
| `POST /control/actions/camera-poe-on` | recovery: turns the camera's port on if its PoE is off (no power check, no cooldown; the switch lock applies). 200 the reading plus `wasOn`; 409 and 502 as `camera-powercycle`. Audited as `camera-poe-on` |
| `POST /control/actions/poe-switch-read` | reads the camera's port on the switch now (log in, read, log out; never polled): `{at, port, index, poe, watts, link, sn, firmware}`; 409 and 502 as `camera-powercycle`. Audited as `control-action` |
| `POST /control/actions/find-camera` | Settings → Find camera: one ONVIF WS-Discovery Probe (NetworkVideoTransmitter, sent twice) to `239.255.255.250:3702`, answers collected for 3 s; no login. 200 `{devices: [{endpoint, address (the first XAddr's host, without the ONVIF port), sender (the address the answer came from), mismatch (they differ), useAddress (what "Use this address" writes: the sender on a mismatch), xaddrs, name, hardware, model (from the scopes), current (the address is `camera.host`'s)}], tookMs, envFile: {writable, path?, reason?}}`; at most 64 devices; 6 a minute per client together with `camera-address` (429 `rate_limited`). On the Pi (host network) it probes the LAN; in a pod network nothing answers. Audited as `control-action` |
| `POST /control/actions/camera-address` | `{"host":"192.168.1.20"}` (address or name, optional `:port`; else 400 `invalid`): writes `CAMERA_HOST=<host>` into the file `CAMPROXY_ENV_FILE` names (absolute, named `.env` or `.env.<word>`, a regular file, under 64 KB). Only that line changes (the last `CAMERA_HOST`, or `CAMPROXY_CAMERA_HOST` when the file sets that; appended when neither), every other byte stays; a backup `.env.bak-<YYYYMMDD-HHMMSS>` (UTC) goes next to it (the newest 5 are kept), then a temp file and a rename, the file's mode kept; shares find-camera's 6 a minute. 200 `{host, previous, key, backup, restart: true}`: the address applies after `restart-proxy` (the Settings page runs it). 409 `not_available` `{detail, line}` without `CAMPROXY_ENV_FILE`, for a path the guard refuses, or a directory it can't write (mount the directory, not the file). Audited as `camera-address` (old → new, the backup; never another line) |
| `POST /control/actions/restart-proxy` | restarts the proxy process: 202, then the normal graceful stop (the same as SIGTERM; `proxy-stop` reason `restart-requested`) and exit 0, also after 15 s if the stop hangs. Compose (`restart: unless-stopped`) or the cluster starts it again; run directly (`npm start`), the process just ends. Admin sessions end with the process. Audited as `proxy-restart` |
| `POST /control/actions/inventory` | `{"kind":"stills"}`, `{"kind":"clips"}`, `{"kind":"clips","camera":true}` (compare with the camera's SD card on `ftp.stream`) or `{"kind":"events"}` (the events against the SD card's recordings on `ftp.stream`, always with the camera): starts an inventory in the background ([the spec](docs/superpowers/specs/2026-10-02-inventory-design.md)); 202 `{runId}`; 400 `invalid` for an unknown kind or a `camera` it can't use; 409 `inventory_busy` `{runId}` while an inventory or repair runs (one at a time); 503 `stopping` once the proxy is stopping. Poll `GET /control/inventory/runs/{id}`. Audited as `inventory` when it ends |
| `POST /control/actions/inventory-repair` | `{"kind":"clips","runId":"clips-…"}`: fetches the recordings that clips run (with the camera, finished, less than an hour old) found missing locally, over Baichuan at low priority (a viewer's download goes first), on `ftp.stream`, the oldest first; at most 50 clips or 200 MB per run (a recording larger than 200 MB is skipped as `too-big`; one that would pass the 200 MB after others is skipped and smaller ones still come), 1 s apart, never past `ftp.maxGB` or while storage is paused; it stops after 3 failures in a row, and at once when the camera refuses a download or is offline (a busy camera Search is tried 3 times, then that clip is skipped as `busy`). A recording the cache can't keep goes through a temp file in `<dataDir>/inventory/tmp`, emptied at startup. The clips are stored like FTP ones with `origin: "camera"`, without an SSE message. 202 `{runId}` (`clipsrepair-…`); 400 `invalid`; 404 `not_found` (no such run); 409 `report_stale`, `not_repairable` or `inventory_busy`; 503 `stopping`. Audited as `inventory-repair` when it ends |
| `POST /control/actions/inventory-repair` (events) | `{"kind":"events","runId":"events-…"}`: adds the events that events run (finished, less than an hour old) found missing. It compares with the camera again and adds only spans that ended by the check's `window.camera.to`: one event per kind per missing span, `source` and `endReason` `recovered`, start and end of the span's recordings, `raw` `{runId, check, recordings, stream, bounds}`; the oldest first, at most 1000 per run (`stopped: "event-cap"`), in one transaction; a span whose kind has an event by then is skipped. Existing events are never changed. 202 `{runId}` (`eventsrepair-…`); 409 `not_repairable` (`no events are missing`), otherwise as for clips. Audited as `inventory-repair` |
| `POST /control/actions/inventory-cancel` | cancels the running inventory: `{cancelled, runId}`; the run keeps its partial counts. Audited as `control-action` |
| `POST /control/actions/archive-clear` | `{"count": N}`: deletes every clip in the [Archive](#archive) when N is the number of clips now; 200 `{cleared, bytes}`; 409 `count_mismatch` `{count}` otherwise; 400 `invalid` without a count. Audited as `archive-clear` |
| `GET /control/inventory` | `{running: {runId, kind, op: "check" or "repair", startedAt, outcome: "running", progress: {phase, done, total, note}} or null, runs: {stills: [the last 10 runs, newest first: {runId, kind, startedAt, tookMs, outcome, counts, message}], clips: […], events: […]}, repairs: {clips: […], events: […]}}` |
| `GET /control/inventory/runs/{id}` | one report: `{runId, kind, op: check\|repair, camera, startedAt, tookMs, outcome: ok\|cancelled\|failed, error, cancelledBy, requestedBy, options, window: {from, to, reason: retention\|budget\|store-younger\|empty\|sd-card, retentionFrom, protectedFrom, notes}, counts, top, items, itemsTruncated, message}` (`notes`: caveats on the counts, such as the clock note when seconds are restorable; stills `counts` include `previewsPruned`, packs without a sprite whose previews were pruned earlier, and `prunedDuringRun`, packs deleted by retention while the run read them, counted as missing; `options: {camera: true}` for a clips compare, whose `counts` add `pairedOtherStream`, recordings here as clips of the other stream, and `prunedHere`, recordings older than the oldest local clip while the storage budget prunes clips, both never offered). The window `reason` `sd-card` is an events check's: the SD card's reach, shorter than `retention.eventsDays`; a clips compare and an events check add `camera: {stream, to, oldestSdDay, unknownDays}` to the window, an events check also `eventsDays`. An events check's items: `missing-event` `{kind, start, end, date, recordings}` oldest first, then `event-without-recording` `{eventId, kind, start, end, source}`. A repair's report has `source` (the clips or events check run it worked from), `stopped` (`clip-cap`, `byte-cap`, `max-gb`, `paused`, `failures`, `refused`, `camera_offline`, `event-cap` (an events repair: more than 1000 missing) or null); an events repair has one item per event added, `{eventId, kind, start, end, result: ok}`; a clips repair one per recording tried: `{id, start, result: ok\|skipped\|failed, reason, error, clipId, bytes, streamed}` (`reason` of a skip: `outside-retention`, `already-local`, `gone-from-camera`, `other-stream`, `viewer`, `invalid`, `too-big`, `byte-cap`, `busy`, `still-recording` (a recording that starts at 23:55 or later, listed with end 000000, before 01:00 the next day); `streamed: true` when it went through `<dataDir>/inventory/tmp`); 400 for a malformed id, 404 for an unknown one. Kept in `<dataDir>/inventory/<kind>/` and repairs in `<dataDir>/inventory/<kind>repair/` (the last 10 each) |
| `GET /control/audit` | the audit log as JSON lines: `limit`, `before`/`after` (cursors), `from`, `to`, `action` (one or more known actions, comma-separated; an unknown one answers 400), `outcome`; admin token, admin session or `CAMPROXY_AUDIT_TOKEN`; HEAD answers like GET without the body. See [docs/audit-log.md](docs/audit-log.md) |
| `GET /control/audit/summary` | `{retentionDays, records}`: `retention.auditDays` and the records kept within it (all actions); same access as `GET /control/audit` |
| `GET /health` | `{ok, version, startedAt}` (no auth): `startedAt` (ms) tells a new process apart |
| `GET /api/local/health` | **local only, no key:** the health summary for a process on the same host (the e-paper display on the Pi). Answered only when the TCP connection comes from `127.0.0.1`, `::1` or `::ffff:127.0.0.1` (never by `X-Forwarded-For` or `server.trustProxy`); any other caller gets what an unknown `/api` route gets (401, or 404 with a token). `{schema: 1, generatedAt, version, startedAt, ok, problemCount, thresholds, platform: {pi, model, hostStats}, items: [{id, label, value, text, problem}], camera, stream, events, ftp, proxy, disk, host}`; no tokens, passwords or FTP settings. The schema: [the plan](docs/superpowers/plans/2026-10-03-health-summary.md#the-api-schema). The same object is `health` in `GET /control/status` |
| `GET /control/log?limit` | recent log lines (info and above), redacted; default limit 100, buffer holds the last 500 |
| `POST /control/login` / `logout`, `GET /control/session` | the admin UI's session cookie (`camproxy_session`, HttpOnly, SameSite=Strict, 12 h; 40 sign-ins per 15 min) |
| `POST /control/login-links`, `GET /control/login-link?code=` | a one-time sign-in link (admin token; the code works once, for 60 s, and is kept only in memory): cams opens the UI with it for a signed-in user |

The **admin UI** at `/` signs in with the admin token once; the token is
exchanged for the cookie and not stored in the browser.
Its navigation works like cams: a sidebar with labels that "Collapse" shrinks
to icons (remembered per browser). On phones (767 px and narrower) a hamburger
at the top left opens the menu as a drawer over the page; its footer has what
the phone top bar leaves out (the camera's model, firmware and version, and
"updated … ago"), the theme toggle and Sign out.

- **Status:** a Health card first (one line per item of the health summary,
  red when it is a problem, and "All OK" or "N problems"), then the camera
  (and its model, linked to the camera's own web page), events, analytics,
  stills, clips/FTP, recordings (SD card), storage (with the data volume's
  "Disk used"), the Archive (with its WARNING above `archive.warnPercent`) and the stream. On a Raspberry Pi a Pi card shows the model, CPU temperature,
  under-voltage, memory, uptime, load and disk. The cards mark the same items
  red as the Health card: one summary decides, with the thresholds
  `health.diskPercent` and `health.tempC`. The same summary is
  `GET /api/local/health`, which the Pi's e-paper display
  ([cam-proxy-pi-display](https://github.com/klaushofrichter/cam-proxy-pi-display))
  draws.
- **Events:** the live stream and the last 100 events.
- **Timeline:** a day of preview sprites, one still per minute, with events
  marked.
- **Clips:** a day's clips with their snapshots and the kinds of the events
  they cover, each once with a count ("motion ×3"), playable, updating as new
  clips arrive.
- **Audit:** who did what, newest first, 50 per page, filtered by action
  and outcome; click a row for its JSON.
- **Settings:** every setting with its source; changes become overrides, and
  can be reset. "Camera name (stored on the camera)" is the camera's own
  name: checked against the camera's rules as you type and saved on the
  camera through `PUT /control/camera/name`. A PoE switch card shows the configured switch and its last
  reading, with "Read the switch now".
- **Maintenance:** the actions, including the camera FTP buttons; the log
  updates every 10 s. "Reboot camera", "Power-cycle camera" (only with a PoE
  switch configured) and "Restart proxy" ask first, in a dialog on the page
  (Cancel or Esc sends nothing). "Turn camera PoE on" (with a switch) turns
  the camera's PoE on if it is off, and a red line warns while it may be off.
  After a reboot the page shows "Rebooting…"
  and the camera's state until it answers again (a power-cycle shows
  "Power-cycling…" while the PoE is off first); after a
  restart it shows "Restarting…", waits for `/health` to answer with a new
  start time or version, and reloads (sign in again: sessions end with the
  process). After 2 minutes without the proxy it says so.
  "Clear the Archive…" deletes every archived clip; its dialog shows the
  count, and its button works only once that number is typed.
  The Inventory box's "Check stills" checks the stills of the retention
  window in the background: the missing seconds, the 10 longest gaps and
  whether a proxy stop or crash, a camera reboot or a power cycle, or a
  storage pause (disk full) explains them, the missing seconds a local clip
  covers (not restored yet, #73), and unreadable packs or sprites without their pack (the first 10
  with their minute). It shows the progress (with Cancel) and the newest
  result, also of a run started in another tab (it polls every 10 s).
  "Check stills" and "Check clips" only read; the two "Search for and …"
  buttons change data, each after a confirmation.
  "Check clips" checks the clips of the retention window (rows without
  their file, files without a row, snapshots no clip links, recording
  events without a clip, clips without an event); "Search for and retrieve
  missing clips" also pairs them with the SD card's recordings on
  `ftp.stream`, and when that compare ends with recordings missing here it
  asks "Retrieve N clips (x MB) from the camera?". Confirmed, it fetches them
  from the SD card (at most 50 or 200 MB per run); the Clips page marks them
  "from camera". Cancelled, the button "Retrieve N missing clips" stays under
  the result for an hour. With nothing missing it says "Nothing to
  retrieve".
  "Search for and add missing events" compares the stored events with the SD card's recordings
  (the camera's own record of what it saw) in the SD card's reach, at most
  `retention.eventsDays`: per trigger kind, a recording (overlapping ones
  merged) needs an event of its kind from 10 s before its start to 5 s after
  its end. When the check ends with events missing it asks to add them
  (Cancel leaves the button "Add N missing events" for an hour; with nothing
  missing it says "Nothing to add."); confirmed, it adds them (at most 1000 per run), as
  events with `source: "recovered"`, marked on the Events page and the
  Timeline. They send no SSE message, never reach Vision (never analysed),
  and don't count in the FTP stall check or the daily event counts. A
  repair's events can be removed by its run id: `DELETE FROM events WHERE
  source = 'recovered' AND json_extract(raw, '$.runId') = '<eventsrepair-…>'`
  in the catalog. Events deleted while the SD card still holds their
  recordings come back as recovered with the next repair: after
  `retention.eventsDays` was shortened and raised again, or after a reset
  catalog. They stand for real recordings, not phantoms.
- **Top bar:** the title links to the GitHub repo; badges for the camera
  online state and event intake; the camera's model (linked to
  `camera.webUiUrl`) · firmware · version; "updated … ago"; Refresh, the
  theme toggle and Sign out.

## Audit log

The proxy records who did what, as ECS JSON lines, one file per UTC day in
`<dataDir>/audit`, kept `retention.auditDays` (90) days:
- start and stop, restarts, camera reboots, sign-ins (with failures), sign-outs, login links;
- refused tokens, throttled to one record per IP and path per 10 minutes;
- control actions and settings changes (secret values redacted);
- inventory runs and repairs, with their counts;
- still checks and every automatic Vision analysis of an event (`event-analysis`, by `system`: what was found, how long it took, the calls made);
- every change to the Archive (added, changed, deleted, cleared, expired), with the person cams names;
- changes of the camera's FTP upload (on, off, pointing elsewhere);
- a storage snapshot and an activity summary at 00:05 camera time.

Read it on the admin UI's **Audit** page, or at `GET /control/audit` with the
admin token or the optional read-only `CAMPROXY_AUDIT_TOKEN`. In the cluster
the records also reach Grafana Cloud Loki through the pod logs. The format,
the API, polling and Grafana are in [docs/audit-log.md](docs/audit-log.md).

## Metrics

`GET /metrics` gives Prometheus text, without auth and counts only:
- `camproxy_disk_bytes{kind}`, `camproxy_disk_free_bytes`,
  `camproxy_disk_size_bytes`;
- `camproxy_events_total`, `camproxy_events_stored` (live events per kind;
  recovered ones are left out, as in the status's `events.stored`);
- `camproxy_onvif_subscribed`, `camproxy_onvif_resubscribes_total`;
- `camproxy_camera_up`, `camproxy_camera_request_seconds`,
  `camproxy_camera_errors_total`;
- `camproxy_sse_clients`, `camproxy_sse_messages_total`,
  `camproxy_stream_log_rows`;
- `camproxy_stills_total`, `camproxy_stills_missing_total`,
  `camproxy_last_still_timestamp_seconds`, `camproxy_stills_minutes_stored`,
  `camproxy_previews_stored`;
- `camproxy_frame_grabber_up`, `camproxy_go2rtc_up`;
- `camproxy_camera_ftp_enabled` (1/0, no sample before the first read),
  `camproxy_clips_stalled`, `camproxy_clips_last_received_timestamp_seconds`
  (while `ftp.enabled`);
- `camproxy_recording_downloads_total{cam,stream,result,priority}` (recordings over
  Baichuan; `result` `ok`, `offline`, `refused`, `auth`, `timeout`,
  `protocol` or `not_found`; `priority` `high` for a viewer, `low` for an
  inventory repair);
- `camproxy_disk_files{kind}`, `camproxy_storage_budget_bytes`,
  `camproxy_storage_growth_bytes_per_day{kind}`,
  `camproxy_storage_days_until_full`, `camproxy_storage_writing_paused`;
- `camproxy_retention_deleted_total`,
  `camproxy_retention_last_run_timestamp_seconds`;
- `camproxy_build_info`.

## Deployment

One image, `ghcr.io/klaushofrichter/cam-proxy`, for linux/amd64 and
linux/arm64. It holds Node 26, go2rtc and ffmpeg, and runs as uid 1000. It
needs a `config.json` (`CAMPROXY_CONFIG`) whose `server.dataDir` is the `/data`
volume, plus the `CAMPROXY_*` secrets. `scripts/container-smoke.sh` builds it
and checks it as the cluster runs it.

- **Branches:** a merge to `main` publishes `:main` and `:sha-<sha>`. A merge
  to `production` releases `v<YYYY.MM.DD.N>` and `:latest`, and deploys to
  the cluster (see below).
- **Cluster** (next to `cam2`, `https://cam-proxy.skylar.technology`, LAN
  only):
  - The manifests live in kube-setup ([request](deploy/cluster/REQUEST.md)).
  - The ConfigMap is [`deploy/cluster/config.json`](deploy/cluster/config.json);
    its camera is `cam2`, and clips come from the sub stream
    (`ftp.stream: "sub"`).
  - The release job pins the image digest in kube-setup, pushes, applies,
    waits for the rollout, and checks that `/health` serves the new version.
  - Secrets: `scripts/sync-secrets.sh --env-file .env.cluster --only all`.
- **Raspberry Pi** (next to the real camera): [`compose.yaml`](compose.yaml)
  with host networking and `/data` on the SSD, prepared by
  [`scripts/prepare-pi.sh`](scripts/prepare-pi.sh). A release doesn't update
  it: run `docker compose pull && docker compose up -d` on the Pi. See
  [docs/raspberry-pi.md](docs/raspberry-pi.md). The Pi also runs
  [cam-proxy-pi-display](https://github.com/klaushofrichter/cam-proxy-pi-display),
  a systemd service that reads `GET /api/local/health` over loopback (host
  networking makes it reachable) and needs no token.

## Development

```sh
scripts/install-go2rtc.sh && scripts/install-mediamtx.sh   # tools/ for the tests
npm test            # vitest, against cam-sim in process (needs ffmpeg)
npm run test:e2e    # Playwright (Chrome) against a proxy and a cam-sim; one sign-in (e2e/auth.setup.ts) serves all specs
npm run lint:types && npm run check
npm run schema      # regenerate config.schema.json after changing a setting
```

- **Real camera:** `npx tsx scripts/verify-camera.ts [seconds]` runs the
  proxy against the real camera. It is read-only: it signs in, checks status,
  subscribes to ONVIF, and runs the stills pipeline (reporting stills per
  minute, size and go2rtc's single connection). Then it unsubscribes, logs out
  and deletes its temporary data. It signs in as the
  camera user `proxy` (password `CAMPROXY_CAMERA_PASSWORD` in `.env`), with the
  camera address from `~/Development/reolink/.env`.
- **Real camera, clips:** `npx tsx scripts/verify-camera.ts --ftp [seconds]`
  changes the camera: it points the camera's FTP at this Mac's LAN address,
  runs the camera's FTP test, waits for a real motion clip and reports it,
  then turns the camera's FTP off. `npx tsx scripts/camera-ftp-off.ts` turns
  it off on its own (after an interrupted run).
- **CI:** tests, e2e, type checks, `npm audit`, CodeQL, a check that no
  media file is committed, and a container smoke test
  (`scripts/container-smoke.sh`, building the image and checking it as the
  cluster runs it). `production` requires `test`, `e2e` and `codeql` (strict,
  with an owner override).

## cams integration

[cams](https://github.com/klaushofrichter/cams) proxies a camera through a
`proxy` entry in its `cams-cameras` setting, with a cam-proxy client token.
It relays `/api/stream` to browsers, and its Timeline page and scrub preview
use the proxy's previews and stills. Clips and event thumbnails come from
the proxy first (the camera only when the proxy has none), and Live falls
back to the proxy's stills when live video isn't playing. See the
[cams README](https://github.com/klaushofrichter/cams#readme) for the
`proxy` setting and the rest of its camera configuration.

## Operating the cluster

- `GET /health` returns `{ok, version, startedAt}` (no auth): use it to
  check the running version.
- **Rollback:** re-pin the previous image digest in kube-setup's
  `manifests/cam-proxy/cam-proxy-deployment.yaml`, then commit, push and
  apply.

MIT licence.
