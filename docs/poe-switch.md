# Camera power-cycle through the PoE switch

When the camera's own API stops helping (a reboot doesn't clear a fault, or the
camera doesn't answer at all), the camera's power can be cut on its PoE
switch and turned on again (issue #85). It happens only for the camera's
port, and only while that port is powering something.

**Power-cycles go through cams-admin** (spec
2026-11-07-poe-switches-design). cams-admin holds each camera's power (switch
and port), checks that the camera is on that port, and runs the cycle on the
proxy that operates the switch (`switch.cycle`). The camera's own proxy keeps
its state: cams-admin tells it when the cycle starts (`camera.power.cycling`,
sent just before the cut; audited as "starting", since the switch may still
refuse it) and when the PoE is on again (`camera.power.cycled`), and it shows
"power-cycling", then "rebooting" until the camera answers, with the shared
2-minute cooldown. A failed cycle (`ok: false`) ends the watch ("not back"),
unless cams-admin adds `poeCut: true` (PoE was cut and is on again, the
camera is rebooting): then the watch goes on. The hello announces
`power-poe-cut` so cams-admin knows the proxy takes that flag.
cams-admin's survey (`switch.survey`, which port each camera is on) goes on
when the switch fails for one camera (busy, a timeout): that camera's result is
`{found: false, reason: "switch_error", detail}` (the error in words, at most
200 characters). It fails as a whole only when every camera failed, or for an
error of the whole switch (no or a wrong password, the switch forgotten).
The Maintenance page's "Power-cycle (through cams-admin)" asks cams-admin
(`POST /control/cameras/<id>/actions/camera-powercycle`: 202 `{requestId}`,
the signed event `camera.power.cycle.request` with `requestId` and `askedAt`, the ask time in ms, so cams-admin ignores a request asked over 5 minutes ago) and shows "Asked cams-admin…"
until its answer (`camera.power.cycle.result`). A request without an answer ends after 5 minutes (the result then says "no answer from cams-admin within 5 minutes"; a later answer still replaces it), and at once when the proxy is unenrolled or cams-admin is switched off. A request asked while the connection to cams-admin was down goes out after the reconnect only while it is still open; once its 5 minutes are over it is dropped (`admin_event_expired` in the log), so cams-admin never cuts the camera's PoE after the page gave up. Without cams-admin (not
connected, or it has not sent the camera's power yet) it is refused: 409
`power_cycle_needs_cams_admin`. A proxy never forces a cycle. `GET
/control/cameras/<id>/power` returns the camera's power as cams-admin sent it
(`camera.power.set`, kept in `<dataDir>/camera-power.json`, no secrets), the
open request and cams-admin's last answer. Camera settings shows it: "PoE:
Switch 2, port 3, verified 2 h ago", "Data only: power adapter", "Power
adapter" or "Unknown".

What follows describes the switch, the cycle itself (the same code runs for
cams-admin's `switch.cycle`), the recovery and the stop. The old switch
settings (`poeSwitch.*`, each camera's `poeSwitch.port`) and
`CAMPROXY_POE_SWITCH_PASSWORD` are retired: see [Retired
settings](#retired-settings).

## The switch

One protocol so far, `sscpoe-web`: the local web API of the STEAMEMO / SSCPOE
switches, which their own web UI uses. cam1's camera hangs on a **STEAMEMO
GPS-208** (8 PoE ports, port 8). The protocol comes from the switch's web UI and
from [slydiman/sscpoe](https://github.com/slydiman/sscpoe)
(`custom_components/sscpoe/protocol.py`, `coordinator.py`). It was measured on
the real switch on 2026-10-01:

```
POST http://<switch>/<callcmd>
{"data": {"callcmd": <N>, "calldata": {...}}}
```

| callcmd | What | The proxy uses |
|---|---|---|
| 123 | log in with `{"password"}` | the answer's `login: "success"` and the session cookie |
| 101 | port detail | `poec[]` (PoE on), `pw[]` (watts), `link[]`, `sn`, `V` (firmware), by internal index |
| 103 | set one port's PoE | `{"opcode": on<<9 \| index<<4 \| 2}`; the answer's `config: "ok"` |
| 126 | log out | always, also after an error |

- **Port numbers:** sscpoe's `reverse_order` rule decides the internal index
  from the switch's `sn`. GPS1xx, GPS2xx, GFS2xx, GPS4xx and GS1xx count their
  ports backwards, so the index is `ports - port`: the GPS-208's port 8 is
  index 0, and its opcodes are `0x002` (off) and `0x202` (on). Other models
  use `port - 1`. cams-admin's `switch.read` answers the ports by their
  number, before the first power-cycle.
- **One web session at a time:** while someone is logged in to the switch's
  web UI, the switch drops every other client's POST without an answer
  (measured: "Remote end closed connection without response"; an earlier
  unauthenticated POST from curl timed out instead). So the proxy never polls
  the switch, logs out after every use, and a login that is closed or not
  answered within 5 s is `switch_busy` ("busy or unreachable: is someone
  logged in to the switch's web UI?") until the browser logs out. A refused
  connection or no route to the switch is `switch_unreachable`.
- **The other protocols** (UDP multicast for older firmware, and a cloud API)
  are not used.

## One controller per switch

A proxy operates the switches cams-admin names by their id (`sw_…`; spec
2026-11-07-poe-switches-design). cams-admin sends the switch's descriptor
(model, address as seen from this proxy, port count, `offSeconds`) with each
switch command; the proxy keeps the descriptors, no secrets, in
`<dataDir>/switches.json`, so "Turn PoE on" works without cams-admin. One
controller per switch serves every port:

- **One session at a time, in arrival order.** The GPS-208 takes one web
  session, so a second request (a cycle, a read, PoE on) waits for the
  first; two ids on the same address share that queue. The address is
  compared as written (case-insensitive): the same switch named once by a
  DNS name and once by its IP gets two queues, and the switch then refuses
  one of two overlapping logins (`switch_busy`, nothing switched). Name a
  switch the same way everywhere. A request still
  waiting after `offSeconds` + 60 s fails with 409 `switch_busy` without
  touching the switch.
- **A forgotten switch** (`switch.forget`): a request still queued on it, or
  sent to its controller afterwards, fails `switch_unknown` ("the switch was
  forgotten"; 404 on the proxy's own routes), not "the proxy is stopping".
  The Proxy settings card says "password set for another address" when a
  password is stored for the switch's old address (`passwordElsewhere` in
  `GET /control/switches`).
- **One read serves every port for 10 s;** a cycle and PoE on always read
  afresh inside their own session.
- **State per port:** "PoE may be off" belongs to the port that was cut
  (`poeMaybeOff` in `GET /control/switches`). The 2-minute reboot/power-cycle
  cooldown stays per camera, on the camera's own proxy.
- **Stopping** turns on every port the proxy may have left off and writes one
  `camera-powercycle` record per switch that may be left dark.
- **A driver per model:** `src/camera/switch/driver.ts` defines the
  interface (log in, read the ports, set one port's PoE, log out, and whether
  the switch takes one session at a time); `sscpoe-web.ts` is the GPS-208's.
  A new model is a new driver registered there. Tests use
  `test/helpers/fake-switch.ts` or the GPS-208 mock, never a real switch.

**The password** of a switch is set on the proxy that operates it, never
through cams-admin: Proxy settings, PoE switches (`PUT
/control/switches/<id>/password`, local admin). It is kept in
`<dataDir>/admin/switch-passwords.json` (mode 600), bound to the switch's
address as this proxy knew it: when cams-admin names another address for the
id, the password is not sent there until it is set again. It is sent in the
switch's login only and never appears in a log line, an API answer, an error
message or an audit record; the page only says whether it is set.

Log out of the switch's web UI after using it: while a browser is logged in,
the proxy's requests are refused (`switch_busy`).

## Retired settings

Before switches came from cams-admin, the proxy had one switch in its own
config: host `poeSwitch.model`, `host`, `ports`, `offSeconds`, each camera's
`poeSwitch.port` (a legacy `camera.poeSwitch` on the Pi), and the password
`CAMPROXY_POE_SWITCH_PASSWORD` (or its `_FILE`). They are gone:

- A config.json or overrides.json that still has them **loads without
  them**, with one info line `legacy_poe_switch_dropped` naming the dropped
  paths (never a refusal to start); overrides.json is written without them
  on the next save. A settings change (`PUT /control/config`) that names
  them is refused as an unknown setting, and a cams-admin command as
  `not_remote_settable`, as before.
- `CAMPROXY_POE_SWITCH_PASSWORD` is not read; when it is set the proxy logs
  `legacy_poe_switch_password_ignored` once. Set the password per switch
  instead (above). `scripts/sync-secrets.sh` no longer sends it.
- `POST /control/actions/camera-poe-on` is gone ("Turn PoE on" is per switch
  port now), and so is `POST /control/actions/poe-switch-read` (404); a
  stored allow entry `camera.action:poe-switch-read` is dropped on start.
- `/control/status` no longer has `camera.poeSwitch`; the health summary's
  `camera.poeSwitch` is always `null`.

## What a power-cycle does

The cycle on the operating proxy (cams-admin's `switch.cycle`):

1. **Checks:** `password_unset` when no password is stored for the switch
   (or it was set for another address), and the port must be within the
   switch's port count. The camera's own proxy keeps the 120 s cooldown
   shared with the camera reboot.
2. Logs in to the switch (123). A dropped or unanswered login is 409
   `switch_busy`; a refused password is 502 `switch_auth`; a refused
   connection is 502 `switch_unreachable`.
3. Reads the ports (101) and refuses with 409 `no_power` unless the camera's
   port has PoE on **and** draws power. That is the safety check: it never
   cuts a port that isn't powering something.
4. PoE off (103). The camera's state becomes "power-cycling" and the proxy
   drops its camera token (the camera loses every session). A stop of the
   proxy before this point never cuts the port.
5. Waits `offSeconds`.
6. PoE on (103). A failed attempt is retried with backoff (1, 2, 4, 8, then
   every 10 s) for about 60 s. Each retry first tries PoE on with the session
   it has (it may still be valid). If that fails, it logs out, logs in again,
   checks whether the port is on already, and then turns PoE on. The session
   cookie is dropped only after the switch answered the logout, or replaced
   by a login that set a new one. The switch has one session: a session left
   open without its cookie would block every login, the switch's own web UI
   too.
7. Logs out (126), on every path.

**Once the PoE-off request is sent, every failure turns PoE on again.** The
switch may have applied the off and lost its answer (the connection dropped,
or no answer came), or something failed during the off time. An answer
without `config: "ok"` is checked: the proxy reads the port once, and if it
still has PoE on and draws power, the off was refused and nothing was cut (502
`switch_error`, no cooldown, no watch). Otherwise it is treated as cut. The proxy then runs step 6 at once and answers 502
`switch_error` with `poeOff: true` and `turnedOn`:

| `turnedOn` | Meaning | Then |
|---|---|---|
| `true` | PoE may have been cut, and it is on again | the camera may reboot; the state is "rebooting", the cooldown runs |
| `false` | the camera's PoE may be **OFF** | the port is listed in the switch's `poeMaybeOff` (Proxy settings, PoE switches); cams-admin's result says "PoE may still be OFF on … port N" |

**Recovery:** "Turn PoE on" for a port under Proxy settings, PoE switches
(`POST /control/switches/<id>/ports/<port>/poe-on`, local admin), or
cams-admin's `switch.poeOn`, logs in, reads the port and, if its PoE is off,
turns it on (with the same retries), then logs out. It skips the power check
(an unpowered port is the point) and the cooldown, waits its turn in the
switch's queue, and works without cams-admin. Answer: the reading plus
`wasOn`. Audited as `switch-port-poe-on`. It only ever turns PoE on, so it
doesn't ask first.

**A stopping proxy** (SIGTERM, a container stop, `restart-proxy`) during the
off time turns the PoE on at once. The retries end after 6 s, and every call
to the switch is cut short to fit what is left of the 8 s wait, with time
kept for the final logout. A call already in flight keeps its own 5 s
timeout, so the worst case is a call started just before the stop (up to
5 s) plus the shortened calls after it: about 7.7 s in all, still inside
the wait. The logout is retried once during normal operation, not while the
stop budget is spent. That stays within compose's 20 s
`stop_grace_period`. If PoE may still be off, or the logout went unanswered
(the switch's web UI may then refuse logins until the switch ends that
session), it logs an error and writes a `camera-powercycle` failure record
(`phase: stop`, `poeLeftOff`, `sessionMaybeOpen`, `switch: {id, host}`,
`portsLeftOff`). After the restart, use "Turn PoE on" under Proxy settings,
PoE switches, or the switch's web UI.

Each switch has one queue for all its work (one session at a time). A
controller that stops (the proxy stopping, or cams-admin forgetting the
switch) waits for its own session only: its requests still queued behind
other work on the same switch end at once, and the other work is not
reported as a session it may have left open.

The cycle's answer, `{offAt, onAt, watts}`, comes once PoE is back on, so
it takes `offSeconds` and a little more. Then the camera's state is
"rebooting" until it answers again, the same as after a camera-API reboot
(#83): ONVIF re-subscribes on its own, and stills and FTP carry on.
`/control/status` has `camera.reboot` (`kind: powercycle`, `phase`,
`offAt`, `downSec`).

Measured on the real switch (2026-10-01): with PoE off for 10 s, the camera
answered its API again 46 s after the cut.

The proxy never reads the switch on its own.

## Admin UI

- **Maintenance:** "Power-cycle (through cams-admin)", enabled while
  cams-admin is connected and has sent the camera's power (else a line says
  why). It asks first, in the same dialog as "Reboot camera": "Ask cams-admin
  to power-cycle the camera (PoE: Switch 2, port 3)? cams-admin first checks
  that the camera is on that port, then cuts its PoE for a few seconds. The
  camera is offline for about a minute." Then "Asked cams-admin…" until
  cams-admin cuts the PoE or answers, "Power-cycling…" while the PoE is off,
  "Rebooting…" until the camera answers, and how long it was away; a refusal
  or a failed cycle shows cams-admin's reason.
- **Status:** the camera's state shows "power-cycling", then "rebooting".
- **Camera settings:** a Power card with the camera's power from cams-admin
  (no settings).
- **Proxy settings, PoE switches:** the switches this proxy operates, whether
  each has its password, a port whose PoE may be off, and "Turn PoE on" per
  port.

## Audit

Through cams-admin, `camera-powercycle` records carry `via: cams-admin` and a
`phase`: `asked` (the Maintenance request, user `admin`, `requestId`),
`requested` (cams-admin cut the PoE, user `cams-admin`, `offAt`;
`duringReboot` when a reboot or power-cycle was already under way),
`cycled` (PoE on again), `failed` (host / end: the cycle failed, cams-admin's
message), `result` (cams-admin's answer to a request, `requestId`, `reason`),
then `back` or `not-back` as below. The switch side is the operator's
`switch-port-cycled` record.

Older versions (the proxy's own switch settings) wrote `camera-powercycle` (host / change, user `admin`) with `switch: {model, host,
port}`, `offSeconds`, `requestedBy` and, on success, `watts`, `offAt` and
`onAt`. Then a second record (host / end, user `system`) when the camera
answers again (`downSec`, from the cut), or a failure after 5 minutes. A
refusal from the switch (busy, no power, a wrong password) is a failure record
with the code. A failure after the PoE-off request says so: "PoE may have been
cut; turned back on: yes/no" (`poeOff: true`, `turnedOn`). A stopping proxy
that may leave PoE off writes `phase: stop`, `poeLeftOff: true`.
`camera-poe-on` (host / change; older versions) recorded "Turn camera PoE on";
the recovery is `switch-port-poe-on` now. Details in [audit-log.md](audit-log.md). The cooldown and the
"rebooting" watch are in memory: a proxy restart resets them.

## Tests

The tests never contact the real switch. `test/helpers/poe-switch-mock.ts`
speaks the switch's web protocol: the login cookie, 101, 103 with the opcode,
126, a wrong password, and the busy session (a POST without the session while
another one is active is dropped with no answer). Fault modes cover the cases
that matter: the PoE-off applied with its answer dropped, never sent, or
without `config: "ok"`; refused PoE-on calls; an expired session; a switch
that answers nothing (hang); slow answers. `POST /mock/poe` is a test hook
that sets a port's PoE, as the switch's web UI would. The e2e harness starts it on
port 18601 and wires PoE on the camera's port to cam-sim's power-off and
power-on, so the simulated camera really goes away.

**Session hygiene.** A logout the switch did not answer is retried once,
on the same session (the cookie is kept). If that fails too, the proxy logs
`poe_switch_logout_failed_session_may_be_open`, and a later login refused or
dropped as busy says it may be the proxy's own session. A login the switch
refused never replaces the session cookie. Measured on the real switch (#90
item 4): a session nobody logs out of locks the switch for 150 to 181 s of idle
time (about 3 minutes after the last call), then it frees itself and the old
cookie is dropped. A login that carries the open session's cookie succeeds and
keeps the same cookie. So the busy message adds that a possibly-own session
frees itself about 3 minutes after the last call.
