# Multi-camera cam-proxy on a dedicated host, with routing and a site CA (design)

Status: draft for Klaus's review, 2026-10-05. Design only; nothing is built.
Klaus's decisions of 2026-10-05 (below, "Decisions") are binding; everything
else is a proposal. Klaus answered the open questions the same day
("Answers" below); what is still open is in §18.

Repos touched by the later plans: cam-proxy (most of it), cams (§12), cam-sim
(one measured command, §15), kube-setup (a request, §14). The Pi and
cam-proxy-pi-display need no change (§11).

## Decisions (Klaus, 2026-10-05)

1. **One cam-proxy per host serves several cameras** (e.g. 4), not one proxy
   per camera. The host: a mini PC, Ryzen 5 3500U class (4 cores / 8
   threads), 8 GB RAM, a large NVMe, **two Ethernet ports**: one to the
   cameras' PoE switch (the camera network; the host runs its DHCP), one to
   the LAN.
2. **Routing:** the host routes between the LAN and the camera network; the
   home router gets a static route to the camera subnet via the host.
   Firewall: LAN → cameras allowed; cameras → internet blocked; cameras →
   host only for what they need (FTP, NTP, DHCP). Fixed DHCP leases per
   camera MAC. cams keeps talking to the cameras directly over that route.
3. **cams connects to several proxies, each with one or more cameras**; one
   SSE stream per proxy, not per camera.
4. Out of scope, but not to be blocked: a cams **overview page** (a grid of
   all cameras with slow thumbnails, < 1 frame/s, and one event history for
   all cameras from several SSE feeds).
5. **The Pi stays one camera / one proxy with its e-paper display.** The new
   proxy runs unchanged with a one-camera config: today's `camera` object
   counts as a list of one; the health summary keeps its `camera` field; no
   data migration on the Pi.
6. **One user with all rights** (today's single profile and tokens, shared
   by all proxies and cameras). Multi-user and roles come later: keep a seam,
   build nothing.
7. **Cluster dependency shrinks to cams itself and cams's HTTPS
   certificate.** Camera certificates, the cert-push CronJobs and LAN DNS must
   not need the cluster.
8. **TLS without DNS:** a per-host **site CA** (§10), refined and confirmed
   below.
9. Size the Ryzen host (§9).

## Answers (Klaus, 2026-10-05, later the same day)

1. **cam1 stays on the Pi**, independent of the new host: no shared CA and no
   dependency either way. The Pi keeps its Let's Encrypt certificate through
   the cluster CronJob `cam1-cert-push` for now. "The Pi gets its own site
   CA" is an option for later, not planned (§11).
2. **The site CA is per host, inside cam-proxy**, not a LAN-wide service
   (§10.1).
3. **Camera subnet `192.168.60.0/24`**, behind the host: confirmed.
4. **The camera network gets its own new PoE switch: a second GPS-208**,
   the same model as the Pi's. The Pi's GPS-208 stays with the Pi, and
   there is no VLAN option. The existing driver (`sscpoe-web`) is used, so
   v1 needs no new driver. Switch control stays pluggable, one driver per
   model (§8.4).
5. **Host OS: Linux, installed by us.** Debian 13 is recommended; Ubuntu
   Server 24.04 LTS is an acceptable alternative (§14.0).
6. **The PC arrives in about two weeks.** The multi-camera runtime, the
   host-wide services and the cams mapping are built and tested with several
   cam-sim instances before it arrives. Host setup and TLS come after, on the
   device (§16).
7. **Router:** Klaus can run tests now. A pre-arrival test uses his Mac as a
   stand-in for the host (§14.3).

## 1. Goals and non-goals

Goals:

- One cam-proxy process serves N cameras (tested with 4; nothing caps it at
  4), each with its own camera side (client, status, events, stills, FTP
  clips, recordings, inventory, reboot, power-cycle), isolated so one bad
  camera never stops the others.
- Host-wide services exist once: HTTP server, catalog, go2rtc, FTP server,
  storage budget, Vision budget, PoE switch controller, audit log, archive,
  compositions, site CA.
- Today's one-camera config, API and health JSON keep working byte for byte
  where a client depends on them (the Pi, its display, cams as it is).
- The host is self-sufficient: DHCP, NTP and certificates for its cameras
  come from the host; only cams (and its certificate) stay in the cluster.
- cams maps several of its cameras onto one proxy, with one event stream and
  one TLS trust anchor per proxy.

Non-goals:

- Multi-user, roles, per-camera permissions (a seam only, §6.6).
- The cams overview page itself (§12.5 lists the proxy API that makes it
  cheap; that API is in scope).
- A reverse proxy for the cameras' own web pages (§10.6: not recommended).
- Hardware video decoding/encoding on the Ryzen iGPU (possible later; the
  sizing in §9 doesn't need it).
- Coordinating budgets across hosts (each proxy keeps its own; §8.2).
- Moving cam2 (cam-sim) or the cluster's cam-proxy out of the cluster.

## 2. What is single-camera today (verified)

| Area | Today | Where |
|---|---|---|
| Config | one `camera` object; PoE switch settings inside it | `src/config/schema.ts:28-49` |
| API routing | paths carry `:cam`, but every router compares with the one id and answers 404 | `src/api/client-api.ts:64-67` (same pattern in compose, archive, still-checks) |
| Camera list | `GET /api/cameras` returns `[info()]`, already an array | `src/api/client-api.ts:80` |
| Catalog | `cam` column in events, annotations, clips, stream_log, clip_arrivals, still_checks, archive; **none** in analytics_usage (PK provider, day) and analytics_unmapped | `src/catalog/migrations.ts:6-169`, `:73-78`, `:84-90` |
| Media | `stills/<cam>/…`, `previews/<cam>/…`, `recordings/<cam>/…`; host-wide: `audit/`, `compositions/`, `inventory/`, `ftp/.incoming`, `overrides.json` | `src/storage.ts:81-131`, `src/proxy.ts:146,161,383`, `src/clips/side.ts:60` |
| go2rtc + grabber | one `Go2rtc` per camera side, streams `<cam>_sub`/`<cam>_main`, its own ports | `src/stills/go2rtc.ts:41,61`, `src/proxy.ts:252` |
| Events | one `EventIntake`, one tracker | `src/proxy.ts:241-242` |
| Recordings | one Baichuan target from `camera.host` | `src/proxy.ts:362-366` |
| FTP | one user, one password; every upload goes to the one camera's indexer | `src/clips/side.ts:57-58`, `src/clips/ftp-server.ts:304`, `src/proxy.ts:223` |
| Storage budget | `maxBytes ?? 85 %` of the whole volume, `used` counts only this proxy's files (two proxies on one volume would each claim 85 %) | `src/storage.ts:76-78,159-182` |
| PoE switch | one controller; a second use while busy fails `switch_busy` (the switch itself takes one web session) | `src/camera/poe-switch.ts:420`, `poe-switch-gps208.md` |
| Vision | one monthly limit and daily cap per proxy, counted per provider and day | `src/proxy.ts:525`, `migrations.ts:73-78` |
| Compositions | one encode at a time | `src/proxy.ts:157-163` |
| Health | one `camera` object; the display reads one URL | `src/health/summary.ts:53`, cam-proxy-pi-display README "api.url" |
| SSE | every message carries `cam`; `?cam=` filters | `src/stream/sse.ts:15,28,116` |
| Audit | the camera id is a process-wide label | `src/proxy.ts:146`, `src/audit/audit-log.ts:232` |
| Camera TLS | the proxy verifies the camera by `camera.tlsName` (public CAs) | `src/proxy.ts:229` |
| Proxy TLS | plain HTTP only (port 8480); the Pi's proxy is reached by the cluster's cams at `http://192.168.1.220:8480` with the bearer token in clear on the LAN; the cluster proxy sits behind the ingress | `src/proxy.ts:801`, memory note cam-proxy-project |
| Networking | `network_mode: host` | `compose.yaml` |

cams (verified):

- Each `cameras.json` entry has `proxy {url, token, adminToken?, camera?}`;
  `camera` is the proxy's id for that camera (`server/cameraRegistry.ts:28`).
- The SSE relay is **one `ProxyStream` per cams camera**, which drops
  messages for other cameras (`server/proxy/stream.ts:156-157,178-185`): four
  cameras on one proxy would open four upstream streams and receive every
  message four times.
- The archive groups proxies by url + token, reached `via` the first cams
  camera of the group (`server/proxy/archive.ts:20-29`).
- cams talks to the camera directly for live FLV, Snap, status,
  settings/device/light/reboot, rename (without an adminToken), the composed
  clip's time stamp, recordings `timeInfo` and fallbacks, and the web UI
  link. Camera TLS is verified only when `tlsServername` is set
  (`server/reolink/http.ts:56`), against public CAs; `tlsCa` exists only as a
  test seam (`server/reolink/client.ts:100`).

Certificates (verified): cam1 serves a Let's Encrypt certificate for
`cam1.skylar.technology`, issued in the cluster by HTTP-01 and pushed daily by
the `cam1-cert-push` CronJob running `push_cert.py` (CertificateClear, wait,
login, ImportCertificate, success judged only by the served fingerprint). The
measured firmware facts: "Use an RSA key"; the file names must be
`server.crt` / `server.key`; an import over an installed certificate returns
200 and changes nothing. No key size limit was measured; RSA 2048 (cert-manager's
default) works. cam-sim implements GetCertificateInfo, CertificateClear and
ImportCertificate and serves the imported certificate. Neither cams nor
cam-proxy nor cam-sim knows the NTP commands yet.

## 3. Architecture

```
                    ┌──────────────────────────── mini PC ─────────────────────────────┐
 LAN 192.168.1.0/24 │ enp1s0 (LAN)                              enp2s0 (camera net)    │  PoE switch
 ── cams (cluster) ─┼─▶ cam-proxy :8443 (HTTPS, site cert)        192.168.60.1/24 ───────┼──▶ cam3 .13
 ── browsers ───────┼─▶ routed (nftables) ───────────────────────────────────────────────┼──▶ cam4 .14
                    │                                                                     │    cam5 .15
                    │ cam-proxy (one Node process)                                        │    cam6 .16
                    │  host-wide: HTTP(S) server, catalog, SSE, storage, Vision budget,   │
                    │             go2rtc (one process, 2 streams per camera), FTP server, │
                    │             PoE switch controller, site CA + cert manager, audit,   │
                    │             archive, compositions (2 at a time)                     │
                    │  per camera: CameraWorker { client, status, intake, grabber,        │
                    │             recordings/Baichuan, ftp watch, inventory checks,       │
                    │             reboot/power-cycle, cert state }                         │
                    │ dnsmasq (DHCP, camera side only) · chrony (NTP for the cameras)     │
                    └─────────────────────────────────────────────────────────────────────┘
```

### 3.1 Per-camera workers

Today's `buildCameraSide` / `startCameraSide` / `stopCameraSide`
(`src/proxy.ts:226-332`) become a `CameraWorker` class, one per configured
camera, holding what is camera-specific:

- `ReolinkClient`, `StatusPoller`, name announcer, `EventTracker` +
  `EventIntake` (ONVIF + polling fallback);
- the stills pipeline: a `FrameGrabber` reading its camera's sub stream from
  the shared go2rtc, and its `MinuteStore`;
- the recordings side (Baichuan session, one transfer at a time per camera;
  the cache is shared, §8.3);
- the camera-FTP watch (#93) and the clips stall check;
- the inventory checks bound to this camera (the runner stays host-wide and
  runs one inventory at a time, labelled with the camera);
- `CameraReboot` and the power-cycle state (the switch itself is host-wide);
- the camera's certificate state (§10).

### 3.2 Host-wide services

HTTP server and routers, catalog (one SQLite file, one writer), stream log +
SSE, storage manager, analytics service (one queue, one provider budget per
key), composer, archive, audit log, daily audit, host monitor, health
summary, metrics, go2rtc, FTP server, PoE switch controller, site CA and
certificate scheduler, ONVIF discovery ("Find camera").

### 3.3 Supervision

- Each worker starts, stops and restarts on its own. A worker's start or
  runtime failure (bad address, refused login, go2rtc stream error, ffmpeg
  exit) sets that camera's `error` and retries with backoff (5 s doubling to
  5 min, reset after 10 min healthy); the others never wait for it.
- A camera with no address no longer stops the process (today: "no camera
  address: the proxy does not start", `schema.ts:31`): its worker stays idle
  with `error: "no_address"`, so Find camera can still be used. For the Pi
  this is a small, visible improvement, not a break.
- go2rtc is shared: if it exits, the host restarts it (backoff as above) and
  every grabber reconnects; a stream's source error stays that camera's.
  Streams are added and removed through go2rtc's API (`PUT/DELETE
  /api/streams`), so adding or restarting one camera never restarts go2rtc
  (the password handling of such a stream: §8.5).
- Restarts: "restart camera side" becomes per camera
  (`/control/cameras/:cam/actions/restart`); settings that need a process
  restart stay host-wide as today (`needsProcessRestart`).
- Every async call into a worker from the API goes through the worker's
  `ready` state: a request for a camera that is restarting answers `503
  camera_restarting` with Retry-After, never hangs.

### 3.4 Rejected alternatives

- **One process (container) per camera plus a router in front:** the storage
  budget double-counts the volume (§2), the PoE switch takes one session per
  host, FTP needs one port per camera on the camera side, Vision budgets
  split per camera, and each container needs its own go2rtc. Decision 1
  rules it out as well.
- **Worker threads per camera:** the work per camera is I/O and child
  processes (ffmpeg, go2rtc); the Node event loop carries 4 cameras at 1
  still/s easily (§9). Threads would split the catalog writer. Not needed.

## 4. Config schema

### 4.1 Shape

```jsonc
{
  "server": { "port": 8480, "dataDir": "/data", "tls": { "port": 8443 } },
  "tls": { "site": "garage", "cameraCerts": true },          // §10
  "poeSwitch": { "model": "sscpoe-web", "host": "192.168.60.2", "ports": 8, "offSeconds": 10 },
  "ftp": { "enabled": true, "port": 2121, "passive": "50000-50039", "tls": true, "publicHost": "192.168.60.1" },
  "storage": { "maxPercent": 85 },
  "cameras": [
    { "id": "cam3", "name": "Driveway", "host": "192.168.60.13", "user": "proxy",
      "poeSwitch": { "port": 1 }, "ftp": { "user": "cam3" } },
    { "id": "cam4", "name": "Gate", "host": "192.168.60.14", "user": "proxy",
      "poeSwitch": { "port": 2 }, "stills": { "intervalS": 2 },
      "storage": { "sharePercent": 20 } }
  ]
}
```

- `cameras` is an array in config.json (order = display order). Inside the
  proxy it is a map keyed by id; settings paths and overrides use the id,
  never the index: `cameras.cam4.stills.intervalS`. Reordering the array
  changes nothing stored.
- **Per-camera keys** (the camera node): everything under today's `camera`
  (`id`, `name`, `host`, `protocol`, `tlsName`, `webUiUrl`, `user`,
  `onvifPort`, `rtspPort`, `baichuanPort`, `statusPollS`), plus
  `poeSwitch.port`, `ftp.user`, `storage.sharePercent`, and these
  **overrides of a host default**: `stills.enabled`, `stills.stream`,
  `stills.intervalS`, `ftp.enabled`, `ftp.stream`, `analytics.kinds.*`,
  `events.poll.enabled`. An override absent = the host value. The list is
  closed; anything else is host-wide (retention, storage, quality and sizes,
  go2rtc, sse, recordings, composition, Vision, health, host, archive, tls).
- **Host-wide `poeSwitch`** (model, host, ports, offSeconds): one switch per
  host. `model` picks the driver (§8.4). A second switch is a later extension (`poeSwitches: {id: …}` and
  `cameras[].poeSwitch.switch`); not built.
- `camera` and `cameras` together are a config error. Ids must be unique
  (`^[a-z0-9][a-z0-9-]{0,31}$`, as today).
- The settings tree (`SETTINGS` in `schema.ts`) knows only nested objects
  today; it gains one node kind, a **keyed collection** (`cameras: { '*':
  cameraNode }`). `checkPartial`, `leafPaths`, `leafAt`, `jsonSchema` and the
  overrides walk learn it; `config.schema.json` emits `cameras` as an array
  of the camera node plus the legacy `camera` object.

### 4.2 Backward compatibility (the Pi, the cluster)

- **Legacy `camera: {…}`** is read as `cameras: [{…}]`. Its
  `camera.poeSwitch.{model, host, ports, offSeconds}` move to the host-wide
  `poeSwitch`, its `poeSwitch.port` stays with the camera, and the top-level
  `ftp.user` becomes that camera's `ftp.user`. No file is rewritten: the
  translation happens at load, and `GET /control/config` shows the new shape
  with `sources` saying "config.json (legacy camera)". This is the one
  visible change for a one-camera proxy: tests and scripts that read those
  keys from `GET /control/config` move to the new paths (no known external
  reader; the display and cams don't use it). `PUT`/`DELETE /control/config`
  still accept the legacy `camera.*` and `ftp.user` paths on a one-camera
  proxy, translated like overrides.json.
- **overrides.json** written by today's Settings page holds paths like
  `camera.statusPollS` and `camera.poeSwitch.host`. They are read with the
  same translation (`camera.X` → `cameras.<the one id>.X`, switch keys →
  `poeSwitch.X`) and written back in the new form on the next save. With more
  than one camera, a legacy `camera.*` override is a load error naming the
  path (it can't be assigned).
- **Env:** `CAMERA_HOST` / `CAMPROXY_CAMERA_HOST` and `PI_ADDRESS` keep their
  meaning when exactly one camera is configured (the Pi). With several, a
  `CAMERA_HOST` is a load error ("set cameras[].host instead"); "Use this
  address" (`src/config/env-file.ts`) is offered only on a one-camera proxy.
- **Secrets:** `CAMPROXY_CAMERA_PASSWORD` is the default for every camera;
  `CAMPROXY_CAMERA_PASSWORD_<ID>` (id upper-cased, `-` → `_`) overrides it for
  one camera. `CAMPROXY_FTP_PASSWORD` stays one password for every camera's
  FTP user (the user name tells the camera apart, §7). Tokens are unchanged
  (decision 6).
- The cluster config (`deploy/cluster/config.json`, camera `cam2`) keeps
  working unchanged.

## 5. Catalog and data

### 5.1 Tables

| Table | Change |
|---|---|
| events, annotations, clips, stream_log, still_checks, archive, clip_arrivals | none: they have `cam` already. Add `CREATE INDEX stream_log_cam_ts ON stream_log (cam, ts)` for the per-camera `latest()` lookups (the name/address `camera` message, `src/proxy.ts:183`). |
| analyses | none (bound to its event, which has `cam`). |
| **analytics_usage** | becomes `(provider, key_id, cam, day, calls)`, PK `(provider, key_id, cam, day)`. `key_id` = the first 12 hex digits of SHA-256 of the API key (never the key); `''` for rows from before the migration. Limits sum over `cam` for one `key_id` (§8.2); per-camera rows give the Status page and the daily audit a per-camera split, and make `checksPerDay` really "per camera day" (`schema.ts:150`). |
| analytics_unmapped | none: it counts provider labels that didn't map (a property of the provider, not a camera). |

Migration (a numbered step in `migrations.ts`, automatic on start, no action
on the Pi): create the new `analytics_usage`, copy every row with `key_id =
''` and `cam =` the configured camera if there is exactly one (else
`'unknown'`), drop the old table. A legacy `key_id = ''` row counts toward the
key in use, so this month's count survives the upgrade on the Pi.

### 5.2 Files

- Already keyed by camera: `stills/<cam>`, `previews/<cam>`, `clips/<cam>`
  (indexer), `recordings/<cam>`. Nothing moves.
- Host-wide and staying so: `audit/` (each record gains `labels.camera` when
  it concerns one, instead of the process-wide label at
  `audit-log.ts:232`), `compositions/` (jobs already carry their cam:
  `composer.get(cam, id)`), `inventory/` (each run record gains `camera`),
  `ftp/.incoming` (the session knows its camera, §7), `archive/` (rows have
  `cam`), `overrides.json` (per-camera paths, §4.1), new `tls/` (§10).
- A camera removed from the config: its worker stops, its API answers 404,
  its files stay and age out by retention and the budget (the storage walk
  covers every `<kind>/<cam>` folder, `storage.ts:91`). A "forget camera
  data" action is later work.

## 6. API

### 6.1 Client API (`/api`, client token)

- `GET /api/cameras`: every configured camera, in config order, each as
  today's `info()` plus `error` (worker error or null, P1), `features`
  (P1), `latestStill` (§6.4, P2) and `tls` (§10.4, P5). For one camera the
  array is what it is today plus the new fields.
- `features: string[]` is the same proxy-wide list on every item: what this
  proxy supports beyond the pre-multi-camera API. The first entry is
  `"sse-cam-list"` (SSE `?cam=a,b`, §6.2). A proxy without the field (every
  release before P1: the Pi until its update, the cluster proxy until its
  rollout) supports none of them. Clients test for a name, never for a
  version.
- Every `/api/cameras/:cam/…` route resolves `:cam` to its worker: unknown
  → 404 `not_found` (as today), restarting → 503 `camera_restarting`. The
  `known()` guards (`client-api.ts:64-67` and the same in compose, archive,
  still-checks) become one shared `cameraParam` middleware that puts the
  worker on `res.locals`.
- Host-wide routes keep their paths: `/api/archive*` (rows carry `cam`;
  `GET /api/archive?cam=` filters), `/api/stream`.
- Rate limits: the image bucket (6000/min per client, `proxy.ts:649`, the
  limiter whose `skip` is `!isImage`) is multiplied by the number of
  cameras; a timeline per camera loads the same sprites. The non-image
  bucket (1200/min, `proxy.ts:648`) stays as it is.

### 6.2 SSE (`GET /api/stream`)

Unchanged contract: one stream carries every camera's messages, each with
`cam`; `?cam=<id>` still filters to one, and `?cam=a,b` (new) to several.
Replay by `Last-Event-ID` is over the host-wide stream log, so one cursor
covers all cameras. `?types=` filters types as today; the `still` message
(one per camera per second) stays off unless asked for (`sse.ts:12`).
cams opens one stream per proxy (§12.2).

**Older proxies.** Before P1, cam-proxy compares `?cam=` with its one id as
a whole, so `?cam=a,b` to an old proxy delivers nothing. A proxy that
understands the list says so with `"sse-cam-list"` in `features` (§6.1).
A client sends a list only to such a proxy; otherwise it sends `?cam=<id>`
for one camera (as today) or no `cam` at all for several, and filters by
each message's `cam` itself. An unknown id in a list is not an error: it
matches nothing (a removed camera never breaks a group's stream).

### 6.3 Control API (`/control`, admin)

- New camera-scoped routes: `GET /control/cameras` (each camera's status
  block as `/control/status` gives it now), `GET /control/cameras/:cam/status`,
  `PUT /control/cameras/:cam/name`, `POST /control/cameras/:cam/actions/:name`
  for the camera actions (camera-test, onvif-resubscribe, camera-ftp-setup,
  -test, -off, restart, camera-reboot, camera-powercycle, camera-poe-on,
  poe-switch-read, inventory, inventory-repair, inventory-cancel,
  camera-cert-push §10).
- The old routes stay: `/control/status`, `/control/camera/name`,
  `/control/actions/:name` act on the only camera on a one-camera proxy; on a
  multi-camera proxy a camera action there answers `400 camera_required`
  (host actions such as retention-run, restart-proxy, find-camera,
  archive-clear work as before).
- `GET/PUT/DELETE /control/config` take `cameras.<id>.<path>`. Adding a
  camera: `PUT /control/config` with a new `cameras.<id>` object (written to
  overrides.json), then its worker starts. Removing one that came from
  config.json is not possible from the UI (it says so); one added in the UI
  can be removed there.
- Audit records of camera actions name the camera (`labels.camera`).

### 6.4 Latest still (new; makes the overview cheap)

- `GET /api/cameras/:cam/stills/latest.jpg` and
  `GET /api/cameras/:cam/previews/latest.jpg` (the 160×90 tile): served from
  memory (the grabber's last frame and tile), `ETag: "<cam>-<ts>"`,
  `Cache-Control: no-cache`, `X-Still-Ts: <ts>`; `If-None-Match` answers
  `304` with no body. 404 `no_still` while the stream is down (with the last
  ts in the body). Cost: no disk read, no decode; a client polling every 2–5
  s per camera gets mostly 304 when nothing moved (each second is a new
  frame, so polls at < 1/s get a new image each time: that is the point).
- `GET /api/stills/latest` (JSON): `[{cam, ts, url, tileUrl, up}]` for
  all cameras in one request, for a grid that polls one URL and fetches only
  changed images.
- These count in the image rate-limit bucket.

### 6.5 Health summary (`GET /api/local/health`, control `health`)

`schema` stays **1**; every change is additive, so cam-proxy-pi-display (which
checks the schema and reads `items`, `camera`, `stream`, `events`, `ftp`)
keeps working:

- New `cameras: [ {camera, stream, events, ftp, cert, items} ]`, one per
  camera, each block shaped like today's top-level one.
- Top-level `camera`, `stream`, `events`, `ftp` = the **first camera** in
  config order (on the Pi: the only one, so byte-identical apart from new
  fields).
- `items`: the host items (storage, disk, archive, cpuTemp, underVoltage,
  inventory, version, new `certificates`) plus, per camera item kind
  (camera, stream, events, ftp), **one aggregated item**: with one camera
  exactly today's item; with several, `text` "3 of 4 online" / "cam4
  offline", `problem` if any camera has the problem, `value` the count of
  cameras without it. The item ids stay the same, so the display's pages
  still render.
- New item `certificates` (§10.5): problem when a camera or the proxy
  certificate expires within 14 days or the last push failed.
- Host figures: `host.stats: auto` detects a Raspberry Pi only; on the mini
  PC set `on` (memory, uptime, load; temperature from hwmon `k10temp` `Tctl`
  where present, otherwise null). The Pi-only items stay null there.

### 6.6 The multi-user seam

All access checks go through one function, `can(principal, action,
cam?)`, where `principal` is what `requireAccess` already derives (client,
admin, audit, session). Today it returns what the token kind allows, for any
camera. Routes pass the camera they act on. A later roles project replaces
the function and the principal's source; no route changes then.

## 7. FTP: one server, a user per camera

- One FTP(S) server, one port (2121) and one passive range for all cameras.
  Each camera logs in as its own user (`cameras[].ftp.user`, default the
  camera id); the session's user selects the camera's indexer. Password: the
  one `CAMPROXY_FTP_PASSWORD` (the user name is not a secret; the password
  is shared by every camera of this host, as the camera password is).
- Defence in depth: when the camera's `host` is an IP address, a login from
  another source address is refused (`530`) and logged; on the camera network
  the fixed leases make this reliable. Off when the host is a name.
- Uploads land in `ftp/.incoming` as now and are handed to the session's
  camera; the JPEG's parallel session (the camera's second session) logs in
  with the same user, so the pairing by time stays per camera.
- Passive range: each camera may hold 2 data connections at once (MP4 + JPEG);
  size the range at ≥ 10 ports per camera (`50000-50039` for 4).
- `ftp.publicHost`: on the mini PC the camera-side address (192.168.60.1),
  which "Point the camera's FTP here" writes to each camera. PASV answers the
  connection's own address when it is unset, which is also right here.
- One-camera configs: the legacy top-level `ftp.user` is that camera's user;
  nothing changes on the camera or the Pi.

## 8. Budgets and shared resources

### 8.1 Storage

- **One host-wide budget** (`storage.maxBytes ?? maxPercent ?? 85 %` of the
  data volume), as today. With one proxy per host there is no double count:
  every file on the volume under `dataDir` is the proxy's. (Two proxies on
  one volume stay unsupported; the setup guide says so.)
- **Optional shares:** `cameras[].storage.sharePercent` (sum ≤ 100; the rest
  shared). Over budget, the storage run deletes, as today, recordings cache
  first, then per kind the oldest hour; with shares it first picks the
  camera most above its share, then the oldest hour of that camera. Without
  shares: the oldest hour across all cameras (fair by age). `keepHours` and
  per-kind caps (`stills.maxGB`, `ftp.maxGB`, `previews.maxGB`) stay
  host-wide.
- `storage.usage()` gains a per-camera split (bytes per kind per camera) for
  the Status page, metrics (`cam` label) and the daily audit.
- `minFreeBytes` pauses writing for every camera (one disk).

### 8.2 Vision (Google)

- One budget **per API key** (`key_id`, §5.1): `monthlyLimit`, `dailyCap`
  and `checksPerDay` are host settings and count the calls of every camera
  that uses that key; a key change starts a fresh count (legacy rows go with
  the current key, §5.1). Which cameras are analysed is per camera
  (`cameras[].analytics.kinds.*`).
- Fairness: the analytics queue is one FIFO; to keep one busy camera from
  using the whole daily cap, a host setting
  `analytics.googleVision.perCameraDailyCap` (0 = none, default) limits one
  camera per day.
- Several hosts (the Pi and the mini PC) with the **same key** each enforce
  their own limits; the sum of their `monthlyLimit`s is what can be spent.
  No cross-host counting is built (non-goal); the Settings page says so.

### 8.3 Recordings cache

One LRU cache for all cameras under `recordings/<cam>/`, capped by the host
`recordings.cacheMB`; one Baichuan session and one transfer at a time **per
camera** (the camera's own limit), so four cameras can fetch in parallel.
Suggested cap on the mini PC: 8192 MB (the Pi keeps 2048).

### 8.4 PoE switch

- **The switch: a second GPS-208** (Klaus), on the camera network. The
  Pi's GPS-208 (`192.168.1.217`, cam1 on port 8) stays separate, with the
  Pi's proxy as its only controller. The mini PC uses the existing
  `sscpoe-web` driver unchanged: same protocol, same reverse port numbering,
  its own password (`CAMPROXY_POE_SWITCH_PASSWORD` in the mini PC's
  `config/.env`). Switch control stays a **driver per model** behind one
  interface (log in, read ports, set one port's PoE, log out, and whether
  only one session is allowed), so another model later means a new driver,
  not a new design. P1/P2 test the queue against a fake driver.
- **Its address.** The notes don't say how a GPS-208 gets its address: the
  Pi's unit is at `192.168.1.217` on the router's LAN, and nothing records
  whether that came from DHCP or a static setting. The protocol has a
  network-config command (callcmd 108, `netcfg`), so both are possible. *To
  verify on the device*, when the second unit is unpacked:
  - If it uses DHCP: dnsmasq gives it the fixed lease `192.168.60.2` by its
    MAC. The MAC is printed on the unit and also in callcmd 101's `mac`.
  - If it has a static factory default: set `192.168.60.2/24` with gateway
    `192.168.60.1` in its web UI. Do this from a laptop on the camera
    switch, or from the host before the firewall is closed.

  Either way, `poeSwitch.host` is `192.168.60.2`. The firewall blocks the
  switch from the internet like the cameras (no cloud API), and its web UI
  is reached from the LAN **over the route**, like the cameras' pages
  (`http://192.168.60.2/`).
- **One session at a time is the controller's rule.** The host-wide
  controller is the switch's only automated client, and it serializes every
  use (below). A browser logged in to the switch's web UI still blocks it
  (`switch_busy`, and about 3 min after a session left open), so the setup
  guide says to log out of the web UI after use.
- One `PoeSwitch` controller per host. Requests (read, power-cycle, PoE on)
  go through a **FIFO queue**: a second camera's power-cycle waits for the
  first (bounded at `offSeconds + 60 s`; beyond that `409 switch_busy` as
  today, `src/api/control-api.ts` `switchFail`, also when someone is logged
  in to the switch's web UI).
- A read (callcmd 101) returns every port; one read serves every camera's
  status (cached 10 s).
- The reboot/power-cycle cooldown (2 min) stays per camera.
- Shutdown turns on every port it left off (today's one-port logic, per
  port).

### 8.5 go2rtc

One go2rtc process for the host, two streams per camera (`<cam>_sub`,
`<cam>_main`), each camera's password passed by its own environment variable
(`${CAM_<ID>_PASSWORD}` in the 0600 config, as today for one) for every
camera known when go2rtc is spawned. A process's environment can't change
after spawn, so a stream added at runtime (§3.3: a camera added or
restarted) carries its password in the source URL of the `PUT /api/streams`
call on go2rtc's loopback API (127.0.0.1 only, never logged); at the next
spawn it moves into the config with its variable. go2rtc opens a
source only while it has a consumer: the sub stream is always consumed by the
grabber; the 4K main stream only while someone watches it. Ports are
host-wide (`go2rtc.rtspPort`, `apiPort`).

### 8.6 Compositions

`composition.concurrent` (new host setting, 1–4, default 1): the composer runs
that many encodes at once. The mini PC sets 2 (§9); the Pi keeps 1.

## 9. Sizing the Ryzen host (4 cameras)

Measured inputs: sub stream H.264 896×512 at 10 fps, 1 Mbit/s; main H.265
4512×2512 at 20 fps, 8 Mbit/s (cams `docs/reolink-api.md`); stills about
24 KB each at 1/s (cam-proxy on the real camera, 2026-09-27); a sub clip of
about 0.5–1 MB per 5–10 s (the 2026-10-02 Baichuan measurements).

| Load per camera | Estimate (Zen+ core at ~3 GHz) |
|---|---|
| go2rtc restream of the sub stream (no decode) | < 1 % of a core |
| FrameGrabber: decode 896×512 @ 10 fps + 1 still + 1 tile JPEG/s | 3–6 % of a core |
| ONVIF pull, status poll, catalog writes | negligible |
| 4K live view (pass-through, only while watched) | < 1 % of a core, 8 Mbit/s per viewer |

- **4 cameras steady:** about a quarter of one core of 8 threads. The
  grabbers decode in software; VAAPI is not needed.
- **Compositions:** an encode of a composed sub clip runs several times
  faster than real time on one core and uses 1–2 threads. Two at once
  (`composition.concurrent: 2`) leave ≥ 4 threads for the steady work and
  the API; a third waits in the queue as today.
- **Inventories / repairs:** one at a time host-wide (the runner), each
  bounded by its camera's single transfer.
- **Memory (8 GB):** Node 300–500 MB, go2rtc ~50 MB, 4 grabbers ~40 MB
  each, 2 compositions ~200 MB each, SQLite cache, page cache for the rest.
  Plenty; also room for a cams instance on the same host (as on the Pi's
  demo kit) if wanted.
- **Disk per camera and day:** stills ~2.1 GB, previews ~0.3 GB, sub clips
  1–5 GB depending on events → about 3–7 GB. 4 cameras for 14 days ≈
  170–400 GB; a 1–2 TB NVMe fits the defaults with room for the archive and
  the recordings cache.
- **Network:** camera side ≈ 4 × (1 Mbit/s sub + FTP bursts) steady, + 8
  Mbit/s per 4K viewer; both NICs are gigabit.
- **Catalog:** one writer; ~4 rows/s of stream log and events at most; WAL
  is fine.

These are estimates. P4 measures them on the host, first with 4 cam-sims
and then with the real cameras (the Status page shows load and memory with
`host.stats: on`).

## 10. TLS without DNS: the site CA

### 10.1 Recommendation (final)

Adopt the coordinator's proposal, with four refinements.

**Scope (Klaus):** the site CA is **per host and lives inside cam-proxy**.
It is not a LAN-wide service: no other machine issues or holds it, and it
signs only that host's proxy and the cameras behind it. Two hosts have two
unrelated CAs. The Pi doesn't share the mini PC's CA (it keeps Let's
Encrypt for now, §11).


1. **A per-host site CA, name-constrained.** The proxy generates on first
   start (when `tls.site` is set) a root CA, RSA 3072, valid 10 years,
   subject `CN=cam-proxy site CA <site>`, with **critical X.509 name
   constraints**: permitted DNS `<site>.internal` (RFC 5280 form, no
   leading dot: the name and every name under it), permitted IP ranges the
   camera subnet and the host's own addresses (/32 each), taken from the
   settings `tls.cameraSubnet` and `tls.proxyAddresses` (the P4 renderer
   writes both). An address outside them gets no leaf; the health item
   says so and `tls-ca-rotate` makes a new CA (a new pin in cams). Installing it in
   Klaus's browsers then can't let it vouch for any other site: a leaked key
   can only impersonate this host's cameras and the host itself. The key
   stays in `<dataDir>/tls/ca.key` (mode 600, never served, never logged);
   `tls/` is part of a data backup (§10.7).
2. **Leaf certificates signed directly by the root** (no intermediate), so
   it doesn't matter whether the camera firmware serves a chain: the client
   trusts the root and the leaf alone verifies. Camera leaves are **RSA
   2048** (the only key type and size measured on the camera: "Use an RSA
   key"; cert-manager's RSA 2048 works), 397 days, SANs
   `DNS:<camId>.<site>.internal` and `IP:<camera address>`. The proxy's
   own leaf: SANs `DNS:proxy.<site>.internal`, its LAN and camera-side IPs.
   397 days stays under Apple's 825-day limit for TLS certificates from any
   CA, and pushes happen once a year per camera.
3. **The proxy pushes camera certificates itself** (push_cert.py's logic
   moved into cam-proxy: compare the served fingerprint; if different,
   `GetCertificateInfo` → `CertificateClear` (wait 10 s, log in again) →
   `ImportCertificate` → wait up to 90 s for the new fingerprint; retry once
   with a clear; log out; success only by the served fingerprint). Schedule:
   on adding a camera, when the served fingerprint is not the current leaf,
   and renewal 30 days before expiry, at 04:00 camera time, one camera at a
   time, never during an open event. On the mini PC no CronJob is ever
   needed; `cam1-cert-push` stays for the Pi until the later option of §11.
4. **cams pins one thing per proxy: the CA's SHA-256 fingerprint**, and
   learns everything else over the pinned channel. cams fetches the CA
   certificate from `GET /tls/ca.pem` (public, no token), accepts it only if
   its fingerprint matches the pin, caches it, and then uses it as the
   **only** trust anchor for that proxy's HTTPS URL and for the cameras of
   that proxy. **Fallback** when a camera refuses the import: the proxy
   reports the camera's served (factory, self-signed `CN=CERTIFICATE`)
   fingerprint in `GET /api/cameras` (`tls: {mode: "pinned", fingerprint}`),
   and cams pins it automatically for that camera. That answer arrives over
   the already verified proxy channel, so no second manual pin is needed
   (the coordinator's draft had cams pin it by hand).

### 10.2 What this trusts (a challenge, checked)

The current `from-proxy` rule (cams `cameraRegistry.ts:90-95`, security review
2026-10-04) exists so that a compromised proxy can't redirect cams's camera
login to another host: the camera's certificate is checked against a
public-CA name the proxy doesn't control. **With a site CA the proxy controls
the camera's certificate**, so that protection becomes "trust the proxy host".
That is acceptable, and the name constraints bound it: the proxy already
holds an admin login on every camera and sees every frame; and a constrained
CA can only vouch for addresses on its own camera subnet and its own names,
so it can't send cams's login to an arbitrary LAN or internet host. The spec
keeps `from-proxy` valid with a site-CA pin and says so in cams's docs.

### 10.3 Names and `tlsServername`

- `tls.site` is a short label chosen per host (e.g. `garage` for the mini PC,
  `pi` for the Pi). `.internal` is the TLD reserved for private use (ICANN,
  2024), so no public name exists and nothing reaches CT logs.
- No LAN DNS is needed: clients connect by IP and verify by name.
  `tlsServername` in cams becomes `cam3.garage.internal`; the proxy's URL is
  `https://192.168.1.230:8443` with `tlsServername` `proxy.garage.internal`
  (new optional field in the proxy object, §12.1). An IP SAN makes the cert
  valid by IP as well, which the browser needs.
- The camera address and the name stay independent: a new address only needs
  a re-issued leaf (the proxy does that when a camera's address changes).

### 10.4 The proxy side

- New settings: `tls.site` (unset = off: today's behaviour), `tls.cameraCerts`
  (issue and push camera certificates; default true when `tls.site` is set),
  `server.tls.port` (HTTPS listener with the proxy's leaf; unset = HTTP only).
  The HTTP listener on 8480 stays: loopback callers (the display, cams on the
  same host) and today's clients use it; the setup guide limits it to
  loopback by firewall on the mini PC.
- The proxy's own camera client verifies each camera against the site CA
  once its leaf is served (replaces `camera.tlsName` for those cameras; a
  set `tlsName` still means public-CA verification, e.g. cam1 on the Pi
  with its Let's Encrypt certificate).
- `GET /api/cameras` → `tls: {mode: "site-ca" | "pinned" | "public" |
  "none", servername, fingerprint, notAfter, lastPush: {at, outcome}}`;
  `servername`, `fingerprint`, `notAfter`, `lastPush` may be null;
  `outcome` is `"pushed" | "current" | "refused" | "failed"`.
- **Fingerprint format** (the CA's and a served leaf's): `SHA256:` + the
  upper-case hex SHA-256 of the certificate's DER, no colons. The proxy
  always emits this form; cams accepts it and also plain hex, with or without
  `SHA256:` and colons, in any case (it compares 64 lower-case hex digits).
- `GET /tls/ca.pem` (public; mounted before the admin UI's catch-all route,
  `proxy.ts:741`) and the admin UI's **Certificates** card: the
  CA fingerprint (to copy into cams), per camera the state, expiry, last push,
  a "Push now" action (`camera-cert-push`), and a download of the CA for
  browsers.
- FTPS: the FTP server uses the proxy's leaf too (today a self-signed one per
  process, `side.ts:22-27`; the camera doesn't verify it either way).

### 10.5 Health and alerting

On a site-CA host, the proxy itself checks what the `cam1-cert-push` alerts
(push stale, < 14 days) check for the Pi: the health item `certificates` is a problem when any served camera certificate or
the proxy's own expires within 14 days, or the last push of a camera failed.
It shows on the Status page and on the e-paper display like the other items.
Metrics: `camproxy_cert_not_after_seconds{cam}` and
`camproxy_cert_push_total{cam,outcome}` for anyone who still scrapes.

### 10.6 Browsers and the cameras' own web pages

- Klaus's devices install the site CA once per host (macOS keychain / iOS
  profile / Firefox), or accept the warning. The name constraints make the
  install safe to do.
- **No reverse proxy for the camera web pages (opinion).** Over the route
  the browser reaches `https://192.168.60.13/` directly, with a trusted
  certificate once the CA is installed. A reverse proxy would put the
  cameras' admin UI behind cam-proxy's session (a new, privileged surface),
  need path and cookie rewriting for a UI that isn't ours, and buy nothing
  while the route exists. It becomes worth a look only if neither the route
  nor the 1:1 NAT alternative (§14.3) works.

### 10.7 Operations

- **Backup:** `tls/` (CA key and leaves) with the data. Losing the CA key means
  a new CA, a new pin in cams, and new pushes; nothing else breaks.
- **CA rotation:** cams accepts a list of fingerprints per proxy, so a new CA
  can be pinned before the old one goes.
- **Camera reset / replacement:** the served fingerprint differs → the proxy
  pushes again; if import is refused → fallback pin (§10.1.4).

### 10.8 Alternatives considered

| Option | Why not |
|---|---|
| **Let's Encrypt per camera via DNS-01** | Squarespace DNS has no API, so DNS-01 needs a moved zone or an `_acme-challenge` CNAME to an acme-dns service: a new external dependency. Every camera name lands in public CT logs (an inventory of the house's cameras). The host needs the internet to renew. Clients still connect by IP with `tlsServername` (no LAN DNS). It does give browser trust without installing a CA, which is its one advantage. |
| **Let's Encrypt via HTTP-01 (today)** | Needs the cluster to answer the challenge: violates decision 7. |
| **Self-signed pinning only** | Works with no CA, but every camera and the proxy need their own pin in cams, changed on every reset; browsers warn forever; nothing renews. Kept as the per-camera fallback. |
| **Plain HTTP on the camera network** | The camera network is isolated, but cams reaches the cameras across the LAN and the router (the Login body carries the cams user's password, FLV carries the token), so it would put credentials on the LAN in clear. The proxy-to-camera hop could be HTTP, but the site CA makes HTTPS free there too. |
| **One CA for all hosts / a LAN-wide CA service (held by Klaus's Mac or the cluster)** | One pin in cams instead of one per proxy, but issuing needs that machine (or the cluster) to be there: violates decision 7 or adds a manual step per renewal, and it would tie the hosts together. Klaus ruled it out: per host, inside cam-proxy. |

## 11. The Pi (one camera) stays as it is

- The new image runs with today's `/srv/cam-proxy/data/config.json`, today's
  overrides.json and `config/.env` (legacy `camera`, `CAMERA_HOST`,
  `PI_ADDRESS`): §4.2.
- The catalog migration (§5.1) runs automatically; no file moves; no data
  migration.
- `/api/local/health` keeps schema 1 and every field the display reads (§6.5).
- `GET /api/cameras` and SSE answer as before plus new fields; cams (on the
  Pi and in the cluster) keeps working before its own update.
- **Independent of the mini PC** (Klaus): no shared CA, no dependency either
  way. cam1 keeps its Let's Encrypt certificate for `cam1.skylar.technology`
  through the cluster CronJob `cam1-cert-push`; `tls.site` stays unset on
  the Pi, so it serves HTTP on 8480 exactly as today.
- **Option for later (not planned):** the Pi becomes its own site
  (`tls.site: "pi"`, its own CA). Its proxy would then push cam1's
  certificate (SANs `cam1.pi.internal`, `192.168.1.164`), cams would pin the
  Pi's CA and set `tlsServername: "cam1.pi.internal"`, and kube-setup would
  retire `cam1-cert-push`, its Secrets, the `cam1` Certificate and its
  alerts. That would remove the **last camera dependency on the cluster**
  (decision 7). It needs nothing beyond what the mini PC gets, so it can
  be decided any time.

## 12. cams

### 12.1 Mapping (`cameras.json`)

The file stays an array of cameras; several entries may name the same proxy:

```json
[
  { "id": "driveway", "name": "Driveway", "host": "192.168.60.13", "protocol": "https",
    "tlsServername": "cam3.garage.internal", "user": "cams", "password": "…",
    "proxy": { "url": "https://192.168.1.230:8443", "tlsServername": "proxy.garage.internal",
               "caFingerprint": "SHA256:…", "token": "…", "adminToken": "…", "camera": "cam3" } },
  { "id": "gate", "name": "Gate", "host": "from-proxy", "protocol": "https",
    "tlsServername": "cam4.garage.internal", "user": "cams", "password": "…",
    "proxy": { "url": "https://192.168.1.230:8443", "tlsServername": "proxy.garage.internal",
               "caFingerprint": "SHA256:…", "token": "…", "adminToken": "…", "camera": "cam4" } }
]
```

- **Proxy group** = entries with the same `url` + `token` (the archive's rule
  today, `archive.ts:27`). Within a group, `caFingerprint` and
  `tlsServername` must be equal, else startup fails naming both entries.
  `adminToken` may be set on some entries and absent on others (today's
  `e2e/cameras.json` does that; each camera's sign-in link comes from its
  own entry); only two **different set** values in one group are a startup
  error. `proxy.camera` maps cams's id to the proxy's id (exists today).
- New optional proxy fields: `caFingerprint` (string or list, §10.7; format
  §10.4) and `tlsServername`. With `caFingerprint`, every camera of the
  group is verified against that CA only (or its fallback leaf pin), and
  the proxy URL must be `https://…`, verified against that CA only — except
  a loopback URL (`127.0.0.0/8`, `[::1]`, `localhost`: cams on the proxy's
  own host), which may stay plain `http://` with the pin still used for the
  cameras. A pin on a LAN `http://` URL is refused at startup (it would
  leave the token in clear). A proxy `tlsServername` needs an `https` URL.
  A camera's `tlsServername` is then a `.internal` name; without one, a
  site-CA camera is checked against its address (the leaf's IP SAN).
- **`from-proxy`** (cams `cameraRegistry.ts:90-95`) needs `protocol:
  "https"` and either the camera's `tlsServername` or the group's
  `caFingerprint` (a camera on the leaf-pin fallback serves the factory
  `CN=CERTIFICATE` and has no usable name; its trust is the pin reported
  over the pinned channel, §10.2).
- Repetition of url/token per camera is accepted to keep the file format (a
  Secret in the cluster) unchanged; a `proxies` section is not worth a second
  format.

### 12.2 One SSE stream per proxy

`ProxyStream` becomes one per proxy group (keyed like the archive). It
subscribes with `?cam=<the group's proxy ids>` when the group has one id
(any proxy) or when the proxy lists `"sse-cam-list"` in `features` (§6.1,
read from the group's one `GET /api/cameras`); with several ids on a proxy
without it, it subscribes without `cam` (§6.2 "Older proxies"). Either
way it fans out each message to the cams camera mapped from its `cam` (the
group's `toCams` map, as the archive has); unknown cams are dropped, so the
client-side filter is always there. `proxyStates()` reports per cams
camera from its group's state. Switching one camera's proxy off on the
Settings page re-subscribes the group with the smaller `cam` list (or closes
it when none is left). The browser relay and the top bar's merged
notifications are unchanged (they already take several sources).

### 12.3 TLS in cams

- `server/reolink/http.ts` and the certificate probe
  (`client.ts:228`) take a per-camera trust: `{ca: <site CA PEM>, servername}`,
  `{fingerprint}` (leaf pin), or today's public-CA `servername` check.
- **The leaf pin is checked on the TLS socket at `secureConnect`, before
  any request byte is written**: `rejectUnauthorized: false`, then the
  SHA-256 of the peer's leaf DER is compared with the pin, and on a mismatch
  the socket is destroyed with a certificate error (not "offline"). Not with
  `checkServerIdentity`: Node calls it only after the chain verified, so for
  a self-signed factory certificate it never runs and would accept any
  certificate. The Login body carries the cams user's password, so nothing
  may be sent before the check.
- The proxy client (`server/proxy/client.ts`) uses an undici `Agent` with
  the same CA and servername for `https://` proxy URLs.
- Fallback pins come from the proxy's `GET /api/cameras` `tls` block; the
  last one seen is kept (data dir) so a camera stays reachable while its
  proxy is away.
- cams→proxy today: the Pi is reached over plain `http://192.168.1.220:8480`
  (token in clear on the LAN); the cluster proxy through the ingress over
  HTTPS. With P5, a site-CA proxy (the mini PC) is reached over `https://…:8443` with the
  pin. The plain URL stays valid: the Pi keeps `http://192.168.1.220:8480`
  (it has no site CA, §11), and cams on the same host keeps
  `http://127.0.0.1:8480`, with or without a pin (§12.1: plain http with a
  pin only on loopback).
- `/tls/ca.pem` itself is fetched without verifying the proxy's certificate
  (it is signed by the CA being fetched); the PEM's fingerprint against the
  pin is the check, and no token is sent on that request.

### 12.4 Archive and `via`

Unchanged: the archive already groups by url + token and translates
proxy ids to cams ids. The SSE group and the archive group become the same
object (`server/proxy/groups.ts`), so the two can't disagree.

### 12.5 For the later overview page (not built here)

What makes it cheap: one `GET /api/stills/latest` per proxy every 2–5 s, then
`previews/latest.jpg` (tile) or `stills/latest.jpg` with `If-None-Match` per
camera whose ts changed (§6.4); events for all cameras from the per-proxy SSE
streams cams already holds (§12.2), merged across proxies by the existing
top-bar merge. cams needs a relay route for `latest.jpg` that passes ETag and
304 through.

## 13. Several proxy hosts

Approved by Klaus, 2026-10-05. The house can have any number of proxy hosts:
the Pi, one or more mini PCs, and the cluster's proxy for cam2. Each has one
or more cameras.

### 13.1 cams is the one aggregation layer

- cams is where all proxies come together: one camera pulldown, Video and
  Timeline per camera, the Archive page merging every proxy's archive (the
  `via` groups, §12.4), the top bar merging the notifications of every
  proxy's SSE stream (§12.2), and later the overview grid across all
  cameras (§12.5).
- **No "proxy of proxies" layer.** A middle tier that collects the proxies
  would only add a single point of failure, and a second place for tokens
  and pins. cams already talks to each proxy directly.
- **Per proxy, by design:** the admin UI (settings, audit log, maintenance,
  status) and the host-wide budgets (storage, Vision limits, recordings
  cache, compositions) belong to that host. cams links to each proxy's UI
  (`publicUrl`, sign-in links with `adminToken`) as today.

### 13.2 Rules

- **cams camera ids are unique across all proxies.** Proxy-local ids may
  collide (two hosts may each call a camera `cam1`); `proxy.camera` maps
  cams's id to the proxy's (§12.1).
- **One subnet per proxy host's camera network**: `192.168.60.0/24` for the
  first mini PC, `192.168.61.0/24` for a second, and so on. Each gets its own
  static route on the router via that host's LAN address (§14.3). The Pi has
  no camera network (cam1 is on the LAN).
- **One CA fingerprint pin per proxy host** (§10.1): each host has its own
  site CA, so cams holds one pin per proxy group. A proxy without a site CA
  (the Pi, the cluster proxy) has no pin and keeps its current trust (§11).
- **Shared Google Vision key:** proxies that use the same key each count only
  their own calls (§8.2). Split the monthly limits so that their sum stays
  within the budget, e.g. Pi 300 + mini PC 700 for the 1,000 free calls.

### 13.3 Configuration now: a generated `cameras.json`

A small generator in cams, **`scripts/cameras-config.ts`** (run with `npx tsx
scripts/cameras-config.ts`), writes `cameras.json` from a short list of
proxies, so nobody hand-edits several near-identical entries.

- **Input:** a JSON file, by default `cameras-config.json` next to the
  output, mode 600, never committed. It holds one entry per proxy:
  - `url`, optional `tlsServername`;
  - `caFingerprint` (absent for a proxy without a site CA);
  - the `token` and optional `adminToken`;
  - the cams camera user's credentials for that proxy's cameras
    (`cameraUser`, `cameraPassword`; the proxy doesn't know them), with
    per-camera overrides;
  - an optional `prefix` for new cams ids and optional per-camera
    `id`/`name`;
  - for a proxy without a site CA, the camera TLS settings (`protocol`,
    `tlsServername`) as they are today.

  Every secret field may instead name an environment variable (`"token":
  {"env": "PROXY_GARAGE_TOKEN"}`) or a file (`{"file": "…"}`). There are no
  secrets on the command line, and the script never prints a secret (diffs
  show `•••`).
- **What it does:**
  - For each proxy, it fetches `/tls/ca.pem` and checks it against the pin
    (when there is one), then `GET /api/cameras` with the token over that
    verified TLS.
  - It builds one entry per camera: `host: "from-proxy"` (or the reported
    address for a proxy without a site CA, as today), `protocol: "https"`,
    the camera's `tlsServername` from the proxy's `tls.servername`, the
    `proxy` object with `camera` = the proxy's id, and the shared
    url/token/pin.
- **Stable ids:** an existing entry whose `proxy.url` + `proxy.camera`
  matches keeps its cams id and name, so preferences, the archive's `via`
  and links don't change. A new camera gets `id` from the input, or `prefix`
  + its proxy id.
- **Checks:**
  - Any id collision across proxies stops the script and names both.
  - A camera that a proxy no longer lists is kept and reported (`--prune`
    drops it).
  - An unreachable proxy or a wrong pin stops the script; nothing is
    written.
- **Dry run by default:** it prints a diff against the existing file.
  `--write` writes it atomically (mode 600), keeping the old file as
  `cameras.json.bak-<time>`.
- **Where the output goes:** on the Pi, straight to cams's `cameras.json`.
  For the cluster, the file becomes the `cams-cameras` Secret: Klaus applies
  it (kube-setup owns the manifests).
- **Re-run when cameras are added** to any proxy.
- Tests: against the fake proxy (`test/proxy/fakeProxy.ts`) with two fake
  proxies, including colliding proxy ids, a wrong pin, and the stable-id
  rule.
- Built in P3 (before the hardware): it works for today's proxies without a
  pin, and its pin path is tested against a fake proxy with a test CA. P5
  uses it for real with the mini PC's pin.

### 13.4 Later (not planned; seams kept)

- **Configuration from the cams interface:** "Add proxy" (url + token + CA
  fingerprint) imports its cameras, using the generator's logic as a library
  (`server/cameraImport.ts`, which the script calls). The registry would then
  need a writable store instead of the read-only Secret file.
- **A separate Admin app with an installer wizard** for host setup, proxy and
  cams config in one flow.
- **A cams overview of every proxy's health and Vision usage**, from each
  proxy's health summary (§6.5) and analytics state. It needs a client-token
  read of the health summary, which is a small proxy API addition.

## 14. Network and firewall (the mini PC)

### 14.0 Operating system

- **Debian 13 ("trixie"), installed by us (recommended).** It is the same
  family as Raspberry Pi OS on the Pi, so the packages, paths, systemd units
  and the setup guide's habits carry over. nftables is Debian's default
  firewall, and dnsmasq and chrony are stock packages.
- **Docker from Docker's own apt repository** (not Debian's `docker.io`),
  with `"iptables": false, "ip6tables": false` in `/etc/docker/daemon.json`
  (§14.2). Compose as on the Pi: `/srv/cam-proxy` with the same layout.
- **Ubuntu Server 24.04 LTS is an acceptable alternative.** Same tools
  (nftables, dnsmasq, chrony, Docker's apt repository). Netplan replaces
  `/etc/network/interfaces`, and systemd-resolved must be kept off the
  camera side.
- A minimal install: no desktop, SSH with key auth, unattended security
  updates.

### 14.1 Addresses

- LAN side `enp1s0`: an address from the router's DHCP (the router keeps an
  address per MAC; no reservation needed), e.g. 192.168.1.230. The router's
  static route points at it.
- Camera side `enp2s0`: static `192.168.60.1/24`. **Camera subnet
  `192.168.60.0/24`, confirmed by Klaus**, behind the host. It doesn't
  overlap the LAN or the k3s defaults (10.42.0.0/16 pods, 10.43.0.0/16
  services); P4 checks this against kube-setup's actual CIDRs.
- Fixed leases: the second GPS-208's management address `.2` (§8.4), cameras `.11`–`.29` (cam3 → `.13`
  etc.), a small dynamic pool `.100`–`.149` for a new device until it gets
  its lease.

### 14.2 The sketch (prose; the setup guide written in P4 has the files)

- **sysctl:** `net.ipv4.ip_forward = 1`; no IPv6 forwarding and no router
  advertisements on the camera side (IPv4 only there).
- **Docker:** set `"iptables": false, "ip6tables": false` in
  `/etc/docker/daemon.json`. Every container here uses host networking, and
  Docker's own rules otherwise set the FORWARD policy to DROP and would
  silently break the routing. The host's nftables ruleset is the only one.
- **nftables** (`table inet filter`):
  - `forward` (policy drop): accept `ct state established,related`; accept
    LAN (`iifname enp1s0`) to `ip daddr 192.168.60.0/24` (decision 2: LAN →
    cameras allowed, all ports: HTTPS, RTSP, ONVIF, 9000 for the Reolink app
    by IP); drop and count everything from `enp2s0` (cameras → LAN and
    internet, including DNS and the switch's cloud API); no masquerade
    anywhere, so cameras see the real LAN client and replies route back via
    the host.
  - `input` (policy drop): accept established; loopback; from `enp1s0`: SSH,
    8443 (proxy HTTPS), 8480 only from loopback (or the LAN if Klaus wants
    the old URL during the switch-over), ICMP; from `enp2s0`: UDP 67 (DHCP),
    UDP 123 (NTP), TCP 2121 and the passive range (FTP), ICMP; nothing else
    (cameras can't reach the proxy API).
  - `output`: accept (the proxy reaches cameras, switch, Vision, GHCR).
- **dnsmasq**, camera side only: `interface=enp2s0`, `bind-interfaces`,
  `port=0` (no DNS: the cameras have nothing to resolve), a `dhcp-range` for
  the small pool, one `dhcp-host=<MAC>,<name>,<IP>,infinite` per camera and
  the switch, `dhcp-option=option:router,192.168.60.1` (cameras need the
  host as their gateway to answer LAN clients), `dhcp-option=option:ntp-server,192.168.60.1`.
- **chrony:** syncs from public pools over the LAN; `allow 192.168.60.0/24`;
  `local stratum 10` so the cameras keep a common time while the internet is
  down (the demo case). The proxy also sets each camera's NTP server to
  192.168.60.1 by a whole-object `SetNtp` (§15: measure `GetNtp` first),
  because the firmware may ignore DHCP option 42.

Consequences of "cameras → internet blocked" Klaus should expect: the
Reolink app's cloud/P2P remote view and push notifications stop for these
cameras, firmware update checks stop, and LAN discovery in the app doesn't
cross the route (adding a camera by IP works).

### 14.3 The home router's static route (finding)

**The router:** ASUS **RT-AX86U**, stock firmware **3.0.0.4.388_24436**
(Klaus, 2026-10-05).

**Where the route goes (stock Asuswrt 388).** This follows ASUS's
documentation of the stock web UI. Every detail marked *(verify)* is still
**to verify on the device**:

1. Advanced Settings → **LAN** → tab **Route**.
2. **Enable static routes: Yes** *(verify the label and that the switch
   exists in 388_24436)*.
3. Add one row to the static route list:
   - **Network/Host IP:** `192.168.60.0`
   - **Netmask:** `255.255.255.0`
   - **Gateway:** the mini PC's LAN address (e.g. `192.168.1.230`)
   - **Metric:** empty or `1` *(verify whether the field is required)*
   - **Interface:** `LAN`
4. Press **+** to add the row, then **Apply**. *(Verify that the route
   applies without a router reboot and survives one.)*

Whether the 388 UI also offers to push the route to clients by DHCP (option
121) is *to verify on the device*. The design doesn't need it.

**The hairpin.** A LAN client without its own route sends camera traffic to
the router. The router forwards it back out of its LAN port to the mini PC,
and the camera's reply goes from the mini PC straight to the client. The
mini PC sees both directions, so its conntrack is complete; the router sees
only the client's side. Stock Asuswrt filters WAN traffic with its SPI
firewall, not LAN to LAN, so this usually works. Whether the RT-AX86U
forwards LAN to LAN through its hardware acceleration without dropping the
one-sided flow was the open point; the pre-arrival test below showed that it
hairpins.

**Pre-arrival test, with the Mac standing in for the host.** It checks
the router half of the design (route entry, hairpin, LAN-to-LAN forwarding)
before the PC exists. The Mac takes the host's future camera-side address,
`192.168.60.1`:

1. On the Mac (LAN address `192.168.1.35`, Wi-Fi `en0`): put the alias **on
   the interface the route points to**:
   `sudo ifconfig en0 alias 192.168.60.1 netmask 255.255.255.255`. Then run
   a test server, `python3 -m http.server 8060 --bind 192.168.60.1` (the
   macOS firewall must allow it). Not `lo0`: macOS sends replies out of the
   interface that holds the source address, so with the alias on `lo0` the
   requests arrive but no reply ever leaves (seen in the run below).
2. On the router (LAN → Route, static routes enabled): network
   `192.168.60.0`, netmask `255.255.255.0`, gateway `192.168.1.35`,
   interface `LAN`, then Apply. **Double-check the Network field.** A typo
   that makes it a /24 over the LAN itself (e.g. `192.168.1.x`) would send
   the LAN's own traffic to the gateway, which is harmful.
3. From the Pi (`192.168.1.220`, another LAN client): `ping -c 3
   192.168.60.1` and `curl -v http://192.168.60.1:8060/`. The packets go to
   the router, are hairpinned to the Mac, and the Mac answers the Pi
   directly: the same reply path the mini PC will use. If anything fails,
   `sudo tcpdump -ni en0 host 192.168.60.1` on the Mac shows whether the
   router forwards at all.
4. Cleanup: stop the server, `sudo ifconfig en0 -alias 192.168.60.1`, delete
   the route on the router and Apply.

**Result (Klaus, 2026-10-05, about 12:40):** on the RT-AX86U
3.0.0.4.388_24436, the static route was entered as in step 2 (the first try
had the typo `192.168.1.60` in the Network field and was corrected). With the
alias on `lo0`, tcpdump showed the requests arriving but macOS sent no
replies: a stand-in artifact, not the router. With the alias on `en0`, from
the Pi: ping with 0 % loss (about 70 ms, over the Mac's Wi-Fi), and `curl
http://192.168.60.1:8060/` answered 200 in 14 ms. The router also sends ICMP
redirects (the Pi's ping counts them as "+N errors"). They are harmless:
clients may then go to the gateway directly.

**Conclusion: the hairpin static route works on this router.** The NAT
fallback is not needed. Still to run: the same test from a **cluster node**
(k3s pods leave the cluster with the node's address, so a node test covers
cams's path), through the kube-setup session, before P4 depends on it.

**Test procedure on the device** (after the PC arrives; run it before
anything else depends on the route):

1. **From a LAN client** (the Mac), with no route of its own:
   - `ping -c 3 192.168.60.13` (a camera)
   - `curl -vk --connect-timeout 5 https://192.168.60.13/` (TLS handshake
     and an answer from the camera's web server)
   - `traceroute -n 192.168.60.13`: expect the router, then the mini PC,
     then the camera. If an ICMP redirect was taken, the router hop may be
     missing.
2. **From a cluster node** (via the kube-setup session, which owns the
   nodes): the same three commands, then the same `curl` from a pod in the
   cams namespace. This is what cams will do; it needs the egress rule from
   §14.4 first.
3. **Check the reply path on the mini PC:** `tcpdump -ni enp1s0 host
   192.168.60.13` and `tcpdump -ni enp2s0 host <client>` during the curl.
   Expect the SYN in on `enp1s0` and out on `enp2s0`, and the SYN-ACK in on
   `enp2s0` and out on `enp1s0` straight to the client's MAC (not the
   router's). `conntrack -L -d 192.168.60.13` shows the flow as ASSURED.
4. **If replies are dropped,** look in this order:
   - the mini PC's nftables counters (the `forward` chain's drop counter;
     `ct state established` must match the replies) and
     `sysctl net.ipv4.ip_forward`;
   - `rp_filter` on the mini PC (`net.ipv4.conf.*.rp_filter`): strict mode
     can drop the client's packets if the client address looks like it
     belongs on another interface; set it to 2 (loose) on `enp1s0`;
   - **ICMP redirects:** the router may tell the client "use the mini PC
     directly". That is harmless if the client follows it, and the result
     is the same. If the client ignores it while the router stops
     forwarding after sending it, set `send_redirects` off on the router
     *(verify whether the stock UI allows it; it probably doesn't)*;
   - **the router's LAN-to-LAN forwarding:** if a `tcpdump` on the mini PC
     shows no SYN at all, the router doesn't forward. Check that the route
     is listed under Network Tools / the routing table *(verify where 388
     shows it)*, and try with NAT acceleration off (LAN → Switch Control)
     *(verify the setting's name)*;
   - a client with a stateful firewall (rare on the LAN) that drops the
     SYN-ACK because it comes from the mini PC's MAC.
5. **Decide:** if steps 1 and 2 pass and the route survives a router reboot,
   keep the route. If not, use the fallbacks below in order.

Alternatives if the router can't (ranked; kept for reference, not needed
after the 2026-10-05 test):

1. **1:1 NAT on the host:** the host takes one extra LAN address per camera
   (outside the router's DHCP pool) and DNATs/SNATs it to the camera. No
   client or router change; works for phones and the cluster; cert SANs gain
   the LAN alias. Costs: free LAN addresses to pick, the camera sees the
   host as its client, and RTSP/ONVIF answers that embed the camera's own
   address point at the camera net (cams doesn't use them).
2. **Static routes on the clients:** the cluster nodes (a kube-setup change
   in the node network config) and the Mac. Symmetric and clean, but phones
   and other devices can't reach the camera web pages (only the proxy and
   cams).
3. **Port-forwards on the host's one LAN address** (e.g. 8443+n → camera n
   :443): simplest, but non-standard ports for every camera, a list to
   maintain, and only the forwarded ports work.

### 14.4 How cams in the cluster reaches proxy and cameras

- cams → proxy: the host's LAN address directly (`https://192.168.1.230:8443`),
  no route needed.
- cams → cameras: pod → node (k3s masquerades pod traffic leaving the
  cluster to the node address) → default gateway (the router) → static
  route → host → camera; replies via the host straight to the node.
- kube-setup request (P4): allow cams's egress to `192.168.60.0/24:443`
  and to the host's `8443` (the NetworkPolicy today allows cams →
  cam-proxy:8480 only), and update the `cams-cameras` Secret with the new
  entries and pins (Klaus).
- **Between P4 and P5** the proxy has no HTTPS yet, so the host opens 8480
  to the LAN (the §14.2 switch-over case) and cams uses
  `http://192.168.1.230:8480` without a pin, as it does for the Pi today; the
  egress request covers 8480 for that time. P5 switches cams to the pinned
  `https://…:8443` URL, then closes 8480 to the LAN again and drops that
  egress.

## 15. Testing

- **Unit:** config translation (legacy `camera`, overrides, env with one vs
  several cameras), the keyed-collection schema node, per-camera override
  resolution, storage eviction with and without shares, Vision limits per
  key across cameras and the migration of `analytics_usage`, the PoE queue
  (a fake switch that holds one session), FTP user → camera mapping and the
  source-address check, CA issuance (name constraints present and enforced
  by Node's verifier), leaf SANs, renewal timing, the health summary's
  aggregation (one camera = today's JSON, fixture-compared with the
  display's `tests/fixtures/pi-ok.json`).
- **Integration (vitest, in process):** one proxy with **three cam-sim
  instances** on their own ports: stills from each, events with the right
  `cam`, FTP uploads from two cameras at once landing under the right ids,
  a cam-sim killed and restarted while the others keep producing (the
  supervision test), recordings fetched from two cameras in parallel, cert
  push to cam-sim (it implements CertificateClear/ImportCertificate and
  serves the import) and the fallback when the import is refused (a cam-sim
  fault to add, mirroring the real firmware's 200-and-no-change).
- **e2e (Playwright):** the admin UI's camera picker, per-camera Settings
  and actions, the Certificates card; a one-camera config run of the
  existing suite unchanged (the Pi compatibility gate), except the tests
  that read `GET /control/config` keys, which move to the new paths
  (§4.2).
- **cams:** the fake proxy (`test/proxy/fakeProxy.ts`) serves several
  cameras and one SSE; tests for proxy groups, one upstream stream per group,
  fan-out, CA-pin verification (good pin, wrong pin, rotation list), the
  fallback leaf pin; cams's real-proxy e2e (Silo) gets a two-camera proxy.
- **livestack:** a multi-camera variant (cams → one cam-proxy → 3 cam-sims,
  HTTPS with a pinned site CA).
- **Measure on the real camera first** (memory: the sim copies the real
  camera): `GetNtp`/`SetNtp` (whole object), and an import of a site-CA RSA
  2048 leaf. Both touch a camera setting; they run on a camera of the new
  host when it arrives (P4), never on cam1, which stays independent (§11). cam-sim then gets
  `GetNtp`/`SetNtp`.
- **Network (manual, on the host, checklist in the guide):** from the Mac
  and from a cluster pod reach a camera's HTTPS; from the camera side no
  internet (a laptop on the camera switch: DNS and HTTP out fail, NTP to the
  host works); FTP from a camera; the router route survives a router reboot.

## 16. Phased delivery

The PC arrives in about two weeks (Klaus, 2026-10-05). Everything that can be
built and tested with several cam-sim instances comes first; the device work
follows its arrival.

**Before the hardware (cam-sim only):**

| Phase | Repo | Content | Done when |
|---|---|---|---|
| **P1** config + runtime per camera | cam-proxy | `cameras[]` + legacy translation, keyed-collection schema, `CameraWorker`, `cameraParam` routing, `/api/cameras` list, health `cameras[]` with the compatible top level, audit/inventory camera labels, `analytics_usage` migration, admin UI camera picker (read-only status per camera), supervision | 3 cam-sims in tests; the one-camera suite (apart from the `GET /control/config` keys, §4.2) and the display fixtures unchanged |
| **P2** host-wide services | cam-proxy | one go2rtc with N streams, FTP user mapping, storage shares, Vision per key + per-camera cap, PoE queue with the driver interface (fake driver in tests; `sscpoe-web` unchanged), `composition.concurrent`, per-camera Settings/actions in the UI, control API camera routes, latest-still endpoints, metrics `cam` label | 4 cam-sims on the Mac or a CI runner; the Pi runs the release unchanged |
| **P3** cams mapping | cams | proxy groups, one SSE per proxy with fan-out, archive and SSE on one group object, the `cameras.json` generator `scripts/cameras-config.ts` (§13.3), fake proxy with several cameras, real-proxy e2e with a two-camera proxy, livestack multi-camera variant (cams → one cam-proxy → 3 cam-sims over HTTP) | cams shows several cameras of one proxy over one stream |
| — router pre-test | (Klaus) | the Mac stand-in test of §14.3 | the RT-AX86U hairpins to the stand-in |

**After the PC arrives (on the device):**

| Phase | Repo | Content | Done when |
|---|---|---|---|
| **P4** host setup | cam-proxy (docs) | Debian 13 install, Docker from Docker's repository, nftables, dnsmasq, chrony, the router route and its on-device test (§14.3), compose; `docs/multi-camera-host.md` written as it is done (with the ranked fallbacks); measure the real cameras' `GetNtp`/`SetNtp` and certificate import; the second GPS-208 on `192.168.60.2` (DHCP or static, §8.4) with the existing driver; the kube-setup request (egress to the camera subnet and the host, the `cams-cameras` Secret) | cams in the cluster reaches the cameras and the proxy over the route |
| **P5** TLS / site CA | cam-proxy, cam-sim, cams | CA + leaves, HTTPS listener, cert push and renewal, Certificates card, health item, `/tls/ca.pem`, NTP set; cam-sim refusal fault + NTP; cams CA/leaf pinning, proxy `tlsServername`, fallback pins | pushes verified on the real cameras; cams verifies proxy and cameras against the pin |

Each phase is its own plan and PR series; releases follow the usual rule
(release when ready).

**Order across the repos.** cams P3 needs no proxy release except for its
real-proxy e2e and the livestack variant, which wait for the P1+P2 release
(`cameras[]`, `features`). cams P5 is built against its fake proxy and
waits for proxy P5 only for its livestack HTTPS variant and for real use.
**Mixed versions stay working after every phase:** a new cams with an old
proxy (one id per group, `?cam=<id>` as today; no `features`, so no list
filter; no `tls` block, so no fallback pins; no pin configured, so no
`/tls/ca.pem`), and a new proxy with an old cams (a single `?cam=` is a
list of one; new fields in `GET /api/cameras` are ignored; HTTP on 8480
stays). The Pi and the cluster proxy are such one-camera proxies the whole
time. Because the multi-camera runtime is released before
the PC arrives, the Pi runs it first, as a one-camera host. That is the
compatibility gate of decision 5 in production.

### Migration

cam1 stays on the Pi (Klaus), so nothing migrates: the mini PC starts with
new cameras and an empty data folder. Moving a camera with its data between
hosts would need a catalog import tool (archive and event ids collide); it
is not planned.

## 17. Cluster dependency after the change

| Today in the cluster | After |
|---|---|
| cams + its certificate (cert-manager, Traefik) | stays (decision 7) |
| cam1 Certificate (HTTP-01), `cam1-cert-push` CronJob, `cam1-camera-credentials`, the two Grafana certificate alerts | **stay for now** (Klaus): the Pi keeps Let's Encrypt. They are the last camera dependency on the cluster; the later option of §11 (the Pi as its own site) would remove them. The mini PC's cameras never use them |
| `cam1.skylar.technology` public DNS name | stays with cam1's Let's Encrypt certificate; the mini PC's cameras have no public names |
| LAN DNS | none, before or after |
| cam2 (cam-sim) + the cluster cam-proxy | stay as the cluster's simulated pair; not a dependency of any real camera |
| Prometheus/Grafana scraping cam-proxy | optional; nothing depends on it |
| Release workflows (images, cluster rollout) | unchanged; the Pi and the mini PC are updated by `docker compose pull && up -d` (memory: update the Pi after releases; the mini PC joins that step) |

## 18. Open questions for Klaus

None open. Klaus's answers resolved the first draft's questions ("Answers"
at the top). The router test answered the NAT question (§14.3: not needed),
and the switch is a second GPS-208 (§8.4). Still to do, but not a question:
the router test from a cluster node (§14.3), and the GPS-208's address
setup on the device (§8.4).
