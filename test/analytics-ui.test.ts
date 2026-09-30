// test/analytics-ui.test.ts
import { describe, expect, it } from 'vitest';
import { costEstimate, parseLimit, tagText, usageLine } from '../web/src/lib/analytics';

describe('analytics UI text', () => {
  it('estimates the monthly cost from the limit (1,000 free, then $1.50 per 1,000)', () => {
    expect(costEstimate(0)).toBe('No calls.');
    expect(costEstimate(900)).toBe('Up to 900 calls a month: free (Google\'s first 1,000 a month are free).');
    expect(costEstimate(3000)).toBe('Up to 3,000 calls a month: at most $3.00 (the first 1,000 free, then $1.50 per 1,000).');
  });

  it('describes usage, a pause and an error', () => {
    const base = { id: 'google-vision', name: 'Google Vision', enabled: true, keyMasked: 'AIza…x7Qk', month: { calls: 23, limit: 1000 }, today: { calls: 4, cap: 0 }, paused: null, lastCall: { at: Date.parse('2026-09-30T19:02:00Z'), tookMs: 312, status: 'ok' }, lastError: null };
    expect(usageLine(base)).toMatch(/^23 of 1,000 this month · 4 today · last \d{1,2}:02(\s?[AP]M)? \(0\.3 s\)$/);
    expect(usageLine({ ...base, today: { calls: 4, cap: 30 } })).toContain('4 of 30 today');
    expect(usageLine({ ...base, enabled: false })).toBe('not enabled');
  });

  it('writes the Events tag: top three names by score, nothing found, or why not', () => {
    const o = (name: string, score: number) => ({ name, score });
    expect(tagText(null)).toBeNull();
    expect(tagText({ status: 'ok', reason: null, objects: [o('Car', 0.81), o('Person', 0.9), o('Dog', 0.5), o('Bag', 0.4)] })).toBe('✦ Vision: Person 0.90, Car 0.81, Dog 0.50');
    expect(tagText({ status: 'ok', reason: null, objects: [] })).toBe('✦ Vision: nothing found');
    expect(tagText({ status: 'skipped', reason: 'limit', objects: [] })).toBe('✦ not analysed (limit)');
    expect(tagText({ status: 'failed', reason: 'bad_key', objects: [] })).toBe('✦ not analysed (bad_key)');
  });

  it('parses a limit: a whole number from 0 to max, else null', () => {
    expect(parseLimit('0', 100000)).toBe(0);
    expect(parseLimit('1500', 100000)).toBe(1500);
    expect(parseLimit(' 30 ', 10000)).toBe(30);
    expect(parseLimit(100000, 100000)).toBe(100000);
    for (const bad of ['', '  ', null, undefined, 'abc', '-1', '1.5', '100001', NaN, Infinity]) expect(parseLimit(bad as never, 100000)).toBeNull();
    expect(parseLimit('10001', 10000)).toBeNull();
  });
});
