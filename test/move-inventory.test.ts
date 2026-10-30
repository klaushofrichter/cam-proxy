// Inventory, chunks and manifests of one camera (camera-move plan Task 4, P5/P6/P11, B13).
import { createHash } from 'crypto';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { describe, expect, it } from 'vitest';
import { openCatalog } from '../src/catalog/db';
import { insertPosition } from '../src/catalog/ptz-positions';
import { Cam, chunkManifest, chunkOrder, chunkRows, listChunks, summarize } from '../src/moves/inventory';
import { FILE_KINDS, MOVE_KINDS } from '../src/moves/types';

const D1 = Date.UTC(2026, 9, 1, 12, 0); // 2026-10-01 12:00 UTC
const D2 = Date.UTC(2026, 9, 2, 0, 5); // 2026-10-02 00:05 UTC (a local day could differ)

function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), 'camproxy-inv-'));
  const catalog = openCatalog(join(dataDir, 'catalog.db'));
  const db = catalog.db;
  const put = (rel: string, content: string) => {
    mkdirSync(dirname(join(dataDir, rel)), { recursive: true });
    writeFileSync(join(dataDir, rel), content);
  };
  const abs = (rel: string) => join(dataDir, rel);
  for (const cam of ['cam3', 'cam4']) {
    put(`stills/${cam}/2026/10/01/1200.pack`, 'aaaa');
    put(`previews/${cam}/2026/10/01/1200.jpg`, 'bb');
    put(`previews/${cam}/2026/10/01/1200.json`, '{}');
    put(`stills/${cam}/2026/10/02/0005.pack`, 'cccccc');
    db.prepare('INSERT INTO clips (cam, start_ts, path, stream, size, received_at, snapshot) VALUES (?, ?, ?, ?, 5, 1, ?)').run(cam, D1, abs(`clips/${cam}/2026/10/01/1200-1.mp4`), 'sub', abs(`clips/${cam}/2026/10/01/1200-1.jpg`));
    put(`clips/${cam}/2026/10/01/1200-1.mp4`, 'clipdata');
    put(`clips/${cam}/2026/10/01/1200-1.jpg`, 'snap');
    const ev = Number(db.prepare("INSERT INTO events (cam, source, kind, start_ts) VALUES (?, 'onvif', 'person', ?)").run(cam, D2).lastInsertRowid);
    db.prepare("INSERT INTO analyses (event_id, provider, status, requested_at, image) VALUES (?, 'vision', 'done', 1, ?)").run(ev, abs(`analytics/${cam}/${ev}.jpg`));
    put(`analytics/${cam}/${ev}.jpg`, 'analysis');
    const chk = Number(db.prepare("INSERT INTO still_checks (cam, still_ts, provider, requested_at, requested_via, objects, summary, image) VALUES (?, ?, 'vision', 1, 'session', '[]', '[]', ?)").run(cam, D1, abs(`still-checks/${cam}/check-1.jpg`)).lastInsertRowid);
    put(`still-checks/${cam}/check-${chk}.jpg`, 'check');
    const ar = Number(db.prepare("INSERT INTO archive (cam, name, labels, created_at, recorded_from, recorded_to, quality, original, duration_s, bytes, files, source, thumb_from, created_by, metadata) VALUES (?, 'a', '[]', ?, 1, 2, 'sub', 1, 1, 5, '[]', 's', 'f', 'u', '{}')").run(cam, D2).lastInsertRowid);
    put(`archive/${cam}/${ar}/clip.mp4`, 'archived');
    put(`archive/${cam}/${ar}/meta.json`, '{}');
    // not moved (P6)
    put(`recordings/${cam}/r1.mp4`, 'rec');
    db.prepare("INSERT INTO stream_log (ts, cam, type, data) VALUES (1, ?, 't', '{}')").run(cam);
  }
  return { dataDir, catalog, deps: { catalog, dataDir } };
}
const sha = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');

describe('move inventory', () => {
  it('summary counts per kind match the fixture', async () => {
    const f = fixture();
    const s = summarize(f.deps, 'cam3');
    expect(Object.keys(s).sort()).toEqual([...FILE_KINDS].sort());
    expect(s.stills).toEqual({ files: 4, bytes: 4 + 2 + 2 + 6, rows: 0, oldest: D1, newest: D2 });
    expect(s.clips).toEqual({ files: 2, bytes: 8 + 4, rows: 1, oldest: D1, newest: D1 });
    expect(s.events).toEqual({ files: 1, bytes: 8, rows: 2, oldest: D2, newest: D2 });
    expect(s.checks).toEqual({ files: 1, bytes: 5, rows: 1, oldest: D1, newest: D1 });
    expect(s.archive).toEqual({ files: 2, bytes: 8 + 2, rows: 1, oldest: D2, newest: D2 });
  });

  it('a filter leaves items out of the chunk list, the manifest and the rows (step 4 Task 9)', async () => {
    const f = fixture();
    const clipId = (f.catalog.db.prepare("SELECT id FROM clips WHERE cam = 'cam3'").get() as { id: number }).id;
    const seen: string[] = [];
    const filter = {
      row: (table: string, row: Record<string, unknown>) => (seen.push(table), !(table === 'clips' && row.id === clipId) && table !== 'analyses'),
      file: (rel: string) => rel !== 'stills/cam3/2026/10/01/1200.pack',
    };
    const all = listChunks(f.deps, 'cam3', [...MOVE_KINDS]);
    const some = listChunks(f.deps, 'cam3', [...MOVE_KINDS], filter);
    // The clips day had only that clip: its chunk is gone; the stills day lost one pack.
    expect(some.map((c) => c.id)).toEqual(all.map((c) => c.id).filter((id) => id !== 'clips:2026-10-01'));
    expect(some.find((c) => c.id === 'stills:2026-10-01')).toMatchObject({ files: 2, bytes: 2 + 2 });
    // An event stays without the analysis left out (its image too).
    expect(some.find((c) => c.id === 'events:2026-10-02')).toMatchObject({ files: 0, rows: 1 });
    expect(new Set(seen)).toEqual(new Set(['clips', 'events', 'analyses', 'still_checks', 'archive']));
    const m = await chunkManifest(f.deps, 'cam3', 'stills:2026-10-01', { filter });
    expect(m.files.map((x) => x.path)).toEqual(['previews/cam3/2026/10/01/1200.jpg', 'previews/cam3/2026/10/01/1200.json']);
    expect((await chunkManifest(f.deps, 'cam3', 'clips:2026-10-01', { filter })).files).toEqual([]);
    expect(chunkRows(f.deps, 'cam3', 'clips:2026-10-01', filter)).toEqual([]);
    expect(chunkRows(f.deps, 'cam3', 'events:2026-10-02', filter).map((t) => t.table)).toEqual(['events']);
    // Without a filter nothing changes.
    expect(chunkRows(f.deps, 'cam3', 'events:2026-10-02').map((t) => t.table)).toEqual(['events', 'analyses']);
  });

  it('summary of a camera without content is zeros', () => {
    const f = fixture();
    expect(summarize(f.deps, 'cam9').clips).toEqual({ files: 0, bytes: 0, rows: 0, oldest: null, newest: null });
  });

  it('Archive chunks come first, then the rest newest day first', () => {
    const f = fixture();
    const ids = listChunks(f.deps, 'cam3', [...MOVE_KINDS]).map((c) => c.id);
    expect(ids).toEqual(['archive:2026-10-02', 'events:2026-10-02', 'stills:2026-10-02', 'clips:2026-10-01', 'checks:2026-10-01', 'stills:2026-10-01']);
    const mk = (kind: 'clips' | 'archive' | 'stills' | 'events' | 'checks', day: string) => ({ kind, day });
    const sorted = [mk('stills', '2026-10-21'), mk('clips', '2026-10-21'), mk('archive', '2026-10-18'), mk('archive', '2026-10-20'), mk('events', '2026-10-21'), mk('checks', '2026-10-21')].sort(chunkOrder);
    expect(sorted.map((c) => `${c.kind}:${c.day}`)).toEqual(['archive:2026-10-20', 'archive:2026-10-18', 'clips:2026-10-21', 'events:2026-10-21', 'checks:2026-10-21', 'stills:2026-10-21']);
    const c = listChunks(f.deps, 'cam3', ['clips'])[0];
    expect(c).toEqual({ id: 'clips:2026-10-01', kind: 'clips', day: '2026-10-01', files: 2, bytes: 12, rows: 1 });
  });

  it('manifest hashes match sha256 of the files, with dataDir-relative posix paths', async () => {
    const f = fixture();
    const m = await chunkManifest(f.deps, 'cam3', 'stills:2026-10-01');
    expect(m.rows).toBe(0);
    expect(m.files.map((x) => x.path)).toEqual(['previews/cam3/2026/10/01/1200.jpg', 'previews/cam3/2026/10/01/1200.json', 'stills/cam3/2026/10/01/1200.pack']);
    for (const x of m.files) {
      expect(x.sha256).toBe(sha(join(f.dataDir, x.path)));
      expect(x.size).toBe(readFileSync(join(f.dataDir, x.path)).length);
    }
    const c = await chunkManifest(f.deps, 'cam3', 'clips:2026-10-01');
    expect(c.rows).toBe(1);
    expect(c.files.map((x) => x.path)).toEqual(['clips/cam3/2026/10/01/1200-1.jpg', 'clips/cam3/2026/10/01/1200-1.mp4']);
  });

  it("manifest never lists a path outside the camera's folders", async () => {
    const f = fixture();
    mkdirSync(join(f.dataDir, 'secret'), { recursive: true });
    writeFileSync(join(f.dataDir, 'secret', 'x.mp4'), 'x');
    writeFileSync(join(f.dataDir, 'clips', 'cam4', 'other.mp4'), 'o');
    // rows pointing at another camera's file, a file outside the data folder and a traversal
    const ins = f.catalog.db.prepare("INSERT INTO clips (cam, start_ts, path, stream, size, received_at, snapshot) VALUES ('cam3', ?, ?, 'sub', 1, 1, ?)");
    ins.run(D1 + 1, join(f.dataDir, 'clips', 'cam4', 'other.mp4'), join(f.dataDir, 'secret', 'x.mp4'));
    ins.run(D1 + 2, join(f.dataDir, 'clips', 'cam3', '..', 'cam4', 'other.mp4'), '/etc/hosts');
    // a symlink inside the camera's folder pointing out
    symlinkSync(join(f.dataDir, 'secret', 'x.mp4'), join(f.dataDir, 'stills', 'cam3', '2026', '10', '01', '1201.pack'));
    for (const id of ['clips:2026-10-01', 'stills:2026-10-01']) {
      const m = await chunkManifest(f.deps, 'cam3', id);
      for (const x of m.files) expect(x.path.startsWith('clips/cam3/') || x.path.startsWith('stills/cam3/') || x.path.startsWith('previews/cam3/'), x.path).toBe(true);
      expect(m.files.some((x) => x.path.includes('..') || x.path.includes('secret') || x.path.includes('cam4'))).toBe(false);
    }
    // the rows with foreign paths are not part of the chunk either
    const rows = chunkRows(f.deps, 'cam3', 'clips:2026-10-01')[0].rows as { path: string; snapshot: string | null }[];
    expect(rows).toHaveLength(1);
  });

  it('rejects a camera id or chunk id that is not valid', async () => {
    const f = fixture();
    await expect(chunkManifest(f.deps, '../cam4', 'clips:2026-10-01')).rejects.toThrow(/camera id/);
    await expect(chunkManifest(f.deps, 'cam3', 'clips:../../x')).rejects.toThrow(/chunk id/);
    expect(() => chunkRows(f.deps, 'cam3', 'recordings:2026-10-01')).toThrow(/chunk id/);
  });

  it('rows of an events chunk include its analyses after the events, with relative paths and source ids', async () => {
    const f = fixture();
    const out = chunkRows(f.deps, 'cam3', 'events:2026-10-02');
    expect(out.map((t) => t.table)).toEqual(['events', 'analyses']);
    const ev = out[0].rows as { id: number; cam: string }[];
    const an = out[1].rows as { event_id: number; image: string }[];
    expect(ev).toHaveLength(1);
    expect(ev[0].cam).toBe('cam3');
    expect(an).toHaveLength(1);
    expect(an[0].event_id).toBe(ev[0].id);
    expect(an[0].image).toBe(`analytics/cam3/${ev[0].id}.jpg`);
  });

  it('clip, check and archive rows carry dataDir-relative paths and keep their ids', async () => {
    const f = fixture();
    const clip = chunkRows(f.deps, 'cam3', 'clips:2026-10-01');
    expect(clip.map((t) => t.table)).toEqual(['clips']);
    const cr = clip[0].rows[0] as { id: number; path: string; snapshot: string };
    expect(cr.path).toBe('clips/cam3/2026/10/01/1200-1.mp4');
    expect(cr.snapshot).toBe('clips/cam3/2026/10/01/1200-1.jpg');
    const chk = chunkRows(f.deps, 'cam3', 'checks:2026-10-01');
    expect(chk.map((t) => t.table)).toEqual(['still_checks']);
    const sc = chk[0].rows[0] as { id: number; image: string };
    expect(sc.image).toBe(`still-checks/cam3/check-${sc.id}.jpg`);
    const ar = chunkRows(f.deps, 'cam3', 'archive:2026-10-02');
    expect(ar.map((t) => t.table)).toEqual(['archive']);
    expect((await chunkManifest(f.deps, 'cam3', 'archive:2026-10-02')).files.map((x) => x.path)).toEqual([`archive/cam3/${(ar[0].rows[0] as { id: number }).id}/clip.mp4`, `archive/cam3/${(ar[0].rows[0] as { id: number }).id}/meta.json`]);
    expect(chunkRows(f.deps, 'cam3', 'stills:2026-10-01')).toEqual([]);
    for (const t of [...clip, ...chk]) for (const r of t.rows) expect(JSON.stringify(r)).not.toContain(f.dataDir);
  });

  it('an empty day has an empty manifest', async () => {
    const f = fixture();
    expect((await chunkManifest(f.deps, 'cam3', 'checks:2026-10-01')).files).toHaveLength(1);
    expect(await chunkManifest(f.deps, 'cam3', 'checks:2026-10-05')).toEqual({ files: [], rows: 0, expired: 0 });
  });

  it('the event loop stays responsive while a large file is hashed', async () => {
    const f = fixture();
    writeFileSync(join(f.dataDir, 'previews', 'cam3', '2026', '10', '01', '1200.jpg'), Buffer.alloc(128 << 20, 7));
    let ticked = false;
    setImmediate(() => (ticked = true));
    let tickedBefore = false;
    const p = chunkManifest(f.deps, 'cam3', 'stills:2026-10-01').then((m) => {
      tickedBefore = ticked;
      return m;
    });
    await p;
    expect(tickedBefore).toBe(true);
  });

  it('a file replaced between listing and hashing gets the size of the bytes hashed', async () => {
    const f = fixture();
    const target = join(f.dataDir, 'previews', 'cam3', '2026', '10', '01', '1200.jpg');
    const m = await chunkManifest(f.deps, 'cam3', 'stills:2026-10-01', {
      beforeOpen: (abs) => {
        if (abs !== target) return;
        writeFileSync(`${target}.tmp`, 'a much longer replacement');
        renameSync(`${target}.tmp`, target);
      },
    });
    const x = m.files.find((y) => y.path.endsWith('1200.jpg'))!;
    expect(x.size).toBe(25);
    expect(x.sha256).toBe(sha(target));
  });

  it('a file removed between listing and hashing is dropped and counted expired', async () => {
    const f = fixture();
    const target = join(f.dataDir, 'previews', 'cam3', '2026', '10', '01', '1200.jpg');
    const m = await chunkManifest(f.deps, 'cam3', 'stills:2026-10-01', { beforeOpen: (abs) => abs === target && rmSync(target) });
    expect(m.files.map((x) => x.path)).toEqual(['previews/cam3/2026/10/01/1200.json', 'stills/cam3/2026/10/01/1200.pack']);
    expect(m.expired).toBe(1);
  });

  it('any other read error rejects the manifest (it must not be cached without the file)', async () => {
    const f = fixture();
    const target = join(f.dataDir, 'previews', 'cam3', '2026', '10', '01', '1200.jpg');
    const outside = join(f.dataDir, 'outside.jpg');
    writeFileSync(outside, 'x');
    // replaced by a link between listing and hashing: ELOOP (O_NOFOLLOW)
    const p = chunkManifest(f.deps, 'cam3', 'stills:2026-10-01', {
      beforeOpen: (abs) => {
        if (abs !== target) return;
        rmSync(target);
        symlinkSync(outside, target);
      },
    });
    await expect(p).rejects.toThrow();
    // replaced by a folder: not a regular file
    rmSync(target);
    writeFileSync(target, 'bb');
    const q = chunkManifest(f.deps, 'cam3', 'stills:2026-10-01', {
      beforeOpen: (abs) => {
        if (abs !== target) return;
        rmSync(target);
        mkdirSync(target);
      },
    });
    await expect(q).rejects.toThrow();
  });

  it('size() and walk() refuse a path outside dataDir: .., absolute, encoded separators (CodeQL js/path-injection)', () => {
    const f = fixture();
    const outside = mkdtempSync(join(tmpdir(), 'camproxy-inv-out-'));
    writeFileSync(join(outside, 'x.bin'), 'secret');
    const c = new Cam(f.deps, 'cam3');
    expect(c.size(join(f.dataDir, 'clips', 'cam3', '2026', '10', '01', '1200-1.mp4'))).toBeGreaterThan(0);
    expect(c.walk(join(f.dataDir, 'clips', 'cam3')).length).toBeGreaterThan(0);
    for (const p of [join(f.dataDir, '..', outside.slice(outside.lastIndexOf('/') + 1), 'x.bin'), join(outside, 'x.bin'), '/etc/hosts', `${f.dataDir}/clips/cam3/..%2F..%2F..%2Fetc%2Fhosts`, f.dataDir]) {
      expect(c.size(p), p).toBeNull();
    }
    for (const d of [join(f.dataDir, '..'), outside, join(f.dataDir, 'clips', 'cam3', '..', '..', '..', outside.slice(outside.lastIndexOf('/') + 1)), '/etc', `${f.dataDir}/..%2F..`, f.dataDir]) {
      expect(c.walk(d), d).toEqual([]);
    }
    expect(() => new Cam(f.deps, '../cam3')).toThrow();
  });
});

describe('the ptz chunk', () => {
  const T29 = Date.UTC(2026, 9, 29, 22);
  const T30 = Date.UTC(2026, 9, 30, 1);
  const withPositions = () => {
    const f = fixture();
    const pos = (n: number, o: { sort_order: number; home: 0 | 1; updated_at: number }) => insertPosition(f.catalog, { id: `pos_000000000000000${n}`, cam: 'cam3', name: `P${n}`, slot: n, preset_name: `p${n}`, created_at: T29, ...o });
    pos(1, { sort_order: 2, home: 0, updated_at: T29 });
    pos(2, { sort_order: 0, home: 1, updated_at: T30 });
    pos(3, { sort_order: 1, home: 0, updated_at: T29 });
    insertPosition(f.catalog, { id: 'pos_00000000000000f4', cam: 'cam4', name: 'Other', slot: 1, preset_name: 'o', sort_order: 0, home: 1, created_at: T29, updated_at: T29 });
    return f;
  };

  it('a camera with positions has one ptz chunk on the day of its newest change', () => {
    const f = withPositions();
    const chunks = listChunks(f.deps, 'cam3', ['ptz']);
    expect(chunks).toEqual([{ id: 'ptz:2026-10-30', kind: 'ptz', day: '2026-10-30', files: 0, bytes: 0, rows: 3 }]);
  });

  it('no rows -> no ptz chunk', () => {
    const f = fixture();
    expect(listChunks(f.deps, 'cam3', ['ptz'])).toEqual([]);
    expect(listChunks(f.deps, 'cam3', [...MOVE_KINDS]).some((c) => c.kind === 'ptz')).toBe(false);
  });

  it('chunkRows of the ptz chunk: the rows without cam, by sort_order', async () => {
    const f = withPositions();
    const rows = chunkRows(f.deps, 'cam3', 'ptz:2026-10-30');
    expect(rows).toHaveLength(1);
    expect(rows[0].table).toBe('ptz_positions');
    expect((rows[0].rows as Record<string, unknown>[]).map((r) => r.id)).toEqual(['pos_0000000000000002', 'pos_0000000000000003', 'pos_0000000000000001']);
    expect(rows[0].rows.every((r) => !('cam' in r))).toBe(true);
    expect(await chunkManifest(f.deps, 'cam3', 'ptz:2026-10-30')).toEqual({ files: [], rows: 3, expired: 0 });
  });

  it('chunkOrder: ptz first, then Archive, then the rest', () => {
    const f = withPositions();
    const kinds = listChunks(f.deps, 'cam3', [...MOVE_KINDS]).map((c) => c.kind);
    expect(kinds[0]).toBe('ptz');
    expect(kinds[1]).toBe('archive');
    expect(kinds.filter((k) => k === 'ptz')).toHaveLength(1);
    expect(chunkOrder({ kind: 'ptz', day: '2026-01-01' }, { kind: 'archive', day: '2026-12-01' })).toBeLessThan(0);
  });

  it('a ptz chunk listed on another day still serves all the rows (a position changed after the listing)', async () => {
    const f = withPositions();
    expect(chunkRows(f.deps, 'cam3', 'ptz:2026-10-01')[0].rows).toHaveLength(3);
    expect((await chunkManifest(f.deps, 'cam3', 'ptz:2026-10-01')).rows).toBe(3);
  });

  it('summarize never lists ptz', () => {
    const f = withPositions();
    expect(Object.keys(summarize(f.deps, 'cam3'))).toEqual(['stills', 'clips', 'events', 'checks', 'archive']);
  });
});
