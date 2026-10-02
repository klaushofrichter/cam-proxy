# Inventory PR 1: the shared module and the stills inventory (#72) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An admin can run a stills inventory from the Maintenance page (or `POST /control/actions/inventory`), follow its progress, cancel it, and read a report of the missing seconds, the longest gaps and why, the seconds a local clip could restore, and broken pack/sprite files; each run is saved and audited.

**Architecture:** `src/inventory/runner.ts` is a kind-agnostic runner (one lock, AbortSignal cancel, progress, JSON result files, the `inventory` audit record) that takes a table of checks. `src/inventory/stills.ts` is the first check: it walks the stills and previews folders of the retention window day by day with async reads, using a new `readPackFooter()` from `src/stills/store.ts`, and reads the audit log (proxy starts, daily storage records) and the clips table. The control API exposes start, cancel, the list and one report; a Svelte card on the Maintenance page drives it.

**Tech Stack:** Node 26+ (engines `>=26`), TypeScript, Express 5, `node:sqlite`, sharp (tests only build fixtures with it), Svelte 5 runes, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-02-inventory-design.md` (sections 1, 2, 3 and 7; issue #72).

## Global Constraints

- No new runtime or dev dependency.
- One run at a time per proxy: a second start answers 409 `{"error":"inventory_busy","detail":…,"runId":<running>}`.
- Start: `POST /control/actions/inventory` `{"kind":"stills"}` → 202 `{runId}`; an unknown or missing kind → 400 `{"error":"invalid","detail":"kind is one of: stills"}`.
- Cancel: `POST /control/actions/inventory-cancel` → 200 `{cancelled, runId}` (`false`, `null` when nothing runs); it stays a `control-action` record.
- `GET /control/inventory` → `{running, runs: {stills: [summary, newest first]}}`; `GET /control/inventory/runs/:id` → the report or the running view; 400 `invalid` for an id not matching `^[a-z]{1,16}-\d{1,15}-[0-9a-f]{6}$`, 404 `not_found`.
- All routes are under `/control` (admin token or admin session; the client and audit tokens get 403).
- Results: `<dataDir>/inventory/<kind>/<runId>.json`, written atomically, the last 10 per kind; run id `<kind>-<startedAt ms>-<6 hex>`.
- Report: `{runId, kind, camera, startedAt, tookMs, outcome: ok|cancelled|failed, error?, cancelledBy?: request|stop, requestedBy, window, counts, top (≤ 10), items (≤ 500), itemsTruncated, message}`.
- Audit: one `inventory` record when a run ends (category `host`, type `info`, user `admin`; outcome `success`, `unknown` for cancelled, `failure`); the start writes no `control-action`; a refused start writes nothing.
- Stills window: `retentionFrom = dayStart(now − retention.stillsDays)` (UTC days), `to = minuteOf(now) − 60 s` (exclusive); reasons `retention` (oldest pack < 1 h after `retentionFrom`; window starts at `retentionFrom`), `budget` (a `storage-daily` record since `retentionFrom` had `kinds.stills.oldest` more than 1 h before the oldest pack), `store-younger`, `empty`; `protectedFrom = now − storage.keepHours.stills h`.
- A gap is explained by the last `proxy-start` inside it (`uncleanStop: true` → `crash`, else `stop`), up to `STARTUP_MS = 120_000` after that start.
- Later kinds (clips, events) and all repairs stay out of this PR; the runner takes a table of checks.
- CHANGELOG entries go under `## Unreleased`; never write a version number.
- No clips or media in commits; fixtures are generated JPEGs in temp folders. Never print secrets or read `.env`.
- Work on a feature branch, PR to `main`; stage files explicitly (`git add <paths>`).

## Review Focus

- A path-like run id in the URL (`/control/inventory/runs/..%2F..%2Fcatalog.sqlite`) must answer 400 and never reach the file system (Task 3 test).
- The proxy stopping mid-run must end the run as `cancelled` with `cancelledBy: stop`, saved and audited before the catalog closes (Task 1 test of `stop()`, Task 3 wires it into `doStop`).
- A changed `stills.intervalS` inside the window (packs at 2 s next to packs at 1 s) must not create false gaps: each pack's own interval decides (Task 2 fixture minute 9).
- The minute being collected and the one being written must not show as a gap at the window's end (Task 2 fixture minute 10 and `window.to`).
- A store with no stills (stills disabled, a fresh install) must answer `ok` with reason `empty` and "no stills stored", not fail (Task 2 test; the e2e run without go2rtc hits it too).

---

## File structure

| File | Responsibility |
|---|---|
| `src/inventory/runner.ts` (new) | The lock, cancel, progress, result files, the `inventory` audit record. Knows no kind. |
| `src/inventory/stills.ts` (new) | The stills check: window, walk, gaps, explanations, restorable seconds, file problems. |
| `src/stills/store.ts` (modify) | Export `PackFooter` and a new async `readPackFooter()`: the pack format stays in one file. |
| `src/api/control-api.ts` (modify) | The two actions, the two GET routes, no `control-action` for `inventory`. |
| `src/proxy.ts` (modify) | Build the runner with the stills check; expose it; stop it in `doStop`. |
| `openapi.yaml`, `README.md`, `docs/audit-log.md`, `CHANGELOG.md` (modify) | The routes, the record, the UI, the change. |
| `web/src/lib/inventory.ts` (new) | Pure helpers for the card (durations, progress, report lines, gap rows). |
| `web/src/components/InventoryCard.svelte` (new) | The Maintenance page's Inventory box. |
| `web/src/pages/Maintenance.svelte`, `web/src/lib/audit.ts` (modify) | Mount the card; `inventory` in the Audit page's action filter. |
| `test/inventory-runner.test.ts`, `test/inventory-stills.test.ts`, `test/inventory-api.test.ts`, `test/inventory-ui.test.ts` (new); `test/audit-ui.test.ts` (modify); `e2e/inventory.spec.ts` (new) | Tests. |

---

### Task 1: The runner

**Files:**
- Create: `src/inventory/runner.ts`
- Test: `test/inventory-runner.test.ts`

**Interfaces:**
- Consumes: `AuditLog.write(i: AuditInput): AuditRecord | null` and `AuditLog.list(q)` from `src/audit/audit-log.ts`; `logger` from `src/log.ts`.
- Produces:
  - `export const KEEP_RUNS = 10; export const MAX_TOP = 10; export const MAX_ITEMS = 500;`
  - `export const RUN_ID: RegExp` (`/^([a-z]{1,16})-(\d{1,15})-([0-9a-f]{6})$/`)
  - `export interface Progress { phase: string; done: number; total: number; note?: string }`
  - `export interface InventoryWindow { from: number | null; to: number; reason: string; [k: string]: unknown }`
  - `export interface CheckResult { window: InventoryWindow; counts: Record<string, number>; top: unknown[]; items: unknown[]; message: string }`
  - `export interface CheckContext { signal: AbortSignal; progress: (p: Progress) => void; now: number }`
  - `export type Check = (ctx: CheckContext) => Promise<CheckResult>`
  - `export type RunOutcome = 'ok' | 'cancelled' | 'failed'`
  - `export interface Requester { requestedBy: 'session' | 'token'; ip?: string; userAgent?: string }`
  - `export interface InventoryReport { runId; kind; camera; startedAt; tookMs; outcome: RunOutcome; error?; cancelledBy?: 'request' | 'stop'; requestedBy; window: InventoryWindow | null; counts; top; items; itemsTruncated: boolean; message }`
  - `export type RunSummary = Pick<InventoryReport, 'runId' | 'kind' | 'startedAt' | 'tookMs' | 'outcome' | 'counts' | 'message'>`
  - `export interface RunningView { runId; kind; startedAt; outcome: 'running'; progress: Progress }`
  - `export class InventoryBusyError extends Error { readonly runId: string }`
  - `export class InventoryRunner` with `checks: Partial<Record<string, Check>>` (public, mutable: tests swap a check), `kinds(): string[]`, `start(kind: string, who: Requester): { runId: string; done: Promise<InventoryReport> }`, `cancel(by?: 'request' | 'stop'): string | null`, `running(): RunningView | null`, `list(): Promise<Record<string, RunSummary[]>>`, `get(runId: string): Promise<InventoryReport | RunningView | undefined>`, `stop(): Promise<void>`. Constructor: `{ dir: string; audit: Pick<AuditLog, 'write'>; camera: () => string; checks: Partial<Record<string, Check>>; now?: () => number; keep?: number }`.

- [ ] **Step 1: Write the failing tests**

Create `test/inventory-runner.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AuditLog } from '../src/audit/audit-log';
import { InventoryBusyError, InventoryRunner, MAX_ITEMS, RUN_ID, type Check, type CheckResult } from '../src/inventory/runner';

const T0 = Date.UTC(2026, 9, 2, 12, 0);
const result = (n: number, items = 0): CheckResult => ({
  window: { from: T0 - 60_000, to: T0, reason: 'retention' },
  counts: { missingSeconds: n },
  top: Array.from({ length: 12 }, (_, i) => ({ i })),
  items: Array.from({ length: items }, (_, i) => ({ i })),
  message: `${n} s missing`,
});

// A check that reports progress, then waits until released (5 s missing) or
// cancelled (2 s missing: the partial counts).
function gated() {
  let release: () => void = () => undefined;
  const check: Check = (ctx) =>
    new Promise((resolve) => {
      ctx.progress({ phase: 'stills', done: 1, total: 8, note: '2026-09-25' });
      release = () => resolve(result(5));
      ctx.signal.addEventListener('abort', () => resolve(result(2)));
    });
  return { check, release: () => release() };
}

// Every runner clock read moves 1 s on: a run takes 1000 ms, and runs get distinct start times.
function setup(checks: Record<string, Check>) {
  const dir = mkdtempSync(join(tmpdir(), 'camproxy-inv-'));
  let clock = T0;
  const audit = new AuditLog({ dir: join(dir, 'audit'), version: 't', camera: () => 'cam1', now: () => clock });
  const runner = new InventoryRunner({ dir: join(dir, 'inventory'), audit, camera: () => 'cam1', checks, now: () => (clock += 1000) });
  return { dir, audit, runner };
}
const who = { requestedBy: 'token' as const, ip: '10.0.0.5', userAgent: 'vitest' };
const records = (a: AuditLog) => a.list({ actions: ['inventory'] }).records;

describe('InventoryRunner', () => {
  it('runs a check, saves the report and writes one inventory record', async () => {
    const { runner, audit, dir } = setup({ stills: async () => result(7) });
    const { runId, done } = runner.start('stills', who);
    expect(runId).toMatch(RUN_ID);
    expect(runId.startsWith('stills-')).toBe(true);
    const r = await done;
    expect(r).toMatchObject({ runId, kind: 'stills', camera: 'cam1', outcome: 'ok', requestedBy: 'token', tookMs: 1000, counts: { missingSeconds: 7 }, message: 'Stills inventory: 7 s missing', itemsTruncated: false });
    expect(r.top).toHaveLength(10);
    expect(JSON.parse(readFileSync(join(dir, 'inventory', 'stills', `${runId}.json`), 'utf8'))).toEqual(r);
    const recs = records(audit);
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({
      event: { action: 'inventory', category: ['host'], type: ['info'], outcome: 'success' },
      user: { name: 'admin' }, source: { ip: '10.0.0.5' }, message: 'Stills inventory: 7 s missing',
      cam_proxy: { runId, kind: 'stills', outcome: 'ok', requestedBy: 'token', counts: { missingSeconds: 7 }, tookMs: 1000 },
    });
    expect((recs[0].cam_proxy as { top: unknown[] }).top).toHaveLength(10);
    expect(runner.running()).toBeNull();
  });

  it('one run at a time: a second start is refused with the running id; progress shows', async () => {
    const g = gated();
    const { runner } = setup({ stills: g.check });
    const a = runner.start('stills', who);
    let busy: unknown;
    try {
      runner.start('stills', who);
    } catch (e) {
      busy = e;
    }
    expect(busy).toBeInstanceOf(InventoryBusyError);
    expect((busy as InventoryBusyError).runId).toBe(a.runId);
    expect(runner.running()).toMatchObject({ runId: a.runId, kind: 'stills', outcome: 'running', progress: { phase: 'stills', done: 1, total: 8, note: '2026-09-25' } });
    expect(await runner.get(a.runId)).toMatchObject({ outcome: 'running' });
    g.release();
    expect((await a.done).outcome).toBe('ok');
    const b = runner.start('stills', who); // the lock is free again
    expect(b.runId).not.toBe(a.runId);
    runner.cancel();
    await b.done;
  });

  it('cancel keeps the partial counts; the record is unknown and says who cancelled', async () => {
    const g = gated();
    const { runner, audit } = setup({ stills: g.check });
    const { runId, done } = runner.start('stills', who);
    expect(runner.cancel()).toBe(runId);
    const r = await done;
    expect(r).toMatchObject({ outcome: 'cancelled', cancelledBy: 'request', counts: { missingSeconds: 2 }, message: 'Stills inventory cancelled (partial): 2 s missing' });
    expect(r).not.toHaveProperty('error');
    expect(records(audit)[0]).toMatchObject({ event: { outcome: 'unknown' }, cam_proxy: { outcome: 'cancelled', cancelledBy: 'request' } });
    expect(runner.cancel()).toBeNull();
  });

  it('a check that throws ends failed, is audited and frees the lock', async () => {
    const { runner, audit } = setup({ stills: async () => { throw new Error('disk gone'); } });
    const r = await runner.start('stills', who).done;
    expect(r).toMatchObject({ outcome: 'failed', error: 'disk gone', counts: {}, window: null, top: [], items: [], message: 'Stills inventory failed: disk gone' });
    expect(records(audit)[0]).toMatchObject({ event: { outcome: 'failure' }, error: { message: 'disk gone' } });
    expect(runner.running()).toBeNull();
  });

  it('keeps the last 10 runs per kind; the list is newest first, without top and items', async () => {
    const { runner, dir } = setup({ stills: async () => result(1) });
    const ids: string[] = [];
    for (let i = 0; i < 12; i++) {
      const s = runner.start('stills', who);
      ids.push(s.runId);
      await s.done;
    }
    expect(readdirSync(join(dir, 'inventory', 'stills')).sort()).toEqual(ids.slice(2).map((id) => `${id}.json`).sort());
    const list = await runner.list();
    expect(list.stills.map((x) => x.runId)).toEqual(ids.slice(2).reverse());
    expect(list.stills[0]).toEqual({ runId: ids[11], kind: 'stills', startedAt: expect.any(Number), tookMs: 1000, outcome: 'ok', counts: { missingSeconds: 1 }, message: 'Stills inventory: 1 s missing' });
    expect(await runner.get(ids[0])).toBeUndefined();
    expect((await runner.get(ids[11]))!).toMatchObject({ runId: ids[11], outcome: 'ok' });
    expect(await runner.get('../../catalog.sqlite')).toBeUndefined();
  });

  it('caps the items at 500 and says so', async () => {
    const { runner } = setup({ stills: async () => result(1, MAX_ITEMS + 1) });
    const r = await runner.start('stills', who).done;
    expect(r.items).toHaveLength(MAX_ITEMS);
    expect(r.itemsTruncated).toBe(true);
  });

  it('stop() cancels a running check as "stop" and waits for its record', async () => {
    const g = gated();
    const { runner, audit } = setup({ stills: g.check });
    runner.start('stills', who);
    await runner.stop();
    expect(records(audit)[0].cam_proxy).toMatchObject({ outcome: 'cancelled', cancelledBy: 'stop' });
    expect(runner.running()).toBeNull();
    await runner.stop(); // nothing runs: returns at once
  });

  it('knows only the kinds it has a check for', () => {
    const { runner } = setup({ stills: async () => result(0) });
    expect(runner.kinds()).toEqual(['stills']);
    expect(() => runner.start('clips', who)).toThrow('no inventory of kind clips');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/inventory-runner.test.ts`
Expected: FAIL with "Failed to load url ../src/inventory/runner" (the module doesn't exist).

- [ ] **Step 3: Write the runner**

Create `src/inventory/runner.ts`:

```ts
import { randomBytes } from 'crypto';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import type { AuditLog } from '../audit/audit-log';
import { logger } from '../log';

// The inventories (spec 2026-10-02-inventory-design): one run at a time per
// proxy, cancellable, with progress. Each finished run (also a cancelled or
// failed one) is a JSON file <dir>/<kind>/<runId>.json, the last 10 per kind,
// and one `inventory` audit record. The runner knows no kind: a kind is a
// check in its table.

export const KEEP_RUNS = 10;
export const MAX_TOP = 10;
export const MAX_ITEMS = 500;
export const RUN_ID = /^([a-z]{1,16})-(\d{1,15})-([0-9a-f]{6})$/;
const LABEL: Record<string, string> = { stills: 'Stills' };

export interface Progress { phase: string; done: number; total: number; note?: string }
export interface InventoryWindow { from: number | null; to: number; reason: string; [k: string]: unknown }
export interface CheckResult { window: InventoryWindow; counts: Record<string, number>; top: unknown[]; items: unknown[]; message: string }
export interface CheckContext { signal: AbortSignal; progress: (p: Progress) => void; now: number }
// A check returns its partial result when the signal aborts (it checks between pages).
export type Check = (ctx: CheckContext) => Promise<CheckResult>;
export type RunOutcome = 'ok' | 'cancelled' | 'failed';
export interface Requester { requestedBy: 'session' | 'token'; ip?: string; userAgent?: string }
export interface InventoryReport {
  runId: string;
  kind: string;
  camera: string;
  startedAt: number;
  tookMs: number;
  outcome: RunOutcome;
  error?: string;
  cancelledBy?: 'request' | 'stop';
  requestedBy: string;
  window: InventoryWindow | null;
  counts: Record<string, number>;
  top: unknown[];
  items: unknown[];
  itemsTruncated: boolean;
  message: string;
}
export type RunSummary = Pick<InventoryReport, 'runId' | 'kind' | 'startedAt' | 'tookMs' | 'outcome' | 'counts' | 'message'>;
export interface RunningView { runId: string; kind: string; startedAt: number; outcome: 'running'; progress: Progress }

export class InventoryBusyError extends Error {
  constructor(readonly runId: string) {
    super(`an inventory is running (${runId})`);
  }
}

interface Current { view: RunningView; ac: AbortController; cancelledBy?: 'request' | 'stop'; done: Promise<InventoryReport> }

export class InventoryRunner {
  readonly checks: Partial<Record<string, Check>>;
  private cur: Current | null = null;
  private readonly now: () => number;

  constructor(private readonly d: { dir: string; audit: Pick<AuditLog, 'write'>; camera: () => string; checks: Partial<Record<string, Check>>; now?: () => number; keep?: number }) {
    this.checks = { ...d.checks };
    this.now = d.now ?? Date.now;
  }

  kinds(): string[] {
    return Object.keys(this.checks).filter((k) => this.checks[k]);
  }

  running(): RunningView | null {
    return this.cur ? { ...this.cur.view, progress: { ...this.cur.view.progress } } : null;
  }

  // Starts a run in the background; throws InventoryBusyError while one runs.
  start(kind: string, who: Requester): { runId: string; done: Promise<InventoryReport> } {
    if (this.cur) throw new InventoryBusyError(this.cur.view.runId);
    const check = this.checks[kind];
    if (!check) throw new Error(`no inventory of kind ${kind}`);
    const startedAt = this.now();
    const runId = `${kind}-${startedAt}-${randomBytes(3).toString('hex')}`;
    const cur: Current = {
      view: { runId, kind, startedAt, outcome: 'running', progress: { phase: 'starting', done: 0, total: 0 } },
      ac: new AbortController(),
      done: Promise.resolve(undefined as never),
    };
    this.cur = cur;
    cur.done = this.run(cur, check, who);
    return { runId, done: cur.done };
  }

  // The running run's id, or null. The run ends soon after, with its partial counts.
  cancel(by: 'request' | 'stop' = 'request'): string | null {
    if (!this.cur) return null;
    this.cur.cancelledBy ??= by;
    this.cur.ac.abort();
    return this.cur.view.runId;
  }

  // The proxy stops: cancel, and wait until the run is saved and audited.
  async stop(): Promise<void> {
    const c = this.cur;
    if (!c) return;
    this.cancel('stop');
    await c.done;
  }

  async list(): Promise<Record<string, RunSummary[]>> {
    const out: Record<string, RunSummary[]> = {};
    for (const kind of this.kinds()) {
      out[kind] = [];
      for (const id of await this.ids(kind)) {
        const r = await this.read(kind, id);
        if (r) out[kind].push({ runId: r.runId, kind: r.kind, startedAt: r.startedAt, tookMs: r.tookMs, outcome: r.outcome, counts: r.counts, message: r.message });
      }
    }
    return out;
  }

  // A report, the running view, or undefined (also for anything that isn't a run id).
  async get(runId: string): Promise<InventoryReport | RunningView | undefined> {
    const m = RUN_ID.exec(runId);
    if (!m) return undefined;
    if (this.cur?.view.runId === runId) return this.running()!;
    return this.read(m[1], runId);
  }

  private async run(cur: Current, check: Check, who: Requester): Promise<InventoryReport> {
    const { runId, kind, startedAt } = cur.view;
    let res: CheckResult | null = null;
    let error: string | undefined;
    try {
      res = await check({ signal: cur.ac.signal, now: startedAt, progress: (p) => void (cur.view.progress = p) });
    } catch (err) {
      error = (err as Error).message;
    }
    const outcome: RunOutcome = cur.ac.signal.aborted ? 'cancelled' : error !== undefined ? 'failed' : 'ok';
    const items = res?.items ?? [];
    const report: InventoryReport = {
      runId, kind, camera: this.d.camera(), startedAt, tookMs: this.now() - startedAt, outcome,
      ...(outcome === 'failed' ? { error } : {}),
      ...(outcome === 'cancelled' ? { cancelledBy: cur.cancelledBy ?? 'request' } : {}),
      requestedBy: who.requestedBy,
      window: res?.window ?? null,
      counts: res?.counts ?? {},
      top: (res?.top ?? []).slice(0, MAX_TOP),
      items: items.slice(0, MAX_ITEMS),
      itemsTruncated: items.length > MAX_ITEMS,
      message: message(kind, outcome, res, error),
    };
    try {
      await this.save(report);
    } catch (err) {
      logger.error({ err: (err as Error).message, runId }, 'inventory_save_failed');
    }
    this.d.audit.write({
      action: 'inventory', category: ['host'], type: ['info'],
      outcome: outcome === 'ok' ? 'success' : outcome === 'failed' ? 'failure' : 'unknown',
      user: 'admin', ip: who.ip, userAgent: who.userAgent, message: report.message,
      ...(report.error ? { error: report.error } : {}),
      details: { runId, kind, outcome, requestedBy: who.requestedBy, ...(report.cancelledBy ? { cancelledBy: report.cancelledBy } : {}), window: report.window, counts: report.counts, top: report.top, tookMs: report.tookMs },
    });
    logger.info({ runId, kind, outcome, tookMs: report.tookMs }, 'inventory_done');
    this.cur = null;
    return report;
  }

  private async save(r: InventoryReport): Promise<void> {
    const dir = join(this.d.dir, r.kind);
    await mkdir(dir, { recursive: true });
    const file = join(dir, `${r.runId}.json`);
    await writeFile(`${file}.tmp`, JSON.stringify(r));
    await rename(`${file}.tmp`, file);
    for (const id of (await this.ids(r.kind)).slice(this.d.keep ?? KEEP_RUNS)) await rm(join(dir, `${id}.json`), { force: true });
  }

  // The run ids of a kind on disk, newest first.
  private async ids(kind: string): Promise<string[]> {
    let names: string[];
    try {
      names = await readdir(join(this.d.dir, kind));
    } catch {
      return [];
    }
    const started = (id: string) => Number(RUN_ID.exec(id)![2]);
    return names
      .filter((n) => n.endsWith('.json'))
      .map((n) => n.slice(0, -5))
      .filter((id) => RUN_ID.exec(id)?.[1] === kind)
      .sort((a, b) => started(b) - started(a) || b.localeCompare(a));
  }

  private async read(kind: string, id: string): Promise<InventoryReport | undefined> {
    try {
      return JSON.parse(await readFile(join(this.d.dir, kind, `${id}.json`), 'utf8')) as InventoryReport;
    } catch {
      return undefined;
    }
  }
}

function message(kind: string, outcome: RunOutcome, res: CheckResult | null, error: string | undefined): string {
  const label = `${LABEL[kind] ?? kind} inventory`;
  if (outcome === 'failed') return `${label} failed: ${error}`;
  if (outcome === 'cancelled') return `${label} cancelled${res ? ` (partial): ${res.message}` : ''}`;
  return `${label}: ${res!.message}`;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/inventory-runner.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Type-check**

Run: `npm run lint:types`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/inventory/runner.ts test/inventory-runner.test.ts
git commit -m "Inventory runner: one run at a time, cancel, progress, results, audit (#72)"
```

---

### Task 2: The stills check

**Files:**
- Modify: `src/stills/store.ts` (export `PackFooter`; add `readPackFooter`)
- Create: `src/inventory/stills.ts`
- Test: `test/inventory-stills.test.ts`

**Interfaces:**
- Consumes (Task 1): `Check`, `CheckResult`, `CheckContext`, `Progress`, `MAX_ITEMS`, `MAX_TOP` from `src/inventory/runner.ts`. From the code base: `MinuteStore`, `minutePath(dataDir, kind, cam, minute)`, `minuteOf(ts)` (`src/stills/store.ts`); `AuditLog.list({actions, from, to, after, limit})` → `{records, next, hasMore}` and `AuditRecord` (`src/audit/audit-log.ts`); `Catalog` (`src/catalog/db.ts`, `.db` is a `DatabaseSync`); `insertClip`, `openCatalog` in tests.
- Produces:
  - in `src/stills/store.ts`: `export interface PackFooter { v: 1; minute: number; intervalS: number; size: string; quality: number; slots: [number, number][] }` and `export async function readPackFooter(file: string): Promise<PackFooter | null>`
  - in `src/inventory/stills.ts`: `export const STARTUP_MS = 120_000`, `export interface StillsSettings { cam: string; intervalS: number; stillsDays: number; keepHours: number }`, `export interface StillsInventoryDeps { dataDir: string; settings: () => StillsSettings; audit: Pick<AuditLog, 'list'>; catalog: Catalog }`, `export interface Gap { from: number; to: number; seconds: number; explained: 'stop' | 'crash' | null; explainedSeconds: number }`, `export interface FileProblem { type: 'unreadable-pack' | 'pack-without-sprite' | 'sprite-without-pack'; minute: number }`, `export type WindowReason = 'retention' | 'budget' | 'store-younger' | 'empty'`, `export function stillsCheck(d: StillsInventoryDeps): Check`.
  - The counts keys, in this order: `stillsDays, minutes, packs, expectedSeconds, presentSeconds, missingSeconds, missingPct, gaps, explainedSeconds, unexplainedSeconds, restorableSeconds, unreadablePacks, packsWithoutSprite, spritesWithoutPack`. The window: `{from, to, reason, retentionFrom, protectedFrom}`.

- [ ] **Step 1: Write the failing tests**

Create `test/inventory-stills.test.ts`:

```ts
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import sharp from 'sharp';
import { AuditLog } from '../src/audit/audit-log';
import { openCatalog, type Catalog } from '../src/catalog/db';
import { insertClip } from '../src/catalog/clips';
import { MinuteStore, minutePath, readPackFooter } from '../src/stills/store';
import { stillsCheck, STARTUP_MS, type StillsInventoryDeps, type StillsSettings } from '../src/inventory/stills';
import type { CheckContext, Progress } from '../src/inventory/runner';

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const M = Date.UTC(2026, 8, 27, 0, 10); // 2026-09-27 00:10 UTC: the fixture's first minute
const NOW = M + 11 * MIN + 5000; // the window ends at M + 10 min: minute 10 is left out
const at = (k: number, s = 0) => M + k * MIN + s * 1000;
const range = (a: number, b: number) => Array.from({ length: b - a }, (_, i) => a + i);
const ALL = range(0, 60);

const stills: Buffer[] = [];
const tiles: Buffer[] = [];
let dir: string;
let catalog: Catalog;
let audit: AuditLog;

const store = (intervalS: number) =>
  new MinuteStore({ dataDir: dir, cam: 'cam1', intervalS, still: { size: '64x36', quality: 5 }, tile: { size: '16x9', grid: intervalS === 1 ? '10x6' : '6x5', quality: 7 } });
async function writeMinute(s: MinuteStore, k: number, slots: number[], intervalS = 1) {
  for (const i of slots) s.add({ ts: at(k) + i * intervalS * 1000, still: stills[i], tile: tiles[i] });
  await s.flush();
}
const settings = (o: Partial<StillsSettings> = {}): StillsSettings => ({ cam: 'cam1', intervalS: 1, stillsDays: 7, keepHours: 24, ...o });
const deps = (o: Partial<StillsInventoryDeps> = {}): StillsInventoryDeps => ({ dataDir: dir, settings: () => settings(), audit, catalog, ...o });
const ctx = (o: Partial<CheckContext> = {}): CheckContext => ({ signal: new AbortController().signal, progress: () => undefined, now: NOW, ...o });
const start = (a: AuditLog, unclean: boolean) =>
  a.write({ action: 'proxy-start', category: ['process'], type: ['start'], outcome: 'success', user: 'system', message: 'started', details: { previousStop: unclean ? null : '2026-09-27T00:13:01.000Z', uncleanStop: unclean } });

// The fixture, minute by minute from M (00:10 UTC):
//  0 full · 1 missing 10–19 · 2 full · 3 nothing (a clean proxy start at +20 s) ·
//  4 full, its sprite deleted · 5 an unreadable pack · 6 full ·
//  7 pack deleted, sprite kept (a crash start at +50 s) · 8 missing 0–29 ·
//  9 full at intervalS 2 · 10 full (left out: the minute being written)
// Clips: [1:15, 1:40) restores 5 s, [8:00, 8:15) restores 15 s, [9:00, 9:30) covers stills that are there.
beforeAll(async () => {
  for (let i = 0; i < 60; i++) {
    const background = { r: i * 4, g: 255 - i * 4, b: 100 };
    stills.push(await sharp({ create: { width: 64, height: 36, channels: 3, background } }).jpeg().toBuffer());
    tiles.push(await sharp({ create: { width: 16, height: 9, channels: 3, background } }).jpeg().toBuffer());
  }
  dir = mkdtempSync(join(tmpdir(), 'camproxy-inv-stills-'));
  const one = store(1);
  await writeMinute(one, 0, ALL);
  await writeMinute(one, 1, ALL.filter((i) => i < 10 || i >= 20));
  await writeMinute(one, 2, ALL);
  await writeMinute(one, 4, ALL);
  await writeMinute(one, 5, ALL);
  await writeMinute(one, 6, ALL);
  await writeMinute(one, 7, ALL);
  await writeMinute(one, 8, range(30, 60));
  await writeMinute(store(2), 9, range(0, 30), 2);
  await writeMinute(one, 10, ALL);
  rmSync(`${minutePath(dir, 'previews', 'cam1', at(4))}.json`);
  rmSync(`${minutePath(dir, 'previews', 'cam1', at(4))}.jpg`);
  writeFileSync(`${minutePath(dir, 'stills', 'cam1', at(5))}.pack`, 'garbage');
  rmSync(`${minutePath(dir, 'stills', 'cam1', at(7))}.pack`);

  catalog = openCatalog(join(dir, 'catalog.sqlite'));
  const clip = (s: number, e: number) => insertClip(catalog, { cam: 'cam1', start_ts: s, end_ts: e, path: join(dir, `clip-${s}.mp4`), stream: 'sub', size: 1, received_at: e, snapshot: null });
  clip(at(1, 15), at(1, 40));
  clip(at(8), at(8, 15));
  clip(at(9), at(9, 30));

  let clock = 0;
  audit = new AuditLog({ dir: join(dir, 'audit'), version: 't', camera: () => 'cam1', now: () => clock });
  clock = at(3, 20);
  start(audit, false);
  clock = at(7, 50);
  start(audit, true);
}, 60_000);

describe('readPackFooter', () => {
  it('reads a good footer and refuses a corrupt, short or missing pack', async () => {
    expect(await readPackFooter(`${minutePath(dir, 'stills', 'cam1', at(0))}.pack`)).toMatchObject({ v: 1, minute: at(0), intervalS: 1 });
    expect((await readPackFooter(`${minutePath(dir, 'stills', 'cam1', at(9))}.pack`))!.slots).toHaveLength(30);
    expect(await readPackFooter(`${minutePath(dir, 'stills', 'cam1', at(5))}.pack`)).toBeNull();
    writeFileSync(join(dir, 'short.pack'), 'CPK');
    expect(await readPackFooter(join(dir, 'short.pack'))).toBeNull();
    expect(await readPackFooter(join(dir, 'nope.pack'))).toBeNull();
  });
});

describe('stills inventory', () => {
  it('counts the missing seconds, the gaps, the restorable seconds and the file problems', async () => {
    const r = await stillsCheck(deps())(ctx());
    expect(r.window).toEqual({ from: M, to: at(10), reason: 'store-younger', retentionFrom: Date.UTC(2026, 8, 20), protectedFrom: NOW - 24 * HOUR });
    expect(r.counts).toEqual({
      stillsDays: 7, minutes: 10, packs: 8, expectedSeconds: 600, presentSeconds: 380, missingSeconds: 220, missingPct: 36.67,
      gaps: 4, explainedSeconds: 150, unexplainedSeconds: 70, restorableSeconds: 20,
      unreadablePacks: 1, packsWithoutSprite: 1, spritesWithoutPack: 1,
    });
    expect(r.items).toEqual([
      { type: 'pack-without-sprite', minute: at(4) },
      { type: 'unreadable-pack', minute: at(5) },
      { type: 'sprite-without-pack', minute: at(7) },
    ]);
    expect(r.message).toBe('220 s of 600 s missing (36.67%) since 2026-09-27T00:10:00.000Z, 4 gaps (longest 90 s), 150 s explained by proxy stops, 20 s restorable from clips, 3 file problems');
  });

  it('lists the longest gaps first, explained by a clean or an unclean proxy start', async () => {
    const r = await stillsCheck(deps())(ctx());
    expect(r.top).toEqual([
      { from: at(7), to: at(8, 30), seconds: 90, explained: 'crash', explainedSeconds: 90 },
      { from: at(3), to: at(4), seconds: 60, explained: 'stop', explainedSeconds: 60 },
      { from: at(5), to: at(6), seconds: 60, explained: null, explainedSeconds: 0 },
      { from: at(1, 10), to: at(1, 20), seconds: 10, explained: null, explainedSeconds: 0 },
    ]);
  });

  it('retention: the window starts at the cutoff; a start explains up to 120 s past itself', async () => {
    expect(STARTUP_MS).toBe(120_000);
    let clock = Date.UTC(2026, 8, 27, 0, 1);
    const a2 = new AuditLog({ dir: join(dir, 'audit-2'), version: 't', camera: () => 'cam1', now: () => clock });
    start(a2, true);
    clock = 0;
    const r = await stillsCheck(deps({ settings: () => settings({ stillsDays: 0 }), audit: a2 }))(ctx());
    expect(r.window).toMatchObject({ from: Date.UTC(2026, 8, 27), to: at(10), reason: 'retention', retentionFrom: Date.UTC(2026, 8, 27) });
    expect(r.counts).toMatchObject({ stillsDays: 0, minutes: 20, expectedSeconds: 1200, missingSeconds: 820, gaps: 5, explainedSeconds: 180 });
    expect(r.top[0]).toEqual({ from: Date.UTC(2026, 8, 27), to: M, seconds: 600, explained: 'crash', explainedSeconds: 180 });
  });

  it('budget: a daily storage record saw older stills than are kept', async () => {
    const a3 = new AuditLog({ dir: join(dir, 'audit-3'), version: 't', camera: () => 'cam1', now: () => M - HOUR });
    a3.write({ action: 'storage-daily', category: ['host'], type: ['info'], outcome: 'success', user: 'system', message: 'Storage', details: { kinds: { stills: { oldest: M - 2 * DAY } } } });
    const r = await stillsCheck(deps({ audit: a3 }))(ctx());
    expect(r.window).toMatchObject({ from: M, reason: 'budget' });
  });

  it('an empty store: reason empty, nothing counted', async () => {
    const r = await stillsCheck(deps({ dataDir: mkdtempSync(join(tmpdir(), 'camproxy-inv-empty-')) }))(ctx());
    expect(r).toEqual({
      window: { from: null, to: at(10), reason: 'empty', retentionFrom: Date.UTC(2026, 8, 20), protectedFrom: NOW - 24 * HOUR },
      counts: expect.objectContaining({ minutes: 0, missingSeconds: 0, gaps: 0 }),
      top: [], items: [], message: 'no stills stored',
    });
  });

  it('reports progress per day, and stops walking once cancelled', async () => {
    const seen: Progress[] = [];
    await stillsCheck(deps())(ctx({ progress: (p) => seen.push(p) }));
    expect(seen[0]).toEqual({ phase: 'stills', done: 0, total: 1 });
    expect(seen.at(-1)).toEqual({ phase: 'stills', done: 1, total: 1, note: '2026-09-27' });
    const ac = new AbortController();
    ac.abort();
    const r = await stillsCheck(deps())(ctx({ signal: ac.signal }));
    expect(r.window).toMatchObject({ from: M });
    expect(r.counts).toMatchObject({ minutes: 0, missingSeconds: 0, gaps: 0 });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/inventory-stills.test.ts`
Expected: FAIL: `readPackFooter` is not exported by `src/stills/store.ts` and `../src/inventory/stills` doesn't exist.

- [ ] **Step 3: Export the footer reader from the store**

In `src/stills/store.ts`, change line 19 from

```ts
interface PackFooter { v: 1; minute: number; intervalS: number; size: string; quality: number; slots: [number, number][] }
```

to

```ts
export interface PackFooter { v: 1; minute: number; intervalS: number; size: string; quality: number; slots: [number, number][] }
```

and add after `writeAtomic` (before `interface Current`):

```ts
// A pack's footer, read async and without the store's cache (the inventory
// walks thousands of packs): the same checks as MinuteStore's own read, plus
// a positive interval. null for a missing, short or corrupt pack.
export async function readPackFooter(file: string): Promise<PackFooter | null> {
  let fh: FileHandle | undefined;
  try {
    fh = await open(file, 'r');
    const { size } = await fh.stat();
    if (size < 8) return null;
    const tail = Buffer.alloc(8);
    await fh.read(tail, 0, 8, size - 8);
    const len = tail.readUInt32LE(0);
    if (!tail.subarray(4).equals(MAGIC) || len <= 0 || len >= 1_000_000 || len > size - 8) return null;
    const json = Buffer.alloc(len);
    await fh.read(json, 0, len, size - 8 - len);
    const f = JSON.parse(json.toString('utf8')) as PackFooter;
    return f.v === 1 && Array.isArray(f.slots) && typeof f.intervalS === 'number' && f.intervalS > 0 ? f : null;
  } catch {
    return null;
  } finally {
    await fh?.close();
  }
}
```

and change the `fs/promises` import (line 3) from `import { open } from 'fs/promises';` to `import { open, type FileHandle } from 'fs/promises';`.

- [ ] **Step 4: Write the stills check**

Create `src/inventory/stills.ts`:

```ts
import { readdir } from 'fs/promises';
import { join } from 'path';
import { setImmediate as yieldToLoop } from 'timers/promises';
import type { AuditLog, AuditRecord } from '../audit/audit-log';
import type { Catalog } from '../catalog/db';
import { minuteOf, readPackFooter } from '../stills/store';
import { MAX_ITEMS, MAX_TOP, type Check, type CheckResult } from './runner';

// The stills inventory (#72, spec 2026-10-02-inventory-design §3): what the
// store should hold for the retention window, and what it holds. Local only.
// The folders are read day by day with async reads, so the server stays
// responsive; the signal is checked between days.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
// Stills resume within this time after a proxy start (go2rtc, then the grabber).
export const STARTUP_MS = 120_000;

export interface StillsSettings { cam: string; intervalS: number; stillsDays: number; keepHours: number }
export interface StillsInventoryDeps {
  dataDir: string;
  settings: () => StillsSettings; // read when a run starts
  audit: Pick<AuditLog, 'list'>;
  catalog: Catalog;
}
export interface Gap { from: number; to: number; seconds: number; explained: 'stop' | 'crash' | null; explainedSeconds: number }
export interface FileProblem { type: 'unreadable-pack' | 'pack-without-sprite' | 'sprite-without-pack'; minute: number }
export type WindowReason = 'retention' | 'budget' | 'store-younger' | 'empty';

const pad = (n: number) => String(n).padStart(2, '0');
const dayStart = (ts: number) => Math.floor(ts / DAY) * DAY;
const dayParts = (ts: number): string[] => {
  const d = new Date(ts);
  return [String(d.getUTCFullYear()), pad(d.getUTCMonth() + 1), pad(d.getUTCDate())];
};
const hhmm = (ts: number) => {
  const d = new Date(ts);
  return `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}`;
};

async function names(dir: string): Promise<Set<string>> {
  try {
    return new Set(await readdir(dir));
  } catch {
    return new Set();
  }
}

// Every audit record of `actions` in [from, to], oldest first.
function records(audit: Pick<AuditLog, 'list'>, actions: string[], from: number, to: number): AuditRecord[] {
  const out: AuditRecord[] = [];
  let after = '';
  for (;;) {
    const page = audit.list({ actions, from, to, after, limit: 500 });
    out.push(...page.records);
    if (!page.hasMore || !page.next) return out;
    after = page.next;
  }
}

// The clips overlapping [from, to), merged, by start (clip times: the camera's clock).
function clipSpans(c: Catalog, cam: string, from: number, to: number): { s: number; e: number }[] {
  const rows = c.db
    .prepare('SELECT start_ts AS s, end_ts AS e FROM clips WHERE cam = ? AND end_ts IS NOT NULL AND start_ts < ? AND end_ts > ? ORDER BY start_ts')
    .all(cam, to, from) as unknown as { s: number; e: number }[];
  const out: { s: number; e: number }[] = [];
  for (const r of rows) {
    const last = out.at(-1);
    if (last && r.s <= last.e) last.e = Math.max(last.e, r.e);
    else out.push({ s: r.s, e: r.e });
  }
  return out;
}

// Runs of missing slots, across minute and day borders.
class Gaps {
  private open: { from: number; to: number } | null = null;
  constructor(private readonly onClose: (from: number, to: number) => void) {}
  missing(ts: number, ms: number): void {
    if (this.open && this.open.to === ts) this.open.to = ts + ms;
    else {
      this.close();
      this.open = { from: ts, to: ts + ms };
    }
  }
  close(): void {
    const g = this.open;
    this.open = null;
    if (g) this.onClose(g.from, g.to);
  }
}

export function stillsCheck(d: StillsInventoryDeps): Check {
  return async (ctx): Promise<CheckResult> => {
    const s = d.settings();
    const now = ctx.now;
    const retentionFrom = dayStart(now - s.stillsDays * DAY);
    // Exclusive: the current minute is in memory, and the one before is written only when the next frame comes.
    const to = minuteOf(now) - MINUTE;
    const protectedFrom = now - s.keepHours * HOUR;
    const stillsDir = join(d.dataDir, 'stills', s.cam);
    const previewsDir = join(d.dataDir, 'previews', s.cam);
    const counts = {
      stillsDays: s.stillsDays, minutes: 0, packs: 0, expectedSeconds: 0, presentSeconds: 0, missingSeconds: 0, missingPct: 0,
      gaps: 0, explainedSeconds: 0, unexplainedSeconds: 0, restorableSeconds: 0,
      unreadablePacks: 0, packsWithoutSprite: 0, spritesWithoutPack: 0,
    };

    // The day folders of the retention window: one readdir each, kept for the walk.
    const days: { start: number; packs: Set<string>; previews: Set<string> }[] = [];
    for (let t = retentionFrom; t < to; t += DAY) {
      const p = dayParts(t);
      days.push({ start: t, packs: await names(join(stillsDir, ...p)), previews: await names(join(previewsDir, ...p)) });
    }

    // The oldest pack before `to` decides where the window starts.
    let oldest: number | null = null;
    for (const day of days) {
      const first = [...day.packs].filter((n) => /^\d{4}\.pack$/.test(n)).sort()[0];
      if (!first) continue;
      const m = day.start + Number(first.slice(0, 2)) * HOUR + Number(first.slice(2, 4)) * MINUTE;
      if (m < to) oldest = m;
      break;
    }
    if (oldest === null) return { window: { from: null, to, reason: 'empty', retentionFrom, protectedFrom }, counts, top: [], items: [], message: 'no stills stored' };
    let from: number;
    let reason: WindowReason;
    if (oldest - retentionFrom < HOUR) {
      from = retentionFrom;
      reason = 'retention';
    } else {
      from = oldest;
      const o = oldest;
      const olderSeen = records(d.audit, ['storage-daily'], retentionFrom, now).some((r) => {
        const v = (r.cam_proxy as { kinds?: { stills?: { oldest?: unknown } } } | undefined)?.kinds?.stills?.oldest;
        return typeof v === 'number' && v < o - HOUR;
      });
      reason = olderSeen ? 'budget' : 'store-younger';
    }

    // Proxy starts in the window: the last one inside a gap explains it.
    const starts = records(d.audit, ['proxy-start'], from, to).map((r) => ({
      t: Date.parse(r['@timestamp']),
      crash: (r.cam_proxy as { uncleanStop?: unknown } | undefined)?.uncleanStop === true,
    }));
    const top: Gap[] = [];
    const gaps = new Gaps((gFrom, gTo) => {
      const st = starts.filter((x) => x.t >= gFrom && x.t < gTo).at(-1);
      const explainedSeconds = st ? Math.round((Math.min(gTo, st.t + STARTUP_MS) - gFrom) / 1000) : 0;
      counts.gaps++;
      counts.explainedSeconds += explainedSeconds;
      top.push({ from: gFrom, to: gTo, seconds: (gTo - gFrom) / 1000, explained: st ? (st.crash ? 'crash' : 'stop') : null, explainedSeconds });
      top.sort((a, b) => b.seconds - a.seconds || a.from - b.from);
      if (top.length > MAX_TOP) top.pop();
    });
    const items: FileProblem[] = [];
    const problem = (type: FileProblem['type'], minute: number) => {
      if (type === 'unreadable-pack') counts.unreadablePacks++;
      else if (type === 'pack-without-sprite') counts.packsWithoutSprite++;
      else counts.spritesWithoutPack++;
      if (items.length <= MAX_ITEMS) items.push({ type, minute }); // one more than kept: the runner flags the cut
    };

    const walk = days.filter((x) => x.start + DAY > from);
    ctx.progress({ phase: 'stills', done: 0, total: walk.length });
    for (const [i, day] of walk.entries()) {
      if (ctx.signal.aborted) break;
      const parts = dayParts(day.start);
      const spans = clipSpans(d.catalog, s.cam, day.start, day.start + DAY);
      let k = 0;
      for (let m = Math.max(from, day.start); m < Math.min(to, day.start + DAY); m += MINUTE) {
        counts.minutes++;
        const name = hhmm(m);
        const json = day.previews.has(`${name}.json`);
        const jpg = day.previews.has(`${name}.jpg`);
        let slots: [number, number][] | null = null;
        let step = s.intervalS; // a minute without a readable pack: the current interval
        if (day.packs.has(`${name}.pack`)) {
          counts.packs++;
          const f = await readPackFooter(join(stillsDir, ...parts, `${name}.pack`));
          if (f) [slots, step] = [f.slots, f.intervalS];
          else problem('unreadable-pack', m);
          if (!json || !jpg) problem('pack-without-sprite', m);
        } else if (json || jpg) problem('sprite-without-pack', m);
        for (let j = 0; j < Math.round(60 / step); j++) {
          const ts = m + j * step * 1000;
          counts.expectedSeconds += step;
          if (slots?.[j]?.[1]) {
            gaps.close();
            continue;
          }
          counts.missingSeconds += step;
          gaps.missing(ts, step * 1000);
          while (k < spans.length && spans[k].e <= ts) k++;
          if (k < spans.length && spans[k].s <= ts) counts.restorableSeconds += step;
        }
      }
      ctx.progress({ phase: 'stills', done: i + 1, total: walk.length, note: parts.join('-') });
      await yieldToLoop();
    }
    gaps.close();

    counts.presentSeconds = counts.expectedSeconds - counts.missingSeconds;
    counts.unexplainedSeconds = counts.missingSeconds - counts.explainedSeconds;
    counts.missingPct = counts.expectedSeconds ? Math.round((counts.missingSeconds / counts.expectedSeconds) * 10_000) / 100 : 0;
    const problems = counts.unreadablePacks + counts.packsWithoutSprite + counts.spritesWithoutPack;
    const message =
      `${counts.missingSeconds} s of ${counts.expectedSeconds} s missing (${counts.missingPct}%) since ${new Date(from).toISOString()}, ` +
      `${counts.gaps} gaps${top[0] ? ` (longest ${top[0].seconds} s)` : ''}, ${counts.explainedSeconds} s explained by proxy stops, ` +
      `${counts.restorableSeconds} s restorable from clips, ${problems} file problems`;
    return { window: { from, to, reason, retentionFrom, protectedFrom }, counts, top, items, message };
  };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/inventory-stills.test.ts test/store.test.ts`
Expected: PASS (7 inventory tests; the store's own tests unchanged).

- [ ] **Step 6: Type-check**

Run: `npm run lint:types`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/stills/store.ts src/inventory/stills.ts test/inventory-stills.test.ts
git commit -m "Stills inventory check: gaps, explained stops, restorable seconds, file problems (#72)"
```

---

### Task 3: The control API, the wiring and the API docs

**Files:**
- Modify: `src/api/control-api.ts` (imports; `ControlDeps`; the `control-action` exclusion; two actions; two GET routes)
- Modify: `src/proxy.ts` (imports; `Proxy.inventory`; build the runner; pass it; stop it)
- Modify: `openapi.yaml`, `README.md` (the route table), `docs/audit-log.md`
- Test: `test/inventory-api.test.ts` (new); `test/openapi.test.ts` must stay green

**Interfaces:**
- Consumes (Task 1): `InventoryRunner`, `InventoryBusyError`, `RUN_ID`, `Check`. (Task 2): `stillsCheck(deps)`. From the code base: `clientIp(req)` (`src/api/auth.ts`), the `fail(status, error, detail?, extra?)` helper inside the actions route, `running.stills.intervalS`, `running.retention.stillsDays`, `running.storage.keepHours.stills`, `running.camera.id`, `running.server.dataDir`.
- Produces: `ControlDeps.inventory: InventoryRunner`; `Proxy.inventory: InventoryRunner` (tests reach `p.proxy.inventory.checks`); the routes in Global Constraints.

- [ ] **Step 1: Write the failing API tests**

Create `test/inventory-api.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { ADMIN_TOKEN, CLIENT_TOKEN, auth, startProxy, until } from './helpers/proxy';
import { startSim } from './helpers/sim';
import type { Check } from '../src/inventory/runner';

const AUDIT_TOKEN = 'audit-token-'.padEnd(40, 'z');
let sim: Awaited<ReturnType<typeof startSim>>;
let p: Awaited<ReturnType<typeof startProxy>>;
beforeAll(async () => {
  sim = await startSim();
  p = await startProxy(sim, { env: { CAMPROXY_AUDIT_TOKEN: AUDIT_TOKEN } });
});
afterAll(async () => {
  await p.proxy.stop();
  await sim.close();
});
const admin = () => auth(ADMIN_TOKEN);
const lines = (text: string) => text.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
const report = async (id: string) => (await request(p.base).get(`/control/inventory/runs/${id}`).set(admin())).body;
const finished = (id: string) => until(async () => (await report(id)).outcome !== 'running');

describe('inventory API', () => {
  it('starts a stills inventory (202), then serves the report and the list', async () => {
    const r = await request(p.base).post('/control/actions/inventory').set(admin()).send({ kind: 'stills' });
    expect(r.status).toBe(202);
    expect(r.body.runId).toMatch(/^stills-\d{1,15}-[0-9a-f]{6}$/);
    await finished(r.body.runId);
    const rep = await report(r.body.runId);
    expect(rep).toMatchObject({ runId: r.body.runId, kind: 'stills', camera: 'cam1', outcome: 'ok', requestedBy: 'token' });
    expect(rep.counts).toHaveProperty('missingSeconds');
    const list = await request(p.base).get('/control/inventory').set(admin());
    expect(list.status).toBe(200);
    expect(list.body.running).toBeNull();
    expect(list.body.runs.stills[0]).toMatchObject({ runId: r.body.runId, outcome: 'ok' });
    expect(list.body.runs.stills[0]).not.toHaveProperty('items');
  });

  it('writes one inventory record per run, and no control-action for the start', async () => {
    const r = await request(p.base).post('/control/actions/inventory').set(admin()).send({ kind: 'stills' });
    await finished(r.body.runId);
    const recs = lines((await request(p.base).get('/control/audit?action=inventory,control-action').set(admin())).text);
    const mine = recs.filter((x) => x.cam_proxy?.runId === r.body.runId);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ event: { action: 'inventory', category: ['host'], type: ['info'], outcome: 'success' }, user: { name: 'admin' }, cam_proxy: { kind: 'stills', outcome: 'ok' } });
    expect(recs.some((x) => x.event.action === 'control-action' && x.cam_proxy?.action === 'inventory')).toBe(false);
  });

  it('refuses an unknown or missing kind with 400', async () => {
    for (const body of [{ kind: 'nope' }, {}]) {
      const r = await request(p.base).post('/control/actions/inventory').set(admin()).send(body);
      expect(r.status).toBe(400);
      expect(r.body).toEqual({ error: 'invalid', detail: 'kind is one of: stills' });
    }
  });

  it('one at a time: 409 inventory_busy while one runs; cancel ends it with its partial counts', async () => {
    const inv = p.proxy.inventory;
    const real = inv.checks.stills;
    const blocking: Check = (ctx) =>
      new Promise((resolve) => ctx.signal.addEventListener('abort', () => resolve({ window: { from: null, to: 0, reason: 'empty' }, counts: { missingSeconds: 3 }, top: [], items: [], message: 'partial' })));
    inv.checks.stills = blocking;
    try {
      const a = await request(p.base).post('/control/actions/inventory').set(admin()).send({ kind: 'stills' });
      expect(a.status).toBe(202);
      const b = await request(p.base).post('/control/actions/inventory').set(admin()).send({ kind: 'stills' });
      expect(b.status).toBe(409);
      expect(b.body).toMatchObject({ error: 'inventory_busy', runId: a.body.runId });
      expect((await request(p.base).get('/control/inventory').set(admin())).body.running).toMatchObject({ runId: a.body.runId, outcome: 'running' });
      const c = await request(p.base).post('/control/actions/inventory-cancel').set(admin());
      expect(c.status).toBe(200);
      expect(c.body).toEqual({ cancelled: true, runId: a.body.runId });
      await finished(a.body.runId);
      expect(await report(a.body.runId)).toMatchObject({ outcome: 'cancelled', cancelledBy: 'request', counts: { missingSeconds: 3 } });
    } finally {
      inv.checks.stills = real;
    }
    expect((await request(p.base).post('/control/actions/inventory-cancel').set(admin())).body).toEqual({ cancelled: false, runId: null });
  });

  it('answers 400 for a path-like run id and 404 for an unknown one', async () => {
    const bad = await request(p.base).get('/control/inventory/runs/..%2F..%2Fcatalog.sqlite').set(admin());
    expect(bad.status).toBe(400);
    expect(bad.body).toEqual({ error: 'invalid', detail: 'not a run id' });
    const none = await request(p.base).get('/control/inventory/runs/stills-1-abcdef').set(admin());
    expect(none.status).toBe(404);
    expect(none.body).toEqual({ error: 'not_found' });
  });

  it('is admin only: the client and the audit token get 403', async () => {
    for (const t of [CLIENT_TOKEN, AUDIT_TOKEN]) {
      expect((await request(p.base).get('/control/inventory').set(auth(t))).status).toBe(403);
      expect((await request(p.base).post('/control/actions/inventory').set(auth(t)).send({ kind: 'stills' })).status).toBe(403);
    }
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/inventory-api.test.ts`
Expected: FAIL: the start answers 404 `not_found` (no such action), and `p.proxy.inventory` is undefined.

- [ ] **Step 3: Add the routes to the control API**

In `src/api/control-api.ts`:

Add to the imports (after the `RecordingsStatus` import, line 24):

```ts
import { InventoryBusyError, RUN_ID, type InventoryRunner } from '../inventory/runner';
```

Add to `ControlDeps` (after `recordings: () => RecordingsStatus; …`, line 73):

```ts
  inventory: InventoryRunner; // spec 2026-10-02-inventory-design: one run at a time
```

Add after the `r.get('/stats', …)` handler (after line 256):

```ts
  // Inventories (spec 2026-10-02-inventory-design): the running one and the last runs; one report.
  r.get('/inventory', async (_req, res) => void res.json({ running: d.inventory.running(), runs: await d.inventory.list() }));
  r.get('/inventory/runs/:id', async (req, res) => {
    if (!RUN_ID.test(req.params.id)) return void res.status(400).json({ error: 'invalid', detail: 'not a run id' });
    const run = await d.inventory.get(req.params.id);
    if (!run) return void res.status(404).json({ error: 'not_found' });
    res.json(run);
  });
```

Change the `control-action` condition (line 300) from

```ts
    if (name !== 'camera-reboot' && name !== 'camera-powercycle' && name !== 'camera-poe-on' && name !== 'restart-proxy' && !(name === 'retention-run' && req.body?.dryRun === true)) {
```

to

```ts
    if (name !== 'camera-reboot' && name !== 'camera-powercycle' && name !== 'camera-poe-on' && name !== 'restart-proxy' && name !== 'inventory' && !(name === 'retention-run' && req.body?.dryRun === true)) {
```

and add `inventory` to the comment above it: "…(their own records, camera-reboot and proxy-restart; an inventory writes `inventory` when it ends) or a retention preview…".

Add two cases before `default:` in the `switch (name)`:

```ts
      // Inventories (spec 2026-10-02-inventory-design): 202 {runId}; the run
      // goes on in the background and writes its own `inventory` record.
      case 'inventory': {
        const kind: unknown = req.body?.kind;
        const kinds = d.inventory.kinds();
        if (typeof kind !== 'string' || !kinds.includes(kind)) return fail(400, 'invalid', `kind is one of: ${kinds.join(', ')}`);
        try {
          const { runId } = d.inventory.start(kind, { requestedBy, ip: clientIp(req), userAgent: req.get('user-agent') });
          return void res.status(202).json({ runId });
        } catch (err) {
          if (!(err instanceof InventoryBusyError)) throw err;
          return fail(409, 'inventory_busy', err.message, { runId: err.runId });
        }
      }
      // A control-action record; the run ends with its partial counts.
      case 'inventory-cancel': {
        const runId = d.inventory.cancel('request');
        return void res.json({ cancelled: runId !== null, runId });
      }
```

- [ ] **Step 4: Wire the runner into the proxy**

In `src/proxy.ts`:

Add to the imports (after the `MinuteStore` import, line 34):

```ts
import { InventoryRunner } from './inventory/runner';
import { stillsCheck } from './inventory/stills';
```

Add to `interface Proxy` (after `readonly audit: AuditLog;`):

```ts
  readonly inventory: InventoryRunner;
```

After `const links = createLoginLinks();` (line 137) add:

```ts
  // Inventories (spec 2026-10-02-inventory-design): one run at a time, the
  // results in <dataDir>/inventory, an `inventory` audit record per run.
  // The settings are read when a run starts.
  const inventory = new InventoryRunner({
    dir: join(running.server.dataDir, 'inventory'),
    audit,
    camera: () => running.camera.id,
    checks: {
      stills: stillsCheck({
        dataDir: running.server.dataDir,
        audit,
        catalog,
        settings: () => ({ cam: running.camera.id, intervalS: running.stills.intervalS, stillsDays: running.retention.stillsDays, keepHours: running.storage.keepHours.stills }),
      }),
    },
  });
```

In the `controlApi({ … })` call, after `recordings: () => recordings.status(),` add:

```ts
      inventory,
```

In the `proxy` object, after `audit,` add:

```ts
    inventory,
```

In `doStop`, change

```ts
      await Promise.all([composer.stop(), analytics.stop(), recordings.stop()]);
```

to

```ts
      // A running inventory is cancelled ('stop'), saved and audited before the catalog closes.
      await Promise.all([composer.stop(), analytics.stop(), recordings.stop(), inventory.stop()]);
```

- [ ] **Step 5: Run the API tests to verify they pass**

Run: `npx vitest run test/inventory-api.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 6: Document the routes in openapi.yaml**

Run `npx vitest run test/openapi.test.ts` first. Expected: FAIL (two routes not documented).

In `openapi.yaml`, insert after the `/control/stats:` block (before `/control/config:`):

```yaml
  /control/inventory:
    get:
      summary: The running inventory and the last 10 runs per kind, newest first (spec 2026-10-02-inventory-design)
      responses:
        '200': { description: '{ running: { runId, kind, startedAt, outcome: running, progress: { phase, done, total, note? } } | null, runs: { stills: [{ runId, kind, startedAt, tookMs, outcome: ok|cancelled|failed, counts, message }] } }' }
  /control/inventory/runs/{id}:
    get:
      summary: One inventory report, or the running view while it runs
      parameters:
        - { name: id, in: path, required: true, schema: { type: string, pattern: '^[a-z]{1,16}-\d{1,15}-[0-9a-f]{6}$' } }
      responses:
        '200': { description: '{ runId, kind, camera, startedAt, tookMs, outcome, error?, cancelledBy? (request|stop), requestedBy, window: { from, to, reason (retention|budget|store-younger|empty), retentionFrom, protectedFrom }, counts, top (the 10 longest gaps), items (up to 500 file problems), itemsTruncated, message }' }
        '400': { description: not a run id }
        '404': { description: unknown run }
```

In the `/control/actions/{name}` block:
- the summary line ends `…, poe-switch-read, restart-proxy (the process), inventory ({kind}), inventory-cancel`;
- append to the `description:` text: `inventory starts an inventory ({"kind":"stills"}) in the background; poll GET /control/inventory/runs/{id}. One at a time. It writes an inventory audit record when it ends, no control-action.`;
- `'200'`: append `; inventory-cancel: { cancelled, runId }`;
- `'202'`: append `; inventory: { runId }`;
- add `'400': { description: 'inventory: invalid (an unknown or missing kind)' }` before `'404'`;
- `'409'`: append `; inventory: inventory_busy { runId } (one runs already)`.

Run: `npx vitest run test/openapi.test.ts`
Expected: PASS.

- [ ] **Step 7: Document the routes in the README and the record in docs/audit-log.md**

In `README.md`, in the "Control API and admin UI" table, add after the `POST /control/actions/restart-proxy` row:

```markdown
| `POST /control/actions/inventory` | `{"kind":"stills"}`: starts an inventory in the background ([the spec](docs/superpowers/specs/2026-10-02-inventory-design.md)); 202 `{runId}`; 400 `invalid` for an unknown kind; 409 `inventory_busy` `{runId}` while one runs (one at a time). Poll `GET /control/inventory/runs/{id}`. Audited as `inventory` when it ends |
| `POST /control/actions/inventory-cancel` | cancels the running inventory: `{cancelled, runId}`; the run keeps its partial counts. Audited as `control-action` |
| `GET /control/inventory` | `{running: {runId, kind, startedAt, outcome: "running", progress: {phase, done, total, note}} or null, runs: {stills: [the last 10 runs, newest first: {runId, kind, startedAt, tookMs, outcome, counts, message}]}}` |
| `GET /control/inventory/runs/{id}` | one report: `{runId, kind, camera, startedAt, tookMs, outcome: ok\|cancelled\|failed, error, cancelledBy, requestedBy, window: {from, to, reason, retentionFrom, protectedFrom}, counts, top, items, itemsTruncated, message}`; 400 for a malformed id, 404 for an unknown one. Kept in `<dataDir>/inventory/<kind>/` (the last 10) |
```

In the "Audit log" section's list, add after "- control actions and settings changes (secret values redacted);":

```markdown
- inventory runs, with their counts;
```

In `docs/audit-log.md`:
- in the `control-action` row, change "except `camera-reboot`, `camera-powercycle`, `camera-poe-on`, `restart-proxy` and a retention dry run (`poe-switch-read` is one)" to "except `camera-reboot`, `camera-powercycle`, `camera-poe-on`, `restart-proxy`, `inventory` (its own record when the run ends) and a retention dry run (`poe-switch-read` and `inventory-cancel` are ones)";
- add a row after the `activity-daily` row:

```markdown
| `inventory` | host / info | the end of each inventory run (`POST /control/actions/inventory`): finished, cancelled or failed | user `admin`; `runId`, `kind` (`stills`), `outcome` (`ok`, `cancelled`, `failed`), `requestedBy`, `cancelledBy` (`request`, or `stop` when the proxy stopped mid-run), `window` (`from`, `to`, `reason`: `retention`, `budget`, `store-younger` or `empty`; `retentionFrom`, `protectedFrom`), `counts` (stills: `stillsDays`, `minutes`, `packs`, `expectedSeconds`, `presentSeconds`, `missingSeconds`, `missingPct`, `gaps`, `explainedSeconds`, `unexplainedSeconds`, `restorableSeconds`, `unreadablePacks`, `packsWithoutSprite`, `spritesWithoutPack`), `top` (the 10 longest gaps: `from`, `to`, `seconds`, `explained`: `stop`, `crash` or null, `explainedSeconds`), `tookMs`. Outcome `success`, `unknown` (cancelled) or `failure` (`error.message`). A refused start (400, 409 `inventory_busy`) writes nothing |
```

- [ ] **Step 8: Run the affected suites and the type check**

Run: `npx vitest run test/inventory-api.test.ts test/openapi.test.ts test/control-api.test.ts test/audit-api.test.ts && npm run lint:types`
Expected: PASS, no type errors.

- [ ] **Step 9: Commit**

```bash
git add src/api/control-api.ts src/proxy.ts openapi.yaml README.md docs/audit-log.md test/inventory-api.test.ts
git commit -m "Inventory API: start, cancel, list, report; stills check wired in (#72)"
```

---

### Task 4: The Inventory box, the Audit filter, e2e and the changelog

**Files:**
- Create: `web/src/lib/inventory.ts`, `web/src/components/InventoryCard.svelte`, `e2e/inventory.spec.ts`, `test/inventory-ui.test.ts`
- Modify: `web/src/pages/Maintenance.svelte`, `web/src/lib/audit.ts`, `test/audit-ui.test.ts`, `README.md` (the Maintenance bullet), `CHANGELOG.md`

**Interfaces:**
- Consumes (Task 3): the HTTP routes and shapes in Global Constraints. From the code base: `api(method, path, body?)` and `ApiError` (`web/src/lib/api.ts`; `ApiError.message` is the body's `detail`).
- Produces: `web/src/lib/inventory.ts` exports `Progress`, `RunningView`, `RunSummary`, `InventoryState`, `Gap`, `StillsReport`, `duration(s: number): string`, `progressText(r: RunningView): string`, `stillsLines(r: StillsReport, fmt?: (ms: number) => string): string[]`, `gapRows(r: StillsReport, fmt?: (ms: number) => string): { from: string; to: string; length: string; why: string }[]`; test ids `inventory`, `inventory-stills`, `inventory-cancel`, `inventory-progress`, `inventory-message`, `inventory-result`, `inventory-gaps`.

- [ ] **Step 1: Write the failing helper tests**

Create `test/inventory-ui.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { duration, gapRows, progressText, stillsLines, type StillsReport } from '../web/src/lib/inventory';

const fmt = (ms: number) => new Date(ms).toISOString().slice(11, 19);
const T = Date.UTC(2026, 8, 27, 0, 10);
const report: StillsReport = {
  runId: 'stills-1-abcdef', kind: 'stills', startedAt: T, tookMs: 812, outcome: 'ok', message: 'Stills inventory: 220 s of 600 s missing',
  window: { from: T, to: T + 600_000, reason: 'store-younger' },
  counts: { missingSeconds: 220, expectedSeconds: 600, missingPct: 36.67, gaps: 4, explainedSeconds: 150, unexplainedSeconds: 70, restorableSeconds: 20, unreadablePacks: 1, packsWithoutSprite: 1, spritesWithoutPack: 1 },
  top: [
    { from: T + 420_000, to: T + 510_000, seconds: 90, explained: 'crash', explainedSeconds: 90 },
    { from: T + 70_000, to: T + 80_000, seconds: 10, explained: null, explainedSeconds: 0 },
  ],
  items: [],
  itemsTruncated: false,
};

describe('Inventory box helpers', () => {
  it('formats durations', () => {
    expect(duration(0)).toBe('0 s');
    expect(duration(59)).toBe('59 s');
    expect(duration(60)).toBe('1 min');
    expect(duration(605)).toBe('10 min 5 s');
    expect(duration(3600)).toBe('1 h');
    expect(duration(5430)).toBe('1 h 30 min');
  });

  it('describes the progress of a run', () => {
    expect(progressText({ runId: 'x', kind: 'stills', startedAt: 0, outcome: 'running', progress: { phase: 'stills', done: 3, total: 8, note: '2026-09-25' } })).toBe('Checking stills… day 3 of 8 (2026-09-25)');
    expect(progressText({ runId: 'x', kind: 'stills', startedAt: 0, outcome: 'running', progress: { phase: 'starting', done: 0, total: 0 } })).toBe('Checking stills…');
  });

  it('sums up a stills report', () => {
    expect(stillsLines(report, fmt)).toEqual([
      'Window: 00:10:00 to 00:20:00 (shorter: the store is younger than the retention)',
      'Missing: 3 min 40 s of 10 min (36.67%) in 4 gaps',
      'Explained by proxy stops: 2 min 30 s; unexplained: 1 min 10 s',
      'Restorable from local clips: 20 s',
      'Files: 1 unreadable packs, 1 packs without sprite, 1 sprites without pack',
    ]);
    expect(stillsLines({ ...report, outcome: 'cancelled' }, fmt)[0]).toBe('Cancelled: the counts are partial');
    expect(stillsLines({ ...report, outcome: 'failed', error: 'disk gone' }, fmt)).toEqual(['Failed: disk gone']);
    expect(stillsLines({ ...report, window: { from: null, to: T, reason: 'empty' } }, fmt)).toEqual(['No stills stored']);
  });

  it('lists the top gaps with their cause', () => {
    expect(gapRows(report, fmt)).toEqual([
      { from: '00:17:00', to: '00:18:30', length: '1 min 30 s', why: 'proxy crash (1 min 30 s)' },
      { from: '00:11:10', to: '00:11:20', length: '10 s', why: '—' },
    ]);
  });
});
```

In `test/audit-ui.test.ts`, add after `expect(ACTIONS).toContain('camera-check'); // #93`:

```ts
    expect(ACTIONS).toContain('inventory'); // #72
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/inventory-ui.test.ts test/audit-ui.test.ts`
Expected: FAIL: `../web/src/lib/inventory` doesn't exist; `ACTIONS` lacks `inventory`.

- [ ] **Step 3: Write the helpers and the Audit filter entry**

Create `web/src/lib/inventory.ts`:

```ts
// The Maintenance page's Inventory box (spec 2026-10-02-inventory-design).

export interface Progress { phase: string; done: number; total: number; note?: string }
export interface RunningView { runId: string; kind: string; startedAt: number; outcome: 'running'; progress: Progress }
export interface RunSummary { runId: string; kind: string; startedAt: number; tookMs: number; outcome: 'ok' | 'cancelled' | 'failed'; counts: Record<string, number>; message: string }
export interface InventoryState { running: RunningView | null; runs: Record<string, RunSummary[]> }
export interface Gap { from: number; to: number; seconds: number; explained: 'stop' | 'crash' | null; explainedSeconds: number }
export interface StillsReport extends RunSummary {
  window: { from: number | null; to: number; reason: string } | null;
  top: Gap[];
  items: { type: string; minute: number }[];
  itemsTruncated: boolean;
  error?: string;
}

const REASONS: Record<string, string> = {
  retention: 'the retention window',
  budget: 'shorter: older stills were deleted for space',
  'store-younger': 'shorter: the store is younger than the retention',
  empty: 'no stills stored',
};
const local = (ms: number) => new Date(ms).toLocaleString();

// 0 s, 59 s, 1 min, 10 min 5 s, 1 h, 1 h 30 min (no seconds once it is hours).
export function duration(seconds: number): string {
  const s = Math.round(seconds);
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min${s % 60 ? ` ${s % 60} s` : ''}`;
  const m = Math.floor((s % 3600) / 60);
  return `${Math.floor(s / 3600)} h${m ? ` ${m} min` : ''}`;
}

export function progressText(r: RunningView): string {
  const p = r.progress;
  return p.total ? `Checking ${r.kind}… day ${p.done} of ${p.total}${p.note ? ` (${p.note})` : ''}` : `Checking ${r.kind}…`;
}

export function stillsLines(r: StillsReport, fmt: (ms: number) => string = local): string[] {
  if (r.outcome === 'failed') return [`Failed: ${r.error ?? 'unknown error'}`];
  if (!r.window || r.window.from === null) return ['No stills stored'];
  const c = r.counts;
  return [
    ...(r.outcome === 'cancelled' ? ['Cancelled: the counts are partial'] : []),
    `Window: ${fmt(r.window.from)} to ${fmt(r.window.to)} (${REASONS[r.window.reason] ?? r.window.reason})`,
    `Missing: ${duration(c.missingSeconds)} of ${duration(c.expectedSeconds)} (${c.missingPct}%) in ${c.gaps} gaps`,
    `Explained by proxy stops: ${duration(c.explainedSeconds)}; unexplained: ${duration(c.unexplainedSeconds)}`,
    `Restorable from local clips: ${duration(c.restorableSeconds)}`,
    `Files: ${c.unreadablePacks} unreadable packs, ${c.packsWithoutSprite} packs without sprite, ${c.spritesWithoutPack} sprites without pack`,
  ];
}

export function gapRows(r: StillsReport, fmt: (ms: number) => string = local): { from: string; to: string; length: string; why: string }[] {
  return r.top.map((g) => ({
    from: fmt(g.from),
    to: fmt(g.to),
    length: duration(g.seconds),
    why: g.explained ? `proxy ${g.explained} (${duration(g.explainedSeconds)})` : '—',
  }));
}
```

In `web/src/lib/audit.ts`, add `'inventory'` to `ACTIONS` after `'activity-daily'`:

```ts
export const ACTIONS = ['proxy-start', 'proxy-stop', 'proxy-restart', 'camera-reboot', 'camera-powercycle', 'camera-poe-on', 'camera-check', 'login', 'logout', 'login-link-issued', 'auth-refused', 'control-action', 'config-change', 'secret-override', 'storage-daily', 'activity-daily', 'inventory', 'audit-throttled'];
```

- [ ] **Step 4: Run the helper tests to verify they pass**

Run: `npx vitest run test/inventory-ui.test.ts test/audit-ui.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the Inventory card and mount it**

Create `web/src/components/InventoryCard.svelte`:

```svelte
<script lang="ts">
  import { onMount } from 'svelte';
  import { api, ApiError } from '../lib/api';
  import { gapRows, progressText, stillsLines, type InventoryState, type StillsReport } from '../lib/inventory';

  // The inventories (spec 2026-10-02-inventory-design): start one, follow its
  // progress (polled every second while it runs), cancel it, and show the
  // newest stills report. One run at a time per proxy.
  let inv = $state<InventoryState | null>(null);
  let report = $state<StillsReport | null>(null);
  let message = $state('');
  let starting = $state(false);
  const busy = $derived(!!inv?.running);

  async function load() {
    const s = await api<InventoryState>('GET', '/control/inventory');
    inv = s;
    const last = s.runs.stills?.[0];
    if (last && last.runId !== report?.runId) report = await api<StillsReport>('GET', `/control/inventory/runs/${encodeURIComponent(last.runId)}`);
  }
  const reload = () => load().catch(() => (message = 'Could not load the inventory.'));
  onMount(() => void reload());
  $effect(() => {
    if (!busy) return;
    const t = setInterval(() => void reload(), 1000);
    return () => clearInterval(t);
  });

  async function start() {
    if (starting || busy) return;
    starting = true;
    message = '';
    try {
      await api('POST', '/control/actions/inventory', { kind: 'stills' });
    } catch (e) {
      message = `Inventory: ${e instanceof ApiError ? e.message : 'failed'}`;
    }
    starting = false;
    await reload();
  }
  async function cancel() {
    try {
      await api('POST', '/control/actions/inventory-cancel');
    } catch (e) {
      message = `Cancel: ${e instanceof ApiError ? e.message : 'failed'}`;
    }
    await reload();
  }
</script>

<div class="card" data-testid="inventory">
  <h3>Inventory</h3>
  <p class="small">Checks the local stills against what the store should hold for the retention window; it never contacts the camera. One run at a time.</p>
  <div class="buttons">
    <button onclick={() => void start()} disabled={starting || busy} data-testid="inventory-stills">Check stills</button>
    {#if busy}<button onclick={() => void cancel()} data-testid="inventory-cancel">Cancel</button>{/if}
  </div>
  {#if inv?.running}<p class="busy" data-testid="inventory-progress">{progressText(inv.running)}</p>{/if}
  {#if message}<p class="bad" data-testid="inventory-message">{message}</p>{/if}
  {#if report}
    <div class="result" data-testid="inventory-result">
      <p class="line">{report.message}</p>
      <p class="small">{new Date(report.startedAt).toLocaleString()}, took {(report.tookMs / 1000).toFixed(1)} s</p>
      <ul>
        {#each stillsLines(report) as l, i (i)}<li>{l}</li>{/each}
      </ul>
      {#if report.top.length}
        <table data-testid="inventory-gaps">
          <thead><tr><th>from</th><th>to</th><th>length</th><th>cause</th></tr></thead>
          <tbody>
            {#each gapRows(report) as g, i (i)}<tr><td class="mono">{g.from}</td><td class="mono">{g.to}</td><td>{g.length}</td><td>{g.why}</td></tr>{/each}
          </tbody>
        </table>
      {/if}
    </div>
  {/if}
</div>

<style>
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 16px; display: grid; gap: 8px; }
  h3 { margin: 0; font-size: 16px; }
  p { margin: 0; }
  ul { margin: 0; padding-left: 18px; }
  .result { display: grid; gap: 6px; }
  .line { font-weight: 600; }
  .small { font-size: 13px; color: var(--muted); }
  .busy { color: var(--accent); font-weight: 600; }
  .bad { color: var(--danger); }
  .mono { font-family: var(--mono); }
  .buttons { display: flex; flex-wrap: wrap; gap: 8px; }
  button { padding: 7px 12px; border-radius: 8px; border: 1px solid var(--border); background: var(--surface-2); cursor: pointer; color: var(--text); }
  button:hover { border-color: var(--accent); }
  button:disabled { opacity: 0.5; cursor: default; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 3px 8px; border-bottom: 1px solid var(--border); }
</style>
```

In `web/src/pages/Maintenance.svelte`, add to the imports (after the `ConfirmDialog` import):

```ts
  import InventoryCard from '../components/InventoryCard.svelte';
```

and put the card between the actions card and the log card, i.e. replace

```svelte
  </div>
  <div class="card">
    <div class="loghead"><h3>Log</h3><span class="small">updates every 10 s</span></div>
```

with

```svelte
  </div>
  <InventoryCard />
  <div class="card">
    <div class="loghead"><h3>Log</h3><span class="small">updates every 10 s</span></div>
```

- [ ] **Step 6: Type-check the UI and build it**

Run: `npm run check && npm run build`
Expected: no errors; `dist/web` is rebuilt.

- [ ] **Step 7: Write the e2e test**

Create `e2e/inventory.spec.ts`:

```ts
import { test, expect } from '@playwright/test';
import { ADMIN_TOKEN, PROXY_PORT } from './env';

// The stills inventory (#72) from the Maintenance page's Inventory box.
test('Check stills: the result shows, and the audit log has the run', async ({ page, request }) => {
  await page.goto('/#/maintenance');
  await expect(page.getByTestId('inventory-stills')).toBeEnabled();
  const [resp] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/control/actions/inventory') && r.request().method() === 'POST'),
    page.getByTestId('inventory-stills').click(),
  ]);
  expect(resp.status()).toBe(202);
  const { runId } = (await resp.json()) as { runId: string };
  await expect(page.getByTestId('inventory-result')).toContainText('Stills inventory', { timeout: 30_000 });
  await expect(page.getByTestId('inventory-stills')).toBeEnabled();
  await expect
    .poll(async () => {
      const r = await request.get(`http://127.0.0.1:${PROXY_PORT}/control/audit?action=inventory&limit=20`, { headers: { Authorization: `Bearer ${ADMIN_TOKEN}` } });
      const recs = (await r.text()).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as { cam_proxy?: Record<string, unknown> });
      return recs.find((x) => x.cam_proxy?.runId === runId)?.cam_proxy ?? null;
    }, { timeout: 10_000 })
    .toMatchObject({ kind: 'stills', outcome: 'ok', requestedBy: 'session' });
});
```

- [ ] **Step 8: Run the e2e test**

Run: `npm run test:e2e -- e2e/inventory.spec.ts`
Expected: PASS (2 tests: the setup sign-in and this one). Without go2rtc in `tools/` the store is empty and the panel shows "Stills inventory: no stills stored"; the test passes either way.

- [ ] **Step 9: README Maintenance bullet and CHANGELOG**

In `README.md`, in the admin UI list, append to the end of the **Maintenance** bullet (after "After 2 minutes without the proxy it says so."):

```markdown
  The Inventory box's "Check stills" checks the stills of the retention
  window in the background: the missing seconds, the 10 longest gaps and
  whether a proxy stop or crash explains them, the seconds a local clip
  could restore, and unreadable packs or sprites without their pack. It shows
  the progress (with Cancel) and the newest result.
```

In `CHANGELOG.md`, add under `## Unreleased` (as the first bullet):

```markdown
- Stills inventory (#72, spec 2026-10-02-inventory-design): the Maintenance page's Inventory box ("Check stills"; `POST /control/actions/inventory` `{"kind":"stills"}`, admin only) checks the stills of the retention window in the background: missing seconds and %, the 10 longest gaps and whether a proxy stop or crash explains them (from the audit log), the missing seconds a local clip covers ("restorable"), unreadable packs, packs without a sprite and sprites without a pack. Progress and Cancel (`POST /control/actions/inventory-cancel`); one run at a time (409 `inventory_busy`). Results: `GET /control/inventory` and `GET /control/inventory/runs/{id}`, the last 10 kept in `<dataDir>/inventory/stills/`. Each run writes an `inventory` audit record (the start writes no `control-action`); the Audit page can filter by it.
```

- [ ] **Step 10: The whole suite**

Run: `npm run lint:types && npm run check && npm test && npm run test:e2e`
Expected: all pass.

- [ ] **Step 11: Commit**

```bash
git add web/src/lib/inventory.ts web/src/components/InventoryCard.svelte web/src/pages/Maintenance.svelte web/src/lib/audit.ts test/inventory-ui.test.ts test/audit-ui.test.ts e2e/inventory.spec.ts README.md CHANGELOG.md
git commit -m "Maintenance page: Inventory box with Check stills, progress, cancel and result (#72)"
```

---

## Self-review notes

- Spec coverage (sections 1, 2, 3, 7 for stills): lock, cancel, progress, JSON results and the last 10 (Task 1); window and reasons, walk, gaps, explained, restorable, file problems, counts, message (Task 2); API, 409, admin only, no `control-action` for the start, `stop()` in `doStop`, openapi, README routes, audit-log.md (Task 3); the Maintenance box, the Audit filter, e2e, CHANGELOG (Task 4). Clips, events, repairs, `camera?` and `inventory-repair` are PR 2 to PR 4.
- Names used across tasks: `InventoryRunner`, `InventoryBusyError`, `RUN_ID`, `MAX_ITEMS`, `MAX_TOP`, `Check`, `CheckResult`, `CheckContext`, `Progress`, `stillsCheck`, `STARTUP_MS`, `readPackFooter`, `PackFooter`, `ControlDeps.inventory`, `Proxy.inventory`.
- Dry run (2026-10-02): this plan's code, applied to `main` at 87b9bfd in a scratch tree, passed `npm run lint:types`, `npm run check`, `npm run build`, `npm test` (73 files, 890 tests) and `e2e/inventory.spec.ts`. Nothing of it was committed.
