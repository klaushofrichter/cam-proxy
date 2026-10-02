import http from 'http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { restartProcess } from '../src/process-restart';
import { startSim } from './helpers/sim';
import { ADMIN_TOKEN, auth, startProxy, until } from './helpers/proxy';

// Restart the proxy process (issue #71): POST /control/actions/restart-proxy.

describe('restartProcess', () => {
  it('stops, then exits with 0', async () => {
    const order: string[] = [];
    const exit = vi.fn((code: number) => void order.push(`exit ${code}`));
    const result = await restartProcess({ stop: async () => void order.push('stop'), exit, timeoutMs: 1000 });
    expect(result).toBe('stopped');
    expect(order).toEqual(['stop', 'exit 0']);
  });

  it('exits anyway when stop hangs past the timeout', async () => {
    const exit = vi.fn();
    const t0 = Date.now();
    const result = await restartProcess({ stop: () => new Promise<void>(() => undefined), exit, timeoutMs: 50 });
    expect(result).toBe('timeout');
    expect(exit).toHaveBeenCalledWith(0);
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it('exits when stop fails', async () => {
    const exit = vi.fn();
    expect(await restartProcess({ stop: async () => { throw new Error('boom'); }, exit, timeoutMs: 1000 })).toBe('failed');
    expect(exit).toHaveBeenCalledWith(0);
  });
});

describe('POST /control/actions/restart-proxy', () => {
  let sim: Awaited<ReturnType<typeof startSim>>;
  beforeAll(async () => {
    sim = await startSim();
  });
  afterAll(async () => {
    await sim.close();
  });
  const AUDIT_TOKEN = 'audit-token-'.padEnd(40, 'z');

  it('refuses the client token and the audit token (403); nothing stops', async () => {
    const exit = vi.fn();
    const p = await startProxy(sim, { env: { CAMPROXY_AUDIT_TOKEN: AUDIT_TOKEN }, proxy: { exit } });
    try {
      expect((await request(p.base).post('/control/actions/restart-proxy').set(auth())).status).toBe(403);
      expect((await request(p.base).post('/control/actions/restart-proxy').set(auth(AUDIT_TOKEN))).status).toBe(403);
      expect((await request(p.base).get('/health')).status).toBe(200);
      expect(exit).not.toHaveBeenCalled();
      expect(p.proxy.audit.list({ actions: ['proxy-restart', 'proxy-stop'] }).records).toHaveLength(0);
    } finally {
      await p.proxy.stop();
    }
  });

  it('answers 202, records proxy-restart then proxy-stop (restart-requested), and exits with 0', async () => {
    const exit = vi.fn();
    const p = await startProxy(sim, { proxy: { exit } });
    const r = await request(p.base).post('/control/actions/restart-proxy').set(auth(ADMIN_TOKEN));
    expect(r.status).toBe(202);
    await until(() => exit.mock.calls.length > 0);
    expect(exit).toHaveBeenCalledWith(0);
    expect(exit).toHaveBeenCalledTimes(1);
    const recs = p.proxy.audit.list({ actions: ['proxy-restart', 'proxy-stop', 'control-action'] }).records.reverse();
    expect(recs.map((x) => x.event.action)).toEqual(['proxy-restart', 'proxy-stop']);
    expect(recs[0]).toMatchObject({ event: { category: ['process'], type: ['change'], outcome: 'success' }, user: { name: 'admin' }, source: { ip: '127.0.0.1' }, cam_proxy: { requestedBy: 'token' } });
    expect(recs[1]).toMatchObject({ cam_proxy: { reason: 'restart-requested' } });
    // The server is closed: the process would now end.
    await expect(request(p.base).get('/health')).rejects.toThrow();
    await p.proxy.stop(); // joins the stop that ran
  });

  // #86 item 4: a second request before the stop closes the server is no second record.
  it('a second request before the stop writes no second proxy-restart record', async () => {
    const exit = vi.fn();
    const p = await startProxy(sim, { proxy: { exit } });
    // Several open connections, so the requests land before the stop closes the server.
    const agent = new http.Agent({ keepAlive: true, maxSockets: 6 });
    const send = (path: string, method: string) => new Promise<number>((resolve) => {
      const u = new URL(path, p.base);
      const req = http.request({ agent, hostname: u.hostname, port: u.port, path: u.pathname, method, headers: { Authorization: `Bearer ${ADMIN_TOKEN}`, Connection: 'keep-alive' } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode ?? 0)); });
      req.on('error', () => resolve(0));
      req.end();
    });
    await Promise.all(Array.from({ length: 6 }, () => send('/health', 'GET')));
    const codes = await Promise.all(Array.from({ length: 6 }, () => send('/control/actions/restart-proxy', 'POST')));
    expect(codes.filter((c) => c === 202).length).toBeGreaterThan(1);
    agent.destroy();
    await until(() => exit.mock.calls.length > 0);
    expect(p.proxy.audit.list({ actions: ['proxy-restart'] }).records).toHaveLength(1);
    await p.proxy.stop();
  });

  it('by session with the CSRF header', async () => {
    const exit = vi.fn();
    const p = await startProxy(sim, { proxy: { exit } });
    const login = await request(p.base).post('/control/login').send({ token: ADMIN_TOKEN });
    const cookie = String(login.headers['set-cookie']).split(';')[0];
    expect((await request(p.base).post('/control/actions/restart-proxy').set('Cookie', cookie)).status).toBe(403);
    expect((await request(p.base).post('/control/actions/restart-proxy').set('Cookie', cookie).set('X-CamProxy-UI', '1')).status).toBe(202);
    await until(() => exit.mock.calls.length > 0);
    expect(p.proxy.audit.list({ actions: ['proxy-restart'] }).records[0]).toMatchObject({ cam_proxy: { requestedBy: 'session' } });
    await p.proxy.stop();
  });

  it('/health tells a new start apart: the start time', async () => {
    const p = await startProxy(sim, { proxy: { exit: vi.fn() } });
    try {
      const h = (await request(p.base).get('/health')).body;
      expect(h).toEqual({ ok: true, version: 'dev', startedAt: expect.any(Number) });
    } finally {
      await p.proxy.stop();
    }
  });
});
