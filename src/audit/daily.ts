import type { TimeInfo } from '../camera/time';
import { localDay } from '../analytics/local-day';
import { logger } from '../log';
import type { AuditLog } from './audit-log';

// The daily audit records (spec 2026-10-01-audit-log-design): at 00:05
// camera time, storage-daily then activity-daily (for the previous camera
// day). Once per camera day: a record of today's day in the log means done,
// so a restart doesn't repeat it, and a start after downtime catches up
// (today's records only; missed days stay missed).
export type StorageDaily = { message: string; details: Record<string, unknown> };
export type ActivityDaily = StorageDaily;
const AFTER_MS = 5 * 60_000;

export function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

// The first ms of a camera day: UTC midnight shifted by the offset in effect
// at that moment (DST or standard), checked against localDay.
export function dayStartMs(day: string, t: TimeInfo | undefined): number {
  const utc = Date.parse(`${day}T00:00:00Z`);
  if (!t) return utc;
  for (const off of [t.stdOffsetMinutes + (t.dstOffsetMinutes || 0), t.stdOffsetMinutes]) {
    const ms = utc - off * 60_000;
    if (localDay(ms, t) === day && localDay(ms - 1, t) !== day) return ms;
  }
  return utc - t.stdOffsetMinutes * 60_000;
}

export class DailyAudit {
  private timer: NodeJS.Timeout | undefined;
  private done: string | null = null;
  constructor(private readonly d: { audit: AuditLog; now?: () => number; timeInfo: () => TimeInfo | undefined; storage: () => StorageDaily; activity: (day: string, from: number, to: number) => ActivityDaily; everyMs?: number }) {}

  // The first check waits one tick: the camera's time info arrives
  // asynchronously after start, and without it the day would be a UTC day.
  start(): void {
    this.stop();
    this.timer = setInterval(() => {
      try {
        this.check();
      } catch (err) {
        logger.error({ err: (err as Error).message }, 'audit_daily_failed'); // tried again next tick
      }
    }, this.d.everyMs ?? 60_000);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  check(): void {
    const now = (this.d.now ?? Date.now)();
    const ti = this.d.timeInfo();
    const day = localDay(now, ti);
    if (day === this.done) return;
    const start = dayStartMs(day, ti);
    if (now < start + AFTER_MS) return; // before 00:05 camera time
    const has = (action: string) => !!this.d.audit.find((r) => r.event?.action === action && r.cam_proxy?.day === day, 3);
    const prev = addDays(day, -1);
    let ok = true; // a write that failed (null) is tried again next tick
    if (!has('storage-daily')) {
      const s = this.d.storage();
      ok = !!this.d.audit.write({ action: 'storage-daily', category: ['host'], type: ['info'], outcome: 'success', user: 'system', message: s.message, details: { day, ...s.details } });
    }
    if (!has('activity-daily')) {
      const a = this.d.activity(prev, dayStartMs(prev, ti), start);
      ok = !!this.d.audit.write({ action: 'activity-daily', category: ['host'], type: ['info'], outcome: 'success', user: 'system', message: a.message, details: { day, forDay: prev, ...a.details } }) && ok;
    }
    if (ok) this.done = day;
  }
}
