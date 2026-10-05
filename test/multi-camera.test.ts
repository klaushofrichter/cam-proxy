import { basename } from 'path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN_TOKEN, auth, until } from './helpers/proxy';
import { startMultiProxy, startSims, type Sim } from './helpers/multi';
import { sseConnect } from './helpers/sse';

const go2rtc = process.env.CAMPROXY_TEST_GO2RTC;
const HOUR = 3600_000;
let sims: Sim[];
let p: Awaited<ReturnType<typeof startMultiProxy>>;
const admin = () => auth(ADMIN_TOKEN);

beforeAll(async () => {
  sims = await startSims(3);
  p = await startMultiProxy(sims);
  await until(() => p.proxy.cameras.list().every((w) => w.status.state().online && w.intake.state().onvif === 'subscribed'), 30_000);
}, 60_000);
afterAll(async () => {
  await p.proxy.stop();
  await Promise.all(sims.map((s) => s.close()));
});

describe('one proxy, three cameras (spec §15)', () => {
  it('lists the cameras in config order, each online with its own address', async () => {
    const r = await request(p.base).get('/api/cameras').set(auth());
    expect(r.body.map((c: { id: string; online: boolean; address: string; error: string | null }) => [c.id, c.online, c.address, c.error])).toEqual(sims.map((s, i) => [`cam${i + 3}`, true, s.camera.host, null]));
  });

  it('events arrive with the right cam on one stream; ?cam= narrows it', async () => {
    const all = sseConnect(`${p.base}/api/stream?types=camera-event&kinds=person`, auth());
    const two = sseConnect(`${p.base}/api/stream?types=camera-event&kinds=person&cam=cam3,cam5`, auth());
    await all.until(() => all.status() === 200);
    await two.until(() => two.status() === 200);
    await new Promise((r) => setTimeout(r, 300));
    sims[1].sim.engine.events.trigger('person', 1);
    sims[2].sim.engine.events.trigger('person', 1);
    await all.until(() => new Set(all.events.map((e) => (e.data as { cam: string }).cam)).size === 2, 10_000);
    await two.until(() => two.events.length > 0, 10_000);
    expect(new Set(all.events.map((e) => (e.data as { cam: string }).cam))).toEqual(new Set(['cam4', 'cam5']));
    expect(two.events.every((e) => (e.data as { cam: string }).cam === 'cam5')).toBe(true);
    expect((await request(p.base).get('/api/cameras/cam4/events').set(auth())).body[0]).toMatchObject({ kind: 'person' });
    expect((await request(p.base).get('/api/cameras/cam3/events').set(auth())).body).toEqual([]);
    all.close();
    two.close();
  });

  it.skipIf(!go2rtc)('stills from each camera', async () => {
    await until(() => p.proxy.cameras.list().every((w) => w.stills?.grabber.up() === true), 30_000);
    const now = Date.now();
    for (const id of ['cam3', 'cam4', 'cam5']) {
      await until(async () => (await request(p.base).get(`/api/cameras/${id}/stills?from=${now - 60_000}&to=${now + 60_000}`).set(auth())).body.length > 0, 15_000);
    }
  });

  it('a camera that goes away and comes back: the others keep producing (supervision)', async () => {
    sims[0].sim.engine.powerOff();
    await until(() => !p.proxy.cameras.get('cam3')!.status.state().online, 20_000);
    const s = sseConnect(`${p.base}/api/stream?types=camera-event&kinds=person&cam=cam4`, auth());
    await s.until(() => s.status() === 200);
    await new Promise((r) => setTimeout(r, 300));
    sims[1].sim.engine.events.trigger('person', 1);
    await s.until(() => s.events.length > 0, 10_000);
    void sims[0].sim.engine.powerOn(500);
    await until(() => p.proxy.cameras.get('cam3')!.status.state().online, 30_000);
    s.close();
  }, 60_000);

  it('recordings from two cameras in parallel', async () => {
    const pick = (s: Sim) => s.sim.engine.sd.all().find((r) => r.end !== null)!;
    const [a, b] = [pick(sims[0]), pick(sims[1])];
    const win = (date: string) => {
      const from = Date.parse(`${date}T00:00:00Z`) - 12 * HOUR;
      return `from=${from}&to=${from + 47 * HOUR}&stream=sub`;
    };
    // The list first (it maps the id to the camera's file).
    await request(p.base).get(`/api/cameras/cam3/recordings?${win(a.date)}`).set(auth()).expect(200);
    await request(p.base).get(`/api/cameras/cam4/recordings?${win(b.date)}`).set(auth()).expect(200);
    const [ra, rb] = await Promise.all([
      request(p.base).get(`/api/cameras/cam3/recordings/${basename(a.files.sub.name)}`).set(auth()),
      request(p.base).get(`/api/cameras/cam4/recordings/${basename(b.files.sub.name)}`).set(auth()),
    ]);
    expect([ra.status, rb.status]).toEqual([200, 200]);
    expect(sims[0].sim.engine.counters.baichuanDownloads).toBeGreaterThan(0);
    expect(sims[1].sim.engine.counters.baichuanDownloads).toBeGreaterThan(0);
  }, 60_000);

  it('the old camera actions answer camera_required; host actions work', async () => {
    // The camera's name is a camera action too (spec §6.3): never the first camera's by accident.
    const n = await request(p.base).put('/control/camera/name').set(admin()).send({ name: 'Renamed' });
    expect([n.status, n.body.error]).toEqual([400, 'camera_required']);
    expect(sims.map((s) => s.sim.engine.settings.name)).not.toContain('Renamed');
    const r = await request(p.base).post('/control/actions/camera-test').set(admin());
    expect([r.status, r.body.error]).toEqual([400, 'camera_required']);
    expect((await request(p.base).post('/control/actions/retention-run').set(admin()).send({ dryRun: true })).status).toBe(200);
  });

  // Ruling P1-16: the image bucket grows with the number of cameras; the other one does not.
  it('the image rate limit is 6000 per minute per camera', async () => {
    const img = await request(p.base).get('/api/cameras/cam3/stills/1000.jpg').set(auth());
    expect(img.headers['ratelimit-policy']).toMatch(/q=18000/);
    const other = await request(p.base).get('/api/cameras').set(auth());
    expect(other.headers['ratelimit-policy']).toMatch(/q=1200/);
  });

  it('health: one block per camera; the top level is the first camera', async () => {
    const h = (await request(p.base).get('/api/local/health')).body;
    expect(h.schema).toBe(1);
    expect(h.camera.id).toBe('cam3');
    expect(h.cameras.map((c: { camera: { id: string } }) => c.camera.id)).toEqual(['cam3', 'cam4', 'cam5']);
    expect(h.items.filter((i: { id: string }) => i.id === 'camera')).toHaveLength(1);
  });
});

describe('a camera without an address next to working ones (spec §3.3)', () => {
  it('stays idle with no_address; the process runs; the others work', async () => {
    const s2 = await startSims(1);
    const q = await startMultiProxy(s2, { extra: [{ id: 'cam9', host: '' }] });
    try {
      await until(() => q.proxy.cameras.get('cam3')!.status.state().online, 20_000);
      const list = (await request(q.base).get('/api/cameras').set(auth())).body;
      expect(list.map((c: { id: string; error: string | null }) => [c.id, c.error])).toEqual([['cam3', null], ['cam9', 'no_address']]);
      expect(q.proxy.cameras.get('cam9')!.phase()).toBe('idle');
    } finally {
      await q.proxy.stop();
      await s2[0].close();
    }
  }, 60_000);
});
