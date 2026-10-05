// The Pi's one-camera setup keeps working through the multi-camera change
// (spec 2026-10-05-multi-camera-host-design §4.2, §11): its config.json (a
// legacy `camera` object with a PoE switch), overrides.json written by the
// Settings page with legacy paths, CAMERA_HOST / PI_ADDRESS, and a catalog
// as release 8 left it (events, Vision usage).
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Client } from 'basic-ftp';
import request from 'supertest';
import { ftpUsers } from '../src/clips/side';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MIGRATIONS } from '../src/catalog/migrations';
import { usageBetween, usageByCamera } from '../src/catalog/analyses';
import { cameraConfig } from '../src/config/cameras';
import { loadConfig } from '../src/config/load';
import { createProxy, type Proxy } from '../src/proxy';
import { ADMIN_TOKEN, CLIENT_TOKEN, auth, freePort, until } from './helpers/proxy';
import { startSim } from './helpers/sim';

let sim: Awaited<ReturnType<typeof startSim>>;
let proxy: Proxy;
let base: string;
let dir: string;
let ftpPort = 0;
let go2rtcPorts: { rtspPort: number; apiPort: number };
const EVENT_TS = Date.now() - 3600_000;

// A catalog at schema version 8 with one event and this month's Vision usage.
function catalogV8(path: string): void {
  const raw = new DatabaseSync(path);
  raw.exec('CREATE TABLE schema_version (version INTEGER NOT NULL)');
  MIGRATIONS.slice(0, 8).forEach((sql, i) => {
    raw.exec(sql);
    raw.prepare('INSERT INTO schema_version (version) VALUES (?)').run(i + 1);
  });
  raw.prepare("INSERT INTO events (cam, source, kind, start_ts, end_ts, raw) VALUES ('cam1', 'onvif', 'person', ?, ?, NULL)").run(EVENT_TS, EVENT_TS + 5000);
  const day = new Date().toISOString().slice(0, 10);
  raw.prepare("INSERT INTO analytics_usage (provider, day, calls) VALUES ('google-vision', ?, 14)").run(day);
  raw.close();
}

beforeAll(async () => {
  sim = await startSim();
  dir = mkdtempSync(join(tmpdir(), 'camproxy-pi-'));
  const data = join(dir, 'data');
  mkdirSync(data);
  const go2rtc = process.env.CAMPROXY_TEST_GO2RTC;
  ftpPort = await freePort();
  const passive = await freePort();
  go2rtcPorts = { rtspPort: await freePort(), apiPort: await freePort() };
  // docs/raspberry-pi.md, plus the PoE switch (docs/poe-switch.md) and the test's ports.
  writeFileSync(join(dir, 'config.json'), JSON.stringify({
    camera: { id: 'cam1', name: 'Den', protocol: 'http', user: 'proxy', onvifPort: sim.ports.onvif, rtspPort: sim.ports.rtsp || 554, baichuanPort: sim.camera.baichuanPort,
      poeSwitch: { model: 'sscpoe-web', host: '127.0.0.1:9', port: 8, ports: 8, offSeconds: 10 } },
    server: { logLevel: 'silent' },
    stills: { enabled: !!go2rtc, stream: 'sub' },
    go2rtc: { binary: go2rtc ?? 'go2rtc', ...go2rtcPorts },
    storage: { maxBytes: 161061273600, minFreeBytes: 0 },
    ftp: { enabled: true, port: ftpPort, passive: `${passive}-${passive}`, tls: true, stream: 'sub' },
  }));
  // What the Settings page wrote before several cameras (legacy paths).
  writeFileSync(join(data, 'overrides.json'), JSON.stringify({ camera: { statusPollS: 7, poeSwitch: { offSeconds: 12 } }, ftp: { user: 'picam' } }));
  catalogV8(join(data, 'catalog.sqlite'));
  const loaded = loadConfig({
    CAMPROXY_TOKENS: CLIENT_TOKEN, CAMPROXY_ADMIN_TOKEN: ADMIN_TOKEN, CAMPROXY_CAMERA_PASSWORD: sim.password, CAMPROXY_FTP_PASSWORD: 'ftp-secret-'.padEnd(24, 'z'),
    CAMERA_HOST: sim.camera.host, PI_ADDRESS: '127.0.0.1',
  }, { cwd: dir });
  proxy = createProxy(loaded);
  const { port } = await proxy.start({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await proxy?.stop();
  await sim?.close();
});

describe('the Pi: one legacy camera, legacy overrides, a version 8 catalog', () => {
  it('runs its camera with the file, the overrides and the environment', async () => {
    const c = cameraConfig(proxy.running, 'cam1')!;
    expect(c).toMatchObject({ id: 'cam1', host: sim.camera.host, statusPollS: 7 });
    expect(c.poeSwitch).toEqual({ model: 'sscpoe-web', host: '127.0.0.1:9', port: 8, ports: 8, offSeconds: 12 });
    expect(c.ftp).toEqual({ user: 'picam', enabled: true, stream: 'sub' });
    expect(proxy.running.ftp.publicHost).toBe('127.0.0.1');
    await until(() => proxy.status.state().online);
  });

  it('GET /api/cameras: the one camera, as before', async () => {
    const r = await request(base).get('/api/cameras').set(auth());
    expect(r.status).toBe(200);
    expect(r.body).toHaveLength(1);
    expect(r.body[0]).toMatchObject({ id: 'cam1' });
    for (const k of ['id', 'name', 'online']) expect(r.body[0]).toHaveProperty(k);
  });

  it('the catalog is migrated and keeps its events and the month of Vision usage', async () => {
    expect(proxy.catalog.schemaVersion()).toBe(MIGRATIONS.length);
    const r = await request(base).get(`/api/cameras/cam1/events?from=${EVENT_TS - 1000}&to=${EVENT_TS + 1000}&limit=10`).set(auth());
    expect(r.status).toBe(200);
    expect(r.body.map((e: { kind: string }) => e.kind)).toEqual(['person']);
    expect(usageBetween(proxy.catalog, 'google-vision', '2000-01-01', '2999-12-31')).toBe(14);
    // The month's usage is the one camera's now (spec §5.1).
    expect(usageByCamera(proxy.catalog, 'google-vision', '2000-01-01', '2999-12-31')).toEqual({ cam1: 14 });
  });

  it('/api/local/health: schema 1, the camera on top, the same item ids', async () => {
    const h = (await request(base).get('/api/local/health')).body;
    expect(h.schema).toBe(1);
    expect(h.camera).toMatchObject({ id: 'cam1' });
    for (const k of ['camera', 'stream', 'events', 'ftp', 'items']) expect(h).toHaveProperty(k);
    expect(h.items.map((i: { id: string }) => i.id)).toEqual(PI_ITEM_IDS);
  });

  it('a settings save keeps every legacy override value', async () => {
    const r = await request(base).put('/control/config').set(auth(ADMIN_TOKEN)).send({ retention: { eventsDays: 40 } });
    expect(r.status).toBe(200);
    const saved = JSON.parse(readFileSync(join(dir, 'data', 'overrides.json'), 'utf8'));
    const reloaded = loadConfig({ CAMPROXY_TOKENS: CLIENT_TOKEN, CAMPROXY_ADMIN_TOKEN: ADMIN_TOKEN, CAMPROXY_CAMERA_PASSWORD: sim.password, CAMPROXY_FTP_PASSWORD: 'x'.repeat(24), CAMERA_HOST: sim.camera.host }, { cwd: dir });
    const c = cameraConfig(reloaded.config, 'cam1')!;
    expect(c.statusPollS).toBe(7);
    expect(c.poeSwitch.offSeconds).toBe(12);
    expect(c.ftp.user).toBe('picam');
    expect(reloaded.config.retention.eventsDays).toBe(40);
    expect(saved.retention.eventsDays).toBe(40);
  });
});

// P2 (spec §8.5): one go2rtc for the host; on the Pi it serves the one camera
// on go2rtc.rtspPort/apiPort as before (cam1_sub, cam1_main), with the password
// only in its environment.
describe.skipIf(!process.env.CAMPROXY_TEST_GO2RTC)('the Pi: stills through the host go2rtc', () => {
  it('cam1_sub and cam1_main on the configured ports; frames arrive', async () => {
    await until(() => proxy.stills?.grabber.up() === true, 30_000);
    const streams = await new Promise<Record<string, unknown>>((resolve, reject) => {
      import('http').then(({ get }) => get({ host: '127.0.0.1', port: go2rtcPorts.apiPort, path: '/api/streams' }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve(JSON.parse(body)));
      }).on('error', reject));
    });
    expect(Object.keys(streams).sort()).toEqual(['cam1_main', 'cam1_sub']);
    expect(proxy.stills!.go2rtc.streamUrl('cam1', 'sub')).toBe(`rtsp://127.0.0.1:${go2rtcPorts.rtspPort}/cam1_sub`);
  }, 40_000);
});

// P2 (spec §7): one FTP server with a user per camera. The Pi's camera keeps
// its user (picam from the overrides) and logs in from its own address.
describe('the Pi: FTP for its one camera', () => {
  it('the user picam is cam1, from the camera address only; it logs in', async () => {
    expect([...ftpUsers(proxy.running)]).toEqual([['picam', { cam: 'cam1', ip: '127.0.0.1' }]]);
    const c = new Client(5000);
    try {
      await c.access({ host: '127.0.0.1', port: ftpPort, user: 'picam', password: 'ftp-secret-'.padEnd(24, 'z'), secure: true, secureOptions: { rejectUnauthorized: false } });
      expect(await c.pwd()).toBe('/');
    } finally {
      c.close();
    }
  });
});

// The health items the Pi's display reads, as release 8 answers them.
const PI_ITEM_IDS = ['camera', 'stream', 'events', 'ftp', 'storage', 'disk', 'archive', 'inventory', 'version'];

describe('the cluster proxy (deploy/cluster/config.json, camera cam2)', () => {
  it('loads unchanged: one camera cam2 with FTP on the sub stream', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'camproxy-cluster-'));
    writeFileSync(join(cwd, 'config.json'), readFileSync(join(__dirname, '..', 'deploy', 'cluster', 'config.json')));
    const loaded = loadConfig({ CAMPROXY_TOKENS: CLIENT_TOKEN, CAMPROXY_ADMIN_TOKEN: ADMIN_TOKEN, CAMPROXY_CAMERA_PASSWORD: 'p'.repeat(12), CAMPROXY_FTP_PASSWORD: 'f'.repeat(24) }, { cwd });
    const c = cameraConfig(loaded.config, 'cam2')!;
    expect(c).toMatchObject({ id: 'cam2', name: 'cam2', host: 'cam2.cam-sim.svc.cluster.local:443', protocol: 'https', tlsName: 'cam2.skylar.technology' });
    expect(c.ftp).toEqual({ user: 'camera', enabled: true, stream: 'sub' });
    expect(c.stills.stream).toBe('sub');
  });
});
