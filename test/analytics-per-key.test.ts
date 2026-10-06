import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { openCatalog } from '../src/catalog/db';
import { addUsage } from '../src/catalog/analyses';
import { insertEvent } from '../src/catalog/events';
import { DEFAULTS } from '../src/config/defaults';
import { AnalyticsService } from '../src/analytics/service';
import { keyId } from '../src/analytics/key-id';
import { localDay } from '../src/analytics/local-day';
import { StreamLog } from '../src/stream/log';

const T0 = Date.parse('2026-10-05T15:00:00Z');

function setup(key: { v: string }) {
  const dir = mkdtempSync(join(tmpdir(), 'camproxy-perkey-'));
  const c = openCatalog(join(dir, 'catalog.sqlite'));
  let now = T0 + 3000;
  const config = structuredClone(DEFAULTS);
  config.analytics.googleVision = { enabled: true, monthlyLimit: 3, dailyCap: 0, checksPerDay: 10, perCameraDailyCap: 0 };
  const calls: string[] = [];
  const s = new AnalyticsService({
    catalog: c, log: new StreamLog(c, () => now), dataDir: dir, cams: () => ['cam3', 'cam4'], config: () => config,
    secrets: () => ({ googleVisionKey: key.v, googleVisionUrl: 'http://mock' }),
    // One still a second after each window's start; an exact second (a check) has its still.
    readStill: async (cam) => Buffer.from(cam), listStills: (_cam, f, t) => [f === t ? f : f + 1000],
    timeInfo: () => undefined, now: () => now, sleep: async (ms) => void (now += ms),
    provider: () => ({ id: 'google-vision', name: 'Google Vision', async analyze(j) { calls.push(j.toString()); return { objects: [], raw: {} }; } }),
  });
  const ev = (cam: string, t = T0) => insertEvent(c, { cam, source: 'onvif', kind: 'person', start_ts: t, raw: null });
  return { c, s, calls, config, ev, day: localDay(now, undefined) };
}

describe('Vision per key (spec 2026-10-05-multi-camera-host-design §8.2)', () => {
  it('a new key starts a fresh month; legacy rows ("" key) count with the key in use', async () => {
    const key = { v: 'key-one-123456789' };
    const { c, s, calls, ev, day } = setup(key);
    addUsage(c, { provider: 'google-vision', keyId: keyId('key-one-123456789'), cam: 'cam3' }, day);
    addUsage(c, { provider: 'google-vision', keyId: keyId('key-one-123456789'), cam: 'cam3' }, day);
    addUsage(c, { provider: 'google-vision', keyId: '', cam: 'cam3' }, day);
    s.onEvent(ev('cam3'));
    await s.idle();
    expect(calls).toEqual([]); // 2 + 1 legacy = the limit of 3
    key.v = 'key-two-123456789';
    s.onEvent(ev('cam4', T0 + 5000));
    await s.idle();
    expect(calls).toEqual(['cam4']); // the new key: only the legacy row counts (1 of 3)
    expect(s.state()[0].month.calls).toBe(2);
  });

  it('perCameraDailyCap limits one camera; the others go on', async () => {
    const key = { v: 'key-one-123456789' };
    const { s, calls, config, ev } = setup(key);
    config.analytics.googleVision.monthlyLimit = 100;
    config.analytics.googleVision.perCameraDailyCap = 1;
    s.onEvent(ev('cam3'));
    s.onEvent(ev('cam3', T0 + 10_000));
    s.onEvent(ev('cam4', T0 + 20_000));
    await s.idle();
    expect(calls).toEqual(['cam3', 'cam4']);
    expect(s.state()[0].cameras).toEqual([{ id: 'cam3', today: 1, month: 1 }, { id: 'cam4', today: 1, month: 1 }]);
    const r = await s.check('cam3', T0 + 1000, 'token');
    expect(r).toMatchObject({ outcome: 'refused', status: 429, error: 'limit', reason: 'camera' });
  });

  it("checksPerDay is per camera and day (the doc; 10 a day for the Pi's one camera)", async () => {
    const key = { v: 'key-one-123456789' };
    const { s, config } = setup(key);
    config.analytics.googleVision.monthlyLimit = 100;
    config.analytics.googleVision.checksPerDay = 1;
    expect((await s.check('cam3', T0 + 1000, 'token')).outcome).toBe('ok');
    expect(await s.check('cam3', T0 + 2000, 'token')).toMatchObject({ outcome: 'refused', reason: 'checks' });
    expect((await s.check('cam4', T0 + 1000, 'token')).outcome).toBe('ok');
    expect(s.usage('cam4').checks).toEqual({ today: 1, cap: 1 });
    expect(s.state()[0].checks).toEqual({ today: 2, cap: 2 }); // the host: every camera's
  });
});
