# Changelog

## Unreleased

- Recordings from the camera's SD card (spec 2026-10-02-baichuan-recordings-design): `GET /api/cameras/:cam/recordings?from=&to=&stream=` lists them (at most 48 hours; `id`, `start`, `end`, `stream`, `size`, `kinds`, and `clipId`, the FTP copy if there is one), `GET /api/cameras/:cam/recordings/days?month=YYYY-MM` the days with recordings, and `GET|HEAD /api/cameras/:cam/recordings/:id` serves one as MP4. The file is fetched over Reolink's Baichuan protocol (TCP 9000), not HTTP `cmd=Download`, which the RLC-1224A refuses since 2026-10-01; full resolution on demand, also for recordings FTP never delivered. It streams while it arrives and is kept in a cache. One download at a time per camera; parallel requests for one file share it, a viewer who stops reading is dropped after 5 s while the cache keeps filling, and a late joiner is served from the cache. `Range` comes from the cache (`Range: bytes=0-` on a file not yet cached, how a `<video>` opens, streams while it arrives as 200 with the whole file; a file that can't be cached, or several ranges, get the whole file with 200; a range past the end is 416 without a download); the `ETag` is the id and size (304, `If-Range`); `HEAD` never downloads. Errors: 400 `invalid`, 404 `unknown_recording`, 503 `camera_offline` (the poller says offline or no connection could be made), 502 `recordings_unavailable` with `reason` `refused`, `auth`, `timeout`, `protocol`, `offline` (lost mid-transfer) or `search_failed`; after the first byte the connection is cut. A camera reboot or power-cycle resets the Baichuan session. The Baichuan client is ported from reolink_aio (MIT, see THIRD_PARTY_NOTICES).
- Recordings settings: `camera.baichuanPort` (default 9000, applies at the next connection) and `recordings.cacheMB` (default 2048, 64 to 1,048,576, applies at the next fetch or storage run). The cache is a storage kind (`recordings`, in `/control/stats` disk usage and the disk metrics): never aged out, capped by `recordings.cacheMB` (so its writes don't count toward the days until the disk is full), and the first thing deleted when the storage budget is exceeded, least recently used first, never a file in use; below `storage.minFreeBytes` files are streamed without being kept. The daily storage audit record lists `recordings`; reading a recording writes no audit record.
- Recordings status: the Status page has a "Recordings (SD card)" card with the last download and the cache fill (amber for timeout and offline, red for auth, refused and protocol, grey for not found and before the first download); `/control/status` has `recordings` (the last download: `at`, `result`, `stream`, `bytes`, `ms`; and the cache's `bytes`, `files`, `capBytes`); metric `camproxy_recording_downloads_total{cam,stream,result}`; one `recording_download` info log line per download. A stopping proxy stops a running download (cmd 9) and closes the Baichuan session; a change of `camera.baichuanPort` closes it, so the next download connects to the new port.
- Status page (#93): the FTP card reads the camera's FTP settings (when the camera comes online, every 5 minutes, and after a setup or off; never the password) and shows "Camera upload". It turns red, with an alert and a "Point the camera's FTP here" button, when the camera's FTP upload is off, points somewhere other than this proxy (server, port or user), or when no clip arrived for `ftp.stalledHours` (new setting, default 6, 1–72) while the camera recorded motion, person, vehicle or pet events. A quiet day is no warning. Only another server name (port and user match) is amber; a camera with no FTP server set that never sent a clip (fresh or reset) is grey, "FTP upload isn't set up on the camera", with no alarm. An intentional `camera-ftp-off` stays red while `ftp.enabled` is true; set `ftp.enabled: false` to silence it. The time of the last clip outlives clip retention (catalog version 5). On 2026-10-01 the upload had been off for 37 hours unnoticed. `/control/status` has `ftp.camera` and `ftp.stalled`.
- Audit log: `camera-check` records each change of the camera's FTP upload (on, off, elsewhere) with the before and after. The daily activity record has `clipsReceived` and `recordingEvents`, and says so when a day had recording events but no clips (`noClips`).
- Metrics: `camproxy_camera_ftp_enabled`, `camproxy_clips_stalled`, `camproxy_clips_last_received_timestamp_seconds`.

## v2026.10.01.5

- Maintenance page: "Power-cycle camera" cuts the camera's PoE power on its switch for 10 s and turns it on again (`POST /control/actions/camera-powercycle`, admin only), when a switch is configured: `camera.poeSwitch` (`model` `sscpoe-web` for the STEAMEMO GPS-208 and kin, `host`, `port`, `ports`, `offSeconds`; they apply at once) and the optional secret `CAMPROXY_POE_SWITCH_PASSWORD`. It refuses a port with PoE off or no power draw (409 `no_power`), says when someone is logged in to the switch's web UI (409 `switch_busy`) or the password is wrong (502 `switch_auth`), and always logs out of the switch. The camera's state shows "power-cycling", then "rebooting" until it answers again; the 120 s cooldown is shared with "Reboot camera". Once the PoE-off request is sent, any failure (a lost or refused answer, a timeout) turns PoE on again, retried with backoff for about a minute, and the answer and the audit record say whether PoE is on again (`poeOff`, `turnedOn`). "Turn camera PoE on" (`POST /control/actions/camera-poe-on`, audited as `camera-poe-on`) turns the camera's PoE on if it is off, and the page warns while it may be off. A login the switch doesn't answer counts as busy; a retry keeps the switch session until the switch answered its logout, so a stuck session can't lock out the proxy and the switch's web UI; an off the switch refuses while the port keeps its power counts as refused (nothing cut). A proxy stopping mid-cycle turns PoE on first (bounded to fit the 20 s stop grace) and audits it if PoE may be left off. Audited as `camera-powercycle` (never the password). The Status page and a new PoE switch card on the Settings page show the switch and its last reading ("Read the switch now", `POST /control/actions/poe-switch-read`); the proxy never polls the switch. See docs/poe-switch.md.
- Settings page: an optional number without a value yet (like `camera.poeSwitch.port`) is saved as a number; `GET /control/config` answers each setting's `type`.
- Maintenance page: "Restart proxy" can't be confirmed twice, and a failed first `/health` read no longer reloads the page on the old process (and a new process that answers first is still recognised by its start time).
- A refused camera reboot says "in progress" while one is being sent, instead of "rebooted less than 2 minutes ago".

## v2026.10.01.4

- Maintenance page: "Reboot camera" reboots the camera (`POST /control/actions/camera-reboot`, admin only). It asks first; afterwards the page shows "Rebooting…" and the camera's state, and the Status page shows "rebooting (requested HH:MM)" until the camera answers again or 5 minutes pass. Another reboot within 120 s is refused (429). The proxy drops its camera token and rides it out: ONVIF re-subscribes on its own. Audited as `camera-reboot`, with a second record when the camera is back (`downSec`) or not back after 5 minutes.
- Maintenance page: "Restart proxy" restarts the proxy process (`POST /control/actions/restart-proxy`, admin only): the normal graceful stop, then exit 0, and compose or the cluster starts it again (run directly, the process just ends). The page shows "Restarting…" and reloads when the new process answers; after 2 minutes without it, it says so. Sign in again afterwards. Both buttons share one confirmation dialog on the page.
- Audit log: `proxy-restart` now means only the process restart. The camera-side restart (`POST /control/actions/restart`, "Restart camera side") is recorded as a `control-action` with `action: restart`. `proxy-stop` has the reason `restart-requested` after a process restart.
- `/health` also answers `startedAt`, the time the process started serving.
- Audit log: the daily storage record says "N minutes of stills" (it counts minute files, not single stills).
- Status page: "Days until full" says "more than a year" past 365 days, as the daily storage record does.
- A token in the URL (`?token=`, `?access_token=`) is now refused on the sign-in routes (`/control/login`, `/control/login-link`, `/control/logout`, `/control/session`) too.
- Audit log: the daily storage record says "more than a year until full" instead of a day count past 365 days (`daysUntilFull` keeps the number).
- Audit log: a `config-change` record marks each setting that waits for a restart (`restart: "restart"`, or `"process"` for a new process).
- Audit log: `HEAD /control/audit` answers like GET (it was 403 even for admins).
- Audit log: the audit folder's growth per day counts calendar days over the last 7 whole days (days without records count as 0, today is left out by its date), so the storage projection no longer overstates it.
- Audit log: a user agent or refused path cut at its length limit no longer ends in half an emoji.
- Stills: a camera stream that holds back a second of frames and then delivers them at once (cam-sim does every 4 s) no longer leaves a missing still every few seconds; frames up to 2.5 s late keep their own second.
- Events: an event that starts right after the proxy subscribes to the camera's events again (after a camera restart, a network blip or the restart action) is no longer taken for the initial state and lost. Each event kind now starts at its own camera message time when several arrive in one pull.
- Analytics: set or override the Google Vision key on the Settings page (or `PUT /control/secrets/google-vision-key`). It is used from the next call on and lifts an invalid-key pause. It is kept in memory only, never saved, logged or returned: a restart of the proxy restores the configured key, or none. The card says "Manual key active (AIza…wXyZ)" while it is in use, the provider state reports `keySource` (`env`, `manual`, `none`), and each set is an audit record, `secret-override`, with the masked key.

## v2026.10.01.3

- Analysis window: the table's columns read "Objects" and "Score", and the score shows as a percent ("99%"), the same as the labels on the picture.
- Audit log: who did what on the proxy, as ECS JSON lines in one file per UTC day under `<dataDir>/audit`, kept `retention.auditDays` (default 90). It records start and stop, restarts, sign-ins (with failures), sign-outs, login links, refused tokens (throttled), control actions, settings changes, and a daily storage and activity snapshot at 00:05 camera time. Read it on the new Audit page or at `GET /control/audit` (newest first or from a cursor, for a poller). Optional read-only `CAMPROXY_AUDIT_TOKEN`. The start record says when the last run ended without a stop (`uncleanStop`). See docs/audit-log.md.
- Admin sign-in: 40 sign-ins per 15 minutes per client (was 20).

## v2026.10.01.2

- Analysis modal: the purple frame keeps its rounded corners when the content is long ("Show all objects"); the body scrolls inside the frame and the title stays in place.
- Analysis modal: the labels next to the boxes read "Person 84%" (name with a capital first letter, the rounded percent); the table keeps the score (0.84).
- Analysis modal: a click on an object row (summary or all objects) draws only that object's box; a second click shows all boxes again. The selected row is highlighted, rows work with Enter and Space, an object without a box says "no box", and switching "Show all objects" clears the selection. The picture stays in view at the top while the list scrolls (at most 45% of the window height); a label at the top or right edge of the picture stays inside it.

## v2026.10.01.1

- Pi: `compose.yaml` gives the container 20 s to stop, time to end an encode and store a Vision call in flight.
- Analytics: no call for an event that retention removed meanwhile; a call in flight when the proxy stops is stored (a restart doesn't pay for it again); an attempt that isn't retried (switched off, stopping) is stored as failed; only a change to an analytics setting lifts an invalid-key pause; day counting handles DST across New Year; while the camera is down its time is asked once a minute, not on every read.
- Analytics: `CAMPROXY_GOOGLE_VISION_URL` accepts `http://` only for localhost (the key travels in a header). An answer's entry without a name or a numeric score is no longer shown as an object. A stored analysis that isn't valid JSON no longer fails the events list.
- Analytics UI: Status shows one "Analytics: not enabled" card while nothing is enabled, and the pause reason reads "invalid key (check …; switch analytics off and on, or restart, to try again)"; the settings card puts a refused checkbox back, clears its old message before a save, and shows the estimate for the saved limit while the typed one is invalid; the analysis modal shows "Loading…" and the status, closes with Esc wherever the focus is, and gives the focus back; the analysed ring stays visible on the open minute; a space before "✦ Vision".
- Composed clips: a part that reaches the 200 MB cap fails the job with that reason instead of being cut short silently; a cancelled job's folder is removed once its encoder has ended.
- A catalog file this process can't write (another owner) is reported at start, like an unwritable data folder, instead of failing at the first write.

## v2026.09.30.5

- Analytics summary: each analysis keeps persons, vehicles and pets only (by Open Images class id, duplicates merged), sent with the `analysis` stream message and served per day at `/api/cameras/{cam}/analyses` for cams; objects that don't map are counted (Status, `/control/analytics/unmapped`).
- Pi: `compose.yaml` passes `CAMPROXY_GOOGLE_VISION_KEY` to the container; the Pi guide says how to add the key.

## v2026.09.30.4

- External analytics (optional, off by default): the still of a person, vehicle or pet event goes to Google Vision, and the objects found are kept with the event and shown as a "✦ Vision" tag (Events), a mark on analysed minutes (Timeline) and a picture with boxes. Key `CAMPROXY_GOOGLE_VISION_KEY`; a monthly limit and an optional daily cap bound the calls. See README, Analytics.

## v2026.09.30.3

- Timeline: a minute opens inside its hour card, right under that hour's thumbnails, instead of at the top of the page (no scrolling). ◀ ▶ (and the arrow keys) step to the previous or next minute of the same hour. The minute names its events (kind, start–end) and frames their seconds in the event's colour, person first.

## v2026.09.30.2

- Timeline: a minute clicked in the hour grid opens at the top of the page; the open minute has a tinted background, set apart from the hour cards, and is marked in the grid.

## v2026.09.30.1

- Fix: a real camera's clip pictures were never attached. The camera names the `.jpg` after the event, 3–5 s after the clip (pre-record), and cam-proxy paired them by identical name. A picture now goes to the clip that started last at most 10 s before it, in either arrival order; on startup, stored clips without a picture are paired from the stored pictures. A stored picture is logged (`snapshot_stored`).
- Clips page: each event kind once, with a count ("motion ×3"), AI kinds first.
- The stills, previews and clips lists answer `to is before from` for a reversed range, instead of saying the range is missing.
- Docs: a [Raspberry Pi guide](docs/raspberry-pi.md) and `scripts/prepare-pi.sh`, from the first Pi install (cam1, 2026-09-29). The script also turns on the memory cgroup.
- `server.trustProxy` (0–5): the number of reverse proxies in front; rate limits then count clients by X-Forwarded-For (set 1 behind the cluster ingress). Needs a restart.
- Composed clips: stills every 2 s or more hold instead of flickering to cards (the badge names the rate); frames are dropped before scaling; a short clip file fills its part; the 200 MB budget is enforced while encoding; storage paused is checked at run start; a finished result stays while it's polled; failures say "the encoder failed" (ffmpeg's text is logged, not shown); `composition.font` needs a restart.
- FTP: both clips of the repeated autumn DST hour are kept; a publicHost name is looked up again after a minute; an unwritable data folder says which folder and what to do.
- Composed clips: a clip with pre-/post-roll from other clips, stills or "No recording" cards (`/api/cameras/{cam}/compositions`), for cams' Downloads. The container adds the DejaVu font; `composition.font` overrides it.
- One-time sign-in links for the admin UI: `POST /control/login-links` (admin token) returns a code valid once for 60 s; `GET /control/login-link?code=` redeems it for a UI session. cams uses it so a signed-in user needn't paste the token.
- `/api/cameras` reports `publicUrl` (the `server.publicUrl` setting, no longer reserved), so cams can link to the proxy's web UI.
- `GET /api/cameras/{cam}/extent`: the oldest clip, still and preview kept, so a client (cams' History strip) knows how far back it can go.
- Tests: cam-sim v2026.09.28.1.
- Deploy: the cluster's `ftp.stream` is `sub` (clips for cams play in every
  browser).

## v2026.09.27.2

- Deferred minors from the Plan 3 and 4 reviews:
  - FTP server hardening (no leaked passive listeners, TLS pipeline lines,
    log masking, `PROT P` without a certificate, `STOR` while paused);
  - the clip indexer checks that a `.jpg` starts like a JPEG;
  - Clips page fixes (only the newest load fills the page, the events
    window, the list isn't mutated).
- Admin UI: top-bar Refresh, live updates (Timeline, Maintenance's log,
  Refresh on other pages), links to the camera and the repo, and
  `camera.webUiUrl` (the camera model links to its own web page).

## v2026.09.27.1

- Phase 1 (core):
  - `config.json` with overrides and a generated JSON Schema; secrets from
    the environment;
  - the camera client (from cams) with a status poller;
  - ONVIF PullPoint events with re-subscription and a polling fallback;
  - the SQLite catalog, and a stream log with a resumable SSE stream;
  - the client API (bearer tokens), the control API (admin token or UI
    session), stats and Prometheus metrics, retention for rows;
  - the admin UI (status, events, settings, maintenance) and a favicon;
  - `scripts/sync-secrets.sh` and a read-only real-camera check.
- Phase 2 (stills, previews, storage):
  - go2rtc as the single camera connection (installer with pinned checksums);
  - a frame grabber writing a still every second and preview tiles;
  - minute packs and sprite sheets that describe their own settings;
  - storage management (age per kind, size budget, hard floor);
  - stills and previews API, live `still` SSE messages, stats and metrics;
  - the admin UI's Timeline page;
  - verified on the real camera (60 stills a minute, one camera connection).
- Phase 3 (clips):
  - an upload-only FTP(S) server inside the proxy (no dependency);
  - the clip indexer (camera-local names to UTC with the camera's DST rule,
    ffprobe check, snapshots, `clip` stream messages with their events);
  - the camera's FTP test file (`TestFtp`'s `.txt`) is not an index failure;
  - camera FTP setup, test and off actions (whole-object writes);
  - the clips API with HTTP Range, and the admin UI's Clips page;
  - clips in storage management (rows deleted with files, stale partial
    uploads removed);
  - `verify-camera.ts --ftp` and `camera-ftp-off.ts` for the real camera.
- Phase 4 (packaging and cluster deployment):
  - a multi-arch image (linux/amd64, linux/arm64) with go2rtc and ffmpeg,
    running as uid 1000;
  - `build-push` (branch `main`) and `release` (branch `production`)
    workflows;
  - digest-pinned deploy in kube-setup with a served-version check;
  - a container smoke test (`scripts/container-smoke.sh`);
  - `compose.yaml` for the Raspberry Pi.
- CI: tests, e2e, type checks, audit, CodeQL, no media files.
