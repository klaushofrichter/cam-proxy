// The copier's catalog import on the target (camera-move plan Task 9, S §8.2;
// rulings B13, B23, B35): rows get the target's ids, links between rows are
// remapped, path columns become the target's absolute paths, files named by an
// id are renamed to the new id, rows whose files are not verified are left out,
// duplicates (P12 overlap) and rows imported before are skipped.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { beforeAll, describe, expect, it } from 'vitest';
import { openCatalog, type Catalog } from '../src/catalog/db';
import { importRows, landingPath, type ImportDeps } from '../src/moves/import';
import type { TableRows } from '../src/moves/inventory';
import { setLogLevel } from '../src/log';

beforeAll(() => setLogLevel('silent'));

const CAM = 'cam9';
const T = Date.UTC(2026, 9, 20, 12, 0);

function fixture(): ImportDeps & { put: (rel: string, content: string) => void } {
  const dataDir = mkdtempSync(join(tmpdir(), 'camproxy-import-'));
  const catalog: Catalog = openCatalog(join(dataDir, 'catalog.db'));
  const d = { catalog, dataDir, staging: join(dataDir, 'move-staging', 'mv_1') };
  const put = (rel: string, content: string) => {
    const p = landingPath(d, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  };
  return { ...d, put };
}

const event = (id: number, ts: number) => ({ id, cam: 'cam1', source: 'onvif', kind: 'person', start_ts: ts, end_ts: ts + 5000, end_reason: 'state', raw: null });
const analysis = (id: number, eventId: number, image: string | null) => ({ id, event_id: eventId, provider: 'google-vision', status: 'ok', reason: null, still_ts: T, image, requested_at: T, took_ms: 10, objects: '[]', raw: null, summary: '[]' });
const clip = (id: number, ts: number, path: string, snapshot: string | null) => ({ id, cam: 'cam1', start_ts: ts, end_ts: ts + 10_000, path, stream: 'sub', size: 4, received_at: ts + 11_000, snapshot, origin: 'ftp' });

describe('importRows', () => {
  it('analyses keep pointing at their events after import', () => {
    const f = fixture();
    // The target has events of its own: the imported ones get other ids.
    for (let i = 0; i < 7; i++) f.catalog.db.prepare("INSERT INTO events (cam, source, kind, start_ts) VALUES ('cam1', 'onvif', 'motion', ?)").run(T - 100_000 + i);
    f.put('analytics/cam9/50.jpg', 'image-50');
    f.put('analytics/cam9/51.jpg', 'image-51');
    const rows: TableRows[] = [
      { table: 'events', rows: [event(50, T), event(51, T + 60_000)] },
      { table: 'analyses', rows: [analysis(3, 50, 'analytics/cam9/50.jpg'), analysis(4, 51, 'analytics/cam9/51.jpg')] },
    ];
    const out = importRows(f, CAM, rows, new Set(['analytics/cam9/50.jpg', 'analytics/cam9/51.jpg']));
    expect(out).toMatchObject({ inserted: 4, skipped: 0 });
    const evs = f.catalog.db.prepare('SELECT * FROM events WHERE cam = ? ORDER BY start_ts').all(CAM) as { id: number; start_ts: number }[];
    expect(evs.map((e) => e.start_ts)).toEqual([T, T + 60_000]);
    expect(evs.every((e) => e.id > 7)).toBe(true);
    const an = f.catalog.db.prepare('SELECT * FROM analyses ORDER BY event_id').all() as { event_id: number; image: string }[];
    expect(an.map((a) => a.event_id)).toEqual(evs.map((e) => e.id));
    for (const [i, a] of an.entries()) {
      // Renamed to the new event id, an absolute path of the target.
      expect(a.image).toBe(join(f.dataDir, 'analytics', CAM, `${evs[i].id}.jpg`));
      expect(readFileSync(a.image, 'utf8')).toBe(`image-${50 + i}`);
    }
    // The staged copies are gone (renamed).
    expect(existsSync(landingPath(f, 'analytics/cam9/50.jpg'))).toBe(false);
    // The map for the journal: source id -> target id.
    expect(out.map.events).toEqual([[50, evs[0].id], [51, evs[1].id]]);
  });

  it('a clip row is not imported when its file failed', () => {
    const f = fixture();
    f.put('clips/cam9/2026/10/20/1200-1.mp4', 'clip');
    f.put('clips/cam9/2026/10/20/1200-1.jpg', 'snap');
    f.put('clips/cam9/2026/10/20/1201-1.mp4', 'bad!');
    f.put('clips/cam9/2026/10/20/1202-1.mp4', 'clip');
    const rows: TableRows[] = [{
      table: 'clips', rows: [
        clip(1, T, 'clips/cam9/2026/10/20/1200-1.mp4', 'clips/cam9/2026/10/20/1200-1.jpg'),
        clip(2, T + 60_000, 'clips/cam9/2026/10/20/1201-1.mp4', null),
        // Its snapshot failed: the clip comes without it.
        clip(3, T + 120_000, 'clips/cam9/2026/10/20/1202-1.mp4', 'clips/cam9/2026/10/20/1202-1.jpg'),
        // Expired on the source: no file in the manifest at all.
        clip(4, T + 180_000, 'clips/cam9/2026/10/20/1203-1.mp4', null),
      ],
    }];
    const verified = new Set(['clips/cam9/2026/10/20/1200-1.mp4', 'clips/cam9/2026/10/20/1200-1.jpg', 'clips/cam9/2026/10/20/1202-1.mp4']);
    const out = importRows(f, CAM, rows, verified);
    expect(out).toMatchObject({ inserted: 2, skipped: 2 });
    const got = f.catalog.db.prepare('SELECT cam, start_ts, path, snapshot FROM clips ORDER BY start_ts').all();
    expect(got).toEqual([
      { cam: CAM, start_ts: T, path: join(f.dataDir, 'clips/cam9/2026/10/20/1200-1.mp4'), snapshot: join(f.dataDir, 'clips/cam9/2026/10/20/1200-1.jpg') },
      { cam: CAM, start_ts: T + 120_000, path: join(f.dataDir, 'clips/cam9/2026/10/20/1202-1.mp4'), snapshot: null },
    ]);
  });

  it('skips duplicates: clips by camera and start, still checks by their unique key, rows imported before', () => {
    const f = fixture();
    // The target recorded this clip itself during the overlap (P12).
    f.catalog.db.prepare("INSERT INTO clips (cam, start_ts, path, stream, size, received_at) VALUES (?, ?, '/x/own.mp4', 'sub', 4, 1)").run(CAM, T);
    f.catalog.db.prepare("INSERT INTO still_checks (cam, still_ts, provider, requested_at, requested_via, objects, summary) VALUES (?, ?, 'google-vision', 1, 'token', '[]', '[]')").run(CAM, T);
    f.put('clips/cam9/2026/10/20/1200-1.mp4', 'clip');
    const rows: TableRows[] = [
      { table: 'clips', rows: [clip(1, T, 'clips/cam9/2026/10/20/1200-1.mp4', null)] },
      { table: 'still_checks', rows: [{ id: 8, cam: 'cam1', still_ts: T, provider: 'google-vision', requested_at: 1, requested_via: 'token', took_ms: 1, image: null, objects: '[]', raw: null, summary: '[]' }] },
    ];
    expect(importRows(f, CAM, rows, new Set(['clips/cam9/2026/10/20/1200-1.mp4']))).toMatchObject({ inserted: 0, skipped: 2 });
    expect((f.catalog.db.prepare('SELECT COUNT(*) AS n FROM clips').get() as { n: number }).n).toBe(1);

    // Imported once; a second import with the journal's map adds nothing.
    const g = fixture();
    g.put('analytics/cam9/50.jpg', 'image-50');
    const evRows: TableRows[] = [{ table: 'events', rows: [event(50, T)] }, { table: 'analyses', rows: [analysis(3, 50, 'analytics/cam9/50.jpg')] }];
    const first = importRows(g, CAM, evRows, new Set(['analytics/cam9/50.jpg']));
    expect(first.inserted).toBe(2);
    const again = importRows(g, CAM, evRows, new Set(['analytics/cam9/50.jpg']), first.map);
    expect(again).toMatchObject({ inserted: 0, skipped: 2 });
    expect((g.catalog.db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n).toBe(1);
    expect((g.catalog.db.prepare('SELECT COUNT(*) AS n FROM analyses').get() as { n: number }).n).toBe(1);
    // Without the map (a journal save lost after the commit) the natural keys still hold.
    expect(importRows(g, CAM, evRows, new Set())).toMatchObject({ inserted: 0 });
  });

  it('renames still-check images and Archive folders to the new ids', () => {
    const f = fixture();
    f.catalog.db.prepare("INSERT INTO still_checks (cam, still_ts, provider, requested_at, requested_via, objects, summary) VALUES ('cam1', 1, 'google-vision', 1, 'token', '[]', '[]')").run();
    f.put('still-checks/cam9/check-8.jpg', 'check-image');
    f.put('archive/cam9/5/clip.mp4', 'archived-clip');
    f.put('archive/cam9/5/thumb.jpg', 'thumb');
    f.put('archive/cam9/5/meta.json', '{"id":5}');
    const archive = { id: 5, cam: 'cam1', name: 'Fox', labels: '[]', retention_days: null, created_at: T, expires_at: null, recorded_from: T - 60_000, recorded_to: T, quality: 'original', original: 1, duration_s: 60, bytes: 13, files: '{}', source: '{"type":"clip"}', thumb_from: 'clip', thumb_at: null, created_by: 'admin', metadata: '{}' };
    const rows: TableRows[] = [
      { table: 'still_checks', rows: [{ id: 8, cam: 'cam1', still_ts: T, provider: 'google-vision', requested_at: 1, requested_via: 'token', took_ms: 1, image: 'still-checks/cam9/check-8.jpg', objects: '[]', raw: null, summary: '[]' }] },
      { table: 'archive', rows: [archive] },
    ];
    const out = importRows(f, CAM, rows, new Set(['still-checks/cam9/check-8.jpg', 'archive/cam9/5/clip.mp4', 'archive/cam9/5/thumb.jpg', 'archive/cam9/5/meta.json']));
    expect(out).toMatchObject({ inserted: 2, skipped: 0 });
    const chk = f.catalog.db.prepare('SELECT id, image FROM still_checks WHERE cam = ?').get(CAM) as { id: number; image: string };
    expect(chk.image).toBe(join(f.dataDir, 'still-checks', CAM, `check-${chk.id}.jpg`));
    expect(readFileSync(chk.image, 'utf8')).toBe('check-image');
    const arc = f.catalog.db.prepare('SELECT id FROM archive WHERE cam = ?').get(CAM) as { id: number };
    const folder = join(f.dataDir, 'archive', CAM, String(arc.id));
    expect(readFileSync(join(folder, 'clip.mp4'), 'utf8')).toBe('archived-clip');
    expect(readFileSync(join(folder, 'thumb.jpg'), 'utf8')).toBe('thumb');
    // meta.json describes the new row.
    expect(JSON.parse(readFileSync(join(folder, 'meta.json'), 'utf8')).item.id).toBe(arc.id);
  });

  it('never takes a path outside the camera folders', () => {
    const f = fixture();
    const rows: TableRows[] = [{ table: 'clips', rows: [clip(1, T, '../secret/x.mp4', null), clip(2, T + 1, 'clips/cam4/2026/10/20/1200-1.mp4', null)] }];
    expect(importRows(f, CAM, rows, new Set(['../secret/x.mp4', 'clips/cam4/2026/10/20/1200-1.mp4']))).toMatchObject({ inserted: 0, skipped: 2 });
  });
});
