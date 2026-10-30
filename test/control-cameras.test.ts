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
  it("GET /control/status: the top-level camera parts are the first camera's block", async () => {
    const st = (await request(p.base).get('/control/status').set(admin())).body;
    const [b] = st.cameras;
    expect(st.camera).toEqual(b.camera);
    expect(st.intake).toEqual(b.intake);
    expect(Object.keys(st.stream)).toEqual(Object.keys(b.stream));
    expect(st.ftp).toEqual(b.ftp);
    expect(st.recordings).toEqual(b.recordings);
    expect(Object.keys(st)).toEqual(['version', 'camera', 'intake', 'sse', 'stream', 'retention', 'storage', 'ftp', 'recordings', 'analytics', 'analyticsUnmapped', 'health', 'archive', 'cameras', 'moveLeftovers']);
    const one = (await request(p.base).get('/control/cameras/cam1/status').set(admin())).body;
    expect(Object.keys(one)).toEqual(['id', 'camera', 'intake', 'stream', 'ftp', 'recordings', 'source', 'credentials']);
    expect(one.ftp).toEqual(b.ftp);
  });
  it('one camera: the old camera actions act on it', async () => {
    expect((await request(p.base).post('/control/actions/camera-test').set(admin())).status).toBe(200);
  });
});
