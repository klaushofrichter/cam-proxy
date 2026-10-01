import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { ADMIN_TOKEN, CLIENT_TOKEN, auth, startProxy, until } from './helpers/proxy';
import { startSim } from './helpers/sim';

const AUDIT_TOKEN = 'audit-token-'.padEnd(40, 'z');
let sim: Awaited<ReturnType<typeof startSim>>;
let p: Awaited<ReturnType<typeof startProxy>>;
beforeAll(async () => {
  sim = await startSim();
  p = await startProxy(sim, { env: { CAMPROXY_AUDIT_TOKEN: AUDIT_TOKEN } });
});
afterAll(async () => {
  await p.proxy.stop();
  await sim.close();
});

const lines = (text: string) => text.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));

describe('audit API', () => {
  it('records proxy-start with the version and the features', async () => {
    const r = await request(p.base).get('/control/audit?action=proxy-start').set(auth(ADMIN_TOKEN));
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/application\/x-ndjson/);
    const [rec] = lines(r.text);
    expect(rec).toMatchObject({ event: { action: 'proxy-start', category: ['process'], type: ['start'], outcome: 'success' }, user: { name: 'system' }, labels: { camera: 'cam1' } });
    expect(rec.cam_proxy).toMatchObject({ config: { camera: 'cam1' } });
    expect(r.headers['x-has-more']).toBe('false');
    expect(r.headers['x-next-cursor']).toBe(rec.cam_proxy.cursor);
  });

  it('the audit token reads the audit log and nothing else; the client token never reads it', async () => {
    expect((await request(p.base).get('/control/audit').set(auth(AUDIT_TOKEN))).status).toBe(200);
    for (const [method, path] of [['get', '/control/status'], ['get', '/control/config'], ['post', '/control/actions/restart'], ['post', '/control/audit'], ['get', '/api/cameras']] as const) {
      expect((await (request(p.base) as any)[method](path).set(auth(AUDIT_TOKEN))).status, `${method} ${path}`).toBe(path.startsWith('/api') ? 401 : 403);
    }
    expect((await request(p.base).get('/control/audit').set(auth(CLIENT_TOKEN))).status).toBe(403);
    expect((await request(p.base).get('/control/audit')).status).toBe(401);
    expect((await request(p.base).get('/control/audit').set(auth('unknown-token-'.padEnd(40, 'q')))).status).toBe(401);
  });

  it('pages newest first with before, oldest first with after, and answers 400 for bad queries', async () => {
    for (let i = 0; i < 5; i++) p.proxy.audit.write({ action: 'test-entry', category: ['host'], type: ['info'], outcome: 'success', message: `t${i}` });
    const first = await request(p.base).get('/control/audit?action=test-entry&limit=2').set(auth(ADMIN_TOKEN));
    expect(lines(first.text).map((x) => x.message)).toEqual(['t4', 't3']);
    expect(first.headers['x-has-more']).toBe('true');
    const second = await request(p.base).get(`/control/audit?action=test-entry&limit=2&before=${first.headers['x-next-cursor']}`).set(auth(ADMIN_TOKEN));
    expect(lines(second.text).map((x) => x.message)).toEqual(['t2', 't1']);
    const up = await request(p.base).get('/control/audit?action=test-entry&limit=10&after=').set(auth(ADMIN_TOKEN));
    expect(lines(up.text).map((x) => x.message)).toEqual(['t0', 't1', 't2', 't3', 't4']);
    for (const q of ['before=x', 'limit=0', 'limit=999', 'from=5&to=1', 'outcome=maybe', 'before=2026-10-01:1&after=2026-10-01:1', 'limit=abc']) {
      const r = await request(p.base).get(`/control/audit?${q}`).set(auth(ADMIN_TOKEN));
      expect(r.status, q).toBe(400);
      expect(r.body.error).toBe('invalid');
    }
  });

  it('records a restart requested through the control API, by session or token', async () => {
    const r = await request(p.base).post('/control/actions/restart').set(auth(ADMIN_TOKEN));
    expect(r.status).toBe(202);
    await until(() => p.proxy.audit.list({ actions: ['proxy-restart'] }).records.length === 1);
    expect(p.proxy.audit.list({ actions: ['proxy-restart'] }).records[0]).toMatchObject({ event: { category: ['process'], type: ['change'] }, user: { name: 'admin' }, cam_proxy: { requestedBy: 'token' } });
    // the shared proxy still answers after the restart
    expect((await request(p.base).get('/control/audit?limit=1').set(auth(AUDIT_TOKEN))).status).toBe(200);
  });

  it('records proxy-stop with the reason on a clean stop', async () => {
    const q = await startProxy(sim, {});
    await q.proxy.stop({ reason: 'SIGTERM' });
    // the stopped proxy's audit folder still holds the record
    expect(q.proxy.audit.list({ actions: ['proxy-stop'] }).records[0]).toMatchObject({ cam_proxy: { reason: 'SIGTERM' }, event: { type: ['end'] } });
  });
});
