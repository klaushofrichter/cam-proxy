// purgeCamera (camera-move plan Task 3, S §11): every row and folder of one
// camera goes, nothing of another; the counts are the five content kinds.
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it, vi } from 'vitest';
import { ArchiveStore } from '../src/archive/store';
import { openCatalog } from '../src/catalog/db';
import { MOVE_KINDS } from '../src/moves/types';
import { purgeCamera } from '../src/moves/purge';

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

describe('purgeCamera', () => {
  it('removes every row and folder of the camera and nothing of another camera', () => {
    const f = fixture();
    for (const t of TABLES) {
      expect(f.count(t, 'cam3'), `${t} cam3 before`).toBe(1);
      expect(f.count(t, 'cam4'), `${t} cam4 before`).toBe(1);
    }
    const r = purgeCamera({ catalog: f.catalog, dataDir: f.dataDir, storage: f.storage, archive: f.archive }, 'cam3');
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
    expect(f.storage.recount).toHaveBeenCalledTimes(1);
  });

  it('purging twice is a no-op', () => {
    const f = fixture();
    const deps = { catalog: f.catalog, dataDir: f.dataDir, storage: f.storage, archive: f.archive };
    purgeCamera(deps, 'cam3');
    const again = purgeCamera(deps, 'cam3');
    expect(again.deleted).toEqual({ stills: { files: 0, bytes: 0 }, clips: { files: 0, bytes: 0 }, events: { files: 0, bytes: 0 }, checks: { files: 0, bytes: 0 }, archive: { files: 0, bytes: 0 } });
    for (const t of TABLES) expect(f.count(t, 'cam4'), t).toBe(1);
  });

  it('refuses an id that is not a camera id (no path from a request value)', () => {
    const f = fixture();
    expect(() => purgeCamera({ catalog: f.catalog, dataDir: f.dataDir, storage: f.storage, archive: f.archive }, '../cam4')).toThrow(/camera id/);
    expect(existsSync(join(f.dataDir, 'stills', 'cam4'))).toBe(true);
  });
});
