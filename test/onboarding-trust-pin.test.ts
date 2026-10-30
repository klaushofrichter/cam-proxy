import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NEVER_REMOTE_ACTIONS } from '../src/fleet/policy';
import { servedCertificate } from '../src/tls/served';
import { otherCertificate } from './helpers/certs';
import { audits, managedAdminToken } from './helpers/onboarding';
import { ADMIN_TOKEN, auth, startProxy, until } from './helpers/proxy';
import { startSim } from './helpers/sim';

// POST /control/cameras/:cam/actions/camera-trust-pin on a proxy without tls.site
// (spec 2026-10-30-camera-onboarding-design §4.4).
let s: Awaited<ReturnType<typeof startSim>>;
let p: Awaited<ReturnType<typeof startProxy>>;
let managed: string;
beforeAll(async () => {
  s = await startSim();
  const dir = mkdtempSync(join(tmpdir(), 'onb-pin-'));
  managed = managedAdminToken(dir);
  p = await startProxy(s, { dir, settings: { camera: { host: `127.0.0.1:${s.ports.https}`, protocol: 'https', user: 'proxy', onvifPort: s.ports.onvif, rtspPort: s.ports.rtsp || 554, baichuanPort: s.camera.baichuanPort, statusPollS: 5 } } });
}, 30_000);
afterAll(async () => {
  await p?.proxy.stop();
  await s?.close();
});
const pin = (fingerprint: unknown, t = ADMIN_TOKEN) => request(p.base).post('/control/cameras/cam1/actions/camera-trust-pin').set(auth(t)).send({ fingerprint });
const client = async () => (await request(p.base).get('/api/cameras/cam1').set(auth())).body;
const served = async () => (await servedCertificate('127.0.0.1', s.ports.https))!.fingerprint;

describe('pinning a camera certificate without a site CA', () => {
  it('a fingerprint other than the served one is 409 and pins nothing', async () => {
    expect(p.proxy.certs).toBeUndefined();
    const other = await otherCertificate();
    const r = await pin(other.fingerprint);
    expect([r.status, r.body.error, r.body.served]).toEqual([409, 'fingerprint_mismatch', await served()]);
    expect((await client()).tls.mode).toBe('none');
    expect((await pin('SHA256:abc')).status).toBe(400);
    expect(audits(p.dir, 'camera-trust').at(-1)).toMatchObject({ event: { outcome: 'failure' }, error: { message: 'fingerprint_mismatch' }, cam_proxy: { op: 'pin' } });
  });

  it('pins the served certificate; the client view reports mode pinned', async () => {
    const fp = await served();
    const r = await pin(fp);
    expect([r.status, r.body.mode, r.body.fingerprint]).toEqual([200, 'pinned', fp]);
    expect((await client()).tls).toMatchObject({ mode: 'pinned', fingerprint: fp });
    expect(audits(p.dir, 'camera-trust').at(-1)).toMatchObject({ event: { outcome: 'success' }, cam_proxy: { op: 'pin', from: 'none', fingerprint: fp } });
    expect(audits(p.dir, 'control-action').filter((x) => x.cam_proxy?.action === 'camera-trust-pin')).toHaveLength(0);
    await until(async () => (await client()).online === true, 10_000);
  });

  it('a pinned camera serving a new certificate goes offline and shows trust not ok', async () => {
    const other = await otherCertificate('CERTIFICATE');
    s.sim.engine.clearCertificate();
    await until(() => !s.sim.engine.certRestarting, 10_000);
    expect(s.sim.engine.importCertificate(other.pem, other.key)).toBeNull();
    await until(async () => (await served()) === other.fingerprint, 10_000);
    await until(async () => (await client()).online === false, 20_000);
    expect((await client()).tls.fingerprint).not.toBe(other.fingerprint);
    // Pinned again to what it serves now: back online.
    expect((await pin(other.fingerprint)).status).toBe(200);
    await until(async () => (await client()).online === true, 20_000);
  }, 60_000);

  it('a managed admin token may pin; cams-admin can never (not a remote action)', async () => {
    const r = await pin(await served(), managed);
    expect([r.status, r.body.mode]).toEqual([200, 'pinned']);
    expect(audits(p.dir, 'camera-trust').at(-1)!.user.name).toBe('token:cams');
    expect(NEVER_REMOTE_ACTIONS).toContain('camera-trust-pin');
    expect((await request(p.base).post('/control/actions/camera-trust-clear').set(auth(managed)).send({ confirm: 'clear' })).status).toBe(403);
  });

  it('an http camera is 409 not_available', async () => {
    const h = await startSim();
    const q = await startProxy(h);
    try {
      const r = await request(q.base).post('/control/cameras/cam1/actions/camera-trust-pin').set(auth(ADMIN_TOKEN)).send({ fingerprint: `SHA256:${'A'.repeat(64)}` });
      expect([r.status, r.body.error]).toEqual([409, 'not_available']);
    } finally {
      await q.proxy.stop();
      await h.close();
    }
  }, 30_000);
});
