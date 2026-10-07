# Audit log

Who did what on the proxy: starts and stops, restarts, camera reboots and power-cycles, changes of the camera's FTP upload, sign-ins (including
failures), refused tokens, control actions, settings changes, still checks, automatic Vision analyses, composed clips, and a daily
storage and activity snapshot. Design: [the spec](superpowers/specs/2026-10-01-audit-log-design.md).

## What it records

| `event.action` | category / type | When | `cam_proxy` details |
|---|---|---|---|
| `proxy-start` | process / start | every start, once it is listening | `config` (camera id, stills, ftp, analytics on or off), `previousStop` (time of the newest record when it is a `proxy-stop`, else null), `uncleanStop` (`true` when the newest start or stop record is a start: the last run ended without a `proxy-stop`, as after a crash or power loss) |
| `proxy-stop` | process / end | a clean shutdown | `reason` (the signal, `restart-requested` after `restart-proxy`, or `stop`) |
| `proxy-restart` | process / change | `POST /control/actions/restart-proxy` (the process restart), before the `proxy-stop` | `requestedBy` (`session` or `token`) |
| `camera-reboot` | host / change, then host / end | `POST /control/actions/camera-reboot`; a second record when the camera answers again, or after 5 minutes without it | the request (user `admin`): `phase: requested`, `confirmed`, `requestedBy`; outcome `success` (confirmed), `unknown` (the camera dropped the connection after receiving it) or `failure` (it never reached the camera; `error.message` has the code). The end (user `system`): `phase: back` with `downSec` (request to the first answer), outcome `success`; or `phase: not-back` with `waitedSec`, outcome `failure`. A refused request (429, within 120 s of the last reboot or power-cycle) writes nothing |
| `camera-powercycle` | host / change, then host / end | `POST /control/actions/camera-powercycle` (the camera's PoE switch, [poe-switch.md](poe-switch.md)); a second record when the camera answers again, or after 5 minutes without it | the request (user `admin`): `switch` (`{model, host, port}`), `offSeconds`, `requestedBy`, `phase: requested`; on success `watts` (the draw before the cut), `offAt`, `onAt`, outcome `success`. A failure: `error.message` has the code (`switch_busy`, `no_power`, `switch_auth`, `switch_unreachable`, `switch_error`); `poeOff` says whether the PoE-off request was sent, and then `turnedOn` whether PoE is on again and `offAt` (ms) when the PoE was cut, or when the failure was seen if the cut was not; the message says "PoE may have been cut; turned back on: yes/no", and the end record follows. A proxy stop that may leave PoE off, or the switch session open (its logout unanswered), writes a failure with `phase: stop`, `poeLeftOff`, `sessionMaybeOpen`. The end (user `system`): `phase: back` with `downSec` (the cut to the first answer), or `phase: not-back` with `waitedSec`. Never the password. A request refused before reaching the switch (409 `not_configured`, 429) writes nothing |
| `camera-poe-on` | host / change | `POST /control/actions/camera-poe-on` ("Turn camera PoE on", recovery) | `switch` (`{model, host, port}`), `wasOn`, `requestedBy`; a failure has the code (and `poeStillOff`). 409 `not_configured` writes nothing |
| `camera-check` | host / change | the camera's FTP upload changed (#93): read every 5 minutes while `ftp.enabled` and the camera answers, and after `camera-ftp-setup` and `camera-ftp-off`. The baseline is the last `camera-check` record (a restart doesn't repeat it), else on | user `system`; `check: ftp`, `from` and `to` (each `{state, enable, server, port, user}`; `state` is `on`, `off`, `elsewhere`, `server_differs` (only the server name differs), or `unknown` for the first record), `mismatch` (`server`, `port`, `user`: what differs from this proxy); outcome `failure` for off and elsewhere, `success` for on and server_differs. A camera never set up (no server, no clip ever: `not_set_up`) writes nothing. Never the password |
| `login` | authentication / start | `POST /control/login` and `GET /control/login-link`, success or failure | `auth.method` (`token-form` or `login-link`); on failure `auth.reason` (`wrong-token`, `link-used-or-expired`, `rate-limited`); `auth.suppressed` |
| `logout` | authentication / end | `POST /control/logout` | with a session: `user.name` `admin`. Without one: `auth.reason: no-session`; `auth.suppressed` |
| `login-link-issued` | authentication / creation | `POST /control/login-links` (cams mints a link) | user `admin`, or `token:<label>` when a cams-admin-managed admin token minted it (its session is then a managed one, which can't widen the command policy) |
| `auth-refused` | authentication / denied | a request the auth layer answered with 401 or 403 | `auth.tokenKind` (`none`, `invalid`, `client`, `admin`, `audit`, `session`, `managed-client`, `managed-admin`), `auth.reason` (`no-token`, `wrong-token`, `admin-only`, `local-admin-only` (a cams-admin-managed admin token or its session on a route only local admin rights may change), `csrf`), `auth.suppressed`; ECS `http.request.method` and `url.path` |
| `camera-name` | configuration / change | `PUT /control/camera/name` (the Settings page's "Camera name (stored on the camera)"), once the camera was asked | `from` (the name before), `to` (the name read back from the camera; `requested` too when it differs), `requestedBy` (`token` or `session`); user `admin`. A failure (the camera refused the name, is offline or failed) has the reason as `error` and `requested`. A name refused by the rules before the call (400) writes nothing. A rename made in the Reolink app is not audited (it reaches clients as a `camera` stream message) |
| `camera-address` | configuration / change | `POST /control/actions/camera-address` (Settings → Find camera → "Use this camera"), written or refused by the `.env` guard | user `admin`; `from`, `to` (the address), `key` (`CAMERA_HOST` or `CAMPROXY_CAMERA_HOST`), `backup` (the backup file), `requestedBy`; a failure has the code as `error.message`. Never another line of the file |
| `control-action` | configuration / change | `POST /control/actions/:name` except `camera-reboot`, `camera-powercycle`, `camera-poe-on`, `restart-proxy`, `camera-address`, `archive-clear`, `inventory` and `inventory-repair` (their own records; an inventory's when the run ends) and a retention dry run (`poe-switch-read` and `inventory-cancel` are ones); the camera-side `restart` is one (`action: restart`) | `action`, `result` (`ok`, the error code or status, or `aborted`), `requestedBy` |
| `config-change` | configuration / change | `PUT /control/config`, reset of an override (`DELETE /control/config/{path}`), and Reset to defaults (`DELETE /control/config`: one record for all, message "Settings reset to defaults: …", `reset: "all"`) | `changes`: `[{key, from, to, restart?}]`, secrets redacted; `restart` is `restart` for a setting that waits for a restart, `process` for one that waits for a new process, and missing for a live one. A refused change (400) writes nothing, nor does a reset with nothing to reset. From cams-admin (migration P3): user `cams-admin`, `cmdId`, `actor`, and `rollbackOf` for a `config.rollback`; the card's Undo: the local user and `undoOf` |
| `secret-override` | configuration / change | `PUT /control/secrets/google-vision-key` (the Settings page's key field) | `secret` (`CAMPROXY_GOOGLE_VISION_KEY`), `masked` (first and last four characters, `AIza…wXyZ`), `replaced` (`env`, `manual` or `none`). Never the key. A refused key (400) writes nothing |
| `still-check` | host / access | `POST /api/cameras/{cam}/still-checks` (a second checked with Vision by hand, cams #179), each request past the input check | user `client` (the client token) or `admin`; `stillTs`, `outcome` (`ok`, `reused`, `refused`, `failed`), `source` (a reused one: `check` or `event`), `reason` (refused: `off`, `no_key`, `checks_off`, `busy`, `bad_key`, `quota`, `month`, `day`, `checks`; failed: the provider's, as in the 502), `cost` (1 when this request made a Vision call, else 0), `tookMs`, `found` (the categories found, e.g. `["person"]`), `requestedBy` (`token` or `session`). Outcome `success` for ok and reused, else `failure` (`error.message` the reason). Never the image or the key. A 400 or 404 (`no_still`) and a rate-limited request write nothing |
| `event-analysis` | host / access | an automatic Vision analysis of an event (the analytics service's call for a person, vehicle or pet event) that made a call: once per event, when it ends, ok or failed (after its one retry) | user `system`; `cam`, `eventId`, `kind`, `stillTs` (the still sent), `outcome` (`ok` or `failed`), `reason` (failed: the provider's, e.g. `timeout`, `quota`, `bad_key`), `calls` (the Vision calls made for it, 1 or 2 with the retry), `tookMs` (the last call), `found` (the categories found, e.g. `["person"]`). The message lists them with their scores ("Vision on event 812 (person): person 90%"). Outcome `success` for ok, else `failure` (`error.message` the reason). A skip (no still, the monthly limit or daily cap, a pause, analytics off) made no call and writes nothing; the analysis row and the daily `activity-daily` still count it. Never the image or the key. A result whose event was deleted meanwhile is still recorded (the call was paid) |
| `composition` | host / access | `POST /api/cameras/{cam}/compositions` (a composed clip, cams's Save dialog), each request past the input check that is not a dry run | user `client` or `admin`; `anchor` (`clip` with `clipId`, or `at` with `at`, a second: cams #179), `from`, `to` (the window, unix ms), `durationS`, `size`, `seconds` (`{clip, still, card}`: what the clip is made of), `outcome` (`started`, `busy`, `nothing_to_compose`, `storage_paused`, `no_font`), `jobId` (when started), `requestedBy` (`token` or `session`). Outcome `success` for started, else `failure` (`error.message` the outcome). A 400 or 404, a dry run and a rate-limited request write nothing |
| `archive-add` | file / creation | an archive job ended (`POST /api/cameras/{cam}/archive`, [archive.md](archive.md)), done or failed, or the space check refused it before a job (507) | user `client` or `admin`; `id`, `cam`, `name`, `source` (`{type: composition, jobId, anchor, …}`, `{type: clip, clipId, stream}` or `{type: recording, recording, stream}`), `bytes`, `labels`, `retentionDays` (null: forever), `durationS`, `quality`, `jobId`, `requestedBy` (`token` or `session`), `onBehalfOf` (the person cams names in `X-On-Behalf-Of`, when sent). A failure has the code as `error.message` (`insufficient_space` with `needed`, `free`, `minFreeBytes`; `camera_offline`, `unknown_recording`, `fetch_failed`, `source_gone`, `store_failed`, `cancelled`). A 400, 404, 409, 503 or a rate-limited request writes nothing |
| `archive-update` | file / change | `PATCH /api/archive/{id}` that changed something | `id`, `cam`, `name` (after), `changes: [{field: name\|labels\|retentionDays, from, to}]`, `requestedBy`, `onBehalfOf`. An unchanged PATCH writes nothing |
| `archive-delete` | file / deletion | `DELETE /api/archive/{id}`, and per clip of `POST /api/archive/delete` | `id`, `cam`, `name`, `bytes`, `createdAt`, `requestedBy`, `onBehalfOf` |
| `archive-clear` | file / deletion | Maintenance → Clear the Archive (`POST /control/actions/archive-clear` with the right count) | user `admin`; `count`, `bytes`, `ids`, `requestedBy`. A count mismatch (409) writes nothing |
| `archive-expire` | file / deletion | the Archive's daily cleanup (03:30 camera time), one per clip past its retention | user `system`; `id`, `cam`, `name`, `retentionDays`, `createdAt`, `expiresAt`, `bytes` |
| `storage-daily` | host / info | once per camera day, 00:05 camera time | `day`, `size`, `free`, `budget`, `used`, `daysUntilFull` (null when not growing), `kinds` (`stills`, `previews`, `clips`, `recordings`, `catalog`, `audit`, each `{bytes, files, oldest, newest, growthPerDay}`; for `recordings` oldest and newest are the least and most recently used; the audit folder's growth is its last 7 whole UTC days per calendar day), `clipRows` |
| `storage-paused`, `storage-resumed` | host / change | free space fell below `storage.minFreeBytes` (writing of stills, clips and recordings stops), or came back above it; checked every 10 s and after each retention run | `free`, `minFreeBytes` (bytes). Outcome `failure` for a pause, `success` for a resume. The stills inventory explains gaps by them (#106) |
| `activity-daily` | host / info | once per camera day, 00:05 camera time | `day`, `forDay`, `events` (`total` and `byKind`: live events only; `recovered`: events of the day recovered from the SD card by then, #75), `recordingEvents` (motion, person, vehicle, pet; live only), `clipsReceived` (and `clips`, the same count), `noClips: true` when there were recording events but no clip (the message says so), `analytics` (`vision`, `analyses` per status, and `checks`: the day's still checks `{calls, reused, refused, failed}`, cams #179; the message adds "N still checks" when calls were made), `stream` |
| `inventory` | host / info | the end of each inventory run (`POST /control/actions/inventory`): finished, cancelled or failed | user `admin`; `runId`, `kind` (`stills`, `clips`, `events`), `options` (`{camera: true}`: the clips were compared with the camera), `outcome` (`ok`, `cancelled`, `failed`), `requestedBy`, `cancelledBy` (`request`, or `stop` when the proxy stopped mid-run), `window` (`from`, `to`, `reason`: `retention`, `budget`, `store-younger`, `empty` or `sd-card` (events: the SD card's reach, shorter than `retention.eventsDays`); `retentionFrom`, `protectedFrom`; `notes`, caveats on the counts), `counts` (stills: `stillsDays`, `minutes`, `packs`, `expectedSeconds`, `presentSeconds`, `missingSeconds`, `missingPct`, `gaps`, `explainedSeconds`, `unexplainedSeconds`, `restorableSeconds`, `unreadablePacks`, `packsWithoutSprite`, `spritesWithoutPack`, `previewsPruned`, `prunedDuringRun`: packs deleted by retention while the run read them, counted as missing), `top` (the 10 longest gaps: `from`, `to`, `seconds`, `explained`: `stop`, `crash`, `reboot`, `powercycle`, `paused` (a storage pause) or null, `explainedSeconds`), `tookMs`. Clips `counts`: `clipsDays`, `clips`, `fromCamera`, `rowsWithoutFile`, `filesWithoutRow` (clip files no row points to), `snapshotsWithoutClip` (FTP pictures no clip row links), `events` (recording kinds, ended 5 min ago or earlier), `eventsWithoutClip`, `clipsWithoutEvent`; with the camera also `cameraDays`, `unknownDays` (a failed Search: never counted as missing), `recordings`, `timerOnly` (ignored), `paired`, `pairedOtherStream` (recordings here as clips of the other stream after an `ftp.stream` change: never missing), `missingLocally`, `missingLocallyBytes`, `prunedHere` (recordings older than the oldest local clip while the storage budget or `ftp.maxGB` prunes clips: not offered for repair), `goneFromCamera`, `olderThanSd` (local clips before the SD card's oldest day), `otherStream`; clips `top`: the camera days with the most missing (`date`, `state`, `recordings`, `missingLocally`, `goneFromCamera`); the window has `camera: {stream, to, oldestSdDay, unknownDays}`. Events (always with the camera): the window is the SD card's reach, at most `retention.eventsDays` (`reason` `sd-card`, `retention` or `empty`; `eventsDays`, `retentionFrom`, `camera` as for clips); `counts`: `eventsDays`, `cameraDays`, `unknownDays`, `recordings`, `timerOnly`, `spans` (per kind, overlapping recordings merged), `matched`, `missingEvents`, `missingPerson`, `missingVehicle`, `missingPet`, `missingMotion`, `events` (recording kinds, judged), `eventsWithoutRecording`; `top`: the camera days with the most missing spans (`date`, `state`, `spans`, `missing`). Outcome `success`, `unknown` (cancelled) or `failure` (`error.message`). A refused start (400, 409 `inventory_busy`, 503 `stopping`) writes nothing |
| `inventory-repair` | host / change | the end of each repair (`POST /control/actions/inventory-repair`): finished, cancelled or failed | user `admin`; `runId` (`clipsrepair-…`, `eventsrepair-…`), `kind` (`clips`, `events`), `source` (the check run it repaired from), `outcome`, `requestedBy`, `cancelledBy`, `stopped` (why it ended early or left candidates: `clip-cap`, `byte-cap` (also when candidates were skipped for the 200 MB), `max-gb`, `paused`, `failures`, `refused`, `camera_offline`, `event-cap` (an events repair: more than 1000 missing); null when it got through its list), `counts` (`candidates`, `requested`, `done`, `failed`, `skipped`, `bytes`; events: `checked`, `candidates`, `requested`, `done` (events added), `skipped` (a span whose kind had an event by then), `failed`, `donePerson`, `doneVehicle`, `donePet`, `doneMotion`), `failures` (up to 10: `id`, `start`, `error`), `tookMs`. Outcome as for `inventory`. A refused start (400, 404, 409, 503) writes nothing |
| `admin-command` | configuration / change (denied for a refusal) | a command from cams-admin (migration P2, [cams-admin.md](cams-admin.md)): one record per command that ran, with its final outcome; refusals (nacks) at most one per code per 10 minutes | user `cams-admin`; `cmdId`, `command`, `actor` (the cams-admin user it acted for), `outcome` (`ok`, `failed`, `conflict`, or the refusal code: `bad_signature`, `wrong_target`, `expired`, `replayed`, `not_allowed`, `paused`, `rate_limited`, `invalid_args`, `unsupported_version`, `busy`), `code` (a failure's: `shadows_local_token`, `store_error`, `internal`, and P3's `not_remote_settable`, `held_by_env`, `unknown_camera`, `widening_local_only`, `invalid_value`, `no_backup`, `already_rolled_back`, a camera action's error code), `changed`; a camera action run for a command writes its usual record (`control-action`, `camera-reboot`, …) with user `cams-admin`, `requestedBy: cams-admin`, `cmdId`, `actor`; for `tokens.apply` `tokens` (`revision`, `client`, `admin`, `ids`: each `{id, kind, label}`); a refusal's `suppressed` and `suppressedCmdIds` (the cmdIds of the refusals of that code since the last record, the first 50). Never a token or a hash |
| `admin-policy` | configuration / change | the allowed commands or the pause changed on the Status card or with `admin-commands` | user `admin` (or `token:<label>` for a cams-admin-managed admin token, which can only narrow), `from`, `to` (`{allow, paused, pauseReason}`), `requestedBy`. A refused widening (403 `local_admin_only`) writes nothing |
| `admin-token` | configuration / change | a managed token blocked or unblocked on the Status card or with `admin-tokens` | user as for `admin-policy`; `op` (`block`, `unblock`), `id`, `label`, `kind`. Never the hash |
| `audit-throttled` | host / info | a day's file reached 50 MB | none |

Notes on what the code does today:

- **Recordings write no audit record:** listing or downloading a camera
  recording is not audited; the cache only shows in `storage-daily`.
- **Refused tokens are throttled:** one `auth-refused` record per source IP
  and path per 10 minutes. The throttle key is the path with each run of 6 or
  more digits and each run of 16 or more hex characters replaced by `:n`, so
  numbered stills and previews (`/api/cameras/cam1/stills/<ts>.jpg`) are one
  key; the record keeps the real path. On top of that, at most 60 refused-token
  records per source IP per 10 minutes, whatever the paths. The next record
  carries `cam_proxy.auth.suppressed`, the number of refusals in between that
  were not recorded. The path in the record, the message and the throttle key
  are cut to 256 characters (with `…`), and never include the query string.
- **A start after a crash:** `proxy-start` looks at the newest `proxy-start`
  or `proxy-stop` in the last 400 days. If that is a start, it writes
  `previousStop: null` and `uncleanStop: true`. Shutdown signals are handled
  once: a second signal during the stop writes no second `proxy-stop`.
- **Rate-limited sign-ins:** at most one `login` record with `reason:
  rate-limited` per IP per 15 minutes (the limiter's window), the rest counted
  in `suppressed`. The limit is 40 sign-ins per 15 minutes per client for the
  token form, and 200 for one-time links.
- **A sign-out without a session** changes nothing and is recorded at most
  once per IP per 10 minutes.
- **The throttles keep at most 10,000 keys** (expired ones are pruned first,
  then the oldest evicted), so a flood of addresses can't grow memory.
- **`control-action` `aborted`:** the client disconnected before the answer
  was sent, so the outcome is unknown (`event.outcome: unknown`).
- **Restarts:** `proxy-restart` is the process restart (`restart-proxy`),
  followed by `proxy-stop` with reason `restart-requested` and, once the
  supervisor started it again, `proxy-start`. The camera-side `restart`
  (reconnect, apply restart settings) is a `control-action` with
  `action: restart`; before #71 it was recorded as `proxy-restart`.
- **Camera reboots and power-cycles:** `camera-reboot` and `camera-powercycle`
  from the proxy (cams reboots the camera directly, without a record here).
  "Back" means a status check answered after one failed, or the camera
  answered with a new serial number.
- **The reboot cooldown and the "rebooting" watch are in memory.** A proxy
  restart resets both: the 120 s cooldown starts over (a reboot or
  power-cycle is accepted at once), and a reboot or power-cycle in progress
  gets no end record (no `back`, no `not-back`).
- Successful bearer-token API calls are not recorded (cams makes thousands a
  day).

### Examples

Authentication, a sign-in:

```json
{"@timestamp":"2026-10-01T05:05:00.012Z","ecs":{"version":"8.11.0"},
 "event":{"kind":"event","category":["authentication"],"type":["start"],"action":"login","outcome":"success","dataset":"cam-proxy.audit"},
 "service":{"name":"cam-proxy","version":"2026.10.01.1"},"host":{"name":"cam-proxy"},"labels":{"camera":"cam1"},
 "user":{"name":"admin"},"source":{"ip":"192.168.1.35"},"user_agent":{"original":"Mozilla/5.0 …"},
 "message":"Admin signed in with the admin token",
 "cam_proxy":{"auth":{"method":"token-form"}}}
```

Authentication, a refused token (the second of a burst):

```json
{"@timestamp":"2026-10-01T05:20:11.340Z","ecs":{"version":"8.11.0"},
 "event":{"kind":"event","category":["authentication"],"type":["denied"],"action":"auth-refused","outcome":"failure","dataset":"cam-proxy.audit"},
 "service":{"name":"cam-proxy","version":"2026.10.01.1"},"host":{"name":"cam-proxy"},"labels":{"camera":"cam1"},
 "source":{"ip":"192.168.1.77"},"http":{"request":{"method":"GET"}},"url":{"path":"/control/status"},
 "message":"Refused GET /control/status (wrong-token)",
 "cam_proxy":{"auth":{"tokenKind":"invalid","reason":"wrong-token","suppressed":14}}}
```

Process:

```json
{"@timestamp":"2026-10-01T04:58:02.101Z","ecs":{"version":"8.11.0"},
 "event":{"kind":"event","category":["process"],"type":["start"],"action":"proxy-start","outcome":"success","dataset":"cam-proxy.audit"},
 "service":{"name":"cam-proxy","version":"2026.10.01.1"},"host":{"name":"cam-proxy"},"labels":{"camera":"cam1"},
 "user":{"name":"system"},
 "message":"cam-proxy 2026.10.01.1 started",
 "cam_proxy":{"config":{"camera":"cam1","stills":true,"ftp":true,"analytics":false},"previousStop":"2026-10-01T04:57:40.870Z","uncleanStop":false}}
```

Configuration (the values of a field named like a secret are written as
`"[redacted]"`: a name with `token`, `password`, `passwd`, `passphrase`, `pwd`, `credential`,
`secret`, `authorization` or `cookie` in it, or ending in `key` (any case, such as
`apiKey` or `privatekey`); not
`keyframe` or `ftp.keyFile`):

```json
{"@timestamp":"2026-10-01T06:12:30.555Z","ecs":{"version":"8.11.0"},
 "event":{"kind":"event","category":["configuration"],"type":["change"],"action":"config-change","outcome":"success","dataset":"cam-proxy.audit"},
 "service":{"name":"cam-proxy","version":"2026.10.01.1"},"host":{"name":"cam-proxy"},"labels":{"camera":"cam1"},
 "user":{"name":"admin"},"source":{"ip":"192.168.1.35"},
 "message":"Settings changed: sse.pingS",
 "cam_proxy":{"changes":[{"key":"sse.pingS","from":15,"to":10}]}}
```

Daily records (the storage record; the activity record has the same shape
with its own details):

```json
{"@timestamp":"2026-10-02T05:05:00.020Z","ecs":{"version":"8.11.0"},
 "event":{"kind":"event","category":["host"],"type":["info"],"action":"storage-daily","outcome":"success","dataset":"cam-proxy.audit"},
 "service":{"name":"cam-proxy","version":"2026.10.01.1"},"host":{"name":"cam-proxy"},"labels":{"camera":"cam1"},
 "user":{"name":"system"},
 "message":"Storage: 82.7 GB used of 150.0 GB budget, 10,080 minutes of stills, 1,312 clips, 213 days until full",
 "cam_proxy":{"day":"2026-10-02","size":229000000000,"free":98000000000,"budget":150000000000,"used":82694100000,"daysUntilFull":213.47,
  "kinds":{"stills":{"bytes":31000000000,"files":10080,"oldest":1790294400000,"newest":1790917440000,"growthPerDay":180000000},"previews":{"bytes":9000000000,"files":40320,"oldest":1789689600000,"newest":1790917440000,"growthPerDay":25000000},"clips":{"bytes":42000000000,"files":1312,"oldest":1790294400000,"newest":1790916060000,"growthPerDay":110000000},"recordings":{"bytes":312000000,"files":9,"oldest":1790900000000,"newest":1790917000000,"growthPerDay":0},"catalog":{"bytes":380000000,"files":1,"oldest":null,"newest":1790917500000,"growthPerDay":0},"audit":{"bytes":2100000,"files":7,"oldest":1790380800000,"newest":1790899200000,"growthPerDay":300000}},"clipRows":1312}}
```

```json
{"@timestamp":"2026-10-02T05:05:00.031Z","ecs":{"version":"8.11.0"},
 "event":{"kind":"event","category":["host"],"type":["info"],"action":"activity-daily","outcome":"success","dataset":"cam-proxy.audit"},
 "service":{"name":"cam-proxy","version":"2026.10.01.1"},"host":{"name":"cam-proxy"},"labels":{"camera":"cam1"},
 "user":{"name":"system"},
 "message":"Activity 2026-10-01: 212 events (motion 150, person 40, vehicle 22), 31 clips, Vision 84 of 500 this month",
 "cam_proxy":{"day":"2026-10-02","forDay":"2026-10-01","events":{"total":212,"byKind":{"motion":150,"person":40,"vehicle":22}},"clips":31,
  "analytics":{"vision":{"day":9,"monthToDate":84,"monthlyLimit":500},"analyses":{"ok":9}},"stream":{"clients":1}}}
```

(The numbers above are illustrative; the camera is in Chicago, so 00:05
camera time is 05:05 UTC. `used` is the sum of the kinds' bytes, and
`daysUntilFull` is the budget left divided by the kinds' summed
`growthPerDay`.) Past 365 days the message says `more than a year until full`
instead of the number; `daysUntilFull` keeps the number. Stills are counted in
minutes (one pack file per minute; `kinds.stills.files`), not single stills.

### Daily records in detail

- Written at 00:05 camera time (the camera's time zone, as the analytics day
  counting uses): `storage-daily` for the new day, then `activity-daily`
  about the previous camera day. `cam_proxy.day` is the day the record was
  written for, `forDay` the day the activity covers.
- **Once per camera day.** A record for today's day already in the log means
  done, so a restart doesn't repeat them, and a start after downtime that
  lands after 00:05 writes the missing ones.
- **No back-fill:** days the proxy was down are not written afterwards.
  A start between 00:00 and 00:05 doesn't catch up yesterday's records;
  today's follow at 00:05.
- **Without the camera's time info:** the proxy waits up to 1 hour after
  its start for it. After that it writes the records for the UTC day, marked
  `cam_proxy.dayBasis: "utc"`. Once the time info is known, such records do
  not count as done, so a day may also get the normal camera-day pair. Readers
  can filter on `dayBasis` (records without it are camera-day records).

## Format

- Each record is one ECS 8.11 JSON object on one line, in a file of UTC
  days. `@timestamp` is UTC, ISO 8601 with milliseconds.
- Every record has: `@timestamp`, `ecs.version`, `event.kind` (`event`),
  `event.category[]`, `event.type[]`, `event.action`, `event.outcome`
  (`success`, `failure` or `unknown`), `event.dataset` (`cam-proxy.audit`),
  `service.name` and `service.version`, `host.name`, `labels.camera` and
  `message` (one readable sentence).
- Optional: `user.name` (`admin`, or `system` for the proxy's own records),
  `source.ip` (honours `server.trustProxy`, like the rate limits),
  `user_agent.original` (cut to 512 characters), `error.message`, and
  `cam_proxy.*` for the proxy's own details.
- Read through the API, each record also has `cam_proxy.cursor` (see below).
  It is added on reading and not in the file.
- **Never written:** tokens, link codes, cookies, passwords, the Vision key.
  Any value under a name containing `token`, `key`, `password` or `secret`
  is replaced with `"[redacted]"`, and a config change is redacted by the
  setting's name. (`key` and `tokenKind` themselves are kept: they describe;
  so is `secret` when its value is a known secret's name, `CAMPROXY_GOOGLE_VISION_KEY`.) A Vision
  key set on the Settings page appears as its first and last four characters
  only (Google keys start with `AIza`, so that shows four characters of the
  secret part).

## Files and retention

- `<dataDir>/audit/YYYY-MM-DD.jsonl`, one file per **UTC** day, append only
  with a single writer. A write that fails is logged at error level and the
  action it describes goes ahead.
- `retention.auditDays` (1 to 3650, default 90) is the age limit. The
  hourly retention run deletes whole files older than that; `POST
  /control/actions/retention-run` with `{"dryRun":true}` counts them.
- The folder counts in the storage budget and in `/control/stats` as
  `disk.audit` (and on the Status page), but it is **never dropped to make
  room**: only retention removes it.
- **50 MB guard:** when a day's file reaches 50 MB, further `auth-refused`
  records and failed `login` records for that day are dropped, and one
  `audit-throttled` record says so. Every other action is always written.
- **Token-like path segments are masked:** any path segment of 32 or
  more characters (by length, whatever the characters: dots, `+`, `=`, `%`, `~`
  and a file extension don't hide it) is written as `:token` in the path and
  message of an `auth-refused` record and in the `unauthorized` log line, in
  case a token was put in the URL.
- **A daily record that can't be written is retried with a backoff** (1, 2, 4
  ... up to 60 minutes), not every minute; so is a failure that throws.
- **Restart requests:** a second `restart-proxy` request before the stop
  writes no second `proxy-restart` record.

## API

`GET /control/audit` answers JSON lines (`application/x-ndjson`), one record
per line.

- **Access:** the admin token (bearer), an admin UI session, or
  `CAMPROXY_AUDIT_TOKEN`. The audit token reads this route only: on any
  other route it answers 403 `admin_only` (or 401 on the client API), so an
  answer never tells which kind of token matched. The client token gets 403 `admin_only`. HEAD answers like GET, without
  the body.
  A token in the URL is refused.
- **Parameters:**

| Query | Meaning |
|---|---|
| `limit` | 1 to 500, default 100 |
| `before=<cursor>` | records older than the cursor, newest first (the Audit page) |
| `after=<cursor>` | records newer than the cursor, oldest first (a poller) |
| `from`, `to` | unix ms bounds |
| `action` | one or more `event.action` values, comma-separated; each must be one of the actions in the table above (else 400 `unknown action: <name>`) |
| `outcome` | `success`, `failure` or `unknown` |

- With neither `before` nor `after`: the newest records, newest first.
  `before` and `after` together answer 400, as do a bad cursor, outcome,
  limit or a range with `to` before `from`.
- **Headers:** `X-Next-Cursor` (for the next page in the same direction;
  with `after` and no records it repeats your cursor), `X-Has-More`
  (`true` or `false`), `Cache-Control: no-store`.
- A cursor is `<day>:<line>` (the file's UTC day and the line number); treat
  it as opaque.

A poller keeps the cursor of its last read and asks for what is newer:

```sh
curl -si -H "Authorization: Bearer $CAMPROXY_AUDIT_TOKEN" \
  "http://<pi>:8480/control/audit?after=$CURSOR&limit=500"
```

`<pi>` is the Pi's LAN address (`docs/raspberry-pi.md`).

Take the records from the body and store the `X-Next-Cursor` header for the
next call; continue at once while `X-Has-More` is `true`. Start without a
cursor by asking `?limit=1` for the newest record and using its
`cam_proxy.cursor`, or read from the oldest with `after=1970-01-01:0`.

`CAMPROXY_AUDIT_TOKEN` is optional (32+ characters, different from the admin
and client tokens; `CAMPROXY_AUDIT_TOKEN_FILE` works too). It is never shown,
logged or returned. A refused use of it elsewhere is an `auth-refused` record
with `tokenKind: audit`.

## In Grafana today

Every record is also logged through the application logger at info level
with `audit: true` and the ECS object under the `ecs` field. The cluster's
pod logs reach Grafana Cloud Loki, so cam2's records are there:

```logql
{namespace="cam-proxy"} | json | audit="true"
```

The stdout copies need `server.logLevel` at `info` or lower; the audit
files are written regardless of it.

The record itself is the `ecs` field of the log line; `| json` flattens it
into labels such as `ecs_event_action`.

The Pi's records are not in Loki yet. The options are a poller in the
cluster that reads `GET /control/audit` with the audit token (it needs Klaus's
approval through kube-setup, as a cluster change), Grafana Alloy on the Pi, or
a push from the proxy. None is built; the optional `CAMPROXY_AUDIT_TOKEN`
is how a poller would get in.

## The Audit page

The admin UI's sidebar entry **Audit** sits between Clips and Settings
(admin sessions only).

- A table, newest first, **50 per page**: time (local), action, outcome
  (green, red or grey dot), who (`user.name` and `source.ip`), and the
  `message`.
- **Filters:** actions and an outcome. The action filter is a drop-down
  list of checkboxes, one per known action: all are selected at first (no
  filter, so a newer action this page doesn't list shows too); clicking an
  action selects or unselects it; **All actions** selects all, and when all
  are selected it selects none. None selected shows no records: "No actions
  selected". The button says "All actions", "No actions", the one action, or
  "N actions". Keyboard: Enter or Space opens it, Tab or the arrow keys move,
  Space toggles, Esc closes. Changing a filter starts again from the newest;
  the selection is not kept in the URL (the page has no URL state).
- **How many:** under the title, "Kept for 90 days (Settings) · 1,234
  events in that time.": `retention.auditDays` and the records kept now,
  all actions whatever the filter (`GET /control/audit/summary`, which the
  audit token reads too; the records in the day files from the retention's
  cutoff day on).
- **Paging:** Newer, Older, and Newest (back to the top). The top bar's
  Refresh reloads the page.
- Click (or press Enter on) a row to expand it to the full record as JSON.
- Empty: "No audit records yet."
