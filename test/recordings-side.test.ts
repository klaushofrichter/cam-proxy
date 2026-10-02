// test/recordings-side.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { basename, join } from 'path';
import { Writable } from 'stream';
import { logBuffer } from '../src/log';
import { startSim } from './helpers/sim';
import { ADMIN_TOKEN, auth, startProxy, until } from './helpers/proxy';

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

  it('pins in the cache are the paths storage sees (recordingsBusy)', () => {
    const path = p.proxy.recordings.cache.path(CACHED);
    expect(path).toBe(join(p.proxy.running.server.dataDir, 'recordings', 'cam1', CACHED));
    const unpin = p.proxy.recordings.cache.pin(path);
    // Storage enumerates join(dataDir, 'recordings', cam, name): the same string.
    expect(p.proxy.recordings.cache.files().map((f) => f.path)).toContain(path);
    expect(p.proxy.recordings.cache.busy(path)).toBe(true);
    unpin();
  });

  it('downloads a recording from cam-sim over Baichuan into the cache, and records the result', async () => {
    const rec = sim.sim.engine.sd.all().find((r) => r.end !== null)!;
    const id = basename(rec.files.sub.name);
    const entry = await p.proxy.recordings.list.find(id);
    expect(entry?.path).toBe(rec.files.sub.name);
    await p.proxy.recordings.fetcher.get(entry!, { priority: 'high' }).fetch.done;
    expect(p.proxy.recordings.cache.has(id)).toBe(true);
    const st = await request(p.base).get('/control/status').set(auth(ADMIN_TOKEN));
    expect(st.body.recordings.last).toMatchObject({ result: 'ok', stream: 'sub', bytes: rec.files.sub.size });
    const m = await request(p.base).get('/metrics');
    expect(m.text).toContain('camproxy_recording_downloads_total{cam="cam1",stream="sub",result="ok"} 1');
    expect(m.text).toContain('camproxy_disk_bytes{kind="recordings"}');
    expect(p.proxy.recordings.session.connected()).toBe(true);
    // One info line per download: camera, id, stream, bytes, ms, result.
    const line = logBuffer.recent(500).find((l) => l.msg === 'recording_download' && l.id === id);
    expect(line).toMatchObject({ camera: 'cam1', stream: 'sub', bytes: rec.files.sub.size, result: 'ok' });
    expect(typeof line?.ms).toBe('number');
    // Never a secret in the log.
    expect(JSON.stringify(logBuffer.recent(500))).not.toContain(sim.password);
  });

  it('a change of camera.baichuanPort closes the session; the next use connects to the new port', async () => {
    expect(p.proxy.recordings.session.connected()).toBe(true);
    const port = p.proxy.running.camera.baichuanPort;
    const r = await request(p.base).put('/control/config').set(auth(ADMIN_TOKEN)).send({ camera: { baichuanPort: port === 1 ? 2 : 1 } });
    expect(r.status).toBeLessThan(300);
    expect(p.proxy.recordings.session.connected()).toBe(false);
    await until(() => sim.sim.engine.counters.baichuanSessions === 0);
    // Back to the camera's port: the next download connects again.
    const back = await request(p.base).put('/control/config').set(auth(ADMIN_TOKEN)).send({ camera: { baichuanPort: port } });
    expect(back.status).toBeLessThan(300);
    const rec = sim.sim.engine.sd.all().filter((r) => r.end !== null)[1]!;
    const entry = await p.proxy.recordings.list.find(basename(rec.files.sub.name));
    await p.proxy.recordings.fetcher.get(entry!, { priority: 'high' }).fetch.done;
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
