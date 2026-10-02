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
  web UI, the switch drops every other client's POST without an answer. So
  the proxy never polls the switch, logs out after every use, and a
  power-cycle fails with `switch_busy` until the browser logs out.
- **The other protocols** (UDP multicast for older firmware, and a cloud API)
  are not used.

## Settings

All in `camera.poeSwitch` (config.json, or the Settings page). They apply at
once: the proxy reads them on every use.

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
2. Logs in to the switch (123). A dropped login is 409 `switch_busy`; a
   refused password is 502 `switch_auth`; no answer is 502
   `switch_unreachable`.
3. Reads the ports (101) and refuses with 409 `no_power` unless the camera's
   port has PoE on **and** draws power. That is the safety check: it never
   cuts a port that isn't powering something.
4. PoE off (103). The camera's state becomes "power-cycling" and the proxy
   drops its camera token (the camera loses every session).
5. Waits `offSeconds`.
6. PoE on (103), up to three tries. If the switch does not confirm it, the
   answer is 502 `switch_error` with "PoE may still be off on port N": check
   the switch's web UI.
7. Logs out (126), on every path.

If the proxy stops during the off time (SIGTERM, a container stop, or
`restart-proxy`), it turns the PoE on at once and logs out before it exits,
so the camera is never left without power by a stopping proxy.

The answer, 202 `{offAt, onAt, watts}`, comes once PoE is back on, so the
request takes `offSeconds` and a little more. Then the camera's state is
"rebooting" until it answers again, the same as after a camera-API reboot
(#83): ONVIF re-subscribes on its own, and stills and FTP carry on.
`/control/status` has `camera.reboot` (`kind: powercycle`, `phase`,
`offAt`, `downSec`) and `camera.poeSwitch` (the settings, `passwordSet`,
`configured`, `busy`, and the `last` reading).

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
  answers, and how long it was away.
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
with the code. Details in [audit-log.md](audit-log.md). The cooldown and the
"rebooting" watch are in memory: a proxy restart resets them.

## Tests

The tests never contact the real switch. `test/helpers/poe-switch-mock.ts`
speaks the switch's web protocol: the login cookie, 101, 103 with the opcode,
126, a wrong password, and the busy session (a POST without the session while
another one is active is dropped with no answer). The e2e harness starts it on
port 18601 and wires PoE on the camera's port to cam-sim's power-off and
power-on, so the simulated camera really goes away.
