// test/recordings-faults.test.ts
// Every cam-sim Baichuan fault through the proxy (spec "Integration").
// Each test has its own sim, proxy and cache (beforeEach), so the order does
// not matter and no state (session, 15 s login guard, counters) leaks.
// Also covered elsewhere: 503 camera_offline, 404 unknown_recording and the
// HTTP Download refused case (downloads.refuse, Baichuan works) are in
// recordings-api.test.ts; the offline and unknown-id cases are repeated here
// as one line each.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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

beforeEach(async () => {
  next = 0;
  sim = await startSim();
  p = await startProxy(sim);
  await until(() => p.proxy.status.state().online, 15_000);
  // Main files first: the largest, for the faults that need a transfer in flight.
  const recs = sim.sim.engine.sd.all().filter((r) => r.end !== null) as { files: { sub: SimFile; main: SimFile } }[];
  files = [...recs.map((r) => r.files.main), ...recs.map((r) => r.files.sub)];
  expect(files.length).toBeGreaterThanOrEqual(10);
}, 30_000);
afterEach(async () => {
  await p.proxy.stop();
  await sim.close();
});

// The side effects of a failed or cut download: nothing of it in the cache,
// nothing pinned.
const noTrace = (f: SimFile) => {
  const id = basename(f.name);
  expect(existsSync(cacheDir()) ? readdirSync(cacheDir()).filter((n) => n.startsWith(id)) : []).toEqual([]);
  expect(p.proxy.recordings.cache.has(id)).toBe(false);
  expect(p.proxy.recordings.cache.busy(p.proxy.recordings.cache.partPath(id))).toBe(false);
};
const refusedCount = async () => Number(/result="refused",priority="high"} (\d+)/.exec((await request(p.base).get('/metrics')).text)?.[1] ?? 0);
const okWhole = async (f: SimFile) => {
  const r = await grab(fileUrl(f));
  expect([r.status, r.complete, r.body.length]).toEqual([200, true, f.size]);
  return r;
};

describe('Baichuan faults through the proxy', () => {
  it('baichuan.refuse: 502 refused (the camera still lists it); the status and the counter say so', async () => {
    const f = fresh();
    const before = await refusedCount();
    faults().set({ name: 'baichuan.refuse' });
    try {
      const r = await request(p.base).get(fileUrl(f)).set(auth());
      expect(r.status).toBe(502);
      expect(r.body).toMatchObject({ error: 'recordings_unavailable', reason: 'refused' });
      expect(r.body.detail).not.toContain('/mnt/');
      expect(await lastResult()).toBe('refused');
      expect(await refusedCount()).toBe(before + 1);
      noTrace(f);
    } finally {
      faults().clear('baichuan.refuse');
    }
    await okWhole(f);
  });

  it('baichuan.dropMidway: 200 then the body ends short, nothing stays in the cache; the next request works', async () => {
    const f = fresh();
    faults().set({ name: 'baichuan.dropMidway' });
    const r = await grab(fileUrl(f)).finally(() => faults().clear('baichuan.dropMidway'));
    expect(r.status).toBe(200);
    expect(r.complete).toBe(false);
    expect(r.body.length).toBeLessThan(f.size);
    expect(counters().droppedBaichuanDownloads).toBeGreaterThanOrEqual(1);
    noTrace(f);
    await okWhole(f);
  });

  it('baichuan.delayMs: a slow transfer completes', async () => {
    const f = files[files.length - 2]; // a sub file
    faults().set({ name: 'baichuan.delayMs', ms: 10 });
    try {
      await okWhole(f);
    } finally {
      faults().clear('baichuan.delayMs');
    }
  });

  it('pushes right after login do not disturb a download', async () => {
    p.proxy.recordings.session.close();
    const r = await okWhole(fresh());
    expect(r.body.subarray(4, 8).toString()).toBe('ftyp');
  });

  it('an abort mid-transfer (disk paused, client gone) sends cmd 9; stale chunks are dropped and the next download on the same session is whole', async () => {
    const big = fresh();
    const after = fresh();
    await okWhole(fresh()); // a session is open, with a known login count
    const logins = counters().baichuanLogins;
    p.proxy.running.storage.minFreeBytes = Number.MAX_SAFE_INTEGER;
    p.proxy.storage.check();
    faults().set({ name: 'baichuan.delayMs', ms: 20 });
    try {
      const cut = await grab(fileUrl(big), { abortAfterBytes: 1 });
      expect(cut.complete).toBe(false);
      // The fetch ends once the abort is sent; chunks still in flight arrive after.
      await until(() => !p.proxy.recordings.cache.busy(p.proxy.recordings.cache.partPath(basename(big.name))));
    } finally {
      faults().clear('baichuan.delayMs');
      p.proxy.running.storage.minFreeBytes = 0;
      p.proxy.storage.check();
    }
    noTrace(big);
    await okWhole(after);
    expect(counters().baichuanLogins).toBe(logins); // the same session
    noTrace(big);
  });

  it('a session the camera closed while idle (its 32 s drop) is replaced at the next request', async () => {
    await okWhole(fresh());
    expect(p.proxy.recordings.session.connected()).toBe(true);
    const logins = counters().baichuanLogins;
    faults().set({ name: 'offline' }); // drops the Baichuan connections
    try {
      await until(() => !p.proxy.recordings.session.connected(), 5000);
    } finally {
      faults().clear('offline');
    }
    await okWhole(fresh());
    expect(counters().baichuanLogins).toBe(logins + 1);
  });

  it('baichuan.sessionLimit: a connection over the limit is reset at its first message: 502 refused; it works once one closes', async () => {
    faults().set({ name: 'baichuan.sessionLimit', max: 1 });
    const hold = net.connect({ host: '127.0.0.1', port: sim.camera.baichuanPort });
    await new Promise((r) => hold.once('connect', r));
    // The sim counts logged-in sessions only, so the held connection can't be polled:
    // two loop turns let the sim accept it, and the HTTP round trip below adds many more.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    const f = fresh();
    try {
      const r = await request(p.base).get(fileUrl(f)).set(auth());
      expect(r.status).toBe(502);
      expect(r.body.reason).toBe('refused');
      noTrace(f);
    } finally {
      hold.destroy();
      faults().clear('baichuan.sessionLimit');
    }
    // The sim notices the closed connection a moment later: poll the outcome.
    await until(async () => (await request(p.base).get(fileUrl(f)).set(auth())).status === 200);
    await okWhole(f);
  });

  it('baichuan.loginFail: 502 auth; within 15 s the next request fails fast without another login', async () => {
    faults().set({ name: 'baichuan.loginFail', count: 1 }); // only the first login is rejected
    const f = fresh();
    try {
      const a = await request(p.base).get(fileUrl(f)).set(auth());
      expect([a.status, a.body.reason]).toEqual([502, 'auth']);
      noTrace(f);
      const logins = counters().baichuanLogins;
      const t0 = Date.now();
      const b = await request(p.base).get(fileUrl(f)).set(auth());
      expect([b.status, b.body.reason]).toEqual([502, 'auth']); // the camera would accept it now: the guard answered
      expect(Date.now() - t0).toBeLessThan(2000);
      expect(counters().baichuanLogins).toBe(logins);
      expect(await lastResult()).toBe('auth');
      noTrace(f);
    } finally {
      faults().clear('baichuan.loginFail');
    }
  });

  it('camera offline: 503 camera_offline, nothing cached; it works when the camera is back', async () => {
    const f = fresh();
    faults().set({ name: 'offline' });
    try {
      const r = await request(p.base).get(fileUrl(f)).set(auth());
      expect([r.status, r.body]).toEqual([503, { error: 'camera_offline' }]);
      noTrace(f);
    } finally {
      faults().clear('offline');
    }
    await okWhole(f);
  });

  it('an id the camera does not list: 404 unknown_recording', async () => {
    const r = await request(p.base).get('/api/cameras/cam1/recordings/RecS00_20200101_000000_000100_0_ABCDEF_1000.mp4').set(auth());
    expect([r.status, r.body]).toEqual([404, { error: 'unknown_recording' }]);
  });

  it('downloads.refuse (the HTTP Download is refused): Baichuan still delivers', async () => {
    faults().set({ name: 'downloads.refuse' });
    try {
      await okWhole(fresh());
    } finally {
      faults().clear('downloads.refuse');
    }
  });
});
