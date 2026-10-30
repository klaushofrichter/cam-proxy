import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { openCatalog, type Catalog } from '../src/catalog/db';
import { insertPosition, listPositions, type PtzPositionRow } from '../src/catalog/ptz-positions';
import { importPtz, PTZ_TABLE, ptzRowsProblem, ptzWireRows, type PtzWireRow } from '../src/moves/ptz';

const fresh = (): Catalog => openCatalog(join(mkdtempSync(join(tmpdir(), 'camproxy-mvptz-')), 'catalog.sqlite'));
const id = (n: number) => `pos_${n.toString(16).padStart(16, '0')}`;
const wire = (n: number, o: Partial<PtzWireRow> = {}): PtzWireRow => ({ id: id(n), name: `Spot ${n}`, sort_order: n, home: n === 0 ? 1 : 0, slot: n, preset_name: `spot${n}`, created_at: 1000, updated_at: 2000, ...o });
const set = (n: number) => Array.from({ length: n }, (_, i) => wire(i));

describe('PTZ positions on the move wire', () => {
  it('ptzWireRows drops cam', () => {
    const r: PtzPositionRow = { ...wire(0), cam: 'cam4' };
    expect(ptzWireRows([r])).toEqual([wire(0)]);
  });

  it('ptzRowsProblem accepts a valid set and []', () => {
    expect(ptzRowsProblem(set(3))).toBeNull();
    expect(ptzRowsProblem(set(20))).toBeNull();
    expect(ptzRowsProblem([])).toBeNull();
  });

  it.each<[string, unknown]>([
    ['not an array', { rows: [] }],
    ['21 rows', set(21)],
    ['a duplicate id', [wire(0), wire(1, { id: id(0) })]],
    ['a bad id', [wire(0, { id: 'pos_xyz' })]],
    ['a duplicate slot', [wire(0), wire(1, { slot: 0 })]],
    ['slot 64', [wire(0, { slot: 64 })]],
    ['two homes', [wire(0), wire(1, { home: 1 })]],
    ['no home', [wire(0, { home: 0 }), wire(1)]],
    ['sort_order [0, 2]', [wire(0), wire(1, { sort_order: 2 })]],
    ["a name 'a\\nb'", [wire(0, { name: 'a\nb' })]],
    ['a name with outer spaces', [wire(0, { name: ' a ' })]],
    ['a preset_name of 32 bytes', [wire(0, { preset_name: 'x'.repeat(32) })]],
    ['an empty preset_name', [wire(0, { preset_name: '' })]],
    ['an extra key cam', [{ ...wire(0), cam: 'cam4' }]],
    ['a missing updated_at', [(({ updated_at: _u, ...r }) => r)(wire(0))]],
    ['a negative created_at', [wire(0, { created_at: -1 })]],
  ])('ptzRowsProblem refuses %s', (_name, rows) => {
    expect(ptzRowsProblem(rows)).not.toBeNull();
  });

  it('importPtz replaces and returns inserted', () => {
    const c = fresh();
    insertPosition(c, { ...wire(9, { home: 1, sort_order: 0 }), cam: 'cam4' });
    insertPosition(c, { ...wire(9, { id: id(99), home: 1, sort_order: 0 }), cam: 'cam5' });
    expect(importPtz(c, 'cam4', [{ table: 'other', rows: [{}] }, { table: PTZ_TABLE, rows: set(2) }])).toEqual({ inserted: 2 });
    expect(listPositions(c, 'cam4')).toEqual(set(2).map((r) => ({ ...r, cam: 'cam4' })));
    expect(listPositions(c, 'cam5')).toHaveLength(1);
    expect(importPtz(c, 'cam4', [])).toEqual({ inserted: 0 });
    expect(listPositions(c, 'cam4')).toEqual([]);
    c.close();
  });

  it('importPtz with invalid rows throws and changes nothing', () => {
    const c = fresh();
    insertPosition(c, { ...wire(9, { home: 1, sort_order: 0 }), cam: 'cam4' });
    expect(() => importPtz(c, 'cam4', [{ table: PTZ_TABLE, rows: [wire(0), wire(1, { home: 1 })] }])).toThrow();
    expect(listPositions(c, 'cam4').map((r) => r.id)).toEqual([id(9)]);
    c.close();
  });
});

describe('importPtz with the move start (final review 2): the moved set wins, positions saved here since stay', () => {
  const START = 5000;
  const local = (n: number, o: Partial<PtzPositionRow> = {}): PtzPositionRow => ({ ...wire(n), id: id(100 + n), cam: 'cam4', name: `Here ${n}`, slot: 40 + n, preset_name: `here${n}`, created_at: START + 10, updated_at: START + 10, ...o });
  it('imported rows first in their order, then the rows saved here since the move began; one home (the imported one); stale rows dropped', () => {
    const c = fresh();
    insertPosition(c, local(0, { home: 1, sort_order: 0, created_at: 1, updated_at: 1, name: 'Stale' }));
    insertPosition(c, local(1, { home: 0, sort_order: 1 }));
    insertPosition(c, local(2, { home: 0, sort_order: 2, slot: 1, name: 'Slot clash' }));
    insertPosition(c, local(3, { home: 0, sort_order: 3, name: 'spot 0' }));
    expect(importPtz(c, 'cam4', [{ table: PTZ_TABLE, rows: set(2) }], START)).toEqual({ inserted: 2 });
    const rows = listPositions(c, 'cam4');
    expect(rows.map((r) => r.id)).toEqual([id(0), id(1), id(101)]);
    expect(rows.map((r) => r.sort_order)).toEqual([0, 1, 2]);
    expect(rows.filter((r) => r.home === 1).map((r) => r.id)).toEqual([id(0)]);
    c.close();
  });
  it('no imported rows: the rows saved here stay, with one home', () => {
    const c = fresh();
    insertPosition(c, local(1, { home: 0, sort_order: 0 }));
    insertPosition(c, local(2, { home: 0, sort_order: 1 }));
    importPtz(c, 'cam4', [], START);
    const rows = listPositions(c, 'cam4');
    expect(rows.map((r) => [r.id, r.sort_order, r.home])).toEqual([[id(101), 0, 1], [id(102), 1, 0]]);
    c.close();
  });
});
