import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { createMetrics } from '../src/api/metrics';
import { openCatalog } from '../src/catalog/db';
import { DEFAULTS } from '../src/config/defaults';
import { Storage } from '../src/storage';
import { insertEvent } from '../src/catalog/events';
import { StreamLog } from '../src/stream/log';

describe('metrics with several cameras', () => {
  it('one camera_up sample per camera; counters labelled by the camera they came from', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'camproxy-metrics-'));
    const catalog = openCatalog(join(dir, 'catalog.sqlite'));
    const log = new StreamLog(catalog);
    const config = structuredClone(DEFAULTS);
    config.server.dataDir = dir;
    const storage = new Storage({ catalog, log, config: () => config, statfs: () => ({ free: 1e12, size: 2e12 }) });
    const m = createMetrics({
      storage, config: () => config, catalog, log, sseClients: () => 0, version: 'test', target: 'test',
      cameras: () => [
        { id: 'cam3', up: true, ftpEnabled: null, clips: null, onvifSubscribed: true, stills: undefined },
        { id: 'cam4', up: false, ftpEnabled: null, clips: null, onvifSubscribed: false, stills: undefined },
      ],
    });
    m.onStill('cam4', 1_000_000);
    const text = await m.render();
    expect(text).toMatch(/camproxy_camera_up\{cam="cam3"\} 1/);
    expect(text).toMatch(/camproxy_camera_up\{cam="cam4"\} 0/);
    expect(text).toMatch(/camproxy_stills_total\{cam="cam4"\} 1/);
  });

  it('stills, previews and events per camera (spec §8.1)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'camproxy-metrics-'));
    const catalog = openCatalog(join(dir, 'catalog.sqlite'));
    const log = new StreamLog(catalog);
    const config = structuredClone(DEFAULTS);
    config.server.dataDir = dir;
    const storage = new Storage({ catalog, log, config: () => config, statfs: () => ({ free: 1e12, size: 2e12 }) });
    storage.noteWritten('stills', 100, 1, { cam: 'cam3' });
    storage.noteWritten('stills', 100, 1, { cam: 'cam4' });
    storage.noteWritten('previews', 100, 2, { cam: 'cam4' });
    insertEvent(catalog, { cam: 'cam4', source: 'onvif', kind: 'person', start_ts: 1000, raw: null });
    const m = createMetrics({
      storage, config: () => config, catalog, log, sseClients: () => 0, version: 'test', target: 'test',
      cameras: () => ['cam3', 'cam4'].map((id) => ({ id, up: true, ftpEnabled: null, clips: null, onvifSubscribed: true, stills: undefined })),
    });
    const text = await m.render();
    expect(text).toMatch(/camproxy_stills_minutes_stored\{cam="cam3"\} 1/);
    expect(text).toMatch(/camproxy_stills_minutes_stored\{cam="cam4"\} 1/);
    expect(text).toMatch(/camproxy_previews_stored\{cam="cam4"\} 1/);
    expect(text).toMatch(/camproxy_events_stored\{cam="cam4",kind="person"\} 1/);
    expect(text).not.toMatch(/camproxy_events_stored\{cam="cam3"/);
  });
});
