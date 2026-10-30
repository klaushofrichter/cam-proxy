import type { Catalog } from './db';

// Saved PTZ positions (spec 2026-10-30-ptz-capabilities-design §6, migration
// 10). Per camera: sort_order is 0..n-1 without gaps, and exactly one row is
// Home while any exist (kept so by the positions service).
export interface PtzPositionRow {
  id: string; // pos_<16 hex>
  cam: string;
  name: string; // as the user wrote it (trimmed)
  sort_order: number;
  home: 0 | 1;
  slot: number; // the camera's preset slot, 0-63
  preset_name: string; // the name written to the camera at the last save
  created_at: number;
  updated_at: number;
}

// One transaction; ROLLBACK on a throw.
function tx(c: Catalog, fn: () => void): void {
  c.db.exec('BEGIN');
  try {
    fn();
    c.db.exec('COMMIT');
  } catch (err) {
    c.db.exec('ROLLBACK');
    throw err;
  }
}

export function listPositions(c: Catalog, cam: string): PtzPositionRow[] {
  return c.db.prepare('SELECT * FROM ptz_positions WHERE cam = ? ORDER BY sort_order, created_at').all(cam) as unknown as PtzPositionRow[];
}

export function positionById(c: Catalog, cam: string, id: string): PtzPositionRow | undefined {
  return c.db.prepare('SELECT * FROM ptz_positions WHERE cam = ? AND id = ?').get(cam, id) as unknown as PtzPositionRow | undefined;
}

// Throws on a slot this camera already uses (UNIQUE).
export function insertPosition(c: Catalog, r: PtzPositionRow): void {
  c.db
    .prepare('INSERT INTO ptz_positions (id, cam, name, sort_order, home, slot, preset_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(r.id, r.cam, r.name, r.sort_order, r.home, r.slot, r.preset_name, r.created_at, r.updated_at);
}

export function updatePosition(c: Catalog, cam: string, id: string, patch: Partial<Pick<PtzPositionRow, 'name' | 'slot' | 'preset_name' | 'updated_at'>>): void {
  const keys = (['name', 'slot', 'preset_name', 'updated_at'] as const).filter((k) => patch[k] !== undefined);
  if (keys.length === 0) return;
  c.db.prepare(`UPDATE ptz_positions SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE cam = ? AND id = ?`).run(...keys.map((k) => patch[k]!), cam, id);
}

export function setHomePosition(c: Catalog, cam: string, id: string, now: number): void {
  tx(c, () => {
    c.db.prepare('UPDATE ptz_positions SET home = 0 WHERE cam = ? AND home = 1 AND id != ?').run(cam, id);
    c.db.prepare('UPDATE ptz_positions SET home = 1, updated_at = ? WHERE cam = ? AND id = ?').run(now, cam, id);
  });
}

// `ids`: every id of this camera once, already checked by the caller.
export function setPositionOrder(c: Catalog, cam: string, ids: string[], now: number): void {
  tx(c, () => {
    const st = c.db.prepare('UPDATE ptz_positions SET sort_order = ?, updated_at = ? WHERE cam = ? AND id = ?');
    ids.forEach((id, i) => st.run(i, now, cam, id));
  });
}

// The rest keep their order, renumbered 0..n-1.
export function deletePosition(c: Catalog, cam: string, id: string): void {
  tx(c, () => {
    c.db.prepare('DELETE FROM ptz_positions WHERE cam = ? AND id = ?').run(cam, id);
    const st = c.db.prepare('UPDATE ptz_positions SET sort_order = ? WHERE cam = ? AND id = ?');
    listPositions(c, cam).forEach((r, i) => st.run(i, cam, r.id));
  });
}
