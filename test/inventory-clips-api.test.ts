import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { ADMIN_TOKEN, auth, startProxy, until } from './helpers/proxy';
import { startSim } from './helpers/sim';

// The clips inventory and its repair (#74) against cam-sim's SD card and its
// Baichuan server: the proxy compares on ftp.stream (sub here).
let sim: Awaited<ReturnType<typeof startSim>>;
let p: Awaited<ReturnType<typeof startProxy>>;
beforeAll(async () => {
  sim = await startSim();
  // Yesterday (camera-local): two recordings with triggers and one on the timer.
  const sd = sim.sim.engine.sd;
  sd.clear();
  sd.seed([
    { daysAgo: 1, start: '070000', end: '070030', triggers: ['motion'] },
    { daysAgo: 1, start: '071000', end: '071030', triggers: ['person'] },
    { daysAgo: 1, start: '072000', end: '072030', triggers: [] },
  ]);
  p = await startProxy(sim, { settings: { ftp: { stream: 'sub' } } });
  await until(() => p.proxy.status.state().online, 15_000);
}, 30_000);
afterAll(async () => {
  await p.proxy.stop();
  await sim.close();
});
const admin = () => auth(ADMIN_TOKEN);
const lines = (text: string) => text.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
const report = async (id: string) => (await request(p.base).get(`/control/inventory/runs/${id}`).set(admin())).body;
async function run(path: string, body: object) {
  const r = await request(p.base).post(`/control/actions/${path}`).set(admin()).send(body);
  expect(r.status).toBe(202);
  await until(async () => (await report(r.body.runId)).outcome !== 'running', 20_000);
  return report(r.body.runId);
}

describe('clips inventory API', () => {
  it('checks the local clips without contacting the camera', async () => {
    const searches = sim.sim.engine.counters.searches;
    const rep = await run('inventory', { kind: 'clips' });
    expect(rep).toMatchObject({ kind: 'clips', op: 'check', outcome: 'ok', counts: { clips: 0, rowsWithoutFile: 0 } });
    expect(rep).not.toHaveProperty('options');
    expect(rep.counts).not.toHaveProperty('missingLocally');
    expect(sim.sim.engine.counters.searches).toBe(searches);
  });

  it('refuses a camera option it cannot use', async () => {
    const bad = async (body: object, detail: string) => {
      const r = await request(p.base).post('/control/actions/inventory').set(admin()).send(body);
      expect(r.status).toBe(400);
      expect(r.body).toEqual({ error: 'invalid', detail });
    };
    await bad({ kind: 'clips', camera: 'yes' }, 'camera is true or false');
    await bad({ kind: 'stills', camera: true }, 'the stills inventory has no camera compare');
  });

  it('compares with the camera, repairs the missing clips over Baichuan, and then finds none missing', async () => {
    const cmp = await run('inventory', { kind: 'clips', camera: true });
    expect(cmp).toMatchObject({ outcome: 'ok', options: { camera: true }, counts: { recordings: 2, timerOnly: 1, missingLocally: 2, paired: 0, unknownDays: 0 }, window: { camera: { stream: 'sub' } } });
    expect(cmp.items.filter((x: { type: string }) => x.type === 'missing-locally')).toHaveLength(2);
    const downloads = sim.sim.engine.counters.baichuanDownloads;
    const rep = await run('inventory-repair', { kind: 'clips', runId: cmp.runId });
    expect(rep).toMatchObject({ kind: 'clips', op: 'repair', outcome: 'ok', source: cmp.runId, stopped: null, counts: { requested: 2, done: 2, failed: 0, skipped: 0 } });
    expect(rep.runId).toMatch(/^clipsrepair-/);
    expect(sim.sim.engine.counters.baichuanDownloads).toBe(downloads + 2);
    // The clips page shows them as from the camera.
    const yesterday = Math.min(...rep.items.map((x: { start: number }) => x.start));
    const clips = await request(p.base).get(`/api/cameras/cam1/clips?from=${yesterday - 60_000}&to=${yesterday + 86_400_000}`).set(auth());
    expect(clips.body.map((c: { origin: string; stream: string }) => [c.origin, c.stream])).toEqual([['camera', 'sub'], ['camera', 'sub']]);
    // One inventory-repair record, no control-action for the start.
    const recs = lines((await request(p.base).get('/control/audit?action=inventory-repair,control-action').set(admin())).text);
    expect(recs.filter((x) => x.event.action === 'inventory-repair')).toEqual([
      expect.objectContaining({ event: expect.objectContaining({ action: 'inventory-repair', outcome: 'success' }), cam_proxy: expect.objectContaining({ runId: rep.runId, source: cmp.runId, counts: expect.objectContaining({ done: 2 }) }) }),
    ]);
    expect(recs.some((x) => x.cam_proxy?.action === 'inventory-repair')).toBe(false);
    const list = (await request(p.base).get('/control/inventory').set(admin())).body;
    expect(list.repairs.clips[0]).toMatchObject({ runId: rep.runId, outcome: 'ok' });
    expect(list.runs.clips[0].runId).toBe(cmp.runId);
    const again = await run('inventory', { kind: 'clips', camera: true });
    expect(again.counts).toMatchObject({ missingLocally: 0, paired: 2, fromCamera: 2, goneFromCamera: 0 });
  });

  it('stops the repair when the camera refuses the download', async () => {
    sim.sim.engine.sd.seed([{ daysAgo: 1, start: '073000', end: '073030', triggers: ['vehicle'] }]);
    p.proxy.recordings.list.clear(); // the day list is cached 30 s
    const cmp = await run('inventory', { kind: 'clips', camera: true });
    expect(cmp.counts.missingLocally).toBe(1);
    sim.sim.engine.faults.set({ name: 'baichuan.refuse' });
    try {
      const rep = await run('inventory-repair', { kind: 'clips', runId: cmp.runId });
      expect(rep).toMatchObject({ outcome: 'ok', stopped: 'refused', counts: { done: 0, failed: 1 } });
      expect(rep.message).toMatch(/stopped: the camera refused a download$/);
    } finally {
      sim.sim.engine.faults.clear('baichuan.refuse');
    }
  });

  it('refuses a repair from a bad, unknown, local-only or other-kind run', async () => {
    const post = (body: object) => request(p.base).post('/control/actions/inventory-repair').set(admin()).send(body);
    expect((await post({ kind: 'stills', runId: 'stills-1-abcdef' })).body).toEqual({ error: 'invalid', detail: 'kind is one of: clips' });
    expect((await post({ kind: 'clips', runId: '../x' })).body).toEqual({ error: 'invalid', detail: 'runId is the id of a check run' });
    const unknown = await post({ kind: 'clips', runId: 'clips-1-abcdef' });
    expect([unknown.status, unknown.body.error]).toEqual([404, 'not_found']);
    const local = await run('inventory', { kind: 'clips' });
    const r = await post({ kind: 'clips', runId: local.runId });
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ error: 'not_repairable', detail: 'compare the clips with the camera first' });
    const audit = lines((await request(p.base).get('/control/audit?action=inventory-repair,control-action').set(admin())).text);
    expect(audit.some((x) => x.cam_proxy?.action === 'inventory-repair')).toBe(false); // refused starts write nothing
  });

  it('fails the compare with camera_offline when the camera does not answer', async () => {
    sim.sim.engine.faults.set({ name: 'offline' });
    try {
      p.proxy.recordings.list.clear();
      const rep = await run('inventory', { kind: 'clips', camera: true });
      expect(rep.outcome).toBe('failed');
      expect(rep.error).toMatch(/^camera_offline: /);
    } finally {
      sim.sim.engine.faults.clear('offline');
    }
  }, 60_000);
});
