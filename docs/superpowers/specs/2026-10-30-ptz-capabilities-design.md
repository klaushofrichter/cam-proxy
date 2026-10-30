# Camera capabilities and PTZ — design

Date: 2026-10-30. Repos: cam-proxy (owner of this spec), cam-sim, cams;
cams-admin for the move part only (§7).
Status: draft for Klaus's review.

## 1. Intent

The first pan/tilt/zoom camera, a Reolink **E1 Outdoor Pro**, joined the
home network and runs on the Pi's proxy as camera `e1`. Klaus wants to steer
it from the cams Video page and keep a short list of named positions to jump
back to.

Klaus's principle: **cam-proxy abstracts the camera maker.** cams speaks the
proxy's own API in our own terms; the proxy translates to Reolink commands.
Different camera models offer different features, so the proxy tells cams,
per camera, what that camera can do (**capabilities**), and cams shows only
that.

This spec does PTZ first. Moving all of cams's remaining direct camera calls
(settings, light, snapshot fallback, reboot, recordings fallback) behind the
proxy is a later, separate design (§9).

## 2. Goals, non-goals, anti-goals

Goals:

- A per-camera **capabilities** object from the proxy, starting with PTZ,
  shaped so later features (light, settings sections, …) can be added.
- A maker-neutral **PTZ API** on the proxy: relative moves, zoom, focus,
  and up to **20 saved positions** per camera, one of them **Home**.
- Positions are stored on the proxy; any user can save, rename, sort, delete,
  go to and set Home (cams has no roles).
- A cam-sim **E1 Outdoor Pro profile**, so the whole chain can be developed
  and tested with different camera models side by side.
- A PTZ panel in cams on the Video page while live video is shown.
- Test suites against the simulator (CI) and the real E1 (by hand, on the Pi
  or the MacBook).
- **Move cleanup** (Klaus, 2026-10-30): after a camera moves away, the
  proxy it left keeps no credentials or configuration for it, as far as it can
  remove them; what it can't remove is reported (§7).

Non-goals (this round):

- Absolute coordinates or click-to-position (the E1 can't report its
  pan/tilt; it has no 3D location).
- Patrols, guard/auto-return to Home, AI auto-tracking, preset images,
  calibration. The camera has them; they can become capabilities later.
- Moving cams's other direct camera calls behind the proxy (§9).
- PTZ in the MCP server, the landing page or llms.txt (follow-up once
  released).
- A second simulator instance in the cluster (needs kube-setup; optional
  follow-up).

Anti-goals (would make this a failure even if it works):

- Reolink terms (`PtzCtrl`, preset slot ids, `op` names) leaking into the
  proxy's client API or into cams.
- A camera that keeps turning because a browser tab closed mid-move.
- Positions that silently point somewhere else (a camera reset or replaced
  under the same id) — missing presets are shown, never guessed.
- Overwriting presets someone saved on the camera with the Reolink app.
- PTZ buttons on a camera that can't move.

## 3. Facts measured on the E1 (2026-10-30, read-only probe)

Firmware v3.1.0.5714. From `GetAbility` (channel 0): `ptzCtrl`, `ptzPreset`,
`ptzPatrol`, `ptzTattern` permit 7; `supportPtzSpeed`, `supportZoom`,
`supportFocus`, `supportPtzCheck` set; `supportPtz3DLocation` and
`supportDigitalZoom` 0; `ptzType` 0. `GetPtzPreset`: 64 slots, ids 1–64,
names up to 31 characters, none enabled. `GetZoomFocus`: zoom 0–27, focus
0–97. `GetPtzGuard` present (timeout 60 s). `GetPtzCurPos`: "not exist".
RLC-1224A and CX820 (our other models): `ptzCtrl`/`ptzPreset` permit 0.

**Measured 2026-10-30** (Klaus's OK; captures sanitized for cam-sim):

- `PtzCtrl` (action 0, `{channel: 0, op, speed}`): ops `Left`, `Right`,
  `Up`, `Down`, `LeftUp`, `LeftDown`, `RightUp`, `RightDown`, `Stop`,
  `ZoomInc`, `ZoomDec`, `FocusInc`, `FocusDec`, `ToPos` (with `id`) answer
  `{rspCode: 200}`. **Speed 1–64**; 0 or above 64 → error `rspCode -4`
  "param error"; `speed` may be left out. An unknown op → `-4`.
- `ZoomInc` for 1.5 s took zoom 7 → 26 (of 0–27); `GetZoomFocus` follows.
  Absolute zoom: `StartZoomFocus {ZoomFocus: {channel, op: "ZoomPos", pos}}`.
- **Preset slots are ids 0–63**, although `GetPtzPreset`'s `range` says
  1–64; id 64 → `-4`. `SetPtzPreset {PtzPreset: {channel, enable: 1, id,
  name}}` saves the current position **including zoom**; delete with
  `enable: 0, name: ""`.
- A name longer than 31 characters is accepted but stored as the camera's
  default `pos<id+1>`: the proxy cuts names to 31 before sending.
- `ToPos` to an empty slot answers 200 without moving: the proxy checks the
  slot (`missing`) before going.
- How long a move runs without `Stop` was not measured; the lease (§5.1)
  makes it irrelevant.

## 4. Capabilities (cam-proxy)

`GET /api/cameras` and `GET /api/cameras/:cam` gain `capabilities` per
camera:

```json
"capabilities": {
  "schema": 1,
  "ptz": { "move": true, "zoom": true, "focus": true, "speed": true, "positions": { "max": 20 } }
}
```

- `ptz` is `null` for a camera without pan/tilt control. `zoom`, `focus`,
  `speed` follow the camera's abilities; `positions` is present when the camera
  can store presets.
- `capabilities` is `null` while the camera has never been read (offline since
  start). cams treats `null` as "nothing extra".
- The proxy reads `GetAbility` after each successful login and when the
  firmware or model in `GetDevInfo` changes, and keeps the derived object in
  memory. A change sends the existing `camera` SSE message so cams refreshes.
- The derivation lives in one module (e.g. `src/camera/capabilities.ts`):
  Reolink ability → our object. Tests use the captured abilities of the three
  models (sanitized: no serials, addresses or ids in the public repos).
- The proxy-wide `features` list gains `ptz` so cams knows the proxy speaks
  this API at all.

## 5. PTZ API (cam-proxy, client tokens)

All under `/api/cameras/:cam/ptz`, client or admin access (cams uses its
client token). A camera without the capability answers 404
`{"error":"not_supported"}`; offline 503 `camera_offline`; a camera refusal
502 `camera_error`.

### 5.1 Moving

- `POST …/ptz/move` `{ "direction": "left|right|up|down|left-up|left-down|right-up|right-down", "speed": 1–10 (default 5), "durationMs": 100–2000 (default 400) }`.
  The proxy starts the move and sends `Stop` after `durationMs` **unless
  another move for that camera arrives first**, which replaces it (new
  direction/speed, timer restarted). A tap is one call; press-and-hold is a
  call every ~250 ms with `durationMs` 600 while the button is held, then
  `stop`. A lost tab therefore stops the camera within 2 s at most.
- `POST …/ptz/zoom` `{ "direction": "in|out", "durationMs" }` and
  `POST …/ptz/focus` `{ "direction": "near|far", "durationMs" }` (focus only
  with `ptz.focus`): same lease rule.
- `POST …/ptz/stop`: stops at once.
- 204 on success. Speed 1–10 maps linearly onto the camera's measured range
  (my call; §3 measures it).
- Moves are not audited (too chatty); position changes are (§5.3).
- One move lease per camera; the last caller wins (no roles, no locking).

### 5.2 Positions

A position: `{ "id": "pos_…", "name": "Gate", "order": 0, "home": true, "state": "ok|missing" }`.

- `GET …/ptz/positions` → `{ "max": 20, "positions": [...] }` sorted by
  `order`.
- `POST …/ptz/positions` `{ "name" }` → saves **where the camera points
  now** as a new position; 201 with it. 409 `limit_reached` at 20; 409
  `no_free_slot` when the camera has no slot the proxy may use (§6). The first
  position of a camera becomes Home.
- `PATCH …/ptz/positions/:id` `{ "name"?, "home": true? }` — rename; `home:
  true` moves the Home mark here (exactly one Home while any position exists;
  `home: false` is refused 400).
- `PUT …/ptz/positions/order` `{ "ids": [...] }` — the full new order (all
  ids, each once; else 400).
- `POST …/ptz/positions/:id/save` — overwrite this position with where the
  camera points now (also the fix for a `missing` one).
- `POST …/ptz/positions/:id/go` — move there; 409 `position_missing` when its
  preset is gone from the camera.
- `DELETE …/ptz/positions/:id` — 409 `home_position` for Home while others
  exist (set another Home first); deleting the last position is allowed.
- Names: 1–40 characters, trimmed, unique per camera (case-insensitive) — my
  call; the camera copy is cut to its 31.
- Each change sends a new SSE type `ptz-positions` `{cam}` so other viewers
  reload the list; and is audited (`ptz-position` with `details.op` save,
  resave, rename, home, order, delete).

## 6. Mapping to the camera (cam-proxy, Reolink)

- Moves → `PtzCtrl` with the direction's op and speed, `Stop` on lease end;
  zoom/focus → the zoom/focus ops. Exact names from §3's measurement.
- Positions → camera **preset slots**. The proxy stores
  `{cam, id, name, order, home, slot, createdAt, updatedAt}` in a new catalog
  table `ptz_positions` (migration 10). Save: pick the lowest slot that is
  **not enabled on the camera and not used by another position**, then
  `SetPtzPreset {enable: 1, id: slot, name}` (whole preset object), re-read
  `GetPtzPreset` and confirm the slot is enabled with that name, else 502 and
  nothing stored. Slots already enabled on the camera that the proxy didn't
  create are never touched (someone's Reolink-app presets).
- Go → `PtzCtrl op ToPos id slot`. Delete → `SetPtzPreset {enable: 0}` on the
  slot, re-read, then delete the row (a slot already gone on the camera still
  deletes the row).
- `state: missing`: on each login and on `GET positions` (camera read cached
  ≤ 30 s), a position whose slot is not enabled on the camera is `missing`.
  Nothing is re-created automatically.
- **Replaced or reset camera** (my call): each row stores the camera's serial
  (from `GetDevInfo`) at save time. When the camera under that id reports a
  different serial, all its positions are `missing` regardless of the slots,
  until saved again (a re-save writes the new serial). A factory reset keeps
  the serial; the slots are then empty and the rows `missing` by the rule
  above. The serial is stored but never returned by the client API.
- **Lost catalog** (my call): presets the proxy made but no longer knows
  about look foreign and stay untouched. With 64 slots and 20 positions that
  leak is accepted; preset names on the camera stay the plain position names
  (no tag).
- Logging out after writes follows the existing client session handling.

## 7. Moves and move cleanup

- **Positions travel with the camera.** The presets live on the camera, so a
  move to another proxy carries the camera's `ptz_positions` rows (new
  content kind `ptz` in `src/moves/types.ts`; small, always all of it). cams-admin's contract lists the
  content kinds, so it needs the new kind too.
  - Mechanism (my call): one JSON file of the rows (without the serial; the
    target re-reads it) through the existing file copier, so no new message
    type. On the target it **replaces** any rows that camera id has there (a
    camera coming back gets its current positions).
  - Version skew (my call): the source sends `ptz` only when the target lists
    it among the kinds it accepts (the target's capabilities exchange in the
    move evaluation); otherwise the move proceeds without positions and the
    move report says so. The presets stay on the camera, so nothing is lost
    for good. Hosts are updated before planned moves anyway.
  - **cams-admin is in scope** for this part only: the contract's content
    kinds gain `ptz`, and its diag shows `moveLeftovers`.
- **Cleanup on the proxy the camera left** (extends `MoveSource.finish()`):
  - already today: content purged (except the keep list), overrides camera
    node removed, stored password deleted, trust/leaf and manifests dropped;
  - new: its `ptz_positions` rows deleted; a `CAMPROXY_CAMERA_PASSWORD_<ID>`
    line removed from the env file **when the proxy manages that file**
    (`CAMPROXY_ENV_FILE`, as on the Pi), audited `move-cleanup`;
  - what the proxy can't remove itself (an entry in `config.json`, which it
    never writes; a password in compose's environment or a `_FILE` secret) is
    listed in `GET /control/status` as `moveLeftovers: [{camera, moveId,
    items: ["config.json entry", "env CAMPROXY_CAMERA_PASSWORD_CAM4_FILE"]}]`
    and shown in cam-proxy's own admin UI with what to do; cams-admin's diag
    shows it too.
  - The camera itself keeps its presets; the target proxy adopts them.

## 8. Simulator, cams, tests

### 8.1 cam-sim: E1 Outdoor Pro profile

- `CAMSIM_MODEL=e1-outdoor-pro` (next to `rlc-1224a`, `cx820`):
  `src/profile/e1-outdoor-pro.ts` + `e1-ability.json` from the captured
  ability (sanitized), devInfo with a fake serial.
- New handlers (PTZ models only; fixed models keep answering as today):
  `PtzCtrl` (moves change a virtual pan/tilt state over time at the given
  speed until `Stop`, as measured), `ToPos`, `GetPtzPreset`/`SetPtzPreset`
  (64 slots, storing the virtual position), `GetZoomFocus`, `GetPtzGuard`,
  `GetPtzCheckState`, answers for unsupported ones copied from the real E1.
- The simulated picture shows the virtual position: at least a `drawtext`
  overlay "PAN x TILT y ZOOM z"; a crop window moving over a larger frame is
  the builder's choice.
- Control API: `GET /sim/api/ptz` (virtual state and presets) for tests;
  `POST /sim/api/reset` clears it.
- Everything else about the E1 (stream sizes, AI kinds, SD card) follows the
  probe in §3 where cam-sim already models it.

### 8.2 cams

- Server: routes `/api/cameras/:id/ptz/*` passing through to the proxy
  (`ProxyClient`, `proxyPath`), viewer access for every member;
  `capabilities` passed on in the camera list. `test/proxy/fakeProxy.ts`
  learns capabilities, PTZ moves and positions.
- Web: a new `PtzPanel.svelte` in the Video page's right sidebar
  (`Video.svelte` `<aside class="side">`), directly above the events list with
  the Event Filter, **only while live video is shown and the camera has
  `ptz`**. Collapsible, **collapsed by default**; open/closed remembered per
  browser (my call).
  - Direction pad (8 directions, tap = step, hold = move), zoom −/+, focus
    −/+ when supported.
  - Positions list: 5 rows visible, more by scrolling (max 20). Click = go.
    Home marked (star); "Make Home" per row. Drag to sort, plus up/down
    buttons for keyboard use. Rename inline. Delete inline with a confirm row
    (no browser dialogs).
  - "Save position": inline name field (default "Position N"); disabled at
    20 with a note. A `missing` row shows "Not on the camera — save again".
  - Soft transitions only (no flicker).
- e2e: panel hidden for a fixed camera, shown for a PTZ camera, hold-to-move
  sends repeated moves then stop, save/sort/Home/delete flows.

### 8.3 Tests

- cam-proxy: unit tests for the capability derivation (three captured
  models), the move lease (timer, replace, stop), slot allocation (skips
  foreign presets), missing detection; integration tests against the
  in-process cam-sim with the E1 profile; openapi and audit-action tests
  updated.
- cam-sim: conformance tests for the PTZ commands against the captured E1
  answers.
- Livestack: `start-sim-stack.sh` gets a model option so the chain runs with
  an E1 sim; `check-stack.sh` adds PTZ checks.
- **Real E1** (Klaus asked for it, 2026-10-30): first the §3 measurement
  (a read/measure script, results into cam-sim's reference captures and
  cams `docs/reolink-api.md`), then a scripted suite through the Pi's proxy
  (or a proxy on the MacBook): move each direction briefly, zoom, save a test
  position, move away, go back, rename, delete, confirm the slot is free
  again. It uses only slots it created and leaves the camera as it found it
  (the camera does move during the run).

## 9. Later: the wider abstraction

After PTZ ships: a separate design to move cams's direct camera calls
(settings, light, snapshot, reboot, recordings fallback) behind the proxy,
listing each as a capability, so cams no longer needs camera logins at all.

## 10. Rollout

cam-sim (profile) → cam-proxy (capabilities, PTZ, move cleanup) → cams
(panel). The cams-admin contract change (content kind `ptz`, leftovers in
diag) ships with cam-proxy's move part. Then update the three hosts; the Pi
runs `e1`. Each release posted to #cams-application.

## 11. Left to the builder

Module layout, the lease timer implementation, UI details within the above
(icons, exact spacing), the sim's picture effect beyond the overlay, test
names.
