# Camera calls for cams (cam-proxy, spec §4.8) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every camera call cams makes today (status, snapshot, live, settings, light, reboot, time) is served by the camera's proxy in maker-neutral shapes, announced by the `camera-calls` feature, so cams can stop calling cameras and hold no camera password (part C of the onboarding design).

**Architecture:** One new client router `src/api/camera-calls-api.ts` (mounted on `/api` behind `requireAccess('client')`; the camera-changing routes add `requireAccess('admin')` per route) serves status, snapshot, settings, light and reboot from the worker's existing client, poller, SD watch, time info, certificate state and reboot. cams's settings model moves into `src/camera/settings/` unchanged in shape. Live video is a WebSocket upgrade on the proxy's existing HTTP/HTTPS servers (`src/api/live-upgrade.ts`) that relays the host go2rtc's MSE WebSocket (`/api/ws` on 127.0.0.1) through `src/stream/live.ts`: one JSON `mse` message with the MIME type, then binary fMP4. The `camera-calls` feature goes into `FEATURES` last, once every route ships.

**Tech Stack:** TypeScript (Node 26, CommonJS), Express 5, `ws` ^8.22 (already a dependency; `WebSocketServer({ noServer: true })`), Node's global `WebSocket` for the go2rtc side, go2rtc v1.9.14 (`scripts/install-go2rtc.sh`), vitest + supertest, cam-sim in process (models `RLC-1224A`, `CX820`, `E1-Outdoor-Pro`).

**Spec:** `docs/superpowers/specs/2026-10-30-camera-onboarding-design.md` — §4.8 (routes for cams), §6 (what cams needs from them), §10.1–§10.3 (auth, trust, live transport). Part A (§4.1–§4.7) is released (v2026.10.30.3); this plan builds on its password API, trust pin and onboarding service.

## Prerequisites

- **cam-sim: none expected.** The pinned tarball (v2026.10.30.3) already answers `GetEnc`, `GetHddInfo`, `GetDevInfo` (with `hardVer` and cam-sim's `simulator`), `Snap`, `Reboot`, `GetRecV20`/`SetRecV20`, `GetMdAlarm`/`SetMdAlarm`, `GetAiAlarm`/`SetAiAlarm`, `GetIsp`/`SetIsp`, `GetIrLights`/`SetIrLights`, `GetWhiteLed`/`SetWhiteLed`, `GetOsd`/`SetOsd` for all three models, the faults `settings.fail` and `settings.ignore`, and RTSP main H.265 / sub H.264 with AAC (cams's own settings tests run against the same commands). Task 1 Step 1 checks this per model; any gap found is a cam-sim issue and a cam-sim release before the task that needs it, never a workaround here.
- **cams-admin contract: none.** No heartbeat field, command or remote-settable setting changes; `MANAGED_ALLOWED` is local to this repo.
- **kube-setup: none.** The cams → proxy WebSocket uses the existing HTTPS address; cleared with the Cluster session on 2026-10-30 (spec §10.3).

## Global Constraints

- Maker-neutral answers: no Reolink command name, rspCode or camera message reaches a client; camera failures answer `camera_offline` (503) or `camera_error` (502), as `src/api/ptz-api.ts` does.
- Reads (status, snapshot, live, settings GET, light GET) take client tokens. Camera-changing calls (settings PUT, light PUT, reboot) need admin-kind access: `requireAccess('admin', access)` on the route; a managed admin token passes only through a `MANAGED_ALLOWED` line for exactly that method and path (spec §10.1). A client token on them answers 403 `admin_only`.
- Camera writes: whole-object Sets only (read, change, Set the whole object), re-read after writing, `client.logout()` afterwards, one write at a time per camera, audited (never a password).
- Live: no new port, no WebRTC/UDP; MSE over a WebSocket on the existing HTTP/HTTPS servers at `/api/cameras/:cam/live`; sub stream by default, `stream=main` on demand (spec §10.3). Bearer token only (no cookie, no token in the URL).
- go2rtc's API stays on 127.0.0.1; nothing go2rtc says is forwarded except the validated MIME type and the media bytes (its errors can carry the RTSP URL with the camera password).
- Every new route is in `openapi.yaml` (test/openapi.test.ts keeps it equal to the registered routes), documented in README.md, and its audit record in `docs/audit-log.md`. User-visible changes go under `## Unreleased` in CHANGELOG.md.
- `features` gains `camera-calls` only in the last task, after every route of this plan is in.
- Never stage `tools` (a symlink in this worktree). Stage files explicitly.

## Review Focus

1. **go2rtc error text with the RTSP URL** (it holds `user:password@host`): any text go2rtc sends other than a valid `mse` message must reach the client only as `{"type":"error","value":"stream_unavailable"}`; no answer, log line or close reason contains `rtsp://` or the camera password. Test in Task 6.
2. **Two writers at once** (two cams viewers saving the image section together): whole-object writes interleaved lose one change. Writes to one camera are serialized; both PUTs end with both changes on the camera. Test in Task 3.
3. **A slow or stalled live reader** (cams not reading): the proxy must not buffer without bound; the socket closes with code 4008 `slow_consumer` once more than 8 MiB is queued, and go2rtc's consumer goes. Test in Task 6.
4. **Wrong token kinds on camera-changing routes**: a client token on settings PUT, light PUT or reboot answers 403 `admin_only`; a managed admin token passes exactly these; the audit token answers 401 everywhere here. Tests in Tasks 3, 4, 5.
5. **Live when there is no stream to give** (stills off for the camera, go2rtc down or restarting, camera restarting): the client gets `{"type":"error","value":"stream_unavailable"}` (or `camera_restarting`, `camera_offline`) at once and the socket closes, never an open socket that hangs. Test in Task 6.

---

### Task 1: Camera status for clients

**Files:**
- Create: `src/camera/streams.ts`, `src/api/camera-calls-api.ts`, `test/camera-calls-status.test.ts`
- Modify: `src/camera/client.ts` (`status()` returns `hardware`, `simulator`), `src/camera/status.ts` (`CameraState` keeps them), `src/cameras/worker.ts` (a `streams` reader and a certificate cache on the worker), `src/api/client-api.ts` (export the `tls` view as `cameraTls`), `src/onboarding/service.ts` (`servedNow`), `src/proxy.ts` (mount), `openapi.yaml`, `README.md` (Client API)

**Interfaces:**
- Produces: `export interface StreamInfo { codec: 'h264' | 'h265'; width: number; height: number; fps: number }`; `export class StreamsReader { constructor(command: CameraCommand, now?: () => number); read(): Promise<{ main: StreamInfo | null; sub: StreamInfo | null }> }` (GetEnc cached 10 min after success, 30 s after failure; a failure answers both null) in `src/camera/streams.ts`.
- Produces: `CameraWorker.streams: StreamsReader`; `CameraWorker.certificate(): Promise<{ subject: string; issuer: string; validTo: string } | null>` (the client's `cameraCertificate()`, cached 1 h, also when null).
- Produces: `export function cameraTls(w: CameraWorker, state: CertState | undefined, served: string | null): CameraTlsView` in `src/api/client-api.ts`, where `CameraTlsView = { mode; servername; fingerprint; notAfter; lastPush; served: string | null; problem: 'untrusted' | 'changed' | null }` (`untrusted`: https and mode `none`; `changed`: mode `pinned` and `served` differs from `fingerprint`). `GET /api/cameras(/:cam)` keeps its fields and gains `served` and `problem`.
- Produces: `OnboardingService.servedNow(cam: string): string | null` (the cached served fingerprint; starts a background measure when older than the existing measure interval).
- Produces: `export function cameraCallsApi(d: CameraCallsDeps): express.Router` with `CameraCallsDeps = { cameras: CameraRegistry; audit: Pick<AuditLog, 'write'>; tls: (id: string) => CertState | undefined; served: (id: string) => string | null; credentials: (id: string) => Credentials; access: AccessDeps }` — later tasks add routes to this router.
- Produces: the status body (all keys always present):

```ts
{ id, online, since, checkedAt: number | null, error: string | null,
  model: string | null, firmware: string | null, hardware: string | null, name: string, simulator: string | null,
  streams: { main: StreamInfo | null; sub: StreamInfo | null },
  sd: { present: boolean; mounted: boolean; capacityMB: number | null; freeMB: number | null; checkedAt: number } | null,
  time: { clockOffsetMs: number | null; stdOffsetMinutes: number; dstOffsetMinutes: number; dstRule: DstRule | null } | null,
  certificate: { subject: string; issuer: string; validTo: string } | null,
  credentials: Credentials, tls: CameraTlsView }
```

- [ ] **Step 1: Check cam-sim per model.** In a scratch vitest run (not committed), start `startSim({ model })` for `RLC-1224A`, `CX820`, `E1-Outdoor-Pro` and call `GetEnc`, `GetHddInfo`, `GetDevInfo`, `Snap` and every Get/Set pair of Task 3 through a `ReolinkClient`. Expected: every one answers rspCode 200. A gap: open a cam-sim issue and stop this plan until it is released.

- [ ] **Step 2: Write the failing tests** in `test/camera-calls-status.test.ts`:

```ts
it('answers the status of a camera with a client token', async () => {
  const r = await request(p.base).get('/api/cameras/cam1/status').set(auth()).expect(200);
  expect(r.body).toMatchObject({ id: 'cam1', online: true, model: expect.any(String), firmware: expect.any(String), hardware: expect.any(String), simulator: expect.any(String) });
  expect(r.body.streams.sub).toEqual({ codec: 'h264', width: expect.any(Number), height: expect.any(Number), fps: expect.any(Number) });
  expect(r.body.sd).toMatchObject({ present: true, mounted: true });
  expect(r.body.time).toMatchObject({ stdOffsetMinutes: expect.any(Number), dstOffsetMinutes: expect.any(Number) });
  expect(r.body.credentials).toMatchObject({ source: expect.any(String), authOk: true });
  expect(r.body.tls).toMatchObject({ mode: expect.any(String), problem: expect.toBeOneOf([null, 'untrusted']) });
});
it.each(['RLC-1224A', 'E1-Outdoor-Pro'] as const)('reports %s main as h265 (its GetEnc)', async (model) => { /* main.codec === 'h265' */ });
it('asks GetEnc once per 10 minutes, again 30 s after a failure', async () => { /* StreamsReader with a counting stub command and a fake now() */ });
it('answers offline from the poller without waiting for the camera', async () => { /* sim stopped → online false, error set, answered < 1 s, streams both null */ });
it('reports a pinned camera serving another certificate as tls.problem "changed"', async () => { /* pin, sim.engine.importCertificate(), servedNow refreshed → problem 'changed', served !== fingerprint */ });
it('answers 401 to the audit token and 404 to an unknown camera', async () => {});
```

- [ ] **Step 3: Run to verify they fail**

Run: `npx vitest run test/camera-calls-status.test.ts`
Expected: FAIL, 404 on `/api/cameras/cam1/status`.

- [ ] **Step 4: Implement.** `StreamsReader` is cams's `ReolinkClient.streams()`/`toStream()` (cams `server/reolink/client.ts:279`) over a `CameraCommand`. The route reads only caches and the poller: `streams.read()` and `certificate()` only while the poller says online, each bounded by 5 s (`within` from `src/async.ts`; on timeout the field is null). `sd` from `sdWatch` (null until its first successful read); `time` from `w.timeInfo()` plus `status.state().clockOffsetMs`. Mount in `src/proxy.ts` next to `ptzApi`: `app.use('/api', requireAccess('client', access), cameraCallsApi({...}))`. Add the route to `openapi.yaml` and a "Camera status" block under README's Client API.

- [ ] **Step 5: Run to verify they pass**

Run: `npx vitest run test/camera-calls-status.test.ts test/client-api.test.ts test/openapi.test.ts test/camera-status.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/camera/streams.ts src/api/camera-calls-api.ts src/camera/client.ts src/camera/status.ts src/cameras/worker.ts src/api/client-api.ts src/onboarding/service.ts src/proxy.ts openapi.yaml README.md test/camera-calls-status.test.ts
git commit -m "feat: camera status for clients (streams, SD, time, certificate)"
```

---

### Task 2: On-demand snapshot

**Files:**
- Modify: `src/stills/go2rtc.ts` (`frame`), `src/api/camera-calls-api.ts`, `openapi.yaml`, `README.md`
- Test: `test/camera-calls-snapshot.test.ts`

**Interfaces:**
- Consumes: `cameraCallsApi` (Task 1).
- Produces: `Go2rtc.frame(cam: string, stream: 'sub' | 'main'): Promise<Buffer>` — `GET /api/frame.jpeg?src=<cam>_<stream>` on the 127.0.0.1 API, 10 s timeout, rejects on a non-200 or a body that is not a JPEG (`ff d8`).
- Produces: `GET /api/cameras/:cam/snapshot.jpg?stream=main|sub` (client; default `main`): `image/jpeg`, `Cache-Control: no-store`. `main`: the camera's `Snap` (`w.client.snapshot()`). `sub`: `go2rtc.frame` — 404 `stream_unavailable` when the camera has no go2rtc stream (stills off). 400 `invalid` for another `stream`; 503 `camera_offline`; 502 `camera_error`.

- [ ] **Step 1: Write the failing tests**: `main` answers a JPEG whose SOF size equals the sim's main resolution; `sub` (skipIf no `CAMPROXY_TEST_GO2RTC`) answers a JPEG of the sub size; `stream=foo` → 400; a camera with `stills.enabled: false` and `stream=sub` → 404 `stream_unavailable`; sim stopped → 503 `camera_offline`; the body of any refusal has no `rtsp://`.
- [ ] **Step 2: Run** `npx vitest run test/camera-calls-snapshot.test.ts` — Expected: FAIL (404).
- [ ] **Step 3: Implement** `frame` and the route (CameraError mapping as `ptz-api.ts`'s `fail`); openapi + README.
- [ ] **Step 4: Run** `npx vitest run test/camera-calls-snapshot.test.ts test/go2rtc.test.ts test/openapi.test.ts` — Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add src/stills/go2rtc.ts src/api/camera-calls-api.ts openapi.yaml README.md test/camera-calls-snapshot.test.ts
git commit -m "feat: on-demand camera snapshot for clients"
```

---

### Task 3: Camera settings model and routes

**Files:**
- Create: `src/camera/settings/model.ts` (cams `server/reolink/settings.ts`, moved), `src/camera/settings/io.ts`, `test/camera-settings-model.test.ts` (cams `test/settingsMapping.test.ts`, moved), `test/camera-settings-api.test.ts`
- Modify: `src/cameras/worker.ts` (`writeLock`), `src/api/camera-calls-api.ts`, `src/api/auth.ts` (`MANAGED_ALLOWED`), `openapi.yaml`, `README.md`, `docs/audit-log.md`

**Interfaces:**
- Produces (`model.ts`): exactly cams's exports and shapes — `DetectionSettings`, `ImageSettings`, `DetectionPatch`, `ImagePatch`, `RawDetection`, `RawImage`, `SettingsCommand`, `AI_KINDS`, `AI_TYPE`, `OSD_POSITIONS`, `detectionFrom`, `imageFrom`, `validateDetectionPatch`, `validateImagePatch`, `detectionCommands`, `imageCommands`, `changedKeys`, `patchApplied`. Copy the file with its comments; only import paths change.
- Produces (`io.ts`):
  - `export type SettingsSection = 'detection' | 'image'`; `export const SECTIONS: readonly SettingsSection[]`
  - `readSection(command: CameraCommand, section: SettingsSection): Promise<{ raw: RawDetection | RawImage; settings: DetectionSettings | ImageSettings }>` (cams `server/reolink/device.ts` `readDetectionRaw`/`readImageRaw`)
  - `writeSection(command: CameraCommand, section: SettingsSection, body: unknown): Promise<WriteResult>` where `WriteResult = { status: 400; details: string[] } | { status: 200 | 207; fields: Record<string, { ok: boolean; error?: 'camera_rejected' | 'not_applied' }>; settings: DetectionSettings | ImageSettings; patch: DetectionPatch | ImagePatch; unexpected: string[] }` — cams `server/routes/settings.ts` `apply`, `expectedChange` and `writeSection` moved; an offline or auth CameraError rethrows (whole request fails).
- Produces: `CameraWorker.writeLock: Semaphore` (`src/camera/semaphore.ts`, 1 permit), shared by settings and light writes.
- Produces routes: `GET /api/cameras/:cam/settings` → `{ detection, image }`; `GET /api/cameras/:cam/settings/:section` → the section's settings; `PUT /api/cameras/:cam/settings/:section` (admin-kind) → `200|207 { fields, settings }`, 400 `{ error: 'invalid', details }`, 404 `not_found` (unknown section). 503/502 as Task 2.
- Produces: `MANAGED_ALLOWED` line `['PUT', /^\/api\/cameras\/[^/]+\/settings\/(detection|image)$/]`.
- Produces audit `camera-settings`: category `configuration`, type `change`, outcome `success` when every field is ok, else `failure` with `error` `not_applied` or `camera_rejected`; user `actorOf(access)`; details `{ section, patch, fields: {<field>: 'ok' | <error>}, unexpected (≤ 20 keys), requestedBy }`. A 400 or a camera that was offline before any write writes nothing.

- [ ] **Step 1: Move the model test.** Copy cams `test/settingsMapping.test.ts` to `test/camera-settings-model.test.ts` with imports pointing to `../src/camera/settings/model`. Run `npx vitest run test/camera-settings-model.test.ts` — Expected: FAIL (module not found).
- [ ] **Step 2: Move the model.** Copy cams `server/reolink/settings.ts` to `src/camera/settings/model.ts`. Run the same command — Expected: PASS.
- [ ] **Step 3: Write the failing route tests** in `test/camera-settings-api.test.ts` (port the cams `test/settingsRoutes.test.ts` cases that hit the camera, now through the proxy), plus:

```ts
it('reads both sections with a client token', async () => { /* 200 {detection: {recording: boolean, …}, image: {dayNight: …}} */ });
it('refuses a write with a client token (403 admin_only) and allows a managed admin token', async () => {});
it('writes the whole object and re-reads it', async () => { /* PUT image {flip:{vertical:true}} → 200; sim Isp keeps every other key; GET shows vertical true */ });
it('answers 207 with not_applied when the camera ignores a write', async () => { /* startSim({ faults: [{ name: 'settings.ignore', cmds: ['SetIsp'] }] }) → 207, fields.flip.error 'not_applied'; audit outcome failure */ });
it('answers 207 with camera_rejected when the camera refuses one command', async () => { /* faults: [{ name: 'settings.fail', cmds: ['SetOsd'] }] */ });
it('serializes two writers on one camera', async () => { /* PUT image {flip:{mirror:true}} and PUT image {dayNight:'color'} at once → both 200; GET shows both */ });
it('logs out after a write', async () => { /* vi.spyOn(p.proxy.cameras.get('cam1')!.client, 'logout') called once per PUT */ });
it('audits camera-settings with section, patch and fields, never a password', async () => {});
it('answers 400 invalid with details for an unknown field and 404 for an unknown section', async () => {});
```

- [ ] **Step 4: Run** `npx vitest run test/camera-settings-api.test.ts` — Expected: FAIL (404).
- [ ] **Step 5: Implement** `io.ts`, the routes (the PUT inside `w.writeLock.run(...)`, `w.client.logout()` in `finally`), the `MANAGED_ALLOWED` line, openapi, README ("Camera settings"), `docs/audit-log.md` row.
- [ ] **Step 6: Run** `npx vitest run test/camera-settings-model.test.ts test/camera-settings-api.test.ts test/auth-managed-routes.test.ts test/openapi.test.ts` — Expected: PASS.
- [ ] **Step 7: Commit**

```bash
git add src/camera/settings/model.ts src/camera/settings/io.ts src/cameras/worker.ts src/api/camera-calls-api.ts src/api/auth.ts openapi.yaml README.md docs/audit-log.md test/camera-settings-model.test.ts test/camera-settings-api.test.ts
git commit -m "feat: camera settings for clients (cams's model, whole-object writes, audited)"
```

---

### Task 4: Light

**Files:**
- Modify: `src/api/camera-calls-api.ts`, `src/api/auth.ts`, `openapi.yaml`, `README.md`, `docs/audit-log.md`
- Test: `test/camera-light-api.test.ts`

**Interfaces:**
- Consumes: `writeLock` (Task 3).
- Produces: `GET /api/cameras/:cam/light` (client) → `{ on: boolean }` (`WhiteLed.state === 1`); `PUT /api/cameras/:cam/light` (admin-kind) body exactly `{ on: boolean }` (else 400 `invalid`) → 200 `{ on }`, 502 `{ error: 'not_applied', on }`. The write: GetWhiteLed, SetWhiteLed with the whole object and `state` 1/0 (nothing sent when already so), re-read every 250 ms for up to 5 s (cams `server/routes/settings.ts:151-196`, measured lag), logout.
- Produces: `MANAGED_ALLOWED` line `['PUT', /^\/api\/cameras\/[^/]+\/light$/]`.
- Produces audit `camera-light`: configuration/change, details `{ from: boolean, to: boolean, requestedBy }`; outcome `failure` with error `not_applied` when the re-read never showed it. A request that changed nothing writes nothing.

- [ ] **Step 1: Write the failing tests** (port cams `test/lightRoutes.test.ts`): on/off round trip; a client token on PUT → 403 `admin_only`; `{on: 'yes'}` and `{on: true, x: 1}` → 400; `faults: [{ name: 'settings.ignore', cmds: ['SetWhiteLed'] }]` → 502 `not_applied` after ≈ 5 s and an audit failure; already on → 200 without a `SetWhiteLed` (`sim.sim.engine.counters.setCalls`).
- [ ] **Step 2: Run** `npx vitest run test/camera-light-api.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** the two routes, the allow line, openapi, README, audit-log row.
- [ ] **Step 4: Run** `npx vitest run test/camera-light-api.test.ts test/auth-managed-routes.test.ts test/openapi.test.ts` — Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add src/api/camera-calls-api.ts src/api/auth.ts openapi.yaml README.md docs/audit-log.md test/camera-light-api.test.ts
git commit -m "feat: camera light for clients"
```

---

### Task 5: Reboot for managed admins

**Files:**
- Modify: `src/api/camera-calls-api.ts`, `src/api/auth.ts`, `openapi.yaml`, `README.md`
- Test: `test/camera-reboot-api.test.ts`

**Interfaces:**
- Consumes: `CameraWorker.reboot.request(who: RebootRequester): Promise<RebootAnswer>` (`src/camera/reboot.ts`), `whoOf` (`src/api/onboarding-api.ts`).
- Produces: `POST /api/cameras/:cam/reboot` (admin-kind), body exactly `{ confirm: 'reboot' }` (else 400 `invalid`) → 202 `{ confirmed }`; 429 with `Retry-After` and the body the `camera-reboot` action answers today (`src/api/actions.ts` `tooSoon`); 502 `{ error, detail }`. Audited by `CameraReboot` itself (`camera-reboot`, user `actorOf`).
- Produces: `MANAGED_ALLOWED` line `['POST', /^\/api\/cameras\/[^/]+\/reboot$/]`.

- [ ] **Step 1: Write the failing tests**: a managed admin token reboots (202, `sim.sim.engine.counters.reboots` +1, audit `camera-reboot` with `user: 'token:cams'`); a second call → 429 with `Retry-After`; a client token → 403 `admin_only`; `{}` and `{confirm: 'reboot', x: 1}` → 400 and no Reboot sent.
- [ ] **Step 2: Run** `npx vitest run test/camera-reboot-api.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** the route (same answer mapping as the action), the allow line, openapi, README.
- [ ] **Step 4: Run** `npx vitest run test/camera-reboot-api.test.ts test/camera-reboot.test.ts test/auth-managed-routes.test.ts test/openapi.test.ts` — Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add src/api/camera-calls-api.ts src/api/auth.ts openapi.yaml README.md test/camera-reboot-api.test.ts
git commit -m "feat: camera reboot for managed admin tokens"
```

---

### Task 6: Live video as MSE over a WebSocket

**Files:**
- Create: `src/stream/live.ts`, `src/api/live-upgrade.ts`, `test/live-ws.test.ts`, `test/live-upgrade.test.ts`
- Modify: `src/stills/go2rtc.ts` (`wsUrl`), `src/api/auth.ts` (`upgradeAccess`), `src/proxy.ts` (an `upgrade` listener on the http and the https server), `openapi.yaml`, `README.md`

**Interfaces:**
- Produces (`go2rtc.ts`): `Go2rtc.wsUrl(cam: string, stream: 'sub' | 'main'): string` → `ws://127.0.0.1:<apiPort>/api/ws?src=<cam>_<stream>`.
- Produces (`auth.ts`): `upgradeAccess(req: IncomingMessage, d: AccessDeps): AccessInfo` — `accessOf` over the raw request: bearer only (a cookie session counts as none), the same order and `onRefused` reporting.
- Produces (`live.ts`):
  - `export const LIVE = { maxPerCamera: 8, maxTotal: 32, maxBufferedBytes: 8 * 1024 * 1024, startMs: 10_000 } as const`
  - `export const DEFAULT_CODECS = 'avc1.640029,avc1.64002A,avc1.640033,hvc1.1.6.L153.B0,mp4a.40.2,mp4a.40.5'`
  - `export function validCodecs(v: unknown): string | null` — undefined → `DEFAULT_CODECS`; a string matching `^[A-Za-z0-9.,]{1,512}$` → it; anything else → null.
  - `export const MSE_MIME = /^video\/mp4; codecs="[A-Za-z0-9.,]{1,512}"$/`
  - `export class LiveRelay { constructor(o: { now?: () => number }); count(cam?: string): number; relay(client: WebSocket, upstreamUrl: string, codecs: string, info: { cam: string; stream: 'sub' | 'main' }): void }`
- Protocol to the client (cams): first a text `{"type":"mse","value":"video/mp4; codecs=\"…\""}` (go2rtc's own message, forwarded only when `value` matches `MSE_MIME`), then binary messages (fMP4 init segment, then fragments, as go2rtc sends them). Failures: a text `{"type":"error","value":"stream_unavailable"}` then close 1011; no `mse` within `startMs` → the same; a client with more than `maxBufferedBytes` queued (`client.bufferedAmount`) → close 4008 `slow_consumer`. Either side closing closes the other.
- Produces (`live-upgrade.ts`): `export function liveUpgrade(d: { access: AccessDeps; cameras: CameraRegistry; relay: LiveRelay }): (req: IncomingMessage, socket: Duplex, head: Buffer) => void`. Path `^/api/cameras/([^/?]+)/live$` (other upgrade paths: 404). Checks in this order. Refused before the upgrade, as a plain HTTP answer with a JSON body, then the socket ends: `token`/`access_token` in the query → 400 `token_in_url`; 60 upgrades per client IP and minute → 429 `rate_limited`; `upgradeAccess` not client or admin → 401 `unauthorized`; unknown camera → 404 `not_found`; `stream` not `sub`/`main` or `validCodecs` null → 400 `invalid`. Then `WebSocketServer({ noServer: true }).handleUpgrade`; the camera's state is answered over the socket (a client such as cams's undici `WebSocket` can't read a refused upgrade's status), as `{"type":"error","value":<code>}` and close 1013: restarting → `camera_restarting`; no go2rtc stream for the camera (stills off, go2rtc not up) → `stream_unavailable`; poller offline → `camera_offline`; `relay.count(cam) >= maxPerCamera` or `relay.count() >= maxTotal` → `too_many_streams`. Else `relay.relay(...)`. Not audited (a read); `live_open` / `live_close` {cameraId, stream, ms, bytes} at debug.

- [ ] **Step 1: Write the failing unit tests** (`test/live-upgrade.test.ts`, no go2rtc needed; a proxy with stills off): every HTTP refusal above with its status and code, and every socket refusal as its `error` message and close 1013; a cookie session alone → 401; `validCodecs` cases (`undefined`, `'avc1.64002A,mp4a.40.2'`, `'avc1"; x'`, 600 chars).
- [ ] **Step 2: Write the failing go2rtc tests** (`test/live-ws.test.ts`, `describe.skipIf(!process.env.CAMPROXY_TEST_GO2RTC)`, a `ws` client with `Authorization: Bearer <client token>`):

```ts
it('relays the sub stream as MSE: the mime first, then fMP4', async () => {
  // first message text: {type:'mse', value: /^video\/mp4; codecs="avc1\./}; next binary starts with an ftyp box (bytes 4..8 === 'ftyp'); a moof follows within 5 s
});
it('relays main as h265 on request', async () => { /* stream=main → value contains 'hvc1' or 'hev1' */ });
it('closes go2rtc\'s consumer when the client leaves', async () => { /* close client → go2rtc.streams().cam1_sub.consumers back to the count before */ });
it('closes a stalled reader with 4008 slow_consumer', async () => { /* client socket paused (ws _socket.pause()) → close code 4008 within 60 s */ });
it('never forwards go2rtc text but the mse message', async () => { /* camera password changed on the sim so go2rtc fails → client gets {type:'error',value:'stream_unavailable'}; no message, close reason or logBuffer line contains 'rtsp://' or the password */ });
it('counts streams per camera and answers the ninth too_many_streams', async () => {});
```

- [ ] **Step 3: Run** `npx vitest run test/live-upgrade.test.ts test/live-ws.test.ts` — Expected: FAIL.
- [ ] **Step 4: Implement** `wsUrl`, `upgradeAccess`, `LiveRelay` (upstream: Node's global `WebSocket`, `binaryType = 'arraybuffer'`, sends `{"type":"mse","value": codecs}` on open), `liveUpgrade`, and in `src/proxy.ts` `server.on('upgrade', live)` and `hs.on('upgrade', live)`; shutdown closes every relayed socket. openapi: `GET /api/cameras/{cam}/live` with a 101 answer and the refusals; README "Live video" (the protocol above, and that cams relays it to browsers as chunked HTTP).
- [ ] **Step 5: Run** `CAMPROXY_TEST_GO2RTC=$PWD/tools/go2rtc npx vitest run test/live-upgrade.test.ts test/live-ws.test.ts test/openapi.test.ts test/auth-managed.test.ts` — Expected: PASS.
- [ ] **Step 6: Commit**

```bash
git add src/stream/live.ts src/api/live-upgrade.ts src/stills/go2rtc.ts src/api/auth.ts src/proxy.ts openapi.yaml README.md test/live-ws.test.ts test/live-upgrade.test.ts
git commit -m "feat: live video as MSE over a WebSocket on the proxy's address"
```

---

### Task 7: Announce `camera-calls`, docs and the full run

**Files:**
- Modify: `src/stream/sse.ts` (`FEATURES`), `README.md` (features line, "cams integration"), `CHANGELOG.md`, `test/client-api.test.ts`
- Test: `test/camera-calls-auth.test.ts`

**Interfaces:**
- Produces: `FEATURES = ['sse-cam-list', 'ptz', 'camera-calls']`. `camera-calls` means: every route of Tasks 1–6, `PUT /control/cameras/:cam/password` and `POST /control/cameras/:cam/actions/camera-trust-pin` for managed admins, `tls.served`/`tls.problem` in the camera view. cams switches a proxy over on this entry (spec §8).

- [ ] **Step 1: Write the failing tests**: `GET /api/cameras` items' `features` contain `camera-calls`; `test/camera-calls-auth.test.ts` walks every route of this plan with a client token, a managed admin token, the audit token and none, and asserts the table: reads 200 for client and managed admin; writes 403 `admin_only` for client, not 403 for managed admin; audit token and none 401.
- [ ] **Step 2: Run** `npx vitest run test/client-api.test.ts test/camera-calls-auth.test.ts` — Expected: FAIL (feature missing).
- [ ] **Step 3: Implement** the entry; README (features line: `camera-calls: status, snapshot, live, settings, light, reboot for cams`; "cams integration": cams calls cameras only through these routes when it sees the entry); CHANGELOG under `## Unreleased`: "cams can reach a camera only through its proxy: camera status, snapshot, live video (WebSocket), settings, light and reboot for cams (`camera-calls`)."
- [ ] **Step 4: Run the whole suite and the checks**

Run: `npm run lint:types && npm run build && CAMPROXY_TEST_GO2RTC=$PWD/tools/go2rtc npm test`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/stream/sse.ts README.md CHANGELOG.md test/client-api.test.ts test/camera-calls-auth.test.ts
git commit -m "feat: announce camera-calls for cams"
```

After the PR merges: release (CHANGELOG heading PR afterwards), update the Pi (`release-update-pi`), post to #cams-application. The cams plan (`cams` `docs/superpowers/plans/2026-10-31-cams-through-proxy.md`) starts from that release.

## Decisions beyond the spec

- **Settings sections are cams's two, `detection` and `image`.** They already hold recording, motion/AI detection, IR, white light (spotlight), day/night, flip and on-screen text. Encoding is read-only (`streams` in status): stream changes are a non-goal (§2).
- **Light is `{on: boolean}`.** "Auto" is the spotlight mode in the `image` section, as in cams today.
- **Snapshot `sub` comes from go2rtc's `frame.jpeg`** (the camera's `Snap` is full size only); without a go2rtc stream it is 404 `stream_unavailable`, not a camera Snap scaled down.
- **Status carries `tls.served` and `tls.problem`** so cams's trust dialog shows the fingerprint the proxy measured from one client read (§6.2), and `credentials` (Part A's block) for the password button.
- **Live is bearer-only** (no cookie session), so a page in a browser can't open it cross-site; at most 8 per camera and 32 per proxy; a reader that falls 8 MiB behind is closed (cams reconnects).
- **Recordings: no new route.** cams's Search/Download fallbacks map onto the existing `/recordings`, `/recordings/days` and `/recordings/:id` (Baichuan VOD); no gap was found.
