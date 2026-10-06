import { describe, expect, it } from 'vitest';
import { certLine, fingerprintGroups } from '../web/src/lib/tls';

const NOW = Date.UTC(2026, 9, 20, 12, 0);
const DAY = 86400_000;
describe('the Certificates card', () => {
  it('one line per camera', () => {
    expect(certLine({ mode: 'site-ca', notAfter: NOW + 200 * DAY, lastPush: { at: NOW - 3 * 3600_000, outcome: 'pushed' } }, NOW)).toBe('site CA, 200 days left, pushed 3 h ago');
    expect(certLine({ mode: 'pinned', notAfter: null, lastPush: { at: NOW, outcome: 'refused' } }, NOW)).toBe('pinned: the camera refused the import');
    expect(certLine({ mode: 'public', notAfter: null, lastPush: null }, NOW)).toBe('public CA');
    expect(certLine({ mode: 'none', notAfter: null, lastPush: null }, NOW)).toBe('HTTP: no certificate');
  });
  it('the fingerprint in groups of four', () => {
    expect(fingerprintGroups('SHA256:ABCDEF0123456789')).toBe('SHA256: ABCD EF01 2345 6789');
  });
});
