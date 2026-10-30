import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { cameraPasswordsFile } from '../src/config/camera-passwords';
import { servedCertificate } from '../src/tls/served';
import { otherCertificate } from './helpers/certs';
import { startMultiProxy, startSims, type Sim } from './helpers/multi';
import { ADMIN_TOKEN, auth, startProxy, until } from './helpers/proxy';
import { startSim } from './helpers/sim';

// The onboarding security review's fixes (feat/onboarding-a): env passwords on
// add and remove, one add or remove at a time, a pinned camera serving another
// certificate, plaintext http.
const stops: (() => Promise<unknown>)[] = [];
afterAll(async () => void (await Promise.all(stops.map((f) => f()))), 60_000);
const a = () => auth(ADMIN_TOKEN);
const stored = (dir: string) => (existsSync(cameraPasswordsFile(join(dir, 'data'))) ? JSON.parse(readFileSync(cameraPasswordsFile(join(dir, 'data')), 'utf8')).cameras : {});
async function multi(n: number, o: Parameters<typeof startMultiProxy>[1] = {}) {
  const sims = await startSims(n);
  const p = await startMultiProxy([sims[0]], o);
  stops.push(async () => (await p.proxy.stop(), await Promise.all(sims.map((s) => s.close()))));
  return { p, sims };
}
const httpBody = (id: string, s: Sim, password = s.password) => ({ id, host: s.camera.host, protocol: 'http', user: 'proxy', password, ports: { http: s.ports.http, rtsp: s.ports.rtsp, onvif: s.ports.onvif, baichuan: s.ports.baichuan } });

describe('env passwords on add and remove (review 2)', () => {
  it("an add with the camera's password in compose's environment is 409 env_password; nothing is asked or stored", async () => {
    const { p, sims } = await multi(2, { env: { CAMPROXY_CAMERA_PASSWORD_CAM6: 'from-compose' } });
    const before = sims[1].sim.engine.counters.loginAttempts;
    const r = await request(p.base).post('/control/cameras').set(a()).send(httpBody('cam6', sims[1]));
    expect([r.status, r.body.error]).toEqual([409, 'env_password']);
    expect(r.body.detail).toContain('CAMPROXY_CAMERA_PASSWORD_CAM6');
    expect(sims[1].sim.engine.counters.loginAttempts).toBe(before);
    expect(stored(p.dir)).toEqual({});
  }, 30_000);

  it('remove, then add again with a new password: the camera logs in with the new one', async () => {
    const envDir = mkdtempSync(join(tmpdir(), 'onb-rv-env-'));
    const file = join(envDir, '.env');
    writeFileSync(file, 'CAMPROXY_CAMERA_PASSWORD_CAM6=proxy-pw\n', { mode: 0o600 });
    const { p, sims } = await multi(2, { env: { CAMPROXY_ENV_FILE: file, CAMPROXY_CAMERA_PASSWORD_CAM6: 'proxy-pw' } });
    const s = sims[1];
    // Added with its own managed line: the line goes, the store has it.
    const r1 = await request(p.base).post('/control/cameras').set(a()).send(httpBody('cam6', s));
    expect(r1.status).toBe(201);
    expect(readFileSync(file, 'utf8')).not.toContain('CAMPROXY_CAMERA_PASSWORD_CAM6');
    expect((await request(p.base).delete('/control/cameras/cam6').set(a())).status).toBe(200);
    s.sim.engine.sessions.modifyUser('proxy', { password: 'brand-new-pw' });
    const r2 = await request(p.base).post('/control/cameras').set(a()).send(httpBody('cam6', s, 'brand-new-pw'));
    expect(r2.status).toBe(201);
    await until(async () => (await request(p.base).get('/api/cameras/cam6').set(auth())).body.online === true, 20_000);
    expect((await request(p.base).get('/api/cameras/cam6').set(auth())).body.credentials.source).toBe('store');
  }, 60_000);
});

describe('one add or remove at a time (review 3)', () => {
  it('two adds at once at the limit: one is added, the other is 409 camera_limit', async () => {
    const { p, sims } = await multi(3);
    expect((await request(p.base).put('/control/profile').set(a()).send({ cameras: 2 })).status).toBe(200);
    const [x, y] = await Promise.all([request(p.base).post('/control/cameras').set(a()).send(httpBody('cam6', sims[1])), request(p.base).post('/control/cameras').set(a()).send(httpBody('cam7', sims[2]))]);
    expect([x.status, y.status].sort()).toEqual([201, 409]);
    expect([x, y].find((r) => r.status === 409)!.body.error).toBe('camera_limit');
    expect((await request(p.base).get('/control/cameras').set(a())).body).toHaveLength(2);
  }, 40_000);
});

describe('a pinned camera serving another certificate (review 4)', () => {
  it('the password save is 409 fingerprint_mismatch with the served one; no login', async () => {
    const s = await startSim();
    const p = await startProxy(s, { settings: { camera: { host: `127.0.0.1:${s.ports.https}`, protocol: 'https', user: 'proxy', onvifPort: s.ports.onvif, rtspPort: s.ports.rtsp || 554, baichuanPort: s.camera.baichuanPort, statusPollS: 5 } } });
    stops.push(async () => (await p.proxy.stop(), await s.close()));
    const fp = (await servedCertificate('127.0.0.1', s.ports.https))!.fingerprint;
    expect((await request(p.base).post('/control/cameras/cam1/actions/camera-trust-pin').set(a()).send({ fingerprint: fp })).status).toBe(200);
    const other = await otherCertificate('CERTIFICATE');
    s.sim.engine.clearCertificate();
    await until(() => !s.sim.engine.certRestarting, 10_000);
    expect(s.sim.engine.importCertificate(other.pem, other.key)).toBeNull();
    await until(async () => (await servedCertificate('127.0.0.1', s.ports.https))?.fingerprint === other.fingerprint, 10_000);
    const before = s.sim.engine.counters.loginAttempts;
    const r = await request(p.base).put('/control/cameras/cam1/password').set(a()).send({ password: s.password });
    expect([r.status, r.body.error, r.body.served]).toEqual([409, 'fingerprint_mismatch', other.fingerprint]);
    expect(s.sim.engine.counters.loginAttempts).toBe(before);
  }, 40_000);
});

describe('plain http (review 5)', () => {
  it('the add and the password answers say plaintext for an http camera', async () => {
    const { p, sims } = await multi(2);
    const add = await request(p.base).post('/control/cameras').set(a()).send(httpBody('cam6', sims[1]));
    expect([add.status, add.body.plaintext]).toEqual([201, true]);
    const pw = await request(p.base).put('/control/cameras/cam6/password').set(a()).send({ password: sims[1].password });
    expect([pw.status, pw.body.plaintext]).toEqual([200, true]);
  }, 30_000);
});

