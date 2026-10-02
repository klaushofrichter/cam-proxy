import { describe, expect, it } from 'vitest';
import { BUSY_TRIES, listCamera, type CameraListDeps } from '../src/inventory/camera-list';
import { SearchError, type RecordingEntry } from '../src/recordings/list';
import type { TimeInfo } from '../src/camera/time';

// UTC-6 without DST: camera-local days start at 06:00 UTC.
const TIME: TimeInfo = { stdOffsetMinutes: -360, dstOffsetMinutes: 0 };
const at = (date: string, hhmm = '1200') => Date.parse(`${date}T${hhmm.slice(0, 2)}:${hhmm.slice(2)}:00Z`) + 6 * 3_600_000;
const entry = (date: string, hhmm: string): RecordingEntry => ({ id: `RecS0A_${date.replaceAll('-', '')}_${hhmm}00_${hhmm}30_0_55148000000000_100000.mp4`, path: `/mnt/sda/${date}/x.mp4`, start: at(date, hhmm), end: at(date, hhmm) + 30_000, stream: 'sub', size: 0x100000, kinds: ['motion'] });

// A fake RecordingList: `days` per month, recordings per date, and failures per date.
function fake(o: { months?: Record<string, number[] | Error>; recs?: Record<string, RecordingEntry[]>; fail?: Record<string, Error[]> } = {}) {
  const searched: string[] = [];
  const deps: CameraListDeps = {
    timeInfo: async () => TIME,
    sleep: async () => undefined,
    list: {
      monthDays: async (month) => {
        const m = o.months?.[month];
        if (m instanceof Error) throw m;
        return m ?? [];
      },
      day: async (date) => {
        searched.push(date);
        const f = o.fail?.[date]?.shift();
        if (f) throw f;
        return o.recs?.[date] ?? [];
      },
    },
  };
  return { deps, searched };
}
const signal = () => new AbortController().signal;

describe('listCamera', () => {
  it('searches only the days the month overview has, oldest first, and names the SD card\'s oldest day', async () => {
    const f = fake({ months: { '2026-09': [20, 29, 30], '2026-10': [1] }, recs: { '2026-09-29': [entry('2026-09-29', '0815')], '2026-10-01': [entry('2026-10-01', '0930')] } });
    const progress: string[] = [];
    const l = await listCamera(f.deps, { from: at('2026-09-28', '0000'), to: at('2026-10-01', '2300'), stream: 'sub', signal: signal(), progress: (d, t, date) => progress.push(`${d}/${t} ${date}`) });
    expect(l.days.map((x) => [x.date, x.state, x.recordings.length])).toEqual([['2026-09-28', 'listed', 0], ['2026-09-29', 'listed', 1], ['2026-09-30', 'listed', 0], ['2026-10-01', 'listed', 1]]);
    expect(f.searched).toEqual(['2026-09-29', '2026-09-30', '2026-10-01']);
    expect(l.oldestSdDay).toBe('2026-09-20');
    expect(progress).toEqual(['1/4 2026-09-28', '2/4 2026-09-29', '3/4 2026-09-30', '4/4 2026-10-01']);
  });

  it('marks a day whose Search fails unknown, and goes on', async () => {
    const f = fake({ months: { '2026-09': [29, 30] }, fail: { '2026-09-29': [new SearchError('search_failed', 'rspCode -17')] } });
    const l = await listCamera(f.deps, { from: at('2026-09-29', '0000'), to: at('2026-09-30', '2300'), stream: 'sub', signal: signal() });
    expect(l.days).toEqual([{ date: '2026-09-29', state: 'unknown', recordings: [], error: 'rspCode -17' }, { date: '2026-09-30', state: 'listed', recordings: [] }]);
  });

  it('searches every day of a month whose overview failed', async () => {
    const f = fake({ months: { '2026-09': new SearchError('search_failed', 'x') } });
    const l = await listCamera(f.deps, { from: at('2026-09-29', '0000'), to: at('2026-09-30', '2300'), stream: 'sub', signal: signal() });
    expect(f.searched).toEqual(['2026-09-29', '2026-09-30']);
    expect(l.oldestSdDay).toBeNull();
  });

  it('tries a busy Search again, and gives up after BUSY_TRIES as unknown', async () => {
    const busy = () => new SearchError('busy', 'too many recording Searches waiting');
    const f = fake({ months: { '2026-09': [29, 30] }, fail: { '2026-09-29': [busy()], '2026-09-30': Array.from({ length: BUSY_TRIES }, busy) } });
    const l = await listCamera(f.deps, { from: at('2026-09-29', '0000'), to: at('2026-09-30', '2300'), stream: 'sub', signal: signal() });
    expect(l.days.map((x) => x.state)).toEqual(['listed', 'unknown']);
    expect(f.searched).toEqual(['2026-09-29', '2026-09-29', ...Array.from({ length: BUSY_TRIES }, () => '2026-09-30')]);
  });

  it('an offline camera ends the listing', async () => {
    const f = fake({ months: { '2026-09': [29, 30] }, fail: { '2026-09-30': [new SearchError('camera_offline', 'the camera does not answer')] } });
    await expect(listCamera(f.deps, { from: at('2026-09-29', '0000'), to: at('2026-09-30', '2300'), stream: 'sub', signal: signal() })).rejects.toMatchObject({ code: 'camera_offline' });
    const noTime = fake();
    noTime.deps.timeInfo = async () => { throw new Error('ECONNREFUSED'); };
    await expect(listCamera(noTime.deps, { from: at('2026-09-29'), to: at('2026-09-30'), stream: 'sub', signal: signal() })).rejects.toMatchObject({ code: 'camera_offline' });
  });

  it('stops between days when cancelled, with the days listed so far', async () => {
    const ac = new AbortController();
    const f = fake({ months: { '2026-09': [28, 29, 30] } });
    const day = f.deps.list.day;
    f.deps.list.day = async (date, stream, fresh, sig) => {
      const r = await day(date, stream, fresh, sig);
      if (date === '2026-09-29') ac.abort();
      return r;
    };
    const l = await listCamera(f.deps, { from: at('2026-09-28', '0000'), to: at('2026-09-30', '2300'), stream: 'sub', signal: ac.signal });
    expect(l.days.map((x) => x.date)).toEqual(['2026-09-28', '2026-09-29']);
  });

  it('does not name the oldest SD day when an earlier month\'s overview failed', async () => {
    const f = fake({ months: { '2026-09': new SearchError('search_failed', 'x'), '2026-10': [2] } });
    const l = await listCamera(f.deps, { from: at('2026-09-30', '0000'), to: at('2026-10-02', '2300'), stream: 'sub', signal: signal() });
    expect(l.oldestSdDay).toBeNull();
    // A failed later month does not matter.
    const g = fake({ months: { '2026-09': [30], '2026-10': new SearchError('search_failed', 'x') } });
    const m = await listCamera(g.deps, { from: at('2026-09-30', '0000'), to: at('2026-10-02', '2300'), stream: 'sub', signal: signal() });
    expect(m.oldestSdDay).toBe('2026-09-30');
  });

  it('a cancel during the busy wait returns at once', async () => {
    const ac = new AbortController();
    const f = fake({ months: { '2026-09': [29] }, fail: { '2026-09-29': [new SearchError('busy', 'full')] } });
    f.deps.sleep = (ms, sig) => new Promise<void>((resolve) => {
      expect(ms).toBe(1000);
      sig?.addEventListener('abort', () => resolve(), { once: true });
      setTimeout(() => ac.abort(), 5);
    });
    const t0 = Date.now();
    const l = await listCamera(f.deps, { from: at('2026-09-29', '0000'), to: at('2026-09-29', '2300'), stream: 'sub', signal: ac.signal });
    expect(Date.now() - t0).toBeLessThan(500);
    expect(l.days).toEqual([]);
    expect(f.searched).toEqual(['2026-09-29']);
  });

  it('a time error that is not a network error is a failed Search, not an offline camera', async () => {
    const f = fake();
    f.deps.timeInfo = async () => { throw new Error('bad time answer'); };
    await expect(listCamera(f.deps, { from: at('2026-09-29'), to: at('2026-09-30'), stream: 'sub', signal: signal() })).rejects.toMatchObject({ code: 'search_failed', message: 'bad time answer' });
  });
});
