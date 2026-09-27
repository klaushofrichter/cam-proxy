import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { randomBytes } from 'crypto';
import { startSim } from './helpers/sim';
import { startProxy, auth } from './helpers/proxy';
import { insertClip, type ClipRow } from '../src/catalog/clips';
import { insertEvent } from '../src/catalog/events';

let sim: Awaited<ReturnType<typeof startSim>>;
let p: Awaited<ReturnType<typeof startProxy>>;
const T = Date.UTC(2026, 8, 27, 19, 3, 1);
const body = randomBytes(10_000);
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 9, 9, 0xff, 0xd9]);
let withSnap: ClipRow;
let noSnap: ClipRow;
let eventId = 0;

const binary = (r: request.Test) =>
  r.buffer(true).parse((res, cb) => {
    const chunks: Buffer[] = [];
    res.on('data', (c: Buffer) => chunks.push(c));
    res.on('end', () => cb(null, Buffer.concat(chunks)));
  });

beforeAll(async () => {
  sim = await startSim();
  p = await startProxy(sim);
  const folder = join(p.dir, 'data', 'clips', 'cam1', '2026', '09', '27');
  mkdirSync(folder, { recursive: true });
  const mp4 = join(folder, `1903-${T}.mp4`);
  writeFileSync(mp4, body);
  writeFileSync(mp4.replace(/\.mp4$/, '.jpg'), jpeg);
  const base = { cam: 'cam1', stream: 'main', size: body.length, received_at: T + 60_000 };
  withSnap = insertClip(p.proxy.catalog, { ...base, start_ts: T, end_ts: T + 30_000, path: mp4, snapshot: mp4.replace(/\.mp4$/, '.jpg') });
  noSnap = insertClip(p.proxy.catalog, { ...base, start_ts: T + 3_600_000, end_ts: T + 3_630_000, path: mp4, snapshot: null });
  eventId = insertEvent(p.proxy.catalog, { cam: 'cam1', source: 'onvif', kind: 'motion', start_ts: T + 5000, raw: null }).id;
}, 30_000);
afterAll(async () => {
  await p.proxy.stop();
  await sim.close();
});

describe('clips API', () => {
  it('lists the clips in a range with their events and URLs', async () => {
    const r = await request(p.proxy.app).get(`/api/cameras/cam1/clips?from=${T - 60_000}&to=${T + 60_000}`).set(auth());
    expect(r.status).toBe(200);
    expect(r.body).toEqual([
      { id: withSnap.id, start: T, end: T + 30_000, stream: 'main', size: body.length, events: [eventId], url: `/api/cameras/cam1/clips/${withSnap.id}.mp4`, snapshotUrl: `/api/cameras/cam1/clips/${withSnap.id}.jpg` },
    ]);
    const both = await request(p.proxy.app).get(`/api/cameras/cam1/clips?from=${T}&to=${T + 2 * 3_600_000}`).set(auth());
    expect(both.body.map((c: { id: number }) => c.id)).toEqual([withSnap.id, noSnap.id]);
    expect(both.body[1].snapshotUrl).toBeNull();
  });

  it('checks the range: required, ordered, at most 31 days', async () => {
    const get = (q: string) => request(p.proxy.app).get(`/api/cameras/cam1/clips${q}`).set(auth());
    expect((await get('')).status).toBe(400);
    expect((await get(`?from=${T}&to=${T - 1}`)).status).toBe(400);
    expect((await get(`?from=${T}&to=${T + 32 * 86_400_000}`)).status).toBe(400);
    expect((await get(`?from=${T}&to=${T + 31 * 86_400_000}`)).status).toBe(200);
    expect((await request(p.proxy.app).get(`/api/cameras/cam9/clips?from=${T}&to=${T}`).set(auth())).status).toBe(404);
  });

  it('serves a whole clip with range support and long caching', async () => {
    const r = await binary(request(p.proxy.app).get(`/api/cameras/cam1/clips/${withSnap.id}.mp4`).set(auth()));
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toBe('video/mp4');
    expect(r.headers['accept-ranges']).toBe('bytes');
    expect(r.headers['content-length']).toBe(String(body.length));
    expect(r.headers['cache-control']).toBe('private, max-age=604800, immutable');
    expect(Buffer.compare(r.body, body)).toBe(0);
  });

  it('answers partial, open-ended and unsatisfiable ranges', async () => {
    const url = `/api/cameras/cam1/clips/${withSnap.id}.mp4`;
    const part = await binary(request(p.proxy.app).get(url).set(auth()).set('Range', 'bytes=100-199'));
    expect(part.status).toBe(206);
    expect(part.headers['content-range']).toBe(`bytes 100-199/${body.length}`);
    expect(part.headers['content-length']).toBe('100');
    expect(Buffer.compare(part.body, body.subarray(100, 200))).toBe(0);
    const open = await binary(request(p.proxy.app).get(url).set(auth()).set('Range', 'bytes=9000-'));
    expect(open.status).toBe(206);
    expect(open.headers['content-range']).toBe(`bytes 9000-9999/${body.length}`);
    expect(Buffer.compare(open.body, body.subarray(9000))).toBe(0);
    const bad = await request(p.proxy.app).get(url).set(auth()).set('Range', 'bytes=20000-30000');
    expect(bad.status).toBe(416);
    expect(bad.headers['content-range']).toBe(`bytes */${body.length}`);
  });

  it('serves the snapshot, and 404 for unknown clips or a missing snapshot', async () => {
    const snap = await binary(request(p.proxy.app).get(`/api/cameras/cam1/clips/${withSnap.id}.jpg`).set(auth()));
    expect(snap.status).toBe(200);
    expect(snap.headers['content-type']).toBe('image/jpeg');
    expect(Buffer.compare(snap.body, jpeg)).toBe(0);
    expect((await request(p.proxy.app).get(`/api/cameras/cam1/clips/${noSnap.id}.jpg`).set(auth())).status).toBe(404);
    expect((await request(p.proxy.app).get('/api/cameras/cam1/clips/999999.mp4').set(auth())).status).toBe(404);
    expect((await request(p.proxy.app).get('/api/cameras/cam1/clips/abc.mp4').set(auth())).status).toBe(400);
    expect((await request(p.proxy.app).get(`/api/cameras/cam9/clips/${withSnap.id}.mp4`).set(auth())).status).toBe(404);
  });

  it('allows the many range requests of a seeking player (the image limit, not the general one)', async () => {
    const url = `/api/cameras/cam1/clips/${withSnap.id}.mp4`;
    for (let i = 0; i < 1250; i += 50) {
      // Through the proxy's own port: 1250 throwaway listen(0) servers could
      // land on a port another local server holds on 127.0.0.1.
      const batch = await Promise.all(Array.from({ length: 50 }, (_, j) => request(p.base).get(url).set(auth()).set('Range', `bytes=${(i + j) % 9000}-${((i + j) % 9000) + 9}`)));
      for (const r of batch) expect(r.status, JSON.stringify(r.body)).toBe(206);
    }
  }, 60_000);
});
