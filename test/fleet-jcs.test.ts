import { describe, expect, it } from 'vitest';
import { jcs } from '../src/fleet/jcs';

describe('JCS (RFC 8785)', () => {
  it('sorts keys by UTF-16 code units, not by code point (RFC 8785 §3.2.3)', () => {
    // The RFC's example; U+FB33 (Hebrew) sorts after the smiley's surrogate pair D83D DE00.
    const input = { '\u20ac': 'Euro Sign', '\r': 'Carriage Return', '\ufb33': 'Hebrew Letter Dalet With Dagesh', '1': 'One', '\ud83d\ude00': 'Emoji: Grinning Face', '\u0080': 'Control', '\u00f6': 'Latin Small Letter O With Diaeresis' };
    expect(jcs(input)).toBe('{"\\r":"Carriage Return","1":"One","\u0080":"Control","\u00f6":"Latin Small Letter O With Diaeresis","\u20ac":"Euro Sign","\ud83d\ude00":"Emoji: Grinning Face","\ufb33":"Hebrew Letter Dalet With Dagesh"}');
  });
  it('writes numbers as ES does: -0 → 0, 1e21, 0.1', () => {
    expect(jcs([-0, 1e21, 0.1, 100])).toBe('[0,1e+21,0.1,100]');
  });
  it('refuses what JSON cannot say', () => {
    // eslint-disable-next-line no-sparse-arrays
    for (const bad of [undefined, NaN, Infinity, () => 1, new Date(0), { a: undefined }, [1, , 2]]) expect(() => jcs(bad), String(bad)).toThrow();
    let deep: unknown = 1;
    for (let i = 0; i < 40; i++) deep = [deep];
    expect(() => jcs(deep)).toThrow(/too deep/);
  });
});
