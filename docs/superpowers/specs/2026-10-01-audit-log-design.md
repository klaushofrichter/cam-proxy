# Audit log (design)

Status: agreed with Klaus in chat (2026-10-01). This spec is for review.

## Goal

cam-proxy keeps an audit log of who did what and when, plus a daily snapshot
of storage and activity, so that:
- it can be read in the admin UI (a new **Audit** page, newest first, paged);
- it can be pulled later by a collector into Grafana, e.g. Grafana Cloud's
  Loki (a scrapable API).

The log is stored on the proxy itself, with a configurable retention (default
90 days).

## Decisions (Klaus, 2026-10-01)

| Topic | Decision |
|---|---|
| **Format** | ECS (Elastic Common Schema) JSON lines: one JSON object per line. |
| **Storage** | One append-only file per day. |
| **Retention** | `retention.auditDays`, default **90**. |
| **Getting it into Grafana** | API only for now. How the Pi's log reaches Grafana is decided later (a poller in the cluster, Alloy on the Pi, or a push). Every record also goes to stdout, so the cluster's cam2 proxy lands in Grafana Cloud Loki today through the existing Alloy pod-log collector. |
| **Logins** | Web UI sign-ins, with both successes and failures. A refused bearer token is recorded, throttled. Successful bearer-token API calls are not recorded per request (cams makes thousands a day). |
| **Extra events** | Control actions and settings changes are recorded too: who changed what. |
| **Read-only token** | An optional `CAMPROXY_AUDIT_TOKEN` that can only read the audit API. |
| **UI** | A new Audit page: newest first, with paging. |

## The record

**Format:**
- Each event is one ECS 8.x JSON object on one line.
- Field names follow ECS. cam-proxy's own details go under `cam_proxy.*`, which is the ECS convention for custom fields.
- Timestamps are UTC (ISO 8601 with milliseconds).

```json
{"@timestamp":"2026-10-01T05:05:00.012Z","ecs":{"version":"8.11.0"},
 "event":{"kind":"event","category":["authentication"],"type":["start"],"action":"login","outcome":"success","dataset":"cam-proxy.audit"},
 "user":{"name":"admin"},"source":{"ip":"192.168.1.35"},"user_agent":{"original":"Mozilla/5.0 …"},
 "service":{"name":"cam-proxy","version":"2026.10.01.1"},"host":{"name":"cam-proxy"},
 "labels":{"camera":"cam1"},
 "cam_proxy":{"auth":{"method":"token-form"}},
 "message":"Admin signed in with the admin token"}
```

The fields every record carries:
- `@timestamp`;
- `ecs.version`;
- `event.kind`, `event.category[]`, `event.type[]`, `event.action`, `event.outcome` (`success`, `failure` or `unknown`) and `event.dataset` (`cam-proxy.audit`);
- `service.name` and `service.version`;
- `host.name`;
- `labels.camera`;
- `message`, a readable summary in one sentence.

**Optional fields:**
- `user.name`: `admin`, `client`, `audit`, or `system` for the proxy's own records.
- `source.ip`: the client address. It honours `server.trustProxy`, like the rate limits.
- `user_agent.original`.
- `error.message`: for failures.
- `cam_proxy.*`.

**Never written:** tokens, link codes, cookies, passwords, the Vision key, or any value of a config key whose name contains `token`, `key`, `password` or `secret` (such a value is replaced with `"[redacted]"`).

## What is recorded

| `event.action` | category / type | When | `cam_proxy` details |
|---|---|---|---|
| `proxy-start` | process / start | every start, once it is listening | `config` (camera id, stills on, FTP on, analytics enabled), `previousStop` (the last `proxy-stop` time, if there is one) |
| `proxy-stop` | process / end | a clean shutdown (SIGTERM) | `reason` (signal) |
| `proxy-restart` | process / change | `POST /control/actions/restart` | `requestedBy` (`session` or `token`) |
| `login` | authentication / start | `POST /control/login` and `GET /control/login-link`, success or failure | `auth.method` (`token-form` or `login-link`); on failure, `auth.reason` (`wrong-token`, `link-used-or-expired`, `rate-limited`) |
| `logout` | authentication / end | `POST /control/logout` | |
| `login-link-issued` | authentication / creation | `POST /control/login-links` (cams mints a link) | |
| `auth-refused` | authentication / denied | a request refused with 401 or 403 by the auth layer (no token, wrong token, admin-only, CSRF) | `auth.tokenKind` (`none`, `client`, `admin` or `invalid`), `http.request.method` and `url.path` (ECS fields), `auth.reason`. At most one record per source IP and path per 10 minutes. The record then carries `cam_proxy.auth.suppressed`, the number of refusals that were not recorded. |
| `control-action` | configuration / change | any other `POST /control/actions/:name` (FTP setup, test or off; ONVIF resubscribe; camera test; retention run) | `action` (the name), `result` (ok or the error code) |
| `config-change` | configuration / change | `PUT /control/config` and the reset of an override | `changes`: `[{ key, from, to }]` for each changed key, with secrets redacted |
| `storage-daily` | host / info | daily, 00:05 camera time | see "Daily records" |
| `activity-daily` | host / info | daily, 00:05 camera time | see "Daily records" |

**Reboot:**
- cam-proxy has no command that reboots the camera. cams reboots it directly.
- `proxy-restart` is therefore the only restart command.
- A future camera-reboot action would be recorded as `control-action`.

## Daily records

**When they're written:**
- At 00:05 camera time (the camera's time zone, as the analytics day counting already uses), cam-proxy writes `storage-daily` and then `activity-daily`.
- If the proxy was down at 00:05, it writes them at its next start. To know whether they are missing, it checks for today's records in the camera's day.
- Each is written at most once per camera day.

**`storage-daily`**, from `storage.usage()`:
- `size`, `free`, `budget` and `used` (bytes), and `daysUntilFull`.
- Per kind (`stills`, `previews`, `clips`, `catalog` and `audit`): `files`, `bytes`, `oldest`, `newest` and `growthPerDay`.
- The catalog row count of clips.

The message reads e.g. "Storage: 182.4 GB used of 150 GB budget, 41,230 stills, 1,312 clips, 214 days until full".

**`activity-daily`**, for the previous camera day:
- `events`: the total, and a count by kind (person, vehicle, pet, motion, and others).
- `clips`: the number received.
- `analytics`: Vision calls in the previous day and month to date, the monthly limit, and analyses by status (`ok`, `skipped` or `failed`).
- `stream`: the number of SSE clients right now.

## Storage and retention

**Files:**
- Records go to `<dataDir>/audit/YYYY-MM-DD.jsonl`, one file per **UTC** day, matching the UTC `@timestamp`.
- Writes are appends only, one line per call, and the process has a single writer.
- A record that fails to write is logged at error level, and the action it describes goes ahead.

**Retention:**
- `retention.auditDays`: an integer from 1 to 3650, default 90. It is in the Settings page with the other retention settings.
- The existing retention sweep deletes whole files older than the limit.

**Storage budget:** the audit folder counts as its own small kind (`audit`) and shows on the Status page. It is never deleted to make room: only retention removes it.

**Size guard:** if a day's file reaches 50 MB, further `auth-refused` records for that day are dropped. One `audit-throttled` record says so. All other actions are always written.

**stdout:** every record is also logged through the application logger at info level, with `audit: true` and the ECS object under `ecs`. In the cluster, Grafana Alloy already ships pod logs to Grafana Cloud Loki, so `{namespace="cam-proxy"} | json | audit="true"` finds cam2's records.

## API

**`GET /control/audit`:**
- Answers with JSON lines (`Content-Type: application/x-ndjson`), one ECS record per line.
- Access: the **admin token** (bearer), an admin UI session, or `CAMPROXY_AUDIT_TOKEN`. The admin token always works, and the audit token is an optional extra for a read-only poller. The client token gets 403.

| Query | Meaning |
|---|---|
| `limit` | 1–500, default 100 |
| `before=<cursor>` | records older than the cursor, **newest first** (paging back; the UI) |
| `after=<cursor>` | records newer than the cursor, **oldest first** (polling; a scraper) |
| `from`, `to` | unix ms bounds |
| `action` | one or more `event.action` values, comma-separated |
| `outcome` | `success`, `failure` or `unknown` |

- With neither `before` nor `after`, it answers the newest records, newest first.
- Each record carries its cursor in `cam_proxy.cursor`, an opaque string made of the file day and the line number. The response headers give `X-Next-Cursor` (for the next page in the same direction) and `X-Has-More: true|false`.
- A bad cursor or a bad range answers 400 with a message. An unknown action filter answers nothing (200, empty).

**`CAMPROXY_AUDIT_TOKEN`:**
- An optional environment variable. The `_FILE` variant reads it from a file, like the other secrets.
- With it, the bearer token can read `GET /control/audit` and nothing else. Every other route answers 403.
- It is never shown, logged or returned.
- A refused attempt with it elsewhere is recorded as `auth-refused`, with `tokenKind: audit`.

**Docs:** openapi.yaml, README (a section "Audit log"), and a guide `docs/audit-log.md`. The guide covers the record format with an example per action, the API, retention, and how to read cam2's records in Grafana Cloud Loki today.

## The Audit page (admin UI)

**Layout:**
- A new sidebar entry "Audit", for admins only, between Status and Settings.
- A table, newest on top, 50 per page:
  - time (local, with the date);
  - action;
  - outcome (a dot: green for success, red for failure, grey for unknown);
  - who (`user.name`, `source.ip`);
  - the summary (`message`).
- Clicking a row expands it and shows the full record as formatted JSON.

**Filters:** an action (a select of the actions above, plus all) and an outcome. Changing a filter starts again from the newest.

**Paging:** "Newer" and "Older" buttons follow the cursors. "Newest" jumps back to the top. The page doesn't refresh by itself; the top bar's Refresh reloads it, as on the other pages.

**Daily records:** the summary column shows their message. The expanded view shows the numbers.

**Empty state:** "No audit records yet."

## Testing

**Unit tests:**
- **The writer:**
  - the ECS fields;
  - one line per record;
  - the UTC file per day;
  - write failures don't throw into callers;
  - the stdout copy.
- **Each recorded action:**
  - the fields;
  - no secret ever appears: test each route with tokens and codes, and assert they are absent from the file and from stdout.
- **`auth-refused`:**
  - throttling per IP and path;
  - the suppressed count;
  - the 50 MB size guard.
- **Daily records:**
  - written at 00:05 camera time (injected clock and time zone);
  - written once per day;
  - catch-up at start after downtime;
  - the contents from a seeded catalog and storage.
- **Retention:**
  - deletes whole files older than `auditDays`;
  - keeps the rest.
- **The API:**
  - `before` newest first;
  - `after` oldest first;
  - cursors across file boundaries;
  - filters;
  - limits;
  - 400s;
  - the audit token can read and nothing else;
  - the admin token and the session can read;
  - the client token gets 403.
- **Config:** `auditDays` default, bounds, and the Settings round trip.

**e2e:**
- Sign in, then fail one sign-in, then sign out: all three appear on the Audit page with the right outcomes.
- Paging works with more than 50 records (seeded).
- The restart action is recorded.
- A row expands to show its JSON.

## Later

- Getting the Pi's log into Grafana: a poller in the cluster (outbound to the Pi on the LAN, which needs Klaus's approval through kube-setup), Grafana Alloy on the Pi, or a push from cam-proxy.
- A camera-reboot action, if cam-proxy gets one.
- Signing or hash-chaining the files for tamper evidence, if it is ever needed.
