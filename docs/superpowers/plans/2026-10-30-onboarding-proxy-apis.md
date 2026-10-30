# Camera onboarding: proxy APIs (cam-proxy, part A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A camera goes from "on the LAN with its admin password" to "configured, trusted and checked" on a proxy through APIs only: write-only password API, probe, add/remove camera (also on the single-camera Pi), certificate pin without a site CA, one onboarding status per camera, the time zone, and the cams-admin commands and heartbeat field that read and drive it.

**Architecture:** A new module folder `src/onboarding/` holds the pieces (password attempts, login check, probe, zone rules, status, leftovers) and one `OnboardingService` that `src/proxy.ts` wires with the existing loaded-config, worker registry, camera certificates, env-file writer and audit log. Routes live in a new `src/api/onboarding-api.ts` (mounted on `/control`, admin access); the three new actions (`camera-probe`, `camera-trust-pin`, `camera-time-set`) go through the existing `performAction` core so the command channel reuses them. `CameraCerts` gains an admin pin that works without `tls.site`.

**Tech Stack:** TypeScript (Node 26, CommonJS), Express 5, vitest + supertest, cam-sim in process (models `RLC-1224A`, `CX820`, `E1-Outdoor-Pro`), Svelte 5 admin UI, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-30-camera-onboarding-design.md` — this plan covers §4.1–§4.7 and the decisions in §10. Not §4.8 (camera calls behind the proxy for cams): a later plan.

## Prerequisites (before Task 10 and Task 11)

**1. cams-admin contract change FIRST (needed by Task 11).** The heartbeat body is `additionalProperties: false` in `strict/heartbeat.schema.json`, the command names, allow entries and camera actions are enums, and `scripts/contract-drift.sh` requires `test/contract/cams-admin-v1` to equal cams-admin main's `contract/v1`. So a cams-admin PR must land on main (or on a branch named in `SOURCE` while it is open) before Task 11 vendors it. That PR's `contract/v1` must accept, in both the lenient and the strict schemas:

- `heartbeat.schema.json` → `body.onboarding` (optional, kept when `truncated`): an object, `maxProperties` 64, property names `^[a-z0-9][a-z0-9-]{0,31}$`, each value `{ready: boolean, missing: string[]}` (`additionalProperties: false`, both required), `missing` items enum `reachable login trust capabilities stream events ftp time name poe profile`, `uniqueItems`, `maxItems` 11.
- `strict/heartbeat.schema.json` → `proxy.commands.allow` enum gains `camera.onboarding.get` and `camera.action:camera-time-set`.
- `command.schema.json` (strict and lenient) → command name enum gains `camera.onboarding.get`.
- New `commands/camera.onboarding.get.args.schema.json` (+ strict): `{v: 1, camera: <camera id> | null}`, both required, no other keys.
- New `commands/camera.onboarding.get.result.schema.json` (+ strict): `{cameras: {<camera id>: OnboardingStatus}, clamped?: boolean}`, `cameras` `maxProperties` 64; `OnboardingStatus` = `{camera, ready: boolean, checkedAt: integer ≥ 0, steps: {<step>: {ok: boolean | null, detail: string ≤ 200, action?: string ≤ 32}}, trust: {mode: site-ca|pinned|public|none, fingerprint: SHA256 pin | null, served: SHA256 pin | null}, time: {clockOffsetMs: integer | null, zone: string ≤ 64 | null, cameraStdOffsetMinutes: integer | null, cameraDst: boolean | null}}` (the 11 step names above, all required).
- `strict/commands/camera.action.args.schema.json` → `action` enum gains `camera-time-set` (camera required, like the others); cams-admin's own lists derived from the contract mark it disruptive (off by default per proxy).
- `remote-settable.json` → `denied` gains `time.zone` (local only).
- Fixtures: `valid-heartbeat-onboarding.json`, `valid-command-onboarding-get.json`, `valid-result-onboarding-get.json`, `valid-command-camera-time-set.json`, and a drift fixture with an unknown step name.
- `camera.ftp.setup` (spec §4.6) is the existing `camera.action:camera-ftp-setup`: no contract change.

**2. cam-sim prerequisites (a separate small cam-sim PR, released before Task 10).** cam-sim already has what the probe, password and trust tests need: the factory certificate (self-signed, CN `CERTIFICATE`) on its HTTPS port, which a test reads with `servedCertificate` (`src/tls/served.ts`); `Login` refuses a wrong password with rspCode `-7`; `SetFtpV20`/`GetFtpV20`/`TestFtp`; `GetDevInfo` and `GetAbility` per model; `sim.engine.importCertificate()` to make the camera serve another certificate. Missing:

- **`SetTime`**, measured first: one read-only `GetTime` with `action: 1` and one `SetTime` that writes back exactly what `GetTime` returned, on the real camera (Klaus's OK needed; log out afterwards) — this records the required fields, whether `Time.year…sec` must be sent and the range errors. cam-sim then stores `Time.timeZone` and the whole `Dst` object (`enable`, `offset`, `startMon/Week/Weekday/Hour/Min/Sec`, `endMon/…`), answers `GetTime` from them (today `timeValue` derives the zone from `CAMSIM_TZ` and a hard-coded US rule; the configured tz stays the default until a `SetTime`), applies them to its local clock (file names, Search), notes `SetTime` in `counters.setCalls`, and refuses out-of-range values with the measured rspCode.
- Release cam-sim; Task 10 bumps the `cam-sim` tarball in `package.json`.

## Global Constraints

- A camera password is never logged, audited, returned, put in a URL, or stored anywhere but `data/admin/camera-passwords.json` (mode 600, `cameraPasswordStore`). Tests assert a sentinel password appears in no answer, no audit record (`data/audit/*`) and no `logBuffer` line.
- A password reaches a camera only over http, or over https verified by the site CA, a public name (`tlsName`), or a pin to a fingerprint the caller confirmed. https with trust `none` → 409 `not_trusted` (pin first).
- Password attempts: **5 per camera address per 10 minutes** (`PASSWORD_ATTEMPTS = 5`, `PASSWORD_WINDOW_MS = 600_000`), shared by the password API, probe-with-password and add; the 6th answers 429 `too_many_attempts` with `Retry-After` and never reaches the camera.
- Camera writes: whole-object Sets (read, change, Set the whole object), re-read after writing, log out afterwards (a standalone client: `logout()` in `finally`).
- Probe: read-only on the camera (`Get*`, `Login`, `Logout` only); local only (never in `MANAGED_ALLOWED`, in `NEVER_REMOTE_ACTIONS`).
- Auth (§10.1, §10.2): managed-admin may `PUT /control/cameras/:cam/password` and `POST /control/cameras/:cam/actions/camera-trust-pin` (added to `MANAGED_ALLOWED`); `POST /control/cameras` and `DELETE /control/cameras/:id` are local admin only (`requireLocalAdmin()`); nothing here is a cams-admin command except `camera.onboarding.get` and `camera.action:camera-time-set`.
- Errors: 422 `camera_refused` (login rejected), 503 `camera_offline`, 409 `env_password`, `not_trusted`, `fingerprint_mismatch`, `camera_limit`, `camera_exists`, `camera_id`, `config_json`, `not_available`, `zone_unknown`, `zone_unsupported`, `move_open`; 400 `invalid`; 429 `too_many_attempts`.
- New audit actions: `camera-password`, `camera-probe`, `camera-add`, `camera-remove`, `camera-time`; the pin writes the existing `camera-trust` with `details.op: 'pin'`. Each goes into `src/audit/actions.ts`, `web/src/lib/audit.ts` `ACTIONS` (same order) and `docs/audit-log.md`.
- Every new route goes into `openapi.yaml` (`test/openapi.test.ts`); a new setting into `config.schema.json` (`npm run schema`) and the remote-settable classification.
- Public repo: tests and docs use `192.0.2.x` addresses, made-up fingerprints (`SHA256:` + 64 hex) and no serials.
- `npm test`, `npm run lint:types` and `npm run check` pass at every commit; user-visible changes go under `## Unreleased` in CHANGELOG.md.

## Decisions beyond the spec

- **Pin before password.** https cameras get their certificate pinned (or are site-CA/public) before a password is sent. The probe takes `password` as optional: without it, ports and certificate only; with it, `fingerprint` is required and the login runs over a connection pinned to it. `POST /control/cameras` logs in pinned to `trust.fingerprint`. `PUT …/password` with trust `none` answers 409 `not_trusted`. (Otherwise the password goes to whatever answers on that address.)
- `credentials` (§4.1) is added to the camera status block (`GET /control/cameras`, `GET /control/cameras/:cam/status`; there is no `GET /control/cameras/:cam`) and to the client view `GET /api/cameras(/:cam)`. `source: 'env'` covers the camera's own variable and the shared `CAMPROXY_CAMERA_PASSWORD` (`envName` says which); only the own variable conflicts with a save (409 `env_password` when the proxy can't remove it); the store already wins over the shared default.
- The rate limit is keyed by the camera's bare address (the same physical account for the password API, the probe and add).
- Command kinds (§4.6) map to the contract as: `camera.onboarding.get` = a new command, allow entry `camera.onboarding.get`, **on by default** (a policy can switch it off; `policy.json` gains `off: string[]`); `camera.ftp.setup` = the existing `camera.action:camera-ftp-setup`; `camera.time.set` = a new camera action `camera.action:camera-time-set`, disruptive, off by default, budgeted.
- Onboarding steps: "off by choice" (FTP off for the camera, stills off) is `ok: true, detail: 'off'`; `null` means not known yet; `ready` = every required step `ok === true`. An **http** camera's `trust` step is `ok: false` ("plain http: no certificate"), so http cameras are never `ready` (fail closed, spec §2 anti-goals). Tests that expect `ready` use https sims.
- `time.zone` is a new optional setting (IANA name, validated with `Intl`), local only (`LOCAL_ONLY` in `src/fleet/remote-settable.ts`, contract `denied`). The host zone is known when `process.env.TZ` is set or `Intl` resolves a zone other than `UTC`/`Etc/UTC`.
- Single-camera proxy (`loaded.legacyCamera`): the added camera always takes the legacy camera's id (`id` optional; another id → 409 `camera_id`). Offboarding it removes `CAMERA_HOST` from the env file and leaves the camera idle (its `config.json` object stays; a `camera.host` there is a leftover).
- `DELETE /control/cameras/:id` takes an id, not a running camera: a camera already gone from `config.json` (after a restart) can still be cleaned up (password, env line, TLS files, PTZ rows); a camera defined in `config.json` on a several-camera proxy is refused 409 `config_json` (remove it there, restart, call again). Leftovers are kept in `data/admin/remove-leftovers.json` (re-checked on read, like move leftovers) and shown on `GET /control/status` as `removeLeftovers`; they are not in the heartbeat (no contract field).
- Probe defaults: `protocol: 'https'`, `user: 'admin'`; ports 80/443/554/8000/9000 overridable by `ports` (non-default cameras, tests). The same `user` default for add.
- The onboarding status measures the served certificate of an https camera (`servedCertificate`, 3 s) at most once a minute per camera; the heartbeat uses only the cached value (no camera connection from the heartbeat).

## Review Focus

1. **A password in an answer, log or audit record.** A sentinel password through every new route (save ok, refused, offline, rate-limited, env conflict; probe; add; remove) must appear nowhere. Tests in Task 3 and Task 7 (`the password appears in no answer, audit record or log line`).
2. **Repeated wrong passwords.** A script retrying a wrong password must not lock the camera's account: the 6th try in 10 minutes is refused before any `Login`. Test in Task 3 (`the 6th attempt is 429 and the camera sees no 6th login`).
3. **A camera that serves a different certificate than the dialog showed** (swapped camera, someone in between). The pin and the add must refuse and keep trust `none`; a pinned camera that later serves another certificate is refused until pinned again. Tests in Task 5 (`a fingerprint other than the served one is 409 and pins nothing`, `a pinned camera serving a new certificate goes offline and shows trust not ok`).
4. **A password set in compose's environment or a `_FILE` secret** while the owner saves one through the API: the API must refuse (409 `env_password`), store nothing, and say what to remove; one in the managed env file is removed with its backups. Test in Task 3.
5. **Adding at the limit, and on the Pi with a camera already there.** The add is refused with nothing stored or written, the running cameras keep running, and a proxy already over its profile keeps its warning only. Tests in Task 7 (`at the limit: 409, no password stored, cameras unchanged`) and Task 8 (`a configured legacy camera: 409 camera_limit, .env unchanged`).

---

### Task 1: Credentials in the camera views

**Files:**
- Modify: `src/camera/status.ts` (CameraState gains `checkedAt?: number`, set on every check, success or failure)
- Create: `src/onboarding/credentials.ts`
- Modify: `src/api/control-api.ts` (`CameraStatusBlock.credentials`), `src/api/client-api.ts` (`info()` adds `credentials`), `src/proxy.ts` (wiring), `openapi.yaml` (schemas)
- Test: `test/onboarding-credentials.test.ts`

**Interfaces:**
- Produces:
  - `export type CredentialSource = 'env' | 'store' | 'none'`
  - `export interface Credentials { source: CredentialSource; envName?: string; authOk: boolean | null; checkedAt: number | null }`
  - `export function passwordSource(l: Loaded, id: string): { source: CredentialSource; envName?: string; ownEnv: boolean }` — own `CAMPROXY_CAMERA_PASSWORD_<ID>` (or its `_FILE`) in `l.env` → `env` + that name, `ownEnv: true`; else the store has it → `store`; else `CAMPROXY_CAMERA_PASSWORD` set → `env`, `envName: 'CAMPROXY_CAMERA_PASSWORD'`; else `none`. Mirrors `loadSecrets`' order.
  - `export function credentialsOf(src: ReturnType<typeof passwordSource>, st: CameraState): Credentials` — `authOk`: `true` when `st.online`, `false` when `st.error === 'camera_auth_failed'`, else `null`; `checkedAt: st.checkedAt ?? null`. `ownEnv` is not exposed.

- [ ] **Step 1: Write the failing tests**

```ts
it('the own variable wins, then the store, then the shared default', () => {
  expect(passwordSource(loadedWith({ env: { CAMPROXY_CAMERA_PASSWORD_CAM_2: 'x' } }), 'cam-2')).toEqual({ source: 'env', envName: 'CAMPROXY_CAMERA_PASSWORD_CAM_2', ownEnv: true });
  expect(passwordSource(loadedWith({ stored: { cam1: 'y' }, env: { CAMPROXY_CAMERA_PASSWORD: 'z' } }), 'cam1')).toEqual({ source: 'store', ownEnv: false });
  expect(passwordSource(loadedWith({ env: { CAMPROXY_CAMERA_PASSWORD: 'z' } }), 'cam1')).toEqual({ source: 'env', envName: 'CAMPROXY_CAMERA_PASSWORD', ownEnv: false });
});
it('authOk: online true, a rejected login false, anything else unknown', () => {
  const s = { source: 'store', ownEnv: false } as const;
  expect(credentialsOf(s, { online: true, since: 1, checkedAt: 5 })).toEqual({ source: 'store', authOk: true, checkedAt: 5 });
  expect(credentialsOf(s, { online: false, since: 1, error: 'camera_auth_failed', checkedAt: 6 }).authOk).toBe(false);
  expect(credentialsOf(s, { online: false, since: 1, error: 'camera_offline' }).authOk).toBeNull();
});
it('GET /control/cameras and GET /api/cameras/:cam carry credentials, never a password', async () => { /* startProxy(startSim()); both bodies have credentials {source:'env', envName:'CAMPROXY_CAMERA_PASSWORD', authOk:true}; JSON.stringify(body) does not contain sim.password */ });
```

`loadedWith` builds a `Loaded` through `loadConfig` on a temp dir (the store file written with `cameraPasswordStore`).

- [ ] **Step 2: Run** `npx vitest run test/onboarding-credentials.test.ts` — Expected: FAIL (module missing).
- [ ] **Step 3: Implement** `checkedAt` in `StatusPoller.check()`, `src/onboarding/credentials.ts`, then `credentials` in `cameraStatus()` (proxy.ts) and `info()` (client-api.ts gets a dep `credentials: (id: string) => Credentials`). Document `Credentials` in `openapi.yaml`.
- [ ] **Step 4: Run** the test file and `npm run lint:types` — Expected: PASS.
- [ ] **Step 5: Commit** `git add src/camera/status.ts src/onboarding/credentials.ts src/api/control-api.ts src/api/client-api.ts src/proxy.ts openapi.yaml test/onboarding-credentials.test.ts && git commit -m "feat: camera views say where the password comes from and whether it works"`

### Task 2: Password attempts and the pinned login check

**Files:**
- Create: `src/onboarding/attempts.ts`, `src/onboarding/login-check.ts`
- Modify: `src/camera/client.ts` (the "not verified" warning moves out of the constructor: logged once on the first request when `!trusted()`)
- Test: `test/onboarding-login-check.test.ts`

**Interfaces:**
- Produces:
  - `export const PASSWORD_ATTEMPTS = 5; export const PASSWORD_WINDOW_MS = 600_000`
  - `export class PasswordAttempts { constructor(now?: () => number); take(host: string): { ok: true } | { ok: false; retryAfterS: number } }` — key is `bareHost(splitHost(host).hostname).toLowerCase()`; every `take` that returns ok counts.
  - `export type LoginOutcome = 'ok' | 'refused' | 'offline' | 'error'`
  - `export async function checkLogin(t: { id: string; host: string; protocol: 'https' | 'http'; user: string; password: string; trust?: CameraTrust }, o?: { timeoutMs?: number }): Promise<{ outcome: LoginOutcome; device?: { model: string; firmware: string; name: string | null }; ability?: unknown }>` — a fresh `ReolinkClient` (never the worker's, so its login backoff is untouched), `setTrust(t.trust)` when given, `GetDevInfo` then `GetAbility` (`{User: {userName}}`), `logout()` in `finally`. `camera_auth_failed` → `refused`, `camera_offline` → `offline`, other errors → `error`.

- [ ] **Step 1: Write the failing tests**

```ts
it('allows 5 attempts per address per 10 minutes, then says when to retry', () => {
  let t = 0; const a = new PasswordAttempts(() => t);
  for (let i = 0; i < 5; i++) expect(a.take('192.0.2.10:443').ok).toBe(true);
  expect(a.take('192.0.2.10')).toEqual({ ok: false, retryAfterS: 600 });
  expect(a.take('192.0.2.11').ok).toBe(true);
  t = 600_001; expect(a.take('192.0.2.10').ok).toBe(true);
});
it.each(['RLC-1224A', 'CX820', 'E1-Outdoor-Pro'] as const)('%s: the right password is ok with model and ability, a wrong one refused; both log out', async (model) => {
  const s = await startSim({ model });
  const ok = await checkLogin({ id: 'x', host: s.camera.host, protocol: 'http', user: 'proxy', password: s.password });
  expect(ok.outcome).toBe('ok'); expect(ok.device?.model).toBeTruthy(); expect(ok.ability).toBeTruthy();
  expect((await checkLogin({ id: 'x', host: s.camera.host, protocol: 'http', user: 'proxy', password: 'wrong' })).outcome).toBe('refused');
  expect(s.sim.engine.sessions.online()).toHaveLength(0);
});
it('over https it logs in only to the pinned certificate', async () => { /* served = await servedCertificate('127.0.0.1', s.ports.https); trust {ca: served.pem, fingerprint: served.fingerprint} → ok; trust with another sim's certificate → 'error' and s.state.loginAttempts unchanged */ });
it('a closed port is offline', async () => { /* host 127.0.0.1:<freePort()> → 'offline' */ });
```

- [ ] **Step 2: Run** `npx vitest run test/onboarding-login-check.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** both modules and the client warning change.
- [ ] **Step 4: Run** the file plus `test/camera-client.test.ts` — Expected: PASS.
- [ ] **Step 5: Commit** `git add src/onboarding/attempts.ts src/onboarding/login-check.ts src/camera/client.ts test/onboarding-login-check.test.ts && git commit -m "feat: password attempt limit and a pinned login check"`

### Task 3: Camera password API

**Files:**
- Create: `src/onboarding/service.ts` (`OnboardingService`, grown by later tasks), `src/api/onboarding-api.ts`
- Modify: `src/config/load.ts` (`withoutEnv`), `src/api/auth.ts` (`MANAGED_ALLOWED`), `src/proxy.ts` (service + router), `src/audit/actions.ts`, `web/src/lib/audit.ts`, `docs/audit-log.md`, `openapi.yaml`
- Test: `test/onboarding-password-api.test.ts`, `test/auth-managed-routes.test.ts` (the new entry)

**Interfaces:**
- Consumes: Task 1 `passwordSource`, Task 2 `PasswordAttempts`, `checkLogin`.
- Produces:
  - `export function withoutEnv(l: Loaded, names: string[]): Loaded` in `src/config/load.ts` — rebuilt with a copy of `l.env` lacking those names (the process environment is untouched).
  - `export interface OnboardingDeps { loaded: () => Loaded; setLoaded: (l: Loaded) => void; running: () => Config; cameras: CameraRegistry; restartCamera: (cam: string) => Promise<void>; passwords: CameraPasswordStore; trustFor: (cam: string) => CameraTrust | undefined; certState: (cam: string) => CertState | null; audit: Pick<AuditLog, 'write'>; attempts: PasswordAttempts; now?: () => number }` (later tasks add fields)
  - `export type Who = ActionWho` (from `src/api/actions.ts`)
  - `OnboardingService.savePassword(cam: string, password: string, who: Who): Promise<{ status: 200; credentials: Credentials } | { status: 409 | 422 | 429 | 503 | 400; error: string; detail?: string; retryAfterS?: number }>`
  - `export function onboardingApi(s: OnboardingService): express.Router` with `PUT /cameras/:cam/password` (camera param via `cameraParam(cameras, 'admin')`).

Order in `savePassword`: validate (`password` a string of 1–64 characters, no control characters; else 400 `invalid`, nothing audited) → own env variable: in the managed env file (`readEnvValue` on `loaded.envFile.path`) → remember to remove it; else (compose environment, `_FILE`) → 409 `env_password` with `detail` naming the variable → https with `certState(cam)?.mode ?? 'none'` = `none` and no `tlsName` → 409 `not_trusted` → `attempts.take(host)` → `checkLogin` with `trustFor(cam)` → `refused` 422 `camera_refused`, `offline` 503 `camera_offline`, `error` 503 `camera_offline` → `passwords.set` → `removePasswordLine(loaded, cam)` when remembered → `setLoaded(withoutEnv(rebuildWith(...), [own name]))` → `restartCamera(cam)` → 200 `{credentials}`. One `camera-password` record for every outcome after validation: `{camera, outcome, error?, details: {envLine?: 'removed', requestedBy}}`; a rate-limited refusal at most once per address per window (`RefusalThrottle`).

- [ ] **Step 1: Write the failing tests** (an http sim; a sim user whose password the test changes with `sim.engine.sessions.modifyUser`)

```ts
it('saves a password the camera accepts, applies it without a restart, and audits no value', async () => {
  s.sim.engine.sessions.modifyUser('proxy', { password: 'n3w-Secret!' });
  await until(async () => (await get('/control/cameras/cam1/status')).body.credentials.authOk === false, 20_000);
  const r = await put('/control/cameras/cam1/password', { password: 'n3w-Secret!' });
  expect([r.status, r.body.credentials.source]).toEqual([200, 'store']);
  await until(async () => (await get('/api/cameras/cam1', CLIENT)).body.online, 20_000);
  expect(JSON.parse(readFileSync(join(dir, 'data/admin/camera-passwords.json'), 'utf8')).cameras.cam1.password).toBe('n3w-Secret!');
  expect(auditText(dir) + logText() + JSON.stringify(r.body)).not.toContain('n3w-Secret!');
  expect(lastAudit(dir, 'camera-password')).toMatchObject({ outcome: 'success', camera: 'cam1' });
});
it('a password the camera refuses is 422 camera_refused and stores nothing', ...);
it('the password appears in no answer, audit record or log line', async () => { /* sentinel through ok, refused, offline (sim.state.offline), 429 and env_password; auditText(dir) + logText() + every body */ });
it('the 6th attempt is 429 and the camera sees no 6th login', async () => { /* 5 wrong → 422 each; 6th → 429 + Retry-After; s.state.loginAttempts grew by 5 only */ });
it('removes the camera\'s line from the managed env file and its backups', async () => { /* CAMPROXY_ENV_FILE with CAMPROXY_CAMERA_PASSWORD_CAM1=old (+ a .bak-… file); after 200 neither file has the key; credentials.source 'store' */ });
it('an own variable the proxy cannot remove is 409 env_password', async () => { /* env CAMPROXY_CAMERA_PASSWORD_CAM1 only in the process env → 409 {error:'env_password', detail contains 'CAMPROXY_CAMERA_PASSWORD_CAM1'}; store file absent */ });
it('https with trust none is 409 not_trusted (pin first)', ...);
it('a managed admin token may set it; a client token may not', ...);
```

- [ ] **Step 2: Run** `npx vitest run test/onboarding-password-api.test.ts` — Expected: FAIL (404).
- [ ] **Step 3: Implement** `withoutEnv`, `OnboardingService.savePassword`, the router, `['PUT', /^\/control\/cameras\/[^/]+\/password$/]` in `MANAGED_ALLOWED`, `camera-password` in the three audit lists, the route in `openapi.yaml`.
- [ ] **Step 4: Run** the file, `test/auth-managed-routes.test.ts`, `test/audit-actions.test.ts`, `test/openapi.test.ts` — Expected: PASS.
- [ ] **Step 5: Commit** `git add src/onboarding/service.ts src/api/onboarding-api.ts src/config/load.ts src/api/auth.ts src/proxy.ts src/audit/actions.ts web/src/lib/audit.ts docs/audit-log.md openapi.yaml test/onboarding-password-api.test.ts test/auth-managed-routes.test.ts && git commit -m "feat: PUT /control/cameras/:cam/password (write-only, checked with the camera)"`

### Task 4: Probe

**Files:**
- Create: `src/onboarding/probe.ts`
- Modify: `src/api/actions.ts` (`camera-probe` case, `OWN_AUDIT`, `ActionDeps` gains `onboarding`), `src/api/control-api.ts` (`camera-probe` shares `findLimit`), `src/fleet/policy.ts` (`NEVER_REMOTE_ACTIONS` + `camera-probe`), `src/audit/actions.ts`, `web/src/lib/audit.ts`, `docs/audit-log.md`, `openapi.yaml`
- Test: `test/onboarding-probe.test.ts`, `test/fleet-policy.test.ts`

**Interfaces:**
- Consumes: Task 2 `checkLogin`, `PasswordAttempts`; `servedCertificate` (`src/tls/served.ts`); `deriveCapabilities`.
- Produces:
  - `export interface ProbeInput { host: string; protocol: 'https' | 'http'; user: string; password?: string; fingerprint?: string; ports: { http: number; https: number; rtsp: number; onvif: number; baichuan: number } }`
  - `export interface ProbeResult { host: string; ports: Record<'http' | 'https' | 'rtsp' | 'onvif' | 'baichuan', boolean>; certificate: { fingerprint: string; subject: string; issuer: string; notAfter: number; selfSigned: boolean } | null; login: 'ok' | 'refused' | 'offline' | 'not_tried'; device: { model: string; firmware: string; name: string | null } | null; capabilities: Capabilities | null; tookMs: number }`
  - `export function probeInput(body: Record<string, unknown>): ProbeInput | string` — the string is the 400 detail; defaults `protocol 'https'`, `user 'admin'`, ports 80/443/554/8000/9000, a `:port` in `host` replaces the API protocol's port; `fingerprint` must match `^SHA256:[0-9A-F]{64}$`.
  - `export async function probeCamera(i: ProbeInput, o?: { connectTimeoutMs?: number }): Promise<ProbeResult | { error: 'fingerprint_mismatch'; served: string | null }>` — TCP connects in parallel (1.5 s each); the certificate when https; a password over https needs `fingerprint` equal to the served one (else `fingerprint_mismatch`), then `checkLogin` with that pin.
  - `OnboardingService.probe(body: Record<string, unknown>, who: Who): Promise<ActionOutcome>` — 400 `invalid`, 400 `invalid` "fingerprint: required with a password over https", 409 `fingerprint_mismatch` (`extra: {served}`), 429 `too_many_attempts` (only when a password is given), 200 `ProbeResult`. One `camera-probe` record `{host, outcome, details: {model, login, requestedBy}}`.

- [ ] **Step 1: Write the failing tests**

```ts
it.each(['RLC-1224A', 'CX820', 'E1-Outdoor-Pro'] as const)('%s over https: certificate first, then model and capabilities with the confirmed fingerprint', async (model) => {
  const s = await startSim({ model });
  const ports = { http: s.ports.http, https: s.ports.https, rtsp: s.ports.rtsp, onvif: s.ports.onvif, baichuan: s.ports.baichuan };
  const a = await post('/control/actions/camera-probe', { host: `127.0.0.1:${s.ports.https}`, ports });
  expect(a.body).toMatchObject({ login: 'not_tried', ports: { https: true, onvif: true, baichuan: true }, certificate: { subject: expect.stringContaining('CERTIFICATE'), selfSigned: true } });
  const b = await post('/control/actions/camera-probe', { host: `127.0.0.1:${s.ports.https}`, ports, user: 'proxy', password: s.password, fingerprint: a.body.certificate.fingerprint });
  expect(b.body.login).toBe('ok');
  expect(b.body.capabilities.ptz === null).toBe(model !== 'E1-Outdoor-Pro');
  expect(s.state.setCalls).toEqual([]);           // read-only
  expect(s.sim.engine.sessions.online()).toHaveLength(0); // logged out
});
it('a password over https without a fingerprint is 400; with another fingerprint 409 and no login', ...);
it('managed admin rights are refused (local only); it is never remote', ...);
it('audits host, outcome and model, never the password', ...);
```

- [ ] **Step 2: Run** `npx vitest run test/onboarding-probe.test.ts` — Expected: FAIL (404 `not_found` from `performAction`).
- [ ] **Step 3: Implement** `probe.ts`, the service method, the action case (a host action: not in `CAMERA_ACTIONS`), the limiter, the policy entry, audit lists, `openapi.yaml` (the `camera-probe` body and answer under `/control/actions/{name}`).
- [ ] **Step 4: Run** the file and `test/fleet-policy.test.ts`, `test/control-actions-core.test.ts` — Expected: PASS.
- [ ] **Step 5: Commit** `git add src/onboarding/probe.ts src/onboarding/service.ts src/api/actions.ts src/api/control-api.ts src/fleet/policy.ts src/audit/actions.ts web/src/lib/audit.ts docs/audit-log.md openapi.yaml test/onboarding-probe.test.ts test/fleet-policy.test.ts && git commit -m "feat: camera-probe (ports, certificate, model, capabilities; read-only)"`

### Task 5: Certificate pin without a site CA

**Files:**
- Modify: `src/tls/camera-certs.ts` (`pinServed`; `forget` takes a reason), `src/proxy.ts` (`ensureCerts()`: makes `certs` on a proxy without `tls.site` on first use, no scheduler), `src/api/actions.ts` (`camera-trust-pin`), `src/api/control-api.ts` (`CAMERA_ACTIONS`, `TRUST` limiter), `src/fleet/policy.ts` (`NEVER_REMOTE_ACTIONS`), `src/api/auth.ts` (`MANAGED_ALLOWED`), `openapi.yaml`
- Test: `test/tls-camera-certs.test.ts`, `test/onboarding-trust-pin.test.ts`, `test/pi-compat.test.ts`

**Interfaces:**
- Produces:
  - `CameraCerts.pinServed(id: string, served: Served, who: Requester): CertState` — `extra.pin = served`, `blocked = null`, mode `pinned`, fingerprint `served.fingerprint`, saved; one `camera-trust` record `details: {op: 'pin', from, fingerprint}`; `onTrust(id)`.
  - `CameraCerts.forget(id, who?, reason: 'moved' | 'removed' = 'moved')` — the message says "the camera moved away" or "the camera was removed".
  - `OnboardingService.pin(cam: string, fingerprint: unknown, who: Who): Promise<ActionOutcome>` — 400 `invalid` (pattern), 409 `not_available` for http, `public` (tlsName) or `site-ca` ("clear the trust first: camera-trust-clear"), 503 `camera_offline` when nothing answers, 409 `fingerprint_mismatch` with `extra: {served}`, else 200 `CertState`. Allowed from `none` and `pinned` (pin again after a change).
  - `OnboardingDeps` gains `served: (cam: string) => Promise<Served | null>` and `pinServed: (cam: string, s: Served, who: Requester) => CertState`.

- [ ] **Step 1: Write the failing tests**

```ts
// tls-camera-certs.test.ts (unit, no site)
it('pinServed pins what was served, audits op pin, and survives a reload', () => { /* new CameraCerts({site: () => undefined,...}); pinServed → state mode 'pinned'; a new instance on the same dir → pin(id).fingerprint equal */ });
// onboarding-trust-pin.test.ts (https sim, proxy without tls.site)
it('pins the served certificate; the client view reports mode pinned', async () => { /* fp from servedCertificate → POST /control/cameras/cam1/actions/camera-trust-pin {fingerprint} → 200 mode pinned; GET /api/cameras/cam1 tls {mode:'pinned', fingerprint: fp} */ });
it('a fingerprint other than the served one is 409 and pins nothing', ...);
it('a pinned camera serving a new certificate goes offline and shows trust not ok', async () => { /* sim.engine.importCertificate(other) → until camera offline; pin again with the new fp → online */ });
it('a managed admin token may pin; cams-admin can never (not a remote action)', ...);
// pi-compat.test.ts
it('a pin on a proxy without tls.site never leads to a certificate push', ...);
```

- [ ] **Step 2: Run** the three files — Expected: FAIL.
- [ ] **Step 3: Implement** `pinServed`, the `forget` reason, `ensureCerts()` in proxy.ts (the trust-only branch of `startSiteCa` reused), the action, `['POST', /^\/control\/cameras\/[^/]+\/actions\/camera-trust-pin$/]` in `MANAGED_ALLOWED`, `camera-trust-pin` in `CAMERA_ACTIONS`, `OWN_AUDIT`, `TRUST`, `NEVER_REMOTE_ACTIONS`, `openapi.yaml`.
- [ ] **Step 4: Run** the files plus `test/tls-*.test.ts`, `test/auth-managed-routes.test.ts` — Expected: PASS.
- [ ] **Step 5: Commit** `git add src/tls/camera-certs.ts src/proxy.ts src/api/actions.ts src/api/control-api.ts src/fleet/policy.ts src/api/auth.ts src/onboarding/service.ts openapi.yaml test/tls-camera-certs.test.ts test/onboarding-trust-pin.test.ts test/pi-compat.test.ts && git commit -m "feat: camera-trust-pin: pin the camera's certificate without a site CA"`

### Task 6: Zone rules and the onboarding status

**Files:**
- Create: `src/onboarding/zone.ts`, `src/onboarding/status.ts`
- Modify: `src/config/schema.ts`, `src/config/defaults.ts` (`time: { zone?: string }`, live), `src/fleet/remote-settable.ts` (`LOCAL_ONLY['time.zone']`), `config.schema.json` (`npm run schema`), `src/onboarding/service.ts`, `src/api/onboarding-api.ts`, `src/proxy.ts`, `openapi.yaml`
- Test: `test/onboarding-zone.test.ts`, `test/onboarding-status.test.ts`, `test/fleet-remote-settable.test.ts`

**Interfaces:**
- Produces:
  - `export interface ZoneRule { stdOffsetMinutes: number; dst: (DstRule & { offsetHours: number }) | null }` (`DstRule` from `src/camera/time.ts`)
  - `export function zoneRule(zone: string, year: number): ZoneRule | 'unsupported'`
  - `export function proxyZone(c: Config, env?: NodeJS.ProcessEnv): string | null` — `time.zone`, else the host zone when known (Decisions), else null.
  - `export type StepName = 'reachable' | 'login' | 'trust' | 'capabilities' | 'stream' | 'events' | 'ftp' | 'time' | 'name' | 'poe' | 'profile'`; `export const STEPS: readonly StepName[]` (that order); `export const REQUIRED: readonly StepName[] = ['reachable', 'login', 'trust', 'capabilities', 'stream', 'events']`
  - `export interface Step { ok: boolean | null; detail: string; action?: string }`
  - `export interface OnboardingStatus { camera: string; ready: boolean; checkedAt: number; steps: Record<StepName, Step>; trust: { mode: CertMode; fingerprint: string | null; served: string | null }; time: { clockOffsetMs: number | null; zone: string | null; cameraStdOffsetMinutes: number | null; cameraDst: boolean | null } }`
  - `export interface OnboardingInput { camera: string; now: number; protocol: 'https' | 'http'; state: CameraState; credentials: Credentials; cert: CertState | null; served: string | null; capabilities: Capabilities | null; stills: { enabled: boolean; up: boolean }; intake: IntakeState; ftp: { enabled: boolean; view: CameraFtpView | null; lastUpload: number | null }; timeInfo: TimeInfo | undefined; zone: string | null; name: { name: string; nameSource: 'camera' | 'config' }; poePort: number | null; profile: ProfileWarning[] }`
  - `export function onboardingStatus(i: OnboardingInput): OnboardingStatus` (pure)
  - `export function compactOf(s: OnboardingStatus): { ready: boolean; missing: StepName[] }` — `missing`: steps with `ok === false`, plus required steps with `ok === null`, in `STEPS` order.
  - `OnboardingService.status(cam?: string): Promise<OnboardingStatus[]>` — measures the served certificate (cached 60 s per camera); `OnboardingService.statusNow(cam?: string): OnboardingStatus[]` — the cache only, no camera connection (the heartbeat, Task 11)
  - Routes `GET /cameras/:cam/onboarding` → one object; `GET /onboarding` → `{cameras: OnboardingStatus[]}`.

Step rules (`detail` ≤ 200 characters, `action` names the fix): `reachable` ← `state.online` or a non-network error (`camera_auth_failed`); `login` ← `credentials.authOk` (`source: 'none'` → false, action `password`); `trust` ← site-ca/pinned/public ok, `pinned` with `served` ≠ `fingerprint` → false "serves another certificate: pin again", `none` → false "certificate not trusted" (action `camera-trust-pin`), http → false (Decisions); `capabilities` ← not null; `stream` ← stills off → true 'off', else `up`; `events` ← `intake.onvif === 'subscribed'`; `ftp` ← off → true 'off', `view.state` ok and no `mismatch` → true, unknown → null, else false (action `camera-ftp-setup`); `time` ← no `timeInfo` → null; zone null → null "zone unknown: set time.zone"; `|clockOffsetMs| > 60_000` → false; camera's std offset and DST rule ≠ `zoneRule(zone, year)` → false (action `camera-time-set`); `name` ← `nameSource === 'camera'`; `poe` ← a port → true, none → true 'none'; `profile` ← no `profile_cameras_exceeded`.

`zoneRule`: scan the year's offsets hour by hour (`Intl.DateTimeFormat` `longOffset`), take the two changes, express each as the local wall time just before it (the start in standard time, the end in DST, as `DstRule` says), month/weekday from that date, week `ceil(day / 7)` and `5` when the date is in the month's last 7 days; then check with `dstBounds()` that the rule gives the same two instants, else `'unsupported'`. No change → `dst: null`.

- [ ] **Step 1: Write the failing tests**

```ts
it.each([
  ['America/Chicago', -360, { startMon: 3, startWeek: 2, startWeekday: 0, startHour: 2, startMin: 0, endMon: 11, endWeek: 1, endWeekday: 0, endHour: 2, endMin: 0, offsetHours: 1 }],
  ['Europe/Berlin', 60, { startMon: 3, startWeek: 5, startWeekday: 0, startHour: 2, startMin: 0, endMon: 10, endWeek: 5, endWeekday: 0, endHour: 3, endMin: 0, offsetHours: 1 }],
  ['Australia/Sydney', 600, { startMon: 10, startWeek: 1, startWeekday: 0, startHour: 2, startMin: 0, endMon: 4, endWeek: 1, endWeekday: 0, endHour: 3, endMin: 0, offsetHours: 1 }],
  ['Asia/Tokyo', 540, null],
])('zoneRule(%s, 2026)', (zone, std, dst) => expect(zoneRule(zone, 2026)).toEqual({ stdOffsetMinutes: std, dst }));
it('proxyZone: the setting, else TZ, else unknown on a UTC host', () => { /* {time:{zone:'Europe/Berlin'}} → 'Europe/Berlin'; env TZ 'America/Chicago' → that; neither on UTC → null */ });
it('ready needs every required step; trust none is not ok and names the fix', () => {
  const s = onboardingStatus(input({ cert: { ...cert, mode: 'none' } }));
  expect([s.ready, s.steps.trust]).toEqual([false, { ok: false, detail: 'certificate not trusted', action: 'camera-trust-pin' }]);
  expect(compactOf(s)).toEqual({ ready: false, missing: ['trust'] });
  expect(onboardingStatus(input()).ready).toBe(true);
});
it('FTP and stills off by choice are ok; an http camera is never ready', ...);
it('time: zone unknown is null, another zone or 2 minutes off is false', ...);
it('GET /control/cameras/cam1/onboarding and /control/onboarding against an https sim with a pin', async () => { /* ready true after pin; steps.time ok null without time.zone on a UTC host */ });
it('time.zone is local only (denied for cams-admin)', ...);
```

- [ ] **Step 2: Run** the test files — Expected: FAIL.
- [ ] **Step 3: Implement** the setting (schema, defaults, `npm run schema`), `LOCAL_ONLY` entry, `zone.ts`, `status.ts`, the service's input gathering from the worker (`status.state()`, `capabilities()`, `streamStatus()`, `intake.state()`, `ftpWatch`, `timeInfo()`, `name()`, `poeSwitchInfo()`), the served-fingerprint cache (60 s), the routes, `openapi.yaml`.
- [ ] **Step 4: Run** the files plus `test/fleet-remote-settable.test.ts` — Expected: PASS. The contract's `denied` list gains `time.zone` only in Task 11: until then the deny-list equality test compares without the names in `const PENDING_CONTRACT = ['time.zone']` (in the test file; Task 11 deletes it).
- [ ] **Step 5: Commit** `git add src/onboarding/zone.ts src/onboarding/status.ts src/onboarding/service.ts src/api/onboarding-api.ts src/config/schema.ts src/config/defaults.ts config.schema.json src/fleet/remote-settable.ts src/proxy.ts openapi.yaml test/onboarding-zone.test.ts test/onboarding-status.test.ts test/fleet-remote-settable.test.ts && git commit -m "feat: onboarding status per camera (GET /control/onboarding)"`

### Task 7: Add a camera (several-camera proxy) and the camera limit

**Files:**
- Modify: `src/config/profile.ts` (`atCameraLimit`), `src/onboarding/service.ts` (`add`), `src/api/onboarding-api.ts` (`POST /cameras`, `requireLocalAdmin()`), `src/audit/actions.ts`, `web/src/lib/audit.ts`, `docs/audit-log.md`, `openapi.yaml`, `docs/multi-camera-host.md` (adding a camera)
- Test: `test/onboarding-add.test.ts`, `test/config-profile.test.ts`

**Interfaces:**
- Consumes: Tasks 2–6.
- Produces:
  - `export const atCameraLimit = (c: Config): boolean => c.profile.cameras !== undefined && heldCameras(c) >= c.profile.cameras`
  - `export interface AddBody { id?: string; name?: string; host: string; protocol?: 'https' | 'http'; user?: string; password: string; trust?: { fingerprint: string }; ports?: Partial<ProbeInput['ports']> }`
  - `OnboardingService.add(body: unknown, who: Who): Promise<{ status: 201; onboarding: OnboardingStatus } | { status: number; error: string; detail?: string; retryAfterS?: number; extra?: Record<string, unknown> }>`

Order (nothing is stored or written until the camera accepted the login): validate (`id` like `cameras.*.id`, `host` `validCameraHost`, https needs `trust.fingerprint`) → `loaded.legacyCamera` → Task 8's path → id exists (also hidden `moved`) → 409 `camera_exists` → `atCameraLimit(running)` → 409 `camera_limit` (detail `profile.cameras is <n>`) → `attempts.take` → `probeCamera` with the password and fingerprint (`fingerprint_mismatch` 409, `refused` 422, `offline` 503) → `passwords.set(id)` → `applyOverrides(loaded, {cameras: {[id]: {host, protocol, user, name?, onvifPort, rtspPort, baichuanPort}}})` (ports from `ports` when given) → `setLoaded` → wait for the worker (`cameras.get(id)`, ≤ 10 s) → `pinServed` with the probed certificate (https) → 201 with `status(id)`. A failure after `passwords.set` removes the stored password again. One `camera-add` record `{camera, host, details: {model, pinned: fingerprint | null, requestedBy}}`; the `config-change` record of the overrides is written as `PUT /control/config` does.

- [ ] **Step 1: Write the failing tests**

```ts
it('adds an https camera with password and pin in one call; it is ready', async () => { /* POST /control/cameras {id:'cam6', host:`127.0.0.1:${s.ports.https}`, user:'proxy', password, trust:{fingerprint}, ports} → 201; until onboarding.ready; overrides.json cameras.cam6.host; credentials.source 'store'; tls mode pinned */ });
it('at the limit: 409, no password stored, cameras unchanged', async () => { /* PUT /control/profile {cameras:1}; POST → 409 camera_limit; camera-passwords.json has no cam6; GET /control/cameras ids unchanged */ });
it('a proxy already over its profile keeps running with its warning', ...);
it('a refused password stores and adds nothing', ...);
it('a managed admin token or sign-in is 403 local_admin_only', ...);
it('the password appears in no answer, audit record or log line', ...);
it('atCameraLimit counts held cameras only (moved ones are not held)', ...); // config-profile.test.ts
```

- [ ] **Step 2: Run** `npx vitest run test/onboarding-add.test.ts test/config-profile.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** as ordered above; `camera-add` in the audit lists; the route in `openapi.yaml`.
- [ ] **Step 4: Run** the files plus `test/cameras-add-remove.test.ts` — Expected: PASS.
- [ ] **Step 5: Commit** `git add src/config/profile.ts src/onboarding/service.ts src/api/onboarding-api.ts src/audit/actions.ts web/src/lib/audit.ts docs/audit-log.md docs/multi-camera-host.md openapi.yaml test/onboarding-add.test.ts test/config-profile.test.ts && git commit -m "feat: POST /control/cameras adds a camera with its password and pin; the profile limit refuses"`

### Task 8: Add a camera on a single-camera proxy (the Pi)

**Files:**
- Modify: `src/config/load.ts` (`withCameraHost`), `src/onboarding/service.ts`, `docs/raspberry-pi.md`
- Test: `test/onboarding-add-single.test.ts`, `test/pi-compat.test.ts`

**Interfaces:**
- Produces:
  - `export function withCameraHost(l: Loaded, v: EnvValue | undefined): Loaded` in `src/config/load.ts` — rebuilt with `envLayer.cameraHost` replaced (undefined removes it).
  - `OnboardingDeps` gains `moveOpen?: (moveId: string) => boolean` and `envFile: () => string | undefined`.

The legacy camera `L = loaded.order[0]`. `body.id` given and ≠ L → 409 `camera_id` ("this proxy has one camera, <L>"). L has a host (`cameraConfig(loaded.config, L).host`) and no `moved` → 409 `camera_limit`. `moved` with `moveOpen(moved)` → 409 `move_open`. `checkEnvPath(envFile())` fails → 409 `not_available` with `extra: {line: 'CAMERA_HOST=<host>'}` (checked before the camera is asked). Then as Task 7 from the probe on, except: `writeEnvKey(path, CAMERA_HOST_NAMES, host)` (backup, audited inside `camera-add` as `details.envKey`), overrides `cameras.L.{protocol, user, name?}` and the `moved` override removed (`removeOverride(l, 'cameras.L.moved')`), `setLoaded(withCameraHost(next, {value: host, name: key}))`, then `restartCamera(L)`.

- [ ] **Step 1: Write the failing tests** (proxy from a legacy `config.json` `camera` object without `host`, `CAMPROXY_ENV_FILE` in a temp dir)

```ts
it('a Pi without a camera takes the new one: CAMERA_HOST written, running at once, no restart', async () => { /* POST /control/cameras {host, password, trust} → 201 camera 'cam1'; readEnvValue(file,'CAMERA_HOST') === host; until online */ });
it('a configured legacy camera: 409 camera_limit, .env unchanged', ...);
it('another id is 409 camera_id', ...);
it('after a finished move the hidden camera is replaced; during an open move it is 409 move_open', ...);
it('without a writable .env: 409 not_available with the line, nothing stored', ...);
```

- [ ] **Step 2: Run** `npx vitest run test/onboarding-add-single.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** `withCameraHost` and the legacy branch; `docs/raspberry-pi.md`: "Add a camera" with the API instead of the hand edit.
- [ ] **Step 4: Run** the file plus `test/pi-compat.test.ts`, `test/camera-address.test.ts` — Expected: PASS.
- [ ] **Step 5: Commit** `git add src/config/load.ts src/onboarding/service.ts docs/raspberry-pi.md test/onboarding-add-single.test.ts test/pi-compat.test.ts && git commit -m "feat: POST /control/cameras on a single-camera proxy writes CAMERA_HOST and starts the camera"`

### Task 9: Remove a camera (offboard)

**Files:**
- Create: `src/onboarding/remove-leftovers.ts`
- Modify: `src/onboarding/service.ts` (`remove`), `src/api/onboarding-api.ts` (`DELETE /cameras/:id`, `requireLocalAdmin()`), `src/api/control-api.ts` (`/status` gains `removeLeftovers`), `src/proxy.ts`, `src/audit/actions.ts`, `web/src/lib/audit.ts`, `docs/audit-log.md`, `openapi.yaml`, `web/src/components/MoveLeftoversCard.svelte` (shows both lists)
- Test: `test/onboarding-remove.test.ts`

**Interfaces:**
- Consumes: `removePasswordLine`, `leftoverItems` (`src/moves/leftovers.ts`), `CameraCerts.forget(id, who, 'removed')` (Task 5), `deleteCameraPositions`, `cameraFtpOff`, `withCameraHost` (Task 8).
- Produces:
  - `export interface RemoveLeftover { camera: string; at: number; items: string[] }`
  - `export function removeLeftoverItems(l: Loaded, cam: string): string[]` — `env <NAME>` / `env <NAME>_FILE` for the own password variable, `config.json camera.host` on a legacy proxy whose file sets it.
  - `export class RemoveLeftovers { constructor(dataDir: string); add(e: RemoveLeftover): void; current(l: Loaded): RemoveLeftover[] }` — `data/admin/remove-leftovers.json`, at most 16, re-checked on read; a camera configured again drops out.
  - `OnboardingService.remove(id: string, who: Who): Promise<{ status: 200; removed: string[]; leftovers: string[] } | { status: 400 | 404 | 409; error: string; detail?: string }>`

Steps in order, each one's result in `removed` or `leftovers`: id invalid → 400; config.json camera on a several-camera proxy → 409 `config_json`; nothing known about the id (no config, no stored password, no env line, no TLS files, no PTZ rows) → 404. Running and FTP pointing here (`readCameraFtp` server equals `ftp.publicHost`) → `cameraFtpOff` (`'camera FTP upload off'`; failure → leftover `'camera FTP upload still points here'`); the camera's config (`removeOverride(cameras.<id>)`, or on a legacy proxy `CAMERA_HOST` removed with `removeEnvKey` for the key in use and `withCameraHost(l, undefined)`) → `setLoaded` (the worker stops); the store password; the managed env line (`removePasswordLine`); `forget(id, who, 'removed')`; `deleteCameraPositions`. Files follow retention. One `camera-remove` record `{camera, details: {removed, leftovers, requestedBy}}`.

- [ ] **Step 1: Write the failing tests**

```ts
it('removes an added camera with its password, pin, PTZ rows and FTP upload', async () => { /* add cam6 (Task 7 helper) with ftp on; DELETE /control/cameras/cam6 → 200 removed contains 'camera FTP upload off', 'stored password', 'certificate pin'; sim Ftp.enable 0 (re-read); camera-passwords.json lacks cam6; data/tls/cameras has no cam6.*; GET /api/cameras/cam6 404 */ });
it('a password in compose\'s environment is a leftover, listed on /control/status until gone', ...);
it('a config.json camera on a several-camera proxy is 409 config_json; after it is gone from config.json, DELETE cleans up', ...);
it('on the Pi: CAMERA_HOST removed, the camera idle, config.json untouched', ...);
it('unknown id is 404; managed rights are 403', ...);
```

- [ ] **Step 2: Run** `npx vitest run test/onboarding-remove.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** as above; the card lists remove leftovers under "Left over from removed cameras".
- [ ] **Step 4: Run** the file plus `test/move-leftovers.test.ts`, `test/openapi.test.ts`, `npm run check` — Expected: PASS.
- [ ] **Step 5: Commit** `git add src/onboarding/remove-leftovers.ts src/onboarding/service.ts src/api/onboarding-api.ts src/api/control-api.ts src/proxy.ts src/audit/actions.ts web/src/lib/audit.ts docs/audit-log.md openapi.yaml web/src/components/MoveLeftoversCard.svelte test/onboarding-remove.test.ts && git commit -m "feat: DELETE /control/cameras/:id offboards a camera and lists what is left"`

### Task 10: Set the camera's time zone (`camera-time-set`)

Needs the cam-sim release with `SetTime` (Prerequisites 2).

**Files:**
- Modify: `package.json`, `package-lock.json` (cam-sim tarball)
- Create: `src/camera/time-set.ts`
- Modify: `src/camera/client.ts` (`forgetTime(): void` drops the cached `TimeInfo`), `src/api/actions.ts` (`camera-time-set`), `src/api/control-api.ts` (`CAMERA_ACTIONS`), `src/onboarding/service.ts`, `src/audit/actions.ts`, `web/src/lib/audit.ts`, `docs/audit-log.md`, `openapi.yaml`
- Test: `test/camera-time-set.test.ts`

**Interfaces:**
- Consumes: Task 6 `zoneRule`, `proxyZone`; `ensureNtp` (`src/cameras/ntp.ts`).
- Produces:
  - `export type TimeOutcome = 'set' | 'already' | 'unsupported' | 'failed'`
  - `export async function setCameraZone(client: Pick<ReolinkClient, 'command' | 'logout'>, rule: ZoneRule): Promise<{ outcome: TimeOutcome; before?: unknown; after?: unknown; detail?: string }>` — `GetTime`; equal zone (`Time.timeZone === -std * 60`) and `Dst` (`enable`, `offset`, the ten rule fields; `enable: 0` when `dst` is null) → `already`; else `SetTime` with the whole `{Time, Dst}` as read, zone and rule replaced (the clock fields as the measurement in Prerequisites 2 says); `GetTime` again: equal → `set`, else `failed`; rspCode -9 → `unsupported`; `logout()` in `finally`.
  - `OnboardingService.setTime(cam: string, who: Who): Promise<ActionOutcome>` — zone `proxyZone(running)` null → 409 `zone_unknown`; `zoneRule` `'unsupported'` → 409 `zone_unsupported`; then `setCameraZone(worker.client, rule)`, `worker.client.forgetTime()`, then the NTP server via the existing `cameraNtp(cam)` (null when `ntp.server` is unset); 200 `{outcome, zone, ntp: NtpOutcome | null}`. One `camera-time` record `{camera, outcome, details: {zone, before: {stdOffsetMinutes, dst}, after, ntp, requestedBy}}`.

- [ ] **Step 1: Write the failing tests**

```ts
it.each(['RLC-1224A', 'CX820', 'E1-Outdoor-Pro'] as const)('%s: sets zone and DST rule as one whole object, re-reads, logs out', async (model) => {
  // proxy with time.zone 'Europe/Berlin' over a sim in America/Chicago
  const r = await post('/control/cameras/cam1/actions/camera-time-set', {});
  expect(r.body).toMatchObject({ outcome: 'set', zone: 'Europe/Berlin' });
  expect(s.state.setCalls.filter((c) => c === 'SetTime')).toHaveLength(1);
  const t = timeInfoFromGetTime((await rawCommand(s, 'GetTime')));
  expect([t.stdOffsetMinutes, t.dstRule?.startWeek, t.dstRule?.endMon]).toEqual([60, 5, 10]);
  expect((await post('/control/cameras/cam1/actions/camera-time-set', {})).body.outcome).toBe('already');
  expect(s.sim.engine.sessions.online()).toHaveLength(0);
});
it('no zone known: 409 zone_unknown, nothing written', ...);
it('the onboarding time step turns ok after the set', ...);
```

- [ ] **Step 2: Run** `npx vitest run test/camera-time-set.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** after bumping cam-sim (`npm install <release tarball URL>`); the action in `CAMERA_ACTIONS` and `OWN_AUDIT`; `camera-time` in the audit lists.
- [ ] **Step 4: Run** the file and the whole suite `npm test` (the cam-sim bump) — Expected: PASS.
- [ ] **Step 5: Commit** `git add package.json package-lock.json src/camera/time-set.ts src/camera/client.ts src/api/actions.ts src/api/control-api.ts src/onboarding/service.ts src/audit/actions.ts web/src/lib/audit.ts docs/audit-log.md openapi.yaml test/camera-time-set.test.ts && git commit -m "feat: camera-time-set: the camera's zone and DST from time.zone or the host"`

### Task 11: cams-admin commands and the heartbeat's onboarding field

Needs the cams-admin contract change on main (Prerequisites 1).

**Files:**
- Modify: `test/contract/cams-admin-v1/**` (vendored copy + `SOURCE`), `src/fleet/policy.ts`, `src/fleet/command-args.ts`, `src/fleet/command-check.ts` (rate window), `src/fleet/camera-commands.ts`, `src/fleet/heartbeat.ts`, `src/fleet/client.ts`, `src/proxy.ts`, `docs/cams-admin.md`, `web/src/components/CamsAdminCommands.svelte` (the default-on entry shows ticked)
- Test: `test/fleet-policy.test.ts`, `test/fleet-camera-commands.test.ts`, `test/fleet-heartbeat.test.ts`, `test/fleet-contract.test.ts`, `test/fleet-remote-settable.test.ts` (`PENDING_CONTRACT` from Task 6 removed)

**Interfaces:**
- Consumes: Task 6 `OnboardingService.statusNow`, `compactOf`; Task 10 `camera-time-set`.
- Produces:
  - `REMOTE_ACTIONS` and `DISRUPTIVE_ACTIONS` gain `'camera-time-set'` (EFFECT: "rewrites the camera's time zone and DST rule"); `export const DEFAULT_ON: readonly string[] = ['camera.onboarding.get']`; `ALLOW_ENTRIES` and `IMPLEMENTED` gain `'camera.onboarding.get'`; `ENTRY_TEXT['camera.onboarding.get'] = "cams-admin may read each camera's onboarding status (no secrets)"`.
  - `PolicyFile.off?: string[]`; `effective().allow` = today's list ∪ (`DEFAULT_ON` − `off`), without consent; `setAllow(list, by)` stores `allow: list − DEFAULT_ON`, `off: DEFAULT_ON − list` (removing it is narrowing, adding it back needs local).
  - `export interface OnboardingGetArgs { v: 1; camera: string | null }`; `export const validateOnboardingGet: (a: unknown) => ArgsVerdict<OnboardingGetArgs>`
  - `cameraHandlers` gains `'camera.onboarding.get'`: unknown camera → failed `unknown_camera`; result `{cameras: {<id>: OnboardingStatus}}`, scrubbed and over 16 KiB `{cameras: {}, clamped: true}`; window 12 per minute.
  - `CAMERA_WRITES` gains `camera-time-set` with `verifyTime(answer): {verified, mismatch}` (`set`/`already` → verified).
  - Audit on this side: the existing `admin-command` record (`src/fleet/commands.ts`) for every command, plus `camera-time` from the action; `camera.onboarding.get` writes only `admin-command`.
  - `buildHeartbeat(summary, proxy, maxBytes?, profile?, moveLeftovers?, onboarding?: Record<string, { ready: boolean; missing: StepName[] }>)` — at most 64 cameras; kept when truncated; omitted when empty. `FleetClient` deps gain `onboardingNow: () => Record<string, {ready, missing}>`.

- [ ] **Step 1: Vendor the contract** — copy cams-admin main's `contract/v1` over `test/contract/cams-admin-v1` (keep the directory layout), set `SOURCE` to `klaushofrichter/cams-admin <commit> (contract/v1, main)`; run `bash scripts/contract-drift.sh` — Expected: `contract/v1 matches cams-admin origin/main`.
- [ ] **Step 2: Write the failing tests**

```ts
it('camera.onboarding.get is allowed by default and can be switched off locally; managed rights only narrow', () => { /* no policy.json → effective().allow contains it; setAllow([], 'managed') → gone, off ['camera.onboarding.get']; setAllow(['camera.onboarding.get'], 'managed') throws WideningRefused */ });
it('camera.onboarding.get answers the strict result schema', async () => { /* handler result validated with strict validators('camera.onboarding.get.result') */ });
it('camera.action:camera-time-set is disruptive, off by default, and verified by its re-read', ...);
it('the heartbeat carries onboarding {cam: {ready, missing}} and passes the strict schema, also truncated', () => {
  const hb = buildHeartbeat(summary, proxy, 2_000, null, [], { cam1: { ready: false, missing: ['trust'] } });
  expect(hb.truncated).toBe(true); expect(hb.body.onboarding).toEqual({ cam1: { ready: false, missing: ['trust'] } });
  expect(strict.heartbeat(envelope(hb.body))).toBe(true);
});
```

- [ ] **Step 3: Run** the four fleet test files — Expected: FAIL.
- [ ] **Step 4: Implement** the policy, args, handler, heartbeat field and wiring; `docs/cams-admin.md`: the two commands, the default-on entry, `onboarding` in the heartbeat.
- [ ] **Step 5: Run** `npx vitest run test/fleet-*.test.ts` and `bash scripts/contract-drift.sh` — Expected: PASS.
- [ ] **Step 6: Commit** `git add test/contract/cams-admin-v1 src/fleet/policy.ts src/fleet/command-args.ts src/fleet/command-check.ts src/fleet/camera-commands.ts src/fleet/heartbeat.ts src/fleet/client.ts src/proxy.ts docs/cams-admin.md web/src/components/CamsAdminCommands.svelte test/fleet-policy.test.ts test/fleet-camera-commands.test.ts test/fleet-heartbeat.test.ts test/fleet-contract.test.ts test/fleet-remote-settable.test.ts && git commit -m "feat: camera.onboarding.get, camera-time-set for cams-admin, onboarding in the heartbeat"`

### Task 12: Admin UI: password, trust, add from Find camera, onboarding card

**Files:**
- Create: `web/src/lib/onboarding.ts`, `web/src/components/CameraPasswordDialog.svelte`, `web/src/components/TrustCertificateDialog.svelte`, `web/src/components/OnboardingCard.svelte`
- Modify: `web/src/components/AddCameraCard.svelte` (probe → confirm fingerprint → password → `POST /control/cameras`), `web/src/components/FindCameraCard.svelte` ("Add this camera" → the add flow with the address filled; on the Pi the same call writes `CAMERA_HOST`, no restart), `web/src/pages/Status.svelte` (one `OnboardingCard` per camera), `web/src/pages/Settings.svelte` (`time.zone`; "Set camera time" button)
- Test: `test/onboarding-ui.test.ts`, `e2e/onboarding.spec.ts`

**Interfaces:**
- Consumes: the routes and shapes of Tasks 1–10.
- Produces (pure, tested): `passwordConfirmText(name: string, host: string): string` = `Save the login for ${name} (${host}) on this proxy?`; `trustConfirmText(name: string, fingerprint: string): string` = `Trust the certificate ${fingerprint} of ${name}? Only if it matches what the camera shows.`; `stepLine(name: StepName, s: Step): string`; `passwordError(code: string): string` (camera_refused → "The camera refused this password.", camera_offline, too_many_attempts → "Too many tries: wait <n> minutes.", env_password → "The password is set in the environment (<name>): remove it there first.", not_trusted → "Trust the camera's certificate first.").

The password field is `type="password"`, `autocomplete="off"`, cleared after every answer, never put in a store or the URL. Managed sign-ins see the password and trust dialogs (allowed), not the add or remove buttons (`lockedWhy($rights, 'local')`).

- [ ] **Step 1: Write the failing tests** — `onboarding-ui.test.ts` asserts the texts above for sample inputs; `e2e/onboarding.spec.ts`: on the e2e proxy over an https cam-sim with trust `none`: the card shows "certificate not trusted" → Trust dialog with the measured fingerprint → confirm → the card's trust line turns ok; Camera password dialog with a wrong password shows "The camera refused this password." and the field is empty again.
- [ ] **Step 2: Run** `npx vitest run test/onboarding-ui.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** the lib, the dialogs (on `ConfirmDialog`), the card and the add flow.
- [ ] **Step 4: Run** `npx vitest run test/onboarding-ui.test.ts`, `npm run check`, `npm run test:e2e -- e2e/onboarding.spec.ts e2e/find-camera.spec.ts` — Expected: PASS.
- [ ] **Step 5: Commit** `git add web/src/lib/onboarding.ts web/src/components/CameraPasswordDialog.svelte web/src/components/TrustCertificateDialog.svelte web/src/components/OnboardingCard.svelte web/src/components/AddCameraCard.svelte web/src/components/FindCameraCard.svelte web/src/pages/Status.svelte web/src/pages/Settings.svelte test/onboarding-ui.test.ts e2e/onboarding.spec.ts && git commit -m "feat: admin UI for camera password, certificate trust, adding and onboarding status"`

### Task 13: End to end over all three models, CHANGELOG

**Files:**
- Create: `test/onboarding-e2e.test.ts`
- Modify: `CHANGELOG.md` (`## Unreleased`), `README.md` (the onboarding API in the API list)

- [ ] **Step 1: Write the test** — `it.each(['RLC-1224A', 'CX820', 'E1-Outdoor-Pro'])`: a several-camera proxy with `time.zone`, a fresh https sim: probe without password → add with password + fingerprint → `camera-time-set` → `camera-ftp-setup` (FTP on) → `GET /control/cameras/<id>/onboarding` `ready: true` and every step `ok: true` except `poe` 'none' → `DELETE` → removed, nothing left; the audit records in order `camera-probe`, `camera-add`, `camera-trust`, `camera-time`, `control-action`, `camera-remove`, none containing the password.
- [ ] **Step 2: Run** `npx vitest run test/onboarding-e2e.test.ts` — Expected: PASS (all pieces exist; a failure here is a bug in an earlier task: fix it there).
- [ ] **Step 3: CHANGELOG** under `## Unreleased`, user terms: adding a camera with its password and certificate from the admin page or the API (also on the Pi, no file edits, no restart); the password is checked with the camera, saved only on the proxy and never shown; trusting a camera's certificate without a site CA; the onboarding status per camera; removing a camera cleans up; setting the camera's time zone; cams-admin can read the onboarding status (on by default) and set the time (off by default; needs the matching cams-admin release).
- [ ] **Step 4: Run** `npm test`, `npm run lint:types`, `npm run check` — Expected: PASS.
- [ ] **Step 5: Commit** `git add test/onboarding-e2e.test.ts CHANGELOG.md README.md && git commit -m "test: onboarding end to end over all three camera models; CHANGELOG"`
