import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { startSim } from './helpers/sim';
import { startProxy, auth, until, CLIENT_TOKEN } from './helpers/proxy';
import { insertEvent, closeEvent } from '../src/catalog/events';

let sim: Awaited<ReturnType<typeof startSim>>;
let p: Awaited<ReturnType<typeof startProxy>>;
beforeAll(async () => {
  sim = await startSim();
  p = await startProxy(sim);
  const c = p.proxy.catalog;
  closeEvent(c, insertEvent(c, { cam: 'cam1', source: 'onvif', kind: 'person', start_ts: 1000, raw: null }).id, 2000, 'state');
  insertEvent(c, { cam: 'cam1', source: 'poll', kind: 'vehicle', start_ts: 3000, raw: null });
  await until(async () => (await request(p.base).get('/api/cameras').set(auth())).body[0]?.online === true);
});
afterAll(async () => {
  await p.proxy.stop();
  await sim.close();
});

describe('client API', () => {
  it('answers /health without a token', async () => {
    expect((await request(p.base).get('/health')).body).toEqual({ ok: true, version: 'dev' });
  });

  it('needs a valid bearer token, and refuses one in the URL', async () => {
    expect((await request(p.base).get('/api/cameras')).status).toBe(401);
    expect((await request(p.base).get('/api/cameras').set(auth('x'.repeat(40)))).status).toBe(401);
    const inUrl = await request(p.base).get(`/api/cameras?token=${CLIENT_TOKEN}`).set(auth());
    expect(inUrl.status).toBe(400);
    expect(inUrl.body).toEqual({ error: 'token_in_url' });
    expect((await request(p.base).get('/api/cameras?access_token=x').set(auth())).status).toBe(400);
  });

  it('lists the camera with its state', async () => {
    const r = await request(p.base).get('/api/cameras').set(auth());
    expect(r.body).toEqual([{ id: 'cam1', name: 'Den', online: true, lastEventTs: 3000, stream: process.env.CAMPROXY_TEST_GO2RTC ? expect.objectContaining({ up: expect.any(Boolean) }) : null, publicUrl: null }]);
  });

  it('names its own web address when server.publicUrl is set (cams links to it)', async () => {
    const q = await startProxy(sim, { settings: { server: { logLevel: 'silent', publicUrl: 'https://proxy.example' } } });
    try {
      expect((await request(q.base).get('/api/cameras').set(auth())).body[0].publicUrl).toBe('https://proxy.example');
    } finally {
      await q.proxy.stop();
    }
  });

  it('lists events, newest first, with filters', async () => {
    const all = await request(p.base).get('/api/cameras/cam1/events').set(auth());
    expect(all.body.map((e: { kind: string }) => e.kind)).toEqual(['vehicle', 'person']);
    expect(all.body[1]).toEqual({ id: 1, kind: 'person', source: 'onvif', start: 1000, end: 2000, endReason: 'state', analysis: null });
    const person = await request(p.base).get('/api/cameras/cam1/events?kind=person&from=500&to=1500&limit=5').set(auth());
    expect(person.body).toHaveLength(1);
    expect((await request(p.base).get('/api/cameras/cam1/events?from=abc').set(auth())).status).toBe(400);
    expect((await request(p.base).get('/api/cameras/nope/events').set(auth())).status).toBe(404);
  });

  it('answers unknown routes with JSON 404', async () => {
    const r = await request(p.base).get('/api/nothing').set(auth());
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: 'not_found' });
  });

  it('limits any one client to 1200 requests a minute', async () => {
    const agent = request.agent(p.base);
    let last = 0;
    for (let i = 0; i < 1201 && last !== 429; i++) last = (await agent.get('/health')).status;
    expect(last).toBe(429);
  }, 60000);
});
