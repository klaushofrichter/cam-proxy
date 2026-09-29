import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import sharp from 'sharp';
import { startSim } from './helpers/sim';
import { startProxy, auth, until } from './helpers/proxy';
import { sseConnect } from './helpers/sse';

const binary = process.env.CAMPROXY_TEST_GO2RTC;
let sim: Awaited<ReturnType<typeof startSim>>;
let p: Awaited<ReturnType<typeof startProxy>>;
// A minute in the past, filled with known frames.
const M = Math.floor((Date.now() - 10 * 60_000) / 60_000) * 60_000;
const known: Buffer[] = [];

beforeAll(async () => {
  sim = await startSim();
  p = await startProxy(sim);
  for (let i = 0; i < 3; i++) known.push(await sharp({ create: { width: 64, height: 36, channels: 3, background: { r: i * 80, g: 10, b: 10 } } }).jpeg().toBuffer());
  const tile = await sharp({ create: { width: 160, height: 90, channels: 3, background: '#222' } }).jpeg().toBuffer();
  const store = p.proxy.stills!.store;
  known.forEach((still, i) => store.add({ ts: M + i * 1000, still, tile }));
  await store.flush();
}, 60000);
afterAll(async () => {
  await p.proxy.stop();
  await sim.close();
});

describe.skipIf(!binary)('stills and previews API', () => {
  it('reports the stream in /api/cameras once frames arrive', async () => {
    // Wait on the grabber itself: polling the API this fast would hit the rate limit.
    await until(() => p.proxy.stills!.grabber.up(), 30000);
    const cam = (await request(p.proxy.app).get('/api/cameras').set(auth())).body[0];
    expect(cam.stream.lastFrameTs).toBeGreaterThan(Date.now() - 10_000);
  }, 40000);

  it('lists stills in a range and serves one', async () => {
    const list = await request(p.proxy.app).get(`/api/cameras/cam1/stills?from=${M}&to=${M + 59_999}`).set(auth());
    expect(list.body).toEqual([M, M + 1000, M + 2000]);
    const one = await request(p.proxy.app).get(`/api/cameras/cam1/stills/${M + 1000}.jpg`).set(auth()).buffer(true).parse((res, cb) => {
      const b: Buffer[] = [];
      res.on('data', (d: Buffer) => b.push(d));
      res.on('end', () => cb(null, Buffer.concat(b)));
    });
    expect(one.status).toBe(200);
    expect(one.headers['content-type']).toBe('image/jpeg');
    expect(one.headers['cache-control']).toMatch(/immutable/);
    expect(Buffer.compare(one.body as Buffer, known[1])).toBe(0);
  });

  it('says a reversed range is reversed (a from later than to)', async () => {
    const r = await request(p.proxy.app).get('/api/cameras/cam1/stills?from=2000&to=1000').set(auth());
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: 'invalid', detail: 'to is before from' });
  });

  it('answers 404 for a missing still and 400 for a bad one, never outside the data folder', async () => {
    expect((await request(p.proxy.app).get(`/api/cameras/cam1/stills/${M + 5000}.jpg`).set(auth())).status).toBe(404);
    expect((await request(p.proxy.app).get('/api/cameras/cam1/stills/abc.jpg').set(auth())).status).toBe(400);
    expect((await request(p.proxy.app).get('/api/cameras/cam1/stills/..%2F..%2Fcatalog.sqlite').set(auth())).status).toBe(400);
    expect((await request(p.proxy.app).get(`/api/cameras/cam1/stills/${M + 1500}.jpg`).set(auth())).status).toBe(404);
    expect((await request(p.proxy.app).get(`/api/cameras/nope/stills/${M}.jpg`).set(auth())).status).toBe(404);
  });

  it('limits a list to one day, and needs from and to', async () => {
    expect((await request(p.proxy.app).get(`/api/cameras/cam1/stills?from=0&to=${2 * 86_400_000}`).set(auth())).status).toBe(400);
    expect((await request(p.proxy.app).get('/api/cameras/cam1/stills').set(auth())).status).toBe(400);
    expect((await request(p.proxy.app).get(`/api/cameras/cam1/previews?from=0&to=${2 * 86_400_000}`).set(auth())).status).toBe(400);
  });

  it('lists preview minutes with sprite URLs, and serves a sprite', async () => {
    const r = await request(p.proxy.app).get(`/api/cameras/cam1/previews?from=${M}&to=${M + 59_999}`).set(auth());
    expect(r.body).toEqual([{ minute: M, cols: 10, rows: 6, tileW: 160, tileH: 90, intervalS: 1, present: expect.any(Array), url: `/api/cameras/cam1/previews/${M}.jpg` }]);
    expect(r.body[0].present.slice(0, 4)).toEqual([true, true, true, false]);
    const sprite = await request(p.proxy.app).get(`/api/cameras/cam1/previews/${M}.jpg`).set(auth());
    expect(sprite.status).toBe(200);
    expect(sprite.headers['content-type']).toBe('image/jpeg');
    expect((await request(p.proxy.app).get(`/api/cameras/cam1/previews/${M + 30_000}.jpg`).set(auth())).status).toBe(404);
  });

  it('sends live still messages only to clients that ask for them, without ids', async () => {
    const plain = sseConnect(`${p.base}/api/stream`, auth());
    const stills = sseConnect(`${p.base}/api/stream?types=still`, auth());
    await stills.until(() => stills.events.some((e) => e.event === 'still'), 20000);
    const e = stills.events.find((x) => x.event === 'still')!;
    expect(e.id).toBeUndefined();
    expect(e.data).toMatchObject({ cam: 'cam1', ts: expect.any(Number), url: expect.stringMatching(/^\/api\/cameras\/cam1\/stills\/\d+\.jpg$/), sprite: expect.stringMatching(/^\/api\/cameras\/cam1\/previews\/\d+\.jpg$/), tile: expect.any(Number) });
    expect(plain.events.some((x) => x.event === 'still')).toBe(false);
    plain.close();
    stills.close();
  }, 30000);

  it('serves a day of sprites (1440) without hitting the general rate limit', async () => {
    const agent = request.agent(p.proxy.app);
    let limited = 0;
    for (let i = 0; i < 1300; i++) if ((await agent.get(`/api/cameras/cam1/previews/${M}.jpg`).set(auth())).status === 429) limited++;
    expect(limited).toBe(0);
    expect((await agent.get('/api/cameras').set(auth())).status).toBe(200); // the API itself is not starved
  }, 60000);

  it('reports the stream going down and up as camera-status messages', async () => {
    await until(() => p.proxy.stills!.grabber.up(), 30000);
    const from = p.proxy.log.lastId();
    sim.sim.engine.faults.set({ name: 'rtsp.reset' });
    const statuses = () => p.proxy.log.since(from, { types: ['camera-status'] }, 50).map((m) => m.data.stream);
    try {
      await until(() => statuses().includes('down'), 30000);
    } finally {
      sim.sim.engine.faults.clear('rtsp.reset');
    }
    await until(() => statuses().includes('up'), 60000);
  }, 120000);

  it('adds stills and previews to stats and metrics', async () => {
    const stats = (await request(p.proxy.app).get('/control/stats').set(auth('admin-token-'.padEnd(40, 'y')))).body;
    expect(stats.disk.stills.files).toBeGreaterThanOrEqual(1);
    expect(stats.disk.previews.files).toBeGreaterThanOrEqual(2);
    expect(stats.storage).toMatchObject({ budget: expect.any(Number), paused: false });
    const m = (await request(p.proxy.app).get('/metrics')).text;
    for (const name of ['camproxy_stills_total', 'camproxy_stills_missing_total', 'camproxy_last_still_timestamp_seconds', 'camproxy_frame_grabber_up', 'camproxy_go2rtc_up', 'camproxy_disk_bytes{kind="stills"}', 'camproxy_disk_files{kind="previews"}', 'camproxy_storage_budget_bytes', 'camproxy_storage_writing_paused', 'camproxy_storage_days_until_full']) {
      expect(m).toContain(name);
    }
  });
});
