import type { TimeInfo } from '../camera/time';
import { localDay } from '../analytics/local-day';
import { logger } from '../log';
import type { AuditLog } from './audit-log';
import { RECORDING_KINDS } from '../clips/ftp-health';
import { addDays } from '../time-units';

// The daily audit records (spec 2026-10-01-audit-log-design): at 00:05
// camera time, storage-daily then activity-daily (for the previous camera
// day). Once per camera day: a record of today's day in the log means done,
// so a restart doesn't repeat it, and a start after downtime catches up.
// Known gap: only the current camera day is caught up. Days missed during
// downtime stay missing, and so does yesterday's record after a start
// between 00:00 and 00:05 (today's follows at 00:05).
// Without the camera's time info the day is a UTC day, but only after
// FALLBACK_MS since start (the time info arrives asynchronously); such
// records carry dayBasis 'utc' and don't count as done once the time info
// is known, so they never suppress the camera-day records.
export type StorageDaily = { message: string; details: Record<string, unknown> };
export type ActivityDaily = StorageDaily;
const AFTER_MS = 5 * 60_000;
const FALLBACK_MS = 60 * 60_000;

// The storage-daily message. Past a year the projection says only that: at a
// slow growth the day count runs into the hundred thousands (#78). Stills are
// stored as one pack per minute, so the count is of minutes, not of stills
// (counting stills would mean reading every pack).
export function storageMessage(u: { used: number; budget: number; stillMinutes: number; clipRows: number; daysUntilFull: number | null }): string {
  const gb = (b: number) => `${(b / 1e9).toFixed(1)} GB`;
  const days = u.daysUntilFull === null ? null : Math.round(u.daysUntilFull);
  const full = days === null ? 'not filling' : days > 365 ? 'more than a year until full' : `${days} days until full`;
  return `Storage: ${gb(u.used)} used of ${gb(u.budget)} budget, ${u.stillMinutes.toLocaleString('en-US')} minutes of stills, ${u.clipRows.toLocaleString('en-US')} clips, ${full}`;
}

// The activity-daily record of a camera day. `clipsReceived` (#93) next to
// the events: a day with recording events but no clips stands out (`noClips`
// and the message), as 2026-09-30 would have. `clips` is the same count,
// kept for readers of older records. `events` are the live ones; events
// recovered from the SD card (#75) are counted apart (`events.recovered`).
export function activityDaily(day: string, a: { events: Record<string, number>; recovered?: number; clips: number; vision: { day: number; monthToDate: number; monthlyLimit: number }; analyses: Record<string, number>; sseClients: number }): ActivityDaily {
  const total = Object.values(a.events).reduce((x, y) => x + y, 0);
  const recovered = a.recovered ?? 0;
  const recordingEvents = RECORDING_KINDS.reduce((n, k) => n + (a.events[k] ?? 0), 0);
  const noClips = recordingEvents > 0 && a.clips === 0;
  const kinds = Object.entries(a.events).map(([k, n]) => `${k} ${n}`).join(', ') || 'none';
  const clips = noClips ? `NO clips received for ${recordingEvents} recording events (is the camera's FTP upload on?)` : `${a.clips} clips received`;
  return {
    message: `Activity ${day}: ${total} events (${kinds})${recovered ? `, ${recovered} recovered from the SD card` : ''}, ${clips}, Vision ${a.vision.monthToDate} of ${a.vision.monthlyLimit} this month`,
    details: { events: { total, byKind: a.events, recovered }, recordingEvents, clips: a.clips, clipsReceived: a.clips, ...(noClips ? { noClips: true } : {}), analytics: { vision: a.vision, analyses: a.analyses }, stream: { clients: a.sseClients } },
  };
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
  private done: string | null = null; // "<basis>:<day>"
  private startedAt: number | undefined;
  // A failed write is retried with a backoff (1, 2, 4 ... 60 min), not every tick.
  private failures = 0;
  private retryAt = 0;
  constructor(private readonly d: { audit: AuditLog; now?: () => number; timeInfo: () => TimeInfo | undefined; storage: () => StorageDaily; activity: (day: string, from: number, to: number) => ActivityDaily; everyMs?: number }) {}

  // Asks for the time info once to start its fetch (refreshingTimeInfo is
  // lazy); the first check is a tick later.
  start(): void {
    this.stop();
    this.startedAt = (this.d.now ?? Date.now)();
    this.d.timeInfo();
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

  // An exception backs off like a failed write, then goes on to the caller.
  check(): void {
    const now = (this.d.now ?? Date.now)();
    try {
      this.run(now);
    } catch (err) {
      this.backoff(now);
      throw err;
    }
  }

  private backoff(now: number): void {
    this.retryAt = now + Math.min(60, 2 ** this.failures) * 60_000;
    this.failures++;
  }

  private run(now: number): void {
    const ti = this.d.timeInfo();
    // Started, no time info yet: wait for it a while rather than use a UTC day.
    if (!ti && this.startedAt !== undefined && now - this.startedAt < FALLBACK_MS) return;
    if (now < this.retryAt) return;
    const day = localDay(now, ti);
    const basis = ti ? 'camera' : 'utc';
    if (`${basis}:${day}` === this.done) return;
    const start = dayStartMs(day, ti);
    if (now < start + AFTER_MS) return; // before 00:05 camera time
    // One pass over the log for both records of this day. With time info, UTC-day records don't count.
    const found = new Set<string>();
    this.d.audit.find((r) => {
      const a = r.event?.action;
      if ((a === 'storage-daily' || a === 'activity-daily') && r.cam_proxy?.day === day && (!ti || r.cam_proxy?.dayBasis !== 'utc')) found.add(a);
      return found.size === 2;
    }, 3);
    const mark = ti ? {} : { dayBasis: 'utc' };
    const prev = addDays(day, -1);
    let ok = true; // a write that failed (null) is tried again next tick
    if (!found.has('storage-daily')) {
      const s = this.d.storage();
      ok = !!this.d.audit.write({ action: 'storage-daily', category: ['host'], type: ['info'], outcome: 'success', user: 'system', message: s.message, details: { day, ...mark, ...s.details } });
    }
    if (!found.has('activity-daily')) {
      const a = this.d.activity(prev, dayStartMs(prev, ti), start);
      ok = !!this.d.audit.write({ action: 'activity-daily', category: ['host'], type: ['info'], outcome: 'success', user: 'system', message: a.message, details: { day, forDay: prev, ...mark, ...a.details } }) && ok;
    }
    if (ok) {
      this.done = `${basis}:${day}`;
      this.failures = 0;
    } else {
      this.backoff(now);
    }
  }
}
