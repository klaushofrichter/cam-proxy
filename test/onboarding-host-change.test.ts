import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { readEnvValue } from '../src/config/env-file';
import { loadConfig } from '../src/config/load';
import { PasswordAttempts } from '../src/onboarding/attempts';
import { RemoveLeftovers } from '../src/onboarding/remove-leftovers';
import { OnboardingService } from '../src/onboarding/service';
import { createProxy, type Proxy } from '../src/proxy';
import { servedCertificate } from '../src/tls/served';
import { otherCertificate } from './helpers/certs';
import { startMultiProxy } from './helpers/multi';
import { audits, auditText, logText } from './helpers/onboarding';
import { ADMIN_TOKEN, CLIENT_TOKEN, auth, freePort, until } from './helpers/proxy';
import { E1_MODEL, startSim } from './helpers/sim';

// PUT /control/cameras/:id/host (and /control/camera/host on a single-camera
// proxy): a configured camera's new address after the DHCP router handed out
// another one. Only the same camera: its pinned certificate, a login with its
// stored password, its model as last read; then written where this proxy
// keeps the address (CAMERA_HOST in the env file, else overrides.json).
type Sim = Awaited<ReturnType<typeof startSim>>;
const stops: (() => Promise<unknown>)[] = [];
afterAll(async () => void (await Promise.all(stops.map((f) => f()))), 60_000);
const sim = async (o: Parameters<typeof startSim>[0] = {}) => {
  const s = await startSim(o);
  stops.push(() => s.close());
  return s;
};
const admin = () => auth(ADMIN_TOKEN);
const online = async (base: string, cam: string) => (await request(base).get(`/api/cameras/${cam}`).set(auth())).body.online === true;

// A Pi: config.json `camera`, CAMERA_HOST in the env file (`host`: 'sim' is
// the camera's own sim, which then is online; null: no line).
async function pi(host0: string | null | 'sim') {
  const s0 = await sim();
  const host = host0 === 'sim' ? s0.camera.host : host0;
  const dir = mkdtempSync(join(tmpdir(), 'host-pi-'));
  mkdirSync(join(dir, 'data'));
  writeFileSync(join(dir, 'config.json'), JSON.stringify({
    camera: { id: 'cam1', protocol: 'http', user: 'proxy', onvifPort: s0.ports.onvif, rtspPort: s0.ports.rtsp || 554, baichuanPort: s0.camera.baichuanPort, statusPollS: 5 },
    server: { logLevel: 'silent' },
    stills: { enabled: false },
    go2rtc: { binary: 'go2rtc', rtspPort: await freePort(), apiPort: await freePort() },
    events: { onvif: { subscribeMin: 1, pullTimeoutS: 1 }, poll: { enabled: true, intervalS: 1, afterOnvifDownS: 1 } },
  }));
  const envPath = join(dir, '.env');
  writeFileSync(envPath, host ? `PI_ADDRESS=127.0.0.1\nCAMERA_HOST=${host}\n` : 'PI_ADDRESS=127.0.0.1\n', { mode: 0o600 });
  const proxy: Proxy = createProxy(loadConfig({ CAMPROXY_TOKENS: CLIENT_TOKEN, CAMPROXY_ADMIN_TOKEN: ADMIN_TOKEN, CAMPROXY_CAMERA_PASSWORD: s0.password, CAMPROXY_ENV_FILE: envPath }, { cwd: dir }));
  stops.push(() => proxy.stop());
  const base = `http://127.0.0.1:${(await proxy.start({ port: 0, host: '127.0.0.1' })).port}`;
  const put = (to: unknown, path = '/control/cameras/cam1/host', h: Record<string, string> = admin()) => request(base).put(path).set(h).send({ host: to });
  const backups = () => readdirSync(dir).filter((n) => n.startsWith('.env.bak-'));
  return { s0, dir, envPath, proxy, base, put, backups };
}

describe('a new address on the Pi (CAMERA_HOST in the env file)', () => {
  it('the same camera at its new address: CAMERA_HOST rewritten (with a backup), the camera back online, audited', async () => {
    const t = await pi('sim');
    const base = t.base;
    const proxy = t.proxy;
    await until(() => online(base, 'cam1'), 20_000);
    // The router gave the camera another address: a second sim of the same model stands in for it.
    const s1 = await sim();
    const r = await request(base).put('/control/camera/host').set(admin()).send({ host: s1.camera.host });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ outcome: 'changed', camera: 'cam1', from: t.s0.camera.host, to: s1.camera.host, stored: 'env', identity: { checked: 'model', model: 'RLC-1224A' } });
    expect(readEnvValue(readFileSync(t.envPath, 'utf8'), 'CAMERA_HOST')).toBe(s1.camera.host);
    expect(readEnvValue(readFileSync(t.envPath, 'utf8'), 'PI_ADDRESS')).toBe('127.0.0.1');
    expect(t.backups()).toHaveLength(1);
    expect(proxy.running.cameras.cam1.host).toBe(s1.camera.host);
    await until(async () => (await online(base, 'cam1')) && s1.sim.engine.counters.logins > 1, 20_000);
    const rec = audits(t.dir, 'camera-host-change').at(-1)!;
    expect([rec.event.outcome, rec.labels.camera, rec.cam_proxy.from, rec.cam_proxy.to, rec.cam_proxy.requestedBy]).toEqual(['success', 'cam1', t.s0.camera.host, s1.camera.host, 'token']);
    // Again with the same address: unchanged, nothing written.
    const before = t.backups().length;
    const again = await request(base).put('/control/cameras/cam1/host').set(admin()).send({ host: s1.camera.host });
    expect([again.status, again.body.outcome]).toEqual([200, 'unchanged']);
    expect(t.backups()).toHaveLength(before);
  }, 60_000);

  it('another camera model at the new address: 409 different_camera, nothing written', async () => {
    const t = await pi('sim');
    const base = t.base;
    await until(() => online(base, 'cam1'), 20_000);
    const other = await sim({ model: E1_MODEL });
    const r = await request(base).put('/control/cameras/cam1/host').set(admin()).send({ host: other.camera.host });
    expect([r.status, r.body.error]).toEqual([409, 'different_camera']);
    expect(r.body).toMatchObject({ expected: { model: 'RLC-1224A' }, found: { model: 'E1 Outdoor Pro' } });
    expect(readEnvValue(readFileSync(t.envPath, 'utf8'), 'CAMERA_HOST')).toBe(t.s0.camera.host);
    expect(t.backups()).toEqual([]);
    const rec = audits(t.dir, 'camera-host-change').at(-1)!;
    expect([rec.event.outcome, rec.error?.message, rec.cam_proxy.from, rec.cam_proxy.to]).toEqual(['failure', 'different_camera', t.s0.camera.host, other.camera.host]);
  }, 60_000);

  it('nothing known to compare (the old address never answered): the login is the check, and the answer says so', async () => {
    const t = await pi(`127.0.0.1:${await freePort()}`);
    const r = await t.put(t.s0.camera.host);
    expect(r.status).toBe(200);
    expect(r.body.identity).toEqual({ checked: 'login', model: 'RLC-1224A', detail: expect.stringContaining('no model known') });
    expect(readEnvValue(readFileSync(t.envPath, 'utf8'), 'CAMERA_HOST')).toBe(t.s0.camera.host);
    await until(() => online(t.base, 'cam1'), 20_000);
  }, 60_000);

  it("a camera that refuses the stored password: 422, nothing written; the attempts are limited; the password is never shown", async () => {
    const old = `127.0.0.1:${await freePort()}`;
    const t = await pi(old);
    const stranger = await sim();
    stranger.sim.engine.sessions.modifyUser('proxy', { password: 'another-camera-pw' });
    const r = await t.put(stranger.camera.host);
    expect([r.status, r.body.error]).toEqual([422, 'camera_refused']);
    expect(readEnvValue(readFileSync(t.envPath, 'utf8'), 'CAMERA_HOST')).toBe(old);
    expect(t.backups()).toEqual([]);
    for (let i = 0; i < 4; i++) await t.put(stranger.camera.host);
    const tries = stranger.sim.engine.counters.loginAttempts;
    const limited = await t.put(stranger.camera.host);
    expect([limited.status, limited.body.error]).toEqual([429, 'too_many_attempts']);
    expect(limited.headers['retry-after']).toMatch(/^\d+$/);
    expect(stranger.sim.engine.counters.loginAttempts).toBe(tries); // not asked
    expect(auditText(t.dir) + logText() + JSON.stringify(r.body)).not.toContain(t.s0.password);
  }, 60_000);

  it('the body and the camera are checked first', async () => {
    const t = await pi(`127.0.0.1:${await freePort()}`);
    for (const h of [undefined, '', 'a b', '3221225994', '192.0.002.010', 42]) {
      const r = await t.put(h);
      expect([r.status, r.body.error], String(h)).toEqual([400, 'invalid']);
    }
    expect((await t.put('192.0.2.10', '/control/cameras/cam9/host')).status).toBe(404);
    expect((await t.put('192.0.2.10', '/control/cameras/Cam1/host')).status).toBe(400);
    expect((await t.put('192.0.2.10', '/control/cameras/cam1/host', auth())).status).toBe(403);
  }, 30_000);

  it('a camera without an address is 409 no_address (onboard it instead)', async () => {
    const t = await pi(null);
    const r = await t.put('192.0.2.10');
    expect([r.status, r.body.error]).toEqual([409, 'no_address']);
  }, 30_000);
});

describe('a new address on a several-camera proxy (overrides.json)', () => {
  it('a config.json camera: the address goes into overrides.json, config.json untouched, the camera online there', async () => {
    const [s0, s1] = await Promise.all([sim(), sim()]);
    const p = await startMultiProxy([s0], { extra: [{ id: 'cam4' }] });
    stops.push(() => p.proxy.stop());
    await until(() => online(p.base, 'cam3'), 20_000);
    const r = await request(p.base).put('/control/cameras/cam3/host').set(admin()).send({ host: s1.camera.host });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ outcome: 'changed', from: s0.camera.host, to: s1.camera.host, stored: 'overrides', identity: { checked: 'model' } });
    expect(JSON.parse(readFileSync(join(p.dir, 'data', 'overrides.json'), 'utf8')).cameras.cam3.host).toBe(s1.camera.host);
    expect(JSON.parse(readFileSync(join(p.dir, 'config.json'), 'utf8')).cameras[0].host).toBe(s0.camera.host);
    await until(async () => (await online(p.base, 'cam3')) && s1.sim.engine.counters.logins > 1, 20_000);
    expect(audits(p.dir, 'config-change').at(-1)!.message).toContain('cameras.cam3.host');
    // PUT /control/camera/host needs a camera id here.
    const one = await request(p.base).put('/control/camera/host').set(admin()).send({ host: s0.camera.host });
    expect([one.status, one.body.error]).toEqual([400, 'camera_required']);
  }, 60_000);

  it('a pinned https camera: another certificate at the new address is 409 fingerprint_mismatch, no password sent', async () => {
    const [s0, s1] = await Promise.all([sim(), sim()]);
    const p = await startMultiProxy([s0], { https: true });
    stops.push(() => p.proxy.stop());
    const fingerprint = (await servedCertificate('127.0.0.1', s0.ports.https))!.fingerprint;
    expect((await request(p.base).post('/control/cameras/cam3/actions/camera-trust-pin').set(admin()).send({ fingerprint })).status).toBe(200);
    await until(() => online(p.base, 'cam3'), 20_000);
    // Every cam-sim serves the same default certificate: s1 gets one of its own.
    const other = await otherCertificate();
    s1.sim.engine.clearCertificate();
    await until(() => !s1.sim.engine.certRestarting, 10_000);
    expect(s1.sim.engine.importCertificate(other.pem, other.key)).toBeNull();
    await until(async () => (await servedCertificate('127.0.0.1', s1.ports.https))?.fingerprint === other.fingerprint, 10_000);
    const tries = s1.sim.engine.counters.loginAttempts;
    const r = await request(p.base).put('/control/cameras/cam3/host').set(admin()).send({ host: `127.0.0.1:${s1.ports.https}` });
    expect([r.status, r.body.error]).toEqual([409, 'fingerprint_mismatch']);
    expect(r.body.served).toBe(other.fingerprint);
    expect(s1.sim.engine.counters.loginAttempts).toBe(tries);
    expect(existsSync(join(p.dir, 'data', 'overrides.json')) ? JSON.parse(readFileSync(join(p.dir, 'data', 'overrides.json'), 'utf8')).cameras?.cam3?.host : undefined).toBeUndefined();
    // The same certificate under another spelling of the address: accepted.
    const ok = await request(p.base).put('/control/cameras/cam3/host').set(admin()).send({ host: `localhost:${s0.ports.https}` });
    expect([ok.status, ok.body.outcome, ok.body.identity?.checked]).toEqual([200, 'changed', 'model']);
  }, 60_000);
});

describe('a camera move still open', () => {
  it('is 409 move_open, the camera never asked', async () => {
    const MOVE = `mv_${'1'.repeat(20)}`;
    const dir = mkdtempSync(join(tmpdir(), 'host-move-'));
    mkdirSync(join(dir, 'data'));
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ camera: { id: 'cam1', host: '192.0.2.10', protocol: 'http', user: 'proxy' }, server: { logLevel: 'silent' } }));
    writeFileSync(join(dir, 'data', 'overrides.json'), JSON.stringify({ cameras: { cam1: { moved: MOVE } } }));
    const loaded = loadConfig({ CAMPROXY_TOKENS: CLIENT_TOKEN, CAMPROXY_ADMIN_TOKEN: ADMIN_TOKEN, CAMPROXY_CAMERA_PASSWORD: 'x' }, { cwd: dir });
    const writes: Record<string, any>[] = [];
    const asked: string[] = [];
    const s = new OnboardingService({
      loaded: () => loaded, setLoaded: () => asked.push('setLoaded'), running: () => loaded.config, cameras: { get: () => undefined, ids: () => [] } as never,
      restartCamera: async () => void asked.push('restart'), passwords: { get: () => undefined, set: () => asked.push('store'), delete: () => undefined },
      trustFor: () => undefined, certState: () => null, audit: { write: (r: Record<string, any>) => (writes.push(r), null) }, attempts: new PasswordAttempts(),
      served: async () => (asked.push('served'), null), pinServed: () => { throw new Error('no pin'); }, statusInput: () => null, zone: () => null,
      moveOpen: (id) => id === MOVE, envFile: () => join(dir, '.env'),
      positions: { count: () => 0, remove: () => 0 }, trust: { known: () => false, forget: () => undefined }, cameraFtp: { pointsHere: async () => false, off: async () => undefined }, removeLeftovers: new RemoveLeftovers(join(dir, 'data')), cameraClient: () => null, cameraNtp: async () => null,
    });
    const r = await s.changeHost('cam1', { host: '192.0.2.11' }, { user: 'admin', requestedBy: 'token' });
    expect([r.status, 'error' in r && r.error]).toEqual([409, 'move_open']);
    expect(asked).toEqual([]);
    expect(writes.map((w) => [w.action, w.outcome, w.details.from, w.details.to])).toEqual([['camera-host-change', 'failure', '192.0.2.10', '192.0.2.11']]);
  });
});
