import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { insertPosition, listPositions } from '../src/catalog/ptz-positions';
import { cameraPasswordsFile, cameraPasswordStore } from '../src/config/camera-passwords';
import { readEnvValue } from '../src/config/env-file';
import { loadConfig } from '../src/config/load';
import { RemoveLeftovers, removeLeftoverItems } from '../src/onboarding/remove-leftovers';
import { createProxy, type Proxy } from '../src/proxy';
import { servedCertificate } from '../src/tls/served';
import { startMultiProxy, startSims, type Sim } from './helpers/multi';
import { audits, managedAdminToken } from './helpers/onboarding';
import { ADMIN_TOKEN, CLIENT_TOKEN, auth, freePort, until } from './helpers/proxy';
import { startSim } from './helpers/sim';

// DELETE /control/cameras/:id (spec 2026-10-30-camera-onboarding-design §4.3).
const stops: (() => Promise<unknown>)[] = [];
afterAll(async () => void (await Promise.all(stops.map((f) => f()))), 60_000);
const admin = () => auth(ADMIN_TOKEN);
const stored = (dir: string) => (existsSync(cameraPasswordsFile(join(dir, 'data'))) ? JSON.parse(readFileSync(cameraPasswordsFile(join(dir, 'data')), 'utf8')).cameras : {});
async function multi(sims: Sim[], o: Parameters<typeof startMultiProxy>[1] = {}) {
  const p = await startMultiProxy(sims, o);
  stops.push(() => p.proxy.stop());
  return p;
}

describe('removing a camera', () => {
  it('removes an added camera with its password, pin, PTZ rows and FTP upload', async () => {
    const sims = await startSims(2);
    stops.push(() => Promise.all(sims.map((s) => s.close())));
    const p = await multi([sims[0]], { settings: { ftp: { publicHost: '127.0.0.1', port: await freePort() } }, env: { CAMPROXY_FTP_PASSWORD: 'ftp-secret-'.padEnd(24, 'z') } });
    const s = sims[1];
    const fingerprint = (await servedCertificate('127.0.0.1', s.ports.https))!.fingerprint;
    const add = await request(p.base).post('/control/cameras').set(admin()).send({ id: 'cam6', host: `127.0.0.1:${s.ports.https}`, user: 'proxy', password: s.password, trust: { fingerprint }, ports: { https: s.ports.https, rtsp: s.ports.rtsp, onvif: s.ports.onvif, baichuan: s.ports.baichuan } });
    expect(add.status).toBe(201);
    await until(async () => (await request(p.base).get('/api/cameras/cam6').set(auth())).body.online === true, 20_000);
    expect((await request(p.base).post('/control/cameras/cam6/actions/camera-ftp-setup').set(admin())).status).toBe(200);
    expect(s.sim.engine.settings.running.Ftp).toMatchObject({ enable: 1, server: '127.0.0.1' });
    insertPosition(p.proxy.catalog, { id: 'pos1', cam: 'cam6', name: 'Gate', sort_order: 0, home: 0, slot: 1, preset_name: 'Gate', created_at: 1, updated_at: 1 });
    expect(readdirSync(join(p.dir, 'data', 'tls', 'cameras')).join()).toContain('state.json');
    const r = await request(p.base).delete('/control/cameras/cam6').set(admin());
    expect(r.status).toBe(200);
    expect(r.body.removed).toEqual(expect.arrayContaining(['camera FTP upload off', 'configuration', 'stored password', 'certificate pin', 'PTZ positions (1)']));
    expect(r.body.leftovers).toEqual([]);
    expect(s.sim.engine.settings.running.Ftp.enable).toBe(0);
    expect(stored(p.dir).cam6).toBeUndefined();
    expect(readdirSync(join(p.dir, 'data', 'tls', 'cameras')).filter((f) => f.startsWith('cam6'))).toEqual([]);
    expect(JSON.parse(readFileSync(join(p.dir, 'data', 'tls', 'cameras', 'state.json'), 'utf8')).cameras.cam6).toBeUndefined();
    expect(listPositions(p.proxy.catalog, 'cam6')).toEqual([]);
    await until(async () => (await request(p.base).get('/api/cameras/cam6').set(auth())).status === 404, 10_000);
    const rec = audits(p.dir, 'camera-remove').at(-1)!;
    expect([rec.event.outcome, rec.labels.camera, rec.cam_proxy.removed, rec.cam_proxy.leftovers]).toEqual(['success', 'cam6', r.body.removed, []]);
    expect(audits(p.dir, 'camera-trust').at(-1)!.message).toContain('the camera was removed');
    // Gone: nothing left to remove.
    expect((await request(p.base).delete('/control/cameras/cam6').set(admin())).status).toBe(404);
  }, 60_000);

  it("a password in compose's environment is a leftover, listed on /control/status until gone", async () => {
    const sims = await startSims(2);
    stops.push(() => Promise.all(sims.map((s) => s.close())));
    const p = await multi([sims[0]], { env: { CAMPROXY_CAMERA_PASSWORD_CAM6: 'proxy-pw' } });
    const s = sims[1];
    expect((await request(p.base).put('/control/config').set(admin()).send({ cameras: { cam6: { host: s.camera.host, protocol: 'http', user: 'proxy', onvifPort: s.ports.onvif, rtspPort: s.ports.rtsp, baichuanPort: s.camera.baichuanPort } } })).status).toBe(200);
    const r = await request(p.base).delete('/control/cameras/cam6').set(admin());
    expect([r.status, r.body.leftovers]).toEqual([200, ['env CAMPROXY_CAMERA_PASSWORD_CAM6']]);
    const st = (await request(p.base).get('/control/status').set(admin())).body;
    expect(st.removeLeftovers).toEqual([{ camera: 'cam6', at: expect.any(Number), items: ['env CAMPROXY_CAMERA_PASSWORD_CAM6'] }]);
    // Once the variable is gone (a recreated container), the entry drops out.
    const l = new RemoveLeftovers(join(p.dir, 'data'));
    const without = { ...p.proxy.loaded, env: { ...p.proxy.loaded.env, CAMPROXY_CAMERA_PASSWORD_CAM6: undefined } };
    expect(l.current(without)).toEqual([]);
    expect(l.current(p.proxy.loaded)).toHaveLength(1);
  }, 40_000);

  it('a config.json camera on a several-camera proxy is 409 config_json; after it is gone from config.json, DELETE cleans up', async () => {
    const sims = await startSims(2);
    stops.push(() => Promise.all(sims.map((s) => s.close())));
    const dir = mkdtempSync(join(tmpdir(), 'onb-rm-cfg-'));
    const p = await startMultiProxy(sims, { dir });
    cameraPasswordStore(join(dir, 'data')).set('cam4', 'old-pw');
    const r = await request(p.base).delete('/control/cameras/cam4').set(admin());
    expect([r.status, r.body.error]).toEqual([409, 'config_json']);
    expect(stored(dir).cam4.password).toBe('old-pw');
    await p.proxy.stop();
    const q = await multi([sims[0]], { dir });
    const r2 = await request(q.base).delete('/control/cameras/cam4').set(admin());
    expect([r2.status, r2.body.removed]).toEqual([200, ['stored password']]);
    expect(stored(dir).cam4).toBeUndefined();
  }, 40_000);

  it('unknown id is 404, a bad one 400; managed rights are 403', async () => {
    const sims = await startSims(1);
    stops.push(() => Promise.all(sims.map((s) => s.close())));
    const dir = mkdtempSync(join(tmpdir(), 'onb-rm-m-'));
    const managed = managedAdminToken(dir);
    const p = await multi(sims, { dir });
    expect((await request(p.base).delete('/control/cameras/cam9').set(admin())).status).toBe(404);
    expect((await request(p.base).delete('/control/cameras/Bad_Id').set(admin())).status).toBe(400);
    const m = await request(p.base).delete('/control/cameras/cam3').set(auth(managed));
    expect([m.status, m.body.error]).toEqual([403, 'local_admin_only']);
    expect(audits(dir, 'camera-remove')).toHaveLength(0);
  }, 30_000);
});

describe('removing the Pi camera', () => {
  let proxy: Proxy;
  it('on the Pi: CAMERA_HOST removed, the camera idle, config.json untouched', async () => {
    const sim = await startSim();
    stops.push(() => sim.close());
    const dir = mkdtempSync(join(tmpdir(), 'onb-rm-pi-'));
    mkdirSync(join(dir, 'data'));
    const cfg = JSON.stringify({ camera: { id: 'cam1', protocol: 'http', user: 'proxy', onvifPort: sim.ports.onvif, rtspPort: sim.ports.rtsp || 554, baichuanPort: sim.camera.baichuanPort, statusPollS: 5 }, server: { logLevel: 'silent' }, stills: { enabled: false }, go2rtc: { binary: 'go2rtc', rtspPort: await freePort(), apiPort: await freePort() } });
    writeFileSync(join(dir, 'config.json'), cfg);
    const envPath = join(dir, '.env');
    writeFileSync(envPath, `CAMERA_HOST=${sim.camera.host}\nPI_ADDRESS=127.0.0.1\n`, { mode: 0o600 });
    proxy = createProxy(loadConfig({ CAMPROXY_TOKENS: CLIENT_TOKEN, CAMPROXY_ADMIN_TOKEN: ADMIN_TOKEN, CAMPROXY_CAMERA_PASSWORD: sim.password, CAMPROXY_ENV_FILE: envPath }, { cwd: dir }));
    stops.push(() => proxy.stop());
    const base = `http://127.0.0.1:${(await proxy.start({ port: 0, host: '127.0.0.1' })).port}`;
    await until(async () => (await request(base).get('/api/cameras/cam1').set(auth())).body.online === true, 20_000);
    const r = await request(base).delete('/control/cameras/cam1').set(admin());
    expect([r.status, r.body.removed]).toEqual([200, expect.arrayContaining(['CAMERA_HOST'])]);
    expect(readEnvValue(readFileSync(envPath, 'utf8'), 'CAMERA_HOST')).toBeUndefined();
    expect(readEnvValue(readFileSync(envPath, 'utf8'), 'PI_ADDRESS')).toBe('127.0.0.1');
    expect(readFileSync(join(dir, 'config.json'), 'utf8')).toBe(cfg);
    await until(async () => (await request(base).get('/api/cameras/cam1').set(auth())).body.online === false, 20_000);
    expect((await request(base).get('/api/cameras/cam1').set(auth())).body.address).toBe('');
  }, 60_000);

  it('removeLeftoverItems: the own variable, its _FILE, a config.json camera.host on the Pi', () => {
    const dir = mkdtempSync(join(tmpdir(), 'onb-rm-items-'));
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ camera: { id: 'cam1', host: '192.0.2.10' }, server: { logLevel: 'silent' } }));
    const l = loadConfig({ CAMPROXY_TOKENS: CLIENT_TOKEN, CAMPROXY_ADMIN_TOKEN: ADMIN_TOKEN, CAMPROXY_CAMERA_PASSWORD: 'x' }, { cwd: dir });
    expect(removeLeftoverItems({ ...l, env: { CAMPROXY_CAMERA_PASSWORD_CAM1: 'x', CAMPROXY_CAMERA_PASSWORD_CAM1_FILE: '/run/secrets/x' } }, 'cam1')).toEqual(['env CAMPROXY_CAMERA_PASSWORD_CAM1', 'env CAMPROXY_CAMERA_PASSWORD_CAM1_FILE', 'config.json camera.host']);
  });
});
