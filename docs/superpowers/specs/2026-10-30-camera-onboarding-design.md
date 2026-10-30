# Automated camera onboarding — design

Date: 2026-10-30. Repos: cam-proxy (owner of this spec), cams-admin, cams,
cam-sim (test support). Status: decided (Klaus, 2026-10-30: "go with your recommendations on all four", §10); being implemented.

## 1. Intent

Adding the E1 Outdoor Pro (2026-10-30) took a dozen hand steps across three
apps: hand-edited proxy files, a password typed into a `.env` file and again
into each cams viewer, a camera the viewers refused because nothing vouched
for its certificate, a form in cams-admin, and a Confirm click per viewer.

Klaus (2026-10-30):

- Onboarding a new camera must be fully automatable, with an API for every
  step **and for checking every step**.
- People handle only the camera's **initial admin password** and **root
  passwords**; nobody moves tokens or passwords between systems. A
  confirmation dialog is fine.
- Every setup call leaves an **audit trace**.
- The proxy abstracts the camera maker; cams talks to the proxy (the "wider
  abstraction" planned after PTZ).

The inventory behind this spec: every step, its API, auth, audit and
verification, with file references, was taken on 2026-10-30 (cam-proxy
bcdccf3, cams-admin 32de987, cams 1a2947e).

## 2. Goals, non-goals, anti-goals

Goals:

- A camera goes from "on the LAN with its admin password" to "fully working
  in every cams viewer" through APIs only, the password entered once.
- One **onboarding status** per camera that a script (and a person) can read
  to see which steps are done, which are missing, and why.
- cams viewers hold **no camera passwords and no camera certificates**: every
  camera call goes through the camera's proxy.
- Every write step audited (who, what, outcome; never secrets).
- Offboarding (a camera removed) is the same: API-driven, checked, audited,
  leaving no credentials behind.

Non-goals (this round):

- A least-privilege camera user (the proxy keeps using the camera's admin
  account), stream/encoding changes, cloud/push settings.
- Camera discovery from cams-admin over the command channel (discovery stays
  a local proxy action: it probes the LAN).
- Auto-onboarding without any human step: the password is the human step.
- The autofocus toggle (cam-proxy #288) and other PTZ follow-ups.

Anti-goals:

- A camera password in cams-admin, in a cams viewer, in a log, an audit
  record, a URL, or an API answer.
- A changed camera address that silently sends the stored password to another
  host (today's reason why `cameras.*.host` is never remote-settable stays).
- A certificate trusted without a person or a CA vouching for it.
- Breaking today's setups during the switch: older viewers and proxies keep
  working until updated.

## 3. The onboarding flow (target)

```
1 discover   proxy: find-camera (local)                → candidates
2 probe      proxy: probe {host, password}             → model, abilities, ports, cert fingerprint
3 add        proxy: add camera {id, host, …}           → camera configured (password stored, cert pinned)
             (2+3 may be one call: "onboard")
4 register   cams-admin: adopt (ops:onboard, or auto)  → camera in the account
5 viewers    cams: apply config (no confirm needed for cameras any more)
6 extras     proxy: FTP setup, NTP/time zone, PoE port, name (each optional)
7 verify     proxy + cams-admin: onboarding status      → all green
```

The password appears exactly once, in step 2/3, typed by the owner into a
confirmation dialog (proxy admin UI or cams Settings) or given to a script on
stdin by the owner. It goes to the proxy only.

## 4. cam-proxy (A)

### 4.1 Camera password API

- `PUT /control/cameras/:cam/password` `{password}` (admin; write-only):
  the proxy logs in to the camera with it first; only a successful login
  stores it in `admin/camera-passwords.json` (mode 600) and applies it without
  a restart; else 422 `camera_refused` (or 503 `camera_offline`), nothing
  stored. Audited `camera-password` `{camera, outcome}` — never the value.
- `GET /control/cameras/:cam` (and `/api/cameras/:cam` for clients) gains
  `credentials: {source: env|store|none, authOk: bool|null, checkedAt}`.
- An environment password still wins over the store (today's rule) and is
  reported as `source: env`. Saving through this API removes that camera's
  `CAMPROXY_CAMERA_PASSWORD_<ID>` line from the env file when the proxy manages
  it (as the move cleanup does), so the store is the one source; an env value
  the proxy can't remove (compose, `_FILE`) is reported and the save answers
  409 `env_password` (remove it first). The store is `data/admin/camera-
  passwords.json`; a camera move already carries it, sealed.
- The admin UI gets a "Camera password" dialog (password field + confirm
  line: "Save the login for <name> (<host>) on this proxy?").
- Rate limit: 5 attempts per camera per 10 minutes (a wrong password must not
  lock the camera's account).

### 4.2 Probe before adding

- `POST /control/actions/camera-probe` `{host, protocol?, user?, password}`
  (admin, local only, like find-camera): ports 80/443/554/8000/9000 reachable,
  TLS certificate fingerprint and subject, then with the password:
  `GetDevInfo` (model, firmware, name) and `GetAbility` → our capabilities
  object (§4 of the PTZ spec), then Logout. Nothing stored; the password is
  dropped after the call. Audited `camera-probe` `{host, outcome, model}`.
- Read-only on the camera (Get* only).

### 4.3 Adding a camera (also on a single-camera proxy)

- `POST /control/cameras` `{id, name?, host, protocol?, user?, password,
  trust: {fingerprint}}` (**local admin only**: the proxy's own admin token or
  admin UI session; never managed tokens, never remote — §10.1):
  probes (§4.2), checks the profile's camera limit (**refused** 409
  `camera_limit` at the limit; today only a warning), stores the password
  (§4.1), pins the certificate (§4.4) when the fingerprint matches what the
  camera serves, adds the camera; the limit refuses only an addition beyond
  it — a proxy already over its profile keeps running with today's warning; (as `PUT /control/config` does today, kept in
  overrides, no restart), and returns the camera's onboarding status (§4.5).
  Audited `camera-add`.
- A **single-camera proxy** (config.json `camera` + `CAMERA_HOST`, the Pi)
  takes the same call: the new camera replaces the configured one only when
  that one is `moved` or absent, else 409 `camera_limit`. `CAMERA_HOST` is
  written with it (the existing env-file writer), so "Find camera → Use this
  camera" keeps working. No hand edit of config.json.
- `DELETE /control/cameras/:id` (offboard, admin): stops the camera, removes
  its password (store and a managed env line, as the move cleanup does), its
  TLS leaf/pin state, its PTZ rows, turns the camera's FTP upload off when it
  pointed here, and lists what it could not remove (`moveLeftovers`'s
  sibling `removeLeftovers`). Files follow retention. Audited `camera-remove`.

### 4.4 Certificate trust without a site CA

- `POST /control/cameras/:cam/actions/camera-trust-pin`
  `{fingerprint}` (admin): pins the certificate the camera serves now, only
  if it matches the given fingerprint (the one the dialog showed), mode
  `pinned`; `GET /api/cameras` reports it as today, so cams (while it still
  calls cameras) pins it too. Audited `camera-trust` `{op: pin, fingerprint}`.
- A pinned camera that later serves another certificate is refused until an
  admin pins again (same rule as site-CA cameras). The proxy itself stops
  talking unverified to a pinned camera (today it logs "not verified").
- Admin UI: "Trust this camera's certificate" with the fingerprint and a
  confirm.

### 4.5 Onboarding status

- `GET /control/cameras/:cam/onboarding` (admin) and per camera in
  `GET /control/onboarding`: one object with a step list —
  `reachable`, `login` (credentials.authOk), `trust` (mode, problem; ok for
  `site-ca`, `pinned`, `public`; **`none` is not ok** and shows "certificate
  not trusted" with the trust action — nothing is pinned automatically, also
  not on upgrade),
  `capabilities` (read), `stream` (up), `events` (subscribed), `ftp`
  (`camera.state`, last upload, or `off` by choice), `time` (clock offset,
  zone), `name`, `poe` (port set or `none`), `profile` (within limit) — each
  `{ok: true|false|null, detail}`; `ready: true` when every required step is
  ok. Required: reachable, login, trust, capabilities, stream, events.
- The heartbeat to cams-admin carries a compact form (`onboarding: {<cam>:
  {ready, missing: [step…]}}`).

### 4.6 Remote orchestration (cams-admin → proxy)

- New command kinds, each **off by default** and switched on per proxy in its
  policy (like the disruptive ones today), audited on both sides:
  `camera.onboarding.get` (read, allowed by default), `camera.ftp.setup`
  (exists as an action), `camera.time.set` (§4.7). Certificate pinning is
  **not** a cams-admin command: it is done in the proxy's admin page or from
  cams with the proxy-admin token cams holds (§10.2).
- **Not** remote: adding a camera, setting a host, setting a password,
  discovery, probe. These carry the password or decide where it goes; they
  stay local to the proxy (its admin UI or a script with the proxy's admin
  token on that host) or come from cams through the proxy's own API (§6.2).

### 4.7 Time

- Read: the camera's time, zone and DST in the onboarding status (`GetTime`).
- Write: `camera-time-set` action: zone from the setting `time.zone`
  (default: the host's zone; refused when neither is known),
  DST rules, NTP via the existing `camera-ntp-set`. Whole-object Set, re-read,
  audited.

### 4.8 Camera calls behind the proxy (for §6)

New routes (maker-neutral shapes; capabilities say which a camera has),
replacing cams's direct calls. **Reads** (status, snapshot, live, settings
GET) take client tokens; **camera-changing calls** (settings PUT, light,
reboot, password, trust pin) need an admin-kind token — the proxy-admin token
cams already holds per proxy (cams-admin-issued, `managed-admin`, added to
`MANAGED_ALLOWED` for exactly these routes). Client tokens stay read-only:

- `GET /api/cameras/:cam/status` — online, model, firmware, name, stream
  details (codec, size, fps per stream), SD card, clock offset. (Partly
  exists in `GET /api/cameras/:cam`.)
- `GET /api/cameras/:cam/snapshot.jpg` — an on-demand snapshot (main or sub).
- Live video: the proxy's go2rtc (already running for stills) serves the
  camera's live streams to clients as **MSE over a WebSocket on the proxy's
  existing HTTPS address** (`/api/cameras/:cam/live`), client-token auth; no
  new ports, no WebRTC/UDP (§10.3). Sub stream by default, main on demand.
- `GET/PUT /api/cameras/:cam/settings/:section` — the sections cams edits
  today (encoding, image, on-screen text, recording, motion/AI detection,
  IR, white light), moved from cams's `server/reolink/settings.ts` into the
  proxy as its model; whole-object Sets, re-read after writing, audited
  `camera-settings`.
- `PUT /api/cameras/:cam/light` — light on/off/auto (audited).
- `POST /api/cameras/:cam/reboot` — the existing reboot action for clients
  (audited).
- Recordings: cams's Search/Download fallbacks go to the proxy's recordings
  API (Baichuan VOD) only.
- Time for compositions: the camera's time and zone from `status`.

## 5. cams-admin (B)

- Ops scopes for what is session-only today and needed for automation:
  `actions` (camera actions, rename, restart), `config` (config preview/apply
  of allowed settings), `offboard` (camera delete). Each audited with the ops
  token's label. **Enrollment stays a signed-in step** (a new proxy joining an
  account is a root action; §10.4).
- **Auto-adopt** (per account, off by default): a camera a proxy reports
  that the registry lacks, whose onboarding status is `ready`, is adopted
  (host from the proxy, model from the report), audited `camera-adopt` with
  actor `system:auto-adopt`.
- Site-CA pins taken from the enrolled proxy's report (no hand copy of
  `/tls/ca.pem`), still shown in the proxy page; a change is held for a
  confirm as today.
- `GET /api/v1/diag/cameras/:camsId/onboarding` (diag) and the camera page:
  one view of proxy status (§4.5), registry row, and each viewer's state for
  that camera (from the viewers' reports: applied, held, problems).
- Command kinds of §4.6 in the camera page ("Set time", "FTP setup"), and in
  the ops API under `actions`. They stop at each proxy's local allow-list
  (disruptive kinds are off by default per proxy); the onboarding script does
  not assume them.

## 6. cams (C)

### 6.1 Through the proxy

- Every route in today's direct-call list uses the proxy's API (§4.8) for a
  camera with a proxy: status, snapshot, live, settings, light, reboot,
  device, name, recordings fallback, time. `server/reolink/*` remains only for
  cameras without a proxy (none in the cluster; kept for the local
  livestack and the cams-only setup), and is removed from the code paths of
  proxied cameras.
- A camera whose proxy is down shows offline (no direct fallback: it would
  need a password in the viewer — decided 2026-10-30).
- Camera trust in viewers (pins, held camera connection data, Confirm per
  viewer) is no longer needed for proxied cameras: viewers trust **proxies**
  (site-CA pins of the proxy, held proxy changes as today), not cameras.

### 6.2 Camera login dialog

- Settings → Camera login (and a "Enter password" button in the offline box
  when the proxy reports `credentials.authOk: false` or `source: none`):
  a dialog "Save the login for <camera> on proxy <proxy>?" with the password
  field. cams sends it straight to the proxy's `PUT /control/cameras/:cam/
  password` with its proxy-admin token (§10.1; if it has none the dialog says
  to use the proxy's admin page).
- Likewise "Trust this camera's certificate" (offline box and Settings, when
  the proxy reports trust `none` or a changed certificate): the dialog shows
  the fingerprint **the proxy measured** (from the proxy's status, never
  typed or copied) and pins it with the proxy-admin token (§10.2).
  cams keeps no copy; the existing local credentials file and the cluster's
  credentials Secret are emptied of cameras that have a proxy, and the cluster
  Secret is retired through kube-setup.
- The proxy's answer (refused, offline, saved) shows in the dialog.
- Audited by the proxy; cams logs `camera_password_relayed` (no value).

## 7. Verification and the onboarding script (D)

- `scripts/onboard-camera.sh` in cam-proxy (runs on the proxy host or with
  the proxy's URL + admin token from a file): find → probe (shows model,
  abilities and the certificate fingerprint) → asks the owner to confirm the
  fingerprint and type the camera password (stdin, not echoed) → add →
  optional extras (FTP, time, name) → waits for cams-admin to list the camera
  (adopt with an ops token having `onboard` if auto-adopt is off) → polls the
  onboarding status in the proxy and cams-admin until `ready` everywhere →
  prints one line per step (ok/FAIL). Never prints tokens or the password.
- `scripts/offboard-camera.sh`: the reverse, checked the same way.
- Tests: every API against cam-sim (all three models) in CI; the scripts end
  to end in the livestack; the real E1 (Klaus's OK) re-onboarded with the
  script as the acceptance test.

## 8. Rollout

1. cam-sim: whatever the probe/trust/settings/live tests need (e.g. serving a
   self-signed certificate, `SetTime`).
2. cam-proxy A (§4.1–4.7) — usable at once: the E1 gets its password via the
   API and its certificate pinned, and cams viewers stop refusing it.
3. cams-admin B.
4. cam-proxy §4.8, then cams C (cams through the proxy, password dialog),
   then retire the viewers' camera credentials (local files, cluster Secret
   via kube-setup).
5. D: scripts, docs (cams-admin `docs/onboarding-a-camera.md`, the Obsidian
   note), re-onboard the E1.

Each step a release, posted to #cams-application. Older cams keep working
against a newer proxy (new routes only add). cams switches **per proxy**: a
camera whose proxy lists the new features goes through the proxy only (no
direct fallback, §6.1); a camera whose proxy is older keeps today's direct
calls. A viewer's stored camera password is removed only for cameras whose
proxy has the features. `server/reolink/*` stays for cameras without a proxy
(the local livestack, cams-only setups).

## 9. Left to the builder

Module layout, the live transport (whatever go2rtc serves that cams's player
takes, with the least latency), the settings section shapes (keep cams's
current model where it is maker-neutral), UI wording within the above, test
names.

## 10. Decisions (Klaus, 2026-10-30)

1. **Password via cams:** cams-admin-issued proxy-admin tokens (`managed-admin`,
   held by cams) may **set** a camera password — write-only, saved only after
   the camera accepts the login, never readable. Worst case is a wrong password
   (camera offline), never a leaked password or a changed address. Adding and
   removing cameras and changing a camera's host stay local to the proxy.
2. **Certificate trust:** confirmed in the proxy's admin page **or** from cams
   (proxy-admin token) in a dialog showing the fingerprint the proxy measured
   on the LAN. Not a cams-admin command.
3. **Live video:** MSE over WebSocket on the proxy's existing HTTPS address, no
   new ports, no WebRTC/UDP; sub stream by default, main on demand. Cleared
   with kube-setup before the cluster path is used.
4. **Ops scopes:** `offboard` yes; `enroll` no (stays signed-in).
