import { EventEmitter } from 'events';
import type { Catalog } from './catalog/db';
import { deleteEventsBefore } from './catalog/events';
import type { Config } from './config/defaults';
import type { StreamLog } from './stream/log';

const DAY = 86_400_000;
export interface RetentionRun { dryRun: boolean; deleted: { events: number; streamLog: number }; at: number }

// Phase 1: rows only (events and the stream log). Files (stills, previews,
// clips) and the size budget join in phase 2 (spec §8a).
export class Retention extends EventEmitter {
  private last: number | null = null;
  private readonly total = { events: 0, streamLog: 0 };
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly d: { catalog: Catalog; log: StreamLog; config: () => Config; now?: () => number }) {
    super();
  }

  private now(): number {
    return (this.d.now ?? Date.now)();
  }

  run(opts: { dryRun?: boolean }): RetentionRun {
    const r = this.d.config().retention;
    const now = this.now();
    const eventsBefore = now - r.eventsDays * DAY;
    const logBefore = now - r.streamLogDays * DAY;
    const db = this.d.catalog.db;
    let deleted;
    if (opts.dryRun) {
      deleted = {
        events: (db.prepare('SELECT COUNT(*) AS n FROM events WHERE start_ts < ?').get(eventsBefore) as { n: number }).n,
        streamLog: (db.prepare('SELECT COUNT(*) AS n FROM stream_log WHERE ts < ?').get(logBefore) as { n: number }).n,
      };
    } else {
      deleted = { events: deleteEventsBefore(this.d.catalog, eventsBefore), streamLog: this.d.log.deleteBefore(logBefore) };
      this.total.events += deleted.events;
      this.total.streamLog += deleted.streamLog;
      this.last = now;
    }
    const run = { dryRun: !!opts.dryRun, deleted, at: now };
    if (!opts.dryRun) this.emit('run', run);
    return run;
  }

  start(): void {
    const tick = () => {
      this.run({});
      this.timer = setTimeout(tick, this.d.config().retention.intervalMin * 60_000);
    };
    this.timer = setTimeout(tick, 5_000);
  }

  stop(): void {
    clearTimeout(this.timer);
  }

  lastRun(): number | null {
    return this.last;
  }

  totals(): { events: number; streamLog: number } {
    return { ...this.total };
  }
}
