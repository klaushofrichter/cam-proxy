import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import { join } from 'path';
import request from 'supertest';
import { isLoopback, localApi } from '../src/api/local-api';
import type { HealthSummary } from '../src/health/summary';
import type { StatFs } from '../src/health/host';
import { startSim } from './helpers/sim';
import { startProxy, auth, ADMIN_TOKEN, CLIENT_TOKEN } from './helpers/proxy';

// Spec 2026-10-03-health-summary-design A4: GET /api/local/health, no key,
// answered only to the socket's loopback address.

describe('isLoopback', () => {
  it('127.0.0.1, ::1 and the IPv4-mapped ::ffff:127.0.0.1 only', () => {
    for (const a of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) expect(isLoopback(a)).toBe(true);
    for (const a of ['192.168.1.50', '::ffff:192.168.1.50', '127.0.0.2', '10.0.0.1', '0.0.0.0', '::', '', undefined]) expect(isLoopback(a)).toBe(false);
  });
});

// A small app: a test middleware sets the socket's remote address, as a LAN
// client's connection would have it; everything after the route answers as
// an unknown route ("unknown").
describe('the loopback guard', () => {
  let server: http.Server;
  let base = '';
  let remote: string | undefined;
  const fake = { schema: 1 } as unknown as HealthSummary;
  beforeAll(async () => {
    const app = express();
    app.set('trust proxy', true); // even so: the forwarding header is never used
    app.use((req, _res, next) => {
      if (remote !== undefined) Object.defineProperty(req.socket, 'remoteAddress', { value: remote, configurable: true });
      next();
    });
    app.use('/api', localApi({ health: async () => fake }));
    app.use((_req, res) => void res.status(404).json({ error: 'unknown' }));
    server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('serves the loopback caller, without a key, not cached', async () => {
    remote = undefined;
    const r = await request(base).get('/api/local/health');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ schema: 1 });
    expect(r.headers['cache-control']).toBe('no-store');
  });
  it('a LAN address goes on as an unknown route', async () => {
    remote = '192.168.1.50';
    expect((await request(base).get('/api/local/health')).body).toEqual({ error: 'unknown' });
  });
  it('a LAN address with a spoofed X-Forwarded-For: 127.0.0.1 still does (trust proxy on)', async () => {
    remote = '192.168.1.50';
    const r = await request(base).get('/api/local/health').set('X-Forwarded-For', '127.0.0.1').set('X-Real-IP', '127.0.0.1').set('Forwarded', 'for=127.0.0.1');
    expect(r.body).toEqual({ error: 'unknown' });
  });
  it('the IPv4-mapped loopback is served; a mapped LAN address is not', async () => {
    remote = '::ffff:127.0.0.1';
    expect((await request(base).get('/api/local/health')).status).toBe(200);
    remote = '::ffff:192.168.1.50';
    expect((await request(base).get('/api/local/health')).body).toEqual({ error: 'unknown' });
  });
  it('::1 is served', async () => {
    remote = '::1';
    expect((await request(base).get('/api/local/health')).status).toBe(200);
  });
  it('GET only: other methods go on as an unknown route', async () => {
    remote = undefined;
    expect((await request(base).post('/api/local/health')).body).toEqual({ error: 'unknown' });
  });
  it('OPTIONS from a LAN address goes on as an unknown route too (no Allow header)', async () => {
    remote = '192.168.1.50';
    const r = await request(base).options('/api/local/health');
    expect(r.body).toEqual({ error: 'unknown' });
    expect(r.headers.allow).toBeUndefined();
  });
});

describe('GET /api/local/health on the proxy', () => {
  let sim: Awaited<ReturnType<typeof startSim>>;
  let p: Awaited<ReturnType<typeof startProxy>>;
  const statfs: StatFs = () => ({ bsize: 4096, blocks: 1_000_000, bfree: 300_000, bavail: 250_000 }); // 73.7 %
  const FTP_PASSWORD = 'ftp-secret-'.padEnd(24, 'q');
  beforeAll(async () => {
    sim = await startSim();
    p = await startProxy(sim, {
      settings: { ftp: { enabled: true, publicHost: '127.0.0.1', user: 'camera' } },
      env: { CAMPROXY_FTP_PASSWORD: FTP_PASSWORD },
      proxy: { host: { root: join(__dirname, 'fixtures', 'host', 'pi'), statfs } },
    });
    // A PoE switch (live setting): its port is in the answer, its host is not.
    await request(p.base).put('/control/config').set(auth(ADMIN_TOKEN)).send({ camera: { poeSwitch: { model: 'sscpoe-web', host: '192.0.2.99', port: 8 } } });
  }, 30_000);
  afterAll(async () => {
    await p.proxy.stop();
    await sim.close();
  });

  it('answers loopback without a key: the summary, Pi figures from the fixture', async () => {
    const r = await request(p.base).get('/api/local/health');
    expect(r.status).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    const h = r.body as HealthSummary;
    expect(h.schema).toBe(1);
    expect(h.platform).toEqual({ pi: true, model: 'Raspberry Pi 4 Model B Rev 1.5', hostStats: true });
    expect(h.items.map((i) => i.id)).toEqual(['camera', 'stream', 'events', 'ftp', 'storage', 'disk', 'cpuTemp', 'underVoltage', 'inventory', 'version']);
    expect(h.items.find((i) => i.id === 'disk')).toMatchObject({ value: 73.7, problem: false });
    expect(h.items.find((i) => i.id === 'cpuTemp')).toMatchObject({ value: 53.6, problem: false });
    expect(h.thresholds).toEqual({ diskPercent: 90, tempC: 75, ftpStalledHours: 6 });
    expect(h.camera.poeSwitch).toEqual({ model: 'sscpoe-web', port: 8 });
    expect(h.version).toBe('dev');
    expect(typeof h.startedAt).toBe('number');
  });

  it('is the same summary as /control/status health', async () => {
    const a = (await request(p.base).get('/api/local/health')).body as HealthSummary;
    const b = (await request(p.base).get('/control/status').set(auth(ADMIN_TOKEN))).body.health as HealthSummary;
    // Built by the same function from the same state (times may move on in between).
    const stable = (h: HealthSummary) => ({ schema: h.schema, version: h.version, startedAt: h.startedAt, thresholds: h.thresholds, platform: h.platform, items: h.items.map((i) => [i.id, i.label]), disk: h.disk, host: h.host, camera: h.camera.id });
    expect(stable(b)).toEqual(stable(a));
  });

  it('a threshold change applies at once and is audited', async () => {
    const put = await request(p.base).put('/control/config').set(auth(ADMIN_TOKEN)).send({ health: { diskPercent: 70 } });
    expect(put.status).toBe(200);
    const h = (await request(p.base).get('/api/local/health')).body as HealthSummary;
    expect(h.thresholds.diskPercent).toBe(70);
    expect(h.items.find((i) => i.id === 'disk')?.problem).toBe(true);
    expect(h.ok).toBe(false);
    const audit = await request(p.base).get('/control/audit?action=config-change&after=&limit=10').set(auth(ADMIN_TOKEN));
    expect(audit.text).toContain('health.diskPercent');
    // host.stats off: still a Pi, no host figures, no Pi lines
    await request(p.base).put('/control/config').set(auth(ADMIN_TOKEN)).send({ host: { stats: 'off' } });
    const off = (await request(p.base).get('/api/local/health')).body as HealthSummary;
    expect(off.platform).toEqual({ pi: true, model: 'Raspberry Pi 4 Model B Rev 1.5', hostStats: false });
    expect(off.host).toBeNull();
    expect(off.items.map((i) => i.id)).not.toContain('cpuTemp');
    await request(p.base).delete('/control/config/host.stats').set(auth(ADMIN_TOKEN));
    await request(p.base).delete('/control/config/health.diskPercent').set(auth(ADMIN_TOKEN));
  });

  it('carries no secrets', async () => {
    const text = (await request(p.base).get('/api/local/health')).text;
    for (const s of [ADMIN_TOKEN, CLIENT_TOKEN, FTP_PASSWORD, sim.password, '192.0.2.99']) expect(text).not.toContain(s);
    const keys: string[] = [];
    const walk = (v: unknown) => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) (keys.push(k), walk(x));
    };
    walk(JSON.parse(text));
    for (const bad of [/password/i, /token/i, /secret/i, /key$/i, /publicHost/i, /^user$/i, /serial/i, /^server$/i]) expect(keys.filter((k) => bad.test(k))).toEqual([]);
  });

  it('is not part of the client API: a client token is no key here, and nothing else changes', async () => {
    expect((await request(p.base).get('/api/local/health').set(auth(CLIENT_TOKEN))).status).toBe(200);
    expect((await request(p.base).get('/api/local/nothing').set(auth(CLIENT_TOKEN))).status).toBe(404);
  });
});

describe('GET /api/local/health off a Pi', () => {
  it('no host figures, no Pi lines', async () => {
    const sim = await startSim();
    const p = await startProxy(sim, { proxy: { host: { root: join(__dirname, 'fixtures', 'host', 'linux') } } });
    try {
      const h = (await request(p.base).get('/api/local/health')).body as HealthSummary;
      expect(h.platform).toEqual({ pi: false, model: null, hostStats: false });
      expect(h.host).toBeNull();
      expect(h.items.map((i) => i.id)).toEqual(['camera', 'stream', 'events', 'ftp', 'storage', 'disk', 'inventory', 'version']);
      expect(h.disk?.sizeBytes).toBeGreaterThan(0); // the real statfs of the data folder
    } finally {
      await p.proxy.stop();
      await sim.close();
    }
  }, 30_000);
});

// A request from another address can't be made from the test machine without
// its LAN address; the proxy's own route uses the same guard as above, and its
// fall-through is checked here: the next handler is the /api access check.
describe('the fall-through on the proxy', () => {
  it('a non-loopback caller gets what an unknown /api route gets', async () => {
    const sim = await startSim();
    const p = await startProxy(sim);
    try {
      // Re-run the app with the socket address of a LAN client.
      const app = express();
      app.use((req, _res, next) => (Object.defineProperty(req.socket, 'remoteAddress', { value: '192.168.1.50', configurable: true }), next()));
      app.use(p.proxy.app);
      const server = http.createServer(app);
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      try {
        const same = async (path: string, headers: Record<string, string> = {}) => {
          const r = await request(base).get(path).set(headers);
          return { status: r.status, body: r.body };
        };
        expect(await same('/api/local/health')).toEqual(await same('/api/local/nothing'));
        expect((await same('/api/local/health')).status).toBe(401);
        expect(await same('/api/local/health', auth(CLIENT_TOKEN))).toEqual({ status: 404, body: { error: 'not_found' } });
        expect(await same('/api/local/health', { 'X-Forwarded-For': '127.0.0.1' })).toEqual(await same('/api/local/nothing'));
        const opt = async (path: string) => {
          const r = await request(base).options(path);
          return { status: r.status, body: r.body, allow: r.headers.allow };
        };
        expect(await opt('/api/local/health')).toEqual(await opt('/api/local/nothing'));
        expect((await opt('/api/local/health')).allow).toBeUndefined();
      } finally {
        await new Promise<void>((r) => server.close(() => r()));
      }
    } finally {
      await p.proxy.stop();
      await sim.close();
    }
  }, 30_000);
});
