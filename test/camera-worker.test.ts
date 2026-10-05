import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openCatalog } from '../src/catalog/db';
import { loadConfig } from '../src/config/load';
import { StreamLog } from '../src/stream/log';
import { sseHandler } from '../src/stream/sse';
import { Storage } from '../src/storage';
import { AuditLog } from '../src/audit/audit-log';
import { CameraWorker, type WorkerDeps } from '../src/cameras/worker';
import { CameraRegistry } from '../src/cameras/registry';
import { CachePool } from '../src/recordings/pool';
import { ADMIN_TOKEN, CLIENT_TOKEN, freePort, until } from './helpers/proxy';
import { logBuffer } from '../src/log';
import type { Go2rtc, StreamSource } from '../src/stills/go2rtc';
import { startSim } from './helpers/sim';

let sim: Awaited<ReturnType<typeof startSim>>;
beforeAll(async () => {
  sim = await startSim();
});
afterAll(async () => {
  await sim.close();
});

const NO_HOOKS = { onCameraCheck() {}, onResubscribe() {}, onStill() {}, onStillMissing() {}, onRecordingDownload() {} };

function worker(o: { host?: string; over?: Partial<WorkerDeps>; stills?: boolean; go2rtc?: string; onvifPort?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'camproxy-worker-'));
  writeFileSync(join(dir, 'config.json'), JSON.stringify({
    camera: { host: o.host ?? sim.camera.host, protocol: 'http', user: 'proxy', onvifPort: o.onvifPort ?? sim.ports.onvif, rtspPort: sim.ports.rtsp || 554, baichuanPort: sim.camera.baichuanPort, statusPollS: 5 },
    stills: { enabled: o.stills ?? false },
    ...(o.go2rtc ? { go2rtc: { binary: o.go2rtc } } : {}),
    server: { logLevel: 'silent' },
  }));
  const loaded = loadConfig({ CAMPROXY_TOKENS: CLIENT_TOKEN, CAMPROXY_ADMIN_TOKEN: ADMIN_TOKEN, CAMPROXY_CAMERA_PASSWORD: sim.password }, { cwd: dir });
  const running = structuredClone(loaded.config);
  const catalog = openCatalog(join(running.server.dataDir, 'catalog.sqlite'));
  const log = new StreamLog(catalog);
  const audit = new AuditLog({ dir: join(running.server.dataDir, 'audit'), version: 'test' });
  const storage = new Storage({ catalog, log, config: () => running, audit });
  const w = new CameraWorker({
    id: 'cam1', running: () => running, password: () => sim.password, poeSwitchPassword: () => undefined,
    ftpTarget: () => ({ server: '', port: 2121, user: 'camera', password: '', tls: true, stream: 'main' }),
    go2rtc: () => undefined,
    cachePool: new CachePool(() => running.recordings.cacheMB * 2 ** 20),
    catalog, log, sse: sseHandler(log, running.sse), storage, audit, hooks: NO_HOOKS,
    ...o.over,
  });
  return { w, running, catalog };
}

describe('CameraWorker (spec §3.1)', () => {
  it('starts, reads the camera, restarts, stops', async () => {
    const { w, catalog } = worker();
    expect(w.phase()).toBe('idle');
    await w.start();
    expect(w.phase()).toBe('ready');
    await until(() => w.status.state().online);
    await until(() => w.nameSource() === 'camera');
    const restart = w.restart();
    expect(w.phase()).toBe('restarting');
    await restart;
    expect(w.phase()).toBe('ready');
    await until(() => w.status.state().online);
    await w.stopSwitch();
    await w.stopRecordings();
    await w.stop();
    expect(w.phase()).toBe('stopped');
    catalog.close();
  });

  it("the host's recordings cache: the whole cap, the pool's figures and this camera's part (spec §8.3)", () => {
    const pool = new CachePool(() => 5 * 2 ** 20);
    const { w, running, catalog } = worker({ over: { cachePool: pool } });
    writeFileSync(join(running.server.dataDir, 'recordings', 'cam1', 'RecM01.mp4'), Buffer.alloc(100));
    expect(pool.usage().files).toBe(1);
    expect(w.recordings.status().cache).toEqual({ bytes: 100, files: 1, capBytes: 5 * 2 ** 20 });
    expect(w.recordings.status().camera).toEqual({ bytes: 100, files: 1 });
    catalog.close();
  });
});

describe('storage per camera (spec §8.1)', () => {
  it("the worker's stills and clips writes name its camera", async () => {
    const fake = { ready: () => new Promise<void>(() => undefined), up: () => false, streamUrl: () => 'rtsp://127.0.0.1:1/x', setStream: async () => undefined };
    const { w, catalog } = worker({ stills: true, over: { go2rtc: () => fake as unknown as Go2rtc } });
    const calls: unknown[][] = [];
    const storage = (w as unknown as { d: { storage: { noteWritten: (...a: unknown[]) => void } } }).d.storage;
    storage.noteWritten = (...a: unknown[]) => void calls.push(a);
    w.stills!.store.emit('written', { kind: 'stills', bytes: 10, files: 1 });
    (w.makeIndexer(true) as unknown as { d: { stored: (b: number) => void } }).d.stored(20);
    expect(calls).toEqual([['stills', 10, 1, { cam: 'cam1' }], ['clips', 20, 1, { growth: true, cam: 'cam1' }]]);
    catalog.close();
  });
});

describe('CameraRegistry', () => {
  it('lists in config order, finds by id, first()', () => {
    let order = ['b', 'a'];
    const r = new CameraRegistry(() => order);
    const fake = (id: string) => ({ id }) as unknown as CameraWorker;
    r.add(fake('a'));
    r.add(fake('b'));
    expect(r.ids()).toEqual(['b', 'a']);
    expect(r.first().id).toBe('b');
    expect(r.get('a')?.id).toBe('a');
    expect(r.get('zz')).toBeUndefined();
    order = ['a', 'b'];
    expect(r.list().map((w) => w.id)).toEqual(['a', 'b']);
    expect(r.size).toBe(2);
  });
});

describe('supervision (spec §3.3)', () => {
  it('a camera without an address stays idle with no_address and starts nothing', async () => {
    const before = sim.sim.engine.counters.loginAttempts;
    const { w, catalog } = worker({ host: '' });
    await w.start();
    expect(w.phase()).toBe('idle');
    expect(w.error()).toBe('no_address');
    await new Promise((r) => setTimeout(r, 300));
    expect(sim.sim.engine.counters.loginAttempts).toBe(before);
    await w.stop();
    catalog.close();
  });

  it('a failed start sets the error and retries after 5 s, then 10 s; success clears it', async () => {
    let failures = 2;
    const delays: number[] = [];
    let pending: (() => void) | undefined;
    const { w, catalog } = worker({
      over: {
        beforeStart: () => {
          if (failures-- > 0) throw new Error('go2rtc_start_failed');
        },
        schedule: (ms, fn) => ((delays.push(ms), (pending = fn)), () => undefined),
      },
    });
    await w.start();
    expect(w.error()).toBe('go2rtc_start_failed');
    expect(delays).toEqual([5000]);
    pending!();
    await until(() => delays.length === 2);
    expect(delays).toEqual([5000, 10000]);
    pending!();
    await until(() => w.phase() === 'ready');
    expect(w.error()).not.toBe('go2rtc_start_failed');
    await w.stopSwitch();
    await w.stopRecordings();
    await w.stop();
    catalog.close();
  });

  // P2 (spec §8.5): one go2rtc for the host. A go2rtc that isn't up is the
  // host's to retry; the camera's grabber waits for it, and a stop meanwhile is quick.
  it("waits for the host's go2rtc; a stop while waiting ends at once", async () => {
    const fake = { ready: () => new Promise<void>(() => undefined), up: () => false, streamUrl: (cam: string, s: string) => `rtsp://127.0.0.1:1/${cam}_${s}`, setStream: async () => undefined };
    const { w, catalog } = worker({ stills: true, over: { go2rtc: () => fake as unknown as Go2rtc } });
    await w.start();
    await new Promise((r) => setTimeout(r, 200));
    expect(w.stills?.grabber.pid()).toBeUndefined();
    expect(w.error()).toBeNull();
    const t0 = Date.now();
    await w.stopSwitch();
    await w.stopRecordings();
    await w.stop();
    expect(Date.now() - t0).toBeLessThan(2000);
    catalog.close();
  });

  it('a restart registers the stream source again only when it changed', async () => {
    let password = sim.password;
    const set: StreamSource[] = [];
    const fake = { ready: () => new Promise<void>(() => undefined), up: () => false, streamUrl: () => 'rtsp://127.0.0.1:1/x', setStream: async (s: StreamSource) => void set.push(s) };
    const { w, catalog } = worker({ stills: true, over: { go2rtc: () => fake as unknown as Go2rtc, password: () => password } });
    await w.start();
    await w.restart();
    expect(set).toEqual([]);
    password = 'changed-pw';
    await w.restart();
    expect(set.map((s) => [s.cam, s.password])).toEqual([['cam1', 'changed-pw']]);
    await w.stopSwitch();
    await w.stopRecordings();
    await w.stop();
    catalog.close();
  });

  // Live test 2026-10-05: log lines of a camera's parts (onvif_down, poll_failed, frame_grabber_exited, …) name the camera.
  it("its parts' log lines carry the camera id", async () => {
    const t0 = Date.now();
    const { w, catalog } = worker({ onvifPort: await freePort() });
    await w.start();
    const line = () => logBuffer.recent(500).find((l) => l.msg === 'onvif_down' && (l.time as number) >= t0);
    await until(() => !!line(), 15_000);
    expect(line()!.cameraId).toBe('cam1');
    await w.stopSwitch();
    await w.stopRecordings();
    await w.stop();
    catalog.close();
  }, 20_000);
});
