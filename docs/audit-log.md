# Audit log

Who did what on the proxy: starts and stops, restarts, camera reboots and power-cycles, changes of the camera's FTP upload, sign-ins (including
failures), refused tokens, control actions, settings changes, still checks, automatic Vision analyses, composed clips, and a daily
storage and activity snapshot. Design: [the spec](superpowers/specs/2026-10-01-audit-log-design.md).

## What it records

| `event.action` | category / type | When | `cam_proxy` details |
|---|---|---|---|
| `proxy-start` | process / start | every start, once it is listening | `config` (camera id: the first running camera, null when none runs, all moved away; stills, ftp, analytics on or off), `previousStop` (time of the newest record when it is a `proxy-stop`, else null), `uncleanStop` (`true` when the newest start or stop record is a start: the last run ended without a `proxy-stop`, as after a crash or power loss) |
| `proxy-stop` | process / end | a clean shutdown | `reason` (the signal, `restart-requested` after `restart-proxy`, or `stop`) |
| `proxy-restart` | process / change | `POST /control/actions/restart-proxy` (the process restart), before the `proxy-stop` | `requestedBy` (`session` or `token`); `allowedBy: ui.restart` when a cams-admin sign-in did it ([cams-admin.md](cams-admin.md#signing-in-from-cams-admin)) |
| `camera-reboot` | host / change, then host / end | `POST /control/actions/camera-reboot`; a second record when the camera answers again, or after 5 minutes without it | the request (user `admin`): `phase: requested`, `confirmed`, `requestedBy`; outcome `success` (confirmed), `unknown` (the camera dropped the connection after receiving it) or `failure` (it never reached the camera; `error.message` has the code). The end (user `system`): `phase: back` with `downSec` (request to the first answer), outcome `success`; or `phase: not-back` with `waitedSec`, outcome `failure`. A refused request (429, within 120 s of the last reboot or power-cycle) writes nothing |
| `camera-powercycle` | host / change, then host / end | `POST /control/actions/camera-powercycle` (the camera's PoE switch, [poe-switch.md](poe-switch.md)); a second record when the camera answers again, or after 5 minutes without it | the request (user `admin`): `switch` (`{model, host, port}`), `offSeconds`, `requestedBy`, `phase: requested`; on success `watts` (the draw before the cut), `offAt`, `onAt`, outcome `success`. A failure: `error.message` has the code (`switch_busy`, `no_power`, `switch_auth`, `switch_unreachable`, `switch_error`); `poeOff` says whether the PoE-off request was sent, and then `turnedOn` whether PoE is on again and `offAt` (ms) when the PoE was cut, or when the failure was seen if the cut was not; the message says "PoE may have been cut; turned back on: yes/no", and the end record follows. A proxy stop that may leave PoE off, or the switch session open (its logout unanswered), writes a failure with `phase: stop`, `poeLeftOff`, `sessionMaybeOpen`. The end (user `system`): `phase: back` with `downSec` (the cut to the first answer), or `phase: not-back` with `waitedSec`. Never the password. A request refused before reaching the switch (409 `not_configured`, 429) writes nothing |
| `camera-poe-on` | host / change | `POST /control/actions/camera-poe-on` ("Turn camera PoE on", recovery) | `switch` (`{model, host, port}`), `wasOn`, `requestedBy`; a failure has the code (and `poeStillOff`). 409 `not_configured` writes nothing |
| `camera-check` | host / change | the camera's FTP upload changed (#93): read every 5 minutes while `ftp.enabled` and the camera answers, and after `camera-ftp-setup` and `camera-ftp-off`. The baseline is the last `camera-check` record (a restart doesn't repeat it), else on | user `system`; `check: ftp`, `from` and `to` (each `{state, enable, server, port, user}`; `state` is `on`, `off`, `elsewhere`, `server_differs` (only the server name differs), or `unknown` for the first record), `mismatch` (`server`, `port`, `user`: what differs from this proxy); outcome `failure` for off and elsewhere, `success` for on and server_differs. A camera never set up (no server, no clip ever: `not_set_up`) writes nothing. Never the password |
| `login` | authentication / start | `POST /control/login` and `GET /control/login-link`, success or failure | `auth.method` (`token-form` or `login-link`); on failure `auth.reason` (`wrong-token`, `link-used-or-expired`, `rate-limited`); `auth.suppressed` |
| `logout` | authentication / end | `POST /control/logout` | with a session: `user.name` `admin`. Without one: `auth.reason: no-session`; `auth.suppressed` |
| `login-link-issued` | authentication / creation | `POST /control/login-links` (cams mints a link) | user `admin`, or `token:<label>` when a cams-admin-managed admin token minted it (its session is then a managed one, which can't widen the command policy) |
| `auth-refused` | authentication / denied | a request the auth layer answered with 401 or 403 | `auth.tokenKind` (`none`, `invalid`, `client`, `admin`, `audit`, `session`, `managed-client`, `managed-admin`), `auth.reason` (`no-token`, `wrong-token`, `admin-only`, `local-admin-only` (a cams-admin-managed admin token or its session on a route only local admin rights may change, and no `ui.*` entry allows it), `local-setting` (a cams-admin sign-in with `ui.config` setting or resetting a setting only the local admin changes, a storage limit or Google Vision on/off, shortening retention or raising a spending cap, or removing a camera; [cams-admin.md](cams-admin.md#signing-in-from-cams-admin)), `csrf`), `auth.suppressed`; user `token:<label>` for a cams-admin-managed token or its session; ECS `http.request.method` and `url.path` |
| `camera-name` | configuration / change | `PUT /control/camera/name` (the Settings page's "Camera name (stored on the camera)"), once the camera was asked | `from` (the name before), `to` (the name read back from the camera; `requested` too when it differs), `requestedBy` (`token` or `session`); user `admin`. A failure (the camera refused the name, is offline or failed) has the reason as `error` and `requested`. A name refused by the rules before the call (400) writes nothing. A rename made in the Reolink app is not audited (it reaches clients as a `camera` stream message) |
| `camera-address` | configuration / change | `POST /control/actions/camera-address` (Settings → Find camera → "Use this camera"), written or refused by the `.env` guard | user `admin`; `from`, `to` (the address), `key` (`CAMERA_HOST` or `CAMPROXY_CAMERA_HOST`), `backup` (the backup file), `requestedBy`; a failure has the code as `error.message`. Never another line of the file |
| `camera-password` | configuration / change | `PUT /control/cameras/:cam/password` (spec 2026-10-30-camera-onboarding-design §4.1): every attempt after the shape check; a rate-limited one (`too_many_attempts`) at most once per camera address in 10 minutes | user `admin`, `token:<label>` (a managed admin token) or `managed-admin`; `requestedBy`; `envLine: removed` when the camera's own line left the env file; a failure has the code as `error.message` (`camera_refused`, `camera_offline`, `env_password`, `not_trusted`, `too_many_attempts`; `suppressed` for rate-limited ones in between). Never the password |
| `camera-probe` | configuration / access | `POST /control/actions/camera-probe` (spec 2026-10-30-camera-onboarding-design §4.2), after the shape check; a rate-limited one at most once per camera address in 10 minutes | user `admin`; `host`, `login` (`ok`, `refused`, `offline`, `not_tried`), `model` (or null), `ports` (which answered), `fingerprint` (the served certificate's), `requestedBy`; a failure has the code as `error.message` (`camera_refused`, `camera_offline`, `fingerprint_mismatch` with `served`, `too_many_attempts`). No control-action record. Never the password |
| `camera-add` | configuration / creation | `POST /control/cameras` (spec 2026-10-30-camera-onboarding-design §4.3), after the shape check | user `admin`; `host`, `model`, `pinned` (the pinned fingerprint, or null for http), `requestedBy`; with it the `config-change` record of the overrides and the `camera-trust` record of the pin. A failure has the code as `error.message` (`camera_exists`, `camera_limit`, `fingerprint_mismatch` with `served`, `camera_refused`, `camera_offline`, `too_many_attempts`, `invalid`); nothing is stored then. Never the password |
| `camera-remove` | configuration / deletion | `DELETE /control/cameras/:id` (spec 2026-10-30-camera-onboarding-design §4.3) once the id is known here | user `admin`; `removed` (what went: `camera FTP upload off`, `configuration`, `CAMERA_HOST`, `stored password`, `env <NAME> line`, `certificate pin` or `certificate trust`, `PTZ positions (n)`), `leftovers` (what a person has to remove: `env <NAME>`, `env <NAME>_FILE`, `config.json camera.host`, or a step that failed), `requestedBy`; with it a `config-change` record and the `camera-trust` record ("the camera was removed"). A refusal (400, 404, 409 `config_json`) writes nothing. Never a password |
| `camera-time` | configuration / change | `POST /control/cameras/:cam/actions/camera-time-set` (spec 2026-10-30-camera-onboarding-design §4.7), or cams-admin's `camera.action:camera-time-set`, once a zone is known | user `admin` or `cams-admin`; `zone`, `outcome` (`set`, `already`, `unsupported`, `failed`), `before` and `after` (`stdOffsetMinutes`, `dst`: the camera's rule fields), `ntp` (the NTP sync's outcome, or null without `ntp.server`), `requestedBy`; a camera that did not answer has the code as `error.message`. 409 `zone_unknown` and `zone_unsupported` write nothing |
| `camera-trust` | configuration / change | a camera's certificate trust changed: the site CA's pushes and checks (user `system`), `camera-trust-clear`, a camera move's expected leaf, a camera forgotten after a move or a removal, and the admin's pin (`POST /control/cameras/:cam/actions/camera-trust-pin`, spec 2026-10-30-camera-onboarding-design §4.4) | `from`, `to` or `fingerprint`; a pin: `op: pin`, `from` (the mode before), `fingerprint`, `requestedBy`; a refused pin: outcome `failure`, `error.message` `fingerprint_mismatch`, `fingerprint` (the one given) and `served`. Never a key |
| `control-action` | configuration / change | `POST /control/actions/:name` except `camera-reboot`, `camera-powercycle`, `camera-poe-on`, `restart-proxy`, `camera-address`, `archive-clear`, `inventory` and `inventory-repair` (their own records; an inventory's when the run ends) and a retention dry run (`poe-switch-read` and `inventory-cancel` are ones); the camera-side `restart` is one (`action: restart`) | `action`, `result` (`ok`, the error code or status, or `aborted`), `requestedBy`; `allowedBy: ui.restart` for a camera-side restart by a cams-admin sign-in |
| `config-change` | configuration / change | `PUT /control/config`, reset of an override (`DELETE /control/config/{path}`), and Reset to defaults (`DELETE /control/config`: one record for all, message "Settings reset to defaults: …", `reset: "all"`) | `changes`: `[{key, from, to, restart?}]`, secrets redacted; `restart` is `restart` for a setting that waits for a restart, `process` for one that waits for a new process, and missing for a live one. A refused change (400) writes nothing, nor does a reset with nothing to reset. From cams-admin (migration P3): user `cams-admin`, `cmdId`, `actor`, and `rollbackOf` for a `config.rollback`; the card's Undo: the local user and `undoOf`. By a cams-admin sign-in (issue #227): user `token:<label>`, `allowedBy: ui.config` |
| `secret-override` | configuration / change | `PUT /control/secrets/google-vision-key` (the Settings page's key field) | `secret` (`CAMPROXY_GOOGLE_VISION_KEY`), `masked` (first and last four characters, `AIza…wXyZ`), `replaced` (`env`, `manual` or `none`). Never the key. A refused key (400) writes nothing |
| `still-check` | host / access | `POST /api/cameras/{cam}/still-checks` (a second checked with Vision by hand, cams #179), each request past the input check | user `client` (the client token) or `admin`; `stillTs`, `outcome` (`ok`, `reused`, `refused`, `failed`), `source` (a reused one: `check` or `event`), `reason` (refused: `off`, `no_key`, `checks_off`, `busy`, `bad_key`, `quota`, `month`, `day`, `checks`; failed: the provider's, as in the 502), `cost` (1 when this request made a Vision call, else 0), `tookMs`, `found` (the categories found, e.g. `["person"]`), `requestedBy` (`token` or `session`). Outcome `success` for ok and reused, else `failure` (`error.message` the reason). Never the image or the key. A 400 or 404 (`no_still`) and a rate-limited request write nothing |
| `event-analysis` | host / access | an automatic Vision analysis of an event (the analytics service's call for a person, vehicle or pet event) that made a call: once per event, when it ends, ok or failed (after its one retry) | user `system`; `cam`, `eventId`, `kind`, `stillTs` (the still sent), `outcome` (`ok` or `failed`), `reason` (failed: the provider's, e.g. `timeout`, `quota`, `bad_key`), `calls` (the Vision calls made for it, 1 or 2 with the retry), `tookMs` (the last call), `found` (the categories found, e.g. `["person"]`). The message lists them with their scores ("Vision on event 812 (person): person 90%"). Outcome `success` for ok, else `failure` (`error.message` the reason). A skip (no still, the monthly limit or daily cap, a pause, analytics off) made no call and writes nothing; the analysis row and the daily `activity-daily` still count it. Never the image or the key. A result whose event was deleted meanwhile is still recorded (the call was paid) |
| `composition` | host / access | `POST /api/cameras/{cam}/compositions` (a composed clip, cams's Save dialog), each request past the input check that is not a dry run | user `client` or `admin`; `anchor` (`clip` with `clipId`, or `at` with `at`, a second: cams #179), `from`, `to` (the window, unix ms), `durationS`, `size`, `seconds` (`{clip, still, card}`: what the clip is made of), `outcome` (`started`, `busy`, `nothing_to_compose`, `storage_paused`, `no_font`), `jobId` (when started), `requestedBy` (`token` or `session`). Outcome `success` for started, else `failure` (`error.message` the outcome). A 400 or 404, a dry run and a rate-limited request write nothing |
| `camera-settings` | configuration / change | `PUT /api/cameras/{cam}/settings/{section}` (cams's Settings page through the proxy, spec 2026-10-30-camera-onboarding-design §4.8): a write of the `detection` or `image` section | user `admin` or `token:<label>` (a managed admin token); `section`, `patch` (what was asked), `fields` (`{<field>: ok \| not_applied \| camera_rejected}`), `unexpected` (at most 20 key names the camera changed that no write asked for), `requestedBy` (`token` or `session`). Outcome `success` when every field was saved, else `failure` with `error.message` `not_applied` or `camera_rejected` (the first); a camera that went offline or refused the session after a write was sent is a `failure` with that code. A 400, 403, 404 or a camera offline before any write writes nothing. Never a password |
| `ptz-position` | configuration / creation (save), deletion (delete), change (the rest) | a change to a camera's saved PTZ positions (`/api/cameras/{cam}/ptz/positions…`, spec 2026-10-30-ptz-capabilities-design §5.2): save, save again, rename, make Home, reorder, delete | user `client` or `admin`; `op` (`save`, `resave`, `rename`, `home`, `order`, `delete`), `id`, `name`, `from` (rename: the old name), `ids` (order: the new order), `requestedBy` (`token` or `session`). A camera that refused or did not keep the change is a `failure` with `error.message` `camera_error`. A 400, 404, 409 or 503 writes nothing; moves and going to a position are not audited |
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
| `admin-policy` | configuration / change | the allowed commands or the pause changed on the cams-admin page or with `admin-commands` | user `admin` (or `token:<label>` for a cams-admin-managed admin token, which can only narrow), `from`, `to` (`{allow, paused, pauseReason}`), `requestedBy`. A refused widening (403 `local_admin_only`) writes nothing |
| `admin-token` | configuration / change | a managed token blocked or unblocked on the cams-admin page or with `admin-tokens` | user as for `admin-policy`; `op` (`block`, `unblock`), `id`, `label`, `kind`. Never the hash |
| `audit-throttled` | host / info | a day's file reached 50 MB | none |
| `move-token-refused` | authentication / denied | a request to the source's move endpoints (`/api/moves/{id}/...`, camera moves) refused with 403 `move_token` | `moveId` (null when not a move id), `reason` (`unknown-move`: no source move with that id here, `ended`: finished, cancelled or failed, `no-token`, `wrong-token`, `wrong-address`: not from the target's address), `path`, `suppressed` (refusals not recorded since the last record); the camera; ECS `source.ip`. A `wrong-address` refusal before the switch-over is only recorded; from it on the move fails (`token_address`). Refused requests count toward a per-address limit (429 beyond it). At most one record per move and reason per 10 minutes (junk requests can't use up the record of a wrong-address attempt); refusals for move ids this proxy doesn't have share one such limit. Never the token |
| `move-request` | configuration / creation | a camera move started on this proxy's page (`POST /control/moves`, the source side; [camera moves](superpowers/specs/2026-10-21-camera-move-design.md)) | user `admin`, or `token:<label>` for a cams-admin sign-in (the `move.send` entry); `requestId`, `camera`, `source` (this proxy's id at cams-admin), `target` (the target proxy's id), `targetName`, `origin` (`local` or `managed`), `label` (who, as cams-admin is told), `bytes` (all content of the camera), `summary` (per kind: `files`, `bytes`, `rows`, `oldest`, `newest`); ECS `source.ip`. A refused start (409 `move_refused`: `moves_not_allowed`, `busy`; 400, 404) writes nothing. Never a password |
| `move-offer` | configuration / change | the target's answer to a camera move offered to it (`move.offer` from cams-admin) | user `cams-admin`; `moveId`, `camera`, `source` (the source proxy's id), `sourceName`, `target` (this proxy's id), `role` (`target`), `accept`; accepted (outcome `success`): `space` (`needed`, `available`, `fits`, `perKind`, `retentionProposal`) and `probeBps` (the measured rate from the source); refused (outcome `failure`): `reason` (`moves_not_allowed`, `busy`, `no_site_ca`, `id_taken`, `camera_limit`, `incompatible`, `ca_does_not_cover_camera`, `camera_unreachable`); `bytes` (all content offered). Never the move token |
| `move-approve` | configuration / change | the move's plan approved on the source's page (`POST /control/moves/{id}/approve`) | user as for `move-request`; `moveId`, `camera`, `source`, `target`, `origin`, `label`, `plan` (`transfer`, `kinds`, `space`, `targetSettings`, `budgetS`, `estimateS`), `kinds`, `space`, `settings` (the camera's settings as they move), `budgetS`, `estimateS`, `positions` (the camera's PTZ positions: `carried` when the target takes them, `ptz` then in the plan; `not_taken` when it doesn't, an older cam-proxy; `none` without positions; the message says so). A refused plan (400) writes nothing |
| `move-auto-approve` | configuration / info | a camera move cams-admin started with bounds (`move.begin`) that this proxy did not approve by itself when the target accepted; the offer waits on the move panel for a person, as one started here. Within the bounds the approval is a `move-approve` record instead (user `cams-admin`, `origin` `managed`, `label` `cams-admin auto-approval`), and a rejected answer writes no record | user `cams-admin`; outcome `failure`; `moveId`, `camera`, `source`, `target`, `role` (`source`), `reason` (`over_budget`: the estimate is over `maxBudgetS`; `space`: the content doesn't fit and the bounds' space choice isn't possible; `no_estimate`: the target gave none; `not_allowed`: `move.send` is off at answer time, `detail` `moves_not_allowed`; `plan`: the plan was refused, `detail` the approval's error), `bounds` (`transfer`, `kinds`, `space`, `maxBudgetS`), `estimateS` (null without one) |
| `move-switch` | configuration / change | a switch-over step of a camera move. Source: entering the switch-over (`move.go` from cams-admin). Target: each step it runs (`start`: `move.start`; then `secrets`, `camera`, `cert`, `ftp`), once with its outcome | user `cams-admin`; `moveId`, `camera`, `source`, `target`, `step`, `outcome` (`ok`, `skipped`: FTP is off for the camera on the target, `failed`: given up after its retries, outcome `failure`, with `attempts` and `detail`). Source `go`: `leafFingerprint` (the target's leaf the camera may now serve: the certificate guard accepts exactly it), `publicKeyFingerprint` (SHA-256 of the target's X25519 key the password is sealed to), `chunks` (the frozen manifest's chunk count). Target (`role` `target`): `start` has `leafFingerprint` (the leaf issued for `<camera>.<site>.internal`), `publicKeyFingerprint`, `plan`, `done` (the chunks cams-admin reported done); `camera` has `leftover` (a hidden `moved` entry of this camera shown again in the same write) and `targetSettings` (the approved limits applied with plan space `retention`, else null); `cert` has `leafFingerprint` and `push` (`pushed` or `current`). Never the key, the password or the token |
| `move-phase` | configuration / change | each phase change of a move on this proxy. Source: `opened` (`move.open`), `switching` (`move.go`), `released` (`move.release`: the camera hidden), `rejected` (the target's answer was no; outcome `failure`, `reason`), `finished` (`move.finish`), `cancelled` (`move.cancel`), and `failed` with `code` `token_address` (user `system`, outcome `failure`: the move token was used from another address; the move ends). Target: `switching` (the runner started), `switched` (the camera runs here with its password, leaf and FTP), `copying` (right after), `copied` (the copier ended: `counts` with `verified`, `skipped` and `failed` files and the `bytes` verified; the same as text in `detail`), `failed` (a step gave up, outcome `failure`, `code`: `secrets_failed`, `camera_failed`, `cert_failed`, `ftp_failed`, `copy_failed` when the copier hit an unexpected error (a journal or catalog write), or `internal` for an unexpected error; `finished` and `cancelled` at the end of the move; `detail` `id_taken` when a camera of that id was added here after the offer; the cert step waits up to 10 minutes for an open camera event without counting it as a failure) | user `cams-admin`; `moveId`, `camera`, `source`, `target`, `role` (`source` or `target`), `phase` |
| `move-progress` | configuration / info | the target's copy of a moved camera's content: at every 10 % of the bytes, and at least hourly | user `cams-admin`; `moveId`, `camera`, `source`, `target`, `role` (`target`), `percent`, `bytesDone`, `bytesTotal`, `rateBps` (the rate the copy is held to now), `etaS`, `chunks` (`total`, `verified`, `skipped`, `failed`) |
| `move-budget-exceeded` | configuration / change | once per move on the target, when the approved time budget is over with content left; the copy goes on at the same rate or lower, never faster (not for a copy back: it has no approved budget, only the pace) | user `cams-admin`; outcome `failure`; `moveId`, `camera`, `source`, `target`, `role`, `budgetS`, `elapsedS`, `bytesDone`, `bytesTotal` |
| `move-paused` | configuration / change | a copy back (a return, step 4) on the original proxy: the next chunk has no room here (outcome `failure`, `code` `no_space`): it does not fit without deleting anything, or the storage budget would keep less than 5 % free after it, or storage deleted content for a size cap or the budget within the last hour; the copy waits, it never skips the chunk and never lets storage pressure delete this proxy's own older content for it. A copy back is not paced (no time budget), only halved under load, and again when there is room (outcome `success`); cams-admin sees `move.phase` `copying` with code `no_space`, then without | user `cams-admin`; `moveId`, `camera`, `source`, `target`, `role` (`target`), `paused`, `code` |
| `move-return` | configuration / change | a copy back after a cancel past the switch-over (step 4), one record per step. The copy back runs in the opposite direction: its source is the proxy that took the camera (it holds the content), its target the original proxy. Source (`role` `source`): `open` (`move.return.open`; `chunks`, `bytes`, `rekeyed` when a new move token was made) and `finish` (`deleted`, `kept`: what the original reported verified and what the cancelled move imported are removed here; nothing with `abandoned`). Target (`role` `target`): `start` (`move.return.start`; `done`: chunks already reported, ignored by a return: every chunk is copied and checked again) and `finish` (copied back; with `abandoned` what was copied back stays). Give up in cams-admin deletes nothing | user `cams-admin`; `moveId` (the copy back's own id), `returnOf` (the cancelled move), `camera`, `source`, `target`, `role`, `step` (`open`, `start`, `finish`), `abandoned` (finish) |
| `move-file-failed` | configuration / change | a chunk of the copy ended with files that failed their size and SHA-256 check 3 times (or that the source listed outside the camera's folders, or that stayed `not_listed` after 3 new listings), or whose rows could not be imported after 3 tries (`import: failed`; counted as one failure, its staged files removed); one record per chunk | user `cams-admin`; outcome `failure`; `moveId`, `camera`, `source`, `target`, `role`, `chunk` (`<kind>:<YYYY-MM-DD>`), `failed` (how many), `paths` (up to 50, relative to the data folder). The chunk shows as `failed` (copied with failures); a file the source's retention removed before it was copied is skipped, not failed, and writes nothing. Never the move token |
| `move-source-unreachable` | configuration / change | the target's copy: the source gives no answer or keeps refusing (any answer but 200 and 404; 503 and 429 are load, not refusal: they only halve the rate for a minute), or its chunk rows stay `unknown_chunk` after 3 new listings of the chunk or keep not being a list — at the first failure and every 6 hours while it lasts; the copy keeps trying with a backoff (up to 5 minutes), and a cut or stalled file is fetched again without counting as a failure | user `cams-admin`; outcome `failure`; `moveId`, `camera`, `source`, `target`, `role`, `since` (unix ms of the first failure), `failures` (tries so far), `answer` (the last HTTP status, or `no answer`). Never the move token |
| `move-cancel` | configuration / change | a camera move cancelled on this proxy (`move.cancel` from cams-admin; [camera moves](superpowers/specs/2026-10-21-camera-move-design.md) §10.3). Source, before the switch-over: the move closes and the camera stays as it was (only the target's expected leaf is cleared, if set). Source, after it: the camera comes back: it runs here again at once, the proxy pushes its own leaf (the target's leaf it served was accepted until then), points the camera's FTP upload here again and reads it back, then no other leaf is accepted. A step of that which fails writes a record with outcome `failure` (at most one an hour per move) and the proxy tries again by itself, with a backoff, also after a restart; meanwhile it counts as busy (no other move starts) and the move's end (`cancelled`) is reported only once all steps are done. Target: the copy stops and its temporary files go; the camera node the move wrote leaves the configuration (live; a config.json entry is hidden again) with its stored password and its leaf; before the switch-over, with `copied` `delete` what the move copied here is deleted (the catalog entries it imported and their files, and the files it placed) and with `age-out` the retention removes it in time; after the switch-over nothing is deleted: the record is kept (`returnPending`) and its content is copied back to the original next (`move-return`). A camera of that id this proxy had itself is never touched, nor its stored password (only one the move stored is deleted). An offer never approved (no plan 35 minutes after it opened) closes on either side on its own: user `system`, `reason` `offer_expired` | user `cams-admin` (`system` for an expired offer); `moveId`, `camera`, `source`, `target`, `role`, `phase` (the phase the move was cancelled in). Source: `switchedBack` (whether the camera had been switched over), and then `push` (`pushed` or `current`), `leafFingerprint` (the leaf it serves now), or `cert` `not_managed` instead of both (this proxy doesn't manage the camera's certificate: no site CA, `tlsName`, an http camera or `tls.cameraCerts` off; the camera keeps the target's certificate, and the message says to restore its own where it is managed), `ftp` (`ok`, or `skipped`: FTP is off for the camera here); a failed step: `step` (`camera`, `cert`, `ftp`), `code` (`camera_failed`, `cert_failed`, `ftp_failed`, `no_site_ca`), `detail`, `attempts`. Target: `copied` (`delete` or `age-out`; `returnPending: true` instead after the switch-over), `cameraEntry` (`removed`, `hidden`, or `untouched`: the camera never came here), `deleted` (what the move had copied and was deleted, per kind `files` and `bytes`; null with `age-out`). Never the token or a key |
| `move-check` | configuration / info | the target's completeness check before a move concludes (step 4): per kind the files missing, recovered, failed and expired at the source | user `cams-admin`; `moveId`, `camera`, `source`, `target`, `role` (`target`), `check` (`complete`, `missing`, `recovered`, `failed`, `expired`) |
| `move-outcome-refused` | configuration / change | the source did not take the target's report of what to keep (`PUT /api/moves/:id/outcome` refused, or not reachable at an ended-early finish): a report that reached it earlier still applies; without one the source keeps every Archive item of the camera and deletes the rest | user `cams-admin`; `moveId`, `camera`, `source`, `target`, `role` (`target`), `status` (HTTP status, or null) |
| `move-cleanup` | configuration / deletion | the source after the move finished (`move.finish`, S §11): every file and catalog entry of the camera deleted except what the target reported to keep and every Archive item not reported copied (kept Archive items get a "Kept here" note saying why). Only what the receiver reported verified is deleted; failed and missing items, the overlap minute's still and un-copied Archive items stay and age out with retention, except Archive items with no expiry, which stay until deleted by hand (stills and previews, clips and snapshots, events with their Vision results and images, still checks, Archive items; also its recordings cache, not counted); an overrides-added camera removed, a config.json camera left hidden (delete it there); its stored password, leaf files and trust state deleted. Audit records stay | user `cams-admin`; `moveId`, `camera`, `source`, `target`, `role` (`source`), `deleted` (per kind `stills`, `clips`, `events`, `checks`, `archive`: `files`, `bytes`), `kept` (the same shape: what stayed on this proxy), `files`, `bytes` (the totals), `cameraEntry` (`removed` or `hidden`), `ptzPositions` (PTZ positions deleted), `env` (the camera's password line in the managed `.env`: `outcome` `removed` with `key` (no backup is kept, and the line is removed from the older `.env.bak-…` backups too), `not_in_file`, `not_managed` without `CAMPROXY_ENV_FILE`, or `failed` with its `code`; never the value), `leftovers` (what is left to remove by hand, as in `moveLeftovers`) |
| `move-done` | configuration / change | a camera move's end on this proxy (`move.finish`): on the target the copy is over (its temporary files and the move's keys deleted, the camera stays), on the source after `move-cleanup`; `abandoned` when cams-admin ended the transfer early | user `cams-admin`; `moveId`, `camera`, `source`, `target`, `role`, `abandoned`, `durationS` (since the move was opened here). Target: `chunks` (`total`, `verified`, `skipped`, `failed`, `abandoned`: not copied when the transfer ended), `files` (`verified`, `skipped`, `failed`), `bytes` (verified). Source: `files`, `bytes` (deleted) |

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
