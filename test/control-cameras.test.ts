import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN_TOKEN, auth, startProxy, until } from './helpers/proxy';
import { startSim } from './helpers/sim';

let sim: Awaited<ReturnType<typeof startSim>>;
let p: Awaited<ReturnType<typeof startProxy>>;
const admin = () => auth(ADMIN_TOKEN);
beforeAll(async () => {
  sim = await startSim();
  p = await startProxy(sim);
  // A settled camera: the two answers compared below are taken at different moments.
  await until(() => p.proxy.status.state().online && p.proxy.intake.state().onvif === 'subscribed');
});
afterAll(async () => {
  await p.proxy.stop();
  await sim.close();
});

describe('control: cameras (spec §6.3)', () => {
  it('GET /control/cameras: one block per camera, the same as the top-level status', async () => {
    const list = (await request(p.base).get('/control/cameras').set(admin())).body;
    expect(list.map((b: { id: string }) => b.id)).toEqual(['cam1']);
    const st = (await request(p.base).get('/control/status').set(admin())).body;
    expect(st.cameras).toEqual(list);
    expect(list[0].camera.name).toBe(st.camera.name);
    expect((await request(p.base).get('/control/cameras/cam1/status').set(admin())).body.id).toBe('cam1');
    expect((await request(p.base).get('/control/cameras/cam9/status').set(admin())).status).toBe(404);
  });
  it('one camera: the old camera actions act on it', async () => {
    expect((await request(p.base).post('/control/actions/camera-test').set(admin())).status).toBe(200);
  });
});
