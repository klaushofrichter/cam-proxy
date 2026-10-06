import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { createMetrics } from '../src/api/metrics';
import { openCatalog } from '../src/catalog/db';
import { DEFAULTS } from '../src/config/defaults';
import { Storage } from '../src/storage';
import { StreamLog } from '../src/stream/log';

function metrics(certs?: () => { cam: string; notAfter: number | null }[]) {
  const dir = mkdtempSync(join(tmpdir(), 'camproxy-metrics-certs-'));
  const catalog = openCatalog(join(dir, 'catalog.sqlite'));
  const log = new StreamLog(catalog);
  const config = structuredClone(DEFAULTS);
  config.server.dataDir = dir;
  const storage = new Storage({ catalog, log, config: () => config, statfs: () => ({ free: 1e12, size: 2e12 }) });
  return createMetrics({ storage, config: () => config, catalog, log, sseClients: () => 0, version: 'test', target: 'test', cameras: () => [], ...(certs ? { certs } : {}) });
}

describe('certificate metrics (spec §10.5)', () => {
  it('camproxy_cert_not_after_seconds per camera and the proxy; camproxy_cert_push_total by outcome', async () => {
    const m = metrics(() => [{ cam: 'proxy', notAfter: 2_000_000_000_000 }, { cam: 'cam3', notAfter: 1_900_000_000_000 }, { cam: 'cam4', notAfter: null }]);
    m.onCertPush('cam3', 'pushed');
    m.onCertPush('cam4', 'refused');
    const text = await m.render();
    expect(text).toMatch(/camproxy_cert_not_after_seconds\{cam="proxy"\} 2000000000/);
    expect(text).toMatch(/camproxy_cert_not_after_seconds\{cam="cam3"\} 1900000000/);
    expect(text).not.toMatch(/camproxy_cert_not_after_seconds\{cam="cam4"\}/);
    expect(text).toMatch(/camproxy_cert_push_total\{cam="cam3",outcome="pushed"\} 1/);
    expect(text).toMatch(/camproxy_cert_push_total\{cam="cam4",outcome="refused"\} 1/);
  });
  it('without a site CA (the Pi): no certificate samples', async () => {
    const text = await metrics().render();
    expect(text).not.toMatch(/camproxy_cert_not_after_seconds\{/);
    expect(text).not.toMatch(/camproxy_cert_push_total\{/);
  });
});
