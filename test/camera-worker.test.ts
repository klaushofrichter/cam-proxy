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
import { CameraWorker } from '../src/cameras/worker';
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

function worker() {
  const dir = mkdtempSync(join(tmpdir(), 'camproxy-worker-'));
  writeFileSync(join(dir, 'config.json'), JSON.stringify({
    camera: { host: sim.camera.host, protocol: 'http', user: 'proxy', onvifPort: sim.ports.onvif, rtspPort: sim.ports.rtsp || 554, baichuanPort: sim.camera.baichuanPort, statusPollS: 5 },
    stills: { enabled: false },
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
