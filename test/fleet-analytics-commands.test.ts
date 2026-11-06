import { describe, expect, it } from 'vitest';
import type { ProviderState } from '../src/analytics/service';
import { analyticsHandlers } from '../src/fleet/analytics-commands';
import type { CommandBody } from '../src/fleet/command-check';
import { CommandLimits } from '../src/fleet/command-check';
import type { Done } from '../src/fleet/commands';
import { ALLOW_ENTRIES, DEFAULT_ON, ENTRY_TEXT, IMPLEMENTED } from '../src/fleet/policy';
import { ARGS_VALIDATORS } from '../src/fleet/command-args';
import { strict, why } from './helpers/contract';

// analytics.usage.get (cams-admin Vision management design 2026-11-05): the
// state of GET /control/analytics, per provider, without the key or its mask.
const KEY = 'AIzaFAKEfakeFAKEfakeFAKEfake1234';
const MASK = 'AIza…1234';
const NOW = 1_793_927_000_000;
const state = (over: Partial<ProviderState> = {}): ProviderState => ({
  id: 'google-vision', name: 'Google Vision', enabled: true, keyMasked: MASK, keySource: 'env',
  month: { calls: 84, limit: 1000 }, today: { calls: 9, cap: 50 }, paused: null,
  lastCall: { at: NOW - 1000, tookMs: 300, status: 'ok' }, lastError: null, lastErrorAt: null,
  checks: { today: 1, cap: 10 }, cameras: [{ id: 'cam1', today: 3, month: 40 }, { id: 'cam2', today: 6, month: 44 }], ...over,
});
const body = { cmdId: 'cmd_00000000000000000001', actor: 'admin@example.org', command: 'analytics.usage.get' } as CommandBody;
const make = (s: ProviderState[], ceiling = 1000) => analyticsHandlers({ state: () => s, config: () => ({ analytics: { googleVision: { remoteMaxMonthly: ceiling } } }) as never, now: () => NOW })['analytics.usage.get'];
const get = async (s: ProviderState[], ceiling?: number) => (await make(s, ceiling)({ v: 1 }, body)) as Done;
const resultOk = (r: Done) => {
  const v = strict('commands/analytics.usage.get.result');
  expect(v(r.result), why(v)).toBe(true);
};

describe('analytics.usage.get', () => {
  it('answers the strict result: settings, use, ceiling, per camera', async () => {
    const r = await get([state()]);
    expect(r.status).toBe('ok');
    resultOk(r);
    expect(r.result).toEqual({ v: 1, at: NOW, providers: [{ id: 'google-vision', name: 'Google Vision', enabled: true, key: 'env', monthlyLimit: 1000, remoteMaxMonthly: 1000, dailyCap: 50, month: { calls: 84 }, today: { calls: 9 }, paused: null, lastError: null, cameras: [{ id: 'cam1', today: 3, month: 40 }, { id: 'cam2', today: 6, month: 44 }] }] });
  });
  it('never carries the key or its mask, whatever its source', async () => {
    for (const keySource of ['env', 'manual', 'none'] as const) {
      const r = await get([state({ keySource, keyMasked: keySource === 'none' ? null : MASK })]);
      resultOk(r);
      const text = JSON.stringify(r.result);
      expect(text).not.toContain(MASK);
      expect(text).not.toContain('AIza');
      expect(text).not.toContain(KEY);
      expect(text).not.toMatch(/keyMasked/);
      expect((r.result!.providers as { key: string }[])[0].key).toBe(keySource);
    }
  });
  it('a pause and the last error, with when; at most 64 cameras; 200 characters of message', async () => {
    const cameras = Array.from({ length: 70 }, (_, i) => ({ id: `cam${i}`, today: 0, month: i }));
    const r = await get([state({ paused: { reason: 'quota', until: NOW + 3_600_000 }, lastError: 'x'.repeat(300), lastErrorAt: NOW - 5000, cameras })], 0);
    resultOk(r);
    const p = (r.result!.providers as Record<string, unknown>[])[0];
    expect(p).toMatchObject({ paused: { reason: 'quota', until: NOW + 3_600_000 }, lastError: { at: NOW - 5000, message: 'x'.repeat(200) }, remoteMaxMonthly: 0 });
    expect((p.cameras as unknown[]).length).toBe(64);
    // A last error from before lastErrorAt existed: the answer's time.
    expect((await get([state({ lastError: 'bad_key', lastErrorAt: null, paused: { reason: 'bad_key', until: null } })])).result!.providers).toMatchObject([{ lastError: { at: NOW, message: 'bad_key' }, paused: { reason: 'bad_key', until: null } }]);
  });
  it('the args are {v: 1} only', () => {
    expect(ARGS_VALIDATORS['analytics.usage.get']({ v: 1 })).toMatchObject({ ok: true });
    expect(ARGS_VALIDATORS['analytics.usage.get']({ v: 1, provider: 'google-vision' })).toMatchObject({ ok: false, code: 'invalid_args' });
    expect(ARGS_VALIDATORS['analytics.usage.get']({ v: 2 })).toMatchObject({ ok: false, code: 'unsupported_version' });
  });
  it('allowed by default (a read without secrets), switchable off locally; implemented; explained', () => {
    expect(DEFAULT_ON).toContain('analytics.usage.get');
    expect(ALLOW_ENTRIES).toContain('analytics.usage.get');
    expect(IMPLEMENTED.has('analytics.usage.get')).toBe(true);
    expect(ENTRY_TEXT['analytics.usage.get']).toMatch(/Google Vision/);
  });
  it('its own rate budget: 10 a minute', () => {
    let t = 0;
    const l = new CommandLimits(() => t);
    for (let i = 0; i < 10; i++) expect(l.take('analytics.usage.get').ok).toBe(true);
    expect(l.take('analytics.usage.get')).toMatchObject({ ok: false, retryAfterS: 60 });
    expect(l.take('config.get').ok).toBe(true); // the others are not affected
    t = 60_000;
    expect(l.take('analytics.usage.get').ok).toBe(true);
  });
});
