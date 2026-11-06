import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { leafPaths, SETTINGS } from '../src/config/schema';
import { CEILINGS, classify, DENIED, denyReason, directionFailures, NARROW, narrowingOk, narrowRules, patternOf, REMOTE, settableView } from '../src/fleet/remote-settable';
import { CONTRACT } from './helpers/contract';

const contract = JSON.parse(readFileSync(join(CONTRACT, 'remote-settable.json'), 'utf8')) as { remote: string[]; narrow: Record<string, string>; ceilings: Record<string, string>; denied: string[] };
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
  it('this version lets cams-admin set exactly the contract\'s remote list', () => {
    expect([...REMOTE].sort()).toEqual([...contract.remote].sort());
  });
  it('the deny list names each prefix once, and every prefix the contract denies', () => {
    expect(new Set(DENIED).size).toBe(DENIED.length);
    expect([...DENIED].sort()).toEqual([...contract.denied].sort());
  });
  it('the compiled remote list is a subset of the contract (the upper bound); narrow paths agree', () => {
    for (const r of REMOTE) expect(contract.remote, r).toContain(r);
    // Every narrow path the contract names that is remote here is narrow here, the same way.
    for (const [p, d] of Object.entries(contract.narrow)) if (REMOTE.includes(p)) expect(NARROW[p], p).toBe(d);
    for (const p of Object.keys(NARROW)) expect(contract.narrow[p], p).toBe(NARROW[p]);
    // Each ceiling path is bounded by the contract's local-only ceiling.
    expect(CEILINGS).toEqual(contract.ceilings);
    for (const c of Object.values(CEILINGS)) expect(classify(c, IDS), c).toBe('denied');
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
    expect(classify('cameras.cam-2.stills.intervalS', IDS)).toBe('remote');
  });
  it('no remote path has a secret-looking name (settings never hold secrets)', () => {
    for (const r of REMOTE) expect(r).not.toMatch(/token|password|secret|key|credential/i);
  });
});

describe('local only (coordinator ruling I4)', () => {
  it('capture and feature on/off switches and health thresholds are denied, with a reason', () => {
    for (const p of ['stills.enabled', 'ftp.enabled', 'archive.enabled', 'events.poll.enabled', 'analytics.kinds.person', 'analytics.kinds.vehicle', 'analytics.kinds.pet', 'analytics.googleVision.remoteMaxMonthly',
      'health.diskPercent', 'health.tempC', 'archive.warnPercent', 'host.stats', 'ftp.stalledHours',
      'cameras.cam1.stills.enabled', 'cameras.cam1.ftp.enabled', 'cameras.cam1.analytics.kinds.person', 'cameras.cam1.events.poll.enabled']) {
      expect(classify(p, IDS), p).toBe('denied');
      expect(denyReason(p), p).toMatch(/^local only: /);
    }
    expect(denyReason('storage.maxPercent')).toMatch(/^local only: /);
    expect(denyReason('cameras.cam1.host')).toBeUndefined();
  });
  it('every remote boolean is not an on/off switch of capture, but Google Vision (gated by its local ceiling)', () => {
    for (const p of REMOTE.filter((x) => x !== 'analytics.googleVision.enabled')) expect(p, p).not.toMatch(/\.enabled$|^analytics\.kinds\.|\.kinds\./);
    expect(NARROW['analytics.googleVision.enabled']).toBe('ceilingGated');
  });
});

describe('narrow paths (R3-2)', () => {
  it('Google Vision only toward less spending; 0 = no cap for the caps', () => {
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
    expect(v['analytics.googleVision.monthlyLimit']).toMatchObject({ type: 'integer', min: 0, max: 100000, dir: 'ceiling' });
    expect(v['analytics.googleVision.enabled']).toEqual({ type: 'boolean', dir: 'ceilingGated' });
    expect(v['cameras.*.stills.intervalS']).toMatchObject({ type: 'integer', oneOf: [1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30, 60] });
  });
});

// Vision management (cams-admin design 2026-11-05): the monthly limit and the
// switch are bounded by a ceiling set at the proxy.
describe('ceiling paths', () => {
  const ML = 'analytics.googleVision.monthlyLimit';
  const EN = 'analytics.googleVision.enabled';
  it('ceiling: lowering always; raising only to the ceiling', () => {
    expect(narrowingOk(ML, 5000, 3000, 1000)).toBe(true); // lowering, above the ceiling
    expect(narrowingOk(ML, 5000, 6000, 1000)).toBe(false);
    expect(narrowingOk(ML, 0, 1000, 1000)).toBe(true);
    expect(narrowingOk(ML, 0, 1001, 1000)).toBe(false);
    expect(narrowingOk(ML, 0, 1, 0)).toBe(false);
    expect(narrowingOk(ML, 100, 1000)).toBe(false); // no ceiling given: 0
  });
  it('ceilingGated: off always; on only with a ceiling above 0 (or when already on)', () => {
    expect(narrowingOk(EN, true, false, 0)).toBe(true);
    expect(narrowingOk(EN, false, true, 0)).toBe(false);
    expect(narrowingOk(EN, false, true, 1)).toBe(true);
    expect(narrowingOk(EN, true, true, 0)).toBe(true);
  });
  it('directionFailures: widening_local_only first, then above_local_ceiling with the ceiling named', () => {
    const cfg = { analytics: { googleVision: { remoteMaxMonthly: 1000 } } };
    expect(directionFailures([{ path: ML, from: 0, to: 800 }], cfg)).toBeNull();
    expect(directionFailures([{ path: ML, from: 0, to: 6000 }], cfg)).toEqual({ code: 'above_local_ceiling', paths: [{ path: ML, code: 'above_local_ceiling', detail: 'cams-admin may allow up to 1000 calls a month (analytics.googleVision.remoteMaxMonthly)' }] });
    expect(directionFailures([{ path: EN, from: false, to: true }], { analytics: { googleVision: { remoteMaxMonthly: 0 } } })).toEqual({ code: 'above_local_ceiling', paths: [{ path: EN, code: 'above_local_ceiling', detail: 'cams-admin may not switch it on: no ceiling at the proxy (analytics.googleVision.remoteMaxMonthly is 0)' }] });
    expect(directionFailures([{ path: ML, from: 0, to: 6000 }, { path: 'retention.clipsDays', from: 30, to: 1 }], cfg)).toEqual({ code: 'widening_local_only', paths: [{ path: 'retention.clipsDays', code: 'widening_local_only', detail: 'a remote change may only keep data longer' }] });
  });
  it('narrowRules names the ceiling path for the page', () => {
    expect(narrowRules()[ML]).toEqual({ dir: 'ceiling', ceiling: 'analytics.googleVision.remoteMaxMonthly' });
    expect(narrowRules()[EN]).toEqual({ dir: 'ceilingGated', ceiling: 'analytics.googleVision.remoteMaxMonthly' });
  });
});
