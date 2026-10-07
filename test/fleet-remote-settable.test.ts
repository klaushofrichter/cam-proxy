import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { leafPaths, SETTINGS } from '../src/config/schema';
import { classify, DENIED, NARROW, narrowingOk, patternOf, REMOTE, settableView } from '../src/fleet/remote-settable';
import { CONTRACT } from './helpers/contract';

const contract = JSON.parse(readFileSync(join(CONTRACT, 'remote-settable.json'), 'utf8')) as { remote: string[]; narrow: Record<string, string>; denied: string[] };
const IDS = ['cam1', 'cam-2'];

describe('the classification (R3-1)', () => {
  it('every setting leaf is classified: remote or denied, never both, never neither', () => {
    for (const p of leafPaths(SETTINGS, '', IDS)) {
      const c = classify(p, IDS);
      expect(['remote', 'denied'], p).toContain(c);
      const listed = REMOTE.includes(patternOf(p));
      const denied = DENIED.some((d) => patternOf(p) === d || patternOf(p).startsWith(`${d}.`));
      expect(listed && denied, `${p} is in both lists`).toBe(false);
      expect(listed || denied, `${p} is unclassified: add it to REMOTE (contract first) or DENIED`).toBe(true);
    }
  });
  it('the compiled remote list is a subset of the contract (the upper bound); narrow paths agree', () => {
    for (const r of REMOTE) expect(contract.remote, r).toContain(r);
    expect(NARROW).toEqual(contract.narrow);
  });
  it('M5: the deny list holds every trust, address, port, file and camsAdmin path', () => {
    for (const p of ['camsAdmin.url', 'camsAdmin.enabled', 'camsAdmin.keyFile', 'server.port', 'server.publicUrl', 'go2rtc.binary', 'ftp.port', 'ftp.publicHost', 'ftp.certFile', 'tls.site', 'tls.cameraSubnet', 'composition.font', 'ntp.server', 'poeSwitch.host', 'poeSwitch.model',
      'cameras.cam1.host', 'cameras.cam1.protocol', 'cameras.cam1.tlsName', 'cameras.cam1.user', 'cameras.cam1.onvifPort', 'cameras.cam1.rtspPort', 'cameras.cam1.baichuanPort', 'cameras.cam1.poeSwitch.port', 'cameras.cam1.ftp.user', 'cameras.cam1.webUiUrl', 'cameras.cam1.id'])
      expect(classify(p, IDS), p).toBe('denied');
  });
  it('a camera path for a camera that does not exist is unknown_camera (never adds one); a whole camera is not a setting', () => {
    expect(classify('cameras.evil.name', IDS)).toBe('unknown_camera');
    expect(classify('cameras.evil.host', IDS)).toBe('unknown_camera');
    expect(classify('cameras.cam1', IDS)).toBe('not_a_setting');
    expect(classify('cameras', IDS)).toBe('not_a_setting');
    expect(classify('stills', IDS)).toBe('not_a_setting');
    expect(classify('nosuch.path', IDS)).toBe('not_a_setting');
    expect(classify('cameras.cam-2.stills.enabled', IDS)).toBe('remote');
  });
  it('no remote path has a secret-looking name (settings never hold secrets)', () => {
    for (const r of REMOTE) expect(r).not.toMatch(/token|password|secret|key|credential/i);
  });
});

describe('narrow paths (R3-2)', () => {
  it('Google Vision only toward less spending; 0 = no cap for the caps', () => {
    expect(narrowingOk('analytics.googleVision.enabled', true, false)).toBe(true);
    expect(narrowingOk('analytics.googleVision.enabled', false, true)).toBe(false);
    expect(narrowingOk('analytics.googleVision.monthlyLimit', 1000, 100)).toBe(true);
    expect(narrowingOk('analytics.googleVision.monthlyLimit', 100, 1000)).toBe(false);
    expect(narrowingOk('analytics.googleVision.dailyCap', 50, 10)).toBe(true);
    expect(narrowingOk('analytics.googleVision.dailyCap', 50, 0)).toBe(false); // 0 = no cap
    expect(narrowingOk('analytics.googleVision.dailyCap', 0, 50)).toBe(true);
    expect(narrowingOk('analytics.googleVision.perCameraDailyCap', 5, 0)).toBe(false);
    expect(narrowingOk('analytics.googleVision.checksPerDay', 5, 0)).toBe(true); // 0 = no checks
  });
  it('every retention period and size cap only up (keep data longer); other paths are free', () => {
    for (const p of ['retention.stillsDays', 'retention.previewsDays', 'retention.clipsDays', 'retention.eventsDays', 'retention.auditDays', 'retention.streamLogDays']) {
      expect(narrowingOk(p, 90, 30), p).toBe(false);
      expect(narrowingOk(p, 30, 90), p).toBe(true);
    }
    expect(narrowingOk('stills.maxGB', 50, 10)).toBe(false);
    expect(narrowingOk('stills.maxGB', undefined, 10)).toBe(false); // unset = no cap
    expect(narrowingOk('stills.maxGB', 10, undefined)).toBe(true);
    expect(narrowingOk('retention.intervalMin', 60, 5)).toBe(true); // timing only, deletes nothing more
    expect(narrowingOk('sse.pingS', 30, 5)).toBe(true);
  });
  it('storage is local only (coordinator ruling): every storage.* and cameras.*.storage.* leaf is denied', () => {
    for (const p of leafPaths(SETTINGS, '', IDS).filter((x) => /^storage\.|^cameras\.[^.]+\.storage\./.test(x))) expect(classify(p, IDS), p).toBe('denied');
  });
  it('settableView: every remote leaf with its bounds, narrow ones marked', () => {
    const v = settableView();
    expect(Object.keys(v).sort()).toEqual([...REMOTE].sort());
    expect(v['sse.pingS']).toMatchObject({ type: 'integer', min: 1, max: 300 });
    expect(v['analytics.googleVision.dailyCap'].dir).toBe('less');
    expect(v['cameras.*.stills.intervalS']).toMatchObject({ type: 'integer', oneOf: [1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30, 60] });
  });
});
