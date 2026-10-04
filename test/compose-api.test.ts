// test/compose-api.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { join } from 'path';
import { readdirSync } from 'fs';
import { startSim } from './helpers/sim';
import { startProxy, auth, until } from './helpers/proxy';
import { insertClip } from '../src/catalog/clips';
import { defaultFont } from '../src/compose/ffmpeg';
import sharp from 'sharp';

const run = promisify(execFile);
let sim: Awaited<ReturnType<typeof startSim>>;
let p: Awaited<ReturnType<typeof startProxy>>;
let clipId = 0;
let silentId = 0;
let longId = 0;
const T = Date.UTC(2026, 8, 28, 19, 0, 0);
// Around a second (#179 phase 3): a past minute with stills in its first
// 50 s and a 15 s FTP clip from :30 (stills need go2rtc, as in CI).
const go2rtc = process.env.CAMPROXY_TEST_GO2RTC;
const M = Math.floor((Date.now() - 10 * 60_000) / 60_000) * 60_000;
let edgeClipId = 0;

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
  // An FTP copy longer than the SD recording the viewer chose (cams's Save
  // dialog, 2026-10-04): 245 s from 131 s before the recording's start.
  longId = insertClip(p.proxy.catalog, { cam, start_ts: T + 3_600_000 - 131_000, end_ts: T + 3_600_000 + 114_000, path: withAudio, stream: 'sub', size: 1, received_at: T, snapshot: null }).id;
  const clip15 = join(p.dir, 'c15.mp4');
  await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=10', '-t', '15', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', clip15]);
  edgeClipId = insertClip(p.proxy.catalog, { cam, start_ts: M + 30_000, end_ts: M + 45_000, path: clip15, stream: 'sub', size: 1, received_at: M, snapshot: null }).id;
  if (go2rtc) {
    const tile = await sharp({ create: { width: 160, height: 90, channels: 3, background: '#222' } }).jpeg().toBuffer();
    const still = await sharp({ create: { width: 640, height: 360, channels: 3, background: '#345' } }).jpeg().toBuffer();
    for (let i = 0; i < 50; i++) p.proxy.stills!.store.add({ ts: M + i * 1000, still, tile });
    await p.proxy.stills!.store.flush();
  }
}, 60_000);
afterAll(async () => {
  await p.proxy.stop();
  await sim.close();
});

const cam = () => p.proxy.running.camera.id;
const post = (body: object) => request(p.base).post(`/api/cameras/${cam()}/compositions`).set(auth()).send(body);

describe('compositions API', () => {
  it('refuses bad input and unknown clips', async () => {
    expect((await post({ clipId, preS: 3601, postS: 0, size: 'sd', badge: true })).status).toBe(400);
    expect((await post({ clipId, preS: 0, postS: 295, size: 'sd', badge: true })).body).toEqual({ error: 'invalid', detail: 'at most 300 s (5:00)' }); // 6 + 295
    expect((await post({ clipId, preS: 0, postS: 115, size: '1080p', badge: true })).body).toEqual({ error: 'invalid', detail: 'at most 120 s (2:00)' });
    expect((await post({ clipId, preS: 0, postS: 0, size: 'sd', badge: true, span: { start: T, end: 'x' } })).body).toMatchObject({ error: 'invalid', detail: expect.stringMatching(/^span/) });
    expect((await post({ clipId, preS: 0, postS: 0, size: 'sd', badge: true, span: { start: T + 10_000, end: T } })).status).toBe(400);
    // The span must overlap the clip (T … T+6 s) by at least 1 s: another recording's span is refused.
    const elsewhere = await post({ clipId, preS: 0, postS: 0, size: 'sd', badge: true, span: { start: T + 60_000, end: T + 80_000 } });
    expect(elsewhere.status).toBe(400);
    expect(elsewhere.body).toEqual({ error: 'invalid', detail: 'span must overlap the clip by at least 1 s' });
    expect((await post({ clipId, preS: 0, postS: 0, size: 'sd', badge: true, span: { start: T + 5_500, end: T + 20_000 } })).body).toEqual({ error: 'invalid', detail: 'span must overlap the clip by at least 1 s' }); // 0.5 s
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

  // Image 16 of 2026-10-04: a 114 s SD recording, pre-roll -100, post-roll
  // 30 is 44 s, also when the proxy's copy of it is longer.
  it.skipIf(!defaultFont())('applies the rolls to the span cams sends (114 s, -100, +30 → 44 s)', async () => {
    const span = { start: T + 3_600_000, end: T + 3_600_000 + 114_000 };
    const r = await post({ clipId: longId, span, preS: -100, postS: 30, size: 'sd', badge: false });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ durationS: 44 });
    await request(p.base).delete(`/api/cameras/${cam()}/compositions/${r.body.id as string}`).set(auth());
    // Without a span the rolls apply to the proxy's own clip (245 s - 100 s).
    const own = await post({ clipId: longId, preS: -100, postS: 0, size: 'sd', badge: false });
    expect(own.body).toMatchObject({ durationS: 145 });
    await request(p.base).delete(`/api/cameras/${cam()}/compositions/${own.body.id as string}`).set(auth());
  }, 30_000);

  it.skipIf(!defaultFont())('answers 409 for a result that is not ready, and hides jobs from other cameras', async () => {
    const r = await post({ clipId: silentId, preS: 0, postS: 30, size: 'sd', badge: false });
    const id = r.body.id as string;
    const early = await request(p.base).get(`/api/cameras/${cam()}/compositions/${id}.mp4`).set(auth());
    expect([409, 200]).toContain(early.status); // 200 only if the encode already finished
    expect((await request(p.base).get(`/api/cameras/other/compositions/${id}`).set(auth())).status).toBe(404);
    await request(p.base).delete(`/api/cameras/${cam()}/compositions/${id}`).set(auth());
  }, 30_000);
});

// Phase 3 of #179 (spec 2026-10-04-still-checks-design §13): `at` instead of
// `clipId`, the window [at - pre, at + 1 s + post].
const records = () => p.proxy.audit.list({ actions: ['composition'], limit: 500 }).records as unknown as { event: { outcome: string }; user?: { name: string }; message: string; cam_proxy: Record<string, unknown>; error?: { message: string } }[];
const around = (at: unknown, more: object = {}) => post({ at, preS: 10, postS: 10, size: 'sd', badge: true, ...more });
const nowSecond = () => Math.floor(Date.now() / 1000) * 1000;

describe('compositions around a second: the request', () => {
  it.each([
    [{ clipId: 1, at: M }, 'exactly one of clipId (a clip) or at (a second, unix ms)'],
    [{ at: undefined }, 'exactly one of clipId (a clip) or at (a second, unix ms)'],
    [{ at: String(M) }, 'at is a whole number (unix ms)'],
    [{ at: M + 0.5 }, 'at is a whole number (unix ms)'],
    [{ at: -1000 }, 'at is a whole number (unix ms)'],
    [{ at: M + 1 }, 'at is a whole second'],
    [{ at: M, span: { start: M, end: M + 1000 } }, 'span goes with clipId, not with at'],
    [{ at: M, preS: -1 }, 'around a second, pre-roll and post-roll are whole seconds from 0 to 3600'],
    [{ at: M, postS: 3601 }, 'around a second, pre-roll and post-roll are whole seconds from 0 to 3600'],
    [{ at: M, preS: 150, postS: 150 }, 'at most 300 s (5:00)'],
    [{ at: M, preS: 60, postS: 60, size: '1080p' }, 'at most 120 s (2:00)'],
    [{ at: M, dryRun: 'yes' }, 'dryRun is true or false'],
  ])('400 invalid for %j', async (body, detail) => {
    const before = records().length;
    const r = await post({ preS: 10, postS: 10, size: 'sd', badge: true, ...body });
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: 'invalid', detail });
    expect(records().length).toBe(before); // a bad request writes nothing
  });

  it('400 for a second in the future, older than the sources kept, or a window not yet over', async () => {
    expect((await around(nowSecond() + 60_000)).body).toEqual({ error: 'invalid', detail: 'at is in the future' });
    expect((await around(nowSecond() - 9 * 86_400_000)).body).toEqual({ error: 'invalid', detail: 'at is older than the stills and clips kept (7 days)' });
    const r = await around(nowSecond() - 2000);
    expect(r.status).toBe(400);
    expect(r.body.detail).toMatch(/^the window ends in the future \(\d+ s from now\)$/);
  });

  it('409 nothing_to_compose where no clip or still covers any second, also as a dry run', async () => {
    const at = M - 5 * 60_000;
    const dry = await around(at, { dryRun: true });
    expect(dry.status).toBe(409);
    expect(dry.body).toEqual({ error: 'nothing_to_compose', detail: 'no clip or still covers any second of this window' });
    const before = records().length;
    const r = await around(at);
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('nothing_to_compose');
    expect(records().length).toBe(before + 1);
    expect(records()[0]).toMatchObject({ event: { outcome: 'failure' }, user: { name: 'client' }, error: { message: 'nothing_to_compose' }, cam_proxy: { anchor: 'at', at, from: at - 10_000, to: at + 11_000, durationS: 21, size: 'sd', outcome: 'nothing_to_compose', seconds: { clip: 0, still: 0, card: 21 }, jobId: null, requestedBy: 'token' } });
  });

  it('a dry run over the clip\'s edge: stills before it, the clip after, no job and no record', async () => {
    const before = records().length;
    const jobs = () => readdirSync(join(p.proxy.running.server.dataDir, 'compositions')).length; // each job has its folder
    const jobsBefore = jobs();
    const r = await post({ at: M + 30_000, preS: 5, postS: 5, size: 'sd', badge: true, dryRun: true });
    expect(r.status).toBe(200);
    expect(jobs()).toBe(jobsBefore);
    expect(r.body).toEqual({ start: M + 25_000, end: M + 36_000, durationS: 11, seconds: go2rtc ? { clip: 6, still: 5, card: 0 } : { clip: 6, still: 0, card: 5 }, clips: [{ start: M + 30_000, end: M + 45_000 }] });
    expect(records().length).toBe(before);
  });

  it.skipIf(!go2rtc)('a dry run on stills only, with a gap at the end as cards', async () => {
    const r = await post({ at: M + 10_000, preS: 10, postS: 10, size: 'sd', badge: true, dryRun: true });
    expect(r.body).toEqual({ start: M, end: M + 21_000, durationS: 21, seconds: { clip: 0, still: 21, card: 0 }, clips: [] });
    // Stills end at :49, the clip ends at :45: :50 and later are cards.
    const gap = await post({ at: M + 52_000, preS: 3, postS: 3, size: 'sd', badge: true, dryRun: true });
    expect(gap.body).toMatchObject({ durationS: 7, seconds: { clip: 0, still: 1, card: 6 } });
  });
});

describe('compositions around a second: the result', () => {
  it.skipIf(!defaultFont() || !go2rtc)('encodes a stills-only second (21 s) and audits it', async () => {
    const r = await around(M + 10_000);
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ durationS: 21 });
    const id = r.body.id as string;
    expect(records()[0]).toMatchObject({ event: { outcome: 'success' }, cam_proxy: { anchor: 'at', at: M + 10_000, outcome: 'started', jobId: id, seconds: { clip: 0, still: 21, card: 0 } } });
    await until(async () => (await request(p.base).get(`/api/cameras/${cam()}/compositions/${id}`).set(auth())).body.state === 'done', 60_000);
    const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', join(p.dir, 'compositions', id, `${id}.mp4`)]).catch(() => ({ stdout: '' }));
    if (stdout) expect(Number(stdout)).toBeCloseTo(21, 0);
    await request(p.base).delete(`/api/cameras/${cam()}/compositions/${id}`).set(auth());
  }, 90_000);

  it.skipIf(!defaultFont())('encodes around a clip second (the clip covers all of it)', async () => {
    const r = await post({ at: M + 37_000, preS: 3, postS: 3, size: '360p', badge: false });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ durationS: 7 });
    const id = r.body.id as string;
    expect(records()[0]).toMatchObject({ cam_proxy: { anchor: 'at', seconds: { clip: 7, still: 0, card: 0 } } });
    await until(async () => (await request(p.base).get(`/api/cameras/${cam()}/compositions/${id}`).set(auth())).body.state === 'done', 60_000);
    await request(p.base).delete(`/api/cameras/${cam()}/compositions/${id}`).set(auth());
  }, 90_000);

  it('audits clip-anchored compositions too', async () => {
    const r = await post({ clipId: edgeClipId, preS: 0, postS: 0, size: 'sd', badge: false, dryRun: false });
    expect([201, 429, 503]).toContain(r.status);
    expect(records()[0]).toMatchObject({ cam_proxy: { anchor: 'clip', clipId: edgeClipId, from: M + 30_000, to: M + 45_000, durationS: 15 } });
    if (r.status === 201) await request(p.base).delete(`/api/cameras/${cam()}/compositions/${r.body.id as string}`).set(auth());
  });

  // Last in the file: it uses up this client's minute.
  it('limits real requests to 10 a minute per client; dry runs are not counted', async () => {
    for (let i = 0; i < 12; i++) expect((await post({ at: M + 30_000, preS: 0, postS: 0, size: 'sd', badge: false, dryRun: true })).status).toBe(200);
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) {
      const r = await around(M - 5 * 60_000); // nothing there: 409, no encode
      statuses.push(r.status);
    }
    expect(statuses).toContain(429);
    const limited = await around(M - 5 * 60_000);
    expect(limited.body).toEqual({ error: 'rate_limited' });
  });
});
