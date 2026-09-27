# cam-proxy: design spec

**Status:** draft for review, 2026-09-27.
**Requirements:** [docs/requirements.md](../../requirements.md) (the camera
gateway design note). This spec turns them into decisions; where they differ,
this spec wins and says why.
**Author:** Klaus Hofrichter, with Claude.

## 1. Purpose and scope

cam-proxy sits next to one Reolink RLC-1224A and becomes its only client. It
keeps what matters (events, a still every second, clips) and serves it through
a clean API with a live, resumable SSE stream. Apps such as cams then no longer
depend on the camera's quirks (one search at a time, limited logins, broken
downloads, no push).

**In scope:** one camera per instance, with a camera id in every path and
table, so more cameras later need no migration.

**Out of scope for now:**
- WebRTC live pass-through, and external image analysis (§18, later phases);
- camera settings through the proxy: cams keeps writing settings directly
  until the proxy covers them (requirements §13);
- the Reolink "Baichuan" protocol (TCP 9000) and camera webhooks. Webhook
  support is unconfirmed on this firmware, and ONVIF works (§5).

## 2. Targets and packaging

| Target | Role | Camera | Form |
|---|---|---|---|
| Raspberry Pi 4B (4 GB, SSD) | production | the real camera (cam1) | Docker Compose: the cam-proxy image plus go2rtc's official image |
| k3s cluster | production | cam2 (cam-sim) | the same image; manifests in kube-setup; `cam-proxy.skylar.technology` |
| Mac (Apple Silicon) | development only | cam-sim locally, or the real camera for checks | native (`npm run dev`), go2rtc and ffmpeg as local binaries; the compose file can be tried too |

- **One image** (linux/arm64 and linux/amd64), configured by one
  `config.json` plus secrets in environment variables (§14), with all data
  under one `/data` volume. What runs next to the
  real camera is exactly what CI built and tested.
- **Docker on the Pi** (decided 2026-09-27): compose with
  `restart: unless-stopped`, host networking (FTP passive ports, later WebRTC),
  and `/data` on the SSD.
- **Local development address:** `http://localhost:8480`. Plain HTTP is fine
  on localhost only.

## 3. Architecture

```
                         ┌───────────────────────── cam-proxy host ─────────────────────────┐
 camera ──RTSP (sub)────▶│ go2rtc: one connection per stream, restreams on 127.0.0.1         │
   │                     │    └──RTSP──▶ frame grabber (ffmpeg) → stills packs + sprites    │
   ├──ONVIF PullPoint───▶│ event intake ─┐                                                   │
   ├──FTP(S) upload─────▶│ clip intake ──┼──▶ catalog (SQLite) ──▶ stream_log ──▶ SSE        │
   │                     │ camera client ┘        │                                          │
   └──HTTP API◀──────────│ (status polling, FTP setup, fallback event polling)               │
                         │ HTTP server :8480 — /api (clients), /control (admin), /, /metrics │
                         └───────────────────────────────────────────────────────────────────┘
```

One Node process owns everything except go2rtc and ffmpeg, which it starts and
supervises as child processes (on the Pi, go2rtc runs as its own container).

**Source layout** (Node 26, TypeScript, CommonJS, Express 5; the same
conventions as cam-sim):

```
src/config/              config.json + overrides + secrets → validated config (§14)
src/camera/              the Reolink HTTP client (moved from cams server/reolink/), status poller
src/events/              ONVIF PullPoint client, polling fallback, event model
src/catalog/             SQLite schema, migrations, queries
src/stream/              stream_log, SSE fan-out and replay
src/stills/              go2rtc supervisor, frame grabber, packs, sprites, retention
src/clips/               FTP(S) server, clip indexing, Range serving
src/api/                 client API (/api), control API (/control), auth, metrics
web/                     admin UI (Svelte 5 + Vite), built into dist/web
```

## 4. Camera connection

- **HTTP API:** the Reolink client from cams (`server/reolink/`, about 960
  lines) moves here with its tests. It keeps one token, runs one search at a
  time and one transfer at a time, and writes settings as whole objects. It
  carries every quirk measured in `cams/docs/reolink-api.md`. cam-proxy uses
  one camera user of its own (e.g. `proxy`), so its logins don't compete with
  cams'.
- **Status:** a poller calls `GetDevInfo` every 30 s. Online/offline changes
  go to `stream_log` as `camera-status`.
- **Video:** go2rtc holds exactly one RTSP connection per camera stream
  (sub first; main later for clips and live). The frame grabber reads go2rtc's
  local restream, never the camera. go2rtc listens on 127.0.0.1 only, on
  ports that don't clash with cam-sim on the same Mac (RTSP 18554, API 11984).
- **Camera settings:** the `camera` group of `config.json` (§14): host,
  protocol, TLS name, user, ONVIF and RTSP ports. The password is a secret
  in the environment. cam-sim on the Mac uses 8554 for RTSP, which is why the
  port is configurable.

## 5. Events

**Primary source: ONVIF PullPoint** on the camera's port 8000. It was captured
on the real camera on 2026-09-27, and cam-sim reproduces it.

- **Lifecycle:** subscribe (`CreatePullPointSubscription`, 10-minute
  termination), then long-poll `PullMessages` (Timeout PT30S), and `Renew`
  well before expiry.
- **Recovery:** a fault, a dropped connection or `InvalidArgVal` means the
  subscription is gone. This happens on camera reboot and power loss. The
  proxy re-subscribes with backoff (1 s up to 60 s).
- **Initial state:** the first pull after subscribing returns `Initialized`
  messages with every topic's current state. They set the proxy's known state
  but don't create events.
- **Topics to event kinds:** `CellMotionDetector/Motion` and `MotionAlarm`
  map to `motion` (they arrive together, so they are merged).
  `PeopleDetect`, `VehicleDetect` and `DogCatDetect` map to `person`,
  `vehicle` and `pet`. Other topics (`FaceDetect`, `Visitor`, `Package`,
  `Non_Motor_VehicleDetect`) are stored as events of their own name.
- **Event:** a `true` state change opens an event (`start_ts`) and the next
  `false` closes it (`end_ts`). An event still open after 10 minutes is
  closed with `end_reason: timeout`.
- **Fallback: polling** `GetMdState` and `GetAiState` every 2 s. It is used
  only while ONVIF is down for more than 60 s, and ends when ONVIF is back.
  Events record their `source` (`onvif` or `poll`).
- **Where they go:** each event is an `events` row plus `camera-event`
  messages in `stream_log` (phase `start` and `end`).

## 6. Catalog

SQLite in WAL mode via `node:sqlite` (built into Node 26, with FTS5, so there
is no native module to build on the Pi). The file is `/data/catalog.sqlite`.
Images never go into the database.

Tables follow requirements §6, with these changes:

- `events(id, cam, source, kind, start_ts, end_ts, end_reason, raw JSON)`;
  timestamps are unix milliseconds throughout.
- `frames` is **not** a table. A still's location follows from its time
  (§8), which saves 86,400 rows a day.
- `annotations` and `outbox` wait for the external-analysis phase.
  `annotations` is created in phase 1 anyway, empty, so the API shape is
  stable.
- `clips(id, cam, start_ts, end_ts, path, stream, size, received_at)`.
- `stream_log` as in §7.
- A `schema_version` table plus forward-only migrations in code.

## 7. Stream log and SSE (core requirement)

As requirements §11, decided:

- `stream_log(id INTEGER PRIMARY KEY AUTOINCREMENT, ts, cam, type, data JSON)`.
  Everything is written there first, then pushed.
- `GET /api/stream?cam&types&kinds&since`. It resumes from `Last-Event-ID`
  or `?since=`, replays everything newer, then continues live.
- **Too far behind:** a resume id older than the retention answers
  `event: reset` with the oldest id.
- **Types:** `camera-event`, `camera-status`, `clip`, `annotation`, and `still`
  (opt-in only).
- **Keep-alive and headers:** `: ping` every 15 s and `retry: 3000`;
  `Content-Type: text/event-stream`, `Cache-Control: no-store`,
  `X-Accel-Buffering: no`, and a flush after every message.
- **Backpressure:** each client has a bounded queue of 1000 messages. A
  client that falls behind is disconnected, and resumes from its
  `Last-Event-ID` without losing anything. At most 50 clients.
- **Retention:** 7 days, in the same retention job as stills.

## 8. Stills and previews

As requirements §5:

All numbers here are `config.json` settings (§14); the values given are the
defaults.

- **Source:** one ffmpeg reads go2rtc's restream of `stills.stream` (sub)
  and writes two outputs from the same decode:
  - a still every `stills.intervalS` (1 s) at `stills.size` (896×512), JPEG
    quality `stills.quality`;
  - a preview tile at the same moments, at `previews.tileSize` (160×90).
- **Packs:** `/data/stills/<cam>/YYYY/MM/DD/HHMM.pack`: the minute's JPEGs
  concatenated, followed by an offset table with one slot per interval (60 at
  1 s), a header and a magic footer. A missing slot has length 0.
  - **Self-describing:** the header records the interval, size and quality
    the pack was made with. Changing the settings later leaves older packs
    readable; the API reports each minute's own interval. Reading one still is one read of the table and
  one read of the image. The pack being written stays open until the minute
  ends; reads of the current minute come from memory.
- **Sprites:** `/data/previews/<cam>/YYYY/MM/DD/HHMM.jpg`: one sheet per
  minute, a grid of `previews.grid` (10×6 at 1 s) tiles, with the grid and
  tile size recorded in a small `HHMM.json` next to it. ffmpeg streams the tiles to the proxy
  (`image2pipe`). The proxy composes each minute's sheet with `sharp`, whose
  prebuilt binaries cover linux-arm64, Alpine included, so there's no build
  on the Pi. A missing second leaves its tile dark.
- **Times:** stills are keyed by the proxy's clock (UTC, aligned to whole
  seconds), not by the camera's clock. The camera clock's offset is recorded
  in `camera-status`.
- **Retention and disk space:** see §8a.
- **Resilience:** if go2rtc or ffmpeg exits, it restarts with backoff.
  `camera-status` reports `stream: down` after 10 s without a frame.

## 8a. Storage management

The disk fills up eventually: stills alone take about 3–5 GB a day, and
main-stream clips about 1.5 GB. Two limits apply, and whichever is reached
first wins.

**1. Age, per kind.** Each kind has its own retention, set separately:

| Kind | Setting | Default |
|---|---|---|
| stills | `retention.stillsDays` | 7 |
| previews (thumbnail sprites) | `retention.previewsDays` | 14 (they are tiny and keep the timeline usable after the stills are gone) |
| clips | `retention.clipsDays` | 7 |
| events | `retention.eventsDays` | 30 (rows only) |
| stream log | `retention.streamLogDays` | 7 |

**2. Size budget.**

- `storage.maxPercent` (85) of the disk the data is on, or
  `storage.maxBytes`, overall.
- Optional per-kind caps: `stills.maxGB`, `previews.maxGB`, `clips.maxGB`.

When a limit is exceeded, the oldest data goes first, an hour at a time (not
a whole day), in this order:

1. stills;
2. clips;
3. previews.

A per-kind minimum stops any one kind from being wiped out:
`storage.keepHours` (stills 24, clips 24, previews 72). Rows that point at
deleted files (events keep theirs; clips rows go) are cleaned up with them.

**3. Hard floor.** If free space still falls below `storage.minFreeBytes`
(2 GB), for example because another program fills the disk:

- the proxy stops writing: the frame grabber pauses and the FTP intake refuses
  uploads;
- `camera-status` and the metrics say `storage: full`;
- writing resumes on its own once there is room again.

The catalog and the stream log keep working.

**Running it:**

- The storage job runs every `retention.intervalMin` (60), and at once when a
  write pushes usage over the budget.
- Each run records what it deleted, per kind (`camproxy_retention_deleted_total`,
  and the admin UI's log).
- **Visible in advance:** the stats (§13) show usage per kind, growth per day
  (averaged over 3 days), the projected days until the budget is reached, and
  what the next run would delete.
- The admin UI can run it now, or preview a run without deleting anything.

## 9. Clips (FTP intake)

- **Server:** an FTPS server inside the process (a maintained Node FTP server
  library; choosing it is a plan task, and it must pass `npm audit` with no
  high finding in production dependencies).
  - Upload only, with one user (`ftp.user`, password in the environment),
    passive ports `ftp.passive` (30000–30009), on the LAN.
  - Plain FTP is allowed only when `ftp.tls` is `false` (for cam-sim tests).
- **Files:** they land in `/data/clips/<cam>/YYYY/MM/DD/`. The camera's names
  (`<Name>_00_YYYYMMDDHHMMSS.mp4` and `.jpg`) give the start time.
  - Each finished upload is indexed into `clips` and linked to overlapping
    events by time.
  - It is announced as `clip` in `stream_log`.
- **Camera setup:** the control API writes the camera's whole `Ftp` object
  (server, port, user, password, directory, main or sub stream, the schedule)
  and can run the camera's `TestFtp`. This uses the measured rules: the whole
  object, and "off" means `enable: 0` with a server still set.
- **Serving:** `GET /api/cameras/:cam/clips/:id` with HTTP Range and
  `Content-Length`.

## 10. Client API (`/api`)

Bearer token (`CAMPROXY_TOKENS`, a comma list in the environment, so a token
can be rotated without downtime) on everything except `/health` and `/metrics`.

```
GET /api/cameras                                   → [{id, name, online, lastEventTs, stream}]
GET /api/cameras/:cam/events?from&to&kind&limit    → events, newest first
GET /api/cameras/:cam/stills/:ts.jpg               → one still (404 if none)
GET /api/cameras/:cam/stills?from&to               → [{ts}] seconds that have a still
GET /api/cameras/:cam/previews?date                → [{minute, url, cols:10, rows:6, tileW:160, tileH:90, first}]
GET /api/cameras/:cam/previews/:date/:minute.jpg   → one sprite
GET /api/cameras/:cam/clips?from&to                → clips
GET /api/cameras/:cam/clips/:id                    → video/mp4, Range
GET /api/stream?cam&types&kinds&since              → SSE (§7)
```

- Timestamps in and out are unix milliseconds.
- Errors are JSON `{error, detail?}`.
- The whole API is described in `openapi.yaml`, checked against the routes in
  a test, as in cam-sim.

## 11. Control API (`/control`) and admin UI

This follows the cam-sim pattern but is its own app.

- **Auth:** `CAMPROXY_ADMIN_TOKEN`, which is separate from the client tokens.
  cams gets a client token and can't change the proxy. The UI signs in with
  the admin token and gets an HttpOnly, SameSite=Strict session cookie. Writes
  with the cookie need `X-CamProxy-UI: 1`. Sign-in is rate-limited.
- **Routes:**
  - `GET /control/status`: camera, ONVIF subscription, go2rtc, frame grabber,
    FTP and retention states;
  - `GET /control/stats`: the numbers (§13).
  - `GET /control/config`: the effective configuration, with each setting's
    value, its source (`default`, `file` or `override`) and whether a change
    needs a restart. Secrets never appear.
  - `PUT /control/config`: sets overrides (§14), validated like the file.
    `DELETE /control/config/<path>` removes one, back to the file's value.
  - `POST /control/actions/<name>`:
    - `retention-run`, with `{"dryRun": true}` to preview what it would delete;
    - `onvif-resubscribe`;
    - `camera-test`;
    - `camera-ftp-setup` (writes the camera's whole `Ftp` object from `ftp`);
  - `restart`, which applies settings that need a restart;
    - `camera-ftp-test`;
    - `catalog-backup`, which downloads a consistent copy.
  - `GET /control/log`: recent proxy log lines, redacted.

  Credentials and tokens are never settable or readable here.
- **Admin UI** (Svelte 5, built into `dist/web`, served at `/`):
  - **Status:** everything from `/control/status`, live.
  - **Live check:** the latest still, refreshing each second, and the SSE
    stream as a scrolling log.
  - **Timeline:** one day's preview sprites with events marked. Click a
    minute to see its stills. This is the prototype for cams' history view.
  - **Settings and maintenance:** the settings above and the actions.

  It uses cam-sim's theme so the family looks alike.

## 12. Security

- Tokens:
  - at least 32 random bytes;
  - compared in constant time;
  - never logged, never accepted in URLs (`?token=` answers 400).
- Secrets (tokens, camera and FTP passwords) live only in the environment
  (`_FILE` variants for Secrets). They are never in `config.json`, never in
  overrides, never shown or settable in the UI.
- **The FTP intake and the camera** reach the proxy on the LAN only:
  - on the Pi, the host's LAN interface;
  - in the cluster, a LAN-only ServiceLB address, like cam2's gateway ports.
- **Transport:**
  - **Cluster:** the UI and API go through Traefik with a Let's Encrypt
    certificate at `cam-proxy.skylar.technology`, on the LAN only (like
    cam2's UI).
  - **Pi:** plain HTTP on the LAN at first, with TLS through a pushed
    certificate as a later step (requirements §16.9).
- CodeQL and `npm audit` gate every PR, as in cam-sim, with accepted findings
  listed in `.github/codeql-accepted.tsv`.

## 13. Health, statistics and metrics

- **`/health`:** the process is up, with no camera check and no auth.
- **`GET /control/stats`** (admin token or UI session): the numbers below as
  JSON, grouped by area. The admin UI's Status page shows them, and scripts
  can read them. Example:
  `{"disk":{"stills":{"bytes":..,"files":..},"previews":{..},"clips":{..},"catalog":{..},"free":..,"size":..},"stills":{"stored":..,"oldest":..,"newest":..,"perMinute":..},...}`
- **`GET /metrics`:** the same numbers in Prometheus text format, unauthenticated,
  for the cluster's Prometheus. It never includes event content or image data.

| Metric (`camproxy_` prefix) | Type | Labels | Also in `/control/stats` |
|---|---|---|---|
| `disk_bytes`, `disk_files` | gauge | `kind` = stills, previews, clips, catalog | `disk.<kind>` |
| `disk_free_bytes`, `disk_size_bytes` | gauge | | `disk.free`, `disk.size` |
| `storage_budget_bytes` | gauge | | `storage.budget` |
| `storage_growth_bytes_per_day` | gauge | `kind` | `storage.growth.<kind>` |
| `storage_days_until_full` | gauge | | `storage.daysUntilFull` (projected, §8a) |
| `storage_writing_paused` | gauge | | 1 below the hard floor (§8a) |
| `stills_stored` | gauge | `cam` | the number of stills within retention |
| `stills_total` | counter | `cam` | stills written since start |
| `stills_missing_total` | counter | `cam` | seconds with no frame |
| `last_still_timestamp_seconds` | gauge | `cam` | alert when stale |
| `previews_stored` | gauge | `cam` | sprite sheets (one per minute) |
| `frame_grabber_up`, `go2rtc_up` | gauge | `cam` | |
| `events_total` | counter | `cam`, `source` (onvif, poll), `kind` | |
| `events_stored` | gauge | `cam`, `kind` | |
| `onvif_subscribed` | gauge | `cam` | |
| `onvif_resubscribes_total` | counter | `cam`, `reason` | |
| `clips_total`, `clips_stored` | counter, gauge | `cam`, `stream` | |
| `last_clip_timestamp_seconds` | gauge | `cam` | |
| `camera_up` | gauge | `cam` | |
| `camera_request_seconds` | histogram | `cam`, `cmd` | |
| `camera_errors_total` | counter | `cam`, `code` | |
| `sse_clients` | gauge | | |
| `sse_messages_total` | counter | `type` | |
| `sse_replayed_total`, `sse_dropped_clients_total` | counter | | |
| `stream_log_rows` | gauge | | |
| `retention_deleted_total` | counter | `kind` | |
| `retention_last_run_timestamp_seconds` | gauge | | |
| `build_info` | gauge | `version`, `target` (pi, cluster, dev) | |

- **Cheap on a Pi:** the proxy never walks the data folders per request. File
  counts and bytes are kept up to date as files are written and deleted, with
  a full re-count at start and after each retention run. Disk free and size
  come from `statfs`.
- **Per phase:** each metric arrives with its feature. Phase 1 has disk
  (catalog), events, ONVIF, camera, SSE, stream log, retention and build.
  Stills, previews, the frame grabber and go2rtc come in phase 2, clips in
  phase 3.
- **Alerts** (Grafana, next to the cams alerts, in phase 5):
  - disk above 85 %;
  - no still for 2 minutes;
  - camera down for 5 minutes;
  - ONVIF not subscribed for 5 minutes;
  - no clip for a day that had events.

## 14. Configuration

**One central file, `config.json`, holds every setting that isn't a secret.**
Secrets stay in environment variables, so the file can be committed, copied,
or put in a ConfigMap without leaking anything.

- **Where it is:** `./config.json` locally, `/data/config.json` on the Pi, a
  ConfigMap mounted as a file in the cluster. `CAMPROXY_CONFIG` points
  elsewhere.
- **Validated at start** against `config.schema.json` (JSON Schema, shipped
  in the repo, so editors can check and complete the file). An unknown key or
  a bad value stops the start with a message naming the key.
- **Defaults** are in code. The file only needs what differs, typically the
  camera. `config.example.json` shows every setting with its default.
- **Overrides:** the admin UI and `PUT /control/config` store changes in
  `/data/overrides.json`, on top of the file. They survive restarts and
  redeploys; the cluster's ConfigMap is read-only anyway.
  - The effective value is default, then file, then override.
  - The UI shows each setting's source and can remove an override.
- **Live or restart:** some settings apply at once (retention, polling
  fallback, SSE limits, log level). Others need a restart (camera, stills
  size and interval, ports), and the UI says so and offers `restart`.

**Settings** (defaults in brackets):

| Group | Settings |
|---|---|
| `server` | `port` (8480), `dataDir` (`/data` in the image, `./data` locally), `logLevel` (`info`), `publicUrl` (for absolute links, optional) |
| `camera` | `id` (`cam1`), `name` (`Den`), `host` (required), `protocol` (`https`), `tlsName`, `user` (`proxy`), `onvifPort` (8000), `rtspPort` (554), `statusPollS` (30) |
| `go2rtc` | `binary` (`go2rtc`) or `url` (when it runs as its own container), `rtspPort` (18554), `apiPort` (11984) |
| `stills` | `enabled` (true), `stream` (`sub`), `intervalS` (1), `size` (`896x512`), `quality` (5, ffmpeg `q:v`; lower is better) |
| `previews` | `tileSize` (`160x90`), `grid` (`10x6`, must hold one minute of stills), `quality` (7) |
| `events` | `onvif.subscribeMin` (10), `onvif.pullTimeoutS` (30), `poll.enabled` (true), `poll.intervalS` (2), `poll.afterOnvifDownS` (60), `maxOpenMin` (10) |
| `retention` | `stillsDays` (7), `previewsDays` (14), `clipsDays` (7), `eventsDays` (30), `streamLogDays` (7), `intervalMin` (60) (§8a) |
| `storage` | `maxPercent` (85) or `maxBytes`, `minFreeBytes` (2 GB), `keepHours` (`{stills: 24, clips: 24, previews: 72}`); per-kind caps `stills.maxGB`, `previews.maxGB`, `clips.maxGB` (none) |
| `sse` | `maxClients` (50), `queuePerClient` (1000), `pingS` (15) |
| `ftp` | `enabled` (false), `port` (2121), `passive` (`30000-30009`), `user` (`camera`), `tls` (true), `stream` (`main`) |

**Example** (local development against cam-sim):

```json
{
  "camera": { "host": "127.0.0.1:8080", "protocol": "http", "rtspPort": 8554, "onvifPort": 8000, "user": "proxy" },
  "server": { "dataDir": "./data" }
}
```

**Secrets** (environment only):

| Variable | |
|---|---|
| `CAMPROXY_TOKENS` / `_FILE` | client tokens, comma list |
| `CAMPROXY_ADMIN_TOKEN` / `_FILE` | control API and admin UI |
| `CAMPROXY_CAMERA_PASSWORD` / `_FILE` | the proxy's camera user |
| `CAMPROXY_FTP_PASSWORD` / `_FILE` | the camera's FTP login to the proxy; required when `ftp.enabled` |

`scripts/sync-secrets.sh`, as in cam-sim, generates tokens into `.env` and
syncs them to GitHub and the cluster.

## 15. cams integration

cams stays usable without the proxy. Each feature falls back to the camera
directly while the proxy is absent or offline, per feature.

- **Events via SSE:** cams subscribes to `/api/stream` server-side with a
  client token, and relays to its browsers behind Google sign-in. The token
  never reaches a browser. This replaces the 60-second polling of the
  recordings list; new events appear at once.
- **History timeline:** a new view scrubs the preview sprites and shows
  stills, with events marked.
- **Clips:** recordings play from the proxy's FTP clips when the camera's
  Download fails (it currently always fails).
- **Configuration:** cams' camera list gets an optional `proxy`:
  `{url, token}` per camera (the token from its Secret).

## 16. Testing

- **Unit and integration (vitest):** against **cam-sim in process**, a dev
  dependency pinned to a release as in cams.
  - ONVIF events come from cam-sim's event triggers; power-off and reboot
    exercise re-subscription.
  - Stills come from cam-sim's RTSP through a real go2rtc.
  - Clips come from cam-sim's FTP uploads into the proxy's FTP server.
  - SSE resume and backpressure are tested with real HTTP clients.
- **CI installs go2rtc and MediaMTX** (cam-sim's RTSP) with pinned checksums.
- **e2e (Playwright, Chrome):** the admin UI against a proxy plus cam-sim.
- **Real camera:** a read-only verification script checks that the proxy's
  camera user can sign in, the ONVIF subscription works, and one minute of
  stills comes through. Klaus runs it, or it runs with his go-ahead. It
  never changes camera settings except the FTP setup, and only when asked.
- **cams:** its existing suites keep passing. New tests cover the SSE relay
  and fallback against an in-process proxy.

## 17. Repository, CI and releases

Same style as cam-sim:

- **Branches:** `main` plus `production`. A feature PR goes to `main`, then a
  PR from `main` to `production` releases.
- **Branch protection:** the steps-service standard (test and CodeQL,
  strict, enforce admins).
- **Workflows:**
  - `pr-checks`: test, e2e, container, CodeQL, audit, and no media files;
  - `build-push`: a multi-arch image to `ghcr.io/klaushofrichter/cam-proxy`;
  - `release`: tag `vYYYY.MM.DD.N` and deploy to the cluster through a
    self-hosted runner, pinned by digest, as for cam2.
- **Pi deploys:** by hand at first (`docker compose pull && up -d`). Watchtower
  or a pull timer is a later decision.

## 18. Phases

Each phase ends with something usable, released.

1. **Core** (built 2026-09-27, Plan 1; verified read-only against the real camera):
   - config and the camera client;
   - the status poller;
   - ONVIF events with the polling fallback;
   - the catalog and `stream_log` with SSE resume;
   - the events API;
   - auth, `/health` and `/metrics`;
   - the control API with status and actions;
   - a first admin UI (status and live event log).

   Runs natively on the Mac against cam-sim. Verified once against the real
   camera.
2. **Stills and previews** (built 2026-09-27, Plan 2; verified on the real camera): go2rtc supervision, the frame grabber, packs,
   sprites, retention, their APIs, and the admin UI timeline.
3. **Clips:** the FTP(S) intake, camera FTP setup, and the clips API.
4. **cams:** the SSE relay replaces polling, the history timeline, and clips
   from the proxy.
5. **Packaging and deployment:**
   - the image and compose file;
   - the cluster: a kube-setup request, `cam-proxy.skylar.technology`, next
     to cam2;
   - the Pi when it arrives, next to the real camera.
6. **Later:** WebRTC live pass-through, and external analysis with
   annotations and the outbox.

## 19. Open questions

1. The Pi's TLS (requirements §16.9): push a cluster-issued certificate, or
   stay HTTP on the LAN.
2. The external analysis target and budget (phase 6).
3. Whether cams eventually goes proxy-only, with the proxy as the camera's
   only client.
