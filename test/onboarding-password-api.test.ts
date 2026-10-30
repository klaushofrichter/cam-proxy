import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { cameraPasswordsFile } from '../src/config/camera-passwords';
import { ADMIN_TOKEN, auth, startProxy, until } from './helpers/proxy';
import { auditText, audits, lastAudit, logText, managedAdminToken } from './helpers/onboarding';
import { startSim } from './helpers/sim';

// PUT /control/cameras/:cam/password (spec 2026-10-30-camera-onboarding-design §4.1).
type Sim = Awaited<ReturnType<typeof startSim>>;
type P = Awaited<ReturnType<typeof startProxy>>;
const open: { p: P; s: Sim }[] = [];
afterAll(async () => {
  await Promise.all(open.map(async ({ p, s }) => (await p.proxy.stop(), await s.close())));
}, 60_000);
async function setup(o: Parameters<typeof startProxy>[1] & { https?: boolean } = {}) {
  const s = await startSim();
  const settings = o.https ? { camera: { host: `127.0.0.1:${s.ports.https}`, protocol: 'https', user: 'proxy', onvifPort: s.ports.onvif, rtspPort: s.ports.rtsp || 554, baichuanPort: s.camera.baichuanPort, statusPollS: 5 }, ...o.settings } : o.settings;
  const p = await startProxy(s, { ...o, ...(settings ? { settings } : {}) });
  open.push({ p, s });
  const put = (password: unknown, t = ADMIN_TOKEN) => request(p.base).put('/control/cameras/cam1/password').set(auth(t)).send({ password });
  const get = (path: string, t = ADMIN_TOKEN) => request(p.base).get(path).set(auth(t));
  const stored = () => (existsSync(cameraPasswordsFile(join(p.dir, 'data'))) ? JSON.parse(readFileSync(cameraPasswordsFile(join(p.dir, 'data')), 'utf8')).cameras : {});
  const online = () => until(async () => (await request(p.base).get('/api/cameras/cam1').set(auth())).body.online === true, 20_000);
  return { s, p, put, get, stored, online };
}
// The camera's password changes (the proxy's session goes with it).
const changePassword = (s: Sim, pw: string) => {
  s.sim.engine.sessions.modifyUser('proxy', { password: pw });
  s.sim.engine.sessions.revokeUser('proxy');
};

describe('saving a camera password', () => {
  it('saves a password the camera accepts, applies it without a restart, and audits no value', async () => {
    const { s, p, put, get, stored } = await setup();
    await until(async () => (await request(p.base).get('/api/cameras/cam1').set(auth())).body.online === true, 20_000);
    changePassword(s, 'n3w-Secret!');
    await until(async () => (await get('/control/cameras/cam1/status')).body.credentials?.authOk === false, 30_000);
    const r = await put('n3w-Secret!');
    expect([r.status, r.body.credentials?.source]).toEqual([200, 'store']);
    await until(async () => (await request(p.base).get('/api/cameras/cam1').set(auth())).body.online === true, 20_000);
    expect(stored().cam1.password).toBe('n3w-Secret!');
    expect(auditText(p.dir) + logText() + JSON.stringify(r.body)).not.toContain('n3w-Secret!');
    const rec = lastAudit(p.dir, 'camera-password')!;
    expect([rec.event.outcome, rec.labels.camera, rec.user.name, rec.cam_proxy.requestedBy]).toEqual(['success', 'cam1', 'admin', 'token']);
    // A refused one stores nothing; the saved one stays.
    const bad = await put('not-it');
    expect([bad.status, bad.body.error]).toEqual([422, 'camera_refused']);
    expect(stored().cam1.password).toBe('n3w-Secret!');
    expect(lastAudit(p.dir, 'camera-password')!.event.outcome).toBe('failure');
    // A client token may not; a value of the wrong shape is 400 and audited never.
    expect((await put('n3w-Secret!', 'client-token-'.padEnd(40, 'x'))).status).toBe(403);
    const n = audits(p.dir, 'camera-password').length;
    for (const v of ['', 'x'.repeat(65), 'a\nb', 42, undefined]) expect([(await put(v)).status, (await put(v)).body.error], String(v)).toEqual([400, 'invalid']);
    expect(audits(p.dir, 'camera-password')).toHaveLength(n);
  }, 90_000);

  it('a password the camera refuses is 422 camera_refused and stores nothing', async () => {
    const { put, stored } = await setup();
    const r = await put('wrong-one');
    expect([r.status, r.body.error]).toEqual([422, 'camera_refused']);
    expect(stored()).toEqual({});
  }, 30_000);

  it('the password appears in no answer, audit record or log line', async () => {
    const SENTINEL = 'S3ntinel-Pw!q';
    const { s, p, put, stored } = await setup();
    const bodies: unknown[] = [];
    const go = async (pw: string, status: number) => {
      const r = await put(pw);
      bodies.push(r.body, r.headers);
      expect(r.status, pw).toBe(status);
    };
    changePassword(s, SENTINEL);
    await go(SENTINEL, 200); // 1
    await go(`${SENTINEL}-wrong`, 422); // 2
    s.sim.engine.faults.set({ name: 'offline' });
    await go(SENTINEL, 503); // 3 offline
    s.sim.engine.faults.clear('offline');
    await go(`${SENTINEL}-x`, 422); // 4
    await go(`${SENTINEL}-y`, 422); // 5
    await go(`${SENTINEL}-z`, 429); // 6: refused before the camera
    expect(stored().cam1.password).toBe(SENTINEL);
    expect(auditText(p.dir) + logText() + JSON.stringify(bodies)).not.toContain(SENTINEL);
  }, 60_000);

  it('the 6th attempt is 429 and the camera sees no 6th login', async () => {
    const { s, put, p, online } = await setup();
    await online(); // the worker's own login first
    const before = s.sim.engine.counters.loginAttempts;
    for (let i = 0; i < 5; i++) expect((await put(`wrong-${i}`)).status).toBe(422);
    expect(s.sim.engine.counters.loginAttempts - before).toBe(5);
    const r = await put('wrong-6');
    expect([r.status, r.body.error]).toEqual([429, 'too_many_attempts']);
    expect(Number(r.headers['retry-after'])).toBeGreaterThan(500);
    expect(s.sim.engine.counters.loginAttempts - before).toBe(5);
    // One rate-limited record per address and window.
    await put('wrong-7');
    expect(audits(p.dir, 'camera-password').filter((x) => x.error?.message === 'too_many_attempts')).toHaveLength(1);
  }, 30_000);
});

describe('a password in the environment', () => {
  it("removes the camera's line from the managed env file and its backups", async () => {
    const envDir = mkdtempSync(join(tmpdir(), 'onb-env-'));
    const file = join(envDir, '.env');
    writeFileSync(join(envDir, '.env.bak-20261030-120000'), 'CAMPROXY_CAMERA_PASSWORD_CAM1=older\n', { mode: 0o600 });
    // The camera's own variable comes from that file (as compose's env_file does).
    writeFileSync(file, 'CAMPROXY_CAMERA_PASSWORD_CAM1=old\n', { mode: 0o600 });
    const { s, p, put, get } = await setup({ env: { CAMPROXY_ENV_FILE: file, CAMPROXY_CAMERA_PASSWORD_CAM1: 'old' } });
    expect((await get('/control/cameras/cam1/status')).body.credentials).toMatchObject({ source: 'env', envName: 'CAMPROXY_CAMERA_PASSWORD_CAM1' });
    const r = await put(s.password);
    expect([r.status, r.body.credentials?.source]).toEqual([200, 'store']);
    expect(readFileSync(file, 'utf8')).not.toContain('CAMPROXY_CAMERA_PASSWORD_CAM1');
    expect(readFileSync(join(envDir, '.env.bak-20261030-120000'), 'utf8')).not.toContain('CAMPROXY_CAMERA_PASSWORD_CAM1');
    expect(lastAudit(p.dir, 'camera-password')!.cam_proxy.envLine).toBe('removed');
    await until(async () => (await request(p.base).get('/api/cameras/cam1').set(auth())).body.online === true, 20_000);
  }, 40_000);

  it('an own variable the proxy cannot remove is 409 env_password', async () => {
    const SENTINEL = 'S3ntinel-Env!';
    const { p, put } = await setup({ env: { CAMPROXY_CAMERA_PASSWORD_CAM1: 'proxy-pw' } });
    const r = await put(SENTINEL);
    expect([r.status, r.body.error]).toEqual([409, 'env_password']);
    expect(r.body.detail).toContain('CAMPROXY_CAMERA_PASSWORD_CAM1');
    expect(existsSync(cameraPasswordsFile(join(p.dir, 'data')))).toBe(false);
    expect(auditText(p.dir) + logText() + JSON.stringify(r.body)).not.toContain(SENTINEL);
  }, 30_000);
});

describe('trust and rights', () => {
  it('https with trust none is 409 not_trusted (pin first)', async () => {
    const { s, put, stored, online } = await setup({ https: true });
    await online();
    const before = s.sim.engine.counters.loginAttempts;
    const r = await put(s.password);
    expect([r.status, r.body.error]).toEqual([409, 'not_trusted']);
    expect(stored()).toEqual({});
    expect(s.sim.engine.counters.loginAttempts).toBe(before);
  }, 30_000);

  it('a managed admin token may set it; a client token may not', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'onb-pw-managed-'));
    const managed = managedAdminToken(dir);
    const { s, p, put } = await setup({ dir });
    expect((await put(s.password, 'client-token-'.padEnd(40, 'x'))).status).toBe(403);
    const r = await put(s.password, managed);
    expect([r.status, r.body.credentials?.source]).toEqual([200, 'store']);
    expect(lastAudit(p.dir, 'camera-password')!.user.name).toBe('token:cams');
  }, 30_000);
});
