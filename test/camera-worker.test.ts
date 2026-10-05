import { chmodSync, mkdtempSync, writeFileSync } from 'fs';
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
import { ADMIN_TOKEN, CLIENT_TOKEN, until } from './helpers/proxy';
import { startSim } from './helpers/sim';

let sim: Awaited<ReturnType<typeof startSim>>;
beforeAll(async () => {
  sim = await startSim();
});
afterAll(async () => {
  await sim.close();
});

const NO_HOOKS = { onCameraCheck() {}, onResubscribe() {}, onStill() {}, onStillMissing() {}, onRecordingDownload() {} };

function worker(o: { host?: string; over?: Partial<WorkerDeps>; stills?: boolean; go2rtc?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'camproxy-worker-'));
  writeFileSync(join(dir, 'config.json'), JSON.stringify({
    camera: { host: o.host ?? sim.camera.host, protocol: 'http', user: 'proxy', onvifPort: sim.ports.onvif, rtspPort: sim.ports.rtsp || 554, baichuanPort: sim.camera.baichuanPort, statusPollS: 5 },
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
    id: 'cam1', index: 0, running: () => running, password: () => sim.password, poeSwitchPassword: () => undefined,
    ftpTarget: () => ({ server: '', port: 2121, user: 'camera', password: '', tls: true, stream: 'main' }),
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

  it('one camera: the whole recordings cache cap (Ruling P1-3)', () => {
    const { w, running, catalog } = worker();
    expect(w.recordings.status().cache.capBytes).toBe(running.recordings.cacheMB * 2 ** 20);
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

  // Review: a go2rtc that can't start reaches supervision (an error and a retry), not only the log.
  it('a go2rtc start failure sets the error and retries with the backoff', async () => {
    const delays: number[] = [];
    const { w, catalog } = worker({
      stills: true,
      over: { startGo2rtc: () => Promise.reject(new Error('no such file')), schedule: (ms) => (delays.push(ms), () => undefined) },
    });
    await w.start();
    await until(() => delays.length === 1);
    expect(delays).toEqual([5000]);
    expect(w.error()).toBe('go2rtc_start_failed: no such file');
    await w.stopSwitch();
    await w.stopRecordings();
    await w.stop();
    catalog.close();
  });

  // Live test 2026-10-05: a stop while go2rtc is still starting ends it at once (its ports free), not after the ready wait.
  it('a stop during the go2rtc start ends go2rtc at once', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'camproxy-slow-go2rtc-'));
    const fake = join(dir, 'go2rtc');
    writeFileSync(fake, '#!/bin/sh\nexec sleep 30\n');
    chmodSync(fake, 0o755);
    const { w, catalog } = worker({ stills: true, go2rtc: fake });
    await w.start();
    await until(() => w.stills?.go2rtc.pid() !== undefined);
    const t0 = Date.now();
    await w.stopSwitch();
    await w.stopRecordings();
    await w.stop();
    expect(Date.now() - t0).toBeLessThan(4000);
    expect(w.stills?.go2rtc.pid()).toBeUndefined();
    catalog.close();
  }, 20_000);
});
