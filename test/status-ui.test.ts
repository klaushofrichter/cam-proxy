import { describe, expect, it } from 'vitest';
import { daysUntilFullText } from '../web/src/lib/format';
import { cameraFtpText, ftpAlerts, type FtpHealth } from '../web/src/lib/ftp';

describe('Status page: days until full (#78)', () => {
  it('rounds, says "more than a year" past 365 days, and — when not filling', () => {
    expect(daysUntilFullText(null)).toBe('—');
    expect(daysUntilFullText(214.4)).toBe('214');
    expect(daysUntilFullText(365)).toBe('365');
    expect(daysUntilFullText(365.6)).toBe('more than a year');
    expect(daysUntilFullText(893_477)).toBe('more than a year');
  });
});

// Issue #93: the FTP card's warnings.
describe('Status page: the camera FTP warnings (#93)', () => {
  const H = 3600_000;
  const NOW = Date.UTC(2026, 9, 1, 21, 15, 0);
  const cam = (over: Partial<NonNullable<FtpHealth['camera']>> = {}): FtpHealth['camera'] => ({ state: 'on', checkedAt: NOW, enable: true, server: '192.168.1.50', port: 2121, user: 'camera', mismatch: [], error: null, ...over });
  const ftp = (over: Partial<FtpHealth> = {}): FtpHealth => ({ enabled: true, publicHost: '192.168.1.50', camera: cam(), stalled: { stalled: false, hours: 6, lastClip: NOW - H, events: 0 }, ...over });

  it('on and pointing here, clips arriving: no warning', () => {
    expect(ftpAlerts(ftp())).toEqual([]);
  });
  it('FTP off on the camera: a warning with the fix', () => {
    expect(ftpAlerts(ftp({ camera: cam({ state: 'off', enable: false }) }))).toEqual([{ kind: 'off', text: "The camera's FTP upload is off: no clips arrive." }]);
  });
  it('points elsewhere: says where', () => {
    const [a] = ftpAlerts(ftp({ camera: cam({ state: 'elsewhere', server: 'nas.local', port: 21, mismatch: ['server', 'port'] }) }));
    expect(a).toEqual({ kind: 'elsewhere', text: "The camera's FTP upload points to nas.local:21 (user camera), not to this proxy (192.168.1.50)." });
  });
  it('stalled: no clip for N hours while events happened, with the time of the last clip', () => {
    const [a] = ftpAlerts(ftp({ stalled: { stalled: true, hours: 6, lastClip: NOW - 37 * H, events: 12 } }), (ts) => `T${ts}`);
    expect(a).toEqual({ kind: 'stalled', text: `No clip in the last 6 h although the camera recorded 12 events; the last clip arrived T${NOW - 37 * H}.` });
    expect(ftpAlerts(ftp({ stalled: { stalled: true, hours: 6, lastClip: null, events: 1 } }))[0].text).toBe('No clip in the last 6 h although the camera recorded 1 event; no clip has arrived yet.');
  });
  it('unknown (not read yet, camera offline) or FTP off in the proxy: no warning', () => {
    expect(ftpAlerts(ftp({ camera: cam({ state: 'unknown', enable: null }) }))).toEqual([]);
    expect(ftpAlerts(ftp({ enabled: false, camera: null, stalled: null }))).toEqual([]);
  });
  it('the camera state line', () => {
    expect(cameraFtpText(cam())).toBe('on, to this proxy');
    expect(cameraFtpText(cam({ state: 'off', enable: false }))).toBe('off');
    expect(cameraFtpText(cam({ state: 'elsewhere', server: 'nas.local', port: 21 }))).toBe('to nas.local:21');
    expect(cameraFtpText(cam({ state: 'unknown', checkedAt: null }))).toBe('—');
    expect(cameraFtpText(null)).toBe('—');
  });
});
