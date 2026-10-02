// test/recordings-api.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { existsSync, unlinkSync, writeFileSync } from 'fs';
import { get as httpGet, type ClientRequest } from 'http';
import { basename, join } from 'path';
import { startSim } from './helpers/sim';
import { auth, CLIENT_TOKEN, freePort, startProxy, until } from './helpers/proxy';
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

// #99: one camera-local day, with the recording that runs into it from the day before.
describe('GET /recordings?date=', () => {
  it('lists one camera-local day in the same shape as from/to', async () => {
    const rec = recs[0];
    const r = await request(p.base).get(`/api/cameras/cam1/recordings?date=${rec.date}&stream=sub`).set(auth());
    expect(r.status).toBe(200);
    const item = r.body.find((x: { id: string }) => x.id === basename(rec.files.sub.name));
    expect(Object.keys(item).sort()).toEqual(['clipId', 'end', 'id', 'kinds', 'size', 'start', 'stream']);
    const starts = r.body.map((x: { start: number }) => x.start);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
  });

  it('includes a recording that starts the day before and runs past midnight; so does a from/to window just after midnight', async () => {
    const cross = sim.sim.engine.sd.add({ date: '2026-01-14', start: '235000', end: '000500', mainEnd: '000500', triggers: ['person'], dst: false });
    const id = basename(cross.files.sub.name);
    const day = await request(p.base).get('/api/cameras/cam1/recordings?date=2026-01-15&stream=sub').set(auth());
    expect(day.status).toBe(200);
    const item = day.body.find((x: { id: string }) => x.id === id);
    expect(item).toBeDefined();
    expect(item.end - item.start).toBe(15 * 60_000);
    const before = await request(p.base).get('/api/cameras/cam1/recordings?date=2026-01-14&stream=sub').set(auth());
    expect(before.body.map((x: { id: string }) => x.id)).toContain(id);
    const win = await request(p.base).get(`/api/cameras/cam1/recordings?from=${item.end - 60_000}&to=${item.end + HOUR}&stream=sub`).set(auth());
    expect(win.body.map((x: { id: string }) => x.id)).toContain(id);
  });

  it('checks the query: YYYY-MM-DD, a real date, not with from/to, stream required', async () => {
    const T = Date.now();
    const get = (q: string) => request(p.base).get(`/api/cameras/cam1/recordings${q}`).set(auth());
    for (const q of ['?date=2026-1-05&stream=sub', '?date=2026-02-30&stream=sub', '?date=20261005&stream=sub', '?date=2026-10-05', `?date=2026-10-05&from=${T}&to=${T + 1}&stream=sub`, `?date=2026-10-05&from=${T}&stream=sub`, `?date=2026-10-05&to=${T}&stream=sub`]) {
      const r = await get(q);
      expect(r.status, q).toBe(400);
      expect(r.body.error).toBe('invalid');
    }
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

// Review fixes: a stable ETag, an early 416, a drop isn't "offline".
describe('GET /recordings/:id: validators, ranges past the end, a dropped transfer', () => {
  beforeAll(async () => {
    await until(() => p.proxy.status.state().online, 15_000);
  });

  it('a stable ETag from id and size (no Last-Modified): If-None-Match is 304, If-Range with a Range is 206', async () => {
    const f = recs[2].files.main;
    const id = basename(f.name);
    const live = await binary(request(p.base).get(url(id)).set(auth())); // streamed while it arrives
    expect(live.status).toBe(200);
    const etag = live.headers.etag as string;
    expect(etag).toMatch(/^"[^"]+"$/);
    await until(() => existsSync(join(p.dir, 'data', 'recordings', 'cam1', id)), 2000);
    const a = await binary(request(p.base).get(url(id)).set(auth()));
    await new Promise((r) => setTimeout(r, 1100)); // a new mtime from the read (LRU touch)
    const b = await binary(request(p.base).get(url(id)).set(auth()));
    expect([a.headers.etag, b.headers.etag]).toEqual([etag, etag]);
    expect(b.headers['last-modified']).toBeUndefined();
    const fresh = await request(p.base).get(url(id)).set(auth()).set('If-None-Match', etag);
    expect(fresh.status).toBe(304);
    const part = await binary(request(p.base).get(url(id)).set(auth()).set('If-Range', etag).set('Range', 'bytes=0-9'));
    expect(part.status).toBe(206);
    expect(part.body).toEqual((a.body as Buffer).subarray(0, 10));
    const stale = await binary(request(p.base).get(url(id)).set(auth()).set('If-Range', '"other"').set('Range', 'bytes=0-9'));
    expect([stale.status, (stale.body as Buffer).length]).toEqual([200, f.size]);
  });

  it('a Range wholly past the end of a file not cached is 416 at once, without a download', async () => {
    const f = recs[3].files.main;
    const before = downloads();
    const r = await request(p.base).get(url(basename(f.name))).set(auth()).set('Range', `bytes=${f.size}-`);
    expect(r.status).toBe(416);
    expect(r.headers['content-range']).toBe(`bytes */${f.size}`);
    expect(downloads()).toBe(before);
  });

  it('a transfer dropped midway is 502 offline (not camera_offline); a Baichuan port that refuses is 503', async () => {
    const f = recs[4].files.sub; // not cached (streamed only, above)
    sim.sim.engine.faults.set({ name: 'baichuan.dropMidway' });
    try {
      const r = await request(p.base).get(url(basename(f.name))).set(auth()).set('Range', 'bytes=0-9');
      expect([r.status, r.body.error, r.body.reason]).toEqual([502, 'recordings_unavailable', 'offline']);
      expect(p.proxy.recordings.status().last?.result).toBe('offline');
    } finally {
      sim.sim.engine.faults.clear('baichuan.dropMidway');
    }
    const cam = p.proxy.running.camera;
    const port = cam.baichuanPort;
    cam.baichuanPort = await freePort(); // nothing listens: the connect fails
    p.proxy.recordings.session.close();
    try {
      const r = await request(p.base).get(url(basename(recs[4].files.main.name))).set(auth());
      expect([r.status, r.body]).toEqual([503, { error: 'camera_offline' }]);
    } finally {
      cam.baichuanPort = port;
    }
    const ok = await binary(request(p.base).get(url(basename(f.name))).set(auth()));
    expect([ok.status, (ok.body as Buffer).length]).toEqual([200, f.size]);
  }, 30_000);
});

// Final review: a browser's `Range: bytes=0-` streams; a Range on a file that
// can't be kept costs one download.
describe('GET /recordings/:id: bytes=0- and files that cannot be kept', () => {
  const cacheDir = () => join(p.dir, 'data', 'recordings', 'cam1');
  beforeAll(async () => {
    await until(() => p.proxy.status.state().online, 15_000);
  });
  afterAll(() => {
    sim.sim.engine.faults.clear('baichuan.delayMs');
  });

  it('an uncached bytes=0- is 200 with the whole file, its first byte before the download ends; cached, it is 206', async () => {
    const f = recs[1].files.main;
    const id = basename(f.name);
    const before = downloads();
    const fetches = (p.proxy.recordings.fetcher as unknown as { byId: Map<string, unknown> }).byId;
    sim.sim.engine.faults.set({ name: 'baichuan.delayMs', ms: 20 });
    const got = await new Promise<{ status: number; body: Buffer; runningAtFirst: boolean; cachedAtFirst: boolean }>((resolve, reject) => {
      const req = httpGet(`${p.base}${url(id)}`, { headers: { Authorization: `Bearer ${CLIENT_TOKEN}`, Range: 'bytes=0-' } }, (res) => {
        const parts: Buffer[] = [];
        let runningAtFirst = false;
        let cachedAtFirst = true;
        res.on('data', (c: Buffer) => {
          if (!parts.length) {
            runningAtFirst = fetches.has(id);
            cachedAtFirst = existsSync(join(cacheDir(), id));
          }
          parts.push(c);
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(parts), runningAtFirst, cachedAtFirst }));
        res.on('error', reject);
      });
      req.on('error', reject);
    });
    sim.sim.engine.faults.clear('baichuan.delayMs');
    expect(got.status).toBe(200);
    expect([got.runningAtFirst, got.cachedAtFirst]).toEqual([true, false]);
    expect(got.body.length).toBe(f.size);
    expect(downloads()).toBe(before + 1);
    await until(() => existsSync(join(cacheDir(), id)), 2000);
    const whole = await binary(request(p.base).get(url(id)).set(auth()));
    expect(got.body).toEqual(whole.body);
    const cached = await binary(request(p.base).get(url(id)).set(auth()).set('Range', 'bytes=0-'));
    expect(cached.status).toBe(206);
    expect(cached.body).toEqual(whole.body);
    expect(downloads()).toBe(before + 1);
  }, 30_000);

  it('a Range on a file with no room beside the pinned files is the whole file as 200, one download', async () => {
    const f = recs[3].files.sub;
    const id = basename(f.name);
    const cache = p.proxy.recordings.cache as unknown as { capBytes: () => number; pin: (path: string) => () => void };
    const pinned = join(cacheDir(), 'pinned-final-review.mp4');
    writeFileSync(pinned, Buffer.alloc(200));
    const unpin = cache.pin(pinned);
    cache.capBytes = () => f.size + 100; // the file fits the cap, not beside the pinned one
    try {
      const before = downloads();
      const r = await binary(request(p.base).get(url(id)).set(auth()).set('Range', 'bytes=10-19'));
      expect(r.status).toBe(200);
      expect((r.body as Buffer).length).toBe(f.size);
      expect(downloads()).toBe(before + 1);
    } finally {
      unpin();
      delete (cache as { capBytes?: unknown }).capBytes;
      unlinkSync(pinned);
    }
  }, 30_000);
});
