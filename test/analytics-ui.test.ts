// test/analytics-ui.test.ts
import { describe, expect, it } from 'vitest';
import { boxLabel, costEstimate, keyNotice, validKey, scorePct, labelStyle, estimateFor, parseLimit, pausedText, tagText, stillUrl, toggleSelection, usageLine } from '../web/src/lib/analytics';

describe('analytics UI text', () => {
  it('links the plain still of a second like the Timeline does', () => {
    expect(stillUrl('cam1', 1759400000000)).toBe('/api/cameras/cam1/stills/1759400000000.jpg');
    expect(stillUrl('cam 1/x', 5)).toBe('/api/cameras/cam%201%2Fx/stills/5.jpg');
  });

  it('estimates the monthly cost from the limit (1,000 free, then $2.25 per 1,000)', () => {
    expect(costEstimate(0)).toBe('No calls.');
    expect(costEstimate(900)).toBe('Up to 900 calls a month: free (Google\'s first 1,000 a month are free).');
    expect(costEstimate(3000)).toBe('Up to 3,000 calls a month: at most $4.50 (the first 1,000 free, then $2.25 per 1,000; Google\'s price list, checked 2026-09-30).');
  });

  it('describes usage, a pause and an error', () => {
    const base = { id: 'google-vision', name: 'Google Vision', enabled: true, keyMasked: 'AIza…x7Qk', month: { calls: 23, limit: 1000 }, today: { calls: 4, cap: 0 }, paused: null, lastCall: { at: Date.parse('2026-09-30T19:02:00Z'), tookMs: 312, status: 'ok' }, lastError: null };
    expect(usageLine(base)).toMatch(/^23 of 1,000 this month · 4 today · last \d{1,2}:02(\s?[AP]M)? \(0\.3 s\)$/);
    expect(usageLine({ ...base, today: { calls: 4, cap: 30 } })).toContain('4 of 30 today');
    expect(usageLine({ ...base, enabled: false })).toBe('not enabled');
  });

  it('writes the Events tag from the summary: subtype and score in the order given (the server sorts); "nothing relevant"; or why not', () => {
    const s = (subtype: string, score: number, category: 'person' | 'vehicle' | 'pet' = 'person') => ({ category, subtype, score, box: { x0: 0, y0: 0, x1: 1, y1: 1 } });
    expect(tagText(null)).toBeNull();
    expect(tagText({ status: 'ok', reason: null, objects: [], summary: [s('person', 0.84), s('dog', 0.7, 'pet')] })).toBe('✦ Vision: Person 0.84, Dog 0.70');
    expect(tagText({ status: 'ok', reason: null, objects: [{ name: 'Ceiling fan', score: 0.9 }], summary: [] })).toBe('✦ Vision: nothing relevant');
    // Issue #56: the server's order is kept, and the tag stops at 3 entries.
    expect(tagText({ status: 'ok', reason: null, objects: [], summary: [s('dog', 0.6, 'pet'), s('person', 0.9)] })).toBe('✦ Vision: Dog 0.60, Person 0.90');
    expect(tagText({ status: 'ok', reason: null, objects: [], summary: [s('person', 0.9), s('man', 0.8), s('car', 0.7, 'vehicle'), s('dog', 0.6, 'pet')] })).toBe('✦ Vision: Person 0.90, Man 0.80, Car 0.70');
    expect(tagText({ status: 'skipped', reason: 'limit', objects: [] })).toBe('✦ not analysed (limit)');
    expect(tagText({ status: 'failed', reason: 'bad_key', objects: [] })).toBe('✦ not analysed (bad_key)');
    // an older record without a summary falls back to the objects
    expect(tagText({ status: 'ok', reason: null, objects: [{ name: 'Person', score: 0.9 }] })).toBe('✦ Vision: Person 0.90');
  });

  // Issue #52: no "Paused: invalid key: check …" (two colons).
  it('says why the provider is paused, with one colon at most', () => {
    expect(pausedText({ reason: 'bad_key', until: null })).toBe('invalid key (check CAMPROXY_GOOGLE_VISION_KEY or set a new key in Settings; switch analytics off and on, or restart, to try again)');
    expect(pausedText({ reason: 'quota', until: Date.parse('2026-09-30T19:02:00Z') })).toMatch(/^quota, until \d{1,2}:02(\s?[AP]M)?$/);
    expect(pausedText(null)).toBeNull();
  });

  // Issue #70: the manual key's notice, and the field's check.
  it('says when a manual key is active, with the masked key', () => {
    expect(keyNotice({ keySource: 'manual', keyMasked: 'AIza…wXyZ' })).toBe('Manual key active (AIza…wXyZ). Not saved: a restart restores the configured key.');
    expect(keyNotice({ keySource: 'env', keyMasked: 'AIza…aBcD' })).toBeNull();
    expect(keyNotice({ keySource: 'none', keyMasked: null })).toBeNull();
    expect(keyNotice(null)).toBeNull();
  });
  it('accepts a key of 20 to 200 characters without whitespace', () => {
    expect(validKey('A'.repeat(20))).toBe(true);
    expect(validKey('A'.repeat(200))).toBe(true);
    expect(validKey('A'.repeat(19))).toBe(false);
    expect(validKey('A'.repeat(201))).toBe(false);
    expect(validKey('AIzaSy with space 00000')).toBe(false);
    expect(validKey('')).toBe(false);
    expect(validKey('AIzaSyCtrl\u0001000000000000')).toBe(false);
    expect(validKey('AIzaSyNonAscii\u00e9000000000')).toBe(false);
  });

  // Issue #52: the estimate previews a valid draft; an invalid one shows the saved limit's.
  it('estimates for the typed limit when it is valid, else for the saved one', () => {
    expect(estimateFor('3000', 500)).toBe(costEstimate(3000));
    expect(estimateFor('abc', 500)).toBe(costEstimate(500));
    expect(estimateFor('', 0)).toBe('No calls.');
  });

  it('parses a limit: a whole number from 0 to max, else null', () => {
    expect(parseLimit('0', 100000)).toBe(0);
    expect(parseLimit('1500', 100000)).toBe(1500);
    expect(parseLimit(' 30 ', 10000)).toBe(30);
    expect(parseLimit(100000, 100000)).toBe(100000);
    for (const bad of ['', '  ', null, undefined, 'abc', '-1', '1.5', '100001', NaN, Infinity]) expect(parseLimit(bad as never, 100000)).toBeNull();
    expect(parseLimit('10001', 10000)).toBeNull();
  });

  // The overlay's label next to a box: "Clothing 20%" (the table keeps 0.89).
  it('labels a box with the name, first letter capitalised, and the rounded percent', () => {
    expect(scorePct(0.99)).toBe('99%');
    expect(scorePct(0.705)).toBe('70%'); // from the 2-decimal score (0.705 is stored just below .705)
    expect(scorePct(1)).toBe('100%');
    expect(boxLabel('clothing', 0.2)).toBe('Clothing 20%');
    expect(boxLabel('person', 0.84)).toBe('Person 84%');
    expect(boxLabel('Ceiling fan', 0.86)).toBe('Ceiling fan 86%');
    // only the first letter changes; Google's name is kept otherwise
    expect(boxLabel('ceiling Fan', 0.5)).toBe('Ceiling Fan 50%');
    expect(boxLabel('TV', 0.7)).toBe('TV 70%');
    // The percent agrees with the table's score (toFixed(2)), also on a .xx5:
    // 0.705 is "0.70" in the table, so "70%" (not 71%).
    expect(boxLabel('clothing', 0.705)).toBe('Clothing 70%');
    expect(boxLabel('top', 0.845)).toBe('Top 84%');
    expect(boxLabel('top', 0.125)).toBe('Top 13%');
    expect(boxLabel('top', 0.124)).toBe('Top 12%');
    expect(boxLabel('top', 0.8456)).toBe('Top 85%');
    for (let k = 0; k <= 1000; k++) {
      const score = k / 1000;
      expect(boxLabel('x', score)).toBe(`X ${Number(score.toFixed(2).replace('.', ''))}%`);
    }
    expect(boxLabel('belt', 0)).toBe('Belt 0%');
    expect(boxLabel('belt', 1)).toBe('Belt 100%');
  });

  // Where the label goes: above the box's left corner; inside the box when the
  // box touches the top (else it is cut off); anchored right near the right edge.
  it('places a box label so it stays inside the picture', () => {
    expect(labelStyle({ x0: 0.1, y0: 0.2, x1: 0.4, y1: 0.9 })).toBe('left:10%;top:20%;transform:translateY(-100%)');
    expect(labelStyle({ x0: 0.1, y0: 0, x1: 0.4, y1: 0.5 })).toBe('left:10%;top:0%');
    expect(labelStyle({ x0: 0.1, y0: 0.079, x1: 0.4, y1: 0.5 })).toBe('left:10%;top:7.9%');
    expect(labelStyle({ x0: 0.8, y0: 0.2, x1: 0.95, y1: 0.5 })).toBe('right:5%;top:20%;transform:translateY(-100%)');
    expect(labelStyle({ x0: 0.8, y0: 0, x1: 1, y1: 0.5 })).toBe('right:0%;top:0%');
    expect(labelStyle({ x0: 0.75, y0: 0.08, x1: 1, y1: 0.5 })).toBe('left:75%;top:8%;transform:translateY(-100%)');
  });

  // Clicking an object row shows only its box; clicking it again shows all.
  it('toggles the selected object row', () => {
    expect(toggleSelection(null, 2)).toBe(2);
    expect(toggleSelection(2, 2)).toBeNull();
    expect(toggleSelection(2, 0)).toBe(0);
  });
});
