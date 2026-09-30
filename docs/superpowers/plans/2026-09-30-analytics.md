# External Analytics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** cam-proxy sends the still of a person (vehicle, pet) event to Google Vision, within a monthly and daily call limit, stores the objects found, and shows them in Settings, Status, Events, the Timeline and a modal with the boxes.

**Architecture:** A new `src/analytics/` module: a provider interface with one implementation (Google Vision over `fetch`), and a service that listens to camera-event starts on the stream log, picks the still at start + 1 s, checks the limits, calls the provider one event at a time, and stores the result in a new `analyses` table (and a JPEG copy). The client API adds `analysis` to events and two endpoints; the control API reports usage. The web UI gets an Analytics settings card, Status cards, an Events column, Timeline marks and a modal.

**Tech Stack:** TypeScript (Node 24, `node:sqlite`), Express 5, Svelte 5 (runes), Vitest, Playwright. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-30-analytics-design.md`

## Global Constraints

- cam-proxy only; cams is not changed (it ignores the new `analysis` field).
- The key comes only from the environment: `CAMPROXY_GOOGLE_VISION_KEY` (or `CAMPROXY_GOOGLE_VISION_KEY_FILE`); base URL `CAMPROXY_GOOGLE_VISION_URL`, default `https://vision.googleapis.com`. The key is never logged, never returned in full, never put in a URL: `X-Goog-Api-Key` header only.
- Masked key: first 4 + `…` + last 4 characters; keys shorter than 12 characters show as `set`.
- Defaults make no calls: Google Vision disabled, `monthlyLimit` 0, `dailyCap` 0 (0 = no daily cap), kinds: person only.
- Limits count calls sent, per provider, per camera-local day; the month is the camera-local calendar month.
- Features: `OBJECT_LOCALIZATION` only, `maxResults` 20: 1 unit per call.
- Motion events are never analysed.
- Image: the still at `start + 1000 ms`; else the nearest within ±2000 ms; wait for it at most 5000 ms.
- One call at a time; 10 s timeout; one retry after 30 s for timeout, network error and HTTP 5xx.
- 400/403 → `bad_key`, pause until settings or key change or restart; 429 → `quota`, pause 1 h.
- After a restart, events from the last 10 minutes that passed the filter and have no analysis are queued again.
- Analytics colour: purple `#a855f7`. Event-kind colours stay: person `#ef4444`, vehicle `#3b82f6`, pet `#22c55e`, motion `#f59e0b`.
- Real Google calls never run in CI; tests use the mock server.
- Test content (stills, clips) is never committed or pushed.

## Rulings made while planning (against the spec's letter)

- **Settings shape:** the settings schema (`src/config/schema.ts`) has no arrays. So `analytics.kinds` is an object of booleans (`{ person, vehicle, pet }`), and providers are named keys (`analytics.googleVision: { enabled, monthlyLimit, dailyCap }`). The code keeps the provider list in `PROVIDERS` (`src/analytics/providers.ts`), so a second provider is one more key plus one more entry. All kinds false is allowed: nothing is analysed, and the Settings card says so. *Cost if wrong: renaming the keys in overrides.json.*
- **Events page:** its table has no duration column, so the tag goes into a new last column, "analysis". *Cost if wrong: moving one cell.*
- **Status data:** `/control/status` gains `analytics` (the same list `/control/analytics` returns), so the Status page updates with its existing polling. *Cost if wrong: one extra endpoint call.*
- The unused `annotations` table from migration 1 stays unused; the spec's `analyses` table is new.

## Review Focus

1. **A second event of the same kind while the first is still waiting for its still.** Both must be queued and analysed in order, each with its own still, and neither blocks the other past 5 s. (Task 4, test "two events in a row".)
2. **The month changes while the proxy runs** (camera-local midnight on the 1st). The month count starts at 0, and the day count resets at local midnight, in the camera's zone, not the container's (UTC). (Task 4, test "counts per camera-local day and month".)
3. **Settings changed while a call is paused** for `bad_key`. Saving any `analytics.googleVision` setting lifts the pause. (Task 4, test "a settings change lifts a bad_key pause".)
4. **An event deleted by retention while its analysis is queued.** Storing the result must not fail on the foreign key or crash the queue; the result is dropped. (Task 4, test "the event is gone by the time the result comes".)
5. **Google answers 200 with an `error` inside `responses[0]`**, e.g. a bad image. That is `failed`, reason `bad_response` (or the mapped reason), not `ok` with no objects. (Task 3, test "an error inside responses[0]".)

---

## File Structure

| File | Responsibility |
|---|---|
| `src/config/defaults.ts` (modify) | `Config.analytics`, its defaults; `Secrets.googleVisionKey?`, `Secrets.googleVisionUrl` |
| `src/config/schema.ts` (modify) | `analytics` settings with limits |
| `src/config/secrets.ts` (modify) | read the key and URL |
| `src/catalog/migrations.ts` (modify) | migration 3: `analyses`, `analytics_usage` |
| `src/catalog/analyses.ts` (create) | reading and writing analyses and usage |
| `src/analytics/providers.ts` (create) | provider interface, `PROVIDERS`, `AnalyticsError`, `maskKey` |
| `src/analytics/google-vision.ts` (create) | the Google Vision provider |
| `src/analytics/local-day.ts` (create) | a timestamp → camera-local `YYYY-MM-DD` |
| `src/analytics/service.ts` (create) | filter, still, limits, queue, retry, pause, storing, state |
| `src/clips/indexer.ts` (modify) | export `dstBounds` |
| `src/stream/log.ts` (modify) | stream type `analysis` |
| `src/proxy.ts` (modify) | create and wire the service |
| `src/api/client-api.ts` (modify) | `analysis` in events; `/events/:id/analysis(.jpg)` |
| `src/api/control-api.ts` (modify) | `/control/analytics`; `analytics` in `/control/status` |
| `src/storage.ts` (modify) | delete JPEG copies whose analysis is gone |
| `openapi.yaml`, `README.md`, `CHANGELOG.md`, `.env.example` (modify) | docs |
| `test/helpers/vision-mock.ts` (create) | the mock Google server |
| `web/src/lib/analytics.ts` (create) | tag text, estimate, box helpers (pure) |
| `web/src/components/AnalyticsSettings.svelte` (create) | the Settings card |
| `web/src/components/AnalysisModal.svelte` (create) | the modal |
| `web/src/pages/Settings.svelte`, `Status.svelte`, `Events.svelte`, `Timeline.svelte` (modify) | the UI |
| `e2e/start.ts`, `e2e/env.ts` (modify), `e2e/analytics.spec.ts` (create) | e2e with the mock |
| `scripts/analytics-live.ts` (create) | manual real-Google check |

---

### Task 1: Settings and secrets

**Files:**
- Modify: `src/config/defaults.ts`, `src/config/schema.ts`, `src/config/secrets.ts`
- Create: `src/analytics/providers.ts` (only `maskKey` and `PROVIDERS` in this task)
- Test: `test/analytics-config.test.ts`

**Interfaces:**
- Produces:
  - `Config['analytics']: { kinds: { person: boolean; vehicle: boolean; pet: boolean }; googleVision: { enabled: boolean; monthlyLimit: number; dailyCap: number } }`
  - `Secrets.googleVisionKey?: string`, `Secrets.googleVisionUrl: string`
  - `maskKey(key: string | undefined): string | null`
  - `PROVIDERS: readonly { id: 'google-vision'; name: 'Google Vision'; configKey: 'googleVision'; keyEnv: 'CAMPROXY_GOOGLE_VISION_KEY' }[]`
  - `type ProviderId = 'google-vision'`

- [ ] **Step 1: Write the failing test**

```ts
// test/analytics-config.test.ts
import { describe, expect, it } from 'vitest';
import { DEFAULTS } from '../src/config/defaults';
import { checkPartial, SettingError } from '../src/config/schema';
import { loadSecrets } from '../src/config/secrets';
import { maskKey, PROVIDERS } from '../src/analytics/providers';

const env = { CAMPROXY_TOKENS: 'c'.repeat(32), CAMPROXY_ADMIN_TOKEN: 'a'.repeat(32), CAMPROXY_CAMERA_PASSWORD: 'pw' };

describe('analytics settings', () => {
  it('default to no calls: disabled, limit 0, person only', () => {
    expect(DEFAULTS.analytics).toEqual({
      kinds: { person: true, vehicle: false, pet: false },
      googleVision: { enabled: false, monthlyLimit: 0, dailyCap: 0 },
    });
  });

  it('accept valid values', () => {
    expect(() => checkPartial({ analytics: { kinds: { vehicle: true }, googleVision: { enabled: true, monthlyLimit: 1000, dailyCap: 50 } } })).not.toThrow();
  });

  it.each([
    [{ analytics: { kinds: { motion: true } } }, 'analytics.kinds.motion: unknown setting'],
    [{ analytics: { googleVision: { monthlyLimit: -1 } } }, 'analytics.googleVision.monthlyLimit: must be from 0 to 100000'],
    [{ analytics: { googleVision: { dailyCap: 10001 } } }, 'analytics.googleVision.dailyCap: must be from 0 to 10000'],
    [{ analytics: { googleVision: { enabled: 'yes' } } }, 'analytics.googleVision.enabled: must be true or false'],
    [{ analytics: { roboflow: {} } }, 'analytics.roboflow: unknown setting'],
  ])('reject %j', (obj, message) => {
    expect(() => checkPartial(obj)).toThrow(new SettingError(message));
  });
});

describe('the Vision key and URL', () => {
  it('come from the environment, with Google as the default URL', () => {
    expect(loadSecrets(env, false)).toMatchObject({ googleVisionUrl: 'https://vision.googleapis.com' });
    expect(loadSecrets(env, false).googleVisionKey).toBeUndefined();
    const s = loadSecrets({ ...env, CAMPROXY_GOOGLE_VISION_KEY: 'AIzaSyExample1234x7Qk', CAMPROXY_GOOGLE_VISION_URL: 'http://127.0.0.1:9' }, false);
    expect(s.googleVisionKey).toBe('AIzaSyExample1234x7Qk');
    expect(s.googleVisionUrl).toBe('http://127.0.0.1:9');
  });

  it('reject a URL that is not http(s), without echoing it', () => {
    expect(() => loadSecrets({ ...env, CAMPROXY_GOOGLE_VISION_URL: 'ftp://x' }, false)).toThrow('CAMPROXY_GOOGLE_VISION_URL: must be an http(s) URL');
  });

  it('are masked: first and last four characters', () => {
    expect(maskKey('AIzaSyExample1234x7Qk')).toBe('AIza…x7Qk');
    expect(maskKey('short')).toBe('set');
    expect(maskKey(undefined)).toBeNull();
  });

  it('name the provider list', () => {
    expect(PROVIDERS.map((p) => p.id)).toEqual(['google-vision']);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run test/analytics-config.test.ts`
Expected: FAIL, `Cannot find module '../src/analytics/providers'`.

- [ ] **Step 3: Implement**

In `src/config/defaults.ts`, add to `interface Config` (after `ftp`):

```ts
  // External analytics (spec 2026-09-30-analytics-design): which event kinds,
  // and per provider its switch and call limits. 0 = no calls.
  analytics: {
    kinds: { person: boolean; vehicle: boolean; pet: boolean };
    googleVision: { enabled: boolean; monthlyLimit: number; dailyCap: number };
  };
```

to `DEFAULTS` (after `ftp`):

```ts
  analytics: {
    kinds: { person: true, vehicle: false, pet: false },
    googleVision: { enabled: false, monthlyLimit: 0, dailyCap: 0 },
  },
```

and to `interface Secrets`:

```ts
  googleVisionKey?: string;
  googleVisionUrl: string; // not a secret; read with them (default Google's)
```

In `src/config/schema.ts`, add to `SETTINGS` (after `ftp`):

```ts
  analytics: {
    kinds: {
      person: { type: 'boolean', doc: 'analyse person events' },
      vehicle: { type: 'boolean', doc: 'analyse vehicle events' },
      pet: { type: 'boolean', doc: 'analyse pet events' },
    },
    googleVision: {
      enabled: { type: 'boolean', doc: 'send event stills to Google Vision (needs CAMPROXY_GOOGLE_VISION_KEY)' },
      monthlyLimit: int(0, 100000, 'Google Vision calls per calendar month (camera time); 0 = none'),
      dailyCap: int(0, 10000, 'Google Vision calls per day at most; 0 = no daily cap'),
    },
  },
```

In `src/config/secrets.ts`, before the `return` of `loadSecrets`:

```ts
  const googleVisionKey = read(env, 'CAMPROXY_GOOGLE_VISION_KEY');
  const googleVisionUrl = env.CAMPROXY_GOOGLE_VISION_URL || 'https://vision.googleapis.com';
  if (!/^https?:\/\/[^\s]+$/.test(googleVisionUrl)) throw new SettingError('CAMPROXY_GOOGLE_VISION_URL: must be an http(s) URL');
```

and change the return to:

```ts
  return { tokens, adminToken, cameraPassword, ...(ftpPassword ? { ftpPassword } : {}), ...(googleVisionKey ? { googleVisionKey } : {}), googleVisionUrl: googleVisionUrl.replace(/\/+$/, '') };
```

Create `src/analytics/providers.ts`:

```ts
// External analytics providers (spec 2026-09-30-analytics-design). One entry
// per provider; its settings live under analytics.<configKey>.
export type ProviderId = 'google-vision';

export const PROVIDERS = [
  { id: 'google-vision', name: 'Google Vision', configKey: 'googleVision', keyEnv: 'CAMPROXY_GOOGLE_VISION_KEY' },
] as const satisfies readonly { id: ProviderId; name: string; configKey: 'googleVision'; keyEnv: string }[];

// The key as the UI may show it: first and last four characters.
export function maskKey(key: string | undefined): string | null {
  if (!key) return null;
  if (key.length < 12) return 'set';
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}
```

- [ ] **Step 4: Run the test and the config tests**

Run: `npx vitest run test/analytics-config.test.ts test/config.test.ts`
Expected: PASS. If `test/config.test.ts` compares the full `DEFAULTS` or the generated `config.schema.json`, regenerate the schema file with the repo's existing script (`grep -n schema package.json` names it) and update the expectation to include `analytics`.

- [ ] **Step 5: Commit**

```bash
git add src/config/defaults.ts src/config/schema.ts src/config/secrets.ts src/analytics/providers.ts test/analytics-config.test.ts
git commit -m "feat(analytics): settings, key and URL from the environment"
```

(Add `config.schema.json` to the `git add` if Step 4 regenerated it.)

---

### Task 2: Storage (migration 3 and `src/catalog/analyses.ts`)

**Files:**
- Modify: `src/catalog/migrations.ts`
- Create: `src/catalog/analyses.ts`
- Test: `test/catalog-analyses.test.ts`

**Interfaces:**
- Consumes: `openCatalog(file)`, `insertEvent(c, {...})`, `deleteEventsBefore(c, ts)` (existing).
- Produces:
  - `type AnalysisStatus = 'ok' | 'skipped' | 'failed'`
  - `interface AnalysisRow { id: number; event_id: number; provider: string; status: AnalysisStatus; reason: string | null; still_ts: number | null; image: string | null; requested_at: number; took_ms: number | null; objects: string | null; raw: string | null }`
  - `saveAnalysis(c: Catalog, r: Omit<AnalysisRow, 'id'>): AnalysisRow | null` (null when the event is gone)
  - `analysisFor(c: Catalog, eventId: number): AnalysisRow | undefined` (the latest row of any provider)
  - `analysesFor(c: Catalog, eventIds: number[]): Map<number, AnalysisRow>`
  - `addUsage(c: Catalog, provider: string, day: string): void` (+1)
  - `usageBetween(c: Catalog, provider: string, fromDay: string, toDay: string): number` (inclusive)
  - `pruneUsage(c: Catalog, beforeDay: string): number`
  - `unanalysed(c: Catalog, cam: string, kinds: string[], since: number): { id: number; kind: string; start_ts: number }[]`
  - `analysisImages(c: Catalog): Set<string>`

- [ ] **Step 1: Write the failing test**

```ts
// test/catalog-analyses.test.ts
import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { openCatalog } from '../src/catalog/db';
import { deleteEventsBefore, insertEvent } from '../src/catalog/events';
import { addUsage, analysesFor, analysisFor, analysisImages, pruneUsage, saveAnalysis, unanalysed, usageBetween } from '../src/catalog/analyses';

const fresh = () => openCatalog(join(mkdtempSync(join(tmpdir(), 'camproxy-an-')), 'catalog.sqlite'));
const row = (event_id: number, over: object = {}) => ({
  event_id, provider: 'google-vision', status: 'ok' as const, reason: null, still_ts: 1000, image: `/d/${event_id}.jpg`,
  requested_at: 2000, took_ms: 300, objects: '[{"name":"Person","score":0.9,"box":{"x0":0,"y0":0,"x1":1,"y1":1}}]', raw: '{}', ...over,
});

describe('analyses', () => {
  it('migrate to version 3', () => {
    expect(fresh().schemaVersion()).toBe(3);
  });

  it('store one per event and provider, the latest winning', () => {
    const c = fresh();
    const e = insertEvent(c, { cam: 'cam1', source: 'onvif', kind: 'person', start_ts: 1000, raw: null });
    saveAnalysis(c, row(e.id, { status: 'skipped', reason: 'limit', objects: null }));
    saveAnalysis(c, row(e.id));
    expect(analysisFor(c, e.id)).toMatchObject({ status: 'ok', reason: null });
    expect(analysesFor(c, [e.id, 999]).size).toBe(1);
  });

  it('drop a result whose event is gone, instead of failing', () => {
    const c = fresh();
    expect(saveAnalysis(c, row(424242))).toBeNull();
  });

  it('are deleted with their event', () => {
    const c = fresh();
    const e = insertEvent(c, { cam: 'cam1', source: 'onvif', kind: 'person', start_ts: 1000, raw: null });
    saveAnalysis(c, row(e.id));
    expect(analysisImages(c)).toEqual(new Set([`/d/${e.id}.jpg`]));
    deleteEventsBefore(c, 5000);
    expect(analysisFor(c, e.id)).toBeUndefined();
    expect(analysisImages(c).size).toBe(0);
  });

  it('list events of the chosen kinds without an analysis, since a time', () => {
    const c = fresh();
    const a = insertEvent(c, { cam: 'cam1', source: 'onvif', kind: 'person', start_ts: 10_000, raw: null });
    const b = insertEvent(c, { cam: 'cam1', source: 'onvif', kind: 'person', start_ts: 20_000, raw: null });
    insertEvent(c, { cam: 'cam1', source: 'onvif', kind: 'motion', start_ts: 20_000, raw: null });
    insertEvent(c, { cam: 'cam1', source: 'onvif', kind: 'person', start_ts: 1_000, raw: null }); // too old
    saveAnalysis(c, row(a.id));
    expect(unanalysed(c, 'cam1', ['person'], 5_000).map((e) => e.id)).toEqual([b.id]);
    expect(unanalysed(c, 'cam1', [], 5_000)).toEqual([]);
  });
});

describe('usage', () => {
  it('counts calls per provider per day, summed over a range', () => {
    const c = fresh();
    addUsage(c, 'google-vision', '2026-09-30');
    addUsage(c, 'google-vision', '2026-09-30');
    addUsage(c, 'google-vision', '2026-10-01');
    expect(usageBetween(c, 'google-vision', '2026-09-01', '2026-09-30')).toBe(2);
    expect(usageBetween(c, 'google-vision', '2026-10-01', '2026-10-31')).toBe(1);
    expect(usageBetween(c, 'other', '2026-01-01', '2026-12-31')).toBe(0);
    expect(pruneUsage(c, '2026-10-01')).toBe(1);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run test/catalog-analyses.test.ts`
Expected: FAIL, `Cannot find module '../src/catalog/analyses'`.

- [ ] **Step 3: Implement**

Append to `MIGRATIONS` in `src/catalog/migrations.ts`:

```ts
  // 3: external analytics (spec 2026-09-30-analytics-design): one result per
  // event and provider, deleted with its event; calls per provider per day.
  `
  CREATE TABLE analyses (
    id INTEGER PRIMARY KEY,
    event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    status TEXT NOT NULL,
    reason TEXT,
    still_ts INTEGER,
    image TEXT,
    requested_at INTEGER NOT NULL,
    took_ms INTEGER,
    objects TEXT,
    raw TEXT,
    UNIQUE (event_id, provider)
  );
  CREATE TABLE analytics_usage (
    provider TEXT NOT NULL,
    day TEXT NOT NULL,
    calls INTEGER NOT NULL,
    PRIMARY KEY (provider, day)
  );
  `,
```

Create `src/catalog/analyses.ts`:

```ts
import type { Catalog } from './db';

// External analytics results and call counts (spec 2026-09-30-analytics-design).
export type AnalysisStatus = 'ok' | 'skipped' | 'failed';
export interface AnalysisRow {
  id: number;
  event_id: number;
  provider: string;
  status: AnalysisStatus;
  reason: string | null;
  still_ts: number | null;
  image: string | null;
  requested_at: number;
  took_ms: number | null;
  objects: string | null; // JSON [{name, score, box}]
  raw: string | null; // JSON
}

// Stores (or replaces) the result for an event and provider. Null when the
// event was deleted meanwhile (retention): the result is dropped.
export function saveAnalysis(c: Catalog, r: Omit<AnalysisRow, 'id'>): AnalysisRow | null {
  const exists = c.db.prepare('SELECT 1 FROM events WHERE id = ?').get(r.event_id);
  if (!exists) return null;
  return c.db
    .prepare(
      `INSERT INTO analyses (event_id, provider, status, reason, still_ts, image, requested_at, took_ms, objects, raw)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (event_id, provider) DO UPDATE SET status = excluded.status, reason = excluded.reason, still_ts = excluded.still_ts,
         image = excluded.image, requested_at = excluded.requested_at, took_ms = excluded.took_ms, objects = excluded.objects, raw = excluded.raw
       RETURNING *`,
    )
    .get(r.event_id, r.provider, r.status, r.reason, r.still_ts, r.image, r.requested_at, r.took_ms, r.objects, r.raw) as unknown as AnalysisRow;
}

export function analysisFor(c: Catalog, eventId: number): AnalysisRow | undefined {
  return c.db.prepare('SELECT * FROM analyses WHERE event_id = ? ORDER BY requested_at DESC, id DESC LIMIT 1').get(eventId) as unknown as AnalysisRow | undefined;
}

export function analysesFor(c: Catalog, eventIds: number[]): Map<number, AnalysisRow> {
  const out = new Map<number, AnalysisRow>();
  if (!eventIds.length) return out;
  const rows = c.db
    .prepare(`SELECT * FROM analyses WHERE event_id IN (${eventIds.map(() => '?').join(',')}) ORDER BY requested_at, id`)
    .all(...eventIds) as unknown as AnalysisRow[];
  for (const r of rows) out.set(r.event_id, r); // the latest wins
  return out;
}

export function addUsage(c: Catalog, provider: string, day: string): void {
  c.db.prepare('INSERT INTO analytics_usage (provider, day, calls) VALUES (?, ?, 1) ON CONFLICT (provider, day) DO UPDATE SET calls = calls + 1').run(provider, day);
}

export function usageBetween(c: Catalog, provider: string, fromDay: string, toDay: string): number {
  const r = c.db.prepare('SELECT COALESCE(SUM(calls), 0) AS n FROM analytics_usage WHERE provider = ? AND day >= ? AND day <= ?').get(provider, fromDay, toDay) as { n: number };
  return r.n;
}

export function pruneUsage(c: Catalog, beforeDay: string): number {
  return Number(c.db.prepare('DELETE FROM analytics_usage WHERE day < ?').run(beforeDay).changes);
}

// Events of the given kinds since a time that have no analysis (any provider).
export function unanalysed(c: Catalog, cam: string, kinds: string[], since: number): { id: number; kind: string; start_ts: number }[] {
  if (!kinds.length) return [];
  return c.db
    .prepare(
      `SELECT e.id, e.kind, e.start_ts FROM events e
       WHERE e.cam = ? AND e.start_ts >= ? AND e.kind IN (${kinds.map(() => '?').join(',')})
         AND NOT EXISTS (SELECT 1 FROM analyses a WHERE a.event_id = e.id)
       ORDER BY e.start_ts, e.id`,
    )
    .all(cam, since, ...kinds) as { id: number; kind: string; start_ts: number }[];
}

export function analysisImages(c: Catalog): Set<string> {
  return new Set((c.db.prepare('SELECT image FROM analyses WHERE image IS NOT NULL').all() as { image: string }[]).map((r) => r.image));
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/catalog-analyses.test.ts test/catalog.test.ts`
Expected: PASS. If `test/catalog.test.ts` asserts `schemaVersion()` is 2, change it to 3.

- [ ] **Step 5: Commit**

```bash
git add src/catalog/migrations.ts src/catalog/analyses.ts test/catalog-analyses.test.ts test/catalog.test.ts
git commit -m "feat(analytics): analyses and usage tables"
```

---

### Task 3: The Google Vision provider and the mock server

**Files:**
- Modify: `src/analytics/providers.ts`
- Create: `src/analytics/google-vision.ts`, `test/helpers/vision-mock.ts`
- Test: `test/analytics-google.test.ts`

**Interfaces:**
- Consumes: `ProviderId` (Task 1).
- Produces:
  - `interface Box { x0: number; y0: number; x1: number; y1: number }`
  - `interface Found { name: string; score: number; box: Box }`
  - `interface ProviderResult { objects: Found[]; raw: unknown }`
  - `interface AnalyticsProvider { id: ProviderId; name: string; analyze(jpeg: Buffer, signal: AbortSignal): Promise<ProviderResult> }`
  - `class AnalyticsError extends Error { reason: string; retry: boolean; pause: 'bad_key' | 'quota' | null }`
  - `googleVision(o: { key: string; baseUrl: string }): AnalyticsProvider`
  - `startVisionMock(o?: { key?: string }): Promise<VisionMock>` where `VisionMock = { url: string; calls: number; lastKeyHeader: string | undefined; lastUrl: string | undefined; script: MockAnswer[]; close(): Promise<void> }` and `type MockAnswer = { objects?: { name: string; score: number; vertices: { x?: number; y?: number }[] }[]; status?: number; body?: unknown; delayMs?: number }`. An empty `script` answers one person at 0.9 over the whole picture.

- [ ] **Step 1: Write the mock and the failing test**

```ts
// test/helpers/vision-mock.ts
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';

// A stand-in for Google Vision's images:annotate (spec: tests never call
// Google). Answers from `script` in order (the last one repeats); counts calls.
export type MockAnswer = {
  objects?: { name: string; score: number; vertices: { x?: number; y?: number }[] }[];
  status?: number;
  body?: unknown;
  delayMs?: number;
};
export interface VisionMock {
  url: string;
  calls: number;
  lastKeyHeader: string | undefined;
  lastUrl: string | undefined;
  script: MockAnswer[];
  close(): Promise<void>;
}

const PERSON = { name: 'Person', score: 0.9, vertices: [{ x: 0.1, y: 0.2 }, { x: 0.4, y: 0.2 }, { x: 0.4, y: 0.9 }, { x: 0.1, y: 0.9 }] };

export async function startVisionMock(o: { key?: string } = {}): Promise<VisionMock> {
  const key = o.key ?? 'mock-vision-key-000000';
  let server: Server;
  const mock: VisionMock = {
    url: '',
    calls: 0,
    lastKeyHeader: undefined,
    lastUrl: undefined,
    script: [],
    close: () => new Promise((r) => server.close(() => r())),
  };
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', async () => {
      mock.calls++;
      mock.lastUrl = req.url;
      mock.lastKeyHeader = req.headers['x-goog-api-key'] as string | undefined;
      const answer = mock.script.length > 1 ? mock.script.shift()! : (mock.script[0] ?? {});
      if (answer.delayMs) await new Promise((r) => setTimeout(r, answer.delayMs));
      if (req.method !== 'POST' || req.url !== '/v1/images:annotate') return void res.writeHead(404).end();
      if (mock.lastKeyHeader !== key) {
        res.writeHead(403, { 'content-type': 'application/json' });
        return void res.end(JSON.stringify({ error: { code: 403, status: 'PERMISSION_DENIED', message: 'API key not valid.' } }));
      }
      const status = answer.status ?? 200;
      res.writeHead(status, { 'content-type': 'application/json' });
      if (answer.body !== undefined) return void res.end(JSON.stringify(answer.body));
      if (status !== 200) return void res.end(JSON.stringify({ error: { code: status, status: 'ERROR', message: 'mock error' } }));
      const objects = answer.objects ?? [PERSON];
      res.end(JSON.stringify({ responses: [{ localizedObjectAnnotations: objects.map((x) => ({ name: x.name, score: x.score, boundingPoly: { normalizedVertices: x.vertices } })) }] }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  mock.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return mock;
}
```

```ts
// test/analytics-google.test.ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { googleVision } from '../src/analytics/google-vision';
import { AnalyticsError } from '../src/analytics/providers';
import { startVisionMock, type VisionMock } from './helpers/vision-mock';

let mock: VisionMock;
beforeAll(async () => (mock = await startVisionMock({ key: 'k-123456789012' })));
afterAll(() => mock.close());
beforeEach(() => (mock.script = []));
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
const call = (key = 'k-123456789012') => googleVision({ key, baseUrl: mock.url }).analyze(jpeg, AbortSignal.timeout(5000));
const fail = async (key?: string) => {
  try {
    await call(key);
  } catch (e) {
    return e as AnalyticsError;
  }
  throw new Error('no error');
};

describe('Google Vision provider', () => {
  it('sends the key in a header, never the URL, and asks for objects only', async () => {
    await call();
    expect(mock.lastKeyHeader).toBe('k-123456789012');
    expect(mock.lastUrl).toBe('/v1/images:annotate');
  });

  it('maps objects to name, score and box (fractions), missing coordinates as 0', async () => {
    mock.script = [{ objects: [{ name: 'Car', score: 0.81, vertices: [{ y: 0.38 }, { x: 0.55, y: 0.38 }, { x: 0.55, y: 0.65 }, { x: 0.27, y: 0.65 }] }] }];
    const r = await call();
    expect(r.objects).toEqual([{ name: 'Car', score: 0.81, box: { x0: 0, y0: 0.38, x1: 0.55, y1: 0.65 } }]);
    expect(r.raw).toEqual({ localizedObjectAnnotations: expect.any(Array) });
  });

  it('answers no objects as an empty list', async () => {
    mock.script = [{ body: { responses: [{}] } }];
    expect((await call()).objects).toEqual([]);
  });

  it.each([
    [{ status: 403 }, 'bad_key', false, 'bad_key'],
    [{ status: 400 }, 'bad_key', false, 'bad_key'],
    [{ status: 429 }, 'quota', false, 'quota'],
    [{ status: 503 }, 'http_5xx', true, null],
    [{ status: 418 }, 'http_418', false, null],
  ])('maps %j to %s', async (answer, reason, retry, pause) => {
    mock.script = [answer];
    expect(await fail()).toMatchObject({ reason, retry, pause });
  });

  it('maps a wrong key (the mock refuses it) to bad_key', async () => {
    expect(await fail('wrong-key-0000')).toMatchObject({ reason: 'bad_key', pause: 'bad_key' });
  });

  // Review focus 5.
  it('treats an error inside responses[0] as a failure, not as nothing found', async () => {
    mock.script = [{ body: { responses: [{ error: { code: 3, message: 'Bad image data.' } }] } }];
    expect(await fail()).toMatchObject({ reason: 'bad_response', retry: false });
  });

  it('treats an unexpected body as bad_response', async () => {
    mock.script = [{ body: { hello: 1 } }];
    expect(await fail()).toMatchObject({ reason: 'bad_response' });
  });

  it('turns an abort into a retryable timeout', async () => {
    mock.script = [{ delayMs: 500 }];
    await expect(googleVision({ key: 'k-123456789012', baseUrl: mock.url }).analyze(jpeg, AbortSignal.timeout(50))).rejects.toMatchObject({ reason: 'timeout', retry: true });
  });

  it('turns a refused connection into a retryable network error', async () => {
    await expect(googleVision({ key: 'k', baseUrl: 'http://127.0.0.1:9' }).analyze(jpeg, AbortSignal.timeout(2000))).rejects.toMatchObject({ reason: 'network', retry: true });
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run test/analytics-google.test.ts`
Expected: FAIL, `Cannot find module '../src/analytics/google-vision'`.

- [ ] **Step 3: Implement**

Append to `src/analytics/providers.ts`:

```ts
export interface Box { x0: number; y0: number; x1: number; y1: number } // fractions 0–1
export interface Found { name: string; score: number; box: Box }
export interface ProviderResult { objects: Found[]; raw: unknown }
export interface AnalyticsProvider {
  id: ProviderId;
  name: string;
  analyze(jpeg: Buffer, signal: AbortSignal): Promise<ProviderResult>;
}

// A failed call: `reason` is stored, `retry` allows one more try after 30 s,
// `pause` stops the provider (bad_key: until settings/key change; quota: 1 h).
export class AnalyticsError extends Error {
  constructor(
    readonly reason: string,
    readonly retry: boolean,
    readonly pause: 'bad_key' | 'quota' | null = null,
  ) {
    super(reason);
  }
}
```

Create `src/analytics/google-vision.ts`:

```ts
import { AnalyticsError, type AnalyticsProvider, type Found } from './providers';

type Vertex = { x?: number; y?: number };
type Annotation = { name?: unknown; score?: unknown; boundingPoly?: { normalizedVertices?: Vertex[] } };

// Google Cloud Vision, object localization only (1 unit per image). The key
// goes in X-Goog-Api-Key, never in the URL (it would reach logs).
export function googleVision(o: { key: string; baseUrl: string }): AnalyticsProvider {
  return {
    id: 'google-vision',
    name: 'Google Vision',
    async analyze(jpeg, signal) {
      let res: Response;
      try {
        res = await fetch(`${o.baseUrl}/v1/images:annotate`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-goog-api-key': o.key },
          body: JSON.stringify({ requests: [{ image: { content: jpeg.toString('base64') }, features: [{ type: 'OBJECT_LOCALIZATION', maxResults: 20 }] }] }),
          signal,
        });
      } catch (err) {
        if (signal.aborted) throw new AnalyticsError('timeout', true);
        throw new AnalyticsError('network', true);
      }
      if (res.status === 400 || res.status === 401 || res.status === 403) throw new AnalyticsError('bad_key', false, 'bad_key');
      if (res.status === 429) throw new AnalyticsError('quota', false, 'quota');
      if (res.status >= 500) throw new AnalyticsError('http_5xx', true);
      if (res.status !== 200) throw new AnalyticsError(`http_${res.status}`, false);
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        throw new AnalyticsError('bad_response', false);
      }
      const first = (body as { responses?: unknown[] })?.responses?.[0] as { error?: unknown; localizedObjectAnnotations?: Annotation[] } | undefined;
      if (!first || typeof first !== 'object' || first.error) throw new AnalyticsError('bad_response', false);
      const anns = Array.isArray(first.localizedObjectAnnotations) ? first.localizedObjectAnnotations : [];
      const objects: Found[] = anns.map((a) => {
        const v = a.boundingPoly?.normalizedVertices ?? [];
        const xs = v.map((p) => p.x ?? 0);
        const ys = v.map((p) => p.y ?? 0);
        return {
          name: String(a.name ?? 'object'),
          score: typeof a.score === 'number' ? a.score : 0,
          box: { x0: Math.min(1, ...xs), y0: Math.min(1, ...ys), x1: Math.max(0, ...xs), y1: Math.max(0, ...ys) },
        };
      });
      return { objects, raw: { localizedObjectAnnotations: anns } };
    },
  };
}
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run test/analytics-google.test.ts`
Expected: PASS (13 tests).

- [ ] **Step 5: Commit**

```bash
git add src/analytics/providers.ts src/analytics/google-vision.ts test/helpers/vision-mock.ts test/analytics-google.test.ts
git commit -m "feat(analytics): Google Vision provider and a mock server for tests"
```

---

### Task 4: The analytics service

**Files:**
- Create: `src/analytics/local-day.ts`, `src/analytics/service.ts`
- Modify: `src/clips/indexer.ts` (export `dstBounds`)
- Test: `test/analytics-service.test.ts`

**Interfaces:**
- Consumes: Tasks 1–3 (`Config['analytics']`, `PROVIDERS`, `maskKey`, `AnalyticsProvider`, `AnalyticsError`, `saveAnalysis`, `addUsage`, `usageBetween`, `unanalysed`), `StreamLog.append(cam, type, data)`, `TimeInfo` (`src/camera/time.ts`).
- Produces:
  - `localDay(ts: number, t: TimeInfo | undefined): string` (`YYYY-MM-DD`; without `t`, UTC)
  - `interface ProviderState { id: string; name: string; enabled: boolean; keyMasked: string | null; month: { calls: number; limit: number }; today: { calls: number; cap: number }; paused: { reason: string; until: number | null } | null; lastCall: { at: number; tookMs: number; status: string } | null; lastError: string | null }`
  - `class AnalyticsService` with `constructor(d: AnalyticsDeps)`, `onEvent(e: { id: number; kind: string; start_ts: number }): void`, `catchUp(): void`, `settingsChanged(): void`, `state(): ProviderState[]`, `idle(): Promise<void>` (tests), `stop(): void`
  - `interface AnalyticsDeps { catalog: Catalog; log: StreamLog; cam: string; dataDir: string; config: () => Config; secrets: () => { googleVisionKey?: string; googleVisionUrl: string }; readStill: (ts: number) => Promise<Buffer | undefined>; listStills: (from: number, to: number) => number[]; timeInfo: () => TimeInfo | undefined; now?: () => number; sleep?: (ms: number) => Promise<void>; provider?: (id: ProviderId, key: string, baseUrl: string) => AnalyticsProvider }`

- [ ] **Step 1: Write the failing test**

```ts
// test/analytics-service.test.ts
import { beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { openCatalog, type Catalog } from '../src/catalog/db';
import { deleteEventsBefore, insertEvent } from '../src/catalog/events';
import { analysisFor } from '../src/catalog/analyses';
import { StreamLog } from '../src/stream/log';
import { DEFAULTS, type Config } from '../src/config/defaults';
import { AnalyticsService } from '../src/analytics/service';
import { localDay } from '../src/analytics/local-day';
import { AnalyticsError, type AnalyticsProvider } from '../src/analytics/providers';
import { timeInfoFromGetTime } from '../src/camera/time';

// America/Chicago as the camera reports it (see clips-indexer.test.ts).
const chicago = timeInfoFromGetTime({
  Dst: { enable: 1, offset: 1, startMon: 3, startWeek: 2, startWeekday: 0, startHour: 2, startMin: 0, startSec: 0, endMon: 11, endWeek: 1, endWeekday: 0, endHour: 2, endMin: 0, endSec: 0 },
  Time: { year: 2026, mon: 9, day: 30, hour: 9, min: 0, sec: 0, hourFmt: 1, isDst: 1, timeFmt: 'MM/DD/YYYY', timeZone: 21600 },
});

const T0 = Date.parse('2026-09-30T15:00:00Z'); // 10:00 CDT
let c: Catalog;
let log: StreamLog;
let now: number;
let config: Config;
let stills: Map<number, Buffer>;
let calls: number[];
let answers: Array<'ok' | AnalyticsError>;
let dir: string;

const provider: AnalyticsProvider = {
  id: 'google-vision',
  name: 'Google Vision',
  async analyze(jpeg) {
    calls.push(jpeg[0]);
    const a = answers.length > 1 ? answers.shift()! : (answers[0] ?? 'ok');
    if (a !== 'ok') throw a;
    return { objects: [{ name: 'Person', score: 0.8, box: { x0: 0.1, y0: 0.1, x1: 0.5, y1: 0.9 } }], raw: { n: 1 } };
  },
};

function service(over: { key?: string } = {}) {
  return new AnalyticsService({
    catalog: c, log, cam: 'cam1', dataDir: dir,
    config: () => config,
    secrets: () => ({ googleVisionKey: over.key ?? 'k-123456789012', googleVisionUrl: 'http://mock' }),
    readStill: async (ts) => stills.get(ts),
    listStills: (from, to) => [...stills.keys()].filter((t) => t >= from && t <= to).sort((a, b) => a - b),
    timeInfo: () => chicago,
    now: () => now,
    sleep: async (ms) => void (now += ms),
    provider: () => provider,
  });
}
const event = (kind: string, start_ts = T0) => insertEvent(c, { cam: 'cam1', source: 'onvif', kind, start_ts, raw: null });
const still = (ts: number, byte: number) => stills.set(ts, Buffer.from([byte, 0xd8]));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'camproxy-svc-'));
  c = openCatalog(join(dir, 'catalog.sqlite'));
  log = new StreamLog(c, () => now);
  now = T0 + 3000;
  config = structuredClone(DEFAULTS);
  config.analytics.googleVision = { enabled: true, monthlyLimit: 100, dailyCap: 0 };
  stills = new Map();
  calls = [];
  answers = [];
});

describe('local day', () => {
  it('is the camera-local date, across DST', () => {
    expect(localDay(Date.parse('2026-10-01T04:59:00Z'), chicago)).toBe('2026-09-30'); // 23:59 CDT
    expect(localDay(Date.parse('2026-10-01T05:00:00Z'), chicago)).toBe('2026-10-01');
    expect(localDay(Date.parse('2026-12-01T05:59:00Z'), chicago)).toBe('2026-11-30'); // 23:59 CST
    expect(localDay(Date.parse('2026-12-01T06:00:00Z'), chicago)).toBe('2026-12-01');
  });
});

describe('AnalyticsService', () => {
  it('analyses a person event with the still 1 s after its start, stores it and copies the image', async () => {
    still(T0 + 1000, 7);
    const s = service();
    const e = event('person');
    s.onEvent(e);
    await s.idle();
    const a = analysisFor(c, e.id)!;
    expect(a).toMatchObject({ status: 'ok', still_ts: T0 + 1000, provider: 'google-vision' });
    expect(JSON.parse(a.objects!)[0].name).toBe('Person');
    expect(readFileSync(a.image!)).toEqual(Buffer.from([7, 0xd8]));
    expect(log.since(0, { types: ['analysis'] }, 10)[0].data).toMatchObject({ eventId: e.id, status: 'ok' });
    expect(s.state()[0]).toMatchObject({ enabled: true, keyMasked: 'k-12…9012', month: { calls: 1, limit: 100 }, today: { calls: 1, cap: 0 } });
  });

  it('never analyses motion, nor kinds switched off', async () => {
    still(T0 + 1000, 7);
    const s = service();
    s.onEvent(event('motion'));
    s.onEvent(event('vehicle'));
    await s.idle();
    expect(calls).toEqual([]);
  });

  it('takes the nearest still within 2 s, else skips with no_still (no call)', async () => {
    still(T0 + 2500, 9);
    const s = service();
    const a = event('person');
    s.onEvent(a);
    await s.idle();
    expect(analysisFor(c, a.id)).toMatchObject({ status: 'ok', still_ts: T0 + 2500 });
    stills.clear();
    const b = event('person', T0 + 60_000);
    s.onEvent(b);
    await s.idle();
    expect(analysisFor(c, b.id)).toMatchObject({ status: 'skipped', reason: 'no_still' });
    expect(calls).toHaveLength(1);
  });

  it('stores nothing at all while no provider is enabled', async () => {
    config.analytics.googleVision.enabled = false;
    still(T0 + 1000, 7);
    const s = service();
    const e = event('person');
    s.onEvent(e);
    await s.idle();
    expect(analysisFor(c, e.id)).toBeUndefined();
    expect(s.state()[0].enabled).toBe(false);
  });

  it('stores nothing without a key, even when enabled', async () => {
    still(T0 + 1000, 7);
    const s = service({ key: '' });
    const e = event('person');
    s.onEvent(e);
    await s.idle();
    expect(analysisFor(c, e.id)).toBeUndefined();
    expect(s.state()[0]).toMatchObject({ keyMasked: null });
  });

  it('skips with reason limit at the monthly limit and at the daily cap', async () => {
    still(T0 + 1000, 7);
    still(T0 + 61_000, 7);
    still(T0 + 121_000, 7);
    config.analytics.googleVision = { enabled: true, monthlyLimit: 2, dailyCap: 1 };
    const s = service();
    const [a, b] = [event('person'), event('person', T0 + 60_000)];
    s.onEvent(a);
    s.onEvent(b);
    await s.idle();
    expect(analysisFor(c, a.id)?.status).toBe('ok');
    expect(analysisFor(c, b.id)).toMatchObject({ status: 'skipped', reason: 'limit' }); // daily cap 1
    config.analytics.googleVision.monthlyLimit = 0;
    const d = event('person', T0 + 120_000);
    s.onEvent(d);
    await s.idle();
    expect(analysisFor(c, d.id)).toMatchObject({ status: 'skipped', reason: 'limit' });
    expect(calls).toHaveLength(1);
  });

  // Review focus 2.
  it('counts per camera-local day and month', async () => {
    config.analytics.googleVision = { enabled: true, monthlyLimit: 1, dailyCap: 0 };
    const late = Date.parse('2026-10-01T04:58:00Z'); // 23:58 CDT on Sep 30
    still(late + 1000, 1);
    still(late + 181_000, 1); // 00:01 CDT on Oct 1: a new month
    const s = service();
    const a = event('person', late);
    now = late + 3000;
    s.onEvent(a);
    await s.idle();
    const b = event('person', late + 180_000);
    now = late + 183_000;
    s.onEvent(b);
    await s.idle();
    expect(analysisFor(c, a.id)?.status).toBe('ok');
    expect(analysisFor(c, b.id)?.status).toBe('ok'); // the October count starts at 0
    expect(s.state()[0].month).toEqual({ calls: 1, limit: 1 });
  });

  it('retries a timeout once after 30 s, then fails', async () => {
    still(T0 + 1000, 7);
    answers = [new AnalyticsError('timeout', true), new AnalyticsError('timeout', true)];
    const s = service();
    const e = event('person');
    const before = now;
    s.onEvent(e);
    await s.idle();
    expect(calls).toHaveLength(2);
    expect(now - before).toBeGreaterThanOrEqual(30_000);
    expect(analysisFor(c, e.id)).toMatchObject({ status: 'failed', reason: 'timeout' });
    expect(s.state()[0].month.calls).toBe(2); // every call sent counts
  });

  it('pauses on a bad key until settings change, and 1 h on quota', async () => {
    still(T0 + 1000, 7);
    still(T0 + 61_000, 7);
    answers = [new AnalyticsError('bad_key', false, 'bad_key'), 'ok'];
    const s = service();
    const a = event('person');
    s.onEvent(a);
    await s.idle();
    expect(s.state()[0].paused).toMatchObject({ reason: 'bad_key', until: null });
    const b = event('person', T0 + 60_000);
    s.onEvent(b);
    await s.idle();
    expect(analysisFor(c, b.id)).toMatchObject({ status: 'skipped', reason: 'paused' });
    expect(calls).toHaveLength(1);
    // Review focus 3.
    s.settingsChanged();
    expect(s.state()[0].paused).toBeNull();

    answers = [new AnalyticsError('quota', false, 'quota')];
    const q = event('person', T0 + 60_000 * 2);
    still(T0 + 121_000, 7);
    s.onEvent(q);
    await s.idle();
    expect(s.state()[0].paused).toMatchObject({ reason: 'quota', until: now + 3_600_000 });
  });

  // Review focus 1.
  it('two events in a row are both analysed, in order, each with its own still', async () => {
    still(T0 + 1000, 1);
    still(T0 + 11_000, 2);
    const s = service();
    const [a, b] = [event('person'), event('person', T0 + 10_000)];
    s.onEvent(a);
    s.onEvent(b);
    await s.idle();
    expect(calls).toEqual([1, 2]);
    expect(analysisFor(c, a.id)?.still_ts).toBe(T0 + 1000);
    expect(analysisFor(c, b.id)?.still_ts).toBe(T0 + 11_000);
  });

  // Review focus 4.
  it('drops the result when the event is gone by the time the result comes', async () => {
    still(T0 + 1000, 7);
    const s = service();
    const e = event('person');
    s.onEvent(e);
    deleteEventsBefore(c, T0 + 1); // retention runs while it is queued
    await s.idle();
    expect(analysisFor(c, e.id)).toBeUndefined();
    expect(existsSync(join(dir, 'analytics', 'cam1', `${e.id}.jpg`))).toBe(false); // its image copy is removed too
    expect(log.since(0, { types: ['analysis'] }, 10)).toEqual([]); // and nothing is announced
  });

  it('queues the last 10 minutes of unanalysed events again after a restart', async () => {
    still(T0 + 1000, 7);
    const old = event('person', T0 - 11 * 60_000);
    const recent = event('person');
    event('motion');
    const s = service();
    s.catchUp();
    await s.idle();
    expect(analysisFor(c, recent.id)?.status).toBe('ok');
    expect(analysisFor(c, old.id)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run test/analytics-service.test.ts`
Expected: FAIL, `Cannot find module '../src/analytics/service'`.

- [ ] **Step 3: Implement**

In `src/clips/indexer.ts`, change `function dstBounds(` to `export function dstBounds(`.

Create `src/analytics/local-day.ts`:

```ts
import type { TimeInfo } from '../camera/time';
import { dstBounds } from '../clips/indexer';

// The camera-local date of a moment: the limits count per camera day and
// calendar month (the container runs in UTC). Without the camera's time
// info, the UTC date.
export function localDay(ts: number, t: TimeInfo | undefined): string {
  let offset = 0;
  if (t) {
    offset = t.stdOffsetMinutes;
    if (t.dstRule && t.dstOffsetMinutes) {
      const year = new Date(ts + offset * 60_000).getUTCFullYear();
      const [start, end] = dstBounds(year, t.dstRule, t.stdOffsetMinutes, t.dstOffsetMinutes);
      if (ts >= start && ts < end) offset += t.dstOffsetMinutes;
    }
  }
  return new Date(ts + offset * 60_000).toISOString().slice(0, 10);
}
```

(If `dstBounds` returns local-wall values rather than UTC milliseconds, convert here so that `start`/`end` are UTC ms; the Chicago test in Step 1 decides it.)

Create `src/analytics/service.ts`:

```ts
import { mkdirSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { Catalog } from '../catalog/db';
import { addUsage, saveAnalysis, unanalysed, usageBetween } from '../catalog/analyses';
import type { Config } from '../config/defaults';
import type { TimeInfo } from '../camera/time';
import { logger } from '../log';
import type { StreamLog } from '../stream/log';
import { googleVision } from './google-vision';
import { localDay } from './local-day';
import { AnalyticsError, maskKey, PROVIDERS, type AnalyticsProvider, type ProviderId } from './providers';

const STILL_AFTER_MS = 1000; // the still 1 s after the start: the detection
const STILL_NEAR_MS = 2000; // else the nearest within ±2 s
const STILL_WAIT_MS = 5000; // wait at most this long for it
const TIMEOUT_MS = 10_000;
const RETRY_AFTER_MS = 30_000;
const QUOTA_PAUSE_MS = 3_600_000;
const CATCH_UP_MS = 10 * 60_000;
const KINDS = ['person', 'vehicle', 'pet'] as const;

export interface AnalyticsDeps {
  catalog: Catalog;
  log: StreamLog;
  cam: string;
  dataDir: string;
  config: () => Config;
  secrets: () => { googleVisionKey?: string; googleVisionUrl: string };
  readStill: (ts: number) => Promise<Buffer | undefined>;
  listStills: (from: number, to: number) => number[];
  timeInfo: () => TimeInfo | undefined;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  provider?: (id: ProviderId, key: string, baseUrl: string) => AnalyticsProvider;
}

export interface ProviderState {
  id: string;
  name: string;
  enabled: boolean;
  keyMasked: string | null;
  month: { calls: number; limit: number };
  today: { calls: number; cap: number };
  paused: { reason: string; until: number | null } | null;
  lastCall: { at: number; tookMs: number; status: string } | null;
  lastError: string | null;
}

type Job = { id: number; kind: string; start_ts: number };

// Sends event stills to the enabled provider, one at a time, within the
// limits, and stores what comes back (spec 2026-09-30-analytics-design).
export class AnalyticsService {
  private readonly queue: Job[] = [];
  private running: Promise<void> | null = null;
  private stopped = false;
  private paused: { reason: string; until: number | null } | null = null;
  private lastCall: ProviderState['lastCall'] = null;
  private lastError: string | null = null;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly d: AnalyticsDeps) {
    this.now = d.now ?? Date.now;
    this.sleep = d.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  private settings() {
    return this.d.config().analytics;
  }
  private key(): string | undefined {
    return this.d.secrets().googleVisionKey || undefined;
  }
  // On, with a key: otherwise events aren't queued and nothing is stored.
  private active(): boolean {
    return this.settings().googleVision.enabled && !!this.key();
  }
  private wanted(kind: string): boolean {
    const k = this.settings().kinds;
    return (KINDS as readonly string[]).includes(kind) && k[kind as (typeof KINDS)[number]] === true;
  }

  onEvent(e: Job): void {
    if (this.stopped || !this.active() || !this.wanted(e.kind)) return;
    this.queue.push({ id: e.id, kind: e.kind, start_ts: e.start_ts });
    this.running ??= this.drain().finally(() => (this.running = null));
  }

  // After a restart: the last 10 minutes of events that were never analysed.
  catchUp(): void {
    if (!this.active()) return;
    const kinds = KINDS.filter((k) => this.settings().kinds[k]);
    for (const e of unanalysed(this.d.catalog, this.d.cam, kinds, this.now() - CATCH_UP_MS)) this.onEvent(e);
  }

  // A saved analytics setting (or a new key) lifts a bad_key pause.
  settingsChanged(): void {
    if (this.paused?.reason === 'bad_key') this.paused = null;
  }

  async idle(): Promise<void> {
    while (this.running) await this.running;
  }

  stop(): void {
    this.stopped = true;
    this.queue.length = 0;
  }

  private monthUsage(day: string): number {
    return usageBetween(this.d.catalog, 'google-vision', `${day.slice(0, 7)}-01`, `${day.slice(0, 7)}-31`);
  }

  state(): ProviderState[] {
    const g = this.settings().googleVision;
    const day = localDay(this.now(), this.d.timeInfo());
    if (this.paused && this.paused.until !== null && this.paused.until <= this.now()) this.paused = null; // a quota pause ends
    return PROVIDERS.map((p) => ({
      id: p.id,
      name: p.name,
      enabled: g.enabled,
      keyMasked: maskKey(this.key()),
      month: { calls: this.monthUsage(day), limit: g.monthlyLimit },
      today: { calls: usageBetween(this.d.catalog, p.id, day, day), cap: g.dailyCap },
      paused: this.paused,
      lastCall: this.lastCall,
      lastError: this.lastError,
    }));
  }

  private async drain(): Promise<void> {
    for (let job = this.queue.shift(); job && !this.stopped; job = this.queue.shift()) {
      try {
        await this.run(job);
      } catch (err) {
        logger.warn({ err: (err as Error).message, eventId: job.id }, 'analytics_job_failed');
      }
    }
  }

  // The still at start + 1 s, else the nearest within ±2 s; waits for it.
  private async pickStill(start: number): Promise<number | null> {
    const want = start + STILL_AFTER_MS;
    const deadline = want + STILL_WAIT_MS;
    for (;;) {
      const near = this.d.listStills(want - STILL_NEAR_MS, want + STILL_NEAR_MS);
      if (near.includes(want)) return want;
      if (this.now() >= deadline || this.now() >= want + STILL_NEAR_MS) {
        if (!near.length) return null;
        return near.reduce((a, b) => (Math.abs(b - want) < Math.abs(a - want) ? b : a));
      }
      await this.sleep(Math.min(1000, deadline - this.now()));
    }
  }

  private store(job: Job, r: { status: 'ok' | 'skipped' | 'failed'; reason: string | null; stillTs: number | null; image: string | null; tookMs: number | null; objects: unknown; raw: unknown }): void {
    const row = saveAnalysis(this.d.catalog, {
      event_id: job.id, provider: 'google-vision', status: r.status, reason: r.reason, still_ts: r.stillTs, image: r.image,
      requested_at: this.now(), took_ms: r.tookMs, objects: r.objects === null ? null : JSON.stringify(r.objects), raw: r.raw === null ? null : JSON.stringify(r.raw),
    });
    if (!row) {
      if (r.image) try { unlinkSync(r.image); } catch { /* already gone */ }
      return;
    }
    this.d.log.append(this.d.cam, 'analysis', { eventId: job.id, provider: 'google-vision', status: r.status, reason: r.reason, objects: r.objects ?? [] });
  }

  private skip(job: Job, reason: string, stillTs: number | null = null): void {
    this.store(job, { status: 'skipped', reason, stillTs, image: null, tookMs: null, objects: null, raw: null });
  }

  private async run(job: Job): Promise<void> {
    if (!this.active()) return;
    const stillTs = await this.pickStill(job.start_ts);
    if (stillTs === null) return this.skip(job, 'no_still');
    if (this.paused && this.paused.until !== null && this.paused.until <= this.now()) this.paused = null;
    if (this.paused) return this.skip(job, 'paused', stillTs);
    const jpeg = await this.d.readStill(stillTs);
    if (!jpeg) return this.skip(job, 'no_still');
    const key = this.key()!;
    const provider = (this.d.provider ?? ((id, k, url) => googleVision({ key: k, baseUrl: url })))('google-vision', key, this.d.secrets().googleVisionUrl);

    for (let attempt = 0; ; attempt++) {
      const g = this.settings().googleVision;
      const day = localDay(this.now(), this.d.timeInfo());
      if (this.monthUsage(day) >= g.monthlyLimit || (g.dailyCap > 0 && usageBetween(this.d.catalog, 'google-vision', day, day) >= g.dailyCap)) {
        return this.skip(job, 'limit', stillTs);
      }
      addUsage(this.d.catalog, 'google-vision', day);
      const t0 = this.now();
      try {
        const res = await provider.analyze(jpeg, AbortSignal.timeout(TIMEOUT_MS));
        const tookMs = this.now() - t0;
        this.lastCall = { at: t0, tookMs, status: 'ok' };
        const dir = join(this.d.dataDir, 'analytics', this.d.cam);
        mkdirSync(dir, { recursive: true });
        const image = join(dir, `${job.id}.jpg`);
        writeFileSync(image, jpeg);
        return this.store(job, { status: 'ok', reason: null, stillTs, image, tookMs, objects: res.objects, raw: res.raw });
      } catch (err) {
        const e = err instanceof AnalyticsError ? err : new AnalyticsError('network', true);
        this.lastCall = { at: t0, tookMs: this.now() - t0, status: e.reason };
        this.lastError = e.reason;
        if (e.pause === 'bad_key') this.paused = { reason: 'bad_key', until: null };
        if (e.pause === 'quota') this.paused = { reason: 'quota', until: this.now() + QUOTA_PAUSE_MS };
        if (e.retry && attempt === 0) {
          await this.sleep(RETRY_AFTER_MS);
          continue;
        }
        return this.store(job, { status: 'failed', reason: e.reason, stillTs, image: null, tookMs: this.now() - t0, objects: null, raw: null });
      }
    }
  }
}
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run test/analytics-service.test.ts`
Expected: PASS (13 tests). If `local day` fails, fix the `dstBounds` conversion in `local-day.ts` (see the note in Step 3), not the test.

- [ ] **Step 5: Commit**

```bash
git add src/analytics/local-day.ts src/analytics/service.ts src/clips/indexer.ts test/analytics-service.test.ts
git commit -m "feat(analytics): the service: filter, still, limits, queue, retry, pause"
```

---

### Task 5: Wiring, API and storage clean-up

**Files:**
- Modify: `src/stream/log.ts`, `src/proxy.ts`, `src/api/client-api.ts`, `src/api/control-api.ts`, `src/storage.ts`, `openapi.yaml`
- Test: `test/analytics-api.test.ts`

**Interfaces:**
- Consumes: `AnalyticsService` (Task 4), `analysisFor`, `analysesFor`, `analysisImages`, `pruneUsage` (Task 2).
- Produces (HTTP):
  - `GET /api/cameras/{cam}/events` → each event has `analysis: { provider, status, reason, objects } | null`
  - `GET /api/cameras/{cam}/events/{id}/analysis` → `{ eventId, provider, status, reason, stillTs, requestedAt, tookMs, objects, raw }` or 404 `{error:'not_found'}`
  - `GET /api/cameras/{cam}/events/{id}/analysis.jpg` → `image/jpeg` or 404
  - `GET /control/analytics` → `ProviderState[]`; `GET /control/status` gains `analytics: ProviderState[]`
  - stream message type `analysis`
- Produces (for the UI): `Proxy.analytics: AnalyticsService` (tests reach it through `p.proxy.analytics`).

- [ ] **Step 1: Write the failing test**

```ts
// test/analytics-api.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { insertEvent } from '../src/catalog/events';
import { saveAnalysis } from '../src/catalog/analyses';
import { ADMIN_TOKEN, CLIENT_TOKEN } from './helpers/tokens';
import { startSim } from './helpers/sim';
import { auth, startProxy, until } from './helpers/proxy';
import { startVisionMock, type VisionMock } from './helpers/vision-mock';

let sim: Awaited<ReturnType<typeof startSim>>;
let p: Awaited<ReturnType<typeof startProxy>>;
let mock: VisionMock;
beforeAll(async () => {
  sim = await startSim();
  mock = await startVisionMock({ key: 'k-123456789012' });
  p = await startProxy(sim, { env: { CAMPROXY_GOOGLE_VISION_KEY: 'k-123456789012', CAMPROXY_GOOGLE_VISION_URL: mock.url } });
});
afterAll(async () => {
  await p.proxy.stop();
  await sim.close();
  await mock.close();
});

describe('analytics API', () => {
  it('adds analysis to events, and serves the record and its image', async () => {
    const c = p.proxy.catalog;
    const e = insertEvent(c, { cam: 'cam1', source: 'onvif', kind: 'person', start_ts: Date.now() - 60_000, raw: null });
    const dir = join(p.dir, 'data', 'analytics', 'cam1');
    mkdirSync(dir, { recursive: true });
    const image = join(dir, `${e.id}.jpg`);
    writeFileSync(image, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    saveAnalysis(c, { event_id: e.id, provider: 'google-vision', status: 'ok', reason: null, still_ts: e.start_ts + 1000, image, requested_at: Date.now(), took_ms: 250,
      objects: JSON.stringify([{ name: 'Person', score: 0.8, box: { x0: 0.1, y0: 0.1, x1: 0.5, y1: 0.9 } }]), raw: '{"a":1}' });
    const list = await request(p.proxy.app).get(`/api/cameras/cam1/events?from=0&to=${Date.now()}&limit=10`).set(auth());
    expect(list.body.find((x: { id: number }) => x.id === e.id).analysis).toEqual({ provider: 'google-vision', status: 'ok', reason: null, objects: [{ name: 'Person', score: 0.8, box: { x0: 0.1, y0: 0.1, x1: 0.5, y1: 0.9 } }] });
    const full = await request(p.proxy.app).get(`/api/cameras/cam1/events/${e.id}/analysis`).set(auth());
    expect(full.body).toMatchObject({ eventId: e.id, stillTs: e.start_ts + 1000, tookMs: 250, raw: { a: 1 } });
    const jpg = await request(p.proxy.app).get(`/api/cameras/cam1/events/${e.id}/analysis.jpg`).set(auth());
    expect(jpg.status).toBe(200);
    expect(jpg.headers['content-type']).toBe('image/jpeg');
    expect((await request(p.proxy.app).get('/api/cameras/cam1/events/999999/analysis').set(auth())).status).toBe(404);
  });

  it('reports the provider state to admins only, key masked', async () => {
    const r = await request(p.proxy.app).get('/control/analytics').set(auth(ADMIN_TOKEN));
    expect(r.status).toBe(200);
    expect(r.body[0]).toMatchObject({ id: 'google-vision', enabled: false, keyMasked: 'k-12…9012', month: { calls: 0, limit: 0 } });
    expect(JSON.stringify(r.body)).not.toContain('k-123456789012');
    expect((await request(p.proxy.app).get('/control/status').set(auth(ADMIN_TOKEN))).body.analytics).toHaveLength(1);
    expect((await request(p.proxy.app).get('/control/analytics').set(auth(CLIENT_TOKEN))).status).toBe(403);
  });

  it('with the limit at 0 no call reaches the mock, even when enabled', async () => {
    await request(p.proxy.app).put('/control/config').set(auth(ADMIN_TOKEN)).send({ analytics: { googleVision: { enabled: true } } });
    const before = mock.calls;
    const e = insertEvent(p.proxy.catalog, { cam: 'cam1', source: 'onvif', kind: 'person', start_ts: Date.now(), raw: null });
    p.proxy.analytics.onEvent(e);
    await p.proxy.analytics.idle();
    expect(mock.calls).toBe(before);
  });

  it('a real camera event reaches the service through the stream log', async () => {
    await request(p.proxy.app).put('/control/config').set(auth(ADMIN_TOKEN)).send({ analytics: { googleVision: { enabled: true, monthlyLimit: 10 } } });
    const r = await fetch(`${sim.control}/sim/api/events`, { method: 'POST', headers: { ...sim.controlAuth, 'content-type': 'application/json' }, body: JSON.stringify({ type: 'person', durationS: 1 }) });
    expect(r.status).toBe(201);
    // Stills are off in unit tests without go2rtc: the event is skipped with no_still (no call).
    await until(async () => {
      const list = await request(p.proxy.app).get(`/api/cameras/cam1/events?from=${Date.now() - 60_000}&to=${Date.now() + 60_000}&limit=10&kind=person`).set(auth());
      return list.body.some((x: { analysis: { status: string } | null }) => x.analysis !== null);
    }, 15_000);
  });

  it('deletes images whose analysis is gone', async () => {
    const orphan = join(p.dir, 'data', 'analytics', 'cam1', '424242.jpg');
    writeFileSync(orphan, Buffer.from([1]));
    await request(p.proxy.app).post('/control/actions/retention-run').set(auth(ADMIN_TOKEN)).send({});
    expect(existsSync(orphan)).toBe(false);
  });
});
```

Before running, check the helper names this test assumes: `grep -n "export" test/helpers/sim.ts test/helpers/proxy.ts` and the token constants' file. Adjust the imports (`ADMIN_TOKEN`, `CLIENT_TOKEN`), `sim.control`/`sim.controlAuth` and `p.proxy.stop`/`sim.close` to the real names; the assertions stay as written.

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run test/analytics-api.test.ts`
Expected: FAIL (no `analysis` field / 404 on `/control/analytics` / `p.proxy.analytics` undefined).

- [ ] **Step 3: Implement**

`src/stream/log.ts`: add `'analysis'` to `STREAM_TYPES`:

```ts
export const STREAM_TYPES = ['camera-event', 'camera-status', 'clip', 'annotation', 'still', 'analysis'] as const;
```

Check the SSE filter's default types (`grep -n "STREAM_TYPES\|types" src/api/*.ts src/stream/*.ts`); if clients get all types by default, nothing else changes.

`src/proxy.ts`:
- add `readonly analytics: AnalyticsService;` to the `Proxy` interface;
- after the stills side exists (the variable holding `MinuteStore` is `stills?.store`), create the service:

```ts
  let timeInfo: TimeInfo | undefined;
  void client.timeInfo().then((t) => (timeInfo = t), () => undefined);
  const analytics = new AnalyticsService({
    catalog, log, cam: running.camera.id, dataDir: running.server.dataDir,
    config: () => running,
    secrets: () => ({ googleVisionKey: loaded.secrets.googleVisionKey, googleVisionUrl: loaded.secrets.googleVisionUrl }),
    readStill: (ts) => stills?.store.readStill(ts) ?? Promise.resolve(undefined),
    listStills: (from, to) => stills?.store.listStills(from, to) ?? [],
    timeInfo: () => timeInfo,
  });
  // Every camera-event start goes to the service (it filters by kind).
  log.on('message', (m: StreamMessage) => {
    if (m.type === 'camera-event' && m.data.phase === 'start') analytics.onEvent({ id: Number(m.data.eventId), kind: String(m.data.kind), start_ts: Number(m.data.ts) });
  });
```

- call `analytics.catchUp()` where the proxy starts (in `start()`, after the catalog and stills are up);
- in `setLoaded`, after the live settings are copied, call `analytics.settingsChanged()`;
- in `stop()`, call `analytics.stop()`;
- pass `analytics` to `clientApi(...)` and `controlApi(...)` deps, and expose it on the returned object.

`src/api/client-api.ts`:
- add `analytics?: unknown` is not needed; the router needs only the catalog. Change the events route:

```ts
    const rows = listEvents(d.catalog, { cam: cam().id, from, to, kind, limit });
    const an = analysesFor(d.catalog, rows.map((e) => e.id));
    res.json(rows.map((e) => ({ ...eventJson(e), analysis: analysisSummary(an.get(e.id)) })));
```

with, near `eventJson`:

```ts
const parse = (s: string | null) => (s === null ? null : JSON.parse(s));
export const analysisSummary = (a: AnalysisRow | undefined) =>
  a ? { provider: a.provider, status: a.status, reason: a.reason, objects: parse(a.objects) ?? [] } : null;
```

and the two new routes after the events route:

```ts
  r.get('/cameras/:cam/events/:id/analysis', (req, res) => {
    if (!known(req, res)) return;
    const a = analysisFor(d.catalog, Number(req.params.id));
    if (!a) return void res.status(404).json({ error: 'not_found' });
    res.json({ eventId: a.event_id, provider: a.provider, status: a.status, reason: a.reason, stillTs: a.still_ts, requestedAt: a.requested_at, tookMs: a.took_ms, objects: parse(a.objects) ?? [], raw: parse(a.raw) });
  });
  r.get('/cameras/:cam/events/:id/analysis.jpg', (req, res) => {
    if (!known(req, res)) return;
    const a = analysisFor(d.catalog, Number(req.params.id));
    let jpeg: Buffer | undefined;
    try {
      jpeg = a?.image ? readFileSync(a.image) : undefined;
    } catch {
      jpeg = undefined;
    }
    sendJpeg(res, jpeg, true);
  });
```

(`sendJpeg` is defined further down in the same function today; move the two routes below it, or move `sendJpeg` above. Add `/cameras/:cam/events/:id/analysis.jpg` to the image rate-limit regex in `src/proxy.ts` (`const IMAGE = ...`) next to `clips/\d{1,15}\.(mp4|jpg)`.)

`src/api/control-api.ts`:
- add `analytics: () => ProviderState[]` to `ControlDeps`;
- `r.get('/analytics', (_req, res) => void res.json(d.analytics()));`
- in the `/status` handler's JSON, add `analytics: d.analytics()`.

`src/storage.ts`, in the non-dry branch right after `deleted.events = deleteEventsBefore(...)`:

```ts
      // Analysis images whose analysis is gone (deleted with its event).
      const keep = analysisImages(this.d.catalog);
      const dir = join(cfg.server.dataDir, 'analytics', cfg.camera.id);
      for (const f of existsSync(dir) ? readdirSync(dir) : []) {
        const path = join(dir, f);
        if (!keep.has(path)) try { unlinkSync(path); } catch { /* gone */ }
      }
      pruneUsage(this.d.catalog, new Date(now - 400 * DAY).toISOString().slice(0, 10));
```

`openapi.yaml`: add the `analysis` property to the event schema, the two paths under the client API, `/control/analytics` under the control API, and `analytics` to the status schema. Keep the existing style; `test/openapi.test.ts` checks that every route is documented.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/analytics-api.test.ts test/openapi.test.ts test/client-api.test.ts test/control-api.test.ts`
Expected: PASS. `client-api.test.ts` may compare whole event objects: add `analysis: null` there.

- [ ] **Step 5: Commit**

```bash
git add src/stream/log.ts src/proxy.ts src/api/client-api.ts src/api/control-api.ts src/storage.ts openapi.yaml test/analytics-api.test.ts test/client-api.test.ts
git commit -m "feat(analytics): wire the service; events carry their analysis; control API usage"
```

---

### Task 6: Settings and Status in the web UI

**Files:**
- Create: `web/src/lib/analytics.ts`, `web/src/components/AnalyticsSettings.svelte`
- Modify: `web/src/pages/Settings.svelte`, `web/src/pages/Status.svelte`, `web/src/lib/state.ts` (the status type)
- Test: `test/analytics-ui.test.ts`

**Interfaces:**
- Consumes: `/control/config` (the settings view), `/control/status` → `analytics: ProviderState[]`.
- Produces:
  - `costEstimate(monthlyLimit: number): string`
  - `usageLine(s: ProviderState): string`
  - `tagText(a: { status: string; reason: string | null; objects: { name: string; score: number }[] } | null): string | null`
  - `type UiProviderState` (the JSON of `ProviderState`)

- [ ] **Step 1: Write the failing test**

```ts
// test/analytics-ui.test.ts
import { describe, expect, it } from 'vitest';
import { costEstimate, tagText, usageLine } from '../web/src/lib/analytics';

describe('analytics UI text', () => {
  it('estimates the monthly cost from the limit (1,000 free, then $1.50 per 1,000)', () => {
    expect(costEstimate(0)).toBe('No calls.');
    expect(costEstimate(900)).toBe('Up to 900 calls a month: free (Google\'s first 1,000 a month are free).');
    expect(costEstimate(3000)).toBe('Up to 3,000 calls a month: at most $3.00 (the first 1,000 free, then $1.50 per 1,000).');
  });

  it('describes usage, a pause and an error', () => {
    const base = { id: 'google-vision', name: 'Google Vision', enabled: true, keyMasked: 'AIza…x7Qk', month: { calls: 23, limit: 1000 }, today: { calls: 4, cap: 0 }, paused: null, lastCall: { at: Date.parse('2026-09-30T19:02:00Z'), tookMs: 312, status: 'ok' }, lastError: null };
    expect(usageLine(base)).toMatch(/^23 of 1,000 this month · 4 today · last \d{1,2}:02(\s?[AP]M)? \(0\.3 s\)$/);
    expect(usageLine({ ...base, today: { calls: 4, cap: 30 } })).toContain('4 of 30 today');
    expect(usageLine({ ...base, enabled: false })).toBe('not enabled');
  });

  it('writes the Events tag: top three names by score, nothing found, or why not', () => {
    const o = (name: string, score: number) => ({ name, score });
    expect(tagText(null)).toBeNull();
    expect(tagText({ status: 'ok', reason: null, objects: [o('Car', 0.81), o('Person', 0.9), o('Dog', 0.5), o('Bag', 0.4)] })).toBe('✦ Vision: Person 0.90, Car 0.81, Dog 0.50');
    expect(tagText({ status: 'ok', reason: null, objects: [] })).toBe('✦ Vision: nothing found');
    expect(tagText({ status: 'skipped', reason: 'limit', objects: [] })).toBe('✦ not analysed (limit)');
    expect(tagText({ status: 'failed', reason: 'bad_key', objects: [] })).toBe('✦ not analysed (bad_key)');
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run test/analytics-ui.test.ts`
Expected: FAIL, `Cannot find module '../web/src/lib/analytics'`.

- [ ] **Step 3: Implement**

Create `web/src/lib/analytics.ts`:

```ts
// Text for the analytics UI (spec 2026-09-30-analytics-design). Pure: tested
// in test/analytics-ui.test.ts.
export interface UiProviderState {
  id: string;
  name: string;
  enabled: boolean;
  keyMasked: string | null;
  month: { calls: number; limit: number };
  today: { calls: number; cap: number };
  paused: { reason: string; until: number | null } | null;
  lastCall: { at: number; tookMs: number; status: string } | null;
  lastError: string | null;
}
export interface UiObject { name: string; score: number; box?: { x0: number; y0: number; x1: number; y1: number } }
export interface UiAnalysis { provider?: string; status: string; reason: string | null; objects: UiObject[] }

const n = (x: number) => x.toLocaleString('en-US');

export function costEstimate(monthlyLimit: number): string {
  if (monthlyLimit <= 0) return 'No calls.';
  if (monthlyLimit <= 1000) return `Up to ${n(monthlyLimit)} calls a month: free (Google's first 1,000 a month are free).`;
  const dollars = ((monthlyLimit - 1000) / 1000) * 1.5;
  return `Up to ${n(monthlyLimit)} calls a month: at most $${dollars.toFixed(2)} (the first 1,000 free, then $1.50 per 1,000).`;
}

export function usageLine(s: UiProviderState): string {
  if (!s.enabled) return 'not enabled';
  const today = s.today.cap > 0 ? `${n(s.today.calls)} of ${n(s.today.cap)} today` : `${n(s.today.calls)} today`;
  const last = s.lastCall
    ? ` · last ${new Date(s.lastCall.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} (${(s.lastCall.tookMs / 1000).toFixed(1)} s)`
    : '';
  return `${n(s.month.calls)} of ${n(s.month.limit)} this month · ${today}${last}`;
}

export function tagText(a: UiAnalysis | null): string | null {
  if (!a) return null;
  if (a.status !== 'ok') return `✦ not analysed (${a.reason ?? a.status})`;
  if (!a.objects.length) return '✦ Vision: nothing found';
  const top = [...a.objects].sort((x, y) => y.score - x.score).slice(0, 3);
  return `✦ Vision: ${top.map((o) => `${o.name} ${o.score.toFixed(2)}`).join(', ')}`;
}
```

Create `web/src/components/AnalyticsSettings.svelte` (reads `/control/config` paths `analytics.*` and `/control/status`'s `analytics`; saves with `PUT /control/config`):

```svelte
<script lang="ts">
  import { api, ApiError } from '../lib/api';
  import { status } from '../lib/state';
  import { costEstimate, type UiProviderState } from '../lib/analytics';

  // The Analytics card (spec 2026-09-30-analytics-design): event kinds, and per
  // provider its switch, masked key, limits, estimate and the shared-key note.
  let { view, onsaved }: { view: Record<string, { value: unknown }>; onsaved: (v: Record<string, { value: unknown }>) => void } = $props();
  let message = $state('');
  const val = <T,>(p: string) => view[p]?.value as T;
  const provider = $derived(($status?.analytics?.[0] ?? null) as UiProviderState | null);
  let monthly = $state('');
  let daily = $state('');
  $effect(() => {
    monthly = String(val<number>('analytics.googleVision.monthlyLimit') ?? 0);
    daily = String(val<number>('analytics.googleVision.dailyCap') ?? 0);
  });

  async function put(body: object, what: string) {
    try {
      onsaved(await api('PUT', '/control/config', { analytics: body }));
      message = `${what} saved`;
    } catch (e) {
      message = e instanceof ApiError ? e.message : 'not saved';
    }
  }
  const kinds = ['person', 'vehicle', 'pet'] as const;
  const noKinds = $derived(kinds.every((k) => !val<boolean>(`analytics.kinds.${k}`)));
</script>

<div class="card analytics" data-testid="analytics-settings">
  <h3>Analytics</h3>
  <p class="muted small">Sends the still of an event to an image-analysis service and keeps the objects it finds (a second opinion on the camera's label).</p>
  <fieldset>
    <legend>Analyse these events</legend>
    {#each kinds as k (k)}
      <label><input type="checkbox" data-testid={`analytics-kind-${k}`} checked={val<boolean>(`analytics.kinds.${k}`)} onchange={(e) => void put({ kinds: { [k]: (e.currentTarget as HTMLInputElement).checked } }, `${k} events`)} /> {k}</label>
    {/each}
    <p class="muted small">Motion-only events are never analysed.{noKinds ? ' No kind is selected: nothing is analysed.' : ''}</p>
  </fieldset>

  <div class="provider" data-testid="analytics-provider-google-vision">
    <h4>Google Vision</h4>
    <label class="switch">
      <input type="checkbox" data-testid="analytics-enabled" disabled={!provider?.keyMasked} checked={val<boolean>('analytics.googleVision.enabled')}
        onchange={(e) => void put({ googleVision: { enabled: (e.currentTarget as HTMLInputElement).checked } }, 'Google Vision')} />
      enabled
    </label>
    <p class="small" data-testid="analytics-key">
      Key: {#if provider?.keyMasked}<span class="mono">{provider.keyMasked}</span>{:else}not set: add <span class="mono">CAMPROXY_GOOGLE_VISION_KEY</span> to the environment and restart{/if}
    </p>
    <label>Calls per month <input type="number" min="0" max="100000" bind:value={monthly} data-testid="analytics-monthly" />
      <button onclick={() => void put({ googleVision: { monthlyLimit: Number(monthly) } }, 'Monthly limit')}>Save</button></label>
    <label>At most per day (0 = no cap) <input type="number" min="0" max="10000" bind:value={daily} data-testid="analytics-daily" />
      <button onclick={() => void put({ googleVision: { dailyCap: Number(daily) } }, 'Daily cap')}>Save</button></label>
    <p class="small" data-testid="analytics-estimate">{costEstimate(Number(monthly) || 0)}</p>
    <p class="muted small">The limit counts this proxy's calls only. Proxies that share a key share Google's budget: keep their limits' total within it.</p>
  </div>
  {#if message}<p class="msg" data-testid="analytics-message">{message}</p>{/if}
</div>

<style>
  .analytics { border-left: 4px solid #a855f7; }
  h4 { margin: 8px 0 4px; font-size: 14px; }
  fieldset { border: 0; padding: 0; margin: 0; display: flex; gap: 12px; flex-wrap: wrap; align-items: center; }
  legend { font-size: 13px; color: var(--muted); padding: 0; margin-bottom: 4px; }
  .provider { display: grid; gap: 6px; padding-top: 6px; border-top: 1px solid var(--border); }
  input[type='number'] { width: 90px; }
  .mono { font-family: var(--mono); }
  .muted { color: var(--muted); margin: 0; }
  .small { font-size: 13px; }
</style>
```

(Match `.card`, button and input styles to `Settings.svelte`'s; copy its style block's `.card` rule if the component doesn't inherit it.)

`web/src/pages/Settings.svelte`:
- import `AnalyticsSettings`;
- exclude the `analytics` group from the generic table: in `groups`, skip paths starting with `analytics.`;
- render `<AnalyticsSettings {view} onsaved={(v) => (view = v)} />` before the generic cards.

`web/src/lib/state.ts`: add `analytics?: UiProviderState[]` to the status type (find it with `grep -n "interface\|type" web/src/lib/state.ts`).

`web/src/pages/Status.svelte`: after the Events card, add:

```svelte
      {#each $status.analytics ?? [] as a (a.id)}
        <div class="card" data-testid={`card-analytics-${a.id}`}>
          <h3>Analytics · {a.name}</h3>
          <dl>
            <dt>Usage</dt><dd data-testid="analytics-usage">{usageLine(a)}</dd>
            {#if a.paused}<dt>Paused</dt><dd class="bad">{a.paused.reason === 'bad_key' ? 'invalid key: check CAMPROXY_GOOGLE_VISION_KEY' : `quota: until ${new Date(a.paused.until ?? 0).toLocaleTimeString()}`}</dd>{/if}
            {#if a.lastError}<dt>Last error</dt><dd class="bad">{a.lastError}</dd>{/if}
          </dl>
        </div>
      {/each}
```

(import `usageLine` from `../lib/analytics`). With `enabled: false`, `usageLine` gives "not enabled", which is the spec's "Analytics: not enabled".

- [ ] **Step 4: Run the tests and the type check**

Run: `npx vitest run test/analytics-ui.test.ts && npm run check`
Expected: PASS; `check` exits 0.

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/analytics.ts web/src/components/AnalyticsSettings.svelte web/src/pages/Settings.svelte web/src/pages/Status.svelte web/src/lib/state.ts test/analytics-ui.test.ts
git commit -m "feat(analytics): Settings card and Status card"
```

---

### Task 7: Events column, Timeline marks and the modal

**Files:**
- Create: `web/src/components/AnalysisModal.svelte`
- Modify: `web/src/pages/Events.svelte`, `web/src/pages/Timeline.svelte`, `web/src/lib/timeline.ts`
- Test: `test/timeline-ui.test.ts` (extend)

**Interfaces:**
- Consumes: events with `analysis` (Task 5), `/events/{id}/analysis`, `/events/{id}/analysis.jpg`, stream message `analysis` (the page's existing refresh on `$refreshTick` / the feed), `tagText` (Task 6), `TimelineEvent`, `eventsInMinute` (existing).
- Produces:
  - `TimelineEvent` gains `analysis?: { status: string; stillTs?: number } | null`
  - `minuteMarks(m: { minute: number }, events: TimelineEvent[], now: number): { count: number; analysed: boolean }`
  - `analysedSeconds(m: { minute: number; intervalS: number; present: boolean[] }, stills: { eventId: number; stillTs: number }[]): (number | null)[]` (per tile: the event id whose analysed still it is)

- [ ] **Step 1: Write the failing test** (append to `test/timeline-ui.test.ts`)

```ts
import { analysedSeconds, minuteMarks } from '../web/src/lib/timeline';

describe('analytics marks on the Timeline', () => {
  const m = { minute: M, intervalS: 1, present: Array(60).fill(true) as boolean[] };
  it('counts a minute\'s events and whether one was analysed', () => {
    const evs = [
      { id: 1, kind: 'person', start: M + 1000, end: M + 5000, analysis: { status: 'ok' } },
      { id: 2, kind: 'motion', start: M + 1000, end: M + 5000, analysis: null },
      { id: 3, kind: 'person', start: M + 40_000, end: M + 42_000, analysis: { status: 'skipped' } },
    ];
    expect(minuteMarks(m, evs, M + 60_000)).toEqual({ count: 3, analysed: true });
    expect(minuteMarks(m, evs.slice(1), M + 60_000)).toEqual({ count: 2, analysed: false });
  });
  it('marks the tiles whose still was analysed', () => {
    const t = analysedSeconds(m, [{ eventId: 1, stillTs: M + 2000 }, { eventId: 9, stillTs: M + 90_000 }]);
    expect(t[2]).toBe(1);
    expect(t.filter((x) => x !== null)).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run test/timeline-ui.test.ts`
Expected: FAIL, `minuteMarks is not a function`.

- [ ] **Step 3: Implement**

Append to `web/src/lib/timeline.ts`, and add `analysis?: { status: string; stillTs?: number } | null` to `TimelineEvent`:

```ts
// The hour grid's marks for a minute (spec 2026-09-30-analytics-design): how
// many events it has (×2, ×3), and whether one of them was analysed (ok).
export function minuteMarks(m: { minute: number }, events: TimelineEvent[], now: number): { count: number; analysed: boolean } {
  const list = eventsInMinute(m, events, now);
  return { count: list.length, analysed: list.some((e) => e.analysis?.status === 'ok') };
}

// Per tile of the minute, the id of the event whose analysed still it is.
export function analysedSeconds(m: { minute: number; intervalS: number; present: boolean[] }, stills: { eventId: number; stillTs: number }[]): (number | null)[] {
  return m.present.map((_, i) => {
    const from = m.minute + i * m.intervalS * 1000;
    const hit = stills.find((s) => s.stillTs >= from && s.stillTs < from + m.intervalS * 1000);
    return hit ? hit.eventId : null;
  });
}
```

`GET …/events` returns the summary without `stillTs`. Add `stillTs: a.still_ts` to `analysisSummary` in `src/api/client-api.ts` (Task 5's function) and to that test's expected object, so the Timeline can place the ✦ without an extra request.

Create `web/src/components/AnalysisModal.svelte`:

```svelte
<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '../lib/api';
  import type { UiObject } from '../lib/analytics';

  // The analysis of one event (spec 2026-09-30-analytics-design): the image
  // with its boxes, the objects, the camera's event, and the raw answer.
  let { camId, event, onclose }: { camId: string; event: { id: number; kind: string; start: number; end: number | null }; onclose: () => void } = $props();
  interface Full { provider: string; status: string; reason: string | null; stillTs: number | null; requestedAt: number; tookMs: number | null; objects: UiObject[]; raw: unknown }
  let a = $state<Full | null>(null);
  let failed = $state(false);
  let dialog: HTMLDivElement;
  const base = $derived(`/api/cameras/${encodeURIComponent(camId)}/events/${event.id}`);
  const fmt = (ts: number | null) => (ts === null ? 'now' : new Date(ts).toLocaleTimeString());
  onMount(() => {
    dialog.focus();
    api<Full>('GET', `${base}/analysis`).then((r) => (a = r), () => (failed = true));
  });
  function onkey(e: KeyboardEvent) {
    if (e.key === 'Escape') onclose();
    if (e.key === 'Tab') {
      // Keep focus inside the modal.
      const f = [...dialog.querySelectorAll<HTMLElement>('button, summary, [tabindex="0"]')];
      if (!f.length) return;
      const i = f.indexOf(document.activeElement as HTMLElement);
      const next = e.shiftKey ? (i <= 0 ? f.length - 1 : i - 1) : (i + 1) % f.length;
      f[next].focus();
      e.preventDefault();
    }
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="backdrop" onclick={(e) => e.target === e.currentTarget && onclose()}>
  <div class="modal" role="dialog" aria-modal="true" aria-label="Analysis" tabindex="-1" bind:this={dialog} onkeydown={onkey} data-testid="analysis-modal">
    <div class="head">
      <h3>✦ Analysis · {event.kind} {fmt(event.start)}–{fmt(event.end)}</h3>
      <button onclick={onclose} aria-label="Close" data-testid="analysis-close">✕</button>
    </div>
    {#if failed}<p class="muted">Could not load the analysis.</p>{/if}
    {#if a}
      {#if a.status === 'ok'}
        <div class="figure">
          <img src={`${base}/analysis.jpg`} alt="The analysed still" data-testid="analysis-image" />
          <svg viewBox="0 0 1 1" preserveAspectRatio="none" data-testid="analysis-boxes">
            {#each a.objects as o, i (i)}
              {#if o.box}<rect x={o.box.x0} y={o.box.y0} width={o.box.x1 - o.box.x0} height={o.box.y1 - o.box.y0} vector-effect="non-scaling-stroke" />{/if}
            {/each}
          </svg>
          {#each a.objects as o, i (i)}
            {#if o.box}<span class="label" style={`left:${o.box.x0 * 100}%;top:${o.box.y0 * 100}%`}>{o.name} {o.score.toFixed(2)}</span>{/if}
          {/each}
        </div>
        <table data-testid="analysis-objects">
          <thead><tr><th>object</th><th>score</th></tr></thead>
          <tbody>{#each a.objects as o, i (i)}<tr><td>{o.name}</td><td>{o.score.toFixed(2)}</td></tr>{:else}<tr><td colspan="2" class="muted">Nothing found.</td></tr>{/each}</tbody>
        </table>
      {:else}
        <p data-testid="analysis-reason">Not analysed: {a.reason ?? a.status}.</p>
      {/if}
      <p class="muted small">{a.provider} · {new Date(a.requestedAt).toLocaleString()}{a.tookMs !== null ? ` · ${(a.tookMs / 1000).toFixed(1)} s` : ''}{a.stillTs !== null ? ` · still ${new Date(a.stillTs).toLocaleTimeString()}` : ''}</p>
      {#if a.raw !== null}<details><summary>Raw answer</summary><pre>{JSON.stringify(a.raw, null, 2)}</pre></details>{/if}
    {/if}
  </div>
</div>

<style>
  .backdrop { position: fixed; inset: 0; background: rgb(0 0 0 / 0.5); display: grid; place-items: center; z-index: 50; padding: 16px; }
  .modal { background: var(--surface); border: 1px solid #a855f7; border-radius: var(--radius); padding: 16px; width: min(960px, 100%); max-height: 90vh; overflow: auto; display: grid; gap: 10px; }
  .head { display: flex; justify-content: space-between; align-items: center; gap: 10px; }
  h3 { margin: 0; font-size: 16px; }
  .figure { position: relative; line-height: 0; }
  .figure img { width: 100%; border-radius: 6px; background: #111; }
  .figure svg { position: absolute; inset: 0; width: 100%; height: 100%; }
  rect { fill: none; stroke: #a855f7; stroke-width: 3; }
  .label { position: absolute; transform: translateY(-100%); background: #a855f7; color: #fff; font-size: 12px; line-height: 1.4; padding: 0 4px; border-radius: 3px; white-space: nowrap; }
  table { border-collapse: collapse; font-size: 13px; }
  td, th { padding: 3px 10px 3px 0; text-align: left; }
  pre { font-size: 12px; overflow: auto; max-height: 300px; }
  .muted { color: var(--muted); margin: 0; }
  .small { font-size: 13px; }
  button { padding: 4px 10px; border-radius: 8px; border: 1px solid var(--border); background: var(--surface-2); color: var(--text); cursor: pointer; }
</style>
```

`web/src/pages/Events.svelte`:
- extend the event type with `analysis: UiAnalysis | null`;
- add a header cell `<th>analysis</th>` and a cell per row:

```svelte
<td>{#if tagText(e.analysis)}<button class="tag" class:grey={e.analysis?.status !== 'ok'} data-testid="analysis-tag" onclick={() => (shown = e)}>{tagText(e.analysis)}</button>{/if}</td>
```

- change the empty row's `colspan` to 5;
- `let shown = $state<(typeof events)[number] | null>(null);` and at the end of the section `{#if shown}<AnalysisModal camId={camId} event={shown} onclose={() => (shown = null)} />{/if}` (get `camId` the way `Timeline.svelte` does: the first camera from `/api/cameras`);
- reload the table when an `analysis` stream message arrives: the page's existing feed store (`$feed`) carries stream messages; add a `$effect` that calls the page's load function when the newest `$feed` item has `type === 'analysis'`;
- styles: `.tag { border: 1px solid #a855f7; color: #a855f7; background: none; border-radius: 999px; padding: 0 8px; font-size: 12px; cursor: pointer; } .tag.grey { border-color: var(--border); color: var(--muted); }`.

`web/src/pages/Timeline.svelte`:
- add `analysis?: { status: string; stillTs?: number } | null` to its `Ev` interface (it now matches `TimelineEvent`);
- in the hour grid's minute button, add `class:analysed={minuteMarks(m, events, Date.now()).analysed}` and inside the button a count badge:

```svelte
{@const marks = minuteMarks(m, events, Date.now())}
<button class="thumb {e ? `ev-${e.kind}` : ''}" class:active={open?.minute === m.minute} class:analysed={marks.analysed} ...>
  {#if marks.count > 1}<span class="count" data-testid="minute-count">×{marks.count}</span>{/if}
</button>
```

- in the minute view, compute `const seen = analysedSeconds(m, evs.filter((e) => e.analysis?.stillTs).map((e) => ({ eventId: e.id, stillTs: e.analysis!.stillTs! })));`; a tile with `seen[i] !== null` gets `class:analysed` and a `<span class="spark">✦</span>`, and its click opens the modal for that event instead of the still;
- each event in the minute's event line with `analysis` gets a `<button class="link" data-testid="minute-analysis-link" onclick={() => (shown = e)}>✦ Vision</button>`;
- `let shown = $state<Ev | null>(null)` and `{#if shown}<AnalysisModal {camId} event={shown} onclose={() => (shown = null)} />{/if}`;
- styles: `.thumb { position: relative; } .thumb.analysed, .tile.analysed { outline: 2px solid #a855f7; outline-offset: 1px; } .count { position: absolute; right: 2px; bottom: 2px; background: rgb(0 0 0 / 0.7); color: #fff; font-size: 10px; line-height: 1.3; padding: 0 3px; border-radius: 3px; } .spark { position: absolute; top: 1px; left: 3px; color: #a855f7; font-size: 11px; line-height: 1; } .link { color: #a855f7; background: none; border: 0; padding: 0; cursor: pointer; text-decoration: underline; }`, and `position: relative` on `.tile`;
- the active-minute outline (accent) and the analysed outline (purple) both use `outline`: give `.thumb.active` the accent outline 3 px and `.thumb.analysed` a purple `box-shadow: 0 0 0 2px #a855f7` instead, so both show.

- [ ] **Step 4: Run the tests and the type check**

Run: `npx vitest run test/timeline-ui.test.ts test/analytics-api.test.ts && npm run check`
Expected: PASS; `check` exits 0.

- [ ] **Step 5: Commit**

```bash
git add web/src/components/AnalysisModal.svelte web/src/pages/Events.svelte web/src/pages/Timeline.svelte web/src/lib/timeline.ts src/api/client-api.ts test/timeline-ui.test.ts test/analytics-api.test.ts
git commit -m "feat(analytics): Events tag, Timeline marks and the analysis modal"
```

---

### Task 8: End-to-end with the mock, the live script, docs

**Files:**
- Modify: `e2e/env.ts`, `e2e/start.ts`, `README.md`, `CHANGELOG.md`, `.env.example`
- Create: `e2e/analytics.spec.ts`, `scripts/analytics-live.ts`

**Interfaces:**
- Consumes: everything above; `startVisionMock` (Task 3).
- Produces: `VISION_MOCK_PORT` in `e2e/env.ts`.

- [ ] **Step 1: Write the failing e2e test**

`e2e/env.ts`: add

```ts
export const VISION_MOCK_PORT = 18600;
export const VISION_KEY = 'e2e-vision-key-not-a-secret';
```

`e2e/start.ts`: before `loadConfig(...)`, start the mock on that port (add a `port` option to `startVisionMock`: `server.listen(o.port ?? 0, ...)`), and add `CAMPROXY_GOOGLE_VISION_KEY: VISION_KEY, CAMPROXY_GOOGLE_VISION_URL: \`http://127.0.0.1:${VISION_MOCK_PORT}\`` to the environment object passed to `loadConfig`. Expose the mock's call count for the tests with a tiny route on the mock: `GET /calls` → `{calls}` (add it to `vision-mock.ts`).

```ts
// e2e/analytics.spec.ts
import { test, expect, type Page } from '@playwright/test';
import { ADMIN_TOKEN, SIM, SIM_CONTROL_TOKEN, VISION_MOCK_PORT } from './env';

async function signIn(page: Page) {
  await page.goto('/');
  await page.getByTestId('token-input').fill(ADMIN_TOKEN);
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('shell')).toBeVisible();
}
const calls = async (page: Page) => (await (await page.request.get(`http://127.0.0.1:${VISION_MOCK_PORT}/calls`)).json()).calls as number;
const person = (page: Page) => page.request.post(`http://127.0.0.1:${SIM.control}/sim/api/events`, { headers: { Authorization: `Bearer ${SIM_CONTROL_TOKEN}` }, data: { type: 'person', durationS: 2 } });

test.describe.configure({ mode: 'serial' });

test('with the limit at 0, a person event reaches no analytics call', async ({ page }) => {
  await signIn(page);
  await expect(page.getByTestId('stream-state')).toHaveText('up', { timeout: 30000 });
  await page.getByTestId('nav-settings').click();
  await expect(page.getByTestId('analytics-key')).toContainText('e2e-…cret');
  await page.getByTestId('analytics-enabled').check();
  await expect(page.getByTestId('analytics-message')).toContainText('saved');
  const before = await calls(page);
  expect((await person(page)).status()).toBe(201);
  await page.waitForTimeout(6000);
  expect(await calls(page)).toBe(before);
});

test('a person event is analysed: Status counts it, Events tags it, the Timeline marks it, the modal shows the box', async ({ page }) => {
  await signIn(page);
  await page.getByTestId('nav-settings').click();
  await page.getByTestId('analytics-monthly').fill('10');
  await page.getByTestId('analytics-monthly').locator('xpath=following-sibling::button').click();
  await expect(page.getByTestId('analytics-estimate')).toContainText('Up to 10 calls a month: free');
  const before = await calls(page);
  expect((await person(page)).status()).toBe(201);
  await expect.poll(() => calls(page), { timeout: 20000 }).toBe(before + 1);

  await page.getByTestId('nav-status').click();
  await expect(page.getByTestId('analytics-usage')).toContainText('1 of 10 this month');

  await page.getByTestId('nav-events').click();
  const tag = page.getByTestId('analysis-tag').first();
  await expect(tag).toContainText('✦ Vision: Person 0.90', { timeout: 15000 });
  await tag.click();
  const modal = page.getByTestId('analysis-modal');
  await expect(modal).toBeVisible();
  await expect(modal.getByTestId('analysis-boxes').locator('rect')).toHaveCount(1);
  await expect.poll(() => modal.getByTestId('analysis-image').evaluate((i) => (i as HTMLImageElement).naturalWidth)).toBe(896);
  await page.keyboard.press('Escape');
  await expect(modal).toHaveCount(0);

  await page.getByTestId('nav-timeline').click();
  const analysed = page.locator('[data-testid="minute"].analysed').last();
  await expect(analysed).toBeVisible({ timeout: 15000 });
  await expect(page.locator('[data-testid="minute-count"]').first()).toContainText('×'); // person + its motion event
  await analysed.click();
  await page.getByTestId('minute-analysis-link').first().click();
  await expect(page.getByTestId('analysis-modal')).toBeVisible();
});

test.afterAll(async ({ request }) => {
  // Leave analytics off for the other specs.
  await request.put('/control/config', { headers: { Authorization: `Bearer ${ADMIN_TOKEN}` }, data: { analytics: { googleVision: { enabled: false, monthlyLimit: 0 } } } });
});
```

- [ ] **Step 2: Run it to see it fail, then pass**

Run: `npm run build && npx playwright test e2e/analytics.spec.ts`
Expected before the e2e plumbing (mock port, env): FAIL at `analytics-key` (not set). After Step 1's `e2e/start.ts` change: PASS (2 tests). Then run the whole suite: `npx playwright test`; expected: all pass (other specs unaffected: analytics is off again after this file).

- [ ] **Step 3: The live script**

Create `scripts/analytics-live.ts` (run by hand only: `npx tsx scripts/analytics-live.ts <jpg>...`):

```ts
// Real Google Vision calls, by hand only (never in CI): sends the given JPEGs,
// at most LIMIT (default 5), and prints the time and objects per image.
// Needs CAMPROXY_GOOGLE_VISION_KEY in the environment.
import { readFileSync } from 'fs';
import { basename } from 'path';
import { googleVision } from '../src/analytics/google-vision';

const key = process.env.CAMPROXY_GOOGLE_VISION_KEY;
if (!key) throw new Error('set CAMPROXY_GOOGLE_VISION_KEY');
const limit = Number(process.env.LIMIT ?? 5);
const files = process.argv.slice(2).slice(0, limit);
const vision = googleVision({ key, baseUrl: process.env.CAMPROXY_GOOGLE_VISION_URL ?? 'https://vision.googleapis.com' });
for (const f of files) {
  const t0 = Date.now();
  try {
    const r = await vision.analyze(readFileSync(f), AbortSignal.timeout(10_000));
    console.log(JSON.stringify({ file: basename(f), seconds: (Date.now() - t0) / 1000, objects: r.objects.map((o) => [o.name, Number(o.score.toFixed(2))]) }));
  } catch (err) {
    console.log(JSON.stringify({ file: basename(f), seconds: (Date.now() - t0) / 1000, error: (err as Error).message }));
  }
}
```

Check that `tsx` is available (`npx tsx --version`); if the repo uses another runner for scripts (`grep -n "\"scripts\"" -A15 package.json`), use that and say so in the script's first comment.

- [ ] **Step 4: Docs**

- `README.md`: a new section "Analytics (optional)" after "Clips": what it does; the settings (`analytics.kinds.*`, `analytics.googleVision.{enabled,monthlyLimit,dailyCap}`) with defaults; the key and URL variables; the limits and the shared-key note; the free tier and price as measured (2026-09-30); what is stored and for how long; the API additions (link to openapi); the live script; "cam2's proxy in the cluster has no key (Klaus, 2026-09-30)".
- `.env.example`: `# CAMPROXY_GOOGLE_VISION_KEY=` with a one-line comment.
- `CHANGELOG.md` under Unreleased: "External analytics (optional, off by default): …" in two or three lines.

- [ ] **Step 5: Full check and commit**

Run: `npm test && npm run check && npm run build && npx playwright test`
Expected: all pass. (The flaky control-API test, issue #44, may fail once; re-run and note it.)

```bash
git add e2e/env.ts e2e/start.ts e2e/analytics.spec.ts test/helpers/vision-mock.ts scripts/analytics-live.ts README.md CHANGELOG.md .env.example
git commit -m "feat(analytics): e2e with the mock, a live script, docs"
```

---

## After the plan (not tasks for the implementer)

- **Local `.env`:** rename `GOOGLE_VISION_KEY` to `CAMPROXY_GOOGLE_VISION_KEY` (Klaus).
- **Release, then the Pi:** add the key to `/srv/cam-proxy/.env`, then `docker compose up -d`. Enable it on the Settings page with a small monthly limit.
- **Cluster:** no key for cam2's proxy.
