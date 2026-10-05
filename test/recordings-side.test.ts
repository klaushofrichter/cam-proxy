// test/recordings-side.test.ts
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, truncateSync, unlinkSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { basename, join } from 'path';
import { Writable } from 'stream';
import { logBuffer } from '../src/log';
import { createRecordingsSide } from '../src/recordings/side';
import { startSim } from './helpers/sim';
import { ADMIN_TOKEN, auth, freePort, startProxy, until } from './helpers/proxy';

let sim: Awaited<ReturnType<typeof startSim>>;
let p: Awaited<ReturnType<typeof startProxy>>;
let recDir: string;
const CACHED = 'RecS0A_DST20201001_211129_211207_0_5514C080000000_3E8.mp4';
const LEFTOVER = 'RecS0A_DST20201001_211300_211330_0_5514C080000000_3E8.mp4.part';

beforeAll(async () => {
  sim = await startSim();
  const dir = mkdtempSync(join(tmpdir(), 'camproxy-recside-'));
  recDir = join(dir, 'data', 'recordings', 'cam1');
  mkdirSync(recDir, { recursive: true });
  writeFileSync(join(recDir, CACHED), Buffer.alloc(1000));
  writeFileSync(join(recDir, LEFTOVER), Buffer.alloc(10));
  p = await startProxy(sim, { dir });
  await until(() => p.proxy.status.state().online, 15_000);
}, 30_000);
afterAll(async () => {
  await p.proxy.stop();
  await sim.close();
});

describe('the recordings side', () => {
  it('deletes leftover .part files at start and reports the cache in /control/status', async () => {
    expect(existsSync(join(recDir, LEFTOVER))).toBe(false);
    const st = await request(p.base).get('/control/status').set(auth(ADMIN_TOKEN));
    expect(st.body.recordings).toEqual({ last: null, cache: { bytes: 1000, files: 1, capBytes: 2048 * 2 ** 20 } });
  });

  it('storage over the cache cap keeps a pinned recording (recordingsBusy) and deletes an unpinned one', async () => {
    const cache = p.proxy.recordings.cache;
    const A = 'RecS0A_DST20201002_100000_100100_0_5514C080000000_3E8.mp4';
    const B = 'RecS0A_DST20201002_110000_110100_0_5514C080000000_3E8.mp4';
    // Sparse files: 40 MB each, over the 64 MB cap together. A is the least
    // recently used, so it would go first if it were not pinned.
    for (const [id, t] of [[A, 1000], [B, 2000]] as const) {
      const f = join(recDir, id);
      writeFileSync(f, '');
      truncateSync(f, 40 * 2 ** 20);
      utimesSync(f, new Date(t), new Date(t));
    }
    const r = await request(p.base).put('/control/config').set(auth(ADMIN_TOKEN)).send({ recordings: { cacheMB: 64 } });
    expect(r.status).toBe(200);
    p.proxy.storage.recount();
    const unpin = cache.pin(cache.path(A));
    try {
      p.proxy.storage.run({});
    } finally {
      unpin();
    }
    expect(cache.has(A)).toBe(true);
    expect(cache.has(B)).toBe(false);
    expect(cache.has(CACHED)).toBe(true); // under the cap once B went
    unlinkSync(join(recDir, A));
    p.proxy.storage.recount();
    expect((await request(p.base).delete('/control/config/recordings.cacheMB').set(auth(ADMIN_TOKEN))).status).toBe(200);
  });

  it('downloads a recording from cam-sim over Baichuan into the cache, and records the result', async () => {
    const rec = sim.sim.engine.sd.all().find((r) => r.end !== null)!;
    const id = basename(rec.files.sub.name);
    const entry = await p.proxy.recordings.list.find(id);
    expect(entry?.path).toBe(rec.files.sub.name);
    await p.proxy.recordings.fetcher.get(entry!, { priority: 'high' }).fetch.done;
    expect(p.proxy.recordings.cache.has(id)).toBe(true);
    const st = await request(p.base).get('/control/status').set(auth(ADMIN_TOKEN));
    // A viewer's download (high); a repair's is low (#111: told apart).
    expect(st.body.recordings.last).toMatchObject({ result: 'ok', stream: 'sub', bytes: rec.files.sub.size, priority: 'high' });
    const m = await request(p.base).get('/metrics');
    expect(m.text).toContain('camproxy_recording_downloads_total{cam="cam1",stream="sub",result="ok",priority="high"} 1');
    expect(m.text).toContain('camproxy_disk_bytes{kind="recordings"}');
    expect(p.proxy.recordings.session.connected()).toBe(true);
    // One info line per download: camera, id, stream, bytes, ms, result.
    const line = logBuffer.recent(500).find((l) => l.msg === 'recording_download' && l.id === id);
    expect(line).toMatchObject({ camera: 'cam1', stream: 'sub', bytes: rec.files.sub.size, result: 'ok', priority: 'high' });
    expect(typeof line?.ms).toBe('number');
    // Never a secret in the log.
    expect(JSON.stringify(logBuffer.recent(500))).not.toContain(sim.password);
  });

  it('a change of camera.baichuanPort closes the session; the next use connects to the new port', async () => {
    expect(p.proxy.recordings.session.connected()).toBe(true);
    const port = p.proxy.running.cameras.cam1.baichuanPort;
    const unused = await freePort();
    const r = await request(p.base).put('/control/config').set(auth(ADMIN_TOKEN)).send({ camera: { baichuanPort: unused } });
    expect(r.status).toBe(200);
    expect(p.proxy.recordings.session.connected()).toBe(false);
    await until(() => sim.sim.engine.counters.baichuanSessions === 0);
    // Nothing listens on the new port: the next download fails offline.
    const rec = sim.sim.engine.sd.all().filter((r) => r.end !== null)[1]!;
    const entry = await p.proxy.recordings.list.find(basename(rec.files.sub.name));
    await expect(p.proxy.recordings.fetcher.get(entry!, { priority: 'high' }).fetch.done).rejects.toMatchObject({ code: 'offline' });
    expect(p.proxy.recordings.status().last).toMatchObject({ result: 'offline', stream: 'sub' });
    expect(sim.sim.engine.counters.baichuanSessions).toBe(0);
    // Back to the camera's port: the same download works.
    const back = await request(p.base).put('/control/config').set(auth(ADMIN_TOKEN)).send({ camera: { baichuanPort: port } });
    expect(back.status).toBe(200);
    await p.proxy.recordings.fetcher.get(entry!, { priority: 'high' }).fetch.done;
    expect(p.proxy.recordings.cache.has(entry!.id)).toBe(true);
    expect(p.proxy.recordings.session.connected()).toBe(true);
  });

  it('stop() closes the Baichuan session (a plain close)', async () => {
    await p.proxy.stop();
    expect(p.proxy.recordings.session.connected()).toBe(false);
    await until(() => sim.sim.engine.counters.baichuanSessions === 0);
  });
});

describe('stopping during a download', () => {
  let sim2: Awaited<ReturnType<typeof startSim>>;
  let q: Awaited<ReturnType<typeof startProxy>>;
  beforeAll(async () => {
    sim2 = await startSim();
    q = await startProxy(sim2);
    await until(() => q.proxy.status.state().online, 15_000);
  }, 30_000);
  afterAll(async () => {
    await q.proxy.stop();
    await sim2.close();
  });

  it('stops the running download with cmd 9, closes the session, leaves no .part', async () => {
    sim2.sim.engine.faults.set({ name: 'baichuan.delayMs', ms: 50 });
    const rec = sim2.sim.engine.sd.all().find((r) => r.end !== null)!;
    const entry = await q.proxy.recordings.list.find(basename(rec.files.main.name));
    const { fetch } = q.proxy.recordings.fetcher.get(entry!, { priority: 'high' });
    let got = 0;
    fetch.attach(new Writable({ write: (c: Buffer, _e, cb) => ((got += c.length), cb()) }), () => undefined);
    await until(() => got > 0, 10_000);
    const t0 = Date.now();
    await q.proxy.stop();
    expect(Date.now() - t0).toBeLessThan(5_000);
    await expect(fetch.done).rejects.toBeDefined();
    const cmds = sim2.sim.engine.requests.recent(200).filter((r) => r.port === 'baichuan').map((r) => r.cmd);
    expect(cmds).toContain('9');
    expect(q.proxy.recordings.session.connected()).toBe(false);
    await until(() => sim2.sim.engine.counters.baichuanSessions === 0);
    const dir = join(q.proxy.running.server.dataDir, 'recordings', 'cam1');
    expect(readdirSync(dir).filter((n) => n.endsWith('.part'))).toEqual([]);
  }, 30_000);
});

describe('a camera reboot', () => {
  let sim3: Awaited<ReturnType<typeof startSim>>;
  let r: Awaited<ReturnType<typeof startProxy>>;
  beforeAll(async () => {
    sim3 = await startSim();
    r = await startProxy(sim3);
    await until(() => r.proxy.status.state().online, 15_000);
  }, 30_000);
  afterAll(async () => {
    await r.proxy.stop();
    await sim3.close();
  });

  it('resets the recordings side when the reboot goes out: the session is closed at once', async () => {
    const rec = sim3.sim.engine.sd.all().find((x) => x.end !== null)!;
    const entry = await r.proxy.recordings.list.find(basename(rec.files.sub.name));
    await r.proxy.recordings.fetcher.get(entry!, { priority: 'high' }).fetch.done;
    expect(r.proxy.recordings.session.connected()).toBe(true);
    // cam-sim drops its sockets on a reboot; the real camera may leave them
    // half-open, so the proxy must reset on its own.
    const reset = vi.spyOn(r.proxy.recordings, 'reset');
    const res = await request(r.base).post('/control/actions/camera-reboot').set(auth(ADMIN_TOKEN));
    expect(res.status).toBe(202);
    expect(reset).toHaveBeenCalledTimes(1);
    expect(r.proxy.recordings.session.connected()).toBe(false);
  }, 30_000);
});

describe('reset() after a camera.id change (#99, Task 11)', () => {
  it('prepares the new camera folder: created, its leftover .part files deleted', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'camproxy-reset-'));
    let cam = 'cam1';
    const side = createRecordingsSide({
      dataDir,
      cam: () => cam,
      target: () => ({ host: '127.0.0.1', port: 1, user: 'u', password: 'p' }),
      capBytes: () => 2 ** 20,
      search: async () => ({}),
      timeInfo: async () => ({ stdOffsetMinutes: 0, dstOffsetMinutes: 0 }),
      paused: () => false,
      noteWritten: () => undefined,
    });
    const next = join(dataDir, 'recordings', 'cam9');
    mkdirSync(next, { recursive: true });
    writeFileSync(join(next, LEFTOVER), Buffer.alloc(10));
    writeFileSync(join(next, CACHED), Buffer.alloc(10));
    cam = 'cam9';
    side.reset();
    expect(readdirSync(next)).toEqual([CACHED]);
    // A reset for the same camera leaves a .part alone (a download may be writing it).
    writeFileSync(join(next, LEFTOVER), Buffer.alloc(10));
    side.reset();
    expect(readdirSync(next).sort()).toEqual([CACHED, LEFTOVER].sort());
    await side.stop();
  });
});
