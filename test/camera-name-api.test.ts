import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { startSim } from './helpers/sim';
import { startProxy, auth, until, ADMIN_TOKEN, CLIENT_TOKEN } from './helpers/proxy';
import { renameSim, startDevNameShim, type DevNameShim } from './helpers/devname-shim';
import { sseConnect } from './helpers/sse';

// Camera name design: the camera stores the name; the proxy reads it with
// the routine poll, writes it through PUT /control/camera/name and tells
// clients with one `camera` stream message per change.

let sim: Awaited<ReturnType<typeof startSim>>;
let shim: DevNameShim;
let p: Awaited<ReturnType<typeof startProxy>>;
const admin = () => auth(ADMIN_TOKEN);
const cameraMessages = () => p.proxy.log.since(0, { types: ['camera'] }, 100).map((m) => ({ cam: m.cam, ...m.data }));
const auditOf = async (action: string) => (await request(p.base).get(`/control/audit?action=${action}&after=&limit=50`).set(admin())).text.split('\n').filter(Boolean).map((l) => JSON.parse(l));

beforeAll(async () => {
  sim = await startSim();
  renameSim(sim.sim, 'Den');
  shim = await startDevNameShim(sim.sim, sim.ports.http);
  // camera.name in config.json differs from the camera's: the camera wins once read.
  p = await startProxy({ ...sim, camera: { ...sim.camera, host: shim.host } }, { settings: { camera: { name: 'Configured Name', host: shim.host, protocol: 'http', user: 'proxy', onvifPort: sim.ports.onvif, rtspPort: sim.ports.rtsp || 554, baichuanPort: sim.camera.baichuanPort, statusPollS: 3600 } } });
  await until(() => p.proxy.status.state().name === 'Den');
}, 30_000);
afterAll(async () => {
  await p.proxy.stop();
  await shim.close();
  await sim.close();
});
beforeEach(() => {
  sim.sim.engine.faults.clear('offline');
});

describe('reading the name', () => {
  it("the client camera info, /control/status and /api/local/health report the camera's name", async () => {
    const list = await request(p.base).get('/api/cameras').set(auth(CLIENT_TOKEN));
    expect(list.body[0]).toMatchObject({ id: 'cam1', name: 'Den' });
    const one = await request(p.base).get('/api/cameras/cam1').set(auth(CLIENT_TOKEN));
    expect(one.status).toBe(200);
    expect(one.body).toEqual(list.body[0]);
    expect((await request(p.base).get('/api/cameras/nope').set(auth(CLIENT_TOKEN))).status).toBe(404);
    const st = await request(p.base).get('/control/status').set(admin());
    expect(st.body.camera).toMatchObject({ name: 'Den', nameSource: 'camera' });
    expect(st.body.health.camera.name).toBe('Den');
    expect((await request(p.base).get('/api/local/health')).body.camera.name).toBe('Den');
  });

  it('no stream message while the name stays the same (the configured fallback was never announced)', async () => {
    // The first read differs from the configured fallback: one message for that.
    expect(cameraMessages()).toEqual([{ cam: 'cam1', name: 'Den' }]);
    await p.proxy.status.checkNow();
    await p.proxy.status.checkNow();
    expect(cameraMessages()).toHaveLength(1);
  });

  it('a rename made elsewhere (the Reolink app) is picked up by the poll: one SSE message', async () => {
    const sse = sseConnect(`${p.base}/api/stream?types=camera`, auth(CLIENT_TOKEN));
    try {
      await until(() => sse.status() === 200);
      renameSim(sim.sim, 'Backyard Left');
      await p.proxy.status.checkNow();
      await p.proxy.status.checkNow();
      await sse.until(() => sse.events.length >= 1);
      await new Promise((r) => setTimeout(r, 100));
      expect(sse.events).toEqual([{ id: expect.any(Number), event: 'camera', data: { cam: 'cam1', name: 'Backyard Left' } }]);
      expect((await request(p.base).get('/api/cameras').set(auth(CLIENT_TOKEN))).body[0].name).toBe('Backyard Left');
    } finally {
      sse.close();
    }
  });

  it('the default stream (no types) includes camera messages, and a resume replays them', async () => {
    const sse = sseConnect(`${p.base}/api/stream?since=0`, auth(CLIENT_TOKEN));
    try {
      await sse.until(() => sse.events.filter((e) => e.event === 'camera').length >= 2);
      expect(sse.events.filter((e) => e.event === 'camera').map((e) => e.data)).toEqual([{ cam: 'cam1', name: 'Den' }, { cam: 'cam1', name: 'Backyard Left' }]);
    } finally {
      sse.close();
    }
  });
});

describe('PUT /control/camera/name', () => {
  it('validates, writes, re-reads, answers the name read back, audits and announces once', async () => {
    renameSim(sim.sim, 'Backyard Left');
    await p.proxy.status.checkNow();
    const before = cameraMessages().length;
    const sets = shim.setCalls.length;
    const r = await request(p.base).put('/control/camera/name').set(admin()).send({ name: 'Front Door (1)' });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ name: 'Front Door (1)' });
    expect(shim.setCalls.slice(sets)).toEqual([{ name: 'Front Door (1)' }]);
    expect(sim.sim.engine.config.name).toBe('Front Door (1)');
    // At once, without waiting for the next poll.
    expect((await request(p.base).get('/api/cameras').set(auth(CLIENT_TOKEN))).body[0].name).toBe('Front Door (1)');
    expect(cameraMessages().slice(before)).toEqual([{ cam: 'cam1', name: 'Front Door (1)' }]);
    await p.proxy.status.checkNow(); // the poll reads the same name: nothing more
    expect(cameraMessages().slice(before)).toHaveLength(1);
    const rec = (await auditOf('camera-name')).at(-1);
    expect(rec.event).toMatchObject({ action: 'camera-name', outcome: 'success' });
    expect(rec.user.name).toBe('admin');
    expect(rec.message).toBe('Camera name changed: "Backyard Left" → "Front Door (1)"');
    expect(rec.cam_proxy).toMatchObject({ from: 'Backyard Left', to: 'Front Door (1)', requestedBy: 'token' });
  });

  it('refuses a name against the rules with 400 invalid_name and a reason, without calling the camera', async () => {
    const sets = shim.setCalls.length;
    for (const [name, reason] of [['Back_yard', 'not allowed: _'], ['x'.repeat(32), 'too long: 32 characters, at most 31'], [' Den', 'no leading or trailing space'], ['', 'empty: 1 to 31 characters'], [7, 'empty: 1 to 31 characters']] as const) {
      const r = await request(p.base).put('/control/camera/name').set(admin()).send({ name });
      expect(r.status).toBe(400);
      expect(r.body).toEqual({ error: 'invalid_name', reason });
    }
    expect((await request(p.base).put('/control/camera/name').set(admin()).send([])).status).toBe(400);
    expect(shim.setCalls.length).toBe(sets);
  });

  it("a camera refusal is 400 invalid_name with the camera's reason, audited as a failure", async () => {
    shim.refuseNext = -54;
    const r = await request(p.base).put('/control/camera/name').set(admin()).send({ name: 'Garage' });
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: 'invalid_name', reason: 'not allowed by the camera (rspCode -54)' });
    expect(sim.sim.engine.config.name).toBe('Front Door (1)'); // a refused write leaves the old name
    const rec = (await auditOf('camera-name')).at(-1);
    expect(rec.event).toMatchObject({ action: 'camera-name', outcome: 'failure' });
    expect(rec.message).toContain('not allowed by the camera');
  });

  it('an offline camera is 503 camera_offline', async () => {
    sim.sim.engine.faults.set({ name: 'offline' });
    const r = await request(p.base).put('/control/camera/name').set(admin()).send({ name: 'Garage' });
    expect(r.status).toBe(503);
    expect(r.body).toEqual({ error: 'camera_offline' });
  });

  it('needs the admin token or an admin session with the CSRF header; a client token is refused', async () => {
    expect((await request(p.base).put('/control/camera/name').send({ name: 'Garage' })).status).toBe(401);
    expect((await request(p.base).put('/control/camera/name').set(auth(CLIENT_TOKEN)).send({ name: 'Garage' })).status).toBe(403);
    const login = await request(p.base).post('/control/login').send({ token: ADMIN_TOKEN });
    const cookie = String(login.headers['set-cookie']).split(';')[0];
    const noCsrf = await request(p.base).put('/control/camera/name').set('Cookie', cookie).send({ name: 'Garage' });
    expect(noCsrf.status).toBe(403);
    expect(noCsrf.body).toEqual({ error: 'csrf' });
    const ok = await request(p.base).put('/control/camera/name').set('Cookie', cookie).set('X-CamProxy-UI', '1').send({ name: 'Garage' });
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ name: 'Garage' });
    expect((await auditOf('camera-name')).at(-1).cam_proxy).toMatchObject({ from: 'Front Door (1)', to: 'Garage', requestedBy: 'session' });
  });
});
