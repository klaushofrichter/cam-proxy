import { localDay } from '../analytics/local-day';
import { dayStartMs } from '../audit/daily';
import type { TimeInfo } from '../camera/time';
import { logger } from '../log';
import { addDays } from '../time-units';

// The Archive's daily cleanup (spec 2026-10-05-archive-design §5, ruling
// 4): once per camera day at 03:30 camera time (UTC without the camera's
// time info), checked once a minute; a start after 03:30 runs it at the
// first tick (the proxy may have been down at 03:30). Not part of the
// hourly storage run.
export const CLEANUP_AT_MS = 3.5 * 3_600_000;
export interface CleanupResult { removed: number; bytes: number }

export class ArchiveCleanup {
  private timer: NodeJS.Timeout | undefined;
  private doneDay: string | null = null;
  private last: (CleanupResult & { at: number }) | null = null;

  constructor(private readonly d: { run: (now: number) => CleanupResult; timeInfo: () => TimeInfo | undefined; now?: () => number; everyMs?: number }) {}

  private now(): number {
    return (this.d.now ?? Date.now)();
  }

  private slot(day: string, ti: TimeInfo | undefined): number {
    return dayStartMs(day, ti) + CLEANUP_AT_MS;
  }

  start(): void {
    this.stop();
    this.d.timeInfo(); // starts its fetch
    this.timer = setInterval(() => this.tick(), this.d.everyMs ?? 60_000);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  tick(): void {
    const now = this.now();
    const ti = this.d.timeInfo();
    const day = localDay(now, ti);
    if (this.doneDay === day || now < this.slot(day, ti)) return;
    try {
      const r = this.d.run(now);
      this.doneDay = day;
      this.last = { at: now, ...r };
      logger.info({ removed: r.removed, bytes: r.bytes }, 'archive_cleanup');
    } catch (err) {
      logger.error({ err: (err as Error).message }, 'archive_cleanup_failed'); // tried again next tick
    }
  }

  // When the cleanup runs next: today's 03:30 camera time, tomorrow's once
  // today's ran, or now when today's is due (it runs within a minute).
  nextRunAt(): number {
    const now = this.now();
    const ti = this.d.timeInfo();
    const day = localDay(now, ti);
    const today = this.slot(day, ti);
    if (now < today) return today;
    if (this.doneDay !== day) return now;
    return this.slot(addDays(day, 1), ti);
  }

  lastRun(): (CleanupResult & { at: number }) | null {
    return this.last && { ...this.last };
  }
}
