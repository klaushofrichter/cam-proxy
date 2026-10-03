# Health summary: Pi figures, thresholds, Status page cards, local API — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One health summary (items with value, text and a problem flag, against the thresholds `health.diskPercent` and `health.tempC`) that the Status page shows as a Health card (plus a Pi card on a Raspberry Pi, red marks in the other cards and the data-volume disk on the Storage card), and that `GET /api/local/health` serves, without a key, to loopback callers only: the e-paper display (part B, another repo) reads it.

**Architecture:** `src/health/host.ts` reads the host figures from injectable paths (Pi detection from `/proc/cpuinfo`, hwmon by name, meminfo, uptime, loadavg; the data volume by `statfs`) once a minute in a `HostMonitor`. `src/health/summary.ts` is a pure `buildHealth(input)` that turns the existing status pieces and the host reading into the schema below: the one place with the problem rules. `src/api/local-api.ts` has `isLoopback()` and the route; non-loopback requests fall through as if the route did not exist. `src/proxy.ts` gathers the input (`healthNow()`), mounts the route before the `/api` access check and adds `health` to `GET /control/status`. The admin UI's `web/src/lib/health.ts` reads the items; `Status.svelte` draws the cards.

**Tech Stack:** Node 26+, TypeScript, Express 5, Svelte 5 runes, Vitest, Playwright. No new dependency.

**Spec:** `docs/superpowers/specs/2026-10-03-health-summary-design.md` (part A of the reolink e-paper design, approved 2026-10-03).

## Global Constraints

- Host figures are optional: a figure that can't be read is `null`, is left off the GUI, and is never a problem. No shell-outs; file reads only.
- Pi detection: `/proc/cpuinfo` line `Model\s*:\s*Raspberry Pi…`. hwmon by name only: scan `/sys/class/hwmon/*/name` for `cpu_thermal` (`temp1_input`, millidegrees) and `rpi_volt` (`in0_lcrit_alarm`); never a fixed `hwmonN`.
- `/proc/meminfo`, `/proc/uptime`, `/proc/loadavg`, temperature and under-voltage are read only while host stats are on: `host.stats` `auto` (default: on a Pi), `on`, `off`. The data volume (statfs of `server.dataDir`) is read everywhere.
- Settings (live, validated, audited as `config-change` by the existing PUT /control/config path, shown on the Settings page by its generic groups): `health.diskPercent` integer 50–99, default 90; `health.tempC` integer 40–95, default 75; `host.stats` `auto|on|off`, default `auto`. The FTP stall keeps `ftp.stalledHours`.
- Loopback: the socket's `remoteAddress` only, exactly `127.0.0.1`, `::1`, `::ffff:127.0.0.1`. Never `req.ip`, `X-Forwarded-For` or `trust proxy`. Anything else continues as an unknown `/api` route would (401 without a token, 404 with a client token).
- No secrets in the answer: no tokens, passwords, FTP settings (server, port, user, publicHost), the PoE switch's host, the camera serial.
- The Status page uses `status.health` for every red mark it shares with the summary (one source: `buildHealth`).
- Light and dark: only the theme tokens (`--danger`, `--muted`, `--surface`, `--border`, …); phone width works (cards in the existing auto-fill grid).
- CHANGELOG entries go under `## Unreleased`; never write a version number in the sources. Stage files explicitly.

## File structure

| File | Responsibility |
|---|---|
| `src/config/schema.ts`, `src/config/defaults.ts`, `config.example.json`, `config.schema.json` (modify) | the three settings |
| `src/health/host.ts` (new) | `HostPaths`, `detectPlatform()`, `readHwmon()`, `readHostStats()`, `dataVolume()`, `HostMonitor` |
| `src/health/summary.ts` (new) | `HealthInput`, `HealthSummary`, `buildHealth()` (the problem rules, the texts) |
| `src/api/local-api.ts` (new) | `isLoopback()`, `localApi({ health })` |
| `src/proxy.ts` (modify) | `ProxyOptions.host` (paths and statfs, for tests and e2e), the monitor, `healthNow()`, the route, `health` in `/control/status` |
| `src/api/control-api.ts` (modify) | `ControlDeps.health`; `/control/status` async with `health` |
| `test/fixtures/host/pi/…`, `test/fixtures/host/linux/…` (new) | `/proc` and `/sys` trees of a Pi 4 and of a non-Pi Linux host |
| `test/health-host.test.ts`, `test/health-summary.test.ts`, `test/local-api.test.ts`, `test/health-ui.test.ts` (new) | unit and API tests |
| `web/src/lib/health.ts` (new), `web/src/lib/state.ts`, `web/src/pages/Status.svelte` (modify) | the cards and red marks |
| `e2e/health.spec.ts` (new), `e2e/start.ts` (modify) | the Health and Pi cards against the Pi fixture (`E2E_HOST_ROOT` picks another tree) |
| `openapi.yaml`, `README.md`, `CHANGELOG.md`, `docs/raspberry-pi.md` (modify) | docs |

---

## Task 1: the settings

**Files:** modify `src/config/schema.ts`, `src/config/defaults.ts`, `config.example.json`, `config.schema.json` (`npm run schema`); test `test/config.test.ts`.

- [ ] Write failing tests in `test/config.test.ts`: defaults `health: {diskPercent: 90, tempC: 75}`, `host: {stats: 'auto'}`; `health.diskPercent: 49` and `100` refused naming the setting; `health.tempC: 39`/`96` refused; `host.stats: 'maybe'` refused; all three live (`needsRestart` false).
- [ ] Run `npx vitest run test/config.test.ts`: fails.
- [ ] Add to `SETTINGS`: `health: { diskPercent: int(50, 99, …), tempC: int(40, 95, …) }`, `host: { stats: { type: 'string', enum: ['auto', 'on', 'off'], … } }`; to `Config` and `DEFAULTS`; to `config.example.json`; `npm run schema`.
- [ ] Tests pass (including "config.example.json is valid and shows every default"). Commit `feat(config): health thresholds and host.stats`.

## Task 2: the host figures

**Files:** create `src/health/host.ts`, `test/health-host.test.ts`, fixtures `test/fixtures/host/pi/proc/{cpuinfo,meminfo,uptime,loadavg}`, `test/fixtures/host/pi/sys/class/hwmon/hwmon{0,1,2}/…` (`hwmon0` `name` = `rpi_volt` with `in0_lcrit_alarm` 0, `hwmon1` `name` = `cpu_thermal` with `temp1_input` 53600, `hwmon2` an unrelated sensor; deliberately not in the Pi's own order), `test/fixtures/host/linux/proc/…` (an x86 cpuinfo without `Model`, meminfo, uptime, loadavg; no hwmon).

```ts
export interface HostPaths { root: string } // '/' in production; a fixture tree in tests
export interface Platform { pi: boolean; model: string | null }
export interface HostStats { cpuTempC: number | null; underVoltage: boolean | null; memory: { totalBytes: number; availableBytes: number; usedPercent: number } | null; uptimeS: number | null; load: { m1: number; m5: number; m15: number } | null }
export interface DataVolume { sizeBytes: number; freeBytes: number; usedBytes: number; usedPercent: number }
export type StatFs = (dir: string) => { bsize: number; blocks: number; bfree: number; bavail: number };
export function detectPlatform(p: HostPaths): Platform;
export function hwmonByName(p: HostPaths): Map<string, string>; // name -> its directory
export function readHostStats(p: HostPaths): HostStats;
export function dataVolume(dir: string, statfs?: StatFs): DataVolume | null;
export function hostStatsOn(setting: 'auto' | 'on' | 'off', platform: Platform): boolean;
export class HostMonitor { constructor(d: { paths: HostPaths; dataDir: () => string; setting: () => 'auto' | 'on' | 'off'; statfs?: StatFs; everyMs?: number }); start(): void; stop(): void; refresh(): HostReading; reading(): HostReading }
export interface HostReading { platform: Platform & { hostStats: boolean }; disk: DataVolume | null; host: HostStats | null }
```

- [ ] Failing tests: the Pi fixture is a Pi with model `Raspberry Pi 4 Model B Rev 1.5`; the Linux fixture and a missing root are not (`model: null`); hwmon found by name whatever the number; temp 53.6, under-voltage false (and true with a fixture copy whose alarm is 1); meminfo usedPercent one decimal; uptime whole seconds; load numbers; every reader returns null on a missing or garbled file; `dataVolume()` is df's Use% (`(blocks−bfree)/((blocks−bfree)+bavail)`, one decimal) and null when statfs throws; `hostStatsOn` auto/on/off; `HostMonitor` reads host stats only while on (`off` on the Pi fixture gives `host: null` but `platform.pi: true`), reads the disk always, and `refresh()` follows a changed setting at once.
- [ ] Implement; tests pass. Commit `feat(health): host figures, platform-aware`.

## Task 3: the summary

**Files:** create `src/health/summary.ts`, `test/health-summary.test.ts`.

`buildHealth(input: HealthInput): HealthSummary` (types as "The API schema" below). `HealthInput` carries: `now`, `version`, `startedAt`, `thresholds`, `camera` (id, name, host, `CameraState`, reboot phase or null, poeSwitch `{model, port}` or null), `stream`, `intake` (`IntakeState`), `ftp` (enabled, listening, camera FTP view or null, `ClipsStall` or null, lastClip, clips, failures), `storage` (paused, lastRun), `recordingsCache`, `sseClients`, `lastInventory` (`{kind, op, outcome, startedAt, message}` or null), `reading` (`HostReading`).

- [ ] Failing tests, one per rule: camera offline; stream down only while enabled (`off` is no problem); events not subscribed (`down, polling` text); FTP `off`/`elsewhere` problems, `server_differs`/`not_set_up`/`unknown` not, disabled → `disabled` no problem, stalled → problem with text `no clip for 6 h`; storage paused; disk at 89.9 no, at 90.0 yes, with `diskPercent` 80 at 85 yes; cpuTemp 74.9 no, 75.0 yes; under-voltage true; inventory `failed` yes, `cancelled` no, null `none yet`; version never; items order and presence (no disk item for `disk: null`; no cpuTemp/underVoltage when `host` is null or their figure null); `ok`/`problemCount`; the camera `address` drops the port; `poeSwitch` without host.
- [ ] Implement; tests pass. Commit `feat(health): the health summary with thresholds`.

## Task 4: the local API and /control/status

**Files:** create `src/api/local-api.ts`, `test/local-api.test.ts`; modify `src/proxy.ts`, `src/api/control-api.ts`, `openapi.yaml`.

- [ ] Failing tests:
  - `isLoopback`: true for `127.0.0.1`, `::1`, `::ffff:127.0.0.1`; false for `192.168.1.50`, `::ffff:192.168.1.50`, `127.0.0.2`, `10.0.0.1`, `''`, `undefined`.
  - Guard on a small Express app (a test middleware sets the socket's `remoteAddress` before the route): a LAN address answers like an unknown route; a LAN address with `X-Forwarded-For: 127.0.0.1` and `trust proxy` on still does; `::ffff:127.0.0.1` is served.
  - Against a proxy and cam-sim (`startProxy` with `proxy.host` pointing at the Pi fixture and a fake statfs): 200 with `schema: 1`, `platform.pi: true`, the items in order, `Cache-Control: no-store`; no Authorization needed; the answer equals `/control/status`'s `health` apart from `generatedAt`; `PUT /control/config {"health":{"diskPercent":50}}` turns the disk item into a problem at once (and writes a `config-change` record); no secrets: the JSON contains neither the tokens, the camera or FTP passwords, nor any key named `password`, `token`, `publicHost`, `user`, `serial`; the Linux fixture gives `platform.pi: false`, `host: null`, no cpuTemp item; POST answers like an unknown route.
- [ ] Implement `localApi`, the monitor and `healthNow()` in `proxy.ts` (route mounted before `refuseTokenInUrl` and the `/api` access check); `/control/status` gets `health`; document `/api/local/health` in `openapi.yaml` (the openapi test lists it).
- [ ] Tests pass, including `test/openapi.test.ts`. Commit `feat(api): GET /api/local/health for loopback callers; health in /control/status`.

## Task 5: the Status page

**Files:** create `web/src/lib/health.ts`; modify `web/src/lib/state.ts`, `web/src/pages/Status.svelte`; test `test/health-ui.test.ts`.

- [ ] Failing tests for the helpers: `healthHeadline(h)` → `All OK`, `1 problem`, `3 problems`; `problemOf(h, id)` (false for a missing item or no health); `piCardTitle(platform)` → `Pi` / `Host`; `uptimeText(412233)` → `4 d 18 h`, `3 h 5 min`, `42 min`; `memoryText(m)` → `14.7 % of 3.7 GB`; `loadText` → `0.42 · 0.38 · 0.35`; `diskText(d)` → `11.4 % used, 191.0 GB free`.
- [ ] Implement; tests pass.
- [ ] Status page: a Health card first in the grid (full width: `grid-column: 1 / -1`), its headline (`data-testid="health-headline"`, red when problems), one line per item (`data-testid="health-item-<id>"`, `bad` class when `problem`); a Pi card (`data-testid="card-pi"`, titled `Pi`, or `Host` when host stats are forced on off a Pi) only when `health.host` is set: model, CPU temperature, under-voltage, memory, uptime, load, disk, red where the item is a problem; the Storage card gets `Disk used` (`data-testid="storage-disk"`, red from the disk item); the camera state, ONVIF, stream, camera FTP upload, last clip and writing lines take `bad` from the matching item. `npm run check` passes. Commit `feat(ui): Health and Pi cards, red marks from the health summary`.

## Task 6: e2e

**Files:** create `e2e/health.spec.ts`; modify `e2e/start.ts`.

- [ ] `start.ts` passes `host: { root: process.env.E2E_HOST_ROOT ?? <test/fixtures/host/pi> }` to `createProxy`.
- [ ] Spec: the Health card is first and lists Camera, Disk, CPU temperature, Version; the Pi card shows `Raspberry Pi 4 Model B Rev 1.5` and `53.6 °C`; setting `health.tempC` to 50 through the control API turns the CPU temperature line red in both cards and the headline counts it, and resetting it clears it (`DELETE /control/config/health.tempC`); the Storage card has `Disk used`; `GET /api/local/health` from the test runner (loopback) answers 200.
- [ ] `npm run test:e2e` passes. Commit `test(e2e): the Health and Pi cards`.

## Task 7: docs

- [ ] README: the settings table (`health`, `host`), the route in the Control API table (local only, no key), the admin UI's Status description; `docs/raspberry-pi.md`: what the Pi card reads and that it needs `network_mode: host` to describe the host; CHANGELOG `## Unreleased`. Commit `docs: the health summary, the local API and the settings`.

## Task 8: final checks

- [ ] `npx vitest run`, `npx tsc -p tsconfig.json --noEmit`, `npm run lint:types`, `npm run check`, `npm run build`, `npm run test:e2e`: all pass. Screenshots of the Status page (Pi and non-Pi, light and dark, desktop and phone width) for the review.
- [ ] Push, PR to `main`.

---

## The API schema

This is also written to the session scratchpad as `health-api-schema.md` for part B. The same object is `health` in `GET /control/status`.

### Access

- `GET http://127.0.0.1:8480/api/local/health` (also HEAD). No key, no cookie.
- Answered only when the TCP socket's remote address is `127.0.0.1`, `::1` or
  `::ffff:127.0.0.1`. `X-Forwarded-For` and `server.trustProxy` are never
  looked at.
- Any other address gets exactly what an unknown `/api` route gets (the
  request goes on as if the route did not exist): 401 `{"error":"unauthorized"}`
  without a token, 404 `{"error":"not_found"}` with a valid client token. So
  from the LAN it is indistinguishable from a route that does not exist.
- `Content-Type: application/json`, `Cache-Control: no-store`. Always 200 when
  answered: a figure that can't be read is `null`, never an error.
- No secrets: no tokens, passwords, FTP settings (server, port, user,
  publicHost), PoE switch host or camera serial.

### Conventions

- Times: unix **milliseconds** (integers). Durations: as named (`…S` seconds,
  `…Ms` milliseconds).
- Bytes: integers. Percent: number with one decimal (`11.4`), 0–100.
- Temperatures: °C, number with one decimal.
- `null` = unknown, not measured, or not applicable. A `null` figure is never a
  problem and is left off the GUI (and should be left off the display).
- New fields may be added within schema 1; a breaking change bumps `schema`.

### Top level

| Field | Type | Meaning |
|---|---|---|
| `schema` | integer | `1` |
| `generatedAt` | integer (ms) | when this answer was built |
| `version` | string | the installed proxy version, exactly as `/health` gives it (`"2026.10.03.1"` on a release, `"dev"` locally) |
| `startedAt` | integer (ms) or null | when this process started serving (proxy "up since") |
| `ok` | boolean | `true` when no item has `problem: true` |
| `problemCount` | integer | the number of items with `problem: true` |
| `thresholds` | object | `{diskPercent: integer, tempC: integer, ftpStalledHours: integer}`: the settings `health.diskPercent` (default 90), `health.tempC` (default 75), `ftp.stalledHours` (default 6) |
| `platform` | object | `{pi: boolean, model: string or null, hostStats: boolean}`: `pi` from `/proc/cpuinfo` `Model : Raspberry Pi …`; `model` that line's value (null off a Pi); `hostStats` whether the host figures (`host`) are read (setting `host.stats`: `auto` = on a Pi only, `on`, `off`) |
| `items` | array of Item | the at-a-glance list (the Status page's Health card, the display's Overview), in a fixed order |
| `camera` | object | details for the Camera page |
| `stream` | object | the live stream (stills) |
| `events` | object | the event intake |
| `ftp` | object | clip uploads |
| `proxy` | object | details for the Proxy page |
| `disk` | object or null | the proxy's data volume (every platform); null if `statfs` failed |
| `host` | object or null | Pi/host figures; null when `platform.hostStats` is false |

### Item

`{id: string, label: string, value: (see table), text: string, problem: boolean}`

- `label`: a short English label ("Camera"). `text`: a short display text
  ("online", "53.6 °C"). Both are meant to be shown as they are.
- Order and presence:

| `id` | `label` | present | `value` | `problem` when |
|---|---|---|---|---|
| `camera` | Camera | always | boolean: online | not online |
| `stream` | Live stream | always | `"up"`, `"down"`, `"off"` (stills disabled) | `"down"` |
| `events` | Events intake | always | `"subscribed"`, `"connecting"`, `"down"` (ONVIF) | not `"subscribed"` |
| `ftp` | Camera FTP upload | always | `"disabled"` (FTP off in the proxy), or the camera's FTP state: `"on"`, `"off"`, `"elsewhere"`, `"server_differs"`, `"not_set_up"`, `"unknown"` (not read yet) | `"off"` or `"elsewhere"`, or the stall check says stalled (`ftp.stalled`) |
| `storage` | Storage | always | `"writing"` or `"paused"` (free space below `storage.minFreeBytes`) | `"paused"` |
| `disk` | Disk | when `disk` is not null | number: `disk.usedPercent` | `usedPercent >= thresholds.diskPercent` |
| `cpuTemp` | CPU temperature | when `host.cpuTempC` is not null | number: °C | `value >= thresholds.tempC` |
| `underVoltage` | Under-voltage | when `host.underVoltage` is not null | boolean: the alarm is set | `true` |
| `inventory` | Last inventory | always | `"ok"`, `"cancelled"`, `"failed"`, or null (no run yet) | `"failed"` |
| `version` | Version | always | string: `version` | never |

Texts: camera `online` / `offline` / `rebooting` / `power-cycling`; stream
`up` / `down` / `off`; events `subscribed`, else the ONVIF state plus `, polling`
while polling fills in (`down, polling`); ftp `off in the proxy`, `no clip for 6 h`
(stalled), `on`, `off on the camera`, `points elsewhere`, `other server name`,
`not set up`, `not read yet`; storage `writing` / `paused (low space)`;
disk `11.4 % of 228.6 GB` (GB = 1024³ bytes, as on the Status page); cpuTemp
`53.6 °C`; underVoltage `no` / `detected`; inventory `none yet` or
`<kind>[ repair]: <outcome>` (`clips: ok`, `events repair: failed`); version
the version string.

### `camera`

| Field | Type | |
|---|---|---|
| `id` | string | `camera.id` (`cam1`) |
| `name` | string | `camera.name` (`Den`) |
| `address` | string | `camera.host` without its port (the camera's IP or name) |
| `online` | boolean | |
| `since` | integer (ms) | when `online` last changed |
| `model` | string or null | e.g. `RLC-1224A` |
| `firmware` | string or null | |
| `clockOffsetMs` | integer or null | camera clock minus proxy clock |
| `error` | string or null | why the last check failed (an error code such as `timeout`) |
| `reboot` | string or null | the phase of a reboot or power-cycle the proxy started: `rebooting`, `power-cycling`, `back`, `not-back`; null when none |
| `poeSwitch` | object or null | `{model: string, port: integer or null}` when `camera.poeSwitch.model` is not `none` (the switch's host is left out) |

### `stream`

`{enabled: boolean, up: boolean, lastFrameAt: integer (ms) or null}`

### `events`

`{onvif: "subscribed" | "connecting" | "down", source: "onvif" | "poll" | "none", since: integer (ms), resubscribes: integer}`

### `ftp`

| Field | Type | |
|---|---|---|
| `enabled` | boolean | `ftp.enabled` (the proxy takes clips) |
| `listening` | boolean | the FTP server listens |
| `cameraUpload` | string or null | the camera's FTP state (as item `ftp`'s value), null while `enabled` is false |
| `checkedAt` | integer (ms) or null | the last successful read of the camera's FTP settings |
| `lastClipAt` | integer (ms) or null | the last clip received |
| `clipsStored` | integer | clips in the catalog |
| `failures` | integer | upload and indexing failures since the start |
| `stalled` | boolean | no clip for `thresholds.ftpStalledHours` while the camera recorded events (false while `enabled` is false) |
| `eventsWithoutClip` | integer | the events of that stall window (0 when not stalled) |

### `proxy`

| Field | Type | |
|---|---|---|
| `sseClients` | integer | viewers on the event stream |
| `storagePaused` | boolean | same as item `storage` |
| `lastRetentionRun` | integer (ms) or null | |
| `recordingsCache` | object | `{bytes: integer, files: integer, capBytes: integer}` |
| `lastInventory` | object or null | the newest finished inventory run (check or repair, any kind): `{kind: string, op: "check" or "repair", outcome: "ok" or "cancelled" or "failed", startedAt: integer (ms), message: string}` |

### `disk` (the data volume, every platform)

`{sizeBytes: integer, freeBytes: integer, usedBytes: integer, usedPercent: number}`

`freeBytes` is what the proxy can still write (`bavail`), `usedBytes` is
`size − bfree`, and `usedPercent = usedBytes / (usedBytes + freeBytes)`, one
decimal: the same as `df`'s "Use%".

### `host` (only when `platform.hostStats`)

| Field | Type | |
|---|---|---|
| `cpuTempC` | number or null | hwmon `cpu_thermal` `temp1_input` / 1000, one decimal |
| `underVoltage` | boolean or null | hwmon `rpi_volt` `in0_lcrit_alarm` = 1 |
| `memory` | object or null | `{totalBytes, availableBytes: integer, usedPercent: number}` from `/proc/meminfo` (MemTotal, MemAvailable) |
| `uptimeS` | integer or null | `/proc/uptime`, whole seconds |
| `load` | object or null | `{m1, m5, m15: number}` from `/proc/loadavg` |

These are read once a minute (no shell-outs); `generatedAt` is the answer's
time, the host figures may be up to a minute older.

### Example: the Pi (cam1, real camera)

```json
{
  "schema": 1,
  "generatedAt": 1791041100000,
  "version": "2026.10.03.2",
  "startedAt": 1791034655742,
  "ok": true,
  "problemCount": 0,
  "thresholds": { "diskPercent": 90, "tempC": 75, "ftpStalledHours": 6 },
  "platform": { "pi": true, "model": "Raspberry Pi 4 Model B Rev 1.5", "hostStats": true },
  "items": [
    { "id": "camera", "label": "Camera", "value": true, "text": "online", "problem": false },
    { "id": "stream", "label": "Live stream", "value": "up", "text": "up", "problem": false },
    { "id": "events", "label": "Events intake", "value": "subscribed", "text": "subscribed", "problem": false },
    { "id": "ftp", "label": "Camera FTP upload", "value": "on", "text": "on", "problem": false },
    { "id": "storage", "label": "Storage", "value": "writing", "text": "writing", "problem": false },
    { "id": "disk", "label": "Disk", "value": 11.4, "text": "11.4 % of 228.6 GB", "problem": false },
    { "id": "cpuTemp", "label": "CPU temperature", "value": 53.6, "text": "53.6 °C", "problem": false },
    { "id": "underVoltage", "label": "Under-voltage", "value": false, "text": "no", "problem": false },
    { "id": "inventory", "label": "Last inventory", "value": "ok", "text": "clips: ok", "problem": false },
    { "id": "version", "label": "Version", "value": "2026.10.03.2", "text": "2026.10.03.2", "problem": false }
  ],
  "camera": {
    "id": "cam1", "name": "Den", "address": "192.168.1.103", "online": true, "since": 1791034660112,
    "model": "RLC-1224A", "firmware": "v3.1.0.4054_2409213180", "clockOffsetMs": -412, "error": null,
    "reboot": null, "poeSwitch": { "model": "sscpoe-web", "port": 8 }
  },
  "stream": { "enabled": true, "up": true, "lastFrameAt": 1791041099000 },
  "events": { "onvif": "subscribed", "source": "onvif", "since": 1791034661020, "resubscribes": 3 },
  "ftp": {
    "enabled": true, "listening": true, "cameraUpload": "on", "checkedAt": 1791040980000,
    "lastClipAt": 1791039210000, "clipsStored": 412, "failures": 0, "stalled": false, "eventsWithoutClip": 0
  },
  "proxy": {
    "sseClients": 2, "storagePaused": false, "lastRetentionRun": 1791038400000,
    "recordingsCache": { "bytes": 734003200, "files": 6, "capBytes": 2147483648 },
    "lastInventory": { "kind": "clips", "op": "check", "outcome": "ok", "startedAt": 1791030000000, "message": "Clips check: nothing missing" }
  },
  "disk": { "sizeBytes": 245457289216, "freeBytes": 205078347776, "usedBytes": 26414358528, "usedPercent": 11.4 },
  "host": {
    "cpuTempC": 53.6, "underVoltage": false,
    "memory": { "totalBytes": 4025016320, "availableBytes": 3435134976, "usedPercent": 14.7 },
    "uptimeS": 412233, "load": { "m1": 0.42, "m5": 0.38, "m15": 0.35 }
  }
}
```

### Example: the cluster (cam2, no Pi), with one problem

```json
{
  "schema": 1,
  "generatedAt": 1791041100000,
  "version": "2026.10.03.2",
  "startedAt": 1791012000000,
  "ok": false,
  "problemCount": 1,
  "thresholds": { "diskPercent": 90, "tempC": 75, "ftpStalledHours": 6 },
  "platform": { "pi": false, "model": null, "hostStats": false },
  "items": [
    { "id": "camera", "label": "Camera", "value": true, "text": "online", "problem": false },
    { "id": "stream", "label": "Live stream", "value": "up", "text": "up", "problem": false },
    { "id": "events", "label": "Events intake", "value": "subscribed", "text": "subscribed", "problem": false },
    { "id": "ftp", "label": "Camera FTP upload", "value": "on", "text": "no clip for 6 h", "problem": true },
    { "id": "storage", "label": "Storage", "value": "writing", "text": "writing", "problem": false },
    { "id": "disk", "label": "Disk", "value": 62.3, "text": "62.3 % of 19.6 GB", "problem": false },
    { "id": "inventory", "label": "Last inventory", "value": null, "text": "none yet", "problem": false },
    { "id": "version", "label": "Version", "value": "2026.10.03.2", "text": "2026.10.03.2", "problem": false }
  ],
  "camera": {
    "id": "cam2", "name": "cam2", "address": "cam2.cam-sim.svc.cluster.local", "online": true, "since": 1791012003000,
    "model": "RLC-1224A", "firmware": "v3.1.0.4054_2409213180", "clockOffsetMs": 3, "error": null,
    "reboot": null, "poeSwitch": null
  },
  "stream": { "enabled": true, "up": true, "lastFrameAt": 1791041099000 },
  "events": { "onvif": "subscribed", "source": "onvif", "since": 1791012004000, "resubscribes": 48 },
  "ftp": {
    "enabled": true, "listening": true, "cameraUpload": "on", "checkedAt": 1791040900000,
    "lastClipAt": 1791016000000, "clipsStored": 95, "failures": 0, "stalled": true, "eventsWithoutClip": 4
  },
  "proxy": {
    "sseClients": 1, "storagePaused": false, "lastRetentionRun": 1791038400000,
    "recordingsCache": { "bytes": 0, "files": 0, "capBytes": 2147483648 },
    "lastInventory": null
  },
  "disk": { "sizeBytes": 21003583488, "freeBytes": 7918845952, "usedBytes": 13084737536, "usedPercent": 62.3 },
  "host": null
}
```
