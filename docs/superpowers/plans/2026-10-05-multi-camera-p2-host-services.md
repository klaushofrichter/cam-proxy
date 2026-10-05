# Multi-camera P2: host-wide services — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The services a host has once (go2rtc, FTP server, storage budget, Vision budget, PoE switch, compositions, recordings cache) serve every camera of the proxy, and every camera gets its own control routes, settings and actions in the API and the admin UI.

**Architecture:** P1 left four stand-ins (Rulings P1-1 to P1-4: a go2rtc per camera, FTP for one camera, a split recordings cache, a `PoeSwitch` per camera). This phase replaces each with the host-wide service of spec §7–§8, adds the per-camera control routes and the latest-still endpoints of §6.3–§6.4, and lets the control API add and remove cameras (worker reconcile). Each task removes one stand-in or adds one service and is tested with cam-sims, the switch mock or a fake driver.

**Tech Stack:** Node 26, TypeScript 7, Express 5, node:sqlite, vitest 5, Playwright, Svelte 5, go2rtc (its HTTP API), cam-sim, the GPS-208 mock (`test/helpers/poe-switch-mock.ts`).

**Spec:** `docs/superpowers/specs/2026-10-05-multi-camera-host-design.md` (§3.2, §6.1, §6.3, §6.4, §6.5 host figures, §7, §8, §9, §15, §16 row P2). Builds on `docs/superpowers/plans/2026-10-05-multi-camera-p1-runtime.md` (read its rulings: P1-1 … P1-16).

## Global Constraints

- The Pi runs every release of this phase unchanged (one camera, legacy `camera` config) (spec §16 P2 "the Pi runs the release unchanged").
- One go2rtc process for the host, two streams per camera (`<cam>_sub`, `<cam>_main`), each camera's password passed by its own environment variable (`${CAM_<ID>_PASSWORD}` in the 0600 config); ports host-wide (`go2rtc.rtspPort`, `apiPort`); streams added and removed through go2rtc's API (`PUT/DELETE /api/streams`), so adding or restarting one camera never restarts go2rtc (spec §3.3, §8.5).
- One FTP(S) server, one port and one passive range for all cameras; each camera logs in as its own user (`cameras[].ftp.user`, default the camera id); one `CAMPROXY_FTP_PASSWORD`; when the camera's `host` is an IP address a login from another source address is refused (`530`) and logged; passive range ≥ 10 ports per camera (spec §7).
- Storage: one host-wide budget (`storage.maxBytes ?? maxPercent ?? 85 %`); optional `cameras[].storage.sharePercent` (sum ≤ 100); over budget: recordings cache first, then per kind the oldest hour — with shares first the camera most above its share; without shares the oldest hour across all cameras; `keepHours` and per-kind caps stay host-wide; `minFreeBytes` pauses every camera (spec §8.1).
- Vision: one budget per API key (`key_id`); `monthlyLimit`, `dailyCap`, `checksPerDay` are host settings counting every camera; a key change starts a fresh count (legacy rows go with the current key); `analytics.googleVision.perCameraDailyCap` (0 = none, default) (spec §8.2).
- Recordings: one LRU cache for all cameras under `recordings/<cam>/`, capped by the host `recordings.cacheMB`; one Baichuan session and one transfer at a time per camera (spec §8.3).
- PoE: one controller per host; a driver per model behind one interface (log in, read ports, set one port's PoE, log out, and whether only one session is allowed); `sscpoe-web` unchanged; FIFO queue, a second camera's power-cycle waits for the first, bounded at `offSeconds + 60 s`; a read (callcmd 101) serves every camera's status, cached 10 s; the 2-min reboot/power-cycle cooldown stays per camera; shutdown turns on every port it left off (spec §8.4).
- `composition.concurrent` (1–4, default 1) (spec §8.6).
- Latest still: `GET /api/cameras/:cam/stills/latest.jpg`, `GET /api/cameras/:cam/previews/latest.jpg` from memory, `ETag: "<cam>-<ts>"`, `Cache-Control: no-cache`, `X-Still-Ts`, `If-None-Match` → 304 no body, `404 no_still` while the stream is down (last ts in the body); `GET /api/stills/latest` → `[{cam, ts, url, tileUrl, up}]`; all in the image rate-limit bucket (spec §6.4).
- Control: `GET /control/cameras/:cam/status`, `PUT /control/cameras/:cam/name`, `POST /control/cameras/:cam/actions/:name`; old routes act on the only camera, `400 camera_required` on a multi-camera proxy; adding a camera with `PUT /control/config` `cameras.<id>`; a config.json camera can't be removed from the UI (spec §6.3).
- Host figures: on the mini PC `host.stats: on`; temperature from hwmon `k10temp` `Tctl` where present, otherwise null (spec §6.5).
- Secrets never logged; the go2rtc API carries a camera password only on 127.0.0.1 and never in a log line.
- No new runtime dependency.

## Review Focus

1. **A camera added through the API while go2rtc runs** (`PUT /control/config` with `cameras.cam6`): its streams appear in go2rtc without restarting it, and the other cameras' grabbers never drop a frame. Pinned in Task 10 (`adding a camera never restarts go2rtc`).
2. **Two cameras ask the switch at once** (power-cycle of cam3 while cam4's port is read): the second waits its turn instead of failing, and a request still waiting after `offSeconds + 60 s` gets `switch_busy`. Pinned in Task 7 (`queue: the second waits; beyond the bound switch_busy`).
3. **An FTP login with the right user and password from the wrong address** (another camera's IP, or a laptop on the camera network): refused with 530, logged and audited, no upload accepted. Pinned in Task 2 (`a login from another address is refused`).
4. **Shares that don't add up** (`sharePercent` sum 120, a share on one camera only, a share of 0): sum > 100 is a config error naming the cameras; one share alone leaves the rest to the others; 0 is "nothing reserved". Pinned in Task 3 (`share rules`).
5. **A latest-still poll with a stale ETag while the camera is down**: answers `404 no_still` with the last `ts`, never a 304 for an image that is no longer current. Pinned in Task 11 (`down: 404 even with a matching ETag`).

---

## File structure

| File | Responsibility | Task |
|---|---|---|
| `src/stills/go2rtc.ts` | one process, many streams, API add/remove | 1 |
| `src/cameras/worker.ts` | grabber on the host go2rtc; latest frame; PoE port handle | 1, 7, 11 |
| `src/clips/ftp-server.ts`, `src/clips/side.ts` | users per camera, source check | 2 |
| `src/storage.ts`, `src/config/schema.ts` (`sharePercent`) | per-camera units, shares | 3 |
| `src/recordings/cache.ts`, `src/recordings/pool.ts` (new) | one LRU over every camera's cache | 4 |
| `src/analytics/service.ts`, schema `perCameraDailyCap` | per key; per-camera cap | 5 |
| `src/camera/switch/driver.ts` (new), `src/camera/switch/sscpoe-web.ts` (new) | driver interface; GPS-208 driver | 6 |
| `src/camera/poe-switch.ts` | host controller, FIFO, per-port state | 7 |
| `src/compose/jobs.ts` | `composition.concurrent` | 8 |
| `src/api/control-api.ts`, `src/api/camera-control.ts` (new) | camera routes | 9 |
| `src/config/legacy.ts`, `src/config/load.ts`, `src/proxy.ts` | cameras added/removed in overrides; reconcile | 10 |
| `src/api/client-api.ts`, `src/api/latest-api.ts` (new) | latest still | 11 |
| `src/health/host.ts` | `k10temp` `Tctl` | 12 |
| `web/src/...` | per-camera settings and actions, add camera, splits | 13 |
| `test/multi-host.test.ts` (new), `e2e/multi/*` | four cam-sims | 14 |
| docs | | 15 |

## Rulings (spec gaps decided here)

- **Ruling P2-1: streams added after go2rtc started carry the camera password in the API call** (`PUT /api/streams?name=…&src=rtsp://user:<pw>@…` on 127.0.0.1); at the next go2rtc (re)spawn every stream moves into the 0600 config with `${CAM_<ID>_PASSWORD}` — spec §8.5 wants env variables, spec §3.3 wants runtime adds without a restart; an environment can't change after spawn — cost if wrong: a password on the loopback API of a process we own (never logged; the API listens on 127.0.0.1 only).
- **Ruling P2-2: a camera without a share gets an equal part of what the shares leave** (`(100 − Σ shares) / cameras without a share`) for the "most above its share" choice — spec §8.1 says "the rest shared" without saying how it is split — cost if wrong: eviction order among unshared cameras differs slightly.
- **Ruling P2-3: `switch_busy` stays HTTP 409** — spec §8.4 says "`503 switch_busy` as today", but today's code answers 409 (`src/api/control-api.ts`, `switchFail`); clients and the UI handle 409 — cost if wrong: one status code differs from the spec text.
- **Ruling P2-4: the FTP source-address check compares the camera's `host` (without its port) with the session's address**, IPv4-mapped prefix removed; a `host` that is a name (or empty) turns the check off for that camera — spec §7 — cost if wrong: none.
- **Ruling P2-5: a camera added in the UI lives in overrides.json** (`cameras.<id>` with at least `host`), appended after the config.json cameras, sorted by id (overrides.json is an object, and integer-like keys would reorder; sorting is the stable rule); `DELETE /control/config/cameras.<id>` removes it (only one added this way); a config.json camera answers `400 invalid` "defined in config.json" — spec §6.3 — cost if wrong: none.
- **Ruling P2-6: removing a camera stops its worker and removes its go2rtc streams; its files stay** and age out by retention (spec §5.2); its catalog rows stay too — cost if wrong: none (a "forget camera data" action is later work per the spec).
- **Ruling P2-7: the 10 s switch read cache serves `poe-switch-read` and the status block**, never a power-cycle or PoE-on (those always read fresh inside their session) — spec §8.4 "one read serves every camera's status (cached 10 s)" — cost if wrong: none.
- **Ruling P2-8: `perCameraDailyCap` counts the automatic analyses and the still checks of the camera together** (both are `google-vision` calls of that camera) — spec §8.2 is silent — cost if wrong: still checks might deserve their own count; `checksPerDay` already bounds them.

---

### Task 1: One go2rtc for the host, two streams per camera

**Files:**
- Modify: `src/stills/go2rtc.ts`
- Modify: `src/cameras/worker.ts` (no own go2rtc; registers its streams)
- Modify: `src/proxy.ts` (one `Go2rtc`, started before the workers)
- Modify: `test/go2rtc.test.ts` (new constructor), `test/helpers/multi.ts` (one port pair again)
- Test: `test/go2rtc-host.test.ts` (new)

**Interfaces:**
- Consumes: `Backoff` (P1 Task 9).
- Produces (`src/stills/go2rtc.ts`):

```ts
export interface StreamSource { cam: string; host: string; port: number; user: string; password: string }
export const passwordEnv = (cam: string): string;                 // CAM_<ID>_PASSWORD (upper, - → _)
export function go2rtcConfig(o: { rtspPort: number; apiPort: number }, sources: StreamSource[]): string;  // JSON, no password in it
export class Go2rtc extends EventEmitter {
  constructor(o: { binary?: string; rtspPort: number; apiPort: number; sources: () => StreamSource[] });
  streamUrl(cam: string, stream: 'sub' | 'main'): string;
  up(): boolean; pid(): number | undefined;
  ready(): Promise<void>;                                          // resolves once the API answers (after start)
  start(): Promise<void>;
  setStream(src: StreamSource): Promise<void>;                     // add or replace both streams of a camera, no restart
  removeStream(cam: string): Promise<void>;
  streams(): Promise<Record<string, { producers: unknown[]; consumers: unknown[] }>>;
  stop(): Promise<void>;
}
```
- Worker: `WorkerDeps` loses nothing it had but gains `go2rtc: () => Go2rtc | undefined` and `source(): StreamSource` is a worker method; `StillsSide` becomes `{ go2rtc: Go2rtc; grabber; store }` with the host's `Go2rtc`.

- [ ] **Step 1: Write the failing tests**

Create `test/go2rtc-host.test.ts`:

```ts
import { execFile } from 'child_process';
import { promisify } from 'util';
import { afterEach, describe, expect, it } from 'vitest';
import { freePort } from './helpers/proxy';
import { Go2rtc, go2rtcConfig, passwordEnv, type StreamSource } from '../src/stills/go2rtc';

const run = promisify(execFile);
const binary = process.env.CAMPROXY_TEST_GO2RTC;
const src = (cam: string, password = `pw-${cam}`): StreamSource => ({ cam, host: '127.0.0.1', port: 9, user: 'proxy', password });
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});

describe('go2rtc config (spec §8.5)', () => {
  it('two streams per camera; each password only as its env variable', () => {
    const text = go2rtcConfig({ rtspPort: 1, apiPort: 2 }, [src('cam3', 's3cr3t!'), src('cam-4', 'x')]);
    const cfg = JSON.parse(text);
    expect(Object.keys(cfg.streams)).toEqual(['cam3_sub', 'cam3_main', 'cam-4_sub', 'cam-4_main']);
    expect(cfg.streams.cam3_sub).toBe('rtsp://proxy:${CAM_CAM3_PASSWORD}@127.0.0.1:9/h264Preview_01_sub');
    expect(cfg.streams['cam-4_main']).toBe('rtsp://proxy:${CAM_CAM_4_PASSWORD}@127.0.0.1:9/h264Preview_01_main');
    expect(text).not.toContain('s3cr3t');
    expect(passwordEnv('cam-4')).toBe('CAM_CAM_4_PASSWORD');
  });
});

describe.skipIf(!binary)('one go2rtc, many cameras', () => {
  it('starts with every camera, adds and removes one without a restart', async () => {
    let sources = [src('cam3'), src('cam4')];
    const g = new Go2rtc({ binary, rtspPort: await freePort(), apiPort: await freePort(), sources: () => sources });
    cleanup.push(() => g.stop());
    await g.start();
    const pid = g.pid();
    expect(Object.keys(await g.streams()).sort()).toEqual(['cam3_main', 'cam3_sub', 'cam4_main', 'cam4_sub']);
    sources = [...sources, src('cam5')];
    await g.setStream(src('cam5'));
    await g.removeStream('cam4');
    expect(Object.keys(await g.streams()).sort()).toEqual(['cam3_main', 'cam3_sub', 'cam5_main', 'cam5_sub']);
    expect(g.pid()).toBe(pid);
    const { stdout } = await run('ps', ['-o', 'args=', '-p', String(pid)]);
    expect(stdout).not.toContain('pw-cam3');
  }, 30_000);
});
```

In `test/go2rtc.test.ts` the constructor becomes `new Go2rtc({ binary, rtspPort, apiPort, sources: () => [{ cam: 'cam1', host: '127.0.0.1', port: sim.ports.rtsp, user: 'proxy', password: sim.password }] })` and `g.streamUrl('sub')` becomes `g.streamUrl('cam1', 'sub')`.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/go2rtc-host.test.ts`
Expected: FAIL with `go2rtcConfig is not a function`.

- [ ] **Step 3: Implement `src/stills/go2rtc.ts`**

Replace the options, `PASS_ENV`, `config()`, `spawn()`'s environment and the log cleaning, and add the API calls:

```ts
export interface StreamSource { cam: string; host: string; port: number; user: string; password: string }
interface Go2rtcOptions { binary?: string; rtspPort: number; apiPort: number; sources: () => StreamSource[] }

// Each camera's password reaches go2rtc only through its own environment
// variable (spec 2026-10-05-multi-camera-host-design §8.5).
export const passwordEnv = (cam: string): string => `CAM_${cam.toUpperCase().replace(/-/g, '_')}_PASSWORD`;
const rtsp = (s: StreamSource, pass: string, path: string) => `rtsp://${encodeURIComponent(s.user)}:${pass}@${s.host}:${s.port}/${path}`;
const PATHS = { sub: 'h264Preview_01_sub', main: 'h264Preview_01_main' } as const;

export function go2rtcConfig(o: { rtspPort: number; apiPort: number }, sources: StreamSource[]): string {
  const streams: Record<string, string> = {};
  for (const s of sources) {
    streams[`${s.cam}_sub`] = rtsp(s, `\${${passwordEnv(s.cam)}}`, PATHS.sub);
    streams[`${s.cam}_main`] = rtsp(s, `\${${passwordEnv(s.cam)}}`, PATHS.main);
  }
  return JSON.stringify({
    api: { listen: `127.0.0.1:${o.apiPort}` },
    rtsp: { listen: `127.0.0.1:${o.rtspPort}` },
    webrtc: { listen: '' },
    srtp: { listen: '' },
    log: { level: 'warn' },
    streams,
  });
}
```

In the class:
- `streamUrl(cam: string, stream: 'sub' | 'main')` → `rtsp://127.0.0.1:${this.o.rtspPort}/${cam}_${stream}`.
- `spawn()`: `const sources = this.o.sources(); writeFileSync(file, go2rtcConfig(this.o, sources), { mode: 0o600 });` and the environment `{ PATH: process.env.PATH ?? '', ...Object.fromEntries(sources.map((s) => [passwordEnv(s.cam), encodeURIComponent(s.password)])) }`. The output cleaning replaces every source's password and its encoded form: `const secrets = sources.flatMap((s) => [s.password, encodeURIComponent(s.password)]).filter((x) => x.length >= 3); const clean = (d: Buffer) => secrets.reduce((t, x) => t.replaceAll(x, '***'), String(d).trim());`.
- The restart delay uses `Backoff` (P1 Task 9): replace `backoff` arithmetic with `private readonly backoff = new Backoff();`, `setTimeout(…, this.backoff.next())` on exit and `this.backoff.reset()` once ready (spec §3.3: the host restarts go2rtc with the same backoff).
- `ready()`: a promise resolved by `setReady(true)` (keep one pending promise; a new one after `setReady(false)`).
- The API calls:

```ts
  private call(method: 'PUT' | 'DELETE', query: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: this.o.apiPort, path: `/api/streams?${query}`, method, timeout: 5000 }, (res) => {
        res.resume();
        res.on('end', () => (res.statusCode && res.statusCode < 300 ? resolve() : reject(new Error(`go2rtc ${method} streams: HTTP ${res.statusCode}`))));
      });
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', reject);
      req.end();
    });
  }

  // Adds (or replaces) a camera's two streams through the API: no restart
  // (Ruling P2-1: the password travels in the loopback API call; at the next
  // spawn it is in the 0600 config as an environment variable instead).
  async setStream(s: StreamSource): Promise<void> {
    await this.ready();
    for (const kind of ['sub', 'main'] as const) {
      const name = `${s.cam}_${kind}`;
      await this.call('DELETE', `src=${encodeURIComponent(name)}`).catch(() => undefined); // absent: fine
      await this.call('PUT', `name=${encodeURIComponent(name)}&src=${encodeURIComponent(rtsp(s, encodeURIComponent(s.password), PATHS[kind]))}`);
    }
  }

  async removeStream(cam: string): Promise<void> {
    await this.ready();
    for (const kind of ['sub', 'main'] as const) await this.call('DELETE', `src=${encodeURIComponent(`${cam}_${kind}`)}`).catch(() => undefined);
  }
```

(Check the API shape against the installed binary once: `tools/go2rtc` with a minimal config, `curl -X PUT 'http://127.0.0.1:<api>/api/streams?name=x&src=rtsp://h/p'` then `curl http://127.0.0.1:<api>/api/streams` lists `x`; `curl -X DELETE 'http://127.0.0.1:<api>/api/streams?src=x'` removes it. If the binary wants another parameter, the integration test of Step 1 fails here; fix `setStream`/`removeStream` to the binary's API, never the test.)

- [ ] **Step 4: The worker and the proxy**

`src/cameras/worker.ts`: `WorkerDeps` gains `go2rtc: () => Go2rtc | undefined`; remove the per-worker `new Go2rtc(…)` and Ruling P1-1's offset; add

```ts
  // This camera's stream source for the host's go2rtc.
  source(): StreamSource {
    const c = this.cam();
    return { cam: this.id, host: splitHost(c.host).hostname, port: c.rtspPort, user: c.user, password: this.d.password() };
  }
```

In `build()`, with stills enabled: `const go2rtc = this.d.go2rtc(); if (!go2rtc) { logger.error({ cameraId: this.id }, 'go2rtc_missing'); } else { …grabber with input: go2rtc.streamUrl(this.id, s.stream)… this.stills = { go2rtc, grabber, store }; }`. `startStills()` waits for `s.go2rtc.ready()` instead of starting go2rtc; `stopStills()` no longer stops go2rtc. `restart()` re-registers the source when it changed: keep `private registered: string | undefined` (`JSON.stringify(source)` without the password — compare `{host, port, user}` plus a hash of the password: `createHash('sha256').update(pw).digest('hex')`), and when it differs call `await this.d.go2rtc()?.setStream(this.source())` before `startParts()`.

`src/proxy.ts`: before the workers,

```ts
  // One go2rtc for every camera with stills (spec §8.5); none when stills are off everywhere.
  const stillsCams = () => cams.list().filter((w) => w.cam().stills.enabled);
  const go2rtc = cameraIds(running).some((id) => cameraConfig(running, id)!.stills.enabled) && running.go2rtc.binary
    ? new Go2rtc({ binary: running.go2rtc.binary, rtspPort: running.go2rtc.rtspPort, apiPort: running.go2rtc.apiPort, sources: () => stillsCams().map((w) => w.source()) })
    : undefined;
```

pass `go2rtc: () => go2rtc` to each worker; in `start()` call `await go2rtc?.start()` before the workers start (a failure is logged, not thrown: `go2rtc?.start().catch((err: Error) => logger.error({ err: err.message }, 'go2rtc_start_failed'))`); in `doStop()` after the workers stopped: `await go2rtc?.stop()`. The metrics' `go2rtc_up` reads `go2rtc?.up()`.

`test/helpers/multi.ts` and `e2e/multi/start.ts`: the P1 port blocks are no longer needed (`freePort()` each, and `18800`/`18850` stay valid).

- [ ] **Step 5: Run the tests**

Run: `npx vitest run test/go2rtc-host.test.ts test/go2rtc.test.ts test/camera-worker.test.ts test/stills-api.test.ts test/multi-camera.test.ts test/proxy.test.ts && npm run lint:types && npm test`
Expected: all pass (go2rtc-dependent tests run when `CAMPROXY_TEST_GO2RTC` is set, as in CI).

- [ ] **Step 6: Commit**

```bash
git add src/stills/go2rtc.ts src/cameras/worker.ts src/proxy.ts test/go2rtc-host.test.ts test/go2rtc.test.ts test/helpers/multi.ts e2e/multi/start.ts
git commit -m "feat(stills): one go2rtc for the host, streams added and removed at runtime"
```

---

### Task 2: One FTP server, a user per camera, the source-address check

**Files:**
- Modify: `src/clips/ftp-server.ts` (users map, source check, upload carries the camera)
- Modify: `src/clips/side.ts` (indexer per camera; status per camera)
- Modify: `src/cameras/worker.ts` (`ftpIndexer()`)
- Modify: `src/config/load.ts` (lift Ruling P1-2; passive range and unique users)
- Modify: `src/audit/actions.ts` (`ftp-login-refused`)
- Modify: `src/proxy.ts` (one clips side for every camera)
- Test: `test/ftp-server.test.ts` (extend), `test/config-legacy.test.ts` (update the P1-2 test)

**Interfaces:**
- Produces:
  - `FtpServerOptions.users: () => Map<string, { cam: string; ip?: string }>` replaces `user`; `Upload` gains `user: string; cam: string`; event `'refused'` with `{ user: string; ip: string; expected: string }`.
  - `createClipsSide(d: { config: Config; password: string; users: () => Map<string, { cam: string; ip?: string }>; indexer: (cam: string) => ClipIndexer | undefined; accept: () => boolean; onRefused?: (r: { user: string; ip: string; expected: string }) => void })`; `ClipsSide` gets `lastUpload(cam?: string)`, `uploadFailures(cam?: string)`.
  - `export function ftpUsers(c: Config): Map<string, { cam: string; ip?: string }>` in `src/clips/side.ts` (cameras with FTP on).

- [ ] **Step 1: Write the failing tests**

Append to `test/ftp-server.test.ts` (it starts an `FtpServer` with test TLS and a `basic-ftp` client; follow its existing `start…`/`client…` helpers, passing `users` instead of `user`):

```ts
describe('a user per camera (spec §7)', () => {
  it('each camera logs in as its own user; the upload names the camera', async () => {
    const { server, port } = await startServer({ users: () => new Map([['cam3', { cam: 'cam3' }], ['cam4', { cam: 'cam4' }]]) });
    const got: { cam: string; user: string }[] = [];
    server.on('upload', (u: { cam: string; user: string }) => got.push({ cam: u.cam, user: u.user }));
    await upload(port, 'cam4', 'Mp4Record/2026-10-05/RecS02_20261005_120000_120010_0.mp4');
    expect(got).toEqual([{ cam: 'cam4', user: 'cam4' }]);
  });

  it('a login from another address is refused (530) and reported', async () => {
    const { server, port } = await startServer({ users: () => new Map([['cam3', { cam: 'cam3', ip: '192.168.60.13' }]]) });
    const refused: unknown[] = [];
    server.on('refused', (r: unknown) => refused.push(r));
    await expect(upload(port, 'cam3', 'a.mp4')).rejects.toThrow(/530/);
    expect(refused).toEqual([{ user: 'cam3', ip: '127.0.0.1', expected: '192.168.60.13' }]);
  });

  it('an unknown user is refused like a wrong password', async () => {
    const { port } = await startServer({ users: () => new Map([['cam3', { cam: 'cam3' }]]) });
    await expect(upload(port, 'cam9', 'a.mp4')).rejects.toThrow(/530/);
  });
});
```

(`startServer(over)` and `upload(port, user, path)` are the test file's helpers for "start a server" and "log in with the shared password and STOR one small file"; if the file inlines them, extract them first in the same step, keeping its existing tests as they are.)

In `test/config-legacy.test.ts`, replace the P1 test `FTP on for two cameras is refused until P2` with:

```ts
  it('FTP for several cameras: unique users, ≥ 10 passive ports per camera', () => {
    write('config.json', { ...two, ftp: { enabled: true, passive: '50000-50019' } });
    expect(cameraIds(load({ CAMPROXY_FTP_PASSWORD: 'f' }).config)).toEqual(['cam3', 'cam4']);
    write('config.json', { ...two, ftp: { enabled: true, passive: '50000-50009' } });
    expect(err(() => load({ CAMPROXY_FTP_PASSWORD: 'f' }))).toBe('ftp.passive: 10 ports for 2 cameras with FTP; at least 10 per camera');
    write('config.json', { ftp: { enabled: true, passive: '50000-50019' }, cameras: [{ id: 'cam3', ftp: { user: 'cam' } }, { id: 'cam4', ftp: { user: 'cam' } }] });
    expect(err(() => load({ CAMPROXY_FTP_PASSWORD: 'f' }))).toBe('cameras: cam3 and cam4 both use the FTP user cam');
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/ftp-server.test.ts test/config-legacy.test.ts`
Expected: FAIL — `users` is not an option yet; the config test hits the P1-2 error.

- [ ] **Step 3: Implement the server**

In `src/clips/ftp-server.ts`: `FtpServerOptions.user` → `users: () => Map<string, { cam: string; ip?: string }>`; `Session` gains `cam?: string`; `Upload` gains `user: string; cam: string`. The `PASS` case:

```ts
        const entry = s.user !== undefined ? this.o.users().get(s.user) : undefined;
        if (entry && same(arg, this.o.password)) {
          // Defence in depth (spec §7, Ruling P2-4): a camera with an IP
          // address logs in from that address only.
          if (entry.ip && entry.ip !== ip) {
            this.failures.set(ip, [...this.recentFailures(ip), this.now()]);
            this.log(`login for ${s.user} from ${ip} refused (camera address ${entry.ip})`);
            this.emit('refused', { user: s.user, ip, expected: entry.ip });
            return reply('530 Login incorrect');
          }
          if ([...this.sessionsOpen].filter((x) => x.authed).length >= (this.o.maxSessions ?? 4 * Math.max(1, this.o.users().size))) {
            reply('421 Too many sessions');
            return void s.stream.end();
          }
          this.failures.delete(ip);
          s.authed = true;
          s.cam = entry.cam;
          this.arm(s);
          return reply('230 Logged in');
        }
        this.failures.set(ip, [...this.recentFailures(ip), this.now()]);
        return reply('530 Login incorrect');
```

and the `upload` emit adds `user: s.user!, cam: s.cam!`. (Each camera holds up to two sessions — MP4 and JPEG — so the default session cap scales with the users.)

- [ ] **Step 4: The clips side, the worker, the proxy, the config checks**

`src/clips/side.ts`:

```ts
// The FTP users (spec §7): every camera with FTP on, by its user; the source
// address when the camera's host is an IPv4 address (Ruling P2-4).
export function ftpUsers(c: Config): Map<string, { cam: string; ip?: string }> {
  const m = new Map<string, { cam: string; ip?: string }>();
  for (const id of cameraIds(c)) {
    const cam = cameraConfig(c, id)!;
    if (!cam.ftp.enabled) continue;
    const host = bareHost(splitHost(cam.host).hostname);
    m.set(cam.ftp.user, { cam: id, ...(/^\d{1,3}(\.\d{1,3}){3}$/.test(host) ? { ip: host } : {}) });
  }
  return m;
}
```

`createClipsSide` takes the deps of **Interfaces**; per-camera `last`/`failures` maps; on `upload`: `const ix = d.indexer(u.cam); if (!ix || !d.accept()) { …count a failure for u.cam, discard via any indexer or unlink u.tmpFile… } else void ix.add(u);`; `server.on('refused', d.onRefused)`. `lastUpload(cam?)` and `uploadFailures(cam?)` answer the camera's (or the total without an argument).

`src/cameras/worker.ts`: `ftpIndexer(): ClipIndexer | undefined` — built in `build()` when `cam().ftp.enabled` and the FTP password is set (`WorkerDeps.ftpPassword: () => string | undefined`), with the `relinkSnapshots()` call that `buildClips` has in P1; `undefined` otherwise.

`src/proxy.ts`: `buildClips()` builds one side when any camera has FTP on:

```ts
    clips = createClipsSide({ config: running, password: loaded.secrets.ftpPassword, users: () => ftpUsers(running), indexer: (cam) => cams.get(cam)?.ftpIndexer(), accept: () => !storage.paused(),
      onRefused: (r) => { const t = ftpRefusals.take(r.ip, r.user); if (t.record) audit.write({ action: 'ftp-login-refused', category: ['authentication'], type: ['denied'], outcome: 'failure', ip: r.ip, camera: ftpUsers(running).get(r.user)?.cam, message: `FTP login as ${r.user} from ${r.ip} refused: the camera is at ${r.expected}`, details: { user: r.user, expected: r.expected, ...(t.suppressed ? { suppressed: t.suppressed } : {}) } }); } });
```

(`const ftpRefusals = new RefusalThrottle();` next to `refusals`.) `ftpStatusOf(w)` (P1 Task 14) uses `clips?.side.lastUpload(w.id)`, `uploadFailures(w.id)` and `w.ftpIndexer()?.lastIndexed()`, and `clips: countClips` of that camera now that several cameras may have FTP (keep `countAllClips` when exactly one camera is configured: the Pi's number). Add `'ftp-login-refused'` to `AUDIT_ACTIONS` in `src/audit/actions.ts` (after `'auth-refused'`).

`src/config/load.ts` `crossCheck`: delete the P1-2 rule; add

```ts
  const ftpCams = c.cameraOrder.filter((id) => cameraConfig(c, id)!.ftp.enabled);
  const seen = new Map<string, string>();
  for (const id of ftpCams) {
    const user = cameraConfig(c, id)!.ftp.user;
    if (seen.has(user)) throw new ConfigError(`cameras: ${seen.get(user)} and ${id} both use the FTP user ${user}`);
    seen.set(user, id);
  }
  const [a, b] = c.ftp.passive.split('-').map(Number);
  if (ftpCams.length > 1 && b - a + 1 < 10 * ftpCams.length) throw new ConfigError(`ftp.passive: ${b - a + 1} ports for ${ftpCams.length} cameras with FTP; at least 10 per camera`);
```

(keep the existing `A-B` range check before it; a single FTP camera keeps today's rules, so the Pi's `30000-30009` stays valid).

- [ ] **Step 5: Run the tests**

Run: `npx vitest run test/ftp-server.test.ts test/config-legacy.test.ts test/camera-ftp.test.ts test/ftp-health.test.ts test/ftp-health-api.test.ts test/clips-indexer.test.ts test/audit-actions.test.ts && npm run lint:types && npm test`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/clips src/cameras/worker.ts src/config/load.ts src/audit/actions.ts src/proxy.ts test/ftp-server.test.ts test/config-legacy.test.ts
git commit -m "feat(ftp): one server for every camera, a user each, logins only from the camera's address"
```

---

### Task 3: Storage: per-camera accounting and optional shares

**Files:**
- Modify: `src/storage.ts`
- Modify: `src/config/schema.ts` (`cameras[].storage.sharePercent`), `src/config/defaults.ts` (`CameraNode.storage`), `src/config/cameras.ts` (`ResolvedCamera.storage`), `src/config/load.ts` (sum ≤ 100)
- Modify: `src/cameras/worker.ts`, `src/proxy.ts` (`noteWritten` with the camera)
- Modify: `src/api/metrics.ts` (storage gauges per camera; `events_stored` per camera)
- Test: `test/storage-shares.test.ts` (new)

**Interfaces:**
- Produces:
  - `Storage.noteWritten(kind, bytes, files, o?: { growth?: boolean; cam?: string })`.
  - `Storage.usageByCamera(): Record<string, Record<'stills' | 'previews' | 'clips' | 'recordings', { bytes: number; files: number }>>`.
  - `export function shareBytes(c: Config, budget: number): Map<string, number>` in `src/storage.ts` (Ruling P2-2).
  - `ResolvedCamera.storage: { sharePercent?: number }`.
  - `eventsStoredByCamera(c: Catalog): Record<string, Record<string, number>>` in `src/api/metrics.ts`.

- [ ] **Step 1: Write the failing test**

Create `test/storage-shares.test.ts`:

```ts
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { describe, expect, it } from 'vitest';
import { openCatalog } from '../src/catalog/db';
import { cameraDefaults, DEFAULTS, type Config } from '../src/config/defaults';
import { minutePath } from '../src/stills/store';
import { shareBytes, Storage } from '../src/storage';
import { StreamLog } from '../src/stream/log';

const HOUR = 3600_000;
const NOW = Date.UTC(2026, 9, 5, 12, 0);

function setup(shares: Record<string, number | undefined>) {
  const dir = mkdtempSync(join(tmpdir(), 'camproxy-shares-'));
  const catalog = openCatalog(join(dir, 'catalog.sqlite'));
  const log = new StreamLog(catalog, () => NOW);
  const config: Config = structuredClone(DEFAULTS);
  config.server.dataDir = dir;
  config.cameraOrder = Object.keys(shares);
  config.cameras = Object.fromEntries(Object.entries(shares).map(([id, p]) => [id, { ...cameraDefaults(id), storage: p === undefined ? {} : { sharePercent: p } }]));
  config.storage = { maxBytes: 12_000, minFreeBytes: 0, keepHours: { stills: 0, clips: 0, previews: 0 } };
  // The catalog's own size counts against the budget: left out here, so the numbers stay exact.
  const storage = new Storage({ catalog: { ...catalog, sizeBytes: () => 0 }, log, config: () => config, now: () => NOW, statfs: () => ({ free: 1e12, size: 2e12 }) });
  const put = (cam: string, ts: number, bytes: number) => {
    const file = `${minutePath(dir, 'stills', cam, ts)}.pack`;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, Buffer.alloc(bytes));
  };
  return { config, storage, put, catalog };
}

describe('storage shares (spec §8.1)', () => {
  it('share rules: one share alone leaves the rest to the others; 0 reserves nothing (Ruling P2-2)', () => {
    const { config } = setup({ cam3: 50, cam4: undefined, cam5: 0 });
    expect(Object.fromEntries(shareBytes(config, 1000))).toEqual({ cam3: 500, cam4: 500, cam5: 0 });
    const none = setup({ cam3: undefined, cam4: undefined }).config;
    expect(Object.fromEntries(shareBytes(none, 1000))).toEqual({ cam3: 500, cam4: 500 });
  });

  it('with shares: the camera most above its share loses its oldest hour first', () => {
    const { storage, put, catalog } = setup({ cam3: 75, cam4: 25 });
    // cam3: 4 h × 1000 = 4000 (share 9000); cam4: 10 h × 1000 = 10000 (share 3000). Budget 12000: cam4 loses 2 hours.
    for (let h = 1; h <= 4; h++) put('cam3', NOW - h * HOUR - 20 * HOUR, 1000); // cam3's are the oldest of all
    for (let h = 1; h <= 10; h++) put('cam4', NOW - h * HOUR, 1000);
    const r = storage.run({});
    expect(r.reason).toContain('budget');
    const by = storage.usageByCamera();
    expect(by.cam3.stills.files).toBe(4); // untouched although oldest
    expect(by.cam4.stills.files).toBe(8);
    catalog.close();
  });

  it('without shares: the oldest hour across all cameras (fair by age)', () => {
    const { storage, put, catalog } = setup({ cam3: undefined, cam4: undefined });
    for (let h = 1; h <= 4; h++) put('cam3', NOW - h * HOUR - 20 * HOUR, 1000);
    for (let h = 1; h <= 10; h++) put('cam4', NOW - h * HOUR, 1000);
    storage.run({});
    expect(storage.usageByCamera().cam3.stills.files).toBe(2); // its two oldest hours went first
    expect(storage.usageByCamera().cam4.stills.files).toBe(10);
    catalog.close();
  });
});
```

Append to `test/config-legacy.test.ts`:

```ts
  it('storage.sharePercent: the sum may not exceed 100', () => {
    write('config.json', { cameras: [{ id: 'cam3', storage: { sharePercent: 70 } }, { id: 'cam4', storage: { sharePercent: 50 } }] });
    expect(err(() => load())).toBe('cameras: storage.sharePercent adds up to 120 % (cam3 70, cam4 50); at most 100');
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/storage-shares.test.ts test/config-legacy.test.ts`
Expected: FAIL — `shareBytes` is not exported; `storage: unknown setting`.

- [ ] **Step 3: Settings**

`CAMERA_NODE` gains

```ts
  storage: {
    sharePercent: unset(int(0, 100, "this camera's share of the storage budget, percent (all shares together at most 100)", true), 'no share: the camera has an equal part of what the shares leave'),
  },
```

`CameraNode` gains `storage: { sharePercent?: number }` (`cameraDefaults` → `storage: {}`), `ResolvedCamera` gains `storage: { sharePercent?: number }` (copied in `cameraConfig`), and `crossCheck`:

```ts
  const shared = c.cameraOrder.flatMap((id) => (c.cameras[id].storage?.sharePercent !== undefined ? [[id, c.cameras[id].storage.sharePercent!] as const] : []));
  const sum = shared.reduce((n, [, p]) => n + p, 0);
  if (sum > 100) throw new ConfigError(`cameras: storage.sharePercent adds up to ${sum} % (${shared.map(([id, p]) => `${id} ${p}`).join(', ')}); at most 100`);
```

- [ ] **Step 4: Storage**

In `src/storage.ts`:
- `interface Unit { ts: number; cam: string; files: … }`; `recount()` sets `cam` from the folder it walks; `recountRecordings()` too; `noteWritten(kind, bytes, files, o = {})` stores `cam: o.cam ?? ''` on a new unit (and only merges into the last unit when `cam` matches).
- Add:

```ts
// Each camera's share of the budget in bytes (spec §8.1, Ruling P2-2): its
// sharePercent, or an equal part of what the shares leave.
export function shareBytes(c: Config, budget: number): Map<string, number> {
  const ids = cameraIds(c);
  const own = new Map(ids.flatMap((id) => { const p = cameraConfig(c, id)!.storage.sharePercent; return p === undefined ? [] : [[id, p] as const]; }));
  const rest = Math.max(0, 100 - [...own.values()].reduce((a, b) => a + b, 0));
  const others = ids.filter((id) => !own.has(id));
  return new Map(ids.map((id) => [id, Math.floor((budget * (own.get(id) ?? rest / Math.max(1, others.length))) / 100)]));
}
```

- In `run()`, the budget loop:

```ts
    const shared = cameraIds(cfg).some((id) => cameraConfig(cfg, id)!.storage.sharePercent !== undefined);
    const usedBy = (cam: string) => KINDS.reduce((n, k) => n + sim[k].filter((u) => u.cam === cam).reduce((m, u) => m + unitBytes(u), 0), 0);
    // The oldest hour of one camera's kind, never its newest keepHours.
    const dropOldestHourOf = (kind: MinuteKind, cam: string): boolean => {
      const keepFrom = now - cfg.storage.keepHours[kind] * HOUR;
      const first = sim[kind].find((u) => u.cam === cam);
      if (!first || first.ts >= keepFrom) return false;
      const hour = Math.floor(first.ts / HOUR) * HOUR;
      sim[kind] = sim[kind].filter((u) => {
        const go = u.cam === cam && u.ts < hour + HOUR && u.ts < keepFrom;
        if (go) drop(kind, u);
        return !go;
      });
      return true;
    };
    const share = shared ? shareBytes(cfg, budget) : null;
    while (used() > budget) {
      let progressed = dropRecording();
      if (!progressed && share) {
        // The camera most above its share first, then the next (spec §8.1).
        const order = [...share.keys()].sort((a, b) => usedBy(b) - share.get(b)! - (usedBy(a) - share.get(a)!));
        progressed = order.some((cam) => BUDGET_ORDER.some((k) => dropOldestHourOf(k, cam)));
      }
      if (!progressed && !share) progressed = BUDGET_ORDER.some((k) => dropOldestHour(k));
      if (!progressed) {
        if (!reason.includes('budget_unreachable')) reason.push('budget_unreachable');
        break;
      }
      if (!reason.includes('budget')) reason.push('budget');
    }
```

(`sim` must be declared with `let`-able arrays per kind: it already is an object of arrays; assigning `sim[kind] = …` works. Keep the existing `dropRecording` and `dropOldestHour`.)

- `usageByCamera()`:

```ts
  usageByCamera(): Record<string, Record<FileKind, { bytes: number; files: number }>> {
    this.recountRecordings();
    const out: Record<string, Record<FileKind, { bytes: number; files: number }>> = {};
    for (const kind of KINDS) for (const u of this.units[kind]) {
      if (!u.cam) continue;
      const c = (out[u.cam] ??= { stills: { bytes: 0, files: 0 }, previews: { bytes: 0, files: 0 }, clips: { bytes: 0, files: 0 }, recordings: { bytes: 0, files: 0 } });
      c[kind].bytes += unitBytes(u);
      c[kind].files += u.files.length;
    }
    return out;
  }
```

- Callers of `noteWritten` pass the camera: the worker's store (`{ cam: this.id }`), the indexer's `stored` (`{ growth, cam: this.id }`), the recordings side (`noteWritten: (bytes) => d.storage.noteWritten('recordings', bytes, 1, { cam: this.id })`).

- [ ] **Step 5: Metrics**

`src/api/metrics.ts`: `stills_minutes_stored` and `previews_stored` loop `s.storage.usageByCamera()` (labels by camera); `events_stored` uses

```ts
export function eventsStoredByCamera(c: Catalog): Record<string, Record<string, number>> {
  const rows = c.db.prepare("SELECT cam, kind, COUNT(*) AS n FROM events WHERE source != 'recovered' GROUP BY cam, kind").all() as { cam: string; kind: string; n: number }[];
  const out: Record<string, Record<string, number>> = {};
  for (const r of rows) (out[r.cam] ??= {})[r.kind] = r.n;
  return out;
}
```

and sets `{ cam, kind }` for each. `/control/stats` adds `cameras: storage.usageByCamera()`.

- [ ] **Step 6: Run the tests**

Run: `npx vitest run test/storage-shares.test.ts test/storage.test.ts test/config-legacy.test.ts test/metrics-multi.test.ts && npm run lint:types && npm test`
Expected: all pass (the existing `storage.test.ts` budget tests are one camera: unchanged behaviour).

- [ ] **Step 7: Commit**

```bash
git add src/storage.ts src/config src/cameras/worker.ts src/proxy.ts src/api/metrics.ts src/api/control-api.ts test/storage-shares.test.ts test/config-legacy.test.ts
git commit -m "feat(storage): per-camera accounting and optional shares of the budget"
```

---

### Task 4: One recordings cache for every camera

**Files:**
- Create: `src/recordings/pool.ts`
- Modify: `src/recordings/cache.ts` (`pool` dep), `src/recordings/side.ts`, `src/cameras/worker.ts` (lift Ruling P1-3), `src/proxy.ts`
- Test: `test/recording-pool.test.ts` (new)

**Interfaces:**
- Produces:

```ts
export class CachePool {
  constructor(capBytes: () => number);
  add(c: RecordingCache): void;
  remove(c: RecordingCache): void;
  usage(): { bytes: number; files: number; capBytes: number };
  // Evicts least-recently-used files of any camera (never a pinned one) until
  // `incoming` fits beside everything kept; answers whether it fits.
  makeRoom(incoming: number): boolean;
  pinnedBytes(): number;
}
// RecordingCache deps gain `pool?: CachePool`: makeRoom/fits then go through the pool.
// createRecordingsSide deps gain `pool?: CachePool`.
```

- [ ] **Step 1: Write the failing test**

Create `test/recording-pool.test.ts`:

```ts
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { RecordingCache } from '../src/recordings/cache';
import { CachePool } from '../src/recordings/pool';

describe('one LRU over every camera (spec §8.3)', () => {
  it("evicts the oldest file of any camera, never a pinned one, within the host's cap", () => {
    const root = mkdtempSync(join(tmpdir(), 'camproxy-pool-'));
    const pool = new CachePool(() => 3000);
    const mk = (cam: string) => {
      const dir = join(root, cam);
      mkdirSync(dir, { recursive: true });
      const c = new RecordingCache({ dir: () => dir, capBytes: () => 3000, pool });
      pool.add(c);
      return { c, dir };
    };
    const a = mk('cam3');
    const b = mk('cam4');
    const file = (d: string, id: string, ageS: number) => {
      writeFileSync(join(d, id), Buffer.alloc(1000));
      const t = Date.now() / 1000 - ageS;
      utimesSync(join(d, id), t, t);
    };
    file(a.dir, 'RecA1.mp4', 300); // oldest
    file(b.dir, 'RecB1.mp4', 200);
    file(a.dir, 'RecA2.mp4', 100);
    expect(pool.usage()).toEqual({ bytes: 3000, files: 3, capBytes: 3000 });
    const unpin = b.c.pin(join(b.dir, 'RecB1.mp4'));
    expect(pool.makeRoom(2000)).toBe(true); // A1 and A2 go; B1 is pinned
    expect(pool.usage().files).toBe(1);
    unpin();
    expect(pool.makeRoom(3500)).toBe(false); // above the cap
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/recording-pool.test.ts`
Expected: FAIL with `Failed to resolve import "../src/recordings/pool"`.

- [ ] **Step 3: Implement**

Create `src/recordings/pool.ts`:

```ts
import { unlinkSync } from 'fs';
import type { RecordingCache } from './cache';

// The recordings cache of the host (spec 2026-10-05-multi-camera-host-design
// §8.3): every camera's folder counts against one cap, recordings.cacheMB,
// and the least recently used file of any camera goes first.
export class CachePool {
  private readonly caches = new Set<RecordingCache>();

  constructor(private readonly capBytes: () => number) {}

  add(c: RecordingCache): void {
    this.caches.add(c);
  }

  remove(c: RecordingCache): void {
    this.caches.delete(c);
  }

  private all() {
    return [...this.caches].flatMap((c) => c.files().map((f) => ({ ...f, cache: c }))).sort((a, b) => a.used - b.used);
  }

  usage(): { bytes: number; files: number; capBytes: number } {
    const f = this.all();
    return { bytes: f.reduce((n, x) => n + x.bytes, 0), files: f.length, capBytes: this.capBytes() };
  }

  pinnedBytes(): number {
    return this.all().filter((f) => f.cache.busy(f.path)).reduce((n, f) => n + f.bytes, 0);
  }

  makeRoom(incoming: number): boolean {
    const files = this.all();
    const cap = this.capBytes();
    let total = files.reduce((n, f) => n + f.bytes, 0) + [...this.caches].reduce((n, c) => n + c.partBytes(), 0);
    for (const f of files) {
      if (total + incoming <= cap) break;
      if (f.cache.busy(f.path)) continue;
      try {
        unlinkSync(f.path);
        total -= f.bytes;
      } catch {
        // gone
      }
    }
    return total + incoming <= cap;
  }
}
```

In `src/recordings/cache.ts`: the deps gain `pool?: CachePool`; `partBytes()` becomes public; `makeRoom(incoming)` starts with `if (this.d.pool) return this.d.pool.makeRoom(incoming);`; `fits(size)` with a pool: `return size <= this.capBytes() && this.d.pool.pinnedBytes() + size <= this.capBytes();`.

`src/recordings/side.ts`: deps gain `pool?: CachePool`, passed into `new RecordingCache({ dir: dirOf, capBytes: d.capBytes, pool: d.pool })`; `status()` reports `cache: d.pool ? d.pool.usage() : { ...cache.usage(), capBytes: d.capBytes() }` plus `camera: cache.usage()` (this camera's part).

`src/cameras/worker.ts`: `WorkerDeps.cachePool: CachePool`; `capBytes: () => d.running().recordings.cacheMB * 2 ** 20` (Ruling P1-3 removed); after creating the recordings side: `d.cachePool.add(this.recordings.cache)`; in `stop()`: `d.cachePool.remove(this.recordings.cache)`.

`src/proxy.ts`: `const cachePool = new CachePool(() => running.recordings.cacheMB * 2 ** 20);` passed to every worker; the health input's `recordingsCache` is `cachePool.usage()`.

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/recording-pool.test.ts test/recording-cache.test.ts test/recordings-side.test.ts test/recordings-api.test.ts test/camera-worker.test.ts && npm run lint:types && npm test`
Expected: all pass (`camera-worker.test.ts`'s "whole cap" test now reads `status().cache.capBytes` from the pool: same number).

- [ ] **Step 5: Commit**

```bash
git add src/recordings src/cameras/worker.ts src/proxy.ts test/recording-pool.test.ts test/camera-worker.test.ts
git commit -m "feat(recordings): one LRU cache for every camera, capped by recordings.cacheMB"
```

---

### Task 5: Vision: a budget per API key, a per-camera daily cap

**Files:**
- Modify: `src/analytics/service.ts`
- Modify: `src/config/schema.ts`, `src/config/defaults.ts` (`analytics.googleVision.perCameraDailyCap`)
- Modify: `web/src/components/AnalyticsSettings.svelte` (the several-hosts note), `web/src/lib/analytics.ts` (`UiProviderState.cameras`)
- Test: `test/analytics-per-key.test.ts` (new)

**Interfaces:**
- Consumes: `usageBetween(…, { keyIds, cam })`, `keyId` (P1 Task 1).
- Produces:
  - `Config['analytics']['googleVision'].perCameraDailyCap: number` (0 = none, default 0).
  - `ProviderState.cameras: { id: string; today: number; month: number }[]` (this key's calls per camera).
  - Refusals/skips with reason `'camera'` when a camera reached `perCameraDailyCap`.

- [ ] **Step 1: Write the failing test**

Create `test/analytics-per-key.test.ts`:

```ts
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { openCatalog } from '../src/catalog/db';
import { addUsage } from '../src/catalog/analyses';
import { insertEvent } from '../src/catalog/events';
import { DEFAULTS } from '../src/config/defaults';
import { AnalyticsService } from '../src/analytics/service';
import { keyId } from '../src/analytics/key-id';
import { localDay } from '../src/analytics/local-day';
import { StreamLog } from '../src/stream/log';

const T0 = Date.parse('2026-10-05T15:00:00Z');

function setup(key: { v: string }) {
  const dir = mkdtempSync(join(tmpdir(), 'camproxy-perkey-'));
  const c = openCatalog(join(dir, 'catalog.sqlite'));
  let now = T0 + 3000;
  const config = structuredClone(DEFAULTS);
  config.analytics.googleVision = { enabled: true, monthlyLimit: 3, dailyCap: 0, checksPerDay: 10, perCameraDailyCap: 0 };
  const calls: string[] = [];
  const s = new AnalyticsService({
    catalog: c, log: new StreamLog(c, () => now), dataDir: dir, cams: () => ['cam3', 'cam4'], config: () => config,
    secrets: () => ({ googleVisionKey: key.v, googleVisionUrl: 'http://mock' }),
    readStill: async (cam) => Buffer.from(cam), listStills: (_cam, f) => [f + 1000].filter((t) => t === T0 + 1000 || true),
    timeInfo: () => undefined, now: () => now, sleep: async (ms) => void (now += ms),
    provider: () => ({ id: 'google-vision', name: 'Google Vision', async analyze(j) { calls.push(j.toString()); return { objects: [], raw: {} }; } }),
  });
  const ev = (cam: string, t = T0) => insertEvent(c, { cam, source: 'onvif', kind: 'person', start_ts: t, raw: null });
  return { c, s, calls, config, ev, day: localDay(now, undefined) };
}

describe('Vision per key (spec §8.2)', () => {
  it('a new key starts a fresh month; legacy rows ("" key) count with the key in use', async () => {
    const key = { v: 'key-one-123456789' };
    const { c, s, calls, ev, day } = setup(key);
    addUsage(c, { provider: 'google-vision', keyId: keyId('key-one-123456789'), cam: 'cam3' }, day);
    addUsage(c, { provider: 'google-vision', keyId: keyId('key-one-123456789'), cam: 'cam3' }, day);
    addUsage(c, { provider: 'google-vision', keyId: '', cam: 'cam3' }, day);
    s.onEvent(ev('cam3'));
    await s.idle();
    expect(calls).toEqual([]); // 2 + 1 legacy = the limit of 3
    key.v = 'key-two-123456789';
    s.onEvent(ev('cam4', T0 + 5000));
    await s.idle();
    expect(calls).toEqual(['cam4']); // the new key: only the legacy row counts (1 of 3)
    expect(s.state()[0].month.calls).toBe(2);
  });

  it('perCameraDailyCap limits one camera; the others go on', async () => {
    const key = { v: 'key-one-123456789' };
    const { s, calls, config, ev } = setup(key);
    config.analytics.googleVision.monthlyLimit = 100;
    config.analytics.googleVision.perCameraDailyCap = 1;
    s.onEvent(ev('cam3'));
    s.onEvent(ev('cam3', T0 + 10_000));
    s.onEvent(ev('cam4', T0 + 20_000));
    await s.idle();
    expect(calls).toEqual(['cam3', 'cam4']);
    expect(s.state()[0].cameras).toEqual([{ id: 'cam3', today: 1, month: 1 }, { id: 'cam4', today: 1, month: 1 }]);
    const r = await s.check('cam3', T0 + 1000, 'token');
    expect(r).toMatchObject({ outcome: 'refused', status: 429, error: 'limit', reason: 'camera' });
  });
});
```

(`listStills` in the fake answers one still per request window so every event finds one; the second assertion of the first test reads the month count of the new key including the legacy row.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/analytics-per-key.test.ts`
Expected: FAIL — the first test makes a call (limits sum every key), `cameras` is undefined.

- [ ] **Step 3: Implement**

Settings: in `SETTINGS.analytics.googleVision` add `perCameraDailyCap: unset(int(0, 10000, 'Google Vision calls per camera and day at most (automatic analyses and still checks together); 0 = no per-camera cap'), 'no per-camera cap', 0)`; `Config` and `DEFAULTS` (`perCameraDailyCap: 0`).

`src/analytics/service.ts`:

```ts
  // The rows that count for the key in use (spec §8.2): its own and the
  // legacy rows from before the migration (key_id '').
  private keyIds(key = this.key()): string[] {
    return key ? [keyId(key), ''] : [''];
  }
  private monthUsage(day: string, cam?: string): number {
    return usageBetween(this.d.catalog, 'google-vision', `${day.slice(0, 7)}-01`, `${day.slice(0, 7)}-31`, { keyIds: this.keyIds(), ...(cam ? { cam } : {}) });
  }
  private dayUsage(provider: string, day: string, cam?: string): number {
    return usageBetween(this.d.catalog, provider, day, day, { keyIds: this.keyIds(), ...(cam ? { cam } : {}) });
  }
  private cameraCapReached(cam: string, day: string): boolean {
    const cap = this.settings().googleVision.perCameraDailyCap;
    return cap > 0 && this.dayUsage('google-vision', day, cam) >= cap;
  }
```

Replace every `usageBetween(this.d.catalog, X, day, day)` with `this.dayUsage(X, day)`; in `check()` after the daily-cap refusal add `if (this.cameraCapReached(cam, day)) return refuse(429, 'limit', { reason: 'camera' });`; in `run()`, the limit test becomes `if (this.monthUsage(day) >= g.monthlyLimit || (g.dailyCap > 0 && this.dayUsage('google-vision', day) >= g.dailyCap) || this.cameraCapReached(job.cam, day)) return this.skip(job, 'limit', stillTs);`; `state()` adds `cameras: this.d.cams().map((id) => ({ id, today: this.dayUsage('google-vision', day, id), month: this.monthUsage(day, id) }))`.

UI: `AnalyticsSettings.svelte` gets one line under the limits: "Each proxy counts only its own calls. Proxies that share a key share its budget: keep the sum of their monthly limits within it." and shows `perCameraDailyCap` with the other limits; the Status page's Vision card lists `cameras` (id, today, month) when there is more than one.

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/analytics-per-key.test.ts test/analytics-service.test.ts test/analytics-still-checks.test.ts test/analytics-config.test.ts test/analytics-ui.test.ts && npm run lint:types && npm test`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/analytics/service.ts src/config web/src/components/AnalyticsSettings.svelte web/src/lib/analytics.ts web/src/pages/Status.svelte config.schema.json test/analytics-per-key.test.ts
git commit -m "feat(analytics): one budget per API key; a per-camera daily cap"
```

(Run `npm run schema` before this commit: the setting is new.)

---

### Task 6: PoE: a driver per switch model

Extract the GPS-208 protocol behind an interface. No behaviour change: the existing `test/poe-switch.test.ts` and `test/camera-powercycle.test.ts` are the gate.

**Files:**
- Create: `src/camera/switch/driver.ts`, `src/camera/switch/sscpoe-web.ts`
- Modify: `src/camera/poe-switch.ts` (uses a driver)
- Create: `test/helpers/fake-switch.ts`
- Test: `test/switch-driver.test.ts` (new)

**Interfaces:**
- Produces (`src/camera/switch/driver.ts`):

```ts
export interface SwitchDetail { poe: boolean[]; watts: number[]; link: (boolean | null)[]; sn: string | null; firmware: string | null }  // by internal index
export interface SwitchSession {
  login(password: string): Promise<void>;
  relogin(password: string): Promise<void>;
  detail(): Promise<SwitchDetail>;
  setPoe(index: number, on: boolean): Promise<void>;   // throws SwitchRefusal when the switch said no
  logout(): Promise<void>;
}
export interface SwitchDriver {
  model: string;
  singleSession: boolean;                               // the switch takes one web session at a time
  open(host: string, timeoutMs: () => number): SwitchSession;
  portIndex(port: number, ports: number, sn: string): number;
}
export class SwitchRefusal extends PoeSwitchError {}    // moved from poe-switch.ts (PoeSwitchRefusal)
export function driverFor(model: string): SwitchDriver | undefined;
```
- `src/camera/switch/sscpoe-web.ts`: `export const sscpoeWeb: SwitchDriver` (today's `Session`, `reverseOrder`, `portIndex`, `poeOpcode`, `CMD`, the unreachable codes; `detail()` maps 101's `poec`/`pw`/`link|lnk`/`sn`/`V` to `SwitchDetail`).
- `PoeSwitchDeps` gains `driver?: (model: string) => SwitchDriver | undefined` (default `driverFor`).
- `test/helpers/fake-switch.ts`: `export function fakeSwitch(o?: { ports?: number; watts?: number }): { driver: SwitchDriver; poe: boolean[]; sessions: () => number; log: string[] }` — enforces one session at a time (a second `login` while one is open throws `PoeSwitchError('switch_busy', …)`).

- [ ] **Step 1: Write the failing test**

Create `test/helpers/fake-switch.ts`:

```ts
import { PoeSwitchError } from '../../src/camera/poe-switch';
import type { SwitchDriver, SwitchSession } from '../../src/camera/switch/driver';

// A switch in memory with the GPS-208's one-session rule (spec §8.4: P1/P2
// test the queue against a fake driver; the real switch is never used).
export function fakeSwitch(o: { ports?: number; watts?: number } = {}) {
  const n = o.ports ?? 8;
  const poe = Array.from({ length: n }, () => true);
  let open = 0;
  const log: string[] = [];
  const driver: SwitchDriver = {
    model: 'fake',
    singleSession: true,
    portIndex: (port) => port - 1,
    open(): SwitchSession {
      let mine = false;
      return {
        async login() {
          if (open > 0) throw new PoeSwitchError('switch_busy', 'someone is logged in');
          open++;
          mine = true;
          log.push('login');
        },
        async relogin() {},
        async detail() {
          log.push('detail');
          return { poe: [...poe], watts: poe.map((on) => (on ? (o.watts ?? 4.5) : 0)), link: poe.map(() => true), sn: 'FAKE', firmware: '1' };
        },
        async setPoe(index, on) {
          log.push(`poe ${index} ${on ? 'on' : 'off'}`);
          poe[index] = on;
        },
        async logout() {
          if (mine) open--;
          mine = false;
          log.push('logout');
        },
      };
    },
  };
  return { driver, poe, sessions: () => open, log };
}
```

Create `test/switch-driver.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { PoeSwitch } from '../src/camera/poe-switch';
import { driverFor } from '../src/camera/switch/driver';
import { fakeSwitch } from './helpers/fake-switch';

describe('a PoE switch driver per model (spec §8.4)', () => {
  it('sscpoe-web is the GPS-208 driver: one session, reversed ports on GPS2…', () => {
    const d = driverFor('sscpoe-web')!;
    expect(d.singleSession).toBe(true);
    expect(d.portIndex(8, 8, 'GPS208ABC')).toBe(0);
    expect(d.portIndex(8, 8, 'PS208G')).toBe(7);
    expect(driverFor('none')).toBeUndefined();
  });

  it('the controller works through any driver: a read and a power-cycle on the fake', async () => {
    const sw = fakeSwitch();
    const p = new PoeSwitch({ config: () => ({ model: 'sscpoe-web', host: 'fake', port: 3, ports: 8, offSeconds: 5 }), password: () => 'pw', driver: () => sw.driver, sleep: async () => undefined });
    expect((await p.read()).poe).toBe(true);
    const offs: number[] = [];
    await p.cycle((at) => offs.push(at));
    expect(sw.log.filter((l) => l.startsWith('poe'))).toEqual(['poe 2 off', 'poe 2 on']);
    expect(sw.sessions()).toBe(0);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/switch-driver.test.ts`
Expected: FAIL with `Failed to resolve import "../src/camera/switch/driver"`.

- [ ] **Step 3: Implement**

1. Create `src/camera/switch/driver.ts` with the interfaces of **Interfaces**, `export class SwitchRefusal extends PoeSwitchError {}`, and

```ts
import { sscpoeWeb } from './sscpoe-web';
const DRIVERS: Record<string, SwitchDriver> = { 'sscpoe-web': sscpoeWeb };
export const driverFor = (model: string): SwitchDriver | undefined => (Object.hasOwn(DRIVERS, model) ? DRIVERS[model] : undefined);
```

(import `PoeSwitchError` from `../poe-switch`; to avoid a cycle, move `PoeSwitchError` and `PoeSwitchErrorCode` into `src/camera/switch/errors.ts` and re-export them from `poe-switch.ts`.)

2. Create `src/camera/switch/sscpoe-web.ts`: move `reverseOrder`, `portIndex`, `poeOpcode`, `CMD`, `UNREACHABLE`, the `TIMEOUT` env name and the `Session` class here unchanged (its `setPoe` throws `SwitchRefusal` where it threw `PoeSwitchRefusal`), and add

```ts
// The STEAMEMO/SSCPOE local web protocol (GPS-208 and kin): see the header of
// poe-switch.ts for the measured calls. One web session at a time.
export const sscpoeWeb: SwitchDriver = {
  model: 'sscpoe-web',
  singleSession: true,
  portIndex,
  open(host, timeoutMs) {
    const s = new Session(host, timeoutMs);
    return {
      login: (pw) => s.login(pw),
      relogin: (pw) => s.relogin(pw),
      logout: () => s.logout(),
      setPoe: (i, on) => s.setPoe(i, on),
      async detail() {
        const d = await s.detail();
        const arr = (k: string) => (Array.isArray(d[k]) ? (d[k] as unknown[]) : []);
        const poec = arr('poec');
        const links = arr('link').length ? arr('link') : arr('lnk');
        return {
          poe: poec.map((x) => Number(x) === 1),
          watts: arr('pw').map((x) => (Number.isFinite(Number(x)) ? Number(x) : 0)),
          link: poec.map((_, i) => (links[i] === undefined ? null : Number(links[i]) > 0)),
          sn: typeof d.sn === 'string' && d.sn ? d.sn : null,
          firmware: typeof d.V === 'string' ? d.V : null,
        };
      },
    };
  },
};
```

Keep re-exports in `poe-switch.ts` for `reverseOrder`, `portIndex`, `poeOpcode`, `Session` (tests import them from there).

3. `src/camera/poe-switch.ts`: `open()` uses `const driver = (this.d.driver ?? driverFor)(c.model); if (!driver) throw new PoeSwitchError('switch_error', `no driver for ${c.model}`); const s = driver.open(c.host!, () => this.callTimeout(final));`; `reading(d: SwitchDetail, c, driver)` takes the structured detail:

```ts
  private reading(d: SwitchDetail, c: PoeSwitchConfig, driver: SwitchDriver): PortReading {
    const index = driver.portIndex(c.port!, c.ports, d.sn ?? '');
    if (index < 0 || index >= d.poe.length) throw new PoeSwitchError('switch_error', `port ${c.port} maps to index ${index}, outside the switch's ${d.poe.length} ports`);
    this.last = { at: this.now(), port: c.port!, index, poe: d.poe[index], watts: d.watts[index] ?? 0, link: d.link[index] ?? null, sn: d.sn, firmware: d.firmware };
    this.poeMaybeOff = !this.last.poe;
    return { ...this.last };
  }
```

and every `s.detail()` call site passes the driver along (`f(s, c, driver)` — the session callback type becomes `(s: SwitchSession, c: PoeSwitchConfig, driver: SwitchDriver) => Promise<T>`). `PoeSwitchRefusal` references become `SwitchRefusal`.

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/switch-driver.test.ts test/poe-switch.test.ts test/camera-powercycle.test.ts && npm run lint:types && npm test`
Expected: all pass — the GPS-208 tests against `poe-switch-mock.ts` unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/camera/switch src/camera/poe-switch.ts test/helpers/fake-switch.ts test/switch-driver.test.ts
git commit -m "refactor(poe): a switch driver per model; sscpoe-web is the GPS-208's"
```

---

### Task 7: PoE: one controller per host, a FIFO queue, per-port state

**Files:**
- Modify: `src/camera/poe-switch.ts` (controller with ports)
- Modify: `src/cameras/worker.ts` (a port handle instead of its own `PoeSwitch`; lift Ruling P1-4)
- Modify: `src/proxy.ts` (one controller; stop audits per camera)
- Modify: `test/poe-switch.test.ts` (constructor and `port` arguments)
- Test: `test/poe-queue.test.ts` (new)

**Interfaces:**
- Produces (`src/camera/poe-switch.ts`):

```ts
export interface HostSwitchConfig { model: 'none' | 'sscpoe-web'; host?: string; ports: number; offSeconds: number }
export class PoeSwitch {   // the host's controller (name kept: fewer changes)
  constructor(d: { config: () => HostSwitchConfig; password: () => string | undefined; driver?; sleep?; now?; timeoutMs?; onRetryMs?; stopRecoveryMs?; stopWaitMs?; readCacheMs?: number; queueWaitMs?: () => number });
  notConfigured(port?: number): string | null;
  status(port?: number): PoeSwitchStatus;               // per port: last reading, poeMaybeOff
  read(port: number, o?: { fresh?: boolean }): Promise<PortReading>;   // cached 10 s unless fresh (Ruling P2-7)
  cycle(port: number, onOff: (at: number) => void): Promise<CycleResult>;
  poeOn(port: number): Promise<PoeOnResult>;
  stop(): Promise<{ portsLeftOff: number[]; sessionMaybeOpen: boolean }>;
  forPort(port: () => number | undefined): PortHandle;
}
export interface PortHandle {
  notConfigured(): string | null; status(): PoeSwitchStatus;
  read(): Promise<PortReading>; cycle(onOff: (at: number) => void): Promise<CycleResult>; poeOn(): Promise<PoeOnResult>;
}
```
- The queue: requests run one at a time in arrival order; a request that waited longer than `queueWaitMs()` (default `(offSeconds + 60) * 1000`) fails with `switch_busy` (HTTP 409, Ruling P2-3).

- [ ] **Step 1: Write the failing test**

Create `test/poe-queue.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { PoeSwitch } from '../src/camera/poe-switch';
import { fakeSwitch } from './helpers/fake-switch';

const host = { model: 'sscpoe-web' as const, host: 'fake', ports: 8, offSeconds: 5 };

describe('one PoE controller per host (spec §8.4)', () => {
  it('queue: the second waits; beyond the bound switch_busy', async () => {
    const sw = fakeSwitch();
    let releaseOff!: () => void;
    // The off time of the first cycle holds the switch until released.
    const p = new PoeSwitch({ config: () => host, password: () => 'pw', driver: () => sw.driver, sleep: (ms) => (ms >= 5000 ? new Promise<void>((r) => (releaseOff = r)) : Promise.resolve()), queueWaitMs: () => 200 });
    const first = p.cycle(3, () => undefined);
    await new Promise((r) => setTimeout(r, 20));
    const second = p.read(4, { fresh: true });
    const late = new Promise((r) => setTimeout(r, 300)).then(() => p.read(5, { fresh: true }));
    await expect(second).rejects.toMatchObject({ code: 'switch_busy' }); // waited 200 ms: over the bound
    releaseOff();
    await first;
    expect((await late).port).toBe(5);
    expect(sw.sessions()).toBe(0);
  });

  it('a waiting request runs after the first, in order', async () => {
    const sw = fakeSwitch();
    const p = new PoeSwitch({ config: () => host, password: () => 'pw', driver: () => sw.driver, sleep: async () => undefined });
    const [a, b] = await Promise.all([p.cycle(3, () => undefined), p.read(4, { fresh: true })]);
    expect(a.watts).toBeGreaterThan(0);
    expect(b.port).toBe(4);
    expect(sw.log.indexOf('poe 2 on')).toBeLessThan(sw.log.lastIndexOf('login'));
  });

  it('one read serves every port for 10 s (Ruling P2-7)', async () => {
    let t = 0;
    const sw = fakeSwitch();
    const p = new PoeSwitch({ config: () => host, password: () => 'pw', driver: () => sw.driver, now: () => t, sleep: async () => undefined });
    await p.read(3);
    await p.read(4);
    expect(sw.log.filter((l) => l === 'login')).toHaveLength(1);
    t += 10_001;
    await p.read(4);
    expect(sw.log.filter((l) => l === 'login')).toHaveLength(2);
  });

  it('per-port state; the port handle is a camera view', async () => {
    const sw = fakeSwitch();
    const p = new PoeSwitch({ config: () => host, password: () => 'pw', driver: () => sw.driver, sleep: async () => undefined });
    sw.poe[5] = false;
    await p.read(6, { fresh: true });
    expect(p.status(6).poeMaybeOff).toBe(true);
    expect(p.status(3).poeMaybeOff).toBe(false);
    const h = p.forPort(() => 6);
    expect((await h.poeOn()).wasOn).toBe(false);
    expect(p.status(6).poeMaybeOff).toBe(false);
    expect(p.forPort(() => undefined).notConfigured()).toBe("the camera's poeSwitch.port is not set");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/poe-queue.test.ts`
Expected: FAIL — `cycle(3, …)` passes a number where a callback is expected (the class still reads one configured port).

- [ ] **Step 3: Implement the controller**

In `src/camera/poe-switch.ts`:

1. `PoeSwitchDeps.config` returns `HostSwitchConfig` (no `port`); add `readCacheMs?: number` (10 000) and `queueWaitMs?: () => number`.
2. Per-port state replaces the single fields: `private readonly last = new Map<number, PortReading>(); private readonly offPorts = new Set<number>(); private readonly cutting = new Set<number>(); private cache: { at: number; detail: SwitchDetail } | null = null;`. Every place that used `c.port` uses the method's `port` argument; `this.poeMaybeOff = x` becomes `x ? this.offPorts.add(port) : this.offPorts.delete(port)`; `this.cutting = true/false` becomes `this.cutting.add(port)` / `.delete(port)`; `reading(d, c, driver)` takes `port` and stores into `this.last.set(port, …)`; each session caches its detail: `this.cache = { at: this.now(), detail: d }` on every `detail()` read.
3. `notConfigured(port?: number)`: the host checks (`poeSwitch.model is none`, `poeSwitch.host is not set`, the password) and, when `port` is given or `undefined` is passed explicitly through a handle, `"the camera's poeSwitch.port is not set"` / `"the camera's poeSwitch.port is above poeSwitch.ports"`.
4. The queue replaces the `busy` refusal in `session()`:

```ts
  private tail: Promise<unknown> = Promise.resolve();

  // One switch session at a time for the whole host, in arrival order (spec
  // §8.4). A request waits at most offSeconds + 60 s for the one before it;
  // beyond that it fails switch_busy without touching the switch.
  private session<T>(port: number, f: (s: SwitchSession, c: HostSwitchConfig & { port: number }, driver: SwitchDriver) => Promise<T>): Promise<T> {
    if (this.stopped) return Promise.reject(new PoeSwitchError('switch_error', 'the proxy is stopping'));
    const why = this.notConfigured(port);
    if (why) return Promise.reject(new PoeSwitchError('switch_error', why));
    const before = this.tail;
    let release!: () => void;
    const mine = new Promise<void>((r) => (release = r));
    this.tail = before.then(() => mine);
    const maxWait = this.d.queueWaitMs?.() ?? (this.d.config().offSeconds + 60) * 1000;
    const run = (async () => {
      try {
        if ((await within(before.then(() => true, () => true), maxWait)) === TIMED_OUT) {
          throw new PoeSwitchError('switch_busy', `another camera's switch work took longer than ${Math.round(maxWait / 1000)} s`);
        }
        if (this.stopped) throw new PoeSwitchError('switch_error', 'the proxy is stopping');
        this.busy = true;
        return await this.open(port, f);
      } finally {
        this.busy = false;
        release();
      }
    })();
    this.inflight = run;
    return run;
  }
```

(`open(port, f)` builds `c = { ...this.d.config(), port }`; the rest of `open` is unchanged.)

5. `read(port, o = {})`:

```ts
  read(port: number, o: { fresh?: boolean } = {}): Promise<PortReading> {
    const cached = this.cache;
    const driver = (this.d.driver ?? driverFor)(this.d.config().model);
    if (!o.fresh && cached && driver && this.now() - cached.at <= (this.d.readCacheMs ?? 10_000) && this.notConfigured(port) === null) {
      return Promise.resolve(this.reading(cached.detail, { ...this.d.config(), port }, driver, port));
    }
    return this.session(port, async (s, c, drv) => this.reading(await s.detail(), c, drv, port));
  }
```

`cycle(port, onOff)` and `poeOn(port)` always read fresh inside their session (unchanged logic, per port).

6. `stop()` returns `{ portsLeftOff: [...new Set([...this.offPorts, ...(finished ? [] : this.cutting)])], sessionMaybeOpen }`.
7. `status(port?)` reports the host fields plus, for a port, `port`, `last: this.last.get(port) ?? null`, `poeMaybeOff: this.offPorts.has(port)`, `configured: this.notConfigured(port) === null`.
8. `forPort(port)`:

```ts
  // One camera's view of the host switch (its port read on every use).
  forPort(port: () => number | undefined): PortHandle {
    const p = () => port() ?? 0;
    return {
      notConfigured: () => (port() === undefined ? "the camera's poeSwitch.port is not set" : this.notConfigured(p())),
      status: () => this.status(p()),
      read: () => this.read(p()),
      cycle: (onOff) => this.cycle(p(), onOff),
      poeOn: () => this.poeOn(p()),
    };
  }
```

- [ ] **Step 4: Worker and proxy**

`src/cameras/worker.ts`: `WorkerDeps` gains `poe: PoeSwitch` (the host's) and loses `poeSwitchPassword`; `this.poeSwitch = d.poe.forPort(() => this.cam().poeSwitch.port)` (type `PortHandle`); `stopSwitch()` is removed from the worker. The P1 control code that calls `poeSwitch.read()`, `.cycle()`, `.poeOn()`, `.status()`, `.notConfigured()` works unchanged on the handle.

`src/proxy.ts`: `const poe = new PoeSwitch({ config: () => running.poeSwitch, password: () => loaded.secrets.poeSwitchPassword });` passed to every worker. `doStop()` replaces the per-worker `stopSwitch()` calls with one stop and one record per camera left dark:

```ts
      const { portsLeftOff, sessionMaybeOpen } = await poe.stop();
      for (const port of portsLeftOff) {
        const w = cams.list().find((x) => x.cam().poeSwitch.port === port);
        const sw = { model: running.poeSwitch.model, host: running.poeSwitch.host ?? '', port };
        audit.write({ action: 'camera-powercycle', category: ['host'], type: ['end'], outcome: 'failure', user: 'system', ...(w ? { camera: w.id } : {}), message: `cam-proxy stopping: the camera's PoE may be left OFF on ${sw.host} port ${port}; turn it on in the switch's web UI, or with "Turn camera PoE on" once the proxy is back`, details: { phase: 'stop', poeLeftOff: true, sessionMaybeOpen, switch: sw } });
      }
      if (sessionMaybeOpen && !portsLeftOff.length) audit.write({ action: 'camera-powercycle', category: ['host'], type: ['end'], outcome: 'failure', user: 'system', message: "cam-proxy stopping: the proxy's web session on the switch may still be open: the switch's web UI may refuse logins until the switch ends it", details: { phase: 'stop', poeLeftOff: false, sessionMaybeOpen, switch: { model: running.poeSwitch.model, host: running.poeSwitch.host ?? '' } } });
```

`test/poe-switch.test.ts`: construct with the host config (no `port`) and pass the port to `read(8)`, `cycle(8, …)`, `poeOn(8)`, `status(8)`; replace the "a second use while busy fails switch_busy" expectation with "a second use waits" (the queue) and keep a `switch_busy` test with `queueWaitMs: () => 50`.

- [ ] **Step 5: Run tests**

Run: `npx vitest run test/poe-queue.test.ts test/poe-switch.test.ts test/switch-driver.test.ts test/camera-powercycle.test.ts && npm run lint:types && npm test && npm run build && npm run test:e2e`
Expected: all pass; the e2e maintenance spec's power-cycle against the mock unchanged.

- [ ] **Step 6: Commit**

```bash
git add src/camera/poe-switch.ts src/cameras/worker.ts src/proxy.ts test/poe-queue.test.ts test/poe-switch.test.ts
git commit -m "feat(poe): one controller per host with a FIFO queue and per-port state"
```

---

### Task 8: `composition.concurrent`

**Files:**
- Modify: `src/compose/jobs.ts`, `src/config/schema.ts`, `src/config/defaults.ts`, `src/proxy.ts`
- Test: `test/compose-jobs.test.ts` (extend)

**Interfaces:**
- Produces: setting `composition.concurrent` (1–4, default 1, live); `createComposer(o: { …; concurrent?: () => number })`.

- [ ] **Step 1: Write the failing test**

Append to `test/compose-jobs.test.ts` (it has `make(extra)` → `{ c, m }` with a hand-driven runner `m.jobs[i].finish()`, the request `req`, and `tick()`):

```ts
describe('composition.concurrent (spec §8.6)', () => {
  it('runs that many encodes at once; the next waits', async () => {
    const { c, m } = make({ concurrent: () => 2 });
    c.start({ ...req, cam: 'cam3' });
    c.start({ ...req, cam: 'cam4' });
    c.start({ ...req, cam: 'cam5' });
    await tick();
    expect(m.jobs).toHaveLength(2);
    m.jobs[0].finish();
    await tick();
    await tick();
    expect(m.jobs).toHaveLength(3);
  });
  it('one by default (the Pi)', async () => {
    const { c, m } = make();
    c.start(req);
    c.start(req);
    await tick();
    expect(m.jobs).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/compose-jobs.test.ts`
Expected: FAIL — only `cam3` runs.

- [ ] **Step 3: Implement**

`src/compose/jobs.ts`: replace `let running: Job | undefined; let runningDone: Promise<unknown> | undefined;` with `const running = new Map<Job, Promise<unknown>>();`; `next()`:

```ts
  const next = () => {
    while (!stopped && running.size < Math.max(1, Math.min(4, o.concurrent?.() ?? 1))) {
      const j = [...jobs.values()].find((x) => x.state === 'queued');
      if (!j) return;
      j.state = 'running';
      j.startedAt = now();
      const done = o.runner({ dir: j.dir, out: j.out, req: j.req, signal: j.ctl.signal, onProgress: (p) => { if (j.state === 'running') j.progress = Math.max(j.progress, Math.min(1, p)); } })
        .then(/* unchanged */)
        .catch(/* unchanged */)
        .finally(() => {
          running.delete(j);
          if (!jobs.has(j.id)) rmSync(j.dir, { recursive: true, force: true });
          next();
        });
      running.set(j, done);
    }
  };
```

`drop(j)`: `if (!running.has(j)) rmSync(…)`; `stop()`: `await within(Promise.all([...running.values()]).catch(() => {}), 3000)`. Settings: `composition: { …, concurrent: int(1, 4, 'composed clips encoded at once (2 on a 4-core host, 1 on a Pi)') }`, `Config['composition'].concurrent: number`, `DEFAULTS.composition = { concurrent: 1 }`. `src/proxy.ts`: `createComposer({ …, concurrent: () => running.composition.concurrent })`.

- [ ] **Step 4: Run tests**

Run: `npm run schema && npx vitest run test/compose-jobs.test.ts test/compose-api.test.ts test/config.test.ts && npm run lint:types && npm test`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/compose/jobs.ts src/config src/proxy.ts config.schema.json test/compose-jobs.test.ts
git commit -m "feat(compose): composition.concurrent encodes at once"
```

---

### Task 9: Control API: routes per camera

**Files:**
- Create: `src/api/camera-control.ts` (the per-camera control interface)
- Modify: `src/api/control-api.ts` (camera routes; old routes delegate)
- Modify: `src/proxy.ts` (builds a `CameraControl` per worker)
- Modify: `src/inventory/runner.ts` (`running()` names its camera)
- Modify: `openapi.yaml`
- Test: `test/control-camera-routes.test.ts` (new)

**Interfaces:**
- Produces (`src/api/camera-control.ts`):

```ts
export interface CameraControl {
  id: string;
  block(): CameraStatusBlock;                                   // P1 Task 15's block
  check(): Promise<CameraState>;
  resubscribe(): void;
  restart(): Promise<void>;                                     // this camera's worker only
  reboot(who: RebootRequester): Promise<RebootAnswer>;
  powerCycle(who: RebootRequester): Promise<PowerCycleAnswer>;
  poe: { notConfigured(): string | null; read(): Promise<PortReading>; poeOn(): Promise<PoeOnResult>; info(): { model: string; host: string; port: number } };
  ftp: { target(): FtpTarget; setup(t: FtpTarget): Promise<unknown>; test(t: FtpTarget): Promise<{ ok: boolean; rspCode: number }>; off(): Promise<unknown> };
  name: { current(): string; write(name: string): Promise<string> };
}
```
- `ControlDeps` loses `camera`, `cameraName`, `checkCamera`, `intake`, `resubscribe`, `restart`, `cameraReboot`, `poeSwitch`, `cameraPowerCycle`, `cameraFtp`, `inventoryCamera`, `cameraId` and gains `cameraControl(id: string): CameraControl | undefined` and `cameraIds(): string[]`.
- Routes: `PUT /control/cameras/:cam/name`, `POST /control/cameras/:cam/actions/:name` (camera actions only; a host action there → 404 `not_found`); the old `PUT /control/camera/name` and camera actions on `POST /control/actions/:name` act on the only camera, else `400 camera_required`.
- `InventoryRunner.running()` view gains `camera: string`; `inventory-cancel` on a camera route cancels only that camera's run (`{cancelled: false, runId: null}` otherwise); `inventory-repair` on a camera route refuses a source report of another camera: `409 camera_mismatch`.

- [ ] **Step 1: Write the failing test**

Create `test/control-camera-routes.test.ts`:

```ts
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN_TOKEN, auth, until } from './helpers/proxy';
import { startMultiProxy, startSims, type Sim } from './helpers/multi';

let sims: Sim[];
let p: Awaited<ReturnType<typeof startMultiProxy>>;
const admin = () => auth(ADMIN_TOKEN);
beforeAll(async () => {
  sims = await startSims(2);
  p = await startMultiProxy(sims);
  await until(() => p.proxy.cameras.list().every((w) => w.status.state().online), 20_000);
}, 40_000);
afterAll(async () => {
  await p.proxy.stop();
  await Promise.all(sims.map((s) => s.close()));
});

describe('control routes per camera (spec §6.3)', () => {
  it('a camera action on its own route; the record names the camera', async () => {
    const r = await request(p.base).post('/control/cameras/cam4/actions/camera-test').set(admin());
    expect(r.status).toBe(200);
    // The record is written when the answer has gone out.
    await until(() => !!p.proxy.audit.find((x) => x.event.action === 'control-action', 50));
    expect(p.proxy.audit.find((x) => x.event.action === 'control-action', 50)?.labels).toEqual({ camera: 'cam4' });
  });
  it('renames one camera only', async () => {
    const r = await request(p.base).put('/control/cameras/cam3/name').set(admin()).send({ name: 'Driveway' });
    expect(r.body).toEqual({ name: 'Driveway' });
    expect(sims[0].sim.engine.settings.name).toBe('Driveway');
    expect((await request(p.base).get('/control/cameras/cam4/status').set(admin())).body.camera.name).not.toBe('Driveway');
  });
  it('the old routes need a camera here; host actions are not camera routes', async () => {
    expect((await request(p.base).put('/control/camera/name').set(admin()).send({ name: 'X' })).body.error).toBe('camera_required');
    expect((await request(p.base).post('/control/cameras/cam4/actions/retention-run').set(admin())).status).toBe(404);
    expect((await request(p.base).post('/control/cameras/cam9/actions/camera-test').set(admin())).status).toBe(404);
    expect((await request(p.base).post('/control/cameras/cam4/actions/camera-test').set(auth())).status).toBe(403);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/control-camera-routes.test.ts`
Expected: FAIL — `/control/cameras/cam4/actions/camera-test` answers 404.

- [ ] **Step 3: Implement**

`src/api/control-api.ts`:

1. Move the body of today's `PUT /camera/name` into `async function renameCamera(c: CameraControl, req, res)` (it uses `c.name.current()`, `c.name.write()`, and its audit record gets `camera: c.id`).
2. Move the camera cases of the `actions/:name` switch (`onvif-resubscribe`, `camera-test`, `camera-ftp-setup`, `camera-ftp-test`, `camera-ftp-off`, `restart`, `camera-reboot`, `camera-powercycle`, `camera-poe-on`, `poe-switch-read`, `inventory`, `inventory-repair`, `inventory-cancel`) into `async function cameraAction(c: CameraControl, name: string, req, res, ctx: { fail; requester; requestedBy; tooSoon; switchFail; inventoryRefused })` — the case bodies stay as they are with `d.checkCamera()` → `c.check()`, `d.resubscribe()` → `c.resubscribe()`, `d.restart()` → `c.restart()`, `d.cameraReboot(r)` → `c.reboot(r)`, `d.cameraPowerCycle(r)` → `c.powerCycle(r)`, `d.poeSwitch.*` → `c.poe.*`, `d.cameraFtp.*` → `c.ftp.*`, the inventory `cam` → `c.id`; `inventory-repair` first loads the source report (`d.inventory.get(source)`) and answers `fail(409, 'camera_mismatch', 'the report is of camera X')` when its `camera` differs from `c.id`; `inventory-cancel` cancels only when `d.inventory.running()?.camera === c.id`.
3. Routes:

```ts
  r.param('cam', cameraParam(d.cameras, 'admin'));
  const onlyCamera = (res: Response): CameraControl | undefined => {
    const ids = d.cameraIds();
    if (ids.length !== 1) return void res.status(400).json({ error: 'camera_required', detail: 'several cameras: use /control/cameras/:cam/…' }), undefined;
    return d.cameraControl(ids[0]);
  };
  r.put('/camera/name', async (req, res) => {
    const c = onlyCamera(res);
    if (c) await renameCamera(c, req, res);
  });
  r.put('/cameras/:cam/name', async (req, res) => renameCamera(d.cameraControl(workerOf(res).id)!, req, res));
  r.post('/cameras/:cam/actions/:name', actionLimit, async (req, res) => {
    const name = String(req.params.name);
    if (!CAMERA_ACTIONS.has(name)) return void res.status(404).json({ error: 'not_found' });
    await runAction(req, res, name, d.cameraControl(workerOf(res).id)!);
  });
  r.post('/actions/:name', actionLimit, async (req, res) => {
    const name = String(req.params.name);
    if (CAMERA_ACTIONS.has(name)) {
      const c = onlyCamera(res);
      if (c) await runAction(req, res, name, c);
      return;
    }
    await runAction(req, res, name, undefined);
  });
```

where `runAction(req, res, name, c?)` is today's handler body (the audit registration with `...(c ? { camera: c.id } : {})` in the record, `fail`, `tooSoon`, …) whose `switch` keeps the host cases and ends with `default: return c ? cameraAction(c, name, req, res, ctx) : fail(404, 'not_found');`. The P1 `camera_required` check moves into `onlyCamera` (the audit record of a refused old-route call is written by `runAction` only, so call `onlyCamera` inside `runAction` when `c` is needed: keep the record of P1).

`src/proxy.ts` builds the control per worker:

```ts
  const controlOf = (w: CameraWorker): CameraControl => ({
    id: w.id,
    block: () => cameraStatusBlock(w),
    check: () => w.status.checkNow(),
    resubscribe: () => w.intake.resubscribe(),
    restart: () => w.restart(),
    reboot: (who) => w.reboot.request(who),
    powerCycle: (who) => w.reboot.powerCycle(who, { switch: w.poeSwitchInfo(), offSeconds: running.poeSwitch.offSeconds }, (onOff) => w.poeSwitch.cycle(onOff)),
    poe: { notConfigured: () => w.poeSwitch.notConfigured(), read: () => w.poeSwitch.read(), poeOn: () => w.poeSwitch.poeOn(), info: () => w.poeSwitchInfo() },
    ftp: {
      target: ftpTargetFor(w.id),
      setup: async (t) => { const f = await setupCameraFtp(w.client, t); w.ftpWatch.note(f); return f; },
      test: (t) => testCameraFtp(w.client, t),
      off: async () => { const f = await cameraFtpOff(w.client, ftpTargetFor(w.id)()); w.ftpWatch.note(f); return f; },
    },
    name: { current: () => w.name(), write: (n) => w.writeName(n) },
  });
```

and passes `cameraControl: (id) => { const w = cams.get(id); return w ? controlOf(w) : undefined; }`, `cameraIds: () => cams.ids()`.

`openapi.yaml`: add `/control/cameras/{cam}/name` (put) and `/control/cameras/{cam}/actions/{name}` (post), mirroring the old routes' entries with the `cam` path parameter and the `404`/`503` answers; the old routes' `'400'` mentions `camera_required`.

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/control-camera-routes.test.ts test/control-api.test.ts test/control-cameras.test.ts test/camera-name-api.test.ts test/camera-reboot.test.ts test/camera-powercycle.test.ts test/inventory-api.test.ts test/openapi.test.ts test/multi-camera.test.ts && npm run lint:types && npm test`
Expected: all pass; the one-camera old routes behave as before.

- [ ] **Step 5: Commit**

```bash
git add src/api/camera-control.ts src/api/control-api.ts src/proxy.ts src/inventory/runner.ts openapi.yaml test/control-camera-routes.test.ts
git commit -m "feat(control): camera routes for name and actions; old routes need a camera on several"
```

---

### Task 10: Adding and removing cameras through the control API

**Files:**
- Modify: `src/config/legacy.ts` (overrides may add cameras), `src/config/load.ts` (order; removing an added camera)
- Modify: `src/cameras/registry.ts` (`remove`)
- Modify: `src/proxy.ts` (reconcile workers on `setLoaded`; go2rtc created whenever `go2rtc.binary` is set)
- Modify: `src/api/control-api.ts` (`CameraStatusBlock.source`)
- Test: `test/cameras-add-remove.test.ts` (new); `test/config-legacy.test.ts` (Ruling P1-13's test changes)

**Interfaces:**
- Produces:
  - Overrides may hold `cameras.<new id>` objects (with `host`); `Loaded.order` = config.json's ids, then the added ids sorted (Ruling P2-5); `Loaded.addedCameras: string[]`.
  - `removeOverride(loaded, 'cameras.<id>')` drops an added camera; for a config.json camera it throws `ConfigError('cameras.<id>: defined in config.json; remove it there')`.
  - `CameraRegistry.remove(id: string): CameraWorker | undefined`.
  - `CameraStatusBlock.source: 'config' | 'added'`.

- [ ] **Step 1: Write the failing test**

Create `test/cameras-add-remove.test.ts`:

```ts
import { readFileSync } from 'fs';
import { join } from 'path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN_TOKEN, auth, until } from './helpers/proxy';
import { startMultiProxy, startSims, type Sim } from './helpers/multi';

const go2rtc = process.env.CAMPROXY_TEST_GO2RTC;
let sims: Sim[];
let p: Awaited<ReturnType<typeof startMultiProxy>>;
const admin = () => auth(ADMIN_TOKEN);
beforeAll(async () => {
  sims = await startSims(2);
  p = await startMultiProxy([sims[0]]);
  await until(() => p.proxy.cameras.first().status.state().online, 20_000);
}, 40_000);
afterAll(async () => {
  await p.proxy.stop();
  await Promise.all(sims.map((s) => s.close()));
});

describe('cameras added and removed through the control API (spec §6.3)', () => {
  it('adding a camera never restarts go2rtc; its worker starts', async () => {
    const pid = (p.proxy as unknown as { go2rtcPid?: () => number | undefined }).go2rtcPid?.();
    const s = sims[1];
    const r = await request(p.base).put('/control/config').set(admin()).send({ cameras: { cam6: { host: s.camera.host, protocol: 'http', user: 'proxy', onvifPort: s.ports.onvif, rtspPort: s.ports.rtsp || 554, baichuanPort: s.camera.baichuanPort, statusPollS: 5 } } });
    expect(r.status).toBe(200);
    await until(async () => (await request(p.base).get('/api/cameras').set(auth())).body.some((c: { id: string; online: boolean }) => c.id === 'cam6' && c.online), 20_000);
    expect(JSON.parse(readFileSync(join(p.dir, 'data', 'overrides.json'), 'utf8')).cameras.cam6.host).toBe(s.camera.host);
    if (go2rtc) {
      expect((p.proxy as unknown as { go2rtcPid: () => number | undefined }).go2rtcPid()).toBe(pid);
      await until(() => p.proxy.cameras.get('cam6')!.stills?.grabber.up() === true, 30_000);
    }
    const blocks = (await request(p.base).get('/control/cameras').set(admin())).body;
    expect(blocks.map((b: { id: string; source: string }) => [b.id, b.source])).toEqual([['cam3', 'config'], ['cam6', 'added']]);
  }, 60_000);

  it('an added camera can be removed; a config.json camera cannot', async () => {
    expect((await request(p.base).delete('/control/config/cameras.cam6').set(admin())).status).toBe(200);
    await until(async () => (await request(p.base).get('/api/cameras/cam6').set(auth())).status === 404, 10_000);
    const r = await request(p.base).delete('/control/config/cameras.cam3').set(admin());
    expect([r.status, r.body.detail]).toEqual([400, 'cameras.cam3: defined in config.json; remove it there']);
  });
});
```

In `test/config-legacy.test.ts`, the P1 test `an override for a camera config.json does not define is refused (Ruling P1-13)` becomes:

```ts
  it('an override may add a camera (with a host); added ids follow the file, sorted (Ruling P2-5)', () => {
    write('config.json', two);
    write('data/overrides.json', { cameras: { cam9: { host: 'x' }, cam10: { host: 'y' } } });
    const l = load();
    expect(cameraIds(l.config)).toEqual(['cam3', 'cam4', 'cam10', 'cam9']);
    expect(l.addedCameras).toEqual(['cam10', 'cam9']);
    write('data/overrides.json', { cameras: { cam9: { name: 'no host' } } });
    expect(err(() => load())).toBe('cameras.cam9.host: required for a camera added here');
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/cameras-add-remove.test.ts test/config-legacy.test.ts`
Expected: FAIL — `cameras.cam6: unknown camera (cameras are added in config.json)`.

- [ ] **Step 3: Config**

`src/config/legacy.ts` `normalizeOverrides(over, fileIds)`: replace the unknown-id error with

```ts
  if (isObj(out.cameras)) {
    for (const [id, entry] of Object.entries(out.cameras)) {
      if (!fileIds.includes(id) && (!isObj(entry) || typeof entry.host !== 'string')) throw new ConfigError(`cameras.${id}.host: required for a camera added here`);
    }
  }
```

(the legacy `camera.*` translation keeps using the total number of cameras: pass `[...fileIds, …added]` to `translatePath`.)

`src/config/load.ts`: after normalizing the overrides, `const added = Object.keys((overrides.cameras ?? {}) as object).filter((id) => !norm.order.includes(id)).sort(); const order = [...norm.order, ...added];` — `build()` gets `order` and builds the added cameras like the file ones (`cameraDefaults(id)` merged with nothing from the file; the override merge adds their values); `Loaded.addedCameras = added`. `removeOverride(loaded, path)`:

```ts
  const m = /^cameras\.([^.]+)$/.exec(path);
  if (m) {
    if (!loaded.addedCameras.includes(m[1])) throw new ConfigError(`cameras.${m[1]}: defined in config.json; remove it there`);
    const next = buildWithout(loaded, (o) => { const c = { ...(o.cameras as Obj) }; delete c[m[1]]; return { ...o, cameras: c }; });
    writeOverrides(loaded.files.overrides, next.overrides as Obj);
    return next;
  }
```

(`buildWithout(loaded, edit)`: `build(…, edit(structuredClone(loaded.overrides)), …)` with the order recomputed — factor the order computation into a helper used by `loadConfig`, `applyOverrides` and here.) `applyOverrides` recomputes the order the same way, so a `PUT` that adds a camera yields a `Loaded` that has it.

- [ ] **Step 4: Reconcile the workers**

`src/cameras/registry.ts`: `remove(id) { const w = this.byId.get(id); this.byId.delete(id); return w; }`.

`src/proxy.ts`:
- Create the `Go2rtc` whenever `running.go2rtc.binary` is set (Task 1 created it only when a camera had stills at start); `start()` with no sources runs an idle go2rtc. Expose `go2rtcPid: () => go2rtc?.pid()` on the `Proxy` object (a test seam documented as such).
- Factor the worker creation of P1 Task 3 into `const addWorker = (id: string) => { const w = new CameraWorker({ … }); cams.add(w); return w; };`.
- In `setLoaded(next)`, before `applySettings`:

```ts
    const was = cams.ids();
    const now = cameraIds(next.config);
    // New cameras run at once (spec §6.3): their settings are copied in whole,
    // although camera settings otherwise wait for a restart.
    for (const id of now.filter((x) => !was.includes(x))) running.cameras[id] = structuredClone(next.config.cameras[id]);
    running.cameraOrder = [...now];
    void reconcile(was, now);
```

with

```ts
  const reconcile = async (was: string[], now: string[]) => {
    for (const id of was.filter((x) => !now.includes(x))) {
      const w = cams.remove(id);
      if (!w) continue;
      await w.stopRecordings();
      await w.stop();
      await go2rtc?.removeStream(id).catch((err: Error) => logger.warn({ cameraId: id, err: err.message }, 'go2rtc_remove_failed'));
      delete running.cameras[id];
      logger.info({ cameraId: id }, 'camera_removed'); // files stay (Ruling P2-6)
    }
    for (const id of now.filter((x) => !was.includes(x))) {
      const w = addWorker(id);
      if (w.cam().stills.enabled) await go2rtc?.setStream(w.source()).catch((err: Error) => logger.warn({ cameraId: id, err: err.message }, 'go2rtc_add_failed'));
      await w.start();
      logger.info({ cameraId: id }, 'camera_added');
    }
  };
```

`go2rtc.start()` must run even when it has no streams yet (`start()` at boot whenever the object exists).
- `cameraStatusBlock(w)` adds `source: loaded.addedCameras.includes(w.id) ? 'added' : 'config'`.

- [ ] **Step 5: Run tests**

Run: `npx vitest run test/cameras-add-remove.test.ts test/config-legacy.test.ts test/control-api.test.ts test/multi-camera.test.ts && npm run lint:types && npm test`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/config/legacy.ts src/config/load.ts src/cameras/registry.ts src/proxy.ts src/api/control-api.ts test/cameras-add-remove.test.ts test/config-legacy.test.ts
git commit -m "feat: add and remove cameras through the control API without a restart"
```

---

### Task 11: The latest still, from memory

**Files:**
- Create: `src/api/latest-api.ts`
- Modify: `src/cameras/worker.ts` (`latestFrame()`), `src/api/client-api.ts` (`latestStill` in the camera info), `src/proxy.ts` (router; image bucket), `openapi.yaml`
- Test: `test/latest-still.test.ts` (new)

**Interfaces:**
- Produces:
  - `CameraWorker.latestFrame(): Frame | undefined` (the grabber's last frame, kept in memory whatever storage does).
  - `latestApi(d: { cameras: CameraRegistry }): express.Router` with `GET /cameras/:cam/stills/latest.jpg`, `GET /cameras/:cam/previews/latest.jpg`, `GET /stills/latest`; mounted on `/api` **before** `clientApi` (its `/cameras/:cam/stills/:file` would otherwise take `latest.jpg`).
  - `GET /api/cameras` item gains `latestStill: { ts: number; url: string; tileUrl: string } | null`.

- [ ] **Step 1: Write the failing test**

Create `test/latest-still.test.ts`:

```ts
import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { latestApi } from '../src/api/latest-api';
import { CameraRegistry } from '../src/cameras/registry';
import type { CameraWorker } from '../src/cameras/worker';

function app(state: { up: boolean; frame?: { ts: number; still: Buffer; tile: Buffer } }) {
  const w = { id: 'cam3', phase: () => 'ready', latestFrame: () => state.frame, stills: { grabber: { up: () => state.up } } } as unknown as CameraWorker;
  const cams = new CameraRegistry(() => ['cam3']);
  cams.add(w);
  const a = express();
  a.use(latestApi({ cameras: cams }));
  return a;
}

describe('latest still (spec §6.4)', () => {
  const frame = { ts: 1_791_000_000_000, still: Buffer.from('still'), tile: Buffer.from('tile') };
  it('serves the last frame with ETag, X-Still-Ts and no-cache; a matching ETag gets 304', async () => {
    const a = app({ up: true, frame });
    const r = await request(a).get('/cameras/cam3/stills/latest.jpg');
    expect(r.status).toBe(200);
    expect(r.headers.etag).toBe(`"cam3-${frame.ts}"`);
    expect(r.headers['x-still-ts']).toBe(String(frame.ts));
    expect(r.headers['cache-control']).toBe('no-cache');
    expect(r.body.toString()).toBe('still');
    const again = await request(a).get('/cameras/cam3/stills/latest.jpg').set('If-None-Match', `"cam3-${frame.ts}"`);
    expect(again.status).toBe(304);
    expect(again.text).toBe('');
    expect((await request(a).get('/cameras/cam3/previews/latest.jpg')).body.toString()).toBe('tile');
  });
  it('down: 404 even with a matching ETag, with the last ts', async () => {
    const a = app({ up: false, frame });
    const r = await request(a).get('/cameras/cam3/stills/latest.jpg').set('If-None-Match', `"cam3-${frame.ts}"`);
    expect([r.status, r.body]).toEqual([404, { error: 'no_still', ts: frame.ts }]);
    expect((await request(app({ up: true })).get('/cameras/cam3/stills/latest.jpg')).body).toEqual({ error: 'no_still', ts: null });
  });
  it('GET /stills/latest: every camera in one answer', async () => {
    const r = await request(app({ up: true, frame })).get('/stills/latest');
    expect(r.body).toEqual([{ cam: 'cam3', ts: frame.ts, url: '/api/cameras/cam3/stills/latest.jpg', tileUrl: '/api/cameras/cam3/previews/latest.jpg', up: true }]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/latest-still.test.ts`
Expected: FAIL with `Failed to resolve import "../src/api/latest-api"`.

- [ ] **Step 3: Implement**

Create `src/api/latest-api.ts`:

```ts
import express, { type Request, type Response } from 'express';
import type { CameraRegistry } from '../cameras/registry';
import type { CameraWorker } from '../cameras/worker';
import { cameraParam, workerOf } from './camera-param';

const urls = (cam: string) => ({ url: `/api/cameras/${encodeURIComponent(cam)}/stills/latest.jpg`, tileUrl: `/api/cameras/${encodeURIComponent(cam)}/previews/latest.jpg` });

// The newest still and tile of each camera, from memory (spec
// 2026-10-05-multi-camera-host-design §6.4): no disk read, no decode. A
// client polling every few seconds gets 304 while nothing moved; while the
// stream is down: 404 no_still with the last ts (never a 304 for a stale image).
export function latestApi(d: { cameras: CameraRegistry }): express.Router {
  const r = express.Router();
  r.param('cam', cameraParam(d.cameras));
  const up = (w: CameraWorker) => w.stills?.grabber.up() ?? false;
  const send = (kind: 'still' | 'tile') => (req: Request, res: Response) => {
    const w = workerOf(res);
    const f = w.latestFrame();
    if (!f || !up(w)) return void res.status(404).json({ error: 'no_still', ts: f?.ts ?? null });
    const etag = `"${w.id}-${f.ts}"`;
    res.set({ ETag: etag, 'Cache-Control': 'no-cache', 'X-Still-Ts': String(f.ts) });
    if (req.get('if-none-match') === etag) return void res.status(304).end();
    res.type('image/jpeg').send(kind === 'still' ? f.still : f.tile);
  };
  r.get('/cameras/:cam/stills/latest.jpg', send('still'));
  r.get('/cameras/:cam/previews/latest.jpg', send('tile'));
  r.get('/stills/latest', (_req, res) => void res.json(d.cameras.list().map((w) => ({ cam: w.id, ts: w.latestFrame()?.ts ?? null, ...urls(w.id), up: up(w) }))));
  return r;
}
```

`src/cameras/worker.ts`: `private lastFrame: Frame | undefined;` set first thing in the grabber's `frame` handler (before the storage-paused check); `latestFrame() { return this.lastFrame; }`; cleared in `build()`.

`client-api.ts` `info(w)` adds `latestStill: (() => { const f = w.latestFrame(); return f ? { ts: f.ts, url: …, tileUrl: … } : null; })()`.

`src/proxy.ts`: `app.use('/api', requireAccess('client', access), latestApi({ cameras: cams }));` right before the `composeApi` mount; the image regex adds `(stills|previews)\/latest\.jpg` to the camera alternatives and `|^\/api\/stills\/latest$`. `openapi.yaml`: the three routes (`/api/cameras/{cam}/stills/latest.jpg`, `/api/cameras/{cam}/previews/latest.jpg`, `/api/stills/latest`) with `200`, `304`, `404 no_still`.

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/latest-still.test.ts test/client-api.test.ts test/stills-api.test.ts test/openapi.test.ts && npm run lint:types && npm test`
Expected: all pass (`client-api.test.ts:39`'s exact object gets `latestStill: null` or `expect.anything()` when go2rtc runs).

- [ ] **Step 5: Commit**

```bash
git add src/api/latest-api.ts src/cameras/worker.ts src/api/client-api.ts src/proxy.ts openapi.yaml test/latest-still.test.ts test/client-api.test.ts
git commit -m "feat(api): latest still and tile per camera from memory, with ETag and 304"
```

---

### Task 12: Host figures on the mini PC (`k10temp` `Tctl`)

**Files:**
- Modify: `src/health/host.ts`
- Create: `test/fixtures/host/ryzen/…` (proc from `test/fixtures/host/linux`, plus a k10temp hwmon)
- Test: `test/health-host.test.ts` (extend)

**Interfaces:**
- Produces: `readHostStats(p).cpuTempC` reads hwmon `cpu_thermal` `temp1_input` (the Pi) or else the `k10temp` sensor whose `temp*_label` is `Tctl`; null when neither exists.

- [ ] **Step 1: The fixture**

Run:

```bash
mkdir -p test/fixtures/host/ryzen/sys/class/hwmon/hwmon2
cp -R test/fixtures/host/linux/proc test/fixtures/host/ryzen/
printf 'k10temp\n' > test/fixtures/host/ryzen/sys/class/hwmon/hwmon2/name
printf 'Tctl\n' > test/fixtures/host/ryzen/sys/class/hwmon/hwmon2/temp1_label
printf '48125\n' > test/fixtures/host/ryzen/sys/class/hwmon/hwmon2/temp1_input
```

- [ ] **Step 2: Write the failing test**

Append to `test/health-host.test.ts`:

```ts
describe('the mini PC (spec §6.5)', () => {
  it('CPU temperature from k10temp Tctl; no under-voltage reading', () => {
    const s = readHostStats({ root: join(__dirname, 'fixtures', 'host', 'ryzen') });
    expect(s.cpuTempC).toBe(48.1);
    expect(s.underVoltage).toBeNull();
  });
});
```

(import `readHostStats` and `join` if the file does not already.)

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/health-host.test.ts`
Expected: FAIL — `cpuTempC` is `null`.

- [ ] **Step 4: Implement**

In `readHostStats`:

```ts
  // A Raspberry Pi's cpu_thermal; an AMD Ryzen's k10temp, the Tctl channel (spec §6.5).
  const labelled = (name: string, label: string): number | null => {
    const dir = hw.get(name);
    if (!dir) return null;
    for (let i = 1; i <= 10; i++) if (readAt(join(dir, `temp${i}_label`))?.trim() === label) return intOf(readAt(join(dir, `temp${i}_input`)));
    return null;
  };
  const milli = sensor('cpu_thermal', 'temp1_input') ?? labelled('k10temp', 'Tctl');
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run test/health-host.test.ts test/health-summary.test.ts && npm test`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/health/host.ts test/fixtures/host/ryzen test/health-host.test.ts
git commit -m "feat(health): CPU temperature from k10temp Tctl on AMD hosts"
```

---

### Task 13: Admin UI: per-camera settings and actions, add and remove a camera

**Files:**
- Create: `web/src/lib/camera-settings.ts`, `web/src/components/AddCameraCard.svelte`
- Modify: `web/src/pages/Settings.svelte`, `web/src/pages/Maintenance.svelte` (the P1 note goes), `web/src/pages/Status.svelte` (storage per camera), `web/src/components/PoeSwitchCard.svelte`, `web/src/components/InventoryCard.svelte`, `web/src/lib/maintenance.ts`, `web/src/lib/inventory.ts`
- Test: `test/camera-settings-ui.test.ts` (new)

**Interfaces:**
- Produces (`web/src/lib/camera-settings.ts`):

```ts
export function settingGroups(paths: string[], camera: string | null): { host: Record<string, string[]>; camera: string[] };  // host groups by first segment; the selected camera's paths
export function cameraPath(id: string | null, multi: boolean, suffix: string): string;   // '/control/cameras/<id>/<suffix>' or '/control/<suffix>'
export function newCameraProblem(c: { id: string; host: string }, existing: string[]): string | null;
```

- [ ] **Step 1: Write the failing test**

Create `test/camera-settings-ui.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { cameraPath, newCameraProblem, settingGroups } from '../web/src/lib/camera-settings';

describe('per-camera settings (spec §6.3)', () => {
  it('host groups apart from the selected camera', () => {
    const g = settingGroups(['sse.pingS', 'poeSwitch.host', 'cameras.cam3.host', 'cameras.cam4.host', 'cameras.cam4.stills.intervalS'], 'cam4');
    expect(g.host).toEqual({ sse: ['sse.pingS'], poeSwitch: ['poeSwitch.host'] });
    expect(g.camera).toEqual(['cameras.cam4.host', 'cameras.cam4.stills.intervalS']);
  });
  it('the action path: the camera route with several cameras, the old one with one', () => {
    expect(cameraPath('cam4', true, 'actions/camera-test')).toBe('/control/cameras/cam4/actions/camera-test');
    expect(cameraPath('cam1', false, 'actions/camera-test')).toBe('/control/actions/camera-test');
    expect(cameraPath('cam1', false, 'name')).toBe('/control/camera/name');
  });
  it('a new camera: a valid, unused id and an address', () => {
    expect(newCameraProblem({ id: 'cam6', host: '192.168.60.16' }, ['cam3'])).toBeNull();
    expect(newCameraProblem({ id: 'cam3', host: 'x' }, ['cam3'])).toBe('cam3 exists already');
    expect(newCameraProblem({ id: 'Cam 6', host: 'x' }, [])).toBe('the id is lower-case letters, digits and -, up to 32');
    expect(newCameraProblem({ id: 'cam6', host: '' }, [])).toBe('the camera needs an address');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/camera-settings-ui.test.ts`
Expected: FAIL with `Failed to resolve import "../web/src/lib/camera-settings"`.

- [ ] **Step 3: Implement the lib**

```ts
// web/src/lib/camera-settings.ts
const ID = /^[a-z0-9][a-z0-9-]{0,31}$/;

export function settingGroups(paths: string[], camera: string | null): { host: Record<string, string[]>; camera: string[] } {
  const host: Record<string, string[]> = {};
  const mine: string[] = [];
  for (const p of paths) {
    const m = /^cameras\.([^.]+)\./.exec(p);
    if (m) {
      if (m[1] === camera) mine.push(p);
      continue;
    }
    (host[p.split('.')[0]] ??= []).push(p);
  }
  return { host, camera: mine };
}

export function cameraPath(id: string | null, multi: boolean, suffix: string): string {
  if (multi && id) return `/control/cameras/${encodeURIComponent(id)}/${suffix}`;
  return suffix === 'name' ? '/control/camera/name' : `/control/${suffix}`;
}

export function newCameraProblem(c: { id: string; host: string }, existing: string[]): string | null {
  if (!ID.test(c.id)) return 'the id is lower-case letters, digits and -, up to 32';
  if (existing.includes(c.id)) return `${c.id} exists already`;
  if (!c.host.trim()) return 'the camera needs an address';
  return null;
}
```

- [ ] **Step 4: The pages**

- `Settings.svelte`: `const groups = $derived(settingGroups(Object.keys(view).filter((p) => !p.startsWith('analytics.')), pickCamera(cameraIds($status), $selectedCamera)))`; render the host groups as today, then one group headed "Camera <name>" with `groups.camera` (each row's label is the path after `cameras.<id>.`); for a camera whose status block has `source: 'added'` a "Remove camera" button (`DELETE /control/config/cameras.<id>` after a `ConfirmDialog` that says its files stay until retention removes them); below, `<AddCameraCard />`.
- `AddCameraCard.svelte`: fields id, name, address (`host`), protocol (https/http), user; "Add" validates with `newCameraProblem`, then `PUT /control/config` with `{ cameras: { [id]: { host, name, protocol, user } } }`, then `refresh()`; shows the API's error text on a 400.
- `Maintenance.svelte`, `PoeSwitchCard.svelte`, `InventoryCard.svelte`, `web/src/lib/maintenance.ts`, `web/src/lib/inventory.ts`: every `api('POST', '/control/actions/<camera action>')` and `PUT /control/camera/name` goes through `cameraPath(selected, multiCamera($status), 'actions/<name>' | 'name')`; remove the P1 note and the disabled state; the host actions keep their paths.
- `Status.svelte`: the Storage card lists, with several cameras, each camera's stills/previews/clips/recordings bytes from `/control/stats`'s `cameras`.

- [ ] **Step 5: Check and test**

Run: `npx vitest run test/camera-settings-ui.test.ts test/settings-ui.test.ts test/maintenance-ui.test.ts test/inventory-ui.test.ts && npm run check && npm run build && npm run test:e2e`
Expected: all pass; the one-camera e2e unchanged.

- [ ] **Step 6: Commit**

```bash
git add web/src test/camera-settings-ui.test.ts
git commit -m "feat(ui): per-camera settings and actions; add and remove a camera"
```

---

### Task 14: Four cam-sims: FTP from two at once, the switch queue, latest stills; e2e

**Files:**
- Test: `test/multi-host.test.ts` (new)
- Modify: `e2e/multi/start.ts` (FTP on, a switch mock powering the sims), `e2e/multi/picker.spec.ts` → `e2e/multi/cameras.spec.ts` (per-camera settings and actions)

**Interfaces:**
- Consumes: everything above; `startPoeSwitchMock` (`test/helpers/poe-switch-mock.ts`).

- [ ] **Step 1: Write the integration test**

Create `test/multi-host.test.ts`:

```ts
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listClips } from '../src/catalog/clips';
import { ADMIN_TOKEN, auth, freePort, until } from './helpers/proxy';
import { startMultiProxy, startSims, type Sim } from './helpers/multi';
import { startPoeSwitchMock, type PoeSwitchMock } from './helpers/poe-switch-mock';

const FTP_PW = 'ftp-secret-'.padEnd(24, 'z');
let sims: Sim[];
let sw: PoeSwitchMock;
let p: Awaited<ReturnType<typeof startMultiProxy>>;
const admin = () => auth(ADMIN_TOKEN);

beforeAll(async () => {
  sims = await startSims(4);
  // Ports 1..4 of a GPS-208 power cam3..cam6 (internal index 8 - port: reverse order).
  sw = await startPoeSwitchMock({ password: 'sw-pw', powered: { 7: 4.5, 6: 4.5, 5: 4.5, 4: 4.5 } });
  const passive = await freePort();
  p = await startMultiProxy(sims, {
    settings: {
      ftp: { enabled: true, port: await freePort(), passive: `${passive}-${passive + 39}`, publicHost: '127.0.0.1', tls: true, stream: 'sub' },
      poeSwitch: { model: 'sscpoe-web', host: sw.host, ports: 8, offSeconds: 5 },
    },
    env: { CAMPROXY_FTP_PASSWORD: FTP_PW, CAMPROXY_POE_SWITCH_PASSWORD: 'sw-pw' },
  });
  // The camera nodes of startMultiProxy have no switch ports: add them as overrides.
  await request(p.base).put('/control/config').set(admin()).send({ cameras: Object.fromEntries(['cam3', 'cam4', 'cam5', 'cam6'].map((id, i) => [id, { poeSwitch: { port: i + 1 } }])) });
  for (const s of sims) s.sim.engine.settings.running.Rec.postRec = '1 Seconds';
  await until(() => p.proxy.cameras.list().every((w) => w.status.state().online), 30_000);
}, 60_000);
afterAll(async () => {
  await p.proxy.stop();
  await sw.close();
  await Promise.all(sims.map((s) => s.close()));
});

describe('one host, four cameras (spec §15)', () => {
  it('FTP uploads from two cameras at once land under the right ids', async () => {
    for (const id of ['cam3', 'cam4']) expect((await request(p.base).post(`/control/cameras/${id}/actions/camera-ftp-setup`).set(admin())).status).toBe(200);
    expect(sims[1].sim.engine.settings.running.Ftp.userName).toBe('cam4');
    const t0 = Date.now();
    sims[0].sim.engine.events.trigger('motion', 1);
    sims[1].sim.engine.events.trigger('motion', 1);
    await until(() => ['cam3', 'cam4'].every((cam) => listClips(p.proxy.catalog, cam, t0 - 60_000, Date.now() + 60_000).length > 0), 40_000);
    expect(listClips(p.proxy.catalog, 'cam5', t0 - 60_000, Date.now() + 60_000)).toEqual([]);
  }, 60_000);

  it('two power-cycles at once: the second waits for the first', async () => {
    const [a, b] = await Promise.all([
      request(p.base).post('/control/cameras/cam5/actions/camera-powercycle').set(admin()),
      request(p.base).post('/control/cameras/cam6/actions/camera-powercycle').set(admin()),
    ]);
    expect([a.status, b.status]).toEqual([202, 202]);
    expect(Math.abs(a.body.offAt - b.body.offAt)).toBeGreaterThanOrEqual(5000); // one after the other
    expect(sw.activeSession()).toBe(false);
  }, 60_000);

  it('GET /api/stills/latest lists every camera', async () => {
    const r = await request(p.base).get('/api/stills/latest').set(auth());
    expect(r.body.map((x: { cam: string }) => x.cam)).toEqual(['cam3', 'cam4', 'cam5', 'cam6']);
  });
});
```

(`startPoeSwitchMock`'s `powered` keys are internal indexes; its default serial `GPS208MOCK0001` counts ports backwards, so port 1 is index 7.)

- [ ] **Step 2: Run it**

Run: `npx vitest run test/multi-host.test.ts`
Expected: PASS (`3 passed`). A failure points at the task that owns the behaviour (FTP → Task 2, queue → Task 7, latest → Task 11).

- [ ] **Step 3: e2e**

In `e2e/multi/start.ts` turn FTP on (`ftp: { enabled: true, port: 18760, passive: '18761-18790', publicHost: '127.0.0.1', stream: 'sub' }`, `CAMPROXY_FTP_PASSWORD`). Rename `e2e/multi/picker.spec.ts` to `e2e/multi/cameras.spec.ts`, keep its picker test, replace the Maintenance-note test with:

```ts
test('per-camera settings and actions follow the picker', async ({ page }) => {
  await page.goto('/#/settings');
  await page.getByTestId('camera-picker').selectOption('cam4');
  await expect(page.getByTestId('input-cameras.cam4.statusPollS')).toBeVisible();
  await expect(page.getByTestId('input-cameras.cam3.statusPollS')).toHaveCount(0);
  await page.goto('/#/maintenance');
  const resp = page.waitForResponse((r) => r.url().includes('/control/cameras/cam4/actions/camera-test'));
  await page.getByTestId('action-camera-test').click();
  expect((await resp).status()).toBe(200);
});
```

Run: `npm run build && npm run test:e2e:multi`
Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add test/multi-host.test.ts e2e/multi
git commit -m "test: four cameras on one host: FTP, the switch queue, latest stills; e2e per-camera UI"
```

---

### Task 15: Docs and changelog

**Files:**
- Modify: `README.md`, `CHANGELOG.md`, `docs/poe-switch.md`, `config.cameras.example.json`, `CLAUDE.md`

- [ ] **Step 1: Write**

- `README.md` "Several cameras": replace the P1 "not there yet" list with the host-wide services (one go2rtc, one FTP server with a user per camera and the address check, storage shares, Vision per key and `perCameraDailyCap`, the switch queue, `composition.concurrent`, one recordings cache), the per-camera control routes, adding/removing cameras from the UI, and the latest-still endpoints for an overview grid.
- `docs/poe-switch.md`: one controller per host, the queue (`offSeconds + 60 s`, then `switch_busy` 409), the driver interface (`src/camera/switch/driver.ts`) and how to add a model; log out of the switch's web UI after use.
- `config.cameras.example.json`: add `"ftp": { "enabled": true, "port": 2121, "passive": "50000-50039", "tls": true, "publicHost": "192.168.60.1" }`, `"composition": { "concurrent": 2 }`, `"recordings": { "cacheMB": 8192 }`, `"host": { "stats": "on" }` and `"storage": { "sharePercent": 20 }` on cam4 (spec §4.1, §8.3, §9).
- `CLAUDE.md`: "Several cameras: one go2rtc, one FTP server and one PoE controller per host; `test/helpers/fake-switch.ts` for switch logic, never the real switch."
- `CHANGELOG.md` under `## Unreleased`:

```markdown
- One go2rtc for all cameras; a camera added or restarted never restarts it.
- FTP: one server, a user per camera (default: the camera id); a login from another address than the camera's is refused and audited (`ftp-login-refused`).
- Storage: per-camera accounting (Status page, metrics) and optional `cameras[].storage.sharePercent`.
- Vision: limits count per API key; `analytics.googleVision.perCameraDailyCap`.
- PoE switch: one controller per host with a queue; a driver per switch model.
- `composition.concurrent`: encodes at once (default 1).
- One recordings cache for all cameras (`recordings.cacheMB`).
- Control: `/control/cameras/:cam/name` and `/control/cameras/:cam/actions/:name`; cameras can be added and removed in the Settings page.
- `GET /api/cameras/:cam/stills/latest.jpg`, `…/previews/latest.jpg`, `GET /api/stills/latest`.
- CPU temperature on AMD hosts (k10temp Tctl).
```

- [ ] **Step 2: Full check**

Run: `npm run lint:types && npm test && npm run build && npm run check && npm run test:e2e && npm run test:e2e:multi`
Expected: all green.

- [ ] **Step 3: Commit**

```bash
git add README.md CHANGELOG.md docs/poe-switch.md config.cameras.example.json CLAUDE.md
git commit -m "docs: host-wide services for several cameras"
```

---

## After the plan (for the coordinator)

- Release when ready; update the Pi; check that its display renders and that `GET /control/status` on the Pi shows one camera with `source: 'config'`.
- The CHANGELOG heading PR after the release.
