import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { closeEvent, insertEvent } from '../src/catalog/events';
import { countUnmapped, saveAnalysis } from '../src/catalog/analyses';
import { startSim } from './helpers/sim';
import { ADMIN_TOKEN, CLIENT_TOKEN, auth, startProxy, until } from './helpers/proxy';
import { startVisionMock, type VisionMock } from './helpers/vision-mock';

let sim: Awaited<ReturnType<typeof startSim>>;
let p: Awaited<ReturnType<typeof startProxy>>;
let mock: VisionMock;
let keptImage = '';
beforeAll(async () => {
  sim = await startSim();
  mock = await startVisionMock({ key: 'k-123456789012' });
  p = await startProxy(sim, { env: { CAMPROXY_GOOGLE_VISION_KEY: 'k-123456789012', CAMPROXY_GOOGLE_VISION_URL: mock.url } });
});
afterAll(async () => {
  await p.proxy.stop();
  await sim.close();
  await mock.close();
});

describe('analytics API', () => {
  it('adds analysis to events, and serves the record and its image', async () => {
    const c = p.proxy.catalog;
    const e = insertEvent(c, { cam: 'cam1', source: 'onvif', kind: 'person', start_ts: Date.now() - 60_000, raw: null });
    const dir = join(p.dir, 'data', 'analytics', 'cam1');
    mkdirSync(dir, { recursive: true });
    const image = join(dir, `${e.id}.jpg`);
    keptImage = image;
    writeFileSync(image, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    saveAnalysis(c, { event_id: e.id, provider: 'google-vision', status: 'ok', reason: null, still_ts: e.start_ts + 1000, image, requested_at: Date.now(), took_ms: 250,
      objects: JSON.stringify([{ name: 'Person', score: 0.8, box: { x0: 0.1, y0: 0.1, x1: 0.5, y1: 0.9 } }]), raw: '{"a":1}', summary: null });
    const list = await request(p.proxy.app).get(`/api/cameras/cam1/events?from=0&to=${Date.now()}&limit=10`).set(auth());
    expect(list.body.find((x: { id: number }) => x.id === e.id).analysis).toEqual({ provider: 'google-vision', status: 'ok', reason: null, stillTs: e.start_ts + 1000, objects: [{ name: 'Person', score: 0.8, box: { x0: 0.1, y0: 0.1, x1: 0.5, y1: 0.9 } }], summary: [] });
    const full = await request(p.proxy.app).get(`/api/cameras/cam1/events/${e.id}/analysis`).set(auth());
    expect(full.body).toMatchObject({ eventId: e.id, stillTs: e.start_ts + 1000, tookMs: 250, raw: { a: 1 } });
    const jpg = await request(p.proxy.app).get(`/api/cameras/cam1/events/${e.id}/analysis.jpg`).set(auth());
    expect(jpg.status).toBe(200);
    expect(jpg.headers['content-type']).toBe('image/jpeg');
    expect((await request(p.proxy.app).get('/api/cameras/cam1/events/999999/analysis').set(auth())).status).toBe(404);
  });

  it('reports the provider state to admins only, key masked', async () => {
    const r = await request(p.proxy.app).get('/control/analytics').set(auth(ADMIN_TOKEN));
    expect(r.status).toBe(200);
    expect(r.body[0]).toMatchObject({ id: 'google-vision', enabled: false, keyMasked: 'k-12…9012', month: { calls: 0, limit: 0 } });
    expect(JSON.stringify(r.body)).not.toContain('k-123456789012');
    expect((await request(p.proxy.app).get('/control/status').set(auth(ADMIN_TOKEN))).body.analytics).toHaveLength(1);
    expect((await request(p.proxy.app).get('/control/analytics').set(auth(CLIENT_TOKEN))).status).toBe(403);
  });

  it('with the limit at 0 no call reaches the mock, even when enabled', async () => {
    await request(p.proxy.app).put('/control/config').set(auth(ADMIN_TOKEN)).send({ analytics: { googleVision: { enabled: true } } });
    const before = mock.calls;
    const e = insertEvent(p.proxy.catalog, { cam: 'cam1', source: 'onvif', kind: 'person', start_ts: Date.now(), raw: null });
    p.proxy.analytics.onEvent(e);
    await p.proxy.analytics.idle();
    expect(mock.calls).toBe(before);
  });

  it('a real camera event reaches the service through the stream log', async () => {
    await request(p.proxy.app).put('/control/config').set(auth(ADMIN_TOKEN)).send({ analytics: { googleVision: { enabled: true, monthlyLimit: 10 } } });
    sim.sim.engine.events.trigger('person', 1);
    // Stills are off in unit tests without go2rtc: the event is skipped with no_still (no call).
    await until(async () => {
      const list = await request(p.proxy.app).get(`/api/cameras/cam1/events?from=${Date.now() - 60_000}&to=${Date.now() + 60_000}&limit=10&kind=person`).set(auth());
      return list.body.some((x: { analysis: { status: string } | null }) => x.analysis !== null);
    }, 15_000);
  });

  it('deletes images whose analysis is gone', async () => {
    const orphan = join(p.dir, 'data', 'analytics', 'cam1', '424242.jpg');
    writeFileSync(orphan, Buffer.from([1]));
    await request(p.proxy.app).post('/control/actions/retention-run').set(auth(ADMIN_TOKEN)).send({});
    expect(existsSync(orphan)).toBe(false);
    expect(existsSync(keptImage)).toBe(true);
  });
});

describe('analytics summary API', () => {
  const at = Date.now() - 3_600_000;
  it('serves a day of analyses in the message shape, oldest first, with the summary', async () => {
    const c = p.proxy.catalog;
    const a = insertEvent(c, { cam: 'cam1', source: 'onvif', kind: 'person', start_ts: at, raw: null });
    const b = insertEvent(c, { cam: 'cam1', source: 'onvif', kind: 'pet', start_ts: at + 60_000, raw: null });
    const summary = [{ category: 'person', subtype: 'person', score: 0.84, box: { x0: 0.1, y0: 0.1, x1: 0.2, y1: 0.9 } }];
    saveAnalysis(c, { event_id: b.id, provider: 'google-vision', status: 'skipped', reason: 'limit', still_ts: null, image: null, requested_at: at, took_ms: null, objects: null, raw: null, summary: '[]' });
    saveAnalysis(c, { event_id: a.id, provider: 'google-vision', status: 'ok', reason: null, still_ts: at + 1000, image: null, requested_at: at, took_ms: 300, objects: '[]', raw: '{}', summary: JSON.stringify(summary) });
    const r = await request(p.proxy.app).get(`/api/cameras/cam1/analyses?from=${at - 1}&to=${at + 120_000}`).set(auth());
    expect(r.status).toBe(200);
    expect(r.body).toEqual([
      { eventId: a.id, kind: 'person', start: at, end: null, provider: 'google-vision', status: 'ok', reason: null, stillTs: at + 1000, summary },
      { eventId: b.id, kind: 'pet', start: at + 60_000, end: null, provider: 'google-vision', status: 'skipped', reason: 'limit', stillTs: null, summary: [] },
    ]);
  });

  it("returns the event's end once it closed", async () => {
    const c = p.proxy.catalog;
    const e = insertEvent(c, { cam: 'cam1', source: 'onvif', kind: 'person', start_ts: at + 200_000, raw: null });
    saveAnalysis(c, { event_id: e.id, provider: 'google-vision', status: 'ok', reason: null, still_ts: at + 201_000, image: null, requested_at: at, took_ms: 300, objects: '[]', raw: '{}', summary: '[]' });
    closeEvent(c, e.id, at + 206_000, 'state');
    const r = await request(p.proxy.app).get(`/api/cameras/cam1/analyses?from=${at + 199_000}&to=${at + 202_000}`).set(auth());
    expect(r.body[0]).toMatchObject({ eventId: e.id, end: at + 206_000 });
  });

  it('rejects a reversed, missing or longer-than-a-day range, and needs the client token', async () => {
    for (const q of ['', `?from=${at}`, `?from=${at}&to=${at - 1}`, `?from=${at}&to=${at + 86_400_001}`]) {
      const r = await request(p.proxy.app).get(`/api/cameras/cam1/analyses${q}`).set(auth());
      expect(r.status).toBe(400);
      expect(r.body.error).toBe('invalid');
    }
    expect((await request(p.proxy.app).get('/api/cameras/cam1/analyses?from=0&to=1')).status).toBe(401);
    expect((await request(p.proxy.app).get('/api/cameras/other/analyses?from=0&to=1').set(auth())).status).toBe(404);
  });

  it('events carry the summary', async () => {
    const list = await request(p.proxy.app).get(`/api/cameras/cam1/events?from=${at - 1}&to=${at + 120_000}&limit=10`).set(auth());
    const withSummary = list.body.find((x: { analysis: { status: string } | null }) => x.analysis?.status === 'ok');
    expect(withSummary.analysis.summary[0]).toMatchObject({ category: 'person', score: 0.84 });
  });

  it('lists and clears unmapped objects for admins; status has the top 20', async () => {
    countUnmapped(p.proxy.catalog, [{ mid: '/m/03ldnb', name: 'Ceiling fan' }], Date.now());
    const l = await request(p.proxy.app).get('/control/analytics/unmapped').set(auth(ADMIN_TOKEN));
    expect(l.body).toEqual([expect.objectContaining({ mid: '/m/03ldnb', name: 'Ceiling fan', count: 1 })]);
    expect((await request(p.proxy.app).get('/control/status').set(auth(ADMIN_TOKEN))).body.analyticsUnmapped[0]).toMatchObject({ name: 'Ceiling fan' });
    expect((await request(p.proxy.app).get('/control/analytics/unmapped').set(auth(CLIENT_TOKEN))).status).toBe(403);
    expect((await request(p.proxy.app).delete('/control/analytics/unmapped').set(auth(ADMIN_TOKEN))).body).toEqual({ cleared: 1 });
    expect((await request(p.proxy.app).get('/control/analytics/unmapped').set(auth(ADMIN_TOKEN))).body).toEqual([]);
  });
});
