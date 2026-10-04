# Pi config from one .env; Find camera

2026-10-04. Klaus approved the Pi demo kit's configuration ("Yes to both"):
the camera's address and the Pi's own address live in one file,
`/srv/cam-proxy/.env`, next to the secrets, and the admin UI finds the camera
on a new LAN and writes its address there. cams takes the camera's address
from cam-proxy (cams spec 2026-10-04-camera-address-from-proxy-design), so on
the road only that one file changes.

## 1. Two settings from the environment

| Variable (either name) | Sets | Validation |
|---|---|---|
| `CAMPROXY_CAMERA_HOST` or `CAMERA_HOST` | `camera.host` | address or name, optional `:port` (1–65535): `^[A-Za-z0-9.-]{1,253}(:[0-9]{1,5})?$` |
| `CAMPROXY_PI_ADDRESS` or `PI_ADDRESS` | `ftp.publicHost`, and `server.publicUrl` = `http://<PI_ADDRESS>:<server.port>` | address or name, no port: `^[A-Za-z0-9.-]{1,253}$` |

- **Precedence: environment > overrides (Settings page) > config.json >
  defaults.** The environment layer is merged last in `build()`, so
  `crossCheck` (camera.host required) sees it and config.json may leave
  `camera.host` out.
- An empty value (`CAMERA_HOST=`) counts as unset.
- A bad value fails startup with `CAMERA_HOST: …` (the variable's name, like
  the schema's errors); nothing else is in the message.
- `GET /control/config` reports `source: "env"` and `env: "<NAME>"` for these
  paths; `PUT /control/config` for an env-set path answers 400 `invalid`
  (`camera.host: set in .env (CAMERA_HOST)`), and the Settings page shows the
  field read-only with "set in .env".
- Startup log line `config_env` with the settings set from the environment
  and their values (addresses, never a secret), and whether a .env file was
  read: `{"camera.host":"192.168.1.20","ftp.publicHost":"192.168.1.220",
  "server.publicUrl":"http://192.168.1.220:8480","envFile":true}`.
- `server.publicUrl` stays reserved for the admin UI's own use (CLAUDE.md);
  it is what `GET /api/cameras` reports (cams links to it).

- **Ruling: both names are accepted, the `CAMPROXY_` one wins** — why: with
  `env_file: .env` the plain names arrive as they are written in the one file
  (the file is shared with cams, so `CAMERA_HOST` reads better than a
  cam-proxy prefix), while `CAMPROXY_*` keeps the cluster and local runs in
  the existing naming; no compose mapping lines to forget — cost if wrong: one
  more name to support; dropping one later is a docs change.
- **Ruling: when `CAMPROXY_ENV_FILE` is set, cam-proxy reads these two keys
  from that file at every start, and any value in the file wins over any in
  the process environment** (order: file `CAMPROXY_*`, file plain name,
  process `CAMPROXY_*`, process plain name; security review 2026-10-04 asked
  to pick and document: the file wins, also over a `CAMPROXY_CAMERA_HOST` in
  compose's `environment:`) — why: "Use this address" writes the file and then restarts
  the process, but a container restart (restart-proxy exits, compose starts it
  again) keeps the environment from when the container was created, so the new
  `CAMERA_HOST` would not apply until `docker compose up -d`; reading the file
  makes restart-proxy (and a plain `docker compose restart`) enough — cost if
  wrong: a value set only in compose's `environment:` loses to a different one
  in the file; documented, and the startup line says what applied.
- Only these two keys are ever read from the file; secrets keep coming from
  the environment as before.

## 2. The camera's address in the client API

- `GET /api/cameras` (client token): each entry gets `address`, the camera's
  `camera.host` as it runs (host and optional port; no user, no secret).
- The SSE `camera` message (#169: `{cam, name}`) gains `address`:
  `{cam, name, address}`. It is sent on a name change (as before) and when the
  camera side starts with an address other than the one last told (process
  start, "Restart camera side" after a camera.host change).
- **Ruling: extend the `camera` message, no new type** — why: cams already
  subscribes to `camera` (optional type) and reads only `name`, so older cams
  ignore `address`, and a cams that wants it needs no new type negotiation —
  cost if wrong: a client that treats every `camera` message as a rename sees
  one extra message per address change with the same name (harmless: cams
  announces names on change only).

## 3. Find camera (ONVIF WS-Discovery)

On Settings → Camera ("Find camera" card), admin only.

- `POST /control/actions/find-camera` → 200
  `{devices: [{address, xaddrs, name, hardware, model, current, endpoint}], tookMs, envFile: {writable, reason?, path?}}`.
  - One WS-Discovery `Probe` (SOAP 1.2 over UDP, `wsa:To
    urn:schemas-xmlsoap-org:ws:2005:04:discovery`, `Types
    dn:NetworkVideoTransmitter`) to `239.255.255.250:3702`, sent twice
    (UDP may drop one), answers collected for 3 s; duplicates by endpoint
    are merged.
  - From each `ProbeMatch`: `XAddrs` (the device service URLs; `address` is
    the first one's host without its port: the port there is ONVIF's, 8000 on
    a Reolink, while `camera.host` is the HTTP API's), and the scopes
    `onvif://www.onvif.org/name/…`, `/hardware/…`, `/model/…` (URL-decoded;
    `model` falls back to `hardware`). No login: the Probe answer is public.
  - `sender`: the UDP source address of the answer; `mismatch`: the XAddr
    host differs from it; `useAddress`: what "Use this address" writes, the
    sender on a mismatch (security review 2026-10-04: a device can name any
    address in its XAddrs, but it answered from its own). The UI shows the
    sender and flags "address mismatch".
  - `current`: the device's own address (XAddr host) equals `camera.host`'s host.
  - Only answers whose `RelatesTo` is our MessageID count; at most 64
    devices, at most 64 KB per datagram, text fields cut to 64 characters
    without control characters.
  - Rate limit: 6 per minute per client, shared with `camera-address` (429
    `rate_limited`). The generic
    `control-action` audit record (`find-camera: ok`) records it.
  - On the Pi the container has `network_mode: host`, so the multicast leaves
    on the LAN. In the cluster (cam2, pod network) nothing answers: an empty
    list.
- **Ruling: the parser is built and tested on a documented Reolink sample, not
  a measured one** — why: probing the real camera is not allowed in this task,
  and no capture exists in cam-sim or the docs; the sample
  (`test/fixtures/ws-discovery/reolink-probe-match.xml`) follows the ONVIF
  Core spec and the scope layout Reolink cameras are reported to use (name and
  hardware = the model, e.g. `RLC-1224A`); the parser reads only the fields
  every ONVIF device sends — cost if wrong: a name or model shows as "—" until
  the sample is replaced by a capture; the address comes from `XAddrs`, which
  is mandatory, so finding the camera still works. Follow-up: capture the
  real Probe-match at home (read-only) and replace the sample.

## 4. Use this address

- `POST /control/actions/camera-address {host}` → 200
  `{host, previous, backup, restart: true}`; the UI then runs the existing
  restart-proxy (the same "Restarting…" wait, sign in again).
- `CAMPROXY_ENV_FILE` unset → 409 `not_available` with `line:
  "CAMERA_HOST=<host>"`: the UI says it can't write the file and shows the
  line to add by hand (then recreate the container).
- `host` is checked like `CAMERA_HOST` (400 `invalid`); nothing is written.
- **Path guard**: `CAMPROXY_ENV_FILE` must be absolute, without `..`, its
  name `.env` or `.env.<word>`, an existing regular file (not a symlink),
  under 64 KB; otherwise 409 `not_available` with the reason.
- **The edit**: only the `CAMERA_HOST=` line (optional leading spaces and
  `export `) is replaced, the last one when the key repeats (the one that
  counts); `CAMPROXY_CAMERA_HOST` is replaced instead when the file sets that
  name (it would win); with neither, `CAMERA_HOST=<host>` is appended (after a
  newline when the file doesn't end with one). The replaced line keeps its
  indentation, `export `, its line ending and an inline comment; every other
  byte is unchanged. The file's line ending (CRLF if it has any) is used for
  an appended line. Values are written unquoted (the validation allows no
  character that needs quotes).
- **The write**: first a backup `.env.bak-<YYYYMMDD-HHMMSS>` (UTC) in the same
  directory with the file's mode, then the new text to a temp file in that
  directory with the file's mode, then `rename` over the file (atomic).
  A temp file is removed when anything fails; the old file is untouched then.
  Afterwards only the newest 5 backups stay (by time, then same-second
  number; a new same-second backup is numbered after the highest existing
  one); nothing else in the directory is touched.
- **Audit**: one `camera-address` record (configuration/change): `Camera
  address set in .env: "<old>" → "<new>"`, details `{from, to, key, backup,
  requestedBy}`; a failed write records `failure` with the error code. The
  restart writes its own `proxy-restart` record.
- **Ruling (coordinator, security review 2026-10-04): the settings file is
  `/srv/cam-proxy/config/.env`** (uid 1000, mode 600) in `config/` (uid 1000,
  mode 700), mounted as `./config:/config` with `CAMPROXY_ENV_FILE=/config/.env`
  — why: the first layout mounted the whole project directory read-write, so a
  compromised container could rewrite compose.yaml or plant compose
  substitutions (e.g. a data path of `/`) and get root at the next `up`; now
  the container can write only `config/`, compose.yaml has no `${…}` at all,
  and the file is not compose's project `.env` (no symlink to it either). The
  folder, not the file, is mounted: a rename can't replace a bind-mounted file
  (EBUSY), and the backups go next to it — cost if wrong: one more folder and a
  migration step on the Pi (docs/raspberry-pi.md). A single-file mount answers
  409 `not_available` ("mount the directory").
- **Ruling: the UI chains restart-proxy after a successful write (two
  actions), the server never restarts by itself** — why: the restart already
  has its confirm-free API, its audit record and the UI's wait-for-new-process
  logic; the write stays a plain, testable request — cost if wrong: if the
  browser goes away between the two, the file is written but applies only at
  the next restart; the answer says `restart: true` and the page says so.

## 5. Compose and docs

`compose.yaml` (the Pi):

```yaml
    env_file: config/.env
    environment:
      CAMPROXY_CONFIG: /data/config.json
      CAMPROXY_TARGET: pi
      CAMPROXY_ENV_FILE: /config/.env
    volumes:
      - ./data:/data
      - ./config:/config
```

No `${…}` anywhere (`CAMPROXY_DATA` is gone); `test/compose-file.test.ts`
checks it.

- **Ruling: the `${CAMPROXY_…:?set in .env}` interpolations go, `env_file`
  carries every variable** — why: the one file holds them all; cam-proxy's own
  startup check names a missing secret (`CAMPROXY_TOKENS: required`) — cost if
  wrong: a missing secret fails at container start instead of at `docker
  compose up`.

`docs/raspberry-pi.md`: the single `config/.env` (example without values), the
migration from `/srv/cam-proxy/.env` (backups first; owner uid 1000), the new
compose, config.json without `camera.host`, `ftp.publicHost` and
`server.publicUrl`, "On the road" (Find camera → Use this address → "Point the
camera's FTP here"; a new `PI_ADDRESS`: edit, restart, then "Point the
camera's FTP here").

## 6. cam-sim

- **Ruling: no WS-Discovery responder in cam-sim now; issue filed** — why:
  multicast doesn't reach cam2 in the cluster's pod network, CI runners don't
  route multicast reliably, and the reply would copy an unmeasured sample (cam-sim
  copies the real camera) — cost if wrong: Find camera is tested against a
  fake UDP responder only; a cam-sim responder can follow once a real capture
  exists (cam-sim #90).

## Tests

- `test/env-file.test.ts`: the line editor (comments, quotes, CRLF, no
  trailing newline, duplicate keys, `export`, inline comment, other secrets
  byte-for-byte), the reader, the path guard, the atomic write (mode kept,
  backup, temp gone, failure leaves the file).
- `test/config-env.test.ts`: both names, precedence env > override > file,
  the env file winning, validation, sources, PUT refused, the log summary.
- `test/discovery.test.ts`: Probe XML, parsing the sample (scopes, XAddrs,
  RelatesTo, junk), a fake UDP responder on 127.0.0.1.
- `test/find-camera-api.test.ts`: both actions through the control API
  (admin only, CSRF, rate limit, audit, 409 without the file, write +
  answer).
- `test/settings-ui.test.ts`: the read-only env field.
- `/api/cameras` `address`, the `camera` message's `address`.
