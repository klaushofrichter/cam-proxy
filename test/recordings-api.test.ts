// test/recordings-api.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { existsSync } from 'fs';
import { get as httpGet, type ClientRequest } from 'http';
import { basename, join } from 'path';
import { startSim } from './helpers/sim';
import { auth, CLIENT_TOKEN, startProxy, until } from './helpers/proxy';
import { insertClip } from '../src/catalog/clips';

let sim: Awaited<ReturnType<typeof startSim>>;
let p: Awaited<ReturnType<typeof startProxy>>;
type SimFile = { name: string; size: number };
let recs: { date: string; files: { sub: SimFile; main: SimFile } }[];
const HOUR = 3_600_000;
const url = (id: string) => `/api/cameras/cam1/recordings/${id}`;
const binary = (r: request.Test) =>
  r.buffer(true).parse((res, cb) => {
    const chunks: Buffer[] = [];
    res.on('data', (c: Buffer) => chunks.push(c));
    res.on('end', () => cb(null, Buffer.concat(chunks)));
  });
const downloads = () => sim.sim.engine.counters.baichuanDownloads;
// The whole camera-local day of a recording, and the days around it (47 h).
const windowOf = (date: string) => {
  const from = Date.parse(`${date}T00:00:00Z`) - 12 * HOUR;
  return { from, to: from + 47 * HOUR };
};

beforeAll(async () => {
  sim = await startSim();
  p = await startProxy(sim);
  await until(() => p.proxy.status.state().online, 15_000);
  recs = sim.sim.engine.sd.all().filter((r) => r.end !== null) as typeof recs;
  expect(recs.length).toBeGreaterThanOrEqual(5);
}, 30_000);
afterAll(async () => {
  await p.proxy.stop();
  await sim.close();
});

describe('GET /recordings (the list)', () => {
  it('lists the SD recordings of a window: times, stream, size, kinds, clipId; no camera path', async () => {
    const rec = recs[0];
    const { from, to } = windowOf(rec.date);
    const r = await request(p.base).get(`/api/cameras/cam1/recordings?from=${from}&to=${to}&stream=sub`).set(auth());
    expect(r.status).toBe(200);
    const item = r.body.find((x: { id: string }) => x.id === basename(rec.files.sub.name));
    expect(item).toMatchObject({ stream: 'sub', size: rec.files.sub.size, clipId: null });
    expect(item.kinds.length).toBeGreaterThan(0);
    expect(item.end).toBeGreaterThan(item.start);
    expect(Object.keys(item).sort()).toEqual(['clipId', 'end', 'id', 'kinds', 'size', 'start', 'stream']);
    const starts = r.body.map((x: { start: number }) => x.start);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
    // The FTP copy: same stream, start within 5 s.
    const clip = insertClip(p.proxy.catalog, { cam: 'cam1', start_ts: item.start + 3000, end_ts: item.end, path: '/x.mp4', stream: 'sub', size: 1, received_at: item.end, snapshot: null });
    const again = await request(p.base).get(`/api/cameras/cam1/recordings?from=${from}&to=${to}&stream=sub`).set(auth());
    expect(again.body.find((x: { id: string }) => x.id === item.id).clipId).toBe(clip.id);
    const main = await request(p.base).get(`/api/cameras/cam1/recordings?from=${from}&to=${to}&stream=main`).set(auth());
    expect(main.body.map((x: { id: string }) => x.id)).toContain(basename(rec.files.main.name));
  });

  it('checks the query: from/to required and ordered, at most 48 hours, stream sub or main; unknown camera 404', async () => {
    const get = (q: string, cam = 'cam1') => request(p.base).get(`/api/cameras/${cam}/recordings${q}`).set(auth());
    const T = Date.now();
    for (const q of ['', `?from=${T}&stream=sub`, `?from=${T}&to=${T - 1}&stream=sub`, `?from=${T}&to=${T + 48 * HOUR + 1}&stream=sub`, `?from=${T}&to=${T + 1}`, `?from=${T}&to=${T + 1}&stream=hd`]) {
      const r = await get(q);
      expect(r.status, q).toBe(400);
      expect(r.body.error).toBe('invalid');
    }
    expect((await get(`?from=${T}&to=${T + 48 * HOUR}&stream=sub`)).status).toBe(200);
    expect((await get(`?from=${T}&to=${T + 1}&stream=sub`, 'nope')).body).toEqual({ error: 'not_found' });
  });
});

describe('GET /recordings/days', () => {
  it('the days of a camera-local month with recordings; a bad month is 400 (and /days is not taken for an id)', async () => {
    const month = recs[0].date.slice(0, 7);
    const r = await request(p.base).get(`/api/cameras/cam1/recordings/days?month=${month}`).set(auth());
    expect(r.status).toBe(200);
    expect(r.body.month).toBe(month);
    expect(r.body.days).toContain(Number(recs[0].date.slice(8, 10)));
    expect((await request(p.base).get('/api/cameras/cam1/recordings/days?month=2026-13').set(auth())).status).toBe(400);
    expect((await request(p.base).get('/api/cameras/nope/recordings/days?month=2026-10').set(auth())).status).toBe(404);
  });
});

describe('GET /recordings/:id (the file)', () => {
  it('fetches over Baichuan and streams it: 200, length, ranges, immutable; then the cache serves it', async () => {
    const f = recs[0].files.sub;
    const id = basename(f.name);
    const before = downloads();
    const r = await binary(request(p.base).get(url(id)).set(auth()));
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toBe('video/mp4');
    expect(Number(r.headers['content-length'])).toBe(f.size);
    expect(r.headers['accept-ranges']).toBe('bytes');
    expect(r.headers['cache-control']).toBe('private, max-age=604800, immutable');
    const body = r.body as Buffer;
    expect(body.length).toBe(f.size);
    expect(body.subarray(4, 8).toString()).toBe('ftyp');
    expect(downloads()).toBe(before + 1);
    // The response ends when the last byte is out; the rename follows it.
    await until(() => existsSync(join(p.dir, 'data', 'recordings', 'cam1', id)), 2000);
    // From the cache: no new transfer, Range, and 416.
    const again = await binary(request(p.base).get(url(id)).set(auth()));
    expect(again.body).toEqual(body);
    const part = await binary(request(p.base).get(url(id)).set(auth()).set('Range', 'bytes=0-99'));
    expect(part.status).toBe(206);
    expect(part.body).toEqual(body.subarray(0, 100));
    const bad = await request(p.base).get(url(id)).set(auth()).set('Range', `bytes=${f.size}-`);
    expect(bad.status).toBe(416);
    expect(bad.headers['content-range']).toBe(`bytes */${f.size}`);
    expect(downloads()).toBe(before + 1);
  });

  it('HEAD of a file not cached answers from the list, without a transfer', async () => {
    const f = recs[0].files.main;
    const before = downloads();
    const r = await request(p.base).head(url(basename(f.name))).set(auth());
    expect(r.status).toBe(200);
    expect(Number(r.headers['content-length'])).toBe(f.size);
    expect(r.headers['accept-ranges']).toBe('bytes');
    expect(downloads()).toBe(before);
  });

  it('a Range request for a file not yet cached waits for the fetch, then is served from the cache', async () => {
    const f = recs[0].files.main;
    const id = basename(f.name);
    const part = await binary(request(p.base).get(url(id)).set(auth()).set('Range', 'bytes=10-19'));
    expect(part.status).toBe(206);
    const whole = await binary(request(p.base).get(url(id)).set(auth()));
    expect(part.body).toEqual((whole.body as Buffer).subarray(10, 20));
  });

  it('two requests for one id at once: one transfer', async () => {
    const f = recs[1].files.sub;
    const before = downloads();
    const [a, b] = await Promise.all([binary(request(p.base).get(url(basename(f.name))).set(auth())), binary(request(p.base).get(url(basename(f.name))).set(auth()))]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(a.body).toEqual(b.body);
    expect(downloads()).toBe(before + 1);
  });

  // Review Focus 5.
  it('odd ids never reach the camera: 400 for a bad id, 404 for one the card does not have', async () => {
    const id = basename(recs[0].files.sub.name);
    const before = downloads();
    const cases: [string, number][] = [
      [`%2E%2E%2F${id}`, 400],
      [id.replace('.mp4', '.MP4'), 400],
      [`RecS0A_DST20261001_211129_211207_0_${'A'.repeat(90)}.mp4`, 400], // 129 characters
      ['RecS0A_DST20261340_211129_211207_0_5514C080000000_3E8.mp4', 404], // no such date
      ['RecS0A_DST20200101_211129_211207_0_5514C080000000_3E8.mp4', 404], // not on the card
    ];
    for (const [c, status] of cases) {
      const r = await request(p.base).get(url(c)).set(auth());
      expect(r.status, c).toBe(status);
      if (status === 404) expect(r.body).toEqual({ error: 'unknown_recording' });
    }
    expect((await request(p.base).get('/api/cameras/nope/recordings/' + id).set(auth())).body).toEqual({ error: 'not_found' });
    expect(downloads()).toBe(before);
  });

  it('HTTP Download refused (downloads.refuse) while Baichuan works', async () => {
    sim.sim.engine.faults.set({ name: 'downloads.refuse' });
    try {
      const f = recs[2].files.sub;
      const r = await binary(request(p.base).get(url(basename(f.name))).set(auth()));
      expect(r.status).toBe(200);
      expect((r.body as Buffer).length).toBe(f.size);
    } finally {
      sim.sim.engine.faults.clear('downloads.refuse');
    }
  });

  it('camera offline: the list and an uncached file answer 503, a cached file is still served', async () => {
    const cached = basename(recs[0].files.sub.name);
    const uncached = basename(recs[3].files.sub.name);
    const { from, to } = windowOf(recs[0].date);
    sim.sim.engine.faults.set({ name: 'offline' });
    try {
      await p.proxy.status.checkNow();
      await p.proxy.status.checkNow();
      expect(p.proxy.status.state().online).toBe(false);
      expect((await request(p.base).get(`/api/cameras/cam1/recordings?from=${from}&to=${to}&stream=sub`).set(auth())).body).toEqual({ error: 'camera_offline' });
      expect((await request(p.base).get(`/api/cameras/cam1/recordings/days?month=${recs[0].date.slice(0, 7)}`).set(auth())).status).toBe(503);
      const r = await request(p.base).get(url(uncached)).set(auth());
      expect([r.status, r.body]).toEqual([503, { error: 'camera_offline' }]);
      expect((await request(p.base).get(url(cached)).set(auth())).status).toBe(200);
    } finally {
      sim.sim.engine.faults.clear('offline');
      await p.proxy.status.checkNow();
    }
  });
});

// Binding rules from the reviews: a fetch that isn't kept, and a joined fetch
// that fails for another client's reason, are never final for this client.
describe('GET /recordings/:id when the cache cannot keep the file', () => {
  const cache = () => p.proxy.recordings.cache as unknown as { capBytes: () => number };
  beforeAll(async () => {
    await until(() => p.proxy.status.state().online, 15_000);
    cache().capBytes = () => 1; // every recording is larger than the cap: streamed, never kept
  });
  afterAll(() => {
    delete (cache() as { capBytes?: unknown }).capBytes; // the class method again
    sim.sim.engine.faults.clear('baichuan.delayMs');
  });

  it('a Range request gets the whole file as 200 (Range is served only from the cache)', async () => {
    const f = recs[4].files.sub;
    const id = basename(f.name);
    const before = downloads();
    const r = await binary(request(p.base).get(url(id)).set(auth()).set('Range', 'bytes=0-9'));
    expect(r.status).toBe(200);
    expect((r.body as Buffer).length).toBe(f.size);
    expect(downloads()).toBe(before + 1);
    expect(existsSync(join(p.dir, 'data', 'recordings', 'cam1', id))).toBe(false);
  });

  it('a request that joined a fetch abandoned by its first client fetches again for itself', async () => {
    const f = recs[4].files.main;
    const id = basename(f.name);
    const before = downloads();
    sim.sim.engine.faults.set({ name: 'baichuan.delayMs', ms: 100 });
    // A: the first client, streamed through the tee; it leaves after its first bytes.
    let a: ClientRequest | undefined;
    const aGot = new Promise<void>((resolve, reject) => {
      a = httpGet(`${p.base}${url(id)}`, { headers: { Authorization: `Bearer ${CLIENT_TOKEN}` } }, (res) => {
        res.once('data', () => resolve());
        res.on('error', () => undefined);
      });
      a.on('error', () => undefined);
      setTimeout(() => reject(new Error('no bytes for A')), 10_000);
    });
    await aGot;
    // B joins the running fetch (A has the tee), then A goes.
    const fetches = (p.proxy.recordings.fetcher as unknown as { byId: Map<string, { waiters: number }> }).byId;
    const b = binary(request(p.base).get(url(id)).set(auth())).then((x) => x); // sent now, not when awaited
    await until(() => (fetches.get(id)?.waiters ?? 0) >= 2, 5_000);
    a!.destroy();
    sim.sim.engine.faults.clear('baichuan.delayMs');
    const r = await b;
    expect(r.status).toBe(200);
    expect((r.body as Buffer).length).toBe(f.size);
    expect(downloads()).toBe(before + 2);
  }, 30_000);
});
