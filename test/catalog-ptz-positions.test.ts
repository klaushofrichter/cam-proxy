import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { openCatalog, type Catalog } from '../src/catalog/db';
import { MIGRATIONS } from '../src/catalog/migrations';
import { deletePosition, insertPosition, listPositions, positionById, setHomePosition, setPositionOrder, updatePosition, type PtzPositionRow } from '../src/catalog/ptz-positions';

const fresh = (): Catalog => openCatalog(join(mkdtempSync(join(tmpdir(), 'camproxy-ptz-')), 'catalog.sqlite'));
const row = (id: string, o: Partial<PtzPositionRow> = {}): PtzPositionRow => ({ id, cam: 'e1', name: id, sort_order: 0, home: 0, slot: 0, preset_name: id, created_at: 1, updated_at: 1, ...o });

describe('ptz_positions (migration 10)', () => {
  it('migrates a version 9 catalog to 10 with ptz_positions', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'camproxy-ptz9-')), 'catalog.sqlite');
    const raw = new DatabaseSync(path);
    raw.exec('CREATE TABLE schema_version (version INTEGER NOT NULL)');
    MIGRATIONS.slice(0, 9).forEach((sql, i) => {
      raw.exec(sql);
      raw.prepare('INSERT INTO schema_version (version) VALUES (?)').run(i + 1);
    });
    raw.close();
    const c = openCatalog(path);
    expect(c.schemaVersion()).toBe(10);
    expect(c.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ptz_positions'").get()).toBeTruthy();
    expect(listPositions(c, 'e1')).toEqual([]);
    c.close();
  });

  it('the same slot twice for one camera is refused; another camera may use it', () => {
    const c = fresh();
    insertPosition(c, row('pos_a', { slot: 3 }));
    expect(() => insertPosition(c, row('pos_b', { slot: 3 }))).toThrow();
    insertPosition(c, row('pos_c', { cam: 'other', slot: 3 }));
    expect(listPositions(c, 'other').map((r) => r.id)).toEqual(['pos_c']);
    c.close();
  });

  it('list is by sort_order; delete renumbers 0..n-1', () => {
    const c = fresh();
    insertPosition(c, row('pos_c', { sort_order: 2, slot: 2 }));
    insertPosition(c, row('pos_a', { sort_order: 0, slot: 0, home: 1 }));
    insertPosition(c, row('pos_b', { sort_order: 1, slot: 1 }));
    insertPosition(c, row('pos_x', { cam: 'other', sort_order: 0, slot: 0 }));
    expect(listPositions(c, 'e1').map((r) => r.id)).toEqual(['pos_a', 'pos_b', 'pos_c']);
    deletePosition(c, 'e1', 'pos_b');
    expect(listPositions(c, 'e1').map((r) => [r.id, r.sort_order])).toEqual([['pos_a', 0], ['pos_c', 1]]);
    expect(positionById(c, 'e1', 'pos_b')).toBeUndefined();
    expect(positionById(c, 'other', 'pos_a')).toBeUndefined();
    expect(listPositions(c, 'other')).toHaveLength(1);
    c.close();
  });

  it('setHomePosition leaves exactly one home', () => {
    const c = fresh();
    insertPosition(c, row('pos_a', { sort_order: 0, slot: 0, home: 1 }));
    insertPosition(c, row('pos_b', { sort_order: 1, slot: 1 }));
    insertPosition(c, row('pos_x', { cam: 'other', slot: 0, home: 1 }));
    setHomePosition(c, 'e1', 'pos_b', 99);
    expect(listPositions(c, 'e1').map((r) => [r.id, r.home])).toEqual([['pos_a', 0], ['pos_b', 1]]);
    expect(positionById(c, 'e1', 'pos_b')!.updated_at).toBe(99);
    expect(positionById(c, 'other', 'pos_x')!.home).toBe(1);
    c.close();
  });

  it('setPositionOrder writes the given order', () => {
    const c = fresh();
    for (const [i, id] of ['pos_a', 'pos_b', 'pos_c'].entries()) insertPosition(c, row(id, { sort_order: i, slot: i }));
    setPositionOrder(c, 'e1', ['pos_c', 'pos_a', 'pos_b'], 5);
    expect(listPositions(c, 'e1').map((r) => [r.id, r.sort_order])).toEqual([['pos_c', 0], ['pos_a', 1], ['pos_b', 2]]);
    c.close();
  });

  it('updatePosition changes only the given fields', () => {
    const c = fresh();
    insertPosition(c, row('pos_a', { slot: 4 }));
    updatePosition(c, 'e1', 'pos_a', { name: 'Gate', updated_at: 7 });
    expect(positionById(c, 'e1', 'pos_a')).toMatchObject({ name: 'Gate', slot: 4, preset_name: 'pos_a', updated_at: 7 });
    updatePosition(c, 'e1', 'pos_a', { slot: 5, preset_name: 'Gate' });
    expect(positionById(c, 'e1', 'pos_a')).toMatchObject({ name: 'Gate', slot: 5, preset_name: 'Gate', updated_at: 7 });
    c.close();
  });
});
