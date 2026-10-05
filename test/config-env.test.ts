import { beforeEach, describe, expect, it } from 'vitest';
import { cameraConfig } from '../src/config/cameras';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { applyOverrides, ConfigError, envSummary, loadConfig } from '../src/config/load';

// Spec 2026-10-04-pi-config-design §1: CAMERA_HOST and PI_ADDRESS from the
// environment (or the mounted .env file) over the overrides and config.json.

const SECRETS = { CAMPROXY_TOKENS: 'a'.repeat(32), CAMPROXY_ADMIN_TOKEN: 'c'.repeat(32), CAMPROXY_CAMERA_PASSWORD: 'cam-pw' };

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'camproxy-env-'));
});
const write = (name: string, v: unknown) => writeFileSync(join(dir, name), typeof v === 'string' ? v : JSON.stringify(v));
const load = (env: Record<string, string> = {}) => loadConfig({ ...SECRETS, ...env }, { cwd: dir });
const err = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ConfigError);
    return (e as Error).message;
  }
  throw new Error('expected a ConfigError');
};

describe('CAMERA_HOST and PI_ADDRESS', () => {
  it('set camera.host, ftp.publicHost and server.publicUrl; config.json may leave camera.host out', () => {
    write('config.json', { server: { port: 8480 } });
    const l = load({ CAMERA_HOST: '192.168.1.20', PI_ADDRESS: '192.168.1.220' });
    expect(cameraConfig(l.config, 'cam1')!.host).toBe('192.168.1.20');
    expect(l.config.ftp.publicHost).toBe('192.168.1.220');
    expect(l.config.server.publicUrl).toBe('http://192.168.1.220:8480');
    expect(l.sources['cameras.cam1.host']).toBe('env');
    expect(l.sources['ftp.publicHost']).toBe('env');
    expect(l.sources['server.publicUrl']).toBe('env');
    expect(l.envNames).toEqual({ 'cameras.cam1.host': 'CAMERA_HOST', 'ftp.publicHost': 'PI_ADDRESS', 'server.publicUrl': 'PI_ADDRESS' });
  });

  it('accepts the CAMPROXY_ names, which win over the plain ones', () => {
    const l = load({ CAMERA_HOST: '10.0.0.1', CAMPROXY_CAMERA_HOST: '10.0.0.2:8443', PI_ADDRESS: '10.0.0.3', CAMPROXY_PI_ADDRESS: 'pi.lan' });
    expect(cameraConfig(l.config, 'cam1')!.host).toBe('10.0.0.2:8443');
    expect(l.config.ftp.publicHost).toBe('pi.lan');
    expect(l.envNames['cameras.cam1.host']).toBe('CAMPROXY_CAMERA_HOST');
  });

  it('uses server.port in publicUrl', () => {
    write('config.json', { server: { port: 9000 } });
    expect(load({ CAMERA_HOST: 'h', PI_ADDRESS: '10.0.0.3' }).config.server.publicUrl).toBe('http://10.0.0.3:9000');
  });

  it('precedence: environment > overrides > config.json', () => {
    write('config.json', { camera: { host: 'file-host' }, ftp: { publicHost: 'file-pi' }, server: { publicUrl: 'http://file' } });
    let l = load();
    l = applyOverrides(l, { camera: { host: 'override-host' } });
    expect(cameraConfig(l.config, 'cam1')!.host).toBe('override-host');
    expect(l.sources['cameras.cam1.host']).toBe('override');
    l = load({ CAMERA_HOST: 'env-host' });
    expect(cameraConfig(l.config, 'cam1')!.host).toBe('env-host');
    expect(l.sources['cameras.cam1.host']).toBe('env');
    expect(l.config.ftp.publicHost).toBe('file-pi');
    expect(l.sources['ftp.publicHost']).toBe('file');
  });

  it('an empty value counts as unset', () => {
    write('config.json', { camera: { host: 'file-host' } });
    const l = load({ CAMERA_HOST: '', PI_ADDRESS: '' });
    expect(cameraConfig(l.config, 'cam1')!.host).toBe('file-host');
    expect(l.sources['cameras.cam1.host']).toBe('file');
    expect(l.config.server.publicUrl).toBeUndefined();
  });

  it('refuses bad values, naming the variable', () => {
    expect(err(() => load({ CAMERA_HOST: 'http://10.0.0.1' }))).toBe('CAMERA_HOST: must be an address or name, optional :port');
    expect(err(() => load({ CAMERA_HOST: '10.0.0.1:99999' }))).toBe('CAMERA_HOST: must be an address or name, optional :port');
    expect(err(() => load({ CAMPROXY_CAMERA_HOST: 'a b' }))).toBe('CAMPROXY_CAMERA_HOST: must be an address or name, optional :port');
    expect(err(() => load({ CAMERA_HOST: 'h', PI_ADDRESS: '10.0.0.3:80' }))).toBe('PI_ADDRESS: must be an address or name, without a port');
  });

  it('an override of an env-set setting is refused', () => {
    const l = load({ CAMERA_HOST: '10.0.0.1' });
    expect(err(() => applyOverrides(l, { camera: { host: 'x' } }))).toBe('cameras.cam1.host: set in .env (CAMERA_HOST)');
    expect(err(() => applyOverrides(load({ CAMERA_HOST: 'h', PI_ADDRESS: 'p' }), { server: { publicUrl: 'http://x' } }))).toBe('server.publicUrl: set in .env (PI_ADDRESS)');
  });

  it('a stored override stays stored but the environment wins', () => {
    write('config.json', { camera: { host: 'file-host' } });
    applyOverrides(load(), { camera: { host: 'override-host' } });
    const l = load({ CAMERA_HOST: 'env-host' });
    expect(cameraConfig(l.config, 'cam1')!.host).toBe('env-host');
  });
});

describe('CAMPROXY_ENV_FILE', () => {
  it('its current CAMERA_HOST and PI_ADDRESS win over the process environment', () => {
    write('.env', 'CAMPROXY_TOKENS=never-read-from-here\nCAMERA_HOST=10.0.0.9\nPI_ADDRESS="10.0.0.8"\n');
    const l = load({ CAMPROXY_ENV_FILE: join(dir, '.env'), CAMERA_HOST: '10.0.0.1', PI_ADDRESS: '10.0.0.2' });
    expect(cameraConfig(l.config, 'cam1')!.host).toBe('10.0.0.9');
    expect(l.config.ftp.publicHost).toBe('10.0.0.8');
    // Secrets never come from the file.
    expect(l.secrets.tokens).toEqual(['a'.repeat(32)]);
  });

  it('any name in the file wins over any name in the process environment, CAMPROXY_CAMERA_HOST included', () => {
    // "Use this address" writes the file and restarts: the file must win, or
    // a CAMPROXY_CAMERA_HOST in compose's environment would undo it.
    write('.env', 'CAMERA_HOST=10.0.0.9\n');
    const l = load({ CAMPROXY_ENV_FILE: join(dir, '.env'), CAMPROXY_CAMERA_HOST: '10.0.0.1' });
    expect(cameraConfig(l.config, 'cam1')!.host).toBe('10.0.0.9');
    expect(l.envNames['cameras.cam1.host']).toBe('CAMERA_HOST');
    // Within one source the CAMPROXY_ name wins.
    write('.env', 'CAMERA_HOST=10.0.0.9\nCAMPROXY_CAMERA_HOST=10.0.0.8\n');
    expect(load({ CAMPROXY_ENV_FILE: join(dir, '.env') }).config.cameras.cam1.host).toBe('10.0.0.8');
  });

  it('falls back to the process environment for a key the file leaves out', () => {
    write('.env', 'PI_ADDRESS=10.0.0.8\n');
    const l = load({ CAMPROXY_ENV_FILE: join(dir, '.env'), CAMERA_HOST: '10.0.0.1' });
    expect(cameraConfig(l.config, 'cam1')!.host).toBe('10.0.0.1');
  });

  it('a missing or bad file is not an error: the process environment applies', () => {
    const l = load({ CAMPROXY_ENV_FILE: join(dir, 'nope', '.env'), CAMERA_HOST: '10.0.0.1' });
    expect(cameraConfig(l.config, 'cam1')!.host).toBe('10.0.0.1');
    expect(l.envFile).toEqual({ path: join(dir, 'nope', '.env'), read: false });
  });
});

describe('envSummary', () => {
  it('lists the settings taken from the environment, with values (no secrets)', () => {
    write('.env', 'CAMERA_HOST=10.0.0.9\n');
    const l = load({ CAMPROXY_ENV_FILE: join(dir, '.env'), PI_ADDRESS: '10.0.0.2' });
    expect(envSummary(l)).toEqual({ 'cameras.cam1.host': '10.0.0.9', 'ftp.publicHost': '10.0.0.2', 'server.publicUrl': 'http://10.0.0.2:8480', envFile: true });
    expect(JSON.stringify(envSummary(l))).not.toContain('cam-pw');
  });
  it('is empty without them', () => {
    write('config.json', { camera: { host: 'h' } });
    expect(envSummary(load())).toEqual({ envFile: false });
  });
});
