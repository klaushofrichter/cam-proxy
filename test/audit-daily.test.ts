import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AuditLog } from '../src/audit/audit-log';
import { DailyAudit, addDays, dayStartMs, storageMessage } from '../src/audit/daily';
import { localDay } from '../src/analytics/local-day';
import type { TimeInfo } from '../src/camera/time';

// Chicago: the second Sunday of March 02:00 to the first Sunday of November
// 02:00 (DstRule weekdays count from Sunday = 0, as getUTCDay).
const CHICAGO: TimeInfo = { stdOffsetMinutes: -360, dstOffsetMinutes: 60, dstRule: { startMon: 3, startWeek: 2, startWeekday: 0, startHour: 2, startMin: 0, endMon: 11, endWeek: 1, endWeekday: 0, endHour: 2, endMin: 0 } };
const dirs: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// `null`: no time info (an `undefined` argument would take the default).
function setup(now: { t: number }, zone: TimeInfo | null = CHICAGO, over: { storage?: () => { message: string; details: Record<string, unknown> } } = {}) {
  const ti = zone ?? undefined;
  const dir = mkdtempSync(join(tmpdir(), 'audit-daily-'));
  dirs.push(dir);
  const audit = new AuditLog({ dir, version: 't', camera: () => 'cam1', now: () => now.t });
  const asked: [string, number, number][] = [];
  const mk = (everyMs?: number) => new DailyAudit({
    audit, now: () => now.t, timeInfo: () => ti, everyMs,
    storage: over.storage ?? (() => ({ message: 'Storage: ok', details: { used: 1 } })),
    activity: (day, from, to) => { asked.push([day, from, to]); return { message: `Activity ${day}`, details: { events: { total: 0 } } }; },
  });
  return { audit, asked, mk };
}
const of = (a: AuditLog, action: string) => a.list({ actions: [action], limit: 500 }).records;

describe('storageMessage', () => {
  const u = { used: 82.4e9, budget: 150e9, stillMinutes: 41_230, clipRows: 1312 };
  it('says how many days until full, or that it is not filling', () => {
    expect(storageMessage({ ...u, daysUntilFull: 214.4 })).toBe('Storage: 82.4 GB used of 150.0 GB budget, 41,230 minutes of stills, 1,312 clips, 214 days until full');
    expect(storageMessage({ ...u, daysUntilFull: null })).toBe('Storage: 82.4 GB used of 150.0 GB budget, 41,230 minutes of stills, 1,312 clips, not filling');
  });
  // #78: the Pi's first record read "893477 days until full".
  it('says "more than a year" past 365 days', () => {
    expect(storageMessage({ ...u, daysUntilFull: 365 })).toMatch(/, 365 days until full$/);
    expect(storageMessage({ ...u, daysUntilFull: 365.6 })).toMatch(/, more than a year until full$/);
    expect(storageMessage({ ...u, daysUntilFull: 893_477 })).toMatch(/, more than a year until full$/);
  });
});

describe('CHICAGO test zone', () => {
  it('is CDT on 2026-10-01 and CST on 2026-12-01', () => {
    expect(localDay(Date.parse('2026-10-01T04:59:00Z'), CHICAGO)).toBe('2026-09-30');
    expect(localDay(Date.parse('2026-10-01T05:00:00Z'), CHICAGO)).toBe('2026-10-01');
    expect(localDay(Date.parse('2026-12-01T05:59:00Z'), CHICAGO)).toBe('2026-11-30');
    expect(localDay(Date.parse('2026-12-01T06:00:00Z'), CHICAGO)).toBe('2026-12-01');
  });
});

describe('dayStartMs', () => {
  it('is the camera-local midnight, also on the DST change days', () => {
    expect(dayStartMs('2026-10-01', CHICAGO)).toBe(Date.parse('2026-10-01T05:00:00Z')); // CDT
    expect(dayStartMs('2026-12-01', CHICAGO)).toBe(Date.parse('2026-12-01T06:00:00Z')); // CST
    expect(dayStartMs('2026-03-08', CHICAGO)).toBe(Date.parse('2026-03-08T06:00:00Z')); // spring-forward day starts in CST
    expect(dayStartMs('2026-11-01', CHICAGO)).toBe(Date.parse('2026-11-01T05:00:00Z')); // fall-back day starts in CDT
    expect(dayStartMs('2026-10-01', undefined)).toBe(Date.parse('2026-10-01T00:00:00Z'));
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });
});

describe('DailyAudit', () => {
  it('waits for 00:05 camera time, then writes storage and activity for the previous day, once', () => {
    const now = { t: Date.parse('2026-10-02T05:04:00Z') }; // 00:04 CDT
    const { audit, asked, mk } = setup(now);
    const d = mk();
    d.check();
    expect(of(audit, 'storage-daily')).toHaveLength(0);
    now.t = Date.parse('2026-10-02T05:05:30Z'); // 00:05:30 CDT
    d.check();
    d.check();
    expect(of(audit, 'storage-daily')).toHaveLength(1);
    expect(of(audit, 'storage-daily')[0]).toMatchObject({ event: { category: ['host'], type: ['info'] }, user: { name: 'system' }, cam_proxy: { day: '2026-10-02', used: 1 } });
    expect(of(audit, 'activity-daily')[0]).toMatchObject({ message: 'Activity 2026-10-01', cam_proxy: { day: '2026-10-02', forDay: '2026-10-01' } });
    expect(asked).toEqual([['2026-10-01', Date.parse('2026-10-01T05:00:00Z'), Date.parse('2026-10-02T05:00:00Z')]]);
  });

  // Review focus 1.
  it('writes once per camera day across a restart, and catches up after downtime', () => {
    const now = { t: Date.parse('2026-10-02T05:06:00Z') };
    const { audit, mk } = setup(now);
    mk().check();
    mk().check(); // a restart the same day
    expect(of(audit, 'storage-daily')).toHaveLength(1);
    now.t = Date.parse('2026-10-03T14:00:00Z'); // down over midnight, back at 09:00 CDT
    mk().check();
    expect(of(audit, 'storage-daily').map((r) => r.cam_proxy!.day)).toEqual(['2026-10-03', '2026-10-02']);
  });

  it('on the DST change day the day has 25 hours of activity', () => {
    const now = { t: Date.parse('2026-11-02T06:06:00Z') }; // 00:06 CST on Nov 2
    const { asked, mk } = setup(now);
    mk().check();
    const [[day, from, to]] = asked;
    expect(day).toBe('2026-11-01');
    expect(to - from).toBe(25 * 3_600_000);
  });

  it('on the spring-forward day the day has 23 hours of activity', () => {
    const now = { t: Date.parse('2026-03-09T05:06:00Z') }; // 00:06 CDT on Mar 9
    const { asked, mk } = setup(now);
    mk().check();
    const [[day, from, to]] = asked;
    expect(day).toBe('2026-03-08');
    expect(to - from).toBe(23 * 3_600_000);
  });

  // The real start path: refreshingTimeInfo answers undefined on its first call.
  function lazyStart(at: string, ready: (calls: number, now: number) => boolean) {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse(at));
    const dir = mkdtempSync(join(tmpdir(), 'audit-daily-'));
    dirs.push(dir);
    const audit = new AuditLog({ dir, version: 't', camera: () => 'cam1', now: () => Date.now() });
    const asked: [string, number, number][] = [];
    let calls = 0;
    const d = new DailyAudit({
      audit, now: () => Date.now(), timeInfo: () => (ready(++calls, Date.now()) ? CHICAGO : undefined),
      storage: () => ({ message: 'Storage', details: {} }),
      activity: (day, from, to) => { asked.push([day, from, to]); return { message: `Activity ${day}`, details: {} }; },
    });
    d.start();
    const tick = (iso: string) => { while (Date.now() < Date.parse(iso)) vi.advanceTimersByTime(60_000); };
    return { audit, asked, d, tick };
  }

  it('a start in the camera evening waits for the time info: no early UTC-day record', () => {
    const { audit, asked, d, tick } = lazyStart('2026-10-02T00:30:00Z', (calls) => calls > 1); // 19:30 CDT Oct 1
    tick('2026-10-02T05:04:00Z');
    expect(of(audit, 'storage-daily').filter((r) => r.cam_proxy!.day === '2026-10-02')).toHaveLength(0);
    tick('2026-10-02T05:06:00Z');
    d.stop();
    const s = of(audit, 'storage-daily').filter((r) => r.cam_proxy!.day === '2026-10-02');
    expect(s).toHaveLength(1);
    expect(s[0].cam_proxy!.dayBasis).toBeUndefined();
    expect(of(audit, 'activity-daily').find((r) => r.cam_proxy!.day === '2026-10-02')).toMatchObject({ cam_proxy: { forDay: '2026-10-01' } });
    expect(asked).toContainEqual(['2026-10-01', Date.parse('2026-10-01T05:00:00Z'), Date.parse('2026-10-02T05:00:00Z')]);
    expect(asked.every(([, from]) => from % 3_600_000 === 0 && new Date(from).getUTCHours() === 5)).toBe(true); // camera days only
  });

  it('time info missing past an hour gives UTC-day records marked as such; the camera-day records follow', () => {
    const { audit, d, tick } = lazyStart('2026-10-02T00:30:00Z', (_c, now) => now >= Date.parse('2026-10-02T02:00:00Z'));
    tick('2026-10-02T01:29:00Z');
    expect(of(audit, 'storage-daily')).toHaveLength(0); // within the grace period
    tick('2026-10-02T01:32:00Z');
    expect(of(audit, 'storage-daily').map((r) => r.cam_proxy)).toEqual([expect.objectContaining({ day: '2026-10-02', dayBasis: 'utc' })]);
    tick('2026-10-02T05:06:00Z');
    d.stop();
    const camera = of(audit, 'storage-daily').filter((r) => r.cam_proxy!.day === '2026-10-02' && r.cam_proxy!.dayBasis === undefined);
    expect(camera).toHaveLength(1);
    expect(of(audit, 'activity-daily').filter((r) => r.cam_proxy!.day === '2026-10-02' && r.cam_proxy!.dayBasis === undefined)).toHaveLength(1);
  });

  it('without time info it uses UTC days', () => {
    const now = { t: Date.parse('2026-10-02T00:06:00Z') };
    const { audit, mk } = setup(now, null);
    mk().check();
    expect(of(audit, 'storage-daily')[0].cam_proxy).toMatchObject({ day: '2026-10-02', dayBasis: 'utc' });
  });

  it('a failing check does not escape the timer; it retries on the next tick, and stop() ends it', () => {
    vi.useFakeTimers();
    const now = { t: Date.parse('2026-10-02T05:06:00Z') };
    let fail = true;
    const { audit, mk } = setup(now, CHICAGO, { storage: () => { if (fail) throw new Error('disk gone'); return { message: 'ok', details: {} }; } });
    const d = mk(1000);
    d.start();
    vi.advanceTimersByTime(1000); // the first check: throws, is caught
    expect(of(audit, 'storage-daily')).toHaveLength(0);
    fail = false;
    vi.advanceTimersByTime(1000);
    expect(of(audit, 'storage-daily')).toHaveLength(1);
    expect(of(audit, 'activity-daily')).toHaveLength(1);
    d.stop();
    now.t = Date.parse('2026-10-03T05:06:00Z');
    vi.advanceTimersByTime(5000);
    expect(of(audit, 'storage-daily')).toHaveLength(1);
  });
});
