import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { ADMIN_TOKEN, CLIENT_TOKEN, auth, startProxy } from './helpers/proxy';
import { startSim } from './helpers/sim';
import { IpCap, RefusalThrottle } from '../src/audit/throttle';
import { LOGIN_ATTEMPTS } from '../src/api/control-api';

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

  it('caps records per ip per window, counting the overflow into suppressed', () => {
    const now = { t: 0 };
    const c = new IpCap(60, 600_000, () => now.t);
    for (let i = 0; i < 60; i++) expect(c.take('1.1.1.1')).toEqual({ record: true, suppressed: 0 });
    expect(c.take('1.1.1.1').record).toBe(false);
    expect(c.take('1.1.1.1').record).toBe(false);
    expect(c.take('2.2.2.2').record).toBe(true);
    now.t = 600_001;
    expect(c.take('1.1.1.1')).toEqual({ record: true, suppressed: 2 });
  });

  it('keeps at most `cap` keys, evicting the oldest when none have expired', () => {
    const t = new RefusalThrottle(600_000, () => 0, 10_000);
    for (let i = 0; i < 20_000; i++) t.take('1.1.1.1', `/api/${i}`);
    expect(t.size).toBeLessThanOrEqual(10_000);
    expect(t.take('1.1.1.1', '/api/19999').record).toBe(false); // the newest are kept
    expect(t.take('1.1.1.1', '/api/0').record).toBe(true); // the oldest were evicted
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
    const changesOf = () => (last('config-change').cam_proxy as { changes: { key: string }[] }).changes;
    expect(changesOf()[0]).not.toHaveProperty('restart'); // live
    // #78: a change that waits for a restart says so ('restart', or 'process' for a new process).
    await request(p.base).put('/control/config').set(auth(ADMIN_TOKEN)).send({ camera: { statusPollS: 9 }, server: { trustProxy: 1 } });
    try {
      const changes = changesOf();
      expect(changes.find((c) => c.key === 'camera.statusPollS')).toMatchObject({ to: 9, restart: 'restart' });
      expect(changes.find((c) => c.key === 'server.trustProxy')).toMatchObject({ to: 1, restart: 'process' });
    } finally {
      for (const k of ['camera.statusPollS', 'server.trustProxy']) await request(p.base).delete(`/control/config/${k}`).set(auth(ADMIN_TOKEN));
    }
  });

  it('records a rate-limited sign-in once per window, for the token and the link (own proxy)', async () => {
    const q = await startProxy(sim, {});
    const logins = () => q.proxy.audit.list({ actions: ['login'], limit: 500 }).records;
    try {
      // Klaus (2026-10-01): 40 sign-ins per 15 min; the 41st is refused.
      for (let i = 0; i < LOGIN_ATTEMPTS; i++) expect((await request(q.base).post('/control/login').send({ token: 'wrong' })).status).toBe(401);
      for (let i = 0; i < 10; i++) await request(q.base).post('/control/login').send({ token: 'wrong' });
      const r = await request(q.base).post('/control/login').send({ token: 'wrong' });
      expect(r.status).toBe(429);
      expect(r.body).toEqual({ error: 'too_many_attempts' });
      expect(LOGIN_ATTEMPTS).toBe(40);
      expect(logins().length).toBeLessThanOrEqual(LOGIN_ATTEMPTS + 1);
      const limited = logins().filter((x) => (x.cam_proxy as { auth?: { reason?: string } }).auth?.reason === 'rate-limited');
      expect(limited).toHaveLength(1);
      expect(limited[0]).toMatchObject({ event: { outcome: 'failure' }, message: 'Sign-in refused: too many attempts', cam_proxy: { auth: { method: 'token-form', reason: 'rate-limited' } } });
      // The link limiter (200 per 15 min): one record, the redirect unchanged.
      const before = logins().length;
      let last429: request.Response | undefined;
      for (let i = 0; i < 210; i++) last429 = await request(q.base).get('/control/login-link?code=nope');
      expect(last429!.status).toBe(302);
      expect(last429!.headers.location).toBe('/?link=expired');
      const linkLimited = logins().filter((x) => (x.cam_proxy as { auth?: { method?: string; reason?: string } }).auth?.method === 'login-link' && (x.cam_proxy as { auth?: { reason?: string } }).auth?.reason === 'rate-limited');
      expect(linkLimited).toHaveLength(1);
      expect(logins().length - before).toBeLessThanOrEqual(201);
    } finally {
      await q.proxy.stop();
    }
  }, 30_000);

  it('records anonymous logouts throttled, session logouts always', async () => {
    const outs = () => p.proxy.audit.list({ actions: ['logout'], limit: 500 }).records;
    const n = outs().length;
    for (let i = 0; i < 10; i++) await request(p.base).post('/control/logout');
    expect(outs().length).toBe(n + 1);
    expect(outs()[0]).toMatchObject({ event: { type: ['end'] } });
    expect(outs()[0].user).toBeUndefined();
    const cookie = (await request(p.base).post('/control/login').send({ token: ADMIN_TOKEN })).headers['set-cookie'][0].split(';')[0];
    await request(p.base).post('/control/logout').set('Cookie', cookie).set(ui);
    expect(outs().length).toBe(n + 2);
    expect(outs()[0]).toMatchObject({ user: { name: 'admin' } });
  });

  it('cuts a long path to 256 characters in a refused-token record', async () => {
    await request(p.base).get(`/api/${'a'.repeat(8192)}`);
    const r = last('auth-refused') as unknown as { url: { path: string }; message: string };
    expect(r.url.path.length).toBeLessThanOrEqual(257);
    expect(r.url.path.endsWith('…')).toBe(true);
    expect(r.message.length).toBeLessThan(400);
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

describe('refused-token flood', () => {
  it('writes one record for numbered paths, caps per ip, and gives another ip its own', async () => {
    const sim2 = await startSim();
    const q = await startProxy(sim2, { settings: { server: { logLevel: 'silent', trustProxy: 1 } } });
    try {
      const recs = () => q.proxy.audit.list({ actions: ['auth-refused'], limit: 500 }).records as unknown as { source: { ip: string }; cam_proxy: { auth: { suppressed?: number } } }[];
      const get = (path: string, ip: string) => request(q.base).get(path).set('X-Forwarded-For', ip);
      for (let i = 0; i < 500; i++) await get(`/api/cameras/cam1/stills/${1790000000000 + i * 5000}.jpg`, '203.0.113.1');
      expect(recs().filter((r) => r.source.ip === '203.0.113.1')).toHaveLength(1);
      for (let i = 0; i < 200; i++) await get(`/api/zz${i}x`, '203.0.113.2');
      const n2 = recs().filter((r) => r.source.ip === '203.0.113.2').length;
      expect(n2).toBeGreaterThan(0);
      expect(n2).toBeLessThanOrEqual(60);
      await get('/api/other', '203.0.113.3');
      expect(recs().filter((r) => r.source.ip === '203.0.113.3')).toHaveLength(1);
    } finally {
      await q.proxy.stop();
      await sim2.close();
    }
  });
});
