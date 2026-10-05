// The Archive's daily cleanup timing (spec 2026-10-05-archive-design §5):
// once per camera day at 03:30 camera time, catching up after a start.
import { describe, expect, it } from 'vitest';
import { ArchiveCleanup } from '../src/archive/cleanup';
import type { TimeInfo } from '../src/camera/time';

const CHICAGO: TimeInfo = { stdOffsetMinutes: -360, dstOffsetMinutes: 60, dstRule: { startMon: 3, startWeek: 2, startWeekday: 0, startHour: 2, startMin: 0, endMon: 11, endWeek: 1, endWeekday: 0, endHour: 2, endMin: 0 } };
const H = 3_600_000;

function make(ti: TimeInfo | undefined, start: number) {
  let now = start;
  const runs: number[] = [];
  const c = new ArchiveCleanup({ timeInfo: () => ti, now: () => now, run: (t) => (runs.push(t), { removed: 1, bytes: 10 }) });
  return { c, runs, at: (t: number) => (now = t) };
}

describe('ArchiveCleanup', () => {
  it('runs at 03:30 camera time (CDT: 08:30 UTC), once per camera day', () => {
    const day = Date.UTC(2026, 9, 5); // Oct 5, DST
    const { c, runs, at } = make(CHICAGO, day + 7 * H); // 02:00 CDT
    expect(c.nextRunAt()).toBe(day + 8.5 * H);
    c.tick();
    expect(runs).toEqual([]);
    at(day + 8.5 * H);
    c.tick();
    c.tick();
    expect(runs).toEqual([day + 8.5 * H]);
    expect(c.lastRun()).toEqual({ at: day + 8.5 * H, removed: 1, bytes: 10 });
    expect(c.nextRunAt()).toBe(day + 24 * H + 8.5 * H); // tomorrow 03:30
    at(day + 24 * H + 8.5 * H + 60_000);
    c.tick();
    expect(runs).toHaveLength(2);
  });

  it('in standard time 03:30 CST is 09:30 UTC', () => {
    const day = Date.UTC(2026, 0, 15);
    const { c } = make(CHICAGO, day + 6 * H); // midnight CST
    expect(c.nextRunAt()).toBe(day + 9.5 * H);
  });

  it('a start after 03:30 catches up at once; without the time info the day is UTC', () => {
    const day = Date.UTC(2026, 9, 5);
    const late = make(CHICAGO, day + 15 * H);
    expect(late.c.nextRunAt()).toBe(day + 15 * H); // due now
    late.c.tick();
    expect(late.runs).toHaveLength(1);
    const utc = make(undefined, day + 2 * H);
    expect(utc.c.nextRunAt()).toBe(day + 3.5 * H);
  });

  it('a failing run is logged and tried again at the next tick', () => {
    const day = Date.UTC(2026, 9, 5);
    let fail = true;
    let n = 0;
    const c = new ArchiveCleanup({ timeInfo: () => undefined, now: () => day + 4 * H, run: () => { n++; if (fail) throw new Error('db locked'); return { removed: 0, bytes: 0 }; } });
    c.tick();
    expect(c.lastRun()).toBeNull();
    fail = false;
    c.tick();
    expect(n).toBe(2);
    expect(c.lastRun()).toMatchObject({ removed: 0 });
  });
});
