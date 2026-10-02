// test/recordings-faults.test.ts
// Every cam-sim Baichuan fault through the proxy (spec "Integration").
// Each test takes recordings no earlier test fetched.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import net from 'net';
import request from 'supertest';
import { existsSync, readdirSync } from 'fs';
import { basename, join } from 'path';
import { startSim } from './helpers/sim';
import { ADMIN_TOKEN, auth, startProxy, until } from './helpers/proxy';

let sim: Awaited<ReturnType<typeof startSim>>;
let p: Awaited<ReturnType<typeof startProxy>>;
type SimFile = { name: string; size: number };
let files: SimFile[];
let next = 0;
const fresh = () => files[next++];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const faults = () => sim.sim.engine.faults;
const counters = () => sim.sim.engine.counters;
const cacheDir = () => join(p.dir, 'data', 'recordings', 'cam1');

// A GET that also reports a body cut short (the proxy destroys the response).
function grab(path: string, o: { abortAfterBytes?: number } = {}): Promise<{ status: number; body: Buffer; complete: boolean }> {
  return new Promise((resolve) => {
    const req = http.get(`${p.base}${path}`, { headers: auth() }, (res) => {
      const parts: Buffer[] = [];
      let n = 0;
      const done = (complete: boolean) => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(parts), complete });
      res.on('data', (c: Buffer) => {
        parts.push(c);
        n += c.length;
        if (o.abortAfterBytes !== undefined && n >= o.abortAfterBytes) {
          req.destroy();
          done(false);
        }
      });
      res.on('end', () => done(res.complete));
      res.on('error', () => done(false));
      res.on('close', () => done(res.complete));
    });
    req.on('error', () => resolve({ status: 0, body: Buffer.alloc(0), complete: false }));
  });
}
const fileUrl = (f: SimFile) => `/api/cameras/cam1/recordings/${basename(f.name)}`;
const lastResult = async () => (await request(p.base).get('/control/status').set(auth(ADMIN_TOKEN))).body.recordings.last?.result;

beforeAll(async () => {
  sim = await startSim();
  p = await startProxy(sim);
  await until(() => p.proxy.status.state().online, 15_000);
  // Main files first: the largest, for the faults that need a transfer in flight.
  const recs = sim.sim.engine.sd.all().filter((r) => r.end !== null) as { files: { sub: SimFile; main: SimFile } }[];
  files = [...recs.map((r) => r.files.main), ...recs.map((r) => r.files.sub)];
  expect(files.length).toBeGreaterThanOrEqual(10); // 7 fresh ones, plus the last two
}, 30_000);
afterAll(async () => {
  await p.proxy.stop();
  await sim.close();
});

describe('Baichuan faults through the proxy', () => {
  it('baichuan.refuse: 502 refused (the camera still lists it); the status and the counter say so', async () => {
    const f = files[files.length - 1]; // not fetched here; a later test may still use it
    faults().set({ name: 'baichuan.refuse' });
    try {
      const r = await request(p.base).get(fileUrl(f)).set(auth());
      expect(r.status).toBe(502);
      expect(r.body).toMatchObject({ error: 'recordings_unavailable', reason: 'refused' });
      expect(r.body.detail).not.toContain('/mnt/');
      expect(await lastResult()).toBe('refused');
      expect((await request(p.base).get('/metrics')).text).toContain('result="refused"} 1');
    } finally {
      faults().clear('baichuan.refuse');
    }
  });

  it('baichuan.dropMidway: the body ends short, nothing stays in the cache; the next request works', async () => {
    const f = fresh();
    faults().set({ name: 'baichuan.dropMidway' });
    const r = await grab(fileUrl(f)).finally(() => faults().clear('baichuan.dropMidway'));
    expect(r.complete).toBe(false);
    expect(r.body.length).toBeLessThan(f.size);
    expect(readdirSync(cacheDir()).filter((n) => n.startsWith(basename(f.name)))).toEqual([]);
    const ok = await grab(fileUrl(f));
    expect([ok.status, ok.complete, ok.body.length]).toEqual([200, true, f.size]);
  });

  it('baichuan.delayMs: a slow transfer completes', async () => {
    const f = files[files.length - 2]; // a sub file
    faults().set({ name: 'baichuan.delayMs', ms: 10 });
    try {
      const r = await grab(fileUrl(f));
      expect([r.status, r.complete, r.body.length]).toEqual([200, true, f.size]);
    } finally {
      faults().clear('baichuan.delayMs');
    }
  });

  it('pushes right after login do not disturb a download', async () => {
    p.proxy.recordings.session.close();
    const f = fresh();
    const r = await grab(fileUrl(f));
    expect([r.status, r.complete, r.body.length]).toEqual([200, true, f.size]);
    expect(r.body.subarray(4, 8).toString()).toBe('ftyp');
  });

  it('an abort mid-transfer (disk paused, client gone) sends cmd 9; stale chunks are dropped and the next download on the same session is whole', async () => {
    const big = fresh();
    const after = fresh();
    p.proxy.running.storage.minFreeBytes = Number.MAX_SAFE_INTEGER;
    p.proxy.storage.check();
    faults().set({ name: 'baichuan.delayMs', ms: 20 });
    try {
      const cut = await grab(fileUrl(big), { abortAfterBytes: 1 });
      expect(cut.complete).toBe(false);
      await sleep(300); // the abort reaches the camera, chunks still in flight arrive
    } finally {
      faults().clear('baichuan.delayMs');
      p.proxy.running.storage.minFreeBytes = 0;
      p.proxy.storage.check();
    }
    const logins = counters().baichuanLogins;
    const r = await grab(fileUrl(after));
    expect([r.status, r.complete, r.body.length]).toEqual([200, true, after.size]);
    expect(counters().baichuanLogins).toBe(logins); // the same session
    expect(existsSync(join(cacheDir(), basename(big.name)))).toBe(false);
  });

  it('a session the camera closed while idle (its 32 s drop) is replaced at the next request', async () => {
    await grab(fileUrl(files[files.length - 2])); // cached: no session needed, but make sure one is open
    if (!p.proxy.recordings.session.connected()) await p.proxy.recordings.session.ensure();
    const logins = counters().baichuanLogins;
    faults().set({ name: 'offline' }); // drops the Baichuan connections
    try {
      await until(() => !p.proxy.recordings.session.connected(), 5000);
    } finally {
      faults().clear('offline');
    }
    const f = fresh();
    const r = await grab(fileUrl(f));
    expect([r.status, r.complete, r.body.length]).toEqual([200, true, f.size]);
    expect(counters().baichuanLogins).toBe(logins + 1);
  });

  it('baichuan.sessionLimit: a connection over the limit is reset at its first message: 502 refused; it works once one closes', async () => {
    p.proxy.recordings.session.close();
    await until(() => counters().baichuanSessions === 0);
    faults().set({ name: 'baichuan.sessionLimit', max: 1 });
    const hold = net.connect({ host: '127.0.0.1', port: sim.camera.baichuanPort });
    await new Promise((r) => hold.once('connect', r));
    const f = fresh();
    try {
      await sleep(50);
      const r = await request(p.base).get(fileUrl(f)).set(auth());
      expect(r.status).toBe(502);
      expect(r.body.reason).toBe('refused');
    } finally {
      hold.destroy();
      faults().clear('baichuan.sessionLimit');
    }
    await sleep(100);
    const ok = await grab(fileUrl(f));
    expect([ok.status, ok.complete]).toEqual([200, true]);
  });

  // Last: after a rejected login the session waits 15 s before the next attempt.
  it('baichuan.loginFail: 502 auth; within 15 s the next request fails fast without another login', async () => {
    p.proxy.recordings.session.close();
    faults().set({ name: 'baichuan.loginFail', count: 1 }); // only the first login is rejected
    const f = fresh();
    try {
      const a = await request(p.base).get(fileUrl(f)).set(auth());
      expect([a.status, a.body.reason]).toEqual([502, 'auth']);
      const t0 = Date.now();
      const b = await request(p.base).get(fileUrl(f)).set(auth());
      expect([b.status, b.body.reason]).toEqual([502, 'auth']); // the camera would accept it now: the guard answered
      expect(Date.now() - t0).toBeLessThan(2000);
      expect(await lastResult()).toBe('auth');
    } finally {
      faults().clear('baichuan.loginFail');
    }
  });
});
