import { describe, expect, it } from 'vitest';
import { cameraDefaults, DEFAULTS, type Config } from '../src/config/defaults';
import { cameraConfig, cameraEvents, cameraIds, firstCameraId } from '../src/config/cameras';

const cfg = (): Config => {
  const c = structuredClone(DEFAULTS);
  c.cameras = { cam1: { ...cameraDefaults('cam1'), name: 'Den', host: '192.0.2.10', poeSwitch: { port: 8 }, ftp: { user: 'camera' } } };
  c.cameraOrder = ['cam1'];
  c.poeSwitch = { model: 'sscpoe-web', host: '192.0.2.2', ports: 8, offSeconds: 10 };
  return c;
};

describe('camera accessors (spec §4.1)', () => {
  it('one camera: its id, first in order', () => {
    expect(cameraIds(cfg())).toEqual(['cam1']);
    expect(firstCameraId(cfg())).toBe('cam1');
  });
  it('resolves the camera with the host stills, events, kinds, FTP user and switch', () => {
    const r = cameraConfig(cfg(), 'cam1')!;
    expect(r).toMatchObject({ id: 'cam1', name: 'Den', host: '192.0.2.10', protocol: 'https', user: 'proxy', statusPollS: 30 });
    expect(r.poeSwitch).toEqual({ model: 'sscpoe-web', host: '192.0.2.2', port: 8, ports: 8, offSeconds: 10 });
    expect(r.ftp).toEqual({ user: 'camera', enabled: false, stream: 'main' });
    expect(r.stills).toEqual(DEFAULTS.stills);
    expect(r.events).toEqual(DEFAULTS.events);
    expect(r.analytics.kinds).toEqual(DEFAULTS.analytics.kinds);
  });
  it('an unknown id: undefined', () => {
    expect(cameraConfig(cfg(), 'cam9')).toBeUndefined();
  });
  it('the result is a copy: changing it never changes the config', () => {
    const c = cfg();
    cameraConfig(c, 'cam1')!.stills.intervalS = 5;
    expect(c.stills.intervalS).toBe(1);
  });
  it('cameraEvents: the live host object while the camera overrides nothing', () => {
    const c = cfg();
    expect(cameraEvents(c, 'cam1')).toBe(c.events);
  });
});
