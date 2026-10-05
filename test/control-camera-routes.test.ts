import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN_TOKEN, auth, until } from './helpers/proxy';
import { startMultiProxy, startSims, type Sim } from './helpers/multi';

let sims: Sim[];
let p: Awaited<ReturnType<typeof startMultiProxy>>;
const admin = () => auth(ADMIN_TOKEN);
beforeAll(async () => {
  sims = await startSims(2);
  p = await startMultiProxy(sims);
  await until(() => p.proxy.cameras.list().every((w) => w.status.state().online), 20_000);
}, 40_000);
afterAll(async () => {
  await p.proxy.stop();
  await Promise.all(sims.map((s) => s.close()));
});

describe('control routes per camera (spec 2026-10-05-multi-camera-host-design §6.3)', () => {
  it('a camera action on its own route; the record names the camera', async () => {
    const r = await request(p.base).post('/control/cameras/cam4/actions/camera-test').set(admin());
    expect(r.status).toBe(200);
    // The record is written when the answer has gone out.
    await until(() => !!p.proxy.audit.find((x) => x.event.action === 'control-action', 50));
    expect(p.proxy.audit.find((x) => x.event.action === 'control-action', 50)?.labels).toEqual({ camera: 'cam4' });
  });
  it('renames one camera only', async () => {
    const r = await request(p.base).put('/control/cameras/cam3/name').set(admin()).send({ name: 'Driveway' });
    expect(r.body).toEqual({ name: 'Driveway' });
    expect(sims[0].sim.engine.settings.name).toBe('Driveway');
    expect((await request(p.base).get('/control/cameras/cam4/status').set(admin())).body.camera.name).not.toBe('Driveway');
  });
  it('the old routes need a camera here; host actions are not camera routes', async () => {
    expect((await request(p.base).put('/control/camera/name').set(admin()).send({ name: 'X' })).body.error).toBe('camera_required');
    expect((await request(p.base).post('/control/cameras/cam4/actions/retention-run').set(admin())).status).toBe(404);
    expect((await request(p.base).post('/control/cameras/cam9/actions/camera-test').set(admin())).status).toBe(404);
    expect((await request(p.base).post('/control/cameras/cam4/actions/camera-test').set(auth())).status).toBe(403);
  });
  it('inventory-cancel on a camera route cancels only that camera\'s run', async () => {
    const r = await request(p.base).post('/control/cameras/cam3/actions/inventory-cancel').set(admin());
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ cancelled: false, runId: null });
  });
});
