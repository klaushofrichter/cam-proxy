import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { describe, expect, it } from 'vitest';
import { openCatalog } from '../src/catalog/db';
import { cameraDefaults, DEFAULTS, type Config } from '../src/config/defaults';
import { minutePath } from '../src/stills/store';
import { shareBytes, Storage } from '../src/storage';
import { StreamLog } from '../src/stream/log';

const HOUR = 3600_000;
const NOW = Date.UTC(2026, 9, 5, 12, 0);

function setup(shares: Record<string, number | undefined>) {
  const dir = mkdtempSync(join(tmpdir(), 'camproxy-shares-'));
  const catalog = openCatalog(join(dir, 'catalog.sqlite'));
  const log = new StreamLog(catalog, () => NOW);
  const config: Config = structuredClone(DEFAULTS);
  config.server.dataDir = dir;
  config.cameraOrder = Object.keys(shares);
  config.cameras = Object.fromEntries(Object.entries(shares).map(([id, p]) => [id, { ...cameraDefaults(id), storage: p === undefined ? {} : { sharePercent: p } }]));
  config.storage = { maxBytes: 12_000, minFreeBytes: 0, keepHours: { stills: 0, clips: 0, previews: 0 } };
  // The catalog's own size counts against the budget: left out here, so the numbers stay exact.
  const storage = new Storage({ catalog: Object.assign(Object.create(catalog), { sizeBytes: () => 0 }), log, config: () => config, now: () => NOW, statfs: () => ({ free: 1e12, size: 2e12 }) });
  const put = (cam: string, ts: number, bytes: number) => {
    const file = `${minutePath(dir, 'stills', cam, ts)}.pack`;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, Buffer.alloc(bytes));
  };
  return { config, storage, put, catalog };
}

describe('storage shares (spec 2026-10-05-multi-camera-host-design §8.1)', () => {
  it('share rules: one share alone leaves the rest to the others; 0 reserves nothing (Ruling P2-2)', () => {
    const { config } = setup({ cam3: 50, cam4: undefined, cam5: 0 });
    expect(Object.fromEntries(shareBytes(config, 1000))).toEqual({ cam3: 500, cam4: 500, cam5: 0 });
    const none = setup({ cam3: undefined, cam4: undefined }).config;
    expect(Object.fromEntries(shareBytes(none, 1000))).toEqual({ cam3: 500, cam4: 500 });
  });

  it('with shares: the camera most above its share loses its oldest hour first', () => {
    const { storage, put, catalog } = setup({ cam3: 75, cam4: 25 });
    // cam3: 4 h × 1000 = 4000 (share 9000); cam4: 10 h × 1000 = 10000 (share 3000). Budget 12000: cam4 loses 2 hours.
    for (let h = 1; h <= 4; h++) put('cam3', NOW - h * HOUR - 20 * HOUR, 1000); // cam3's are the oldest of all
    for (let h = 1; h <= 10; h++) put('cam4', NOW - h * HOUR, 1000);
    const r = storage.run({});
    expect(r.reason).toContain('budget');
    const by = storage.usageByCamera();
    expect(by.cam3.stills.files).toBe(4); // untouched although oldest
    expect(by.cam4.stills.files).toBe(8);
    catalog.close();
  });

  it('without shares: the oldest hour across all cameras (fair by age)', () => {
    const { storage, put, catalog } = setup({ cam3: undefined, cam4: undefined });
    for (let h = 1; h <= 4; h++) put('cam3', NOW - h * HOUR - 20 * HOUR, 1000);
    for (let h = 1; h <= 10; h++) put('cam4', NOW - h * HOUR, 1000);
    storage.run({});
    expect(storage.usageByCamera().cam3.stills.files).toBe(2); // its two oldest hours went first
    expect(storage.usageByCamera().cam4.stills.files).toBe(10);
    catalog.close();
  });

  it('noteWritten counts the camera it names', () => {
    const { storage, catalog } = setup({ cam3: undefined, cam4: undefined });
    storage.noteWritten('stills', 500, 1, { cam: 'cam3' });
    storage.noteWritten('stills', 700, 1, { cam: 'cam4' });
    expect(storage.usageByCamera().cam3.stills).toEqual({ bytes: 500, files: 1 });
    expect(storage.usageByCamera().cam4.stills).toEqual({ bytes: 700, files: 1 });
    catalog.close();
  });
});
