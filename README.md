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

## Contents

- [Quick start (Mac, against cam-sim)](#quick-start-mac-against-cam-sim)
- [Configuration](#configuration)
- [Client API](#client-api)
- [Stills and previews](#stills-and-previews)
- [Clips (FTP)](#clips-ftp)
- [Storage management](#storage-management)
- [Event stream (SSE)](#event-stream-sse)
- [Control API and admin UI](#control-api-and-admin-ui)
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
  default, then file, then override.
- **Live or restart:** most settings apply at once. Camera, go2rtc, stills,
  previews, the ONVIF subscription settings and most FTP settings (all but
  `ftp.stream` and `ftp.maxGB`) apply after a restart; the `restart` action
  applies them without restarting the process. `server.port` and
  `server.dataDir` need a new process.

| Group | Settings (defaults) |
|---|---|
| `server` | `port` (8480), `dataDir` (`data`, relative to the config file), `logLevel` (`info`), `publicUrl` (where people reach this proxy; reported in `/api/cameras` as `publicUrl`, so cams can link to it), `trustProxy` (0: none; behind the cluster ingress 1, so rate limits count clients by X-Forwarded-For) |
| `camera` | `id` (`cam1`), `name` (`Den`), `host` (required), `protocol` (`https`), `tlsName`, `webUiUrl` (the camera's own web page, linked from the admin UI; default `https://<host>/`, `none` for no link), `user` (`proxy`), `onvifPort` (8000), `rtspPort` (554), `statusPollS` (30) |
| `events` | `onvif.subscribeMin` (10), `onvif.pullTimeoutS` (30), `poll.enabled` (true), `poll.intervalS` (2), `poll.afterOnvifDownS` (60), `maxOpenMin` (10) |
| `retention` | `stillsDays` (7), `previewsDays` (14), `clipsDays` (7), `eventsDays` (30), `streamLogDays` (7), `intervalMin` (60) |
| `storage` | `maxPercent` (85) or `maxBytes`, `minFreeBytes` (2 GB), `keepHours` (per kind: `stills` 24, `clips` 24, `previews` 72) |
| `sse` | `maxClients` (50), `queuePerClient` (1000), `pingS` (15) |
| `go2rtc` | `binary` (`go2rtc`), `rtspPort` (18554), `apiPort` (11984); both listen on 127.0.0.1 only; `url` (reserved, not used yet: for a go2rtc that runs as its own container) |
| `stills` | `enabled` (true), `stream` (`sub`), `intervalS` (1), `size` (`896x512`), `quality` (5), `maxGB` |
| `previews` | `tileSize` (`160x90`), `grid` (`10x6`), `quality` (7), `maxGB` |
| `ftp` | `enabled` (false), `port` (2121), `passive` (`30000-30009`), `publicHost` (the address the camera connects to), `user` (`camera`), `tls` (true), `certFile`/`keyFile` (else a self-signed certificate), `stream` (`main`), `maxGB` |

| Secret (environment, or `<NAME>_FILE`) | |
|---|---|
| `CAMPROXY_TOKENS` | client tokens, comma-separated, at least 32 characters each (a second token allows rotation without downtime) |
| `CAMPROXY_ADMIN_TOKEN` | the control API and admin UI; different from every client token |
| `CAMPROXY_CAMERA_PASSWORD` | the password of the proxy's camera user (`camera.user`) |
| `CAMPROXY_FTP_PASSWORD` | the camera's FTP login to the proxy; required when `ftp.enabled` |

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

## Client API

Base URL `http://<host>:8480/api`. Every request needs
`Authorization: Bearer <token>`: a client token, the admin token, or an admin
UI session.
- A missing or wrong token answers 401 `{"error":"unauthorized"}`.
- A token in the URL (`?token=`, `?access_token=`) answers 400
  `{"error":"token_in_url"}`.

Any one client may send 1200 requests a minute, plus 6000 image requests
(stills, sprites and clip files — `clips/<id>.mp4` and `clips/<id>.jpg` — a
day on a timeline is up to 1440 sprites); more answer 429
`{"error":"rate_limited"}`. Timestamps are unix milliseconds. The full schema is in
[openapi.yaml](openapi.yaml).

```sh
api() { curl -s -H "Authorization: Bearer $CAMPROXY_TOKEN" "http://localhost:8480/api$1"; }
api /cameras
# [{"id":"cam1","name":"Den","online":true,"lastEventTs":1790000000000,"stream":{"up":true,"lastFrameTs":1790000000000}}]
api '/cameras/cam1/events?kind=person&limit=10'
# [{"id":12,"kind":"person","source":"onvif","start":1790000000000,"end":1790000004000,"endReason":"state"}]
```

- `GET /api/cameras`: the camera and whether it answers; `stream` is `null`
  only when stills are off.
- `GET /api/cameras/{cam}/events?from&to&kind&limit`: events, newest first,
  at most 1000.
  - `source` is `onvif`, or `poll` for the fallback.
  - `endReason` is `state` (the camera said so), `timeout` (still open after
    `events.maxOpenMin`) or `restart` (the proxy stopped while it was open).
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
  The camera's `.jpg` with the same name becomes the clip's snapshot. A
  `clip` stream message follows, with the events the clip covers.
- **Camera setup:** `POST /control/actions/camera-ftp-setup` writes the
  camera's whole FTP object (the proxy at `ftp.publicHost`, uploads on
  motion and people/vehicle/pet detections, all hours).
  `camera-ftp-test` asks the camera to connect (`{ok, rspCode}`), and
  `camera-ftp-off` sets `enable` to 0 with the rest kept. The Maintenance
  page has the three buttons.
- **API:** `GET /api/cameras/{cam}/clips?from&to` (at most 31 days) lists
  `{id, start, end, stream, size, events, url, snapshotUrl}`;
  `/clips/{id}.mp4` serves the file with HTTP Range, `/clips/{id}.jpg` the
  snapshot. The admin UI's Clips page plays them.
- **Composed clips:** `POST /api/cameras/{cam}/compositions`
  `{clipId, preS, postS, size, badge, timeZone?}` composes a clip with a pre-/post-roll
  (−600…60 s each, at most 60 s in all). Each second comes from the clip,
  another clip, that second's still, or a "No recording" card; still and card
  seconds can carry a "STILLS 1 FPS" badge. H.264 10 fps, sizes `sd`, `360p`,
  `720p`, `1080p`. One encoding runs at a time (3 may wait); poll
  `GET …/compositions/{id}` for progress, fetch `…/{id}.mp4`, and
  `DELETE …/{id}` cancels. A job nobody polls for 30 s stops, and results
  are removed after 15 minutes, and one running over 5 minutes fails. Each clip
  part and each run of stills and cards is a small encode of its own (two
  encoder threads), joined without encoding again: about 120 MB peak at SD,
  280 MB at 1080p. Cards show the time in `timeZone` (the viewer's), else the
  process's. The font comes from `composition.font`, else DejaVu Sans (the
  container) or Arial (macOS).
- **Firewall:** the camera connects to the proxy, on `ftp.port` and the
  `ftp.passive` ports. On a Mac with the firewall on, node must be allowed
  to accept incoming connections, again after each Homebrew node upgrade
  (see [The macOS firewall and node](#the-macos-firewall-and-node)).

## Storage management

Two limits apply, and whichever is reached first wins:
- **Age per kind:** `retention.stillsDays` (7), `previewsDays` (14),
  `clipsDays`, `eventsDays` (30), `streamLogDays`, in whole UTC days.
- **Size budget:** `storage.maxPercent` (85 % of the disk) or
  `storage.maxBytes`, catalog included, and optional per-kind caps
  (`stills.maxGB`, …). Over budget, the oldest hour goes first: stills, then
  clips, then previews. The newest `storage.keepHours` of a kind are never
  deleted for the budget.

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
  - `annotation`: reserved, not sent yet;
  - `still`: `{cam, ts, url, sprite, tile}` (the still's URL, its minute's
    sprite sheet, and the tile index within it); only when named in `types`,
    because it fires every second.
- **Filters:** `types` and `kinds` (e.g. `kinds=person,vehicle`) are comma
  lists.
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

## Control API and admin UI

`/control` needs the admin token, or an admin UI session.
- A client token answers 403 `{"error":"admin_only"}`.
- Writes with the session cookie need `X-CamProxy-UI: 1`.

| Route | |
|---|---|
| `GET /control/status` | `{version, camera (incl. webUiUrl), intake, sse, stream: {enabled, up, go2rtcUp, lastFrameTs}, retention, storage: {paused}, ftp: {enabled, listening, port, tls, publicHost, passwordSet, lastUpload, lastClip, clips, failures}}` |
| `GET /control/stats` | `{disk: {catalog, stills, previews, clips}` (each `{bytes, files, oldest, newest, growthPerDay}`), `events, stream, sse, storage}` |
| `GET /control/config` | every setting: `{value, source, restart, pending, next?}`; secrets never appear |
| `PUT /control/config` | overrides, e.g. `{"sse":{"pingS":10}}`; a bad value answers 400 naming it, and nothing is written |
| `DELETE /control/config/{path}` | removes one override |
| `POST /control/actions/{name}` | `onvif-resubscribe`, `restart` (202, started); `camera-test`, `retention-run` (`{"dryRun":true}` previews); `camera-ftp-setup`, `camera-ftp-test` (409 `not_configured` without `ftp.publicHost` or the FTP password), `camera-ftp-off`; any camera call that fails answers 502 `camera_error` |
| `GET /control/log?limit` | recent log lines (info and above), redacted; default limit 100, buffer holds the last 500 |
| `POST /control/login` / `logout`, `GET /control/session` | the admin UI's session cookie (`camproxy_session`, HttpOnly, SameSite=Strict, 12 h; 20 sign-ins per 15 min) |
| `POST /control/login-links`, `GET /control/login-link?code=` | a one-time sign-in link (admin token; the code works once, for 60 s, and is kept only in memory): cams opens the UI with it for a signed-in user |

The **admin UI** at `/` signs in with the admin token once; the token is
exchanged for the cookie and not stored in the browser.

- **Status:** the camera (and its model, linked to the camera's own web
  page), events, stills, clips/FTP and storage.
- **Events:** the live stream and the last 100 events.
- **Timeline:** a day of preview sprites, one still per minute, with events
  marked.
- **Clips:** a day's clips with their snapshots, playable, updating as new
  clips arrive.
- **Settings:** every setting with its source; changes become overrides, and
  can be reset.
- **Maintenance:** the actions, including the camera FTP buttons; the log
  updates every 10 s.
- **Top bar:** the title links to the GitHub repo; badges for the camera
  online state and event intake; the camera's model (linked to
  `camera.webUiUrl`) · firmware · version; "updated … ago"; Refresh, the
  theme toggle and Sign out.

## Metrics

`GET /metrics` gives Prometheus text, without auth and counts only:
- `camproxy_disk_bytes{kind}`, `camproxy_disk_free_bytes`,
  `camproxy_disk_size_bytes`;
- `camproxy_events_total`, `camproxy_events_stored`;
- `camproxy_onvif_subscribed`, `camproxy_onvif_resubscribes_total`;
- `camproxy_camera_up`, `camproxy_camera_request_seconds`,
  `camproxy_camera_errors_total`;
- `camproxy_sse_clients`, `camproxy_sse_messages_total`,
  `camproxy_stream_log_rows`;
- `camproxy_stills_total`, `camproxy_stills_missing_total`,
  `camproxy_last_still_timestamp_seconds`, `camproxy_stills_minutes_stored`,
  `camproxy_previews_stored`;
- `camproxy_frame_grabber_up`, `camproxy_go2rtc_up`;
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
  [docs/raspberry-pi.md](docs/raspberry-pi.md).

## Development

```sh
scripts/install-go2rtc.sh && scripts/install-mediamtx.sh   # tools/ for the tests
npm test            # vitest, against cam-sim in process (needs ffmpeg)
npm run test:e2e    # Playwright (Chrome) against a proxy and a cam-sim
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
  cluster runs it). `production` requires the tests and CodeQL.

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

- `GET /health` returns `{ok, version}` (no auth): use it to check the
  running version.
- **Rollback:** re-pin the previous image digest in kube-setup's
  `manifests/cam-proxy/cam-proxy-deployment.yaml`, then commit, push and
  apply.

MIT licence.
