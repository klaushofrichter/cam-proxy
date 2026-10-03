import { randomBytes } from 'crypto';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'fs/promises';
import { join, resolve, sep } from 'path';
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
  // Bumped by each save: a list() that read the disk before a save doesn't cache.
  private readonly generation = new Map<string, number>();

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
    const opts: StartOptions = options.camera === true && check.camera ? { camera: true } : {};
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
    if (hit) return hit.map((r) => ({ ...r }));
    const gen = this.generation.get(folder) ?? 0;
    const out: RunSummary[] = [];
    for (const id of await this.ids(folder)) {
      const r = await this.read(folder, id);
      if (r) out.push({ runId: r.runId, kind: r.kind, startedAt: r.startedAt, tookMs: r.tookMs, outcome: r.outcome, counts: r.counts, message: r.message });
    }
    if ((this.generation.get(folder) ?? 0) === gen) this.summaries.set(folder, out);
    return out.map((r) => ({ ...r }));
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
      this.generation.set(folder, (this.generation.get(folder) ?? 0) + 1);
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
      // Resolved and kept inside the inventory folder (the id is checked
      // against RUN_ID already; this is also what CodeQL looks for).
      const root = resolve(this.d.dir);
      const path = resolve(root, folder, `${id}.json`);
      if (!path.startsWith(root + sep)) return undefined;
      return JSON.parse(await readFile(path, 'utf8')) as InventoryReport;
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