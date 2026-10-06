import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ReolinkClient } from '../src/camera/client';
import { ensureNtp } from '../src/cameras/ntp';
import { startSim } from './helpers/sim';
import request from 'supertest';
import { ADMIN_TOKEN, auth, startProxy, until } from './helpers/proxy';

let sim: Awaited<ReturnType<typeof startSim>>;
let client: ReolinkClient;
beforeAll(async () => {
  sim = await startSim();
  client = new ReolinkClient({ id: 'cam3', host: sim.camera.host, protocol: 'http', user: 'proxy', password: sim.password });
});
afterAll(async () => {
  await sim.close();
});

describe("the cameras' NTP server (spec §14.2)", () => {
  it('sets the whole object once; then already', async () => {
    const r = await ensureNtp(client, '192.168.60.1');
    expect(r.outcome).toBe('set');
    expect((r.after as { server: string; enable: number })).toMatchObject({ server: '192.168.60.1', enable: 1 });
    expect(Object.keys(r.after as object).sort()).toEqual(Object.keys(r.before as object).sort()); // whole object, nothing dropped
    expect((await ensureNtp(client, '192.168.60.1')).outcome).toBe('already');
    expect(sim.sim.engine.counters.setCalls.filter((c: string) => c === 'SetNtp')).toHaveLength(1);
  });

  it('the proxy sets it when the camera comes online, audited; the action answers the outcome; once an hour at most', async () => {
    const s2 = await startSim();
    const q = await startProxy(s2, { settings: { ntp: { server: '192.168.60.1' } } });
    try {
      await until(() => s2.sim.engine.counters.setCalls.includes('SetNtp'), 20_000);
      expect(s2.sim.engine.settings.get('Ntp')).toMatchObject({ server: '192.168.60.1', enable: 1 });
      await until(async () => (await request(q.base).get('/control/audit?action=camera-ntp').set(auth(ADMIN_TOKEN))).text.includes('Camera NTP server set (192.168.60.1)'), 10_000);
      const r = await request(q.base).post('/control/cameras/cam1/actions/camera-ntp-set').set(auth(ADMIN_TOKEN));
      expect([r.status, r.body]).toEqual([200, { outcome: 'already' }]);
      // A camera that comes back online within the hour: no second SetNtp.
      s2.sim.engine.settings.running.Ntp = { ...s2.sim.engine.settings.get('Ntp'), server: 'pool.ntp.org' };
      q.proxy.cameras.get('cam1')!.status.emit('change', { ...q.proxy.cameras.get('cam1')!.status.state(), online: true });
      await new Promise((res) => setTimeout(res, 300));
      expect(s2.sim.engine.counters.setCalls.filter((c: string) => c === 'SetNtp')).toHaveLength(1);
    } finally {
      await q.proxy.stop();
      await s2.close();
    }
  }, 60_000);

  it('without ntp.server (the Pi): the camera NTP is left alone', async () => {
    const s2 = await startSim();
    const q = await startProxy(s2);
    try {
      await until(() => q.proxy.cameras.get('cam1')!.status.state().online, 20_000);
      await new Promise((res) => setTimeout(res, 300));
      expect(s2.sim.engine.counters.setCalls).not.toContain('SetNtp');
      const r = await request(q.base).post('/control/cameras/cam1/actions/camera-ntp-set').set(auth(ADMIN_TOKEN));
      expect([r.status, r.body.error]).toEqual([409, 'not_configured']);
    } finally {
      await q.proxy.stop();
      await s2.close();
    }
  }, 60_000);
});
