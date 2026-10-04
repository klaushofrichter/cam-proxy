// The still checks API (cams #179, spec 2026-10-04-still-checks-design §5.1, §6).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import sharp from 'sharp';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { insertEvent } from '../src/catalog/events';
import { saveAnalysis } from '../src/catalog/analyses';
import { insertCheck, setCheckImage } from '../src/catalog/still-checks';
import { startSim } from './helpers/sim';
import { ADMIN_TOKEN, CLIENT_TOKEN, auth, startProxy } from './helpers/proxy';
import { startVisionMock, type VisionMock } from './helpers/vision-mock';

const binary = process.env.CAMPROXY_TEST_GO2RTC; // stills need go2rtc (CI has it)
let sim: Awaited<ReturnType<typeof startSim>>;
let p: Awaited<ReturnType<typeof startProxy>>;
let mock: VisionMock;
const M = Math.floor((Date.now() - 10 * 60_000) / 60_000) * 60_000; // a past minute with stills
const KEY = 'k-123456789012';
const records = () => p.proxy.audit.list({ actions: ['still-check'], limit: 500 }).records;
const lastRecord = () => records()[0] as unknown as { event: { outcome: string }; user?: { name: string }; message: string; cam_proxy: Record<string, unknown>; error?: { message: string } };
const post = (at: unknown, token = CLIENT_TOKEN) => request(p.base).post('/api/cameras/cam1/still-checks').set(auth(token)).send({ at });
const setVision = (googleVision: object) => request(p.base).put('/control/config').set(auth(ADMIN_TOKEN)).send({ analytics: { googleVision } });

beforeAll(async () => {
  sim = await startSim();
  mock = await startVisionMock({ key: KEY });
  p = await startProxy(sim, { env: { CAMPROXY_GOOGLE_VISION_KEY: KEY, CAMPROXY_GOOGLE_VISION_URL: mock.url } });
  if (binary) {
    const tile = await sharp({ create: { width: 160, height: 90, channels: 3, background: '#222' } }).jpeg().toBuffer();
    for (let i = 0; i < 4; i++) {
      const still = await sharp({ create: { width: 64, height: 36, channels: 3, background: { r: i * 60, g: 10, b: 10 } } }).jpeg().toBuffer();
      p.proxy.stills!.store.add({ ts: M + i * 1000, still, tile });
    }
    await p.proxy.stills!.store.flush();
  }
}, 60_000);
afterAll(async () => {
  await p.proxy.stop();
  await sim.close();
  await mock.close();
});

describe('POST still-checks: the request', () => {
  it('needs a client token (or an admin); the audit token and none are refused', async () => {
    expect((await request(p.base).post('/api/cameras/cam1/still-checks').send({ at: M })).status).toBe(401);
    expect((await request(p.base).get('/api/cameras/cam1/still-checks?from=0&to=1')).status).toBe(401);
    expect((await request(p.base).get('/api/cameras/cam1/analytics')).status).toBe(401);
  });

  it('a cookie session needs the CSRF header', async () => {
    const login = await request(p.base).post('/control/login').send({ token: ADMIN_TOKEN });
    const cookie = String(login.headers['set-cookie']).split(';')[0];
    const no = await request(p.base).post('/api/cameras/cam1/still-checks').set('Cookie', cookie).send({ at: M });
    expect(no.status).toBe(403);
    expect(no.body).toEqual({ error: 'csrf' });
    // With it the request is taken (Vision is off here: 409).
    const yes = await request(p.base).post('/api/cameras/cam1/still-checks').set('Cookie', cookie).set('X-CamProxy-UI', '1').send({ at: M });
    expect(yes.status).toBe(409);
    expect(lastRecord()).toMatchObject({ user: { name: 'admin' }, cam_proxy: { requestedBy: 'session', outcome: 'refused', reason: 'off' } });
  });

  it.each([
    [undefined, 'at (unix ms) is required'],
    ['1700000000000', 'at is a whole number (unix ms)'],
    [1.5, 'at is a whole number (unix ms)'],
    [-1000, 'at is a whole number (unix ms)'],
    [Number.MAX_SAFE_INTEGER + 1, 'at is a whole number (unix ms)'],
    [Date.now() - 60_000 + 1, 'at is a whole second'],
  ])('400 invalid for at %j', async (at, detail) => {
    const before = records().length;
    const r = await post(at);
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: 'invalid', detail });
    expect(records().length).toBe(before); // a bad request writes nothing
  });

  it('400 for a second in the future or older than the stills kept', async () => {
    const future = await post(Math.ceil(Date.now() / 1000) * 1000 + 60_000);
    expect(future.body).toEqual({ error: 'invalid', detail: 'at is in the future' });
    const old = await post(Math.floor((Date.now() - 9 * 86_400_000) / 1000) * 1000);
    expect(old.status).toBe(400);
    expect(old.body).toEqual({ error: 'invalid', detail: 'at is older than the stills kept (7 days)' });
  });

  it('404 for another camera; 400 for a body that is not JSON', async () => {
    expect((await request(p.base).post('/api/cameras/cam9/still-checks').set(auth()).send({ at: M })).status).toBe(404);
    const r = await request(p.base).post('/api/cameras/cam1/still-checks').set(auth()).set('Content-Type', 'application/json').send('{');
    expect(r.status).toBe(400);
  });

  it('409 analytics_off while Vision is off, audited as refused at no cost', async () => {
    const r = await post(M);
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ error: 'analytics_off', reason: 'off' });
    expect(lastRecord()).toMatchObject({ event: { outcome: 'failure' }, user: { name: 'client' }, cam_proxy: { stillTs: M, outcome: 'refused', reason: 'off', cost: 0, requestedBy: 'token' } });
  });
});

describe('still checks: reuse, reads and the image', () => {
  it('answers a second the automatic analysis sent from it (no call, no key needed in the answer)', async () => {
    const c = p.proxy.catalog;
    const e = insertEvent(c, { cam: 'cam1', source: 'onvif', kind: 'person', start_ts: M + 30_000, raw: null });
    const summary = [{ category: 'person', subtype: 'person', score: 0.84, box: { x0: 0.1, y0: 0.1, x1: 0.4, y1: 0.9 } }];
    saveAnalysis(c, { event_id: e.id, provider: 'google-vision', status: 'ok', reason: null, still_ts: M + 31_000, image: join(p.dir, 'data', 'analytics', 'cam1', `${e.id}.jpg`), requested_at: M + 32_000, took_ms: 500, objects: '[]', raw: '{"secret":1}', summary: JSON.stringify(summary) });
    const before = mock.calls;
    const r = await post(M + 31_000);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      reused: true, source: 'event',
      check: { id: null, eventId: e.id, stillTs: M + 31_000, provider: 'google-vision', summary, objects: [], events: [{ id: e.id, kind: 'person', confirmed: true }], imageUrl: `/api/cameras/cam1/events/${e.id}/analysis.jpg`, requestedAt: M + 32_000, tookMs: 500 },
    });
    expect(mock.calls).toBe(before);
    expect(lastRecord()).toMatchObject({ event: { outcome: 'success' }, cam_proxy: { outcome: 'reused', source: 'event', cost: 0, found: ['person'] } });
  });

  it('lists checks of a range, serves one with raw, and its JPEG; 404 for unknown ids', async () => {
    const c = p.proxy.catalog;
    const at = M - 120_000; // before the open person event above: in no event
    const row = insertCheck(c, { cam: 'cam1', still_ts: at, provider: 'google-vision', requested_at: at + 1000, requested_via: 'token', took_ms: 610, objects: '[{"name":"Dog","score":0.6}]', raw: '{"r":2}', summary: '[]' });
    const img = join(p.dir, 'data', 'still-checks', 'cam1', `check-${row.id}.jpg`);
    const { mkdirSync } = await import('fs');
    mkdirSync(join(p.dir, 'data', 'still-checks', 'cam1'), { recursive: true });
    writeFileSync(img, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    setCheckImage(c, row.id, img);
    const list = await request(p.base).get(`/api/cameras/cam1/still-checks?from=${at - 1}&to=${at + 1}`).set(auth());
    expect(list.status).toBe(200);
    expect(list.body).toEqual([{ id: row.id, stillTs: at, provider: 'google-vision', summary: [], events: [], imageUrl: `/api/cameras/cam1/still-checks/${row.id}.jpg` }]);
    const one = await request(p.base).get(`/api/cameras/cam1/still-checks/${row.id}`).set(auth());
    expect(one.body).toEqual({ id: row.id, stillTs: at, provider: 'google-vision', summary: [], objects: [{ name: 'Dog', score: 0.6 }], events: [], imageUrl: `/api/cameras/cam1/still-checks/${row.id}.jpg`, requestedAt: at + 1000, tookMs: 610, raw: { r: 2 } });
    const jpg = await request(p.base).get(`/api/cameras/cam1/still-checks/${row.id}.jpg`).set(auth());
    expect(jpg.status).toBe(200);
    expect(jpg.headers['content-type']).toBe('image/jpeg');
    expect(jpg.headers['cache-control']).toMatch(/immutable/);
    for (const path of ['999999', '999999.jpg', 'abc', '1.png', '..%2Fcatalog.sqlite']) {
      const r = await request(p.base).get(`/api/cameras/cam1/still-checks/${path}`).set(auth());
      expect([path, r.status]).toEqual([path, /^\d+(\.jpg)?$/.test(path) ? 404 : 400]);
    }
    expect((await request(p.base).get(`/api/cameras/cam9/still-checks/${row.id}`).set(auth())).status).toBe(404);
  });

  it('never serves an image path outside the still-checks folder', async () => {
    const c = p.proxy.catalog;
    const row = insertCheck(c, { cam: 'cam1', still_ts: M + 50_000, provider: 'google-vision', requested_at: M, requested_via: 'token', took_ms: 1, objects: '[]', raw: null, summary: '[]' });
    setCheckImage(c, row.id, join(p.dir, 'data', 'catalog.sqlite'));
    expect((await request(p.base).get(`/api/cameras/cam1/still-checks/${row.id}.jpg`).set(auth())).status).toBe(404);
    expect((await request(p.base).get(`/api/cameras/cam1/still-checks/${row.id}`).set(auth())).body.imageUrl).toMatch(/\.jpg$/);
    // An existing JPEG in the analytics folder is not a check's either.
    const { mkdirSync } = await import('fs');
    mkdirSync(join(p.dir, 'data', 'analytics', 'cam1'), { recursive: true });
    const other = join(p.dir, 'data', 'analytics', 'cam1', 'x.jpg');
    writeFileSync(other, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    setCheckImage(c, row.id, other);
    expect((await request(p.base).get(`/api/cameras/cam1/still-checks/${row.id}.jpg`).set(auth())).status).toBe(404);
  });

  it('rejects a missing, reversed or longer-than-31-days range', async () => {
    for (const q of ['', '?from=5', '?from=5&to=4', `?from=0&to=${31 * 86_400_000 + 1}`, '?from=a&to=b', '?from=0&to=5&limit=x']) {
      const r = await request(p.base).get(`/api/cameras/cam1/still-checks${q}`).set(auth());
      expect([q, r.status, r.body.error]).toEqual([q, 400, 'invalid']);
    }
  });

  it('GET analytics: the budget for the button, never the key', async () => {
    await setVision({ enabled: false, monthlyLimit: 0, dailyCap: 0, checksPerDay: 10 });
    const r = await request(p.base).get('/api/cameras/cam1/analytics').set(auth());
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ enabled: false, paused: null, month: { calls: expect.any(Number), limit: 0 }, today: { calls: expect.any(Number), cap: 0 }, checks: { today: expect.any(Number), cap: 10 } });
    expect(JSON.stringify(r.body)).not.toContain('k-12');
    expect((await request(p.base).get('/api/cameras/cam9/analytics').set(auth())).status).toBe(404);
  });
});

describe.skipIf(!binary)('still checks: calls through the vision mock', () => {
  it('201 with the check, then 200 reused; the stream carries still-check; audited with cost', async () => {
    await setVision({ enabled: true, monthlyLimit: 100, dailyCap: 0, checksPerDay: 10 });
    mock.script = [];
    const before = mock.calls;
    const r = await post(M + 1000);
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ reused: false, check: { stillTs: M + 1000, provider: 'google-vision', summary: [expect.objectContaining({ category: 'person' })], objects: [expect.objectContaining({ name: 'Person' })], events: [], imageUrl: expect.stringMatching(/^\/api\/cameras\/cam1\/still-checks\/\d+\.jpg$/) } });
    expect(typeof r.body.check.id).toBe('number');
    expect(mock.calls).toBe(before + 1);
    expect(lastRecord()).toMatchObject({ event: { outcome: 'success' }, cam_proxy: { stillTs: M + 1000, outcome: 'ok', cost: 1, found: ['person'], requestedBy: 'token' } });
    expect(lastRecord().cam_proxy.tookMs).toEqual(expect.any(Number));
    const again = await post(M + 1000, ADMIN_TOKEN);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ reused: true, source: 'check', check: { id: r.body.check.id } });
    expect(mock.calls).toBe(before + 1);
    const msgs = p.proxy.log.since(0, { types: ['still-check'] }, 100);
    expect(msgs.at(-1)?.data).toMatchObject({ id: r.body.check.id, stillTs: M + 1000 });
    const jpg = await request(p.base).get(r.body.check.imageUrl).set(auth());
    expect(jpg.status).toBe(200);
  });

  it('404 no_still for a second without a still (nothing audited)', async () => {
    const before = records().length;
    const r = await post(M + 30_000 + 5000);
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: 'no_still' });
    expect(records().length).toBe(before);
  });

  it('429 limit with the reason; 502 provider_failed; 503 paused', async () => {
    await setVision({ checksPerDay: 1 });
    const limited = await post(M + 2000);
    expect(limited.status).toBe(429);
    expect(limited.body).toEqual({ error: 'limit', reason: 'checks' });
    await setVision({ checksPerDay: 10 });
    mock.script = [{ status: 500 }];
    const failed = await post(M + 2000);
    expect(failed.status).toBe(502);
    expect(failed.body).toEqual({ error: 'provider_failed', reason: 'http_5xx' });
    expect(lastRecord()).toMatchObject({ event: { outcome: 'failure' }, error: { message: 'http_5xx' }, cam_proxy: { outcome: 'failed', cost: 1 } });
    mock.script = [{ status: 429 }];
    expect((await post(M + 2000)).body).toEqual({ error: 'provider_failed', reason: 'quota' });
    const paused = await post(M + 2000);
    expect(paused.status).toBe(503);
    expect(paused.body).toEqual({ error: 'analytics_paused', reason: 'quota', until: expect.any(Number) });
    mock.script = [];
    await setVision({ enabled: false }); // a settings change does not lift a quota pause; off for the next tests
  });

  it('20 requests a minute per client, then 429 rate_limited', async () => {
    let limited = 0;
    for (let i = 0; i < 25; i++) if ((await post(M + 3000)).status === 429) limited++;
    expect(limited).toBeGreaterThan(0);
    expect((await post(M + 3000)).body).toEqual({ error: 'rate_limited' });
  });
});
