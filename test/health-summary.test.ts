import { describe, expect, it } from 'vitest';
import { buildHealth, type HealthInput } from '../src/health/summary';
import { H, input, NOW } from './helpers/health-input';

const item = (h: ReturnType<typeof buildHealth>, id: string) => h.items.find((i) => i.id === id);

describe('the health summary', () => {
  it('all fine on a Pi: every item in order, no problem', () => {
    const h = buildHealth(input());
    expect(h.schema).toBe(1);
    expect(h.generatedAt).toBe(NOW);
    expect(h.ok).toBe(true);
    expect(h.problemCount).toBe(0);
    expect(h.items.map((i) => i.id)).toEqual(['camera', 'stream', 'events', 'ftp', 'storage', 'disk', 'cpuTemp', 'underVoltage', 'inventory', 'version']);
    expect(h.items.map((i) => [i.id, i.value, i.text])).toEqual([
      ['camera', true, 'online'],
      ['stream', 'up', 'up'],
      ['events', 'subscribed', 'subscribed'],
      ['ftp', 'on', 'on'],
      ['storage', 'writing', 'writing'],
      ['disk', 11.4, '11.4 % of 228.6 GB'],
      ['cpuTemp', 53.6, '53.6 °C'],
      ['underVoltage', false, 'no'],
      ['inventory', 'ok', 'clips: ok'],
      ['version', '2026.10.03.2', '2026.10.03.2'],
    ]);
    expect(item(h, 'camera')?.label).toBe('Camera');
    expect(h.platform).toEqual({ pi: true, model: 'Raspberry Pi 4 Model B Rev 1.5', hostStats: true });
    expect(h.thresholds).toEqual({ diskPercent: 90, tempC: 75, ftpStalledHours: 6 });
  });

  it('the details: camera address without its port, the switch without its host, no serial', () => {
    const h = buildHealth(input());
    expect(h.camera).toEqual({ id: 'cam1', name: 'Den', address: '192.168.1.103', online: true, since: NOW - H, model: 'RLC-1224A', firmware: 'v3.1', clockOffsetMs: -412, error: null, reboot: null, poeSwitch: { model: 'sscpoe-web', port: 8 } });
    expect(JSON.stringify(h)).not.toContain('SERIAL-123');
    expect(h.stream).toEqual({ enabled: true, up: true, lastFrameAt: NOW - 1000 });
    expect(h.events).toEqual({ onvif: 'subscribed', source: 'onvif', since: NOW - H, resubscribes: 3 });
    expect(h.ftp).toEqual({ enabled: true, listening: true, cameraUpload: 'on', checkedAt: NOW - 60_000, lastClipAt: NOW - H, clipsStored: 412, failures: 0, stalled: false, eventsWithoutClip: 0 });
    expect(JSON.stringify(h.ftp)).not.toMatch(/192\.168\.1\.220|2121|"camera"/);
    expect(h.proxy).toEqual({ sseClients: 2, storagePaused: false, lastRetentionRun: NOW - 30 * 60_000, recordingsCache: { bytes: 1000, files: 1, capBytes: 2 ** 31 }, lastInventory: { kind: 'clips', op: 'check', outcome: 'ok', startedAt: NOW - 5 * H, message: 'Clips check: nothing missing' } });
    expect(h.startedAt).toBe(NOW - 2 * H);
    expect(h.disk?.usedPercent).toBe(11.4);
    expect(h.host?.uptimeS).toBe(412233);
  });

  it('camera offline is a problem; rebooting and power-cycling say so', () => {
    const off = (reboot: HealthInput['camera']['reboot']) => buildHealth(input({ camera: { ...input().camera, state: { online: false, since: NOW, error: 'timeout' }, reboot } }));
    expect(item(off(null), 'camera')).toMatchObject({ value: false, text: 'offline', problem: true });
    expect(off(null).camera).toMatchObject({ error: 'timeout', model: null, firmware: null, clockOffsetMs: null });
    expect(item(off('rebooting'), 'camera')?.text).toBe('rebooting');
    expect(item(off('power-cycling'), 'camera')?.text).toBe('power-cycling');
    expect(off(null).ok).toBe(false);
    expect(off(null).problemCount).toBe(1);
  });

  it('the stream is a problem only when down while enabled', () => {
    expect(item(buildHealth(input({ stream: { enabled: true, up: false, lastFrameTs: null } })), 'stream')).toMatchObject({ value: 'down', text: 'down', problem: true });
    expect(item(buildHealth(input({ stream: { enabled: false, up: false, lastFrameTs: null } })), 'stream')).toMatchObject({ value: 'off', text: 'off', problem: false });
  });

  it('events: anything but subscribed is a problem, polling noted', () => {
    expect(item(buildHealth(input({ intake: { onvif: 'down', since: NOW, source: 'poll', resubscribes: 0 } })), 'events')).toMatchObject({ value: 'down', text: 'down, polling', problem: true });
    expect(item(buildHealth(input({ intake: { onvif: 'connecting', since: NOW, source: 'none', resubscribes: 0 } })), 'events')).toMatchObject({ value: 'connecting', text: 'connecting', problem: true });
  });

  describe('camera FTP upload', () => {
    const withCam = (state: string, over: object = {}) => buildHealth(input({ ftp: { ...input().ftp, camera: { ...input().ftp.camera!, state: state as never }, ...over } }));
    it('off, elsewhere and never set up (Klaus, 2026-10-03) are problems', () => {
      expect(item(withCam('off'), 'ftp')).toMatchObject({ value: 'off', text: 'off on the camera', problem: true });
      expect(item(withCam('not_set_up'), 'ftp')).toMatchObject({ value: 'not_set_up', text: 'not set up', problem: true });
      expect(item(withCam('elsewhere'), 'ftp')).toMatchObject({ value: 'elsewhere', text: 'points elsewhere', problem: true });
    });
    it('another server name and not read yet are not', () => {
      expect(item(withCam('server_differs'), 'ftp')).toMatchObject({ text: 'other server name', problem: false });
      expect(item(withCam('unknown'), 'ftp')).toMatchObject({ text: 'not read yet', problem: false });
    });
    it('stalled is a problem whatever the camera says', () => {
      const h = withCam('on', { stalled: { stalled: true, hours: 6, lastClip: NOW - 37 * H, events: 12 } });
      expect(item(h, 'ftp')).toMatchObject({ value: 'on', text: 'no clip for 6 h', problem: true });
      expect(h.ftp).toMatchObject({ stalled: true, eventsWithoutClip: 12 });
    });
    it('FTP off in the proxy: disabled, no problem', () => {
      const h = buildHealth(input({ ftp: { enabled: false, listening: false, camera: null, stalled: null, lastClip: null, clips: 0, failures: 0 } }));
      expect(item(h, 'ftp')).toMatchObject({ value: 'disabled', text: 'off in the proxy', problem: false });
      expect(h.ftp).toMatchObject({ enabled: false, cameraUpload: null, checkedAt: null, stalled: false });
    });
  });

  it('storage paused is a problem', () => {
    const h = buildHealth(input({ storage: { paused: true, lastRun: null } }));
    expect(item(h, 'storage')).toMatchObject({ value: 'paused', text: 'paused (low space)', problem: true });
    expect(h.proxy.storagePaused).toBe(true);
  });

  it('disk: a problem from the threshold on, which is a setting', () => {
    const disk = (usedPercent: number, diskPercent = 90) => item(buildHealth(input({ thresholds: { diskPercent, tempC: 75, ftpStalledHours: 6 }, reading: { ...input().reading, disk: { sizeBytes: 100 * 1024 ** 3, freeBytes: 0, usedBytes: 0, usedPercent } } })), 'disk');
    expect(disk(89.9)?.problem).toBe(false);
    expect(disk(90)?.problem).toBe(true);
    expect(disk(90)?.text).toBe('90.0 % of 100.0 GB');
    expect(disk(85, 80)?.problem).toBe(true);
  });

  it('CPU temperature: a problem from the threshold on', () => {
    const temp = (cpuTempC: number, tempC = 75) => item(buildHealth(input({ thresholds: { diskPercent: 90, tempC, ftpStalledHours: 6 }, reading: { ...input().reading, host: { ...input().reading.host!, cpuTempC } } })), 'cpuTemp');
    expect(temp(74.9)?.problem).toBe(false);
    expect(temp(75)).toMatchObject({ value: 75, text: '75.0 °C', problem: true });
    expect(temp(60, 50)?.problem).toBe(true);
  });

  it('under-voltage is a problem', () => {
    expect(item(buildHealth(input({ reading: { ...input().reading, host: { ...input().reading.host!, underVoltage: true } } })), 'underVoltage')).toMatchObject({ value: true, text: 'detected', problem: true });
  });

  it('inventory: a failed last run is a problem, cancelled is not, none yet', () => {
    const inv = (outcome: 'ok' | 'failed' | 'cancelled', op: 'check' | 'repair' = 'check') => item(buildHealth(input({ lastInventory: { kind: 'events', op, outcome, startedAt: NOW, message: 'm' } })), 'inventory');
    expect(inv('failed')).toMatchObject({ value: 'failed', text: 'events: failed', problem: true });
    expect(inv('failed', 'repair')?.text).toBe('events repair: failed');
    expect(inv('cancelled')?.problem).toBe(false);
    expect(item(buildHealth(input({ lastInventory: null })), 'inventory')).toMatchObject({ value: null, text: 'none yet', problem: false });
  });

  it('a figure that is null is left out and never a problem', () => {
    const h = buildHealth(input({ reading: { platform: { pi: true, model: 'Raspberry Pi 4 Model B Rev 1.5', hostStats: true }, disk: null, host: { cpuTempC: null, underVoltage: null, memory: null, uptimeS: null, load: null } } }));
    expect(h.items.map((i) => i.id)).toEqual(['camera', 'stream', 'events', 'ftp', 'storage', 'inventory', 'version']);
    expect(h.disk).toBeNull();
    expect(h.ok).toBe(true);
  });

  it('off a Pi (the cluster): no host figures, no Pi lines, the disk still checked', () => {
    const h = buildHealth(input({ camera: { ...input().camera, host: 'cam2.cam-sim.svc.cluster.local:443', poeSwitch: null }, reading: { platform: { pi: false, model: null, hostStats: false }, disk: { sizeBytes: 1, freeBytes: 0, usedBytes: 1, usedPercent: 95 }, host: null } }));
    expect(h.items.map((i) => i.id)).toEqual(['camera', 'stream', 'events', 'ftp', 'storage', 'disk', 'inventory', 'version']);
    expect(h.host).toBeNull();
    expect(h.platform).toEqual({ pi: false, model: null, hostStats: false });
    expect(h.camera.address).toBe('cam2.cam-sim.svc.cluster.local');
    expect(h.camera.poeSwitch).toBeNull();
    expect(item(h, 'disk')?.problem).toBe(true);
    expect(h.problemCount).toBe(1);
  });

  // Spec 2026-10-05-archive-design §6: the Archive's size against archive.warnPercent.
  it('the archive item: after the disk while the Archive is on, a problem above warnPercent', () => {
    const on = (percentOfDisk: number, warning: boolean, count = 12) => buildHealth(input({ thresholds: { diskPercent: 90, tempC: 75, ftpStalledHours: 6, archiveWarnPercent: 50 }, archive: { count, bytes: 1.25 * 1024 ** 3, percentOfDisk, warning } }));
    const h = on(0.5, false);
    expect(h.items.map((i) => i.id)).toEqual(['camera', 'stream', 'events', 'ftp', 'storage', 'disk', 'archive', 'cpuTemp', 'underVoltage', 'inventory', 'version']);
    expect(item(h, 'archive')).toEqual({ id: 'archive', label: 'Archive', value: 0.5, text: '12 clips, 1.3 GB (0.5 % of disk)', problem: false });
    expect(h.thresholds.archiveWarnPercent).toBe(50);
    expect(h.ok).toBe(true);
    const over = on(50.1, true, 1);
    expect(item(over, 'archive')).toMatchObject({ problem: true, text: '1 clip, 1.3 GB (50.1 % of disk)' });
    expect(over.problemCount).toBe(1);
    expect(buildHealth(input({ archive: null })).items.map((i) => i.id)).not.toContain('archive');
  });

  it('the version is never a problem', () => {
    expect(item(buildHealth(input({ version: 'dev' })), 'version')).toMatchObject({ value: 'dev', text: 'dev', problem: false });
  });
});
describe('several cameras (spec §6.5)', () => {
  const cam = (id: string, online: boolean) => ({
    camera: { ...input().camera, id, name: id, host: `192.168.60.${id.slice(3)}`, state: online ? input().camera.state : { online: false, since: NOW, error: 'timeout' } },
    stream: input().stream, intake: input().intake, ftp: input().ftp,
  });
  it('the top level is the first camera; one aggregated item per kind', () => {
    const h = buildHealth(input({ others: [cam('cam4', false), cam('cam5', true)] }));
    expect(h.camera.id).toBe('cam1');
    expect(h.cameras.map((c) => [c.camera.id, c.camera.online])).toEqual([['cam1', true], ['cam4', false], ['cam5', true]]);
    expect(item(h, 'camera')).toEqual({ id: 'camera', label: 'Camera', value: 2, text: 'cam4 offline', problem: true });
    expect(item(h, 'stream')).toEqual({ id: 'stream', label: 'Live stream', value: 3, text: 'all 3 up', problem: false });
    expect(h.items.filter((i) => i.id === 'camera')).toHaveLength(1);
    expect(h.problemCount).toBe(1);
  });
  it('more than one with the problem: "n of N"', () => {
    const h = buildHealth(input({ camera: cam('cam1', false).camera, others: [cam('cam4', false), cam('cam5', true)] }));
    expect(item(h, 'camera')).toMatchObject({ value: 1, text: '1 of 3 online', problem: true });
  });
  it('no problem but different states: says so without a count of a state', () => {
    const off = { ...input().stream, enabled: false, up: false };
    const h = buildHealth(input({ others: [{ ...cam('cam4', true), stream: off }] }));
    expect(item(h, 'stream')).toMatchObject({ value: 2, text: 'no problem (2 cameras)', problem: false });
  });
});
