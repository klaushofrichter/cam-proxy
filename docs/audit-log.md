# Audit log

Who did what on the proxy: starts and stops, restarts, sign-ins (including
failures), refused tokens, control actions, settings changes, and a daily
storage and activity snapshot. Design: [the spec](superpowers/specs/2026-10-01-audit-log-design.md).

## What it records

| `event.action` | category / type | When | `cam_proxy` details |
|---|---|---|---|
| `proxy-start` | process / start | every start, once it is listening | `config` (camera id, stills, ftp, analytics on or off), `previousStop` (time of the newest record when it is a `proxy-stop`, else null), `uncleanStop` (`true` when the newest start or stop record is a start: the last run ended without a `proxy-stop`, as after a crash or power loss) |
| `proxy-stop` | process / end | a clean shutdown | `reason` (the signal, or `stop`) |
| `proxy-restart` | process / change | `POST /control/actions/restart` | `requestedBy` (`session` or `token`) |
| `login` | authentication / start | `POST /control/login` and `GET /control/login-link`, success or failure | `auth.method` (`token-form` or `login-link`); on failure `auth.reason` (`wrong-token`, `link-used-or-expired`, `rate-limited`); `auth.suppressed` |
| `logout` | authentication / end | `POST /control/logout` | with a session: `user.name` `admin`. Without one: `auth.reason: no-session`; `auth.suppressed` |
| `login-link-issued` | authentication / creation | `POST /control/login-links` (cams mints a link) | |
| `auth-refused` | authentication / denied | a request the auth layer answered with 401 or 403 | `auth.tokenKind` (`none`, `invalid`, `client`, `admin`, `audit`, `session`), `auth.reason` (`no-token`, `wrong-token`, `admin-only`, `csrf`), `auth.suppressed`; ECS `http.request.method` and `url.path` |
| `control-action` | configuration / change | `POST /control/actions/:name` except `restart` and a retention dry run | `action`, `result` (`ok`, the error code or status, or `aborted`), `requestedBy` |
| `config-change` | configuration / change | `PUT /control/config`, reset of an override | `changes`: `[{key, from, to}]`, secrets redacted. A refused change (400) writes nothing |
| `secret-override` | configuration / change | `PUT /control/secrets/google-vision-key` (the Settings page's key field) | `secret` (`CAMPROXY_GOOGLE_VISION_KEY`), `masked` (first and last four characters, `AIza…wXyZ`), `replaced` (`env`, `manual` or `none`). Never the key. A refused key (400) writes nothing |
| `storage-daily` | host / info | once per camera day, 00:05 camera time | `day`, `size`, `free`, `budget`, `used`, `daysUntilFull`, `kinds`, `clipRows` |
| `activity-daily` | host / info | once per camera day, 00:05 camera time | `day`, `forDay`, `events`, `clips`, `analytics`, `stream` |
| `audit-throttled` | host / info | a day's file reached 50 MB | none |

Notes on what the code does today:

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
- **Restart:** the `restart` action is recorded as `proxy-restart` (a
  restart of the proxy), and for now that is the only restart record.
  cam-proxy has no command that reboots the camera; cams does that directly.
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

Configuration (the values of a setting whose name contains `token`, `key`,
`password` or `secret` are written as `"[redacted]"`):

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
{"@timestamp":"2026-10-02T00:05:00.020Z","ecs":{"version":"8.11.0"},
 "event":{"kind":"event","category":["host"],"type":["info"],"action":"storage-daily","outcome":"success","dataset":"cam-proxy.audit"},
 "service":{"name":"cam-proxy","version":"2026.10.01.1"},"host":{"name":"cam-proxy"},"labels":{"camera":"cam1"},
 "user":{"name":"system"},
 "message":"Storage: 82.4 GB used of 150.0 GB budget, 41,230 stills, 1,312 clips, 214 days until full",
 "cam_proxy":{"day":"2026-10-02","size":229000000000,"free":98000000000,"budget":150000000000,"used":82400000000,"daysUntilFull":214,
  "kinds":{"stills":{"bytes":30000000000,"files":41230,"oldest":1759276800000,"newest":1759363200000,"growthPerDay":4200000000},"previews":{"bytes":9000000000,"files":3100,"oldest":1759276800000,"newest":1759363200000,"growthPerDay":600000000},"clips":{"bytes":42000000000,"files":1312,"oldest":1759276800000,"newest":1759363200000,"growthPerDay":2900000000},"catalog":{"bytes":380000000,"files":1,"oldest":1759276800000,"newest":1759363200000,"growthPerDay":12000000},"audit":{"bytes":2100000,"files":7,"oldest":1759276800000,"newest":1759363200000,"growthPerDay":300000}},"clipRows":1312}}
```

```json
{"@timestamp":"2026-10-02T00:05:00.031Z","ecs":{"version":"8.11.0"},
 "event":{"kind":"event","category":["host"],"type":["info"],"action":"activity-daily","outcome":"success","dataset":"cam-proxy.audit"},
 "service":{"name":"cam-proxy","version":"2026.10.01.1"},"host":{"name":"cam-proxy"},"labels":{"camera":"cam1"},
 "user":{"name":"system"},
 "message":"Activity 2026-10-01: 212 events (motion 150, person 40, vehicle 22), 31 clips, Vision 84 of 500 this month",
 "cam_proxy":{"day":"2026-10-02","forDay":"2026-10-01","events":{"total":212,"byKind":{"motion":150,"person":40,"vehicle":22}},"clips":31,
  "analytics":{"vision":{"day":9,"monthToDate":84,"monthlyLimit":500},"analyses":{"ok":9}},"stream":{"clients":1}}}
```

(The numbers above are illustrative.)

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
  so is `secret` when its value is a `CAMPROXY_…` variable name.) A Vision
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
  records for that day are dropped, and one `audit-throttled` record says so.
  Every other action is always written.

## API

`GET /control/audit` answers JSON lines (`application/x-ndjson`), one record
per line.

- **Access:** the admin token (bearer), an admin UI session, or
  `CAMPROXY_AUDIT_TOKEN`. The audit token reads this route only: on any
  other route it answers 403 `admin_only` (or 401 on the client API), so an
  answer never tells which kind of token matched. The client token gets 403 `admin_only`. HEAD is not supported.
  A token in the URL is refused.
- **Parameters:**

| Query | Meaning |
|---|---|
| `limit` | 1 to 500, default 100 |
| `before=<cursor>` | records older than the cursor, newest first (the Audit page) |
| `after=<cursor>` | records newer than the cursor, oldest first (a poller) |
| `from`, `to` | unix ms bounds |
| `action` | one or more `event.action` values, comma-separated |
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
- **Filters:** an action (a select of the known actions) and an outcome.
  Changing one starts again from the newest.
- **Paging:** Newer, Older, and Newest (back to the top). The top bar's
  Refresh reloads the page.
- Click (or press Enter on) a row to expand it to the full record as JSON.
- Empty: "No audit records yet."
