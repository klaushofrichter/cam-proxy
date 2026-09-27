import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadConfig, applyOverrides, removeOverride, needsRestart, ConfigError } from '../src/config/load';
import { DEFAULTS } from '../src/config/defaults';
import { jsonSchema } from '../src/config/schema';

const T1 = 'a'.repeat(32);
const T2 = 'b'.repeat(40);
const ADMIN = 'c'.repeat(32);
const SECRETS = { CAMPROXY_TOKENS: `${T1}, ${T2}`, CAMPROXY_ADMIN_TOKEN: ADMIN, CAMPROXY_CAMERA_PASSWORD: 'cam-pw' };

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'camproxy-config-'));
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

describe('config.json', () => {
  it('needs only the camera host; everything else has a default', () => {
    write('config.json', { camera: { host: '192.0.2.10' } });
    const l = load();
    expect(l.config.camera.host).toBe('192.0.2.10');
    expect(l.config.server.port).toBe(8480);
    expect(l.config.stills.intervalS).toBe(1);
    expect(l.config.server.dataDir).toBe(join(dir, 'data'));
    expect(l.sources['camera.host']).toBe('file');
    expect(l.sources['server.port']).toBe('default');
  });

  it('reads the file named by CAMPROXY_CONFIG, and resolves dataDir next to it', () => {
    mkdirSync(join(dir, 'etc'));
    write('etc/proxy.json', { camera: { host: 'h' }, server: { dataDir: 'var' } });
    const l = load({ CAMPROXY_CONFIG: 'etc/proxy.json' });
    expect(l.files.config).toBe(join(dir, 'etc/proxy.json'));
    expect(l.config.server.dataDir).toBe(join(dir, 'etc/var'));
  });

  it('refuses to start without a camera host', () => {
    expect(err(() => load())).toBe('camera.host: required');
  });

  it('names an unknown key with its full path', () => {
    write('config.json', { camera: { host: 'h' }, stills: { intervall: 2 } });
    expect(err(() => load())).toBe('stills.intervall: unknown setting');
  });

  it('names a value of the wrong type or out of range', () => {
    write('config.json', { camera: { host: 'h' }, sse: { maxClients: 'many' } });
    expect(err(() => load())).toMatch(/^sse\.maxClients: /);
    write('config.json', { camera: { host: 'h' }, server: { port: 70000 } });
    expect(err(() => load())).toMatch(/^server\.port: /);
    write('config.json', { camera: { host: 'h' }, stills: { size: '897x512' } });
    expect(err(() => load())).toMatch(/^stills\.size: /);
    write('config.json', { camera: { host: 'h' }, stills: { intervalS: 7 } });
    expect(err(() => load())).toMatch(/^stills\.intervalS: /);
  });

  it('checks that the preview grid holds a minute of stills', () => {
    write('config.json', { camera: { host: 'h' }, stills: { intervalS: 1 }, previews: { grid: '5x6' } });
    expect(err(() => load())).toMatch(/^previews\.grid: /);
    write('config.json', { camera: { host: 'h' }, stills: { intervalS: 2 }, previews: { grid: '6x5' } });
    expect(load().config.previews.grid).toBe('6x5');
  });

  it('names the file, not its content, when it is not JSON', () => {
    write('config.json', '{ "camera": { "host": "secret-host" ');
    const m = err(() => load());
    expect(m).toContain('config.json');
    expect(m).not.toContain('secret-host');
  });
});

describe('overrides', () => {
  beforeEach(() => write('config.json', { camera: { host: 'h' }, sse: { pingS: 20 } }));

  it('layers default, file and override, and records the source', () => {
    const l = applyOverrides(load(), { sse: { pingS: 5 } });
    expect(l.config.sse.pingS).toBe(5);
    expect(l.sources['sse.pingS']).toBe('override');
    expect(JSON.parse(readFileSync(join(dir, 'data', 'overrides.json'), 'utf8'))).toEqual({ sse: { pingS: 5 } });
    const again = load();
    expect(again.config.sse.pingS).toBe(5);
  });

  it('refuses a bad override and writes nothing', () => {
    expect(err(() => applyOverrides(load(), { sse: { pingS: -1 } }))).toMatch(/^sse\.pingS: /);
    expect(existsSync(join(dir, 'data', 'overrides.json'))).toBe(false);
  });

  it('removes one override, back to the file value', () => {
    let l = applyOverrides(load(), { sse: { pingS: 5, maxClients: 7 } });
    l = removeOverride(l, 'sse.pingS');
    expect(l.config.sse.pingS).toBe(20);
    expect(l.sources['sse.pingS']).toBe('file');
    expect(l.config.sse.maxClients).toBe(7);
  });

  it('tells which settings need a restart', () => {
    expect(needsRestart('camera.host')).toBe(true);
    expect(needsRestart('stills.intervalS')).toBe(true);
    expect(needsRestart('server.port')).toBe(true);
    expect(needsRestart('sse.pingS')).toBe(false);
    expect(needsRestart('retention.stillsDays')).toBe(false);
  });

  it('refuses secrets in overrides like any unknown key', () => {
    expect(err(() => applyOverrides(load(), { camera: { password: 'x' } }))).toBe('camera.password: unknown setting');
  });
});

describe('secrets', () => {
  beforeEach(() => write('config.json', { camera: { host: 'h' } }));

  it('reads tokens and passwords, _FILE winning', () => {
    write('admin', `${'d'.repeat(32)}\n`);
    const l = load({ CAMPROXY_ADMIN_TOKEN_FILE: join(dir, 'admin') });
    expect(l.secrets.tokens).toEqual([T1, T2]);
    expect(l.secrets.adminToken).toBe('d'.repeat(32));
    expect(l.secrets.cameraPassword).toBe('cam-pw');
  });

  it('rejects a short token without echoing it', () => {
    const m = err(() => load({ CAMPROXY_TOKENS: `${T1},short-secret` }));
    expect(m).toMatch(/^CAMPROXY_TOKENS: /);
    expect(m).not.toContain('short-secret');
  });

  it('requires the secrets, and an admin token distinct from client tokens', () => {
    expect(err(() => loadConfig({ CAMPROXY_ADMIN_TOKEN: ADMIN, CAMPROXY_CAMERA_PASSWORD: 'p' }, { cwd: dir }))).toMatch(/^CAMPROXY_TOKENS: required/);
    expect(err(() => load({ CAMPROXY_ADMIN_TOKEN: T1 }))).toMatch(/^CAMPROXY_ADMIN_TOKEN: /);
  });

  it('requires the FTP password only when FTP is on', () => {
    write('config.json', { camera: { host: 'h' }, ftp: { enabled: true } });
    expect(err(() => load())).toBe('CAMPROXY_FTP_PASSWORD: required when ftp.enabled');
    expect(load({ CAMPROXY_FTP_PASSWORD: 'f' }).secrets.ftpPassword).toBe('f');
  });
});

describe('shipped files', () => {
  const root = join(__dirname, '..');
  it('config.schema.json is generated from the settings description', () => {
    expect(JSON.parse(readFileSync(join(root, 'config.schema.json'), 'utf8'))).toEqual(jsonSchema());
  });

  it('config.example.json is valid and shows every default', () => {
    const example = JSON.parse(readFileSync(join(root, 'config.example.json'), 'utf8'));
    write('config.json', example);
    const l = load();
    const defaults = JSON.parse(JSON.stringify(DEFAULTS));
    defaults.camera.host = example.camera.host;
    defaults.server.dataDir = example.server.dataDir;
    expect(example).toEqual(defaults);
    expect(l.config.camera.host).toBe(example.camera.host);
  });
});

// The cluster's config.json (the ConfigMap kube-setup mounts): it must load
// as is, with the data folder on the volume and FTP on for cam2.
describe('deploy/cluster/config.json', () => {
  it('loads, with /data, cam2 as the camera and FTP on', () => {
    const file = join(__dirname, '..', 'deploy', 'cluster', 'config.json');
    const c = loadConfig({ ...SECRETS, CAMPROXY_FTP_PASSWORD: 'f'.repeat(24), CAMPROXY_CONFIG: file }, { cwd: dir }).config;
    expect(c.server.dataDir).toBe('/data');
    expect(c.camera).toMatchObject({ id: 'cam2', host: 'cam2.cam-sim.svc.cluster.local:443', protocol: 'https', tlsName: 'cam2.skylar.technology', user: 'proxy' });
    expect(c.ftp).toMatchObject({ enabled: true, publicHost: 'cam-proxy.cam-proxy.svc.cluster.local', tls: true });
    expect(c.stills.enabled).toBe(true);
  });
});
