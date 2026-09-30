// test/analytics-service.test.ts
import { beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { openCatalog, type Catalog } from '../src/catalog/db';
import { deleteEventsBefore, insertEvent } from '../src/catalog/events';
import { analysisFor } from '../src/catalog/analyses';
import { StreamLog } from '../src/stream/log';
import { DEFAULTS, type Config } from '../src/config/defaults';
import { AnalyticsService } from '../src/analytics/service';
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

function service(over: { key?: string } = {}) {
  return new AnalyticsService({
    catalog: c, log, cam: 'cam1', dataDir: dir,
    config: () => config,
    secrets: () => ({ googleVisionKey: over.key ?? 'k-123456789012', googleVisionUrl: 'http://mock' }),
    readStill: async (ts) => stills.get(ts),
    listStills: (from, to) => [...stills.keys()].filter((t) => t >= from && t <= to).sort((a, b) => a - b),
    timeInfo: () => chicago,
    now: () => now,
    sleep: async (ms) => void (now += ms),
    provider: () => provider,
  });
}
const event = (kind: string, start_ts = T0) => insertEvent(c, { cam: 'cam1', source: 'onvif', kind, start_ts, raw: null });
const still = (ts: number, byte: number) => stills.set(ts, Buffer.from([byte, 0xd8]));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'camproxy-svc-'));
  c = openCatalog(join(dir, 'catalog.sqlite'));
  log = new StreamLog(c, () => now);
  now = T0 + 3000;
  config = structuredClone(DEFAULTS);
  config.analytics.googleVision = { enabled: true, monthlyLimit: 100, dailyCap: 0 };
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
    config.analytics.googleVision = { enabled: true, monthlyLimit: 2, dailyCap: 1 };
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
    config.analytics.googleVision = { enabled: true, monthlyLimit: 1, dailyCap: 0 };
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
    expect(analysisFor(c, e.id)).toBeUndefined();
    expect(existsSync(join(dir, 'analytics', 'cam1', `${e.id}.jpg`))).toBe(false); // its image copy is removed too
    expect(log.since(0, { types: ['analysis'] }, 10)).toEqual([]); // and nothing is announced
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
      catalog: c, log, cam: 'cam1', dataDir: dir,
      config: () => config,
      secrets: () => ({ googleVisionKey: 'k-123456789012', googleVisionUrl: 'http://mock' }),
      readStill: async (ts) => stills.get(ts),
      listStills: (from, to) => [...stills.keys()].filter((t) => t >= from && t <= to).sort((a, b) => a - b),
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
});
