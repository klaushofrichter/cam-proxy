import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { StreamsReader } from '../src/camera/streams';
import { servedCertificate } from '../src/tls/served';
import { otherCertificate } from './helpers/certs';
import { ADMIN_TOKEN, auth, startProxy, until } from './helpers/proxy';
import { startSim } from './helpers/sim';

// GET /api/cameras/:cam/status (spec 2026-10-30-camera-onboarding-design §4.8).
const AUDIT_TOKEN = 'audit-token-'.padEnd(40, 'z');
let s: Awaited<ReturnType<typeof startSim>>;
let p: Awaited<ReturnType<typeof startProxy>>;
beforeAll(async () => {
  s = await startSim();
  p = await startProxy(s, { env: { CAMPROXY_AUDIT_TOKEN: AUDIT_TOKEN } });
}, 30_000);
afterAll(async () => {
  await p?.proxy.stop();
  await s?.close();
});

const status = (base: string, t?: string) => request(base).get('/api/cameras/cam1/status').set(auth(t));

describe('camera status for clients', () => {
  it('answers the status of a camera with a client token', async () => {
    await until(async () => (await status(p.base)).body.sd !== null, 10_000);
    const r = await status(p.base).expect(200);
    expect(r.body).toMatchObject({ id: 'cam1', online: true, model: expect.any(String), firmware: expect.any(String), hardware: expect.any(String), simulator: expect.any(String) });
    expect(Object.keys(r.body).sort()).toEqual(['certificate', 'checkedAt', 'credentials', 'error', 'firmware', 'hardware', 'id', 'model', 'name', 'online', 'sd', 'simulator', 'since', 'streams', 'time', 'tls'].sort());
    expect(r.body.streams.sub).toEqual({ codec: 'h264', width: expect.any(Number), height: expect.any(Number), fps: expect.any(Number) });
    expect(r.body.sd).toMatchObject({ present: true, mounted: true });
    expect(r.body.time).toMatchObject({ stdOffsetMinutes: expect.any(Number), dstOffsetMinutes: expect.any(Number) });
    expect(r.body.credentials).toMatchObject({ source: expect.any(String), authOk: true });
    expect(r.body.tls).toMatchObject({ mode: expect.any(String), problem: expect.toBeOneOf([null, 'untrusted']) });
    // An http camera presents no certificate.
    expect(r.body.certificate).toBeNull();
    expect(JSON.stringify(r.body)).not.toContain(s.password);
  });

  it('answers the camera list with tls.served and tls.problem', async () => {
    const r = await request(p.base).get('/api/cameras').set(auth()).expect(200);
    expect(r.body[0].tls).toMatchObject({ served: null, problem: null });
  });

  it('answers 401 to the audit token and 404 to an unknown camera', async () => {
    expect((await status(p.base, AUDIT_TOKEN)).status).toBe(401);
    expect((await request(p.base).get('/api/cameras/cam1/status')).status).toBe(401);
    const r = await request(p.base).get('/api/cameras/nope/status').set(auth());
    expect([r.status, r.body.error]).toEqual([404, 'not_found']);
  });
});

describe.each(['RLC-1224A', 'E1-Outdoor-Pro'] as const)('a %s', (model) => {
  it('reports main as h265 (its GetEnc)', async () => {
    const m = await startSim({ model });
    const q = await startProxy(m);
    try {
      await until(async () => (await status(q.base)).body.online === true, 10_000);
      const r = await status(q.base).expect(200);
      expect(r.body.streams.main).toMatchObject({ codec: 'h265' });
      expect(r.body.streams.sub).toMatchObject({ codec: 'h264' });
    } finally {
      await q.proxy.stop();
      await m.close();
    }
  }, 30_000);
});

describe('StreamsReader', () => {
  it('asks GetEnc once per 10 minutes, again 30 s after a failure', async () => {
    let t = 0;
    let calls = 0;
    let fail = false;
    const enc = { Enc: { mainStream: { vType: 'h265', width: 3840, height: 2160, frameRate: 20 }, subStream: { vType: 'h264', width: 640, height: 360, frameRate: 10 } } };
    const r = new StreamsReader(async (cmd) => {
      expect(cmd).toBe('GetEnc');
      calls++;
      if (fail) throw new Error('nope');
      return enc as never;
    }, () => t);
    expect(await r.read()).toEqual({ main: { codec: 'h265', width: 3840, height: 2160, fps: 20 }, sub: { codec: 'h264', width: 640, height: 360, fps: 10 } });
    t = 599_999;
    await r.read();
    expect(calls).toBe(1);
    t = 600_000;
    fail = true;
    expect(await r.read()).toEqual({ main: null, sub: null });
    expect(calls).toBe(2);
    t = 629_999;
    await r.read();
    expect(calls).toBe(2);
    t = 630_000;
    fail = false;
    expect((await r.read()).main?.codec).toBe('h265');
    expect(calls).toBe(3);
  });
});

describe('a camera that is offline', () => {
  it('answers offline from the poller without waiting for the camera', async () => {
    const m = await startSim();
    const q = await startProxy(m);
    try {
      await until(async () => (await status(q.base)).body.online === true, 10_000);
      await m.close();
      const w = q.proxy.cameras.get('cam1')!;
      await w.status.checkNow();
      await w.status.checkNow();
      const t0 = Date.now();
      const r = await status(q.base).expect(200);
      expect(Date.now() - t0).toBeLessThan(1000);
      expect(r.body).toMatchObject({ online: false, error: expect.any(String), streams: { main: null, sub: null }, certificate: null });
    } finally {
      await q.proxy.stop();
    }
  }, 30_000);
});

describe('an https camera', () => {
  it('reports a pinned camera serving another certificate as tls.problem "changed"', async () => {
    const h = await startSim();
    const dir = mkdtempSync(join(tmpdir(), 'calls-tls-'));
    const q = await startProxy(h, { dir, settings: { camera: { host: `127.0.0.1:${h.ports.https}`, protocol: 'https', user: 'proxy', onvifPort: h.ports.onvif, rtspPort: h.ports.rtsp || 554, baichuanPort: h.camera.baichuanPort, statusPollS: 5 } } });
    try {
      // Unpinned: untrusted; its certificate is not verified, so not shown.
      await until(async () => (await status(q.base)).body.online === true, 10_000);
      const before = (await status(q.base)).body;
      expect(before.tls).toMatchObject({ mode: 'none', problem: 'untrusted' });
      expect(before.certificate).toBeNull();
      const fp = (await servedCertificate('127.0.0.1', h.ports.https))!.fingerprint;
      expect((await request(q.base).post('/control/cameras/cam1/actions/camera-trust-pin').set(auth(ADMIN_TOKEN)).send({ fingerprint: fp })).status).toBe(200);
      await until(async () => (await status(q.base)).body.tls.served === fp, 10_000);
      expect((await status(q.base)).body.tls).toMatchObject({ mode: 'pinned', fingerprint: fp, problem: null });
      // Pinned: the certificate it presents is verified and shown.
      await until(async () => (await status(q.base)).body.online === true, 10_000);
      expect((await status(q.base)).body.certificate).toMatchObject({ subject: expect.any(String), issuer: expect.any(String), validTo: expect.any(String) });
      const other = await otherCertificate('CERTIFICATE');
      h.sim.engine.clearCertificate();
      await until(() => !h.sim.engine.certRestarting, 10_000);
      expect(h.sim.engine.importCertificate(other.pem, other.key)).toBeNull();
      q.proxy.onboarding.forgetServed('cam1');
      await until(async () => (await status(q.base)).body.tls.problem === 'changed', 15_000);
      const r = (await status(q.base)).body;
      expect(r.tls.served).toBe(other.fingerprint);
      expect(r.tls.served).not.toBe(r.tls.fingerprint);
    } finally {
      await q.proxy.stop();
      await h.close();
    }
  }, 60_000);
});
