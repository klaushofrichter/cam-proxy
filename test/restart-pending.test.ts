// Live test of #173: with several cameras, pending restart settings must be
// applicable without a process restart — the host-wide restart applies all
// of them; a camera's restart applies that camera's own.
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN_TOKEN, auth, until } from './helpers/proxy';
import { startMultiProxy, startSims, type Sim } from './helpers/multi';

let sims: Sim[];
let p: Awaited<ReturnType<typeof startMultiProxy>>;
const admin = () => auth(ADMIN_TOKEN);
const view = async () => (await request(p.base).get('/control/config').set(admin())).body as Record<string, { value: unknown; pending: boolean; restartScope?: string }>;
beforeAll(async () => {
  sims = await startSims(2);
  p = await startMultiProxy(sims);
  await until(() => p.proxy.cameras.list().every((w) => w.status.state().online), 20_000);
}, 40_000);
afterAll(async () => {
  await p.proxy.stop();
  await Promise.all(sims.map((s) => s.close()));
});

describe('applying pending restart settings with several cameras', () => {
  it("a camera's restart applies that camera's pending settings only", async () => {
    expect((await request(p.base).put('/control/config').set(admin()).send({ cameras: { cam3: { statusPollS: 9 }, cam4: { statusPollS: 7 } } })).status).toBe(200);
    const v = await view();
    expect([v['cameras.cam4.statusPollS'].pending, v['cameras.cam4.statusPollS'].restartScope]).toEqual([true, 'camera']);
    expect((await request(p.base).post('/control/cameras/cam4/actions/restart').set(admin())).status).toBe(202);
    await until(async () => (await view())['cameras.cam4.statusPollS'].pending === false, 15_000);
    expect(p.proxy.running.cameras.cam4.statusPollS).toBe(7);
    expect((await view())['cameras.cam3.statusPollS'].pending).toBe(true);
  });

  it('the host-wide restart (no camera) applies every pending setting, host-wide and per camera', async () => {
    expect((await request(p.base).put('/control/config').set(admin()).send({ cameras: { cam3: { storage: { sharePercent: 30 } } }, events: { onvif: { subscribeMin: 2 } } })).status).toBe(200);
    expect((await view())['events.onvif.subscribeMin'].restartScope).toBe('host');
    expect((await request(p.base).post('/control/actions/restart').set(admin())).status).toBe(202);
    await until(async () => Object.values(await view()).every((s) => !s.pending), 20_000);
    expect(p.proxy.running.cameras.cam3.storage.sharePercent).toBe(30);
    expect(p.proxy.running.cameras.cam3.statusPollS).toBe(9);
    expect(p.proxy.running.events.onvif.subscribeMin).toBe(2);
  }, 30_000);
});
