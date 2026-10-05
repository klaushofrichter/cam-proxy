# Camera power-cycle through the PoE switch

When the camera's own API stops helping (a reboot doesn't clear a fault, or the
camera doesn't answer at all), the proxy can cut the camera's power on its PoE
switch and turn it on again (issue #85). It does this only when a switch is
configured, only for the configured port, and only while that port is
powering something.

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
  use `port - 1`. "Read the switch now" (below) shows the index the proxy
  uses, before the first power-cycle.
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

## Settings

All in `camera.poeSwitch` (config.json, or the Settings page). They apply at
once: the proxy reads them on every use.
Only values that differ from config.json or the default become overrides
(saving `ports` 8 or `offSeconds` 10 stores nothing). On the Settings page,
Reset of `model` reads "Reset – none (no PoE switch: power-cycle off)", and of
`host` or `port` "Reset – not set (PoE switch control off: …)".

| Setting | Default | |
|---|---|---|
| `model` | `none` | `none`, or `sscpoe-web` |
| `host` | — | the switch's address or name, optional `:port` (plain http) |
| `port` | — | the switch port the camera is on, as numbered on the switch (1–48) |
| `ports` | 8 | the switch's PoE port count, for the index mapping (1–48) |
| `offSeconds` | 10 | how long the PoE stays off (5–60) |

The password is a secret, `CAMPROXY_POE_SWITCH_PASSWORD` (or
`CAMPROXY_POE_SWITCH_PASSWORD_FILE`), optional like the other optional
secrets: in `.env` on the Pi (`compose.yaml` passes it on), and
`scripts/sync-secrets.sh` adds it to the cluster Secret when it is set. It is
sent in the switch's login only. It never appears in a log line, an API
answer, an error message or an audit record, and the Settings page only says
whether it is set.

cam1's Pi, for example:

```json
"camera": { "poeSwitch": { "model": "sscpoe-web", "host": "192.168.1.217", "port": 8 } }
```

## What a power-cycle does

`POST /control/actions/camera-powercycle` (admin only; an admin session also
needs the `X-CamProxy-UI` header):

1. **Checks:** 409 `not_configured` when `model` is `none`, `host` or `port` is
   missing, `port` is above `ports`, or the password is not set. 429
   `too_soon` within 120 s of the last camera reboot or power-cycle (they
   share the cooldown), or while one is in progress.
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
| `false` | the camera's PoE may be **OFF** | Maintenance warns: "The camera's PoE may be OFF: use 'Turn camera PoE on', or the switch's web UI (port N)." `camera.poeSwitch.poeMaybeOff` is `true` |

**Recovery:** `POST /control/actions/camera-poe-on` (admin only) logs in,
reads the port and, if its PoE is off, turns it on (with the same retries),
then logs out. It skips the power check (an unpowered port is the point) and
the cooldown, and uses the same switch lock (409 `switch_busy` during a
power-cycle). Answer: the reading plus `wasOn`. Audited as `camera-poe-on`.
The Maintenance page's "Turn camera PoE on" button sends it. The button shows
whenever a switch is configured, so it also works after a proxy restart has
lost the failure state. It only ever turns PoE on, so it doesn't ask first.

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
(`phase: stop`, `poeLeftOff`, `sessionMaybeOpen`). After the restart, use "Turn camera PoE
on" or the switch's web UI.

The answer, 202 `{offAt, onAt, watts}`, comes once PoE is back on, so the
request takes `offSeconds` and a little more. Then the camera's state is
"rebooting" until it answers again, the same as after a camera-API reboot
(#83): ONVIF re-subscribes on its own, and stills and FTP carry on.
`/control/status` has `camera.reboot` (`kind: powercycle`, `phase`,
`offAt`, `downSec`) and `camera.poeSwitch` (the settings, `passwordSet`,
`configured`, `busy`, `poeMaybeOff`, and the `last` reading).

Measured on the real switch (2026-10-01): with PoE off for 10 s, the camera
answered its API again 46 s after the cut.

`POST /control/actions/poe-switch-read` reads the port without switching
anything: log in, 101, log out. The answer is `{at, port, index, poe, watts,
link, sn, firmware}`. It shows on the Status page and in the Settings page's
PoE switch card ("Read the switch now"). The proxy never reads the switch on
its own.

## Admin UI

- **Maintenance:** "Power-cycle camera", only when a switch is configured. It
  asks first, in the same dialog as "Reboot camera": "Cut the camera's PoE
  power on <host> port <n> for 10 s? The camera is offline for about a
  minute. Only works while nobody is logged in to the switch's web UI." Then
  "Power-cycling…" while the PoE is off, "Rebooting…" until the camera
  answers, and how long it was away. "Turn camera PoE on" next to it
  (recovery, no dialog). While the camera's PoE may be off, a red line says
  so; a failed power-cycle's result line says whether PoE is on again.
- **Status:** the camera's state shows "power-cycling", then "rebooting"; the
  PoE switch line shows the switch, the port and the last reading.
- **Settings:** the `camera.poeSwitch` settings in the camera group, and a PoE
  switch card with the last reading and "Read the switch now".

## Audit

`camera-powercycle` (host / change, user `admin`) with `switch: {model, host,
port}`, `offSeconds`, `requestedBy` and, on success, `watts`, `offAt` and
`onAt`. Then a second record (host / end, user `system`) when the camera
answers again (`downSec`, from the cut), or a failure after 5 minutes. A
refusal from the switch (busy, no power, a wrong password) is a failure record
with the code. A failure after the PoE-off request says so: "PoE may have been
cut; turned back on: yes/no" (`poeOff: true`, `turnedOn`). A stopping proxy
that may leave PoE off writes `phase: stop`, `poeLeftOff: true`.
`camera-poe-on` (host / change) records the recovery, with `switch`, `wasOn`
and `requestedBy`, or a failure. Details in [audit-log.md](audit-log.md). The cooldown and the
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
