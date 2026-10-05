import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS } from '../src/catalog/migrations';
import { openCatalog } from '../src/catalog/db';
import { addRecoveredEvents, closeEvent, insertEvent, listEvents } from '../src/catalog/events';
import { analysisImages, listUnmapped, usageBetween } from '../src/catalog/analyses';
import { insertClip, lastClipReceived } from '../src/catalog/clips';
import { checkAt, checkById, checkImages, checksInRange, deleteChecksBefore, insertCheck, linkedEvents, setCheckImage, type StillCheckInput } from '../src/catalog/still-checks';

const fresh = () => openCatalog(join(mkdtempSync(join(tmpdir(), 'camproxy-sc-')), 'catalog.sqlite'));
const person = [{ category: 'person', subtype: 'person', score: 0.84, box: { x0: 0.1, y0: 0.1, x1: 0.4, y1: 0.9 } }];
const input = (still_ts: number, over: Partial<StillCheckInput> = {}): StillCheckInput => ({
  cam: 'cam1', still_ts, provider: 'google-vision', requested_at: still_ts + 5000, requested_via: 'token', took_ms: 600,
  objects: '[{"name":"Person","score":0.84,"box":{"x0":0.1,"y0":0.1,"x1":0.4,"y1":0.9}}]', raw: '{"r":1}', summary: JSON.stringify(person), ...over,
});

describe('migration 7: still_checks', () => {
  // The Pi runs catalog version 6 (v2026.10.04.1): built here from migrations
  // 1-6 as released, filled the way the Pi's is, then opened by this code.
  it("migrates a version 6 catalog in the Pi's shape, every row intact", () => {
    const path = join(mkdtempSync(join(tmpdir(), 'camproxy-v6-')), 'catalog.sqlite');
    const raw = new DatabaseSync(path);
    raw.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    raw.exec('CREATE TABLE schema_version (version INTEGER NOT NULL)');
    MIGRATIONS.slice(0, 6).forEach((sql, i) => {
      raw.exec(sql);
      raw.prepare('INSERT INTO schema_version (version) VALUES (?)').run(i + 1);
    });
    raw.exec(`
      INSERT INTO events (cam, source, kind, start_ts, end_ts, end_reason, raw) VALUES
        ('cam1', 'onvif', 'person', 1000000, 1020000, 'state', '{"topic":"x"}'),
        ('cam1', 'poll', 'motion', 1000500, NULL, NULL, NULL),
        ('cam1', 'recovered', 'person', 900000, 910000, 'recovered', '{"runId":"r"}');
      INSERT INTO analyses (event_id, provider, status, reason, still_ts, image, requested_at, took_ms, objects, raw, summary) VALUES
        (1, 'google-vision', 'ok', NULL, 1001000, '/data/analytics/cam1/1.jpg', 1002000, 597, '[]', '{}', '[]');
      INSERT INTO analytics_usage (provider, day, calls) VALUES ('google-vision', '2026-10-04', 14);
      INSERT INTO analytics_unmapped (key, mid, name, count, last_seen) VALUES ('/m/fan', '/m/fan', 'Ceiling fan', 3, 1000);
      INSERT INTO clips (cam, start_ts, end_ts, path, stream, size, received_at, snapshot, origin) VALUES
        ('cam1', 1000000, 1030000, 'a.mp4', 'sub', 10, 1031000, 'a.jpg', 'ftp'),
        ('cam1', 2000000, 2030000, 'b.mp4', 'sub', 10, 2031000, NULL, 'camera');
      INSERT INTO stream_log (ts, cam, type, data) VALUES (1000000, 'cam1', 'camera-event', '{}');
    `);
    raw.close();

    const c = openCatalog(path);
    expect(c.schemaVersion()).toBe(8);
    expect(listEvents(c, { cam: 'cam1' }).map((e) => e.source).sort()).toEqual(['onvif', 'poll', 'recovered']);
    expect([...analysisImages(c)]).toEqual(['/data/analytics/cam1/1.jpg']);
    expect(usageBetween(c, 'google-vision', '2026-10-01', '2026-10-31')).toBe(14);
    expect(listUnmapped(c)).toHaveLength(1);
    expect(lastClipReceived(c, 'cam1')).toBe(1031000); // the camera's clip is no arrival
    insertClip(c, { cam: 'cam1', start_ts: 3, end_ts: 4, path: 'c.mp4', stream: 'sub', size: 1, received_at: 3000000, snapshot: null });
    expect(lastClipReceived(c, 'cam1')).toBe(3000000); // the trigger still works
    expect((c.db.prepare('SELECT COUNT(*) AS n FROM stream_log').get() as { n: number }).n).toBe(1);
    // The new table: empty, indexed, one per camera, second and provider.
    expect(c.db.prepare('SELECT COUNT(*) AS n FROM still_checks').get()).toEqual({ n: 0 });
    expect(c.db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'still_checks' AND name = 'still_checks_cam_ts'").get()).toBeDefined();
    insertCheck(c, input(1001000));
    expect(() => insertCheck(c, input(1001000))).toThrow(/UNIQUE/);
    c.close();
    // Opening again runs nothing more.
    expect(openCatalog(path).schemaVersion()).toBe(8);
  });

  it('a fresh catalog is at version 8 (the archive, migration 8)', () => {
    expect(fresh().schemaVersion()).toBe(8);
  });
});

describe('still checks in the catalog', () => {
  it('stores a check, its image later, and finds it by id and by second', () => {
    const c = fresh();
    const r = insertCheck(c, input(5000));
    expect(r).toMatchObject({ id: 1, cam: 'cam1', still_ts: 5000, provider: 'google-vision', requested_via: 'token', took_ms: 600, image: null });
    setCheckImage(c, r.id, '/d/check-1.jpg');
    expect(checkById(c, r.id)?.image).toBe('/d/check-1.jpg');
    expect(checkAt(c, 'cam1', 5000)?.id).toBe(r.id);
    expect(checkAt(c, 'cam2', 5000)).toBeUndefined();
    expect(checkAt(c, 'cam1', 6000)).toBeUndefined();
    expect(checkById(c, 99)).toBeUndefined();
    expect([...checkImages(c)]).toEqual(['/d/check-1.jpg']);
  });

  it('lists a range oldest first, one camera, at most `limit` (1000 at most)', () => {
    const c = fresh();
    for (const ts of [3000, 1000, 2000]) insertCheck(c, input(ts));
    insertCheck(c, input(1500, { cam: 'cam2' }));
    expect(checksInRange(c, 'cam1', 1000, 2000).map((r) => r.still_ts)).toEqual([1000, 2000]);
    expect(checksInRange(c, 'cam1', 0, 9999, 2).map((r) => r.still_ts)).toEqual([1000, 2000]);
    expect(checksInRange(c, 'cam1', 0, 9999, 5000)).toHaveLength(3);
  });

  it('deletes checks older than a time and says how many', () => {
    const c = fresh();
    for (const ts of [1000, 2000, 3000]) insertCheck(c, input(ts));
    expect(deleteChecksBefore(c, 2500)).toBe(2);
    expect(checksInRange(c, 'cam1', 0, 9999).map((r) => r.still_ts)).toEqual([3000]);
  });
});

describe('the events a check sits in (computed on read)', () => {
  const MAX_OPEN = 10 * 60_000;
  it('open, ended, recovered, two kinds at once; motion is never confirmed', () => {
    const c = fresh();
    const p = insertEvent(c, { cam: 'cam1', source: 'onvif', kind: 'person', start_ts: 10_000, raw: null }); // open
    const m = insertEvent(c, { cam: 'cam1', source: 'poll', kind: 'motion', start_ts: 9_000, raw: null });
    closeEvent(c, m.id, 20_000, 'state');
    const before = insertEvent(c, { cam: 'cam1', source: 'onvif', kind: 'pet', start_ts: 1_000, raw: null });
    closeEvent(c, before.id, 5_000, 'state');
    insertEvent(c, { cam: 'cam2', source: 'onvif', kind: 'person', start_ts: 10_000, raw: null });
    expect(linkedEvents(c, 'cam1', 20_000, person, MAX_OPEN)).toEqual([
      { id: m.id, kind: 'motion', confirmed: false },
      { id: p.id, kind: 'person', confirmed: true },
    ]);
    // Past the open event's maxOpen: no longer in it.
    expect(linkedEvents(c, 'cam1', 10_000 + MAX_OPEN + 1, person, MAX_OPEN)).toEqual([]);
    // The end is inclusive, the pet event found nothing of its kind.
    expect(linkedEvents(c, 'cam1', 5_000, person, MAX_OPEN)).toEqual([{ id: before.id, kind: 'pet', confirmed: false }]);
    // A recovered event links like any other.
    const { added } = addRecoveredEvents(c, 'cam1', [{ kind: 'vehicle', start_ts: 100_000, end_ts: 110_000, raw: null }], { beforeMs: 0, afterMs: 0, openMs: MAX_OPEN });
    const car = [{ category: 'vehicle', subtype: 'car', score: 0.7, box: { x0: 0, y0: 0, x1: 1, y1: 1 } }];
    expect(linkedEvents(c, 'cam1', 105_000, car, MAX_OPEN)).toEqual([
      { id: p.id, kind: 'person', confirmed: false }, // still open (maxOpen), no person found
      { id: added[0].id, kind: 'vehicle', confirmed: true },
    ]);
  });
});
