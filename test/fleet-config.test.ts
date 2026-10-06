import { createHash } from 'crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyOverrides, ConfigError, configRevision, loadConfig, needsRestart } from '../src/config/load';
import { jcs } from '../src/fleet/jcs';
import { CONFIG_SCHEMA, configJsonSchema } from '../src/config/schema';
import { ALLOW_ENTRIES } from '../src/fleet/policy';
import { writeKeyFile } from '../src/fleet/keyfile';
import type { Proxy } from '../src/proxy';
import { startFakeAdmin, type FakeAdmin } from './helpers/fake-admin';
import { startMultiProxy, startSims, type Sim } from './helpers/multi';
import { strict, why } from './helpers/contract';
import { freePort, until } from './helpers/proxy';

// camsAdmin in the configuration (spec 2026-10-06-cams-admin-phase1-design
// §9.1, §9.2): off unless configured; the client follows the settings at once.
const SECRETS = { CAMPROXY_TOKENS: 'a'.repeat(32), CAMPROXY_ADMIN_TOKEN: 'c'.repeat(32), CAMPROXY_CAMERA_PASSWORD: 'cam-pw' };
const loadWith = (cfg: object) => {
  const dir = mkdtempSync(join(tmpdir(), 'camproxy-acfg-'));
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ camera: { host: '127.0.0.1' }, ...cfg }));
  return loadConfig(SECRETS, { cwd: dir });
};
const refused = (cfg: object): string => {
  try {
    loadWith(cfg);
  } catch (e) {
    expect(e).toBeInstanceOf(ConfigError);
    return (e as Error).message;
  }
  throw new Error('expected a ConfigError');
};

describe('camsAdmin settings', () => {
  it('defaults: no url (off), admin/key.json, enabled', () => {
    expect(loadWith({}).config.camsAdmin).toEqual({ keyFile: 'admin/key.json', enabled: true });
  });
  it('https anywhere; http only for loopback and *.svc.cluster.local', () => {
    expect(loadWith({ camsAdmin: { url: 'https://cams-admin.skylar.technology' } }).config.camsAdmin.url).toBe('https://cams-admin.skylar.technology');
    expect(loadWith({ camsAdmin: { url: 'http://127.0.0.1:29000' } }).config.camsAdmin.url).toBe('http://127.0.0.1:29000');
    expect(loadWith({ camsAdmin: { url: 'http://cams-admin.cams-admin.svc.cluster.local:8080' } }).config.camsAdmin.url).toMatch(/svc/);
    expect(refused({ camsAdmin: { url: 'http://192.168.1.10:29000' } })).toMatch(/^camsAdmin\.url: must be https/);
    expect(refused({ camsAdmin: { url: 'ftp://x.example' } })).toMatch(/^camsAdmin\.url/);
  });
  it('allowCommands: known entries load (P2); unknown or never-remote entries are a load error naming the entry', () => {
    const l = loadWith({ camsAdmin: { allowCommands: ['tokens.apply'], commandsPaused: true } });
    expect(l.config.camsAdmin).toEqual({ keyFile: 'admin/key.json', enabled: true });
    expect(l.commandPolicyBase).toEqual({ allow: ['tokens.apply'], paused: true });
    expect(loadWith({}).commandPolicyBase).toEqual({ allow: [], paused: false });
    expect(refused({ camsAdmin: { allowCommands: ['camera.action:find-camera'] } })).toMatch(/camera\.action:find-camera/);
    expect(refused({ camsAdmin: { allowCommands: 'reboot' } })).toMatch(/^camsAdmin\.allowCommands/);
    expect(refused({ camsAdmin: { commandsPaused: 'yes' } })).toMatch(/^camsAdmin\.commandsPaused/);
  });
  it('config.schema.json knows the command policy keys (editors validate config.json)', () => {
    const ca = (configJsonSchema() as { properties: { camsAdmin: { properties: Record<string, { type: string; items?: { enum: string[] }; maxItems?: number }> } } }).properties.camsAdmin.properties;
    expect(ca.allowCommands).toMatchObject({ type: 'array', maxItems: 32, items: { enum: [...ALLOW_ENTRIES] } });
    expect(ca.commandsPaused).toMatchObject({ type: 'boolean' });
  });
  it('the command policy is never in overrides.json: a load error there, not_a_setting in a PUT', () => {
    const dir = mkdtempSync(join(tmpdir(), 'camproxy-acfg-'));
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ camera: { host: '127.0.0.1' }, server: { dataDir: 'data' } }));
    mkdirSync(join(dir, 'data'));
    writeFileSync(join(dir, 'data', 'overrides.json'), JSON.stringify({ camsAdmin: { allowCommands: ['tokens.apply'] } }));
    expect(() => loadConfig(SECRETS, { cwd: dir })).toThrow(/camsAdmin\.allowCommands: only in config\.json or data\/admin\/policy\.json/);
    const l = loadWith({});
    for (const patch of [{ camsAdmin: { allowCommands: ['tokens.apply'] } }, { camsAdmin: { commandsPaused: false } }]) expect(() => applyOverrides(l, patch), JSON.stringify(patch)).toThrow(/^not_a_setting:/);
    expect(existsSync(l.files.overrides)).toBe(false);
  });
  it('configRevision: sha256 of jcs(overrides), {} when there are none', () => {
    const l = loadWith({});
    expect(configRevision(l)).toBe(`sha256:${createHash('sha256').update('{}').digest('hex')}`);
    const m = applyOverrides(l, { sse: { pingS: 7 }, retention: { clipsDays: 3 } });
    expect(configRevision(m)).toBe(`sha256:${createHash('sha256').update(jcs(m.overrides)).digest('hex')}`);
    expect(jcs(m.overrides)).toMatch(/^\{"retention":.*"sse":/);
  });
  it('the key file is admin/<name>.json: never the data folder itself, overrides.json or anything outside', () => {
    for (const k of ['/etc/key.json', '../key.json', 'key.json', 'overrides.json', 'admin/../overrides.json', 'admin/sub/key.json', 'admin/.json', 'admin/key.txt']) expect(refused({ camsAdmin: { keyFile: k } }), k).toMatch(/^camsAdmin\.keyFile/);
    expect(loadWith({ camsAdmin: { keyFile: 'admin/key-2.json' } }).config.camsAdmin.keyFile).toBe('admin/key-2.json');
  });
  it('the key file can never be one of the P2 files (an unenroll would delete it: a managed admin could lift a pause)', () => {
    for (const k of ['admin/tokens.json', 'admin/commands.json', 'admin/policy.json']) {
      expect(refused({ camsAdmin: { keyFile: k } }), k).toMatch(/^camsAdmin\.keyFile/);
      expect(() => applyOverrides(loadWith({}), { camsAdmin: { keyFile: k } }), k).toThrow(/^camsAdmin\.keyFile/);
    }
  });
  it('applies at once (no restart); an override of an http LAN URL is refused', () => {
    for (const p of ['camsAdmin.url', 'camsAdmin.enabled', 'camsAdmin.keyFile']) expect(needsRestart(p), p).toBe(false);
    const l = loadWith({});
    expect(() => applyOverrides(l, { camsAdmin: { url: 'http://10.0.0.1' } })).toThrow(ConfigError);
  });
  it('the config schema version is a number the heartbeat reports', () => {
    expect(CONFIG_SCHEMA).toBeGreaterThanOrEqual(1);
  });
});

// Each secret the proxy holds, set to a marker that must never reach cams-admin.
const MARK = (n: string) => `SECRETMARKER${n}`.padEnd(40, 'Q');
const MARKERS = {
  CAMPROXY_TOKENS: MARK('client'), CAMPROXY_ADMIN_TOKEN: MARK('admin'), CAMPROXY_AUDIT_TOKEN: MARK('audit'), CAMPROXY_FTP_PASSWORD: MARK('ftp'),
  CAMPROXY_GOOGLE_VISION_KEY: MARK('vision'), CAMPROXY_POE_SWITCH_PASSWORD: MARK('poe'), CAMPROXY_CAMERA_PASSWORD_CAM9: MARK('cam9'),
};

describe('the wired client (four cameras, every secret set)', () => {
  let sims: Sim[];
  let fake: FakeAdmin;
  let proxy: Proxy;
  let base: string;
  let dir: string;
  let key: ReturnType<FakeAdmin['keyFile']>;
  beforeAll(async () => {
    sims = await startSims(3);
    fake = await startFakeAdmin();
    fake.welcomeHeartbeatS = 1;
    fake.nextInS = 1;
    dir = mkdtempSync(join(tmpdir(), 'camproxy-acli-'));
    key = fake.keyFile();
    const ftpPort = await freePort();
    const passive = await freePort();
    writeKeyFile(join(dir, 'data', 'admin', 'key.json'), key);
    const r = await startMultiProxy(sims, {
      dir,
      extra: [{ id: 'cam9', host: '' }],
      env: { ...MARKERS, CAMPROXY_CAMERA_PASSWORD: sims[0].password },
      settings: {
        camsAdmin: { url: fake.url },
        server: { logLevel: 'silent', publicUrl: 'https://proxy.example' },
        ftp: { enabled: true, port: ftpPort, passive: `${passive}-${passive + 40}`, publicHost: '127.0.0.1' },
        analytics: { googleVision: { enabled: true, monthlyLimit: 10 } },
        poeSwitch: { model: 'sscpoe-web', host: '127.0.0.1:9', ports: 8, offSeconds: 10 },
        // A site CA, so the heartbeat's tls block (site, CA fingerprint) is sent too.
        tls: { site: 'garage', cameraSubnet: '127.0.0.0/16', proxyAddresses: '127.0.0.1', cameraCerts: false },
      },
      proxy: { camsAdmin: { timing: { minIntervalS: 0.2, jitterS: 0, backoffCapMs: 300, closeGraceMs: 200 } } },
    });
    proxy = r.proxy;
    base = r.base;
  }, 60_000);
  afterAll(async () => {
    await proxy?.stop();
    await fake?.close();
    await Promise.all((sims ?? []).map((s) => s.close()));
  });

  it('connects and sends the health summary as GET /api/local/health has it, on the strict schema', async () => {
    await until(() => fake.heartbeats().length >= 1, 10_000);
    const hb = fake.heartbeats()[0].msg;
    const v = strict('heartbeat');
    expect(v(hb), why(v)).toBe(true);
    const local = (await request(base).get('/api/local/health').expect(200)).body as { cameras: { camera: { id: string } }[] };
    const body = hb.body as { summary: { cameras: { camera: { id: string } }[]; schema: number }; proxy: { configSchema: number; publicUrl: string | null } };
    expect(body.summary.cameras.map((c) => c.camera.id)).toEqual(local.cameras.map((c) => c.camera.id));
    expect(body.proxy).toMatchObject({ configSchema: CONFIG_SCHEMA, publicUrl: 'https://proxy.example', tls: { site: 'garage', caFingerprint: [expect.stringMatching(/^SHA256:[0-9A-F]{64}$/)] } });
    expect(proxy.camsAdmin.view().state).toBe('connected');
  });

  it('no secret in anything sent to cams-admin', async () => {
    await until(() => fake.heartbeats().length >= 2, 10_000);
    const all = JSON.stringify(fake.received);
    for (const [name, m] of Object.entries(MARKERS)) expect(all.includes(m), name).toBe(false);
    expect(all.includes(key.privateKey)).toBe(false);
    // The cameras' password (the sims need the real one).
    expect(all.includes(sims[0].password)).toBe(false);
  });

  it('PUT /control/config with the command policy answers 400 not_a_setting and changes nothing', async () => {
    const r = await request(base).put('/control/config').set('Authorization', `Bearer ${MARKERS.CAMPROXY_ADMIN_TOKEN}`).send({ camsAdmin: { allowCommands: ['tokens.apply'] } });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('not_a_setting');
    expect(existsSync(join(dir, 'data', 'overrides.json')) ? readFileSync(join(dir, 'data', 'overrides.json'), 'utf8') : '').not.toMatch(/allowCommands/);
  });

  it('a settings change restarts the client only: one socket at a time, the old one says bye', async () => {
    const before = fake.connections;
    const r = await request(base).put('/control/config').set('Authorization', `Bearer ${MARKERS.CAMPROXY_ADMIN_TOKEN}`).send({ camsAdmin: { enabled: false } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    await until(() => proxy.camsAdmin.view().state === 'disabled');
    await until(() => fake.open() === 0);
    expect(fake.received.some((x) => x.msg.type === 'bye')).toBe(true);
    await request(base).put('/control/config').set('Authorization', `Bearer ${MARKERS.CAMPROXY_ADMIN_TOKEN}`).send({ camsAdmin: { enabled: true } }).expect(200);
    await until(() => proxy.camsAdmin.view().state === 'connected', 10_000);
    expect(fake.connections).toBe(before + 1);
    expect(fake.open()).toBe(1);
  });

  it('a URL the key file was not made for: not enrolled (the old socket closes)', async () => {
    const other = await startFakeAdmin();
    try {
      await request(base).put('/control/config').set('Authorization', `Bearer ${MARKERS.CAMPROXY_ADMIN_TOKEN}`).send({ camsAdmin: { url: other.url } }).expect(200);
      await until(() => proxy.camsAdmin.view().state === 'not-enrolled');
      await until(() => fake.open() === 0);
      expect(other.connections).toBe(0);
      expect(proxy.camsAdmin.view().lastError).toMatch(/enroll/);
    } finally {
      await request(base).put('/control/config').set('Authorization', `Bearer ${MARKERS.CAMPROXY_ADMIN_TOKEN}`).send({ camsAdmin: { url: fake.url } });
      await other.close();
    }
    await until(() => proxy.camsAdmin.view().state === 'connected', 10_000);
  });

  it('a key file others can read: key-unsafe, never used', async () => {
    const { chmodSync } = await import('fs');
    const n = fake.connections;
    chmodSync(join(dir, 'data', 'admin', 'key.json'), 0o644);
    try {
      proxy.camsAdmin.reload();
      await until(() => proxy.camsAdmin.view().state === 'key-unsafe');
      await new Promise((r) => setTimeout(r, 300));
      expect(fake.connections).toBe(n);
      expect(proxy.camsAdmin.view().lastError).toMatch(/read by others/);
    } finally {
      chmodSync(join(dir, 'data', 'admin', 'key.json'), 0o600);
      proxy.camsAdmin.reload();
    }
    await until(() => proxy.camsAdmin.view().state === 'connected', 10_000);
  });

  it('the camsAdmin metric names the state', async () => {
    const text = (await request(base).get('/metrics').expect(200)).text;
    expect(text).toMatch(/camproxy_cams_admin_state\{state="connected"\} 1/);
  });

  it('stop: bye shutdown before the HTTP server goes, inside the budget', async () => {
    const t0 = Date.now();
    await proxy.stop();
    expect(Date.now() - t0).toBeLessThan(15_000);
    const byes = fake.received.filter((x) => x.msg.type === 'bye').map((x) => x.msg.body);
    expect(byes.at(-1)).toEqual({ reason: 'shutdown' });
    expect(existsSync(join(dir, 'data', 'admin', 'key.json'))).toBe(true);
  });
});
