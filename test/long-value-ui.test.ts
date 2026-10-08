import { describe, expect, it } from 'vitest';
import { fingerprintChunks, hostOf, httpUrl, shortId } from '../web/src/lib/long-value';

// Long values in the admin UI (#203): ids shortened in the middle, the full
// value on hover and copy; fingerprints in groups of four that wrap cleanly.
describe('long values', () => {
  it('an id keeps its prefix and its last characters', () => {
    expect(shortId('prx_01J9ABCDEFGHJKMNPQ9F5X')).toBe('prx_01J9…9F5X');
    expect(shortId('tok_E2E0000000000000000M', 6, 3)).toBe('tok_E2…00M');
  });
  it('a short id stays whole', () => {
    expect(shortId('prx_short')).toBe('prx_short');
    expect(shortId('abcdefghijkl0')).toBe('abcdefghijkl0'); // 13 = 8 + 4 + 1: nothing saved
    expect(shortId('')).toBe('');
  });
  it('a fingerprint in groups of four, its algorithm apart', () => {
    expect(fingerprintChunks('SHA256:ABCDEF0123456789')).toEqual({ algo: 'SHA256', groups: ['ABCD', 'EF01', '2345', '6789'] });
    expect(fingerprintChunks('SHA256:ABCDE')).toEqual({ algo: 'SHA256', groups: ['ABCD', 'E'] });
    expect(fingerprintChunks('abcdefgh')).toEqual({ algo: null, groups: ['abcd', 'efgh'] });
    expect(fingerprintChunks('SHA256:' + 'A'.repeat(64)).groups).toHaveLength(16);
  });
  it('the host of a URL, or the text as it is', () => {
    expect(hostOf('https://cams-admin.skylar.technology/x')).toBe('cams-admin.skylar.technology');
    expect(hostOf('http://127.0.0.1:18700')).toBe('127.0.0.1:18700');
    expect(hostOf('not a url')).toBe('not a url');
  });
  it('a link only for an http(s) URL', () => {
    expect(httpUrl('https://cams-admin.skylar.technology')).toBe('https://cams-admin.skylar.technology/');
    expect(httpUrl('http://127.0.0.1:18700/x')).toBe('http://127.0.0.1:18700/x');
    for (const v of ['javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd', 'ftp://host/', 'not a url', '']) expect(httpUrl(v)).toBeNull();
  });
});
