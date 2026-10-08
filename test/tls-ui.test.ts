import { describe, expect, it } from 'vitest';
import { certLine, certRows, certWarnings, dateText, expiresText, fingerprintGroups, modeText } from '../web/src/lib/tls';

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

// #203: the Status page's short Certificates card and the Certificates page.
describe('the Certificates summary', () => {
  const view = {
    site: 'home', caFingerprint: 'SHA256:AB', caNotAfter: NOW + 3650 * DAY,
    proxy: { servername: 'proxy.home.internal', fingerprint: 'SHA256:CD', notAfter: NOW + 300 * DAY },
    cameras: [
      { id: 'cam1', servername: 'cam1.home.internal', fingerprint: 'SHA256:EF', mode: 'site-ca' as const, notAfter: NOW + 200 * DAY, lastPush: { at: NOW - 3 * 3600_000, outcome: 'pushed' }, problem: null },
      { id: 'cam2', servername: null, fingerprint: null, mode: 'none' as const, notAfter: null, lastPush: null, problem: null },
      { id: 'cam3', servername: null, fingerprint: 'SHA256:01', mode: 'pinned' as const, notAfter: NOW - 2 * DAY, lastPush: { at: NOW - 60_000, outcome: 'refused' }, problem: 'the camera refused the import' },
    ],
    problems: ['the CA expires in 20 days'],
  };
  it('the mode in words', () => {
    expect(modeText('site-ca')).toBe('site CA');
    expect(modeText('pinned')).toBe('pinned');
    expect(modeText('public')).toBe('public CA');
    expect(modeText('none')).toBe('HTTP');
  });
  it('what is left of a certificate', () => {
    expect(expiresText(NOW + 200 * DAY, NOW)).toBe('expires in 200 days');
    expect(expiresText(NOW + DAY + 1, NOW)).toBe('expires in 1 day');
    expect(expiresText(NOW + 3600_000, NOW)).toBe('expires today');
    expect(expiresText(NOW - 2 * DAY, NOW)).toBe('expired 2 days ago');
    expect(expiresText(null, NOW)).toBeNull();
  });
  it('one row per camera: its name, mode, what is left, the last push', () => {
    const rows = certRows(view, { cam1: 'Driveway' }, NOW);
    expect(rows[0]).toEqual({ id: 'cam1', name: 'Driveway', mode: 'site CA', expires: 'expires in 200 days', push: 'pushed 3 h ago', bad: false });
    expect(rows[1]).toEqual({ id: 'cam2', name: 'cam2', mode: 'HTTP', expires: null, push: null, bad: false });
    expect(rows[2]).toMatchObject({ id: 'cam3', mode: 'pinned', push: 'refused 1 min ago', bad: true });
  });
  it('the warnings: the view\'s problems, then each camera\'s', () => {
    expect(certWarnings(view)).toEqual(['the CA expires in 20 days', 'cam3: the camera refused the import']);
  });
  it('a date as YYYY-MM-DD, or a dash', () => {
    expect(dateText(Date.UTC(2036, 0, 2))).toBe('2036-01-02');
    expect(dateText(null)).toBe('—');
  });
});
