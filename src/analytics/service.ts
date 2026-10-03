import { mkdirSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { sleep } from '../async';
import type { Catalog } from '../catalog/db';
import { addUsage, analysisFor, countUnmapped, saveAnalysis, setSummary, unanalysed, usageBetween, withoutSummary } from '../catalog/analyses';
import { eventById } from '../catalog/events';
import type { Config } from '../config/defaults';
import type { TimeInfo } from '../camera/time';
import { logger } from '../log';
import type { StreamLog } from '../stream/log';
import { summarize } from './classes';
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
}

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
  async stop(): Promise<void> {
    this.stopped = true;
    this.queue.length = 0;
    for (const w of [...this.sleepers]) w();
    await this.running;
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
    }));
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
      addUsage(this.d.catalog, 'google-vision', day);
      t0 = this.now();
      let res: { objects: unknown; raw: unknown };
      try {
        res = await provider.analyze(jpeg, AbortSignal.timeout(TIMEOUT_MS));
      } catch (err) {
        const e = err instanceof AnalyticsError ? err : new AnalyticsError('network', true);
        failed = e;
        this.lastCall = { at: t0, tookMs: this.now() - t0, status: e.reason };
        // A bad_key answer to a call made with a key replaced meanwhile
        // (setManualKey) says nothing about the new key: no pause, no error.
        const staleKey = e.pause === 'bad_key' && this.key() !== key;
        if (!staleKey) this.lastError = e.reason;
        if (e.pause === 'bad_key' && !staleKey) this.paused = { reason: 'bad_key', until: null };
        if (e.pause === 'quota') this.paused = { reason: 'quota', until: this.now() + QUOTA_PAUSE_MS };
        if (e.retry && attempt === 0) {
          await this.wait(RETRY_AFTER_MS);
          continue;
        }
        return this.store(job, { status: 'failed', reason: e.reason, stillTs, image: null, tookMs: this.now() - t0, objects: null, raw: null });
      }
      const tookMs = this.now() - t0;
      this.lastCall = { at: t0, tookMs, status: 'ok' };
      return this.storeOk(job, jpeg, stillTs, tookMs, res);
    }
  }
}
