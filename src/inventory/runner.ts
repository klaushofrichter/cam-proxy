import { randomBytes } from 'crypto';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'fs/promises';
import { join, resolve, sep } from 'path';
import type { AuditLog } from '../audit/audit-log';
import { logger } from '../log';

// The inventories (spec 2026-10-02-inventory-design): one run at a time per
// proxy, cancellable, with progress. Each finished run (also a cancelled or
// failed one) is a JSON file <dir>/<kind>/<runId>.json, the last 10 per kind,
// and one `inventory` audit record. The runner knows no kind: a kind is an
// entry in its check table (its label and its check).

export const KEEP_RUNS = 10;
export const MAX_TOP = 10;
export const MAX_ITEMS = 500;
export const RUN_ID = /^([a-z]{1,16})-(\d{1,15})-([0-9a-f]{6})$/;

export interface Progress { phase: string; done: number; total: number; note?: string }
export interface InventoryWindow { from: number | null; to: number; reason: string; [k: string]: unknown }
export interface CheckResult { window: InventoryWindow; counts: Record<string, number>; top: unknown[]; items: unknown[]; message: string }
export interface CheckContext { signal: AbortSignal; progress: (p: Progress) => void; now: number }
// A check returns its partial result when the signal aborts (it checks between pages).
export type Check = (ctx: CheckContext) => Promise<CheckResult>;
// A kind in the check table: `label` names it in messages ("Stills inventory: …").
export interface InventoryKind { label: string; run: Check }
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

export class InventoryStoppingError extends Error {
  constructor() {
    super('the proxy is stopping: no inventory is started');
  }
}

interface Current { view: RunningView; ac: AbortController; cancelledBy?: 'request' | 'stop'; settled: boolean; done: Promise<InventoryReport> }

export class InventoryRunner {
  readonly checks: Partial<Record<string, InventoryKind>>;
  private cur: Current | null = null;
  private stopping = false;
  private readonly now: () => number;

  constructor(private readonly d: { dir: string; audit: Pick<AuditLog, 'write'>; camera: () => string; checks: Partial<Record<string, InventoryKind>>; now?: () => number; keep?: number }) {
    this.checks = { ...d.checks };
    this.now = d.now ?? Date.now;
  }

  kinds(): string[] {
    return Object.keys(this.checks).filter((k) => this.checks[k]);
  }

  running(): RunningView | null {
    return this.cur ? { ...this.cur.view, progress: { ...this.cur.view.progress } } : null;
  }

  // Starts a run in the background; throws InventoryBusyError while one runs,
  // InventoryStoppingError once stop() was called.
  start(kind: string, who: Requester): { runId: string; done: Promise<InventoryReport> } {
    if (this.stopping) throw new InventoryStoppingError();
    if (this.cur) throw new InventoryBusyError(this.cur.view.runId);
    const check = Object.hasOwn(this.checks, kind) ? this.checks[kind] : undefined;
    if (!check) throw new Error(`no inventory of kind ${kind}`);
    const startedAt = this.now();
    const runId = `${kind}-${startedAt}-${randomBytes(3).toString('hex')}`;
    const cur: Current = {
      view: { runId, kind, startedAt, outcome: 'running', progress: { phase: 'starting', done: 0, total: 0 } },
      ac: new AbortController(),
      settled: false,
      done: Promise.resolve(undefined as never),
    };
    this.cur = cur;
    cur.done = this.run(cur, check, who);
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

  private async run(cur: Current, check: InventoryKind, who: Requester): Promise<InventoryReport> {
    const { runId, kind, startedAt } = cur.view;
    try {
      let res: CheckResult | null = null;
      let error: string | undefined;
      let failed = false;
      try {
        res = await check.run({ signal: cur.ac.signal, now: startedAt, progress: (p) => void (cur.view.progress = p) });
      } catch (err) {
        failed = true;
        error = err instanceof Error ? err.message : String(err);
      }
      cur.settled = true;
      const outcome: RunOutcome = cur.ac.signal.aborted ? 'cancelled' : failed ? 'failed' : 'ok';
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
        message: message(check.label, outcome, res, error),
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
        ...(report.error !== undefined ? { error: report.error } : {}),
        details: { runId, kind, outcome, requestedBy: who.requestedBy, ...(report.cancelledBy ? { cancelledBy: report.cancelledBy } : {}), window: report.window, counts: report.counts, top: report.top, tookMs: report.tookMs },
      });
      logger.info({ runId, kind, outcome, tookMs: report.tookMs }, 'inventory_done');
      return report;
    } finally {
      this.cur = null;
    }
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
      // Resolved and kept inside the inventory folder (the id is checked
      // against RUN_ID already; this is also what CodeQL looks for).
      const root = resolve(this.d.dir);
      const path = resolve(root, kind, `${id}.json`);
      if (!path.startsWith(root + sep)) return undefined;
      return JSON.parse(await readFile(path, 'utf8')) as InventoryReport;
    } catch {
      return undefined;
    }
  }
}

function message(kindLabel: string, outcome: RunOutcome, res: CheckResult | null, error: string | undefined): string {
  const label = `${kindLabel} inventory`;
  if (outcome === 'failed') return `${label} failed: ${error}`;
  if (outcome === 'cancelled') return `${label} cancelled${res ? ` (partial): ${res.message}` : ''}`;
  return `${label}: ${res!.message}`;
}
