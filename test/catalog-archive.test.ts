// The Archive's table (spec 2026-10-05-archive-design §1.1): migration 8 and the queries.
import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS } from '../src/catalog/migrations';
import { openCatalog } from '../src/catalog/db';
import { listEvents } from '../src/catalog/events';
import { analysisImages, usageBetween } from '../src/catalog/analyses';
import { checkImages } from '../src/catalog/still-checks';
import { insertClip, lastClipReceived } from '../src/catalog/clips';
import {
  archiveById, archiveByIds, archiveLabelCounts, archiveTotals, countExpiringBy, deleteArchive, expiredArchive, insertArchive, listArchive, updateArchive,
  type ArchiveInput,
} from '../src/catalog/archive';

const fresh = () => openCatalog(join(mkdtempSync(join(tmpdir(), 'camproxy-ar-')), 'catalog.sqlite'));
const DAY = 86_400_000;
const input = (over: Partial<ArchiveInput> = {}): ArchiveInput => ({
  cam: 'cam1', name: 'Fox', labels: ['Pet'], retention_days: 365, created_at: 1_000_000, recorded_from: 500_000, recorded_to: 530_000,
  quality: 'sd', original: 0, duration_s: 30, bytes: 1000, files: '{"clip":{"bytes":1000,"crc32":1},"thumb":null}', source: '{"type":"clip","clipId":1}',
  thumb_from: 'none', thumb_at: null, created_by: 'client', metadata: '{"schema":1}', ...over,
});

describe('migration 8: archive', () => {
  // The Pi runs catalog version 7 (v2026.10.04.x, still checks): built here
  // from migrations 1-7 as released, filled like the Pi's, then opened.
  it("migrates a version 7 catalog in the Pi's shape, every row intact", () => {
    const path = join(mkdtempSync(join(tmpdir(), 'camproxy-v7-')), 'catalog.sqlite');
    const raw = new DatabaseSync(path);
    raw.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    raw.exec('CREATE TABLE schema_version (version INTEGER NOT NULL)');
    MIGRATIONS.slice(0, 7).forEach((sql, i) => {
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
      INSERT INTO clips (cam, start_ts, end_ts, path, stream, size, received_at, snapshot, origin) VALUES
        ('cam1', 1000000, 1030000, 'a.mp4', 'main', 10, 1031000, 'a.jpg', 'ftp');
      INSERT INTO still_checks (cam, still_ts, provider, requested_at, requested_via, took_ms, image, objects, raw, summary) VALUES
        ('cam1', 1005000, 'google-vision', 1006000, 'token', 500, '/data/still-checks/cam1/check-1.jpg', '[]', NULL, '[]');
      INSERT INTO stream_log (ts, cam, type, data) VALUES (1000000, 'cam1', 'still-check', '{}');
    `);
    raw.close();

    const c = openCatalog(path);
    expect(c.schemaVersion()).toBe(8);
    expect(listEvents(c, { cam: 'cam1' })).toHaveLength(3);
    expect([...analysisImages(c)]).toEqual(['/data/analytics/cam1/1.jpg']);
    expect([...checkImages(c)]).toEqual(['/data/still-checks/cam1/check-1.jpg']);
    expect(usageBetween(c, 'google-vision', '2026-10-01', '2026-10-31')).toBe(14);
    expect(lastClipReceived(c, 'cam1')).toBe(1031000);
    insertClip(c, { cam: 'cam1', start_ts: 3, end_ts: 4, path: 'c.mp4', stream: 'sub', size: 1, received_at: 3000000, snapshot: null });
    expect(lastClipReceived(c, 'cam1')).toBe(3000000); // the trigger still works
    // The new table: empty, with its indexes.
    expect(c.db.prepare('SELECT COUNT(*) AS n FROM archive').get()).toEqual({ n: 0 });
    const idx = (c.db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'archive' ORDER BY name").all() as { name: string }[]).map((r) => r.name);
    expect(idx).toEqual(['archive_created', 'archive_expires']);
    expect(insertArchive(c, input()).id).toBe(1);
    c.close();
    expect(openCatalog(path).schemaVersion()).toBe(8);
  });

  it('ids are never reused (AUTOINCREMENT)', () => {
    const c = fresh();
    const a = insertArchive(c, input());
    const b = insertArchive(c, input());
    deleteArchive(c, b.id);
    expect(insertArchive(c, input()).id).toBe(b.id + 1);
    expect(a.id).toBe(1);
  });
});

describe('archive rows', () => {
  it('stores a row; expires_at is created_at + days, null for forever', () => {
    const c = fresh();
    const r = insertArchive(c, input({ retention_days: 2 }));
    expect(r).toMatchObject({ id: 1, cam: 'cam1', name: 'Fox', labels: '["Pet"]', retention_days: 2, expires_at: 1_000_000 + 2 * DAY, original: 0 });
    expect(insertArchive(c, input({ retention_days: null })).expires_at).toBeNull();
    expect(archiveById(c, 1)?.name).toBe('Fox');
    expect(archiveById(c, 99)).toBeUndefined();
    expect(archiveByIds(c, [2, 1, 7]).map((x) => x.id)).toEqual([1, 2]);
  });

  it('updates name, labels and retention (expires_at follows), and deletes', () => {
    const c = fresh();
    insertArchive(c, input());
    expect(updateArchive(c, 1, { name: 'Cat', labels: ['Pet', 'Garden'], retention_days: 10 })).toMatchObject({ name: 'Cat', labels: '["Pet","Garden"]', retention_days: 10, expires_at: 1_000_000 + 10 * DAY });
    expect(updateArchive(c, 1, { retention_days: null })?.expires_at).toBeNull();
    expect(updateArchive(c, 5, { name: 'x' })).toBeUndefined();
    expect(deleteArchive(c, 1)).toBe(true);
    expect(deleteArchive(c, 1)).toBe(false);
  });

  it('lists with filters, sorting and paging', () => {
    const c = fresh();
    insertArchive(c, input({ name: 'Fox at night', labels: ['Pet', 'SD'], created_at: 3000, recorded_from: 300, bytes: 30, retention_days: 1 }));
    insertArchive(c, input({ name: 'Delivery van', labels: ['Vehicle', '4K'], created_at: 1000, recorded_from: 100, bytes: 10, quality: '4k', retention_days: null }));
    insertArchive(c, input({ cam: 'cam2', name: 'fox again', labels: ['pet'], created_at: 2000, recorded_from: 200, bytes: 20, retention_days: 5 }));
    const ids = (q: Parameters<typeof listArchive>[1]) => listArchive(c, q).rows.map((r) => r.id);
    expect(ids({})).toEqual([1, 3, 2]); // created, newest first
    expect(listArchive(c, {}).total).toBe(3);
    expect(ids({ order: 'asc' })).toEqual([2, 3, 1]);
    expect(ids({ cam: 'cam2' })).toEqual([3]);
    expect(ids({ labels: ['PET'] })).toEqual([1, 3]); // case-insensitive
    expect(ids({ labels: ['pet', 'sd'] })).toEqual([1]); // all of them
    expect(ids({ q: 'FOX' })).toEqual([1, 3]);
    expect(ids({ q: '%' })).toEqual([]); // no wildcards
    expect(ids({ from: 150, to: 250 })).toEqual([3]);
    expect(ids({ quality: ['4k'] })).toEqual([2]);
    expect(ids({ sort: 'recorded', order: 'asc' })).toEqual([2, 3, 1]);
    expect(ids({ sort: 'name', order: 'asc' })).toEqual([2, 3, 1]); // case-insensitive: delivery, fox again, fox at night
    expect(ids({ sort: 'size' })).toEqual([1, 3, 2]);
    expect(ids({ sort: 'expires', order: 'asc' })).toEqual([1, 3, 2]); // forever last
    expect(ids({ sort: 'expires', order: 'desc' })).toEqual([2, 3, 1]); // forever first
    expect(ids({ sort: 'cam', order: 'asc' })).toEqual([1, 2, 3]); // cam1 (ties: recorded desc), cam2
    expect(ids({ sort: 'cam', order: 'desc' })).toEqual([3, 1, 2]);
    const page = listArchive(c, { limit: 1, offset: 1 });
    expect(page).toMatchObject({ total: 3 });
    expect(page.rows.map((r) => r.id)).toEqual([3]);
  });

  it('sorts by quality (resolution), duration and labels; ties by recorded time, then id', () => {
    const c = fresh();
    const add = (o: Partial<ArchiveInput>) => insertArchive(c, input(o)).id;
    const a = add({ quality: '4k', duration_s: 12, labels: ['Vehicle'], recorded_from: 100 });
    const b = add({ quality: 'sd', duration_s: 30, labels: [], recorded_from: 200 });
    const d = add({ quality: '360p', duration_s: 5, labels: ['garden', 'Pet'], recorded_from: 300 });
    const e = add({ quality: '1080p', duration_s: 30, labels: ['Person'], recorded_from: 400 });
    const f = add({ quality: '720p', duration_s: 30, labels: ['person'], recorded_from: 400 });
    const ids = (q: Parameters<typeof listArchive>[1]) => listArchive(c, q).rows.map((r) => r.id);
    expect(ids({ sort: 'quality', order: 'asc' })).toEqual([d, b, f, e, a]);
    expect(ids({ sort: 'quality', order: 'desc' })).toEqual([a, e, f, b, d]);
    // 30 s three times: recorded desc (400, 400, 200), then id desc for e and f.
    expect(ids({ sort: 'duration', order: 'desc' })).toEqual([f, e, b, a, d]);
    expect(ids({ sort: 'duration', order: 'asc' })).toEqual([d, a, f, e, b]);
    // First label alphabetically, case-insensitive: garden, person, person, vehicle; none last.
    expect(ids({ sort: 'labels', order: 'asc' })).toEqual([d, f, e, a, b]);
    expect(ids({ sort: 'labels', order: 'desc' })).toEqual([a, f, e, d, b]);
    // The default (created, all equal here): recorded desc, then id desc.
    expect(ids({})).toEqual([f, e, d, b, a]);
  });

  it('expiry, totals and label counts', () => {
    const c = fresh();
    insertArchive(c, input({ created_at: 0, retention_days: 1, bytes: 5 }));
    insertArchive(c, input({ created_at: 0, retention_days: 3, bytes: 7, labels: ['Person', 'garden'] }));
    insertArchive(c, input({ created_at: 10, retention_days: null, bytes: 11, labels: ['GARDEN'] }));
    expect(expiredArchive(c, DAY).map((r) => r.id)).toEqual([1]); // at the moment it expires
    expect(expiredArchive(c, DAY - 1)).toEqual([]);
    expect(countExpiringBy(c, 3 * DAY)).toBe(2);
    expect(archiveTotals(c)).toEqual({ count: 3, bytes: 23, forever: 1, oldest: 0, newest: 10 });
    expect(archiveTotals(fresh())).toEqual({ count: 0, bytes: 0, forever: 0, oldest: null, newest: null });
    // Case-insensitive, the most used spelling... the first one stored wins.
    expect(archiveLabelCounts(c)).toEqual(new Map([['Pet', 1], ['Person', 1], ['garden', 2]]));
  });
});
