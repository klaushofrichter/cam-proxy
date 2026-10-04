// Still checks in the analytics service (cams #179, spec 2026-10-04-still-checks-design §2).
import { beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { openCatalog, type Catalog } from '../src/catalog/db';
import { insertEvent } from '../src/catalog/events';
import { addUsage, analysisFor, listUnmapped, saveAnalysis, usageBetween } from '../src/catalog/analyses';
import { checkAt, checkById } from '../src/catalog/still-checks';
import { StreamLog } from '../src/stream/log';
import { DEFAULTS, type Config } from '../src/config/defaults';
import { AnalyticsService, type AnalyticsDeps } from '../src/analytics/service';
import { AnalyticsError, type AnalyticsProvider } from '../src/analytics/providers';

const T0 = Date.parse('2026-10-04T15:00:00Z'); // UTC day 2026-10-04 (no camera time info)
const DAY = '2026-10-04';
let c: Catalog;
let log: StreamLog;
let now: number;
let config: Config;
let stills: Map<number, Buffer>;
let calls: number[];
let answers: Array<'ok' | AnalyticsError>;
let dir: string;
let gate: Promise<void> | null; // holds the provider's answer while set

const PERSON = { mid: '/m/01g317', name: 'Person', score: 0.84, box: { x0: 0.1, y0: 0.1, x1: 0.5, y1: 0.9 } };
const FAN = { mid: '/m/0fan', name: 'Ceiling fan', score: 0.6, box: { x0: 0, y0: 0, x1: 0.2, y1: 0.2 } };
const provider: AnalyticsProvider = {
  id: 'google-vision',
  name: 'Google Vision',
  async analyze(jpeg, signal) {
    calls.push(jpeg[0]);
    if (gate) {
      await Promise.race([gate, new Promise((_, rej) => signal.addEventListener('abort', () => rej(new AnalyticsError('timeout', true))))]);
    }
    const a = answers.length > 1 ? answers.shift()! : (answers[0] ?? 'ok');
    if (a !== 'ok') throw a;
    now += 600;
    return { objects: [PERSON, FAN], raw: { n: 2 } };
  },
};

function deps(over: { key?: string } = {}): AnalyticsDeps {
  return {
    catalog: c, log, cam: 'cam1', dataDir: dir,
    config: () => config,
    secrets: () => ({ googleVisionKey: over.key ?? 'k-123456789012', googleVisionUrl: 'http://mock' }),
    readStill: async (ts) => stills.get(ts),
    listStills: (from, to) => [...stills.keys()].filter((t) => t >= from && t <= to).sort((a, b) => a - b),
    timeInfo: () => undefined,
    now: () => now,
    sleep: async (ms) => void (now += ms),
    provider: () => provider,
  };
}
const service = (over: { key?: string } = {}) => new AnalyticsService(deps(over));
const still = (ts: number, byte: number) => stills.set(ts, Buffer.from([byte, 0xd8]));
const usage = (p: string) => usageBetween(c, p, DAY, DAY);
const AT = T0 - 60_000;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'camproxy-checks-'));
  c = openCatalog(join(dir, 'catalog.sqlite'));
  log = new StreamLog(c, () => now);
  now = T0;
  config = structuredClone(DEFAULTS);
  config.analytics.googleVision = { enabled: true, monthlyLimit: 100, dailyCap: 0, checksPerDay: 10 };
  stills = new Map();
  calls = [];
  answers = [];
  gate = null;
});

describe('AnalyticsService.check', () => {
  it('calls Vision for the still, stores the check with its JPEG (named by the row id), announces it and counts it', async () => {
    still(AT, 7);
    const e = insertEvent(c, { cam: 'cam1', source: 'onvif', kind: 'person', start_ts: AT - 2000, raw: null });
    const r = await service().check(AT, 'token');
    expect(r).toMatchObject({ outcome: 'ok', tookMs: 600 });
    if (r.outcome !== 'ok') throw new Error('not ok');
    const row = checkById(c, r.row.id)!;
    expect(row).toMatchObject({ cam: 'cam1', still_ts: AT, provider: 'google-vision', requested_via: 'token', took_ms: 600, image: join(dir, 'analytics', 'cam1', `check-${row.id}.jpg`) });
    expect(readFileSync(row.image!)).toEqual(Buffer.from([7, 0xd8]));
    expect(JSON.parse(row.summary)).toEqual([{ category: 'person', subtype: 'person', score: 0.84, box: PERSON.box }]);
    expect(JSON.parse(row.objects)).toHaveLength(2);
    expect(JSON.parse(row.raw!)).toEqual({ n: 2 });
    const msgs = log.since(0, { types: ['still-check'] }, 10);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].data).toMatchObject({ id: row.id, stillTs: AT, provider: 'google-vision', summary: [expect.objectContaining({ category: 'person' })], objects: expect.any(Array), events: [{ id: e.id, kind: 'person', confirmed: true }], imageUrl: `/api/cameras/cam1/still-checks/${row.id}.jpg` });
    expect(usage('google-vision')).toBe(1); // the shared budget
    expect(usage('google-vision:check')).toBe(1);
    expect(listUnmapped(c).map((u) => u.name)).toEqual(['Ceiling fan']); // counted like the automatic ones
    expect(analysisFor(c, e.id)).toBeUndefined(); // never an event's analysis
  });

  it('answers the stored check for the same second again: no call, counted as reused', async () => {
    still(AT, 7);
    const s = service();
    const first = await s.check(AT, 'token');
    const again = await s.check(AT, 'session');
    expect(again).toMatchObject({ outcome: 'reused', source: 'check' });
    if (again.outcome !== 'reused' || again.source !== 'check' || first.outcome !== 'ok') throw new Error('shape');
    expect(again.row.id).toBe(first.row.id);
    expect(calls).toHaveLength(1);
    expect(usage('google-vision:check-reused')).toBe(1);
    // Reused even when Vision was switched off meanwhile: a stored answer costs nothing.
    config.analytics.googleVision.enabled = false;
    expect((await s.check(AT, 'token')).outcome).toBe('reused');
  });

  it("answers a second the automatic analysis sent from that analysis (source event), with no call and no row", async () => {
    still(AT, 7);
    const e = insertEvent(c, { cam: 'cam1', source: 'onvif', kind: 'person', start_ts: AT - 1000, raw: null });
    saveAnalysis(c, { event_id: e.id, provider: 'google-vision', status: 'ok', reason: null, still_ts: AT, image: '/x.jpg', requested_at: AT, took_ms: 500, objects: '[]', raw: '{}', summary: '[]' });
    const f = insertEvent(c, { cam: 'cam1', source: 'onvif', kind: 'person', start_ts: AT + 9000, raw: null });
    saveAnalysis(c, { event_id: f.id, provider: 'google-vision', status: 'skipped', reason: 'limit', still_ts: AT + 10_000, image: null, requested_at: AT, took_ms: null, objects: null, raw: null, summary: '[]' });
    still(AT + 10_000, 8);
    const r = await service().check(AT, 'token');
    expect(r).toMatchObject({ outcome: 'reused', source: 'event', analysis: { event_id: e.id } });
    expect(checkAt(c, 'cam1', AT)).toBeUndefined();
    // A skipped analysis is no answer: that second gets a call.
    expect((await service().check(AT + 10_000, 'token')).outcome).toBe('ok');
    expect(calls).toHaveLength(1);
  });

  it('refuses in order: off, no key, checks off (409), no still (404), paused (503), month, day, checks (429)', async () => {
    still(AT, 7);
    config.analytics.googleVision.enabled = false;
    expect(await service().check(AT, 'token')).toEqual({ outcome: 'refused', status: 409, error: 'analytics_off', reason: 'off' });
    config.analytics.googleVision.enabled = true;
    expect(await service({ key: '' }).check(AT, 'token')).toEqual({ outcome: 'refused', status: 409, error: 'analytics_off', reason: 'no_key' });
    config.analytics.googleVision.checksPerDay = 0;
    expect(await service().check(AT, 'token')).toEqual({ outcome: 'refused', status: 409, error: 'analytics_off', reason: 'checks_off' });
    config.analytics.googleVision.checksPerDay = 10;
    expect(await service().check(AT + 1000, 'token')).toEqual({ outcome: 'refused', status: 404, error: 'no_still' });

    const s = service();
    answers = [new AnalyticsError('quota', false, 'quota'), 'ok'];
    expect(await s.check(AT, 'token')).toMatchObject({ outcome: 'failed', reason: 'quota', cost: 1 });
    expect(await s.check(AT, 'token')).toEqual({ outcome: 'refused', status: 503, error: 'analytics_paused', reason: 'quota', until: now + 3_600_000 });
    now += 3_600_000;

    config.analytics.googleVision.monthlyLimit = 1; // the failed call counted
    expect(await s.check(AT, 'token')).toEqual({ outcome: 'refused', status: 429, error: 'limit', reason: 'month' });
    config.analytics.googleVision.monthlyLimit = 100;
    config.analytics.googleVision.dailyCap = 1;
    expect(await s.check(AT, 'token')).toEqual({ outcome: 'refused', status: 429, error: 'limit', reason: 'day' });
    config.analytics.googleVision.dailyCap = 0;
    config.analytics.googleVision.checksPerDay = 1;
    expect(await s.check(AT, 'token')).toEqual({ outcome: 'refused', status: 429, error: 'limit', reason: 'checks' });
    expect(calls).toHaveLength(1);
    // Every refusal but no_still is counted; no_still is a 404 like a bad request.
    expect(usage('google-vision:check-refused')).toBe(7);
    expect(usage('google-vision:check-failed')).toBe(1);
  });

  it('the checks cap counts checks only; automatic calls count toward month and day but not toward it', async () => {
    still(AT, 7);
    addUsage(c, 'google-vision', DAY); // three automatic calls today
    addUsage(c, 'google-vision', DAY);
    addUsage(c, 'google-vision', DAY);
    config.analytics.googleVision.checksPerDay = 1;
    expect((await service().check(AT, 'token')).outcome).toBe('ok');
    expect(service().usage()).toEqual({ enabled: true, paused: null, month: { calls: 4, limit: 100 }, today: { calls: 4, cap: 0 }, checks: { today: 1, cap: 1 } });
  });

  it('one call at a time: another second is busy (429); the same second joins the call', async () => {
    still(AT, 7);
    still(AT + 1000, 8);
    const s = service();
    let open!: () => void;
    gate = new Promise<void>((r) => (open = r));
    const first = s.check(AT, 'token');
    await new Promise((r) => setTimeout(r, 0));
    expect(await s.check(AT + 1000, 'token')).toEqual({ outcome: 'refused', status: 429, error: 'busy' });
    const joined = s.check(AT, 'session');
    open();
    expect((await first).outcome).toBe('ok');
    expect(await joined).toMatchObject({ outcome: 'reused', source: 'check', joined: true });
    expect(calls).toHaveLength(1);
    // Free again.
    gate = null;
    expect((await s.check(AT + 1000, 'token')).outcome).toBe('ok');
  });

  it('a timeout is not retried (the user is waiting); it is counted and stores nothing', async () => {
    still(AT, 7);
    answers = [new AnalyticsError('timeout', true), 'ok'];
    const s = service();
    const before = now;
    expect(await s.check(AT, 'token')).toMatchObject({ outcome: 'failed', reason: 'timeout', cost: 1 });
    expect(now - before).toBeLessThan(30_000);
    expect(calls).toHaveLength(1);
    expect(checkAt(c, 'cam1', AT)).toBeUndefined();
    expect(usage('google-vision')).toBe(1);
    expect(s.state()[0].lastCall).toMatchObject({ status: 'timeout' });
    // Trying again later is possible.
    expect((await s.check(AT, 'token')).outcome).toBe('ok');
  });

  it("a bad key from a check pauses the automatic analyses too", async () => {
    still(AT, 7);
    still(AT + 61_000, 7);
    answers = [new AnalyticsError('bad_key', false, 'bad_key')];
    const s = service();
    expect(await s.check(AT, 'token')).toMatchObject({ outcome: 'failed', reason: 'bad_key' });
    expect(s.state()[0].paused).toEqual({ reason: 'bad_key', until: null });
    const e = insertEvent(c, { cam: 'cam1', source: 'onvif', kind: 'person', start_ts: AT + 60_000, raw: null });
    s.onEvent(e);
    await s.idle();
    expect(analysisFor(c, e.id)).toMatchObject({ status: 'skipped', reason: 'paused' });
  });

  it('stop() aborts a running check: counted, not stored, answered aborted', async () => {
    still(AT, 7);
    const s = service();
    gate = new Promise<void>(() => undefined); // never answers by itself
    const r = s.check(AT, 'token');
    await new Promise((x) => setTimeout(x, 0));
    await s.stop();
    expect(await r).toMatchObject({ outcome: 'failed', reason: 'aborted', cost: 1 });
    expect(checkAt(c, 'cam1', AT)).toBeUndefined();
    expect(usage('google-vision')).toBe(1);
    expect(await s.check(AT, 'token')).toMatchObject({ outcome: 'refused', status: 409, reason: 'off' });
  });

  it('keeps the check without an image when the copy cannot be written (the call was paid)', async () => {
    still(AT, 7);
    writeFileSync(join(dir, 'analytics'), 'a file, so mkdir fails');
    const r = await service().check(AT, 'token');
    expect(r.outcome).toBe('ok');
    expect(checkAt(c, 'cam1', AT)).toMatchObject({ image: null });
    expect(existsSync(join(dir, 'analytics', 'cam1'))).toBe(false);
    expect(log.since(0, { types: ['still-check'] }, 10)[0].data).toMatchObject({ imageUrl: null });
  });

  it('reports the checks of today in the provider state', async () => {
    still(AT, 7);
    const s = service();
    await s.check(AT, 'token');
    expect(s.state()[0]).toMatchObject({ month: { calls: 1 }, today: { calls: 1 }, checks: { today: 1, cap: 10 } });
  });
});
