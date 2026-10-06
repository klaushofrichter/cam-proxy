// The Pi's one-camera setup keeps working through the multi-camera change
// (spec 2026-10-05-multi-camera-host-design §4.2, §11): its config.json (a
// legacy `camera` object with a PoE switch), overrides.json written by the
// Settings page with legacy paths, CAMERA_HOST / PI_ADDRESS, and a catalog
// as release 8 left it (events, Vision usage).
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Client } from 'basic-ftp';
import request from 'supertest';
import { ftpUsers } from '../src/clips/side';
import { shareBytes } from '../src/storage';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MIGRATIONS } from '../src/catalog/migrations';
import { usageBetween, usageByCamera } from '../src/catalog/analyses';
import { cameraConfig } from '../src/config/cameras';
import { loadConfig } from '../src/config/load';
import { createProxy, type Proxy } from '../src/proxy';
import { ADMIN_TOKEN, CLIENT_TOKEN, auth, freePort, startProxy, until } from './helpers/proxy';
import { servedFingerprint } from '../src/tls/served';
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
    // P2 (spec §6.4): the newest still from memory.
    await until(() => proxy.cameras.first().latestFrame() !== undefined, 15_000);
    const r = await request(base).get('/api/cameras/cam1/stills/latest.jpg').set(auth());
    expect([r.status, r.headers['content-type']]).toEqual([200, 'image/jpeg']);
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

// P2 (spec §8.1): one storage budget; the Pi's one camera has no share and
// gets the whole budget; the stats name its part.
describe('the Pi: the storage budget', () => {
  it('the whole budget is cam1\'s; storage per camera is cam1 only', async () => {
    expect(Object.fromEntries(shareBytes(proxy.running, 1000))).toEqual({ cam1: 1000 });
    proxy.storage.noteWritten('stills', 10, 1, { cam: 'cam1' });
    const st = (await request(base).get('/control/stats').set(auth(ADMIN_TOKEN))).body;
    expect(Object.keys(st.cameras)).toEqual(['cam1']);
    expect(st.storage.budget).toBe(161061273600);
  });
});

// P2 (spec §8.3): one recordings cache for the host; the Pi's camera has the whole cap.
describe('the Pi: the recordings cache', () => {
  it('the whole recordings.cacheMB, as before', async () => {
    const st = (await request(base).get('/control/status').set(auth(ADMIN_TOKEN))).body;
    expect(st.recordings.cache.capBytes).toBe(proxy.running.recordings.cacheMB * 2 ** 20);
  });
});

// P2 (spec §8.2): Vision limits count per key; the month counted before the
// key ids (key_id '') stays in the Pi's month with the key in use.
describe('the Pi: the Vision budget', () => {
  it("the month's legacy calls count with the key in use (the last test here: it sets a key)", () => {
    expect(proxy.analytics.state()[0].month.calls).toBe(14);
    proxy.analytics.setManualKey('pi-vision-key-'.padEnd(30, 'k'));
    expect(proxy.analytics.state()[0].month.calls).toBe(14);
    expect(proxy.analytics.state()[0].cameras).toEqual([{ id: 'cam1', today: expect.any(Number), month: 14 }]);
  });
});

// P2 (spec §8.4): one PoE controller per host; the Pi's camera is its port 8.
describe('the Pi: the switch controller', () => {
  it("the camera's view is port 8 of the host's GPS-208 settings", () => {
    const h = proxy.cameras.first().poeSwitch;
    expect(h.status()).toMatchObject({ model: 'sscpoe-web', host: '127.0.0.1:9', port: 8, ports: 8, offSeconds: 12, passwordSet: false, configured: false, poeMaybeOff: false });
    expect(h.notConfigured()).toBe('CAMPROXY_POE_SWITCH_PASSWORD is not set');
  });
});

// P2 (spec §8.6): composed clips one at a time on the Pi (the default).
describe('the Pi: compositions', () => {
  it('composition.concurrent is 1', () => {
    expect(proxy.running.composition.concurrent).toBe(1);
  });
});

// P2 (spec §6.3): cameras may be added in overrides.json; the Pi's camera is config.json's.
describe('the Pi: where its camera is defined', () => {
  it("GET /control/status: one camera, source config; it can't be removed from the UI", async () => {
    const st = (await request(base).get('/control/status').set(auth(ADMIN_TOKEN))).body;
    expect(st.cameras.map((c: { id: string; source: string }) => [c.id, c.source])).toEqual([['cam1', 'config']]);
    const r = await request(base).delete('/control/config/cameras.cam1').set(auth(ADMIN_TOKEN));
    expect([r.status, r.body.detail]).toEqual([400, 'cameras.cam1: defined in config.json; remove it there']);
  });
});

// The health items the Pi's display reads, as release 8 answers them.
const PI_ITEM_IDS = ['camera', 'stream', 'events', 'ftp', 'storage', 'disk', 'archive', 'inventory', 'version'];

// The Pi stays on Let's Encrypt through the cluster's cam1-cert-push (spec
// 2026-10-05-multi-camera-host-design §11): no tls.site, no site CA, no
// HTTPS listener, no certificate push, ever.
describe('the Pi: no site CA', () => {
  it('/tls/ca.pem: 404 no_site_ca; no tls folder; no certificate scheduler', async () => {
    const r = await request(base).get('/tls/ca.pem');
    expect([r.status, r.body]).toEqual([404, { error: 'no_site_ca' }]);
    expect(proxy.running.tls).toEqual({ cameraCerts: true });
    expect(proxy.running.server.tls).toEqual({});
    expect(proxy.certs).toBeUndefined();
    expect(proxy.running.ntp).toEqual({});
    expect(sim.sim.engine.counters.setCalls).not.toContain('SetNtp'); // its camera's NTP is left alone
    expect(existsSync(join(dir, 'data', 'tls'))).toBe(false);
    expect((await request(base).get('/api/cameras').set(auth())).body[0].tls).toEqual({ mode: 'none', servername: null, fingerprint: null, notAfter: null, lastPush: null });
    const h = (await request(base).get('/api/local/health')).body;
    expect(h.items.find((i: { id: string }) => i.id === 'certificates')).toBeUndefined();
    expect((await request(base).post('/control/cameras/cam1/actions/camera-cert-push').set(auth(ADMIN_TOKEN))).body).toMatchObject({ outcome: 'failed', detail: 'no site CA: tls.site is not set' });
    expect((await request(base).post('/control/actions/tls-ca-rotate').set(auth(ADMIN_TOKEN)).send({ confirm: 'rotate' })).status).toBe(409);
    expect(existsSync(join(dir, 'data', 'tls'))).toBe(false);
  });
});

// cams-admin (spec 2026-10-06-cams-admin-phase1-design §9.1): no camsAdmin.url,
// so no socket, no timer, no data/admin folder, no new health item or metric.
describe('the Pi: no cams-admin', () => {
  it('off: no client, no data/admin, the same health items, no cams-admin metric', async () => {
    expect(proxy.running.camsAdmin).toEqual({ keyFile: 'admin/key.json', enabled: true });
    expect(proxy.camsAdmin.view()).toMatchObject({ state: 'off', url: null });
    expect(proxy.camsAdmin.active()).toBe(false);
    expect(existsSync(join(dir, 'data', 'admin'))).toBe(false);
    const h = (await request(base).get('/api/local/health')).body;
    expect(h.items.map((i: { id: string }) => i.id)).toEqual(PI_ITEM_IDS);
    expect((await request(base).get('/metrics')).text).not.toMatch(/^camproxy_cams_admin_state\{/m);
  });
});

describe("cam1 as on the Pi (https, tlsName: its Let's Encrypt name) with a site CA on: never pushed to", () => {
  it('mode public; nothing imported into the camera', async () => {
    const s2 = await startSim();
    const before = await servedFingerprint('127.0.0.1', s2.ports.https);
    const q = await startProxy(s2, { settings: {
      camera: { host: `127.0.0.1:${s2.ports.https}`, protocol: 'https', tlsName: 'cam1.skylar.technology', user: 'proxy', onvifPort: s2.ports.onvif, rtspPort: s2.ports.rtsp || 554, baichuanPort: s2.camera.baichuanPort, statusPollS: 5 },
      tls: { site: 'pi', cameraSubnet: '127.0.0.0/16', proxyAddresses: '127.0.0.1' },
    } });
    try {
      await q.proxy.certs!.tick();
      expect(q.proxy.certs!.state('cam1')).toMatchObject({ mode: 'public', servername: 'cam1.skylar.technology', lastPush: null });
      expect((await request(q.base).post('/control/cameras/cam1/actions/camera-cert-push').set(auth(ADMIN_TOKEN))).body.outcome).toBe('failed');
      expect(s2.sim.engine.certs.state.enable).toBe(0);
      expect(await servedFingerprint('127.0.0.1', s2.ports.https)).toBe(before);
      expect(existsSync(join(q.dir, 'data', 'tls', 'cameras', 'cam1.key'))).toBe(false);
      expect((await request(q.base).get('/api/cameras').set(auth())).body[0].tls).toMatchObject({ mode: 'public', servername: 'cam1.skylar.technology', lastPush: null });
    } finally {
      await q.proxy.stop();
      await s2.close();
    }
  }, 60_000);
});

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
