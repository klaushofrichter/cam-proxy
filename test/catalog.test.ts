import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { openCatalog, type Catalog } from '../src/catalog/db';
import { insertEvent, closeEvent, openEvents, listEvents, deleteEventsBefore, closeAllOpen } from '../src/catalog/events';

let dir: string;
let c: Catalog;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'camproxy-catalog-'));
  c = openCatalog(join(dir, 'catalog.sqlite'));
});
afterEach(() => c.close());

const ev = (kind: string, start_ts: number, cam = 'cam1') => insertEvent(c, { cam, source: 'onvif', kind, start_ts, raw: { topic: kind } });

describe('catalog', () => {
  it('creates the schema once; opening again keeps data and version', () => {
    expect(c.schemaVersion()).toBe(2);
    ev('person', 1000);
    c.close();
    c = openCatalog(join(dir, 'catalog.sqlite'));
    expect(c.schemaVersion()).toBe(2);
    expect(listEvents(c, { cam: 'cam1' })).toHaveLength(1);
  });

  it('uses WAL and counts the WAL file in its size', () => {
    expect(c.db.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' });
    for (let i = 0; i < 50; i++) ev('motion', i);
    expect(c.sizeBytes()).toBeGreaterThan(4096);
  });

  it('opens, closes and lists events, newest first, with filters', () => {
    const a = ev('person', 1000);
    ev('vehicle', 2000);
    ev('person', 3000);
    ev('person', 3500, 'cam2');
    expect(a).toMatchObject({ id: 1, kind: 'person', start_ts: 1000, end_ts: null, end_reason: null, raw: { topic: 'person' } });
    expect(openEvents(c, 'cam1')).toHaveLength(3);
    expect(closeEvent(c, a.id, 1500, 'state')).toMatchObject({ end_ts: 1500, end_reason: 'state' });
    expect(openEvents(c, 'cam1').map((e) => e.id)).toEqual([2, 3]);
    expect(listEvents(c, { cam: 'cam1' }).map((e) => e.start_ts)).toEqual([3000, 2000, 1000]);
    expect(listEvents(c, { cam: 'cam1', kind: 'person' }).map((e) => e.start_ts)).toEqual([3000, 1000]);
    expect(listEvents(c, { cam: 'cam1', from: 1500, to: 2500 }).map((e) => e.start_ts)).toEqual([2000]);
    expect(listEvents(c, { cam: 'cam1', limit: 1 })).toHaveLength(1);
  });

  it('caps a list at 1000 rows', () => {
    const insert = c.db.prepare("INSERT INTO events (cam, source, kind, start_ts) VALUES ('cam1', 'onvif', 'motion', ?)");
    for (let i = 0; i < 1100; i++) insert.run(i);
    expect(listEvents(c, { cam: 'cam1', limit: 5000 })).toHaveLength(1000);
  });

  it('deletes events that started before a time', () => {
    ev('motion', 1000);
    ev('motion', 2000);
    expect(deleteEventsBefore(c, 1500)).toBe(1);
    expect(listEvents(c, { cam: 'cam1' }).map((e) => e.start_ts)).toEqual([2000]);
  });

  it('closes events left open by a previous run', () => {
    ev('person', 1000);
    ev('pet', 2000);
    expect(closeAllOpen(c, 'cam1', 5000, 'restart')).toHaveLength(2);
    expect(openEvents(c, 'cam1')).toHaveLength(0);
    expect(listEvents(c, { cam: 'cam1' })[0]).toMatchObject({ end_ts: 5000, end_reason: 'restart' });
  });
});
