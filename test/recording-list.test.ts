// test/recording-list.test.ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { CameraError } from '../src/camera/client';
import type { TimeInfo } from '../src/camera/time';
import { openCatalog } from '../src/catalog/db';
import { clipNear, insertClip } from '../src/catalog/clips';
import { RecordingList, SearchError } from '../src/recordings/list';

const CHI: TimeInfo = { stdOffsetMinutes: -360, dstOffsetMinutes: 60, dstRule: { startMon: 3, startWeek: 2, startWeekday: 0, startHour: 2, startMin: 0, endMon: 11, endWeek: 1, endWeekday: 0, endHour: 2, endMin: 0 } };
const file = (date: string, start: string, end: string, s: 'S' | 'M' = 'S', flags = '5514C080000000', size = '3E8') =>
  `/mnt/sda/Mp4Record/${date}/Rec${s}0A_DST${date.replaceAll('-', '')}_${start}_${end}_0_${flags}_${size}.mp4`;
type Param = { Search: { onlyStatus: number; streamType: string; StartTime: { year: number; mon: number; day: number }; EndTime: { day: number; hour: number; min: number; sec: number } } };
const dateOf = (p: Param) => `${p.Search.StartTime.year}-${String(p.Search.StartTime.mon).padStart(2, '0')}-${String(p.Search.StartTime.day).padStart(2, '0')}`;

function fake(files: Record<string, string[]>, o: { fail?: unknown[]; time?: () => Promise<TimeInfo>; status?: { year: number; mon: number; table: string }[] } = {}) {
  const calls: Param[] = [];
  let running = 0;
  let maxRunning = 0;
  const clock = { t: Date.UTC(2026, 9, 2, 18, 0) };
  const slept: number[] = [];
  const list = new RecordingList({
    search: async (param) => {
      const p = param as Param;
      calls.push(p);
      running++;
      maxRunning = Math.max(maxRunning, running);
      await new Promise((r) => setTimeout(r, 5));
      running--;
      const f = o.fail?.shift();
      if (f) throw f;
      if (p.Search.onlyStatus === 1) return { SearchResult: { Status: o.status ?? [] } };
      return { SearchResult: { File: (files[`${dateOf(p)}|${p.Search.streamType}`] ?? []).map((name) => ({ name, size: 1000 })) } };
    },
    timeInfo: o.time ?? (async () => CHI),
    now: () => clock.t,
    sleep: async (ms) => void slept.push(ms),
  });
  return { list, calls, clock, slept, maxRunning: () => maxRunning };
}

describe('RecordingList.range', () => {
  it('one Search per camera-local day, merged, sorted, filtered to the window, without recordings still being written', async () => {
    const x = fake({
      '2026-10-01|sub': [file('2026-10-01', '211129', '211207'), file('2026-10-01', '080000', '080030')],
      '2026-10-02|sub': [file('2026-10-02', '010000', '010020'), file('2026-10-02', '120000', '000000'), file('2026-10-01', '090000', '090010')],
    });
    // 2026-10-01 20:00 CDT to 2026-10-02 12:00 CDT.
    const r = await x.list.range(Date.UTC(2026, 9, 2, 1, 0), Date.UTC(2026, 9, 2, 17, 0), 'sub');
    expect(x.calls.map((c) => [dateOf(c), c.Search.streamType, c.Search.onlyStatus])).toEqual([['2026-10-01', 'sub', 0], ['2026-10-02', 'sub', 0]]);
    expect(x.calls[0].Search.EndTime).toMatchObject({ day: 1, hour: 23, min: 59, sec: 59 });
    expect(r.map((e) => e.id)).toEqual(['RecS0A_DST20261001_211129_211207_0_5514C080000000_3E8.mp4', 'RecS0A_DST20261002_010000_010020_0_5514C080000000_3E8.mp4']);
    expect(r[0]).toEqual({ id: r[0].id, path: file('2026-10-01', '211129', '211207'), start: Date.UTC(2026, 9, 2, 2, 11, 29), end: Date.UTC(2026, 9, 2, 2, 12, 7), stream: 'sub', size: 1000, kinds: ['person', 'motion'] });
  });

  it('runs one Search at a time, even for parallel requests', async () => {
    const x = fake({});
    await Promise.all([x.list.day('2026-10-01', 'sub'), x.list.day('2026-10-01', 'main'), x.list.day('2026-10-02', 'sub')]);
    expect(x.calls).toHaveLength(3);
    expect(x.maxRunning()).toBe(1);
  });

  it('keeps a day 30 s; requests at the same time share one Search', async () => {
    const x = fake({ '2026-10-01|sub': [file('2026-10-01', '211129', '211207')] });
    await Promise.all([x.list.day('2026-10-01', 'sub'), x.list.day('2026-10-01', 'sub')]);
    expect(x.calls).toHaveLength(1);
    x.clock.t += 29_999;
    await x.list.day('2026-10-01', 'sub');
    expect(x.calls).toHaveLength(1);
    x.clock.t += 1;
    await x.list.day('2026-10-01', 'sub');
    expect(x.calls).toHaveLength(2);
  });

  it('retries -54 once after 1 s; a second -54 or any other failure is search_failed', async () => {
    const busy = () => new CameraError('camera_error', 'Search failed (rspCode -54)', false, -54);
    const x = fake({ '2026-10-01|sub': [file('2026-10-01', '211129', '211207')] }, { fail: [busy()] });
    expect(await x.list.day('2026-10-01', 'sub')).toHaveLength(1);
    expect(x.slept).toEqual([1000]);
    const y = fake({}, { fail: [busy(), busy()] });
    const e = (await y.list.day('2026-10-01', 'sub').catch((err) => err)) as SearchError;
    expect([e.name, e.code]).toEqual(['SearchError', 'search_failed']);
    const z = fake({}, { fail: [new CameraError('camera_error', 'Search failed (rspCode -17)', false, -17)] });
    expect(((await z.list.day('2026-10-01', 'sub').catch((err) => err)) as SearchError).code).toBe('search_failed');
    expect(z.calls).toHaveLength(1);
  });

  it('an unreachable camera is camera_offline', async () => {
    const x = fake({}, { fail: [new CameraError('camera_offline', 'camera unreachable (ECONNREFUSED)')] });
    expect(((await x.list.day('2026-10-01', 'sub').catch((err) => err)) as SearchError).code).toBe('camera_offline');
  });

  // Review Focus 4.
  it('a failed GetTime is search_failed, not a crash; an unreachable one camera_offline', async () => {
    const x = fake({}, { time: async () => { throw new CameraError('camera_error', 'GetTime failed (rspCode -1)'); } });
    expect(((await x.list.range(Date.UTC(2026, 9, 2, 1), Date.UTC(2026, 9, 2, 2), 'sub').catch((err) => err)) as SearchError).code).toBe('search_failed');
    const y = fake({}, { time: async () => { throw new CameraError('camera_offline', 'camera unreachable (ETIMEDOUT)'); } });
    expect(((await y.list.range(Date.UTC(2026, 9, 2, 1), Date.UTC(2026, 9, 2, 2), 'sub').catch((err) => err)) as SearchError).code).toBe('camera_offline');
  });

  it('skips Search entries that are not plain recording paths', async () => {
    const x = fake({ '2026-10-01|sub': ['/mnt/sda/x y/RecS0A_DST20261001_211129_211207_0_5514C080000000_3E8.mp4', file('2026-10-01', '211129', '211207')] });
    expect((await x.list.day('2026-10-01', 'sub')).map((e) => e.path)).toEqual([file('2026-10-01', '211129', '211207')]);
  });
});

describe('RecordingList.find and stillListed', () => {
  it('resolves an id through its own day and stream; the camera path comes from Search', async () => {
    const x = fake({ '2026-10-01|main': [file('2026-10-01', '211129', '211207', 'M')] });
    const id = 'RecM0A_DST20261001_211129_211207_0_5514C080000000_3E8.mp4';
    expect((await x.list.find(id))?.path).toBe(file('2026-10-01', '211129', '211207', 'M'));
    expect(x.calls.map((c) => [dateOf(c), c.Search.streamType])).toEqual([['2026-10-01', 'main']]);
    expect(await x.list.find(id.replace('211129', '211130'))).toBeUndefined();
    expect(await x.list.find('not-a-name.mp4')).toBeUndefined();
  });

  it('stillListed asks the camera again (no cache)', async () => {
    const files = { '2026-10-01|sub': [file('2026-10-01', '211129', '211207')] };
    const x = fake(files);
    const [e] = await x.list.day('2026-10-01', 'sub');
    files['2026-10-01|sub'] = [];
    expect(await x.list.stillListed(e)).toBe(false);
    expect(x.calls).toHaveLength(2);
  });
});

describe('RecordingList.monthDays', () => {
  it('the days with recordings from the month Search (onlyStatus 1, main stream), kept 5 minutes', async () => {
    const x = fake({}, { status: [{ year: 2026, mon: 10, table: '1100000000000000000000000000001' }, { year: 2026, mon: 9, table: '1' }] });
    expect(await x.list.monthDays('2026-10')).toEqual([1, 2, 31]);
    expect(x.calls[0].Search).toMatchObject({ onlyStatus: 1, streamType: 'main', StartTime: { year: 2026, mon: 10, day: 1 }, EndTime: { day: 31, hour: 23, min: 59, sec: 59 } });
    x.clock.t += 299_999;
    await x.list.monthDays('2026-10');
    expect(x.calls).toHaveLength(1);
    x.clock.t += 1;
    await x.list.monthDays('2026-10');
    expect(x.calls).toHaveLength(2);
  });
});

describe('clipNear', () => {
  it('the FTP copy: same camera and stream, start within the slack, the closest', () => {
    const c = openCatalog(join(mkdtempSync(join(tmpdir(), 'camproxy-near-')), 'catalog.sqlite'));
    const T = Date.UTC(2026, 9, 2, 2, 11, 29);
    const base = { cam: 'cam1', end_ts: null, path: '/x.mp4', size: 1, received_at: T, snapshot: null };
    const far = insertClip(c, { ...base, stream: 'sub', start_ts: T + 4000 });
    const near = insertClip(c, { ...base, stream: 'sub', start_ts: T - 2000 });
    insertClip(c, { ...base, stream: 'main', start_ts: T });
    expect(clipNear(c, 'cam1', 'sub', T, 5000)?.id).toBe(near.id);
    expect(clipNear(c, 'cam1', 'sub', T + 8000, 5000)?.id).toBe(far.id);
    expect(clipNear(c, 'cam1', 'sub', T + 10_000, 5000)).toBeUndefined();
    expect(clipNear(c, 'cam2', 'sub', T, 5000)).toBeUndefined();
  });
});
