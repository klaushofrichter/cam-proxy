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

  // #78: Express answers HEAD with the GET route; the guard let only GET through.
  it('answers HEAD like GET for admins and the audit token, still refusing the client token', async () => {
    for (const t of [ADMIN_TOKEN, AUDIT_TOKEN]) {
      const r = await request(p.base).head('/control/audit').set(auth(t));
      expect(r.status).toBe(200);
      expect(r.headers['content-type']).toMatch(/application\/x-ndjson/);
    }
    expect((await request(p.base).head('/control/audit').set(auth(CLIENT_TOKEN))).status).toBe(403);
    expect((await request(p.base).head('/control/audit')).status).toBe(401);
  });

  // Review 2026-10-01: the access check sits on the handler's own route, so
  // every path Express routes to it (case, trailing slash, encoding) is guarded.
  it('guards every spelling of the path that reaches the handler', async () => {
    for (const path of ['/control/AUDIT', '/control/Audit', '/control/audit/', '/control//audit', '/control/%61udit']) {
      const none = (await request(p.base).get(path)).status;
      expect([401, 404], `none ${path}`).toContain(none);
      const client = (await request(p.base).get(path).set(auth(CLIENT_TOKEN))).status;
      expect([403, 404], `client ${path}`).toContain(client);
      const admin = (await request(p.base).get(path).set(auth(ADMIN_TOKEN))).status;
      const audit = (await request(p.base).get(path).set(auth(AUDIT_TOKEN))).status;
      // The handler answers both, or neither: the audit token then meets the admin-only routes.
      if (admin === 200) expect(audit, `audit ${path}`).toBe(200);
      else expect([admin, audit], path).toEqual([404, 403]);
    }
    for (const path of ['/control/AUDIT', '/control/Audit', '/control/audit/']) expect((await request(p.base).get(path).set(auth(AUDIT_TOKEN))).status, path).toBe(200);
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

  it('records the camera-side restart as a control-action (restart), by session or token', async () => {
    const restarts = () => p.proxy.audit.list({ actions: ['control-action'] }).records.filter((x) => (x.cam_proxy as { action?: string }).action === 'restart');
    const r = await request(p.base).post('/control/actions/restart').set(auth(ADMIN_TOKEN));
    expect(r.status).toBe(202);
    await until(() => restarts().length === 1);
    expect(restarts()[0]).toMatchObject({ event: { category: ['configuration'], type: ['change'], outcome: 'success' }, user: { name: 'admin' }, cam_proxy: { action: 'restart', result: 'ok', requestedBy: 'token' } });
    const login = await request(p.base).post('/control/login').send({ token: ADMIN_TOKEN });
    const cookie = String(login.headers['set-cookie']).split(';')[0];
    expect((await request(p.base).post('/control/actions/restart').set('Cookie', cookie).set('x-camproxy-ui', '1')).status).toBe(202);
    await until(() => restarts().length === 2);
    expect(restarts()[0]).toMatchObject({ user: { name: 'admin' }, cam_proxy: { requestedBy: 'session' } });
    // proxy-restart now means only the process restart (#71)
    expect(p.proxy.audit.list({ actions: ['proxy-restart'] }).records).toHaveLength(0);
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

describe('proxy-start after a stop or a crash', () => {
  it('flags an unclean stop when no proxy-stop is between two starts, and not after a clean one', async () => {
    const sim2 = await startSim();
    const a = await startProxy(sim2, {});
    const dir = a.dir;
    const starts = (pp: typeof a) => pp.proxy.audit.list({ actions: ['proxy-start'], limit: 10 }).records.map((r) => (r as unknown as { cam_proxy: { previousStop: string | null; uncleanStop: boolean } }).cam_proxy);
    expect(starts(a)[0]).toMatchObject({ previousStop: null, uncleanStop: false }); // the first start ever
    await a.proxy.stop(); // clean: start, stop
    const b = await startProxy(sim2, { dir });
    const [second] = starts(b);
    expect(second.uncleanStop).toBe(false);
    expect(typeof second.previousStop).toBe('string');
    // b never stops: a crash. The next start sees a start as the newest record.
    const c = await startProxy(sim2, { dir });
    expect(starts(c)[0]).toMatchObject({ previousStop: null, uncleanStop: true });
    await c.proxy.stop();
    await b.proxy.stop();
    await sim2.close();
  });
});

describe('stop', () => {
  it('is idempotent: a second call returns the same promise and writes no second proxy-stop', async () => {
    const sim2 = await startSim();
    const a = await startProxy(sim2, {});
    const first = a.proxy.stop({ reason: 'SIGTERM' });
    const second = a.proxy.stop({ reason: 'SIGINT' });
    expect(second).toBe(first);
    await Promise.all([first, second]);
    const stops = a.proxy.audit.list({ actions: ['proxy-stop'], limit: 10 }).records;
    expect(stops).toHaveLength(1);
    await sim2.close();
  });
});
