import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { basename, join } from 'path';
import { saveAnalysis } from '../src/catalog/analyses';
import { insertEvent } from '../src/catalog/events';
import { reapCount } from '../src/stills/orphans';
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

  it.skipIf(!go2rtc)('the latest still of each camera from memory (spec §6.4)', async () => {
    await until(() => p.proxy.cameras.list().every((w) => w.latestFrame() !== undefined), 30_000);
    const r = await request(p.base).get('/api/cameras/cam4/stills/latest.jpg').set(auth());
    expect([r.status, r.headers['content-type']]).toEqual([200, 'image/jpeg']);
    expect(r.headers.etag).toBe(`"cam4-${r.headers['x-still-ts']}"`);
    expect((await request(p.base).get('/api/cameras/cam4/stills/latest.jpg').set(auth()).set('If-None-Match', r.headers.etag)).status).toBeOneOf([200, 304]);
    expect((await request(p.base).get('/api/cameras/cam3/previews/latest.jpg').set(auth())).status).toBe(200);
    const all = (await request(p.base).get('/api/stills/latest').set(auth())).body;
    expect(all.map((x: { cam: string; up: boolean }) => [x.cam, x.up])).toEqual([['cam3', true], ['cam4', true], ['cam5', true]]);
    const cams = (await request(p.base).get('/api/cameras').set(auth())).body;
    expect(cams[1].latestStill).toEqual({ ts: expect.any(Number), url: '/api/cameras/cam4/stills/latest.jpg', tileUrl: '/api/cameras/cam4/previews/latest.jpg' });
  });

  it('a camera without a still yet: latest.jpg is 404 no_still, not a stored still lookup', async () => {
    const r = await request(p.base).get('/api/cameras/cam9/stills/latest.jpg').set(auth());
    expect(r.status).toBe(404);
    if (!go2rtc) {
      const own = await request(p.base).get('/api/cameras/cam3/stills/latest.jpg').set(auth());
      expect([own.status, own.body]).toEqual([404, { error: 'no_still', ts: null }]);
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

  // Review: a refusal names no camera, points to what exists today, and is audited (also for actions with their own records).
  it('camera_required: audited without a camera, and the detail points to what exists', async () => {
    for (const name of ['camera-test', 'camera-reboot']) {
      const r = await request(p.base).post(`/control/actions/${name}`).set(admin()).send({});
      expect([r.status, r.body.error]).toEqual([400, 'camera_required']);
      expect(r.body.detail).not.toMatch(/\/control\/cameras\/:cam/);
      await until(() => !!p.proxy.audit.find((x) => x.event.action === 'control-action' && (x.cam_proxy as { action?: string } | undefined)?.action === name));
      const rec = p.proxy.audit.find((x) => x.event.action === 'control-action' && (x.cam_proxy as { action?: string } | undefined)?.action === name)!;
      expect(rec.cam_proxy).toMatchObject({ result: 'camera_required' });
      expect(rec.labels).toBeUndefined();
    }
    const inv = await request(p.base).post('/control/actions/inventory').set(admin()).send({ kind: 'stills' });
    expect(inv.body.detail).not.toMatch(/\/control\/cameras\/:cam/);
    const n = await request(p.base).put('/control/camera/name').set(admin()).send({ name: 'X' });
    expect(n.body.detail).not.toMatch(/\/control\/cameras\/:cam/);
  });

  // Live test 2026-10-05: camera actions name their camera — /control/cameras/:cam/actions/:name (spec §6.3) or ?cam= on the old route.
  it('camera actions on a named camera: the route, ?cam=, the name; unknown camera 404', async () => {
    const t = await request(p.base).post('/control/cameras/cam4/actions/camera-test').set(admin());
    expect(t.status).toBe(200);
    expect(t.body.online).toBe(true);
    const inv = await request(p.base).post('/control/actions/inventory?cam=cam5').set(admin()).send({ kind: 'stills' });
    expect(inv.status).toBe(202);
    const report = await (async () => {
      for (;;) {
        const r = await request(p.base).get(`/control/inventory/runs/${inv.body.runId}`).set(admin());
        if (r.body.outcome && r.body.outcome !== 'running') return r.body;
        await new Promise((x) => setTimeout(x, 100));
      }
    })();
    expect(report.camera).toBe('cam5');
    const reboot = await request(p.base).post('/control/cameras/cam9/actions/camera-reboot').set(admin());
    expect(reboot.status).toBe(404);
    expect((await request(p.base).post('/control/actions/camera-test?cam=cam9').set(admin())).status).toBe(404);
    // Host actions have no camera route.
    expect((await request(p.base).post('/control/cameras/cam4/actions/retention-run').set(admin()).send({ dryRun: true })).status).toBe(404);
    // The refusal names the route that works.
    expect((await request(p.base).post('/control/actions/camera-test').set(admin())).body.detail).toMatch(/\/control\/cameras\/<id>\/actions\/camera-test/);
    const name = await request(p.base).put('/control/cameras/cam4/name').set(admin()).send({ name: 'Gate B' });
    expect([name.status, name.body.name]).toEqual([200, 'Gate B']);
    expect(sims[1].sim.engine.settings.name).toBe('Gate B');
    const rec = p.proxy.audit.find((x) => x.event.action === 'camera-name')!;
    expect(rec.labels).toEqual({ camera: 'cam4' });
  }, 60_000);

  // Review: a camera's restart restarts that camera only, audited with it.
  it('restart on a named camera restarts that camera only', async () => {
    const [s3, s4] = [p.proxy.cameras.get('cam3')!.status, p.proxy.cameras.get('cam4')!.status];
    const r = await request(p.base).post('/control/cameras/cam4/actions/restart').set(admin());
    expect(r.status).toBe(202);
    await until(() => p.proxy.cameras.get('cam4')!.status !== s4 && p.proxy.cameras.get('cam4')!.phase() === 'ready', 20_000);
    expect(p.proxy.cameras.get('cam3')!.status).toBe(s3);
    await until(() => !!p.proxy.audit.find((x) => x.event.action === 'control-action' && (x.cam_proxy as { action?: string }).action === 'restart'));
    expect(p.proxy.audit.find((x) => x.event.action === 'control-action' && (x.cam_proxy as { action?: string }).action === 'restart')!.labels).toEqual({ camera: 'cam4' });
    await until(() => p.proxy.cameras.get('cam4')!.status.state().online && p.proxy.cameras.get('cam4')!.intake.state().onvif === 'subscribed', 30_000);
  }, 60_000);

  // Review: inventory-cancel and -repair on a named camera act only on that camera's run.
  it("inventory cancel and repair refuse another camera's run", async () => {
    let release!: () => void;
    p.proxy.inventory.checks.slow = { label: 'Slow', run: () => new Promise((r) => (release = () => r({ window: { from: null, to: 0, reason: 'test' }, counts: {}, top: [], items: [], message: 'slow' }))) };
    try {
      const st = await request(p.base).post('/control/cameras/cam5/actions/inventory').set(admin()).send({ kind: 'slow' });
      expect(st.status).toBe(202);
      const other = await request(p.base).post('/control/cameras/cam4/actions/inventory-cancel').set(admin());
      expect([other.status, other.body.error]).toEqual([409, 'camera_mismatch']);
      const mine = await request(p.base).post('/control/cameras/cam5/actions/inventory-cancel').set(admin());
      expect(mine.body).toMatchObject({ cancelled: true, runId: st.body.runId });
    } finally {
      release?.();
      delete p.proxy.inventory.checks.slow;
    }
    await until(() => p.proxy.inventory.running() === null);
    const ev = await request(p.base).post('/control/cameras/cam5/actions/inventory').set(admin()).send({ kind: 'events' });
    expect(ev.status).toBe(202);
    await until(async () => ((await request(p.base).get(`/control/inventory/runs/${ev.body.runId}`).set(admin())).body.outcome ?? 'running') !== 'running', 30_000);
    const rep = await request(p.base).post('/control/cameras/cam4/actions/inventory-repair').set(admin()).send({ kind: 'events', runId: ev.body.runId });
    expect([rep.status, rep.body.error]).toEqual([409, 'camera_mismatch']);
  }, 60_000);

  // Review (the Pi): go2rtc orphans are reaped only at the process start, never on a restart.
  it('restarts never reap go2rtc', async () => {
    const n = reapCount();
    await request(p.base).post('/control/cameras/cam5/actions/restart').set(admin()).expect(202);
    await until(() => p.proxy.cameras.get('cam5')!.phase() === 'ready');
    await p.proxy.restart();
    expect(reapCount()).toBe(n);
    await until(() => p.proxy.cameras.list().every((w) => w.status.state().online), 30_000);
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

  // Review: an event's analysis is served only under its own camera.
  it("an event's analysis and its image only under the event's camera", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'camproxy-an-'));
    const img = join(dir, 'a.jpg');
    writeFileSync(img, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    const e = insertEvent(p.proxy.catalog, { cam: 'cam3', source: 'onvif', kind: 'person', start_ts: 1000, raw: null });
    saveAnalysis(p.proxy.catalog, { event_id: e.id, provider: 'google-vision', status: 'ok', reason: null, still_ts: 1000, image: img, requested_at: 2000, took_ms: 3, objects: '[]', raw: '{}', summary: '[]' });
    expect((await request(p.base).get(`/api/cameras/cam3/events/${e.id}/analysis`).set(auth())).status).toBe(200);
    expect((await request(p.base).get(`/api/cameras/cam3/events/${e.id}/analysis.jpg`).set(auth())).status).toBe(200);
    expect((await request(p.base).get(`/api/cameras/cam4/events/${e.id}/analysis`).set(auth())).status).toBe(404);
    expect((await request(p.base).get(`/api/cameras/cam4/events/${e.id}/analysis.jpg`).set(auth())).status).toBe(404);
  });

  // Live test 2026-10-05: the Status page's Events card counted every camera's events.
  it('stats: events stored per camera, summing to the host totals', async () => {
    const st = (await request(p.base).get('/control/stats').set(admin())).body;
    const by = st.events.byCamera as Record<string, Record<string, number>>;
    expect(by.cam4.person).toBeGreaterThan(0);
    const sum: Record<string, number> = {};
    for (const kinds of Object.values(by)) for (const [k, n] of Object.entries(kinds)) sum[k] = (sum[k] ?? 0) + n;
    expect(sum).toEqual(st.events.stored);
  });

  it('stats: storage per camera (spec §8.1)', async () => {
    p.proxy.storage.noteWritten('stills', 1234, 1, { cam: 'cam4' });
    const st = (await request(p.base).get('/control/stats').set(admin())).body;
    expect(st.cameras.cam4.stills.bytes).toBeGreaterThanOrEqual(1234);
    expect(Object.keys(st.cameras.cam4).sort()).toEqual(['clips', 'previews', 'recordings', 'stills']);
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
