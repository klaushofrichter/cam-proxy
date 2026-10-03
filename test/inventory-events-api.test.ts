import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { ADMIN_TOKEN, auth, startProxy, until } from './helpers/proxy';
import { startSim } from './helpers/sim';

// The events inventory and its repair (#75) against cam-sim's SD card: the
// recordings of yesterday have no events here (the proxy did not run then).
let sim: Awaited<ReturnType<typeof startSim>>;
let p: Awaited<ReturnType<typeof startProxy>>;
beforeAll(async () => {
  sim = await startSim();
  const sd = sim.sim.engine.sd;
  sd.clear();
  sd.seed([
    { daysAgo: 1, start: '070000', end: '070030', triggers: ['motion'] },
    { daysAgo: 1, start: '071000', end: '071030', triggers: ['person', 'motion'] },
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
const cameraEvents = () => Number((p.proxy.catalog.db.prepare("SELECT COUNT(*) AS n FROM stream_log WHERE type = 'camera-event'").get() as { n: number }).n);

describe('events inventory API', () => {
  it('checks against the camera, adds the missing events as recovered, and then finds none missing', async () => {
    const chk = await run('inventory', { kind: 'events' });
    expect(chk).toMatchObject({ kind: 'events', op: 'check', outcome: 'ok', window: { reason: 'sd-card', eventsDays: 30, camera: { stream: 'sub' } }, counts: { recordings: 2, timerOnly: 1, spans: 3, missingEvents: 3, missingPerson: 1, missingMotion: 2, unknownDays: 0 } });
    expect(chk.items.filter((x: { type: string }) => x.type === 'missing-event')).toHaveLength(3);
    expect(chk.message).toMatch(/^Events inventory: 3 of 3 recording spans without an event \(person 1, motion 2\) since \d{4}-\d\d-\d\d \(the SD card's reach\), /);
    const logged = cameraEvents();
    const rep = await run('inventory-repair', { kind: 'events', runId: chk.runId });
    expect(rep).toMatchObject({ kind: 'events', op: 'repair', outcome: 'ok', source: chk.runId, stopped: null, counts: { candidates: 3, requested: 3, done: 3, skipped: 0 } });
    expect(rep.runId).toMatch(/^eventsrepair-/);
    expect(rep.message).toBe('Events repair: 3 of 3 missing events added (person 1, motion 2), 0 had an event by then');
    // cams sees them through the client API, marked; no SSE or stream-log entry was made.
    const from = Math.min(...rep.items.map((x: { start: number }) => x.start));
    const evs = (await request(p.base).get(`/api/cameras/cam1/events?from=${from}&to=${from + 86_400_000}`).set(auth())).body;
    expect(evs.map((e: { kind: string; source: string; endReason: string }) => [e.kind, e.source, e.endReason])).toEqual([
      ['person', 'recovered', 'recovered'], // newest first
      ['motion', 'recovered', 'recovered'],
      ['motion', 'recovered', 'recovered'],
    ]);
    expect(cameraEvents()).toBe(logged);
    // One inventory-repair record, no control-action for the start.
    const recs = lines((await request(p.base).get('/control/audit?action=inventory-repair,control-action').set(admin())).text);
    expect(recs.filter((x) => x.event.action === 'inventory-repair')).toEqual([
      expect.objectContaining({ event: expect.objectContaining({ action: 'inventory-repair', type: ['change'], outcome: 'success' }), cam_proxy: expect.objectContaining({ runId: rep.runId, kind: 'events', source: chk.runId, counts: expect.objectContaining({ done: 3 }) }) }),
    ]);
    expect(recs.some((x) => x.cam_proxy?.action === 'inventory-repair')).toBe(false);
    const list = (await request(p.base).get('/control/inventory').set(admin())).body;
    expect(list.repairs.events[0]).toMatchObject({ runId: rep.runId, outcome: 'ok' });
    p.proxy.recordings.list.clear(); // the day list is cached 30 s
    const again = await run('inventory', { kind: 'events' });
    expect(again.counts).toMatchObject({ spans: 3, matched: 3, missingEvents: 0 });
    // Nothing missing now: a repair from it is refused and writes nothing.
    const r = await request(p.base).post('/control/actions/inventory-repair').set(admin()).send({ kind: 'events', runId: again.runId });
    expect([r.status, r.body]).toEqual([409, { error: 'not_repairable', detail: 'no events are missing' }]);
  });

  it('refuses camera:true (the events check always uses the camera)', async () => {
    const r = await request(p.base).post('/control/actions/inventory').set(admin()).send({ kind: 'events', camera: true });
    expect([r.status, r.body]).toEqual([400, { error: 'invalid', detail: 'the events inventory has no camera compare' }]);
  });

  it('fails the check with camera_offline when the camera does not answer', async () => {
    sim.sim.engine.faults.set({ name: 'offline' });
    try {
      p.proxy.recordings.list.clear();
      const rep = await run('inventory', { kind: 'events' });
      expect(rep.outcome).toBe('failed');
      expect(rep.error).toMatch(/^camera_offline: /);
    } finally {
      sim.sim.engine.faults.clear('offline');
    }
  }, 60_000);
});
