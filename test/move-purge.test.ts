// What a finished move deletes at the source (camera-move plan Task 3, S §11;
// step 4 Task 6, Review Focus 2 and 5): with nothing to keep every row and
// folder of one camera goes, nothing of another; the counts are the five
// content kinds. The receiver's keep list keeps more (paths, whole chunks);
// Archive is never deleted un-copied, and a kept item carries a "Kept here" note.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it, vi } from 'vitest';
import { ArchiveStore } from '../src/archive/store';
import { expiredArchive } from '../src/catalog/archive';
import { openCatalog, type Catalog } from '../src/catalog/db';
import { DEFAULTS } from '../src/config/defaults';
import { keepListOf, outcomeOf, type ChunkKeep } from '../src/moves/check';
import { listChunks } from '../src/moves/inventory';
import type { MoveRecord } from '../src/moves/journal';
import { MOVE_KINDS } from '../src/moves/types';
import { purgeExcept, type PurgeDeps } from '../src/moves/purge';
import { Storage } from '../src/storage';
import { StreamLog } from '../src/stream/log';

// purgeExcept with nothing to keep: every chunk listed and every Archive chunk reported copied as it is now.
const NOTE = { moveId: 'mv_0123456789ABCDEFGHJK', to: { proxyId: 'prx_0123456789ABCDEFGHJK', name: 'new proxy' }, at: Date.UTC(2026, 9, 23) };
function purgeAll(d: PurgeDeps, cam: string) {
  const chunks = listChunks(d, cam, [...MOVE_KINDS]);
  return purgeExcept(d, cam, { keep: {}, listed: new Set(chunks.map((c) => c.id)), note: NOTE, copied: Object.fromEntries(chunks.filter((c) => c.kind === 'archive').map((c) => [c.id, { files: c.files, bytes: c.bytes, rows: c.rows }])) });
}

const TABLES = ['events', 'analyses', 'annotations', 'clips', 'stream_log', 'analytics_usage', 'clip_arrivals', 'still_checks', 'archive'] as const;

function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), 'camproxy-purge-'));
  const catalog = openCatalog(join(dataDir, 'catalog.db'));
  const db = catalog.db;
  const put = (path: string, bytes: number) => {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, Buffer.alloc(bytes, 1));
  };
  for (const [n, cam] of [[1, 'cam3'], [2, 'cam4']] as const) {
    const ev = Number(db.prepare("INSERT INTO events (cam, source, kind, start_ts) VALUES (?, 'onvif', 'person', ?)").run(cam, n).lastInsertRowid);
    db.prepare("INSERT INTO analyses (event_id, provider, status, requested_at) VALUES (?, 'vision', 'done', 1)").run(ev);
    db.prepare("INSERT INTO annotations (cam, start_ts, source, kind, created_at) VALUES (?, 1, 's', 'k', 1)").run(cam);
    db.prepare("INSERT INTO clips (cam, start_ts, path, stream, size, received_at) VALUES (?, 1, ?, 'sub', 5, 1)").run(cam, `/x/${cam}.mp4`);
    db.prepare("INSERT INTO stream_log (ts, cam, type, data) VALUES (1, ?, 't', '{}')").run(cam);
    db.prepare("INSERT INTO analytics_usage (provider, key_id, cam, day, calls) VALUES ('vision', '', ?, '2026-10-01', 1)").run(cam);
    db.prepare("INSERT OR REPLACE INTO clip_arrivals (cam, last_received) VALUES (?, 1)").run(cam);
    db.prepare("INSERT INTO still_checks (cam, still_ts, provider, requested_at, requested_via, objects, summary) VALUES (?, 1, 'vision', 1, 'ui', '[]', '{}')").run(cam);
    db.prepare("INSERT INTO archive (cam, name, labels, created_at, recorded_from, recorded_to, quality, original, duration_s, bytes, files, source, thumb_from, created_by, metadata) VALUES (?, 'a', '[]', 1, 1, 2, 'sub', 1, 1, 5, '[]', 's', 'f', 'u', '{}')").run(cam);
    put(join(dataDir, 'stills', cam, '2026/10/01', '1200.pack'), 10);
    put(join(dataDir, 'previews', cam, '2026/10/01', '1200.jpg'), 20);
    put(join(dataDir, 'clips', cam, '2026/10/01', '1200-1.mp4'), 30);
    put(join(dataDir, 'clips', cam, '2026/10/01', '1200-1.jpg'), 5);
    put(join(dataDir, 'recordings', cam, 'r1.mp4'), 40);
    put(join(dataDir, 'analytics', cam, '1.jpg'), 50);
    put(join(dataDir, 'still-checks', cam, '1.jpg'), 60);
    put(join(dataDir, 'archive', cam, '1', 'clip.mp4'), 70);
  }
  const storage = { recount: vi.fn() };
  const archive = { store: new ArchiveStore({ dataDir, catalog }) };
  const count = (t: string, cam: string) => (db.prepare(t === 'analyses' ? 'SELECT COUNT(*) n FROM analyses a JOIN events e ON e.id = a.event_id WHERE e.cam = ?' : `SELECT COUNT(*) n FROM ${t} WHERE cam = ?`).get(cam) as { n: number }).n;
  return { dataDir, catalog, storage, archive, count };
}

describe('purgeExcept with nothing to keep', () => {
  it('removes every row and folder of the camera and nothing of another camera', () => {
    const f = fixture();
    for (const t of TABLES) {
      expect(f.count(t, 'cam3'), `${t} cam3 before`).toBe(1);
      expect(f.count(t, 'cam4'), `${t} cam4 before`).toBe(1);
    }
    const r = purgeAll({ catalog: f.catalog, dataDir: f.dataDir, storage: f.storage, archive: f.archive }, 'cam3');
    for (const t of TABLES) {
      expect(f.count(t, 'cam3'), `${t} cam3 after`).toBe(0);
      expect(f.count(t, 'cam4'), `${t} cam4 after`).toBe(1);
    }
    for (const folder of ['stills', 'previews', 'clips', 'recordings', 'analytics', 'still-checks', 'archive']) {
      expect(existsSync(join(f.dataDir, folder, 'cam3')), `${folder} cam3`).toBe(false);
      expect(existsSync(join(f.dataDir, folder, 'cam4')), `${folder} cam4`).toBe(true);
    }
    // Five content kinds only (B49/X13); recordings are deleted but not counted.
    expect(Object.keys(r.deleted).sort()).toEqual([...MOVE_KINDS].sort());
    expect(r.deleted).toEqual({
      stills: { files: 2, bytes: 30 },
      clips: { files: 2, bytes: 35 },
      events: { files: 1, bytes: 50 },
      checks: { files: 1, bytes: 60 },
      archive: { files: 1, bytes: 70 },
    });
    expect(r.kept).toEqual({ stills: { files: 0, bytes: 0 }, clips: { files: 0, bytes: 0 }, events: { files: 0, bytes: 0 }, checks: { files: 0, bytes: 0 }, archive: { files: 0, bytes: 0 } });
    expect(f.storage.recount).toHaveBeenCalledTimes(1);
  });

  it('purging twice is a no-op', () => {
    const f = fixture();
    const deps = { catalog: f.catalog, dataDir: f.dataDir, storage: f.storage, archive: f.archive };
    purgeAll(deps, 'cam3');
    const again = purgeAll(deps, 'cam3');
    expect(again.deleted).toEqual({ stills: { files: 0, bytes: 0 }, clips: { files: 0, bytes: 0 }, events: { files: 0, bytes: 0 }, checks: { files: 0, bytes: 0 }, archive: { files: 0, bytes: 0 } });
    for (const t of TABLES) expect(f.count(t, 'cam4'), t).toBe(1);
  });

  it('refuses an id that is not a camera id (no path from a request value)', () => {
    const f = fixture();
    expect(() => purgeExcept({ catalog: f.catalog, dataDir: f.dataDir, storage: f.storage, archive: f.archive }, '../cam4', { keep: {}, listed: new Set(), note: NOTE })).toThrow(/camera id/);
    expect(existsSync(join(f.dataDir, 'stills', 'cam4'))).toBe(true);
  });
});

// ---- step 4: the keep list ----

const ts = (d: number, h = 12, m = 0) => Date.UTC(2026, 9, d, h, m);
const A = 'clips/cam1/2026/10/20/1200-1.mp4';
const B = 'clips/cam1/2026/10/20/1300-1.mp4';
const PACK = 'stills/cam1/2026/10/20/1200.pack';

// cam1: two clips and a stills pack on the 20th, Archive items 7 (19th), 8 (20th), 9 (22nd); cam2 has its own.
function moved() {
  const dataDir = mkdtempSync(join(tmpdir(), 'camproxy-purge-keep-'));
  const catalog = openCatalog(join(dataDir, 'catalog.db'));
  const db = catalog.db;
  const put = (rel: string, content = 'x') => {
    mkdirSync(join(dataDir, rel, '..'), { recursive: true });
    writeFileSync(join(dataDir, rel), content);
  };
  const clip = (cam: string, t: number, rel: string) => {
    put(rel, `clip ${rel}`);
    db.prepare("INSERT INTO clips (cam, start_ts, path, stream, size, received_at) VALUES (?, ?, ?, 'sub', 5, ?)").run(cam, t, join(dataDir, rel), t);
  };
  const archive = (cam: string, id: number, t: number) => {
    db.prepare("INSERT INTO archive (id, cam, name, labels, created_at, recorded_from, recorded_to, quality, original, duration_s, bytes, files, source, thumb_from, created_by, metadata) VALUES (?, ?, 'a', '[]', ?, 1, 2, 'sub', 1, 1, 5, '[]', 's', 'f', 'u', ?)")
      .run(id, cam, t, JSON.stringify({ archivedAt: t, events: [] }));
    put(`archive/${cam}/${id}/clip.mp4`, `archive clip ${id}`);
    put(`archive/${cam}/${id}/meta.json`, '{}');
  };
  clip('cam1', ts(20, 12), A);
  clip('cam1', ts(20, 13), B);
  put(PACK, 'pack');
  put('recordings/cam1/r1.mp4', 'rec');
  archive('cam1', 7, ts(19));
  archive('cam1', 8, ts(20));
  archive('cam1', 9, ts(22));
  clip('cam2', ts(20, 12), 'clips/cam2/2026/10/20/1200-1.mp4');
  archive('cam2', 20, ts(20));
  const deps: PurgeDeps = { catalog, dataDir, storage: { recount: vi.fn() }, archive: { store: new ArchiveStore({ dataDir, catalog }) } };
  const chunks = listChunks(deps, 'cam1', [...MOVE_KINDS]);
  const listed = new Set(chunks.map((c) => c.id));
  const copied = Object.fromEntries(chunks.filter((c) => c.kind === 'archive').map((c) => [c.id, { files: c.files, bytes: c.bytes, rows: c.rows }]));
  const exists = (rel: string) => existsSync(join(dataDir, rel));
  const clipRow = (rel: string) => db.prepare('SELECT * FROM clips WHERE path = ?').get(join(dataDir, rel)) ?? null;
  const archiveRow = (id: number) => (db.prepare('SELECT * FROM archive WHERE id = ?').get(id) as { metadata: string; cam: string } | undefined) ?? null;
  const note = (id: number) => JSON.parse(archiveRow(id)!.metadata).move;
  return { dataDir, catalog, deps, listed, copied, exists, clipRow, archiveRow, note };
}

describe('purgeExcept (step 4 Task 6)', () => {
  it('purgeExcept keeps listed paths, their rows and whole kept Archive items, with a kept note', () => {
    const f = moved();
    const out = purgeExcept(f.deps, 'cam1', { keep: { 'clips:2026-10-20': [A], 'archive:2026-10-19': 'all' }, listed: f.listed, note: NOTE, copied: f.copied });
    expect(f.exists(A)).toBe(true);
    expect(f.clipRow(A)).not.toBeNull();
    expect(f.exists(B)).toBe(false);
    expect(f.clipRow(B)).toBeNull();
    expect(f.exists(PACK)).toBe(false);
    expect(f.exists('recordings/cam1')).toBe(false);
    // Item 7 stays whole, with its note in the row and in meta.json.
    expect(f.archiveRow(7)!.metadata).toContain('"kept":true');
    expect(f.note(7)).toEqual({ moveId: NOTE.moveId, to: NOTE.to, at: NOTE.at, kept: true, reason: 'failed' });
    expect(JSON.parse(f.archiveRow(7)!.metadata).archivedAt).toBe(ts(19));
    expect(f.exists('archive/cam1/7/clip.mp4')).toBe(true);
    expect(JSON.parse(readFileSync(join(f.dataDir, 'archive/cam1/7/meta.json'), 'utf8')).item.move).toMatchObject({ kept: true, reason: 'failed' });
    // Items 8 and 9 arrived (listed, copied as they are now, not kept): gone.
    expect(f.archiveRow(8)).toBeNull();
    expect(f.exists('archive/cam1/8')).toBe(false);
    expect(f.archiveRow(9)).toBeNull();
    expect(out.kept.archive.files).toBeGreaterThan(0);
    expect(out.kept.clips).toEqual({ files: 1, bytes: Buffer.byteLength(`clip ${A}`) });
    expect(out.deleted.clips.files).toBe(1);
    expect(out.deleted.stills.files).toBe(1);
    // Another camera: untouched.
    expect(f.exists('clips/cam2/2026/10/20/1200-1.mp4')).toBe(true);
    expect(f.archiveRow(20)).not.toBeNull();
    expect(f.note(20)).toBeUndefined();
  });

  it('without an outcome every Archive item stays (not_copied), the rest goes', () => {
    const f = moved();
    const out = purgeExcept(f.deps, 'cam1', { keep: null, listed: f.listed, note: NOTE, copied: f.copied });
    for (const id of [7, 8, 9]) {
      expect(f.exists(`archive/cam1/${id}/clip.mp4`), String(id)).toBe(true);
      expect(f.note(id), String(id)).toMatchObject({ kept: true, reason: 'not_copied', to: NOTE.to });
    }
    expect(f.exists(A)).toBe(false);
    expect(f.exists(B)).toBe(false);
    expect(f.exists(PACK)).toBe(false);
    expect(f.clipRow(A)).toBeNull();
    expect(out.kept.archive.files).toBe(6);
    expect(out.deleted.archive.files).toBe(0);
  });

  it('an Archive item whose day was never listed stays', () => {
    const f = moved();
    const listed = new Set([...f.listed].filter((id) => id !== 'archive:2026-10-22'));
    purgeExcept(f.deps, 'cam1', { keep: {}, listed, note: NOTE, copied: f.copied });
    expect(f.archiveRow(9)).not.toBeNull();
    expect(f.note(9)).toMatchObject({ kept: true, reason: 'not_copied' });
    expect(f.archiveRow(8)).toBeNull();
  });

  it('an Archive chunk not reported copied, or changed since it was copied, stays whole', () => {
    const f = moved();
    const copied = { ...f.copied, 'archive:2026-10-20': { ...f.copied['archive:2026-10-20'], bytes: f.copied['archive:2026-10-20'].bytes + 1 } } as Record<string, { files: number; bytes: number; rows: number }>;
    delete copied['archive:2026-10-22'];
    purgeExcept(f.deps, 'cam1', { keep: {}, listed: f.listed, note: NOTE, copied });
    expect(f.note(8)).toMatchObject({ kept: true, reason: 'not_copied' });
    expect(f.note(9)).toMatchObject({ kept: true, reason: 'not_copied' });
    expect(f.archiveRow(7)).toBeNull();
  });

  it('an Archive item named by a missing path stays whole with reason missing', () => {
    const f = moved();
    const rel = 'archive/cam1/8/clip.mp4';
    purgeExcept(f.deps, 'cam1', { keep: { 'archive:2026-10-20': [rel] }, listed: f.listed, note: NOTE, copied: f.copied, missing: [rel] });
    expect(f.note(8)).toMatchObject({ kept: true, reason: 'missing' });
    expect(f.exists('archive/cam1/8/meta.json')).toBe(true);
    expect(f.archiveRow(7)).toBeNull();
  });

  it('a kept path outside the camera folders is ignored (Review Focus 5)', () => {
    const f = moved();
    purgeExcept(f.deps, 'cam1', { keep: { 'clips:2026-10-20': ['clips/cam1/../cam1/2026/10/20/1300-1.mp4', '/etc/passwd', 'clips/cam2/2026/10/20/1200-1.mp4', A] }, listed: f.listed, note: NOTE, copied: f.copied });
    expect(f.exists(B)).toBe(false);
    expect(f.exists(A)).toBe(true);
    expect(f.exists('clips/cam2/2026/10/20/1200-1.mp4')).toBe(true);
  });

  it('kept files of a removed camera are swept by storage.run', () => {
    const f = moved();
    f.catalog.db.prepare('UPDATE archive SET retention_days = 1, expires_at = ? WHERE id = 7').run(ts(20));
    purgeExcept(f.deps, 'cam1', { keep: { 'clips:2026-10-20': [A], 'archive:2026-10-19': 'all' }, listed: f.listed, note: NOTE, copied: f.copied });
    expect(f.exists(A)).toBe(true);
    // The camera is no longer configured here (it moved); retention still applies to what stayed.
    const config = structuredClone(DEFAULTS);
    config.server.dataDir = f.dataDir;
    config.retention.clipsDays = 1;
    const storage = new Storage({ catalog: f.catalog as Catalog, log: new StreamLog(f.catalog, () => ts(23)), config: () => config, now: () => ts(23), statfs: () => ({ free: 100 * 2 ** 30, size: 200 * 2 ** 30 }) });
    storage.run({});
    expect(f.exists(A)).toBe(false);
    expect(f.clipRow(A)).toBeNull();
    // The kept Archive item ages out with its own expiry (the daily cleanup's list).
    expect(expiredArchive(f.catalog, ts(23)).map((r) => r.id)).toEqual([7]);
  });
});

// ---- the receiver's keep list ----

const rec = (o: Partial<MoveRecord>): MoveRecord => ({ v: 1, id: NOTE.moveId, role: 'target', camera: 'cam1', phase: 'copying', plan: null, peer: { proxyId: 'prx_1', name: 'old' }, chunks: {}, bytesDone: 0, startedAt: 1, ...o });
const meta = (id: string, files = 1, rows = 1) => ({ id, kind: id.split(':')[0] as 'clips', day: id.split(':')[1], files, bytes: 10, rows });

describe('keepListOf', () => {
  it('keeps missing, failed and own paths, whole chunks marked all, and every Archive chunk not verified', () => {
    const r = rec({
      manifest: [meta('archive:2026-10-19'), meta('archive:2026-10-20'), meta('archive:2026-10-21'), meta('archive:2026-10-22'), meta('stills:2026-10-20', 2, 0), meta('clips:2026-10-20'), meta('events:2026-10-20', 0, 3)],
      chunks: {
        'archive:2026-10-19': { state: 'verified', v: 1, meta: { files: 1, bytes: 10, rows: 1 } },
        'archive:2026-10-20': { state: 'failed', v: 0, f: 1, rowsInserted: 1, meta: { files: 1, bytes: 10, rows: 1 } },
        'archive:2026-10-21': { state: 'skipped' },
        'stills:2026-10-20': { state: 'verified' },
        'clips:2026-10-20': { state: 'verified' },
        // Rows that never imported (no files): only at the source.
        'events:2026-10-20': { state: 'failed', f: 1, meta: { files: 0, bytes: 0, rows: 3 } },
      },
    });
    const per = new Map<string, ChunkKeep>([
      ['archive:2026-10-20', { missing: [], failed: ['archive/cam1/8/clip.mp4'] }],
      ['stills:2026-10-20', { missing: ['stills/cam1/2026/10/20/1201.pack'], failed: [], own: ['stills/cam1/2026/10/20/1200.pack'] }],
      ['clips:2026-10-20', { missing: [], failed: [], all: true }],
    ]);
    expect(keepListOf(r, per, false)).toEqual({
      'archive:2026-10-20': ['archive/cam1/8/clip.mp4'],
      'archive:2026-10-21': 'all',
      'archive:2026-10-22': 'all',
      'stills:2026-10-20': ['stills/cam1/2026/10/20/1201.pack', 'stills/cam1/2026/10/20/1200.pack'],
      'clips:2026-10-20': 'all',
      'events:2026-10-20': 'all',
    });
  });

  it('a chunk taken from the done list (B34, never checked here) is not copied; an Archive one is kept whole (I1)', () => {
    const r = rec({
      manifest: [meta('archive:2026-10-19'), meta('clips:2026-10-19')],
      chunks: { 'archive:2026-10-19': { state: 'verified', b: 10, meta: { files: 1, bytes: 10, rows: 1 } }, 'clips:2026-10-19': { state: 'verified', b: 10, meta: { files: 1, bytes: 10, rows: 1 } } },
    });
    const out = outcomeOf(r, new Map(), false);
    expect(out.keep).toEqual({ 'archive:2026-10-19': 'all' });
    expect(out.copied).toBeUndefined();
  });

  it('more than 1000 paths in a chunk keep the whole chunk', () => {
    const many = Array.from({ length: 1001 }, (_, i) => `stills/cam1/2026/10/20/${String(i).padStart(4, '0')}.pack`);
    expect(keepListOf(rec({}), new Map([['stills:2026-10-20', { missing: many, failed: [] }]]), false)).toEqual({ 'stills:2026-10-20': 'all' });
  });

  it('the outcome names missing Archive paths and the Archive chunks copied, bounded to 1 MiB', () => {
    const r = rec({
      manifest: [meta('archive:2026-10-19'), meta('archive:2026-10-20')],
      chunks: { 'archive:2026-10-19': { state: 'verified', v: 1, meta: { files: 1, bytes: 10, rows: 1 } }, 'archive:2026-10-20': { state: 'failed', v: 0, f: 1, meta: { files: 1, bytes: 10, rows: 1 } } },
    });
    const out = outcomeOf(r, new Map([['archive:2026-10-20', { missing: ['archive/cam1/8/clip.mp4'], failed: [] }], ['clips:2026-10-20', { missing: ['clips/cam1/2026/10/20/1200-1.mp4'], failed: [] }]]), false);
    expect(out.missing).toEqual(['archive/cam1/8/clip.mp4']);
    expect(out.copied).toEqual({ 'archive:2026-10-19': { files: 1, bytes: 10, rows: 1 }, 'archive:2026-10-20': { files: 1, bytes: 10, rows: 1 } });
    // 40 chunks of 1000 long paths: over 1 MiB; the largest lists become 'all' until it fits.
    const per = new Map<string, ChunkKeep>();
    for (let d = 0; d < 40; d++) per.set(`stills:${new Date(Date.UTC(2026, 6, 1 + d)).toISOString().slice(0, 10)}`, { missing: Array.from({ length: 1000 }, (_, i) => `stills/cam1/2026/09/01/${'x'.repeat(30)}${i}.pack`), failed: [] });
    const big = outcomeOf(rec({}), per, true);
    expect(Buffer.byteLength(JSON.stringify(big))).toBeLessThan(1024 * 1024);
    expect(Object.keys(big.keep)).toHaveLength(per.size);
    expect(Object.values(big.keep).some((v) => v === 'all')).toBe(true);
  });
});
