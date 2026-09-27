# cam-proxy Plan 1: Core — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** a cam-proxy that runs natively on the Mac against cam-sim (and once
against the real camera). It keeps the camera's status, turns ONVIF events
into stored events, serves them through an authenticated API and a resumable
SSE stream, and has a control API and a first admin UI.

**Architecture:** one Node process (`createProxy(config)` → `start()` /
`stop()`). Configuration is layered: defaults in code, then `config.json`,
then `/data/overrides.json`, with secrets from the environment. SQLite
(`node:sqlite`) holds events and `stream_log`; every change is appended to
`stream_log` first, then pushed to SSE clients. Tests run cam-sim in process.

**Tech Stack:** Node 26, TypeScript 7 (CommonJS, `nodenext`), Express 5, pino,
`node:sqlite`, express-rate-limit, prom-client, vitest 5 + supertest, Svelte 5 +
Vite, Playwright (Chrome); cam-sim v2026.09.27.1 as a dev dependency.

**Spec:** `docs/superpowers/specs/2026-09-27-cam-proxy-design.md` (phase 1,
§18); requirements in `docs/requirements.md`.

## Global Constraints

- Node 26; TypeScript `module: nodenext`, CommonJS, `strict`; Express 5.
- No native modules: SQLite is `node:sqlite`; the image must build on arm64
  without compilers.
- Default port **8480**; data in `./data` locally.
- Timestamps are unix **milliseconds** in the database, the API and SSE.
- Secrets only from the environment (`CAMPROXY_TOKENS`, `CAMPROXY_ADMIN_TOKEN`,
  `CAMPROXY_CAMERA_PASSWORD`, `CAMPROXY_FTP_PASSWORD`, each with `_FILE`);
  never in `config.json`, overrides, logs, the UI or URLs.
- Tokens compared in constant time; a token in a query string answers 400.
- cam-sim is a dev dependency pinned to
  `https://github.com/klaushofrichter/cam-sim/releases/download/v2026.09.27.1/cam-sim-v2026.09.27.1.tgz`.
- No media files committed (CI check, as in cam-sim).
- Stage files explicitly (`git add <paths>`), never `git add -A`.
- Commit messages end with the session's attribution lines.

## Review Focus

1. **A camera reboot or power loss while subscribed:** the proxy
   re-subscribes on its own. No event stays open forever, and none is
   duplicated. → Task 7 tests (cam-sim `powerOff`/`powerOn`, `reboot`).
2. **An SSE client that resumes after the proxy restarts:** it gets exactly
   the messages it missed, with no gap and no duplicate. The ids survive the
   restart. → Task 5 test (reopen the database).
3. **A slow SSE consumer:** it is dropped when its queue fills, then resumes
   without loss. Other clients keep receiving in time. → Task 5 test.
4. **A broken `config.json`** (an unknown key, a wrong type, a missing
   `camera.host`, invalid JSON): the start fails with a message naming the
   key, and nothing half-starts. → Task 2 tests.
5. **Token scope:**
   - a client token can't use `/control`;
   - an admin session can read `/api`;
   - a token in the URL answers 400;
   - a wrong token answers 401 without timing leaks.

   → Task 8 and Task 9 tests.

---

### Task 1: Scaffold, CI and branch protection

**Files:** `package.json`, `package-lock.json`, `tsconfig.json`, `scripts/install-mediamtx.sh`,
`tsconfig.check.json`, `vitest.config.mts`, `src/log.ts`, `test/smoke.test.ts`,
`.github/workflows/pr-checks.yml`, `.github/codeql-accepted.tsv`,
`.github/dependabot.yml`, `CHANGELOG.md`

- `package.json` as cam-sim's (`"type": "commonjs"`), with:
  - scripts `build`, `dev` (`tsx --env-file-if-exists=.env src/cli.ts`),
    `test`, `lint:types`, `build:web`, `dev:web`, `check`, `test:e2e`;
  - dependencies express, express-rate-limit, pino, prom-client;
  - dev dependencies typescript, tsx, vitest, supertest and their types, and
    cam-sim (the pinned tarball).
- `tsconfig.json` and `tsconfig.check.json` copied from cam-sim (the check
  config includes `test`).
- `src/log.ts`: pino with the redaction paths `password`, `token`,
  `authorization`, `*.password`, `*.token`, and `req.url` cut at `?`.
- `pr-checks.yml`, the `test` job:
  - install ffmpeg, and MediaMTX (for cam-sim's RTSP) with
    `scripts/install-mediamtx.sh`, copied from cam-sim (its package ships only
    `dist/` and `openapi.yaml`);
  - `npm test`, `npm run lint:types`, the blocking `npm audit --omit=dev`, and
    the no-media check.

  The `codeql` job and its accepted-list gate are copied from cam-sim.
- **Test** `test/smoke.test.ts`: `import('cam-sim')` works, and
  `createCamSim` answers `GetDevInfo` through supertest.
- **Commit, push the branch, open a PR** to `main`; merge when green.
- **Afterwards:**
  - create the `production` branch from `main`;
  - apply branch protection per the steps-service standard (memory
    `branch-protection-standard`): `production` requires `test` and `codeql`,
    strict, enforce admins; `main` has no protection, as in cam-sim.

### Task 2: Configuration

**Files:** `src/config/defaults.ts`, `src/config/validate.ts`,
`src/config/load.ts`, `src/config/secrets.ts`, `config.schema.json`,
`config.example.json`, `test/config.test.ts`

**Interfaces — Produces:**
```ts
export interface Config {                       // src/config/defaults.ts
  server: { port: number; dataDir: string; logLevel: string; publicUrl?: string };
  camera: { id: string; name: string; host: string; protocol: 'https' | 'http'; tlsName?: string;
            user: string; onvifPort: number; rtspPort: number; statusPollS: number };
  go2rtc: { binary?: string; url?: string; rtspPort: number; apiPort: number };
  stills: { enabled: boolean; stream: 'sub' | 'main'; intervalS: number; size: string; quality: number; maxGB?: number };
  previews: { tileSize: string; grid: string; quality: number; maxGB?: number };
  events: { onvif: { subscribeMin: number; pullTimeoutS: number };
            poll: { enabled: boolean; intervalS: number; afterOnvifDownS: number }; maxOpenMin: number };
  retention: { stillsDays: number; previewsDays: number; clipsDays: number; eventsDays: number;
               streamLogDays: number; intervalMin: number };
  storage: { maxPercent?: number; maxBytes?: number; minFreeBytes: number;
             keepHours: { stills: number; clips: number; previews: number } };
  sse: { maxClients: number; queuePerClient: number; pingS: number };
  ftp: { enabled: boolean; port: number; passive: string; user: string; tls: boolean; stream: 'main' | 'sub'; maxGB?: number };
}
export const DEFAULTS: Config;                   // spec §14 values
export interface Secrets { tokens: string[]; adminToken: string; cameraPassword: string; ftpPassword?: string }
export type Source = 'default' | 'file' | 'override';
export interface Loaded { config: Config; secrets: Secrets; sources: Record<string, Source>; files: { config?: string; overrides: string } }
export class ConfigError extends Error {}         // message names the key, e.g. "camera.host: required"
export function loadConfig(env: NodeJS.ProcessEnv, opts?: { cwd?: string }): Loaded;            // src/config/load.ts
export function applyOverrides(loaded: Loaded, patch: object): Loaded;                           // validates, writes overrides.json atomically
export function removeOverride(loaded: Loaded, path: string): Loaded;
export const RESTART_KEYS: string[];              // e.g. 'camera.*', 'server.port', 'stills.*', 'go2rtc.*', 'ftp.port'
```

- **Loading:**
  - The file is `CAMPROXY_CONFIG`, or `./config.json` if it exists; with
    neither, the defaults apply and `camera.host` fails as required.
  - `dataDir` is resolved relative to the config file.
  - Overrides are read from `<dataDir>/overrides.json`.
- **Validation** is hand-written, without a schema library:
  - types, ranges and enums as in spec §14;
  - `size`/`tileSize` as `WxH` with even numbers;
  - `grid` must hold `60/intervalS` tiles;
  - `passive` as `A-B`;
  - unknown keys are rejected with the full path.
- **`config.schema.json`** mirrors the validator. A test walks `DEFAULTS` and
  checks that every key is in the schema with a matching type. Another test
  checks that `config.example.json` passes the validator and equals
  `DEFAULTS` apart from `camera.host`.
- **Secrets:**
  - `X_FILE` wins over `X`;
  - `CAMPROXY_TOKENS` is split on commas and trimmed, every token must be at
    least 32 characters, and an empty list is an error;
  - the admin token must differ from every client token;
  - the FTP password is required only when `ftp.enabled`.
- **Tests** (`test/config.test.ts`):
  - the defaults and a minimal file load;
  - the layering and the `sources` map;
  - an unknown key → `ConfigError` naming `stills.intervall`;
  - a wrong type → naming `sse.maxClients`;
  - no `camera.host` → `camera.host: required`;
  - invalid JSON → naming the file, not the content;
  - override apply and remove, and restart keys reported;
  - `_FILE` secrets;
  - a short token is rejected without echoing it;
  - the schema matches the defaults and the example matches the validator.

### Task 3: Camera client and status poller

**Files:** `src/camera/client.ts`, `src/camera/http.ts`, `src/camera/semaphore.ts`,
`src/camera/time.ts`, `src/camera/status.ts`, `test/camera-client.test.ts`,
`test/camera-status.test.ts`, `test/helpers/sim.ts`

**Interfaces:**
- Consumes: `Config`, `Secrets` (Task 2).
- Produces:
```ts
export class ReolinkClient { constructor(cam: CameraTarget & { id: string; user: string; password: string }, opts?: {...});
  command<T>(cmd: string, param?: object): Promise<T>; status(): Promise<{ model: string; firmware: string }>;
  timeInfo(): Promise<TimeInfo>; }                                           // moved from cams, API unchanged
export interface CameraState { online: boolean; since: number; model?: string; firmware?: string; clockOffsetMs?: number; error?: string }
export class StatusPoller extends EventEmitter {                            // src/camera/status.ts
  constructor(client: ReolinkClient, intervalS: number, now?: () => number);
  start(): void; stop(): void; state(): CameraState; checkNow(): Promise<CameraState>;
  // emits 'change' (CameraState) only when `online` flips
}
// test/helpers/sim.ts
export async function startSim(opts?: { onvif?: boolean }): Promise<{ sim: CamSim; ports: Ports; cameraConfig: Config['camera']; password: string; close(): Promise<void> }>;
```
- **Moved from cams** `server/reolink/client.ts`, `http.ts` and
  `semaphore.ts` with their behaviour unchanged.
  - Replace the imports: `CameraConfig` becomes a local `CameraTarget`, the
    logger is `src/log.ts`, and the `TimeInfo` part of `clipNames.ts` goes to
    `src/camera/time.ts`.
  - Drop `openLive`, `download` and `searchDay`/`searchMonth` (not used in
    phase 1).
  - Move the matching tests from cams' `test/reolinkClient.test.ts`, adapted
    to `startSim`.
- **`startSim`:** cam-sim in process with the users `admin` and `proxy`,
  `seedClips: 'demo'`, and listening on port 0 for http, https, control, rtsp
  and onvif. `cameraConfig` is pointed at its HTTP port.
- **StatusPoller:**
  - calls `GetDevInfo` and `GetTime` every `statusPollS`;
  - two failures in a row mean offline, one success means online;
  - `clockOffsetMs` = the camera's time minus the proxy's time.
- **Tests:**
  - online at start;
  - a cam-sim `offline` fault → `change` to offline after two polls;
  - clearing the fault → online;
  - `powerOff` → offline;
  - `clockOffsetMs` stays within ±2000;
  - a wrong password → offline with an `error` that doesn't contain the
    password.

### Task 4: Catalog

**Files:** `src/catalog/db.ts`, `src/catalog/migrations.ts`, `src/catalog/events.ts`,
`test/catalog.test.ts`

**Interfaces — Produces:**
```ts
export function openCatalog(file: string): Catalog;         // WAL, foreign_keys on, busy_timeout 5000, runs migrations
export interface Catalog { db: DatabaseSync; close(): void; schemaVersion(): number; sizeBytes(): number }
export interface EventRow { id: number; cam: string; source: 'onvif' | 'poll'; kind: string; start_ts: number; end_ts: number | null; end_reason: string | null; raw: unknown }
export function insertEvent(c: Catalog, e: Omit<EventRow, 'id' | 'end_ts' | 'end_reason'>): EventRow;
export function closeEvent(c: Catalog, id: number, end_ts: number, reason: 'state' | 'timeout' | 'restart'): EventRow;
export function openEvents(c: Catalog, cam: string): EventRow[];
export function listEvents(c: Catalog, q: { cam: string; from?: number; to?: number; kind?: string; limit?: number }): EventRow[]; // newest first, limit ≤ 1000
export function deleteEventsBefore(c: Catalog, ts: number): number;
```
- Migration 1 creates:
  - `events` (index `(cam, start_ts)`);
  - `annotations` (empty, spec §6);
  - `clips`;
  - `stream_log` (Task 5);
  - `schema_version`.

  Migrations are forward-only, and each runs in a transaction.
- **At start**, events still open from a previous run are closed with
  `end_reason: 'restart'` at their last known time.
- **Tests:**
  - migrations are idempotent;
  - reopen keeps the data;
  - insert/close/list with filters and ordering;
  - the `limit` cap;
  - deleting before a time;
  - restart closes open events;
  - `sizeBytes` includes the WAL.

### Task 5: Stream log and SSE

**Files:** `src/stream/log.ts`, `src/stream/sse.ts`, `test/stream-log.test.ts`,
`test/sse.test.ts`

**Interfaces:**
- Consumes: `Catalog` (Task 4).
- Produces:
```ts
export type StreamType = 'camera-event' | 'camera-status' | 'clip' | 'annotation' | 'still';
export interface StreamMessage { id: number; ts: number; cam: string; type: StreamType; data: Record<string, unknown> }
export class StreamLog extends EventEmitter {               // emits 'message' (StreamMessage) after the row is committed
  constructor(c: Catalog, now?: () => number);
  append(cam: string, type: StreamType, data: Record<string, unknown>): StreamMessage;
  since(id: number, filter: Filter, limit: number): StreamMessage[];
  oldestId(): number | null; lastId(): number; deleteBefore(ts: number): number;
}
export interface Filter { cam?: string; types: StreamType[]; kinds?: string[] }   // default types: all but 'still'
export function sseHandler(log: StreamLog, opts: { maxClients: number; queuePerClient: number; pingS: number }): RequestHandler & { clients(): number; closeAll(): void };
```
- **SSE:**
  - Headers: `Content-Type: text/event-stream`, `Cache-Control: no-store`,
    `X-Accel-Buffering: no`, `Connection: keep-alive`. Then `retry: 3000` is
    written first.
  - **Resume:** the start id comes from `Last-Event-ID` or `?since`. Replay in
    pages of 500 from `since()`, then go live. Live messages that arrive
    during the replay are buffered and de-duplicated by id.
  - **Too far behind:** a resume id below `oldestId() - 1` (retention deleted
    it) sends `event: reset` with `data: {"oldestId":N}` and then continues
    from the oldest.
  - **Filters:** `cam`, `types` (a comma list; `still` only when named) and
    `kinds` (matches `data.kind`).
  - **Keep-alive:** `: ping` every `pingS`.
  - **Backpressure:** a queue of `queuePerClient` messages; when it's full, or
    `res.write` returns false for longer than 5 s, the client is disconnected.
  - **Capacity:** past `maxClients`, new clients get 503 `{"error":"too_many_clients"}`.
  - Each message goes out as `id:`, `event:`, then `data:` (JSON).
- **Tests** use a real HTTP server and a small SSE parser in `test/helpers/sse.ts`:
  - live delivery in order;
  - resume with `Last-Event-ID` and with `?since`;
  - **restart**: close and reopen the catalog, and the resume still gives
    exactly the missed ids;
  - reset after retention;
  - filters (`types`, `kinds`, `still` opt-in);
  - ping arrives;
  - **slow consumer** (a paused socket) is dropped while a second client gets
    every message;
  - 503 past `maxClients`;
  - `closeAll` ends the streams.

### Task 6: ONVIF client

**Files:** `src/events/soap.ts`, `src/events/onvif.ts`, `test/onvif-client.test.ts`

**Interfaces — Produces:**
```ts
export interface OnvifMessage { topic: string; op: 'Initialized' | 'Changed' | 'Deleted'; utc: number; state: boolean; raw: string }
export class OnvifSubscription {
  constructor(t: { host: string; port: number; user: string; password: string }, opts: { subscribeMin: number; pullTimeoutS: number; now?: () => number });
  subscribe(): Promise<void>;                  // CreatePullPointSubscription; stores the manager address
  pull(signal?: AbortSignal): Promise<OnvifMessage[]>;   // PullMessages; throws OnvifGoneError on fault InvalidArgVal / connection reset / 400
  renew(): Promise<void>;                      // when less than 1/3 of the lifetime remains
  unsubscribe(): Promise<void>;
}
export class OnvifGoneError extends Error {}
```
- **Requests:**
  - WS-UsernameToken PasswordDigest: base64(sha1(nonce + created + password)),
    with a 16-byte random nonce and `Created` in UTC seconds.
  - SOAP 1.2 envelopes as in cam-sim's `reference/rlc-1224a/onvif/*.xml`.
  - The manager address comes from the reply. Its host is replaced by the
    configured host when the camera answers with a different one, because
    behind port mapping cam-sim returns the Host header.
- **Parsing:** notifications are read with a linear scan (no backtracking
  regexes on camera input; cam-sim's scanner can be copied). The `SimpleItem`
  named `IsMotion` or `State` gives the state; `UtcTime` gives the time.
  Requests time out after `pullTimeoutS + 10`.
- **Tests** against `startSim({ onvif: true })`:
  - subscribe;
  - the first pull returns nine `Initialized` messages;
  - `engine.events.trigger('person', 2)` → `PeopleDetect` `Changed` true,
    then false;
  - renew moves the termination time;
  - unsubscribe, then pull → `OnvifGoneError`;
  - `powerOff` during a pull → `OnvifGoneError`;
  - a wrong password → a clear auth error, without the password in the
    message.

### Task 7: Event intake (tracker, supervision, polling fallback)

**Files:** `src/events/tracker.ts`, `src/events/intake.ts`, `src/events/poll.ts`,
`test/events-intake.test.ts`

**Interfaces:**
- Consumes: `OnvifSubscription` (6), `ReolinkClient` (3), `StreamLog` (5), the
  catalog event functions (4), `Config.events`.
- Produces:
```ts
export class EventTracker {             // topic states → events rows + stream_log 'camera-event'
  constructor(c: Catalog, log: StreamLog, cam: string, opts: { maxOpenMin: number }, now?: () => number);
  apply(source: 'onvif' | 'poll', kind: string, state: boolean, ts: number, raw?: unknown): void;
  initialize(states: Record<string, boolean>): void;   // from 'Initialized': sets known state, no events
  sweep(): void;                                         // closes events open longer than maxOpenMin (end_reason 'timeout')
}
export function topicKind(topic: string): string | null; // CellMotionDetector/Motion|MotionAlarm → motion; PeopleDetect → person; VehicleDetect → vehicle; DogCatDetect → pet; others → their last segment
export interface IntakeState { onvif: 'subscribed' | 'connecting' | 'down'; since: number; source: 'onvif' | 'poll' | 'none'; lastError?: string; resubscribes: number }
export class EventIntake extends EventEmitter {           // emits 'state' (IntakeState)
  constructor(deps: { client: ReolinkClient; tracker: EventTracker; cfg: Config['events']; onvif: { host: string; port: number; user: string; password: string } });
  start(): void; stop(): Promise<void>; state(): IntakeState; resubscribe(): void;
}
```
- **Motion is merged:** both motion topics feed one `motion` state, open
  while either is true.
- **Each `camera-event` message** is `{eventId, kind, phase: 'start'|'end', ts, source}`.
- **The intake loop:**
  - subscribe, then pull in a loop, renewing when due;
  - `OnvifGoneError` or any error → backoff 1, 2, 4 … 60 s, then re-subscribe;
  - after `afterOnvifDownS` of trying, polling starts (if enabled):
    `GetMdState` plus `GetAiState` every `intervalS`, feeding
    `tracker.apply('poll', …)`;
  - polling stops at the next successful subscribe.
- **On re-subscribe,** the `Initialized` states are compared with the open
  events. An open event whose state is now false is closed at the resubscribe
  time with `end_reason 'state'`. An event that is true again stays the same
  event, with no duplicate.
- **Tests** (cam-sim; short timings via config):
  - person, vehicle and pet triggers → rows and start/end messages;
  - motion topics merged → one motion event;
  - `Initialized` creates no event;
  - `reboot()` mid-event → re-subscribe, the event is closed, no duplicate,
    `resubscribes` is 1;
  - `powerOff` for longer than `afterOnvifDownS` with ONVIF off
    (`onvifEnable = 0`) → polling takes over (the source is `poll`), and
    events still arrive;
  - ONVIF back → the source returns to `onvif`;
  - `maxOpenMin` → timeout close;
  - `stop()` leaves no timers (vitest's `--detectOpenHandles`-like check:
    the process exits).

### Task 8: HTTP server, client API and wiring

**Files:** `src/api/auth.ts`, `src/api/client-api.ts`, `src/proxy.ts`, `src/cli.ts`,
`openapi.yaml`, `test/client-api.test.ts`, `test/openapi.test.ts`, `test/proxy.test.ts`

**Interfaces:**
- Consumes: all of the above.
- Produces:
```ts
export function bearerAuth(tokens: () => string[]): RequestHandler;   // 400 token_in_url, 401 unauthorized; timingSafeEqual on SHA-256 digests
export interface Proxy { config: Loaded; app: Express; catalog: Catalog; log: StreamLog; status: StatusPoller; intake: EventIntake;
  start(): Promise<{ port: number }>; stop(): Promise<void> }
export function createProxy(loaded: Loaded): Proxy;                  // src/proxy.ts
```
- **Routes** (spec §10):
  - `/health`;
  - `GET /api/cameras` → `[{id, name, online, lastEventTs, stream: null}]`
    (the stream is null until phase 2);
  - `GET /api/cameras/:cam/events?from&to&kind&limit`;
  - `GET /api/stream`.

  An unknown `:cam` answers 404.
- **Camera status changes** go to the stream log as `camera-status`
  `{online, reason, clockOffsetMs}`.
- **The server** listens on `server.port` and 0.0.0.0 (on the LAN only by
  deployment). JSON errors, and a 64 KB body limit.
- **The CLI** loads the config and prints the first config error cleanly
  (exit 2). It handles SIGINT/SIGTERM with `stop()`, which closes SSE, the
  intake, the poller and the catalog in that order.
- **`openapi.yaml`** is checked against the registered routes, as in cam-sim.
- **Tests:**
  - auth: missing, wrong, token in query → 400, the old token after
    rotation, a short `CAMPROXY_TOKENS` rejected;
  - cameras;
  - events with filters;
  - end to end with cam-sim: a trigger arrives on SSE as `camera-event`
    start and end, and is listed by `/events`;
  - the proxy restarts on the same data dir and a client resumes with no
    gaps;
  - the CLI exits 2 on a bad config without a stack trace.

### Task 9: Control API, metrics, stats, retention

**Files:** `src/api/control-api.ts`, `src/api/session.ts`, `src/api/metrics.ts`,
`src/retention.ts`, `src/log-buffer.ts`, `test/control-api.test.ts`,
`test/metrics.test.ts`, `test/retention.test.ts`

**Interfaces:**
- Consumes: `Proxy` (8), `applyOverrides`/`removeOverride` (2).
- Produces the routes from spec §11 for phase 1:
  - `GET /control/status`: camera, intake, SSE clients, retention last run.
  - `GET /control/stats`: `disk.catalog`, `disk.free/size` (via `statfs`),
    `events.stored` by kind, `stream.rows`, `sse.clients`, and
    `storage.budget` for the data dir.
  - `GET /control/config`: for each setting, `{value, source, restart}`;
    secrets are never included.
  - `PUT /control/config`, `DELETE /control/config/:path`.
  - `POST /control/actions/:name`:
    - `onvif-resubscribe`;
    - `camera-test`, which runs `checkNow`;
    - `retention-run` with `dryRun`;
    - `restart`, which re-creates the components that need a restart;
    - an unknown name answers 404.
  - `GET /control/log?limit`: a ring buffer of the last 500 log lines, already
    redacted.
  - Session: `POST /control/login {token}`, `/control/logout` and
    `/control/session`, as in cam-sim's `session.ts`. The cookie is
    `camproxy_session` (HttpOnly, SameSite=Strict, Secure on TLS, 12 h). Writes
    with the cookie need `X-CamProxy-UI: 1`. Sign-in is limited to 20 per
    15 min.
- **Auth:**
  - `/control/*` takes the admin token or a session;
  - `/api/*` takes a client token, the admin token, or a session;
  - a client token on `/control` answers 403 `{"error":"admin_only"}`.
- **`/metrics`:** prom-client, unauthenticated, with the phase 1 metrics from
  spec §13:
  - disk catalog, free and size;
  - events;
  - ONVIF subscribed and resubscribes;
  - camera up, requests and errors;
  - SSE clients, messages, replayed and dropped;
  - stream log rows;
  - retention deleted and last run;
  - build info (target `dev`).
- **Retention (phase 1):** deletes events older than `eventsDays` and stream
  log rows older than `streamLogDays`. It runs every `intervalMin`, and its
  dry run reports counts. Files come in phase 2.
- **Tests:**
  - scopes: a client token → 403 on `/control`; the admin can read `/api`;
  - a cookie write without the header → 403 `csrf`;
  - config GET shows sources; a PUT of `sse.maxClients` applies live, while a
    PUT of `camera.host` is marked restart;
  - a bad PUT → 400 naming the key, with nothing written;
  - DELETE of an override;
  - each action;
  - `/metrics` parses and has the named series with no event content;
  - retention dry run and real run;
  - the log buffer never contains the tokens or passwords used in the test.

### Task 10: Admin UI

**Files:** `web/` (`index.html`, `vite.config.mts`, `tsconfig.json`, `src/main.ts`,
`src/App.svelte`, `src/lib/{api,router,sse}.ts`, `src/styles/theme.css` from cam-sim,
`src/components/{TopBar,Sidebar,ThemeToggle}.svelte`,
`src/pages/{Login,Status,Events,Settings,Maintenance}.svelte`), static serving in
`src/proxy.ts`, `playwright.config.ts`, `e2e/{env,helpers}.ts`, `e2e/admin.spec.ts`,
`.github/workflows/pr-checks.yml` (e2e job)

- The same look and structure as cam-sim's web UI (copy the theme,
  components and the api/router helpers, renamed).
- **Pages:**
  - **Status:** camera, ONVIF intake and SSE clients, updated live; the stats
    as cards (disk, events, stream log, projected storage).
  - **Events:** the live `camera-event` and `camera-status` log over SSE, a
    fetch-based client with the cookie, resuming by `Last-Event-ID`; plus the
    last 100 events from the API.
  - **Settings:** the effective config grouped as in spec §14, each value
    with its source badge. Editing creates overrides, restart-marked keys show
    a "needs restart" note, and each override can be reset.
  - **Maintenance:** the actions, the retention dry run and the log view.
- **Serving:** `/` and non-API GETs serve the app (`index.html` with
  `Cache-Control: no-store`), with the same framing headers and CSP as
  cam-sim.
- **e2e** (the Playwright `webServer` starts cam-sim and the proxy through
  `e2e/start.ts`):
  - login;
  - the status shows the camera online;
  - a cam-sim person trigger (through cam-sim's control API) appears in the
    Events log;
  - editing `sse.pingS` shows the override badge, and a reset removes it;
  - no token in `localStorage`, `sessionStorage` or the URL.

### Task 11: Docs, secrets script, real-camera check, finish

**Files:** `README.md`, `CHANGELOG.md`, `scripts/sync-secrets.sh`,
`scripts/verify-camera.sh`, `.env.example`, `docs/superpowers/specs/...` (phase 1
marked done)

- **README:**
  - what it is, quick start on the Mac against cam-sim;
  - configuration (the `config.json` layering, settings, secrets);
  - the client API and SSE reference (resume, reset, filters, curl examples);
  - the control API reference and the admin UI;
  - metrics and development.
- **`scripts/sync-secrets.sh`**, adapted from cam-sim:
  - generates `CAMPROXY_TOKENS` and `CAMPROXY_ADMIN_TOKEN` into `.env`;
  - `--rotate`;
  - GitHub and Kubernetes syncing are defined but only used in phase 5;
  - prints key names only.
- **`scripts/verify-camera.sh`** (read-only):
  - runs the proxy against the real camera from `.env`/`config.json` for
    90 s;
  - reports sign-in OK, the status, the ONVIF subscription, and any events
    seen;
  - changes nothing on the camera.

  It needs a camera user for the proxy. Creating the `proxy` user on the real
  camera is a camera change, so ask Klaus before running it. Until then, it
  runs with a read-only check user if Klaus supplies one.
- **Final:** the whole-branch review, fixes, then the PR to `main`. The
  release and deployment wait for phase 5, because there is no image yet.
