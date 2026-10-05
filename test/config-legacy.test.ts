import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { beforeEach, describe, expect, it } from 'vitest';
import { applyOverrides, ConfigError, loadConfig, needsRestart, removeOverride } from '../src/config/load';
import { cameraConfig, cameraIds } from '../src/config/cameras';

const SECRETS = { CAMPROXY_TOKENS: 'a'.repeat(32), CAMPROXY_ADMIN_TOKEN: 'c'.repeat(32), CAMPROXY_CAMERA_PASSWORD: 'cam-pw' };
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'camproxy-legacy-'));
});
const write = (name: string, v: unknown) => {
  mkdirSync(join(dir, name, '..'), { recursive: true });
  writeFileSync(join(dir, name), JSON.stringify(v));
};
const load = (env: Record<string, string> = {}) => loadConfig({ ...SECRETS, ...env }, { cwd: dir });
const err = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    expect(e).toBeInstanceOf(ConfigError);
    return (e as Error).message;
  }
  throw new Error('expected a ConfigError');
};

// The Pi's files as they are (spec §4.2, §11).
const PI_FILE = { camera: { id: 'cam1', host: '192.168.1.103', protocol: 'https', tlsName: 'cam1.skylar.technology', statusPollS: 30, poeSwitch: { model: 'sscpoe-web', host: '192.168.1.217', port: 8, ports: 8, offSeconds: 10 } }, ftp: { enabled: true, user: 'camera', publicHost: '192.168.1.220' } };

describe('legacy camera (spec §4.2)', () => {
  it('reads camera as a list of one; switch keys go to the host; ftp.user to the camera', () => {
    write('config.json', PI_FILE);
    const l = load({ CAMPROXY_FTP_PASSWORD: 'f' });
    expect(cameraIds(l.config)).toEqual(['cam1']);
    const c = cameraConfig(l.config, 'cam1')!;
    expect(c).toMatchObject({ id: 'cam1', name: 'Den', host: '192.168.1.103', tlsName: 'cam1.skylar.technology' });
    expect(c.poeSwitch).toEqual({ model: 'sscpoe-web', host: '192.168.1.217', port: 8, ports: 8, offSeconds: 10 });
    expect(c.ftp).toEqual({ user: 'camera', enabled: true, stream: 'main' });
    expect(l.config.poeSwitch).toEqual({ model: 'sscpoe-web', host: '192.168.1.217', ports: 8, offSeconds: 10 });
    expect(l.legacyCamera).toBe(true);
    expect(l.sources['cameras.cam1.host']).toBe('file');
    expect(l.sources['poeSwitch.host']).toBe('file');
  });

  it("a legacy camera without ftp.user keeps today's default user 'camera' (Ruling P1-11)", () => {
    write('config.json', { camera: { host: 'h' } });
    expect(cameraConfig(load().config, 'cam1')!.ftp.user).toBe('camera');
  });

  it('legacy overrides survive a save: read translated, written back in the new form', () => {
    write('config.json', { camera: { host: 'h' } });
    write('data/overrides.json', { camera: { statusPollS: 60, poeSwitch: { host: '192.0.2.9', port: 3 } }, ftp: { user: 'cam' } });
    const l = load();
    expect(cameraConfig(l.config, 'cam1')).toMatchObject({ statusPollS: 60, poeSwitch: { host: '192.0.2.9', port: 3 }, ftp: { user: 'cam' } });
    applyOverrides(l, { sse: { pingS: 20 } });
    expect(JSON.parse(readFileSync(join(dir, 'data', 'overrides.json'), 'utf8'))).toEqual({
      cameras: { cam1: { statusPollS: 60, poeSwitch: { port: 3 }, ftp: { user: 'cam' } } },
      poeSwitch: { host: '192.0.2.9' },
      sse: { pingS: 20 },
    });
  });

  it('a legacy override path is accepted by the API on one camera (Ruling P1-8)', () => {
    write('config.json', { camera: { host: 'h' } });
    const l = applyOverrides(load(), { camera: { statusPollS: 45 } });
    expect(cameraConfig(l.config, 'cam1')!.statusPollS).toBe(45);
    expect(cameraConfig(removeOverride(l, 'camera.statusPollS').config, 'cam1')!.statusPollS).toBe(30);
  });

  it('no camera and no cameras: one default camera cam1, idle (Ruling P1-10)', () => {
    write('config.json', {});
    const l = load();
    expect(cameraIds(l.config)).toEqual(['cam1']);
    expect(cameraConfig(l.config, 'cam1')).toMatchObject({ name: 'Den', host: '' });
  });
});

describe('cameras (spec §4.1)', () => {
  const two = { cameras: [{ id: 'cam3', host: '192.168.60.13' }, { id: 'cam4', host: '192.168.60.14', stills: { intervalS: 2 }, poeSwitch: { port: 2 } }], poeSwitch: { model: 'sscpoe-web', host: '192.168.60.2' } };

  it('the array in config order; defaults per camera; host overrides resolved', () => {
    write('config.json', two);
    const l = load();
    expect(cameraIds(l.config)).toEqual(['cam3', 'cam4']);
    expect(cameraConfig(l.config, 'cam3')).toMatchObject({ name: 'cam3', user: 'proxy', ftp: { user: 'cam3' }, stills: { intervalS: 1 } });
    expect(cameraConfig(l.config, 'cam4')).toMatchObject({ stills: { intervalS: 2 }, poeSwitch: { model: 'sscpoe-web', host: '192.168.60.2', port: 2 } });
    expect(l.legacyCamera).toBe(false);
    expect(l.sources['cameras.cam4.stills.intervalS']).toBe('file');
    expect(l.sources['cameras.cam3.stills.intervalS']).toBe('default');
  });

  // Review: `file` and `x-file` would read another variable's _FILE path as their password (CAMPROXY_CAMERA_PASSWORD_FILE, _X_FILE).
  it('refuses the ids file and *-file', () => {
    for (const id of ['file', 'cam3-file']) {
      write('config.json', { cameras: [{ id, host: 'h' }] });
      expect(err(() => load())).toBe(`cameras.${id}: not a camera id`);
    }
    write('config.json', { cameras: [{ id: 'filer', host: 'h' }, { id: 'file3', host: 'i' }] });
    expect(cameraIds(load().config)).toEqual(['filer', 'file3']);
  });

  it('integer-like ids keep config order', () => {
    write('config.json', { cameras: [{ id: '2', host: 'a' }, { id: '10', host: 'b' }, { id: '1', host: 'c' }] });
    expect(cameraIds(load().config)).toEqual(['2', '10', '1']);
  });

  it('refuses camera with cameras, duplicate ids, an empty list, a bad id', () => {
    write('config.json', { camera: { host: 'h' }, cameras: [{ id: 'cam3' }] });
    expect(err(() => load())).toBe('camera: use either camera (one camera) or cameras, not both');
    write('config.json', { cameras: [{ id: 'cam3' }, { id: 'cam3' }] });
    expect(err(() => load())).toBe('cameras: duplicate id cam3');
    write('config.json', { cameras: [] });
    expect(err(() => load())).toBe('cameras: at least one camera');
    write('config.json', { cameras: [{ id: 'Cam3' }] });
    expect(err(() => load())).toBe('cameras.Cam3: not a camera id');
    write('config.json', { cameras: [{ host: 'x' }] });
    expect(err(() => load())).toBe('cameras[0].id: required');
  });

  it('a legacy camera.* override with several cameras is a load error naming the path', () => {
    write('config.json', two);
    write('data/overrides.json', { camera: { statusPollS: 60 } });
    expect(err(() => load())).toBe("camera.statusPollS: a legacy camera override can't be assigned with several cameras; use cameras.<id>.statusPollS");
  });

  it('an override for a camera config.json does not define is refused (Ruling P1-13)', () => {
    write('config.json', two);
    write('data/overrides.json', { cameras: { cam9: { host: 'x' } } });
    expect(err(() => load())).toBe('cameras.cam9: unknown camera (cameras are added in config.json)');
  });

  it('CAMERA_HOST with several cameras is a load error', () => {
    write('config.json', two);
    expect(err(() => load({ CAMERA_HOST: '10.0.0.1' }))).toBe('CAMERA_HOST: set cameras[].host instead (several cameras)');
  });

  it('FTP for several cameras: unique users, ≥ 10 passive ports per camera', () => {
    write('config.json', { ...two, ftp: { enabled: true, passive: '50000-50019' } });
    expect(cameraIds(load({ CAMPROXY_FTP_PASSWORD: 'f' }).config)).toEqual(['cam3', 'cam4']);
    write('config.json', { ...two, ftp: { enabled: true, passive: '50000-50009' } });
    expect(err(() => load({ CAMPROXY_FTP_PASSWORD: 'f' }))).toBe('ftp.passive: 10 ports for 2 cameras with FTP; at least 10 per camera');
    write('config.json', { ftp: { enabled: true, passive: '50000-50019' }, cameras: [{ id: 'cam3', ftp: { user: 'cam' } }, { id: 'cam4', ftp: { user: 'cam' } }] });
    expect(err(() => load({ CAMPROXY_FTP_PASSWORD: 'f' }))).toBe('cameras: cam3 and cam4 both use the FTP user cam');
    write('config.json', { ...two, ftp: { enabled: false }, cameras: [{ id: 'cam3', ftp: { enabled: true } }, { id: 'cam4' }] });
    expect(cameraConfig(load({ CAMPROXY_FTP_PASSWORD: 'f' }).config, 'cam3')!.ftp.enabled).toBe(true);
  });


  it('per-camera restart and live rules', async () => {

    expect(needsRestart('cameras.cam3.host')).toBe(true);
    expect(needsRestart('cameras.cam3.poeSwitch.port')).toBe(false);
    expect(needsRestart('cameras.cam3.baichuanPort')).toBe(false);
    expect(needsRestart('cameras.cam3.analytics.kinds.person')).toBe(false);
    expect(needsRestart('poeSwitch.host')).toBe(false);
  });
});
