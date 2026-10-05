// test/analytics-service.test.ts
import { beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { openCatalog, type Catalog } from '../src/catalog/db';
import { addRecoveredEvents, closeEvent, deleteEventsBefore, insertEvent } from '../src/catalog/events';
import { analysisFor, listUnmapped, saveAnalysis } from '../src/catalog/analyses';
import { StreamLog, type StreamMessage } from '../src/stream/log';
import { DEFAULTS, type Config } from '../src/config/defaults';
import { AnalyticsService, type AnalyticsDeps } from '../src/analytics/service';
import { localDay } from '../src/analytics/local-day';
import { AnalyticsError, type AnalyticsProvider } from '../src/analytics/providers';
import { timeInfoFromGetTime } from '../src/camera/time';

// America/Chicago as the camera reports it (see clips-indexer.test.ts).
const chicago = timeInfoFromGetTime({
  Dst: { enable: 1, offset: 1, startMon: 3, startWeek: 2, startWeekday: 0, startHour: 2, startMin: 0, startSec: 0, endMon: 11, endWeek: 1, endWeekday: 0, endHour: 2, endMin: 0, endSec: 0 },
  Time: { year: 2026, mon: 9, day: 30, hour: 9, min: 0, sec: 0, hourFmt: 1, isDst: 1, timeFmt: 'MM/DD/YYYY', timeZone: 21600 },
});

const T0 = Date.parse('2026-09-30T15:00:00Z'); // 10:00 CDT
let c: Catalog;
let log: StreamLog;
let now: number;
let config: Config;
let stills: Map<number, Buffer>;
let calls: number[];
let answers: Array<'ok' | AnalyticsError>;
let dir: string;

const provider: AnalyticsProvider = {
  id: 'google-vision',
  name: 'Google Vision',
  async analyze(jpeg) {
    calls.push(jpeg[0]);
    const a = answers.length > 1 ? answers.shift()! : (answers[0] ?? 'ok');
    if (a !== 'ok') throw a;
    return { objects: [{ name: 'Person', score: 0.8, box: { x0: 0.1, y0: 0.1, x1: 0.5, y1: 0.9 } }], raw: { n: 1 } };
  },
};

function deps(over: { key?: string } = {}): AnalyticsDeps {
  return {
    catalog: c, log, cams: () => ['cam1'], dataDir: dir,
    config: () => config,
    secrets: () => ({ googleVisionKey: over.key ?? 'k-123456789012', googleVisionUrl: 'http://mock' }),
    readStill: async (_cam, ts) => stills.get(ts),
    listStills: (_cam, from, to) => [...stills.keys()].filter((t) => t >= from && t <= to).sort((a, b) => a - b),
    timeInfo: () => chicago,
    now: () => now,
    sleep: async (ms) => void (now += ms),
    provider: () => provider,
  };
}
const service = (over: { key?: string } = {}) => new AnalyticsService(deps(over));
const event = (kind: string, start_ts = T0) => insertEvent(c, { cam: 'cam1', source: 'onvif', kind, start_ts, raw: null });
const still = (ts: number, byte: number) => stills.set(ts, Buffer.from([byte, 0xd8]));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'camproxy-svc-'));
  c = openCatalog(join(dir, 'catalog.sqlite'));
  log = new StreamLog(c, () => now);
  now = T0 + 3000;
  config = structuredClone(DEFAULTS);
  config.analytics.googleVision = { enabled: true, monthlyLimit: 100, dailyCap: 0, checksPerDay: 10, perCameraDailyCap: 0 };
  stills = new Map();
  calls = [];
  answers = [];
});

describe('local day', () => {
  it('is the camera-local date, across DST', () => {
    expect(localDay(Date.parse('2026-10-01T04:59:00Z'), chicago)).toBe('2026-09-30'); // 23:59 CDT
    expect(localDay(Date.parse('2026-10-01T05:00:00Z'), chicago)).toBe('2026-10-01');
    expect(localDay(Date.parse('2026-12-01T05:59:00Z'), chicago)).toBe('2026-11-30'); // 23:59 CST
    expect(localDay(Date.parse('2026-12-01T06:00:00Z'), chicago)).toBe('2026-12-01');
  });

  // Issue #52: a DST period across New Year (southern hemisphere).
  it('is the camera-local date when DST spans New Year (Sydney)', () => {
    const sydney = timeInfoFromGetTime({
      Dst: { enable: 1, offset: 1, startMon: 10, startWeek: 1, startWeekday: 0, startHour: 2, startMin: 0, startSec: 0, endMon: 4, endWeek: 1, endWeekday: 0, endHour: 3, endMin: 0, endSec: 0 },
      Time: { year: 2026, mon: 1, day: 15, hour: 9, min: 0, sec: 0, hourFmt: 1, isDst: 1, timeFmt: 'MM/DD/YYYY', timeZone: -36000 },
    });
    expect(localDay(Date.parse('2026-01-15T13:30:00Z'), sydney)).toBe('2026-01-16'); // 00:30 AEDT (+11)
    expect(localDay(Date.parse('2026-12-31T13:30:00Z'), sydney)).toBe('2027-01-01'); // 00:30 AEDT
    expect(localDay(Date.parse('2026-07-15T13:30:00Z'), sydney)).toBe('2026-07-15'); // 23:30 AEST (+10)
  });
});

describe('AnalyticsService', () => {
  it('analyses a person event with the still 1 s after its start, stores it and copies the image', async () => {
    still(T0 + 1000, 7);
    const s = service();
    const e = event('person');
    s.onEvent(e);
    await s.idle();
    const a = analysisFor(c, e.id)!;
    expect(a).toMatchObject({ status: 'ok', still_ts: T0 + 1000, provider: 'google-vision' });
    expect(JSON.parse(a.objects!)[0].name).toBe('Person');
    expect(readFileSync(a.image!)).toEqual(Buffer.from([7, 0xd8]));
    expect(log.since(0, { types: ['analysis'] }, 10)[0].data).toMatchObject({ eventId: e.id, status: 'ok' });
    expect(s.state()[0]).toMatchObject({ enabled: true, keyMasked: 'k-12…9012', month: { calls: 1, limit: 100 }, today: { calls: 1, cap: 0 } });
  });

  it('never analyses motion, nor kinds switched off', async () => {
    still(T0 + 1000, 7);
    const s = service();
    s.onEvent(event('motion'));
    s.onEvent(event('vehicle'));
    await s.idle();
    expect(calls).toEqual([]);
  });

  it('takes the nearest still within 2 s, else skips with no_still (no call)', async () => {
    still(T0 + 2500, 9);
    const s = service();
    const a = event('person');
    s.onEvent(a);
    await s.idle();
    expect(analysisFor(c, a.id)).toMatchObject({ status: 'ok', still_ts: T0 + 2500 });
    stills.clear();
    const b = event('person', T0 + 60_000);
    s.onEvent(b);
    await s.idle();
    expect(analysisFor(c, b.id)).toMatchObject({ status: 'skipped', reason: 'no_still' });
    expect(calls).toHaveLength(1);
  });

  it('stores nothing at all while no provider is enabled', async () => {
    config.analytics.googleVision.enabled = false;
    still(T0 + 1000, 7);
    const s = service();
    const e = event('person');
    s.onEvent(e);
    await s.idle();
    expect(analysisFor(c, e.id)).toBeUndefined();
    expect(s.state()[0].enabled).toBe(false);
  });

  it('stores nothing without a key, even when enabled', async () => {
    still(T0 + 1000, 7);
    const s = service({ key: '' });
    const e = event('person');
    s.onEvent(e);
    await s.idle();
    expect(analysisFor(c, e.id)).toBeUndefined();
    expect(s.state()[0]).toMatchObject({ keyMasked: null });
  });

  it('skips with reason limit at the monthly limit and at the daily cap', async () => {
    still(T0 + 1000, 7);
    still(T0 + 61_000, 7);
    still(T0 + 121_000, 7);
    config.analytics.googleVision = { enabled: true, monthlyLimit: 2, dailyCap: 1, checksPerDay: 10, perCameraDailyCap: 0 };
    const s = service();
    const [a, b] = [event('person'), event('person', T0 + 60_000)];
    s.onEvent(a);
    s.onEvent(b);
    await s.idle();
    expect(analysisFor(c, a.id)?.status).toBe('ok');
    expect(analysisFor(c, b.id)).toMatchObject({ status: 'skipped', reason: 'limit' }); // daily cap 1
    config.analytics.googleVision.monthlyLimit = 0;
    const d = event('person', T0 + 120_000);
    s.onEvent(d);
    await s.idle();
    expect(analysisFor(c, d.id)).toMatchObject({ status: 'skipped', reason: 'limit' });
    expect(calls).toHaveLength(1);
  });

  // Review focus 2.
  it('counts per camera-local day and month', async () => {
    config.analytics.googleVision = { enabled: true, monthlyLimit: 1, dailyCap: 0, checksPerDay: 10, perCameraDailyCap: 0 };
    const late = Date.parse('2026-10-01T04:58:00Z'); // 23:58 CDT on Sep 30
    still(late + 1000, 1);
    still(late + 181_000, 1); // 00:01 CDT on Oct 1: a new month
    const s = service();
    const a = event('person', late);
    now = late + 3000;
    s.onEvent(a);
    await s.idle();
    const b = event('person', late + 180_000);
    now = late + 183_000;
    s.onEvent(b);
    await s.idle();
    expect(analysisFor(c, a.id)?.status).toBe('ok');
    expect(analysisFor(c, b.id)?.status).toBe('ok'); // the October count starts at 0
    expect(s.state()[0].month).toEqual({ calls: 1, limit: 1 });
  });

  it('retries a timeout once after 30 s, then fails', async () => {
    still(T0 + 1000, 7);
    answers = [new AnalyticsError('timeout', true), new AnalyticsError('timeout', true)];
    const s = service();
    const e = event('person');
    const before = now;
    s.onEvent(e);
    await s.idle();
    expect(calls).toHaveLength(2);
    expect(now - before).toBeGreaterThanOrEqual(30_000);
    expect(analysisFor(c, e.id)).toMatchObject({ status: 'failed', reason: 'timeout' });
    expect(s.state()[0].month.calls).toBe(2); // every call sent counts
  });

  it('pauses on a bad key until settings change, and 1 h on quota', async () => {
    still(T0 + 1000, 7);
    still(T0 + 61_000, 7);
    answers = [new AnalyticsError('bad_key', false, 'bad_key'), 'ok'];
    const s = service();
    const a = event('person');
    s.onEvent(a);
    await s.idle();
    expect(s.state()[0].paused).toMatchObject({ reason: 'bad_key', until: null });
    const b = event('person', T0 + 60_000);
    s.onEvent(b);
    await s.idle();
    expect(analysisFor(c, b.id)).toMatchObject({ status: 'skipped', reason: 'paused' });
    expect(calls).toHaveLength(1);
    // Review focus 3.
    s.settingsChanged();
    expect(s.state()[0].paused).toBeNull();

    answers = [new AnalyticsError('quota', false, 'quota')];
    const q = event('person', T0 + 60_000 * 2);
    still(T0 + 121_000, 7);
    s.onEvent(q);
    await s.idle();
    expect(s.state()[0].paused).toMatchObject({ reason: 'quota', until: now + 3_600_000 });

    // Issue #52: the quota pause ends after the hour, and calls go out again.
    now += 3_600_000;
    expect(s.state()[0].paused).toBeNull();
    answers = ['ok'];
    const r = event('person', now - 3000);
    still(now - 2000, 9);
    s.onEvent(r);
    await s.idle();
    expect(analysisFor(c, r.id)).toMatchObject({ status: 'ok' });
    expect(calls.at(-1)).toBe(9);
  });

  // Review focus 1.
  it('two events in a row are both analysed, in order, each with its own still', async () => {
    still(T0 + 1000, 1);
    still(T0 + 11_000, 2);
    const s = service();
    const [a, b] = [event('person'), event('person', T0 + 10_000)];
    s.onEvent(a);
    s.onEvent(b);
    await s.idle();
    expect(calls).toEqual([1, 2]);
    expect(analysisFor(c, a.id)?.still_ts).toBe(T0 + 1000);
    expect(analysisFor(c, b.id)?.still_ts).toBe(T0 + 11_000);
  });

  // Review focus 4.
  it('drops the result when the event is gone by the time the result comes', async () => {
    still(T0 + 1000, 7);
    const s = service();
    const e = event('person');
    s.onEvent(e);
    deleteEventsBefore(c, T0 + 1); // retention runs while it is queued
    await s.idle();
    expect(calls).toHaveLength(0); // issue #52: no call for an event that is gone
    expect(s.state()[0].month.calls).toBe(0);
    expect(analysisFor(c, e.id)).toBeUndefined();
    expect(log.since(0, { types: ['analysis'] }, 10)).toEqual([]); // and nothing is announced
  });

  it('removes the image copy when the event goes during the call', async () => {
    still(T0 + 1000, 7);
    let written = false; // a stream message
    const s = new AnalyticsService({ ...deps(), provider: () => ({ id: 'google-vision', name: 'Google Vision', async analyze() {
      deleteEventsBefore(c, T0 + 1); // retention runs during the call
      return { objects: [], raw: {} };
    } }) });
    log.on('message', () => (written = true));
    const e = event('person');
    s.onEvent(e);
    await s.idle();
    expect(analysisFor(c, e.id)).toBeUndefined();
    expect(existsSync(join(dir, 'analytics', 'cam1', `${e.id}.jpg`))).toBe(false); // written, then removed
    expect(written).toBe(false);
    expect(s.state()[0].month.calls).toBe(1); // the call was made and counts
  });

  it('queues the last 10 minutes of unanalysed events again after a restart', async () => {
    still(T0 + 1000, 7);
    const old = event('person', T0 - 11 * 60_000);
    const recent = event('person');
    event('motion');
    const s = service();
    s.catchUp();
    await s.idle();
    expect(analysisFor(c, recent.id)?.status).toBe('ok');
    expect(analysisFor(c, old.id)).toBeUndefined();
  });
  // Fix round 1, issue 1: a job queued right as the drain ends is never stranded.
  it.each([1, 2, 3, 4, 5, 6, 7, 8])('drains an event queued %i microtasks after the last result', async (depth) => {
    still(T0 + 1000, 1);
    still(T0 + 11_000, 2);
    const s = service();
    const [a, b] = [event('person'), event('person', T0 + 10_000)];
    let fired = false;
    log.on('message', () => {
      if (fired) return;
      fired = true;
      let n = 0;
      const tick = () => (++n < depth ? void Promise.resolve().then(tick) : s.onEvent(b));
      Promise.resolve().then(tick);
    });
    s.onEvent(a);
    await s.idle();
    await new Promise((r) => setTimeout(r, 0)); // the late onEvent has happened by now
    await s.idle();
    expect(analysisFor(c, a.id)?.status).toBe('ok');
    expect(analysisFor(c, b.id)?.status).toBe('ok');
    expect(calls).toEqual([1, 2]);
  });

  // Fix round 1, issue 2: a local write error does not cause a second paid call.
  it('keeps the result, without an image, when the image copy cannot be written (one call only)', async () => {
    still(T0 + 1000, 7);
    writeFileSync(join(dir, 'analytics'), 'a file, so mkdir fails');
    const s = service();
    const e = event('person');
    s.onEvent(e);
    await s.idle();
    expect(calls).toHaveLength(1);
    expect(analysisFor(c, e.id)).toMatchObject({ status: 'ok', image: null });
    expect(s.state()[0].lastCall?.status).toBe('ok');
    expect(s.state()[0].month.calls).toBe(1);
  });

  // Fix round 1, issue 3: waits the full 5 s for the exact still.
  it('waits up to 5 s for the still at start + 1 s', async () => {
    now = T0 + 1000;
    const s = new AnalyticsService({
      catalog: c, log, cams: () => ['cam1'], dataDir: dir,
      config: () => config,
      secrets: () => ({ googleVisionKey: 'k-123456789012', googleVisionUrl: 'http://mock' }),
      readStill: async (_cam, ts) => stills.get(ts),
      listStills: (_cam, from, to) => [...stills.keys()].filter((t) => t >= from && t <= to).sort((a, b) => a - b),
      timeInfo: () => chicago,
      now: () => now,
      sleep: async (ms) => {
        now += ms;
        if (now > T0 + 4000) still(T0 + 1000, 5);
      },
      provider: () => provider,
    });
    const e = event('person');
    s.onEvent(e);
    await s.idle();
    expect(analysisFor(c, e.id)).toMatchObject({ status: 'ok', still_ts: T0 + 1000 });
  });

  // Final review, finding 3: switched off mid-job must not bill another call.
  it('makes no second attempt when switched off during the retry sleep', async () => {
    still(T0 + 1000, 7);
    answers = [new AnalyticsError('network', true)];
    const s = new AnalyticsService({
      catalog: c, log, cams: () => ['cam1'], dataDir: dir,
      config: () => config,
      secrets: () => ({ googleVisionKey: 'k-123456789012', googleVisionUrl: 'http://mock' }),
      readStill: async (_cam, ts) => stills.get(ts),
      listStills: (_cam, from, to) => [...stills.keys()].filter((t) => t >= from && t <= to).sort((a, b) => a - b),
      timeInfo: () => chicago,
      now: () => now,
      sleep: async (ms) => { now += ms; config.analytics.googleVision.enabled = false; },
      provider: () => provider,
    });
    const e = event('person');
    s.onEvent(e);
    await s.idle();
    expect(calls).toHaveLength(1);
    // Issue #52: the counted attempt is stored, so Status and the event agree.
    expect(analysisFor(c, e.id)).toMatchObject({ status: 'failed', reason: 'network' });
  });

  // Issue #52: stop() wakes a retry wait; no second call, the attempt is kept.
  it('stop() during the retry wait makes no second call and ends the job', async () => {
    still(T0 + 1000, 7);
    answers = [new AnalyticsError('network', true)];
    let wake: () => void = () => {};
    const s = new AnalyticsService({ ...deps(), sleep: (ms) => new Promise<void>((r) => { wake = () => { now += ms; r(); }; }) });
    const e = event('person');
    s.onEvent(e);
    await new Promise((r) => setTimeout(r, 10));
    expect(calls).toHaveLength(1); // now in the 30 s wait
    await s.stop(); // returns without the 30 s passing
    expect(calls).toHaveLength(1);
    expect(analysisFor(c, e.id)).toMatchObject({ status: 'failed', reason: 'network' });
    wake();
  });

  // Review: after stop() the still wait must end at once, not spin until its deadline.
  it('stop() during the still wait returns at once and makes no call', async () => {
    now = T0 + 1000; // no still yet: the service waits for one
    let sleeps = 0;
    const s = new AnalyticsService({ ...deps(), sleep: () => (sleeps++, new Promise<void>(() => {})) }); // a wait that never ends by itself; the clock stands still
    const e = event('person');
    s.onEvent(e);
    await new Promise((r) => setTimeout(r, 10));
    expect(sleeps).toBe(1);
    const t0 = Date.now();
    await Promise.race([s.stop(), new Promise((_, j) => setTimeout(() => j(new Error('stop() did not return')), 1000))]);
    expect(Date.now() - t0).toBeLessThan(500);
    expect(sleeps).toBe(1);
    expect(calls).toHaveLength(0);
    expect(analysisFor(c, e.id)).toBeUndefined();
  });

  // Review: a store that throws after the row was written keeps the image the row names.
  it('keeps the image copy when the row was written but a later step of the store failed', async () => {
    still(T0 + 1000, 7);
    const s = service();
    const e = event('person');
    const append = log.append.bind(log);
    log.append = ((...a: Parameters<typeof append>) => {
      if (a[1] === 'analysis') throw new Error('stream log full');
      return append(...a);
    }) as typeof log.append;
    s.onEvent(e);
    await s.idle();
    const row = analysisFor(c, e.id);
    expect(row?.image).toBeTruthy();
    expect(existsSync(row!.image!)).toBe(true);
  });

  it('stores the result of a call that was in flight when stop() came', async () => {
    still(T0 + 1000, 7);
    let answer: () => void = () => {};
    const s = new AnalyticsService({ ...deps(), provider: () => ({ id: 'google-vision', name: 'Google Vision', analyze: () => new Promise((r) => { answer = () => r({ objects: [], raw: {} }); }) }) });
    const e = event('person');
    s.onEvent(e);
    await new Promise((r) => setTimeout(r, 10));
    let stopped = false;
    const done = s.stop().then(() => (stopped = true));
    await new Promise((r) => setTimeout(r, 10));
    expect(stopped).toBe(false); // waits for the call
    answer();
    await done;
    expect(analysisFor(c, e.id)).toMatchObject({ status: 'ok' });
  });

  it('removes the image copy when the result cannot be stored', async () => {
    still(T0 + 1000, 7);
    const s = service();
    const e = event('person');
    c.db.exec('DROP TABLE analyses'); // the store fails
    s.onEvent(e);
    await s.idle();
    expect(calls).toHaveLength(1);
    expect(existsSync(join(dir, 'analytics', 'cam1', `${e.id}.jpg`))).toBe(false);
  });

  it('makes no call when switched off while waiting for the still', async () => {
    now = T0 + 1000;
    const s = new AnalyticsService({
      catalog: c, log, cams: () => ['cam1'], dataDir: dir,
      config: () => config,
      secrets: () => ({ googleVisionKey: 'k-123456789012', googleVisionUrl: 'http://mock' }),
      readStill: async (_cam, ts) => stills.get(ts),
      listStills: (_cam, from, to) => [...stills.keys()].filter((t) => t >= from && t <= to).sort((a, b) => a - b),
      timeInfo: () => chicago,
      now: () => now,
      sleep: async (ms) => { now += ms; config.analytics.googleVision.enabled = false; still(T0 + 1000, 5); },
      provider: () => provider,
    });
    const e = event('person');
    s.onEvent(e);
    await s.idle();
    expect(calls).toEqual([]);
    expect(analysisFor(c, e.id)).toBeUndefined();
  });

  // Final review, finding 4: stills sit on slot boundaries, events carry ms.
  it('does not wait the full deadline when an event at +300 ms has stills at whole seconds', async () => {
    now = T0 + 1300;
    still(T0 + 1000, 4);
    const s = new AnalyticsService({
      catalog: c, log, cams: () => ['cam1'], dataDir: dir,
      config: () => config,
      secrets: () => ({ googleVisionKey: 'k-123456789012', googleVisionUrl: 'http://mock' }),
      readStill: async (_cam, ts) => stills.get(ts),
      listStills: (_cam, from, to) => [...stills.keys()].filter((t) => t >= from && t <= to).sort((a, b) => a - b),
      timeInfo: () => chicago,
      now: () => now,
      sleep: async (ms) => { now += ms; if (now >= T0 + 2000) still(T0 + 2000, 6); },
      provider: () => provider,
    });
    const e = event('person', T0 + 300);
    s.onEvent(e);
    await s.idle();
    expect(now - (T0 + 1300)).toBeLessThan(2000);
    expect(analysisFor(c, e.id)).toMatchObject({ status: 'ok', still_ts: T0 + 1000 });
  });

  it('stores the summary with the analysis and counts unmapped objects', async () => {
    still(T0 + 1000, 7);
    const mixed: AnalyticsProvider = {
      id: 'google-vision', name: 'Google Vision',
      async analyze() {
        return { objects: [
          { mid: '/m/03ldnb', name: 'Ceiling fan', score: 0.9, box: { x0: 0.1, y0: 0.3, x1: 0.3, y1: 0.5 } },
          { mid: '/m/01g317', name: 'Person', score: 0.74, box: { x0: 0.16, y0: 0.62, x1: 0.23, y1: 0.99 } },
          { mid: '/m/01g317', name: 'Person', score: 0.65, box: { x0: 0.16, y0: 0.62, x1: 0.23, y1: 0.99 } },
        ], raw: {} };
      },
    };
    const s2 = new AnalyticsService({ ...deps(), provider: () => mixed });
    const e = event('person');
    s2.onEvent(e);
    await s2.idle();
    const a = analysisFor(c, e.id)!;
    expect(JSON.parse(a.summary!)).toEqual([{ category: 'person', subtype: 'person', score: 0.74, box: { x0: 0.16, y0: 0.62, x1: 0.23, y1: 0.99 } }]);
    expect(listUnmapped(c)).toEqual([expect.objectContaining({ mid: '/m/03ldnb', name: 'Ceiling fan', count: 1 })]);
  });

  it('the message carries the event kind, start, a null end while open, the still time and the summary', async () => {
    still(T0 + 1000, 7);
    const s = service();
    const e = event('person');
    s.onEvent(e);
    await s.idle();
    const m = log.since(0, { types: ['analysis'] }, 10)[0].data;
    expect(m).toMatchObject({ eventId: e.id, kind: 'person', start: T0, end: null, status: 'ok', stillTs: T0 + 1000, summary: [expect.objectContaining({ category: 'person' })] });
    expect(Array.isArray(m.objects)).toBe(true);
  });

  // Issue #56: an event that ended before its result came has its end in the message.
  it('the message carries the end of an event that has already closed', async () => {
    still(T0 + 1000, 7);
    const s = service();
    const e = event('person');
    closeEvent(c, e.id, T0 + 2500, 'state');
    s.onEvent(e);
    await s.idle();
    expect(log.since(0, { types: ['analysis'] }, 10)[0].data).toMatchObject({ eventId: e.id, start: T0, end: T0 + 2500, status: 'ok' });
  });

  it('a skipped analysis gets an empty summary and counts nothing as unmapped', async () => {
    config.analytics.googleVision.monthlyLimit = 0;
    still(T0 + 1000, 7);
    const s = service();
    const e = event('person');
    s.onEvent(e);
    await s.idle();
    expect(analysisFor(c, e.id)).toMatchObject({ status: 'skipped', summary: '[]' });
    expect(log.since(0, { types: ['analysis'] }, 10)[0].data.summary).toEqual([]);
    expect(listUnmapped(c)).toEqual([]);
  });

  it('backfills summaries of older analyses by name, and the backfill counts nothing as unmapped', () => {
    const e = event('person');
    saveAnalysis(c, { event_id: e.id, provider: 'google-vision', status: 'ok', reason: null, still_ts: T0 + 1000, image: null, requested_at: T0, took_ms: 300,
      objects: JSON.stringify([{ name: 'Ceiling fan', score: 0.9, box: { x0: 0, y0: 0, x1: 0.1, y1: 0.1 } }, { name: 'Person', score: 0.7, box: { x0: 0.2, y0: 0.2, x1: 0.4, y1: 0.9 } }]),
      raw: '{}', summary: null });
    const s = service();
    expect(s.backfillSummaries()).toBe(1);
    expect(JSON.parse(analysisFor(c, e.id)!.summary!)).toEqual([expect.objectContaining({ category: 'person', subtype: 'person', score: 0.7 })]);
    expect(listUnmapped(c)).toEqual([]);
    expect(s.backfillSummaries()).toBe(0);
  });

  it('backfill: a row whose stored objects are not an array gets [] and does not block later rows', () => {
    const mk = (objects: string) => {
      const e = event('person');
      saveAnalysis(c, { event_id: e.id, provider: 'google-vision', status: 'ok', reason: null, still_ts: T0 + 1000, image: null, requested_at: T0, took_ms: 300, objects, raw: '{}', summary: null });
      return e.id;
    };
    const a = mk('null'), b = mk('{}'), good = mk(JSON.stringify([{ name: 'Person', score: 0.7, box: { x0: 0.2, y0: 0.2, x1: 0.4, y1: 0.9 } }]));
    expect(service().backfillSummaries()).toBe(3);
    expect(analysisFor(c, a)!.summary).toBe('[]');
    expect(analysisFor(c, b)!.summary).toBe('[]');
    expect(JSON.parse(analysisFor(c, good)!.summary!)).toHaveLength(1);
  });

  it('store: a failing unmapped count cannot swallow the stream message', async () => {
    c.db.exec('DROP TABLE analytics_unmapped');
    still(T0 + 1000, 7);
    const s2 = new AnalyticsService({ ...deps(), provider: () => ({ id: 'google-vision', name: 'Google Vision', async analyze() { return { objects: [{ mid: '/m/03ldnb', name: 'Ceiling fan', score: 0.9, box: { x0: 0, y0: 0, x1: 0.1, y1: 0.1 } }], raw: {} }; } }) });
    const e = event('person');
    s2.onEvent(e);
    await s2.idle();
    expect(analysisFor(c, e.id)).toMatchObject({ status: 'ok' });
    expect(log.since(0, { types: ['analysis'] }, 10)).toHaveLength(1);
  });
});

// Issue #70: a key set at runtime (Settings page), kept in memory only.
describe('a manual key', () => {
  const ENV_KEY = 'AIzaSyEnvKey000000000aBcD';
  const MANUAL = 'AIzaSyManualKey0000000wXyZ';
  const keyed = (envKey: string) => {
    const used: string[] = [];
    const s = new AnalyticsService({ ...deps({ key: envKey }), provider: (_id, key) => (used.push(key), provider) });
    return { s, used };
  };

  it('replaces the env key at once: the next call uses it, the state reports manual and the masked key', async () => {
    still(T0 + 1000, 7);
    still(T0 + 61_000, 7);
    const { s, used } = keyed(ENV_KEY);
    expect(s.state()[0]).toMatchObject({ keySource: 'env', keyMasked: 'AIza…aBcD' });
    s.onEvent(event('person'));
    await s.idle();
    expect(s.setManualKey(MANUAL)).toBe('env');
    expect(s.state()[0]).toMatchObject({ keySource: 'manual', keyMasked: 'AIza…wXyZ' });
    s.onEvent(event('person', T0 + 60_000));
    await s.idle();
    expect(used).toEqual([ENV_KEY, MANUAL]);
    expect(JSON.stringify(s.state())).not.toContain(MANUAL);
  });

  // Issue #52: the retry after its wait reads the key again.
  it('a key set during the retry wait is the one the retry call uses', async () => {
    still(T0 + 1000, 7);
    answers = [new AnalyticsError('network', true)];
    const used: string[] = [];
    let s!: AnalyticsService;
    s = new AnalyticsService({ ...deps({ key: ENV_KEY }), sleep: async (ms) => { now += ms; s.setManualKey(MANUAL); }, provider: (_id, key) => (used.push(key), provider) });
    s.onEvent(event('person'));
    await s.idle();
    expect(used).toEqual([ENV_KEY, MANUAL]);
  });

  it('replaces an earlier manual key, and gives a proxy without a key one', async () => {
    still(T0 + 1000, 7);
    const { s, used } = keyed('');
    expect(s.state()[0]).toMatchObject({ keySource: 'none', keyMasked: null });
    expect(s.setManualKey(MANUAL)).toBe('none');
    expect(s.setManualKey(ENV_KEY)).toBe('manual');
    expect(s.state()[0]).toMatchObject({ keySource: 'manual', keyMasked: 'AIza…aBcD' });
    s.onEvent(event('person'));
    await s.idle();
    expect(used).toEqual([ENV_KEY]);
  });

  // Review of #70: a call with the old key that fails after the new key is set must not pause the new one.
  it('a bad_key answer to a call made with the previous key does not pause the new key', async () => {
    still(T0 + 1000, 7);
    let release!: (e: AnalyticsError) => void;
    let started!: () => void;
    const inFlight = new Promise<void>((r) => (started = r));
    const gated: AnalyticsProvider = {
      id: 'google-vision', name: 'Google Vision',
      analyze: () => new Promise((_ok, fail) => { release = fail; started(); }),
    };
    const s = new AnalyticsService({ ...deps({ key: ENV_KEY }), provider: () => gated });
    s.onEvent(event('person'));
    await inFlight;
    s.setManualKey(MANUAL);
    release(new AnalyticsError('bad_key', false, 'bad_key'));
    await s.idle();
    expect(s.state()[0]).toMatchObject({ keySource: 'manual', paused: null, lastError: null });
  });

  it('lifts a bad_key pause, not a quota pause', async () => {
    still(T0 + 1000, 7);
    still(T0 + 61_000, 7);
    answers = [new AnalyticsError('bad_key', false, 'bad_key'), 'ok'];
    const { s, used } = keyed(ENV_KEY);
    s.onEvent(event('person'));
    await s.idle();
    expect(s.state()[0].paused).toMatchObject({ reason: 'bad_key' });
    expect(s.state()[0].lastError).toBe('bad_key');
    s.setManualKey(MANUAL);
    expect(s.state()[0]).toMatchObject({ paused: null, lastError: null });
    const b = event('person', T0 + 60_000);
    s.onEvent(b);
    await s.idle();
    expect(analysisFor(c, b.id)).toMatchObject({ status: 'ok' });
    expect(used).toEqual([ENV_KEY, MANUAL]);

    answers = [new AnalyticsError('quota', false, 'quota')];
    still(T0 + 121_000, 7);
    s.onEvent(event('person', T0 + 120_000));
    await s.idle();
    s.setManualKey(ENV_KEY);
    expect(s.state()[0].paused).toMatchObject({ reason: 'quota' });
  });
});

// #75: a recovered event (from the SD card) is never sent to Vision (a paid call).
describe('recovered events and analytics', () => {
  it('neither catchUp() nor the live stream-log listener queues a recovered event', async () => {
    still(T0 + 1000, 7);
    const s = new AnalyticsService({
      ...deps(),
      provider: () => ({ id: 'google-vision', name: 'Google Vision', analyze: async () => expect.fail('Vision was called for a recovered event') }),
    });
    // The proxy's wiring (src/proxy.ts): every camera-event start goes to the service.
    const heard: StreamMessage[] = [];
    log.on('message', (m: StreamMessage) => {
      heard.push(m);
      if (m.type === 'camera-event' && m.data.phase === 'start') s.onEvent({ cam: m.cam, id: Number(m.data.eventId), kind: String(m.data.kind), start_ts: Number(m.data.ts) });
    });
    const { added } = addRecoveredEvents(c, 'cam1', [{ kind: 'person', start_ts: T0, end_ts: T0 + 30_000, raw: null }], { beforeMs: 10_000, afterMs: 5_000, openMs: 600_000 });
    expect(added).toHaveLength(1);
    s.catchUp();
    await s.idle();
    expect(heard).toEqual([]); // the repair writes nothing to the stream log
    expect(analysisFor(c, added[0].id)).toBeUndefined();
    expect(s.state()[0].month.calls).toBe(0);
  });
});

// Automatic analyses are audited (Klaus 2026-10-05): one `event-analysis`
// record per event that made a Vision call, user system; skips write nothing.
describe('audit records of automatic analyses', () => {
  type Written = { action: string; outcome: string; user?: string; message: string; error?: string; category: string[]; type: string[]; details?: Record<string, unknown> };
  let written: Written[];
  const audited = () => new AnalyticsService({ ...deps(), audit: { write: (i: Written) => void written.push(i) } } as AnalyticsDeps);
  beforeEach(() => (written = []));

  it('writes one success record with the event, the still, the time taken and what was found', async () => {
    still(T0 + 1000, 7);
    const s = audited();
    const e = event('person');
    s.onEvent(e);
    await s.idle();
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({
      action: 'event-analysis', category: ['host'], type: ['access'], outcome: 'success', user: 'system',
      details: { cam: 'cam1', eventId: e.id, kind: 'person', stillTs: T0 + 1000, outcome: 'ok', reason: null, calls: 1, tookMs: 0, found: ['person'] },
    });
    expect(written[0].message).toBe(`Vision on event ${e.id} (person): person 80%`);
  });

  it('writes one failure record after the retry, with both calls counted', async () => {
    still(T0 + 1000, 7);
    answers = [new AnalyticsError('timeout', true), new AnalyticsError('timeout', true)];
    const s = audited();
    const e = event('person');
    s.onEvent(e);
    await s.idle();
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({ action: 'event-analysis', outcome: 'failure', user: 'system', error: 'timeout', details: { eventId: e.id, outcome: 'failed', reason: 'timeout', calls: 2, found: [] } });
    expect(written[0].message).toBe(`Vision on event ${e.id} (person) failed: timeout`);
  });

  it('a retry that succeeds is one success record with two calls', async () => {
    still(T0 + 1000, 7);
    answers = [new AnalyticsError('network', true), 'ok'];
    const s = audited();
    s.onEvent(event('person'));
    await s.idle();
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({ outcome: 'success', details: { outcome: 'ok', calls: 2 } });
  });

  it('writes nothing for a skip (no still, the limit, a pause): no call was made', async () => {
    config.analytics.googleVision = { enabled: true, monthlyLimit: 0, dailyCap: 0, checksPerDay: 10, perCameraDailyCap: 0 };
    still(T0 + 1000, 7);
    const s = audited();
    s.onEvent(event('person')); // the limit
    s.onEvent(event('person', T0 + 600_000)); // no still
    await s.idle();
    expect(calls).toHaveLength(0);
    expect(written).toEqual([]);
  });

  it('records a paid call whose event went during the call', async () => {
    still(T0 + 1000, 7);
    const s = new AnalyticsService({ ...deps(), audit: { write: (i: Written) => void written.push(i) }, provider: () => ({ id: 'google-vision', name: 'Google Vision', async analyze() {
      deleteEventsBefore(c, T0 + 1);
      return { objects: [], raw: {} };
    } }) } as AnalyticsDeps);
    const e = event('person');
    s.onEvent(e);
    await s.idle();
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({ outcome: 'success', details: { eventId: e.id, outcome: 'ok', calls: 1, found: [] } });
    expect(written[0].message).toBe(`Vision on event ${e.id} (person): nothing relevant`);
  });
});
