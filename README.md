# cam-proxy

A gateway next to a Reolink camera (RLC-1224A). It becomes the camera's only
client, keeps what matters, and serves it through a clean API with a live,
resumable Server-Sent Events stream. Apps such as
[cams](https://github.com/klaushofrichter/cams) no longer depend on the
camera's quirks (one search at a time, few logins, broken downloads, no push).

**Status:** phases 1 and 2 are built:
- camera status and ONVIF events, with a polling fallback;
- the event catalog and the resumable SSE stream;
- a still every second and preview sprite sheets through go2rtc;
- storage management;
- the client API, control API and admin UI (with a timeline).

Clips, the cams integration and deployment follow; see
the [design spec](docs/superpowers/specs/2026-09-27-cam-proxy-design.md) and
the [requirements](docs/requirements.md).

Targets: a Raspberry Pi 4 next to the real camera, and the k3s cluster next to
`cam2` (a [cam-sim](https://github.com/klaushofrichter/cam-sim) simulated
camera), both production. A Mac runs it for development on `localhost:8480`.

## Contents

- [Quick start (Mac, against cam-sim)](#quick-start-mac-against-cam-sim)
- [Configuration](#configuration)
- [Client API](#client-api)
- [Stills and previews](#stills-and-previews)
- [Storage management](#storage-management)
- [Event stream (SSE)](#event-stream-sse)
- [Control API and admin UI](#control-api-and-admin-ui)
- [Metrics](#metrics)
- [Development](#development)

## Quick start (Mac, against cam-sim)

```sh
npm ci
scripts/install-go2rtc.sh          # go2rtc 1.9.14 into tools/ (checksums pinned)
npm run build                      # server and admin UI
scripts/sync-secrets.sh            # generates CAMPROXY_TOKENS and CAMPROXY_ADMIN_TOKEN into .env
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
- **Live or restart:** most settings apply at once. Camera, go2rtc, stills
  and ONVIF subscription settings apply after a restart; the `restart` action
  applies them without restarting the process. `server.port` and
  `server.dataDir` need a new process.

| Group | Settings (defaults) |
|---|---|
| `server` | `port` (8480), `dataDir` (`data`, relative to the config file), `logLevel` (`info`), `publicUrl` |
| `camera` | `id` (`cam1`), `name` (`Den`), `host` (required), `protocol` (`https`), `tlsName`, `user` (`proxy`), `onvifPort` (8000), `rtspPort` (554), `statusPollS` (30) |
| `events` | `onvif.subscribeMin` (10), `onvif.pullTimeoutS` (30), `poll.enabled` (true), `poll.intervalS` (2), `poll.afterOnvifDownS` (60), `maxOpenMin` (10) |
| `retention` | `stillsDays` (7), `previewsDays` (14), `clipsDays` (7), `eventsDays` (30), `streamLogDays` (7), `intervalMin` (60) |
| `storage` | `maxPercent` (85) or `maxBytes`, `minFreeBytes` (2 GB), `keepHours` |
| `sse` | `maxClients` (50), `queuePerClient` (1000), `pingS` (15) |
| `go2rtc` | `binary` (`go2rtc`), `rtspPort` (18554), `apiPort` (11984); both listen on 127.0.0.1 only |
| `stills` | `enabled` (true), `stream` (`sub`), `intervalS` (1), `size` (`896x512`), `quality` (5), `maxGB` |
| `previews` | `tileSize` (`160x90`), `grid` (`10x6`), `quality` (7), `maxGB` |
| `ftp` | phase 3 |

| Secret (environment, or `<NAME>_FILE`) | |
|---|---|
| `CAMPROXY_TOKENS` | client tokens, comma-separated, at least 32 characters each (a second token allows rotation without downtime) |
| `CAMPROXY_ADMIN_TOKEN` | the control API and admin UI; different from every client token |
| `CAMPROXY_CAMERA_PASSWORD` | the password of the proxy's camera user (`camera.user`) |
| `CAMPROXY_FTP_PASSWORD` | the camera's FTP login to the proxy; required when `ftp.enabled` |

`scripts/sync-secrets.sh` generates the tokens into `.env` (mode 600),
`--rotate <KEY>` replaces one, and it prints names only. Syncing to GitHub and
the cluster comes with deployment.

## Client API

Base URL `http://<host>:8480/api`. Every request needs
`Authorization: Bearer <token>`: a client token, the admin token, or an admin
UI session.
- A missing or wrong token answers 401 `{"error":"unauthorized"}`.
- A token in the URL (`?token=`, `?access_token=`) answers 400
  `{"error":"token_in_url"}`.

Any one client may send 1200 requests a minute; more answer 429
`{"error":"rate_limited"}`. Timestamps are unix milliseconds. The full schema is in
[openapi.yaml](openapi.yaml).

```sh
api() { curl -s -H "Authorization: Bearer $CAMPROXY_TOKEN" "http://localhost:8480/api$1"; }
api /cameras
# [{"id":"cam1","name":"Den","online":true,"lastEventTs":1790000000000,"stream":null}]
api '/cameras/cam1/events?kind=person&limit=10'
# [{"id":12,"kind":"person","source":"onvif","start":1790000000000,"end":1790000004000,"endReason":"state"}]
```

- `GET /api/cameras`: the camera and whether it answers.
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
when the proxy comes back. On the real camera a still is about 24 KB, about
2 GB a day.

| Route | |
|---|---|
| `GET /api/cameras/{cam}/stills?from&to` | timestamps with a still (at most a day) |
| `GET /api/cameras/{cam}/stills/{ts}.jpg` | one still; `immutable` caching once its minute is complete |
| `GET /api/cameras/{cam}/previews?from&to` | `[{minute, cols, rows, tileW, tileH, intervalS, present, url}]` |
| `GET /api/cameras/{cam}/previews/{minute}.jpg` | one minute's sprite sheet |

A browser scrubbing a day loads one sprite per minute and shows a tile with
CSS (`background-position`). The admin UI's **Timeline** page does this. The
SSE type `still` announces each new still live, only to clients that ask with
`types=still`, without an id and without replay.

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
written, counted as `camproxy_stills_missing_total`. Writing resumes on its
own when space is back.

The storage run is hourly (`retention.intervalMin`). `POST
/control/actions/retention-run` runs it now, and `{"dryRun":true}` previews
what it would delete. `/control/stats` shows usage per kind, growth per day,
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
  - `camera-event`: `{cam, eventId, kind, phase: start|end, ts, source}`;
  - `camera-status`: `{cam, online, reason, clockOffsetMs}`;
  - `clip`, `annotation`: later phases;
  - `still`: only when named in `types`, because it fires every second.
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
| `GET /control/status` | camera, event intake (ONVIF state, source, re-subscriptions), SSE clients, last retention |
| `GET /control/stats` | disk (catalog, free, size), events stored per kind, stream log rows, storage budget |
| `GET /control/config` | every setting: `{value, source, restart, pending, next?}`; secrets never appear |
| `PUT /control/config` | overrides, e.g. `{"sse":{"pingS":10}}`; a bad value answers 400 naming it, and nothing is written |
| `DELETE /control/config/{path}` | removes one override |
| `POST /control/actions/{name}` | `onvif-resubscribe`, `camera-test`, `retention-run` (`{"dryRun":true}` previews), `restart` |
| `GET /control/log?limit` | recent log lines (info and above), redacted |
| `POST /control/login` / `logout`, `GET /control/session` | the admin UI's session cookie (`camproxy_session`, HttpOnly, SameSite=Strict, 12 h; 20 sign-ins per 15 min) |

The **admin UI** at `/` signs in with the admin token once; the token is
exchanged for the cookie and not stored in the browser.

- **Status:** camera, events, storage and stream.
- **Events:** the live stream and the last 100 events.
- **Settings:** every setting with its source; changes become overrides, and
  can be reset.
- **Maintenance:** the actions and the log.

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
- **CI:** tests, e2e, type checks, `npm audit`, CodeQL, and a check that no
  media file is committed. `production` requires the tests and CodeQL.

MIT licence.
