import { describe, expect, it } from 'vitest';
import { buildHealth } from '../src/health/summary';
import { CAMS_ADMIN_GRACE_MS, type AdminConnection } from '../src/health/cams-admin';
import { NOW, input } from './helpers/health-input';
import { strict, why } from './helpers/contract';

// The proxy's own connection to cams-admin as a health item (Klaus,
// 2026-11-04: een sat disconnected for 13 minutes with nothing to see).
// Not configured: no item. Connected: ok. Down under 2 minutes (a cams-admin
// deploy): a warning. Longer, or never connected for as long: a problem.
const MIN = 60_000;
const down = (ms: number, reason: string | null = null): AdminConnection => ({ connected: false, downSince: NOW - ms, reason });
const health = (camsAdmin: AdminConnection | null | undefined) => buildHealth(input({ camsAdmin }));
const item = (h: ReturnType<typeof buildHealth>) => h.items.find((i) => i.id === 'camsAdmin');

describe('the camsAdmin item', () => {
  it('not configured: no item', () => {
    expect(item(health(null))).toBeUndefined();
    expect(item(buildHealth(input({})))).toBeUndefined();
  });
  it('connected: ok, right before the version', () => {
    const h = health({ connected: true });
    expect(item(h)).toEqual({ id: 'camsAdmin', label: 'cams-admin', value: 'connected', text: 'connected', problem: false });
    expect(h.ok).toBe(true);
    const ids = h.items.map((i) => i.id);
    expect(ids.indexOf('camsAdmin')).toBe(ids.indexOf('version') - 1);
  });
  it('just down: a warning that says reconnecting, never a problem', () => {
    const h = health(down(30_000, 'refused'));
    expect(item(h)).toEqual({ id: 'camsAdmin', label: 'cams-admin', value: 'reconnecting', text: 'reconnecting', problem: false, warning: true });
    expect([h.ok, h.problemCount]).toEqual([true, 0]);
  });
  it('the edge: the last millisecond of the 2 minutes warns, the 2 minutes are a problem', () => {
    expect(CAMS_ADMIN_GRACE_MS).toBe(2 * MIN);
    expect(item(health(down(2 * MIN - 1)))).toMatchObject({ value: 'reconnecting', problem: false, warning: true });
    const h = health(down(2 * MIN));
    expect(item(h)).toEqual({ id: 'camsAdmin', label: 'cams-admin', value: 'disconnected', text: 'not connected for 2 min', problem: true });
    expect([h.ok, h.problemCount]).toEqual([false, 1]);
  });
  it('longer: whole minutes, with the reason when known', () => {
    expect(item(health(down(13 * MIN + 59_000, 'name lookup failed')))?.text).toBe('not connected for 13 min (name lookup failed)');
    expect(item(health(down(5 * MIN, 'refused')))?.text).toBe('not connected for 5 min (refused)');
    expect(item(health(down(5 * MIN, 'timeout')))?.text).toBe('not connected for 5 min (timeout)');
    expect(item(health(down(5 * MIN)))?.text).toBe('not connected for 5 min');
  });
  it('a clock that went back never shows a negative time', () => {
    expect(item(health(down(-5 * MIN)))).toMatchObject({ value: 'reconnecting', problem: false });
  });
  it('the text stays within the contract\'s 200 characters', () => {
    expect(item(health(down(5 * MIN, 'x'.repeat(400))))!.text.length).toBe(200);
  });
  it('passes the cams-admin contract (strict health summary)', () => {
    const v = strict('health-summary');
    for (const c of [{ connected: true as const }, down(MIN), down(9 * MIN, 'refused')]) {
      const h = health(c);
      expect(v(h), why(v)).toBe(true);
    }
  });
});
