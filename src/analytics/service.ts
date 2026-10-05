import { mkdirSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { sleep } from '../async';
import type { Catalog } from '../catalog/db';
import { addUsage, analysisFor, countUnmapped, okAnalysisAt, releaseUsage, saveAnalysis, setSummary, unanalysed, usageBetween, withoutSummary, type AnalysisRow, type UsageKey } from '../catalog/analyses';
import { keyId } from './key-id';
import { checkAt, insertCheck, setCheckImage, type StillCheckRow } from '../catalog/still-checks';
import { eventById } from '../catalog/events';
import type { Config } from '../config/defaults';
import type { TimeInfo } from '../camera/time';
import { logger } from '../log';
import type { AuditInput } from '../audit/audit-log';
import type { StreamLog } from '../stream/log';
import { checkJson } from './check-json';
import { summarize, summaryCategories, summaryText } from './classes';
import { googleVision } from './google-vision';
import { localDay } from './local-day';
import { AnalyticsError, maskKey, PROVIDERS, type AnalyticsProvider, type Found, type ProviderId } from './providers';

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
  // The audit log: one `event-analysis` record per automatic analysis that made a call.
  audit?: { write: (i: AuditInput) => unknown };
}

export interface ProviderState {
  id: string;
  name: string;
  enabled: boolean;
  keyMasked: string | null;
  keySource: KeySource;
  month: { calls: number; limit: number };
  today: { calls: number; cap: number };
  paused: { reason: string; until: number | null } | null;
  lastCall: { at: number; tookMs: number; status: string } | null;
  lastError: string | null;
  checks: { today: number; cap: number };
}

// The client's view of the budget (GET /api/cameras/{cam}/analytics): no key, no mask.
export interface AnalyticsUsage {
  enabled: boolean;
  paused: { reason: string; until: number | null } | null;
  month: { calls: number; limit: number };
  today: { calls: number; cap: number };
  checks: { today: number; cap: number };
}

// What a still check request came to (spec 2026-10-04-still-checks-design §2).
// `cost` is 1 when this request made a call (counted in the budget).
export type CheckVia = 'token' | 'session';
export type CheckOutcome =
  | { outcome: 'ok'; row: StillCheckRow; tookMs: number }
  | { outcome: 'reused'; source: 'check'; row: StillCheckRow; joined?: true }
  | { outcome: 'reused'; source: 'event'; analysis: AnalysisRow }
  | { outcome: 'refused'; status: 404 | 409 | 429 | 503; error: string; reason?: string; until?: number | null }
  | { outcome: 'failed'; reason: string; tookMs: number | null; cost: 0 | 1 };

// Usage rows next to the provider's (ruling 27): checks made, and the
// outcomes of the requests that made none, per camera day.
export const CHECK_USAGE = { calls: 'google-vision:check', reused: 'google-vision:check-reused', refused: 'google-vision:check-refused', failed: 'google-vision:check-failed' } as const;

type Job = { id: number; kind: string; start_ts: number };
// Where the key in use comes from: the environment (or its _FILE), set at runtime, or none.
export type KeySource = 'env' | 'manual' | 'none';

// Sends event stills to the enabled provider, one at a time, within the
// limits, and stores what comes back (spec 2026-09-30-analytics-design).
export class AnalyticsService {
  private readonly queue: Job[] = [];
  private running: Promise<void> | null = null;
  private draining = false;
  private stopped = false;
  private readonly sleepers = new Set<() => void>(); // stop() wakes them
  private paused: { reason: string; until: number | null } | null = null;
  private lastCall: ProviderState['lastCall'] = null;
  private lastError: string | null = null;
  // A key set at runtime (issue #70): in memory only, gone with the process.
  private manualKey: string | undefined;
  // The still check in flight (one at a time) and how to abort it (stop()).
  private checking: { at: number; done: Promise<CheckOutcome>; abort: AbortController } | null = null;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly d: AnalyticsDeps) {
    this.now = d.now ?? Date.now;
    this.sleep = d.sleep ?? sleep;
  }

  private settings() {
    return this.d.config().analytics;
  }
  private key(): string | undefined {
    return this.manualKey ?? (this.d.secrets().googleVisionKey || undefined);
  }
  // The usage counter of a provider (or check outcome) for this camera and
  // the key in use now ('' when no key: nothing is counted against a key then).
  private usageKey(provider: string, key = this.key()): UsageKey {
    return { provider, keyId: key ? keyId(key) : '', cam: this.d.cam };
  }
  private keySource(): KeySource {
    return this.manualKey !== undefined ? 'manual' : this.d.secrets().googleVisionKey ? 'env' : 'none';
  }

  // Replaces the key in use at once (the next call reads it); answers what it
  // replaced. A new key is a reason to try again: it lifts a bad_key pause.
  // The caller checks the key's form.
  setManualKey(key: string): KeySource {
    const replaced = this.keySource();
    this.manualKey = key;
    if (this.paused?.reason === 'bad_key') {
      this.paused = null;
      if (this.lastError === 'bad_key') this.lastError = null;
    }
    return replaced;
  }
  // On, with a key, not stopped: otherwise events aren't queued and no call is made.
  private active(): boolean {
    return !this.stopped && this.settings().googleVision.enabled && !!this.key();
  }
  private wanted(kind: string): boolean {
    const k = this.settings().kinds;
    return (KINDS as readonly string[]).includes(kind) && k[kind as (typeof KINDS)[number]] === true;
  }

  onEvent(e: Job): void {
    if (this.stopped || !this.active() || !this.wanted(e.kind)) return;
    this.queue.push({ id: e.id, kind: e.kind, start_ts: e.start_ts });
    if (!this.draining) {
      this.draining = true;
      this.running = this.drain();
    }
  }

  // After a restart: the last 10 minutes of events that were never analysed.
  catchUp(): void {
    if (!this.active()) return;
    const kinds = KINDS.filter((k) => this.settings().kinds[k]);
    for (const e of unanalysed(this.d.catalog, this.d.cam, kinds, this.now() - CATCH_UP_MS)) this.onEvent(e);
  }

  // A changed analytics setting lifts a bad_key pause (so does a new key: setManualKey).
  settingsChanged(): void {
    if (this.paused?.reason === 'bad_key') this.paused = null;
  }

  async idle(): Promise<void> {
    while (this.draining || this.queue.length) await this.running;
  }

  // No new calls; a wait ends at once. Resolves when the current job is
  // done: a call in flight is stored (so a restart's catch-up doesn't pay
  // for it again); its timeout bounds the wait.
  // A still check in flight is aborted: it is counted, not stored.
  async stop(): Promise<void> {
    this.stopped = true;
    this.queue.length = 0;
    for (const w of [...this.sleepers]) w();
    const check = this.checking;
    check?.abort.abort();
    await Promise.all([this.running, check?.done]);
  }

  private wait(ms: number): Promise<void> {
    if (this.stopped) return Promise.resolve();
    return new Promise<void>((r) => {
      const done = () => {
        this.sleepers.delete(done);
        r();
      };
      this.sleepers.add(done);
      void this.sleep(ms).then(done);
    });
  }

  // The current pause; a quota pause ends after its hour.
  private pause(): { reason: string; until: number | null } | null {
    return this.paused && this.paused.until !== null && this.paused.until <= this.now() ? null : this.paused;
  }

  private monthUsage(day: string): number {
    return usageBetween(this.d.catalog, 'google-vision', `${day.slice(0, 7)}-01`, `${day.slice(0, 7)}-31`);
  }

  state(): ProviderState[] {
    const g = this.settings().googleVision;
    const day = localDay(this.now(), this.d.timeInfo());
    return PROVIDERS.map((p) => ({
      id: p.id,
      name: p.name,
      enabled: g.enabled,
      keyMasked: maskKey(this.key()),
      keySource: this.keySource(),
      month: { calls: this.monthUsage(day), limit: g.monthlyLimit },
      today: { calls: usageBetween(this.d.catalog, p.id, day, day), cap: g.dailyCap },
      paused: this.pause(),
      lastCall: this.lastCall,
      lastError: this.lastError,
      checks: { today: usageBetween(this.d.catalog, CHECK_USAGE.calls, day, day), cap: g.checksPerDay },
    }));
  }

  usage(): AnalyticsUsage {
    const { month, today, paused, checks } = this.state()[0];
    return { enabled: this.active(), paused, month, today, checks };
  }

  private maxOpenMs(): number {
    return this.d.config().events.maxOpenMin * 60_000;
  }

  private count(what: keyof typeof CHECK_USAGE): void {
    try {
      addUsage(this.d.catalog, this.usageKey(CHECK_USAGE[what]), localDay(this.now(), this.d.timeInfo()));
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'analytics_check_count_failed');
    }
  }

  // A still check (cams #179): Vision on the still of `at` (an exact still
  // time; the caller checked its form and range). Answers a stored check or
  // a successful automatic analysis of that second without a call; else the
  // limits in order, one call at a time (the same second joins it), no
  // retry, 10 s.
  async check(at: number, via: CheckVia): Promise<CheckOutcome> {
    const cam = this.d.cam;
    const stored = checkAt(this.d.catalog, cam, at);
    if (stored) return this.count('reused'), { outcome: 'reused', source: 'check', row: stored };
    const analysis = okAnalysisAt(this.d.catalog, cam, at);
    if (analysis) return this.count('reused'), { outcome: 'reused', source: 'event', analysis };
    const running = this.checking;
    if (running?.at === at) {
      const r = await running.done;
      if (r.outcome === 'ok') return this.count('reused'), { outcome: 'reused', source: 'check', row: r.row, joined: true };
      // Each request is counted once, as what it came to (a 404 never is).
      if (r.outcome === 'failed') return this.count('failed'), { ...r, cost: 0 };
      return r;
    }
    const refuse = (status: 409 | 429 | 503, error: string, more: { reason?: string; until?: number | null } = {}): CheckOutcome => {
      this.count('refused');
      return { outcome: 'refused', status, error, ...more };
    };
    const g = this.settings().googleVision;
    if (this.stopped || !g.enabled) return refuse(409, 'analytics_off', { reason: 'off' });
    if (!this.key()) return refuse(409, 'analytics_off', { reason: 'no_key' });
    if (g.checksPerDay === 0) return refuse(409, 'analytics_off', { reason: 'checks_off' });
    if (!this.d.listStills(at, at).includes(at)) return { outcome: 'refused', status: 404, error: 'no_still' };
    if (running) return refuse(429, 'busy');
    this.paused = this.pause();
    if (this.paused) return refuse(503, 'analytics_paused', { reason: this.paused.reason, until: this.paused.until });
    const day = localDay(this.now(), this.d.timeInfo());
    if (this.monthUsage(day) >= g.monthlyLimit) return refuse(429, 'limit', { reason: 'month' });
    if (g.dailyCap > 0 && usageBetween(this.d.catalog, 'google-vision', day, day) >= g.dailyCap) return refuse(429, 'limit', { reason: 'day' });
    if (usageBetween(this.d.catalog, CHECK_USAGE.calls, day, day) >= g.checksPerDay) return refuse(429, 'limit', { reason: 'checks' });
    // The call is reserved in the same synchronous step as the limit checks:
    // an automatic analysis that runs while the still is read sees it.
    const reserved = [this.usageKey('google-vision'), this.usageKey(CHECK_USAGE.calls)];
    for (const u of reserved) addUsage(this.d.catalog, u, day);
    const abort = new AbortController();
    const done = this.callCheck(at, via, day, abort.signal, reserved);
    this.checking = { at, done, abort };
    try {
      return await done;
    } finally {
      this.checking = null;
    }
  }

  private async callCheck(at: number, via: CheckVia, day: string, stop: AbortSignal, reserved: UsageKey[]): Promise<CheckOutcome> {
    // No call made after all: the reservation (check()) is given back.
    const release = () => {
      try {
        for (const u of reserved) releaseUsage(this.d.catalog, u, day);
      } catch (err) {
        logger.warn({ err: (err as Error).message }, 'analytics_check_release_failed');
      }
    };
    let jpeg: Buffer | undefined;
    try {
      jpeg = await this.d.readStill(at);
    } catch {
      jpeg = undefined;
    }
    if (stop.aborted) {
      release();
      this.count('failed');
      return { outcome: 'failed', reason: 'aborted', tookMs: null, cost: 0 };
    }
    if (!jpeg) return release(), { outcome: 'refused', status: 404, error: 'no_still' }; // deleted meanwhile
    const key = this.key()!;
    const make = this.d.provider ?? ((id, k, url) => googleVision({ key: k, baseUrl: url }));
    const provider = make('google-vision', key, this.d.secrets().googleVisionUrl);
    const t0 = this.now();
    let res: { objects: unknown; raw: unknown };
    try {
      res = await provider.analyze(jpeg, AbortSignal.any([AbortSignal.timeout(TIMEOUT_MS), stop]));
    } catch (err) {
      const e = stop.aborted ? new AnalyticsError('aborted', false) : err instanceof AnalyticsError ? err : new AnalyticsError('network', true);
      this.noteFailure(e, key, t0);
      this.count('failed');
      return { outcome: 'failed', reason: e.reason, tookMs: this.now() - t0, cost: 1 };
    }
    const tookMs = this.now() - t0;
    this.lastCall = { at: t0, tookMs, status: 'ok' };
    const objects = Array.isArray(res.objects) ? (res.objects as Found[]) : [];
    const sum = summarize(objects);
    let row: StillCheckRow;
    try {
      row = insertCheck(this.d.catalog, {
        cam: this.d.cam, still_ts: at, provider: 'google-vision', requested_at: t0, requested_via: via, took_ms: tookMs,
        objects: JSON.stringify(objects), raw: res.raw === undefined ? null : JSON.stringify(res.raw), summary: JSON.stringify(sum.summary),
      });
    } catch (err) {
      logger.warn({ err: (err as Error).message, stillTs: at }, 'analytics_check_store_failed');
      return { outcome: 'failed', reason: 'store_failed', tookMs, cost: 1 };
    }
    // The copy after the row (its name is the row id); a failed copy keeps
    // the row without an image: the result was paid for.
    // Its own folder, not analytics/: an older version's retention never
    // sweeps it (a rollback keeps the images).
    const dir = join(this.d.dataDir, 'still-checks', this.d.cam);
    const image = join(dir, `check-${row.id}.jpg`);
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(image, jpeg);
      setCheckImage(this.d.catalog, row.id, image);
      row = { ...row, image };
    } catch (err) {
      try {
        unlinkSync(image);
      } catch {
        /* never written */
      }
      logger.warn({ err: (err as Error).message, stillTs: at }, 'analytics_check_image_failed');
    }
    try {
      this.d.log.append(this.d.cam, 'still-check', { ...checkJson(this.d.catalog, row, this.maxOpenMs()) });
      if (sum.unmapped.length) countUnmapped(this.d.catalog, sum.unmapped, this.now());
    } catch (err) {
      logger.warn({ err: (err as Error).message, stillTs: at }, 'analytics_check_announce_failed');
    }
    return { outcome: 'ok', row, tookMs };
  }

  // A failed call's effect on the provider state, the same for events and checks.
  private noteFailure(e: AnalyticsError, key: string, t0: number): void {
    this.lastCall = { at: t0, tookMs: this.now() - t0, status: e.reason };
    // A bad_key answer to a call made with a key replaced meanwhile
    // (setManualKey) says nothing about the new key: no pause, no error.
    const staleKey = e.pause === 'bad_key' && this.key() !== key;
    if (!staleKey) this.lastError = e.reason;
    if (e.pause === 'bad_key' && !staleKey) this.paused = { reason: 'bad_key', until: null };
    if (e.pause === 'quota') this.paused = { reason: 'quota', until: this.now() + QUOTA_PAUSE_MS };
  }

  // `draining` is cleared in the same synchronous step that finds the queue
  // empty, so a job queued at any later moment starts a new drain.
  private async drain(): Promise<void> {
    try {
      for (let job = this.queue.shift(); job && !this.stopped; job = this.queue.shift()) {
        try {
          await this.run(job);
        } catch (err) {
          logger.warn({ err: (err as Error).message, eventId: job.id }, 'analytics_job_failed');
        }
      }
    } finally {
      this.draining = false;
    }
  }

  // The still at start + 1 s, else the nearest within ±2 s; waits for it.
  private async pickStill(start: number): Promise<number | null> {
    const want = start + STILL_AFTER_MS;
    const deadline = want + STILL_WAIT_MS;
    for (;;) {
      if (this.stopped) return null; // stop() woke the wait: no spinning to the deadline
      const near = this.d.listStills(want - STILL_NEAR_MS, want + STILL_NEAR_MS);
      const nearest = () => near.reduce((a, b) => (Math.abs(b - want) < Math.abs(a - want) ? b : a));
      if (near.includes(want)) return want;
      // Stills sit on slot boundaries, events carry milliseconds: once a still
      // at or after `want` exists, none that appears later can be closer.
      if (near.some((t) => t >= want)) return nearest();
      if (this.now() >= deadline) return near.length ? nearest() : null;
      await this.wait(Math.min(1000, deadline - this.now()));
    }
  }

  private store(job: Job, r: { status: 'ok' | 'skipped' | 'failed'; reason: string | null; stillTs: number | null; image: string | null; tookMs: number | null; objects: unknown; raw: unknown }): void {
    const sum = r.status === 'ok' && Array.isArray(r.objects) ? summarize(r.objects as Found[]) : { summary: [], unmapped: [] };
    const row = saveAnalysis(this.d.catalog, {
      event_id: job.id, provider: 'google-vision', status: r.status, reason: r.reason, still_ts: r.stillTs, image: r.image,
      requested_at: this.now(), took_ms: r.tookMs, objects: r.objects === null ? null : JSON.stringify(r.objects), raw: r.raw === null ? null : JSON.stringify(r.raw), summary: JSON.stringify(sum.summary),
    });
    if (!row) {
      if (r.image) try { unlinkSync(r.image); } catch { /* already gone */ }
      return;
    }
    const ev = eventById(this.d.catalog, job.id);
    this.d.log.append(this.d.cam, 'analysis', {
      eventId: job.id, kind: ev?.kind ?? job.kind, start: ev?.start_ts ?? job.start_ts, end: ev?.end_ts ?? null,
      provider: 'google-vision', status: r.status, reason: r.reason, stillTs: r.stillTs, summary: sum.summary, objects: r.objects ?? [],
    });
    // Counted last and guarded: a failing count must not swallow the message.
    if (sum.unmapped.length) {
      try {
        countUnmapped(this.d.catalog, sum.unmapped, this.now());
      } catch (err) {
        logger.warn({ err: (err as Error).message, eventId: job.id }, 'analytics_unmapped_count_failed');
      }
    }
  }

  // Analyses stored before summaries existed (or whose summary failed) get
  // one, from their stored objects. Nothing is counted as unmapped: only new
  // analyses count, so a restart can't inflate the list.
  backfillSummaries(): number {
    let n = 0;
    for (const a of withoutSummary(this.d.catalog)) {
      let objects: Found[] = [];
      try {
        const parsed: unknown = a.objects ? JSON.parse(a.objects) : [];
        objects = Array.isArray(parsed) ? (parsed as Found[]) : [];
      } catch {
        objects = [];
      }
      setSummary(this.d.catalog, a.id, JSON.stringify(summarize(objects).summary));
      n++;
    }
    if (n) logger.info({ cam: this.d.cam, summarised: n }, 'analytics_summaries_backfilled');
    return n;
  }

  private skip(job: Job, reason: string, stillTs: number | null = null): void {
    this.store(job, { status: 'skipped', reason, stillTs, image: null, tookMs: null, objects: null, raw: null });
  }

  // After a paid, successful call nothing local may trigger another call: a
  // failed image copy stores the result without it, a failed store is logged.
  // No partial or unreferenced image copy is left behind.
  private storeOk(job: Job, jpeg: Buffer, stillTs: number, tookMs: number, res: { objects: unknown; raw: unknown }): void {
    const remove = (f: string) => {
      try {
        unlinkSync(f);
      } catch {
        /* never written */
      }
    };
    let image: string | null = null;
    try {
      const dir = join(this.d.dataDir, 'analytics', this.d.cam);
      mkdirSync(dir, { recursive: true });
      image = join(dir, `${job.id}.jpg`);
      writeFileSync(image, jpeg);
    } catch (err) {
      if (image) remove(image);
      image = null;
      logger.warn({ err: (err as Error).message, eventId: job.id }, 'analytics_image_copy_failed');
    }
    try {
      this.store(job, { status: 'ok', reason: null, stillTs, image, tookMs, objects: res.objects, raw: res.raw });
    } catch (err) {
      // Only when no row names the image (a later step may fail after the row was written).
      let named = false;
      try {
        named = analysisFor(this.d.catalog, job.id)?.image === image;
      } catch {
        /* the catalog can't say: no row to keep it for */
      }
      if (image && !named) remove(image);
      logger.warn({ err: (err as Error).message, eventId: job.id }, 'analytics_store_failed');
    }
  }

  private async run(job: Job): Promise<void> {
    if (!this.active()) return;
    const stillTs = await this.pickStill(job.start_ts);
    if (!this.active()) return; // switched off while waiting: nothing stored
    if (stillTs === null) return this.skip(job, 'no_still');
    this.paused = this.pause();
    if (this.paused) return this.skip(job, 'paused', stillTs);
    const jpeg = await this.d.readStill(stillTs);
    if (!jpeg) return this.skip(job, 'no_still');
    const make = this.d.provider ?? ((id, k, url) => googleVision({ key: k, baseUrl: url }));

    let failed: AnalyticsError | undefined; // the previous attempt's error
    let t0 = 0;
    // For the audit record: the calls made, the last one's time, what it came to.
    const made = { calls: 0, tookMs: null as number | null, summary: null as unknown[] | null };
    try {
      for (let attempt = 0; ; attempt++) {
        // Switched off or stopped during the retry wait: no call; the counted
        // attempt is stored, so the event and the usage agree.
        if (!this.active()) {
          if (failed) this.store(job, { status: 'failed', reason: failed.reason, stillTs, image: null, tookMs: null, objects: null, raw: null });
          return;
        }
        // Retention may have removed the event meanwhile: no call for it.
        if (!eventById(this.d.catalog, job.id)) return;
        // The key as it is now: a key set during the retry wait is the one used.
        const key = this.key()!;
        const provider = make('google-vision', key, this.d.secrets().googleVisionUrl);
        const g = this.settings().googleVision;
        const day = localDay(this.now(), this.d.timeInfo());
        if (this.monthUsage(day) >= g.monthlyLimit || (g.dailyCap > 0 && usageBetween(this.d.catalog, 'google-vision', day, day) >= g.dailyCap)) {
          return this.skip(job, 'limit', stillTs);
        }
        addUsage(this.d.catalog, this.usageKey('google-vision', key), day);
        made.calls++;
        t0 = this.now();
        let res: { objects: unknown; raw: unknown };
        try {
          res = await provider.analyze(jpeg, AbortSignal.timeout(TIMEOUT_MS));
        } catch (err) {
          const e = err instanceof AnalyticsError ? err : new AnalyticsError('network', true);
          failed = e;
          made.tookMs = this.now() - t0;
          this.noteFailure(e, key, t0);
          if (e.retry && attempt === 0) {
            await this.wait(RETRY_AFTER_MS);
            continue;
          }
          return this.store(job, { status: 'failed', reason: e.reason, stillTs, image: null, tookMs: this.now() - t0, objects: null, raw: null });
        }
        const tookMs = this.now() - t0;
        this.lastCall = { at: t0, tookMs, status: 'ok' };
        made.tookMs = tookMs;
        made.summary = Array.isArray(res.objects) ? summarize(res.objects as Found[]).summary : [];
        return this.storeOk(job, jpeg, stillTs, tookMs, res);
      }
    } finally {
      if (made.calls) this.auditCall(job, stillTs, made, failed?.reason ?? 'unknown');
    }
  }

  // One `event-analysis` record per automatic analysis that made a Vision
  // call (ok, or failed after its retry); never the image or the key. A skip
  // made no call and writes nothing.
  private auditCall(job: Job, stillTs: number, made: { calls: number; tookMs: number | null; summary: unknown[] | null }, reason: string): void {
    if (!this.d.audit) return;
    const ok = made.summary !== null;
    const head = `Vision on event ${job.id} (${job.kind})`;
    try {
      this.d.audit.write({
        action: 'event-analysis', category: ['host'], type: ['access'], outcome: ok ? 'success' : 'failure', user: 'system',
        message: ok ? `${head}: ${summaryText(made.summary!)}` : `${head} failed: ${reason}`,
        ...(ok ? {} : { error: reason }),
        details: { cam: this.d.cam, eventId: job.id, kind: job.kind, stillTs, outcome: ok ? 'ok' : 'failed', reason: ok ? null : reason, calls: made.calls, tookMs: made.tookMs, found: ok ? summaryCategories(made.summary!) : [] },
      });
    } catch (err) {
      logger.warn({ err: (err as Error).message, eventId: job.id }, 'analytics_audit_failed');
    }
  }
}
