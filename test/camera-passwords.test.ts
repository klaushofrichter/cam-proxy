import { mkdtempSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { cameraPasswordStore } from '../src/config/camera-passwords';
import { loadConfig } from '../src/config/load';
import { loadSecrets } from '../src/config/secrets';

const T = 'a'.repeat(40);
const A = 'b'.repeat(40);
const base = { CAMPROXY_TOKENS: T, CAMPROXY_ADMIN_TOKEN: A };
const tmp = () => mkdtempSync(join(tmpdir(), 'campw-'));

describe('camera password store', () => {
  it('stores, reads and deletes in a 600 file', () => {
    const d = tmp();
    const s = cameraPasswordStore(d);
    expect(s.get('cam1')).toBeUndefined();
    s.set('cam1', 'pw-one');
    s.set('cam2', 'pw-two');
    expect(s.get('cam1')).toBe('pw-one');
    expect(statSync(join(d, 'admin', 'camera-passwords.json')).mode & 0o777).toBe(0o600);
    s.delete('cam1');
    expect(s.get('cam1')).toBeUndefined();
    expect(s.get('cam2')).toBe('pw-two');
    expect(s.get('__proto__')).toBeUndefined();
  });

  it('store password is used when no env var', () => {
    const d = tmp();
    cameraPasswordStore(d).set('cam1', 'stored-pw');
    const sec = loadSecrets({ ...base, CAMPROXY_CAMERA_PASSWORD: 'default-pw' }, false, ['cam1', 'cam2'], { dataDir: d });
    expect(sec.cameraPasswords).toEqual({ cam1: 'stored-pw' });
  });

  it('env var wins over the store', () => {
    const d = tmp();
    cameraPasswordStore(d).set('cam1', 'stored-pw');
    const sec = loadSecrets({ ...base, CAMPROXY_CAMERA_PASSWORD_CAM1: 'env-pw' }, false, ['cam1'], { dataDir: d });
    expect(sec.cameraPasswords).toEqual({ cam1: 'env-pw' });
  });

  it('a corrupt store is a setting error that does not show its content', () => {
    const d = tmp();
    mkdirSync(join(d, 'admin'));
    writeFileSync(join(d, 'admin', 'camera-passwords.json'), 'oops-secret{', { mode: 0o600 });
    expect(() => loadSecrets({ ...base, CAMPROXY_CAMERA_PASSWORD: 'x' }, false, ['cam1'], { dataDir: d })).toThrow(/camera-passwords\.json/);
    try {
      loadSecrets({ ...base, CAMPROXY_CAMERA_PASSWORD: 'x' }, false, ['cam1'], { dataDir: d });
    } catch (e) {
      expect((e as Error).message).not.toContain('oops-secret');
    }
  });

  it('several cameras read from the store; the store is not read when every camera has its env var', () => {
    const d = tmp();
    const s = cameraPasswordStore(d);
    s.set('cam1', 'pw-one');
    s.set('cam3', 'pw-three');
    const sec = loadSecrets({ ...base, CAMPROXY_CAMERA_PASSWORD_CAM2: 'env-two', CAMPROXY_CAMERA_PASSWORD: 'x' }, false, ['cam1', 'cam2', 'cam3', 'cam4'], { dataDir: d });
    expect(sec.cameraPasswords).toEqual({ cam1: 'pw-one', cam2: 'env-two', cam3: 'pw-three' });
    writeFileSync(join(d, 'admin', 'camera-passwords.json'), 'not json', { mode: 0o600 });
    expect(loadSecrets({ ...base, CAMPROXY_CAMERA_PASSWORD_CAM1: 'env-one' }, false, ['cam1'], { dataDir: d }).cameraPasswords).toEqual({ cam1: 'env-one' });
  });

  it('a live-added camera with a stored password starts without CAMPROXY_CAMERA_PASSWORD', () => {
    const d = tmp();
    writeFileSync(join(d, 'config.json'), JSON.stringify({ server: { dataDir: join(d, 'data') }, cameras: [{ id: 'cam1', host: '192.0.2.1' }] }));
    expect(() => loadConfig({ ...base }, { cwd: d })).toThrow(/CAMPROXY_CAMERA_PASSWORD: required/);
    cameraPasswordStore(join(d, 'data')).set('cam1', 'stored-pw');
    const loaded = loadConfig({ ...base }, { cwd: d });
    expect(loaded.secrets.cameraPasswords.cam1).toBe('stored-pw');
    expect(readFileSync(join(d, 'data', 'admin', 'camera-passwords.json'), 'utf8')).toContain('stored-pw');
  });
});
