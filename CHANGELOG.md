# Changelog

## Unreleased

- New: cams can reach a camera only through its proxy: camera status, snapshot, live video (WebSocket), settings, light and reboot for cams (`camera-calls`). Reads take a client token; settings, light and reboot need an admin token, and cams's cams-admin admin token may make exactly these. Live video runs on the proxy's own address (no new port), sub stream by default. Settings and light changes are audited (`camera-settings`, `camera-light`). The camera list's `tls` gains `served` and `problem` (a pinned camera now serving another certificate shows as `changed`).
- Proxy profile: the firewall lines are now one per camera with FTP (the FTP port and the passive range in one rule: a ufw port list, an nft set), so all 64 cameras fit; before, cameras beyond the first 32 had none.
- Live video works for a camera with stills off: its go2rtc stream starts with the first live viewer and stops after the last (go2rtc itself too while no camera has stills). Before, such a camera answered `stream_unavailable`. Stills stay as configured.
- An https camera whose certificate nothing verifies (no site CA, no pin, no public name) keeps working, but the health now shows it as a problem ("Certificates: cam1: certificate not trusted", also on the Pi and its display), and its onboarding step says to use "Trust this camera's certificate".
- Camera time: "Set camera time" runs on a camera session of its own; it logged out the session the proxy shares for everything else with that camera.

## v2026.10.30.3

- New: camera onboarding from the admin page or the API, no file edits and no restart:
  - `POST /control/actions/camera-probe` shows which of a camera's ports answer and the certificate it serves; with the camera's password, its model and what it can do. It only reads from the camera.
  - `POST /control/cameras` adds a camera with its password and certificate in one call, also on the Pi (it writes `CAMERA_HOST` into `.env` as "Use this address" does). The proxy logs in first, over exactly the certificate you confirmed; nothing is stored when the camera refuses. A proxy at its `profile.cameras` count refuses the addition (a proxy already over it keeps running). Only the proxy's own admin token or sign-in may add a camera.
  - `DELETE /control/cameras/{id}` removes a camera with its password, certificate trust, PTZ positions and (when it points here) the camera's FTP upload. What only a person can remove is listed under "Left over from removed cameras" on the Status page.
  - `PUT /control/cameras/{cam}/password` saves a camera's password after the camera accepted it, and applies it at once. It is never shown again, logged or audited; the camera's own line in `.env` is removed. A cams-admin admin token may use it too. At most 5 password tries per camera in 10 minutes, so a wrong password can't lock the camera's account.
  - `POST /control/cameras/{cam}/actions/camera-trust-pin` trusts a camera's certificate without a site CA, after you compared its fingerprint (also with a cams-admin admin token; never a cams-admin command). A camera that later serves another certificate is refused until pinned again.
  - `GET /control/onboarding` and `GET /control/cameras/{cam}/onboarding`: one status per camera with each step (reachable, login, trust, capabilities, stream, events, FTP, time, name, PoE, profile), why it isn't done and what fixes it. A camera over plain http is never "ready".
  - The camera views (`GET /control/cameras`, `GET /api/cameras`) say where a camera's password comes from and whether it works (`credentials`), never the password.
  - New setting `time.zone` (local only): the cameras' time zone, compared in the onboarding status; without it the host's zone when known.
  - `POST /control/cameras/{cam}/actions/camera-time-set` and the Settings page's "Set camera time" set a camera's time zone and DST rule from `time.zone` (else the host's zone), its clock, and its NTP server when `ntp.server` is set.
  - Admin page: "Add a camera" checks the camera, shows its certificate to confirm, and adds it with its password (Find camera's "Add this camera" fills in the address); the Status page has an Onboarding card per camera with "Camera password" and "Trust this camera's certificate" (both also open to a cams-admin sign-in).
  - cams-admin can read each camera's onboarding status (`camera.onboarding.get`, on by default; switch it off on the cams-admin page) and the heartbeat carries each camera's ready flag and missing steps. cams-admin can also set a camera's time zone (`camera.action:camera-time-set`, off by default). Needs cams-admin 2026.10.30.3 or later.

## v2026.10.30.2

## v2026.10.30.1

- New: pan, tilt and zoom. Each camera in the camera list now says what it can do (`capabilities`; for now whether and how it can move), and the proxy offers a PTZ API under `/api/cameras/{cam}/ptz`: moves that stop by themselves (a closed browser tab leaves the camera stopped within 2 s), zoom, focus, and up to 20 saved positions per camera with a Home position, kept on the proxy and on the camera. Works with the Reolink E1 Outdoor Pro; presets saved with the camera's own app are left alone, and a position the camera lost shows as missing until saved again. Position changes are audited (`ptz-position`) and sent to stream clients (`ptz-positions`). `scripts/ptz-real-check.sh` checks a real PTZ camera through a proxy (the camera moves while it runs).
- Camera moves: a camera's saved PTZ positions now move with it, when the other proxy runs this version too (needs the cams-admin release that knows them); otherwise the move says they stay behind, and they stay saved on the camera. At the end the proxy the camera left also deletes its positions and removes the camera's password line from its `.env` and that file's backups (on the Pi). What it can't remove itself (a `config.json` entry, a password in compose's environment) is listed under "Left over from camera moves" on the Status page, with what to do, and shown in cams-admin.

- PTZ: holding zoom works on the E1. The camera refuses a zoom while one is running, so a held zoom failed after its first step (502 `camera_error`). Now a zoom call in the running zoom's direction only extends it, and one in the other direction stops the first zoom before starting.

## v2026.10.27.1

- Proxy profile: with FTP on, `profile.cameras` now goes up to 64, as it already did with FTP off. It was capped at 10 because `ftp.passive` could span at most 100 ports; it now spans up to 640 (10 per camera). The derived range grows with it (for 20 cameras `30000-30199`); open those ports on the host's firewall when you raise the count. The firewall lines in the profile report stay at most 64, so they cover the first 32 cameras with FTP.
- Cluster proxy (`deploy/cluster/config.json`): HTTPS on 8443 with the site CA's proxy certificate (`proxy.cluster.internal`). The cluster cams reached it over plain http, and cams refuses a CA pin over http, so after the pin was set cams refused the proxy entry and cam2 showed a certificate error.

## v2026.10.26.2

- FTP: `ftp.sourceSubnet` (config.json only) lets camera FTP logins come from a network instead of each camera's own address. The cluster sets `10.42.0.0/16`: since its camera host became cam2's Service address (site CA, below), cam2's uploads from its pod address were refused (`ftp_login_refused`).
- Cluster proxy (`deploy/cluster/config.json`): its own site CA (`tls.site` `cluster`) issues cam2's certificate (`cam2.cluster.internal`), replacing the Let's Encrypt one for the public name `cam2.skylar.technology`, which is retired like cam1's. The proxy reaches cam2 by its pinned ClusterIP `10.43.61.52` (the CA vouches for that one address and the proxy's ClusterIP); cam2's web UI link is gone with the public name.

## v2026.10.26.1

- Camera moves: the Raspberry Pi (no site CA) and a camera whose certificate is managed elsewhere (`tlsName`, such as cam1's Let's Encrypt certificate) can now be moved away. They were refused before (`no_site_ca`, `external_cert`). The target still needs a site CA that covers the camera, and gives the camera its own certificate. Such a source never touches the camera's certificate, so cancelling after the switch-over leaves the target's certificate on the camera: restore its own where it is managed (for cam1, the `cam1-cert-push` job). The `move-cancel` record says so (`cert`: `not_managed`).

## v2026.10.25.4

## v2026.10.25.3

- Camera moves: cams-admin can ask what a move of a camera would carry before it starts one (new read-only command `move.summary`, under `move.send`): files, bytes and the time span per kind, the same numbers the move request shows. The answer is kept for 30 seconds, so asking often doesn't count the camera's stills each time.
- cams-admin's heartbeat profile now also says whether this proxy has a site CA and which camera network it covers (`tls.site`, `tls.cameraSubnet`; empty on the Pi).

## v2026.10.25.2

- New: the proxy **profile**, what this proxy can hold: `profile.cameras` (how many cameras), `profile.name` (the hardware as you call it), `profile.storageGB` (how much storage it may use, in place of `storage.maxBytes`) and `profile.firewall` (`ufw` or `nft`). Until it is set, the Status page shows a "Set this proxy's profile" card; the Settings page edits it later. Only the local admin token sets it (`GET`/`PUT /control/profile`, recorded as a settings change); cams-admin only reads it. The values are not checked against the hardware: getting them right is yours. `profile.storageGB` counts GB as 10^9 bytes (the `*.maxGB` caps count 1024³), and the budget it sets is still capped by `storage.maxPercent` of the disk. Set on the Settings page over a `storage.maxBytes` in config.json, it wins and `storage.maxBytes` shows as ignored; both in the same file does not load. A camera move that needs more room on such a proxy proposes a higher `profile.storageGB`.
- Going back to v2026.10.25.1 or older: first, in the data folder's `overrides.json`, rename `profile.cameras` to `moves.maxCameras` (`"moves": { "maxCameras": 3 }`) and remove every other `profile.*` setting (`name`, `storageGB`, `firewall`), and the same in config.json if you put the profile there; the older version does not load a file with `profile`.
- `moves.maxCameras` is now `profile.cameras`. The old name is still read (een's 3 stays 3); both set to different values does not load.
- Camera moves: the target refuses a move beyond its profile's cameras (`camera_limit`). **A proxy without a profile takes no more cameras than it holds** (one, if it holds none): set the profile on a proxy that should receive cameras. A move that would need FTP passive ports the target doesn't have is refused too (`incompatible`, with the ports in the detail).
- FTP passive ports follow the profile while FTP is on and `ftp.passive` is unset: 10 ports per camera from 30000, for the profile's cameras or the cameras held, whichever is more (a lower profile never takes ports from a camera it holds). A range set by hand that is smaller than the profile needs now loads, with the warning `profile_ftp_ports`, instead of failing; at least 10 ports per camera with FTP is still required. Proxies with `ftp.passive` set (een, the mini PC, the Pi, the cluster) keep their ranges.
- The profile shows, for each camera with FTP, the firewall lines its host needs (FTP port and passive range, for ufw or nft), with a copy button. Nothing runs them.
- cams-admin's heartbeat now carries the profile: capacity and cameras held, storage budget against the disk, hardware as cam-proxy sees it (CPU cores and model, memory, 5-minute load; temperature on a Pi or with `host.stats: on`), the warnings and the firewall lines.

## v2026.10.25.1

- Camera moves: a proxy without a shared camera password (`CAMPROXY_CAMERA_PASSWORD`) now takes a new camera. Before, every first move of a camera onto such a proxy was refused as `incompatible`, although the camera's password comes with the move.
- Camera moves: a refused offer now says what failed, next to the reason (for example `3 of 3 cameras (moves.maxCameras)`, `ftp.passive: 10 ports for 2 cameras with FTP; at least 10 per camera`, `192.0.2.10:443 not reachable within 3 s`). The move dialog shows it, and the `move-offer` and `move-phase` `rejected` audit records carry it. The detail names settings, ids and addresses, never a password or token. `move.offer` results and `move.answer` take an optional `detail` (up to 300 characters).
- FTP passive ports follow `moves.maxCameras` while FTP is on: with it set and `ftp.passive` unset, the default range is 30000 up, 10 ports per camera the proxy may hold (`maxCameras` 4: `30000-30039`; at most 10). A range set by hand that is smaller than 10 ports per camera it may hold no longer loads (`ftp.passive: N ports for moves.maxCameras M; at least 10 per camera`); with FTP on, `maxCameras` above 10 does not load. With FTP off or without `moves.maxCameras` nothing changes.

## v2026.10.23.2

- Camera moves check that the copy is complete before they end: files still missing get one more try; failed files and files the source's retention removed are counted and shown (audit record `move-check`).
- The old proxy now deletes only what the new one verified. Files that failed or went missing, Archive items that were not copied (marked "Kept here" with the reason) and the overlap minute's still stay and age out with retention; Archive items without an expiry stay until you delete them. If the report doesn't arrive, it keeps every Archive item and deletes the rest (`move-outcome-refused`).
- Cancelling a move after the switch-over now brings the camera back at once and then copies what the new proxy recorded back to the original (`move-return`). The copy back is not cancellable, waits when the original is nearly full or just deleted content for space (`move-paused`), retries on its own, and Give up in cams-admin deletes nothing. The choice "delete what was copied" no longer applies after the switch-over.
- A finished or cancelled move tells cams-admin how long what remains takes to age out (`keepDays`).
- An Archive item has a new field `move` (also in its metadata): after a camera move it says why the item is here (moved from a proxy, or kept because the move could not copy it), `null` otherwise.
- Camera moves copy Archive items first (newest first), then the rest newest day first; with "copy as much as fits" the Archive counts first, and an Archive day that doesn't fit is skipped (it stays on the source) together with every chunk after it.
- Security update of body-parser (GHSA-27r3-jxmh-p828).

## v2026.10.23.1

- Camera moves can be started by cams-admin (new command `move.begin`, under `move.send`). With bounds from cams-admin, the source approves its own offer when the target's answer fits them (estimate within the time budget, the space choice possible); otherwise the offer waits on the panel with the reason (`move-auto-approve` in the audit log).

## v2026.10.22.1

- Camera moves, groundwork: a camera with the new local setting `cameras.<id>.moved` (the id of its move) is hidden like a removed one: its worker stops, it leaves the APIs and its FTP user is refused, while its configuration and files stay; clearing the setting starts it again, live. New local setting `moves.maxCameras` (no limit by default). cams-admin cannot set either. Internal: `purgeCamera` deletes every row and file of one camera.
- Camera moves, source side: new endpoints under `/api/moves/{id}/` (probe, manifest, chunk manifests and rows, files, the sealed camera password) for the proxy taking a camera over. Only that move's token opens them, from the target's address and until the move ends; no other token does. The password is sent only sealed to the target's key. Under storage pressure or high load the file and chunk endpoints answer 503 so the target slows down. A refused request is audited as `move-token-refused` (at most once per move and reason per 10 minutes). The move endpoints are not under the general limit of 1200 requests per minute per address.
- Camera moves, starting one: new admin routes under `/control/moves` (ask for the target proxies, request the move, see its state and the target's answer, approve the plan, ask to cancel). They refuse a move up front on a proxy without a site CA (the Pi: `no_site_ca`), for a camera whose certificate is managed elsewhere (`external_cert`), without the `move.send` entry (`moves_not_allowed`), or while another move is open (`busy`). A cams-admin sign-in may use them only with `move.send`; a cams-admin token never. The source then follows cams-admin's move commands: it records the move, takes the target's answer, and at the switch-over accepts exactly one more certificate on the camera, the target's leaf (any other one is still "unexpected"), and finally hides the camera live. New audit records `move-request`, `move-approve`, `move-switch` and `move-phase`. A valid move token used from another address is reported to cams-admin once.
- Camera moves, target side: a proxy that accepted a move takes the camera over when cams-admin starts it, without a restart: it makes a key for the move and the camera's certificate, fetches the camera's password from the source (sealed to that key) and stores it, adds the camera with the source's settings (and the approved storage limits when the move needed more room; a camera hidden here by an earlier move away is shown again), pushes its certificate to the camera, points the camera's FTP upload at itself, and reports the camera as switched. A step that fails is retried, then the move is reported failed; a restart picks the move up at the step it was in. New audit record `move-offer` (the answer to an offer); `move-switch` and `move-phase` now also on the target.
- Camera moves, copying the content: once the camera is switched over, the target pulls the camera's recordings, stills, clips, events, Vision results, still checks and Archive items from the source, newest day first, at a rate that fills the approved time budget but never exceeds the measured speed (half of it while either proxy is busy; never faster once the budget is over). Each file is checked against its size and SHA-256 and kept under a temporary name until then; a file whose checks fail three times is reported, one the source's retention deleted meanwhile is skipped. Copying waits while the target's storage is paused. Catalog entries get new ids on the target (Vision results stay with their events, Archive items and images are renamed with them), files that failed or expired leave their entries out, and duplicates of what the target recorded itself during the switch-over are skipped. A restart resumes where the copy stopped. The source's manifest now says when it listed the switch-over day again (`refreshed`). A source that stops answering is retried until it is back (audited as `move-source-unreachable` at once and every 6 hours); a slow transfer is never cut for being slow. New audit records `move-progress`, `move-budget-exceeded`, `move-file-failed` and `move-source-unreachable`.
- Camera moves, finishing and cancelling: when cams-admin finishes a move, the source deletes all of the camera's content (files, catalog entries, Archive items, its recordings cache), removes a camera added on its page (a camera from config.json stays hidden there; you can delete it from the file), and deletes the camera's stored password and certificate; the target stops copying and deletes its temporary files and the move's keys. The audit records stay on both. A cancel before the switch-over leaves the camera on the source as it was; after it the camera goes back: the target removes it (and, if chosen, the content the move copied there, never what the target recorded itself meanwhile; the rest its retention ages out), and the source runs it again at once, pushes its own certificate and points its FTP upload back at itself, trying again by itself until that worked (a failure is audited, and no other move starts meanwhile). A move token used from another address now ends the move on the source for good. Finishing or cancelling twice changes nothing. New audit records `move-cancel`, `move-cleanup` and `move-done`.
- Camera moves, the page: Settings has a "Move to another proxy…" button per camera (for the local admin, or a cams-admin sign-in when `move.send` is allowed). It asks which proxy of the account should take the camera and shows the proxy's reason when it can't. When it can, one confirmation panel lists the settings that move, the content (stills, clips, events, still checks, Archive: those that exist) with sizes and days, whether to transfer content, what to do if it doesn't fit (leave kinds out, raise the target's limits, or copy as much as fits, newest first), the estimated time and a time budget (not below the estimate), and says that this proxy deletes the camera's content when the move ends. Approving starts the move. The Status page shows a move in progress (phase, copied of total, time left, over-budget note, a failed move with its reason) with "Cancel move…" and the choice to delete what was copied on the target or let it age out there; the camera's certificate "Push now" is off while it switches over. A camera left hidden in config.json after its move is listed on Settings. The session rights now include `move` for a cams-admin sign-in with `move.send`, and `GET /control/moves` items carry `failure` (the code a failed move ended with).

- Camera moves, the guide: [docs/camera-move.md](docs/camera-move.md) (what to allow, what moves, the panel, cancelling and ending a transfer, the leftover in config.json, the audit records); the cams-admin page lists the `move.send` and `move.receive` entries and the move files in `data/admin/`. A test runs a whole move between two proxies.
- Camera moves, fixes found by that test: a proxy whose last camera moved away no longer stops with an error (the Archive's daily cleanup timer threw), keeps its cams-admin connection (its health summary threw, so it reconnected over and over and the move couldn't finish), and its Status page and local health answer again; they show "no camera runs on this proxy" (in the health one Camera item that is no problem, so such a proxy still reports ok). The copy no longer slows down in the last minute of its time budget, which made almost every move end over budget (`move-budget-exceeded`).
- Camera moves, follow-up: the move dialog explains two new refusals from cams-admin, "cams-admin doesn't know this camera (register it in cams-admin first)" and "something went wrong in cams-admin; try again". The copy now counts its time budget from the approval, like cams-admin does (the switch-over included), and aims to be done at 80 % of it, so moves no longer end slightly over budget.

## v2026.10.21.1

- Admin UI: signing in through a one-time link from cams-admin (#227). Such a session (user `managed-admin`) could press **Save** on the Settings page or **Restart proxy**, and nothing happened: the proxy refused them as local-admin-only, and only the audit log said so. Now the page shows every control it may not use as off, with one line: "Needs the local admin token: you signed in from cams-admin." A refusal that still happens shows as an error at the control (also a Settings row's Reset, which used to fail without a word). Renaming a camera, sign-in links, unticking commands, pausing and blocking keep working as before.
- cams-admin card: two new entries, **cams-admin sign-in**, off by default. `ui.config` lets a cams-admin sign-in change settings and reset them (never addresses, ports, files, trust, users or cams-admin itself, neither set nor reset, and no camera added or removed; its Reset to defaults leaves those as they are and says so); `ui.restart` lets it restart the proxy and its camera side. Only the proxy's own admin token adds them (the card, or `cam-proxy admin-commands allow ui.config`); cams-admin can't grant them to itself, they never apply to a cams-admin token outside the admin UI, and a pause or `CAMPROXY_ADMIN_COMMANDS=off` turns them off again. A change made this way is recorded as usual, with the managed token's label and `allowedBy`; a refusal names the managed token too (reason `local-setting` for a protected setting). `ui.config` also leaves the storage limits and Google Vision on/off to the proxy's own admin token, and changes retention, the size caps and Google Vision's spending caps one way only: retention longer and caps for data higher, spending caps lower, never the other way, by a save or a reset (Reset to defaults keeps such settings and names them; the row says why). `ui.restart` has no rate limit of its own. The page follows a pause or an unticked entry without a reload. `GET /control/session` now also says what the session may do.

## v2026.10.20.2

- Dependencies: @peculiar/x509 2.2.0 (#217), used by the site CA; test tools (#218). cam-sim v2026.10.20.1 for the tests (CX820 model, #222).

## v2026.10.20.1

- Camera FTP status: the Reolink CX820 hides the FTP user with one visible character on each side (`cam4` → `c**4`), the RLC-1224A with two (`camera` → `ca**ra`). The proxy now accepts both, so a CX820 pointed at it shows FTP **on** instead of "uploads elsewhere". Uploads themselves were never affected.

## v2026.10.13.1

- Dependencies: @peculiar/x509 2.x (#213). The library no longer brings its own Reflect polyfill, so the proxy loads `reflect-metadata` before it (one entry, `src/tls/x509.ts`); without it the proxy did not start. Nothing changes in the site CA or the certificates: a CA created before the update still loads with the same fingerprint (pin) and issues leaves with the same extensions, which verify against it. A regression test checks this with a test-only CA and leaf made by 1.14.3 (`test/fixtures/tls-x509-1.14.3/`).

## v2026.10.08.2

- Admin UI: the cams-admin page is called **Cams-Admin** in the navigation and its heading. The Cams-Admin and Certificates pages use the full width like Maintenance: on wide screens the allowed commands sit in two columns and the Site CA and This proxy cards side by side; phone width is unchanged. The cams-admin URL on the Cams-Admin page and the host on the Status card are links that open cams-admin in a new tab (http and https only; the copy button stays).

## v2026.10.08.1

- Admin UI: cams-admin and Certificates get their own pages (#203), in the navigation after Maintenance. The Status page keeps short cards with **Details →**: cams-admin shows the state and since when, the cams-admin host, the account, commands on/paused, how many are allowed (and how many need re-confirming), managed tokens live/blocked, the last command and warnings; Certificates shows the site, the CA's end, one line per camera (mode, what is left, the last push) and warnings. The pages are laid out for phone width: recent commands, changes and managed tokens are rows that stack on narrow screens; ids and hashes are shortened in the middle with the full value on hover and a copy button; fingerprints are shown in groups of four that wrap between groups; times never wrap. The Certificates card's rows no longer spread over the card's height next to a taller card. Nothing changes in what is allowed, audited or in the API.

## v2026.10.07.2

- Health: the camera's SD card (#199). The proxy reads the card and the recording settings (`GetHddInfo`, `GetRecV20`; read-only) when the camera comes online and every 5 minutes. A new health item "SD card" and `camera.sd` (`mounted`, `formatted`, `capacityMB`, `freeMB`, `overwrite`, `recordingEnabled`, `checkedAt`, `lastRecordingAt`, `stalled`) in `GET /api/local/health`, the Status page (Health card, and an "SD card" line on the Camera card) and the cams-admin heartbeat. Overwrite off is a warning on its own ("Overwrite is off: the camera stops recording to its SD card when it is full"; amber, `warning: true`, not counted as a problem). Problems: no card, not mounted or not formatted; recording off; under 5 % free with overwrite off ("SD card almost full and overwrite is off: recording to the SD card will stop"); and recording to the card stopped while FTP clips still come ("The camera hasn't recorded to its SD card since …": its newest recording more than an hour before the newest clip). Metrics `camproxy_camera_sd_free_bytes`, `camproxy_camera_sd_capacity_bytes`, `camproxy_camera_sd_overwrite`. Vendored cams-admin contract with these fields.

## v2026.10.07.1

- Remote configuration from cams-admin (migration P3), **each command off unless allowed on this proxy's card**: `config.get`; `config.set` / `config.unset` with a dry run and a revision check (a local edit since cams-admin read wins: `conflict`); `config.rollback`; `camera.name.set`; `camera.action:<action>` per action; `proxy.restart`. Only a compiled list of settings may be set remotely (never addresses, ports, files, trust, users, cams-admin's own settings, storage, capture switches or health thresholds); retention periods and size caps only up, Google Vision limits only down. Disruptive entries (proxy restart, camera reboot, power-cycle, FTP/NTP/certificate setup) are grouped and warned on the card, at most 2 restarts and 6 disruptive actions an hour. Each change is audited (`config-change` by `cams-admin`), marked on the Settings page and listed on the card with **Undo** (also `cam-proxy admin-commands changes|undo`). A local settings edit reaches cams-admin within seconds. Entries ticked under the previous version (when these commands did nothing yet) need a fresh tick on the card. `camera-ftp-off` can't be allowed for cams-admin (it would stop clip intake). `overrides.json` is now written with fsync (a power cut can't leave it torn). docs/cams-admin.md.

- Security: "Push now" (`camera-cert-push`) no longer returns the camera certificate's private key (or any certificate PEM) in its answer; it answers the outcome, the served fingerprint and the leaf's fingerprint, expiry, names and addresses.

## v2026.10.06.4

- cams-admin files under `data/admin/` (key, tokens, commands, policy, replay): a file of the proxy's own user that others could read is set back to 600 (folder 700) instead of refused. Fixes the cluster's client stopping after v2026.10.06.3 (`fsGroup` makes the volume's files 660 on every pod start). Another user's file is still refused; a refused key file, or unusable replay files, are checked again within 30 s, so a `chmod`/`chown` needs no restart.

## v2026.10.06.3

- Commands from cams-admin (migration P2): signed, allow-listed, idempotent and audited, over the existing outbound channel; **off unless allowed on the proxy** (Status card, `admin-commands`, or `camsAdmin.allowCommands` in `config.json`; never `overrides.json`). Pause (any admin) and resume (local admin token only); the `CAMPROXY_ADMIN_COMMANDS` kill switch (anything but `on` = off). A cams-admin-managed admin token, and sessions or sign-in links it starts, can only narrow. The first command, `tokens.apply`, installs managed client (and, with `tokens.apply.admin`, admin) token hashes beside `CAMPROXY_TOKENS`, with rotation (`retireAt`), stale-revision protection and a local block list (`admin-tokens`); `CAMPROXY_TOKENS` may be unset while a managed client token is live. Files `data/admin/tokens.json`, `commands.json`, `policy.json` (mode 600). Heartbeat `commands`, `tokens`, `configRevision`; hello capability `commands`. Routes `/control/admin/commands*`, `/control/admin/tokens*`; audit actions `admin-command`, `admin-policy`, `admin-token`. Config schema 2. Session cookies are `v2` (a restart signs everyone out, as before). docs/cams-admin.md.

## v2026.10.06.2

- cams-admin client (off unless `camsAdmin.url` is set; the Pi is unchanged until enrolled): enroll with a one-time code (`admin-enroll --url U`, the code on stdin, or the Status page's cams-admin card), then one outbound WebSocket that sends the health summary as a heartbeat (signed handshake, the server key pinned at enrollment, backoff with jitter, close codes per cams-admin's spec §8.8). `admin-unenroll`. Key file `data/admin/key.json` (mode 600). `GET /control/admin`, `POST /control/admin/enroll|reconnect|unenroll`; audit actions `admin-enroll`, `admin-unenroll`; `camproxy_cams_admin_state{state}`. Settings `camsAdmin.url`, `camsAdmin.keyFile`, `camsAdmin.enabled` (`camsAdmin.allowCommands` must be empty). docs/cams-admin.md.

## v2026.10.06.1

- Site CA (`tls.site`, off unless set; the Pi keeps it unset): a name-constrained CA per host (`<site>.internal`, `tls.cameraSubnet`, `tls.proxyAddresses`); camera certificates issued, pushed and renewed by the proxy (a refusing camera is reported `pinned` with its own fingerprint); HTTPS on `server.tls.port`; `GET /tls/ca.pem`; `GET /api/cameras` items carry `tls`; `GET /control/tls`, `camera-cert-push`, `tls-ca-rotate`; the Certificates card; the `certificates` health item; `camproxy_cert_not_after_seconds`, `camproxy_cert_push_total`; FTPS with the proxy's certificate. `ntp.server` keeps the cameras' NTP on the host (`camera-ntp-set`). The host renderer turns all of it on (`lan.address` is new in `host.json`).

## v2026.10.05.7

- **Rollback note** (the Pi): no new migration (the catalog stays at schema 9). The previous release refuses overrides it doesn't know (`composition.concurrent`, `analytics.googleVision.perCameraDailyCap`, `cameras.<id>.storage.sharePercent`, a camera added in the Settings page): a rollback restores the `overrides.json` backup taken before this update.
- One go2rtc for all cameras; a camera added or restarted never restarts it.
- FTP: one server, a user per camera (default: the camera id); a login from another address than the camera's IPv4 address is refused and audited (`ftp-login-refused`; a camera reached by name has no address check). `CAMPROXY_FTP_PASSWORD` at most 256 bytes. On the Pi the camera's FTP login must come from its configured address (`CAMERA_HOST`), as it does.
- Storage: per-camera accounting (Status page, metrics, `/control/stats` `cameras`) and optional `cameras[].storage.sharePercent` (100 % only when every camera has a share).
- Vision: limits count per API key (a new key starts a fresh count, also one of the same Google project); `checksPerDay` per camera and day, as documented; `analytics.googleVision.perCameraDailyCap`.
- A camera's `host` is a name or IPv4 address with an optional `:port` (as `CAMERA_HOST`); anything else (e.g. `${…}`, which go2rtc would expand) is a config error.
- PoE switch: one controller per host with a queue (a second camera's request waits, then `409 switch_busy`); a driver per switch model; one read serves every port for 10 s.
- `composition.concurrent`: encodes at once (default 1).
- One recordings cache for all cameras (`recordings.cacheMB`).
- Control: `/control/cameras/:cam/name` and `/control/cameras/:cam/actions/:name` (since P1); cameras can be added and removed in the Settings page, which shows the host's settings and the picked camera's.
- `GET /api/cameras/:cam/stills/latest.jpg`, `…/previews/latest.jpg`, `GET /api/stills/latest`; `GET /api/cameras` items carry `latestStill`.
- CPU temperature on AMD hosts (k10temp Tctl).
- Several cameras: `POST /control/actions/restart` without a camera restarts every camera side and applies every pending setting (the Settings page's "Restart to apply"); a camera's restart applies its pending `cameras.<id>.*` settings; `GET /control/config` says `restartScope`.
- The multi-camera host (the mini PC, docs/multi-camera-host.md): `scripts/host/render.ts` renders nftables, dnsmasq, chrony, sysctl, the camera-side interface, Docker's `daemon.json` (`"iptables": false`), compose and the first `config.json` from one `host.json`, refusing bad leases, overlapping subnets, a shared or odd NIC name and bad ports; IPv4 forwarding comes on only once the ruleset is loaded (fails closed); `scripts/host/validate-rendered.sh` checks them with Debian 13's tools in containers; `deploy/host/prepare-host.sh` installs them (idempotent) and `deploy/host/check-host.sh` verifies the host. `scripts/measure-camera.ts` reads a camera's `GetNtp` and certificate state (`--set-ntp` writes the whole `Ntp` object). The kube-setup request for the camera subnet is in `deploy/cluster/REQUEST.md`.

## v2026.10.05.6

- **Before updating** (the Pi): back up `data/overrides.json` and `data/catalog.sqlite`. The previous release won't start on the new overrides (`cameras.*`) or the catalog's schema 9; a rollback is restoring both and the previous image (docs/raspberry-pi.md).
- Several cameras per proxy: `cameras` in config.json (a list), a camera worker each, supervised (a failing camera retries with backoff, the others go on; a camera without an address waits idle instead of stopping the proxy). Today's `camera` object still works unchanged; overrides with legacy paths are read translated and written back as `cameras.<id>.*` / `poeSwitch.*`. `GET /control/config` shows the new paths.
- `GET /api/cameras` lists every camera, with `error` and `features` (`["sse-cam-list"]`). A camera being restarted answers `503 camera_restarting`.
- SSE: `?cam=a,b` filters to several cameras.
- Health summary: `cameras[]` and one aggregated item per camera kind; schema 1, the top level is the first camera.
- Audit records name their camera (`labels.camera`) only when they concern one.
- `CAMPROXY_CAMERA_PASSWORD_<ID>` for a camera's own password.
- Admin UI: a camera picker when the proxy has several cameras; the camera actions act on the picked camera. `GET /control/cameras`, `GET /control/cameras/:cam/status`, `POST /control/cameras/:cam/actions/:name` (or `?cam=<id>` on `/control/actions/:name`) and `PUT /control/cameras/:cam/name`; without a camera, a multi-camera proxy answers `400 camera_required`; `restart` with a camera restarts that camera only.

## v2026.10.05.5

- Settings: a value equal to config.json's or the default is no longer stored as an override; saving it removes the override (also in a whole-group `PUT /control/config`, which before stored every field it carried, e.g. `camera.poeSwitch.ports` 8 and `offSeconds` 10).
- Settings page: an override equal to the default (kept by an older version) shows "override = default" (or "= config.json") with a tooltip, and no Reset button, since Reset would change nothing. Reset to defaults still removes it, listed as "N overrides equal to the default are removed too, no change in effect".
- Settings page: a Reset to an unset state says what that means, e.g. "Reset – none (no PoE switch: power-cycle off)", "Reset – not set (PoE switch control off: no switch address)"; the same in Reset to defaults. `GET /control/config` `resetTo` has `same` and `means`.

## v2026.10.05.4

- Audit: every automatic Vision analysis of an event that made a call is an `event-analysis` record (user `system`; camera, event, still, `ok` or `failed`, calls, time taken, categories found). Skips (no still, the limits, a pause) write none.
- Audit page: the action filter is a multi-select (checkboxes in a drop-down, keyboard accessible); "All actions" selects all, and again none ("No actions selected"). It lists every known action (also `event-analysis`, `camera-address` and the Archive's). `GET /control/audit?action=a,b` refuses an unknown action (400).
- Audit page: the retention line says the real numbers, "Kept for 90 days (Settings) · 1,234 events in that time." (`GET /control/audit/summary`).
- Settings page: an override's Reset button names what it goes back to ("Reset – 90 days", "Reset – on", "(config.json)" for a file value); `GET /control/config` has `resetTo` on overrides. "Reset to defaults" (shown while any override is set) removes them all after a confirmation listing each change (`DELETE /control/config`, one `config-change` record with `reset: "all"`). On a phone the settings cards fit the screen.

## v2026.10.05.3

- The Archive (spec 2026-10-05-archive-design, API in docs/archive.md): clips kept apart from retention and the storage budget, in `<dataDir>/archive/<camera>/<id>/` (`clip.mp4`, `thumb.jpg`, `meta.json`) with a catalog row (migration 8). `POST /api/cameras/:cam/archive` stores a finished composition (`source.type: composition`), the SD card's recording as it is (`recording`, fetched over Baichuan unless cached) or the proxy's FTP clip (`clip`), with a name (default `<date> <time> <camera name>` in camera time), labels (Pet, Person, Vehicle, SD, 4K, custom; case-insensitive), a retention (365 days by default, or `null` for forever) and an optional thumbnail second; it answers the archive job (201 when done within 3 s, else 202; `GET /api/archive/jobs/:id`). The metadata snapshot has the window's events with their Vision analyses, the still checks, the camera, quality, duration and size; the thumbnail follows #157 (the analysed or detection still), else the first frame. 507 `insufficient_space {needed, free, minFreeBytes}` when the clip would not leave `storage.minFreeBytes` free.
- `GET /api/archive` (filters: camera, labels, text, recorded window, quality; sort by created, recorded, name, size, expires, camera, quality, duration or labels; paging), `GET|PATCH|DELETE /api/archive/:id`, `POST /api/archive/delete` (up to 500), `GET /api/archive/:id/video` (Range; `?download=1`), `/thumbnail`, `/metadata`, `GET /api/archive/zip?ids=…` (a streamed ZIP: the clips stored, their metadata and thumbnails; ZIP64 past 4 GB), `GET /api/archive/status`. Client token; `X-On-Behalf-Of` names the person in the audit records. A stream message `archive` (`add`, `update`, `delete`, `clear`, `expire`) for every change.
- A daily cleanup at 03:30 camera time removes clips past their retention. Audit records `archive-add`, `archive-update`, `archive-delete`, `archive-clear`, `archive-expire`.
- Status page: an Archive card (clips, size, share of the disk, disk free, oldest, newest, next cleanup and how many expire, last cleanup), with a WARNING above `archive.warnPercent` (new setting, default 50 %); the health summary has an `archive` item (a problem above it; the e-paper display shows it). Maintenance: "Clear the Archive…" (`POST /control/actions/archive-clear {count}`), confirmed by typing the number of clips. New settings `archive.enabled` (true) and `archive.warnPercent` (50).

## v2026.10.05.2

- Settings → Find camera: "Currently used Camera" sits right-aligned in the button column; the button reads "Use this camera" (was "this camera" / "Use this address").

## v2026.10.05.1

- Status page, Analytics card: the usage is on separate lines — This month, Today, Last call, and Still checks today (the manual checks' own daily limit) — instead of one long line.

## v2026.10.04.4

- The Pi's one `.env` (spec 2026-10-04-pi-config-design): `CAMERA_HOST` (or `CAMPROXY_CAMERA_HOST`) sets `camera.host`, `PI_ADDRESS` (or `CAMPROXY_PI_ADDRESS`) sets `ftp.publicHost` and `server.publicUrl` (`http://<PI_ADDRESS>:<port>`). The environment wins over the Settings overrides and config.json; such settings are read-only on the Settings page ("set in .env", `source: "env"`), and an override of them answers 400. With `CAMPROXY_ENV_FILE`, the two keys are read from that file at every start (any value there wins over the container's environment). Startup line `config_env`.
- `GET /api/cameras` entries carry `address` (the camera's `camera.host`), and the `camera` stream message carries it too: `{cam, name, address}`, also sent (with the name last told, if any) when the camera side starts with another address.
- Settings → Find camera: `POST /control/actions/find-camera` probes the LAN with ONVIF WS-Discovery (3 s, no login; 6 a minute) and lists the devices (address, name, model, the current camera marked). "Use this address" (`POST /control/actions/camera-address {host}`) writes `CAMERA_HOST` into the `.env` file (only that line; a backup `.env.bak-<time>`, the last 5 kept; atomic; audited as `camera-address`; it shares find-camera's limit), then restarts the proxy. Each device shows the address its answer came from; one that names another address in its XAddrs is flagged "address mismatch", and the address it answered from is the one used. Without `CAMPROXY_ENV_FILE` it shows the line to add by hand.
- compose.yaml (the Pi): the settings file is now `/srv/cam-proxy/config/.env` (uid 1000, mode 600, in `config/` with mode 700): `env_file: config/.env`, `./config:/config`, `CAMPROXY_ENV_FILE=/config/.env`, `./data:/data`. No `${…}` substitutions any more (`CAMPROXY_DATA` is gone), so nothing the container can write changes how compose starts it. docs/raspberry-pi.md: the single file, the migration from `/srv/cam-proxy/.env`, and "On the road".

## v2026.10.04.3

- Compositions around a second (cams #179, phase 3): `POST /api/cameras/:cam/compositions` takes `{at, preS, postS, size, badge, timeZone?}` (`at` unix ms, a whole second) instead of `{clipId, span?}`, exactly one of them. The window is `[at − preS, at + 1 s + postS]` (rolls 0…3600; the same limits, 300 s and 120 s at `1080p`), each second from an FTP clip that covers it, else its still ("STILLS 1 FPS" badge), else a "No recording" card. 400 `invalid` for an `at` that is not a whole second, in the future, or older than the stills and clips kept, and for a window that has not ended; 409 `nothing_to_compose` when no clip or still covers any second (also for `clipId`, which never happens there).
- `dryRun: true` (either anchor) answers 200 `{start, end, durationS, seconds: {clip, still, card}, clips: [{start, end}]}` without a job, for cams's "made of" line.
- Compositions are limited to 10 a minute per client (dry runs not counted; 429 `rate_limited`) and audited: a `composition` record per request past the input check (anchor, window, size, what it is made of, outcome, job id).

## v2026.10.04.2

- Still checks (cams #179, phase 1): Vision on any second that has a still, picked by hand, stored apart from events. `POST /api/cameras/:cam/still-checks` `{"at": <unix ms>}` (client token, or admin; a session needs `X-CamProxy-UI`): 201 `{check, reused: false}` after one call; 200 `{check, reused: true, source}` without a call when the second was checked before (`check`) or an automatic analysis used its still (`event`, `check.id` null); 400 `invalid` (`at` not a whole second, in the future, or older than the stills kept); 404 `no_still`; 409 `analytics_off` (`off`, `no_key`, `checks_off`); 429 `limit` (`month`, `day`, `checks`), `busy` (one check at a time; the same second waits for the running call), `rate_limited` (20 a minute); 503 `analytics_paused`; 502 `provider_failed` (no retry; the call counted). `check`: `{id, stillTs, provider, summary, objects, events: [{id, kind, confirmed}], imageUrl, requestedAt, tookMs}`; the events the second sits in are computed when read, and a check only confirms (person, vehicle, pet; motion never).
- `GET /api/cameras/:cam/still-checks?from&to` (at most 31 days, oldest first), `GET …/still-checks/:id` (with the raw answer) and `GET …/still-checks/:id.jpg` (immutable). A new stream message `still-check` (in the default types) for each new check.
- `GET /api/cameras/:cam/analytics` (client token): the Vision budget for cams's button, `{enabled, paused, month, today, checks}`, never the key.
- New setting `analytics.googleVision.checksPerDay` (default 10, 0–1000, 0 = no checks): still checks per camera day, on top of the shared monthly limit and daily cap, so checks can't spend the calls the person events need. In the Settings page's Analytics card. `GET /control/analytics` reports `checks: {today, cap}`.
- Audit: a `still-check` record per request past the input check (outcome, reason, cost, what was found, who); `activity-daily` counts the day's checks (`analytics.checks`).
- Catalog version 7: a new table `still_checks` (additive). Checks are kept `retention.eventsDays` (30) with their own JPEG copy in a new folder, `data/still-checks/<cam>/check-<id>.jpg`; retention deletes old checks with their images and files no check names there, and reports `deleted.stillChecks`. The analytics folder is unchanged.
- Rollback: an older version runs with catalog version 7 (it logs `catalog_newer_than_code` and ignores the table) and never touches `data/still-checks/`, so the checks and their images are back when this version runs again; meanwhile cams's check button sees 404 (no still checks on that proxy).

## v2026.10.04.1

- Composed clips are up to 300 s long (were 60 s), 120 s at `1080p` (encoding time on a Pi 4: about 3 minutes either way, estimated from the Mac). Pre-/post-roll are whole seconds from -3600 to 3600 (were -600…60); the result's length is the limit. A job may run 10 minutes (was 5). Refusals read `at most 300 s (5:00)`.
- `POST /api/cameras/:cam/compositions` takes an optional `span: {start, end}` (unix ms): the recording the rolls apply to. cams sends the SD-card recording the viewer chose; the proxy's FTP copy of it can start earlier or run longer, and the rolls were applied to that copy, so a 114 s recording with pre-roll -100 and post-roll 30 (44 s) was refused as "at most 60 s". Without `span` the rolls apply to the clip, as before. A `span` that overlaps the clip by less than 1 s is a 400 (`span must overlap the clip by at least 1 s`).
- Composition encodes run at nice 10, so a long one doesn't starve the stills and the stream on a Pi.

## v2026.10.03.6

- Camera name (camera-name design): the camera stores its name, and the proxy reads it with the routine status poll (`GetDevInfo.name`). `GET /api/cameras` (and the new `GET /api/cameras/:cam`, the same entry for one camera) `name`, `GET /control/status` `camera.name` (with `nameSource`: `camera` or `config`) and `GET /api/local/health` `camera.name` report the camera's own name; the configured `camera.name` is only the fallback until the camera was read after a start.
- `PUT /control/camera/name` `{"name"}` renames the camera: checked against the camera's rules (1 to 31 characters; ASCII letters, digits, space and `- ( ) + = [ ] { }`; no leading or trailing space; the same regex as cams), written with `SetDevName`, read back with `GetDevName`; 200 `{name}` (read back), 400 `{"error":"invalid_name","reason"}` (the rules, or the camera's -54/-56), 503 `{"error":"camera_offline"}`. Admin token or admin session (with `X-CamProxy-UI`); audited as `camera-name` (from, to, requestedBy).
- Stream: a new `camera` message `{cam, name}`, once per change of the camera's name (a rename through the proxy, or one made in the Reolink app or the camera's web UI, seen by the next poll). It is in the default `types`; a client that names `types` adds `camera`.
- Admin UI: the Status page's Camera card shows the name; the Settings page's camera name field is "Camera name (stored on the camera)", checked as you type and saved on the camera (the error under the field when it is refused).
- Tests and e2e run against cam-sim v2026.10.03.5 (GetDevName/SetDevName with the measured rules; it masks the FTP user as the camera does).

## v2026.10.03.5

- Code cleanup across the repo (shared helpers for sleeps, time units, atomic writes, path settings, busy Search retries; one copy each of the camera-side start/stop and the API's range and file-send handling; unused exports dropped). No change in behaviour or API answers.
- Lighter on the Pi: `GET /api/cameras/:cam/clips` reads the events for the whole list in one query (was one per clip) and `/recordings` its clip links in one (was one per recording); a day of previews reads each sidecar once until it changes; the minute's pack and sprite are written without blocking the event loop; SSE frames are built once for all clients; the admin UI sends one status+stats refresh at a time (a burst of stream events was one each) and none from a hidden tab.

## v2026.10.03.4

- CI: the required PR check runs `npm audit --audit-level=high` over all dependencies, dev included, so a high finding in a dev dependency blocks the PR (it only warned before). There are no open findings, so no allowlist.
- Docs: the README has a Related repos section (cams, cam-sim, cam-proxy-pi-display) and names the e-paper display as the reader of `GET /api/local/health`; the settings table adds `composition` and `analytics`; `/health` answers `{ok, version, startedAt}`; `production` requires `e2e` too.

## v2026.10.03.3

- Admin UI navigation works like cams: on desktop the sidebar shows icons and labels and "Collapse" shrinks it to icons (remembered per browser); on phones (767 px and narrower) the icon rail is gone and a hamburger at the top left opens the menu as a drawer over the page; its footer has what the phone top bar leaves out (the camera's model, linked to its web page, firmware and version, and "updated N s ago"), the theme toggle and Sign out. The drawer closes on navigation, Back or Forward, a tap outside, the close button, Escape or Sign out, and gives focus back to the hamburger. The phone top bar stays on one row: the camera and events pills show a dot and the state only.

## v2026.10.03.2

- Health summary (spec 2026-10-03-health-summary-design): the Status page starts with a Health card, one line per item (camera, live stream, events intake, camera FTP upload, storage, disk, CPU temperature, under-voltage, last inventory, version), red when it is a problem, with "All OK" or "N problems". Problems: the camera offline, the stream down while enabled, ONVIF not subscribed, the camera's FTP upload off, pointing elsewhere or never set up (while `ftp.enabled`), or the FTP stall check stalled, storage paused, the data volume at or above `health.diskPercent` (new setting, default 90), the CPU temperature at or above `health.tempC` (new setting, default 75 °C), the under-voltage alarm, a failed last inventory. The other cards mark the same items red from the same summary (the FTP card's "Camera upload" and "Last clip" lines too), and the Storage card shows the data volume's "Disk used". The FTP card's "FTP upload isn't set up on the camera" note is now a warning (amber), no longer grey.
- On a Raspberry Pi (detected from `/proc/cpuinfo`) a Pi card shows the model, CPU temperature and under-voltage (hwmon `cpu_thermal` and `rpi_volt`, found by name), memory, uptime, load and the disk, read once a minute without shell-outs. New setting `host.stats` (`auto`: on a Pi only; `on`; `off`). Off a Pi (the cluster) there is no Pi card and no Pi lines; a figure that can't be read is left out and is never a problem.
- `GET /api/local/health`: the health summary as JSON, without a key, for a process on the same host (the e-paper display on the Pi). Answered only to a connection from `127.0.0.1`, `::1` or `::ffff:127.0.0.1` (the socket address; never `X-Forwarded-For`); any other caller gets what an unknown `/api` route gets. No secrets. `GET /control/status` carries the same summary as `health`.

## v2026.10.03.1

- Inventory box: the buttons say when they change data. Renamed: "Compare clips with the camera" → "Search for and retrieve missing clips", "Check events" → "Search for and add missing events", "Fetch N lost clips" → "Retrieve N missing clips", the stills line "Restorable from local clips: X" → "Covered by local clips: X (not restored)" (the stills message and clock note say "covered by local clips"; the field stays `restorableSeconds`). When the run a click of the page started ends with something missing, the confirmation opens by itself ("Retrieve N clips (x MB) from the camera?", "Add N missing events …?"); Cancel leaves the follow-up button ("Retrieve N missing clips", "Add N missing events") for an hour. A report loaded on page open or a run started in another tab or through the API never asks. With nothing missing the box says "Nothing to retrieve: all the camera's recordings are here." or "Nothing to add." The box's intro says which buttons only read and which change data after a confirmation.

## v2026.10.02.7

- Inventory follow-ups (#106, #111, #114): the clips check counts FTP pictures no clip links as `snapshotsWithoutClip` (item `snapshot-without-clip`), apart from clip files without a row; the events message gives the window start as the camera-local date; the stills box notes packs the retention deleted during the run (`prunedDuringRun`) and lists the first 10 file problems with their minute; with `stills.enabled` off the stills window ends after the newest pack (a note says so) instead of one long gap; the Inventory box also polls every 10 s while idle, so a run started in another tab or through the API shows. The SD card's oldest day also looks at the month before the window, so a window starting on the 1st no longer calls clips gone from the card "older than the SD".
- Storage pauses are audited (#106): `storage-paused` (outcome failure) and `storage-resumed` records when free space crosses `storage.minFreeBytes`, with `free` and `minFreeBytes`; the stills inventory explains gaps by them (`paused`, "storage paused (disk full)"), from the pause to the resume or the next proxy start. The Audit page can filter by them.
- Recordings: a download an inventory repair started (low priority) says "inventory repair" on the Status page's Recordings card; `/control/status` `recordings.last` has `priority` (`high` a viewer, `low` a repair), the `recording_download` log line too, and `camproxy_recording_downloads_total` has a `priority` label (#111).
- The clips and events inventories don't judge a recording that starts at 23:55 or later and is listed with end 000000 (it may still be being written) until 01:00 the next day, and the clips repair skips it until then (`still-recording`): fetched earlier it could be cut short, and its FTP clip would land beside it. `storage-paused` and `storage-resumed` records have user `system`. The clips message says its "since" date is UTC. A failed inventory load in the box clears once a later poll works (#117 review).
- A failed power-cycle that may have cut the PoE records `offAt` in its `camera-powercycle` record, so the stills inventory counts the outage from the cut (#106).
- The stills and clips checks read the audit log one UTC day at a time, yielding between days, and the audit log no longer parses lines that can't name a wanted action: a busy audit day (up to 50 MB) no longer stalls the server for all 8 days at once (#106).

## v2026.10.02.6

- Events inventory (#75, spec 2026-10-02-inventory-design §5): "Check events" (`POST /control/actions/inventory` `{"kind":"events"}`) compares the stored events with the camera's SD recordings on `ftp.stream`, in the SD card's reach (at most `retention.eventsDays`, the report says which): per trigger kind, overlapping recordings are merged and each span needs an event of its kind from 10 s before to 5 s after it; timer-only recordings are counted, not matched; events of a recording kind without a recording are reported. "Add N missing events" (`POST /control/actions/inventory-repair` `{"kind":"events","runId":…}`, after a confirmation) adds one event per missing span and kind, at most 1000 per run in one transaction, with `source` and `endReason` `recovered` and the recordings' start and end (pre- and post-record included); existing events are never changed. Recovered events reach cams through `GET /api/cameras/:cam/events` (marked `source: "recovered"`) but send no SSE or stream-log message, are never analysed (no Vision calls), and don't count in the FTP stall check or the daily event counts (`activity-daily` counts them apart as `events.recovered`). The Events page and the Timeline mark them; a `clip` SSE message never names one, and `camproxy_events_stored` (and the status's `events.stored`) leaves them out. Each repair writes an `inventory-repair` record.

## v2026.10.02.5

- Clips inventory (#74, spec 2026-10-02-inventory-design): "Check clips" (`POST /control/actions/inventory` `{"kind":"clips"}`) checks the clips of the retention window: rows whose file is gone, clip files and pictures without a row, recording events (motion, person, vehicle, pet) without a clip, clips without an event. "Compare clips with the camera" (`"camera": true`) also lists the SD card's recordings of the window on `ftp.stream` (one Search per day with recordings) and pairs them with the local clips by start (±5 s): recordings missing locally, local clips gone from the camera, the SD card's oldest day; timer-only recordings are counted, not paired, and a day whose Search fails is `unknown`, never "missing". The repair (`POST /control/actions/inventory-repair`, the box's "Fetch N lost clips") fetches the missing ones over Baichuan at low priority (at most 50 clips or 200 MB per run, 1 s apart; never past `ftp.maxGB` or while storage is paused; it stops after 3 failures in a row or when the camera refuses or is offline) and stores them as clips marked "from camera" (`origin: "camera"`, catalog schema 6). Repaired clips send no SSE message and don't count as FTP arrivals (the "no clip for N hours" warning and the daily clips count). Each repair writes an `inventory-repair` audit record. `GET /control/inventory` lists repairs apart (`repairs`) and caches the run summaries (#106); the running view has `op`.
- Clips repair details (#74): the oldest missing recordings come first; one larger than a run's 200 MB is skipped (`too-big`) instead of blocking every run, and a busy camera Search skips a clip (`busy`) instead of counting as a failure. While the storage budget or `ftp.maxGB` deletes clips, recordings older than the oldest local clip are not offered (`prunedHere`): they would be deleted again. The offer's clips and MB are picked as the repair picks them. Repaired clips count toward storage usage but not its growth forecast. Repaired clips usually show as "clips without event" in the next check until their events are recovered (#75).

## v2026.10.02.4

- Stills inventory (#72, spec 2026-10-02-inventory-design): the Maintenance page's Inventory box ("Check stills"; `POST /control/actions/inventory` `{"kind":"stills"}`, admin only) checks the stills of the retention window in the background: missing seconds and %, the 10 longest gaps and whether a proxy stop or crash, a camera reboot or a power cycle explains them (from the audit log), the missing seconds a local clip covers ("restorable"), unreadable packs, packs without a sprite and sprites without a pack (a pack without a sprite whose previews were already pruned by their own retention is only counted as `previewsPruned`, not a problem; a pack retention deletes during the run counts as missing, in `prunedDuringRun`). A clean proxy restart explains a gap only from its previous stop, so a stall that a restart fixed stays unexplained. Progress and Cancel (`POST /control/actions/inventory-cancel`); one run at a time (409 `inventory_busy`). Results: `GET /control/inventory` and `GET /control/inventory/runs/{id}`, the last 10 kept in `<dataDir>/inventory/stills/`. Each run writes an `inventory` audit record (the start writes no `control-action`); the Audit page can filter by it.
- Recordings list: `GET /api/cameras/:cam/recordings?date=YYYY-MM-DD&stream=` lists one camera-local day, in the same shape as `from`/`to` (`date` with `from` or `to` is a 400). Both forms now include a recording that starts before midnight and runs into the day (or the range): it was missed, since a camera Search finds only the recordings that start on its day. The day before's midnight-crossing recordings are kept 15 minutes once that day has been over for 5 minutes, so a day view in that time costs one Search per stream after the first (#99).
- Recordings limits: at most 8 camera Searches wait behind the running one; past that a list, days or file request answers 503 `recordings_unavailable` with `reason` `busy` and `Retry-After: 5` instead of queueing without bound, and a Search still waiting when every request for it has gone is dropped (never sent, its place freed). A recording file not yet cached now counts in the normal rate limit (1200 a minute), not the image one; a cached one stays in the image limit (#99).
- Recordings fixes (#99): a rejected Baichuan login logs and reports the camera's remaining attempts; a reconnect right after a close no longer fails with the old attempt; the first-chunk wait starts again after the info record; the cache counts `.part` files toward its cap and touches a file's last use at most once a minute; a camera reboot no longer lets a Search that was running re-fill the list; after a change of `camera.id` the new camera's cache folder is prepared.
- Admin UI, analysis modal: a Boxes / Plain still switch over the image (default Boxes). Plain still shows the still of the analysed second without the boxes; if retention has removed it, the modal says so instead of showing a broken image. The switch is a keyboard-operable radio pair and is hidden for an analysis with no still.
- Analytics: a key set during the retry wait (30 s after a failed call) is the one the retry call uses (issue #52).
- PoE switch (#90): a logout the switch did not answer is retried once on the same session; if it stays lost, a later busy login says it may be the proxy's own session and that it frees itself about 3 minutes after the last call (measured on the real switch: 150 to 181 s idle). A login the switch refused no longer replaces the session cookie. `docs/poe-switch.md` explains the stop's worst case (7.7 s) and the session handling.
- Audit log (#78): secret redaction matches explicit names (`keyframe` and `ftp.keyFile` are no longer redacted); segments of 32 or more characters in a refused path are masked (`:token`) in `auth-refused` records and the `unauthorized` log line; secret names also cover `passphrase`, `pwd`, `credential(s)` and any name ending in `key`; failed sign-ins stop at the 50 MB guard like refused tokens; a daily record that can't be written is retried with a backoff instead of every minute; a second `restart-proxy` request before the stop writes no second `proxy-restart` record. Docs: the `storage-daily` example adds up, `<pi>` is explained.

## v2026.10.02.3

- Recordings from the camera's SD card (spec 2026-10-02-baichuan-recordings-design): `GET /api/cameras/:cam/recordings?from=&to=&stream=` lists them (at most 48 hours; `id`, `start`, `end`, `stream`, `size`, `kinds`, and `clipId`, the FTP copy if there is one), `GET /api/cameras/:cam/recordings/days?month=YYYY-MM` the days with recordings, and `GET|HEAD /api/cameras/:cam/recordings/:id` serves one as MP4. The file is fetched over Reolink's Baichuan protocol (TCP 9000), not HTTP `cmd=Download`, which the RLC-1224A refuses since 2026-10-01; full resolution on demand, also for recordings FTP never delivered. It streams while it arrives and is kept in a cache. One download at a time per camera; parallel requests for one file share it, a viewer who stops reading is dropped after 5 s while the cache keeps filling, and a late joiner is served from the cache. `Range` comes from the cache (`Range: bytes=0-` on a file not yet cached, how a `<video>` opens, streams while it arrives as 200 with the whole file; a file that can't be cached, or several ranges, get the whole file with 200; a range past the end is 416 without a download); the `ETag` is the id and size (304, `If-Range`); `HEAD` never downloads. Errors: 400 `invalid`, 404 `unknown_recording`, 503 `camera_offline` (the poller says offline or no connection could be made), 502 `recordings_unavailable` with `reason` `refused`, `auth`, `timeout`, `protocol`, `offline` (lost mid-transfer) or `search_failed`; after the first byte the connection is cut. A camera reboot or power-cycle resets the Baichuan session. The Baichuan client is ported from reolink_aio (MIT, see THIRD_PARTY_NOTICES).
- Recordings settings: `camera.baichuanPort` (default 9000, applies at the next connection) and `recordings.cacheMB` (default 2048, 64 to 1,048,576, applies at the next fetch or storage run). The cache is a storage kind (`recordings`, in `/control/stats` disk usage and the disk metrics): never aged out, capped by `recordings.cacheMB` (so its writes don't count toward the days until the disk is full), and the first thing deleted when the storage budget is exceeded, least recently used first, never a file in use; below `storage.minFreeBytes` files are streamed without being kept. The daily storage audit record lists `recordings`; reading a recording writes no audit record.
- Recordings status: the Status page has a "Recordings (SD card)" card with the last download and the cache fill (amber for timeout and offline, red for auth, refused and protocol, grey for not found and before the first download); `/control/status` has `recordings` (the last download: `at`, `result`, `stream`, `bytes`, `ms`; and the cache's `bytes`, `files`, `capBytes`); metric `camproxy_recording_downloads_total{cam,stream,result}`; one `recording_download` info log line per download. A stopping proxy stops a running download (cmd 9) and closes the Baichuan session; a change of `camera.baichuanPort` closes it, so the next download connects to the new port.

## v2026.10.02.2

- FTP health: the camera masks the FTP user name in its answer (e.g. `ca**ra`); the check now compares the masked form, so no false 'elsewhere'. Names under 5 characters are compared literally.
- "Turn the camera's FTP off" (`camera-ftp-off`) wrote the camera's masked FTP user and password answer back into its FTP settings; it now writes the proxy's own FTP user and password when `CAMPROXY_FTP_PASSWORD` is set. Without it, the camera's own credentials are kept if unmasked; if the camera shows them masked it answers 409 `not_configured` and writes nothing. The masked-user match accepts any number of stars (only the 6-character case is measured; best effort). `scripts/camera-ftp-off.ts` works again and `scripts/` is now type-checked (`lint:types`). If you used it since the status check shipped, run "Point the camera's FTP here" again.

## v2026.10.02.1

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
