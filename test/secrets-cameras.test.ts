import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { cameraPassword, cameraPasswordEnv, loadSecrets } from '../src/config/secrets';
import { SettingError } from '../src/config/schema';

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
