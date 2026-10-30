import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { cameraPasswordsFile } from '../src/config/camera-passwords';
import { readEnvValue } from '../src/config/env-file';
import { loadConfig } from '../src/config/load';
import { createProxy, type Proxy } from '../src/proxy';
import { servedCertificate } from '../src/tls/served';
import { ADMIN_TOKEN, CLIENT_TOKEN, auth, freePort, until } from './helpers/proxy';
import { startSim } from './helpers/sim';
import { lastAudit } from './helpers/onboarding';
import { OnboardingService } from '../src/onboarding/service';
import { PasswordAttempts } from '../src/onboarding/attempts';
import { RemoveLeftovers } from '../src/onboarding/remove-leftovers';

// POST /control/cameras on a single-camera proxy (the Pi: config.json `camera`
// + CAMERA_HOST; spec 2026-10-30-camera-onboarding-design §4.3).
type Sim = Awaited<ReturnType<typeof startSim>>;
const open: { proxy: Proxy; sim: Sim }[] = [];
afterAll(async () => {
  await Promise.all(open.map(async (o) => (await o.proxy.stop(), await o.sim.close())));
}, 60_000);

const MOVE = `mv_${'1'.repeat(20)}`;
async function pi(o: { envFile?: boolean; cameraHost?: boolean; moved?: boolean } = {}) {
  const sim = await startSim();
  const dir = mkdtempSync(join(tmpdir(), 'onb-pi-'));
  mkdirSync(join(dir, 'data'));
  writeFileSync(join(dir, 'config.json'), JSON.stringify({
    camera: { id: 'cam1', name: 'Den', protocol: 'http', user: 'proxy', onvifPort: sim.ports.onvif, rtspPort: sim.ports.rtsp || 554, baichuanPort: sim.camera.baichuanPort, statusPollS: 5 },
    server: { logLevel: 'silent' },
    stills: { enabled: false },
    go2rtc: { binary: 'go2rtc', rtspPort: await freePort(), apiPort: await freePort() },
    events: { onvif: { subscribeMin: 1, pullTimeoutS: 1 }, poll: { enabled: true, intervalS: 1, afterOnvifDownS: 1 } },
  }));
  if (o.moved) writeFileSync(join(dir, 'data', 'overrides.json'), JSON.stringify({ cameras: { cam1: { moved: MOVE } } }));
  const envPath = join(dir, '.env');
  if (o.envFile !== false) writeFileSync(envPath, o.cameraHost ? `CAMERA_HOST=${sim.camera.host}\n` : '# the Pi\n', { mode: 0o600 });
  const loaded = loadConfig({ CAMPROXY_TOKENS: CLIENT_TOKEN, CAMPROXY_ADMIN_TOKEN: ADMIN_TOKEN, CAMPROXY_CAMERA_PASSWORD: 'not-the-password', ...(o.envFile !== false ? { CAMPROXY_ENV_FILE: envPath } : {}) }, { cwd: dir });
  const proxy = createProxy(loaded);
  const { port } = await proxy.start({ port: 0, host: '127.0.0.1' });
  open.push({ proxy, sim });
  const base = `http://127.0.0.1:${port}`;
  const fingerprint = (await servedCertificate('127.0.0.1', sim.ports.https))!.fingerprint;
  const body = { host: `127.0.0.1:${sim.ports.https}`, user: 'proxy', password: sim.password, trust: { fingerprint }, ports: { rtsp: sim.ports.rtsp, onvif: sim.ports.onvif, baichuan: sim.ports.baichuan } };
  const add = (b: object = body) => request(base).post('/control/cameras').set(auth(ADMIN_TOKEN)).send(b);
  const stored = () => (existsSync(cameraPasswordsFile(join(dir, 'data'))) ? JSON.parse(readFileSync(cameraPasswordsFile(join(dir, 'data')), 'utf8')).cameras : {});
  return { sim, proxy, dir, base, envPath, body, add, stored };
}

describe('adding a camera on the Pi', () => {
  it('a Pi without a camera takes the new one: CAMERA_HOST written, running at once, no restart', async () => {
    const t = await pi();
    const r = await t.add();
    expect([r.status, r.body.onboarding?.camera]).toEqual([201, 'cam1']);
    expect(readEnvValue(readFileSync(t.envPath, 'utf8'), 'CAMERA_HOST')).toBe(t.body.host);
    await until(async () => (await request(t.base).get('/api/cameras/cam1').set(auth())).body.online === true, 20_000);
    const view = (await request(t.base).get('/api/cameras/cam1').set(auth())).body;
    expect([view.address, view.tls.mode, view.credentials.source]).toEqual([t.body.host, 'pinned', 'store']);
    expect(t.stored().cam1.password).toBe(t.sim.password);
    expect(lastAudit(t.dir, 'camera-add')!.cam_proxy).toMatchObject({ host: t.body.host, envName: 'CAMERA_HOST', pinned: t.body.trust.fingerprint });
    // The config.json camera is untouched; the protocol is an override.
    expect(JSON.parse(readFileSync(join(t.dir, 'config.json'), 'utf8')).camera.host).toBeUndefined();
    expect(t.proxy.running.cameras.cam1.protocol).toBe('https');
  }, 40_000);

  it('a configured legacy camera: 409 camera_limit, .env unchanged', async () => {
    const t = await pi({ cameraHost: true });
    const before = readFileSync(t.envPath, 'utf8');
    const r = await t.add();
    expect([r.status, r.body.error]).toEqual([409, 'camera_limit']);
    expect(readFileSync(t.envPath, 'utf8')).toBe(before);
    expect(t.stored()).toEqual({});
  }, 30_000);

  it('another id is 409 camera_id', async () => {
    const t = await pi();
    const r = await t.add({ ...t.body, id: 'cam2' });
    expect([r.status, r.body.error, r.body.detail]).toEqual([409, 'camera_id', 'this proxy has one camera, cam1']);
    expect((await t.add({ ...t.body, id: 'cam1' })).status).toBe(201);
  }, 30_000);

  it('after a finished move the hidden camera is replaced', async () => {
    const t = await pi({ moved: true });
    expect((await request(t.base).get('/api/cameras').set(auth())).body).toEqual([]);
    const r = await t.add();
    expect(r.status).toBe(201);
    await until(async () => (await request(t.base).get('/api/cameras/cam1').set(auth())).body.online === true, 20_000);
    expect(JSON.parse(readFileSync(join(t.dir, 'data', 'overrides.json'), 'utf8')).cameras?.cam1?.moved).toBeUndefined();
  }, 40_000);

  it('without a writable .env: 409 not_available with the line, nothing stored', async () => {
    const t = await pi({ envFile: false });
    const before = t.sim.sim.engine.counters.loginAttempts;
    const r = await t.add();
    expect([r.status, r.body.error, r.body.line]).toEqual([409, 'not_available', `CAMERA_HOST=${t.body.host}`]);
    expect(t.stored()).toEqual({});
    expect(t.sim.sim.engine.counters.loginAttempts).toBe(before); // the camera was not asked
  }, 30_000);
});

describe('a move still open on the Pi', () => {
  it('during an open move it is 409 move_open, the camera never asked', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'onb-pi-open-'));
    mkdirSync(join(dir, 'data'));
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ camera: { id: 'cam1', protocol: 'http', user: 'proxy' }, server: { logLevel: 'silent' } }));
    writeFileSync(join(dir, 'data', 'overrides.json'), JSON.stringify({ cameras: { cam1: { moved: MOVE } } }));
    writeFileSync(join(dir, '.env'), '');
    const loaded = loadConfig({ CAMPROXY_TOKENS: CLIENT_TOKEN, CAMPROXY_ADMIN_TOKEN: ADMIN_TOKEN, CAMPROXY_CAMERA_PASSWORD: 'x' }, { cwd: dir });
    const writes: unknown[] = [];
    const asked: string[] = [];
    const s = new OnboardingService({
      loaded: () => loaded, setLoaded: () => asked.push('setLoaded'), running: () => loaded.config, cameras: { get: () => undefined, ids: () => [] } as never,
      restartCamera: async () => void asked.push('restart'), passwords: { get: () => undefined, set: () => asked.push('store'), delete: () => undefined },
      trustFor: () => undefined, certState: () => null, audit: { write: (r: unknown) => (writes.push(r), null) }, attempts: new PasswordAttempts(),
      served: async () => (asked.push('served'), null), pinServed: () => { throw new Error('no pin'); }, statusInput: () => null, zone: () => null,
      moveOpen: (id) => id === MOVE, envFile: () => join(dir, '.env'),
      positions: { count: () => 0, remove: () => 0 }, trust: { known: () => false, forget: () => undefined }, cameraFtp: { pointsHere: async () => false, off: async () => undefined }, removeLeftovers: new RemoveLeftovers(join(dir, 'data')),
    });
    const r = await s.add({ host: '192.0.2.10', protocol: 'http', password: 'p' }, { user: 'admin', requestedBy: 'token' });
    expect([r.status, 'error' in r && r.error]).toEqual([409, 'move_open']);
    expect(asked).toEqual([]);
    expect(writes).toHaveLength(1);
  });
});
