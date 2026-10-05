import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { openCatalog } from '../src/catalog/db';
import { analysisFor, usageByCamera } from '../src/catalog/analyses';
import { insertEvent } from '../src/catalog/events';
import { checkAt } from '../src/catalog/still-checks';
import { DEFAULTS } from '../src/config/defaults';
import { AnalyticsService } from '../src/analytics/service';
import { localDay } from '../src/analytics/local-day';
import { StreamLog } from '../src/stream/log';

const T0 = Date.parse('2026-10-05T15:00:00Z');

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'camproxy-amulti-'));
  const c = openCatalog(join(dir, 'catalog.sqlite'));
  let now = T0 + 3000;
  const log = new StreamLog(c, () => now);
  const config = structuredClone(DEFAULTS);
  config.analytics.googleVision = { enabled: true, monthlyLimit: 100, dailyCap: 0, checksPerDay: 10, perCameraDailyCap: 0 };
  // cam3 has a still at T0+1000 (byte 3), cam4 at the same time (byte 4).
  const stills: Record<string, Map<number, Buffer>> = { cam3: new Map([[T0 + 1000, Buffer.from([3])]]), cam4: new Map([[T0 + 1000, Buffer.from([4])]]) };
  const seen: number[] = [];
  const s = new AnalyticsService({
    catalog: c, log, dataDir: dir,
    cams: () => ['cam3', 'cam4'],
    kinds: (cam) => (cam === 'cam4' ? { person: false, vehicle: true, pet: false } : config.analytics.kinds),
    config: () => config,
    secrets: () => ({ googleVisionKey: 'k-123456789012', googleVisionUrl: 'http://mock' }),
    readStill: async (cam, ts) => stills[cam]?.get(ts),
    listStills: (cam, from, to) => [...(stills[cam]?.keys() ?? [])].filter((t) => t >= from && t <= to),
    timeInfo: () => undefined,
    now: () => now,
    sleep: async (ms) => void (now += ms),
    provider: () => ({ id: 'google-vision', name: 'Google Vision', async analyze(jpeg) { seen.push(jpeg[0]); return { objects: [], raw: {} }; } }),
  });
  return { c, s, seen, log, day: localDay(now, undefined) };
}

describe('analytics with several cameras (spec §8.2, §5.1)', () => {
  it("analyses each camera's event with its own still and counts the call for that camera", async () => {
    const { c, s, seen, day } = setup();
    const e3 = insertEvent(c, { cam: 'cam3', source: 'onvif', kind: 'person', start_ts: T0, raw: null });
    const e4 = insertEvent(c, { cam: 'cam4', source: 'onvif', kind: 'vehicle', start_ts: T0, raw: null });
    s.onEvent(e3);
    s.onEvent(e4);
    await s.idle();
    expect(seen).toEqual([3, 4]);
    expect(analysisFor(c, e3.id)?.status).toBe('ok');
    expect(analysisFor(c, e4.id)?.status).toBe('ok');
    expect(usageByCamera(c, 'google-vision', day, day)).toEqual({ cam3: 1, cam4: 1 });
  });

  it("follows each camera's kinds: cam4 does not analyse persons", async () => {
    const { c, s, seen } = setup();
    s.onEvent(insertEvent(c, { cam: 'cam4', source: 'onvif', kind: 'person', start_ts: T0, raw: null }));
    await s.idle();
    expect(seen).toEqual([]);
  });

  it('a still check runs on the camera asked for', async () => {
    const { c, s, seen } = setup();
    const r = await s.check('cam4', T0 + 1000, 'token');
    expect(r.outcome).toBe('ok');
    expect(seen).toEqual([4]);
    expect(checkAt(c, 'cam4', T0 + 1000)).toBeDefined();
    expect(checkAt(c, 'cam3', T0 + 1000)).toBeUndefined();
  });
});
