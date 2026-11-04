import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { execFile } from 'child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { promisify } from 'util';
import { openCatalog, type Catalog } from '../src/catalog/db';
import { clipById, insertClip, type ClipOrigin, type ClipRow } from '../src/catalog/clips';
import type { ClipItem } from '../src/inventory/clips';
import { duplicatesRepair, type DuplicateRepairItem } from '../src/inventory/repair-duplicates';
import type { InventoryReport, RepairContext } from '../src/inventory/runner';

const run = promisify(execFile);
const NOW = Date.UTC(2026, 9, 2, 12, 0);
const S = Date.UTC(2026, 9, 1, 2, 13, 28);
let video: Buffer;
beforeAll(async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'camproxy-dupsrc-')), 'v.mp4');
  await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=10', '-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', file]);
  video = readFileSync(file);
}, 30_000);

let dir: string;
let catalog: Catalog;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'camproxy-dup-'));
  catalog = openCatalog(join(dir, 'catalog.sqlite'));
});
afterEach(() => {
  catalog.close();
  chmodSync(dir, 0o755);
  rmSync(dir, { recursive: true, force: true });
});

function row(start: number, origin: ClipOrigin, o: { end?: number | null; cam?: string; stream?: string; snapshot?: string | null; file?: Buffer | null; path?: string } = {}): ClipRow {
  const path = o.path ?? join(dir, 'clips', o.cam ?? 'cam1', `${origin}-${start}.mp4`);
  if (o.file !== null) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, o.file ?? video);
  }
  return insertClip(catalog, { cam: o.cam ?? 'cam1', start_ts: start, end_ts: o.end === undefined ? start + 46_000 : o.end, path, stream: o.stream ?? 'sub', size: video.length, received_at: NOW - 3_600_000, snapshot: o.snapshot ?? null, origin });
}
const item = (fetched: ClipRow, ftp: ClipRow, o: Partial<Extract<ClipItem, { type: 'duplicate-clip' }>> = {}): ClipItem => ({ type: 'duplicate-clip', id: `rec-${fetched.id}`, start: S, end: S + 46_000, stream: 'sub', fetchedClipId: fetched.id, ftpClipId: ftp.id, ftpStart: ftp.start_ts, size: fetched.size, ...o });
const report = (items: ClipItem[], o: Partial<InventoryReport> = {}): InventoryReport => ({
  runId: 'clips-1-abcdef', kind: 'clips', op: 'check', camera: 'cam1', startedAt: NOW - 60_000, tookMs: 1, outcome: 'ok', requestedBy: 'token',
  options: { camera: true }, window: null, counts: { duplicates: items.length }, top: [], items, itemsTruncated: false, message: '', ...o,
});
const ctx = (source: InventoryReport, o: Partial<RepairContext> = {}): RepairContext => ({ signal: new AbortController().signal, progress: () => undefined, now: NOW, cam: 'cam1', runId: 'duplicatesrepair-1-abcdef', source, ...o });
const repair = (o: Partial<Parameters<typeof duplicatesRepair>[0]> = {}) => duplicatesRepair({ catalog, dataDir: dir, ...o });
const reasons = (items: unknown[]) => (items as DuplicateRepairItem[]).map((x) => x.reason ?? x.result);

describe('removing duplicate clips (#342)', () => {
  it('E1: removes the fetched copy and its file, keeps the FTP copy', async () => {
    const fetched = row(S, 'camera');
    const ftp = row(S + 8000, 'ftp', { end: S + 49_000 });
    const prunes: number[] = [];
    const r = await repair({ prune: () => void prunes.push(1) }).run(ctx(report([item(fetched, ftp)])));
    expect(r).toMatchObject({ stopped: null, counts: { candidates: 1, requested: 1, done: 1, failed: 0, skipped: 0, bytes: video.length }, top: [] });
    expect(r.items).toEqual([{ id: `rec-${fetched.id}`, start: S, result: 'ok', clipId: fetched.id, keptClipId: ftp.id, bytes: video.length }]);
    expect(clipById(catalog, fetched.id)).toBeUndefined();
    expect(existsSync(fetched.path)).toBe(false);
    expect(clipById(catalog, ftp.id)).toBeDefined();
    expect(existsSync(ftp.path)).toBe(true);
    expect(prunes).toHaveLength(1);
    expect(r.message).toMatch(/^1 of 1 fetched copies removed \(.* MB\), the FTP copies kept; 0 failed, 0 skipped$/);
  });

  it('moves the picture link to the FTP copy when that has none; the picture file stays', async () => {
    const pic = join(dir, 'clips', 'cam1', 'p.jpg');
    mkdirSync(dirname(pic), { recursive: true });
    writeFileSync(pic, 'x');
    const fetched = row(S, 'camera', { snapshot: pic });
    const ftp = row(S + 8000, 'ftp');
    await repair().run(ctx(report([item(fetched, ftp)])));
    expect(clipById(catalog, ftp.id)?.snapshot).toBe(pic);
    expect(existsSync(pic)).toBe(true);
  });

  // Each of these leaves both copies alone.
  const leftAlone = async (fetched: ClipRow, ftp: ClipRow, reason: string, o: Partial<Extract<ClipItem, { type: 'duplicate-clip' }>> = {}, probe?: () => Promise<unknown>) => {
    const r = await repair(probe ? { probe } : {}).run(ctx(report([item(fetched, ftp, o)])));
    expect(reasons(r.items)).toEqual([reason]);
    expect(r.counts).toMatchObject({ done: 0, skipped: 1 });
    return r;
  };

  it('never removes the only copy: the FTP row gone', async () => {
    const fetched = row(S, 'camera');
    const ftp = row(S + 8000, 'ftp');
    catalog.db.prepare('DELETE FROM clips WHERE id = ?').run(ftp.id);
    await leftAlone(fetched, ftp, 'keep-gone');
    expect(existsSync(fetched.path)).toBe(true);
    expect(clipById(catalog, fetched.id)).toBeDefined();
  });

  it('never removes the only copy: the FTP file gone, empty or not a video', async () => {
    for (const [file, name] of [[null, 'gone'], [Buffer.alloc(0), 'empty'], [Buffer.from('not a video'), 'junk']] as const) {
      const fetched = row(S, 'camera', { path: join(dir, 'clips', 'cam1', `f-${name}.mp4`) });
      const ftp = row(S + 8000, 'ftp', { file, path: join(dir, 'clips', 'cam1', `k-${name}.mp4`) });
      await leftAlone(fetched, ftp, 'keep-unreadable');
      expect(existsSync(fetched.path)).toBe(true);
      expect(clipById(catalog, fetched.id)).toBeDefined();
    }
  });

  it('never removes the only copy: an FTP copy cut short of the recording\'s end', async () => {
    const fetched = row(S, 'camera');
    const ftp = row(S + 8000, 'ftp', { end: S + 20_000 });
    await leftAlone(fetched, ftp, 'keep-short');
    const open = row(S + 1000, 'ftp', { end: null, path: join(dir, 'clips', 'cam1', 'open.mp4') });
    await leftAlone(fetched, open, 'keep-short');
    expect(existsSync(fetched.path)).toBe(true);
  });

  it('never removes a clip of another recording: outside the rules', async () => {
    const fetched = row(S, 'camera');
    await leftAlone(fetched, row(S + 13_000, 'ftp'), 'not-same-recording'); // RLC-1224A, +13 s
    await leftAlone(row(S + 20_000, 'camera'), row(S + 8000, 'ftp', { path: join(dir, 'clips', 'cam1', 'b.mp4') }), 'not-same-recording');
    await leftAlone(fetched, row(S + 8000, 'ftp', { stream: 'main', path: join(dir, 'clips', 'cam1', 'c.mp4') }), 'not-same-recording');
    await leftAlone(fetched, row(S + 8000, 'ftp', { path: join(dir, 'clips', 'cam1', 'd.mp4') }), 'not-same-recording', { end: S + 6000 }); // it ended before the clip starts
    expect(existsSync(fetched.path)).toBe(true);
  });

  it('checks the origins: an FTP row is never removed, a fetched row never kept', async () => {
    const a = row(S, 'ftp');
    const b = row(S + 8000, 'ftp');
    await leftAlone(a, b, 'fetched-changed');
    expect(existsSync(a.path)).toBe(true);
    const c = row(S, 'camera', { path: join(dir, 'clips', 'cam1', 'c1.mp4') });
    const e = row(S + 3000, 'camera', { path: join(dir, 'clips', 'cam1', 'c2.mp4') });
    await leftAlone(c, e, 'keep-gone');
    expect(existsSync(c.path)).toBe(true);
    expect(existsSync(e.path)).toBe(true);
  });

  it('checks the camera: another camera\'s clips are not this run\'s', async () => {
    const fetched = row(S, 'camera', { cam: 'cam2' });
    const ftp = row(S + 8000, 'ftp');
    await leftAlone(fetched, ftp, 'fetched-changed');
    const f2 = row(S, 'camera');
    const k2 = row(S + 8000, 'ftp', { cam: 'cam2' });
    await leftAlone(f2, k2, 'keep-gone');
    expect(existsSync(fetched.path) && existsSync(f2.path)).toBe(true);
  });

  it('one FTP copy answers for one fetched clip: a second pair on it is left alone', async () => {
    const f1 = row(S, 'camera');
    const f2 = row(S + 2000, 'camera');
    const ftp = row(S + 8000, 'ftp');
    const r = await repair().run(ctx(report([item(f1, ftp), item(f2, ftp)])));
    expect(reasons(r.items)).toEqual(['ok', 'keep-used']);
    expect(existsSync(f2.path)).toBe(true);
  });

  it('a fetched file already gone, or outside the clips folder, is left to the check', async () => {
    const gone = row(S, 'camera', { file: null });
    await leftAlone(gone, row(S + 8000, 'ftp'), 'fetched-file-gone');
    expect(clipById(catalog, gone.id)).toBeDefined();
    const outside = join(mkdtempSync(join(tmpdir(), 'camproxy-dupout-')), 'x.mp4');
    const out = row(S, 'camera', { path: outside });
    await leftAlone(out, row(S + 8000, 'ftp', { path: join(dir, 'clips', 'cam1', 'k.mp4') }), 'fetched-file-gone');
    expect(existsSync(outside)).toBe(true);
  });

  it('a failed removal keeps the row, and 3 in a row stop the run', async () => {
    const pairs = [0, 1, 2, 3].map((n) => {
      const start = S + n * 100_000;
      return item(row(start, 'camera'), row(start + 8000, 'ftp'), { start, end: start + 46_000, id: `r${n}` });
    });
    const r = await repair({ probe: async () => { throw new Error('probe broke'); } }).run(ctx(report(pairs)));
    expect(reasons(r.items)).toEqual(['failed', 'failed', 'failed']);
    expect(r).toMatchObject({ stopped: 'failures', counts: { failed: 3, done: 0 } });
    expect(r.top).toHaveLength(3);
  });

  it('stops between pairs when cancelled; what is removed stays removed', async () => {
    const ac = new AbortController();
    const f1 = row(S, 'camera');
    const k1 = row(S + 8000, 'ftp');
    const f2 = row(S + 100_000, 'camera');
    const k2 = row(S + 108_000, 'ftp');
    let n = 0;
    const r = await repair().run(ctx(report([item(f1, k1), item(f2, k2, { start: S + 100_000, end: S + 146_000 })]), { signal: ac.signal, progress: () => void (n++ === 1 && ac.abort()) }));
    expect(r.counts.done).toBe(1);
    expect(existsSync(f2.path)).toBe(true);
  });

  it('says so when the report lists only some', async () => {
    const r = await repair().run(ctx(report([item(row(S, 'camera'), row(S + 8000, 'ftp'))], { counts: { duplicates: 3 } })));
    expect(r).toMatchObject({ stopped: 'item-cap', counts: { candidates: 3, requested: 1, done: 1 } });
  });

  it('is ready only for a compare with the camera that lists a duplicate', () => {
    const fetched = row(S, 'camera');
    const ftp = row(S + 8000, 'ftp');
    expect(repair().ready(report([item(fetched, ftp)]))).toBeNull();
    expect(repair().ready(report([item(fetched, ftp)], { options: undefined }))).toMatch(/compare/);
    expect(repair().ready(report([]))).toBe('no recording is held twice');
  });
});
