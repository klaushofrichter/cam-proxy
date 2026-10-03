# Inventory PR 2: the clips inventory, the camera compare and the repair (#74) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An admin can check the clips of the retention window (rows without a file, files without a row, recording events without a clip, clips without an event), compare them with the camera's SD card, and fetch the clips the proxy lost from the SD card over Baichuan, from the Maintenance page or the control API; every run and every repair is saved and audited.

**Architecture:** PR 1's runner (`src/inventory/runner.ts`) gains start options (`camera: true`), a repair op that shares the one lock, keeps its runs in `<dir>/<kind>repair/` and writes `inventory-repair` records, and a summary cache (#106). New modules: `camera-list.ts` (the SD recordings of a window through `RecordingList`: the month overview, one Search per day with recordings, failed days `unknown`), `match.ts` (pairing by start ±5 s on one stream), `clips.ts` (the check, local part and camera part) and `repair-clips.ts` (the repair through `RecordingFetcher` at `low` priority, the cache pin, `ClipIndexer.addRecording`). Catalog migration 6 adds `clips.origin` (`ftp` | `camera`); the Clips page marks "from camera". The control API gets `camera` on `inventory` and the `inventory-repair` action; the Inventory box gets the clips buttons, the clips result and the repair offer.

**Tech Stack:** Node 26+ (engines `>=26`), TypeScript, Express 5, `node:sqlite`, ffmpeg/ffprobe (tests make a 2-3 s test video), Svelte 5 runes, Vitest, Playwright, cam-sim v2026.10.02.1 (already pinned: SD card, Search, Baichuan downloads, the `baichuan.refuse` and `offline` faults; no bump).

**Spec:** `docs/superpowers/specs/2026-10-02-inventory-design.md` (§0 corrections 1, 6, 7, 8, 9; §1; §2; §4 clips parts 1-3; §7 decisions 1-5, 7, 8, 10, 13; error handling; risks; "Rulings during the build"); issues #74 and #106 (its "PR 2 needs additive runner changes" and summary-cache items).

## Global Constraints

- No new runtime or dev dependency; cam-sim stays at v2026.10.02.1.
- One lock for every inventory and repair: a second start (check or repair) answers 409 `{"error":"inventory_busy","detail":…,"runId":<running>}`.
- Start a check: `POST /control/actions/inventory` `{"kind":"clips"}` or `{"kind":"clips","camera":true}` → 202 `{runId}`; 400 `invalid` for an unknown kind, a non-boolean `camera` (`camera is true or false`), or `camera: true` for a kind without a compare (`the stills inventory has no camera compare`).
- Start a repair: `POST /control/actions/inventory-repair` `{"kind":"clips","runId":"clips-…"}` → 202 `{runId}` (`clipsrepair-<ms>-<6 hex>`); 400 `invalid` (`kind is one of: clips`, `runId is the id of a check run`); 404 `not_found` (no such run of that kind); 409 `report_stale` (the check started 1 h ago or more), 409 `not_repairable` (not `ok`, no camera compare: `compare the clips with the camera first`, or nothing missing: `nothing is missing locally`); 503 `stopping`. A refused start writes no audit record; neither start writes a `control-action`.
- `GET /control/inventory` → `{running: {runId, kind, op: 'check'|'repair', startedAt, outcome: 'running', progress} | null, runs: {stills, clips}, repairs: {clips}}`; summaries cached in memory, read from disk once and again after each save.
- Repair reports: `<dataDir>/inventory/clipsrepair/<runId>.json`, the last 10; report fields as a check's plus `op: 'repair'`, `source` (the check run id), `stopped` (`clip-cap` | `byte-cap` | `max-gb` | `paused` | `failures` | `refused` | `camera_offline` | null), `window` = the source's window; check reports gain `op: 'check'` and `options: {camera: true}` when compared.
- Audit: `inventory-repair` (category `host`, type `change`, user `admin`, outcome like `inventory`): `runId`, `kind`, `source`, `outcome`, `requestedBy`, `cancelledBy`, `stopped`, `counts` (`candidates`, `requested`, `done`, `failed`, `skipped`, `bytes`), `failures` (≤ 10: `id`, `start`, `error`), `tookMs`.
- Clips window: `from = dayStart(now − retention.clipsDays · 1 day)` (UTC), `to = now`; reason `retention`. Events and recordings that ended less than `SETTLE_MS = 300_000` before now are not judged.
- Recording kinds: `motion`, `person`, `vehicle`, `pet`. Timer-only recordings (no trigger) are ignored and counted (`timerOnly`).
- Compare: stream = `ftp.stream` at run time (default `main`; cluster and tests `sub`); one Search per camera-local day that the month overview lists, through `RecordingList` (its gate and caches); a busy Search tried 3 times, 1 s apart; a failed day is `unknown`: never "missing locally", its clips never "gone from the camera"; an offline camera fails the run with `camera_offline: …`.
- Pairing: same stream, starts at most `START_SLACK_MS = 5000` apart, one to one, closest first.
- Repair: `ftp.stream`; `RecordingFetcher.get(entry, {priority: 'low'})` (a viewer's `high` fetch, queued or running, goes first; no pre-emption); the camera path from `RecordingList.find` (never from the report); before each clip: storage not paused, inside the clips retention, same stream, no local clip within 5 s, still listed; caps `REPAIR_MAX_CLIPS = 50`, `REPAIR_MAX_BYTES = 200 · 2^20`, `ftp.maxGB`; `REPAIR_GAP_MS = 1000` between downloads; stops after `REPAIR_MAX_FAILURES = 3` failures in a row, at once on `refused` or an offline camera; candidates oldest first (the SD card overwrites them first; ruling (a) during the build, the plan said newest first).
- Repaired clips: copied from the pinned cache file into `clips/<cam>/YYYY/MM/DD/HHMM-<start>.mp4`, row `origin: 'camera'`, the FTP picture linked when there is one; no stream-log message, no SSE (decision 3); not an FTP arrival (`clip_arrivals`) and not in the daily `clipsReceived` count; counted in the storage budget.
- Catalog schema version 6 (`ALTER TABLE clips ADD COLUMN origin TEXT NOT NULL DEFAULT 'ftp'`); never edit migrations 1-5.
- CHANGELOG entries go under `## Unreleased`; never write a version number.
- No clips or media in commits; test videos are generated by ffmpeg in temp folders. Never print secrets or read `.env`.
- Work on a feature branch, PR to `main`; stage files explicitly (`git add <paths>`).

## Review Focus

- A clip still on its way (an event or recording that ended a moment ago, the FTP upload not finished) must not show as "missing locally" or "event without clip": both wait `SETTLE_MS` (Task 4 fixture: the recording ending 90 s before now and the event ending 30 s before now are left out).
- A day whose Search failed must never turn into "missing locally" nor its local clips into "gone from the camera" (Task 3 `unknown` day; Task 4 "a local clip on an unknown day is never gone").
- A viewer opening a recording while a repair runs must not wait behind the repair's queue: the viewer's `high` fetch goes first, the repair's `low` one after (Task 6 first test, with a real `RecordingFetcher`).
- A repaired clip must not hide an FTP stall: it is no arrival (`clip_arrivals`, the "no clip for N hours" warning) and not "received" in the daily count (Task 2 migration and count tests).
- Things that change between the compare and the repair: a clip that arrived by FTP meanwhile, a recording the SD card overwrote, a changed `ftp.stream` or a paused disk are each skipped or stop the run, never fetched twice (Task 6 "checks each one again" and caps tests).

---

## File structure

| File | Responsibility |
|---|---|
| `src/inventory/runner.ts` (modify) | Start options, the repair op (shares the lock, own folder, `inventory-repair` record), `op` in the running view, the summary cache. |
| `src/catalog/migrations.ts`, `src/catalog/clips.ts` (modify) | Migration 6 (`origin`, the arrivals trigger only for FTP clips); `ClipOrigin`, `insertClip` with `origin`, `countClips` FTP only. |
| `src/api/client-api.ts`, `web/src/pages/Clips.svelte`, `openapi.yaml` (modify) | `origin` in the clip list; the "from camera" chip. |
| `src/inventory/match.ts` (new) | `pairByStart()`: the pairing rule. |
| `src/inventory/camera-list.ts` (new) | `listCamera()`: the SD recordings of a window, day by day, `unknown` days. |
| `src/inventory/clips.ts` (new) | The clips check: local part, camera part, items, top, message. |
| `src/clips/indexer.ts` (modify) | `ClipIndexer.addRecording()`: a fetched recording into clips/ with `origin: 'camera'`. |
| `src/inventory/repair-clips.ts` (new) | The clips repair and its `ready()` rule. |
| `src/proxy.ts`, `src/api/control-api.ts` (modify) | The clips kind with its repair; `camera` and `inventory-repair` in the API; `repairs` in the list. |
| `README.md`, `docs/audit-log.md`, `CHANGELOG.md` (modify) | The routes, the records, the UI, the change. |
| `web/src/lib/inventory.ts`, `web/src/components/InventoryCard.svelte`, `web/src/lib/audit.ts` (modify) | Clips lines, the repair offer, the buttons and panels; `inventory-repair` in the Audit filter. |
| Tests: `test/inventory-runner.test.ts`, `test/catalog.test.ts`, `test/catalog-analyses.test.ts`, `test/catalog-counts.test.ts`, `test/clips-api.test.ts`, `test/clips-indexer.test.ts`, `test/inventory-api.test.ts`, `test/inventory-ui.test.ts`, `test/audit-ui.test.ts`, `e2e/inventory.spec.ts` (modify); `test/inventory-match.test.ts`, `test/inventory-camera-list.test.ts`, `test/inventory-clips.test.ts`, `test/inventory-repair-clips.test.ts`, `test/inventory-clips-api.test.ts` (new) | |

---

### Task 1: The runner: start options, repairs, `op`, cached summaries (#106)

**Files:**
- Modify: `src/inventory/runner.ts` (whole file below)
- Test: `test/inventory-runner.test.ts`

**Interfaces:**
- Consumes: PR 1's runner as it is on the base branch; `AuditLog.write` (`details` become `cam_proxy`).
- Produces (all exported from `src/inventory/runner.ts`, in addition to PR 1's names, which keep their meaning):
  - `export const REPAIR_MAX_AGE_MS = 3_600_000;` and `export const repairFolder = (kind: string): string` (returns `<kind>repair`, the folder and run-id prefix of a kind's repairs)
  - `export type Op = 'check' | 'repair';` `export interface StartOptions { camera?: boolean }`
  - `CheckContext` gains `options?: StartOptions` (optional, so PR 1's stills check and its tests stay as they are).
  - `export interface RepairResult { counts: Record<string, number>; top: unknown[]; items: unknown[]; message: string; stopped: string | null }`
  - `export interface RepairContext { signal: AbortSignal; progress: (p: Progress) => void; now: number; source: InventoryReport }`
  - `export type Repair = (ctx: RepairContext) => Promise<RepairResult>;` `export interface RepairEntry { run: Repair; ready: (source: InventoryReport) => string | null }`
  - `InventoryKind` = `{ label: string; run: Check; camera?: boolean; repair?: RepairEntry }`
  - `InventoryReport` gains `op?: Op`, `options?: StartOptions`, `source?: string`, `stopped?: string | null`; `RunningView` gains `op: Op`.
  - `export class RepairRefusedError extends Error { readonly code: 'not_found' | 'report_stale' | 'not_repairable' }`
  - `InventoryRunner`: `start(kind, who, options?: StartOptions)`, `repairKinds(): string[]`, `repair(kind: string, who: Requester, sourceId: string): Promise<{ runId: string; done: Promise<InventoryReport> }>`, `listRepairs(): Promise<Record<string, RunSummary[]>>`; `list()` now served from a cache.

- [ ] **Step 1: Write the failing tests**

In `test/inventory-runner.test.ts`, replace the import of the runner with:

```ts
import { InventoryBusyError, InventoryRunner, InventoryStoppingError, MAX_ITEMS, RepairRefusedError, RUN_ID, type Check, type CheckResult, type InventoryKind, type Repair, type RepairResult } from '../src/inventory/runner';
```

In `setup()`, let the tests move the clock (replace its `return` line):

```ts
  return { dir, audit, runner, advance: (ms: number) => void (clock += ms) };
```

Append at the end of the file:

```ts
// PR 2 (#106): options, repairs apart from checks, one lock, cached summaries.
describe('InventoryRunner: options and repairs', () => {
  const repaired = (n: number): RepairResult => ({ counts: { requested: n, done: n, failed: 0, skipped: 0, bytes: n * 10 }, top: [], items: [{ id: 'a', result: 'ok' }], message: `${n} fetched`, stopped: null });
  // A clips kind whose check echoes its options and whose repair needs a camera compare.
  const clipsKind = (repair: Repair = async () => repaired(2)): InventoryKind => ({
    label: 'Clips',
    camera: true,
    run: async (ctx) => ({ ...result(1), counts: { missingSeconds: 1, camera: ctx.options?.camera ? 1 : 0 } }),
    repair: { run: repair, ready: (r) => (r.options?.camera ? null : 'compare with the camera first') },
  });
  const repairRecords = (a: AuditLog) => a.list({ actions: ['inventory-repair'] }).records;

  it('passes the camera option to the check, and keeps it in the report and the record', async () => {
    const { runner, audit } = setup({ clips: clipsKind() });
    const r = await runner.start('clips', who, { camera: true }).done;
    expect(r).toMatchObject({ op: 'check', options: { camera: true }, counts: { camera: 1 } });
    expect(records(audit)[0].cam_proxy).toMatchObject({ kind: 'clips', options: { camera: true } });
    const plain = await runner.start('clips', who).done;
    expect(plain).not.toHaveProperty('options');
    expect(plain.counts.camera).toBe(0);
  });

  it('runs a repair from a recent check report: saved apart, audited as inventory-repair', async () => {
    let seen: string | undefined;
    const { runner, audit, dir } = setup({ clips: clipsKind(async (ctx) => ((seen = ctx.source.runId), repaired(2))) });
    const check = await runner.start('clips', who, { camera: true }).done;
    const { runId, done } = await runner.repair('clips', who, check.runId);
    expect(runId).toMatch(/^clipsrepair-\d+-[0-9a-f]{6}$/);
    expect(runner.running()).toMatchObject({ runId, kind: 'clips', op: 'repair' });
    const r = await done;
    expect(seen).toBe(check.runId);
    expect(r).toMatchObject({ runId, kind: 'clips', op: 'repair', outcome: 'ok', source: check.runId, stopped: null, window: check.window, counts: { done: 2, bytes: 20 }, message: 'Clips repair: 2 fetched' });
    expect(readdirSync(join(dir, 'inventory', 'clipsrepair'))).toEqual([`${runId}.json`]);
    expect(await runner.get(runId)).toEqual(r);
    expect((await runner.list()).clips.map((x) => x.runId)).toEqual([check.runId]);
    expect((await runner.listRepairs()).clips.map((x) => x.runId)).toEqual([runId]);
    expect(records(audit)).toHaveLength(1); // the check's
    const rec = repairRecords(audit);
    expect(rec).toHaveLength(1);
    expect(rec[0]).toMatchObject({
      event: { action: 'inventory-repair', category: ['host'], type: ['change'], outcome: 'success' },
      user: { name: 'admin' }, message: 'Clips repair: 2 fetched',
      cam_proxy: { runId, kind: 'clips', source: check.runId, outcome: 'ok', stopped: null, counts: { requested: 2, done: 2 }, failures: [] },
    });
  });

  it('refuses a repair from a missing, foreign, unfinished, stale or unsuitable report', async () => {
    const { runner, advance } = setup({ clips: clipsKind(), stills: stillsKind(async () => result(1)) });
    const refused = async (id: string) => {
      try {
        await runner.repair('clips', who, id);
      } catch (e) {
        expect(e).toBeInstanceOf(RepairRefusedError);
        return (e as RepairRefusedError).code;
      }
      return 'started';
    };
    expect(await refused('clips-1-abcdef')).toBe('not_found');
    expect(await refused('../../catalog')).toBe('not_found');
    const stills = await runner.start('stills', who).done;
    expect(await refused(stills.runId)).toBe('not_found'); // another kind's report
    const local = await runner.start('clips', who).done;
    expect(await refused(local.runId)).toBe('not_repairable'); // no camera compare
    const compared = await runner.start('clips', who, { camera: true }).done;
    advance(3_600_000);
    expect(await refused(compared.runId)).toBe('report_stale');
    runner.checks.clips = { ...clipsKind(), run: async () => { throw new Error('boom'); } };
    const failed = await runner.start('clips', who, { camera: true }).done;
    expect(await refused(failed.runId)).toBe('not_repairable');
    expect(runner.running()).toBeNull();
    await expect(runner.repair('stills', who, stills.runId)).rejects.toThrow('no repair of kind stills');
  });

  it('a repair and a check share the one lock', async () => {
    let release: () => void = () => undefined;
    const { runner } = setup({ clips: clipsKind(() => new Promise((r) => (release = () => r(repaired(1))))) });
    const check = await runner.start('clips', who, { camera: true }).done;
    const rep = await runner.repair('clips', who, check.runId);
    expect(() => runner.start('clips', who)).toThrow(InventoryBusyError);
    await expect(runner.repair('clips', who, check.runId)).rejects.toBeInstanceOf(InventoryBusyError);
    release();
    expect((await rep.done).outcome).toBe('ok');
  });

  it('a cancelled repair keeps its partial counts and says who cancelled', async () => {
    const { runner, audit } = setup({ clips: clipsKind((ctx) => new Promise((r) => ctx.signal.addEventListener('abort', () => r({ ...repaired(1), stopped: 'cancelled' })))) });
    const check = await runner.start('clips', who, { camera: true }).done;
    const rep = await runner.repair('clips', who, check.runId);
    expect(runner.cancel()).toBe(rep.runId);
    const r = await rep.done;
    expect(r).toMatchObject({ outcome: 'cancelled', cancelledBy: 'request', counts: { done: 1 }, message: 'Clips repair cancelled (partial): 1 fetched' });
    expect(repairRecords(audit)[0]).toMatchObject({ event: { outcome: 'unknown' }, cam_proxy: { cancelledBy: 'request' } });
  });

  it('list() reads the saved reports once, and again after the next save', async () => {
    const { runner, dir } = setup({ stills: stillsKind(async () => result(1)) });
    const a = await runner.start('stills', who).done;
    expect((await runner.list()).stills.map((x) => x.runId)).toEqual([a.runId]);
    // A file that appears behind the runner's back is not seen until the next save.
    const other = { ...a, runId: 'stills-1-abcdef', startedAt: 1 };
    writeFileSync(join(dir, 'inventory', 'stills', 'stills-1-abcdef.json'), JSON.stringify(other));
    expect((await runner.list()).stills).toHaveLength(1);
    const b = await runner.start('stills', who).done;
    expect((await runner.list()).stills.map((x) => x.runId)).toEqual([b.runId, a.runId, 'stills-1-abcdef']);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/inventory-runner.test.ts`
Expected: FAIL (`RepairRefusedError` is not exported; `runner.repair is not a function`).

- [ ] **Step 3: Write the implementation**

Replace `src/inventory/runner.ts` with:

```ts
import { randomBytes } from 'crypto';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import type { AuditLog } from '../audit/audit-log';
import { logger } from '../log';

// The inventories (spec 2026-10-02-inventory-design): one run at a time per
// proxy, cancellable, with progress. Each finished run (also a cancelled or
// failed one) is a JSON file <dir>/<kind>/<runId>.json, the last 10 per kind,
// and one `inventory` audit record. The runner knows no kind: a kind is an
// entry in its check table (its label, its check, and optionally a repair).
// A repair shares the lock; its runs are kept apart in <dir>/<kind>repair/
// (run ids `<kind>repair-…`) and audited as `inventory-repair`.

export const KEEP_RUNS = 10;
export const MAX_TOP = 10;
export const MAX_ITEMS = 500;
export const RUN_ID = /^([a-z]{1,16})-(\d{1,15})-([0-9a-f]{6})$/;
// A repair works from a check report younger than this (spec decision 10).
export const REPAIR_MAX_AGE_MS = 3_600_000;
// The folder (and run-id prefix) of a kind's repairs.
export const repairFolder = (kind: string): string => `${kind}repair`;

export type Op = 'check' | 'repair';
export interface Progress { phase: string; done: number; total: number; note?: string }
export interface InventoryWindow { from: number | null; to: number; reason: string; [k: string]: unknown }
export interface CheckResult { window: InventoryWindow; counts: Record<string, number>; top: unknown[]; items: unknown[]; message: string }
// What a start may ask for besides the kind (PR 2: `camera`, the camera compare).
export interface StartOptions { camera?: boolean }
export interface CheckContext { signal: AbortSignal; progress: (p: Progress) => void; now: number; options?: StartOptions }
// A check returns its partial result when the signal aborts (it checks between pages).
export type Check = (ctx: CheckContext) => Promise<CheckResult>;
// A repair's result: `stopped` names why it ended before its list was done (null: it was).
export interface RepairResult { counts: Record<string, number>; top: unknown[]; items: unknown[]; message: string; stopped: string | null }
export interface RepairContext { signal: AbortSignal; progress: (p: Progress) => void; now: number; source: InventoryReport }
export type Repair = (ctx: RepairContext) => Promise<RepairResult>;
// `ready` answers why a (finished, recent) check report can't be repaired from, or null.
export interface RepairEntry { run: Repair; ready: (source: InventoryReport) => string | null }
// A kind in the check table: `label` names it in messages ("Stills inventory: …");
// `camera` says it takes the `camera` option.
export interface InventoryKind { label: string; run: Check; camera?: boolean; repair?: RepairEntry }
export type RunOutcome = 'ok' | 'cancelled' | 'failed';
export interface Requester { requestedBy: 'session' | 'token'; ip?: string; userAgent?: string }
export interface InventoryReport {
  runId: string;
  kind: string;
  op?: Op; // missing in PR 1's reports: a check
  camera: string;
  startedAt: number;
  tookMs: number;
  outcome: RunOutcome;
  error?: string;
  cancelledBy?: 'request' | 'stop';
  requestedBy: string;
  options?: StartOptions; // a check started with options
  source?: string; // a repair: the check report it worked from
  stopped?: string | null; // a repair: why it ended early
  window: InventoryWindow | null;
  counts: Record<string, number>;
  top: unknown[];
  items: unknown[];
  itemsTruncated: boolean;
  message: string;
}
export type RunSummary = Pick<InventoryReport, 'runId' | 'kind' | 'startedAt' | 'tookMs' | 'outcome' | 'counts' | 'message'>;
export interface RunningView { runId: string; kind: string; op: Op; startedAt: number; outcome: 'running'; progress: Progress }

export class InventoryBusyError extends Error {
  constructor(readonly runId: string) {
    super(`an inventory is running (${runId})`);
  }
}

export class InventoryStoppingError extends Error {
  constructor() {
    super('the proxy is stopping: no inventory is started');
  }
}

// A repair that can't start from the report it names: `not_found` (no such
// report of the kind), `report_stale` (an hour old or more), `not_repairable`.
export class RepairRefusedError extends Error {
  constructor(
    readonly code: 'not_found' | 'report_stale' | 'not_repairable',
    message: string,
  ) {
    super(message);
  }
}

interface Current { view: RunningView; ac: AbortController; cancelledBy?: 'request' | 'stop'; settled: boolean; done: Promise<InventoryReport> }
// What one run does, whichever op: its work and how its report and record look.
interface Job {
  title: string; // "Stills inventory", "Clips repair"
  work: (ctx: { signal: AbortSignal; progress: (p: Progress) => void; now: number }) => Promise<CheckResult | (RepairResult & { window: InventoryWindow | null })>;
  extra: Partial<InventoryReport>;
}

export class InventoryRunner {
  readonly checks: Partial<Record<string, InventoryKind>>;
  private cur: Current | null = null;
  private stopping = false;
  private readonly now: () => number;
  // The summaries per folder, read from disk once and again after each save (#106).
  private readonly summaries = new Map<string, RunSummary[]>();

  constructor(private readonly d: { dir: string; audit: Pick<AuditLog, 'write'>; camera: () => string; checks: Partial<Record<string, InventoryKind>>; now?: () => number; keep?: number }) {
    this.checks = { ...d.checks };
    this.now = d.now ?? Date.now;
  }

  kinds(): string[] {
    return Object.keys(this.checks).filter((k) => this.checks[k]);
  }

  // The kinds with a repair.
  repairKinds(): string[] {
    return this.kinds().filter((k) => this.checks[k]!.repair);
  }

  private entry(kind: string): InventoryKind | undefined {
    return Object.hasOwn(this.checks, kind) ? this.checks[kind] : undefined;
  }

  running(): RunningView | null {
    return this.cur ? { ...this.cur.view, progress: { ...this.cur.view.progress } } : null;
  }

  // Starts a check in the background; throws InventoryBusyError while any run
  // (check or repair) goes on, InventoryStoppingError once stop() was called.
  start(kind: string, who: Requester, options: StartOptions = {}): { runId: string; done: Promise<InventoryReport> } {
    const check = this.entry(kind);
    if (!check) throw new Error(`no inventory of kind ${kind}`);
    const opts: StartOptions = options.camera === true ? { camera: true } : {};
    return this.launch(kind, kind, 'check', who, {
      title: `${check.label} inventory`,
      work: (ctx) => check.run({ ...ctx, options: opts }),
      extra: opts.camera ? { options: opts } : {},
    });
  }

  // Starts a repair from a finished check report of the same kind, less than
  // an hour old, that the kind's `ready` accepts. Throws like start(), and
  // RepairRefusedError when the report can't be used.
  async repair(kind: string, who: Requester, sourceId: string): Promise<{ runId: string; done: Promise<InventoryReport> }> {
    this.free();
    const entry = this.entry(kind);
    if (!entry?.repair) throw new Error(`no repair of kind ${kind}`);
    const repair = entry.repair;
    const source = RUN_ID.exec(sourceId)?.[1] === kind ? await this.read(kind, sourceId) : undefined;
    if (!source) throw new RepairRefusedError('not_found', `no ${kind} inventory ${sourceId}`);
    if (source.outcome !== 'ok') throw new RepairRefusedError('not_repairable', 'that inventory did not finish');
    if (this.now() - source.startedAt >= REPAIR_MAX_AGE_MS) throw new RepairRefusedError('report_stale', 'that inventory is an hour old or more: run it again');
    const why = repair.ready(source);
    if (why) throw new RepairRefusedError('not_repairable', why);
    return this.launch(kind, repairFolder(kind), 'repair', who, {
      title: `${entry.label} repair`,
      work: async (ctx) => ({ ...(await repair.run({ ...ctx, source })), window: source.window }),
      extra: { source: source.runId },
    });
  }

  private free(): void {
    if (this.stopping) throw new InventoryStoppingError();
    if (this.cur) throw new InventoryBusyError(this.cur.view.runId);
  }

  // `folder` is the kind for a check, `<kind>repair` for a repair: the run id's prefix.
  private launch(kind: string, folder: string, op: Op, who: Requester, job: Job): { runId: string; done: Promise<InventoryReport> } {
    this.free();
    const startedAt = this.now();
    const runId = `${folder}-${startedAt}-${randomBytes(3).toString('hex')}`;
    const cur: Current = {
      view: { runId, kind, op, startedAt, outcome: 'running', progress: { phase: 'starting', done: 0, total: 0 } },
      ac: new AbortController(),
      settled: false,
      done: Promise.resolve(undefined as never),
    };
    this.cur = cur;
    cur.done = this.run(cur, folder, job, who);
    return { runId, done: cur.done };
  }

  // The running run's id, or null. The run ends soon after, with its partial counts.
  cancel(by: 'request' | 'stop' = 'request'): string | null {
    if (!this.cur) return null;
    // A check that already finished stays ok: the run is only being saved.
    if (!this.cur.settled) {
      this.cur.cancelledBy ??= by;
      this.cur.ac.abort();
    }
    return this.cur.view.runId;
  }

  // The proxy stops: cancel, and wait until the run is saved and audited.
  async stop(): Promise<void> {
    this.stopping = true;
    const c = this.cur;
    if (!c) return;
    this.cancel('stop');
    await c.done;
  }

  // The check runs per kind, newest first.
  async list(): Promise<Record<string, RunSummary[]>> {
    const out: Record<string, RunSummary[]> = {};
    for (const kind of this.kinds()) out[kind] = await this.summariesOf(kind);
    return out;
  }

  // The repair runs per kind (only kinds with a repair), newest first.
  async listRepairs(): Promise<Record<string, RunSummary[]>> {
    const out: Record<string, RunSummary[]> = {};
    for (const kind of this.repairKinds()) out[kind] = await this.summariesOf(repairFolder(kind));
    return out;
  }

  private async summariesOf(folder: string): Promise<RunSummary[]> {
    const hit = this.summaries.get(folder);
    if (hit) return hit;
    const out: RunSummary[] = [];
    for (const id of await this.ids(folder)) {
      const r = await this.read(folder, id);
      if (r) out.push({ runId: r.runId, kind: r.kind, startedAt: r.startedAt, tookMs: r.tookMs, outcome: r.outcome, counts: r.counts, message: r.message });
    }
    this.summaries.set(folder, out);
    return out;
  }

  // A report, the running view, or undefined (also for anything that isn't a run id).
  async get(runId: string): Promise<InventoryReport | RunningView | undefined> {
    const m = RUN_ID.exec(runId);
    if (!m) return undefined;
    if (this.cur?.view.runId === runId) return this.running()!;
    return this.read(m[1], runId);
  }

  private async run(cur: Current, folder: string, job: Job, who: Requester): Promise<InventoryReport> {
    const { runId, kind, op, startedAt } = cur.view;
    try {
      let res: Awaited<ReturnType<Job['work']>> | null = null;
      let error: string | undefined;
      let failed = false;
      try {
        res = await job.work({ signal: cur.ac.signal, now: startedAt, progress: (p) => void (cur.view.progress = p) });
      } catch (err) {
        failed = true;
        error = err instanceof Error ? err.message : String(err);
      }
      cur.settled = true;
      const outcome: RunOutcome = cur.ac.signal.aborted ? 'cancelled' : failed ? 'failed' : 'ok';
      const items = res?.items ?? [];
      const stopped = res && 'stopped' in res ? res.stopped : undefined;
      const report: InventoryReport = {
        runId, kind, op, camera: this.d.camera(), startedAt, tookMs: this.now() - startedAt, outcome,
        ...(outcome === 'failed' ? { error } : {}),
        ...(outcome === 'cancelled' ? { cancelledBy: cur.cancelledBy ?? 'request' } : {}),
        requestedBy: who.requestedBy,
        ...job.extra,
        ...(op === 'repair' ? { stopped: stopped ?? null } : {}),
        window: res?.window ?? null,
        counts: res?.counts ?? {},
        top: (res?.top ?? []).slice(0, MAX_TOP),
        items: items.slice(0, MAX_ITEMS),
        itemsTruncated: items.length > MAX_ITEMS,
        message: message(job.title, outcome, res, error),
      };
      try {
        await this.save(folder, report);
      } catch (err) {
        logger.error({ err: (err as Error).message, runId }, 'inventory_save_failed');
      }
      const common = { runId, kind, outcome, requestedBy: who.requestedBy, ...(report.cancelledBy ? { cancelledBy: report.cancelledBy } : {}) };
      this.d.audit.write({
        action: op === 'repair' ? 'inventory-repair' : 'inventory', category: ['host'], type: [op === 'repair' ? 'change' : 'info'],
        outcome: outcome === 'ok' ? 'success' : outcome === 'failed' ? 'failure' : 'unknown',
        user: 'admin', ip: who.ip, userAgent: who.userAgent, message: report.message,
        ...(report.error !== undefined ? { error: report.error } : {}),
        details: op === 'repair'
          ? { ...common, source: report.source, stopped: report.stopped, counts: report.counts, failures: report.top, tookMs: report.tookMs }
          : { ...common, ...(report.options ? { options: report.options } : {}), window: report.window, counts: report.counts, top: report.top, tookMs: report.tookMs },
      });
      logger.info({ runId, kind, op, outcome, tookMs: report.tookMs }, 'inventory_done');
      return report;
    } finally {
      this.cur = null;
    }
  }

  private async save(folder: string, r: InventoryReport): Promise<void> {
    try {
      const dir = join(this.d.dir, folder);
      await mkdir(dir, { recursive: true });
      const file = join(dir, `${r.runId}.json`);
      await writeFile(`${file}.tmp`, JSON.stringify(r));
      await rename(`${file}.tmp`, file);
      for (const id of (await this.ids(folder)).slice(this.d.keep ?? KEEP_RUNS)) await rm(join(dir, `${id}.json`), { force: true });
    } finally {
      this.summaries.delete(folder); // read again on the next list()
    }
  }

  // The run ids in a folder on disk, newest first.
  private async ids(folder: string): Promise<string[]> {
    let names: string[];
    try {
      names = await readdir(join(this.d.dir, folder));
    } catch {
      return [];
    }
    const started = (id: string) => Number(RUN_ID.exec(id)![2]);
    return names
      .filter((n) => n.endsWith('.json'))
      .map((n) => n.slice(0, -5))
      .filter((id) => RUN_ID.exec(id)?.[1] === folder)
      .sort((a, b) => started(b) - started(a) || b.localeCompare(a));
  }

  private async read(folder: string, id: string): Promise<InventoryReport | undefined> {
    try {
      return JSON.parse(await readFile(join(this.d.dir, folder, `${id}.json`), 'utf8')) as InventoryReport;
    } catch {
      return undefined;
    }
  }
}

function message(title: string, outcome: RunOutcome, res: { message: string } | null, error: string | undefined): string {
  if (outcome === 'failed') return `${title} failed: ${error}`;
  if (outcome === 'cancelled') return `${title} cancelled${res ? ` (partial): ${res.message}` : ''}`;
  return `${title}: ${res!.message}`;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/inventory-runner.test.ts test/inventory-stills.test.ts test/inventory-api.test.ts && npx tsc --noEmit -p tsconfig.check.json`
Expected: PASS (PR 1's tests unchanged and green; 22 runner tests).

- [ ] **Step 5: Commit**

```bash
git add src/inventory/runner.ts test/inventory-runner.test.ts
git commit -m "feat(inventory): start options, repairs apart from checks, cached summaries (#106)"
```

---

### Task 2: Catalog migration 6: where a clip came from

**Files:**
- Modify: `src/catalog/migrations.ts` (append migration 6), `src/catalog/clips.ts` (`ClipRow`, `insertClip`, `countClips`), `src/api/client-api.ts` (`clipJson`), `openapi.yaml` (the clip list), `web/src/pages/Clips.svelte` (the chip)
- Test: `test/catalog.test.ts`, `test/catalog-analyses.test.ts`, `test/catalog-counts.test.ts`, `test/clips-api.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `export type ClipOrigin = 'ftp' | 'camera'` and `ClipRow.origin: ClipOrigin` in `src/catalog/clips.ts`; `insertClip(c, r: Omit<ClipRow, 'id' | 'origin'> & { origin?: ClipOrigin }): ClipRow` (default `'ftp'`); `countClips()` counts FTP clips only; the client clip JSON has `origin`.

- [ ] **Step 1: Write the failing tests**

In `test/catalog.test.ts`, the schema is now version 6. Replace the first test's two `expect(c.schemaVersion()).toBe(5);` lines with `expect(c.schemaVersion()).toBe(6);`, and replace the version-5 migration test with these two tests:

```ts
  // #93 review: the last clip received survives retention; version 5 fills it from the clips kept.
  it('migrates to version 5 with the last clip received per camera, from the clips kept', () => {
    insertClip(c, { cam: 'cam1', start_ts: 1, end_ts: 2, path: 'a.mp4', stream: 'main', size: 1, received_at: 5000, snapshot: null });
    insertClip(c, { cam: 'cam1', start_ts: 1, end_ts: 2, path: 'b.mp4', stream: 'main', size: 1, received_at: 7000, snapshot: null });
    // As a version 4 catalog with these clips.
    c.db.exec('DROP TRIGGER clips_last_received; ALTER TABLE clips DROP COLUMN origin; DROP TABLE clip_arrivals; DELETE FROM schema_version WHERE version >= 5');
    c.close();
    c = openCatalog(join(dir, 'catalog.sqlite'));
    expect(c.schemaVersion()).toBe(6);
    expect(lastClipReceived(c, 'cam1')).toBe(7000);
  });

  // #74: version 6 marks where a clip came from; old rows are FTP uploads.
  it('migrates to version 6: old clips are ftp, and a clip from the camera is no arrival', () => {
    insertClip(c, { cam: 'cam1', start_ts: 1, end_ts: 2, path: 'a.mp4', stream: 'main', size: 1, received_at: 5000, snapshot: null });
    c.db.exec("DROP TRIGGER clips_last_received; ALTER TABLE clips DROP COLUMN origin; DELETE FROM schema_version WHERE version = 6; CREATE TRIGGER clips_last_received AFTER INSERT ON clips BEGIN INSERT INTO clip_arrivals (cam, last_received) VALUES (NEW.cam, NEW.received_at) ON CONFLICT (cam) DO UPDATE SET last_received = MAX(last_received, excluded.last_received); END;");
    c.close();
    c = openCatalog(join(dir, 'catalog.sqlite'));
    expect(c.schemaVersion()).toBe(6);
    expect(c.db.prepare('SELECT origin FROM clips').all()).toEqual([{ origin: 'ftp' }]);
    const repaired = insertClip(c, { cam: 'cam1', start_ts: 3, end_ts: 4, path: 'b.mp4', stream: 'sub', size: 1, received_at: 9000, snapshot: null, origin: 'camera' });
    expect(repaired.origin).toBe('camera');
    expect(lastClipReceived(c, 'cam1')).toBe(5000);
    expect(insertClip(c, { cam: 'cam1', start_ts: 5, end_ts: 6, path: 'c.mp4', stream: 'sub', size: 1, received_at: 9500, snapshot: null }).origin).toBe('ftp');
    expect(lastClipReceived(c, 'cam1')).toBe(9500);
  });
```

In `test/catalog-analyses.test.ts`, replace both `schemaVersion()).toBe(5)` with `schemaVersion()).toBe(6)`.

In `test/catalog-counts.test.ts`, after `expect(countClips(c, 'cam1', 0, 5000)).toBe(1);` add:

```ts
    // A clip fetched from the SD card by a repair is not one received (#74).
    insertClip(c, { cam: 'cam1', start_ts: 1900, end_ts: 2000, path: 'cam1/r.mp4', stream: 'sub', size: 1, received_at: 2000, snapshot: null, origin: 'camera' });
    expect(countClips(c, 'cam1', 0, 5000)).toBe(1);
```

In `test/clips-api.test.ts`, the listed clip gains `origin: 'ftp'` (after `size: body.length,`):

```ts
      { id: withSnap.id, start: T, end: T + 30_000, stream: 'main', size: body.length, origin: 'ftp', events: [eventId], url: `/api/cameras/cam1/clips/${withSnap.id}.mp4`, snapshotUrl: `/api/cameras/cam1/clips/${withSnap.id}.jpg` },
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/catalog.test.ts test/catalog-analyses.test.ts test/catalog-counts.test.ts test/clips-api.test.ts`
Expected: FAIL (schema version 5, no `origin` column).

- [ ] **Step 3: Write the implementation**

`src/catalog/migrations.ts`: append after migration 5 (inside the array):

```ts
  // 6: where a clip came from (spec 2026-10-02-inventory-design §4, #74):
  // 'ftp' (the camera's upload) or 'camera' (fetched from the SD card by an
  // inventory repair). Only FTP clips count as arrivals: a repaired clip must
  // not hide an FTP stall (#93).
  `
  ALTER TABLE clips ADD COLUMN origin TEXT NOT NULL DEFAULT 'ftp';
  DROP TRIGGER clips_last_received;
  CREATE TRIGGER clips_last_received AFTER INSERT ON clips WHEN NEW.origin = 'ftp' BEGIN
    INSERT INTO clip_arrivals (cam, last_received) VALUES (NEW.cam, NEW.received_at)
      ON CONFLICT (cam) DO UPDATE SET last_received = MAX(last_received, excluded.last_received);
  END;
  `,
```

`src/catalog/clips.ts`: replace the end of `ClipRow`, `MAX_LIST` and `insertClip` with:

```ts
  snapshot: string | null;
  origin: ClipOrigin;
}

// 'ftp': uploaded by the camera; 'camera': fetched from its SD card by an inventory repair (#74).
export type ClipOrigin = 'ftp' | 'camera';

const MAX_LIST = 2000;

export function insertClip(c: Catalog, r: Omit<ClipRow, 'id' | 'origin'> & { origin?: ClipOrigin }): ClipRow {
  return c.db
    .prepare('INSERT INTO clips (cam, start_ts, end_ts, path, stream, size, received_at, snapshot, origin) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *')
    .get(r.cam, r.start_ts, r.end_ts, r.path, r.stream, r.size, r.received_at, r.snapshot, r.origin ?? 'ftp') as unknown as ClipRow;
}
```

and `countClips` with:

```ts
// Clips received by FTP in [from, to) (the daily audit record); repaired ones are not received.
export function countClips(c: Catalog, cam: string, from: number, to: number): number {
  return Number((c.db.prepare("SELECT COUNT(*) AS n FROM clips WHERE cam = ? AND origin = 'ftp' AND received_at >= ? AND received_at < ?").get(cam, from, to) as { n: number }).n);
}
```

`src/api/client-api.ts`, in `clipJson`, after `size: c.size,` add `origin: c.origin,`.

`openapi.yaml`, `GET /api/cameras/{cam}/clips` 200 description becomes:

```yaml
        '200': { description: '[{id, start, end, stream, size, origin (ftp: uploaded by the camera; camera: fetched from its SD card by an inventory repair), events: [event ids], url, snapshotUrl (null without a snapshot)}]' }
```

`web/src/pages/Clips.svelte`: the `Clip` interface gets `origin?: string;` after `size: number;`; the hint and the chips line become:

```svelte
      <span class="muted small">Recordings the camera uploads by FTP (and lost ones an inventory repair fetched from its SD card: "from camera"), with the events they cover.</span>
```

```svelte
          <span class="chips">{#if c.origin === 'camera'}<span class="chip origin" data-testid="clip-origin">from camera</span>{/if}{#each clipChips(c.events, kinds) as chip (chip)}<span class="chip">{chip}</span>{/each}</span>
```

and after the `.chip { … }` style rule add:

```css
  .chip.origin { background: var(--surface-2); color: var(--text); border: 1px solid var(--border); }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/catalog.test.ts test/catalog-analyses.test.ts test/catalog-counts.test.ts test/clips-api.test.ts test/ftp-health.test.ts test/clips-indexer.test.ts && npx tsc --noEmit -p tsconfig.check.json && npm run check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/catalog/migrations.ts src/catalog/clips.ts src/api/client-api.ts openapi.yaml web/src/pages/Clips.svelte test/catalog.test.ts test/catalog-analyses.test.ts test/catalog-counts.test.ts test/clips-api.test.ts
git commit -m "feat(catalog): migration 6, clips.origin (ftp or camera); camera clips are no arrivals"
```

---

### Task 3: The pairing rule and the camera list

**Files:**
- Create: `src/inventory/match.ts`, `src/inventory/camera-list.ts`
- Test: `test/inventory-match.test.ts`, `test/inventory-camera-list.test.ts`

**Interfaces:**
- Consumes: `RecordingList.monthDays(month, signal?)`, `RecordingList.day(date, stream, fresh?, signal?)`, `SearchError` (`code`: `camera_offline` | `search_failed` | `busy`), `RecordingEntry` from `src/recordings/list.ts`; `localDays()` and `Stream` from `src/recordings/names.ts`; `TimeInfo` from `src/camera/time.ts`.
- Produces:
  - `match.ts`: `export const START_SLACK_MS = 5_000;` `export function pairByStart<R extends {start: number; stream: string}, L extends {start: number; stream: string; id: number}>(recs: R[], clips: L[], slackMs?: number): { pairs: { rec: R; clip: L }[]; recsAlone: R[]; clipsAlone: L[] }` (`recsAlone` by start, `clipsAlone` by start).
  - `camera-list.ts`: `export interface CameraDay { date: string; state: 'listed' | 'unknown'; recordings: RecordingEntry[]; error?: string }`, `export interface CameraListing { days: CameraDay[]; oldestSdDay: string | null; time: TimeInfo }`, `export interface CameraListDeps { list: Pick<RecordingList, 'monthDays' | 'day'>; timeInfo: () => Promise<TimeInfo>; sleep?: (ms: number) => Promise<void> }`, `export const BUSY_TRIES = 3;`, `export async function listCamera(d: CameraListDeps, o: { from: number; to: number; stream: Stream; signal: AbortSignal; progress?: (done: number, total: number, date: string) => void }): Promise<CameraListing>` (throws `SearchError` `camera_offline`).

- [ ] **Step 1: Write the failing tests**

`test/inventory-match.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { pairByStart, START_SLACK_MS } from '../src/inventory/match';

const rec = (id: string, start: number, stream = 'sub') => ({ id, start, stream });
const clip = (id: number, start: number, stream = 'sub') => ({ id, start, stream });

describe('pairByStart', () => {
  it('pairs a recording with the clip of the same stream starting within 5 s', () => {
    const p = pairByStart([rec('a', 10_000), rec('b', 60_000)], [clip(1, 14_000), clip(2, 66_000)]);
    expect(START_SLACK_MS).toBe(5000);
    expect(p.pairs.map((x) => [x.rec.id, x.clip.id])).toEqual([['a', 1]]);
    expect(p.recsAlone.map((x) => x.id)).toEqual(['b']); // 6 s apart: not the same
    expect(p.clipsAlone.map((x) => x.id)).toEqual([2]);
  });

  it('takes the boundary: exactly 5 s pairs, before and after', () => {
    const p = pairByStart([rec('a', 10_000), rec('b', 50_000)], [clip(1, 5_000), clip(2, 55_000)]);
    expect(p.pairs.map((x) => [x.rec.id, x.clip.id])).toEqual([['a', 1], ['b', 2]]);
  });

  it('never pairs across streams', () => {
    const p = pairByStart([rec('a', 10_000, 'sub')], [clip(1, 10_000, 'main')]);
    expect(p.pairs).toEqual([]);
    expect(p.recsAlone).toHaveLength(1);
    expect(p.clipsAlone).toHaveLength(1);
  });

  it('pairs one to one, closest first: two recordings near one clip leave one alone', () => {
    const p = pairByStart([rec('a', 10_000), rec('b', 13_000)], [clip(1, 12_500)]);
    expect(p.pairs.map((x) => [x.rec.id, x.clip.id])).toEqual([['b', 1]]);
    expect(p.recsAlone.map((x) => x.id)).toEqual(['a']);
    // A tie goes to the earlier recording.
    const tie = pairByStart([rec('b', 14_000), rec('a', 10_000)], [clip(7, 12_000)]);
    expect(tie.pairs.map((x) => x.rec.id)).toEqual(['a']);
  });

  it('a clip claimed by a closer recording leaves the next best to the other', () => {
    const p = pairByStart([rec('a', 10_000), rec('b', 12_000)], [clip(1, 11_900), clip(2, 8_000)]);
    expect(p.pairs.map((x) => [x.rec.id, x.clip.id])).toEqual([['a', 2], ['b', 1]]);
  });
});
```

`test/inventory-camera-list.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { BUSY_TRIES, listCamera, type CameraListDeps } from '../src/inventory/camera-list';
import { SearchError, type RecordingEntry } from '../src/recordings/list';
import type { TimeInfo } from '../src/camera/time';

// UTC-6 without DST: camera-local days start at 06:00 UTC.
const TIME: TimeInfo = { stdOffsetMinutes: -360, dstOffsetMinutes: 0 };
const at = (date: string, hhmm = '1200') => Date.parse(`${date}T${hhmm.slice(0, 2)}:${hhmm.slice(2)}:00Z`) + 6 * 3_600_000;
const entry = (date: string, hhmm: string): RecordingEntry => ({ id: `RecS0A_${date.replaceAll('-', '')}_${hhmm}00_${hhmm}30_0_55148000000000_100000.mp4`, path: `/mnt/sda/${date}/x.mp4`, start: at(date, hhmm), end: at(date, hhmm) + 30_000, stream: 'sub', size: 0x100000, kinds: ['motion'] });

// A fake RecordingList: `days` per month, recordings per date, and failures per date.
function fake(o: { months?: Record<string, number[] | Error>; recs?: Record<string, RecordingEntry[]>; fail?: Record<string, Error[]> } = {}) {
  const searched: string[] = [];
  const deps: CameraListDeps = {
    timeInfo: async () => TIME,
    sleep: async () => undefined,
    list: {
      monthDays: async (month) => {
        const m = o.months?.[month];
        if (m instanceof Error) throw m;
        return m ?? [];
      },
      day: async (date) => {
        searched.push(date);
        const f = o.fail?.[date]?.shift();
        if (f) throw f;
        return o.recs?.[date] ?? [];
      },
    },
  };
  return { deps, searched };
}
const signal = () => new AbortController().signal;

describe('listCamera', () => {
  it('searches only the days the month overview has, oldest first, and names the SD card\'s oldest day', async () => {
    const f = fake({ months: { '2026-09': [20, 29, 30], '2026-10': [1] }, recs: { '2026-09-29': [entry('2026-09-29', '0815')], '2026-10-01': [entry('2026-10-01', '0930')] } });
    const progress: string[] = [];
    const l = await listCamera(f.deps, { from: at('2026-09-28', '0000'), to: at('2026-10-01', '2300'), stream: 'sub', signal: signal(), progress: (d, t, date) => progress.push(`${d}/${t} ${date}`) });
    expect(l.days.map((x) => [x.date, x.state, x.recordings.length])).toEqual([['2026-09-28', 'listed', 0], ['2026-09-29', 'listed', 1], ['2026-09-30', 'listed', 0], ['2026-10-01', 'listed', 1]]);
    expect(f.searched).toEqual(['2026-09-29', '2026-09-30', '2026-10-01']);
    expect(l.oldestSdDay).toBe('2026-09-20');
    expect(progress).toEqual(['1/4 2026-09-28', '2/4 2026-09-29', '3/4 2026-09-30', '4/4 2026-10-01']);
  });

  it('marks a day whose Search fails unknown, and goes on', async () => {
    const f = fake({ months: { '2026-09': [29, 30] }, fail: { '2026-09-29': [new SearchError('search_failed', 'rspCode -17')] } });
    const l = await listCamera(f.deps, { from: at('2026-09-29', '0000'), to: at('2026-09-30', '2300'), stream: 'sub', signal: signal() });
    expect(l.days).toEqual([{ date: '2026-09-29', state: 'unknown', recordings: [], error: 'rspCode -17' }, { date: '2026-09-30', state: 'listed', recordings: [] }]);
  });

  it('searches every day of a month whose overview failed', async () => {
    const f = fake({ months: { '2026-09': new SearchError('search_failed', 'x') } });
    const l = await listCamera(f.deps, { from: at('2026-09-29', '0000'), to: at('2026-09-30', '2300'), stream: 'sub', signal: signal() });
    expect(f.searched).toEqual(['2026-09-29', '2026-09-30']);
    expect(l.oldestSdDay).toBeNull();
  });

  it('tries a busy Search again, and gives up after BUSY_TRIES as unknown', async () => {
    const busy = () => new SearchError('busy', 'too many recording Searches waiting');
    const f = fake({ months: { '2026-09': [29, 30] }, fail: { '2026-09-29': [busy()], '2026-09-30': Array.from({ length: BUSY_TRIES }, busy) } });
    const l = await listCamera(f.deps, { from: at('2026-09-29', '0000'), to: at('2026-09-30', '2300'), stream: 'sub', signal: signal() });
    expect(l.days.map((x) => x.state)).toEqual(['listed', 'unknown']);
    expect(f.searched).toEqual(['2026-09-29', '2026-09-29', ...Array.from({ length: BUSY_TRIES }, () => '2026-09-30')]);
  });

  it('an offline camera ends the listing', async () => {
    const f = fake({ months: { '2026-09': [29, 30] }, fail: { '2026-09-30': [new SearchError('camera_offline', 'the camera does not answer')] } });
    await expect(listCamera(f.deps, { from: at('2026-09-29', '0000'), to: at('2026-09-30', '2300'), stream: 'sub', signal: signal() })).rejects.toMatchObject({ code: 'camera_offline' });
    const noTime = fake();
    noTime.deps.timeInfo = async () => { throw new Error('ECONNREFUSED'); };
    await expect(listCamera(noTime.deps, { from: at('2026-09-29'), to: at('2026-09-30'), stream: 'sub', signal: signal() })).rejects.toMatchObject({ code: 'camera_offline' });
  });

  it('stops between days when cancelled, with the days listed so far', async () => {
    const ac = new AbortController();
    const f = fake({ months: { '2026-09': [28, 29, 30] } });
    const day = f.deps.list.day;
    f.deps.list.day = async (date, stream, fresh, sig) => {
      const r = await day(date, stream, fresh, sig);
      if (date === '2026-09-29') ac.abort();
      return r;
    };
    const l = await listCamera(f.deps, { from: at('2026-09-28', '0000'), to: at('2026-09-30', '2300'), stream: 'sub', signal: ac.signal });
    expect(l.days.map((x) => x.date)).toEqual(['2026-09-28', '2026-09-29']);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/inventory-match.test.ts test/inventory-camera-list.test.ts`
Expected: FAIL (`Cannot find module '../src/inventory/match'`).

- [ ] **Step 3: Write the implementation**

`src/inventory/match.ts`:

```ts
// The pairing rules (spec 2026-10-02-inventory-design §4, decision 7): an SD
// recording and a local clip are the same recording when they have the same
// stream and their starts are at most 5 s apart (cams' rule, and clipNear's).
// Each clip pairs with one recording at most and the reverse: the closest
// starts pair first; on a tie the earlier recording, then the lower clip id.

export const START_SLACK_MS = 5_000;

export interface Pairable { start: number; stream: string }
export interface Pairing<R, L> { pairs: { rec: R; clip: L }[]; recsAlone: R[]; clipsAlone: L[] }

export function pairByStart<R extends Pairable, L extends Pairable & { id: number }>(recs: R[], clips: L[], slackMs = START_SLACK_MS): Pairing<R, L> {
  const sortedClips = [...clips].sort((a, b) => a.start - b.start || a.id - b.id);
  const cand: { r: number; c: number; d: number }[] = [];
  let lo = 0;
  const order = recs.map((_, i) => i).sort((a, b) => recs[a].start - recs[b].start || a - b);
  for (const r of order) {
    const rec = recs[r];
    while (lo < sortedClips.length && sortedClips[lo].start < rec.start - slackMs) lo++;
    for (let c = lo; c < sortedClips.length && sortedClips[c].start <= rec.start + slackMs; c++) {
      if (sortedClips[c].stream === rec.stream) cand.push({ r, c, d: Math.abs(sortedClips[c].start - rec.start) });
    }
  }
  cand.sort((a, b) => a.d - b.d || recs[a.r].start - recs[b.r].start || a.r - b.r || sortedClips[a.c].id - sortedClips[b.c].id);
  const recUsed = new Set<number>();
  const clipUsed = new Set<number>();
  const pairs: { rec: R; clip: L }[] = [];
  for (const x of cand) {
    if (recUsed.has(x.r) || clipUsed.has(x.c)) continue;
    recUsed.add(x.r);
    clipUsed.add(x.c);
    pairs.push({ rec: recs[x.r], clip: sortedClips[x.c] });
  }
  pairs.sort((a, b) => a.rec.start - b.rec.start);
  return {
    pairs,
    recsAlone: order.filter((r) => !recUsed.has(r)).map((r) => recs[r]),
    clipsAlone: sortedClips.filter((_, c) => !clipUsed.has(c)),
  };
}
```

`src/inventory/camera-list.ts`:

```ts
// The SD recordings of an inventory window (spec 2026-10-02-inventory-design
// §4, shared by the clips compare and, in PR 3, the events check): the month
// overview first (which days have recordings), then one Search per day with
// recordings, oldest first, through RecordingList (its one-at-a-time gate and
// its 30 s day cache). A day whose Search fails is `unknown`: its recordings
// are never counted as missing. An offline camera ends the listing
// (SearchError camera_offline); a full Search queue (busy) is tried again.
import { SearchError, type RecordingEntry, type RecordingList } from '../recordings/list';
import { localDays, type Stream } from '../recordings/names';
import type { TimeInfo } from '../camera/time';

export interface CameraDay { date: string; state: 'listed' | 'unknown'; recordings: RecordingEntry[]; error?: string }
export interface CameraListing {
  days: CameraDay[]; // camera-local dates of the window, oldest first (fewer when cancelled)
  oldestSdDay: string | null; // the oldest day with recordings in the window's months
  time: TimeInfo;
}
export interface CameraListDeps {
  list: Pick<RecordingList, 'monthDays' | 'day'>;
  timeInfo: () => Promise<TimeInfo>;
  sleep?: (ms: number) => Promise<void>;
}

// A Search refused because the queue is full is tried this often in all, 1 s apart.
export const BUSY_TRIES = 3;

const isAbort = (e: unknown) => e instanceof Error && e.name === 'AbortError';
const offline = (e: unknown) => e instanceof SearchError && e.code === 'camera_offline';
const pad = (n: number) => String(n).padStart(2, '0');

export async function listCamera(
  d: CameraListDeps,
  o: { from: number; to: number; stream: Stream; signal: AbortSignal; progress?: (done: number, total: number, date: string) => void },
): Promise<CameraListing> {
  let time: TimeInfo;
  try {
    time = await d.timeInfo();
  } catch (err) {
    throw err instanceof SearchError ? err : new SearchError('camera_offline', 'the camera time is unknown');
  }
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const dates = localDays(o.from, o.to, time);
  // The month overview: null when its Search failed (then every day is searched).
  const months = new Map<string, Set<number> | null>();
  for (const month of new Set(dates.map((x) => x.slice(0, 7)))) {
    if (o.signal.aborted) break;
    try {
      months.set(month, new Set(await d.list.monthDays(month, o.signal)));
    } catch (err) {
      if (offline(err)) throw err;
      months.set(month, null);
    }
  }
  let oldestSdDay: string | null = null;
  for (const month of [...months.keys()].sort()) {
    const set = months.get(month);
    if (!set?.size) continue;
    oldestSdDay = `${month}-${pad(Math.min(...set))}`;
    break;
  }
  const days: CameraDay[] = [];
  for (const [i, date] of dates.entries()) {
    if (o.signal.aborted) break;
    const set = months.get(date.slice(0, 7));
    if (set && !set.has(Number(date.slice(8, 10)))) {
      days.push({ date, state: 'listed', recordings: [] }); // no recordings that day: no Search
    } else {
      const day = await searchDay(d, date, o.stream, o.signal, sleep);
      if (!day) break; // cancelled
      days.push(day);
    }
    o.progress?.(i + 1, dates.length, date);
  }
  return { days, oldestSdDay, time };
}

async function searchDay(d: CameraListDeps, date: string, stream: Stream, signal: AbortSignal, sleep: (ms: number) => Promise<void>): Promise<CameraDay | null> {
  for (let attempt = 1; ; attempt++) {
    try {
      return { date, state: 'listed', recordings: await d.list.day(date, stream, false, signal) };
    } catch (err) {
      if (isAbort(err) || signal.aborted) return null;
      if (offline(err)) throw err;
      if (err instanceof SearchError && err.code === 'busy' && attempt < BUSY_TRIES) {
        await sleep(1000);
        continue;
      }
      return { date, state: 'unknown', recordings: [], error: err instanceof Error ? err.message : String(err) };
    }
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/inventory-match.test.ts test/inventory-camera-list.test.ts && npx tsc --noEmit -p tsconfig.check.json`
Expected: PASS (5 + 6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/inventory/match.ts src/inventory/camera-list.ts test/inventory-match.test.ts test/inventory-camera-list.test.ts
git commit -m "feat(inventory): pairing by start and the camera's recordings of a window (#74)"
```

---

### Task 4: The clips check (local and against the camera)

**Files:**
- Create: `src/inventory/clips.ts`
- Test: `test/inventory-clips.test.ts`

**Interfaces:**
- Consumes: Task 1 `Check`, `CheckResult`, `CheckContext.options`, `MAX_ITEMS`, `MAX_TOP`; Task 2 `insertClip` with `origin` (tests) and the `origin` column; Task 3 `listCamera`, `CameraListDeps`, `pairByStart`; `localDate`, `Kind`, `Stream` from `src/recordings/names.ts`.
- Produces (`src/inventory/clips.ts`):
  - `export const SETTLE_MS = 5 * 60_000;` `export const RECORDING_KINDS = ['motion', 'person', 'vehicle', 'pet'] as const;` `export const mb = (bytes: number) => string` (`"2.0 MB"`, MiB, one decimal)
  - `export interface ClipsSettings { cam: string; clipsDays: number; stream: Stream; ftpEnabled: boolean }`
  - `export interface ClipsInventoryDeps { dataDir: string; catalog: Catalog; settings: () => ClipsSettings; camera: CameraListDeps }`
  - `export type ClipItem` = `{type: 'missing-locally'; id; start; end; size; stream; kinds}` | `{type: 'gone-from-camera'; clipId; start}` | `{type: 'row-without-file'; clipId; start; file}` | `{type: 'file-without-row'; file}` | `{type: 'event-without-clip'; eventId; kind; start}` | `{type: 'clip-without-event'; clipId; start}` (`file` relative to the data folder)
  - `export interface CameraDayRow { date: string; state: 'listed' | 'unknown'; recordings: number; missingLocally: number; goneFromCamera: number }`
  - `export function clipsCheck(d: ClipsInventoryDeps): Check` — counts (always) `clipsDays, clips, fromCamera, rowsWithoutFile, filesWithoutRow, events, eventsWithoutClip, clipsWithoutEvent`; with `camera: true` also `cameraDays, unknownDays, recordings, timerOnly, paired, missingLocally, missingLocallyBytes, goneFromCamera, olderThanSd, otherStream`; `window = {from, to, reason: 'retention', notes, camera?: {stream, to, oldestSdDay, unknownDays}}`; items: `missing-locally` (oldest first, ruling (a)) first, then `gone-from-camera`, then the local findings; `top`: `CameraDayRow`s with problems, most missing first.

- [ ] **Step 1: Write the failing tests**

`test/inventory-clips.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { openCatalog, type Catalog } from '../src/catalog/db';
import { insertClip, type ClipOrigin } from '../src/catalog/clips';
import { closeEvent, insertEvent } from '../src/catalog/events';
import { clipsCheck, SETTLE_MS, type ClipsInventoryDeps, type ClipsSettings } from '../src/inventory/clips';
import type { CameraListDeps } from '../src/inventory/camera-list';
import { SearchError, type RecordingEntry } from '../src/recordings/list';
import type { Kind } from '../src/recordings/names';
import type { CheckContext } from '../src/inventory/runner';

// Camera time is UTC here (offset 0): camera-local dates are UTC dates.
const NOW = Date.UTC(2026, 9, 2, 12, 0);
const T = (iso: string) => Date.parse(`${iso}Z`);
let dir: string;
let catalog: Catalog;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'camproxy-invclips-'));
  catalog = openCatalog(join(dir, 'catalog.sqlite'));
});
afterEach(() => {
  catalog.close();
  rmSync(dir, { recursive: true, force: true });
});

const pad = (n: number) => String(n).padStart(2, '0');
// The indexer's own layout: clips/<cam>/YYYY/MM/DD/HHMM-<start>.mp4 (UTC).
const clipPath = (start: number, ext = 'mp4') => {
  const d = new Date(start);
  return join(dir, 'clips', 'cam1', String(d.getUTCFullYear()), pad(d.getUTCMonth() + 1), pad(d.getUTCDate()), `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}-${start}.${ext}`);
};
const touch = (file: string) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, 'x');
};
function clip(start: number, o: { file?: boolean; snapshot?: boolean; stream?: string; origin?: ClipOrigin } = {}) {
  const path = clipPath(start);
  if (o.file !== false) touch(path);
  const snapshot = o.snapshot ? clipPath(start + 3000, 'jpg') : null;
  if (snapshot) touch(snapshot);
  return insertClip(catalog, { cam: 'cam1', start_ts: start, end_ts: start + 30_000, path, stream: o.stream ?? 'sub', size: 1, received_at: start + 60_000, snapshot, origin: o.origin });
}
function event(kind: string, start: number, end: number | null) {
  const e = insertEvent(catalog, { cam: 'cam1', source: 'onvif', kind, start_ts: start, raw: null });
  if (end !== null) closeEvent(catalog, e.id, end, 'state');
  return e;
}
const rec = (start: number, kinds: Kind[] = ['motion'], size = 0x100000): RecordingEntry => ({
  id: `RecS0A_${new Date(start).toISOString().slice(0, 10).replaceAll('-', '')}_${new Date(start).toISOString().slice(11, 19).replaceAll(':', '')}_000000_0_55148000000000_${size.toString(16)}.mp4`,
  path: `/mnt/sda/x/${start}.mp4`, start, end: start + 30_000, stream: 'sub', size, kinds,
});
function camera(o: { months: Record<string, number[]>; recs: Record<string, RecordingEntry[]>; failing?: string[]; offline?: boolean }) {
  const searched: string[] = [];
  const deps: CameraListDeps = {
    timeInfo: async () => ({ stdOffsetMinutes: 0, dstOffsetMinutes: 0 }),
    sleep: async () => undefined,
    list: {
      monthDays: async (m) => o.months[m] ?? [],
      day: async (date) => {
        searched.push(date);
        if (o.offline) throw new SearchError('camera_offline', 'the camera does not answer');
        if (o.failing?.includes(date)) throw new SearchError('search_failed', 'rspCode -17');
        return o.recs[date] ?? [];
      },
    },
  };
  return { deps, searched };
}
const settings = (o: Partial<ClipsSettings> = {}): ClipsSettings => ({ cam: 'cam1', clipsDays: 2, stream: 'sub', ftpEnabled: true, ...o });
const deps = (cam: CameraListDeps, o: Partial<ClipsInventoryDeps> = {}): ClipsInventoryDeps => ({ dataDir: dir, catalog, settings: () => settings(), camera: cam, ...o });
const ctx = (o: Partial<CheckContext> = {}): CheckContext => ({ signal: new AbortController().signal, progress: () => undefined, now: NOW, options: {}, ...o });

// The window is 2026-09-30T00:00Z (clipsDays 2) to NOW.
function fixture() {
  const c1 = clip(T('2026-10-01T08:00:00'), { snapshot: true }); // paired with r1, has an event
  const c2 = clip(T('2026-10-01T09:00:00'), { file: false }); // row without file, paired with r2
  const c3 = clip(T('2026-10-01T10:00:00')); // no event, not on the camera
  const c4 = clip(T('2026-09-30T07:00:00'), { stream: 'main' }); // another stream, no event
  clip(T('2026-09-29T23:00:00')); // before the window
  const c6 = clip(T('2026-10-02T06:00:00'), { origin: 'camera' }); // fetched by an earlier repair, paired with r6
  touch(join(dir, 'clips', 'cam1', '2026', '10', '01', `0700-${T('2026-10-01T07:00:00')}.mp4`)); // file without row
  touch(join(dir, 'clips', 'cam1', '2026', '10', '01', `0701-${T('2026-10-01T07:01:00')}.jpg`)); // picture without row
  const e1 = event('person', T('2026-10-01T08:00:05'), T('2026-10-01T08:00:20'));
  event('motion', T('2026-10-01T09:00:02'), T('2026-10-01T09:00:10'));
  const e3 = event('vehicle', T('2026-10-01T11:00:00'), T('2026-10-01T11:00:20')); // no clip
  event('motion', NOW - 60_000, NOW - 30_000); // ended less than SETTLE_MS ago: not judged
  event('person', NOW - 100_000, null); // still open: not judged
  const recs = {
    '2026-10-01': [rec(T('2026-10-01T08:00:03'), ['person']), rec(T('2026-10-01T09:00:00')), rec(T('2026-10-01T11:00:00'), ['vehicle'], 0x200000), rec(T('2026-10-01T13:00:00'), [])],
    '2026-10-02': [rec(T('2026-10-02T06:00:02')), { ...rec(NOW - 120_000), end: NOW - 90_000 }],
  };
  return { c1, c2, c3, c4, c6, e1, e3, recs };
}

describe('clips inventory, local (part 1)', () => {
  it('finds rows without file, files without row, events without clip and clips without event', async () => {
    const f = fixture();
    const cam = camera({ months: {}, recs: {} });
    const r = await clipsCheck(deps(cam.deps))(ctx());
    expect(SETTLE_MS).toBe(300_000);
    expect(cam.searched).toEqual([]); // local only: no camera contact
    expect(r.window).toEqual({ from: T('2026-09-30T00:00:00'), to: NOW, reason: 'retention', notes: [] });
    expect(r.counts).toEqual({ clipsDays: 2, clips: 5, fromCamera: 1, rowsWithoutFile: 1, filesWithoutRow: 2, events: 3, eventsWithoutClip: 1, clipsWithoutEvent: 3 });
    expect(r.items).toEqual([
      { type: 'row-without-file', clipId: f.c2.id, start: f.c2.start_ts, file: `clips/cam1/2026/10/01/0900-${f.c2.start_ts}.mp4` },
      { type: 'file-without-row', file: `clips/cam1/2026/10/01/0700-${T('2026-10-01T07:00:00')}.mp4` },
      { type: 'file-without-row', file: `clips/cam1/2026/10/01/0701-${T('2026-10-01T07:01:00')}.jpg` },
      { type: 'event-without-clip', eventId: f.e3.id, kind: 'vehicle', start: f.e3.start_ts },
      { type: 'clip-without-event', clipId: f.c4.id, start: f.c4.start_ts },
      { type: 'clip-without-event', clipId: f.c3.id, start: f.c3.start_ts },
      { type: 'clip-without-event', clipId: f.c6.id, start: f.c6.start_ts },
    ]);
    expect(r.top).toEqual([]);
    expect(r.message).toBe('5 clips since 2026-09-30T00:00:00.000Z: 1 rows without file, 2 files without row, 1 of 3 events without clip, 3 clips without event');
  });

  it('notes that FTP is off', async () => {
    const r = await clipsCheck(deps(camera({ months: {}, recs: {} }).deps, { settings: () => settings({ ftpEnabled: false }) }))(ctx());
    expect(r.window.notes).toEqual(['FTP is off in the proxy: no clips arrive, so every event is without a clip']);
  });

  it('stops between days when cancelled, with partial counts and no camera contact', async () => {
    fixture();
    const ac = new AbortController();
    const cam = camera({ months: {}, recs: {} });
    const r = await clipsCheck(deps(cam.deps))(ctx({ signal: ac.signal, options: { camera: true }, progress: (p) => p.done === 1 && ac.abort() }));
    expect(r.counts.clips).toBe(1); // the first day only
    expect(cam.searched).toEqual([]);
  });
});

describe('clips inventory, against the camera (part 2)', () => {
  it('pairs by start on ftp.stream: missing locally, gone from the camera, timer-only, unknown days', async () => {
    const f = fixture();
    const cam = camera({ months: { '2026-09': [28, 30], '2026-10': [1, 2] }, recs: f.recs, failing: ['2026-09-30'] });
    const progress: string[] = [];
    const r = await clipsCheck(deps(cam.deps))(ctx({ options: { camera: true }, progress: (p) => progress.push(`${p.phase} ${p.done}/${p.total}`) }));
    expect(cam.searched).toEqual(['2026-09-30', '2026-10-01', '2026-10-02']);
    expect(progress).toEqual(['clips 0/3', 'clips 1/3', 'clips 2/3', 'clips 3/3', 'camera 1/3', 'camera 2/3', 'camera 3/3']);
    expect(r.counts).toMatchObject({ cameraDays: 3, unknownDays: 1, recordings: 4, timerOnly: 1, paired: 3, missingLocally: 1, missingLocallyBytes: 0x200000, goneFromCamera: 1, olderThanSd: 0, otherStream: 1 });
    expect(r.window).toMatchObject({ camera: { stream: 'sub', to: NOW - SETTLE_MS, oldestSdDay: '2026-09-28', unknownDays: ['2026-09-30'] } });
    expect(r.window.notes).toEqual(['1 local clips of another stream than sub (ftp.stream) were left out of the camera compare']);
    // The repair's candidates first, then the clips gone from the camera, then the local findings.
    expect(r.items.slice(0, 2)).toEqual([
      { type: 'missing-locally', id: f.recs['2026-10-01'][2].id, start: T('2026-10-01T11:00:00'), end: T('2026-10-01T11:00:30'), size: 0x200000, stream: 'sub', kinds: ['vehicle'] },
      { type: 'gone-from-camera', clipId: f.c3.id, start: f.c3.start_ts },
    ]);
    expect(r.items).toHaveLength(9);
    expect(r.top).toEqual([
      { date: '2026-10-01', state: 'listed', recordings: 3, missingLocally: 1, goneFromCamera: 1 },
      { date: '2026-09-30', state: 'unknown', recordings: 0, missingLocally: 0, goneFromCamera: 0 },
    ]);
    expect(r.message).toBe(
      '5 clips since 2026-09-30T00:00:00.000Z: 1 rows without file, 2 files without row, 1 of 3 events without clip, 3 clips without event; ' +
        'camera (sub): 4 recordings, 1 missing locally (2.0 MB), 1 local clips gone from the camera, 1 days unknown',
    );
  });

  it('a local clip on an unknown day is never gone; one before the SD card\'s oldest day is older than the SD', async () => {
    clip(T('2026-09-30T05:00:00')); // before the SD card's oldest day (2026-10-01)
    clip(T('2026-10-01T05:00:00')); // on an unknown day
    const cam = camera({ months: { '2026-09': [], '2026-10': [1] }, recs: {}, failing: ['2026-10-01'] });
    const r = await clipsCheck(deps(cam.deps))(ctx({ options: { camera: true } }));
    expect(r.counts).toMatchObject({ goneFromCamera: 0, olderThanSd: 1, unknownDays: 1, missingLocally: 0 });
    expect(cam.searched).toEqual(['2026-10-01']); // 09-30 and 10-02 have no recordings: no Search
  });

  it('fails the run with camera_offline when the camera does not answer', async () => {
    const cam = camera({ months: { '2026-10': [1] }, recs: {}, offline: true });
    await expect(clipsCheck(deps(cam.deps))(ctx({ options: { camera: true } }))).rejects.toThrow(/^camera_offline: /);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/inventory-clips.test.ts`
Expected: FAIL (`Cannot find module '../src/inventory/clips'`).

- [ ] **Step 3: Write the implementation**

`src/inventory/clips.ts`:

```ts
import { access, readdir } from 'fs/promises';
import { basename, dirname, join } from 'path';
import { setImmediate as yieldToLoop } from 'timers/promises';
import type { Catalog } from '../catalog/db';
import { localDate, type Kind, type Stream } from '../recordings/names';
import type { RecordingEntry } from '../recordings/list';
import { listCamera, type CameraListDeps } from './camera-list';
import { pairByStart } from './match';
import { MAX_ITEMS, MAX_TOP, type Check, type CheckResult } from './runner';

// The clips inventory (#74, spec 2026-10-02-inventory-design §4). Part 1,
// local: the clip rows and files of the clips retention window, and the
// recording-kind events without a clip (and clips without an event). Part 2,
// with `camera: true`: the SD recordings of the window on `ftp.stream`
// (camera-list.ts) paired with the local clips of that stream (match.ts).
// Recordings on the camera but not here are the repair's candidates (the
// first items, oldest first). A day whose Search failed is `unknown`: its
// recordings never count as missing, its clips never as gone.

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// What may still be on its way is not judged: an event or recording that
// ended less than this long ago (the FTP upload follows the recording's end).
export const SETTLE_MS = 5 * 60_000;
// The event kinds the camera records for (a clip is expected for each).
export const RECORDING_KINDS = ['motion', 'person', 'vehicle', 'pet'] as const;
const FTP_OFF_NOTE = 'FTP is off in the proxy: no clips arrive, so every event is without a clip';
const OTHER_STREAM_NOTE = (n: number, stream: string) => `${n} local clips of another stream than ${stream} (ftp.stream) were left out of the camera compare`;

export interface ClipsSettings { cam: string; clipsDays: number; stream: Stream; ftpEnabled: boolean }
export interface ClipsInventoryDeps {
  dataDir: string;
  catalog: Catalog;
  settings: () => ClipsSettings; // read when a run starts
  camera: CameraListDeps;
}
export type ClipItem =
  | { type: 'missing-locally'; id: string; start: number; end: number; size: number; stream: Stream; kinds: Kind[] }
  | { type: 'gone-from-camera'; clipId: number; start: number }
  | { type: 'row-without-file'; clipId: number; start: number; file: string }
  | { type: 'file-without-row'; file: string }
  | { type: 'event-without-clip'; eventId: number; kind: string; start: number }
  | { type: 'clip-without-event'; clipId: number; start: number };
// The camera days with problems, the most missing first (the report's `top`).
export interface CameraDayRow { date: string; state: 'listed' | 'unknown'; recordings: number; missingLocally: number; goneFromCamera: number }

interface Row { id: number; start_ts: number; end_ts: number | null; path: string; snapshot: string | null; stream: string; origin: string }

const pad = (n: number) => String(n).padStart(2, '0');
const dayStart = (ts: number) => Math.floor(ts / DAY) * DAY;
const dayFolder = (root: string, ts: number) => {
  const d = new Date(ts);
  return join(root, String(d.getUTCFullYear()), pad(d.getUTCMonth() + 1), pad(d.getUTCDate()));
};
export const mb = (bytes: number) => `${(bytes / 2 ** 20).toFixed(1)} MB`;

async function names(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}
async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

export function clipsCheck(d: ClipsInventoryDeps): Check {
  return async (ctx): Promise<CheckResult> => {
    const s = d.settings();
    const now = ctx.now;
    const from = dayStart(now - s.clipsDays * DAY);
    const to = now;
    const root = join(d.dataDir, 'clips', s.cam);
    const db = d.catalog.db;
    const counts: Record<string, number> = {
      clipsDays: s.clipsDays, clips: 0, fromCamera: 0, rowsWithoutFile: 0, filesWithoutRow: 0,
      events: 0, eventsWithoutClip: 0, clipsWithoutEvent: 0,
    };
    const local: ClipItem[] = [];
    const add = (it: ClipItem) => {
      if (local.length <= MAX_ITEMS) local.push(it); // one more than kept: the runner flags the cut
    };
    const rel = (file: string) => file.startsWith(`${d.dataDir}/`) ? file.slice(d.dataDir.length + 1) : file;
    const notes: string[] = s.ftpEnabled ? [] : [FTP_OFF_NOTE];

    // Part 1: rows and files, one UTC day folder at a time.
    const rowsOf = db.prepare('SELECT id, start_ts, end_ts, path, snapshot, stream, origin FROM clips WHERE cam = ? AND start_ts >= ? AND start_ts < ? ORDER BY start_ts, id');
    const byPath = db.prepare('SELECT 1 AS x FROM clips WHERE path = ? LIMIT 1');
    const bySnapshot = db.prepare('SELECT 1 AS x FROM clips WHERE snapshot = ? LIMIT 1');
    const days: number[] = [];
    for (let t = from; t < to; t += DAY) days.push(t);
    const rows: Row[] = [];
    let cancelled = false;
    ctx.progress({ phase: 'clips', done: 0, total: days.length });
    for (const [i, day] of days.entries()) {
      if (ctx.signal.aborted) {
        cancelled = true;
        break;
      }
      const folder = dayFolder(root, day);
      const files = new Set(await names(folder));
      const dayRows = rowsOf.all(s.cam, day, Math.min(day + DAY, to)) as unknown as Row[];
      const known = new Set<string>();
      for (const r of dayRows) {
        rows.push(r);
        counts.clips++;
        if (r.origin === 'camera') counts.fromCamera++;
        for (const f of [r.path, r.snapshot]) if (f && dirname(f) === folder) known.add(basename(f));
        const present = dirname(r.path) === folder ? files.has(basename(r.path)) : await exists(r.path);
        if (!present) {
          counts.rowsWithoutFile++;
          add({ type: 'row-without-file', clipId: r.id, start: r.start_ts, file: rel(r.path) });
        }
      }
      for (const n of [...files].sort()) {
        if (known.has(n) || !/\.(mp4|jpg)$/.test(n)) continue;
        const path = join(folder, n);
        if ((n.endsWith('.mp4') ? byPath : bySnapshot).get(path)) continue; // a row of another day points here
        counts.filesWithoutRow++;
        add({ type: 'file-without-row', file: rel(path) });
      }
      ctx.progress({ phase: 'clips', done: i + 1, total: days.length, note: new Date(day).toISOString().slice(0, 10) });
      await yieldToLoop();
    }

    // Events and clips that should overlap: recording-kind events that ended
    // SETTLE_MS ago or earlier; any event for a clip.
    const kinds = RECORDING_KINDS.map(() => '?').join(', ');
    if (!cancelled) {
      const settled = now - SETTLE_MS;
      counts.events = Number((db.prepare(`SELECT COUNT(*) AS n FROM events WHERE cam = ? AND kind IN (${kinds}) AND start_ts >= ? AND end_ts IS NOT NULL AND end_ts <= ?`).get(s.cam, ...RECORDING_KINDS, from, settled) as { n: number }).n);
      const lonely = db
        .prepare(`SELECT e.id, e.kind, e.start_ts FROM events e WHERE e.cam = ? AND e.kind IN (${kinds}) AND e.start_ts >= ? AND e.end_ts IS NOT NULL AND e.end_ts <= ?
          AND NOT EXISTS (SELECT 1 FROM clips c WHERE c.cam = e.cam AND c.start_ts <= e.end_ts AND COALESCE(c.end_ts, c.start_ts) >= e.start_ts) ORDER BY e.start_ts, e.id`)
        .all(s.cam, ...RECORDING_KINDS, from, settled) as { id: number; kind: string; start_ts: number }[];
      counts.eventsWithoutClip = lonely.length;
      for (const e of lonely) add({ type: 'event-without-clip', eventId: e.id, kind: e.kind, start: e.start_ts });
      const bare = db
        .prepare(`SELECT c.id, c.start_ts FROM clips c WHERE c.cam = ? AND c.start_ts >= ? AND c.start_ts < ?
          AND NOT EXISTS (SELECT 1 FROM events e WHERE e.cam = c.cam AND e.start_ts <= COALESCE(c.end_ts, c.start_ts) AND (e.end_ts IS NULL OR e.end_ts >= c.start_ts)) ORDER BY c.start_ts, c.id`)
        .all(s.cam, from, to) as { id: number; start_ts: number }[];
      counts.clipsWithoutEvent = bare.length;
      for (const c of bare) add({ type: 'clip-without-event', clipId: c.id, start: c.start_ts });
    }

    let message =
      `${counts.clips} clips since ${new Date(from).toISOString()}: ${counts.rowsWithoutFile} rows without file, ${counts.filesWithoutRow} files without row, ` +
      `${counts.eventsWithoutClip} of ${counts.events} events without clip, ${counts.clipsWithoutEvent} clips without event`;
    const window: CheckResult['window'] = { from, to, reason: 'retention', notes };
    if (!ctx.options?.camera || cancelled || ctx.signal.aborted) return { window, counts, top: [], items: local, message };

    // Part 2: the camera's recordings of the window on ftp.stream.
    const cameraTo = now - SETTLE_MS;
    let listing;
    try {
      listing = await listCamera(d.camera, {
        from, to, stream: s.stream, signal: ctx.signal,
        progress: (done, total, date) => ctx.progress({ phase: 'camera', done, total, note: date }),
      });
    } catch (err) {
      if ((err as { code?: string }).code === 'camera_offline') throw new Error(`camera_offline: ${(err as Error).message}`);
      throw err;
    }
    const t = listing.time;
    const listed = new Set(listing.days.filter((x) => x.state === 'listed').map((x) => x.date));
    const unknown = listing.days.filter((x) => x.state === 'unknown').map((x) => x.date);
    const recs: RecordingEntry[] = listing.days.flatMap((x) => x.recordings).filter((r) => r.start >= from && r.end <= cameraTo);
    const mine = rows.filter((r) => r.stream === s.stream && (r.end_ts ?? r.start_ts) <= cameraTo && listed.has(localDate(r.start_ts, t)));
    const otherStream = rows.filter((r) => r.stream !== s.stream).length;
    const pairing = pairByStart(recs, mine.map((r) => ({ id: r.id, start: r.start_ts, stream: r.stream })));
    const missing = pairing.recsAlone.filter((r) => r.kinds.length > 0).sort((a, b) => b.start - a.start);
    const sdFrom = listing.oldestSdDay;
    const gone = pairing.clipsAlone.filter((c) => sdFrom === null || localDate(c.start, t) >= sdFrom);
    const camera = {
      cameraDays: listing.days.length,
      unknownDays: unknown.length,
      recordings: recs.filter((r) => r.kinds.length > 0).length,
      timerOnly: recs.filter((r) => r.kinds.length === 0).length,
      paired: pairing.pairs.filter((p) => p.rec.kinds.length > 0).length,
      missingLocally: missing.length,
      missingLocallyBytes: missing.reduce((n, r) => n + r.size, 0),
      goneFromCamera: gone.length,
      olderThanSd: pairing.clipsAlone.length - gone.length,
      otherStream,
    };
    Object.assign(counts, camera);
    const items: ClipItem[] = [
      ...missing.map((r): ClipItem => ({ type: 'missing-locally', id: r.id, start: r.start, end: r.end, size: r.size, stream: r.stream, kinds: r.kinds })),
      ...gone.map((c): ClipItem => ({ type: 'gone-from-camera', clipId: c.id, start: c.start })),
      ...local,
    ];
    const perDay = new Map<string, CameraDayRow>(listing.days.map((x) => [x.date, { date: x.date, state: x.state, recordings: x.recordings.filter((r) => r.kinds.length > 0).length, missingLocally: 0, goneFromCamera: 0 }]));
    const dayOf = new Map(listing.days.flatMap((x) => x.recordings.map((r) => [r.id, x.date] as const)));
    for (const r of missing) perDay.get(dayOf.get(r.id)!)!.missingLocally++;
    for (const c of gone) {
      const row = perDay.get(localDate(c.start, t));
      if (row) row.goneFromCamera++;
    }
    const top = [...perDay.values()]
      .filter((x) => x.state === 'unknown' || x.missingLocally || x.goneFromCamera)
      .sort((a, b) => b.missingLocally - a.missingLocally || b.goneFromCamera - a.goneFromCamera || a.date.localeCompare(b.date))
      .slice(0, MAX_TOP);
    if (otherStream) notes.push(OTHER_STREAM_NOTE(otherStream, s.stream));
    message +=
      `; camera (${s.stream}): ${camera.recordings} recordings, ${camera.missingLocally} missing locally (${mb(camera.missingLocallyBytes)}), ` +
      `${camera.goneFromCamera} local clips gone from the camera, ${camera.unknownDays} days unknown`;
    return {
      window: { ...window, camera: { stream: s.stream, to: cameraTo, oldestSdDay: sdFrom, unknownDays: unknown } },
      counts, top, items, message,
    };
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/inventory-clips.test.ts && npx tsc --noEmit -p tsconfig.check.json`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/inventory/clips.ts test/inventory-clips.test.ts
git commit -m "feat(inventory): the clips check, local and against the camera's SD card (#74)"
```

---

### Task 5: `ClipIndexer.addRecording()`

**Files:**
- Modify: `src/clips/indexer.ts`
- Test: `test/clips-indexer.test.ts`

**Interfaces:**
- Consumes: Task 2 `insertClip` with `origin`, `clipByPath`; the indexer's private `folder()`, `pictureFor()`, `probeVideo()`; `Stream` from `src/recordings/names.ts`.
- Produces: `ClipIndexer.addRecording(file: string, r: { start: number; stream: Stream }): Promise<ClipRow>` — copies `file` (left in place) to `clips/<cam>/YYYY/MM/DD/HHMM-<start>.mp4` (via `<path>.part` and a rename), inserts the row with `origin: 'camera'`, `end_ts = start + ffprobe duration`, `received_at = now`, `snapshot` = the FTP picture of that start if stored, calls `stored(bytes)`; no stream-log entry, no change to `failures()` or `lastIndexed()`. Throws `the recording is not a video` or `a clip with that start exists`.

- [ ] **Step 1: Write the failing tests**

Append to `test/clips-indexer.test.ts`:

```ts
// #74: a recording fetched from the SD card by an inventory repair.
describe('ClipIndexer.addRecording', () => {
  const START = Date.UTC(2026, 8, 27, 19, 3, 1);

  it('copies the recording into clips/, marks it from the camera, links the FTP picture, and tells no stream client', async () => {
    const { dir, catalog, log, indexer } = setup();
    let stored = 0;
    const counted = new ClipIndexer({ catalog, log, config: () => DEFAULTS, timeInfo: async () => chicago(1), dataDir: dir, cam: 'cam1', stored: (b) => (stored += b) });
    // The camera's picture of that event came by FTP without its clip.
    const pic = join(dir, 'clips', 'cam1', '2026', '09', '27', `1903-${START + 4000}.jpg`);
    mkdirSync(join(dir, 'clips', 'cam1', '2026', '09', '27'), { recursive: true });
    writeFileSync(pic, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    const row = await counted.addRecording(clipFile, { start: START, stream: 'sub' });
    expect(row).toMatchObject({ cam: 'cam1', start_ts: START, stream: 'sub', origin: 'camera', snapshot: pic, path: join(dir, 'clips', 'cam1', '2026', '09', '27', `1903-${START}.mp4`) });
    expect(row.end_ts! - START).toBeGreaterThanOrEqual(2900);
    expect(readFileSync(row.path).equals(readFileSync(clipFile))).toBe(true);
    expect(existsSync(clipFile)).toBe(true); // the cached recording stays
    expect(stored).toBe(row.size);
    expect(log.since(0, { types: ['clip'] }, 100)).toEqual([]);
    expect(counted.lastIndexed()).toBeNull();
    expect(indexer.failures()).toBe(0);
  });

  it('refuses a second clip with the same start, and a file that is no video', async () => {
    const { dir, catalog, indexer } = setup();
    await indexer.addRecording(clipFile, { start: START, stream: 'sub' });
    await expect(indexer.addRecording(clipFile, { start: START, stream: 'sub' })).rejects.toThrow('a clip with that start exists');
    const junk = join(dir, 'junk.mp4');
    writeFileSync(junk, 'not a video');
    await expect(indexer.addRecording(junk, { start: START + 60_000, stream: 'sub' })).rejects.toThrow('the recording is not a video');
    expect(listClips(catalog, 'cam1', START - 1000, START + 120_000)).toHaveLength(1);
    expect(existsSync(join(dir, 'clips', 'cam1', '2026', '09', '27', `1904-${START + 60_000}.mp4`))).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/clips-indexer.test.ts`
Expected: FAIL (`indexer.addRecording is not a function`).

- [ ] **Step 3: Write the implementation**

`src/clips/indexer.ts` imports become:

```ts
import { execFile } from 'child_process';
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readSync, renameSync, unlinkSync } from 'fs';
import { copyFile, rename, stat, unlink } from 'fs/promises';
import { dirname, join } from 'path';
import { promisify } from 'util';
import type { DstRule, TimeInfo } from '../camera/time';
import { clipByPath, clipForSnapshot, clipsWithoutSnapshot, deleteClip, insertClip, overlappingEvents, setSnapshot, type ClipRow } from '../catalog/clips';
import type { Catalog } from '../catalog/db';
import type { Config } from '../config/defaults';
import { logger } from '../log';
import type { Stream } from '../recordings/names';
import type { StreamLog } from '../stream/log';
import type { Upload } from './ftp-server';
```

Add the method to `ClipIndexer`, just before `private async index(u: Upload)`:

```ts
  // A recording fetched from the camera's SD card by an inventory repair
  // (#74, spec 2026-10-02-inventory-design §4): `file` stays where it is (the
  // recordings cache; the caller keeps it pinned), a copy goes into clips/
  // under the FTP layout, and the row has origin 'camera'. No stream-log
  // entry, so no SSE (spec decision 3), and no FTP arrival or failure count.
  // Throws when the file is no video or a clip with that start exists.
  async addRecording(file: string, r: { start: number; stream: Stream }): Promise<ClipRow> {
    const probe = await probeVideo(file);
    if (!probe) throw new Error('the recording is not a video');
    const t = new Date(r.start);
    const path = join(this.folder(r.start), `${pad(t.getUTCHours())}${pad(t.getUTCMinutes())}-${r.start}.mp4`);
    if (clipByPath(this.d.catalog, path) || existsSync(path)) throw new Error('a clip with that start exists');
    mkdirSync(dirname(path), { recursive: true });
    const part = `${path}.part`;
    try {
      await copyFile(file, part);
      await rename(part, path);
    } catch (err) {
      await unlink(part).catch(() => undefined);
      throw err;
    }
    const size = (await stat(path)).size;
    this.d.stored?.(size);
    const row = insertClip(this.d.catalog, {
      cam: this.d.cam,
      start_ts: r.start,
      end_ts: r.start + Math.round(probe.durationS * 1000),
      path,
      stream: r.stream,
      size,
      received_at: this.now(),
      snapshot: this.pictureFor(r.start), // the camera's FTP picture may have come without its clip
      origin: 'camera',
    });
    logger.info({ clipId: row.id, start: r.start, durationS: probe.durationS, bytes: size }, 'clip_repaired');
    return row;
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/clips-indexer.test.ts && npx tsc --noEmit -p tsconfig.check.json`
Expected: PASS (20 tests).

- [ ] **Step 5: Commit**

```bash
git add src/clips/indexer.ts test/clips-indexer.test.ts
git commit -m "feat(clips): addRecording, a clip fetched from the SD card, origin camera (#74)"
```

---

### Task 6: The clips repair

**Files:**
- Create: `src/inventory/repair-clips.ts`
- Test: `test/inventory-repair-clips.test.ts`

**Interfaces:**
- Consumes: Task 1 `RepairEntry`, `RepairResult`, `RepairContext`, `InventoryReport`; Task 4 `ClipItem`, `mb`; Task 3 `START_SLACK_MS`; Task 5 `ClipIndexer.addRecording`; `clipNear` (`src/catalog/clips.ts`); `RecordingFetcher.get(entry, {priority, signal})` → `{fetch: Fetch}` with `fetch.done`, `fetch.kept`; `RecordingCache.open(id)` (pins, or null) and `path(id)`; `RecordingList.find(id, signal)`; `BaichuanError` codes `refused`, `offline`, `not_found`; `SearchError` `camera_offline`; `isAbort`.
- Produces (`src/inventory/repair-clips.ts`):
  - `export const REPAIR_MAX_CLIPS = 50; REPAIR_MAX_BYTES = 200 * 2 ** 20; REPAIR_GAP_MS = 1000; REPAIR_MAX_FAILURES = 3;`
  - `export type RepairStop = 'clip-cap' | 'byte-cap' | 'max-gb' | 'paused' | 'failures' | 'refused' | 'camera_offline';`
  - `export type SkipReason = 'outside-retention' | 'already-local' | 'gone-from-camera' | 'other-stream';`
  - `export interface RepairItem { id; start; result: 'ok' | 'skipped' | 'failed'; reason?; error?; clipId?; bytes? }`
  - `export interface ClipsRepairSettings { cam: string; stream: Stream; clipsDays: number; maxGB?: number }`
  - `export interface ClipsRepairDeps { catalog; settings: () => ClipsRepairSettings; list: Pick<RecordingList, 'find'>; fetcher: Pick<RecordingFetcher, 'get'>; cache: Pick<RecordingCache, 'open' | 'path'>; indexer: () => Pick<ClipIndexer, 'addRecording'>; paused: () => boolean; clipsBytes: () => number; sleep?: (ms, signal) => Promise<void>; limits?: { clips?: number; bytes?: number } }`
  - `export function clipsRepair(d: ClipsRepairDeps): RepairEntry` — counts `candidates, requested, done, failed, skipped, bytes`; `top` = failures `{id, start, error}`; message `"<done> of <requested> fetched (<MB>), <failed> failed, <skipped> skipped[; stopped: <why>]"`; `ready()` answers `compare the clips with the camera first` / `nothing is missing locally` / null.

- [ ] **Step 1: Write the failing tests**

`test/inventory-repair-clips.test.ts` (a real `RecordingFetcher`, `RecordingCache` and `ClipIndexer`; the camera is a fake list and download):

```ts
import { beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'child_process';
import { existsSync, mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';
import type { Writable } from 'stream';
import { BaichuanError } from '../src/camera/baichuan/errors';
import { openCatalog } from '../src/catalog/db';
import { insertClip, listClips } from '../src/catalog/clips';
import { ClipIndexer } from '../src/clips/indexer';
import { DEFAULTS } from '../src/config/defaults';
import { RecordingCache } from '../src/recordings/cache';
import { RecordingFetcher } from '../src/recordings/fetcher';
import { SearchError, type RecordingEntry } from '../src/recordings/list';
import { StreamLog } from '../src/stream/log';
import { mb, type ClipItem } from '../src/inventory/clips';
import { clipsRepair, REPAIR_GAP_MS, REPAIR_MAX_BYTES, REPAIR_MAX_CLIPS, type ClipsRepairDeps, type ClipsRepairSettings } from '../src/inventory/repair-clips';
import type { InventoryReport, RepairContext } from '../src/inventory/runner';

const run = promisify(execFile);
const NOW = Date.UTC(2026, 9, 2, 12, 0);
const pad = (n: number) => String(n).padStart(2, '0');
let video: Buffer;
beforeAll(async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'camproxy-repairsrc-')), 'rec.mp4');
  await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=10', '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', file]);
  video = readFileSync(file);
}, 30_000);

// The SD recording i of 2026-10-01 (10:<i>:00 UTC), as the list and the report know it.
const recording = (i: number, o: Partial<RecordingEntry> = {}): RecordingEntry => {
  const size = o.size ?? video.length;
  const id = `RecS0A_20261001_10${pad(i)}00_10${pad(i)}30_0_55148000000000_${size.toString(16).toUpperCase()}.mp4`;
  const start = Date.UTC(2026, 9, 1, 10, i);
  return { id, path: `/mnt/sda/Mp4Record/2026-10-01/${id}`, start, end: start + 30_000, stream: 'sub', size, kinds: ['motion'], ...o };
};
const missing = (e: RecordingEntry): ClipItem => ({ type: 'missing-locally', id: e.id, start: e.start, end: e.end, size: e.size, stream: e.stream, kinds: e.kinds });
const report = (items: ClipItem[], o: Partial<InventoryReport> = {}): InventoryReport => ({
  runId: 'clips-1-abcdef', kind: 'clips', op: 'check', camera: 'cam1', startedAt: NOW - 60_000, tookMs: 10, outcome: 'ok', requestedBy: 'token',
  options: { camera: true }, window: { from: NOW - 7 * 86_400_000, to: NOW, reason: 'retention' }, counts: {}, top: [], items, itemsTruncated: false, message: '', ...o,
});

// A real fetcher, cache and indexer; the camera is a fake list and download.
function setup(o: { settings?: Partial<ClipsRepairSettings>; fail?: (path: string) => Error | undefined; gated?: string[]; listed?: boolean; paused?: boolean; clipsBytes?: number; limits?: ClipsRepairDeps['limits'] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'camproxy-repair-'));
  const catalog = openCatalog(join(dir, 'catalog.sqlite'));
  const cache = new RecordingCache({ dir: () => join(dir, 'recordings', 'cam1'), capBytes: () => 50 * 2 ** 20 });
  cache.init();
  const calls: string[] = [];
  const gates = new Map<string, () => void>();
  const fetcher = new RecordingFetcher({
    cache,
    download: async (path: string, _size: number, out: Writable) => {
      calls.push(path);
      if (o.gated?.includes(path)) await new Promise<void>((r) => gates.set(path, r));
      const f = o.fail?.(path);
      if (f) throw f;
      out.write(video);
      return video.length;
    },
    stillListed: async () => o.listed ?? true,
    paused: () => false,
    noteWritten: () => undefined,
    onDone: () => undefined,
  });
  const known = new Map<string, RecordingEntry>();
  const sleeps: number[] = [];
  const config = structuredClone(DEFAULTS);
  config.server.dataDir = dir;
  const indexer = new ClipIndexer({ catalog, log: new StreamLog(catalog), config: () => config, timeInfo: async () => ({ stdOffsetMinutes: 0, dstOffsetMinutes: 0 }), dataDir: dir, cam: 'cam1' });
  const deps: ClipsRepairDeps = {
    catalog,
    settings: () => ({ cam: 'cam1', stream: 'sub', clipsDays: 7, ...o.settings }),
    list: { find: async (id) => known.get(id) },
    fetcher,
    cache,
    indexer: () => indexer,
    paused: () => o.paused ?? false,
    clipsBytes: () => o.clipsBytes ?? 0,
    sleep: async (ms) => void sleeps.push(ms),
    limits: o.limits,
  };
  const onCamera = (...es: RecordingEntry[]) => es.forEach((e) => known.set(e.id, e));
  return { dir, catalog, cache, fetcher, deps, calls, gates, sleeps, onCamera };
}
const ctx = (source: InventoryReport, o: Partial<RepairContext> = {}): RepairContext => ({ signal: new AbortController().signal, progress: () => undefined, now: NOW, source, ...o });

describe('clips repair', () => {
  it('fetches the missing recordings at low priority after a viewer\'s fetch, 1 s apart, and indexes them from the camera', async () => {
    expect([REPAIR_MAX_CLIPS, REPAIR_MAX_BYTES, REPAIR_GAP_MS]).toEqual([50, 200 * 2 ** 20, 1000]);
    const s = setup({ gated: [recording(9).path] });
    const [a, b, viewer] = [recording(1), recording(2), recording(9)];
    s.onCamera(a, b, viewer);
    // A viewer's download is running: the repair waits for it.
    const v = s.fetcher.get(viewer, { priority: 'high' });
    const progress: string[] = [];
    const done = clipsRepair(s.deps).run(ctx(report([missing(a), missing(b)]), { progress: (p) => progress.push(`${p.done}/${p.total}`) }));
    await new Promise((r) => setTimeout(r, 50));
    expect(s.calls).toEqual([viewer.path]);
    s.gates.get(viewer.path)!();
    await v.fetch.done;
    const r = await done;
    expect(s.calls).toEqual([viewer.path, a.path, b.path]);
    expect(s.sleeps).toEqual([1000]);
    expect(r.stopped).toBeNull();
    expect(r.counts).toEqual({ candidates: 2, requested: 2, done: 2, failed: 0, skipped: 0, bytes: 2 * video.length });
    expect(r.message).toBe(`2 of 2 fetched (${mb(2 * video.length)}), 0 failed, 0 skipped`);
    expect(progress).toEqual(['0/2', '1/2', '2/2']);
    const rows = listClips(s.catalog, 'cam1', a.start, b.end);
    expect(rows.map((x) => [x.start_ts, x.origin, x.stream])).toEqual([[a.start, 'camera', 'sub'], [b.start, 'camera', 'sub']]);
    expect(r.items).toEqual([
      { id: a.id, start: a.start, result: 'ok', clipId: rows[0].id, bytes: video.length },
      { id: b.id, start: b.start, result: 'ok', clipId: rows[1].id, bytes: video.length },
    ]);
    expect(existsSync(rows[0].path)).toBe(true);
    expect(s.cache.open(a.id)).not.toBeNull(); // the cached copy stays for viewers
  });

  it('checks each one again: outside the retention, another stream, already local, gone from the card', async () => {
    const s = setup({ listed: false, fail: (p) => (p.includes('_1005') ? new BaichuanError('refused', 'refused', 400) : undefined) });
    const old = recording(1, { start: NOW - 8 * 86_400_000 });
    const main = recording(2, { stream: 'main' });
    const local = recording(3);
    const unlisted = recording(4);
    const vanished = recording(5); // listed, then the camera answers 400 and no longer lists it
    s.onCamera(old, main, local, vanished);
    insertClip(s.catalog, { cam: 'cam1', start_ts: local.start + 4000, end_ts: local.end, path: '/x.mp4', stream: 'sub', size: 1, received_at: NOW, snapshot: null });
    const r = await clipsRepair(s.deps).run(ctx(report([old, main, local, unlisted, vanished].map(missing))));
    expect(r.items.map((x) => (x as { reason?: string }).reason)).toEqual(['outside-retention', 'other-stream', 'already-local', 'gone-from-camera', 'gone-from-camera']);
    expect(r.counts).toMatchObject({ done: 0, failed: 0, skipped: 5 });
    expect(r.stopped).toBeNull();
  });

  it('stops at once when the camera refuses a download', async () => {
    const s = setup({ fail: () => new BaichuanError('refused', 'the camera refused the download', 400) });
    const [a, b] = [recording(1), recording(2)];
    s.onCamera(a, b);
    const r = await clipsRepair(s.deps).run(ctx(report([a, b].map(missing))));
    expect(r.stopped).toBe('refused');
    expect(s.calls).toEqual([a.path]);
    expect(r.counts).toMatchObject({ done: 0, failed: 1 });
    expect(r.top).toEqual([{ id: a.id, start: a.start, error: 'the camera refused the download' }]);
    expect(r.message).toBe('0 of 2 fetched (0.0 MB), 1 failed, 0 skipped; stopped: the camera refused a download');
  });

  it('stops after 3 failures in a row; a success resets the count', async () => {
    const bad = new Set([1, 3, 4, 5].map((i) => recording(i).path));
    const s = setup({ fail: (p) => (bad.has(p) ? new BaichuanError('protocol', 'the download failed') : undefined) });
    const es = [1, 2, 3, 4, 5, 6].map((i) => recording(i));
    s.onCamera(...es);
    const r = await clipsRepair(s.deps).run(ctx(report(es.map(missing))));
    expect(r.stopped).toBe('failures');
    expect(r.counts).toMatchObject({ done: 1, failed: 4 });
    expect(s.calls).toHaveLength(5); // the sixth is never tried
  });

  it('stops on an offline camera', async () => {
    const s = setup();
    s.deps.list = { find: async () => { throw new SearchError('camera_offline', 'the camera does not answer'); } };
    const r = await clipsRepair(s.deps).run(ctx(report([recording(1), recording(2)].map(missing))));
    expect(r.stopped).toBe('camera_offline');
    expect(r.counts).toMatchObject({ failed: 1, done: 0 });
  });

  it('keeps to the caps: clips per run, bytes per run, ftp.maxGB, and a paused disk', async () => {
    const es = [1, 2, 3].map((i) => recording(i));
    const clipCap = setup({ limits: { clips: 2 } });
    clipCap.onCamera(...es);
    const a = await clipsRepair(clipCap.deps).run(ctx(report(es.map(missing))));
    expect([a.stopped, a.counts.requested, a.counts.done, a.counts.candidates]).toEqual(['clip-cap', 2, 2, 3]);
    const byteCap = setup({ limits: { bytes: Math.floor(video.length * 1.5) } });
    byteCap.onCamera(...es);
    const b = await clipsRepair(byteCap.deps).run(ctx(report(es.map(missing))));
    expect([b.stopped, b.counts.done]).toEqual(['byte-cap', 1]);
    const full = setup({ settings: { maxGB: 1 }, clipsBytes: 2 ** 30 - 10 });
    full.onCamera(...es);
    const c = await clipsRepair(full.deps).run(ctx(report(es.map(missing))));
    expect([c.stopped, c.counts.done, full.calls.length]).toEqual(['max-gb', 0, 0]);
    const paused = setup({ paused: true });
    paused.onCamera(...es);
    const d = await clipsRepair(paused.deps).run(ctx(report(es.map(missing))));
    expect([d.stopped, d.counts.done, paused.calls.length]).toEqual(['paused', 0, 0]);
  });

  it('uses a recording a viewer already cached without fetching it again', async () => {
    const s = setup();
    const a = recording(1);
    s.onCamera(a);
    await s.fetcher.get(a, { priority: 'high' }).fetch.done;
    const r = await clipsRepair(s.deps).run(ctx(report([missing(a)])));
    expect(r.counts.done).toBe(1);
    expect(s.calls).toEqual([a.path]); // the viewer's download only
  });

  it('stops between clips when cancelled', async () => {
    const s = setup();
    const es = [1, 2, 3].map((i) => recording(i));
    s.onCamera(...es);
    const ac = new AbortController();
    const r = await clipsRepair(s.deps).run(ctx(report(es.map(missing)), { signal: ac.signal, progress: (p) => p.done === 1 && ac.abort() }));
    expect(r.counts.done).toBe(1);
    expect(r.items).toHaveLength(1);
    expect(r.stopped).toBeNull();
  });

  it('is ready only for a camera compare with something missing locally', () => {
    const { ready } = clipsRepair(setup().deps);
    expect(ready(report([missing(recording(1))]))).toBeNull();
    expect(ready(report([missing(recording(1))], { options: undefined }))).toBe('compare the clips with the camera first');
    expect(ready(report([{ type: 'gone-from-camera', clipId: 1, start: 0 }]))).toBe('nothing is missing locally');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/inventory-repair-clips.test.ts`
Expected: FAIL (`Cannot find module '../src/inventory/repair-clips'`).

- [ ] **Step 3: Write the implementation**

`src/inventory/repair-clips.ts`:

```ts
import { BaichuanError } from '../camera/baichuan/errors';
import { clipNear } from '../catalog/clips';
import type { Catalog } from '../catalog/db';
import type { ClipIndexer } from '../clips/indexer';
import type { RecordingCache } from '../recordings/cache';
import { isAbort, type RecordingFetcher } from '../recordings/fetcher';
import { SearchError, type RecordingEntry, type RecordingList } from '../recordings/list';
import type { Stream } from '../recordings/names';
import { mb, type ClipItem } from './clips';
import { START_SLACK_MS } from './match';
import type { InventoryReport, RepairEntry, RepairResult } from './runner';

// The clips repair (#74 part 3, spec 2026-10-02-inventory-design §4): fetch
// the recordings a recent camera compare found missing locally, over Baichuan
// at `low` priority (a viewer's fetch, queued or running, goes first; a
// running repair fetch is not pre-empted), on ftp.stream. Each one is checked
// again first (storage not paused, inside the clips retention, still missing
// locally, still on the SD card), then fetched into the recordings cache,
// pinned, copied into clips/ and indexed with origin 'camera'
// (ClipIndexer.addRecording). Caps per run: 50 clips, 200 MB, ftp.maxGB;
// 1 s between downloads; it stops after 3 failures in a row, and at once on a
// refused download or an offline camera.

export const REPAIR_MAX_CLIPS = 50;
export const REPAIR_MAX_BYTES = 200 * 2 ** 20;
export const REPAIR_GAP_MS = 1000;
export const REPAIR_MAX_FAILURES = 3;
const DAY = 86_400_000;

export type RepairStop = 'clip-cap' | 'byte-cap' | 'max-gb' | 'paused' | 'failures' | 'refused' | 'camera_offline';
const STOP_TEXT: Record<RepairStop, string> = {
  'clip-cap': `the ${REPAIR_MAX_CLIPS}-clip cap`,
  'byte-cap': `the ${REPAIR_MAX_BYTES / 2 ** 20} MB cap`,
  'max-gb': 'ftp.maxGB would be exceeded',
  paused: 'storage is paused (disk full)',
  failures: `${REPAIR_MAX_FAILURES} failures in a row`,
  refused: 'the camera refused a download',
  camera_offline: 'the camera is offline',
};
export type SkipReason = 'outside-retention' | 'already-local' | 'gone-from-camera' | 'other-stream';
export interface RepairItem { id: string; start: number; result: 'ok' | 'skipped' | 'failed'; reason?: SkipReason; error?: string; clipId?: number; bytes?: number }

export interface ClipsRepairSettings { cam: string; stream: Stream; clipsDays: number; maxGB?: number }
export interface ClipsRepairDeps {
  catalog: Catalog;
  settings: () => ClipsRepairSettings; // read when a run starts
  list: Pick<RecordingList, 'find'>;
  fetcher: Pick<RecordingFetcher, 'get'>;
  cache: Pick<RecordingCache, 'open' | 'path'>;
  indexer: () => Pick<ClipIndexer, 'addRecording'>;
  paused: () => boolean;
  clipsBytes: () => number; // the clips' bytes on disk now (storage usage)
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  limits?: { clips?: number; bytes?: number }; // tests
}

const missingItems = (r: InventoryReport) => (r.items as ClipItem[]).filter((x): x is Extract<ClipItem, { type: 'missing-locally' }> => x.type === 'missing-locally');

const sleepFor = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });

export function clipsRepair(d: ClipsRepairDeps): RepairEntry {
  const ready = (source: InventoryReport): string | null => {
    if (!source.options?.camera) return 'compare the clips with the camera first';
    if (!missingItems(source).length) return 'nothing is missing locally';
    return null;
  };

  const run = async (ctx: Parameters<RepairEntry['run']>[0]): Promise<RepairResult> => {
    const s = d.settings();
    const maxClips = d.limits?.clips ?? REPAIR_MAX_CLIPS;
    const maxBytes = d.limits?.bytes ?? REPAIR_MAX_BYTES;
    const sleep = d.sleep ?? sleepFor;
    const retentionFrom = Math.floor((ctx.now - s.clipsDays * DAY) / DAY) * DAY;
    const all = missingItems(ctx.source);
    const list = all.slice(0, maxClips);
    const counts = { candidates: all.length, requested: list.length, done: 0, failed: 0, skipped: 0, bytes: 0 };
    const items: RepairItem[] = [];
    const failures: { id: string; start: number; error: string }[] = [];
    let stopped: RepairStop | null = null;
    let inARow = 0;
    let downloads = 0;

    const skip = (c: (typeof list)[number], reason: SkipReason) => {
      counts.skipped++;
      items.push({ id: c.id, start: c.start, result: 'skipped', reason });
    };
    const fail = (c: (typeof list)[number], error: string) => {
      counts.failed++;
      inARow++;
      items.push({ id: c.id, start: c.start, result: 'failed', error });
      failures.push({ id: c.id, start: c.start, error });
      if (inARow >= REPAIR_MAX_FAILURES) stopped = 'failures';
    };
    // A file that went into the cache (or was there already), pinned while it is copied.
    const fetchToCache = async (entry: RecordingEntry): Promise<() => void> => {
      const cached = d.cache.open(entry.id);
      if (cached) return cached;
      if (downloads++ > 0) await sleep(REPAIR_GAP_MS, ctx.signal);
      if (ctx.signal.aborted) throw Object.assign(new Error('cancelled'), { name: 'AbortError' });
      const { fetch } = d.fetcher.get(entry, { priority: 'low', signal: ctx.signal });
      await fetch.done;
      const unpin = fetch.kept ? d.cache.open(entry.id) : null;
      if (!unpin) throw new Error('the recording could not be kept in the cache');
      return unpin;
    };

    for (const [i, c] of list.entries()) {
      if (ctx.signal.aborted || stopped) break;
      ctx.progress({ phase: 'repair', done: i, total: list.length, note: c.id });
      if (d.paused()) {
        stopped = 'paused';
        break;
      }
      if (c.start < retentionFrom) {
        skip(c, 'outside-retention');
        continue;
      }
      if (c.stream !== s.stream) {
        skip(c, 'other-stream'); // ftp.stream changed since the compare
        continue;
      }
      if (clipNear(d.catalog, s.cam, s.stream, c.start, START_SLACK_MS)) {
        skip(c, 'already-local');
        continue;
      }
      if (counts.bytes + c.size > maxBytes) {
        stopped = 'byte-cap';
        break;
      }
      if (s.maxGB !== undefined && d.clipsBytes() + c.size > s.maxGB * 2 ** 30) {
        stopped = 'max-gb';
        break;
      }
      try {
        // The camera path comes from a Search (the 30 s day cache), never from the report.
        const entry = await d.list.find(c.id, ctx.signal);
        if (!entry) {
          skip(c, 'gone-from-camera');
          continue;
        }
        const unpin = await fetchToCache(entry);
        try {
          const row = await d.indexer().addRecording(d.cache.path(entry.id), { start: entry.start, stream: s.stream });
          counts.done++;
          counts.bytes += row.size;
          inARow = 0;
          items.push({ id: c.id, start: c.start, result: 'ok', clipId: row.id, bytes: row.size });
        } finally {
          unpin();
        }
      } catch (err) {
        if (isAbort(err) && ctx.signal.aborted) break;
        if (err instanceof BaichuanError && err.code === 'not_found') {
          skip(c, 'gone-from-camera');
          continue;
        }
        const msg = err instanceof Error ? err.message : String(err);
        fail(c, msg);
        const offline = (err instanceof SearchError && err.code === 'camera_offline') || (err instanceof BaichuanError && err.code === 'offline');
        if (offline) stopped = 'camera_offline';
        else if (err instanceof BaichuanError && err.code === 'refused') stopped = 'refused';
        if (stopped) break;
      }
    }
    if (!stopped && !ctx.signal.aborted && all.length > list.length) stopped = 'clip-cap';
    ctx.progress({ phase: 'repair', done: items.length, total: list.length });
    const message = `${counts.done} of ${counts.requested} fetched (${mb(counts.bytes)}), ${counts.failed} failed, ${counts.skipped} skipped${stopped ? `; stopped: ${STOP_TEXT[stopped]}` : ''}`;
    return { counts, top: failures, items, message, stopped };
  };

  return { run, ready };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/inventory-repair-clips.test.ts && npx tsc --noEmit -p tsconfig.check.json`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add src/inventory/repair-clips.ts test/inventory-repair-clips.test.ts
git commit -m "feat(inventory): the clips repair, low-priority fetches from the SD card (#74)"
```

---

### Task 7: Wire it up: the proxy, the control API, the docs

**Files:**
- Modify: `src/proxy.ts`, `src/api/control-api.ts`, `openapi.yaml`, `README.md`, `docs/audit-log.md`, `CHANGELOG.md`, `test/inventory-api.test.ts`
- Test: `test/inventory-clips-api.test.ts` (new)

**Interfaces:**
- Consumes: Task 1 (`start(kind, who, options)`, `repair()`, `repairKinds()`, `listRepairs()`, `RepairRefusedError`, `InventoryKind.camera`), Task 4 `clipsCheck`, Task 6 `clipsRepair`, Task 5 `ClipIndexer`; the proxy's `recordings` (`list`, `fetcher`, `cache`), `client.timeInfo()`, `storage.paused()`, `storage.usage().clips.bytes`, `storage.noteWritten('clips', bytes, 1)`.
- Produces: the `clips` kind (label `Clips`, `camera: true`, with a repair) in `proxy.inventory.checks`; `POST /control/actions/inventory` with `camera`; `POST /control/actions/inventory-repair`; `GET /control/inventory` with `repairs`. The Inventory box (Task 8) uses exactly these.

- [ ] **Step 1: Write the failing tests**

`test/inventory-api.test.ts`: the 400 for an unknown kind now names both kinds:

```ts
      expect(r.body).toEqual({ error: 'invalid', detail: 'kind is one of: stills, clips' });
```

`test/inventory-clips-api.test.ts` (cam-sim's SD card is cleared and seeded with yesterday's recordings before the proxy's first Search):

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { ADMIN_TOKEN, auth, startProxy, until } from './helpers/proxy';
import { startSim } from './helpers/sim';

// The clips inventory and its repair (#74) against cam-sim's SD card and its
// Baichuan server: the proxy compares on ftp.stream (sub here).
let sim: Awaited<ReturnType<typeof startSim>>;
let p: Awaited<ReturnType<typeof startProxy>>;
beforeAll(async () => {
  sim = await startSim();
  // Yesterday (camera-local): two recordings with triggers and one on the timer.
  const sd = sim.sim.engine.sd;
  sd.clear();
  sd.seed([
    { daysAgo: 1, start: '070000', end: '070030', triggers: ['motion'] },
    { daysAgo: 1, start: '071000', end: '071030', triggers: ['person'] },
    { daysAgo: 1, start: '072000', end: '072030', triggers: [] },
  ]);
  p = await startProxy(sim, { settings: { ftp: { stream: 'sub' } } });
  await until(() => p.proxy.status.state().online, 15_000);
}, 30_000);
afterAll(async () => {
  await p.proxy.stop();
  await sim.close();
});
const admin = () => auth(ADMIN_TOKEN);
const lines = (text: string) => text.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
const report = async (id: string) => (await request(p.base).get(`/control/inventory/runs/${id}`).set(admin())).body;
async function run(path: string, body: object) {
  const r = await request(p.base).post(`/control/actions/${path}`).set(admin()).send(body);
  expect(r.status).toBe(202);
  await until(async () => (await report(r.body.runId)).outcome !== 'running', 20_000);
  return report(r.body.runId);
}

describe('clips inventory API', () => {
  it('checks the local clips without contacting the camera', async () => {
    const searches = sim.sim.engine.counters.searches;
    const rep = await run('inventory', { kind: 'clips' });
    expect(rep).toMatchObject({ kind: 'clips', op: 'check', outcome: 'ok', counts: { clips: 0, rowsWithoutFile: 0 } });
    expect(rep).not.toHaveProperty('options');
    expect(rep.counts).not.toHaveProperty('missingLocally');
    expect(sim.sim.engine.counters.searches).toBe(searches);
  });

  it('refuses a camera option it cannot use', async () => {
    const bad = async (body: object, detail: string) => {
      const r = await request(p.base).post('/control/actions/inventory').set(admin()).send(body);
      expect(r.status).toBe(400);
      expect(r.body).toEqual({ error: 'invalid', detail });
    };
    await bad({ kind: 'clips', camera: 'yes' }, 'camera is true or false');
    await bad({ kind: 'stills', camera: true }, 'the stills inventory has no camera compare');
  });

  it('compares with the camera, repairs the missing clips over Baichuan, and then finds none missing', async () => {
    const cmp = await run('inventory', { kind: 'clips', camera: true });
    expect(cmp).toMatchObject({ outcome: 'ok', options: { camera: true }, counts: { recordings: 2, timerOnly: 1, missingLocally: 2, paired: 0, unknownDays: 0 }, window: { camera: { stream: 'sub' } } });
    expect(cmp.items.filter((x: { type: string }) => x.type === 'missing-locally')).toHaveLength(2);
    const downloads = sim.sim.engine.counters.baichuanDownloads;
    const rep = await run('inventory-repair', { kind: 'clips', runId: cmp.runId });
    expect(rep).toMatchObject({ kind: 'clips', op: 'repair', outcome: 'ok', source: cmp.runId, stopped: null, counts: { requested: 2, done: 2, failed: 0, skipped: 0 } });
    expect(rep.runId).toMatch(/^clipsrepair-/);
    expect(sim.sim.engine.counters.baichuanDownloads).toBe(downloads + 2);
    // The clips page shows them as from the camera.
    const yesterday = Math.min(...rep.items.map((x: { start: number }) => x.start));
    const clips = await request(p.base).get(`/api/cameras/cam1/clips?from=${yesterday - 60_000}&to=${yesterday + 86_400_000}`).set(auth());
    expect(clips.body.map((c: { origin: string; stream: string }) => [c.origin, c.stream])).toEqual([['camera', 'sub'], ['camera', 'sub']]);
    // One inventory-repair record, no control-action for the start.
    const recs = lines((await request(p.base).get('/control/audit?action=inventory-repair,control-action').set(admin())).text);
    expect(recs.filter((x) => x.event.action === 'inventory-repair')).toEqual([
      expect.objectContaining({ event: expect.objectContaining({ action: 'inventory-repair', outcome: 'success' }), cam_proxy: expect.objectContaining({ runId: rep.runId, source: cmp.runId, counts: expect.objectContaining({ done: 2 }) }) }),
    ]);
    expect(recs.some((x) => x.cam_proxy?.action === 'inventory-repair')).toBe(false);
    const list = (await request(p.base).get('/control/inventory').set(admin())).body;
    expect(list.repairs.clips[0]).toMatchObject({ runId: rep.runId, outcome: 'ok' });
    expect(list.runs.clips[0].runId).toBe(cmp.runId);
    const again = await run('inventory', { kind: 'clips', camera: true });
    expect(again.counts).toMatchObject({ missingLocally: 0, paired: 2, fromCamera: 2, goneFromCamera: 0 });
  });

  it('stops the repair when the camera refuses the download', async () => {
    sim.sim.engine.sd.seed([{ daysAgo: 1, start: '073000', end: '073030', triggers: ['vehicle'] }]);
    p.proxy.recordings.list.clear(); // the day list is cached 30 s
    const cmp = await run('inventory', { kind: 'clips', camera: true });
    expect(cmp.counts.missingLocally).toBe(1);
    sim.sim.engine.faults.set({ name: 'baichuan.refuse' });
    try {
      const rep = await run('inventory-repair', { kind: 'clips', runId: cmp.runId });
      expect(rep).toMatchObject({ outcome: 'ok', stopped: 'refused', counts: { done: 0, failed: 1 } });
      expect(rep.message).toMatch(/stopped: the camera refused a download$/);
    } finally {
      sim.sim.engine.faults.clear('baichuan.refuse');
    }
  });

  it('refuses a repair from a bad, unknown, local-only or other-kind run', async () => {
    const post = (body: object) => request(p.base).post('/control/actions/inventory-repair').set(admin()).send(body);
    expect((await post({ kind: 'stills', runId: 'stills-1-abcdef' })).body).toEqual({ error: 'invalid', detail: 'kind is one of: clips' });
    expect((await post({ kind: 'clips', runId: '../x' })).body).toEqual({ error: 'invalid', detail: 'runId is the id of a check run' });
    const unknown = await post({ kind: 'clips', runId: 'clips-1-abcdef' });
    expect([unknown.status, unknown.body.error]).toEqual([404, 'not_found']);
    const local = await run('inventory', { kind: 'clips' });
    const r = await post({ kind: 'clips', runId: local.runId });
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ error: 'not_repairable', detail: 'compare the clips with the camera first' });
    const audit = lines((await request(p.base).get('/control/audit?action=inventory-repair,control-action').set(admin())).text);
    expect(audit.some((x) => x.cam_proxy?.action === 'inventory-repair')).toBe(false); // refused starts write nothing
  });

  it('fails the compare with camera_offline when the camera does not answer', async () => {
    sim.sim.engine.faults.set({ name: 'offline' });
    try {
      p.proxy.recordings.list.clear();
      const rep = await run('inventory', { kind: 'clips', camera: true });
      expect(rep.outcome).toBe('failed');
      expect(rep.error).toMatch(/^camera_offline: /);
    } finally {
      sim.sim.engine.faults.clear('offline');
    }
  }, 60_000);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/inventory-clips-api.test.ts test/inventory-api.test.ts`
Expected: FAIL (400 `kind is one of: stills` for `clips`).

- [ ] **Step 3: Write the implementation**

`src/proxy.ts`: add the imports after `import { stillsCheck } from './inventory/stills';`:

```ts
import { clipsCheck } from './inventory/clips';
import { clipsRepair } from './inventory/repair-clips';
```

Delete PR 1's `// Inventories (spec 2026-10-02-inventory-design): …` block (`const inventory = new InventoryRunner({ … });`, just before `// Composed clips (spec 2026-09-28)`): the clips kind needs the recordings side, which is built later. Insert the new block right after `recordingBusy = (p) => recordings.cache.busy(p);` (nothing between uses `inventory`; the control API, the `Proxy` object and `doStop` come later):

```ts
  // Inventories (spec 2026-10-02-inventory-design): one run at a time, the
  // results in <dataDir>/inventory, an `inventory` audit record per run (an
  // `inventory-repair` record per repair). The settings are read when a run
  // starts. The clips compare lists the SD card through the recordings side;
  // its repair fetches there at low priority and indexes through its own
  // ClipIndexer (FTP may be off).
  const inventory = new InventoryRunner({
    dir: join(running.server.dataDir, 'inventory'),
    audit,
    camera: () => running.camera.id,
    checks: {
      stills: {
        label: 'Stills',
        run: stillsCheck({
          dataDir: running.server.dataDir,
          audit,
          catalog,
          settings: () => ({ cam: running.camera.id, intervalS: running.stills.intervalS, stillsDays: running.retention.stillsDays, previewsDays: running.retention.previewsDays, keepHours: running.storage.keepHours.stills }),
        }),
      },
      clips: {
        label: 'Clips',
        camera: true,
        run: clipsCheck({
          dataDir: running.server.dataDir,
          catalog,
          settings: () => ({ cam: running.camera.id, clipsDays: running.retention.clipsDays, stream: running.ftp.stream, ftpEnabled: running.ftp.enabled }),
          camera: { list: recordings.list, timeInfo: () => client.timeInfo() },
        }),
        repair: clipsRepair({
          catalog,
          settings: () => ({ cam: running.camera.id, stream: running.ftp.stream, clipsDays: running.retention.clipsDays, maxGB: running.ftp.maxGB }),
          list: recordings.list,
          fetcher: recordings.fetcher,
          cache: recordings.cache,
          indexer: () => new ClipIndexer({ catalog, log, config: () => running, timeInfo: () => client.timeInfo(), dataDir: running.server.dataDir, cam: running.camera.id, stored: (bytes) => storage.noteWritten('clips', bytes, 1) }),
          paused: () => storage.paused(),
          clipsBytes: () => storage.usage().clips.bytes,
        }),
      },
    },
  });
```

`src/api/control-api.ts`: import `RepairRefusedError` with the runner names:

```ts
import { InventoryBusyError, InventoryStoppingError, RepairRefusedError, RUN_ID, type InventoryRunner } from '../inventory/runner';
```

The list route:

```ts
  r.get('/inventory', async (_req, res) => void res.json({ running: d.inventory.running(), runs: await d.inventory.list(), repairs: await d.inventory.listRepairs() }));
```

In `r.post('/actions/:name', …)`, the comment above the `control-action` condition reads "an inventory writes `inventory` when it ends, a repair `inventory-repair`", and the condition gains `name !== 'inventory-repair'`:

```ts
    if (name !== 'camera-reboot' && name !== 'camera-powercycle' && name !== 'camera-poe-on' && name !== 'restart-proxy' && name !== 'inventory' && name !== 'inventory-repair' && !(name === 'retention-run' && req.body?.dryRun === true)) {
```

Replace the `case 'inventory': { … }` block with these two cases:

```ts
      case 'inventory': {
        const kind: unknown = req.body?.kind;
        const camera: unknown = req.body?.camera;
        const kinds = d.inventory.kinds();
        if (typeof kind !== 'string' || !kinds.includes(kind)) return fail(400, 'invalid', `kind is one of: ${kinds.join(', ')}`);
        if (camera !== undefined && typeof camera !== 'boolean') return fail(400, 'invalid', 'camera is true or false');
        if (camera && !d.inventory.checks[kind]?.camera) return fail(400, 'invalid', `the ${kind} inventory has no camera compare`);
        try {
          const { runId } = d.inventory.start(kind, { requestedBy, ip: clientIp(req), userAgent: req.get('user-agent') }, { camera: camera === true });
          return void res.status(202).json({ runId });
        } catch (err) {
          if (err instanceof InventoryStoppingError) return fail(503, 'stopping', err.message);
          if (!(err instanceof InventoryBusyError)) throw err;
          return fail(409, 'inventory_busy', err.message, { runId: err.runId });
        }
      }
      // A repair from a check report (#74): 202 {runId}; it writes its own
      // `inventory-repair` record when it ends. A refused start writes nothing.
      case 'inventory-repair': {
        const kind: unknown = req.body?.kind;
        const source: unknown = req.body?.runId;
        const kinds = d.inventory.repairKinds();
        if (typeof kind !== 'string' || !kinds.includes(kind)) return fail(400, 'invalid', `kind is one of: ${kinds.join(', ')}`);
        if (typeof source !== 'string' || !RUN_ID.test(source)) return fail(400, 'invalid', 'runId is the id of a check run');
        try {
          const { runId } = await d.inventory.repair(kind, { requestedBy, ip: clientIp(req), userAgent: req.get('user-agent') }, source);
          return void res.status(202).json({ runId });
        } catch (err) {
          if (err instanceof InventoryStoppingError) return fail(503, 'stopping', err.message);
          if (err instanceof InventoryBusyError) return fail(409, 'inventory_busy', err.message, { runId: err.runId });
          if (!(err instanceof RepairRefusedError)) throw err;
          return err.code === 'not_found' ? fail(404, 'not_found', err.message) : fail(409, err.code, err.message);
        }
      }
```

`openapi.yaml`: in `/control/inventory` replace the summary and the 200 line:

```yaml
      summary: The running inventory or repair and the last 10 runs per kind, newest first (spec 2026-10-02-inventory-design)
      responses:
        '200': { description: '{ running: { runId, kind, op: check|repair, startedAt, outcome: running, progress: { phase, done, total, note? } } | null, runs: { stills: [summary], clips: [summary] }, repairs: { clips: [summary] } }; a summary is { runId, kind, startedAt, tookMs, outcome: ok|cancelled|failed, counts, message }' }
```

in `/control/inventory/runs/{id}` the 200 line:

```yaml
        '200': { description: '{ runId, kind, op (check|repair), camera, startedAt, tookMs, outcome, error?, cancelledBy? (request|stop), requestedBy, options? ({camera: true}: compared with the camera), source? (a repair: the check run it worked from), stopped? (a repair: why it ended early: clip-cap, byte-cap, max-gb, paused, failures, refused, camera_offline, or null), window: { from, to, reason (retention|budget|store-younger|empty), retentionFrom, protectedFrom, notes (caveats on the counts); clips with the camera: camera: { stream, to, oldestSdDay, unknownDays } }, counts, top (stills: the 10 longest gaps; clips: the camera days with the most missing; a repair: up to 10 failures), items (up to 500: stills file problems; clips missing-locally first, then gone-from-camera, row-without-file, file-without-row, event-without-clip, clip-without-event; a repair: one per recording tried), itemsTruncated, message }' }
```

in `/control/actions/{name}` the summary, the inventory part of the description, and the 202, 400, 404, 409 and 503 lines:

```yaml
      summary: onvif-resubscribe, camera-test, retention-run ({dryRun}), camera-ftp-setup, camera-ftp-test, camera-ftp-off, restart (the camera side), camera-reboot, camera-powercycle, camera-poe-on, poe-switch-read, restart-proxy (the process), inventory ({kind, camera?}), inventory-repair ({kind, runId}), inventory-cancel
        inventory starts an inventory ({"kind":"stills"}, {"kind":"clips"}, or {"kind":"clips","camera":true} to
        compare with the camera's SD card) in the background; poll GET /control/inventory/runs/{id}.
        inventory-repair ({"kind":"clips","runId":<a clips run with the camera, less than an hour old>}) fetches the
        recordings missing locally over Baichuan (at most 50 or 200 MB per run). One run of either at a time.
        They write an inventory or inventory-repair audit record when they end, no control-action.
```

```yaml
        '202': { description: 'started (onvif-resubscribe, restart, restart-proxy); camera-reboot: { confirmed } (false: the camera dropped the connection after receiving the request); camera-powercycle: { offAt, onAt, watts } once PoE is back on; inventory, inventory-repair: { runId }' }
        '400': { description: 'inventory: invalid (an unknown or missing kind, camera not a boolean, or camera for a kind without a camera compare); inventory-repair: invalid (a kind without a repair, or runId not a run id)' }
        '404': { description: 'unknown action; inventory-repair: not_found (no such check run of the kind)' }
        '409': { description: 'not_configured (camera-ftp-setup/-test: ftp.publicHost or the FTP password is not set; camera-powercycle, poe-switch-read: no switch or no CAMPROXY_POE_SWITCH_PASSWORD); camera-powercycle, poe-switch-read: switch_busy (someone is logged in to the switch''s web UI), no_power (the port has PoE off or draws 0 W; nothing switched); inventory, inventory-repair: inventory_busy { runId } (one runs already); inventory-repair: report_stale (the check run is an hour old or more), not_repairable (it did not finish, did not compare with the camera, or found nothing missing locally)' }
        '503': { description: 'stopping (inventory, inventory-repair: the proxy is stopping and starts no run)' }
```

`README.md`, the control API table: replace the `POST /control/actions/inventory` row and add the repair row after it; replace the `GET /control/inventory` row:

```md
| `POST /control/actions/inventory` | `{"kind":"stills"}`, `{"kind":"clips"}` or `{"kind":"clips","camera":true}` (compare with the camera's SD card on `ftp.stream`): starts an inventory in the background ([the spec](docs/superpowers/specs/2026-10-02-inventory-design.md)); 202 `{runId}`; 400 `invalid` for an unknown kind or a `camera` it can't use; 409 `inventory_busy` `{runId}` while an inventory or repair runs (one at a time); 503 `stopping` once the proxy is stopping. Poll `GET /control/inventory/runs/{id}`. Audited as `inventory` when it ends |
| `POST /control/actions/inventory-repair` | `{"kind":"clips","runId":"clips-…"}`: fetches the recordings that clips run (with the camera, finished, less than an hour old) found missing locally, over Baichuan at low priority (a viewer's download goes first), on `ftp.stream`; at most 50 clips or 200 MB per run, 1 s apart, never past `ftp.maxGB` or while storage is paused; it stops after 3 failures in a row, and at once when the camera refuses a download or is offline. The clips are stored like FTP ones with `origin: "camera"`, without an SSE message. 202 `{runId}` (`clipsrepair-…`); 400 `invalid`; 404 `not_found` (no such run); 409 `report_stale`, `not_repairable` or `inventory_busy`; 503 `stopping`. Audited as `inventory-repair` when it ends |
| `GET /control/inventory` | `{running: {runId, kind, op: "check" or "repair", startedAt, outcome: "running", progress: {phase, done, total, note}} or null, runs: {stills: [the last 10 runs, newest first: {runId, kind, startedAt, tookMs, outcome, counts, message}], clips: […]}, repairs: {clips: […]}}` |
```

and in "## Audit log" the list item becomes `- inventory runs and repairs, with their counts;`.

`docs/audit-log.md`: in the `control-action` row, "`inventory` (its own record when the run ends)" becomes "`inventory` and `inventory-repair` (their own records when the run ends)"; replace the `inventory` row and add the `inventory-repair` row after it:

```md
| `inventory` | host / info | the end of each inventory run (`POST /control/actions/inventory`): finished, cancelled or failed | user `admin`; `runId`, `kind` (`stills`, `clips`), `options` (`{camera: true}`: the clips were compared with the camera), `outcome` (`ok`, `cancelled`, `failed`), `requestedBy`, `cancelledBy` (`request`, or `stop` when the proxy stopped mid-run), `window` (`from`, `to`, `reason`: `retention`, `budget`, `store-younger` or `empty`; `retentionFrom`, `protectedFrom`; `notes`, caveats on the counts), `counts` (stills: `stillsDays`, `minutes`, `packs`, `expectedSeconds`, `presentSeconds`, `missingSeconds`, `missingPct`, `gaps`, `explainedSeconds`, `unexplainedSeconds`, `restorableSeconds`, `unreadablePacks`, `packsWithoutSprite`, `spritesWithoutPack`, `previewsPruned`, `prunedDuringRun`: packs deleted by retention while the run read them, counted as missing), `top` (the 10 longest gaps: `from`, `to`, `seconds`, `explained`: `stop`, `crash`, `reboot`, `powercycle` or null, `explainedSeconds`), `tookMs`. Clips `counts`: `clipsDays`, `clips`, `fromCamera`, `rowsWithoutFile`, `filesWithoutRow`, `events` (recording kinds, ended 5 min ago or earlier), `eventsWithoutClip`, `clipsWithoutEvent`; with the camera also `cameraDays`, `unknownDays` (a failed Search: never counted as missing), `recordings`, `timerOnly` (ignored), `paired`, `missingLocally`, `missingLocallyBytes`, `goneFromCamera`, `olderThanSd` (local clips before the SD card's oldest day), `otherStream`; clips `top`: the camera days with the most missing (`date`, `state`, `recordings`, `missingLocally`, `goneFromCamera`); the window has `camera: {stream, to, oldestSdDay, unknownDays}`. Outcome `success`, `unknown` (cancelled) or `failure` (`error.message`). A refused start (400, 409 `inventory_busy`, 503 `stopping`) writes nothing |
| `inventory-repair` | host / change | the end of each repair (`POST /control/actions/inventory-repair`): finished, cancelled or failed | user `admin`; `runId` (`clipsrepair-…`), `kind` (`clips`), `source` (the clips run it repaired from), `outcome`, `requestedBy`, `cancelledBy`, `stopped` (why it ended early: `clip-cap`, `byte-cap`, `max-gb`, `paused`, `failures`, `refused`, `camera_offline`; null when it got through its list), `counts` (`candidates`, `requested`, `done`, `failed`, `skipped`, `bytes`), `failures` (up to 10: `id`, `start`, `error`), `tookMs`. Outcome as for `inventory`. A refused start (400, 404, 409, 503) writes nothing |
```

`CHANGELOG.md`, first item under `## Unreleased`:

```md
- Clips inventory (#74, spec 2026-10-02-inventory-design): "Check clips" (`POST /control/actions/inventory` `{"kind":"clips"}`) checks the clips of the retention window: rows whose file is gone, clip files and pictures without a row, recording events (motion, person, vehicle, pet) without a clip, clips without an event. "Compare clips with the camera" (`"camera": true`) also lists the SD card's recordings of the window on `ftp.stream` (one Search per day with recordings) and pairs them with the local clips by start (±5 s): recordings missing locally, local clips gone from the camera, the SD card's oldest day; timer-only recordings are counted, not paired, and a day whose Search fails is `unknown`, never "missing". The repair (`POST /control/actions/inventory-repair`, the box's "Fetch N lost clips") fetches the missing ones over Baichuan at low priority (at most 50 clips or 200 MB per run, 1 s apart; never past `ftp.maxGB` or while storage is paused; it stops after 3 failures in a row or when the camera refuses or is offline) and stores them as clips marked "from camera" (`origin: "camera"`, catalog schema 6). Repaired clips send no SSE message and don't count as FTP arrivals (the "no clip for N hours" warning and the daily clips count). Each repair writes an `inventory-repair` audit record. `GET /control/inventory` lists repairs apart (`repairs`) and caches the run summaries (#106); the running view has `op`.
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/inventory-clips-api.test.ts test/inventory-api.test.ts test/openapi.test.ts test/control-api.test.ts && npx tsc --noEmit -p tsconfig.check.json`
Expected: PASS (the clips API file runs in about 6 s).

- [ ] **Step 5: Commit**

```bash
git add src/proxy.ts src/api/control-api.ts openapi.yaml README.md docs/audit-log.md CHANGELOG.md test/inventory-api.test.ts test/inventory-clips-api.test.ts
git commit -m "feat(inventory): the clips kind, its camera compare and repair in the control API (#74)"
```

---

### Task 8: The Inventory box: clips, the compare, the repair offer

**Files:**
- Modify: `web/src/lib/inventory.ts`, `web/src/components/InventoryCard.svelte` (whole file below), `web/src/lib/audit.ts`, `README.md`, `e2e/inventory.spec.ts`
- Test: `test/inventory-ui.test.ts`, `test/audit-ui.test.ts`

**Interfaces:**
- Consumes: Task 7's API (`GET /control/inventory` with `repairs`, `op` in `running`; `POST /control/actions/inventory` `{kind, camera?}`; `POST /control/actions/inventory-repair` `{kind, runId}`), Task 4's report shape (`counts`, `window.camera`, `top` rows, `missing-locally` items with `size`), Task 6's (`stopped`, `top` failures).
- Produces (`web/src/lib/inventory.ts`): `RunningView.op?`, `InventoryState.repairs?`; `REPAIR_MAX_CLIPS = 50`, `REPAIR_MAX_AGE_MS = 3_600_000`, `CameraDayRow`, `ClipsReport`, `RepairReport`, `mb(bytes)`, `clipsLines(r, fmt?)`, `repairOffer(r: ClipsReport | null, now: number): { count: number; bytes: number } | null`, `repairRows(r, fmt?)`; `progressText()` knows the `camera` phase and the repair op. Test ids: `inventory-clips`, `inventory-clips-camera`, `inventory-clips-result`, `inventory-clips-days`, `inventory-repair`, `inventory-repair-result` (PR 1's `inventory-stills`, `inventory-result`, `inventory-progress`, `inventory-cancel` stay).

- [ ] **Step 1: Write the failing tests**

`test/inventory-ui.test.ts`: the import becomes

```ts
import { clipsLines, duration, gapRows, mb, progressText, repairOffer, repairRows, stillsLines, stillsNotes, type ClipsReport, type RepairReport, type StillsReport } from '../web/src/lib/inventory';
```

and append:

```ts
// #74: the clips report, the repair offer, the repair's failures.
const clipsReport: ClipsReport = {
  runId: 'clips-1-abcdef', kind: 'clips', startedAt: T, tookMs: 2100, outcome: 'ok', message: 'Clips inventory: …',
  options: { camera: true },
  window: { from: T, to: T + 600_000, reason: 'retention', notes: [], camera: { stream: 'sub', to: T + 300_000, oldestSdDay: '2026-09-25', unknownDays: ['2026-09-26'] } },
  counts: { clipsDays: 7, clips: 40, fromCamera: 2, rowsWithoutFile: 1, filesWithoutRow: 0, events: 50, eventsWithoutClip: 3, clipsWithoutEvent: 4, recordings: 45, paired: 40, missingLocally: 60, missingLocallyBytes: 3 * 2 ** 20, timerOnly: 2, goneFromCamera: 1, olderThanSd: 5 },
  top: [],
  items: [...Array.from({ length: 60 }, () => ({ type: 'missing-locally', size: 2 ** 20 })), { type: 'gone-from-camera' }],
  itemsTruncated: false,
};

describe('Inventory box helpers, clips', () => {
  it('describes the progress of a compare and of a repair', () => {
    expect(progressText({ runId: 'x', kind: 'clips', op: 'check', startedAt: 0, outcome: 'running', progress: { phase: 'camera', done: 2, total: 8, note: '2026-09-27' } })).toBe('Comparing clips with the camera… day 2 of 8 (2026-09-27)');
    expect(progressText({ runId: 'x', kind: 'clips', op: 'repair', startedAt: 0, outcome: 'running', progress: { phase: 'repair', done: 3, total: 18, note: 'RecS…' } })).toBe('Repairing clips… 3 of 18');
    expect(progressText({ runId: 'x', kind: 'clips', op: 'repair', startedAt: 0, outcome: 'running', progress: { phase: 'starting', done: 0, total: 0 } })).toBe('Repairing clips…');
  });

  it('sums up a clips report, with the camera part only after a compare', () => {
    expect(mb(3 * 2 ** 20)).toBe('3.0 MB');
    expect(clipsLines(clipsReport, fmt)).toEqual([
      'Window: 00:10:00 to 00:20:00 (the clips retention, 7 days)',
      'Clips: 40 (2 from the camera); 1 without their file, 0 files without a clip',
      'Events: 3 of 50 recording events without a clip; 4 clips without an event',
      'Camera (sub): 45 recordings, 40 here, 60 missing here (3.0 MB), 2 timer-only (ignored)',
      "Gone from the camera: 1 local clips; 5 older than the SD card's oldest day (2026-09-25)",
      'Not listed (the Search failed, nothing counted as missing): 2026-09-26',
    ]);
    const local = { ...clipsReport, options: undefined, window: { from: T, to: T + 600_000, reason: 'retention' } };
    expect(clipsLines(local, fmt)).toHaveLength(3);
    expect(clipsLines({ ...clipsReport, outcome: 'failed', error: 'camera_offline: the camera does not answer' }, fmt)).toEqual(['Failed: camera_offline: the camera does not answer']);
  });

  it('offers a repair only under a recent, finished compare with something missing; at most 50 clips', () => {
    expect(repairOffer(clipsReport, T + 60_000)).toEqual({ count: 50, bytes: 50 * 2 ** 20 });
    expect(repairOffer(clipsReport, T + 3_600_000)).toBeNull(); // an hour old
    expect(repairOffer({ ...clipsReport, options: undefined }, T)).toBeNull();
    expect(repairOffer({ ...clipsReport, outcome: 'cancelled' }, T)).toBeNull();
    expect(repairOffer({ ...clipsReport, counts: { ...clipsReport.counts, missingLocally: 0 } }, T)).toBeNull();
    expect(repairOffer(null, T)).toBeNull();
  });

  it('lists the failures of a repair', () => {
    const rep: RepairReport = { runId: 'clipsrepair-1-abcdef', kind: 'clips', startedAt: T, tookMs: 5000, outcome: 'ok', counts: {}, message: 'Clips repair: …', stopped: 'refused', top: [{ id: 'RecS0A_x.mp4', start: T + 60_000, error: 'the camera refused the download' }] };
    expect(repairRows(rep, fmt)).toEqual([{ at: '00:11:00', error: 'the camera refused the download' }]);
  });
});
```

`test/audit-ui.test.ts`, after `expect(ACTIONS).toContain('camera-powercycle');`:

```ts
    expect(ACTIONS).toContain('inventory-repair');
```

`e2e/inventory.spec.ts`, append:

```ts
// The clips compare (#74): cam-sim's demo recordings of yesterday were never
// uploaded, so they are missing here and the box offers to fetch them. The
// fetch itself is not clicked here (the API test covers it), so the Status
// page's Recordings card still shows no download.
test('Compare clips with the camera: the result and the repair offer show', async ({ page }) => {
  await page.goto('/#/maintenance');
  await expect(page.getByTestId('inventory-clips-camera')).toBeEnabled();
  const [resp] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/control/actions/inventory') && r.request().method() === 'POST'),
    page.getByTestId('inventory-clips-camera').click(),
  ]);
  expect(resp.status()).toBe(202);
  await expect(page.getByTestId('inventory-clips-result')).toContainText('Clips inventory', { timeout: 30_000 });
  await expect(page.getByTestId('inventory-clips-result')).toContainText('Camera (sub):');
  await expect(page.getByTestId('inventory-repair')).toHaveText(/^Fetch \d+ lost clips \(\d+\.\d MB\)$/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/inventory-ui.test.ts test/audit-ui.test.ts`
Expected: FAIL (`clipsLines` is not exported; `ACTIONS` lacks `inventory-repair`).

- [ ] **Step 3: Write the implementation**

`web/src/lib/inventory.ts`: `RunningView` and `InventoryState` become

```ts
export interface RunningView { runId: string; kind: string; op?: 'check' | 'repair'; startedAt: number; outcome: 'running'; progress: Progress }
export interface RunSummary { runId: string; kind: string; startedAt: number; tookMs: number; outcome: 'ok' | 'cancelled' | 'failed'; counts: Record<string, number>; message: string }
export interface InventoryState { running: RunningView | null; runs: Record<string, RunSummary[]>; repairs?: Record<string, RunSummary[]> }
```

`progressText` becomes

```ts
export function progressText(r: RunningView): string {
  const p = r.progress;
  if (r.op === 'repair') return p.total ? `Repairing ${r.kind}… ${p.done} of ${p.total}` : `Repairing ${r.kind}…`;
  const what = p.phase === 'camera' ? `Comparing ${r.kind} with the camera` : `Checking ${r.kind}`;
  return p.total ? `${what}… day ${p.done} of ${p.total}${p.note ? ` (${p.note})` : ''}` : `${what}…`;
}
```

and append:

```ts
// The clips inventory (#74) and its repair.
export const REPAIR_MAX_CLIPS = 50; // the server's cap per run (src/inventory/repair-clips.ts)
export const REPAIR_MAX_AGE_MS = 3_600_000; // a repair needs a compare less than an hour old
export interface CameraDayRow { date: string; state: 'listed' | 'unknown'; recordings: number; missingLocally: number; goneFromCamera: number }
export interface ClipsReport extends RunSummary {
  window: { from: number | null; to: number; reason: string; notes?: string[]; camera?: { stream: string; to: number; oldestSdDay: string | null; unknownDays: string[] } } | null;
  options?: { camera?: boolean };
  top: CameraDayRow[];
  items: { type: string; size?: number }[];
  itemsTruncated: boolean;
  error?: string;
}
export interface RepairReport extends RunSummary {
  source?: string;
  stopped?: string | null;
  top: { id: string; start: number; error: string }[];
  error?: string;
}

export const mb = (bytes: number) => `${(bytes / 2 ** 20).toFixed(1)} MB`;

export function clipsLines(r: ClipsReport, fmt: (ms: number) => string = local): string[] {
  if (r.outcome === 'failed') return [`Failed: ${r.error ?? 'unknown error'}`];
  if (!r.window || r.window.from === null) return [];
  const c = r.counts;
  const cam = r.window.camera;
  return [
    ...(r.outcome === 'cancelled' ? ['Cancelled: the counts are partial'] : []),
    `Window: ${fmt(r.window.from)} to ${fmt(r.window.to)} (the clips retention, ${c.clipsDays} days)`,
    `Clips: ${c.clips}${c.fromCamera ? ` (${c.fromCamera} from the camera)` : ''}; ${c.rowsWithoutFile} without their file, ${c.filesWithoutRow} files without a clip`,
    `Events: ${c.eventsWithoutClip} of ${c.events} recording events without a clip; ${c.clipsWithoutEvent} clips without an event`,
    ...(cam
      ? [
          `Camera (${cam.stream}): ${c.recordings} recordings, ${c.paired} here, ${c.missingLocally} missing here (${mb(c.missingLocallyBytes)}), ${c.timerOnly} timer-only (ignored)`,
          `Gone from the camera: ${c.goneFromCamera} local clips; ${c.olderThanSd} older than the SD card's oldest day (${cam.oldestSdDay ?? 'none'})`,
          ...(cam.unknownDays.length ? [`Not listed (the Search failed, nothing counted as missing): ${cam.unknownDays.join(', ')}`] : []),
        ]
      : []),
  ];
}

// The repair the newest clips report allows: a finished compare with the
// camera, less than an hour old, with recordings missing here. `count` and
// `bytes` are what one run fetches at most (the first 50 candidates).
export function repairOffer(r: ClipsReport | null, now: number): { count: number; bytes: number } | null {
  if (!r || r.outcome !== 'ok' || !r.options?.camera || now - r.startedAt >= REPAIR_MAX_AGE_MS || !r.counts.missingLocally) return null;
  const first = r.items.filter((x) => x.type === 'missing-locally').slice(0, REPAIR_MAX_CLIPS);
  return { count: Math.min(r.counts.missingLocally, REPAIR_MAX_CLIPS), bytes: first.reduce((n, x) => n + (x.size ?? 0), 0) };
}

export function repairRows(r: RepairReport, fmt: (ms: number) => string = local): { at: string; error: string }[] {
  return r.top.map((f) => ({ at: fmt(f.start), error: f.error }));
}
```

`web/src/lib/audit.ts`: add `'inventory-repair'` to `ACTIONS` right after `'inventory'`.

Replace `web/src/components/InventoryCard.svelte` with:

```svelte
<script lang="ts">
  import { onMount } from 'svelte';
  import { api, ApiError } from '../lib/api';
  import { clipsLines, gapRows, mb, progressText, repairOffer, repairRows, stillsLines, stillsNotes, type ClipsReport, type InventoryState, type RepairReport, type StillsReport } from '../lib/inventory';

  // The inventories (spec 2026-10-02-inventory-design): start one, follow its
  // progress (polled every second while it runs), cancel it, and show the
  // newest report of each kind and the newest clips repair. One run at a
  // time per proxy. The repair is offered under a compare with the camera
  // (its dry run) less than an hour old.
  let inv = $state<InventoryState | null>(null);
  let stills = $state<StillsReport | null>(null);
  let clips = $state<ClipsReport | null>(null);
  let repair = $state<RepairReport | null>(null);
  let message = $state('');
  let starting = $state(false);
  let cancelling = $state(false);
  let now = $state(Date.now());
  const busy = $derived(!!inv?.running);
  const offer = $derived(repairOffer(clips, now));

  const fetchReport = <T,>(runId: string) => api<T>('GET', `/control/inventory/runs/${encodeURIComponent(runId)}`);
  async function load() {
    const s = await api<InventoryState>('GET', '/control/inventory');
    inv = s;
    now = Date.now();
    const st = s.runs.stills?.[0];
    if (st && st.runId !== stills?.runId) stills = await fetchReport<StillsReport>(st.runId);
    const cl = s.runs.clips?.[0];
    if (cl && cl.runId !== clips?.runId) clips = await fetchReport<ClipsReport>(cl.runId);
    const rp = s.repairs?.clips?.[0];
    if (rp && rp.runId !== repair?.runId) repair = await fetchReport<RepairReport>(rp.runId);
  }
  const reload = () => load().catch(() => (message = 'Could not load the inventory.'));
  onMount(() => void reload());
  $effect(() => {
    if (!busy) return;
    const t = setInterval(() => void reload(), 1000);
    return () => clearInterval(t);
  });

  async function post(path: string, body: object, label: string) {
    if (starting || busy) return;
    starting = true;
    message = '';
    try {
      await api('POST', path, body);
    } catch (e) {
      message = `${label}: ${e instanceof ApiError ? e.message : 'failed'}`;
    }
    starting = false;
    cancelling = false;
    await reload();
  }
  const start = (kind: string, camera = false) => post('/control/actions/inventory', camera ? { kind, camera } : { kind }, 'Inventory');
  const fetchLost = () => clips && post('/control/actions/inventory-repair', { kind: 'clips', runId: clips.runId }, 'Repair');
  async function cancel() {
    cancelling = true;
    try {
      await api('POST', '/control/actions/inventory-cancel');
    } catch (e) {
      message = `Cancel: ${e instanceof ApiError ? e.message : 'failed'}`;
    }
    await reload();
    if (!inv?.running) cancelling = false;
  }
</script>

<div class="card" data-testid="inventory">
  <h3>Inventory</h3>
  <p class="small">Checks the local stills and clips against what the store should hold for the retention window. "Compare clips with the camera" also reads the camera's SD card list, and a repair fetches lost clips from it. One run at a time.</p>
  <div class="buttons">
    <button onclick={() => void start('stills')} disabled={starting || busy} data-testid="inventory-stills">Check stills</button>
    <button onclick={() => void start('clips')} disabled={starting || busy} data-testid="inventory-clips">Check clips</button>
    <button onclick={() => void start('clips', true)} disabled={starting || busy} data-testid="inventory-clips-camera">Compare clips with the camera</button>
    {#if busy}<button onclick={() => void cancel()} disabled={cancelling} data-testid="inventory-cancel">{cancelling ? 'Cancelling…' : 'Cancel'}</button>{/if}
  </div>
  {#if inv?.running}<p class="busy" role="status" data-testid="inventory-progress">{progressText(inv.running)}</p>{/if}
  {#if message}<p class="bad" role="alert" data-testid="inventory-message">{message}</p>{/if}
  {#if stills}
    <div class="result" data-testid="inventory-result">
      <p class="line">{stills.message}</p>
      <p class="small">{new Date(stills.startedAt).toLocaleString()}, took {(stills.tookMs / 1000).toFixed(1)} s</p>
      <ul>
        {#each stillsLines(stills) as l, i (i)}<li>{l}</li>{/each}
      </ul>
      {#each stillsNotes(stills) as n, i (i)}<p class="small" data-testid="inventory-note">{n}</p>{/each}
      {#if stills.top.length}
        <table data-testid="inventory-gaps">
          <thead><tr><th>from</th><th>to</th><th>length</th><th>cause</th></tr></thead>
          <tbody>
            {#each gapRows(stills) as g, i (i)}<tr><td class="mono">{g.from}</td><td class="mono">{g.to}</td><td>{g.length}</td><td>{g.why}</td></tr>{/each}
          </tbody>
        </table>
      {/if}
    </div>
  {/if}
  {#if clips}
    <div class="result" data-testid="inventory-clips-result">
      <p class="line">{clips.message}</p>
      <p class="small">{new Date(clips.startedAt).toLocaleString()}, took {(clips.tookMs / 1000).toFixed(1)} s</p>
      <ul>
        {#each clipsLines(clips) as l, i (i)}<li>{l}</li>{/each}
      </ul>
      {#each clips.window?.notes ?? [] as n, i (i)}<p class="small">{n}</p>{/each}
      {#if clips.top.length}
        <table data-testid="inventory-clips-days">
          <thead><tr><th>camera day</th><th>recordings</th><th>missing here</th><th>gone from camera</th></tr></thead>
          <tbody>
            {#each clips.top as d (d.date)}<tr><td class="mono">{d.date}</td><td>{d.state === 'unknown' ? 'unknown' : d.recordings}</td><td>{d.missingLocally}</td><td>{d.goneFromCamera}</td></tr>{/each}
          </tbody>
        </table>
      {/if}
      {#if offer}
        <div class="buttons">
          <button onclick={() => void fetchLost()} disabled={starting || busy} data-testid="inventory-repair">Fetch {offer.count} lost clips ({mb(offer.bytes)})</button>
        </div>
        <p class="small">Fetches them from the camera's SD card over Baichuan, one at a time, after any viewer's download; at most 50 clips or 200 MB per run.</p>
      {/if}
    </div>
  {/if}
  {#if repair}
    <div class="result" data-testid="inventory-repair-result">
      <p class="line">{repair.message}</p>
      <p class="small">{new Date(repair.startedAt).toLocaleString()}, took {(repair.tookMs / 1000).toFixed(1)} s</p>
      {#if repair.top.length}
        <table>
          <thead><tr><th>recording</th><th>failure</th></tr></thead>
          <tbody>
            {#each repairRows(repair) as f, i (i)}<tr><td class="mono">{f.at}</td><td>{f.error}</td></tr>{/each}
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

`README.md`, "Maintenance" in the admin UI section: after "…It shows the progress (with Cancel) and the newest result." add

```md
  "Check clips" checks the clips of the retention window (rows without
  their file, files without a row, recording events without a clip, clips
  without an event); "Compare clips with the camera" also pairs them with the
  SD card's recordings on `ftp.stream`. Under a compare less than an hour
  old with recordings missing here, "Fetch N lost clips" fetches them from
  the SD card (at most 50 or 200 MB per run); the Clips page marks them
  "from camera".
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/inventory-ui.test.ts test/audit-ui.test.ts && npm run check && npm run build && npm run test:e2e -- e2e/inventory.spec.ts`
Expected: PASS (the e2e run: the stills test and "Compare clips with the camera: the result and the repair offer show"). The e2e test does not click the repair: a download would change the Status page's Recordings card, which `recordings-status.spec.ts` (later in the run) expects grey.

- [ ] **Step 5: Run everything**

Run: `npm run lint:types && npm run check && npm test && npm run test:e2e`
Expected: PASS (all vitest files; 32 e2e tests).

- [ ] **Step 6: Commit**

```bash
git add web/src/lib/inventory.ts web/src/components/InventoryCard.svelte web/src/lib/audit.ts README.md e2e/inventory.spec.ts test/inventory-ui.test.ts test/audit-ui.test.ts
git commit -m "feat(ui): check and compare clips, fetch lost clips, in the Inventory box (#74)"
```

- [ ] **Step 7: Measure on the real camera (after the merge, on the Pi)**

The spec asks for the Search time on the real camera: run "Compare clips with the camera" once on the Pi and note the report's `tookMs` and `counts.cameraDays` in the PR (or in #74). Don't run the repair there before Klaus has looked at the compare's result.

