import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { openCatalog } from '../src/catalog/db';
import { insertEvent, listEvents } from '../src/catalog/events';
import { StreamLog } from '../src/stream/log';
import { Storage } from '../src/storage';
import { DEFAULTS, type Config } from '../src/config/defaults';
import { minutePath, MinuteStore } from '../src/stills/store';
import sharp from 'sharp';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 8, 27, 12, 0);

function setup(tweak: (c: Config) => void = () => undefined, disk = { free: 100 * 2 ** 30, size: 200 * 2 ** 30 }) {
  const dir = mkdtempSync(join(tmpdir(), 'camproxy-storage-'));
  const catalog = openCatalog(join(dir, 'catalog.sqlite'));
  const log = new StreamLog(catalog, () => NOW);
  const config = structuredClone(DEFAULTS);
  config.server.dataDir = dir;
  tweak(config);
  const fs = { ...disk };
  const storage = new Storage({ catalog, log, config: () => config, now: () => NOW, statfs: () => fs });
  // A fake minute file of `bytes` for `kind` at time `ts`.
  const put = (kind: 'stills' | 'previews', ts: number, bytes = 1000) => {
    const base = minutePath(dir, kind, 'cam1', ts);
    const file = kind === 'stills' ? `${base}.pack` : `${base}.jpg`;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, Buffer.alloc(bytes));
    if (kind === 'previews') writeFileSync(`${base}.json`, '{}');
    return file;
  };
  return { dir, catalog, log, config, storage, put, fs };
}

describe('storage: age', () => {
  it('deletes day folders past each kind’s retention, and old rows', () => {
    const { storage, put, catalog, log } = setup();
    const oldStill = put('stills', NOW - 8 * DAY);
    const keptStill = put('stills', NOW - 6 * DAY);
    const oldPreviewKept = put('previews', NOW - 8 * DAY); // previews keep 14 days
    const oldPreview = put('previews', NOW - 15 * DAY);
    insertEvent(catalog, { cam: 'cam1', source: 'onvif', kind: 'person', start_ts: NOW - 31 * DAY, raw: null });
    log.append('cam1', 'camera-status', { online: true });
    storage.recount();
    const r = storage.run({});
    expect(existsSync(oldStill)).toBe(false);
    expect(existsSync(keptStill)).toBe(true);
    expect(existsSync(oldPreviewKept)).toBe(true);
    expect(existsSync(oldPreview)).toBe(false);
    expect(r.deleted).toMatchObject({ stills: 1, previews: 2, events: 1 });
    expect(listEvents(catalog, { cam: 'cam1' })).toHaveLength(0);
    expect(r.reason).toContain('age');
  });
});

describe('storage: budget', () => {
  // The catalog counts toward the budget (spec §8a): budgets are its size plus files.
  const budget = (x: ReturnType<typeof setup>, files: number) => {
    delete x.config.storage.maxPercent;
    x.config.storage.maxBytes = x.catalog.sizeBytes() + files;
  };

  it('deletes the oldest hour first, stills before previews, keeping keepHours', () => {
    const x = setup((c) => (c.storage.keepHours = { stills: 2, clips: 0, previews: 0 }));
    for (let h = 5; h >= 0; h--) for (let m = 0; m < 2; m++) x.put('stills', NOW - h * HOUR - m * 60_000, 1000); // 12 kB of stills
    x.put('previews', NOW - 5 * HOUR, 1000);
    x.storage.recount();
    expect(x.storage.usage().stills.bytes).toBe(12_000);
    budget(x, 10_000);
    const r = x.storage.run({});
    const u = x.storage.usage();
    expect(u.stills.bytes + u.previews.bytes).toBeLessThanOrEqual(10_000);
    expect(u.stills.oldest).toBeGreaterThan(NOW - 6 * HOUR); // the oldest hour went first
    expect(u.stills.newest).toBe(NOW); // the newest keepHours stay
    expect(u.previews.files).toBe(2); // previews come after stills
    expect(r.reason).toContain('budget');
  });

  it('turns to previews once only keepHours of stills is left', () => {
    const x = setup((c) => (c.storage.keepHours = { stills: 24, clips: 0, previews: 0 }));
    x.put('stills', NOW - HOUR, 1000);
    const prev = x.put('previews', NOW - 3 * HOUR, 1000);
    x.storage.recount();
    budget(x, 1500);
    x.storage.run({});
    expect(existsSync(prev)).toBe(false);
    expect(x.storage.usage().stills.files).toBe(1);
  });

  it('a dry run reports the same and deletes nothing', () => {
    const x = setup((c) => (c.storage.keepHours = { stills: 0, clips: 0, previews: 0 }));
    for (let h = 0; h < 4; h++) x.put('stills', NOW - h * HOUR, 1000);
    x.storage.recount();
    budget(x, 2000);
    const dry = x.storage.run({ dryRun: true });
    expect(readdirSync(join(x.dir, 'stills/cam1/2026/09/27'))).toHaveLength(4);
    const real = x.storage.run({});
    expect(dry.deleted.stills).toBeGreaterThan(0);
    expect(real.deleted.stills).toBe(dry.deleted.stills);
  });

  it('applies a per-kind cap', () => {
    const x = setup((c) => (c.storage.keepHours = { stills: 0, clips: 0, previews: 0 }));
    for (let h = 0; h < 3; h++) x.put('stills', NOW - h * HOUR, 1000);
    x.storage.recount();
    x.config.stills.maxGB = 1;
    expect(x.storage.run({ dryRun: true }).deleted.stills ?? 0).toBe(0); // under 1 GB
  });
});

describe('storage: files written after start', () => {
  it('deletes minutes the store wrote while running, not only those counted at start', async () => {
    const x = setup((c) => {
      c.retention.stillsDays = 1;
      c.retention.previewsDays = 1;
    });
    x.storage.recount();
    const store = new MinuteStore({ dataDir: x.dir, cam: 'cam1', intervalS: 1, still: { size: '16x9', quality: 5 }, tile: { size: '16x9', grid: '10x6', quality: 7 } });
    store.on('written', (w: { kind: 'stills' | 'previews'; bytes: number; files: number }) => x.storage.noteWritten(w.kind, w.bytes, w.files));
    const jpeg = await sharp({ create: { width: 16, height: 9, channels: 3, background: '#333' } }).jpeg().toBuffer();
    const old = NOW - 3 * DAY; // written now (the proxy was running), aged out by the next run
    store.add({ ts: old, still: jpeg, tile: jpeg });
    await store.flush();
    const pack = `${minutePath(x.dir, 'stills', 'cam1', old)}.pack`;
    expect(existsSync(pack)).toBe(true);
    x.storage.run({});
    expect(existsSync(pack)).toBe(false);
    expect(existsSync(`${minutePath(x.dir, 'previews', 'cam1', old)}.jpg`)).toBe(false);
  });
});

describe('storage: floor and accounting', () => {
  it('pauses writing below minFreeBytes and resumes when space is back', () => {
    const { storage, fs, config } = setup();
    const events: boolean[] = [];
    storage.on('paused', (p: boolean) => events.push(p));
    fs.free = config.storage.minFreeBytes - 1;
    storage.check();
    expect(storage.paused()).toBe(true);
    fs.free = config.storage.minFreeBytes + 1;
    storage.check();
    expect(storage.paused()).toBe(false);
    expect(events).toEqual([true, false]);
  });

  it('counts files once at start and keeps count as the store writes', () => {
    const { storage, put } = setup();
    put('stills', NOW - HOUR, 500);
    put('previews', NOW - HOUR, 300);
    storage.recount();
    expect(storage.usage().stills).toMatchObject({ bytes: 500, files: 1 });
    expect(storage.usage().previews).toMatchObject({ bytes: 302, files: 2 });
    storage.noteWritten('stills', 700, 1);
    expect(storage.usage().stills).toMatchObject({ bytes: 1200, files: 2 });
    expect(storage.usage().stills.growthPerDay).toBeGreaterThan(0);
    expect(storage.usage().daysUntilFull).toBeGreaterThan(0);
  });

  it('a failing scheduled run is logged and retried later, never crashing the process', async () => {
    const { storage, catalog } = setup();
    const failures: string[] = [];
    storage.on('failed', (m: string) => failures.push(m));
    catalog.close();
    storage.start({ firstMs: 0, everyMs: 20 });
    await new Promise((r) => setTimeout(r, 120));
    storage.stop();
    expect(failures.length).toBeGreaterThanOrEqual(2);
  });
});
