import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AuditLog, type AuditRecord } from '../src/audit/audit-log';
import { openCatalog, type Catalog } from '../src/catalog/db';
import { insertEvent } from '../src/catalog/events';
import { deleteClip, insertClip, lastClipReceived } from '../src/catalog/clips';
import { CameraFtpWatch, classifyFtp, clipsStalled, STALL_GRACE_MS } from '../src/clips/ftp-health';
import { activityDaily } from '../src/audit/daily';

// Issue #93: the camera's FTP upload was off for 37 hours, unnoticed.
const TARGET = { server: '192.168.1.50', port: 2121, user: 'camera', password: 'ftp-secret-not-real-0000', tls: true, stream: 'sub' as const };
const camFtp = (over: Record<string, unknown> = {}) => ({ enable: 1, server: '192.168.1.50', port: 2121, userName: 'camera', password: 'ftp-secret-not-real-0000', onlyFtps: 1, ...over });

const dirs: string[] = [];
const tmp = (p: string) => {
  const d = mkdtempSync(join(tmpdir(), p));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const records = (dir: string): AuditRecord[] =>
  readdirSync(dir).sort().flatMap((f) => readFileSync(join(dir, f), 'utf8').trimEnd().split('\n').filter(Boolean).map((l) => JSON.parse(l) as AuditRecord));
const checks = (dir: string) => records(dir).filter((r) => r.event.action === 'camera-check');

describe('classifyFtp', () => {
  it('on and pointing at this proxy: on, no mismatch', () => {
    expect(classifyFtp(camFtp(), TARGET)).toEqual({ state: 'on', enable: true, server: '192.168.1.50', port: 2121, user: 'camera', mismatch: [] });
  });
  it('enable 0: off, even with the server still pointing here (2026-10-01)', () => {
    expect(classifyFtp(camFtp({ enable: 0 }), TARGET)).toMatchObject({ state: 'off', enable: false, mismatch: [] });
  });
  it('another server, port or user: elsewhere, naming the fields', () => {
    expect(classifyFtp(camFtp({ port: 21, userName: 'other' }), TARGET)).toMatchObject({ state: 'elsewhere', mismatch: ['port', 'user'] });
  });
  it('off wins over elsewhere', () => {
    expect(classifyFtp(camFtp({ enable: 0, server: 'nas.local' }), TARGET)).toMatchObject({ state: 'off', mismatch: ['server'] });
  });
  // Review of #94: a fresh or reset camera (cam2's sim starts so) is not an alarm.
  it('no server and never a clip: not_set_up; no server but clips before: off', () => {
    const fresh = camFtp({ enable: 0, server: '', port: 21, userName: '' });
    expect(classifyFtp(fresh, TARGET, { clipsBefore: false })).toMatchObject({ state: 'not_set_up', enable: false });
    expect(classifyFtp({ ...fresh, server: '  ' }, TARGET, { clipsBefore: false })).toMatchObject({ state: 'not_set_up' });
    expect(classifyFtp(fresh, TARGET, { clipsBefore: true })).toMatchObject({ state: 'off' });
    // A server set and enable 0: off (was on, now off), clips or not.
    expect(classifyFtp(camFtp({ enable: 0 }), TARGET, { clipsBefore: false })).toMatchObject({ state: 'off' });
  });
  it('the server is compared trimmed and in lower case', () => {
    expect(classifyFtp(camFtp({ server: ' Cam-Proxy.LOCAL ' }), { ...TARGET, server: 'cam-proxy.local' })).toMatchObject({ state: 'on', mismatch: [] });
  });
  it('only the server differs (port and user match): server_differs, a warning, not elsewhere', () => {
    expect(classifyFtp(camFtp({ server: 'nas.local' }), TARGET)).toMatchObject({ state: 'server_differs', mismatch: ['server'] });
    expect(classifyFtp(camFtp({ server: 'nas.local', port: 21 }), TARGET)).toMatchObject({ state: 'elsewhere', mismatch: ['server', 'port'] });
  });
  it('without ftp.publicHost the server is not compared', () => {
    expect(classifyFtp(camFtp({ server: 'anything' }), { ...TARGET, server: '' })).toMatchObject({ state: 'on', mismatch: [] });
  });
  it('never carries the password', () => {
    expect(JSON.stringify(classifyFtp(camFtp(), TARGET))).not.toContain('ftp-secret');
  });
});

describe('CameraFtpWatch', () => {
  function make(over: { active?: () => boolean; dir?: string; clipsBefore?: () => boolean } = {}) {
    const now = { t: Date.UTC(2026, 9, 1, 21, 0, 0) };
    const dir = over.dir ?? tmp('ftp-audit-');
    const audit = new AuditLog({ dir, version: 'test', camera: () => 'cam1', now: () => now.t, host: 'h' });
    let answer: Record<string, unknown> | Error = camFtp();
    let reads = 0;
    const watch = new CameraFtpWatch({
      read: async () => {
        reads++;
        if (answer instanceof Error) throw answer;
        return answer;
      },
      target: () => TARGET,
      audit,
      active: over.active ?? (() => true),
      clipsBefore: over.clipsBefore,
      now: () => now.t,
    });
    return { now, dir, audit, watch, set: (a: Record<string, unknown> | Error) => (answer = a), reads: () => reads };
  }

  it('unknown before the first read', () => {
    const { watch } = make();
    expect(watch.view()).toMatchObject({ state: 'unknown', checkedAt: null });
  });

  it('on → off → on: a camera-check record per transition, with before and after, never the password', async () => {
    const { watch, set, dir, now } = make();
    expect((await watch.checkNow()).state).toBe('on');
    expect(checks(dir)).toHaveLength(0); // on from the start: nothing to report
    set(camFtp({ enable: 0 }));
    now.t += 300_000;
    const v = await watch.checkNow();
    expect(v).toMatchObject({ state: 'off', enable: false, checkedAt: now.t, server: '192.168.1.50' });
    await watch.checkNow(); // unchanged: no second record
    set(camFtp());
    await watch.checkNow();
    const recs = checks(dir);
    expect(recs).toHaveLength(2);
    expect(recs[0]).toMatchObject({ event: { action: 'camera-check', outcome: 'failure', category: ['host'] }, user: { name: 'system' }, cam_proxy: { check: 'ftp', from: { state: 'on' }, to: { state: 'off', enable: false, server: '192.168.1.50', port: 2121, user: 'camera' } } });
    expect(recs[0].message).toMatch(/FTP upload is off/);
    expect(recs[1]).toMatchObject({ event: { outcome: 'success' }, cam_proxy: { from: { state: 'off' }, to: { state: 'on' } } });
    expect(readdirSync(dir).map((f) => readFileSync(join(dir, f), 'utf8')).join('')).not.toContain('ftp-secret');
  });

  it('points elsewhere: a record naming the fields', async () => {
    const { watch, set, dir } = make();
    await watch.checkNow();
    set(camFtp({ server: 'nas.local', port: 21 }));
    expect((await watch.checkNow()).state).toBe('elsewhere');
    expect(checks(dir)[0]).toMatchObject({ event: { outcome: 'failure' }, cam_proxy: { from: { state: 'on' }, to: { state: 'elsewhere', server: 'nas.local' }, mismatch: ['server', 'port'] } });
    expect(checks(dir)[0].message).toMatch(/nas\.local/);
  });

  it('only another server: a server_differs record that is no failure', async () => {
    const { watch, set, dir } = make();
    await watch.checkNow();
    set(camFtp({ server: 'nas.local' }));
    expect((await watch.checkNow()).state).toBe('server_differs');
    expect(checks(dir)[0]).toMatchObject({ event: { outcome: 'success' }, cam_proxy: { to: { state: 'server_differs' }, mismatch: ['server'] } });
  });

  it('never set up (no server, no clip ever): no record at all; set up later: still none (on is the baseline)', async () => {
    const { watch, set, dir } = make();
    set(camFtp({ enable: 0, server: '', userName: '' }));
    expect((await watch.checkNow()).state).toBe('not_set_up');
    expect(checks(dir)).toHaveLength(0);
    set(camFtp());
    expect((await watch.checkNow()).state).toBe('on');
    expect(checks(dir)).toHaveLength(0);
  });

  it('no server but clips were received before: off, recorded', async () => {
    const { watch, set, dir } = make({ clipsBefore: () => true });
    set(camFtp({ enable: 0, server: '' }));
    expect((await watch.checkNow()).state).toBe('off');
    expect(checks(dir)[0]).toMatchObject({ event: { outcome: 'failure' }, cam_proxy: { to: { state: 'off' } } });
  });

  it('off at the first read: recorded (the baseline is on); not again after a restart', async () => {
    const first = make();
    first.set(camFtp({ enable: 0 }));
    await first.watch.checkNow();
    expect(checks(first.dir)).toHaveLength(1);
    expect(checks(first.dir)[0]).toMatchObject({ cam_proxy: { from: { state: 'unknown' }, to: { state: 'off' } } });
    // A new process on the same audit folder: the last record is the before.
    const second = make({ dir: first.dir });
    second.set(camFtp({ enable: 0 }));
    await second.watch.checkNow();
    expect(checks(first.dir)).toHaveLength(1);
    second.set(camFtp());
    await second.watch.checkNow();
    expect(checks(first.dir).at(-1)).toMatchObject({ cam_proxy: { from: { state: 'off' }, to: { state: 'on' } } });
  });

  it('a failed read keeps the last state, with the error; no record', async () => {
    const { watch, set, dir } = make();
    await watch.checkNow();
    set(new Error('camera_offline'));
    expect(await watch.checkNow()).toMatchObject({ state: 'on', error: 'camera_offline' });
    expect(checks(dir)).toHaveLength(0);
  });

  it('inactive (FTP off in the proxy, or the camera offline): no read', async () => {
    const { watch, reads } = make({ active: () => false });
    expect((await watch.checkNow()).state).toBe('unknown');
    expect(reads()).toBe(0);
  });

  it('note(): an action\'s answer (setup, off) updates the state at once; a read in flight then is dropped', async () => {
    const { watch, set, dir } = make();
    set(camFtp({ enable: 0 }));
    await watch.checkNow();
    // A slow read of the old state, overtaken by the setup's answer.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow = new CameraFtpWatch({ read: async () => (await gate, camFtp({ enable: 0 })), target: () => TARGET, audit: new AuditLog({ dir, version: 't', camera: () => 'cam1' }), active: () => true });
    const inFlight = slow.checkNow();
    slow.note(camFtp());
    release();
    await inFlight;
    expect(slow.view().state).toBe('on');
    watch.note(camFtp());
    expect(watch.view().state).toBe('on');
  });

  it('checks every everyMs while started', async () => {
    const audit = new AuditLog({ dir: tmp('ftp-audit-'), version: 't', camera: () => 'cam1' });
    let reads = 0;
    const w = new CameraFtpWatch({ read: async () => (reads++, camFtp()), target: () => TARGET, audit, active: () => true, everyMs: 20 });
    w.start();
    await new Promise((r) => setTimeout(r, 110));
    w.stop();
    const n = reads;
    expect(n).toBeGreaterThanOrEqual(3);
    await new Promise((r) => setTimeout(r, 60));
    expect(reads).toBe(n);
  });
});

describe('clipsStalled', () => {
  let c: Catalog;
  let dir: string;
  beforeEach(() => {
    dir = tmp('ftp-cat-');
    c = openCatalog(join(dir, 'catalog.sqlite'));
  });
  afterEach(() => c.close());
  const H = 3600_000;
  const NOW = Date.UTC(2026, 9, 1, 21, 0, 0);
  const ev = (kind: string, ts: number) => insertEvent(c, { cam: 'cam1', source: 'onvif', kind, start_ts: ts, raw: null });
  const clip = (received_at: number) => insertClip(c, { cam: 'cam1', start_ts: received_at - 60_000, end_ts: received_at - 30_000, path: `cam1/${received_at}.mp4`, stream: 'main', size: 1, received_at, snapshot: null });

  it('no clip for N hours while recording events happened: stalled, with the last clip and the event count', () => {
    clip(NOW - 37 * H);
    ev('person', NOW - 3 * H);
    ev('motion', NOW - 2 * H);
    expect(clipsStalled(c, 'cam1', NOW, 6)).toEqual({ stalled: true, hours: 6, lastClip: NOW - 37 * H, events: 2 });
  });
  it('a quiet day (no events): no warning', () => {
    clip(NOW - 37 * H);
    expect(clipsStalled(c, 'cam1', NOW, 6)).toMatchObject({ stalled: false, events: 0 });
  });
  it('a clip within N hours: not stalled', () => {
    clip(NOW - 2 * H);
    ev('person', NOW - 1 * H);
    expect(clipsStalled(c, 'cam1', NOW, 6)).toMatchObject({ stalled: false, lastClip: NOW - 2 * H });
  });
  it('events older than N hours, or too recent for their clip yet, or of other kinds, do not count', () => {
    clip(NOW - 37 * H);
    ev('person', NOW - 7 * H);
    ev('person', NOW - STALL_GRACE_MS + 1000);
    ev('Visitor', NOW - 1 * H);
    expect(clipsStalled(c, 'cam1', NOW, 6)).toMatchObject({ stalled: false, events: 0 });
    ev('vehicle', NOW - 1 * H);
    expect(clipsStalled(c, 'cam1', NOW, 6)).toMatchObject({ stalled: true, events: 1 });
  });
  it('never a clip, but events: stalled, lastClip null; not while FTP is not set up on the camera', () => {
    ev('pet', NOW - 1 * H);
    expect(clipsStalled(c, 'cam1', NOW, 6)).toEqual({ stalled: true, hours: 6, lastClip: null, events: 1 });
    expect(clipsStalled(c, 'cam1', NOW, 6, { notSetUp: true })).toMatchObject({ stalled: false });
  });
  // Review of #94: retention (clips 24 h by default) must not forget the last clip.
  it('the last clip survives its deletion by retention', () => {
    clip(NOW - 37 * H);
    deleteClip(c, `cam1/${NOW - 37 * H}.mp4`);
    ev('person', NOW - 1 * H);
    expect(lastClipReceived(c, 'cam1')).toBe(NOW - 37 * H);
    expect(clipsStalled(c, 'cam1', NOW, 6)).toMatchObject({ stalled: true, lastClip: NOW - 37 * H });
    clip(NOW - 40 * H); // an older clip arriving late never moves it back
    expect(lastClipReceived(c, 'cam1')).toBe(NOW - 37 * H);
    expect(lastClipReceived(c, 'cam2')).toBeNull();
  });
});

describe('activity-daily (#93): clipsReceived next to the events', () => {
  const vision = { day: 0, monthToDate: 3, monthlyLimit: 100 };
  it('has clipsReceived and the recording events', () => {
    const a = activityDaily('2026-09-30', { events: { person: 3, motion: 2, Visitor: 1 }, clips: 4, vision, analyses: {}, sseClients: 1 });
    expect(a.details).toMatchObject({ events: { total: 6, byKind: { person: 3, motion: 2, Visitor: 1 } }, clips: 4, clipsReceived: 4, recordingEvents: 5 });
    expect(a.message).toBe('Activity 2026-09-30: 6 events (person 3, motion 2, Visitor 1), 4 clips received, Vision 3 of 100 this month');
    expect(a.details.noClips).toBeUndefined();
  });
  it('a day with recording events but no clips stands out', () => {
    const a = activityDaily('2026-09-30', { events: { person: 12 }, clips: 0, vision, analyses: {}, sseClients: 0 });
    expect(a.details).toMatchObject({ clipsReceived: 0, recordingEvents: 12, noClips: true });
    expect(a.message).toContain('NO clips received for 12 recording events');
  });
  it('a quiet day: no events, no clips, no flag', () => {
    const a = activityDaily('2026-09-30', { events: {}, clips: 0, vision, analyses: {}, sseClients: 0 });
    expect(a.message).toBe('Activity 2026-09-30: 0 events (none), 0 clips received, Vision 3 of 100 this month');
    expect(a.details.noClips).toBeUndefined();
  });
});
