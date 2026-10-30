import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/load';
import { DEFAULTS, type Config } from '../src/config/defaults';
import { dstBounds } from '../src/camera/time';
import { proxyZone, zoneRule } from '../src/onboarding/zone';

// The camera's zone and DST rule from an IANA zone (spec 2026-10-30-camera-onboarding-design §4.7).
describe('zone rules', () => {
  it.each([
    ['America/Chicago', -360, { startMon: 3, startWeek: 2, startWeekday: 0, startHour: 2, startMin: 0, endMon: 11, endWeek: 1, endWeekday: 0, endHour: 2, endMin: 0, offsetHours: 1 }],
    ['Europe/Berlin', 60, { startMon: 3, startWeek: 5, startWeekday: 0, startHour: 2, startMin: 0, endMon: 10, endWeek: 5, endWeekday: 0, endHour: 3, endMin: 0, offsetHours: 1 }],
    ['Australia/Sydney', 600, { startMon: 10, startWeek: 1, startWeekday: 0, startHour: 2, startMin: 0, endMon: 4, endWeek: 1, endWeekday: 0, endHour: 3, endMin: 0, offsetHours: 1 }],
    ['Asia/Tokyo', 540, null],
  ])('zoneRule(%s, 2026)', (zone, std, dst) => expect(zoneRule(zone as string, 2026)).toEqual({ stdOffsetMinutes: std, dst }));

  it('the rule gives the zone\'s own change instants', () => {
    const r = zoneRule('Europe/Berlin', 2027);
    if (r === 'unsupported' || !r.dst) throw new Error('expected a DST rule');
    expect(dstBounds(2027, r.dst, r.stdOffsetMinutes, r.dst.offsetHours * 60)).toEqual([Date.UTC(2027, 2, 28, 1), Date.UTC(2027, 9, 31, 1)]);
  });

  it('a half-hour DST shift or an unknown zone is unsupported', () => {
    expect(zoneRule('Australia/Lord_Howe', 2026)).toBe('unsupported');
    expect(zoneRule('Mars/Olympus', 2026)).toBe('unsupported');
  });
});

describe('the proxy zone', () => {
  const cfg = (zone?: string) => ({ ...structuredClone(DEFAULTS), time: zone ? { zone } : {} }) as unknown as Config;
  it('proxyZone: the setting, else TZ, else unknown on a UTC host', () => {
    expect(proxyZone(cfg('Europe/Berlin'), { TZ: 'America/Chicago' }, () => 'Asia/Tokyo')).toBe('Europe/Berlin');
    expect(proxyZone(cfg(), { TZ: 'America/Chicago' }, () => 'UTC')).toBe('America/Chicago');
    expect(proxyZone(cfg(), {}, () => 'Asia/Tokyo')).toBe('Asia/Tokyo');
    expect(proxyZone(cfg(), {}, () => 'UTC')).toBeNull();
    expect(proxyZone(cfg(), {}, () => 'Etc/UTC')).toBeNull();
    expect(proxyZone(cfg(), { TZ: 'not/a-zone' }, () => 'UTC')).toBeNull();
  });
});

describe('the time.zone setting', () => {
  it('takes an IANA zone the runtime knows; anything else does not load', () => {
    const load = (zone: string) => {
      const dir = mkdtempSync(join(tmpdir(), 'onb-zone-'));
      writeFileSync(join(dir, 'config.json'), JSON.stringify({ camera: { host: '192.0.2.10' }, time: { zone } }));
      return loadConfig({ CAMPROXY_TOKENS: 'a'.repeat(40), CAMPROXY_ADMIN_TOKEN: 'b'.repeat(40), CAMPROXY_CAMERA_PASSWORD: 'x' }, { cwd: dir });
    };
    expect(load('Europe/Berlin').config.time.zone).toBe('Europe/Berlin');
    expect(() => load('Mars/Olympus')).toThrow(/time\.zone/);
  });
});
