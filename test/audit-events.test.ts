import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { ADMIN_TOKEN, CLIENT_TOKEN, auth, startProxy } from './helpers/proxy';
import { startSim } from './helpers/sim';
import { RefusalThrottle } from '../src/audit/throttle';

let sim: Awaited<ReturnType<typeof startSim>>;
let p: Awaited<ReturnType<typeof startProxy>>;
beforeAll(async () => { sim = await startSim(); p = await startProxy(sim, {}); });
afterAll(async () => { await p.proxy.stop(); await sim.close(); });
const last = (action: string) => p.proxy.audit.list({ actions: [action], limit: 1 }).records[0];
const ui = { 'X-CamProxy-UI': '1' };

describe('RefusalThrottle', () => {
  // Review focus 3.
  it('throttles refusals per ip and path, counting the suppressed ones', () => {
    const now = { t: 0 };
    const t = new RefusalThrottle(600_000, () => now.t);
    expect(t.take('1.1.1.1', '/api/x')).toEqual({ record: true, suppressed: 0 });
    expect(t.take('1.1.1.1', '/api/x').record).toBe(false);
    expect(t.take('1.1.1.1', '/api/x').record).toBe(false);
    expect(t.take('1.1.1.1', '/api/y').record).toBe(true);
    expect(t.take('2.2.2.2', '/api/x').record).toBe(true);
    now.t = 600_001;
    expect(t.take('1.1.1.1', '/api/x')).toEqual({ record: true, suppressed: 2 });
  });
});

describe('audit records', () => {
  it('records a sign-in with the token form, a failed one, and a logout', async () => {
    const bad = await request(p.base).post('/control/login').send({ token: 'wrong' });
    expect(bad.status).toBe(401);
    expect(last('login')).toMatchObject({ event: { outcome: 'failure', category: ['authentication'], type: ['start'] }, cam_proxy: { auth: { method: 'token-form', reason: 'wrong-token' } }, source: { ip: '127.0.0.1' } });
    const ok = await request(p.base).post('/control/login').send({ token: ADMIN_TOKEN });
    expect(ok.status).toBe(204);
    expect(last('login')).toMatchObject({ event: { outcome: 'success' }, user: { name: 'admin' }, cam_proxy: { auth: { method: 'token-form' } } });
    const cookie = ok.headers['set-cookie'][0].split(';')[0];
    await request(p.base).post('/control/logout').set('Cookie', cookie).set(ui);
    expect(last('logout')).toMatchObject({ event: { category: ['authentication'], type: ['end'], outcome: 'success' }, user: { name: 'admin' } });
  });

  it('records a login link issued, used, and a used link refused', async () => {
    const { code } = (await request(p.base).post('/control/login-links').set(auth(ADMIN_TOKEN))).body;
    expect(last('login-link-issued')).toMatchObject({ event: { type: ['creation'] }, user: { name: 'admin' } });
    await request(p.base).get(`/control/login-link?code=${code}`);
    expect(last('login')).toMatchObject({ event: { outcome: 'success' }, cam_proxy: { auth: { method: 'login-link' } } });
    await request(p.base).get(`/control/login-link?code=${code}`);
    expect(last('login')).toMatchObject({ event: { outcome: 'failure' }, cam_proxy: { auth: { method: 'login-link', reason: 'link-used-or-expired' } } });
  });

  it('records refused tokens with their kind, throttled', async () => {
    await request(p.base).get('/api/cameras');
    expect(last('auth-refused')).toMatchObject({ event: { category: ['authentication'], type: ['denied'], outcome: 'failure' }, url: { path: '/api/cameras' }, http: { request: { method: 'GET' } }, cam_proxy: { auth: { tokenKind: 'none', reason: 'no-token' } } });
    await request(p.base).get('/control/status').set(auth(CLIENT_TOKEN));
    expect(last('auth-refused')).toMatchObject({ url: { path: '/control/status' }, cam_proxy: { auth: { tokenKind: 'client', reason: 'admin-only' } } });
    const before = p.proxy.audit.list({ actions: ['auth-refused'], limit: 500 }).records.length;
    for (let i = 0; i < 5; i++) await request(p.base).get('/control/status').set(auth(CLIENT_TOKEN));
    expect(p.proxy.audit.list({ actions: ['auth-refused'], limit: 500 }).records.length).toBe(before);
  });

  it('records control actions with their result, and settings changes old → new', async () => {
    await request(p.base).post('/control/actions/onvif-resubscribe').set(auth(ADMIN_TOKEN));
    expect(last('control-action')).toMatchObject({ event: { category: ['configuration'], type: ['change'], outcome: 'success' }, cam_proxy: { action: 'onvif-resubscribe', result: 'ok' } });
    await request(p.base).post('/control/actions/nope').set(auth(ADMIN_TOKEN));
    expect(last('control-action')).toMatchObject({ event: { outcome: 'failure' }, cam_proxy: { action: 'nope', result: 'not_found' } });
    await request(p.base).post('/control/actions/camera-ftp-test').set(auth(ADMIN_TOKEN));
    expect(last('control-action')).toMatchObject({ event: { outcome: 'failure' }, cam_proxy: { action: 'camera-ftp-test', result: 'not_configured', requestedBy: 'token' } });
    const n = p.proxy.audit.list({ actions: ['control-action'], limit: 500 }).records.length;
    await request(p.base).post('/control/actions/retention-run').set(auth(ADMIN_TOKEN)).send({ dryRun: true });
    expect(p.proxy.audit.list({ actions: ['control-action'], limit: 500 }).records.length).toBe(n);
    await request(p.base).put('/control/config').set(auth(ADMIN_TOKEN)).send({ retention: { auditDays: 30 } });
    expect(last('config-change')).toMatchObject({ cam_proxy: { changes: [{ key: 'retention.auditDays', from: 90, to: 30 }] } });
    await request(p.base).delete('/control/config/retention.auditDays').set(auth(ADMIN_TOKEN));
    expect(last('config-change')).toMatchObject({ cam_proxy: { changes: [{ key: 'retention.auditDays', from: 30, to: 90 }] } });
  });

  it('records a rate-limited sign-in (own proxy: 20 attempts per 15 min)', async () => {
    const q = await startProxy(sim, {});
    try {
      for (let i = 0; i < 20; i++) await request(q.base).post('/control/login').send({ token: 'wrong' });
      const r = await request(q.base).post('/control/login').send({ token: 'wrong' });
      expect(r.status).toBe(429);
      expect(r.body).toEqual({ error: 'too_many_attempts' });
      expect(q.proxy.audit.list({ actions: ['login'], limit: 1 }).records[0]).toMatchObject({ event: { outcome: 'failure' }, message: 'Sign-in refused: too many attempts', cam_proxy: { auth: { method: 'token-form', reason: 'rate-limited' } } });
    } finally {
      await q.proxy.stop();
    }
  });

  // Review focus 4.
  it('never writes tokens or codes to the audit files or the log buffer', async () => {
    const { code } = (await request(p.base).post('/control/login-links').set(auth(ADMIN_TOKEN))).body;
    await request(p.base).get(`/control/login-link?code=${code}`);
    await request(p.base).post('/control/login').send({ token: ADMIN_TOKEN });
    await request(p.base).get('/control/status').set(auth('x'.repeat(40)));
    const dir = join(p.dir, 'data', 'audit');
    const text = readdirSync(dir).map((f) => readFileSync(join(dir, f), 'utf8')).join('');
    const logLines = JSON.stringify((await request(p.base).get('/control/log?limit=500').set(auth(ADMIN_TOKEN))).body);
    expect(logLines).toContain('"audit":true');
    for (const secret of [ADMIN_TOKEN, CLIENT_TOKEN, code, 'x'.repeat(40)]) {
      expect(text).not.toContain(secret);
      expect(logLines).not.toContain(secret);
    }
  });
});
