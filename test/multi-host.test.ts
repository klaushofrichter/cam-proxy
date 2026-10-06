// One host, four cameras (spec 2026-10-05-multi-camera-host-design §15): the
// host-wide services serve every camera — one FTP server, one switch
// controller with its queue, one go2rtc and the latest stills.
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listClips } from '../src/catalog/clips';
import { ADMIN_TOKEN, auth, freePort, until } from './helpers/proxy';
import { startMultiProxy, startSims, type Sim } from './helpers/multi';
import { startPoeSwitchMock, type PoeSwitchMock } from './helpers/poe-switch-mock';

const FTP_PW = 'ftp-secret-'.padEnd(24, 'z');
let sims: Sim[];
let sw: PoeSwitchMock;
let p: Awaited<ReturnType<typeof startMultiProxy>>;
const admin = () => auth(ADMIN_TOKEN);

beforeAll(async () => {
  sims = await startSims(4);
  // Ports 1..4 of a GPS-208 power cam3..cam6 (it counts its ports backwards: port 1 is index 7).
  sw = await startPoeSwitchMock({ password: 'sw-pw', powered: { 7: 4.5, 6: 4.5, 5: 4.5, 4: 4.5 } });
  const passive = await freePort();
  p = await startMultiProxy(sims, {
    settings: {
      ftp: { enabled: true, port: await freePort(), passive: `${passive}-${passive + 39}`, publicHost: '127.0.0.1', tls: true, stream: 'sub' },
      poeSwitch: { model: 'sscpoe-web', host: sw.host, ports: 8, offSeconds: 5 },
    },
    env: { CAMPROXY_FTP_PASSWORD: FTP_PW, CAMPROXY_POE_SWITCH_PASSWORD: 'sw-pw' },
  });
  // The camera nodes of startMultiProxy have no switch ports: add them as overrides.
  const r = await request(p.base).put('/control/config').set(admin()).send({ cameras: Object.fromEntries(['cam3', 'cam4', 'cam5', 'cam6'].map((id, i) => [id, { poeSwitch: { port: i + 1 } }])) });
  expect(r.status).toBe(200);
  for (const s of sims) s.sim.engine.settings.running.Rec.postRec = '1 Seconds';
  await until(() => p.proxy.cameras.list().every((w) => w.status.state().online), 30_000);
}, 90_000);
afterAll(async () => {
  await p.proxy.stop();
  await sw.close();
  await Promise.all(sims.map((s) => s.close()));
});

describe('one host, four cameras (spec §15)', () => {
  it('FTP uploads from two cameras at once land under the right ids', async () => {
    for (const id of ['cam3', 'cam4']) expect((await request(p.base).post(`/control/cameras/${id}/actions/camera-ftp-setup`).set(admin())).status).toBe(200);
    expect(sims[1].sim.engine.settings.running.Ftp.userName).toBe('cam4');
    const t0 = Date.now();
    sims[0].sim.engine.events.trigger('motion', 1);
    sims[1].sim.engine.events.trigger('motion', 1);
    await until(() => ['cam3', 'cam4'].every((cam) => listClips(p.proxy.catalog, cam, t0 - 60_000, Date.now() + 60_000).length > 0), 40_000);
    expect(listClips(p.proxy.catalog, 'cam5', t0 - 60_000, Date.now() + 60_000)).toEqual([]);
  }, 60_000);

  it('two power-cycles at once: the second waits for the first', async () => {
    const [a, b] = await Promise.all([
      request(p.base).post('/control/cameras/cam5/actions/camera-powercycle').set(admin()),
      request(p.base).post('/control/cameras/cam6/actions/camera-powercycle').set(admin()),
    ]);
    expect([a.status, b.status]).toEqual([202, 202]);
    expect(Math.abs(a.body.offAt - b.body.offAt)).toBeGreaterThanOrEqual(5000); // one after the other
    expect(sw.activeSession()).toBe(false);
  }, 60_000);

  it('GET /api/stills/latest lists every camera', async () => {
    const r = await request(p.base).get('/api/stills/latest').set(auth());
    expect(r.body.map((x: { cam: string }) => x.cam)).toEqual(['cam3', 'cam4', 'cam5', 'cam6']);
  });
});
