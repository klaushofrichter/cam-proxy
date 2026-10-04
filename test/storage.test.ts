import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync, readdirSync, mkdirSync, unlinkSync, utimesSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { openCatalog } from '../src/catalog/db';
import { insertEvent, listEvents } from '../src/catalog/events';
import { clipById, insertClip } from '../src/catalog/clips';
import { StreamLog } from '../src/stream/log';
import { Storage } from '../src/storage';
import { DEFAULTS, type Config } from '../src/config/defaults';
import { minutePath, MinuteStore } from '../src/stills/store';
import { AuditLog } from '../src/audit/audit-log';
import { saveAnalysis } from '../src/catalog/analyses';
import { checkById, insertCheck, setCheckImage } from '../src/catalog/still-checks';
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

describe('storage: clips', () => {
  // A clip as the indexer stores it: the file, its snapshot and its row.
  const putClip = (x: ReturnType<typeof setup>, ts: number, bytes = 1000) => {
    const d = new Date(ts);
    const p2 = (n: number) => String(n).padStart(2, '0');
    const folder = join(x.dir, 'clips', 'cam1', String(d.getUTCFullYear()), p2(d.getUTCMonth() + 1), p2(d.getUTCDate()));
    mkdirSync(folder, { recursive: true });
    const path = join(folder, `${p2(d.getUTCHours())}${p2(d.getUTCMinutes())}-${ts}.mp4`);
    writeFileSync(path, Buffer.alloc(bytes));
    writeFileSync(path.replace(/\.mp4$/, '.jpg'), Buffer.alloc(10));
    return insertClip(x.catalog, { cam: 'cam1', start_ts: ts, end_ts: ts + 20_000, path, stream: 'main', size: bytes, received_at: ts, snapshot: path.replace(/\.mp4$/, '.jpg') });
  };

  it('ages clips out by clipsDays, with their rows', () => {
    const x = setup((c) => (c.retention.clipsDays = 2));
    const old = putClip(x, NOW - 3 * DAY);
    const kept = putClip(x, NOW - HOUR);
    const r = x.storage.run({});
    expect(r.deleted.clips).toBe(2); // the clip and its snapshot
    expect(existsSync(old.path)).toBe(false);
    expect(clipById(x.catalog, old.id)).toBeUndefined();
    expect(clipById(x.catalog, kept.id)).toBeDefined();
    expect(existsSync(kept.path)).toBe(true);
  });

  it('over budget: stills first, then clips, then previews', () => {
    const x = setup((c) => (c.storage.keepHours = { stills: 0, clips: 0, previews: 0 }));
    x.put('stills', NOW - 5 * HOUR, 1000);
    const clip = putClip(x, NOW - 6 * HOUR, 1000);
    x.put('previews', NOW - 7 * HOUR, 1000);
    x.storage.recount();
    delete x.config.storage.maxPercent;
    // Room for the previews (1000 + 2) and nothing else.
    x.config.storage.maxBytes = x.catalog.sizeBytes() + 1002;
    x.storage.run({});
    expect(x.storage.usage().stills.bytes).toBe(0);
    expect(x.storage.usage().clips.bytes).toBe(0);
    expect(clipById(x.catalog, clip.id)).toBeUndefined();
    expect(x.storage.usage().previews.bytes).toBe(1002);
  });

  it('never counts uploads in progress; removes temp files older than a day', () => {
    const x = setup();
    const incoming = join(x.dir, 'ftp', '.incoming');
    mkdirSync(incoming, { recursive: true });
    writeFileSync(join(incoming, 'fresh'), Buffer.alloc(5000));
    writeFileSync(join(incoming, 'stale'), Buffer.alloc(5000));
    utimesSync(join(incoming, 'stale'), (NOW - 2 * DAY) / 1000, (NOW - 2 * DAY) / 1000);
    x.storage.run({});
    expect(x.storage.usage().clips.bytes).toBe(0);
    expect(readdirSync(incoming)).toEqual(['fresh']);
  });
});

describe('storage: audit', () => {
  // #106: a pause explains still gaps only when it leaves a record.
  it('writes storage-paused and storage-resumed records when the floor check flips', () => {
    const { dir, catalog, log, config, fs } = setup();
    const audit = new AuditLog({ dir: join(dir, 'audit'), version: 't', camera: () => 'cam1', now: () => NOW });
    const s = new Storage({ catalog, log, config: () => config, now: () => NOW, statfs: () => fs, audit });
    fs.free = config.storage.minFreeBytes - 1;
    s.check();
    s.check(); // no change: no second record
    fs.free = config.storage.minFreeBytes + 1;
    s.check();
    const recs = audit.list({ actions: ['storage-paused', 'storage-resumed'], after: '', limit: 10 }).records;
    expect(recs.map((r) => [r.event.action, r.event.outcome])).toEqual([['storage-paused', 'failure'], ['storage-resumed', 'success']]);
    expect(recs[0].cam_proxy).toMatchObject({ free: config.storage.minFreeBytes - 1, minFreeBytes: config.storage.minFreeBytes });
    expect(recs[0].event.category).toEqual(['host']);
    expect(recs.map((r) => (r as { user?: { name?: string } }).user?.name)).toEqual(['system', 'system']);
  });

  it('counts the audit folder in usage and the budget, and sweeps its old days by auditDays', () => {
    const { dir, catalog, log, config, fs } = setup();
    const auditDir = join(dir, 'audit');
    const audit = new AuditLog({ dir: auditDir, version: 't', camera: () => 'cam1', now: () => NOW });
    mkdirSync(auditDir, { recursive: true });
    for (const t of [NOW - 200 * DAY, NOW - 100 * DAY, NOW]) writeFileSync(join(auditDir, `${new Date(t).toISOString().slice(0, 10)}.jsonl`), 'x'.repeat(100) + '\n');
    config.retention.auditDays = 90;
    const s = new Storage({ catalog, log, config: () => config, now: () => NOW, statfs: () => fs, audit });
    s.recount();
    expect(s.usage().audit).toMatchObject({ files: 3, bytes: 303 });
    expect(s.usage().used).toBeGreaterThanOrEqual(303);
    const run = s.run({ dryRun: false });
    expect(run.deleted.audit).toBe(2);
    expect(s.usage().audit.files).toBe(1);
  });

  // #78: the budget never deletes audit days, even when it can't be met; a dry run deletes nothing.
  it('never deletes audit days for the budget; a dry run reports the sweep and deletes nothing', () => {
    const x = setup((c) => (c.storage.keepHours = { stills: 0, clips: 0, previews: 0 }));
    const auditDir = join(x.dir, 'audit');
    const audit = new AuditLog({ dir: auditDir, version: 't', camera: () => 'cam1', now: () => NOW });
    mkdirSync(auditDir, { recursive: true });
    const days = [NOW - 200 * DAY, NOW - 2 * DAY, NOW - DAY, NOW].map((t) => `${new Date(t).toISOString().slice(0, 10)}.jsonl`);
    for (const d of days) writeFileSync(join(auditDir, d), 'x'.repeat(5000) + '\n');
    x.config.retention.auditDays = 90;
    const s = new Storage({ catalog: x.catalog, log: x.log, config: () => x.config, now: () => NOW, statfs: () => x.fs, audit });
    for (let h = 0; h < 3; h++) x.put('stills', NOW - h * HOUR, 1000);
    s.recount();
    delete x.config.storage.maxPercent;
    x.config.storage.maxBytes = x.catalog.sizeBytes() + 1000; // far below the audit folder alone
    const dry = s.run({ dryRun: true });
    expect(dry.deleted.audit).toBe(1);
    expect(readdirSync(auditDir).sort()).toEqual([...days].sort());
    const real = s.run({});
    expect(real.deleted.audit).toBe(1); // the day past auditDays, nothing for the budget
    expect(readdirSync(auditDir).sort()).toEqual(days.slice(1).sort());
    expect(real.deleted.stills).toBe(2); // the budget took what it may (the current minute stays)
  });
});

describe('storage: the recordings cache', () => {
  const putRec = (dir: string, id: string, bytes: number, usedAt: number) => {
    const p = join(dir, 'recordings', 'cam1', id);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, Buffer.alloc(bytes));
    utimesSync(p, new Date(usedAt), new Date(usedAt));
    return p;
  };
  const budget = (x: ReturnType<typeof setup>, files: number) => {
    delete x.config.storage.maxPercent;
    x.config.storage.maxBytes = x.catalog.sizeBytes() + files;
  };

  it('counts cached recordings (not .part files), least recently used as the oldest', () => {
    const x = setup();
    putRec(x.dir, 'RecS0A_A.mp4', 1000, NOW - DAY);
    putRec(x.dir, 'RecS0A_B.mp4', 500, NOW - HOUR);
    writeFileSync(join(x.dir, 'recordings', 'cam1', 'RecS0A_C.mp4.part'), Buffer.alloc(700));
    x.storage.recount();
    expect(x.storage.usage().recordings).toMatchObject({ bytes: 1500, files: 2, oldest: NOW - DAY, newest: NOW - HOUR });
  });

  it('never ages recordings out', () => {
    const x = setup();
    const old = putRec(x.dir, 'RecS0A_A.mp4', 1000, NOW - 300 * DAY);
    x.storage.recount();
    x.storage.run({});
    expect(existsSync(old)).toBe(true);
  });

  it('applies recordings.cacheMB at a storage run, least recently used first', () => {
    const x = setup((c) => (c.recordings.cacheMB = 1));
    const a = putRec(x.dir, 'RecS0A_A.mp4', 600_000, NOW - DAY);
    const b = putRec(x.dir, 'RecS0A_B.mp4', 600_000, NOW - HOUR);
    x.storage.recount();
    const r = x.storage.run({});
    expect([existsSync(a), existsSync(b)]).toEqual([false, true]);
    expect(r.deleted.recordings).toBe(1);
    expect(r.reason).toContain('cap');
  });

  it('over budget: recordings go first, least recently used, before any still; no keepHours', () => {
    const x = setup((c) => (c.storage.keepHours = { stills: 0, clips: 0, previews: 0 }));
    const still = x.put('stills', NOW - 5 * HOUR, 1000);
    const old = putRec(x.dir, 'RecS0A_A.mp4', 1000, NOW - 2 * DAY);
    const recent = putRec(x.dir, 'RecS0A_B.mp4', 1000, NOW - 60_000);
    x.storage.recount();
    budget(x, 2000);
    const r = x.storage.run({});
    expect([existsSync(old), existsSync(recent), existsSync(still)]).toEqual([false, true, true]);
    expect(r.deleted.recordings).toBe(1);
    expect(r.deleted.stills ?? 0).toBe(0);
  });

  // Review Focus 3.
  it('skips a file in use and takes the next least recently used', () => {
    const x = setup();
    const busyOne = putRec(x.dir, 'RecS0A_A.mp4', 1000, NOW - 2 * DAY);
    const next = putRec(x.dir, 'RecS0A_B.mp4', 1000, NOW - DAY);
    const storage = new Storage({ catalog: x.catalog, log: x.log, config: () => x.config, now: () => NOW, statfs: () => x.fs, recordingsBusy: (p) => p === busyOne });
    storage.recount();
    budget(x, 1000);
    storage.run({});
    expect([existsSync(busyOne), existsSync(next)]).toEqual([true, false]);
  });

  it('a dry run reports and deletes nothing; noteWritten counts until the next recount', () => {
    const x = setup((c) => (c.recordings.cacheMB = 1));
    const a = putRec(x.dir, 'RecS0A_A.mp4', 600_000, NOW - DAY);
    putRec(x.dir, 'RecS0A_B.mp4', 600_000, NOW - HOUR);
    x.storage.recount();
    expect(x.storage.run({ dryRun: true }).deleted.recordings).toBe(1);
    expect(existsSync(a)).toBe(true);
    putRec(x.dir, 'RecS0A_C.mp4', 300, NOW); // the fetcher's file, after its rename
    x.storage.noteWritten('recordings', 300, 1);
    expect(x.storage.usage().recordings.bytes).toBe(1_200_300);
  });

  // Final review 3.
  it('recordings writes have a growthPerDay but never count toward daysUntilFull (a capped cache)', () => {
    const x = setup();
    x.put('stills', NOW - HOUR, 1000);
    x.storage.recount();
    x.storage.noteWritten('stills', 3 * 1000, 1);
    const before = x.storage.usage().daysUntilFull;
    putRec(x.dir, 'RecS0A_A.mp4', 3 * 1_000_000, NOW);
    x.storage.noteWritten('recordings', 3 * 1_000_000, 1);
    const u = x.storage.usage();
    expect(u.recordings.growthPerDay).toBe(1_000_000);
    expect(u.stills.growthPerDay).toBe(1000);
    expect(u.daysUntilFull).toBeCloseTo(before! - 3_000_000 / 1000, 3); // the used bytes count, the growth doesn't
  });

  // #74 final review: repaired clips are old recordings fetched back, not growth.
  it('a write marked not growth (the clips repair) counts as usage but not in growthPerDay', () => {
    const x = setup();
    x.storage.recount();
    x.storage.noteWritten('clips', 3 * 1000, 1);
    const before = x.storage.usage();
    x.storage.noteWritten('clips', 3 * 1_000_000, 1, { growth: false });
    const u = x.storage.usage();
    expect(u.clips.growthPerDay).toBe(1000);
    expect(u.clips.bytes).toBe(before.clips.bytes + 3_000_000);
    expect(u.daysUntilFull).toBeCloseTo(before.daysUntilFull! - 3_000_000 / 1000, 3);
  });

  // Final review 4.
  it('usage() recounts the recordings folder: files the cache evicted are gone from the bytes at once', () => {
    const x = setup();
    const a = putRec(x.dir, 'RecS0A_A.mp4', 1000, NOW - DAY);
    putRec(x.dir, 'RecS0A_B.mp4', 500, NOW - HOUR);
    x.storage.recount();
    expect(x.storage.usage().recordings.bytes).toBe(1500);
    unlinkSync(a); // the cache's makeRoom
    expect(x.storage.usage().recordings).toMatchObject({ bytes: 500, files: 1 });
  });
});

// cams #179: still checks keep their JPEG in their own folder,
// data/still-checks/<cam>/ (coordinator ruling: an older proxy's retention
// never sweeps it, so a rollback keeps the images). The analytics folder
// keeps its old rule: only what an analysis names.
describe('storage: still checks', () => {
  const jpg = (dir: string, folder: 'analytics' | 'still-checks', name: string) => {
    const d = join(dir, folder, 'cam1');
    mkdirSync(d, { recursive: true });
    const f = join(d, name);
    writeFileSync(f, Buffer.from([0xff, 0xd8]));
    return f;
  };
  it('keeps the images a check names in its folder, deletes orphans and old checks with theirs; analytics files as before', () => {
    const { storage, catalog, dir } = setup();
    const e = insertEvent(catalog, { cam: 'cam1', source: 'onvif', kind: 'person', start_ts: NOW - DAY, raw: null });
    const analysisJpg = jpg(dir, 'analytics', `${e.id}.jpg`);
    saveAnalysis(catalog, { event_id: e.id, provider: 'google-vision', status: 'ok', reason: null, still_ts: NOW - DAY + 1000, image: analysisJpg, requested_at: NOW, took_ms: 1, objects: '[]', raw: null, summary: '[]' });
    const analysisOrphan = jpg(dir, 'analytics', '424242.jpg');
    const row = (ts: number) => insertCheck(catalog, { cam: 'cam1', still_ts: ts, provider: 'google-vision', requested_at: ts, requested_via: 'token', took_ms: 1, objects: '[]', raw: null, summary: '[]' });
    const kept = row(NOW - 2 * DAY);
    const keptJpg = jpg(dir, 'still-checks', `check-${kept.id}.jpg`);
    setCheckImage(catalog, kept.id, keptJpg);
    const old = row(NOW - 31 * DAY);
    const oldJpg = jpg(dir, 'still-checks', `check-${old.id}.jpg`);
    setCheckImage(catalog, old.id, oldJpg);
    const orphan = jpg(dir, 'still-checks', 'check-999.jpg');

    const dry = storage.run({ dryRun: true });
    expect(dry.deleted.stillChecks).toBe(1);
    expect(existsSync(oldJpg)).toBe(true);
    expect(existsSync(orphan)).toBe(true);

    const r = storage.run({});
    expect(r.deleted.stillChecks).toBe(1);
    expect(checkById(catalog, old.id)).toBeUndefined();
    expect(checkById(catalog, kept.id)).toBeDefined();
    expect(existsSync(keptJpg)).toBe(true);
    expect(existsSync(oldJpg)).toBe(false);
    expect(existsSync(orphan)).toBe(false);
    // The analytics folder: the analysis image survives, an orphan goes.
    expect(existsSync(analysisJpg)).toBe(true);
    expect(existsSync(analysisOrphan)).toBe(false);
  });
});
