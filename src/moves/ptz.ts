// A camera's PTZ positions in a move (spec 2026-10-30-ptz-capabilities-design
// §7): the `ptz` chunk has no files; its rows document carries the camera's
// ptz_positions rows without `cam`, and the target replaces that camera's rows
// with them.
import type { Catalog } from '../catalog/db';
import { listPositions, replaceCameraPositions, type PtzPositionRow } from '../catalog/ptz-positions';
import { POSITIONS_MAX } from '../camera/capabilities';
import { checkName } from '../ptz/positions';
import type { TableRows } from './inventory';

export type PtzWireRow = Omit<PtzPositionRow, 'cam'>;
export const PTZ_TABLE = 'ptz_positions';
const KEYS = ['id', 'name', 'sort_order', 'home', 'slot', 'preset_name', 'created_at', 'updated_at'];
const ID = /^pos_[0-9a-f]{16}$/;
const PRESET_NAME_BYTES = 31;

export const ptzWireRows = (rows: PtzPositionRow[]): PtzWireRow[] => rows.map(({ cam: _cam, ...r }) => r);

const nameOk = (x: unknown): boolean => {
  try {
    return checkName(x) === x;
  } catch {
    return false;
  }
};
const time = (x: unknown) => Number.isSafeInteger(x) && (x as number) >= 0;

// Why these rows can't be a camera's positions (the field that failed), or null.
export function ptzRowsProblem(rows: unknown): string | null {
  if (!Array.isArray(rows) || rows.length > POSITIONS_MAX) return 'rows';
  const ids = new Set<unknown>();
  const slots = new Set<unknown>();
  const orders = new Set<unknown>();
  let homes = 0;
  for (const [i, r] of rows.entries()) {
    const at = `rows.${i}`;
    if (typeof r !== 'object' || r === null || Array.isArray(r)) return at;
    const o = r as Record<string, unknown>;
    const keys = Object.keys(o);
    if (keys.length !== KEYS.length || !KEYS.every((k) => keys.includes(k))) return at;
    if (typeof o.id !== 'string' || !ID.test(o.id) || ids.has(o.id)) return `${at}.id`;
    if (!nameOk(o.name)) return `${at}.name`;
    if (!Number.isSafeInteger(o.sort_order) || (o.sort_order as number) < 0 || (o.sort_order as number) >= rows.length || orders.has(o.sort_order)) return `${at}.sort_order`;
    if (o.home !== 0 && o.home !== 1) return `${at}.home`;
    if (!Number.isSafeInteger(o.slot) || (o.slot as number) < 0 || (o.slot as number) > 63 || slots.has(o.slot)) return `${at}.slot`;
    if (typeof o.preset_name !== 'string' || o.preset_name === '' || Buffer.byteLength(o.preset_name) > PRESET_NAME_BYTES) return `${at}.preset_name`;
    if (!time(o.created_at)) return `${at}.created_at`;
    if (!time(o.updated_at)) return `${at}.updated_at`;
    ids.add(o.id);
    slots.add(o.slot);
    orders.add(o.sort_order);
    homes += o.home;
  }
  return rows.length > 0 && homes !== 1 ? 'rows.home' : null;
}

// The rows of the PTZ_TABLE entry (none: zero rows) become the camera's;
// other tables are ignored. The moved set wins: the camera's rows here are
// replaced by the imported ones, in their order. `since` (the move's start
// on this proxy): a position saved here since then (the camera already ran
// here after the switch-over) is kept after them, unless its slot or name
// clashes with an imported one or the 20 are full; older rows (a stay before
// an earlier move away) are dropped. Exactly one Home: the imported one, or
// without imported rows the first kept one. The caller holds the camera's
// positions lock (PtzPositions.locked) when the camera runs here.
export function importPtz(c: Pick<Catalog, 'db'>, cam: string, tables: TableRows[], since?: number): { inserted: number } {
  const rows = tables.find((t) => t.table === PTZ_TABLE)?.rows ?? [];
  const bad = ptzRowsProblem(rows);
  if (bad) throw new Error(`ptz rows: ${bad}`);
  const typed = rows as PtzWireRow[];
  const next: PtzPositionRow[] = [...typed].sort((a, b) => a.sort_order - b.sort_order).map((r) => ({ ...r, cam }));
  if (since !== undefined) {
    const slots = new Set(next.map((r) => r.slot));
    const names = new Set(next.map((r) => r.name.toLowerCase()));
    const ids = new Set(next.map((r) => r.id));
    for (const r of listPositions(c, cam)) {
      if (r.created_at < since || slots.has(r.slot) || names.has(r.name.toLowerCase()) || ids.has(r.id) || next.length >= POSITIONS_MAX) continue;
      next.push({ ...r, home: 0 });
      slots.add(r.slot);
      names.add(r.name.toLowerCase());
    }
  }
  const home = typed.length ? next.findIndex((r) => r.home === 1) : 0;
  replaceCameraPositions(c, cam, next.map((r, i) => ({ ...r, sort_order: i, home: i === home ? 1 : 0 })));
  return { inserted: typed.length };
}
