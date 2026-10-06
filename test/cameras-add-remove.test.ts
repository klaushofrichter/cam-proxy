import { readFileSync } from 'fs';
import { join } from 'path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN_TOKEN, auth, until } from './helpers/proxy';
import { startMultiProxy, startSims, type Sim } from './helpers/multi';

const go2rtc = process.env.CAMPROXY_TEST_GO2RTC;
let sims: Sim[];
let p: Awaited<ReturnType<typeof startMultiProxy>>;
const admin = () => auth(ADMIN_TOKEN);
beforeAll(async () => {
  sims = await startSims(2);
  p = await startMultiProxy([sims[0]]);
  await until(() => p.proxy.cameras.first().status.state().online, 20_000);
  if (go2rtc) await until(() => p.proxy.cameras.first().stills?.grabber.up() === true, 30_000);
}, 60_000);
afterAll(async () => {
  await p.proxy.stop();
  await Promise.all(sims.map((s) => s.close()));
});

describe('cameras added and removed through the control API (spec 2026-10-05-multi-camera-host-design §6.3)', () => {
  it('adding a camera never restarts go2rtc; its worker starts', async () => {
    const pid = p.proxy.go2rtcPid();
    const frames = p.proxy.cameras.first().stills?.grabber.lastFrameTs();
    const s = sims[1];
    const r = await request(p.base).put('/control/config').set(admin()).send({ cameras: { cam6: { host: s.camera.host, protocol: 'http', user: 'proxy', onvifPort: s.ports.onvif, rtspPort: s.ports.rtsp || 554, baichuanPort: s.camera.baichuanPort, statusPollS: 5 } } });
    expect(r.status).toBe(200);
    await until(async () => (await request(p.base).get('/api/cameras').set(auth())).body.some((c: { id: string; online: boolean }) => c.id === 'cam6' && c.online), 20_000);
    expect(JSON.parse(readFileSync(join(p.dir, 'data', 'overrides.json'), 'utf8')).cameras.cam6.host).toBe(s.camera.host);
    if (go2rtc) {
      expect(p.proxy.go2rtcPid()).toBe(pid);
      await until(() => p.proxy.cameras.get('cam6')!.stills?.grabber.up() === true, 30_000);
      // cam3's grabber kept running all along.
      expect(p.proxy.cameras.first().stills!.grabber.lastFrameTs()!).toBeGreaterThan(frames!);
      expect(p.proxy.cameras.first().stills!.grabber.up()).toBe(true);
    }
    const blocks = (await request(p.base).get('/control/cameras').set(admin())).body;
    expect(blocks.map((b: { id: string; source: string }) => [b.id, b.source])).toEqual([['cam3', 'config'], ['cam6', 'added']]);
  }, 90_000);

  it('an added camera can be removed; a config.json camera cannot', async () => {
    expect((await request(p.base).delete('/control/config/cameras.cam6').set(admin())).status).toBe(200);
    await until(async () => (await request(p.base).get('/api/cameras/cam6').set(auth())).status === 404, 10_000);
    if (go2rtc) await until(async () => !Object.keys(await p.proxy.cameras.first().stills!.go2rtc.streams()).some((k) => k.startsWith('cam6_')), 10_000);
    const r = await request(p.base).delete('/control/config/cameras.cam3').set(admin());
    expect([r.status, r.body.detail]).toEqual([400, 'cameras.cam3: defined in config.json; remove it there']);
  }, 30_000);
});
