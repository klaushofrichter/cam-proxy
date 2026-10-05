import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { createMetrics } from '../src/api/metrics';
import { openCatalog } from '../src/catalog/db';
import { DEFAULTS } from '../src/config/defaults';
import { Storage } from '../src/storage';
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
});
