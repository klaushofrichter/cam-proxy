import { describe, it, expect, beforeEach } from 'vitest';
import { cameraConfig, cameraIds } from '../src/config/cameras';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadConfig, applyOverrides, removeOverride, needsRestart, resetTarget, ConfigError } from '../src/config/load';
import { cameraDefaults, DEFAULTS } from '../src/config/defaults';
import { configJsonSchema, leafAt, leafPaths } from '../src/config/schema';

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
    expect(cameraConfig(l.config, 'cam1')!.host).toBe('192.0.2.10');
    expect(l.config.server.port).toBe(8480);
    expect(l.config.stills.intervalS).toBe(1);
    expect(l.config.server.dataDir).toBe(join(dir, 'data'));
    expect(l.sources['cameras.cam1.host']).toBe('file');
    expect(l.sources['server.port']).toBe('default');
  });

  it('reads the file named by CAMPROXY_CONFIG, and resolves dataDir next to it', () => {
    mkdirSync(join(dir, 'etc'));
    write('etc/proxy.json', { camera: { host: 'h' }, server: { dataDir: 'var' } });
    const l = load({ CAMPROXY_CONFIG: 'etc/proxy.json' });
    expect(l.files.config).toBe(join(dir, 'etc/proxy.json'));
    expect(l.config.server.dataDir).toBe(join(dir, 'etc/var'));
  });

  it('starts without a camera host: the camera waits idle (spec §3.3)', () => {
    write('config.json', {});
    expect(cameraConfig(load().config, 'cam1')!.host).toBe('');
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
    expect(needsRestart('cameras.cam1.host')).toBe(true);
    expect(needsRestart('stills.intervalS')).toBe(true);
    expect(needsRestart('composition.font')).toBe(true); // resolved once at start (issue #30)
    expect(needsRestart('server.trustProxy')).toBe(true);
    expect(needsRestart('server.port')).toBe(true);
    expect(needsRestart('sse.pingS')).toBe(false);
    expect(needsRestart('retention.stillsDays')).toBe(false);
  });

  it('refuses secrets in overrides like any unknown key', () => {
    expect(err(() => applyOverrides(load(), { camera: { password: 'x' } }))).toBe('camera.password: unknown setting');
  });
});

// Klaus 2026-10-05 (the Pi's Settings page): overrides equal to the default
// (camera.poeSwitch.ports 8, offSeconds 10) offered a Reset that changed
// nothing. The cause: every leaf of a PUT body was stored, whatever its value
// (a whole poeSwitch group, or a Save of the unchanged default).
describe('an override equal to what Reset restores', () => {
  beforeEach(() => write('config.json', { camera: { host: 'h' }, sse: { pingS: 20 } }));
  const stored = () => JSON.parse(readFileSync(join(dir, 'data', 'overrides.json'), 'utf8'));

  it('is not stored when a group is saved whole: only what differs becomes an override', () => {
    const l = applyOverrides(load(), { camera: { poeSwitch: { model: 'sscpoe-web', host: '192.168.1.217', port: 8, ports: 8, offSeconds: 10 } } });
    expect(stored()).toEqual({ cameras: { cam1: { poeSwitch: { port: 8 } } }, poeSwitch: { model: 'sscpoe-web', host: '192.168.1.217' } });
    expect(l.sources['poeSwitch.ports']).toBe('default');
    expect(l.sources['poeSwitch.offSeconds']).toBe('default');
    expect(cameraConfig(l.config, 'cam1')!.poeSwitch).toEqual({ model: 'sscpoe-web', host: '192.168.1.217', port: 8, ports: 8, offSeconds: 10 });
  });

  it("is not stored when the value is config.json's", () => {
    const l = applyOverrides(load(), { sse: { pingS: 20 } });
    expect(l.sources['sse.pingS']).toBe('file');
    expect(stored()).toEqual({});
  });

  it('removes an existing override when the default is saved over it', () => {
    let l = applyOverrides(load(), { sse: { maxClients: 7 }, retention: { auditDays: 30 } });
    l = applyOverrides(l, { sse: { maxClients: 50 } });
    expect(l.sources['sse.maxClients']).toBe('default');
    expect(l.config.sse.maxClients).toBe(50);
    expect(stored()).toEqual({ retention: { auditDays: 30 } });
  });

  it('keeps an override whose removal changes the value (go2rtc.url drops the default binary)', () => {
    const l = applyOverrides(load(), { go2rtc: { url: 'http://go2rtc:1984', binary: 'go2rtc' } });
    expect(stored()).toEqual({ go2rtc: { url: 'http://go2rtc:1984', binary: 'go2rtc' } });
    expect(l.config.go2rtc.binary).toBe('go2rtc');
  });

  it('one already stored (an older proxy) is marked: Reset would change nothing', () => {
    mkdirSync(join(dir, 'data'), { recursive: true });
    write('data/overrides.json', { camera: { poeSwitch: { model: 'sscpoe-web', host: '192.168.1.217', port: 8, ports: 8, offSeconds: 10 } }, sse: { pingS: 20 } });
    const l = load();
    expect(l.sources['poeSwitch.ports']).toBe('override');
    expect(resetTarget(l, 'camera.poeSwitch.ports')).toEqual({ value: 8, source: 'default', same: true });
    expect(resetTarget(l, 'camera.poeSwitch.offSeconds')).toEqual({ value: 10, source: 'default', same: true });
    expect(resetTarget(l, 'sse.pingS')).toEqual({ value: 20, source: 'file', same: true });
    // A real change says what the unset state means.
    expect(resetTarget(l, 'camera.poeSwitch.model')).toEqual({ value: 'none', source: 'default', means: 'no PoE switch: power-cycle off' });
    expect(resetTarget(l, 'camera.poeSwitch.host')).toEqual({ source: 'default', means: expect.stringMatching(/^PoE switch control off/) });
    expect(resetTarget(l, 'camera.poeSwitch.port')).toEqual({ source: 'default', means: expect.stringMatching(/^PoE switch control off/) });
  });
});

// What the unset state means, for every setting whose default is not set,
// none, empty, off or 0 = none: the Reset button and Reset to defaults say it.
describe('the unset state of a setting', () => {
  it('is described next to the schema for every setting without a value by default', () => {
    const unsetByDefault = leafPaths().filter((p) => {
      const v = p.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], DEFAULTS);
      return v === undefined || v === '' || v === 'none' || v === false;
    });
    expect(unsetByDefault.length).toBeGreaterThan(15);
    for (const p of unsetByDefault) expect(leafAt(p)?.unset?.text, p).toMatch(/\w/);
    // 0 = none.
    expect(leafAt('analytics.googleVision.monthlyLimit')?.unset).toEqual({ value: 0, text: expect.any(String) });
    expect(leafAt('analytics.googleVision.dailyCap')?.unset).toEqual({ value: 0, text: expect.any(String) });
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
    // The server compares at most 256 bytes: a longer password could never log in.
    expect(err(() => load({ CAMPROXY_FTP_PASSWORD: 'f'.repeat(257) }))).toBe('CAMPROXY_FTP_PASSWORD: longer than 256 bytes');
    expect(load({ CAMPROXY_FTP_PASSWORD: 'f'.repeat(256) }).secrets.ftpPassword).toHaveLength(256);
  });
});

describe('shipped files', () => {
  const root = join(__dirname, '..');
  it('config.schema.json is generated from the settings description', () => {
    expect(JSON.parse(readFileSync(join(root, 'config.schema.json'), 'utf8'))).toEqual(configJsonSchema());
  });

  it('config.example.json is valid and shows every default', () => {
    const example = JSON.parse(readFileSync(join(root, 'config.example.json'), 'utf8'));
    write('config.json', example);
    const l = load();
    // The one-camera (legacy) form: the defaults of camera cam1 and the host switch in `camera`, ftp.user (spec 2026-10-05-multi-camera-host-design §4.2).
    const { cameras: _c, cameraOrder: _o, poeSwitch, ...defaults } = JSON.parse(JSON.stringify(DEFAULTS));
    const { ftp: _f, stills: _s, storage: _st, analytics: _a, events: _e, poeSwitch: _p, ...cam } = cameraDefaults('cam1');
    defaults.camera = { ...cam, name: 'Den', host: example.camera.host, poeSwitch };
    defaults.ftp = { ...defaults.ftp, user: 'camera' };
    defaults.server.dataDir = example.server.dataDir;
    expect(example).toEqual(defaults);
    expect(cameraConfig(l.config, 'cam1')!.host).toBe(example.camera.host);
  });

  it('config.cameras.example.json loads: two cameras, the host switch', () => {
    write('config.json', readFileSync(join(__dirname, '..', 'config.cameras.example.json'), 'utf8'));
    const l = load({ CAMPROXY_FTP_PASSWORD: 'f'.repeat(24) });
    expect(cameraIds(l.config)).toEqual(['cam3', 'cam4']);
    expect(cameraConfig(l.config, 'cam4')!.storage).toEqual({ sharePercent: 20 });
    expect(l.config.composition.concurrent).toBe(2);
    expect(cameraConfig(l.config, 'cam4')!.poeSwitch).toMatchObject({ host: '192.168.60.2', port: 2 });
  });
});

// The cluster's config.json (the ConfigMap kube-setup mounts): it must load
// as is, with the data folder on the volume and FTP on for cam2.
describe('deploy/cluster/config.json', () => {
  it('loads, with /data, cam2 as the camera and FTP on', () => {
    const file = join(__dirname, '..', 'deploy', 'cluster', 'config.json');
    const c = loadConfig({ ...SECRETS, CAMPROXY_FTP_PASSWORD: 'f'.repeat(24), CAMPROXY_CONFIG: file }, { cwd: dir }).config;
    expect(c.server.dataDir).toBe('/data');
    expect(cameraConfig(c, "cam2")).toMatchObject({ id: "cam2", host: 'cam2.cam-sim.svc.cluster.local:443', protocol: 'https', tlsName: 'cam2.skylar.technology', user: 'proxy', webUiUrl: 'https://cam2.skylar.technology/' });
    // cams plays these clips: the sub stream (H.264) plays in every browser.
    expect(c.ftp).toMatchObject({ enabled: true, publicHost: 'cam-proxy.cam-proxy.svc.cluster.local', tls: true, stream: 'sub' });
    expect(c.stills.enabled).toBe(true);
    // local-path volumes have no quota (statfs sees the node's disk): the cap
    // is maxBytes, 85 % of the 20Gi PVC.
    expect(c.storage.maxBytes).toBe(Math.floor(20 * 2 ** 30 * 0.85));
  });
});

// The camera's own web page, linked from the admin UI (camera model).
describe('camera.webUiUrl', () => {
  it('accepts an http(s) URL or none, and nothing else', () => {
    write('config.json', { camera: { host: '10.0.0.5', webUiUrl: 'https://cam1.skylar.technology/' } });
    expect(cameraConfig(load().config, 'cam1')!.webUiUrl).toBe('https://cam1.skylar.technology/');
    write('config.json', { camera: { host: '10.0.0.5', webUiUrl: 'none' } });
    expect(cameraConfig(load().config, 'cam1')!.webUiUrl).toBe('none');
    write('config.json', { camera: { host: '10.0.0.5', webUiUrl: 'javascript:alert(1)' } });
    expect(err(() => load())).toMatch(/camera.webUiUrl/);
  });
});

describe('audit settings', () => {
  beforeEach(() => write('config.json', { camera: { host: '192.0.2.10' } }));
  it('retention.auditDays defaults to 90 and is bounded 1-3650', () => {
    const l = load();
    expect(l.config.retention.auditDays).toBe(90);
    expect(() => applyOverrides(l, { retention: { auditDays: 0 } })).toThrow();
    expect(() => applyOverrides(l, { retention: { auditDays: 3651 } })).toThrow();
    expect(applyOverrides(l, { retention: { auditDays: 30 } }).config.retention.auditDays).toBe(30);
  });

  it('reads an optional audit token (or its _FILE), and refuses a short or reused one', () => {
    expect(load().secrets.auditToken).toBeUndefined();
    const audit = 'audit-token-'.padEnd(40, 'z');
    expect(load({ CAMPROXY_AUDIT_TOKEN: audit }).secrets.auditToken).toBe(audit);
    const f = join(dir, 'audit.txt');
    writeFileSync(f, audit + '\n');
    expect(load({ CAMPROXY_AUDIT_TOKEN_FILE: f }).secrets.auditToken).toBe(audit);
    expect(() => load({ CAMPROXY_AUDIT_TOKEN: 'short' })).toThrow(/CAMPROXY_AUDIT_TOKEN/);
    expect(() => load({ CAMPROXY_AUDIT_TOKEN: ADMIN })).toThrow(/CAMPROXY_AUDIT_TOKEN/);
    expect(() => load({ CAMPROXY_AUDIT_TOKEN: T1 })).toThrow(/CAMPROXY_AUDIT_TOKEN/);
  });
});

// The camera's PoE switch (issue #85): settings, live; the password is a secret.
describe('camera.poeSwitch', () => {
  beforeEach(() => write('config.json', { camera: { host: '192.0.2.10' } }));
  it('defaults to no switch, 8 ports and 10 s off', () => {
    expect(cameraConfig(load().config, 'cam1')!.poeSwitch).toEqual({ model: 'none', ports: 8, offSeconds: 10 });
  });

  it('takes a model, a host (optional :port), the camera port 1-48, the port count and offSeconds 5-60', () => {
    const l = applyOverrides(load(), { camera: { poeSwitch: { model: 'sscpoe-web', host: '192.168.1.217', port: 8, ports: 8, offSeconds: 15 } } });
    expect(cameraConfig(l.config, 'cam1')!.poeSwitch).toEqual({ model: 'sscpoe-web', host: '192.168.1.217', port: 8, ports: 8, offSeconds: 15 });
    expect(applyOverrides(load(), { camera: { poeSwitch: { host: 'switch.lan:8080' } } }).config.poeSwitch.host).toBe('switch.lan:8080');
    for (const [k, v] of [['model', 'gps208'], ['host', 'http://x'], ['host', 'a b'], ['port', 0], ['port', 49], ['ports', 0], ['ports', 49], ['offSeconds', 4], ['offSeconds', 61]] as const) {
      expect(() => applyOverrides(load(), { camera: { poeSwitch: { [k]: v } } }), `${k}=${v}`).toThrow(new RegExp(`camera.poeSwitch.${k}`));
    }
  });

  it('applies at once: no restart for the switch settings (read on every use)', () => {
    for (const k of ['model', 'host', 'port', 'ports', 'offSeconds']) expect(needsRestart(`camera.poeSwitch.${k}`), k).toBe(false);
    expect(needsRestart('cameras.cam1.host')).toBe(true);
  });

  it('reads an optional CAMPROXY_POE_SWITCH_PASSWORD (or its _FILE)', () => {
    expect(load().secrets.poeSwitchPassword).toBeUndefined();
    expect(load({ CAMPROXY_POE_SWITCH_PASSWORD: 'sw-pw' }).secrets.poeSwitchPassword).toBe('sw-pw');
    const f = join(dir, 'switch.txt');
    writeFileSync(f, 'sw-file-pw\n');
    expect(load({ CAMPROXY_POE_SWITCH_PASSWORD: 'sw-pw', CAMPROXY_POE_SWITCH_PASSWORD_FILE: f }).secrets.poeSwitchPassword).toBe('sw-file-pw');
    expect(err(() => load({ CAMPROXY_POE_SWITCH_PASSWORD_FILE: join(dir, 'missing') }))).toBe('CAMPROXY_POE_SWITCH_PASSWORD_FILE: cannot read the file');
  });

  it('refuses the password as a setting like any unknown key', () => {
    expect(() => applyOverrides(load(), { camera: { poeSwitch: { password: 'x' } } })).toThrow(/camera.poeSwitch.password: unknown setting/);
  });
});

describe('recordings settings', () => {
  beforeEach(() => write('config.json', { camera: { host: '192.0.2.10' } }));
  it('recordings.cacheMB defaults to 2048 (64 to 1,048,576); camera.baichuanPort to 9000 (1 to 65535)', () => {
    const l = load();
    expect(l.config.recordings.cacheMB).toBe(2048);
    expect(cameraConfig(l.config, 'cam1')!.baichuanPort).toBe(9000);
    for (const v of [63, 1_048_577]) expect(() => applyOverrides(l, { recordings: { cacheMB: v } })).toThrow(/recordings.cacheMB/);
    for (const v of [0, 65536]) expect(() => applyOverrides(l, { camera: { baichuanPort: v } })).toThrow(/camera.baichuanPort/);
    expect(applyOverrides(l, { recordings: { cacheMB: 64 }, camera: { baichuanPort: 9001 } }).config.cameras.cam1.baichuanPort).toBe(9001);
  });

  it('both apply without a restart (the port at the next connection, the cap at the next fetch or storage run)', () => {
    expect(needsRestart('recordings.cacheMB')).toBe(false);
    expect(needsRestart('camera.baichuanPort')).toBe(false);
    expect(needsRestart('cameras.cam1.host')).toBe(true);
  });
});

// The health summary (spec 2026-10-03-health-summary-design): thresholds and host figures.
describe('health and host settings', () => {
  beforeEach(() => write('config.json', { camera: { host: '192.0.2.10' } }));
  it('health.diskPercent defaults to 90 (50-99), health.tempC to 75 (40-95), host.stats to auto', () => {
    const l = load();
    expect(l.config.health).toEqual({ diskPercent: 90, tempC: 75 });
    expect(l.config.host).toEqual({ stats: 'auto' });
    for (const v of [49, 100, 90.5]) expect(() => applyOverrides(l, { health: { diskPercent: v } })).toThrow(/health.diskPercent/);
    for (const v of [39, 96]) expect(() => applyOverrides(l, { health: { tempC: v } })).toThrow(/health.tempC/);
    expect(() => applyOverrides(l, { host: { stats: 'maybe' } })).toThrow(/host.stats/);
    const next = applyOverrides(l, { health: { diskPercent: 50, tempC: 95 }, host: { stats: 'off' } });
    expect(next.config.health).toEqual({ diskPercent: 50, tempC: 95 });
    expect(next.config.host.stats).toBe('off');
  });

  it('all three apply at once', () => {
    for (const p of ['health.diskPercent', 'health.tempC', 'host.stats']) expect(needsRestart(p)).toBe(false);
  });
});
