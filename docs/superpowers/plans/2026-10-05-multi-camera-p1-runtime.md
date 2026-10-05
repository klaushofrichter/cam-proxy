# Multi-camera P1: config and runtime per camera — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One cam-proxy process serves N cameras, each with its own isolated camera side, while today's one-camera config, API, SSE and health JSON keep working for the Pi, its e-paper display and cams.

**Architecture:** The camera side of `src/proxy.ts` (client, status poller, events, stills, recordings, reboot, PoE port, FTP watch) moves into a `CameraWorker` class, one per configured camera, held by a `CameraRegistry` in config order. Host-wide services (catalog, SSE, storage, analytics, archive, composer, inventory runner, audit, health) take the camera id as a parameter instead of reading `config.camera`. The config gains a keyed `cameras` collection; the legacy `camera` object is translated at load, so no file on the Pi changes. The refactor goes in two halves so every task leaves the suite green: first the runtime moves onto accessors over the old config shape (Tasks 2–6), then the config shape switches underneath them (Tasks 7–9).

**Tech Stack:** Node 26, TypeScript 7, Express 5, node:sqlite, vitest 5, Playwright, Svelte 5 (admin UI), cam-sim (release tarball) as the test camera, go2rtc + ffmpeg for stills.

**Spec:** `docs/superpowers/specs/2026-10-05-multi-camera-host-design.md` (§3, §4, §5, §6.1–§6.3, §6.5, §6.6, §11, §15, §16 row P1). Read it with this plan.

## Global Constraints

- Today's one-camera config, API and health JSON keep working byte for byte where a client depends on them (the Pi, its display, cams as it is) (spec §1).
- `camera` and `cameras` together are a config error. Ids must be unique, `^[a-z0-9][a-z0-9-]{0,31}$` (spec §4.1).
- Legacy `camera: {…}` is read as `cameras: [{…}]`; its `camera.poeSwitch.{model, host, ports, offSeconds}` move to the host-wide `poeSwitch`, its `poeSwitch.port` stays with the camera, and the top-level `ftp.user` becomes that camera's `ftp.user`. No file is rewritten (spec §4.2).
- overrides.json legacy paths: `camera.X` → `cameras.<the one id>.X`, switch keys → `poeSwitch.X`; written back in the new form on the next save; with more than one camera a legacy `camera.*` override is a load error naming the path (spec §4.2).
- `CAMERA_HOST` / `CAMPROXY_CAMERA_HOST` and `PI_ADDRESS` keep their meaning with exactly one camera; with several, a `CAMERA_HOST` is a load error ("set cameras[].host instead") (spec §4.2).
- `CAMPROXY_CAMERA_PASSWORD` is the default for every camera; `CAMPROXY_CAMERA_PASSWORD_<ID>` (id upper-cased, `-` → `_`) overrides it for one camera (spec §4.2).
- Supervision: a worker failure sets that camera's `error` and retries with backoff **5 s doubling to 5 min, reset after 10 min healthy**; the others never wait for it (spec §3.3).
- A camera with no address no longer stops the process: its worker stays idle with `error: "no_address"` (spec §3.3).
- A request for a camera that is restarting answers `503 camera_restarting` with Retry-After, never hangs; unknown camera → `404 not_found` (spec §3.3, §6.1).
- `analytics_usage` becomes `(provider, key_id, cam, day, calls)`, PK `(provider, key_id, cam, day)`; `key_id` = the first 12 hex digits of SHA-256 of the API key (never the key); `''` for rows from before the migration (spec §5.1).
- Health summary: `schema` stays **1**, every change additive; top-level `camera`, `stream`, `events`, `ftp` = the first camera in config order; item ids stay the same (spec §6.5).
- SSE: one stream carries every camera's messages, each with `cam`; `?cam=<id>` filters to one, `?cam=a,b` to several (spec §6.2).
- The image rate-limit bucket is multiplied by the number of cameras (spec §6.1; which bucket: Ruling P1-16).
- All access checks go through one function, `can(principal, action, cam?)` (spec §6.6).
- Secrets and tokens are never logged or put in an error message; the FTP and camera passwords never reach a log line.
- No new runtime dependency in this phase. Node 26 or later.
- The real camera and the real PoE switch are never used by tests (cam-sim and the switch mock only).

## Review Focus

1. **The Pi's overrides.json with legacy paths** (`camera.statusPollS`, `camera.poeSwitch.host`, `ftp.user`): the proxy loads, runs with the translated values, and the next save writes `cameras.cam1.*` / `poeSwitch.*` without losing any value. Pinned in Task 11 (`legacy overrides survive a save`).
2. **An id that looks like a number** (`"cameras": [{"id":"2"},{"id":"10"},{"id":"1"}]`): JavaScript orders integer-like object keys numerically; the proxy must keep config order everywhere (`GET /api/cameras`, health `cameras`, the picker). Pinned in Task 11 (`integer-like ids keep config order`).
3. **A request for a camera during its own restart**: answers 503 with Retry-After within milliseconds, and the other cameras answer normally. Pinned in Task 4 (`restarting camera answers 503 at once; the others answer normally`).
4. **One camera without an address next to working ones**: the process starts, the others produce stills and events, the idle one shows `no_address`. Pinned in Task 9 (the worker on its own) and Task 16 (`stays idle with no_address; the process runs; the others work`).
5. **SSE camera filters with odd input** (`?cam=cam1,`, `?cam=cam1,cam1`, `?cam=unknown`): empties are ignored, duplicates harmless, an unknown id yields an empty stream (not a 400, so a cams group with a removed camera keeps its stream). Pinned in Task 13 (`cam list edge cases`).

---

## File structure

| File | Responsibility | Task |
|---|---|---|
| `src/catalog/migrations.ts`, `src/catalog/analyses.ts`, `src/analytics/key-id.ts` (new) | migration 9; usage per key and camera | 1 |
| `src/config/cameras.ts` (new) | `ResolvedCamera`, `cameraIds`, `cameraConfig`, `cameraEvents` | 2, 11 |
| `src/cameras/worker.ts` (new), `src/cameras/registry.ts` (new) | one camera's side; the workers in config order | 3, 8, 9 |
| `src/cameras/backoff.ts` (new) | supervision backoff | 9 |
| `src/api/camera-param.ts` (new), `src/api/auth.ts` | `cameraParam`, `can()` | 4 |
| `src/api/client-api.ts`, `compose-api.ts`, `archive-api.ts`, `still-checks-api.ts` | `:cam` → worker | 4 |
| `src/analytics/service.ts` | one queue; jobs/checks/usage per camera | 1, 5 |
| `src/archive/service.ts`, `src/compose/jobs.ts` | stills and names of the request's camera | 6 |
| `src/inventory/*.ts` | runs bound to a camera | 7 |
| `src/audit/*.ts`, `src/storage.ts`, `src/api/metrics.ts` | labels, sweep, metrics, daily activity per camera | 8 |
| `src/config/schema.ts` | keyed collection; camera node; host `poeSwitch` | 10, 11 |
| `src/config/defaults.ts`, `src/config/load.ts`, `src/config/legacy.ts` (new), `src/config/load-error.ts` (new) | new shape; legacy translation | 11 |
| `src/config/secrets.ts` | per-camera passwords | 12 |
| `src/stream/log.ts`, `src/stream/sse.ts` | `?cam=a,b` | 13 |
| `src/health/summary.ts` | `cameras[]`, aggregated items | 14 |
| `src/api/control-api.ts` | `cameras` in status, `GET /control/cameras`, `camera_required` | 7, 8, 11, 15 |
| `src/proxy.ts` | host wiring over the registry | 3–8, 12, 14, 15 |
| `test/helpers/multi.ts` (new), `test/multi-camera.test.ts` (new) | three cam-sims | 16 |
| `web/src/lib/cameras.ts` (new), `web/src/components/CameraPicker.svelte` (new), pages | camera picker | 17 |
| `e2e/multi/*` (new), `playwright.multi.config.ts` (new), `.github/workflows/pr-checks.yml` | multi-camera e2e | 18 |
| `README.md`, `CHANGELOG.md`, `config.cameras.example.json` (new), `CLAUDE.md`, `openapi.yaml` | docs | 19 |

## Rulings (spec gaps decided here)

- **Ruling P1-1: go2rtc per worker in P1, ports offset by 100 × the camera's index** (`go2rtc.rtspPort + 100*i`, `apiPort + 100*i`) — the shared go2rtc is P2 (spec §16), but P1 must run three cameras; index 0 keeps today's ports, so the Pi is unchanged — cost if wrong: ~10 lines replaced in P2, and a port clash on a multi-camera host before P2 (none exists yet).
- **Ruling P1-2: FTP for one camera only in P1.** More than one camera with an effective `ftp.enabled` is a config error ("ftp.enabled: several cameras need per-camera FTP users (multi-camera phase 2); enable it for one camera") — the user→camera mapping is P2 (spec §16); without it uploads would land under the wrong camera — cost if wrong: multi-camera test hosts run without FTP until P2.
- **Ruling P1-3: the recordings cache cap is split evenly in P1** (`cacheMB / number of cameras` per camera) — the shared LRU is P2 (spec §8.3); one camera keeps today's cap — cost if wrong: a smaller per-camera cache on a multi-camera test host until P2.
- **Ruling P1-4: each worker has its own `PoeSwitch` instance in P1**, built from the host `poeSwitch` plus the camera's `poeSwitch.port` — the FIFO controller is P2 (spec §8.4); with one camera this is today's behaviour — cost if wrong: on a multi-camera test host two simultaneous power-cycles may get `switch_busy` from the switch until P2.
- **Ruling P1-5: the analytics usage day uses the first camera's clock** (`timeInfo` of the first worker) — the cameras of one host share a site and a time zone (spec §8.2 counts "per camera day" but defines one budget per key) — cost if wrong: a camera in another time zone counts its calls on a neighbouring day.
- **Ruling P1-6: limits sum over every key in P1** (`usageBetween` without a key filter, as today); per-key budgets come in P2 (spec §16 P2 "Vision per key") — cost if wrong: none for one key.
- **Ruling P1-7: the legacy migration's `cam` is filled at startup**, not inside the SQL migration (migrations are static SQL; the camera list is runtime data): rows get `cam = ''` in migration 9, and `adoptLegacyUsage(catalog, ids)` sets them to the one id (or `'unknown'` with several) on start — cost if wrong: none; the rule is the spec's.
- **Ruling P1-8: `PUT /control/config` and `DELETE /control/config/:path` accept legacy `camera.*`, `ftp.user` paths on a one-camera proxy** (translated like overrides.json) — spec §4.2 translates the file but is silent on the API; scripts and the e2e suite use these paths — cost if wrong: a second accepted spelling of the same setting.
- **Ruling P1-9: `GET /control/config` keys are the new paths** (`cameras.cam1.statusPollS`, `poeSwitch.model`) as spec §4.2 says; the tests that read those keys are updated. This is the one place the "one-camera suite unchanged" gate of §16 gives way to §4.2 — cost if wrong: an external script reading `camera.*` keys from the settings view breaks (none known).
- **Ruling P1-10: no `camera` and no `cameras` in config.json** means one default camera `cam1` (name `Den`), as today's defaults, idle with `no_address` — spec §3.3 removes "the proxy does not start" — cost if wrong: none.
- **Ruling P1-11: a new-shape camera's default name is its id; its default `ftp.user` is its id; a legacy camera keeps today's defaults** (`name` "Den", `ftp.user` "camera") so the Pi's camera keeps logging in as `camera` — spec §7 says the default user is the camera id, §4.2 says nothing changes on the Pi — cost if wrong: none on the Pi.
- **Ruling P1-12: the camera-scoped control routes are P2.** In P1 the old routes act on the only camera, and on a multi-camera proxy a camera action answers `400 camera_required` (spec §6.3); `GET /control/cameras` (read-only) is built in P1 because the picker needs it — cost if wrong: none.
- **Ruling P1-13: overrides may only touch camera ids that config.json defines in P1** (`cameras.x: unknown camera`); adding a camera through `PUT /control/config` is P2 (spec §6.3 with §16 P2) — cost if wrong: none.
- **Ruling P1-14: the `archive` stream message is sent once per camera of the rows it names** (`log.append(row.cam, 'archive', …)`), not once under the process camera — the stream log row needs a `cam`, and a cams group subscribed with `?cam=` must see it — cost if wrong: a client that filtered by camera now sees archive messages of its own cameras only, which is the intent.
- **Ruling P1-16: the bucket multiplied by the number of cameras is the image bucket (6000/min, `src/proxy.ts:649`)**, not the 1200/min one — spec §6.1 calls the image bucket "1200/min, proxy.ts:648", but line 648 is the non-image bucket (its `skip` is `isImage`); the spec's reason ("a timeline per camera loads the same sprites") is about images — cost if wrong: the non-image bucket stays at 1200/min per client, as today.
- **Ruling P1-15: the `Proxy` object keeps `status`, `intake`, `stills`, `recordings` getters as the first camera's**, next to the new `cameras` registry — tests and one-camera callers use them; new code uses the registry — cost if wrong: none; they are internal.

---

### Task 1: Catalog migration 9 and camera/key-aware usage counting

**Files:**
- Modify: `src/catalog/migrations.ts` (append migration 9)
- Modify: `src/catalog/analyses.ts:51-62,154-158` (usage functions)
- Create: `src/analytics/key-id.ts`
- Modify: `src/analytics/service.ts` (callers of `addUsage`/`releaseUsage`)
- Modify: `test/catalog-analyses.test.ts:70-86`, `test/catalog-still-checks.test.ts`, `test/catalog-archive.test.ts` (schema version 8 → 9)
- Test: `test/catalog-usage.test.ts` (new)

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `export function keyId(key: string): string` (12 lowercase hex chars) in `src/analytics/key-id.ts`.
  - `export interface UsageKey { provider: string; keyId: string; cam: string }` in `src/catalog/analyses.ts`.
  - `addUsage(c: Catalog, u: UsageKey, day: string): void`
  - `releaseUsage(c: Catalog, u: UsageKey, day: string): void`
  - `usageBetween(c: Catalog, provider: string, fromDay: string, toDay: string, f?: { keyIds?: string[]; cam?: string }): number`
  - `usageByCamera(c: Catalog, provider: string, fromDay: string, toDay: string): Record<string, number>`
  - `adoptLegacyUsage(c: Catalog, cams: string[]): number` (rows changed)
  - `pruneUsage` unchanged.

- [ ] **Step 1: Write the failing test**

Create `test/catalog-usage.test.ts`:

```ts
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { openCatalog } from '../src/catalog/db';
import { MIGRATIONS } from '../src/catalog/migrations';
import { addUsage, adoptLegacyUsage, releaseUsage, usageBetween, usageByCamera } from '../src/catalog/analyses';
import { keyId } from '../src/analytics/key-id';

const fresh = () => openCatalog(join(mkdtempSync(join(tmpdir(), 'camproxy-usage-')), 'catalog.sqlite'));

// A catalog as release 8 left it, with one month of usage (spec §5.1).
function version8(rows: [string, string, number][]): string {
  const path = join(mkdtempSync(join(tmpdir(), 'camproxy-usage8-')), 'catalog.sqlite');
  const raw = new DatabaseSync(path);
  raw.exec('CREATE TABLE schema_version (version INTEGER NOT NULL)');
  MIGRATIONS.slice(0, 8).forEach((sql, i) => {
    raw.exec(sql);
    raw.prepare('INSERT INTO schema_version (version) VALUES (?)').run(i + 1);
  });
  for (const [p, d, n] of rows) raw.prepare('INSERT INTO analytics_usage (provider, day, calls) VALUES (?, ?, ?)').run(p, d, n);
  raw.close();
  return path;
}

describe('analytics_usage per key and camera (spec §5.1)', () => {
  it('keyId: the first 12 hex digits of SHA-256, never the key', () => {
    expect(keyId('abc')).toBe('ba7816bf8f01');
    expect(keyId('abc')).toMatch(/^[0-9a-f]{12}$/);
  });

  it('counts per provider, key and camera; sums over keys and cameras by default', () => {
    const c = fresh();
    const a = { provider: 'google-vision', keyId: keyId('k1'), cam: 'cam3' };
    const b = { provider: 'google-vision', keyId: keyId('k1'), cam: 'cam4' };
    addUsage(c, a, '2026-10-05');
    addUsage(c, a, '2026-10-05');
    addUsage(c, b, '2026-10-05');
    expect(usageBetween(c, 'google-vision', '2026-10-01', '2026-10-31')).toBe(3);
    expect(usageBetween(c, 'google-vision', '2026-10-01', '2026-10-31', { cam: 'cam4' })).toBe(1);
    expect(usageBetween(c, 'google-vision', '2026-10-01', '2026-10-31', { keyIds: [keyId('k2')] })).toBe(0);
    expect(usageByCamera(c, 'google-vision', '2026-10-05', '2026-10-05')).toEqual({ cam3: 2, cam4: 1 });
    releaseUsage(c, a, '2026-10-05');
    expect(usageBetween(c, 'google-vision', '2026-10-05', '2026-10-05', { cam: 'cam3' })).toBe(1);
    releaseUsage(c, a, '2026-10-05');
    releaseUsage(c, a, '2026-10-05'); // never below 0
    expect(usageBetween(c, 'google-vision', '2026-10-05', '2026-10-05', { cam: 'cam3' })).toBe(0);
  });

  it('migration 9 keeps the Pi month: legacy rows get key "" and the one camera', () => {
    const c = openCatalog(version8([['google-vision', '2026-10-04', 14], ['google-vision:check', '2026-10-04', 2]]));
    expect(c.schemaVersion()).toBe(9);
    expect(usageBetween(c, 'google-vision', '2026-10-01', '2026-10-31')).toBe(14);
    expect(adoptLegacyUsage(c, ['cam1'])).toBe(2);
    expect(usageByCamera(c, 'google-vision', '2026-10-04', '2026-10-04')).toEqual({ cam1: 14 });
    expect(usageBetween(c, 'google-vision', '2026-10-04', '2026-10-04', { keyIds: [''] })).toBe(14);
    expect(adoptLegacyUsage(c, ['cam1'])).toBe(0); // once only
    expect(c.db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'stream_log_cam_ts'").get()).toBeDefined();
  });

  it('with several cameras the legacy rows go to "unknown"', () => {
    const c = openCatalog(version8([['google-vision', '2026-10-04', 5]]));
    adoptLegacyUsage(c, ['cam3', 'cam4']);
    expect(usageByCamera(c, 'google-vision', '2026-10-04', '2026-10-04')).toEqual({ unknown: 5 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/catalog-usage.test.ts`
Expected: FAIL with `Failed to resolve import "../src/analytics/key-id"`

- [ ] **Step 3: Write the implementation**

Create `src/analytics/key-id.ts`:

```ts
import { createHash } from 'crypto';

// Which API key a usage row was counted against (spec 2026-10-05-multi-camera-host-design §5.1):
// the first 12 hex digits of its SHA-256. Never the key, never reversible to it.
export function keyId(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 12);
}
```

Append to `MIGRATIONS` in `src/catalog/migrations.ts` (after the archive migration, before `];`):

```ts
  // 9: several cameras on one proxy (spec 2026-10-05-multi-camera-host-design
  // §5.1): usage per API key (key_id, '' for rows from before) and camera
  // ('' here; adoptLegacyUsage assigns the configured camera at start).
  // stream_log_cam_ts serves the per-camera latest() lookups.
  `
  CREATE TABLE analytics_usage_v9 (
    provider TEXT NOT NULL,
    key_id TEXT NOT NULL,
    cam TEXT NOT NULL,
    day TEXT NOT NULL,
    calls INTEGER NOT NULL,
    PRIMARY KEY (provider, key_id, cam, day)
  );
  INSERT INTO analytics_usage_v9 (provider, key_id, cam, day, calls) SELECT provider, '', '', day, calls FROM analytics_usage;
  DROP TABLE analytics_usage;
  ALTER TABLE analytics_usage_v9 RENAME TO analytics_usage;
  CREATE INDEX stream_log_cam_ts ON stream_log (cam, ts);
  `,
```

Replace `addUsage`, `usageBetween` and `releaseUsage` in `src/catalog/analyses.ts` and add the new functions:

```ts
// One usage counter: a provider's (or a still-check outcome's) calls with one
// API key for one camera (spec 2026-10-05-multi-camera-host-design §5.1).
export interface UsageKey { provider: string; keyId: string; cam: string }

export function addUsage(c: Catalog, u: UsageKey, day: string): void {
  c.db
    .prepare('INSERT INTO analytics_usage (provider, key_id, cam, day, calls) VALUES (?, ?, ?, ?, 1) ON CONFLICT (provider, key_id, cam, day) DO UPDATE SET calls = calls + 1')
    .run(u.provider, u.keyId, u.cam, day);
}

// Calls of a provider between two days (inclusive), over every key and camera
// unless `keyIds` or `cam` narrow it.
export function usageBetween(c: Catalog, provider: string, fromDay: string, toDay: string, f: { keyIds?: string[]; cam?: string } = {}): number {
  const where = ['provider = ?', 'day >= ?', 'day <= ?'];
  const args: string[] = [provider, fromDay, toDay];
  if (f.keyIds) (where.push(`key_id IN (${f.keyIds.map(() => '?').join(',') || "NULL"})`), args.push(...f.keyIds));
  if (f.cam !== undefined) (where.push('cam = ?'), args.push(f.cam));
  const r = c.db.prepare(`SELECT COALESCE(SUM(calls), 0) AS n FROM analytics_usage WHERE ${where.join(' AND ')}`).get(...args) as { n: number };
  return r.n;
}

// The same, split by camera (the Status page and the daily audit).
export function usageByCamera(c: Catalog, provider: string, fromDay: string, toDay: string): Record<string, number> {
  const rows = c.db.prepare('SELECT cam, SUM(calls) AS n FROM analytics_usage WHERE provider = ? AND day >= ? AND day <= ? GROUP BY cam ORDER BY cam').all(provider, fromDay, toDay) as { cam: string; n: number }[];
  return Object.fromEntries(rows.map((r) => [r.cam, r.n]));
}

// Rows the migration left without a camera (cam = ''): the one configured
// camera's, or 'unknown' with several (spec §5.1). Runs at every start;
// changes nothing once done.
export function adoptLegacyUsage(c: Catalog, cams: string[]): number {
  return Number(c.db.prepare("UPDATE analytics_usage SET cam = ? WHERE cam = ''").run(cams.length === 1 ? cams[0] : 'unknown').changes);
}
```

```ts
// Gives back a reserved call that was never made (a still check reserves its
// call before it reads the still).
export function releaseUsage(c: Catalog, u: UsageKey, day: string): void {
  c.db.prepare('UPDATE analytics_usage SET calls = calls - 1 WHERE provider = ? AND key_id = ? AND cam = ? AND day = ? AND calls > 0').run(u.provider, u.keyId, u.cam, day);
}
```

In `src/analytics/service.ts`, import `keyId` and add one helper to the class; every `addUsage`/`releaseUsage` call uses it (the camera is still the one `this.d.cam` here; Task 5 passes the job's camera):

```ts
import { keyId } from './key-id';
```

```ts
  // The usage counter of a provider (or check outcome) for this camera and
  // the key in use now ('' when no key: nothing is counted against a key then).
  private usageKey(provider: string, key = this.key()): UsageKey {
    return { provider, keyId: key ? keyId(key) : '', cam: this.d.cam };
  }
```

Replace the calls:
- `count()`: `addUsage(this.d.catalog, this.usageKey(CHECK_USAGE[what]), localDay(this.now(), this.d.timeInfo()));`
- `check()`: before the reservation, `const reserved = [this.usageKey('google-vision'), this.usageKey(CHECK_USAGE.calls)];` then `for (const u of reserved) addUsage(this.d.catalog, u, day);` and pass `reserved` to `callCheck(at, via, day, abort.signal, reserved)`.
- `callCheck(…, reserved: UsageKey[])`: `release` becomes `for (const u of reserved) releaseUsage(this.d.catalog, u, day);` (the same key as reserved, also if the key changed meanwhile).
- `run()`: `addUsage(this.d.catalog, this.usageKey('google-vision', key), day);`

Import `type UsageKey` from `../catalog/analyses`.

In `test/catalog-analyses.test.ts:70-86`, the old calls become `addUsage(c, { provider: 'google-vision', keyId: '', cam: 'cam1' }, '2026-09-30')` (same for every `addUsage` there); the `usageBetween` asserts stay. In `test/catalog-still-checks.test.ts` and `test/catalog-archive.test.ts` the hand-made version-8 catalogs stay as they are (they insert into the old table before opening); change their `expect(c.schemaVersion()).toBe(8)` to `.toBe(MIGRATIONS.length)`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/catalog-usage.test.ts test/catalog-analyses.test.ts test/catalog-still-checks.test.ts test/catalog-archive.test.ts test/analytics-service.test.ts test/analytics-still-checks.test.ts`
Expected: PASS (`Test Files  6 passed`)

- [ ] **Step 5: Run the whole suite and the type check**

Run: `npm test && npm run lint:types`
Expected: `Test Files  … passed` with no failures; `lint:types` prints nothing.

- [ ] **Step 6: Commit**

```bash
git add src/catalog/migrations.ts src/catalog/analyses.ts src/analytics/key-id.ts src/analytics/service.ts test/catalog-usage.test.ts test/catalog-analyses.test.ts test/catalog-still-checks.test.ts test/catalog-archive.test.ts
git commit -m "feat(catalog): usage per API key and camera (migration 9)"
```

---

### Task 2: Camera accessors over today's config shape

The runtime stops reading `config.camera` directly; it asks `cameraIds()` and `cameraConfig()`. This task builds them over the *old* shape so nothing else changes yet; Task 8 reimplements them over the new shape.

**Files:**
- Create: `src/config/cameras.ts`
- Test: `test/config-cameras.test.ts` (new)

**Interfaces:**
- Consumes: `Config` from `src/config/defaults.ts` (old shape: `camera`, `ftp.user`, `camera.poeSwitch`).
- Produces (`src/config/cameras.ts`):

```ts
export type PoeSwitchModel = 'none' | 'sscpoe-web';
export interface HostPoeSwitch { model: PoeSwitchModel; host?: string; ports: number; offSeconds: number }
export interface ResolvedCamera {
  id: string; name: string; host: string; protocol: 'https' | 'http'; tlsName?: string; webUiUrl?: string;
  user: string; onvifPort: number; rtspPort: number; baichuanPort: number; statusPollS: number;
  poeSwitch: HostPoeSwitch & { port?: number };      // the host switch plus this camera's port
  ftp: { user: string; enabled: boolean; stream: 'main' | 'sub' };
  stills: Config['stills'];                          // host stills with this camera's overrides applied
  events: Config['events'];                          // host events with this camera's overrides applied
  analytics: { kinds: Config['analytics']['kinds'] };
}
export function cameraIds(c: Config): string[];                          // config order
export function cameraConfig(c: Config, id: string): ResolvedCamera | undefined;
export function firstCameraId(c: Config): string;
// The events settings a camera's tracker and intake read on every use: the
// host object itself (live, as today) unless the camera overrides one of them.
export function cameraEvents(c: Config, id: string): Config['events'];
```

- [ ] **Step 1: Write the failing test**

Create `test/config-cameras.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { DEFAULTS, type Config } from '../src/config/defaults';
import { cameraConfig, cameraEvents, cameraIds, firstCameraId } from '../src/config/cameras';

const cfg = (): Config => {
  const c = structuredClone(DEFAULTS);
  c.camera.host = '192.0.2.10';
  c.camera.poeSwitch = { model: 'sscpoe-web', host: '192.0.2.2', port: 8, ports: 8, offSeconds: 10 };
  return c;
};

describe('camera accessors (spec §4.1)', () => {
  it('one camera: its id, first in order', () => {
    expect(cameraIds(cfg())).toEqual(['cam1']);
    expect(firstCameraId(cfg())).toBe('cam1');
  });
  it('resolves the camera with the host stills, events, kinds, FTP user and switch', () => {
    const r = cameraConfig(cfg(), 'cam1')!;
    expect(r).toMatchObject({ id: 'cam1', name: 'Den', host: '192.0.2.10', protocol: 'https', user: 'proxy', statusPollS: 30 });
    expect(r.poeSwitch).toEqual({ model: 'sscpoe-web', host: '192.0.2.2', port: 8, ports: 8, offSeconds: 10 });
    expect(r.ftp).toEqual({ user: 'camera', enabled: false, stream: 'main' });
    expect(r.stills).toEqual(DEFAULTS.stills);
    expect(r.events).toEqual(DEFAULTS.events);
    expect(r.analytics.kinds).toEqual(DEFAULTS.analytics.kinds);
  });
  it('an unknown id: undefined', () => {
    expect(cameraConfig(cfg(), 'cam9')).toBeUndefined();
  });
  it('the result is a copy: changing it never changes the config', () => {
    const c = cfg();
    cameraConfig(c, 'cam1')!.stills.intervalS = 5;
    expect(c.stills.intervalS).toBe(1);
  });
  it('cameraEvents: the live host object while the camera overrides nothing', () => {
    const c = cfg();
    expect(cameraEvents(c, 'cam1')).toBe(c.events);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/config-cameras.test.ts`
Expected: FAIL with `Failed to resolve import "../src/config/cameras"`

- [ ] **Step 3: Write the implementation**

Create `src/config/cameras.ts`:

```ts
import type { Config } from './defaults';

// One camera's settings as its worker runs them (spec
// 2026-10-05-multi-camera-host-design §4.1): the camera node plus the host
// defaults it may override. Always a copy.
export type PoeSwitchModel = 'none' | 'sscpoe-web';
export interface HostPoeSwitch { model: PoeSwitchModel; host?: string; ports: number; offSeconds: number }
export interface ResolvedCamera {
  id: string; name: string; host: string; protocol: 'https' | 'http'; tlsName?: string; webUiUrl?: string;
  user: string; onvifPort: number; rtspPort: number; baichuanPort: number; statusPollS: number;
  poeSwitch: HostPoeSwitch & { port?: number };
  ftp: { user: string; enabled: boolean; stream: 'main' | 'sub' };
  stills: Config['stills'];
  events: Config['events'];
  analytics: { kinds: Config['analytics']['kinds'] };
}

// The configured cameras' ids in config order (today: the one camera).
export function cameraIds(c: Config): string[] {
  return [c.camera.id];
}

export function firstCameraId(c: Config): string {
  return cameraIds(c)[0];
}

// Live: the tracker and the intake read maxOpenMin and poll.* on every use,
// and a Settings change applies at once (as before several cameras).
export function cameraEvents(c: Config, _id: string): Config['events'] {
  return c.events;
}

export function cameraConfig(c: Config, id: string): ResolvedCamera | undefined {
  if (id !== c.camera.id) return undefined;
  const { poeSwitch, ...cam } = structuredClone(c.camera);
  return {
    ...cam,
    poeSwitch,
    ftp: { user: c.ftp.user, enabled: c.ftp.enabled, stream: c.ftp.stream },
    stills: structuredClone(c.stills),
    events: structuredClone(c.events),
    analytics: { kinds: { ...c.analytics.kinds } },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/config-cameras.test.ts`
Expected: PASS (`5 passed`)

- [ ] **Step 5: Commit**

```bash
git add src/config/cameras.ts test/config-cameras.test.ts
git commit -m "feat(config): camera accessors (cameraIds, cameraConfig)"
```

---

### Task 3: `CameraWorker` and `CameraRegistry`; the proxy runs its camera through them

Move today's camera side (`src/proxy.ts:167-372` and the reboot/PoE/time-info pieces at `:442-470`) into a class, one instance per camera id, held in config order. With one camera nothing visible changes; the existing suite is the gate.

**Files:**
- Create: `src/cameras/worker.ts`
- Create: `src/cameras/registry.ts`
- Modify: `src/proxy.ts` (camera side → registry; host code uses `cams.first()`)
- Test: `test/camera-worker.test.ts` (new)

**Interfaces:**
- Consumes: `cameraConfig`, `cameraIds`, `cameraEvents`, `ResolvedCamera` (Task 2).
- Produces (`src/cameras/worker.ts`):

```ts
export type WorkerPhase = 'idle' | 'starting' | 'ready' | 'restarting' | 'stopped';
export interface WorkerHooks {
  onCameraCheck(c: { ok: boolean; ms: number; error?: string }): void;
  onResubscribe(): void;
  onStill(ts: number): void;
  onStillMissing(): void;
  onRecordingDownload(o: { stream: string; result: string; priority: string }): void;
}
export interface WorkerDeps {
  id: string;
  index: number;                         // position in config order (Ruling P1-1)
  running: () => Config;
  password: () => string;                // this camera's password
  poeSwitchPassword: () => string | undefined;
  ftpTarget: () => FtpTarget;            // what camera-ftp-setup writes for this camera
  catalog: Catalog; log: StreamLog; sse: SseHandler; storage: Storage; audit: AuditLog;
  hooks: WorkerHooks;
  cameraFtpCheckMs?: number;
}
export function cameraWebUi(c: ResolvedCamera): string | null;
export class CameraWorker extends EventEmitter {
  readonly id: string;
  client: ReolinkClient; status: StatusPoller; intake: EventIntake; stills: StillsSide | undefined;
  readonly recordings: RecordingsSide; readonly reboot: CameraReboot; readonly poeSwitch: PoeSwitch;
  readonly ftpWatch: CameraFtpWatch; readonly timeInfo: () => TimeInfo | undefined;
  cam(): ResolvedCamera;
  phase(): WorkerPhase;
  error(): string | null;
  name(): string;
  nameSource(): 'camera' | 'config';
  writeName(name: string): Promise<string>;
  readStill(ts: number): Promise<Buffer | undefined>;
  listStills(from: number, to: number): number[];
  makeIndexer(growth: boolean): ClipIndexer;
  streamStatus(): { enabled: boolean; up: boolean; go2rtcUp: boolean; lastFrameTs: number | null };
  clipsHealth(): ClipsStall | null;
  poeSwitchInfo(): { model: string; host: string; port: number };
  settingsChanged(before: ResolvedCamera): void;
  start(): Promise<void>;
  restart(): Promise<void>;
  stopSwitch(): Promise<void>;           // first in the proxy's stop: PoE back on, audited
  stopRecordings(): Promise<void>;
  stop(): Promise<void>;                 // the rest, after the HTTP server closed
}
```

- Produces (`src/cameras/registry.ts`):

```ts
export class CameraRegistry {
  constructor(order: () => string[]);
  add(w: CameraWorker): void;
  get(id: string): CameraWorker | undefined;
  list(): CameraWorker[];                // config order
  ids(): string[];
  first(): CameraWorker;                 // throws when empty
  readonly size: number;
}
```

- [ ] **Step 1: Write the failing test**

Create `test/camera-worker.test.ts`:

```ts
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openCatalog } from '../src/catalog/db';
import { loadConfig } from '../src/config/load';
import { StreamLog } from '../src/stream/log';
import { sseHandler } from '../src/stream/sse';
import { Storage } from '../src/storage';
import { AuditLog } from '../src/audit/audit-log';
import { CameraWorker } from '../src/cameras/worker';
import { CameraRegistry } from '../src/cameras/registry';
import { ADMIN_TOKEN, CLIENT_TOKEN, until } from './helpers/proxy';
import { startSim } from './helpers/sim';

let sim: Awaited<ReturnType<typeof startSim>>;
beforeAll(async () => {
  sim = await startSim();
});
afterAll(async () => {
  await sim.close();
});

const NO_HOOKS = { onCameraCheck() {}, onResubscribe() {}, onStill() {}, onStillMissing() {}, onRecordingDownload() {} };

function worker() {
  const dir = mkdtempSync(join(tmpdir(), 'camproxy-worker-'));
  writeFileSync(join(dir, 'config.json'), JSON.stringify({
    camera: { host: sim.camera.host, protocol: 'http', user: 'proxy', onvifPort: sim.ports.onvif, rtspPort: sim.ports.rtsp || 554, baichuanPort: sim.camera.baichuanPort, statusPollS: 5 },
    stills: { enabled: false },
    server: { logLevel: 'silent' },
  }));
  const loaded = loadConfig({ CAMPROXY_TOKENS: CLIENT_TOKEN, CAMPROXY_ADMIN_TOKEN: ADMIN_TOKEN, CAMPROXY_CAMERA_PASSWORD: sim.password }, { cwd: dir });
  const running = structuredClone(loaded.config);
  const catalog = openCatalog(join(running.server.dataDir, 'catalog.sqlite'));
  const log = new StreamLog(catalog);
  const audit = new AuditLog({ dir: join(running.server.dataDir, 'audit'), version: 'test', camera: () => 'cam1' });
  const storage = new Storage({ catalog, log, config: () => running, audit });
  const w = new CameraWorker({
    id: 'cam1', index: 0, running: () => running, password: () => sim.password, poeSwitchPassword: () => undefined,
    ftpTarget: () => ({ server: '', port: 2121, user: 'camera', password: '', tls: true, stream: 'main' }),
    catalog, log, sse: sseHandler(log, running.sse), storage, audit, hooks: NO_HOOKS,
  });
  return { w, running, catalog };
}

describe('CameraWorker (spec §3.1)', () => {
  it('starts, reads the camera, restarts, stops', async () => {
    const { w, catalog } = worker();
    expect(w.phase()).toBe('idle');
    await w.start();
    expect(w.phase()).toBe('ready');
    await until(() => w.status.state().online);
    await until(() => w.nameSource() === 'camera');
    const restart = w.restart();
    expect(w.phase()).toBe('restarting');
    await restart;
    expect(w.phase()).toBe('ready');
    await until(() => w.status.state().online);
    await w.stopSwitch();
    await w.stopRecordings();
    await w.stop();
    expect(w.phase()).toBe('stopped');
    catalog.close();
  });

  it('one camera: the whole recordings cache cap (Ruling P1-3)', () => {
    const { w, running, catalog } = worker();
    expect(w.recordings.status().cache.capBytes).toBe(running.recordings.cacheMB * 2 ** 20);
    catalog.close();
  });
});

describe('CameraRegistry', () => {
  it('lists in config order, finds by id, first()', () => {
    let order = ['b', 'a'];
    const r = new CameraRegistry(() => order);
    const fake = (id: string) => ({ id }) as unknown as CameraWorker;
    r.add(fake('a'));
    r.add(fake('b'));
    expect(r.ids()).toEqual(['b', 'a']);
    expect(r.first().id).toBe('b');
    expect(r.get('a')?.id).toBe('a');
    expect(r.get('zz')).toBeUndefined();
    order = ['a', 'b'];
    expect(r.list().map((w) => w.id)).toEqual(['a', 'b']);
    expect(r.size).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/camera-worker.test.ts`
Expected: FAIL with `Failed to resolve import "../src/cameras/worker"`

- [ ] **Step 3: Write the registry**

Create `src/cameras/registry.ts`:

```ts
import type { CameraWorker } from './worker';

// The camera workers of this proxy (spec 2026-10-05-multi-camera-host-design
// §3.1), always listed in config order (`order`: the ids as configured).
export class CameraRegistry {
  private readonly byId = new Map<string, CameraWorker>();

  constructor(private readonly order: () => string[]) {}

  add(w: CameraWorker): void {
    this.byId.set(w.id, w);
  }

  get(id: string): CameraWorker | undefined {
    return this.byId.get(id);
  }

  list(): CameraWorker[] {
    return this.order().flatMap((id) => (this.byId.has(id) ? [this.byId.get(id)!] : []));
  }

  ids(): string[] {
    return this.list().map((w) => w.id);
  }

  first(): CameraWorker {
    const w = this.list()[0];
    if (!w) throw new Error('no camera configured');
    return w;
  }

  get size(): number {
    return this.byId.size;
  }
}
```

- [ ] **Step 4: Write the worker**

Create `src/cameras/worker.ts`:

```ts
import { EventEmitter } from 'events';
import type { AuditLog } from '../audit/audit-log';
import type { Catalog } from '../catalog/db';
import { lastClipReceived } from '../catalog/clips';
import { ReolinkClient } from '../camera/client';
import { bareHost, splitHost } from '../camera/http';
import { CameraNameAnnouncer, writeCameraName } from '../camera/name';
import { CameraReboot } from '../camera/reboot';
import { PoeSwitch } from '../camera/poe-switch';
import { StatusPoller, type CameraState } from '../camera/status';
import type { TimeInfo } from '../camera/time';
import { refreshingTimeInfo } from '../analytics/time-info';
import type { StillsSide } from '../api/client-api';
import { readCameraFtp, type FtpTarget } from '../clips/camera-ftp';
import { CameraFtpWatch, clipsStalled, type ClipsStall } from '../clips/ftp-health';
import { ClipIndexer } from '../clips/indexer';
import type { Config } from '../config/defaults';
import { cameraConfig, cameraEvents, cameraIds, type ResolvedCamera } from '../config/cameras';
import { EventIntake } from '../events/intake';
import { EventTracker } from '../events/tracker';
import { logger } from '../log';
import { createRecordingsSide, type RecordingsSide } from '../recordings/side';
import { Go2rtc } from '../stills/go2rtc';
import { FrameGrabber, type Frame } from '../stills/grabber';
import { MinuteStore, minuteOf } from '../stills/store';
import type { Storage } from '../storage';
import type { StreamLog } from '../stream/log';
import type { SseHandler } from '../stream/sse';

export type WorkerPhase = 'idle' | 'starting' | 'ready' | 'restarting' | 'stopped';

// What the host counts per camera (Prometheus); the proxy binds the camera id.
export interface WorkerHooks {
  onCameraCheck(c: { ok: boolean; ms: number; error?: string }): void;
  onResubscribe(): void;
  onStill(ts: number): void;
  onStillMissing(): void;
  onRecordingDownload(o: { stream: string; result: string; priority: string }): void;
}

export interface WorkerDeps {
  id: string;
  index: number; // position in config order: go2rtc ports until P2 (Ruling P1-1)
  running: () => Config;
  password: () => string;
  poeSwitchPassword: () => string | undefined;
  ftpTarget: () => FtpTarget;
  catalog: Catalog;
  log: StreamLog;
  sse: SseHandler;
  storage: Storage;
  audit: AuditLog;
  hooks: WorkerHooks;
  cameraFtpCheckMs?: number;
}

// The camera's own web page for the admin UI: webUiUrl, none for no link,
// or https://<host without its port>/.
export function cameraWebUi(c: ResolvedCamera): string | null {
  if (c.webUiUrl === 'none') return null;
  if (c.webUiUrl) return c.webUiUrl;
  const { hostname } = splitHost(c.host);
  return hostname ? `https://${hostname}/` : null;
}

// One camera's side (spec 2026-10-05-multi-camera-host-design §3.1): its
// client, status poller, name, events, stills, recordings, reboot, PoE port
// and FTP watch. restart() builds the parts again with the current settings;
// one worker's trouble never touches another's.
export class CameraWorker extends EventEmitter {
  readonly id: string;
  client!: ReolinkClient;
  status!: StatusPoller;
  intake!: EventIntake;
  stills: StillsSide | undefined;
  readonly recordings: RecordingsSide;
  readonly reboot: CameraReboot;
  readonly poeSwitch: PoeSwitch;
  readonly ftpWatch: CameraFtpWatch;
  readonly timeInfo: () => TimeInfo | undefined;
  private phaseNow: WorkerPhase = 'idle';
  private errorNow: string | null = null;
  // The camera's name as last read (camera-name design); the configured name
  // is only the fallback until the first read. Each change goes to stream
  // clients once as a `camera` message with the camera's address.
  private nameRead: string | undefined;
  private toldName: string | undefined;
  private toldAddress: string | undefined;
  private readonly announcer: CameraNameAnnouncer;
  private lastResubscribes = 0;
  private stillsStarting: Promise<void> | undefined;
  private stopping = false;
  private watchStarted = false;
  private restarting: Promise<void> | undefined;

  constructor(private readonly d: WorkerDeps) {
    super();
    this.id = d.id;
    const lastTold = d.log.latest(d.id, 'camera')?.data;
    this.toldName = typeof lastTold?.name === 'string' ? lastTold.name : undefined;
    this.toldAddress = typeof lastTold?.address === 'string' ? lastTold.address : undefined;
    this.announcer = new CameraNameAnnouncer(this.toldName ?? this.cam().name, (name, previous) => {
      logger.info({ cameraId: this.id, name, previous }, 'camera_name_changed');
      this.toldName = name;
      this.toldAddress = this.cam().host;
      d.log.append(this.id, 'camera', { name, address: this.cam().host });
    });
    // The FTP watch is read by the status listeners build() adds: made first.
    this.ftpWatch = new CameraFtpWatch({
      read: () => readCameraFtp(this.client),
      target: d.ftpTarget,
      audit: d.audit,
      active: () => this.cam().ftp.enabled && this.status.state().online,
      clipsBefore: () => lastClipReceived(d.catalog, this.id) !== null,
      everyMs: d.cameraFtpCheckMs,
    });
    this.build();
    // Recordings on the SD card over Baichuan (spec 2026-10-02-baichuan-recordings-design).
    this.recordings = createRecordingsSide({
      dataDir: d.running().server.dataDir,
      cam: () => this.id,
      target: () => {
        const c = this.cam();
        return { host: bareHost(splitHost(c.host).hostname), port: c.baichuanPort, user: c.user, password: d.password() };
      },
      // Ruling P1-3: the cap split evenly until the shared cache of P2.
      capBytes: () => Math.floor((d.running().recordings.cacheMB * 2 ** 20) / Math.max(1, cameraIds(d.running()).length)),
      search: (param) => this.client.command('Search', param),
      timeInfo: () => this.client.timeInfo(),
      paused: () => d.storage.paused(),
      noteWritten: (bytes) => d.storage.noteWritten('recordings', bytes, 1),
      onDownload: (o) => d.hooks.onRecordingDownload({ stream: o.stream, result: o.result, priority: o.priority }),
    });
    // A reboot (#83): the client and poller are read on use (restart builds
    // them anew); the Baichuan session dies with the camera.
    this.reboot = new CameraReboot({
      send: () => this.client.command('Reboot'),
      forgetToken: () => {
        this.client.forgetToken();
        this.recordings.reset();
      },
      serial: () => this.status.state().serial,
      check: async () => {
        const s = await this.status.checkNow();
        return { ok: s.error === undefined, serial: s.serial };
      },
      audit: d.audit,
    });
    // Ruling P1-4: this camera's port on the host switch (one controller per host in P2).
    this.poeSwitch = new PoeSwitch({ config: () => this.cam().poeSwitch, password: d.poeSwitchPassword });
    this.timeInfo = refreshingTimeInfo(() => this.client.timeInfo());
  }

  cam(): ResolvedCamera {
    const c = cameraConfig(this.d.running(), this.id);
    if (!c) throw new Error(`camera ${this.id} is not configured`);
    return c;
  }

  phase(): WorkerPhase {
    return this.phaseNow;
  }

  // The worker's own error (Task 6: supervision), else the camera's last check error.
  error(): string | null {
    return this.errorNow ?? this.status.state().error ?? null;
  }

  name(): string {
    return this.nameRead ?? this.cam().name;
  }

  nameSource(): 'camera' | 'config' {
    return this.nameRead === undefined ? 'config' : 'camera';
  }

  // Writes through to the camera and reads back; the poller (and so the
  // stream message) knows the new name at once.
  async writeName(name: string): Promise<string> {
    const read = await writeCameraName((cmd, param) => this.client.command(cmd, param), name);
    this.status.noteName(read);
    return read;
  }

  readStill(ts: number): Promise<Buffer | undefined> {
    return this.stills?.store.readStill(ts) ?? Promise.resolve(undefined);
  }

  listStills(from: number, to: number): number[] {
    return this.stills?.store.listStills(from, to) ?? [];
  }

  // A clip indexer for this camera; `growth: false` for a repair's fetches.
  makeIndexer(growth: boolean): ClipIndexer {
    const d = this.d;
    return new ClipIndexer({ catalog: d.catalog, log: d.log, config: d.running, timeInfo: () => this.client.timeInfo(), dataDir: d.running().server.dataDir, cam: this.id, stored: (bytes) => d.storage.noteWritten('clips', bytes, 1, { growth }) });
  }

  streamStatus(): { enabled: boolean; up: boolean; go2rtcUp: boolean; lastFrameTs: number | null } {
    const s = this.stills;
    return { enabled: !!s, up: s?.grabber.up() ?? false, go2rtcUp: s?.go2rtc.up() ?? false, lastFrameTs: s?.grabber.lastFrameTs() ?? null };
  }

  // No stall warning for a camera never set up, nor before the first read when no clip ever came.
  private ftpNotSetUp(): boolean {
    const st = this.ftpWatch.view().state;
    return st === 'not_set_up' || (st === 'unknown' && lastClipReceived(this.d.catalog, this.id) === null);
  }

  clipsHealth(): ClipsStall | null {
    return this.cam().ftp.enabled ? clipsStalled(this.d.catalog, this.id, Date.now(), this.d.running().ftp.stalledHours, { notSetUp: this.ftpNotSetUp() }) : null;
  }

  // What audit records name about the switch: never the password.
  poeSwitchInfo(): { model: string; host: string; port: number } {
    const c = this.cam().poeSwitch;
    return { model: c.model, host: c.host ?? '', port: c.port ?? 0 };
  }

  // Live settings changed (the proxy's setLoaded): a new Baichuan port is used
  // from the next connection on.
  settingsChanged(before: ResolvedCamera): void {
    if (this.cam().baichuanPort !== before.baichuanPort) this.recordings.session.close();
  }

  // Tells stream clients the camera's address when it starts with another
  // one than last told (spec 2026-10-04-pi-config-design §2).
  private announceAddress(): void {
    const host = this.cam().host;
    if (this.toldAddress === host) return;
    this.toldAddress = host;
    logger.info({ cameraId: this.id, address: host }, 'camera_address_told');
    this.d.log.append(this.id, 'camera', { ...(this.toldName !== undefined ? { name: this.toldName } : {}), address: host });
  }

  // The parts restart() makes anew: client, poller, tracker, intake, stills.
  private build(): void {
    const d = this.d;
    const c = this.cam();
    this.announceAddress();
    this.client = new ReolinkClient({ id: c.id, host: c.host, protocol: c.protocol, tlsServername: c.tlsName, user: c.user, password: d.password() });
    this.status = new StatusPoller(this.client, c.statusPollS);
    this.status.on('change', (s: CameraState) => d.log.append(c.id, 'camera-status', { online: s.online, reason: s.error ?? null, clockOffsetMs: s.clockOffsetMs ?? null }));
    this.status.on('check', (x: { ok: boolean; ms: number; error?: string }) => d.hooks.onCameraCheck(x));
    this.status.on('name', (name: string) => {
      this.nameRead = name;
      this.announcer.seen(name);
    });
    // The camera's FTP settings as soon as it answers (#93), then every few minutes.
    this.status.on('change', (s: CameraState) => {
      if (s.online) void this.ftpWatch.checkNow();
    });
    const events = cameraEvents(d.running(), this.id);
    const tracker = new EventTracker(d.catalog, d.log, c.id, events);
    this.intake = new EventIntake({ client: this.client, tracker, cfg: events, onvif: { host: splitHost(c.host).hostname, port: c.onvifPort, user: c.user, password: d.password() } });
    this.lastResubscribes = 0;
    this.intake.on('state', (st: { resubscribes: number }) => {
      for (; this.lastResubscribes < st.resubscribes; this.lastResubscribes++) d.hooks.onResubscribe();
    });
    // Stills: go2rtc holds the camera connection, one ffmpeg makes stills and
    // tiles, the store writes a pack and a sprite per minute.
    this.stills = undefined;
    if (c.stills.enabled) {
      const r = d.running();
      const s = c.stills;
      const offset = 100 * d.index; // Ruling P1-1: index 0 keeps today's ports
      const go2rtc = new Go2rtc({ binary: r.go2rtc.binary, rtspPort: r.go2rtc.rtspPort + offset, apiPort: r.go2rtc.apiPort + offset, cam: c.id,
        source: { host: splitHost(c.host).hostname, port: c.rtspPort, user: c.user, password: d.password() } });
      const grabber = new FrameGrabber({ input: go2rtc.streamUrl(s.stream), intervalS: s.intervalS, size: s.size, tileSize: r.previews.tileSize, quality: s.quality, tileQuality: r.previews.quality });
      const store = new MinuteStore({ dataDir: r.server.dataDir, cam: c.id, intervalS: s.intervalS, still: { size: s.size, quality: s.quality }, tile: { size: r.previews.tileSize, grid: r.previews.grid, quality: r.previews.quality } });
      store.on('written', (w: { kind: 'stills' | 'previews'; bytes: number; files: number }) => d.storage.noteWritten(w.kind, w.bytes, w.files));
      grabber.on('frame', (f: Frame) => {
        if (d.storage.paused()) return d.hooks.onStillMissing(); // the disk is full: no writing
        store.add(f);
        d.hooks.onStill(f.ts);
        const minute = minuteOf(f.ts);
        const base = `/api/cameras/${encodeURIComponent(c.id)}`;
        d.sse.live(c.id, 'still', { ts: f.ts, url: `${base}/stills/${f.ts}.jpg`, sprite: `${base}/previews/${minute}.jpg`, tile: Math.floor((f.ts - minute) / (s.intervalS * 1000)) });
      });
      // Stream up and down reach stream clients as camera-status (spec §8).
      grabber.on('state', (st: { up: boolean }) => {
        const cs = this.status.state();
        d.log.append(c.id, 'camera-status', { online: cs.online, stream: st.up ? 'up' : 'down', reason: st.up ? null : 'no_frames', clockOffsetMs: cs.clockOffsetMs ?? null });
      });
      this.stills = { go2rtc, grabber, store };
    }
  }

  // go2rtc takes a moment to start; the grabber starts only if its side is
  // still the current one (a restart or stop may come in between).
  private startStills(): void {
    const s = this.stills;
    if (!s) return;
    this.stillsStarting = s.go2rtc.start().then(
      () => {
        if (this.stills === s && !this.stopping) s.grabber.start();
      },
      (err: Error) => logger.error({ cameraId: this.id, err: err.message }, 'go2rtc_start_failed'),
    );
  }

  private async stopStills(): Promise<void> {
    const s = this.stills;
    if (!s) return;
    this.stopping = true;
    await this.stillsStarting;
    this.stopping = false;
    await s.grabber.stop();
    await s.go2rtc.stop();
    await s.store.flush();
  }

  private async startParts(): Promise<void> {
    this.status.start();
    this.intake.start();
    this.startStills();
  }

  private async stopParts(): Promise<void> {
    await this.intake.stop();
    this.status.stop();
    await this.stopStills();
    await this.client.logout();
  }

  async start(): Promise<void> {
    this.phaseNow = 'starting';
    await this.startParts();
    if (!this.watchStarted) {
      this.ftpWatch.start();
      this.watchStarted = true;
    }
    this.phaseNow = 'ready';
  }

  // One at a time: a second call while one runs joins it.
  restart(): Promise<void> {
    this.restarting ??= (async () => {
      this.phaseNow = 'restarting';
      try {
        await this.stopParts();
        this.recordings.reset();
        this.build();
        await this.startParts();
        this.phaseNow = 'ready';
        logger.info({ cameraId: this.id }, 'camera_side_restarted');
      } finally {
        this.restarting = undefined;
      }
    })();
    return this.restarting;
  }

  // A power-cycle in its off time turns the camera's PoE on now, not never;
  // bounded, and loud (audited) when it could not.
  async stopSwitch(): Promise<void> {
    const { poeLeftOff, sessionMaybeOpen } = await this.poeSwitch.stop();
    if (!poeLeftOff && !sessionMaybeOpen) return;
    const sw = this.poeSwitchInfo();
    const parts = [
      ...(poeLeftOff ? [`the camera's PoE may be left OFF on ${sw.host} port ${sw.port}; turn it on in the switch's web UI, or with "Turn camera PoE on" once the proxy is back`] : []),
      ...(sessionMaybeOpen ? ["the proxy's web session on the switch may still be open: the switch's web UI may refuse logins until the switch ends it"] : []),
    ];
    this.d.audit.write({ action: 'camera-powercycle', category: ['host'], type: ['end'], outcome: 'failure', user: 'system', message: `cam-proxy stopping: ${parts.join('; ')}`, details: { phase: 'stop', poeLeftOff, sessionMaybeOpen, switch: sw } });
  }

  stopRecordings(): Promise<void> {
    return this.recordings.stop();
  }

  async stop(): Promise<void> {
    await this.restarting;
    this.phaseNow = 'stopped';
    this.ftpWatch.stop();
    this.reboot.stop();
    await this.stopParts();
  }
}
```

- [ ] **Step 5: Run the worker test**

Run: `npx vitest run test/camera-worker.test.ts`
Expected: PASS (`3 passed`)

- [ ] **Step 6: Wire the proxy through the registry**

In `src/proxy.ts`:

1. Delete `cameraWebUi` (now in the worker module) and the camera-side code: `client`, `status`, the name block (`cameraNameRead` … `announceAddress`), `intake`, `lastResubscribes`, `clips`/`stills` declarations, `makeIndexer`, `buildCameraSide`, `startClips`, `startStills`, `stopStills`, `startCameraSide`, `stopCameraSide`, `ftpWatch`, `noted`, `ftpNotSetUp`, `clipsHealth`, the `buildCameraSide()` call, `recordings` (`createRecordingsSide`), `reboot`, `poeSwitch`, `poeSwitchInfo`, and `const timeInfo = refreshingTimeInfo(...)`.
2. Replace the start-of-file close of open events with one per camera:

```ts
  for (const id of cameraIds(running)) {
    for (const e of closeAllOpen(catalog, id, last.ts ?? Date.now(), 'restart')) {
      log.append(e.cam, 'camera-event', { eventId: e.id, kind: e.kind, phase: 'end', ts: e.end_ts, source: e.source, reason: 'restart' });
    }
  }
```

3. After `storage.on('run', metrics.onRetention);` build the registry and the host FTP side:

```ts
  // The camera workers (spec 2026-10-05-multi-camera-host-design §3.1), in config order.
  const cams = new CameraRegistry(() => cameraIds(running));
  // What camera-ftp-setup writes for a camera (never logged: it has the password).
  const ftpTargetFor = (id: string) => (): FtpTarget => {
    const c = cameraConfig(running, id)!;
    return { server: running.ftp.publicHost ?? '', port: running.ftp.port, user: c.ftp.user, password: loaded.secrets.ftpPassword ?? '', tls: running.ftp.tls, stream: c.ftp.stream };
  };
  cameraIds(running).forEach((id, index) =>
    cams.add(new CameraWorker({
      id, index,
      running: () => running,
      password: () => loaded.secrets.cameraPassword,
      poeSwitchPassword: () => loaded.secrets.poeSwitchPassword,
      ftpTarget: ftpTargetFor(id),
      catalog, log, sse, storage, audit,
      hooks: { onCameraCheck: metrics.onCameraCheck, onResubscribe: metrics.onResubscribe, onStill: metrics.onStill, onStillMissing: metrics.onStillMissing, onRecordingDownload: metrics.onRecordingDownload },
      cameraFtpCheckMs: opts.cameraFtpCheckMs,
    })),
  );
  recordingBusy = (p) => cams.list().some((w) => w.recordings.cache.busy(p));
  // The FTP server (host-wide): uploads go to the one camera with FTP on (Ruling P1-2).
  let clips: ReturnType<typeof createClipsSide> | undefined;
  const ftpCamera = () => cams.list().find((w) => w.cam().ftp.enabled);
  const buildClips = () => {
    clips = undefined;
    const w = ftpCamera();
    if (!w) return;
    if (!loaded.secrets.ftpPassword) return void logger.error('ftp_enabled_without_password');
    const indexer = w.makeIndexer(true);
    // Pictures stored before they were paired by time (2026-09-30).
    try {
      indexer.relinkSnapshots();
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'snapshots_relink_failed');
    }
    clips = createClipsSide({ config: running, user: w.cam().ftp.user, password: loaded.secrets.ftpPassword, indexer, accept: () => !storage.paused() });
  };
  buildClips();
  const startClips = async () => {
    try {
      await clips?.start();
    } catch (err) {
      logger.error({ err: (err as Error).message }, 'ftp_start_failed');
    }
  };
```

In `src/clips/side.ts`, `createClipsSide` gains `user: string` in its deps and passes `user: d.user` to `FtpServer` (instead of `f.user`); this keeps the server independent of where the user setting lives.

4. Replace every remaining use of a deleted name with the first camera (Task 5 makes them per camera). Use this table, and let `npm run lint:types` find every site:

| was | becomes |
|---|---|
| `status` | `cams.first().status` |
| `intake` | `cams.first().intake` |
| `stills` | `cams.first().stills` |
| `client` | `cams.first().client` |
| `recordings` | `cams.first().recordings` |
| `reboot` | `cams.first().reboot` |
| `poeSwitch` | `cams.first().poeSwitch` |
| `ftpWatch` | `cams.first().ftpWatch` |
| `cameraName` | `() => cams.first().name()` |
| `cameraNameRead === undefined ? 'config' : 'camera'` | `cams.first().nameSource()` |
| `poeSwitchInfo()` | `cams.first().poeSwitchInfo()` |
| `streamStatus` | `() => cams.first().streamStatus()` |
| `clipsHealth()` | `cams.first().clipsHealth()` |
| `makeIndexer(false)` | `cams.first().makeIndexer(false)` |
| `timeInfo` (the refreshing one) | `() => cams.first().timeInfo()` |
| `stillAt` | `(ts: number) => cams.first().readStill(ts)` |
| `stillsIn` | `(from: number, to: number) => cams.first().listStills(from, to)` |
| `cameraWebUi(running.camera)` | `cameraWebUi(cams.first().cam())` |
| `running.camera.id` | `cams.first().id` |
| `running.camera.poeSwitch` | `cams.first().cam().poeSwitch` |
| `noted(setupCameraFtp(client, t))` | `(async () => { const f = await setupCameraFtp(cams.first().client, t); cams.first().ftpWatch.note(f); return f; })()` |
| `noted(cameraFtpOff(client, ftpTarget()))` | `(async () => { const w = cams.first(); const f = await cameraFtpOff(w.client, ftpTargetFor(w.id)()); w.ftpWatch.note(f); return f; })()` |
| `ftpTarget` | `ftpTargetFor(cams.first().id)` |
| `cameraName.write` body | `(name) => cams.first().writeName(name)` |

`clientApi`'s `status: () => status` becomes `status: () => cams.first().status`; `stills: () => stills` becomes `stills: () => cams.first().stills`; `recordings: () => recordings` becomes `recordings: () => cams.first().recordings`.

5. `setLoaded`: replace the Baichuan port lines with

```ts
    const before = new Map(cams.list().map((w) => [w.id, w.cam()]));
    loaded = next;
    applySettings(needsRestart);
    for (const w of cams.list()) w.settingsChanged(before.get(w.id)!);
```

(keep the rest of `setLoaded`).

6. `restartCameraSide` (the `restart` action) restarts every worker and the FTP side:

```ts
  const restartCameraSide = async () => {
    await clips?.stop();
    applySettings(needsProcessRestart);
    await Promise.all(cams.list().map((w) => w.restart()));
    buildClips();
    await startClips();
    logger.info('cam_proxy_restarted');
  };
```

7. `start()`: replace `await startCameraSide(); ftpWatch.start();` with

```ts
      await Promise.all(cams.list().map((w) => w.start()));
      await startClips();
```

and `proxy-start`'s `details.config.camera: running.camera.id` with `cameras: cams.ids()`; the `cam_proxy_started` log line gets `cameras: cams.ids()` instead of `camera`.

8. `doStop()`: replace `ftpWatch.stop()` (gone: the worker stops it) and the PoE block with `await Promise.all(cams.list().map((w) => w.stopSwitch()));`; replace `reboot.stop()` (gone); in the `Promise.all([...])` replace `recordings.stop()` with `...cams.list().map((w) => w.stopRecordings())`; replace `await stopCameraSide();` with `await clips?.stop(); await Promise.all(cams.list().map((w) => w.stop()));`.

9. The `Proxy` interface gains `readonly cameras: CameraRegistry;` and the object gets `cameras: cams,`; its getters become (Ruling P1-15):

```ts
    get status() {
      return cams.first().status;
    },
    get intake() {
      return cams.first().intake;
    },
    get stills() {
      return cams.first().stills;
    },
    get clips() {
      return clips?.side;
    },
    get recordings() {
      return cams.first().recordings;
    },
```

(`recordings` moves from a plain property to a getter; the interface line stays `readonly recordings: RecordingsSide;`).

- [ ] **Step 7: Run the whole suite and the type check**

Run: `npm run lint:types && npm test`
Expected: `lint:types` prints nothing; `Test Files  … passed` with no failures (the one-camera suite unchanged).

- [ ] **Step 8: Run the e2e suite**

Run: `npm run build && npm run test:e2e`
Expected: every spec passes (`… passed`), none skipped that passed before.

- [ ] **Step 9: Commit**

```bash
git add src/cameras/worker.ts src/cameras/registry.ts src/proxy.ts src/clips/side.ts test/camera-worker.test.ts
git commit -m "refactor: the camera side becomes a CameraWorker in a CameraRegistry"
```

---

### Task 4: `cameraParam`, `can()`, and every `:cam` route served by its worker

**Files:**
- Create: `src/api/camera-param.ts`
- Modify: `src/api/auth.ts` (export `AccessInfo`, add `can`, `requireAccess` uses it)
- Modify: `src/api/client-api.ts`, `src/api/compose-api.ts`, `src/api/archive-api.ts`, `src/api/still-checks-api.ts`
- Modify: `src/proxy.ts` (router deps; image rate limit × cameras)
- Test: `test/camera-param.test.ts` (new), `test/client-api.test.ts` (extend)

**Interfaces:**
- Consumes: `CameraRegistry`, `CameraWorker` (Task 3).
- Produces:
  - `src/api/auth.ts`: `export interface AccessInfo { access: 'admin' | 'client' | 'audit' | null; viaCookie: boolean; tokenKind: TokenKind }`; `export type AccessNeed = 'client' | 'admin' | 'audit-read'`; `export function can(principal: AccessInfo, need: AccessNeed, cam?: string): boolean`.
  - `src/api/camera-param.ts`: `export const RESTART_RETRY_S = 5`; `export function cameraParam(cams: CameraRegistry, need?: AccessNeed): (req: Request, res: Response, next: NextFunction, id: string) => void`; `export function workerOf(res: Response): CameraWorker`.
  - Router deps: `clientApi(d: { config; catalog; cameras: CameraRegistry; sse })`, `composeApi(d: { …; cameras: CameraRegistry })` (no `stillsIn`), `stillChecksApi(d: { …; cameras: CameraRegistry })`, `archiveApi(d: { …; cameras: CameraRegistry })` (no `recordings`, `online`, `timeInfo`).
  - `GET /api/cameras` item: today's fields plus `error: string | null`.

- [ ] **Step 1: Write the failing tests**

Create `test/camera-param.test.ts`:

```ts
import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { can, type AccessInfo } from '../src/api/auth';
import { cameraParam, workerOf } from '../src/api/camera-param';
import { CameraRegistry } from '../src/cameras/registry';
import type { CameraWorker, WorkerPhase } from '../src/cameras/worker';

const worker = (id: string, phase: WorkerPhase) => ({ id, phase: () => phase }) as unknown as CameraWorker;

function app(phases: Record<string, WorkerPhase>) {
  const cams = new CameraRegistry(() => Object.keys(phases));
  for (const [id, p] of Object.entries(phases)) cams.add(worker(id, p));
  const a = express();
  const r = express.Router();
  r.param('cam', cameraParam(cams));
  r.get('/cameras/:cam/x', (_req, res) => void res.json({ id: workerOf(res).id }));
  a.use((_req, res, next) => ((res.locals.access = { access: 'client', viaCookie: false, tokenKind: 'client' }), next()));
  a.use(r);
  return a;
}

describe('cameraParam (spec §6.1, §3.3)', () => {
  it('puts the worker on res.locals', async () => {
    const r = await request(app({ cam3: 'ready', cam4: 'ready' })).get('/cameras/cam4/x');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ id: 'cam4' });
  });
  it('unknown camera: 404 not_found', async () => {
    const r = await request(app({ cam3: 'ready' })).get('/cameras/cam9/x');
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: 'not_found' });
  });
  it('restarting camera answers 503 at once; the others answer normally', async () => {
    const a = app({ cam3: 'restarting', cam4: 'ready' });
    const t0 = Date.now();
    const r = await request(a).get('/cameras/cam3/x');
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(r.status).toBe(503);
    expect(r.body).toEqual({ error: 'camera_restarting' });
    expect(r.headers['retry-after']).toBe('5');
    expect((await request(a).get('/cameras/cam4/x')).status).toBe(200);
  });
  it('an idle camera (no address) is still served: its stored data stays readable', async () => {
    expect((await request(app({ cam3: 'idle' })).get('/cameras/cam3/x')).status).toBe(200);
  });
});

describe('can() (spec §6.6): what the token kind allows, for any camera', () => {
  const p = (access: AccessInfo['access'], tokenKind: AccessInfo['tokenKind'] = 'client'): AccessInfo => ({ access, viaCookie: tokenKind === 'session', tokenKind });
  it.each([
    [p('admin', 'admin'), 'admin', true],
    [p('admin', 'session'), 'client', true],
    [p('client'), 'client', true],
    [p('client'), 'admin', false],
    [p('audit', 'audit'), 'audit-read', true],
    [p('audit', 'audit'), 'client', false],
    [p(null, 'none'), 'client', false],
  ] as const)('%j may %s: %s', (who, need, ok) => {
    expect(can(who, need)).toBe(ok);
    expect(can(who, need, 'cam3')).toBe(ok);
  });
});
```

Append to `test/client-api.test.ts`, inside its `describe('client API', …)` (the file's `p` and `sim` come from its `beforeAll`; `auth` is imported):

```ts
  it('GET /api/cameras: one camera, today\'s fields plus error (spec §6.1)', async () => {
    const r = await request(p.base).get('/api/cameras').set(auth());
    expect(r.status).toBe(200);
    expect(r.body).toHaveLength(1);
    expect(Object.keys(r.body[0]).sort()).toEqual(['address', 'error', 'id', 'lastEventTs', 'name', 'online', 'publicUrl', 'stream']);
    expect(r.body[0].id).toBe('cam1');
    expect((await request(p.base).get('/api/cameras/cam9').set(auth())).status).toBe(404);
  });
```

Its existing exact assertion at `test/client-api.test.ts:39` (`expect(r.body).toEqual([{ id: 'cam1', … address: sim.camera.host }])`) gets `error: null` added to the object: a new field, as spec §6.1 says.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/camera-param.test.ts test/client-api.test.ts`
Expected: FAIL with `Failed to resolve import "../src/api/camera-param"` (and the new client-api test fails on the missing `error` key).

- [ ] **Step 3: `can()` in `src/api/auth.ts`**

Export the `AccessInfo` interface (add `export`), and add below it:

```ts
export type AccessNeed = 'client' | 'admin' | 'audit-read';

// The one access decision (spec 2026-10-05-multi-camera-host-design §6.6):
// today what the token kind allows, for any camera. A later roles project
// replaces this function and the principal's source; routes stay as they are.
export function can(principal: AccessInfo, need: AccessNeed, _cam?: string): boolean {
  const a = principal.access;
  if (need === 'admin') return a === 'admin';
  if (need === 'audit-read') return a === 'admin' || a === 'audit';
  return a === 'admin' || a === 'client';
}
```

In `requireAccess`, keep the 401 branch as it is and replace the two 403 checks with:

```ts
    if (!can(a, need)) return refuse(403, 'admin-only', 'admin_only');
    // HEAD too: Express answers it with the GET route, without the body.
    if (need === 'audit-read' && req.method !== 'GET' && req.method !== 'HEAD') return refuse(403, 'admin-only', 'admin_only');
```

- [ ] **Step 4: Create `src/api/camera-param.ts`**

```ts
import type { NextFunction, Request, Response } from 'express';
import { can, type AccessInfo, type AccessNeed } from './auth';
import type { CameraRegistry } from '../cameras/registry';
import type { CameraWorker } from '../cameras/worker';

// How long a client waits before asking a restarting camera again.
export const RESTART_RETRY_S = 5;

// Resolves `:cam` to its worker for every route of a router (spec
// 2026-10-05-multi-camera-host-design §6.1): unknown → 404 not_found;
// restarting → 503 camera_restarting with Retry-After (never a hang).
// Use: router.param('cam', cameraParam(cams)).
export function cameraParam(cams: CameraRegistry, need: AccessNeed = 'client') {
  return (_req: Request, res: Response, next: NextFunction, id: string): void => {
    const w = cams.get(String(id));
    if (!w) return void res.status(404).json({ error: 'not_found' });
    const a = res.locals.access as AccessInfo | undefined;
    if (a && !can(a, need, w.id)) return void res.status(403).json({ error: 'admin_only' });
    if (w.phase() === 'restarting') {
      res.setHeader('Retry-After', String(RESTART_RETRY_S));
      return void res.status(503).json({ error: 'camera_restarting' });
    }
    res.locals.worker = w;
    next();
  };
}

export function workerOf(res: Response): CameraWorker {
  return res.locals.worker as CameraWorker;
}
```

- [ ] **Step 5: Convert the four routers**

In each of `client-api.ts`, `compose-api.ts`, `archive-api.ts`, `still-checks-api.ts`:

1. Add `cameras: CameraRegistry` to the deps type; remove the single-camera deps (`status`, `cameraName`, `stills`, `recordings` in client-api; `stillsIn` in compose-api; `recordings`, `online`, `timeInfo` in archive-api).
2. Right after `const r = express.Router();` add `r.param('cam', cameraParam(d.cameras));`.
3. Delete `const cam = () => …camera.id`, `known()`, and every `if (!known(req, res)) return;` / `if (req.params.cam !== cam()) return notFound(res);` (the param does it, before the route's own middlewares such as `validate` and the limiters).
4. In every handler of a `/cameras/:cam/...` route, start with `const w = workerOf(res);` and use: `w.id` for `cam()`, `w.stills` for `d.stills()`, `w.status` for `d.status()`, `w.recordings` for `d.recordings()`, `w.name()` for `d.cameraName()`, `w.listStills(from, to)` for `d.stillsIn(from, to)`, `w.status.state().online` for `d.online()`, `w.timeInfo()` for `d.timeInfo()`.
5. archive-api: `resolveSource(c, res, input)` gains a first parameter `w: CameraWorker` and uses it as in 4; the zip's file name becomes `archive-${d.cameras.size === 1 ? d.cameras.first().id : 'all'}-${stamp}.zip` (host-wide route: no `:cam`).
6. still-checks-api: `validAt` no longer calls `known`; the image route's folder is `resolve(d.config().server.dataDir, 'still-checks', w.id)`.

client-api's list and info become:

```ts
  // One camera's info. `name`: the camera's own name (camera-name design), the
  // configured name until first read. publicUrl: where people reach this
  // proxy's web UI. address: the camera's host as it runs. error: the
  // worker's or the last check's error, null when fine (spec §6.1).
  const info = (w: CameraWorker) => {
    const s = w.stills;
    const stream = s ? { up: s.grabber.up(), lastFrameTs: s.grabber.lastFrameTs() } : null;
    return { id: w.id, name: w.name(), online: w.status.state().online, lastEventTs: lastLiveEventTs(d.catalog, w.id), stream, publicUrl: d.config().server.publicUrl ?? null, address: w.cam().host, error: w.error() };
  };
  r.get('/cameras', (_req, res) => void res.json(d.cameras.list().map(info)));
  r.get('/cameras/:cam', (_req, res) => void res.json(info(workerOf(res))));
```

- [ ] **Step 6: Proxy wiring**

In `src/proxy.ts`, pass `cameras: cams` to the four routers and drop the removed deps.

The image bucket grows with the number of cameras (spec §6.1; see Ruling P1-16). Today `app.use(limiter(1200, isImage))` is the bucket for everything **but** images (its `skip` is `isImage`) and `app.use(limiter(6000, (req) => !isImage(req)))` is the image bucket. Replace the second line with:

```ts
  // Images: 6000 per minute per camera (a timeline per camera loads its own sprites).
  app.use(rateLimit({ windowMs: 60_000, limit: () => 6000 * Math.max(1, cams.size), skip: (req) => !isImage(req), standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'rate_limited' } }));
```

and keep the 1200 non-image bucket as it is. `isImage`'s recording check becomes `cams.list().some((w) => w.recordings.cache.has(id))`.

- [ ] **Step 7: Run the tests**

Run: `npx vitest run test/camera-param.test.ts test/client-api.test.ts test/compose-api.test.ts test/archive-api.test.ts test/archive-api-read.test.ts test/still-checks-api.test.ts test/stills-api.test.ts test/clips-api.test.ts test/recordings-api.test.ts`
Expected: PASS (`Test Files  9 passed`)

- [ ] **Step 8: Whole suite and types**

Run: `npm run lint:types && npm test`
Expected: no type errors; all test files pass.

- [ ] **Step 9: Commit**

```bash
git add src/api/camera-param.ts src/api/auth.ts src/api/client-api.ts src/api/compose-api.ts src/api/archive-api.ts src/api/still-checks-api.ts src/proxy.ts test/camera-param.test.ts test/client-api.test.ts
git commit -m "feat(api): every :cam route resolves its camera worker; can() seam"
```

---

### Task 5: Analytics: one host-wide queue, jobs and checks carry their camera

**Files:**
- Modify: `src/analytics/service.ts`
- Modify: `src/api/still-checks-api.ts` (`check(w.id, …)`)
- Modify: `src/proxy.ts` (analytics deps, `onEvent` with `cam`)
- Modify: `test/analytics-service.test.ts`, `test/analytics-still-checks.test.ts` (deps shape)
- Test: `test/analytics-multi.test.ts` (new)

**Interfaces:**
- Consumes: `UsageKey`, `keyId` (Task 1); `CameraRegistry` (Task 3).
- Produces (`src/analytics/service.ts`):

```ts
export interface AnalyticsDeps {
  catalog: Catalog; log: StreamLog; dataDir: string;
  cams: () => string[];                                        // configured ids, config order
  kinds?: (cam: string) => Config['analytics']['kinds'];       // default: the host kinds
  config: () => Config;
  secrets: () => { googleVisionKey?: string; googleVisionUrl: string };
  readStill: (cam: string, ts: number) => Promise<Buffer | undefined>;
  listStills: (cam: string, from: number, to: number) => number[];
  timeInfo: () => TimeInfo | undefined;                        // the usage day (Ruling P1-5)
  now?; sleep?; provider?; audit?;                             // unchanged
}
type Job = { cam: string; id: number; kind: string; start_ts: number };
onEvent(e: Job): void;
check(cam: string, at: number, via: CheckVia): Promise<CheckOutcome>;
```

- [ ] **Step 1: Write the failing test**

Create `test/analytics-multi.test.ts`:

```ts
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { openCatalog } from '../src/catalog/db';
import { analysisFor, usageByCamera } from '../src/catalog/analyses';
import { insertEvent } from '../src/catalog/events';
import { checkAt } from '../src/catalog/still-checks';
import { DEFAULTS } from '../src/config/defaults';
import { AnalyticsService } from '../src/analytics/service';
import { localDay } from '../src/analytics/local-day';
import { StreamLog } from '../src/stream/log';

const T0 = Date.parse('2026-10-05T15:00:00Z');

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'camproxy-amulti-'));
  const c = openCatalog(join(dir, 'catalog.sqlite'));
  let now = T0 + 3000;
  const log = new StreamLog(c, () => now);
  const config = structuredClone(DEFAULTS);
  config.analytics.googleVision = { enabled: true, monthlyLimit: 100, dailyCap: 0, checksPerDay: 10 };
  // cam3 has a still at T0+1000 (byte 3), cam4 at the same time (byte 4).
  const stills: Record<string, Map<number, Buffer>> = { cam3: new Map([[T0 + 1000, Buffer.from([3])]]), cam4: new Map([[T0 + 1000, Buffer.from([4])]]) };
  const seen: number[] = [];
  const s = new AnalyticsService({
    catalog: c, log, dataDir: dir,
    cams: () => ['cam3', 'cam4'],
    kinds: (cam) => (cam === 'cam4' ? { person: false, vehicle: true, pet: false } : config.analytics.kinds),
    config: () => config,
    secrets: () => ({ googleVisionKey: 'k-123456789012', googleVisionUrl: 'http://mock' }),
    readStill: async (cam, ts) => stills[cam]?.get(ts),
    listStills: (cam, from, to) => [...(stills[cam]?.keys() ?? [])].filter((t) => t >= from && t <= to),
    timeInfo: () => undefined,
    now: () => now,
    sleep: async (ms) => void (now += ms),
    provider: () => ({ id: 'google-vision', name: 'Google Vision', async analyze(jpeg) { seen.push(jpeg[0]); return { objects: [], raw: {} }; } }),
  });
  return { c, s, seen, log, day: localDay(now, undefined) };
}

describe('analytics with several cameras (spec §8.2, §5.1)', () => {
  it("analyses each camera's event with its own still and counts the call for that camera", async () => {
    const { c, s, seen, day } = setup();
    const e3 = insertEvent(c, { cam: 'cam3', source: 'onvif', kind: 'person', start_ts: T0, raw: null });
    const e4 = insertEvent(c, { cam: 'cam4', source: 'onvif', kind: 'vehicle', start_ts: T0, raw: null });
    s.onEvent(e3);
    s.onEvent(e4);
    await s.idle();
    expect(seen).toEqual([3, 4]);
    expect(analysisFor(c, e3.id)?.status).toBe('ok');
    expect(analysisFor(c, e4.id)?.status).toBe('ok');
    expect(usageByCamera(c, 'google-vision', day, day)).toEqual({ cam3: 1, cam4: 1 });
  });

  it("follows each camera's kinds: cam4 does not analyse persons", async () => {
    const { c, s, seen } = setup();
    s.onEvent(insertEvent(c, { cam: 'cam4', source: 'onvif', kind: 'person', start_ts: T0, raw: null }));
    await s.idle();
    expect(seen).toEqual([]);
  });

  it('a still check runs on the camera asked for', async () => {
    const { c, s, seen } = setup();
    const r = await s.check('cam4', T0 + 1000, 'token');
    expect(r.outcome).toBe('ok');
    expect(seen).toEqual([4]);
    expect(checkAt(c, 'cam4', T0 + 1000)).toBeDefined();
    expect(checkAt(c, 'cam3', T0 + 1000)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/analytics-multi.test.ts`
Expected: FAIL (TypeScript-free run: `seen` is `[]` or `readStill is not a function`-style errors, because the service still reads `this.d.cam` and calls `readStill(ts)`).

- [ ] **Step 3: Implement**

In `src/analytics/service.ts`:

1. Replace the deps type with the one in **Interfaces** above, and `type Job = { cam: string; id: number; kind: string; start_ts: number };`.
2. `wanted(kind)` becomes `wanted(cam: string, kind: string)` reading `(this.d.kinds ?? (() => this.settings().kinds))(cam)`.
3. `onEvent(e: Job)`: `if (this.stopped || !this.active() || !this.wanted(e.cam, e.kind)) return; this.queue.push({ cam: e.cam, id: e.id, kind: e.kind, start_ts: e.start_ts });` (rest unchanged).
4. `catchUp()`:

```ts
  catchUp(): void {
    if (!this.active()) return;
    for (const cam of this.d.cams()) {
      const k = (this.d.kinds ?? (() => this.settings().kinds))(cam);
      const kinds = KINDS.filter((x) => k[x]);
      if (kinds.length) for (const e of unanalysed(this.d.catalog, cam, kinds, this.now() - CATCH_UP_MS)) this.onEvent({ cam, ...e });
    }
  }
```

5. `usageKey(provider, key?)` from Task 1 becomes `usageKey(provider: string, cam: string, key = this.key()): UsageKey` returning `{ provider, keyId: key ? keyId(key) : '', cam }`.
6. `count(what)` becomes `count(what, cam: string)`; every caller passes the check's camera.
7. `check(cam: string, at: number, via: CheckVia)`: replace `const cam = this.d.cam;` by the parameter; the join test becomes `if (running?.at === at && running.cam === cam)`; `this.checking = { cam, at, done, abort }` (add `cam: string` to the `checking` field's type); `this.d.listStills(cam, at, at)`; the reservations use `this.usageKey(..., cam)`; `callCheck(cam, at, via, day, signal, reserved)`.
8. `callCheck`: `this.d.readStill(cam, at)`; `insertCheck(... cam, ...)`; folder `join(this.d.dataDir, 'still-checks', cam)`; `this.d.log.append(cam, 'still-check', …)`.
9. `pickStill(start)` becomes `pickStill(cam: string, start: number)` with `this.d.listStills(cam, …)`.
10. `run(job)`: `pickStill(job.cam, job.start_ts)`, `this.d.readStill(job.cam, stillTs)`, `addUsage(this.d.catalog, this.usageKey('google-vision', job.cam, key), day)`.
11. `store(job, …)`: `this.d.log.append(job.cam, 'analysis', …)`; `storeOk`: folder `join(this.d.dataDir, 'analytics', job.cam)`; `auditCall`: `details: { cam: job.cam, … }`.
12. `backfillSummaries()`: the log line drops `cam` (`logger.info({ summarised: n }, …)`).

In `src/api/still-checks-api.ts` the check call becomes `d.analytics.check(workerOf(res).id, at, via)` (Task 4 already gives the route its worker).

In `src/proxy.ts`:

```ts
  const analytics = new AnalyticsService({
    catalog, log, dataDir: running.server.dataDir,
    cams: () => cams.ids(),
    kinds: (cam) => cameraConfig(running, cam)?.analytics.kinds ?? running.analytics.kinds,
    config: () => running,
    secrets: () => ({ googleVisionKey: loaded.secrets.googleVisionKey, googleVisionUrl: loaded.secrets.googleVisionUrl }),
    readStill: (cam, ts) => cams.get(cam)?.readStill(ts) ?? Promise.resolve(undefined),
    listStills: (cam, from, to) => cams.get(cam)?.listStills(from, to) ?? [],
    timeInfo: () => cams.first().timeInfo(),
    audit,
  });
  log.on('message', (m: StreamMessage) => {
    if (m.type === 'camera-event' && m.data.phase === 'start') analytics.onEvent({ cam: m.cam, id: Number(m.data.eventId), kind: String(m.data.kind), start_ts: Number(m.data.ts) });
  });
```

In `test/analytics-service.test.ts` and `test/analytics-still-checks.test.ts`, the shared `deps()` factory changes `cam: 'cam1'` to `cams: () => ['cam1']`, `readStill: async (ts) =>` to `readStill: async (_cam, ts) =>`, `listStills: (from, to) =>` to `listStills: (_cam, from, to) =>`; every `s.check(` / `.check(at` call gets `'cam1', ` as its first argument; any hand-made `onEvent({ id, kind, start_ts })` literal gets `cam: 'cam1'` (rows from `insertEvent` carry `cam` already).

- [ ] **Step 4: Run the analytics tests**

Run: `npx vitest run test/analytics-multi.test.ts test/analytics-service.test.ts test/analytics-still-checks.test.ts test/analytics-api.test.ts test/still-checks-api.test.ts`
Expected: PASS (`Test Files  5 passed`)

- [ ] **Step 5: Whole suite and types**

Run: `npm run lint:types && npm test`
Expected: no type errors; every test file passes.

- [ ] **Step 6: Commit**

```bash
git add src/analytics/service.ts src/api/still-checks-api.ts src/proxy.ts test/analytics-multi.test.ts test/analytics-service.test.ts test/analytics-still-checks.test.ts
git commit -m "feat(analytics): one queue for every camera; jobs, checks and usage carry the camera"
```

---

### Task 6: Archive and compositions read stills of the request's camera

**Files:**
- Modify: `src/archive/service.ts` (deps per camera; `notify` per camera, Ruling P1-14)
- Modify: `src/compose/jobs.ts` (`ffmpegRunner` reads the job's camera)
- Modify: `src/proxy.ts`
- Modify: `test/archive-service.test.ts`, `test/archive-jobs.test.ts`, `test/compose-ffmpeg.test.ts`, `test/compose-jobs.test.ts` where they build these deps
- Test: `test/archive-multi.test.ts` (new)

**Interfaces:**
- Produces:
  - `ArchiveDeps`: `cameraName: (cam: string) => string`, `cameraModel: (cam: string) => string | null`, `stillsIn: (cam: string, from: number, to: number) => number[]`, `readStill: (cam: string, ts: number) => Promise<Buffer | undefined>` (each was camera-less).
  - `Archive.notify(action: Action, rows: { id: number; cam: string }[], items?: ArchiveRow[]): void` — one stream message per camera among `rows`.
  - `ffmpegRunner(o: { …; readStill: (cam: string, ts: number) => Promise<Buffer | undefined>; stillsIntervalS?: (cam: string) => number })`.

- [ ] **Step 1: Write the failing test**

Create `test/archive-multi.test.ts`:

```ts
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { openCatalog } from '../src/catalog/db';
import { insertArchive } from '../src/catalog/archive';
import { DEFAULTS } from '../src/config/defaults';
import { Archive } from '../src/archive/service';
import type { AuditLog } from '../src/audit/audit-log';
import { StreamLog, type StreamMessage } from '../src/stream/log';

describe('archive stream messages per camera (Ruling P1-14)', () => {
  it('a delete across two cameras sends one message per camera', () => {
    const dir = mkdtempSync(join(tmpdir(), 'camproxy-armulti-'));
    const c = openCatalog(join(dir, 'catalog.sqlite'));
    const log = new StreamLog(c);
    const config = structuredClone(DEFAULTS);
    config.server.dataDir = dir;
    const a = new Archive({
      dataDir: dir, catalog: c, log, audit: { write: () => undefined } as unknown as AuditLog, config: () => config, disk: () => ({ free: 1e12, size: 2e12 }), timeInfo: () => undefined,
      cameraName: (cam) => `name-${cam}`, cameraModel: () => null, version: 'test',
      stillsIn: () => [], readStill: async () => undefined,
    });
    const row = (cam: string) => insertArchive(c, { cam, name: cam, labels: [], retention_days: 365, created_at: 1000, recorded_from: 1, recorded_to: 2, quality: 'sd', original: 0, duration_s: 1, bytes: 3, files: '{}', source: '{}', thumb_from: 'none', thumb_at: null, created_by: 'client', metadata: '{}' });
    const r3 = row('cam3');
    const r4 = row('cam4');
    const sent: StreamMessage[] = [];
    log.on('message', (m: StreamMessage) => sent.push(m));
    a.delete([r3.id, r4.id], { user: 'admin' });
    expect(sent.filter((m) => m.type === 'archive').map((m) => [m.cam, m.data.ids])).toEqual([['cam3', [r3.id]], ['cam4', [r4.id]]]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/archive-multi.test.ts`
Expected: FAIL — the messages have `cam: 'cam1'` (the process camera) and one message for both rows.

- [ ] **Step 3: Implement**

`src/archive/service.ts`:

```ts
  // One stream message per camera of the rows named (Ruling P1-14): a client
  // subscribed to some cameras sees the changes of exactly those.
  notify(action: Action, rows: { id: number; cam: string }[], items?: ArchiveRow[]): void {
    if (!rows.length) return;
    const byCam = new Map<string, number[]>();
    for (const r of rows) byCam.set(r.cam, [...(byCam.get(r.cam) ?? []), r.id]);
    for (const [cam, ids] of byCam) {
      const mine = items?.filter((x) => x.cam === cam);
      try {
        this.d.log.append(cam, 'archive', { action, ids, ...(mine ? { items: mine.map(itemJson) } : {}) });
      } catch (err) {
        logger.warn({ err: (err as Error).message }, 'archive_notify_failed');
      }
    }
  }
```

Callers: `add` → `this.notify('add', [row], [row])`; `update` → `this.notify('update', [row], [row])`; `delete` collects `removed: ArchiveRow[]` (the rows `store.remove` returned) and calls `this.notify('delete', removed)`; `clear` → `this.notify('clear', rows.filter(…removed…))` (the rows it removed); `expire` → the rows it removed. The snapshot in the jobs deps uses the request's camera: `takeSnapshot({ catalog: d.catalog, cam: w.cam, cameraName: d.cameraName(w.cam), model: d.cameraModel(w.cam), … })` where `w` is the job's request (it has `cam`); `defaultName: (from) => defaultName(from, d.cameraName(req.cam), d.timeInfo())` (pass the request into the factory the way the existing code passes `w`); the thumbnail lookup uses `this.d.stillsIn(req.cam, …)` and `this.d.readStill(req.cam, t)`.

`src/compose/jobs.ts` `ffmpegRunner`: `readStill: (cam: string, ts: number) => …` called as `o.readStill(job.req.cam, s.ts)`; `stillsIntervalS?: (cam: string) => number` called as `o.stillsIntervalS?.(job.req.cam)`.

`src/proxy.ts`:

```ts
    runner: ffmpegRunner({ font: font ?? '', clock: clockText, readStill: (cam, ts) => cams.get(cam)?.readStill(ts) ?? Promise.resolve(undefined), hasAudio, paused: () => storage.paused(), stillsIntervalS: (cam) => cameraConfig(running, cam)?.stills.intervalS ?? running.stills.intervalS }),
```

(the composer is built before the registry today: move the `createComposer` call below the registry construction.)

```ts
  const archive = new Archive({
    dataDir: running.server.dataDir, catalog, log, audit, config: () => running, disk: () => storage.diskSpace(),
    timeInfo: () => cams.first().timeInfo(),
    cameraName: (cam) => cams.get(cam)?.name() ?? cam,
    cameraModel: (cam) => cams.get(cam)?.status.state().model ?? null,
    version: VERSION,
    stillsIn: (cam, from, to) => cams.get(cam)?.listStills(from, to) ?? [],
    readStill: (cam, ts) => cams.get(cam)?.readStill(ts) ?? Promise.resolve(undefined),
  });
```

compose-api's `stillsIn` dep was removed in Task 4 (it uses `w.listStills`). Update the four test files' deps the same way (`readStill: async (_cam, ts) =>`, `stillsIn: (_cam, f, t) =>`, `cameraName: () => 'Den'`).

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/archive-multi.test.ts test/archive-service.test.ts test/archive-jobs.test.ts test/archive-api.test.ts test/compose-ffmpeg.test.ts test/compose-jobs.test.ts test/compose-api.test.ts`
Expected: PASS (`Test Files  7 passed`)

- [ ] **Step 5: Whole suite and types**

Run: `npm run lint:types && npm test`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/archive/service.ts src/compose/jobs.ts src/proxy.ts test/archive-multi.test.ts test/archive-service.test.ts test/archive-jobs.test.ts test/compose-ffmpeg.test.ts test/compose-jobs.test.ts
git commit -m "feat(archive,compose): stills and names of the request's camera; archive messages per camera"
```

---

### Task 7: Inventories: one runner, each run bound to a camera

**Files:**
- Modify: `src/inventory/runner.ts` (`cam` in start/report; no `camera` dep)
- Modify: `src/inventory/stills.ts`, `src/inventory/clips.ts`, `src/inventory/events.ts`, `src/inventory/repair-clips.ts`, `src/inventory/repair-events.ts` (`settings(cam)`, `camera(cam)`)
- Modify: `src/api/control-api.ts` (`inventory` action passes the camera)
- Modify: `src/proxy.ts`
- Modify: `test/inventory-*.test.ts` that build runners or check deps
- Test: `test/inventory-multi.test.ts` (new)

**Interfaces:**
- Produces:
  - `InventoryRunner` deps: `{ dir; audit; checks; now?; keep? }` (no `camera`).
  - `start(kind: string, who: Requester, options: { camera?: boolean; cam: string }): { runId; done }`.
  - `repair(kind, who, sourceRunId)`: the repair runs on the source report's `camera`.
  - `CheckContext` and `RepairContext` gain `cam: string`.
  - Check deps: `settings: (cam: string) => …Settings` and `camera: (cam: string) => CameraListDeps` (and for the clips repair `camera: (cam) => { list; fetcher; cache; indexer: () => ClipIndexer; timeInfo }`).
  - stills inventory: audit records with a `labels.camera` of another camera are ignored.

- [ ] **Step 1: Write the failing test**

Create `test/inventory-multi.test.ts`:

```ts
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { InventoryRunner, type CheckResult } from '../src/inventory/runner';

const result = (n: number): CheckResult => ({ window: { from: null, to: 0, reason: 'test' }, counts: { n }, top: [], items: [], message: `n=${n}` });

describe('inventory runs per camera (spec §3.1)', () => {
  it('passes the camera to the check and records it in the report and the audit record', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'camproxy-invmulti-'));
    const writes: { camera?: string; details?: unknown }[] = [];
    const seen: string[] = [];
    const runner = new InventoryRunner({
      dir: join(dir, 'inventory'),
      audit: { write: (r: { camera?: string; details?: unknown }) => void writes.push(r) } as never,
      checks: { stills: { label: 'Stills', run: async (ctx) => (seen.push(ctx.cam), result(1)) } },
    });
    const { done } = runner.start('stills', { requestedBy: 'token' }, { cam: 'cam4' });
    const report = await done;
    expect(seen).toEqual(['cam4']);
    expect(report.camera).toBe('cam4');
    expect(writes.at(-1)?.camera).toBe('cam4');
  });

  it('one run at a time across cameras', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'camproxy-invmulti2-'));
    let release!: () => void;
    const runner = new InventoryRunner({
      dir: join(dir, 'inventory'), audit: { write: () => undefined } as never,
      checks: { stills: { label: 'Stills', run: () => new Promise((r) => (release = () => r(result(0)))) } },
    });
    const a = runner.start('stills', { requestedBy: 'token' }, { cam: 'cam3' });
    expect(() => runner.start('stills', { requestedBy: 'token' }, { cam: 'cam4' })).toThrow(/an inventory is running/);
    release();
    await a.done;
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/inventory-multi.test.ts`
Expected: FAIL — `seen` is `[undefined]` / `report.camera` is undefined (the runner still asks its `camera` dep).

- [ ] **Step 3: Implement the runner**

In `src/inventory/runner.ts`:
- `interface StartOptions { camera?: boolean }` stays the *stored* option; add `export interface StartRequest extends StartOptions { cam: string }`.
- `CheckContext` gets `cam: string`; `RepairContext` gets `cam: string`.
- Remove `camera: () => string` from the constructor deps.
- `start(kind, who, request: StartRequest)`: keep the stored `options` as `{ camera: true }` or `{}` as today; pass `cam: request.cam` into the job; the report's `camera` is `request.cam`.
- `repair(kind, who, source)`: the camera is the source report's `camera`.
- The job's `work` receives `cam` and passes it into the check's/repair's context.
- Every audit record the runner writes (`inventory`, `inventory-repair`) gets `camera: cam` (the field Task 8 turns into `labels.camera`; until then it is ignored by `AuditLog`), and its message names the camera when more than one is configured is **not** needed (the label carries it).

In the five check/repair modules, `d.settings()` becomes `d.settings(ctx.cam)` and `d.camera` (the list deps) becomes `d.camera(ctx.cam)`; the clips repair's `list`, `fetcher`, `cache`, `indexer`, `tempDir`, `clipsBytes` stay in its deps but `list`, `fetcher`, `cache`, `indexer` become functions of the camera (`list: (cam) => …`). In `stills.ts`, the audit records read through `records(…)` are filtered:

```ts
    const mine = (r: AuditRecord) => r.labels?.camera === undefined || r.labels.camera === ctx.cam;
    const audit = (await records(d.audit, AUDIT_ACTIONS, from, now)).filter(mine);
```

(the `AuditRecord` type gets `labels?: { camera?: string }` if it lacks it).

In `src/proxy.ts` the runner's checks are built once with camera functions:

```ts
  const worker = (cam: string) => {
    const w = cams.get(cam);
    if (!w) throw new Error(`camera ${cam} is not configured`);
    return w;
  };
  const camSettings = (cam: string) => cameraConfig(running, cam)!;
  const eventsDeps = {
    catalog,
    settings: (cam: string) => ({ cam, eventsDays: running.retention.eventsDays, stream: camSettings(cam).ftp.stream, eventMaxOpenMin: running.events.maxOpenMin }),
    camera: (cam: string) => ({ list: worker(cam).recordings.list, timeInfo: () => worker(cam).client.timeInfo() }),
  };
  const inventory = new InventoryRunner({
    dir: inventoryDir,
    audit,
    checks: {
      stills: {
        label: 'Stills',
        run: stillsCheck({ dataDir: running.server.dataDir, audit, catalog,
          settings: (cam) => ({ cam, intervalS: camSettings(cam).stills.intervalS, stillsDays: running.retention.stillsDays, previewsDays: running.retention.previewsDays, keepHours: running.storage.keepHours.stills, enabled: camSettings(cam).stills.enabled }) }),
      },
      clips: {
        label: 'Clips',
        camera: true,
        run: clipsCheck({ dataDir: running.server.dataDir, catalog, audit,
          settings: (cam) => ({ cam, clipsDays: running.retention.clipsDays, stream: camSettings(cam).ftp.stream, ftpEnabled: camSettings(cam).ftp.enabled, eventMaxOpenMin: running.events.maxOpenMin }),
          camera: (cam) => ({ list: worker(cam).recordings.list, timeInfo: () => worker(cam).client.timeInfo() }) }),
        repair: clipsRepair({ catalog,
          settings: (cam) => ({ cam, stream: camSettings(cam).ftp.stream, clipsDays: running.retention.clipsDays, maxGB: running.ftp.maxGB }),
          list: (cam) => worker(cam).recordings.list,
          fetcher: (cam) => worker(cam).recordings.fetcher,
          cache: (cam) => worker(cam).recordings.cache,
          indexer: (cam) => worker(cam).makeIndexer(false),
          tempDir: () => repairTmp,
          paused: () => storage.paused(),
          clipsBytes: () => storage.usage().clips.bytes }),
      },
      events: { label: 'Events', run: eventsCheck(eventsDeps), repair: eventsRepair(eventsDeps) },
    },
  });
```

In `src/api/control-api.ts`, the `inventory` case passes the camera: add `inventoryCamera: () => string | null` to `ControlDeps` (the only camera's id, or null with several — Task 15 answers `camera_required` for null), and call `d.inventory.start(kind, requester, { camera: camera === true, cam })` with `const cam = d.inventoryCamera(); if (cam === null) return fail(400, 'camera_required', 'several cameras: use /control/cameras/:cam/actions/inventory');`. In `src/proxy.ts`: `inventoryCamera: () => (cams.size === 1 ? cams.first().id : null)`.

Update the inventory tests: `new InventoryRunner({ …, camera: () => 'cam1', … })` loses `camera`; `runner.start(kind, who)` / `start(kind, who, { camera: true })` gain `cam: 'cam1'`; check deps built in tests get `settings: () => …` → `settings: (_cam) => …` (unchanged body) and `camera: x` → `camera: () => x`.

- [ ] **Step 4: Run the inventory tests**

Run: `npx vitest run test/inventory-multi.test.ts test/inventory-runner.test.ts test/inventory-stills.test.ts test/inventory-clips.test.ts test/inventory-events.test.ts test/inventory-repair-clips.test.ts test/inventory-repair-events.test.ts test/inventory-api.test.ts test/inventory-clips-api.test.ts test/inventory-events-api.test.ts`
Expected: PASS (`Test Files  10 passed`)

- [ ] **Step 5: Whole suite and types**

Run: `npm run lint:types && npm test`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/inventory src/api/control-api.ts src/proxy.ts test/inventory-*.test.ts
git commit -m "feat(inventory): one runner for every camera; each run names its camera"
```

---

### Task 8: Audit records name their camera; storage, daily audit and metrics over every camera

**Files:**
- Modify: `src/audit/audit-log.ts` (`AuditInput.camera`; no process-wide label)
- Modify: `src/cameras/worker.ts` (its audit writes carry the camera)
- Modify: `src/camera/reboot.ts`, `src/clips/ftp-health.ts` (audit dep type `Pick<AuditLog, 'write'>`)
- Modify: `src/api/control-api.ts` (camera records: `camera-name`, camera actions)
- Modify: `src/storage.ts:262-271` (sweep every camera folder)
- Modify: `src/audit/daily.ts`, `src/proxy.ts` (daily activity per camera, summed)
- Modify: `src/api/metrics.ts` (per-camera gauges; hooks take the camera)
- Modify: `test/audit-api.test.ts:26`, `test/audit-log.test.ts` (labels)
- Test: `test/audit-camera-label.test.ts` (new), `test/storage.test.ts` (extend), `test/metrics-multi.test.ts` (new)

**Interfaces:**
- Produces:
  - `AuditInput` gains `camera?: string`; a record has `labels: { camera }` only when `camera` is given. `AuditLog`'s constructor deps lose `camera`.
  - `withCamera(audit: Pick<AuditLog, 'write'>, cam: string): Pick<AuditLog, 'write'>` exported from `src/audit/audit-log.ts`.
  - `createMetrics(s)`: `s.cameras: () => { id: string; up: boolean; ftpEnabled: boolean | null; clips: { lastClip: number | null; stalled: boolean } | null; onvifSubscribed: boolean; stills: StillsSide | undefined }[]` replaces `stills`, `cameraUp`, `cameraFtpEnabled`, `clipsHealth`, `onvifSubscribed`; hooks become `onResubscribe(cam)`, `onStill(cam, ts)`, `onStillMissing(cam)`, `onRecordingDownload(cam, o)`, `onCameraCheck(cam, c)`.
  - `activityDaily(day, a)` unchanged; the proxy passes per-camera sums and `details.cameras` (below).

- [ ] **Step 1: Write the failing tests**

Create `test/audit-camera-label.test.ts`:

```ts
import { mkdtempSync, readFileSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { AuditLog, withCamera } from '../src/audit/audit-log';

describe('audit labels per record (spec §5.2)', () => {
  it('labels.camera only on records that concern a camera', () => {
    const dir = mkdtempSync(join(tmpdir(), 'camproxy-auditlbl-'));
    const a = new AuditLog({ dir, version: 'test' });
    a.write({ action: 'proxy-start', category: ['process'], type: ['start'], outcome: 'success', user: 'system', message: 'start' });
    withCamera(a, 'cam4').write({ action: 'camera-reboot', category: ['host'], type: ['start'], outcome: 'success', user: 'admin', message: 'reboot' });
    const lines = readFileSync(join(dir, readdirSync(dir)[0]), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines[0].labels).toBeUndefined();
    expect(lines[1].labels).toEqual({ camera: 'cam4' });
  });
});
```

Append to `test/storage.test.ts` (it has a `setup()` that returns `{ dir, storage, … }`; `mkdirSync` and `writeFileSync` are imported there, add `existsSync` to its `fs` import):

```ts
describe('storage: images of every camera (spec §5.2)', () => {
  it('sweeps unreferenced analysis and check images of every camera folder, also a removed camera', () => {
    const { dir, storage } = setup();
    for (const cam of ['cam3', 'cam4', 'gone']) {
      mkdirSync(join(dir, 'analytics', cam), { recursive: true });
      writeFileSync(join(dir, 'analytics', cam, '1.jpg'), 'x');
      mkdirSync(join(dir, 'still-checks', cam), { recursive: true });
      writeFileSync(join(dir, 'still-checks', cam, 'check-1.jpg'), 'x');
    }
    storage.run({});
    for (const cam of ['cam3', 'cam4', 'gone']) {
      expect(existsSync(join(dir, 'analytics', cam, '1.jpg'))).toBe(false);
      expect(existsSync(join(dir, 'still-checks', cam, 'check-1.jpg'))).toBe(false);
    }
  });
});
```

Create `test/metrics-multi.test.ts`:

```ts
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { createMetrics } from '../src/api/metrics';
import { openCatalog } from '../src/catalog/db';
import { DEFAULTS } from '../src/config/defaults';
import { Storage } from '../src/storage';
import { StreamLog } from '../src/stream/log';

describe('metrics with several cameras', () => {
  it('one camera_up sample per camera; counters labelled by the camera they came from', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'camproxy-metrics-'));
    const catalog = openCatalog(join(dir, 'catalog.sqlite'));
    const log = new StreamLog(catalog);
    const config = structuredClone(DEFAULTS);
    config.server.dataDir = dir;
    const storage = new Storage({ catalog, log, config: () => config, statfs: () => ({ free: 1e12, size: 2e12 }) });
    const m = createMetrics({
      storage, config: () => config, catalog, log, sseClients: () => 0, version: 'test', target: 'test',
      cameras: () => [
        { id: 'cam3', up: true, ftpEnabled: null, clips: null, onvifSubscribed: true, stills: undefined },
        { id: 'cam4', up: false, ftpEnabled: null, clips: null, onvifSubscribed: false, stills: undefined },
      ],
    });
    m.onStill('cam4', 1_000_000);
    const text = await m.render();
    expect(text).toMatch(/camproxy_camera_up\{cam="cam3"\} 1/);
    expect(text).toMatch(/camproxy_camera_up\{cam="cam4"\} 0/);
    expect(text).toMatch(/camproxy_stills_total\{cam="cam4"\} 1/);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/audit-camera-label.test.ts test/storage.test.ts test/metrics-multi.test.ts`
Expected: FAIL — `withCamera` is not exported; the `gone`/`cam3`/`cam4` images survive (the sweep only looks at the configured camera's folder); `createMetrics` has no `cameras`.

- [ ] **Step 3: Audit labels**

In `src/audit/audit-log.ts`: `AuditInput` gets `camera?: string`; the constructor deps lose `camera`; in `record()` replace `labels: { camera: this.d.camera() },` with `...(i.camera ? { labels: { camera: i.camera } } : {}),`; and add:

```ts
// The audit log as one camera's code sees it: every record names that camera.
export function withCamera(audit: Pick<AuditLog, 'write'>, cam: string): Pick<AuditLog, 'write'> {
  return { write: (i: AuditInput) => audit.write({ ...i, camera: cam }) };
}
```

(`write`'s return type stays whatever it is today; type the wrapper's `write` as `AuditLog['write']`.)

In `src/camera/reboot.ts` (`RebootDeps.audit`) and `src/clips/ftp-health.ts` (the watch's `audit`), change the type from `AuditLog` to `Pick<AuditLog, 'write'>`. In `src/cameras/worker.ts` build `const audit = withCamera(d.audit, d.id);` in the constructor (store it as `private readonly audit`) and pass it to `CameraFtpWatch`, `CameraReboot`, and use it for the `stopSwitch` record.

In `src/api/control-api.ts` the records that concern the camera get `camera`: `camera-name` (`base` gets `camera: <the camera id>`), `camera-poe-on`, and the generic `control-action` record when the action is a camera action (`CAMERA_ACTIONS` set: `camera-test`, `onvif-resubscribe`, `camera-ftp-setup`, `camera-ftp-test`, `camera-ftp-off`, `restart`, `camera-reboot`, `camera-powercycle`, `camera-poe-on`, `poe-switch-read`, `inventory`, `inventory-repair`, `inventory-cancel`). Add `cameraId: () => string` to `ControlDeps` (the only camera; Task 15 replaces it with the routed camera) and in proxy `cameraId: () => cams.first().id`. The archive's `archive-add` record gets `camera: req.cam`; the analytics `event-analysis` record gets `camera: job.cam`; the inventory runner's records already pass `camera` (Task 7).

In `src/proxy.ts`: `new AuditLog({ dir: …, version: VERSION })` (no `camera`).

Update `test/audit-api.test.ts:26`: the `proxy-start` record has no `labels` any more — replace `labels: { camera: 'cam1' }` in that `toMatchObject` with nothing and add `expect(rec.labels).toBeUndefined();`. In every test that builds `new AuditLog({ …, camera: … })` (`grep -rln "new AuditLog" test`: at least `test/audit-log.test.ts`, `test/camera-worker.test.ts`) remove `camera`, and drop any `labels` expectation on records written without `camera`.

- [ ] **Step 4: Storage sweep over every camera folder**

In `src/storage.ts` replace `sweep`:

```ts
      // Images no row names, in every camera's folder (also a camera removed
      // from the config): analyses' in analytics/, still checks' in still-checks/.
      const sweep = (folder: string, keep: Set<string>) => {
        const base = join(cfg.server.dataDir, folder);
        for (const cam of safeDir(base)) {
          const dir = join(base, cam);
          for (const f of safeDir(dir)) {
            const path = join(dir, f);
            if (!keep.has(path)) try { unlinkSync(path); } catch { /* gone, or a folder */ }
          }
        }
      };
```

- [ ] **Step 5: Metrics per camera**

In `src/api/metrics.ts`, replace the single-camera sources with `cameras: () => CameraMetrics[]` where

```ts
export interface CameraMetrics { id: string; up: boolean; ftpEnabled: boolean | null; clips: { lastClip: number | null; stalled: boolean } | null; onvifSubscribed: boolean; stills: StillsSide | undefined }
```

Each per-camera gauge's `collect` loops: e.g.

```ts
  g('camera_up', '1 while the camera answers', ['cam'], function () {
    for (const c of s.cameras()) this.set({ cam: c.id }, c.up ? 1 : 0);
  });
```

(the same for `frame_grabber_up` with `c.stills?.grabber.up()`, `go2rtc_up`, `onvif_subscribed`, `camera_ftp_enabled` (skip `null`), `clips_last_received_timestamp_seconds` and `clips_stalled` (skip `null`)). `stills_minutes_stored` and `previews_stored` stay host totals with `cam` = the first camera until P2 splits storage per camera (keep their label set; P2 Task "storage per camera" fills it). `events_stored` loops cameras with `eventsStored(s.catalog)` filtered — keep its current per-kind total under the first camera's label (P2 splits it). The initial zero samples (`stillsTotal.inc({ cam }, 0)` …) run for every `s.cameras()` id. The hooks take the camera:

```ts
    onResubscribe: (cam: string) => resubscribes.inc({ cam }),
    onStill: (cam: string, ts: number) => (stillsTotal.inc({ cam }), lastStill.set({ cam }, ts / 1000)),
    onStillMissing: (cam: string) => stillsMissing.inc({ cam }),
    onRecordingDownload: (cam: string, o: { stream: string; result: string; priority: string }) => recordingDownloads.inc({ cam, stream: o.stream, result: o.result, priority: o.priority }),
    onCameraCheck: (cam: string, c: { ok: boolean; ms: number; error?: string }) => {
      cameraSeconds.observe({ cam, cmd: 'status' }, c.ms / 1000);
      if (!c.ok) cameraErrors.inc({ cam, code: c.error ?? 'unknown' });
    },
```

In `src/proxy.ts` build metrics after the registry is known (`cameras: () => cams.list().map((w) => ({ id: w.id, up: w.status.state().online, ftpEnabled: w.cam().ftp.enabled ? w.ftpWatch.view().enable : null, clips: w.clipsHealth(), onvifSubscribed: w.intake.state().onvif === 'subscribed', stills: w.stills }))` — the registry is created before the workers are added, so `metrics` can be created right after `new CameraRegistry(...)`), and bind the hooks per worker:

```ts
      hooks: { onCameraCheck: (c) => metrics.onCameraCheck(id, c), onResubscribe: () => metrics.onResubscribe(id), onStill: (ts) => metrics.onStill(id, ts), onStillMissing: () => metrics.onStillMissing(id), onRecordingDownload: (o) => metrics.onRecordingDownload(id, o) },
```

- [ ] **Step 6: Daily activity over every camera**

In the `DailyAudit` `activity` callback in `src/proxy.ts`, compute each camera's counts and sum them:

```ts
    activity: (day, from, to) => {
      const sum = (rs: Record<string, number>[]) => rs.reduce<Record<string, number>>((a, r) => { for (const [k, n] of Object.entries(r)) a[k] = (a[k] ?? 0) + n; return a; }, {});
      const per = cams.ids().map((cam) => ({ cam, events: countEventsByKind(catalog, cam, from, to), recovered: countRecoveredEvents(catalog, cam, from, to), clips: countClips(catalog, cam, from, to), analyses: countAnalysesByStatus(catalog, cam, from, to) }));
      const checkCounts = (d: string) => {
        const n = (p: string) => usageBetween(catalog, p, d, d);
        return { calls: n(CHECK_USAGE.calls), reused: n(CHECK_USAGE.reused), refused: n(CHECK_USAGE.refused), failed: n(CHECK_USAGE.failed) };
      };
      const vision = { day: usageBetween(catalog, 'google-vision', day, day), monthToDate: usageBetween(catalog, 'google-vision', `${day.slice(0, 7)}-01`, day), monthlyLimit: running.analytics.googleVision.monthlyLimit };
      const a = activityDaily(day, { events: sum(per.map((p) => p.events)), recovered: per.reduce((n, p) => n + p.recovered, 0), clips: per.reduce((n, p) => n + p.clips, 0), vision, analyses: sum(per.map((p) => p.analyses)), checks: checkCounts(day), sseClients: sse.clients() });
      // Several cameras: each one's counts too (one camera: the record as before).
      return per.length > 1 ? { ...a, details: { ...a.details, cameras: Object.fromEntries(per.map((p) => [p.cam, { events: p.events, recovered: p.recovered, clips: p.clips, analyses: p.analyses, vision: usageByCamera(catalog, 'google-vision', day, day)[p.cam] ?? 0 }])) } } : a;
    },
```

(import `usageByCamera`; `ActivityDaily['details']` gets an optional `cameras?: Record<string, unknown>` field.)

- [ ] **Step 7: Run the tests**

Run: `npx vitest run test/audit-camera-label.test.ts test/storage.test.ts test/metrics-multi.test.ts test/audit-api.test.ts test/audit-log.test.ts test/audit-daily.test.ts test/audit-events.test.ts test/camera-reboot.test.ts test/ftp-health.test.ts`
Expected: PASS (`Test Files  9 passed`)

- [ ] **Step 8: Whole suite, types, e2e**

Run: `npm run lint:types && npm test && npm run build && npm run test:e2e`
Expected: clean; e2e all pass (the audit page shows records as before; host records simply lack the camera label).

- [ ] **Step 9: Commit**

```bash
git add src/audit/audit-log.ts src/audit/daily.ts src/cameras/worker.ts src/camera/reboot.ts src/clips/ftp-health.ts src/api/control-api.ts src/api/metrics.ts src/storage.ts src/proxy.ts test
git commit -m "feat: audit records, metrics, storage sweep and daily activity per camera"
```

---

### Task 9: Supervision: backoff restarts, and an idle worker without an address

**Files:**
- Create: `src/cameras/backoff.ts`
- Modify: `src/cameras/worker.ts` (supervised start; `no_address`)
- Modify: `src/config/load.ts:92` (no `camera.host: required`)
- Modify: `test/config.test.ts` ("refuses to start without a camera host" → starts)
- Test: `test/backoff.test.ts` (new), `test/camera-worker.test.ts` (extend)

**Interfaces:**
- Produces:
  - `export class Backoff { constructor(o?: { firstMs?: number; maxMs?: number; healthyMs?: number }); next(): number; healthy(sinceMs: number, now: number): void; reset(): void }` — `next()` returns 5000, 10000, 20000, … capped at 300000; `healthy(since, now)` resets when `now - since >= healthyMs` (600000).
  - `WorkerDeps` gains test seams: `beforeStart?: () => void | Promise<void>` (called at the start of every start of the parts; a throw is a start failure) and `schedule?: (ms: number, fn: () => void) => () => void` (default `setTimeout`, returns a cancel).
  - Worker: with no `host`, `start()` leaves `phase()` `'idle'` and `error()` `'no_address'`, starts nothing; a start failure sets `error()` to the failure's message and schedules `restart()` after `Backoff.next()`.

- [ ] **Step 1: Write the failing tests**

Create `test/backoff.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { Backoff } from '../src/cameras/backoff';

describe('Backoff (spec §3.3)', () => {
  it('5 s doubling to 5 min', () => {
    const b = new Backoff();
    expect(Array.from({ length: 9 }, () => b.next())).toEqual([5000, 10000, 20000, 40000, 80000, 160000, 300000, 300000, 300000]);
  });
  it('reset after 10 min healthy, not before', () => {
    const b = new Backoff();
    b.next();
    b.next();
    b.healthy(0, 599_999);
    expect(b.next()).toBe(20000);
    b.healthy(0, 600_000);
    expect(b.next()).toBe(5000);
  });
});
```

Append to `test/camera-worker.test.ts` (reuse its `worker()` helper; give the helper an optional `over: Partial<WorkerDeps>` merged into the deps and an optional `host` that replaces `sim.camera.host` in the written config — `''` writes `host: ''`):

```ts
describe('supervision (spec §3.3)', () => {
  it('a camera without an address stays idle with no_address and starts nothing', async () => {
    const before = sim.sim.engine.counters.loginAttempts;
    const { w, catalog } = worker({ host: '' });
    await w.start();
    expect(w.phase()).toBe('idle');
    expect(w.error()).toBe('no_address');
    await new Promise((r) => setTimeout(r, 300));
    expect(sim.sim.engine.counters.loginAttempts).toBe(before);
    await w.stop();
    catalog.close();
  });

  it('a failed start sets the error and retries after 5 s, then 10 s; success clears it', async () => {
    let failures = 2;
    const delays: number[] = [];
    let pending: (() => void) | undefined;
    const { w, catalog } = worker({
      over: {
        beforeStart: () => {
          if (failures-- > 0) throw new Error('go2rtc_start_failed');
        },
        schedule: (ms, fn) => ((delays.push(ms), (pending = fn)), () => undefined),
      },
    });
    await w.start();
    expect(w.error()).toBe('go2rtc_start_failed');
    expect(delays).toEqual([5000]);
    pending!();
    await until(() => delays.length === 2);
    expect(delays).toEqual([5000, 10000]);
    pending!();
    await until(() => w.phase() === 'ready');
    expect(w.error()).not.toBe('go2rtc_start_failed');
    await w.stopSwitch();
    await w.stopRecordings();
    await w.stop();
    catalog.close();
  });
});
```

In `test/config.test.ts`, replace the test `refuses to start without a camera host` with:

```ts
  it('starts without a camera host: the camera waits idle (spec §3.3)', () => {
    write('config.json', {});
    expect(load().config.camera.host).toBe('');
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/backoff.test.ts test/camera-worker.test.ts test/config.test.ts`
Expected: FAIL — `Failed to resolve import "../src/cameras/backoff"`; the config test fails with `camera.host: required`.

- [ ] **Step 3: Implement**

Create `src/cameras/backoff.ts`:

```ts
// Restart delays of a camera worker (spec 2026-10-05-multi-camera-host-design
// §3.3): 5 s doubling to 5 min, back to 5 s once the camera was healthy for
// 10 minutes.
export class Backoff {
  private n = 0;
  private readonly first: number;
  private readonly max: number;
  private readonly healthyMs: number;

  constructor(o: { firstMs?: number; maxMs?: number; healthyMs?: number } = {}) {
    this.first = o.firstMs ?? 5000;
    this.max = o.maxMs ?? 300_000;
    this.healthyMs = o.healthyMs ?? 600_000;
  }

  next(): number {
    const ms = Math.min(this.max, this.first * 2 ** this.n);
    if (ms < this.max) this.n++;
    return ms;
  }

  healthy(sinceMs: number, now: number): void {
    if (now - sinceMs >= this.healthyMs) this.reset();
  }

  reset(): void {
    this.n = 0;
  }
}
```

In `src/cameras/worker.ts`:

```ts
import { Backoff } from './backoff';
```

Add to `WorkerDeps`:

```ts
  // Test seams: a throw from beforeStart is a start failure; schedule replaces setTimeout.
  beforeStart?: () => void | Promise<void>;
  schedule?: (ms: number, fn: () => void) => () => void;
```

Add fields and replace `startParts`, `start`, `restart`:

```ts
  private readonly backoff = new Backoff();
  private cancelRetry: (() => void) | undefined;
  private onlineSince: number | null = null;

  private schedule(ms: number, fn: () => void): () => void {
    if (this.d.schedule) return this.d.schedule(ms, fn);
    const t = setTimeout(fn, ms);
    t.unref();
    return () => clearTimeout(t);
  }

  // Starts the parts; a failure is this camera's error and a later retry,
  // never the process's (spec §3.3). Answers whether the parts run.
  private async startParts(): Promise<boolean> {
    if (!this.cam().host) {
      this.errorNow = 'no_address';
      this.phaseNow = 'idle';
      return false;
    }
    try {
      await this.d.beforeStart?.();
      this.status.start();
      this.intake.start();
      this.startStills();
      this.errorNow = null;
      return true;
    } catch (err) {
      this.errorNow = (err as Error).message;
      const ms = this.backoff.next();
      logger.warn({ cameraId: this.id, err: this.errorNow, retryMs: ms }, 'camera_side_start_failed');
      this.cancelRetry = this.schedule(ms, () => void this.restart().catch((e: Error) => logger.error({ cameraId: this.id, err: e.message }, 'camera_side_restart_failed')));
      return false;
    }
  }

  async start(): Promise<void> {
    this.phaseNow = 'starting';
    const running = await this.startParts();
    if (!this.watchStarted) {
      this.ftpWatch.start();
      this.watchStarted = true;
    }
    if (running) this.phaseNow = 'ready';
    else if (this.errorNow !== 'no_address') this.phaseNow = 'ready'; // serving stored data; the retry is scheduled
  }
```

and in `restart()` replace `await this.startParts(); this.phaseNow = 'ready';` with

```ts
        this.cancelRetry?.();
        const running = await this.startParts();
        this.phaseNow = running || this.errorNow !== 'no_address' ? 'ready' : 'idle';
```

`stopParts()` must tolerate parts that never started: `intake.stop()`, `status.stop()` and `client.logout()` already do (they are idempotent); keep them. `stop()` also calls `this.cancelRetry?.()` first.

The healthy reset: in `build()`'s `status.on('change', …)` handler add

```ts
      this.onlineSince = s.online ? (this.onlineSince ?? Date.now()) : null;
      if (this.onlineSince !== null) this.backoff.healthy(this.onlineSince, Date.now());
```

and `error()` stays `this.errorNow ?? this.status.state().error ?? null` (a refused login shows as the check's error without a restart: the poller keeps trying on its own).

In `src/config/load.ts` delete `if (!c.camera.host) throw new ConfigError('camera.host: required');` from `crossCheck`, and change the `camera.host` leaf's `unset` text in `src/config/schema.ts` to `'no camera address: the camera waits idle (Find camera can still be used)'`.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/backoff.test.ts test/camera-worker.test.ts test/config.test.ts`
Expected: PASS (`Test Files  3 passed`)

- [ ] **Step 5: Whole suite and types**

Run: `npm run lint:types && npm test`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/cameras/backoff.ts src/cameras/worker.ts src/config/load.ts src/config/schema.ts test/backoff.test.ts test/camera-worker.test.ts test/config.test.ts
git commit -m "feat(cameras): supervised camera workers; no address leaves the camera idle"
```

---

### Task 10: The settings tree learns a keyed collection

Walkers only; `SETTINGS` keeps its shape until Task 11 switches it.

**Files:**
- Modify: `src/config/schema.ts`
- Test: `test/config-schema-collection.test.ts` (new)

**Interfaces:**
- Produces (`src/config/schema.ts`):

```ts
export type Collection = { collection: Node; doc: string };
export type Node = { [key: string]: Node | Leaf | Collection };
export const CAMERA_ID = '^[a-z0-9][a-z0-9-]{0,31}$';
export function collection(of: Node, doc: string): Collection;
export function checkPartial(obj: unknown, node?: Node, prefix?: string): void;      // collections: an object keyed by id
export function leafPaths(node?: Node, prefix?: string, ids?: string[]): string[];   // a collection expands to each id
export function leafAt(path: string, node?: Node): Leaf | undefined;                 // a collection consumes one id segment
export function jsonSchema(node?: Node, extra?: Record<string, object>): object;    // a collection is an array of its node, id required
export const CAMERA_NODE: Node;      // one camera of `cameras` (spec §4.1)
export const LEGACY_CAMERA: Node;    // today's `camera` node, verbatim (for legacy files)
export const HOST_POE_SWITCH: Node;  // host-wide `poeSwitch` (model, host, ports, offSeconds)
export function checkValue(path: string, leaf: Leaf, v: unknown): void;            // checkLeaf, exported
export const LEGACY_FTP_USER: Leaf;  // today's top-level ftp.user leaf
```

- [ ] **Step 1: Write the failing test**

Create `test/config-schema-collection.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { CAMERA_ID, CAMERA_NODE, checkPartial, collection, jsonSchema, leafAt, leafPaths, LEGACY_CAMERA, SettingError, type Node } from '../src/config/schema';

const TREE: Node = {
  sse: { pingS: { type: 'integer', min: 1, max: 300, doc: 'ping' } },
  cams: collection({ id: { type: 'string', pattern: CAMERA_ID, doc: 'id' }, n: { type: 'integer', min: 1, max: 9, doc: 'n' } }, 'the cameras'),
};
const msg = (f: () => void) => {
  try {
    f();
  } catch (e) {
    expect(e).toBeInstanceOf(SettingError);
    return (e as Error).message;
  }
  throw new Error('expected a SettingError');
};

describe('keyed collection (spec §4.1)', () => {
  it('checks each entry under its id', () => {
    checkPartial({ cams: { cam3: { n: 2 }, cam4: { id: 'cam4' } } }, TREE);
    expect(msg(() => checkPartial({ cams: { cam3: { n: 0 } } }, TREE))).toBe('cams.cam3.n: must be from 1 to 9');
    expect(msg(() => checkPartial({ cams: { Cam3: {} } }, TREE))).toBe('cams.Cam3: not a camera id');
    expect(msg(() => checkPartial({ cams: { cam3: { id: 'cam4' } } }, TREE))).toBe("cams.cam3.id: must be the camera's key (cam3)");
    expect(msg(() => checkPartial({ cams: [] }, TREE))).toBe('cams: must be an object');
    expect(msg(() => checkPartial({ cams: { cam3: { zz: 1 } } }, TREE))).toBe('cams.cam3.zz: unknown setting');
  });
  it('leaf paths expand to the given ids, in that order', () => {
    expect(leafPaths(TREE, '', ['b', 'a'])).toEqual(['sse.pingS', 'cams.b.id', 'cams.b.n', 'cams.a.id', 'cams.a.n']);
    expect(leafPaths(TREE)).toEqual(['sse.pingS']);
  });
  it('leafAt skips the id segment', () => {
    expect(leafAt('cams.cam9.n', TREE)).toMatchObject({ type: 'integer', max: 9 });
    expect(leafAt('cams.n', TREE)).toBeUndefined();
  });
  it('the JSON schema: an array of the node, id required', () => {
    const js = jsonSchema(TREE) as { properties: Record<string, { type: string; items: { required: string[]; properties: object } }> };
    expect(js.properties.cams.type).toBe('array');
    expect(js.properties.cams.items.required).toEqual(['id']);
    expect(Object.keys(js.properties.cams.items.properties)).toEqual(['id', 'n']);
  });
  it('the camera node has the per-camera keys and the closed list of host overrides', () => {
    expect(leafPaths(CAMERA_NODE)).toEqual([
      'id', 'name', 'host', 'protocol', 'tlsName', 'webUiUrl', 'user', 'onvifPort', 'rtspPort', 'baichuanPort', 'statusPollS',
      'poeSwitch.port', 'ftp.user', 'ftp.enabled', 'ftp.stream', 'stills.enabled', 'stills.stream', 'stills.intervalS',
      'analytics.kinds.person', 'analytics.kinds.vehicle', 'analytics.kinds.pet', 'events.poll.enabled',
    ]);
    expect(leafPaths(LEGACY_CAMERA)).toContain('poeSwitch.model');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/config-schema-collection.test.ts`
Expected: FAIL with `collection is not a function` (or missing exports).

- [ ] **Step 3: Implement**

In `src/config/schema.ts`:

1. Types and helpers:

```ts
export type Collection = { collection: Node; doc: string };
export type Node = { [key: string]: Node | Leaf | Collection };
export const CAMERA_ID = '^[a-z0-9][a-z0-9-]{0,31}$';
export const collection = (of: Node, doc: string): Collection => ({ collection: of, doc });
const isCollection = (n: Node | Leaf | Collection): n is Collection => typeof (n as Collection).collection === 'object' && typeof (n as Collection).doc === 'string';
const isLeaf = (n: Node | Leaf | Collection): n is Leaf => !isCollection(n) && typeof (n as Leaf).type === 'string' && typeof (n as Leaf).doc === 'string';
```

2. Move today's `camera: { … }` object out of `SETTINGS` into `export const LEGACY_CAMERA: Node = { … }` **verbatim**, and put it back into `SETTINGS` as `camera: LEGACY_CAMERA` (no change in behaviour yet). Do the same for `ftp.user`: `export const LEGACY_FTP_USER: Leaf = { type: 'string', pattern: '^[^\\s:]{1,31}$', doc: 'FTP user the camera logs in as' };` and `user: LEGACY_FTP_USER` inside `SETTINGS.ftp`.

3. The new nodes (used by Task 11):

```ts
const hostValue = (path: string) => `the host value, ${path}`;
export const CAMERA_NODE: Node = {
  id: { type: 'string', pattern: CAMERA_ID, doc: 'camera id used in paths and the API' },
  name: { type: 'string', pattern: '^.{1,64}$', doc: "fallback display name until the camera's own name is read (default: the id)" },
  host: unset({ type: 'string', pattern: '^[^\\s/]*$', doc: 'address or name, optional :port' }, 'no camera address: the camera waits idle (Find camera can still be used)', ''),
  protocol: { type: 'string', enum: ['https', 'http'], doc: 'camera HTTP API protocol' },
  tlsName: unset({ type: 'string', pattern: '^[^\\s]+$', optional: true, doc: 'verify the camera certificate against this name' }, "the camera's certificate is not verified"),
  webUiUrl: unset({ type: 'string', pattern: '^(https?://[^\\s]+|none)$', optional: true, doc: "the camera's own web page, linked from the admin UI; default https://<host>/, none for no link" }, 'the link goes to https://<host>/'),
  user: { type: 'string', pattern: '^[^\\s:]{1,31}$', doc: "the proxy's own camera user" },
  onvifPort: port('camera ONVIF port'),
  rtspPort: port('camera RTSP port'),
  baichuanPort: port("camera Baichuan port (recordings over TCP); the host is the camera's host"),
  statusPollS: int(5, 3600, 'seconds between status checks'),
  poeSwitch: {
    port: unset(int(1, 48, "the port of the host's PoE switch this camera is on, as numbered on the switch", true), 'PoE switch control off for this camera: no port'),
  },
  ftp: {
    user: unset({ type: 'string', pattern: '^[^\\s:]{1,31}$', optional: true, doc: 'FTP user this camera logs in as' }, 'the camera id'),
    enabled: unset({ type: 'boolean', doc: 'accept clip uploads from this camera' }, hostValue('ftp.enabled')),
    stream: unset({ type: 'string', enum: ['main', 'sub'], optional: true, doc: 'the stream this camera uploads' }, hostValue('ftp.stream')),
  },
  stills: {
    enabled: unset({ type: 'boolean', doc: 'store stills of this camera' }, hostValue('stills.enabled')),
    stream: unset({ type: 'string', enum: ['sub', 'main'], optional: true, doc: 'camera stream the stills come from' }, hostValue('stills.stream')),
    intervalS: unset({ type: 'integer', min: 1, max: 60, optional: true, oneOf: [1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30, 60], doc: 'seconds between stills (divides a minute)' }, hostValue('stills.intervalS')),
  },
  analytics: {
    kinds: {
      person: unset({ type: 'boolean', doc: "analyse this camera's person events" }, hostValue('analytics.kinds.person')),
      vehicle: unset({ type: 'boolean', doc: "analyse this camera's vehicle events" }, hostValue('analytics.kinds.vehicle')),
      pet: unset({ type: 'boolean', doc: "analyse this camera's pet events" }, hostValue('analytics.kinds.pet')),
    },
  },
  events: {
    poll: {
      enabled: unset({ type: 'boolean', doc: 'poll GetMdState/GetAiState while ONVIF is down' }, hostValue('events.poll.enabled')),
    },
  },
};
export const HOST_POE_SWITCH: Node = {
  model: unset({ type: 'string', enum: ['none', 'sscpoe-web'], doc: "the cameras' PoE switch: none, or sscpoe-web (the STEAMEMO/SSCPOE local web protocol: GPS-208 and kin)" }, 'no PoE switch: power-cycle off', 'none'),
  host: unset({ type: 'string', pattern: '^[A-Za-z0-9.-]{1,253}(:[0-9]{1,5})?$', optional: true, doc: "the switch's address or name, optional :port (http)" }, 'PoE switch control off: no switch address'),
  ports: int(1, 48, "the switch's PoE port count (maps a port to its internal index)"),
  offSeconds: int(5, 60, 'seconds the PoE stays off in a power-cycle'),
};
```

4. `checkLeaf` is exported as `checkValue` (keep `checkLeaf` as the internal name or rename all uses).

5. Walkers:

```ts
export function checkPartial(obj: unknown, node: Node = SETTINGS, prefix = ''): void {
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) throw new SettingError(`${prefix || 'config'}: must be an object`);
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (!Object.hasOwn(node, k)) throw new SettingError(`${path}: unknown setting`);
    const child = node[k];
    if (isLeaf(child)) checkValue(path, child, v);
    else if (isCollection(child)) {
      if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SettingError(`${path}: must be an object`);
      for (const [id, entry] of Object.entries(v)) {
        if (!new RegExp(CAMERA_ID).test(id)) throw new SettingError(`${path}.${id}: not a camera id`);
        checkPartial(entry, child.collection, `${path}.${id}`);
        const own = (entry as Record<string, unknown>).id;
        if (own !== undefined && own !== id) throw new SettingError(`${path}.${id}.id: must be the camera's key (${id})`);
      }
    } else checkPartial(v, child, path);
  }
}

export function leafPaths(node: Node = SETTINGS, prefix = '', ids: string[] = []): string[] {
  return Object.entries(node).flatMap(([k, v]) => {
    const path = prefix ? `${prefix}.${k}` : k;
    if (isLeaf(v)) return [path];
    if (isCollection(v)) return ids.flatMap((id) => leafPaths(v.collection, `${path}.${id}`));
    return leafPaths(v, path, ids);
  });
}

export function leafAt(path: string, node: Node = SETTINGS): Leaf | undefined {
  let n: Node | Leaf | Collection | undefined = node;
  const keys = path.split('.');
  for (let i = 0; i < keys.length && n; i++) {
    if (isLeaf(n)) return undefined;
    if (isCollection(n)) {
      n = n.collection; // keys[i] is the id
      continue;
    }
    n = Object.hasOwn(n, keys[i]) ? n[keys[i]] : undefined;
  }
  return n && isLeaf(n) ? n : undefined;
}
```

(`leafAt('cams.n')`: after `cams` the walker is at the collection; `n` is consumed as the id and the path ends on a node, not a leaf → `undefined`, as the test wants.)

```ts
export function jsonSchema(node: Node = SETTINGS, extra: Record<string, object> = {}): object {
  const leaf = (v: Leaf) =>
    v.type === 'boolean' ? { type: 'boolean', description: v.doc }
    : v.type === 'integer' ? { type: 'integer', minimum: v.min, maximum: v.max, ...(v.oneOf ? { enum: v.oneOf } : {}), description: v.doc }
    : { type: 'string', ...(v.enum ? { enum: v.enum } : {}), ...(v.pattern ? { pattern: v.pattern } : {}), description: v.doc };
  const conv = (n: Node): object => ({
    type: 'object',
    additionalProperties: false,
    properties: Object.fromEntries(Object.entries(n).map(([k, v]) => [k, isLeaf(v) ? leaf(v) : isCollection(v) ? { type: 'array', description: v.doc, items: { ...conv(v.collection), required: ['id'] } } : conv(v)])),
  });
  const root = conv(node) as { properties: Record<string, object> };
  return { $schema: 'https://json-schema.org/draft/2020-12/schema', title: 'cam-proxy config.json', ...root, properties: { ...root.properties, ...extra } };
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/config-schema-collection.test.ts test/config.test.ts`
Expected: PASS (`Test Files  2 passed`) — `config.test.ts` unchanged: `SETTINGS` still has `camera`.

- [ ] **Step 5: Schema file unchanged**

Run: `npm run schema && git diff --stat config.schema.json`
Expected: no diff for `config.schema.json`.

- [ ] **Step 6: Commit**

```bash
git add src/config/schema.ts test/config-schema-collection.test.ts
git commit -m "feat(config): keyed collection node; camera and host switch nodes"
```

---

### Task 11: The config switches to `cameras`; the legacy `camera` is translated at load

**Files:**
- Create: `src/config/legacy.ts`
- Modify: `src/config/schema.ts` (`SETTINGS`: `cameras`, host `poeSwitch`; no `camera`, no `ftp.user`)
- Modify: `src/config/defaults.ts` (`Config`, `DEFAULTS`, `cameraDefaults`)
- Modify: `src/config/cameras.ts` (over the new shape)
- Modify: `src/config/load.ts` (translation, order, env, cross checks, restart rules, `legacyCamera`)
- Modify: `src/api/control-api.ts` (`configView` paths and `legacy`; find-camera/camera-address on several cameras)
- Modify: `src/camera/poe-switch.ts:223-231` (messages name the new paths)
- Modify: `web/src/lib/maintenance.ts:76-78`, `web/src/components/PoeSwitchCard.svelte:8,31`, `web/src/pages/Settings.svelte:126` (new paths; "config.json (legacy camera)")
- Modify: `scripts/gen-schema.ts` → `config.schema.json` (regenerated)
- Modify: tests that read `config.camera`, settings view keys or the old messages: `test/config.test.ts`, `test/config-env.test.ts`, `test/control-api.test.ts`, `test/audit-events.test.ts`, `test/settings-ui.test.ts`, `test/camera-powercycle.test.ts`, `test/recordings-api.test.ts:374`, `test/recordings-side.test.ts:94`, `test/archive-api.test.ts:21`, `test/compose-api.test.ts:34,55`, `e2e/admin.spec.ts:185-229`, `e2e/find-camera.spec.ts:45`, `test/helpers/proxy.ts` (unchanged: it writes a legacy `camera` — that is the Pi gate)
- Test: `test/config-legacy.test.ts` (new)

**Interfaces:**
- Consumes: `CAMERA_NODE`, `LEGACY_CAMERA`, `HOST_POE_SWITCH`, `LEGACY_FTP_USER`, `collection`, `checkValue` (Task 10).
- Produces:
  - `Config`: no `camera`; `ftp` without `user`; `cameras: Record<string, CameraNode>`; `cameraOrder: string[]`; `poeSwitch: HostPoeSwitch`.
  - `export interface CameraNode` and `export function cameraDefaults(id: string): CameraNode` in `src/config/defaults.ts`.
  - `src/config/legacy.ts`: `normalizeFile(file: unknown): { settings: Record<string, unknown>; order: string[]; legacy: boolean }`, `normalizeOverrides(over: unknown, ids: string[]): Record<string, unknown>`, `translatePath(path: string, ids: string[]): string`.
  - `Loaded.legacyCamera: boolean`, `Loaded.order: string[]`.
  - `export function settingPaths(c: Config): string[]` in `src/config/load.ts` (= `leafPaths(SETTINGS, '', c.cameraOrder)`).
  - `GET /control/config` rows: `legacy?: true` on file values that came from a legacy `camera`.

- [ ] **Step 1: Write the failing tests**

Create `test/config-legacy.test.ts`:

```ts
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { beforeEach, describe, expect, it } from 'vitest';
import { applyOverrides, ConfigError, loadConfig, removeOverride } from '../src/config/load';
import { cameraConfig, cameraIds } from '../src/config/cameras';

const SECRETS = { CAMPROXY_TOKENS: 'a'.repeat(32), CAMPROXY_ADMIN_TOKEN: 'c'.repeat(32), CAMPROXY_CAMERA_PASSWORD: 'cam-pw' };
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'camproxy-legacy-'));
});
const write = (name: string, v: unknown) => {
  mkdirSync(join(dir, name, '..'), { recursive: true });
  writeFileSync(join(dir, name), JSON.stringify(v));
};
const load = (env: Record<string, string> = {}) => loadConfig({ ...SECRETS, ...env }, { cwd: dir });
const err = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    expect(e).toBeInstanceOf(ConfigError);
    return (e as Error).message;
  }
  throw new Error('expected a ConfigError');
};

// The Pi's files as they are (spec §4.2, §11).
const PI_FILE = { camera: { id: 'cam1', host: '192.168.1.103', protocol: 'https', tlsName: 'cam1.skylar.technology', statusPollS: 30, poeSwitch: { model: 'sscpoe-web', host: '192.168.1.217', port: 8, ports: 8, offSeconds: 10 } }, ftp: { enabled: true, user: 'camera', publicHost: '192.168.1.220' } };

describe('legacy camera (spec §4.2)', () => {
  it('reads camera as a list of one; switch keys go to the host; ftp.user to the camera', () => {
    write('config.json', PI_FILE);
    const l = load({ CAMPROXY_FTP_PASSWORD: 'f' });
    expect(cameraIds(l.config)).toEqual(['cam1']);
    const c = cameraConfig(l.config, 'cam1')!;
    expect(c).toMatchObject({ id: 'cam1', name: 'Den', host: '192.168.1.103', tlsName: 'cam1.skylar.technology' });
    expect(c.poeSwitch).toEqual({ model: 'sscpoe-web', host: '192.168.1.217', port: 8, ports: 8, offSeconds: 10 });
    expect(c.ftp).toEqual({ user: 'camera', enabled: true, stream: 'main' });
    expect(l.config.poeSwitch).toEqual({ model: 'sscpoe-web', host: '192.168.1.217', ports: 8, offSeconds: 10 });
    expect(l.legacyCamera).toBe(true);
    expect(l.sources['cameras.cam1.host']).toBe('file');
    expect(l.sources['poeSwitch.host']).toBe('file');
  });

  it("a legacy camera without ftp.user keeps today's default user 'camera' (Ruling P1-11)", () => {
    write('config.json', { camera: { host: 'h' } });
    expect(cameraConfig(load().config, 'cam1')!.ftp.user).toBe('camera');
  });

  it('legacy overrides survive a save: read translated, written back in the new form', () => {
    write('config.json', { camera: { host: 'h' } });
    write('data/overrides.json', { camera: { statusPollS: 60, poeSwitch: { host: '192.0.2.9', port: 3 } }, ftp: { user: 'cam' } });
    const l = load();
    expect(cameraConfig(l.config, 'cam1')).toMatchObject({ statusPollS: 60, poeSwitch: { host: '192.0.2.9', port: 3 }, ftp: { user: 'cam' } });
    applyOverrides(l, { sse: { pingS: 20 } });
    expect(JSON.parse(readFileSync(join(dir, 'data', 'overrides.json'), 'utf8'))).toEqual({
      cameras: { cam1: { statusPollS: 60, poeSwitch: { port: 3 }, ftp: { user: 'cam' } } },
      poeSwitch: { host: '192.0.2.9' },
      sse: { pingS: 20 },
    });
  });

  it('a legacy override path is accepted by the API on one camera (Ruling P1-8)', () => {
    write('config.json', { camera: { host: 'h' } });
    const l = applyOverrides(load(), { camera: { statusPollS: 45 } });
    expect(cameraConfig(l.config, 'cam1')!.statusPollS).toBe(45);
    expect(cameraConfig(removeOverride(l, 'camera.statusPollS').config, 'cam1')!.statusPollS).toBe(30);
  });

  it('no camera and no cameras: one default camera cam1, idle (Ruling P1-10)', () => {
    write('config.json', {});
    const l = load();
    expect(cameraIds(l.config)).toEqual(['cam1']);
    expect(cameraConfig(l.config, 'cam1')).toMatchObject({ name: 'Den', host: '' });
  });
});

describe('cameras (spec §4.1)', () => {
  const two = { cameras: [{ id: 'cam3', host: '192.168.60.13' }, { id: 'cam4', host: '192.168.60.14', stills: { intervalS: 2 }, poeSwitch: { port: 2 } }], poeSwitch: { model: 'sscpoe-web', host: '192.168.60.2' } };

  it('the array in config order; defaults per camera; host overrides resolved', () => {
    write('config.json', two);
    const l = load();
    expect(cameraIds(l.config)).toEqual(['cam3', 'cam4']);
    expect(cameraConfig(l.config, 'cam3')).toMatchObject({ name: 'cam3', user: 'proxy', ftp: { user: 'cam3' }, stills: { intervalS: 1 } });
    expect(cameraConfig(l.config, 'cam4')).toMatchObject({ stills: { intervalS: 2 }, poeSwitch: { model: 'sscpoe-web', host: '192.168.60.2', port: 2 } });
    expect(l.legacyCamera).toBe(false);
    expect(l.sources['cameras.cam4.stills.intervalS']).toBe('file');
    expect(l.sources['cameras.cam3.stills.intervalS']).toBe('default');
  });

  it('integer-like ids keep config order', () => {
    write('config.json', { cameras: [{ id: '2', host: 'a' }, { id: '10', host: 'b' }, { id: '1', host: 'c' }] });
    expect(cameraIds(load().config)).toEqual(['2', '10', '1']);
  });

  it('refuses camera with cameras, duplicate ids, an empty list, a bad id', () => {
    write('config.json', { camera: { host: 'h' }, cameras: [{ id: 'cam3' }] });
    expect(err(() => load())).toBe('camera: use either camera (one camera) or cameras, not both');
    write('config.json', { cameras: [{ id: 'cam3' }, { id: 'cam3' }] });
    expect(err(() => load())).toBe('cameras: duplicate id cam3');
    write('config.json', { cameras: [] });
    expect(err(() => load())).toBe('cameras: at least one camera');
    write('config.json', { cameras: [{ id: 'Cam3' }] });
    expect(err(() => load())).toBe('cameras.Cam3: not a camera id');
    write('config.json', { cameras: [{ host: 'x' }] });
    expect(err(() => load())).toBe('cameras[0].id: required');
  });

  it('a legacy camera.* override with several cameras is a load error naming the path', () => {
    write('config.json', two);
    write('data/overrides.json', { camera: { statusPollS: 60 } });
    expect(err(() => load())).toBe("camera.statusPollS: a legacy camera override can't be assigned with several cameras; use cameras.<id>.statusPollS");
  });

  it('an override for a camera config.json does not define is refused (Ruling P1-13)', () => {
    write('config.json', two);
    write('data/overrides.json', { cameras: { cam9: { host: 'x' } } });
    expect(err(() => load())).toBe('cameras.cam9: unknown camera (cameras are added in config.json)');
  });

  it('CAMERA_HOST with several cameras is a load error', () => {
    write('config.json', two);
    expect(err(() => load({ CAMERA_HOST: '10.0.0.1' }))).toBe('CAMERA_HOST: set cameras[].host instead (several cameras)');
  });

  it('FTP on for two cameras is refused until P2 (Ruling P1-2)', () => {
    write('config.json', { ...two, ftp: { enabled: true } });
    expect(err(() => load({ CAMPROXY_FTP_PASSWORD: 'f' }))).toBe('ftp.enabled: several cameras need per-camera FTP users (multi-camera phase 2); enable it for one camera');
    write('config.json', { ...two, ftp: { enabled: false }, cameras: [{ id: 'cam3', ftp: { enabled: true } }, { id: 'cam4' }] });
    expect(cameraConfig(load({ CAMPROXY_FTP_PASSWORD: 'f' }).config, 'cam3')!.ftp.enabled).toBe(true);
  });

  it('per-camera restart and live rules', async () => {
    const { needsRestart } = await import('../src/config/load');
    expect(needsRestart('cameras.cam3.host')).toBe(true);
    expect(needsRestart('cameras.cam3.poeSwitch.port')).toBe(false);
    expect(needsRestart('cameras.cam3.baichuanPort')).toBe(false);
    expect(needsRestart('cameras.cam3.analytics.kinds.person')).toBe(false);
    expect(needsRestart('poeSwitch.host')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/config-legacy.test.ts`
Expected: FAIL with `Failed to resolve import`-free errors such as `l.legacyCamera` undefined / `cameras: unknown setting`.

- [ ] **Step 3: `SETTINGS`, `Config`, defaults**

In `src/config/schema.ts`'s `SETTINGS`: remove `camera: LEGACY_CAMERA`; remove `user` from `ftp`; add after `server`:

```ts
  cameras: collection(CAMERA_NODE, 'the cameras of this proxy, in display order (config.json: a list; overrides: by id)'),
  poeSwitch: HOST_POE_SWITCH,
```

`scripts/gen-schema.ts` writes `jsonSchema(SETTINGS, { camera: { ...jsonSchemaOf(LEGACY_CAMERA), description: 'legacy: one camera (read as cameras: [camera]); use cameras' } })` — add an exported `jsonSchemaOf(node: Node): object` (the `conv` of Task 10, exported) to `schema.ts` for this.

In `src/config/defaults.ts`:

```ts
import type { HostPoeSwitch } from './cameras';

// One camera of `cameras` (spec 2026-10-05-multi-camera-host-design §4.1).
// The optional groups override a host default; absent = the host value.
export interface CameraNode {
  id: string; name: string; host: string; protocol: 'https' | 'http'; tlsName?: string; webUiUrl?: string;
  user: string; onvifPort: number; rtspPort: number; baichuanPort: number; statusPollS: number;
  poeSwitch: { port?: number };
  ftp: { user?: string; enabled?: boolean; stream?: 'main' | 'sub' };
  stills: { enabled?: boolean; stream?: 'sub' | 'main'; intervalS?: number };
  analytics: { kinds: { person?: boolean; vehicle?: boolean; pet?: boolean } };
  events: { poll: { enabled?: boolean } };
}

// A new camera's defaults: its name is its id (Ruling P1-11).
export function cameraDefaults(id: string): CameraNode {
  return { id, name: id, host: '', protocol: 'https', user: 'proxy', onvifPort: 8000, rtspPort: 554, baichuanPort: 9000, statusPollS: 30, poeSwitch: {}, ftp: {}, stills: {}, analytics: { kinds: {} }, events: { poll: {} } };
}
```

In `Config`: delete `camera`; `ftp` loses `user`; add `cameras: Record<string, CameraNode>; cameraOrder: string[]; poeSwitch: HostPoeSwitch;`. In `DEFAULTS`: delete `camera`; delete `user: 'camera'` from `ftp`; add `cameras: {}, cameraOrder: [], poeSwitch: { model: 'none', ports: 8, offSeconds: 10 },`.

- [ ] **Step 4: `src/config/legacy.ts`**

```ts
import { ConfigError } from './load-error';
import { checkPartial, checkValue, LEGACY_CAMERA, LEGACY_FTP_USER, SettingError } from './schema';

// Today's one-camera files read as several-camera ones (spec
// 2026-10-05-multi-camera-host-design §4.2). Nothing is written here: the
// translation happens at every load; overrides are written back in the new
// form on the next save.
type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const SWITCH_HOST_KEYS = ['model', 'host', 'ports', 'offSeconds'];

const settingError = <T>(f: () => T): T => {
  try {
    return f();
  } catch (e) {
    if (e instanceof SettingError) throw new ConfigError(e.message);
    throw e;
  }
};

// A legacy camera object → [id, the camera node, the host switch keys].
function fromLegacyCamera(cam: Obj, ftpUser: unknown): [string, Obj, Obj] {
  const { poeSwitch, ...rest } = cam;
  const sw = isObj(poeSwitch) ? poeSwitch : {};
  const host: Obj = {};
  for (const k of SWITCH_HOST_KEYS) if (sw[k] !== undefined) host[k] = sw[k];
  const id = typeof rest.id === 'string' ? rest.id : 'cam1';
  // Today's defaults for the one camera (Ruling P1-11): the Pi keeps them.
  const node: Obj = { ...rest, id, name: rest.name ?? 'Den', ftp: { user: ftpUser ?? 'camera' } };
  if (sw.port !== undefined) node.poeSwitch = { port: sw.port };
  return [id, node, host];
}

export function normalizeFile(file: unknown): { settings: Obj; order: string[]; legacy: boolean } {
  if (!isObj(file)) return { settings: file as Obj, order: [], legacy: false };
  const { camera, cameras, ...rest } = file;
  if (camera !== undefined && cameras !== undefined) throw new ConfigError('camera: use either camera (one camera) or cameras, not both');
  const ftp = isObj(rest.ftp) ? { ...rest.ftp } : undefined;
  const ftpUser = ftp?.user;
  if (ftp) delete ftp.user;
  const settings: Obj = { ...rest, ...(ftp ? { ftp } : {}) };
  if (cameras === undefined) {
    // Legacy: `camera`, or nothing at all (one default camera, Ruling P1-10).
    if (camera !== undefined) settingError(() => checkPartial(camera, LEGACY_CAMERA, 'camera'));
    if (ftpUser !== undefined) settingError(() => checkValue('ftp.user', LEGACY_FTP_USER, ftpUser));
    const [id, node, host] = fromLegacyCamera(isObj(camera) ? camera : {}, ftpUser);
    settings.cameras = { [id]: node };
    if (Object.keys(host).length) settings.poeSwitch = { ...(isObj(settings.poeSwitch) ? settings.poeSwitch : {}), ...host };
    return { settings, order: [id], legacy: true };
  }
  if (ftpUser !== undefined) throw new ConfigError('ftp.user: set cameras[].ftp.user instead');
  if (!Array.isArray(cameras)) throw new ConfigError('cameras: must be a list of cameras');
  if (!cameras.length) throw new ConfigError('cameras: at least one camera');
  const map: Obj = {};
  const order: string[] = [];
  cameras.forEach((c, i) => {
    if (!isObj(c)) throw new ConfigError(`cameras[${i}]: must be an object`);
    if (typeof c.id !== 'string') throw new ConfigError(`cameras[${i}].id: required`);
    if (Object.hasOwn(map, c.id)) throw new ConfigError(`cameras: duplicate id ${c.id}`);
    map[c.id] = c;
    order.push(c.id);
  });
  settings.cameras = map;
  return { settings, order, legacy: false };
}

// One legacy path → the new one (Ruling P1-8): camera.poeSwitch.{model,host,
// ports,offSeconds} → poeSwitch.*, camera.X → cameras.<id>.X, ftp.user →
// cameras.<id>.ftp.user. Other paths stay. Several cameras: an error.
export function translatePath(path: string, ids: string[]): string {
  const legacy = path === 'ftp.user' || path.startsWith('camera.');
  if (!legacy) return path;
  if (ids.length !== 1) {
    const rest = path === 'ftp.user' ? 'ftp.user' : path.slice('camera.'.length);
    throw new ConfigError(`${path}: a legacy camera override can't be assigned with several cameras; use cameras.<id>.${rest}`);
  }
  const id = ids[0];
  if (path === 'ftp.user') return `cameras.${id}.ftp.user`;
  const m = /^camera\.poeSwitch\.(model|host|ports|offSeconds)$/.exec(path);
  if (m) return `poeSwitch.${m[1]}`;
  return `cameras.${id}.${path.slice('camera.'.length)}`;
}

const setIn = (o: Obj, path: string, v: unknown) => {
  const keys = path.split('.');
  let x = o;
  for (const k of keys.slice(0, -1)) x = (isObj(x[k]) ? x[k] : (x[k] = {})) as Obj;
  x[keys[keys.length - 1]] = v;
};

// overrides.json (or a PUT body) in the new form; camera ids must be
// configured ones (Ruling P1-13).
export function normalizeOverrides(over: unknown, ids: string[]): Obj {
  if (!isObj(over)) return over as Obj;
  const { camera, ...rest } = over;
  const out: Obj = structuredClone(rest);
  const ftp = isObj(out.ftp) ? (out.ftp as Obj) : undefined;
  const legacy: [string, unknown][] = [];
  if (ftp && ftp.user !== undefined) {
    legacy.push(['ftp.user', ftp.user]);
    delete ftp.user;
    if (!Object.keys(ftp).length) delete out.ftp;
  }
  if (camera !== undefined) {
    if (!isObj(camera)) throw new ConfigError('camera: must be an object');
    settingError(() => checkPartial(camera, LEGACY_CAMERA, 'camera'));
    const flat = (o: Obj, prefix: string): [string, unknown][] => Object.entries(o).flatMap(([k, v]) => (isObj(v) ? flat(v, `${prefix}.${k}`) : [[`${prefix}.${k}`, v] as [string, unknown]]));
    legacy.push(...flat(camera, 'camera'));
  }
  for (const [p, v] of legacy) setIn(out, translatePath(p, ids), v);
  if (isObj(out.cameras)) {
    for (const id of Object.keys(out.cameras)) if (!ids.includes(id)) throw new ConfigError(`cameras.${id}: unknown camera (cameras are added in config.json)`);
  }
  return out;
}
```

`ConfigError` lives in `load.ts` today; move it to a new tiny module `src/config/load-error.ts` (`export class ConfigError extends Error {}`) and re-export it from `load.ts` (`export { ConfigError } from './load-error';`) so `legacy.ts` and `load.ts` don't import each other.

- [ ] **Step 5: `src/config/load.ts`**

1. Restart rules:

```ts
const RESTART = ['server.port', 'server.dataDir', 'cameras.', 'go2rtc.', 'events.onvif.', 'stills.enabled', 'stills.stream', 'stills.intervalS', 'stills.size', 'stills.quality', 'previews.tileSize', 'previews.grid', 'previews.quality', 'ftp.enabled', 'ftp.port', 'ftp.passive', 'ftp.tls', 'ftp.publicHost', 'ftp.certFile', 'ftp.keyFile', 'composition.font', 'server.trustProxy'];
// Live although under a restart prefix: the PoE switch is read on every use,
// the Baichuan port at the next connection, analytics kinds on every event.
const LIVE = [/^poeSwitch\./, /^cameras\.[^.]+\.poeSwitch\./, /^cameras\.[^.]+\.baichuanPort$/, /^cameras\.[^.]+\.analytics\./];
export function needsRestart(path: string): boolean {
  if (LIVE.some((re) => re.test(path))) return false;
  return RESTART.some((r) => (r.endsWith('.') ? path.startsWith(r) : path === r));
}
```

2. `Loaded` gains `order: string[]; legacyCamera: boolean;` and `export const settingPaths = (c: Config) => leafPaths(SETTINGS, '', c.cameraOrder);` (import `SETTINGS`: export it from schema.ts).

3. `loadConfig`: after reading the file:

```ts
  const raw = file ? readJson(file) : {};
  const norm = normalizeFile(raw);
  const fileSettings = norm.settings;
  asConfigError(() => checkPartial(fileSettings));
```

and for overrides:

```ts
  const overrides = normalizeOverrides(existsSync(overridesFile) ? readJson(overridesFile) : {}, norm.order);
  asConfigError(() => checkPartial(overrides));
```

then `return build(env, file, fileSettings as Obj, overrides as Obj, baseDir, layer, norm);` — `build` gains a last parameter `norm: { order: string[]; legacy: boolean }`, and every other `build(...)` call passes `loaded` 's `{ order: loaded.order, legacy: loaded.legacyCamera }`.

4. In `build`, before the `config` merge with the overrides:

```ts
  // Each camera: its defaults, then its config.json node (spec §4.1).
  merged.cameras = Object.fromEntries(norm.order.map((id) => [id, merge(cameraDefaults(id) as unknown as Obj, ((fileSettings.cameras as Obj | undefined)?.[id] ?? {}) as Obj)]));
```

after the overrides merge: `config.cameraOrder = [...norm.order];`. The environment:

```ts
  if (layer.cameraHost) {
    if (norm.order.length !== 1) throw new ConfigError(`${layer.cameraHost.name}: set cameras[].host instead (several cameras)`);
    const id = norm.order[0];
    config.cameras[id].host = layer.cameraHost.value;
    envNames[`cameras.${id}.host`] = layer.cameraHost.name;
  }
```

`sources` loops `settingPaths(config)`; the result gets `order: norm.order, legacyCamera: norm.legacy`.

5. `crossCheck(c)`:

```ts
function crossCheck(c: Config): void {
  const [cols, rows] = c.previews.grid.split('x').map(Number);
  for (const id of c.cameraOrder) {
    const iv = cameraConfig(c, id)!.stills.intervalS;
    if (cols * rows < 60 / iv) throw new ConfigError(`previews.grid: ${c.previews.grid} holds fewer than the ${60 / iv} tiles of a minute (camera ${id})`);
  }
  // Ruling P1-2: FTP for one camera until the per-camera users of phase 2.
  if (c.cameraOrder.filter((id) => cameraConfig(c, id)!.ftp.enabled).length > 1) throw new ConfigError('ftp.enabled: several cameras need per-camera FTP users (multi-camera phase 2); enable it for one camera');
  const [a, b] = c.ftp.passive.split('-').map(Number);
  if (a > 65535 || b > 65535 || a > b || b - a > 100) throw new ConfigError('ftp.passive: must be A-B with A <= B, at most 100 ports');
  if (c.storage.maxPercent !== undefined && c.storage.maxBytes !== undefined) throw new ConfigError('storage.maxBytes: set either storage.maxPercent or storage.maxBytes, not both');
  if (!c.go2rtc.binary && !c.go2rtc.url) throw new ConfigError('go2rtc.binary: set go2rtc.binary or go2rtc.url');
}
```

6. `loadSecrets(env, ftpEnabled)` gets `c.cameraOrder.some((id) => cameraConfig(c, id)!.ftp.enabled)` as `ftpEnabled`.

7. `applyOverrides(loaded, patch)`: first `patch = normalizeOverrides(patch, loaded.order)`; the rest as today (env check, merge, drop-equal loop, write). `withoutOverride(loaded, path)` / `removeOverride` / `resetTarget` translate: `path = translatePath(path, loaded.order)` and check it against `settingPaths(loaded.config)` instead of `leafPaths()`. `setPaths`/`dropPath` work on the new form unchanged.

- [ ] **Step 6: `src/config/cameras.ts` over the new shape**

```ts
const defined = <T extends object>(o: T): Partial<T> => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;

export function cameraIds(c: Config): string[] {
  return [...c.cameraOrder];
}

export function cameraEvents(c: Config, id: string): Config['events'] {
  const p = c.cameras[id]?.events?.poll?.enabled;
  return p === undefined ? c.events : { ...structuredClone(c.events), poll: { ...structuredClone(c.events.poll), enabled: p } };
}

export function cameraConfig(c: Config, id: string): ResolvedCamera | undefined {
  const n = c.cameras[id];
  if (!n) return undefined;
  const o = structuredClone(n);
  return {
    id, name: o.name, host: o.host, protocol: o.protocol, ...(o.tlsName !== undefined ? { tlsName: o.tlsName } : {}), ...(o.webUiUrl !== undefined ? { webUiUrl: o.webUiUrl } : {}),
    user: o.user, onvifPort: o.onvifPort, rtspPort: o.rtspPort, baichuanPort: o.baichuanPort, statusPollS: o.statusPollS,
    poeSwitch: { ...structuredClone(c.poeSwitch), ...(o.poeSwitch?.port !== undefined ? { port: o.poeSwitch.port } : {}) },
    ftp: { user: o.ftp?.user ?? id, enabled: o.ftp?.enabled ?? c.ftp.enabled, stream: o.ftp?.stream ?? c.ftp.stream },
    stills: { ...structuredClone(c.stills), ...defined(o.stills ?? {}) },
    events: structuredClone(cameraEvents(c, id)),
    analytics: { kinds: { ...c.analytics.kinds, ...defined(o.analytics?.kinds ?? {}) } },
  };
}
```

(`test/config-cameras.test.ts` from Task 2 builds an old-shape config: rewrite its `cfg()` to `const c = structuredClone(DEFAULTS); c.cameras = { cam1: { ...cameraDefaults('cam1'), name: 'Den', host: '192.0.2.10', poeSwitch: { port: 8 }, ftp: { user: 'camera' } } }; c.cameraOrder = ['cam1']; c.poeSwitch = { model: 'sscpoe-web', host: '192.0.2.2', ports: 8, offSeconds: 10 }; return c;` — the assertions stay.)

- [ ] **Step 7: Control API, PoE messages, UI paths**

`src/api/control-api.ts`:
- `configView(loaded, running)` iterates `settingPaths(running)` and adds `...(loaded.legacyCamera && loaded.sources[p] === 'file' && (p.startsWith('cameras.') || p.startsWith('poeSwitch.')) ? { legacy: true } : {})` to each row.
- `recordChanges` iterates `settingPaths(d.loaded().config)`.
- `find-camera`: `current` is true when the address equals any configured camera's host: `const hosts = cameraIds(d.running()).map((id) => splitHost(cameraConfig(d.running(), id)!.host).hostname.toLowerCase());` and `current: hosts.includes(x.address.toLowerCase())`.
- `camera-address`: with more than one camera answer `fail(409, 'not_available', 'several cameras: set cameras[].host in config.json')` before writing anything.

`src/camera/poe-switch.ts` `notConfigured()` messages: `'poeSwitch.model is none'`, `'poeSwitch.host is not set'`, `"the camera's poeSwitch.port is not set"`, `"the camera's poeSwitch.port is above poeSwitch.ports"`; `web/src/lib/maintenance.ts:76-78` the same three texts; `PoeSwitchCard.svelte` names `poeSwitch.*` and `cameras.<id>.poeSwitch.port`; `Settings.svelte:126` `p === 'camera.name'` becomes `/^cameras\.[^.]+\.name$/.test(p)`, and a row with `legacy` shows its source as `config.json (legacy camera)`.

- [ ] **Step 8: Update the tests that read the old shape**

Rules (let `npm run lint:types` list the sites):
- `l.config.camera.X` → `cameraConfig(l.config, 'cam1')!.X` (import `cameraConfig`); `l.config.camera.poeSwitch` → the resolved `poeSwitch` (which now merges the host switch: `{ model, host, port, ports, offSeconds }` as before).
- `p.proxy.running.camera.id` → `cameraIds(p.proxy.running)[0]`; `.camera.baichuanPort` → `cameraConfig(p.proxy.running, 'cam1')!.baichuanPort`.
- settings-view keys: `'camera.statusPollS'` → `'cameras.cam1.statusPollS'`, `'camera.host'` → `'cameras.cam1.host'`, `'camera.poeSwitch.port'` → `'cameras.cam1.poeSwitch.port'`, `'camera.poeSwitch.{model,host,ports,offSeconds}'` → `'poeSwitch.{…}'`; `l.sources['camera.host']` → `l.sources['cameras.cam1.host']`; `envNames` `'camera.host'` → `'cameras.cam1.host'`.
- written overrides.json expectations: `.camera.poeSwitch` → `{ cameras: { cam1: { poeSwitch: { port } } }, poeSwitch: { model, host } }`.
- PUT bodies and DELETE paths in tests may stay legacy (`{ camera: { poeSwitch: … } }`, `/control/config/camera.poeSwitch.host`): Ruling P1-8 keeps them working — this keeps `e2e/maintenance.spec.ts:149` unchanged.
- PoE messages: `'camera.poeSwitch.model is none'` → `'poeSwitch.model is none'` (`test/camera-powercycle.test.ts:201,354`).
- `e2e/admin.spec.ts:185` `row = (k) => \`camera.poeSwitch.${k}\`` → `(k) => (k === 'port' ? 'cameras.cam1.poeSwitch.port' : \`poeSwitch.${k}\`)` and the four texts at `:226-229` use those paths; `e2e/find-camera.spec.ts:45` `input-camera.host` → `input-cameras.cam1.host`.
- `test/config.test.ts`: the `jsonSchema()` comparison against `config.schema.json` stays (it is regenerated); `leafPaths()` without ids now omits camera paths — tests that loop `leafPaths()` for "every setting" use `settingPaths(load().config)`.

- [ ] **Step 9: Regenerate the schema, run everything**

Run: `npm run schema && npx vitest run test/config-legacy.test.ts test/config.test.ts test/config-env.test.ts test/config-cameras.test.ts test/control-api.test.ts && npm run lint:types && npm test`
Expected: all pass; `config.schema.json` now has `cameras` (array), `poeSwitch`, and the legacy `camera`.

- [ ] **Step 10: e2e (the Pi gate)**

Run: `npm run build && npm run check && npm run test:e2e`
Expected: every spec passes with `e2e/start.ts` still writing a legacy `camera` object.

- [ ] **Step 11: Commit**

```bash
git add src/config src/api/control-api.ts src/camera/poe-switch.ts web/src/lib/maintenance.ts web/src/components/PoeSwitchCard.svelte web/src/pages/Settings.svelte scripts/gen-schema.ts config.schema.json test e2e/admin.spec.ts e2e/find-camera.spec.ts
git commit -m "feat(config): cameras list with per-camera overrides; legacy camera translated at load"
```

---

### Task 12: A password per camera

**Files:**
- Modify: `src/config/secrets.ts`, `src/config/defaults.ts` (`Secrets.cameraPasswords`)
- Modify: `src/config/load.ts` (pass the camera ids)
- Modify: `src/proxy.ts` (each worker's `password`)
- Test: `test/secrets-cameras.test.ts` (new)

**Interfaces:**
- Produces:
  - `Secrets.cameraPasswords: Record<string, string>` (only cameras with their own variable).
  - `export function cameraPasswordEnv(id: string): string` → `CAMPROXY_CAMERA_PASSWORD_<ID>` (upper case, `-` → `_`).
  - `export function cameraPassword(s: Secrets, id: string): string`.
  - `loadSecrets(env, ftpEnabled, cameraIds: string[] = [])`.

- [ ] **Step 1: Write the failing test**

Create `test/secrets-cameras.test.ts`:

```ts
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { cameraPassword, cameraPasswordEnv, loadSecrets } from '../src/config/secrets';
import { SettingError } from '../src/config/schema';

const BASE = { CAMPROXY_TOKENS: 'a'.repeat(32), CAMPROXY_ADMIN_TOKEN: 'c'.repeat(32) };

describe('camera passwords (spec §4.2)', () => {
  it('the env name: upper case, - → _', () => {
    expect(cameraPasswordEnv('cam-3')).toBe('CAMPROXY_CAMERA_PASSWORD_CAM_3');
  });
  it('the default for every camera, one camera overridden (also from a _FILE)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'camproxy-sec-'));
    writeFileSync(join(dir, 'pw4'), 'four\n');
    const s = loadSecrets({ ...BASE, CAMPROXY_CAMERA_PASSWORD: 'default', CAMPROXY_CAMERA_PASSWORD_CAM_3: 'three', CAMPROXY_CAMERA_PASSWORD_CAM4_FILE: join(dir, 'pw4') }, false, ['cam-3', 'cam4', 'cam5']);
    expect(cameraPassword(s, 'cam-3')).toBe('three');
    expect(cameraPassword(s, 'cam4')).toBe('four');
    expect(cameraPassword(s, 'cam5')).toBe('default');
  });
  it('no default is fine when every camera has its own; else the default is required', () => {
    expect(cameraPassword(loadSecrets({ ...BASE, CAMPROXY_CAMERA_PASSWORD_CAM3: 'x' }, false, ['cam3']), 'cam3')).toBe('x');
    expect(() => loadSecrets({ ...BASE, CAMPROXY_CAMERA_PASSWORD_CAM3: 'x' }, false, ['cam3', 'cam4'])).toThrow(new SettingError('CAMPROXY_CAMERA_PASSWORD: required (cam4 has no CAMPROXY_CAMERA_PASSWORD_CAM4)'));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/secrets-cameras.test.ts`
Expected: FAIL with `cameraPasswordEnv is not a function`.

- [ ] **Step 3: Implement**

In `src/config/defaults.ts` `Secrets`: `cameraPassword: string;` stays (the default, `''` when only per-camera ones exist) and add `cameraPasswords: Record<string, string>; // CAMPROXY_CAMERA_PASSWORD_<ID>: one camera's own`.

In `src/config/secrets.ts`:

```ts
// One camera's own password variable (spec 2026-10-05-multi-camera-host-design §4.2).
export const cameraPasswordEnv = (id: string): string => `CAMPROXY_CAMERA_PASSWORD_${id.toUpperCase().replace(/-/g, '_')}`;

export function cameraPassword(s: Secrets, id: string): string {
  return s.cameraPasswords[id] ?? s.cameraPassword;
}
```

and in `loadSecrets(env, ftpEnabled, cameraIds: string[] = [])` replace the camera password block with:

```ts
  const cameraPasswords: Record<string, string> = {};
  for (const id of cameraIds) {
    const own = read(env, cameraPasswordEnv(id));
    if (own) cameraPasswords[id] = own;
  }
  const cameraPassword = read(env, 'CAMPROXY_CAMERA_PASSWORD') ?? '';
  const without = cameraIds.find((id) => !cameraPasswords[id]);
  if (!cameraPassword && (without !== undefined || !cameraIds.length)) {
    throw new SettingError(without !== undefined ? `CAMPROXY_CAMERA_PASSWORD: required (${without} has no ${cameraPasswordEnv(without)})` : 'CAMPROXY_CAMERA_PASSWORD: required');
  }
```

and return `cameraPasswords` with the rest. In `src/config/load.ts` `build()` calls `loadSecrets(env, <ftp on for any camera>, config.cameraOrder)`. In `src/proxy.ts` each worker gets `password: () => cameraPassword(loaded.secrets, id)`.

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/secrets-cameras.test.ts test/config.test.ts test/config-env.test.ts && npm run lint:types && npm test`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/config/secrets.ts src/config/defaults.ts src/config/load.ts src/proxy.ts test/secrets-cameras.test.ts
git commit -m "feat(config): CAMPROXY_CAMERA_PASSWORD_<ID> per camera"
```

---

### Task 13: SSE `?cam=a,b`

**Files:**
- Modify: `src/stream/log.ts` (`Filter.cams`), `src/stream/sse.ts`
- Test: `test/sse.test.ts` (extend)

**Interfaces:**
- Produces: `interface Filter { cams?: string[]; types: StreamType[]; kinds?: string[] }` (`cam` is gone); `matches()` and `StreamLog.since()` honour `cams`.

- [ ] **Step 1: Write the failing tests**

Append to `test/sse.test.ts` (it has `serve()`, `connect()`, `log`):

```ts
describe('several cameras on one stream (spec §6.2)', () => {
  const ev2 = (cam: string, n: number) => log.append(cam, 'camera-event', { eventId: n, kind: 'person', phase: 'start', ts: n });

  it('?cam=a,b filters replay and live to those cameras; one cursor for all', async () => {
    await serve();
    ev2('cam3', 1);
    ev2('cam4', 2);
    ev2('cam5', 3);
    const c = connect('/stream?cam=cam3,cam5&since=0');
    await c.until(() => c.events.length >= 2);
    ev2('cam4', 4);
    ev2('cam5', 5);
    await c.until(() => c.events.length >= 3);
    expect(c.events.map((e) => [(e.data as { cam: string }).cam, e.id])).toEqual([['cam3', 1], ['cam5', 3], ['cam5', 5]]);
  });

  it('cam list edge cases: empties ignored, duplicates harmless, unknown id an empty stream', async () => {
    await serve();
    ev2('cam3', 1);
    ev2('cam4', 2);
    const a = connect('/stream?cam=cam3,&since=0');
    const b = connect('/stream?cam=cam3,cam3&since=0');
    const u = connect('/stream?cam=nope&since=0');
    await a.until(() => a.events.length >= 1);
    await b.until(() => b.events.length >= 1);
    await u.until(() => u.status() === 200);
    await new Promise((r) => setTimeout(r, 100));
    expect(a.ids()).toEqual([1]);
    expect(b.ids()).toEqual([1]);
    expect(u.ids()).toEqual([]);
  });

  it('live stills honour the list too', async () => {
    await serve();
    const c = connect('/stream?types=still&cam=cam4');
    await c.until(() => c.status() === 200);
    handler.live('cam3', 'still', { ts: 1 });
    handler.live('cam4', 'still', { ts: 2 });
    await c.until(() => c.events.length >= 1);
    expect(c.events.map((e) => (e.data as { cam: string; ts: number }).ts)).toEqual([2]);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/sse.test.ts`
Expected: FAIL — `?cam=cam3,cam5` matches no camera named `cam3,cam5`, so the first test times out.

- [ ] **Step 3: Implement**

`src/stream/log.ts`:

```ts
export interface Filter {
  cams?: string[]; // these cameras only (spec 2026-10-05-multi-camera-host-design §6.2)
  types: StreamType[];
  kinds?: string[]; // matches data.kind
}
```

in `since()`: `if (f.cams?.length) (where.push(\`cam IN (${f.cams.map(() => '?').join(',')})\`), args.push(...f.cams));`; in `matches()`: `if (f.cams?.length && !f.cams.includes(m.cam)) return false;`.

`src/stream/sse.ts` `filterFrom`:

```ts
  // ?cam=a,b: these cameras; empties dropped, duplicates once (spec §6.2).
  const cams = list(req.query.cam);
  return { types: types as StreamType[], cams: cams?.length ? [...new Set(cams)] : undefined, kinds: list(req.query.kinds) };
```

and the live check `(filter.cam && filter.cam !== cam)` becomes `(filter.cams && !filter.cams.includes(cam))`. Any other `Filter` literal with `cam:` in `src/` (find with `grep -rn "cam: " src/stream`) moves to `cams: [..]`.

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/sse.test.ts && npm run lint:types && npm test`
Expected: all pass (the single `?cam=cam1` of today still works: a list of one).

- [ ] **Step 5: Commit**

```bash
git add src/stream/log.ts src/stream/sse.ts test/sse.test.ts
git commit -m "feat(sse): ?cam=a,b filters to several cameras"
```

---

### Task 14: Health summary: `cameras[]`, aggregated items, the first camera on top

**Files:**
- Modify: `src/health/summary.ts`
- Modify: `src/proxy.ts` (`healthNow` over every worker)
- Create: `test/fixtures/display/pi-ok.json`, `test/fixtures/display/cluster.json` (copied from cam-proxy-pi-display)
- Test: `test/health-summary.test.ts` (extend), `test/health-display-compat.test.ts` (new)

**Interfaces:**
- Produces (`src/health/summary.ts`):

```ts
export interface CameraHealthInput {
  camera: HealthInput['camera']; stream: HealthInput['stream']; intake: IntakeState; ftp: HealthInput['ftp'];
}
// HealthInput keeps camera/stream/intake/ftp (the first camera) and gains:
others?: CameraHealthInput[];   // the other cameras, config order
export interface CameraHealth {
  camera: HealthSummary['camera']; stream: HealthSummary['stream']; events: HealthSummary['events']; ftp: HealthSummary['ftp'];
  cert: null;                   // P5 fills it (spec §10.5)
  items: HealthItem[];          // this camera's camera/stream/events/ftp items
}
// HealthSummary gains:
cameras: CameraHealth[];        // every camera, config order; the first is the top level
```

- [ ] **Step 1: Copy the display's fixtures**

Run:

```bash
mkdir -p test/fixtures/display
cp ~/Development/cam-proxy-pi-display/tests/fixtures/pi-ok.json ~/Development/cam-proxy-pi-display/tests/fixtures/cluster.json test/fixtures/display/
```

Expected: two files; they are the JSON the display's own tests parse (read-only copies: they never change here; the display repo owns them).

- [ ] **Step 2: Write the failing tests**

Create `test/health-display-compat.test.ts`:

```ts
import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { buildHealth } from '../src/health/summary';
import { input } from './helpers/health-input';

// Every key the display's fixtures have (deep), as dotted paths; arrays by their first element.
const keys = (v: unknown, prefix = ''): string[] =>
  Array.isArray(v) ? (v.length ? keys(v[0], `${prefix}[]`) : []) : typeof v === 'object' && v !== null ? Object.entries(v).flatMap(([k, x]) => [`${prefix}${k}`, ...keys(x, `${prefix}${k}.`)]) : [];

describe('the e-paper display keeps working (spec §6.5, decision 5)', () => {
  for (const name of ['pi-ok.json', 'cluster.json']) {
    it(`one camera: every key of the display's ${name} is still there, schema 1`, () => {
      const fixture = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'display', name), 'utf8'));
      const h = buildHealth(input());
      const have = new Set(keys(h));
      expect(keys(fixture).filter((k) => !have.has(k))).toEqual([]);
      expect(h.schema).toBe(1);
    });
  }
  it('one camera: the item list is today\'s, and cameras[0] is the top level', () => {
    const h = buildHealth(input());
    expect(h.items.map((i) => i.id)).toEqual(['camera', 'stream', 'events', 'ftp', 'storage', 'disk', 'cpuTemp', 'underVoltage', 'inventory', 'version']);
    expect(h.cameras).toHaveLength(1);
    expect(h.cameras[0]).toMatchObject({ camera: h.camera, stream: h.stream, events: h.events, ftp: h.ftp, cert: null });
    expect(h.cameras[0].items).toEqual(h.items.filter((i) => ['camera', 'stream', 'events', 'ftp'].includes(i.id)));
  });
});
```

Move the `input()` factory of `test/health-summary.test.ts` into `test/helpers/health-input.ts` (export `input`, `NOW`, `H`) and import it in both files.

Append to `test/health-summary.test.ts`:

```ts
describe('several cameras (spec §6.5)', () => {
  const cam = (id: string, online: boolean) => ({
    camera: { ...input().camera, id, name: id, host: `192.168.60.${id.slice(3)}`, state: online ? input().camera.state : { online: false, since: NOW, error: 'timeout' } },
    stream: input().stream, intake: input().intake, ftp: input().ftp,
  });
  it('the top level is the first camera; one aggregated item per kind', () => {
    const h = buildHealth(input({ others: [cam('cam4', false), cam('cam5', true)] }));
    expect(h.camera.id).toBe('cam1');
    expect(h.cameras.map((c) => [c.camera.id, c.camera.online])).toEqual([['cam1', true], ['cam4', false], ['cam5', true]]);
    expect(item(h, 'camera')).toEqual({ id: 'camera', label: 'Camera', value: 2, text: 'cam4 offline', problem: true });
    expect(item(h, 'stream')).toEqual({ id: 'stream', label: 'Live stream', value: 3, text: 'all 3 up', problem: false });
    expect(h.items.filter((i) => i.id === 'camera')).toHaveLength(1);
    expect(h.problemCount).toBe(1);
  });
  it('more than one with the problem: "n of N"', () => {
    const h = buildHealth(input({ camera: cam('cam1', false).camera, others: [cam('cam4', false), cam('cam5', true)] }));
    expect(item(h, 'camera')).toMatchObject({ value: 1, text: '1 of 3 online', problem: true });
  });
  it('no problem but different states: says so without a count of a state', () => {
    const off = { ...input().stream, enabled: false, up: false };
    const h = buildHealth(input({ others: [{ ...cam('cam4', true), stream: off }] }));
    expect(item(h, 'stream')).toMatchObject({ value: 2, text: 'no problem (2 cameras)', problem: false });
  });
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `npx vitest run test/health-display-compat.test.ts test/health-summary.test.ts`
Expected: FAIL — `h.cameras` is undefined.

- [ ] **Step 4: Implement**

In `src/health/summary.ts`:

1. Split the four camera items out of `buildHealth` into one function (same rules, same texts):

```ts
export interface CameraHealthInput { camera: HealthInput['camera']; stream: HealthInput['stream']; intake: IntakeState; ftp: HealthInput['ftp'] }
export interface CameraHealth { camera: HealthSummary['camera']; stream: HealthSummary['stream']; events: HealthSummary['events']; ftp: HealthSummary['ftp']; cert: null; items: HealthItem[] }

// One camera's items and blocks (the rules of A2, unchanged).
function cameraHealth(c: CameraHealthInput): CameraHealth {
  const items: HealthItem[] = [];
  const add = (id: ItemId, label: string, value: HealthItem['value'], text: string, problem: boolean) => items.push({ id, label, value, text, problem });
  // … the existing camera, stream, events and ftp item code, reading `c.` instead of `i.` …
  return { camera: { /* the existing camera block from c */ }, stream: { /* … */ }, events: { /* … */ }, ftp: { /* … */ }, cert: null, items };
}
```

(cut the existing code for these four items and the `camera`, `stream`, `events`, `ftp` blocks of the result into it; the `stalled` and `FTP_TEXT` logic moves along unchanged.)

2. The aggregation:

```ts
// One item per kind for the whole host (spec §6.5): with one camera exactly
// that camera's; with several, value = the cameras without the problem.
function aggregate(per: { cam: string; item: HealthItem }[]): HealthItem {
  const first = per[0].item;
  if (per.length === 1) return first;
  const bad = per.filter((p) => p.item.problem);
  const value = per.length - bad.length;
  const word = { camera: 'online', stream: 'up', events: 'subscribed', ftp: 'on' }[first.id as 'camera' | 'stream' | 'events' | 'ftp'];
  const same = per.every((p) => p.item.text === first.text);
  const text = bad.length === 1 ? `${bad[0].cam} ${bad[0].item.text}` : bad.length > 1 ? `${value} of ${per.length} ${word}` : same ? `all ${per.length} ${first.text}` : `no problem (${per.length} cameras)`;
  return { id: first.id, label: first.label, value, text, problem: bad.length > 0 };
}
```

3. In `buildHealth(i)`:

```ts
  const cams = [{ camera: i.camera, stream: i.stream, intake: i.intake, ftp: i.ftp }, ...(i.others ?? [])].map((c) => ({ id: c.camera.id, h: cameraHealth(c) }));
  for (const id of ['camera', 'stream', 'events', 'ftp'] as const) items.push(aggregate(cams.map((c) => ({ cam: c.id, item: c.h.items.find((x) => x.id === id)! }))));
  // … then the host items as today (storage, disk, archive, cpuTemp, underVoltage, inventory, version) …
```

and in the result: `camera: cams[0].h.camera, stream: cams[0].h.stream, events: cams[0].h.events, ftp: cams[0].h.ftp, cameras: cams.map((c) => c.h),` — `HealthSummary` gains `cameras: CameraHealth[]`. `HealthInput` gains `others?: CameraHealthInput[]`. The order of `items` stays camera, stream, events, ftp, then the host items.

In `src/proxy.ts` `healthNow()`:

```ts
  const cameraHealthInput = (w: CameraWorker): CameraHealthInput => {
    const ps = w.cam().poeSwitch;
    return {
      camera: { id: w.id, name: w.name(), host: w.cam().host, state: w.status.state(), reboot: w.reboot.state()?.phase ?? null, poeSwitch: ps.model === 'none' ? null : { model: ps.model, port: ps.port ?? null } },
      stream: w.streamStatus(),
      intake: w.intake.state(),
      ftp: ftpStatusOf(w),
    };
  };
```

where `ftpStatusOf(w)` is today's `ftpStatus()` with the camera parts from `w` (`camera: w.cam().ftp.enabled ? w.ftpWatch.view() : null`, `stalled: w.clipsHealth()`, `enabled: w.cam().ftp.enabled`, `listening`/`lastUpload`/`lastClip`/`failures` from the FTP side only when `w` is the FTP camera, else `false`/`null`/`null`/`0`; `clips: countClips` for that camera — use `countAllClips(catalog)` while one camera is configured to keep the Pi's number identical). Then `const [first, ...rest] = cams.list().map(cameraHealthInput); return buildHealth({ …, ...first, others: rest, … })`.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run test/health-display-compat.test.ts test/health-summary.test.ts test/local-api.test.ts test/health-ui.test.ts && npm run lint:types && npm test`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/health/summary.ts src/proxy.ts test/fixtures/display test/helpers/health-input.ts test/health-summary.test.ts test/health-display-compat.test.ts
git commit -m "feat(health): cameras[] and aggregated camera items; schema 1 unchanged"
```

---

### Task 15: Control API: every camera's status; `camera_required` on a multi-camera proxy

**Files:**
- Modify: `src/api/control-api.ts`
- Modify: `src/proxy.ts`
- Test: `test/control-cameras.test.ts` (new)

**Interfaces:**
- Consumes: `CameraRegistry`, `CameraWorker` (Task 3); `cameraParam` (Task 4).
- Produces:
  - `export interface CameraStatusBlock { id: string; camera: <today's camera() object>; intake: IntakeState; stream: <streamStatus>; ftp: FtpStatus; recordings: RecordingsStatus }`.
  - `ControlDeps` gains `cameraStatus: () => CameraStatusBlock[]` and `cameraCount: () => number`; `camera`, `intake`, `stream`, `ftp`, `recordings` stay (the first camera, Ruling P1-12).
  - `GET /control/status` gains `cameras: CameraStatusBlock[]`.
  - `GET /control/cameras` → `CameraStatusBlock[]`; `GET /control/cameras/:cam/status` → one block (404 unknown, 503 restarting via `cameraParam(cams, 'admin')`).
  - `POST /control/actions/:name` for a camera action on a proxy with more than one camera → `400 {error: 'camera_required'}`.

- [ ] **Step 1: Write the failing test**

Create `test/control-cameras.test.ts`:

```ts
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN_TOKEN, auth, startProxy } from './helpers/proxy';
import { startSim } from './helpers/sim';

let sim: Awaited<ReturnType<typeof startSim>>;
let p: Awaited<ReturnType<typeof startProxy>>;
const admin = () => auth(ADMIN_TOKEN);
beforeAll(async () => {
  sim = await startSim();
  p = await startProxy(sim);
});
afterAll(async () => {
  await p.proxy.stop();
  await sim.close();
});

describe('control: cameras (spec §6.3)', () => {
  it('GET /control/cameras: one block per camera, the same as the top-level status', async () => {
    const list = (await request(p.base).get('/control/cameras').set(admin())).body;
    expect(list.map((b: { id: string }) => b.id)).toEqual(['cam1']);
    const st = (await request(p.base).get('/control/status').set(admin())).body;
    expect(st.cameras).toEqual(list);
    expect(list[0].camera.name).toBe(st.camera.name);
    expect((await request(p.base).get('/control/cameras/cam1/status').set(admin())).body.id).toBe('cam1');
    expect((await request(p.base).get('/control/cameras/cam9/status').set(admin())).status).toBe(404);
  });
  it('one camera: the old camera actions act on it', async () => {
    expect((await request(p.base).post('/control/actions/camera-test').set(admin())).status).toBe(200);
  });
});
```

The multi-camera `camera_required` answer is pinned in Task 16 (it needs two cam-sims).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/control-cameras.test.ts`
Expected: FAIL — `/control/cameras` answers 404.

- [ ] **Step 3: Implement**

In `src/api/control-api.ts`:

```ts
// The camera actions (spec §6.3): on a proxy with several cameras they need a
// camera (the routes of phase 2); the host actions work as before.
export const CAMERA_ACTIONS = new Set(['camera-test', 'onvif-resubscribe', 'camera-ftp-setup', 'camera-ftp-test', 'camera-ftp-off', 'restart', 'camera-reboot', 'camera-powercycle', 'camera-poe-on', 'poe-switch-read', 'inventory', 'inventory-repair', 'inventory-cancel']);
```

(Task 8 introduced a set of the same name for the audit label: keep this one definition.) `camera-address` is not in the set: Task 11 already answers it with 409 `not_available` on several cameras. In the `actions/:name` handler, right after the `res.on('close', …)` audit registration (so a refused call still leaves a `control-action` record with result `camera_required`):

```ts
    if (CAMERA_ACTIONS.has(name) && d.cameraCount() > 1) return fail(400, 'camera_required', 'several cameras: this action needs a camera (/control/cameras/:cam/actions/…)');
```

Routes:

```ts
  r.get('/cameras', (_req, res) => void res.json(d.cameraStatus()));
  r.get('/cameras/:cam/status', (req, res) => {
    const b = d.cameraStatus().find((x) => x.id === req.params.cam);
    if (!b) return void res.status(404).json({ error: 'not_found' });
    res.json(b);
  });
```

(`r.param('cam', cameraParam(d.cameras, 'admin'))` in front gives the 503 while restarting: add `cameras: CameraRegistry` to `ControlDeps` and register the param right after `const r = express.Router();`.) `GET /status` adds `cameras: d.cameraStatus(),`.

In `src/proxy.ts`:

```ts
  const cameraStatusBlock = (w: CameraWorker) => ({
    id: w.id,
    camera: { ...w.status.state(), name: w.name(), nameSource: w.nameSource(), webUiUrl: cameraWebUi(w.cam()), reboot: w.reboot.state(), poeSwitch: w.poeSwitch.status() },
    intake: w.intake.state(),
    stream: w.streamStatus(),
    ftp: ftpStatusOf(w),
    recordings: w.recordings.status(),
  });
```

and pass `cameras: cams, cameraStatus: () => cams.list().map(cameraStatusBlock), cameraCount: () => cams.size` to `controlApi`; the existing `camera: () => …` dep becomes `() => cameraStatusBlock(cams.first()).camera` (one definition).

- [ ] **Step 4: Document the routes**

`test/openapi.test.ts` requires every registered route in `openapi.yaml`. Insert after the `/control/status:` operation (keep the file's indentation: paths at two spaces, methods at four):

```yaml
  /control/cameras:
    get:
      summary: Every camera's status block, in config order (spec 2026-10-05-multi-camera-host-design §6.3)
      responses:
        '200': { description: 'A list of {id, camera, intake, stream, ftp, recordings}' }
  /control/cameras/{cam}/status:
    get:
      summary: One camera's status block
      parameters:
        - { name: cam, in: path, required: true, schema: { type: string } }
      responses:
        '200': { description: '{id, camera, intake, stream, ftp, recordings}' }
        '404': { description: not_found }
        '503': { description: camera_restarting (Retry-After) }
```

Copy the exact style of the neighbouring `/control/status` entry if it differs (it is the reference).

- [ ] **Step 5: Run tests**

Run: `npx vitest run test/control-cameras.test.ts test/control-api.test.ts test/openapi.test.ts && npm run lint:types && npm test`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/api/control-api.ts src/proxy.ts openapi.yaml test/control-cameras.test.ts
git commit -m "feat(control): status of every camera; camera actions need a camera on a multi-camera proxy"
```

---

### Task 16: One proxy, three cam-sims (integration)

**Files:**
- Create: `test/helpers/multi.ts`
- Test: `test/multi-camera.test.ts` (new)

**Interfaces:**
- Consumes: everything above.
- Produces (`test/helpers/multi.ts`):

```ts
export type Sim = Awaited<ReturnType<typeof startSim>>;
export async function startSims(n: number): Promise<Sim[]>;
export async function freePortBlock(n: number, step?: number): Promise<number>;  // base with base + step*i free for i < n
export async function startMultiProxy(sims: Sim[], opts?: { ids?: string[]; extra?: object[]; settings?: object; env?: Record<string, string> }): Promise<{ proxy: Proxy; dir: string; base: string; ids: string[] }>;
```

- [ ] **Step 1: Write the helper**

Create `test/helpers/multi.ts`:

```ts
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadConfig } from '../../src/config/load';
import { createProxy, type Proxy } from '../../src/proxy';
import { ADMIN_TOKEN, CLIENT_TOKEN, freePort } from './proxy';
import { startSim } from './sim';

export type Sim = Awaited<ReturnType<typeof startSim>>;

export const startSims = (n: number): Promise<Sim[]> => Promise.all(Array.from({ length: n }, () => startSim()));

// go2rtc per camera until P2 (Ruling P1-1): ports base + 100*i must all be free.
export async function freePortBlock(n: number, step = 100): Promise<number> {
  for (;;) {
    const base = await freePort();
    if (base + step * n > 65000) continue;
    const net = await import('net');
    const free = (port: number) => new Promise<boolean>((r) => {
      const s = net.createServer();
      s.once('error', () => r(false));
      s.listen(port, () => s.close(() => r(true)));
    });
    let ok = true;
    for (let i = 1; i < n && ok; i++) ok = await free(base + step * i);
    if (ok) return base;
  }
}

// One proxy over several cam-sims: cameras cam3, cam4, … (or `ids`), in that
// order; `extra` camera nodes are appended as they are (e.g. one without host).
export async function startMultiProxy(sims: Sim[], opts: { ids?: string[]; extra?: object[]; settings?: object; env?: Record<string, string> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'camproxy-multi-'));
  const go2rtc = process.env.CAMPROXY_TEST_GO2RTC;
  const ids = opts.ids ?? sims.map((_, i) => `cam${i + 3}`);
  const n = sims.length + (opts.extra?.length ?? 0);
  const cameras = [
    ...sims.map((s, i) => ({ id: ids[i], host: s.camera.host, protocol: 'http', user: 'proxy', onvifPort: s.ports.onvif, rtspPort: s.ports.rtsp || 554, baichuanPort: s.camera.baichuanPort, statusPollS: 5 })),
    ...(opts.extra ?? []),
  ];
  writeFileSync(join(dir, 'config.json'), JSON.stringify({
    stills: { enabled: !!go2rtc },
    go2rtc: { binary: go2rtc ?? 'go2rtc', rtspPort: await freePortBlock(n), apiPort: await freePortBlock(n) },
    cameras,
    events: { onvif: { subscribeMin: 1, pullTimeoutS: 1 }, poll: { enabled: true, intervalS: 1, afterOnvifDownS: 1 } },
    server: { logLevel: 'silent' },
    ...(opts.settings ?? {}),
  }));
  // Every cam-sim of startSim() has the proxy user's password 'proxy-pw'.
  const loaded = loadConfig({ CAMPROXY_TOKENS: CLIENT_TOKEN, CAMPROXY_ADMIN_TOKEN: ADMIN_TOKEN, CAMPROXY_CAMERA_PASSWORD: sims[0]?.password ?? 'proxy-pw', ...opts.env }, { cwd: dir });
  const proxy: Proxy = createProxy(loaded);
  const { port } = await proxy.start({ port: 0, host: '127.0.0.1' });
  return { proxy, dir, base: `http://127.0.0.1:${port}`, ids: cameras.map((c) => (c as { id: string }).id) };
}
```

- [ ] **Step 2: Write the integration tests**

Create `test/multi-camera.test.ts`:

```ts
import { basename } from 'path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN_TOKEN, auth, until } from './helpers/proxy';
import { startMultiProxy, startSims, type Sim } from './helpers/multi';
import { sseConnect } from './helpers/sse';

const go2rtc = process.env.CAMPROXY_TEST_GO2RTC;
const HOUR = 3600_000;
let sims: Sim[];
let p: Awaited<ReturnType<typeof startMultiProxy>>;
const admin = () => auth(ADMIN_TOKEN);

beforeAll(async () => {
  sims = await startSims(3);
  p = await startMultiProxy(sims);
  await until(() => p.proxy.cameras.list().every((w) => w.status.state().online && w.intake.state().onvif === 'subscribed'), 30_000);
}, 60_000);
afterAll(async () => {
  await p.proxy.stop();
  await Promise.all(sims.map((s) => s.close()));
});

describe('one proxy, three cameras (spec §15)', () => {
  it('lists the cameras in config order, each online with its own address', async () => {
    const r = await request(p.base).get('/api/cameras').set(auth());
    expect(r.body.map((c: { id: string; online: boolean; address: string; error: string | null }) => [c.id, c.online, c.address, c.error])).toEqual(sims.map((s, i) => [`cam${i + 3}`, true, s.camera.host, null]));
  });

  it('events arrive with the right cam on one stream; ?cam= narrows it', async () => {
    const all = sseConnect(`${p.base}/api/stream?types=camera-event&kinds=person`, auth());
    const two = sseConnect(`${p.base}/api/stream?types=camera-event&kinds=person&cam=cam3,cam5`, auth());
    await all.until(() => all.status() === 200);
    await two.until(() => two.status() === 200);
    await new Promise((r) => setTimeout(r, 300));
    sims[1].sim.engine.events.trigger('person', 1);
    sims[2].sim.engine.events.trigger('person', 1);
    await all.until(() => new Set(all.events.map((e) => (e.data as { cam: string }).cam)).size === 2, 10_000);
    await two.until(() => two.events.length > 0, 10_000);
    expect(new Set(all.events.map((e) => (e.data as { cam: string }).cam))).toEqual(new Set(['cam4', 'cam5']));
    expect(two.events.every((e) => (e.data as { cam: string }).cam === 'cam5')).toBe(true);
    expect((await request(p.base).get('/api/cameras/cam4/events').set(auth())).body[0]).toMatchObject({ kind: 'person' });
    expect((await request(p.base).get('/api/cameras/cam3/events').set(auth())).body).toEqual([]);
    all.close();
    two.close();
  });

  it.skipIf(!go2rtc)('stills from each camera', async () => {
    await until(() => p.proxy.cameras.list().every((w) => w.stills?.grabber.up() === true), 30_000);
    const now = Date.now();
    for (const id of ['cam3', 'cam4', 'cam5']) {
      await until(async () => (await request(p.base).get(`/api/cameras/${id}/stills?from=${now - 60_000}&to=${now + 60_000}`).set(auth())).body.length > 0, 15_000);
    }
  });

  it('a camera that goes away and comes back: the others keep producing (supervision)', async () => {
    sims[0].sim.engine.powerOff();
    await until(() => !p.proxy.cameras.get('cam3')!.status.state().online, 20_000);
    const s = sseConnect(`${p.base}/api/stream?types=camera-event&kinds=person&cam=cam4`, auth());
    await s.until(() => s.status() === 200);
    await new Promise((r) => setTimeout(r, 300));
    sims[1].sim.engine.events.trigger('person', 1);
    await s.until(() => s.events.length > 0, 10_000);
    void sims[0].sim.engine.powerOn(500);
    await until(() => p.proxy.cameras.get('cam3')!.status.state().online, 30_000);
    s.close();
  }, 60_000);

  it('recordings from two cameras in parallel', async () => {
    const pick = (s: Sim) => s.sim.engine.sd.all().find((r) => r.end !== null)!;
    const [a, b] = [pick(sims[0]), pick(sims[1])];
    const win = (date: string) => {
      const from = Date.parse(`${date}T00:00:00Z`) - 12 * HOUR;
      return `from=${from}&to=${from + 47 * HOUR}&stream=sub`;
    };
    // The list first (it maps the id to the camera's file).
    await request(p.base).get(`/api/cameras/cam3/recordings?${win(a.date)}`).set(auth()).expect(200);
    await request(p.base).get(`/api/cameras/cam4/recordings?${win(b.date)}`).set(auth()).expect(200);
    const [ra, rb] = await Promise.all([
      request(p.base).get(`/api/cameras/cam3/recordings/${basename(a.files.sub.name)}`).set(auth()),
      request(p.base).get(`/api/cameras/cam4/recordings/${basename(b.files.sub.name)}`).set(auth()),
    ]);
    expect([ra.status, rb.status]).toEqual([200, 200]);
    expect(sims[0].sim.engine.counters.baichuanDownloads).toBeGreaterThan(0);
    expect(sims[1].sim.engine.counters.baichuanDownloads).toBeGreaterThan(0);
  }, 60_000);

  it('the old camera actions answer camera_required; host actions work', async () => {
    const r = await request(p.base).post('/control/actions/camera-test').set(admin());
    expect([r.status, r.body.error]).toEqual([400, 'camera_required']);
    expect((await request(p.base).post('/control/actions/retention-run').set(admin()).send({ dryRun: true })).status).toBe(200);
  });

  it('health: one block per camera; the top level is the first camera', async () => {
    const h = (await request(p.base).get('/api/local/health')).body;
    expect(h.schema).toBe(1);
    expect(h.camera.id).toBe('cam3');
    expect(h.cameras.map((c: { camera: { id: string } }) => c.camera.id)).toEqual(['cam3', 'cam4', 'cam5']);
    expect(h.items.filter((i: { id: string }) => i.id === 'camera')).toHaveLength(1);
  });
});

describe('a camera without an address next to working ones (spec §3.3)', () => {
  it('stays idle with no_address; the process runs; the others work', async () => {
    const s2 = await startSims(1);
    const q = await startMultiProxy(s2, { extra: [{ id: 'cam9', host: '' }] });
    try {
      await until(() => q.proxy.cameras.get('cam3')!.status.state().online, 20_000);
      const list = (await request(q.base).get('/api/cameras').set(auth())).body;
      expect(list.map((c: { id: string; error: string | null }) => [c.id, c.error])).toEqual([['cam3', null], ['cam9', 'no_address']]);
      expect(q.proxy.cameras.get('cam9')!.phase()).toBe('idle');
    } finally {
      await q.proxy.stop();
      await s2[0].close();
    }
  }, 60_000);
});
```

- [ ] **Step 3: Run them**

Run: `npx vitest run test/multi-camera.test.ts`
Expected: PASS (`7 passed`, or `6 passed | 1 skipped` without go2rtc). A failure here is a bug in Tasks 3–15: fix it in the module that owns it (the test names say which), not in the test.

- [ ] **Step 4: Whole suite**

Run: `npm test`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add test/helpers/multi.ts test/multi-camera.test.ts
git commit -m "test: one proxy with three cam-sims"
```

---

### Task 17: Admin UI: camera picker (read-only status per camera)

**Files:**
- Create: `web/src/lib/cameras.ts`, `web/src/components/CameraPicker.svelte`
- Modify: `web/src/lib/state.ts` (`Status.cameras`)
- Modify: `web/src/components/TopBar.svelte`, `web/src/components/CameraMeta.svelte`, `web/src/pages/Status.svelte`, `web/src/pages/Events.svelte`, `web/src/pages/Timeline.svelte`, `web/src/pages/Clips.svelte`, `web/src/pages/Maintenance.svelte`
- Test: `test/cameras-ui.test.ts` (new)

**Interfaces:**
- Produces (`web/src/lib/cameras.ts`):

```ts
export interface CameraBlock { id: string; camera: Status['camera']; intake: Status['intake']; stream: Status['stream']; ftp: Status['ftp']; recordings?: RecordingsStatus }
export const selectedCamera: Writable<string | null>;            // persisted in localStorage 'camproxy.camera' (try/catch)
export function cameraIds(s: Status | null): string[];             // s.cameras ids, or [] for an older proxy
export function pickCamera(ids: string[], selected: string | null): string | null;  // selected if listed, else the first, else null
export function blockOf(s: Status | null, id: string | null): CameraBlock | null;   // the block, or the top-level fields (older proxy / one camera)
export function multiCamera(s: Status | null): boolean;           // more than one camera
```

- [ ] **Step 1: Write the failing test**

Create `test/cameras-ui.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { blockOf, cameraIds, multiCamera, pickCamera } from '../web/src/lib/cameras';

const cam = (id: string, online = true) => ({ id, camera: { name: id, online, since: 0 }, intake: { onvif: 'subscribed', since: 0, source: 'onvif', resubscribes: 0 }, stream: { enabled: true, up: true, go2rtcUp: true, lastFrameTs: 1 }, ftp: { enabled: false } });
const status = (ids: string[]) => ({ version: 'v', camera: cam(ids[0]).camera, intake: cam(ids[0]).intake, stream: cam(ids[0]).stream, ftp: cam(ids[0]).ftp, cameras: ids.map((i) => cam(i, i !== 'cam4')) }) as never;

describe('camera picker (spec §16 P1)', () => {
  it('ids in config order; multi only with more than one', () => {
    expect(cameraIds(status(['cam3', 'cam4']))).toEqual(['cam3', 'cam4']);
    expect(multiCamera(status(['cam3', 'cam4']))).toBe(true);
    expect(multiCamera(status(['cam1']))).toBe(false);
    expect(cameraIds(null)).toEqual([]);
  });
  it('the selection survives while listed, else the first', () => {
    expect(pickCamera(['cam3', 'cam4'], 'cam4')).toBe('cam4');
    expect(pickCamera(['cam3', 'cam4'], 'gone')).toBe('cam3');
    expect(pickCamera([], 'cam4')).toBeNull();
  });
  it("the selected camera's block; an older proxy without cameras: the top level", () => {
    expect(blockOf(status(['cam3', 'cam4']), 'cam4')?.camera.online).toBe(false);
    const old = { ...status(['cam1']), cameras: undefined } as never;
    expect(blockOf(old, null)?.id).toBe('');
    expect(blockOf(old, null)?.camera.name).toBe('cam1');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/cameras-ui.test.ts`
Expected: FAIL with `Failed to resolve import "../web/src/lib/cameras"`.

- [ ] **Step 3: Implement the lib and the picker**

`web/src/lib/state.ts`: `Status` gains `cameras?: CameraBlock[];` (import the type from `./cameras`).

Create `web/src/lib/cameras.ts`:

```ts
import { writable } from 'svelte/store';
import type { Status } from './state';
import type { RecordingsStatus } from './recordings';

export interface CameraBlock { id: string; camera: Status['camera']; intake: Status['intake']; stream: Status['stream']; ftp: Status['ftp']; recordings?: RecordingsStatus }

const KEY = 'camproxy.camera';
const stored = (): string | null => {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
};
// The camera the pages show (several cameras on this proxy), kept per browser.
export const selectedCamera = writable<string | null>(typeof localStorage === 'undefined' ? null : stored());
selectedCamera.subscribe((v) => {
  try {
    if (v) localStorage.setItem(KEY, v);
  } catch {
    // private mode: the choice lasts this page only
  }
});

export const cameraIds = (s: Status | null): string[] => s?.cameras?.map((c) => c.id) ?? [];
export const multiCamera = (s: Status | null): boolean => cameraIds(s).length > 1;
export const pickCamera = (ids: string[], selected: string | null): string | null => (selected && ids.includes(selected) ? selected : (ids[0] ?? null));

export function blockOf(s: Status | null, id: string | null): CameraBlock | null {
  if (!s) return null;
  const found = s.cameras?.find((c) => c.id === pickCamera(cameraIds(s), id));
  return found ?? { id: s.cameras?.[0]?.id ?? '', camera: s.camera, intake: s.intake, stream: s.stream, ftp: s.ftp, recordings: s.recordings };
}
```

Create `web/src/components/CameraPicker.svelte`:

```svelte
<script lang="ts">
  import { status } from '../lib/state';
  import { cameraIds, pickCamera, selectedCamera } from '../lib/cameras';
  const ids = $derived(cameraIds($status));
  const current = $derived(pickCamera(ids, $selectedCamera));
</script>

{#if ids.length > 1}
  <label class="picker">
    <span class="long">Camera</span>
    <select data-testid="camera-picker" value={current} onchange={(e) => selectedCamera.set((e.currentTarget as HTMLSelectElement).value)}>
      {#each $status?.cameras ?? [] as c (c.id)}
        <option value={c.id}>{c.camera.name ?? c.id}{c.camera.online ? '' : ' (offline)'}</option>
      {/each}
    </select>
  </label>
{/if}

<style>
  .picker { display: inline-flex; gap: 6px; align-items: center; font-size: 12px; color: var(--muted); }
  select { font: inherit; padding: 2px 6px; border-radius: 8px; border: 1px solid var(--border); background: var(--surface-2); color: var(--text); }
</style>
```

- [ ] **Step 4: Use it in the pages**

- `TopBar.svelte`: import `CameraPicker` and `blockOf`, `selectedCamera`; place `<CameraPicker />` after the brand link; `const block = $derived(blockOf($status, $selectedCamera));` and the two badges read `block.camera.online` and `block.intake` instead of `$status.camera` / `$status.intake`.
- `CameraMeta.svelte`: `blockOf($status, $selectedCamera)?.camera` instead of `$status?.camera`.
- `Status.svelte`: `const block = $derived(blockOf($status, $selectedCamera));` and the Camera, Events, Stream and FTP cards read `block.camera`, `block.intake`, `block.stream`, `block.ftp`; `bad(id)` reads the selected camera's items: `const camHealth = $derived(health?.cameras?.find((c) => c.camera.id === block?.id));` and `bad = (id) => ['camera', 'stream', 'events', 'ftp'].includes(id) && camHealth ? !!camHealth.items.find((i) => i.id === id)?.problem : problemOf(health, id)` (`UiHealth` gets `cameras?: { camera: { id: string }; items: { id: string; problem: boolean }[] }[]` in `web/src/lib/health.ts`). The Health card keeps the host items (aggregated).
- `Events.svelte`, `Timeline.svelte`, `Clips.svelte`: replace `cams[0].id` with `pickCamera(cams.map((c) => c.id), $selectedCamera)`, and reload when `$selectedCamera` changes (an `$effect` that reads it and calls the page's load function).
- `Maintenance.svelte`: when `multiCamera($status)`, show above the camera actions a note card `data-testid="multi-camera-note"`: "Several cameras: camera actions and per-camera settings come with the next release; the status of each camera is on the Status page." and render the camera action buttons disabled. Host actions (retention, restart proxy, Find camera, archive) stay enabled.

- [ ] **Step 5: Type check, unit tests, build**

Run: `npx vitest run test/cameras-ui.test.ts test/status-ui.test.ts test/health-ui.test.ts test/nav-ui.test.ts && npm run check && npm run build`
Expected: tests pass; `check` prints no errors; the build succeeds.

- [ ] **Step 6: e2e (one camera unchanged)**

Run: `npm run test:e2e`
Expected: all pass; no picker shows on the one-camera e2e proxy.

- [ ] **Step 7: Commit**

```bash
git add web/src/lib/cameras.ts web/src/lib/state.ts web/src/lib/health.ts web/src/components/CameraPicker.svelte web/src/components/TopBar.svelte web/src/components/CameraMeta.svelte web/src/pages/Status.svelte web/src/pages/Events.svelte web/src/pages/Timeline.svelte web/src/pages/Clips.svelte web/src/pages/Maintenance.svelte test/cameras-ui.test.ts
git commit -m "feat(ui): camera picker; the pages show the selected camera"
```

---

### Task 18: e2e with three cameras

**Files:**
- Create: `e2e/multi/start.ts`, `e2e/multi/env.ts`, `e2e/multi/auth.setup.ts`, `e2e/multi/picker.spec.ts`, `playwright.multi.config.ts`
- Modify: `package.json` (`test:e2e:multi`), `.github/workflows/pr-checks.yml` (the e2e job runs it), `.gitignore` if `e2e/.auth/` isn't ignored already (it is: check)

**Interfaces:**
- Consumes: the proxy, cam-sim (`createCamSim({ name })`).
- Produces: `npm run test:e2e:multi`.

- [ ] **Step 1: The servers**

Create `e2e/multi/env.ts`:

```ts
// Test-only values for the multi-camera e2e run; not secrets.
export const PROXY_PORT = 18680;
export const SIMS = [
  { name: 'Driveway', http: 18700, https: 18701, control: 18702, onvif: 18703, rtsp: 18704 },
  { name: 'Gate', http: 18710, https: 18711, control: 18712, onvif: 18713, rtsp: 18714 },
  { name: 'Garden', http: 18720, https: 18721, control: 18722, onvif: 18723, rtsp: 18724 },
];
export const ADMIN_TOKEN = 'e2e-multi-admin-token-not-a-secret-00000000';
export const CLIENT_TOKEN = 'e2e-multi-client-token-not-a-secret-0000000';
export const STATE_FILE = 'e2e/.auth/multi.json';
```

Create `e2e/multi/start.ts`:

```ts
// The multi-camera e2e servers: three cam-sims and one cam-proxy over them.
import { existsSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createCamSim } from 'cam-sim';
import { loadConfig } from '../../src/config/load';
import { createProxy } from '../../src/proxy';
import { ADMIN_TOKEN, CLIENT_TOKEN, PROXY_PORT, SIMS } from './env';

const tool = (name: string) => (existsSync(join(__dirname, '..', '..', 'tools', name)) ? join(__dirname, '..', '..', 'tools', name) : undefined);
process.env.CAMSIM_MEDIAMTX ??= tool('mediamtx');
const GO2RTC = process.env.CAMPROXY_TEST_GO2RTC ?? tool('go2rtc');

async function main() {
  const sims = await Promise.all(SIMS.map(async (s) => {
    const sim = await createCamSim({ users: [{ name: 'proxy', level: 'admin', password: 'e2e-proxy-pw' }], name: s.name, seedClips: 'demo' });
    const ports = await sim.listen({ http: s.http, https: s.https, control: s.control, onvif: s.onvif, rtsp: s.rtsp }, '127.0.0.1');
    return { sim, ports };
  }));
  const dir = mkdtempSync(join(tmpdir(), 'camproxy-e2e-multi-'));
  writeFileSync(join(dir, 'config.json'), JSON.stringify({
    cameras: sims.map(({ ports }, i) => ({ id: `cam${i + 3}`, host: `127.0.0.1:${ports.http}`, protocol: 'http', user: 'proxy', onvifPort: ports.onvif, rtspPort: ports.rtsp || 554, statusPollS: 5 })),
    events: { onvif: { subscribeMin: 1, pullTimeoutS: 2 } },
    server: { logLevel: 'warn' },
    stills: { enabled: !!GO2RTC },
    // Ruling P1-1: camera i uses these ports + 100*i.
    go2rtc: { binary: GO2RTC ?? 'go2rtc', rtspPort: 18800, apiPort: 18850 },
  }));
  const proxy = createProxy(loadConfig({ CAMPROXY_TOKENS: CLIENT_TOKEN, CAMPROXY_ADMIN_TOKEN: ADMIN_TOKEN, CAMPROXY_CAMERA_PASSWORD: 'e2e-proxy-pw' }, { cwd: dir }));
  await proxy.start({ port: PROXY_PORT, host: '127.0.0.1' });
  const stop = async () => {
    await proxy.stop({ reason: 'e2e' });
    await Promise.all(sims.map((s) => s.sim.close()));
    process.exit(0);
  };
  process.once('SIGINT', () => void stop());
  process.once('SIGTERM', () => void stop());
}

void main();
```

Create `e2e/multi/auth.setup.ts` (as `e2e/auth.setup.ts`, with this run's token and state file):

```ts
import { test as setup, expect } from '@playwright/test';
import { ADMIN_TOKEN, STATE_FILE } from './env';

setup('sign in once', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('token-input').fill(ADMIN_TOKEN);
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('shell')).toBeVisible();
  await page.context().storageState({ path: STATE_FILE });
});
```

Create `playwright.multi.config.ts`:

```ts
import { defineConfig, devices } from '@playwright/test';
import { PROXY_PORT, STATE_FILE } from './e2e/multi/env';

export default defineConfig({
  testDir: 'e2e/multi',
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: { baseURL: `http://127.0.0.1:${PROXY_PORT}`, ...devices['Desktop Chrome'], channel: 'chrome' },
  projects: [
    { name: 'setup', testMatch: /auth\.setup\.ts/ },
    { name: 'e2e', dependencies: ['setup'], testIgnore: /auth\.setup\.ts/, use: { storageState: STATE_FILE } },
  ],
  webServer: { command: 'npx tsx e2e/multi/start.ts', port: PROXY_PORT, reuseExistingServer: !process.env.CI, timeout: 60_000 },
});
```

Add to `package.json` scripts: `"test:e2e:multi": "playwright test -c playwright.multi.config.ts"`. In `playwright.config.ts` add `testIgnore: ['multi/**']` at the top level so the one-camera run never picks these up (keep its project-level `testIgnore` for the setup file).

- [ ] **Step 2: Write the spec**

Create `e2e/multi/picker.spec.ts`:

```ts
import { expect, test } from '@playwright/test';

test('the picker lists the three cameras and switches the Status cards', async ({ page }) => {
  await page.goto('/');
  const picker = page.getByTestId('camera-picker');
  await expect(picker.locator('option')).toHaveCount(3);
  await expect(page.getByTestId('camera-name')).toHaveText('Driveway', { timeout: 15_000 });
  await picker.selectOption('cam4');
  await expect(page.getByTestId('camera-name')).toHaveText('Gate');
  await page.reload();
  await expect(page.getByTestId('camera-picker')).toHaveValue('cam4');
  await expect(page.getByTestId('camera-name')).toHaveText('Gate');
});

test('Maintenance: camera actions wait for a camera route; host actions work', async ({ page }) => {
  await page.goto('/#/maintenance');
  await expect(page.getByTestId('multi-camera-note')).toBeVisible();
});
```

- [ ] **Step 3: Run it**

Run: `npm run build && npm run test:e2e:multi`
Expected: `3 passed` (the setup and two tests).

- [ ] **Step 4: CI**

In `.github/workflows/pr-checks.yml`, in the `e2e` job, after `- run: npm run test:e2e` add `- run: npm run test:e2e:multi`.

- [ ] **Step 5: Commit**

```bash
git add e2e/multi playwright.multi.config.ts playwright.config.ts package.json .github/workflows/pr-checks.yml
git commit -m "test(e2e): three cameras behind one proxy; the camera picker"
```

---

### Task 19: Docs, example, changelog

**Files:**
- Create: `config.cameras.example.json`
- Modify: `README.md`, `CHANGELOG.md`, `CLAUDE.md`, `openapi.yaml`, `docs/raspberry-pi.md` (one line: nothing changes on the Pi)
- Test: `test/config.test.ts` (the new example loads)

- [ ] **Step 1: The example and its test**

Create `config.cameras.example.json`:

```json
{
  "server": { "port": 8480, "dataDir": "data", "logLevel": "info" },
  "poeSwitch": { "model": "sscpoe-web", "host": "192.168.60.2", "ports": 8, "offSeconds": 10 },
  "cameras": [
    { "id": "cam3", "name": "Driveway", "host": "192.168.60.13", "user": "proxy", "poeSwitch": { "port": 1 } },
    { "id": "cam4", "name": "Gate", "host": "192.168.60.14", "user": "proxy", "poeSwitch": { "port": 2 }, "stills": { "intervalS": 2 } }
  ]
}
```

Append to `test/config.test.ts`:

```ts
  it('config.cameras.example.json loads: two cameras, the host switch', () => {
    write('config.json', readFileSync(join(__dirname, '..', 'config.cameras.example.json'), 'utf8'));
    const l = load();
    expect(cameraIds(l.config)).toEqual(['cam3', 'cam4']);
    expect(cameraConfig(l.config, 'cam4')!.poeSwitch).toMatchObject({ host: '192.168.60.2', port: 2 });
  });
```

Run: `npx vitest run test/config.test.ts`
Expected: PASS.

- [ ] **Step 2: README, CLAUDE.md, openapi, Pi doc**

- `README.md`: a section **Several cameras** after the configuration section: `cameras` (a list, config order = display order), the per-camera keys and the closed list of host overrides (copy spec §4.1's list), the host-wide `poeSwitch`, `CAMPROXY_CAMERA_PASSWORD_<ID>`, that a legacy `camera` still works and is never rewritten, what is not there yet in this release (one FTP camera, camera routes for actions/settings, shared go2rtc: "phase 2"), the SSE `?cam=a,b`, `GET /api/cameras` `error`, the health `cameras[]`, and `npm run test:e2e:multi`.
- `CLAUDE.md` first line: "Camera gateway for one or more Reolink cameras: …"; add `npm run test:e2e:multi` to Commands.
- `openapi.yaml`: `/api/cameras` item gains `error`; `/api/stream`'s `cam` parameter says "one id, or several separated by commas"; every `/api/cameras/{cam}/…` operation lists `'503': { description: camera_restarting (Retry-After) }`; `/control/actions/{name}` lists `'400'` `camera_required`; `/control/status` mentions `cameras`.
- `docs/raspberry-pi.md`: one line under updates: "From the multi-camera release on, config.json may keep its `camera` object; nothing on the Pi changes."

- [ ] **Step 3: CHANGELOG**

Under `## Unreleased` in `CHANGELOG.md`:

```markdown
- Several cameras per proxy: `cameras` in config.json (a list), a camera worker each, supervised (a failing camera retries with backoff, the others go on; a camera without an address waits idle). Today's `camera` object still works unchanged.
- `GET /api/cameras` lists every camera, with `error`. A camera being restarted answers `503 camera_restarting`.
- SSE: `?cam=a,b` filters to several cameras.
- Health summary: `cameras[]` and one aggregated item per camera kind; schema 1, the top level is the first camera.
- Audit records name their camera (`labels.camera`) only when they concern one.
- `CAMPROXY_CAMERA_PASSWORD_<ID>` for a camera's own password.
- Admin UI: a camera picker when the proxy has several cameras.
```

- [ ] **Step 4: Full check**

Run: `npm run lint:types && npm test && npm run build && npm run check && npm run test:e2e && npm run test:e2e:multi`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add config.cameras.example.json README.md CHANGELOG.md CLAUDE.md openapi.yaml docs/raspberry-pi.md test/config.test.ts
git commit -m "docs: several cameras per proxy"
```

---

## After the plan (for the coordinator)

- Release when ready (memory: release when ready). After the release, update the Pi (`docker compose pull && docker compose up -d`) and check that `/api/local/health` on the Pi still has `schema: 1`, `camera`, `items` with the same ids, and that the display page renders — the production gate of decision 5.
- cam-proxy needs a CHANGELOG heading PR after the release (memory: release clears CHANGELOG).
