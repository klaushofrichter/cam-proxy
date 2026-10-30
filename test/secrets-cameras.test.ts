import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { cameraPassword, cameraPasswordEnv, loadSecrets } from '../src/config/secrets';
import { SettingError } from '../src/config/schema';
import { applyOverrides, loadConfig } from '../src/config/load';

const BASE = { CAMPROXY_TOKENS: 'a'.repeat(32), CAMPROXY_ADMIN_TOKEN: 'c'.repeat(32) };

describe('camera passwords (spec §4.2)', () => {
  it('the env name: upper case, - → _', () => {
    expect(cameraPasswordEnv('cam-3')).toBe('CAMPROXY_CAMERA_PASSWORD_CAM_3');
  });
  it('the default for every camera, one camera overridden (also from a _FILE)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'camproxy-sec-'));
    writeFileSync(join(dir, 'pw4'), 'four\n');
    const s = loadSecrets({ ...BASE, CAMPROXY_CAMERA_PASSWORD: 'default', CAMPROXY_CAMERA_PASSWORD_CAM_3: 'three', CAMPROXY_CAMERA_PASSWORD_CAM4_FILE: join(dir, 'pw4') }, false, ['cam-3', 'cam4', 'cam5']);
    expect(cameraPassword(s, 'cam-3')).toBe('three');
    expect(cameraPassword(s, 'cam4')).toBe('four');
    expect(cameraPassword(s, 'cam5')).toBe('default');
  });
  it('no default is fine when every camera has its own; else the default is required', () => {
    expect(cameraPassword(loadSecrets({ ...BASE, CAMPROXY_CAMERA_PASSWORD_CAM3: 'x' }, false, ['cam3']), 'cam3')).toBe('x');
    expect(() => loadSecrets({ ...BASE, CAMPROXY_CAMERA_PASSWORD_CAM3: 'x' }, false, ['cam3', 'cam4'])).toThrow(new SettingError('CAMPROXY_CAMERA_PASSWORD: required (cam4 has no CAMPROXY_CAMERA_PASSWORD_CAM4)'));
  });
});

describe('a camera that moved away needs no password (plan D final review 1)', () => {
  it('config.json cam3 + cam4, overrides cam3.moved, only _CAM4 set: loads (also after a restart)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'camproxy-sec-moved-'));
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ cameras: [{ id: 'cam3', host: '192.0.2.3' }, { id: 'cam4', host: '192.0.2.4' }] }));
    const env = { ...BASE, CAMPROXY_CAMERA_PASSWORD_CAM4: 'four' };
    // Before the move both need one.
    expect(() => loadConfig(env, { cwd: dir })).toThrow(/cam3 has no CAMPROXY_CAMERA_PASSWORD_CAM3/);
    const full = loadConfig({ ...env, CAMPROXY_CAMERA_PASSWORD_CAM3: 'three' }, { cwd: dir });
    // The move hid cam3 (overrides.json); its password went with the cleanup. A restart loads.
    applyOverrides(full, { cameras: { cam3: { moved: 'mv_0123456789ABCDEFGHJK' } } });
    const l = loadConfig(env, { cwd: dir });
    expect(l.config.cameras.cam3.moved).toBe('mv_0123456789ABCDEFGHJK');
    expect(cameraPassword(l.secrets, 'cam4')).toBe('four');
  });
  it('loadSecrets: a moved camera is not required; an active one still is', () => {
    expect(cameraPassword(loadSecrets({ ...BASE, CAMPROXY_CAMERA_PASSWORD_CAM4: 'x' }, false, ['cam3', 'cam4'], { moved: ['cam3'] }), 'cam4')).toBe('x');
    expect(() => loadSecrets({ ...BASE, CAMPROXY_CAMERA_PASSWORD_CAM3: 'x' }, false, ['cam3', 'cam4'], { moved: ['cam3'] })).toThrow(/cam4 has no/);
    // Every camera moved away: nothing required.
    expect(() => loadSecrets(BASE, false, ['cam3'], { moved: ['cam3'] })).not.toThrow();
  });
});
