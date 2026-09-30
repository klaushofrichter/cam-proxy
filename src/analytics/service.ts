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
  private draining = false;
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

  // A saved analytics setting (or a new key) lifts a bad_key pause.
  settingsChanged(): void {
    if (this.paused?.reason === 'bad_key') this.paused = null;
  }

  async idle(): Promise<void> {
    while (this.draining || this.queue.length) await this.running;
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
      const near = this.d.listStills(want - STILL_NEAR_MS, want + STILL_NEAR_MS);
      if (near.includes(want)) return want;
      if (this.now() >= deadline) {
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

  // After a paid, successful call nothing local may trigger another call: a
  // failed image copy stores the result without it, a failed store is logged.
  private storeOk(job: Job, jpeg: Buffer, stillTs: number, tookMs: number, res: { objects: unknown; raw: unknown }): void {
    let image: string | null = null;
    try {
      const dir = join(this.d.dataDir, 'analytics', this.d.cam);
      mkdirSync(dir, { recursive: true });
      image = join(dir, `${job.id}.jpg`);
      writeFileSync(image, jpeg);
    } catch (err) {
      image = null;
      logger.warn({ err: (err as Error).message, eventId: job.id }, 'analytics_image_copy_failed');
    }
    try {
      this.store(job, { status: 'ok', reason: null, stillTs, image, tookMs, objects: res.objects, raw: res.raw });
    } catch (err) {
      logger.warn({ err: (err as Error).message, eventId: job.id }, 'analytics_store_failed');
    }
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
        return this.storeOk(job, jpeg, stillTs, tookMs, res);
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
