// test/compose-api.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { join } from 'path';
import { startSim } from './helpers/sim';
import { startProxy, auth, until } from './helpers/proxy';
import { insertClip } from '../src/catalog/clips';
import { defaultFont } from '../src/compose/ffmpeg';

const run = promisify(execFile);
let sim: Awaited<ReturnType<typeof startSim>>;
let p: Awaited<ReturnType<typeof startProxy>>;
let clipId = 0;
let silentId = 0;
const T = Date.UTC(2026, 8, 28, 19, 0, 0);

beforeAll(async () => {
  sim = await startSim();
  p = await startProxy(sim);
  const withAudio = join(p.dir, 'a.mp4');
  const silent = join(p.dir, 's.mp4');
  await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=10', '-f', 'lavfi', '-i', 'sine=r=16000', '-t', '6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', withAudio]);
  await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=10', '-t', '4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', silent]);
  const cam = p.proxy.running.camera.id;
  clipId = insertClip(p.proxy.catalog, { cam, start_ts: T, end_ts: T + 6000, path: withAudio, stream: 'sub', size: 1, received_at: T, snapshot: null }).id;
  silentId = insertClip(p.proxy.catalog, { cam, start_ts: T + 20_000, end_ts: T + 24_000, path: silent, stream: 'sub', size: 1, received_at: T, snapshot: null }).id;
});
afterAll(async () => {
  await p.proxy.stop();
  await sim.close();
});

const cam = () => p.proxy.running.camera.id;
const post = (body: object) => request(p.base).post(`/api/cameras/${cam()}/compositions`).set(auth()).send(body);

describe('compositions API', () => {
  it('refuses bad input and unknown clips', async () => {
    expect((await post({ clipId, preS: 99, postS: 0, size: 'sd', badge: true })).status).toBe(400);
    expect((await post({ clipId, preS: 0, postS: 0, size: '4k', badge: true })).status).toBe(400);
    expect((await post({ clipId, preS: 0, postS: 0, size: 'sd', badge: true, timeZone: 'Mars/Olympus' })).status).toBe(400);
    expect((await post({ clipId: 999_999, preS: 0, postS: 0, size: 'sd', badge: true })).status).toBe(404);
    expect((await request(p.base).post('/api/cameras/nope/compositions').set(auth()).send({ clipId, preS: 0, postS: 0, size: 'sd', badge: true })).status).toBe(404);
    expect((await request(p.base).post(`/api/cameras/${cam()}/compositions`).send({})).status).toBe(401);
  });

  it.skipIf(!defaultFont())('composes a clip with cards and a silent clip after it, and serves the result', async () => {
    const r = await post({ clipId, preS: 2, postS: 20, size: '360p', badge: true, timeZone: 'America/Chicago' }); // 2 cards, 6 s clip, 14 cards, 4 s silent clip, 2 cards → 28 s
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ state: expect.stringMatching(/queued|running/), durationS: 28 });
    const id = r.body.id as string;
    await until(async () => (await request(p.base).get(`/api/cameras/${cam()}/compositions/${id}`).set(auth())).body.state === 'done', 60_000);
    const mp4 = await request(p.base).get(`/api/cameras/${cam()}/compositions/${id}.mp4`).set(auth()).buffer(true).parse((res, cb) => { const b: Buffer[] = []; res.on('data', (c: Buffer) => b.push(c)); res.on('end', () => cb(null, Buffer.concat(b))); });
    expect(mp4.status).toBe(200);
    expect(mp4.headers['content-type']).toBe('video/mp4');
    expect((mp4.body as Buffer).subarray(4, 8).toString()).toBe('ftyp');
    expect((await request(p.base).delete(`/api/cameras/${cam()}/compositions/${id}`).set(auth())).status).toBe(204);
    expect((await request(p.base).get(`/api/cameras/${cam()}/compositions/${id}`).set(auth())).status).toBe(404);
  }, 90_000);

  it.skipIf(!defaultFont())('answers 409 for a result that is not ready, and hides jobs from other cameras', async () => {
    const r = await post({ clipId: silentId, preS: 0, postS: 30, size: 'sd', badge: false });
    const id = r.body.id as string;
    const early = await request(p.base).get(`/api/cameras/${cam()}/compositions/${id}.mp4`).set(auth());
    expect([409, 200]).toContain(early.status); // 200 only if the encode already finished
    expect((await request(p.base).get(`/api/cameras/other/compositions/${id}`).set(auth())).status).toBe(404);
    await request(p.base).delete(`/api/cameras/${cam()}/compositions/${id}`).set(auth());
  }, 30_000);
});
