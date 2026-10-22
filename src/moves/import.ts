import { existsSync, mkdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { metadataJson } from '../archive/json';
import { CAM_ID } from '../archive/paths';
import type { ArchiveRow } from '../catalog/archive';
import type { Catalog } from '../catalog/db';
import { CONTENT_FOLDERS, type TableRows } from './inventory';

// The catalog rows of one copied chunk on the target (camera-move plan Task 9,
// S §8.2; rulings B13, B23, B35). Rows get the target's ids; analyses follow
// their events through the old→new map; path columns (clips.path, .snapshot,
// analyses.image, still_checks.image) become the target's absolute paths;
// files named by a catalog id are renamed to the new id:
// analytics/<cam>/<eventId>.jpg, still-checks/<cam>/check-<id>.jpg,
// archive/<cam>/<id>/. Those (STAGED_FOLDERS) are copied to the move's staging
// folder under their source names, so a staged image never meets a target
// file of the same name and storage's sweep of unreferenced images never sees
// one; the import renames them in place. Clips and stills land at their own
// paths (not named by an id).
//
// A row is imported only when its main file is verified (a clip's file, an
// Archive item's clip.mp4); a snapshot or image that isn't goes as null.
// Duplicates are skipped (P12 overlap, a lost journal save): clips by
// (cam, start_ts), still checks by (cam, still_ts, provider), events by
// (cam, start_ts, source, kind), analyses by (event_id, provider), Archive
// items by (cam, created_at, name); rows in the journal's map of an earlier
// import of the chunk are skipped too. One transaction per chunk, a savepoint
// per row: a row that can't be stored is skipped (counted in `failed` and
// `skipped`); a failure of the whole import leaves no row and moves staged
// files back.

export const STAGED_FOLDERS: readonly string[] = ['analytics', 'still-checks', 'archive'];
const TABLES = ['events', 'analyses', 'clips', 'still_checks', 'archive'] as const;
type Table = (typeof TABLES)[number];
// Per table: [source id, target id, natural key] (kept per chunk beside the
// journal, chunk-parts.ts). The key is the row's duplicate key as stored here
// (clips: start_ts; events: start_ts|source|kind; analyses: event_id|provider;
// still_checks: still_ts|provider; archive: created_at|name): a delete-cancel
// removes a row only when its key still matches, never a row of the target's
// own that got a reused id (final review 3).
export type ImportMap = Partial<Record<Table, [number, number, string][]>>;

// The natural key of a row of the target's catalog (importKey's form).
export function rowKey(t: Table, row: Record<string, unknown>): string {
  if (t === 'clips') return String(row.start_ts);
  if (t === 'events') return `${row.start_ts}|${row.source}|${row.kind}`;
  if (t === 'analyses') return `${row.event_id}|${row.provider}`;
  if (t === 'still_checks') return `${row.still_ts}|${row.provider}`;
  return `${row.created_at}|${row.name}`;
}
export interface ImportDeps { catalog: Pick<Catalog, 'db'>; dataDir: string; staging: string }

const SEGMENT = /^[^\x00-\x1f\x7f\\/]{1,255}$/;

export function moveStagingDir(dataDir: string, moveId: string): string {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(moveId)) throw new Error('invalid move id');
  return join(dataDir, 'move-staging', moveId);
}

// A dataDir-relative posix path inside one of the camera's content folders
// (<folder>/<cam>/...), optionally of the given folders only.
export function relOk(cam: string, rel: unknown, folders: readonly string[] = CONTENT_FOLDERS): rel is string {
  if (typeof rel !== 'string' || rel.length > 1024 || !CAM_ID.test(cam)) return false;
  const parts = rel.split('/');
  return parts.length >= 3 && folders.includes(parts[0]) && parts[1] === cam && parts.every((s) => SEGMENT.test(s) && s !== '.' && s !== '..');
}

export const isStaged = (rel: string): boolean => STAGED_FOLDERS.includes(rel.split('/')[0]);

// Where a copied file lies until its rows are imported: the staging folder for
// id-named files, else its own path.
export function landingPath(d: Pick<ImportDeps, 'dataDir' | 'staging'>, rel: string): string {
  return isStaged(rel) ? join(d.staging, ...rel.split('/')) : join(d.dataDir, ...rel.split('/'));
}

const isValue = (v: unknown): v is string | number | null => v === null || typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v));
const posInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;

export function importRows(d: ImportDeps, cam: string, rows: TableRows[], verified: Set<string>, prev: ImportMap = {}): { inserted: number; skipped: number; failed: number; map: ImportMap } {
  const db = d.catalog.db;
  const columns = new Map<Table, string[]>(TABLES.map((t) => [t, (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name).filter((c) => c !== 'id')]));
  const map: Record<Table, Map<number, number>> = Object.fromEntries(TABLES.map((t) => [t, new Map((prev[t] ?? []).map(([s, n]) => [s, n]))])) as Record<Table, Map<number, number>>;
  const fresh: Record<Table, [number, number, string][]> = Object.fromEntries(TABLES.map((t) => [t, []])) as unknown as Record<Table, [number, number, string][]>;
  const moved: { from: string; to: string }[] = [];
  let inserted = 0;
  let skipped = 0;
  let failed = 0;

  // A verified file still at its landing place, or null.
  const usable = (rel: unknown, folders: readonly string[]): string | null => {
    if (!relOk(cam, rel, folders) || !verified.has(rel)) return null;
    const p = landingPath(d, rel);
    return existsSync(p) ? p : null;
  };
  // A staged file renamed to its final name (a stale file of no row there is replaced).
  const place = (from: string, to: string) => {
    mkdirSync(dirname(to), { recursive: true });
    if (existsSync(to)) unlinkSync(to);
    renameSync(from, to);
    moved.push({ from, to });
  };
  const insert = (t: Table, row: Record<string, unknown>, set: Record<string, string | number | null>): number | null => {
    const cols = columns.get(t)!.filter((c) => c in row || c in set);
    const vals = cols.map((c) => (c in set ? set[c] : row[c]));
    if (!vals.every(isValue)) return null;
    const r = db.prepare(`INSERT INTO ${t} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')}) RETURNING id`).get(...(vals as (string | number | null)[])) as { id: number };
    return r.id;
  };
  const one = <T>(sql: string, ...args: (string | number)[]) => db.prepare(sql).get(...args) as T | undefined;
  const referenced = (path: string) => !!one('SELECT 1 AS x FROM analyses WHERE image = ?', path) || !!one('SELECT 1 AS x FROM still_checks WHERE image = ?', path);

  const handle = (t: Table, row: Record<string, unknown>): number | null => {
    const src = row.id;
    if (!posInt(src)) return null;
    if (t === 'events') {
      if (typeof row.start_ts !== 'number' || typeof row.source !== 'string' || typeof row.kind !== 'string') return null;
      const dup = one<{ id: number }>('SELECT id FROM events WHERE cam = ? AND start_ts = ? AND source = ? AND kind = ?', cam, row.start_ts, row.source, row.kind);
      if (dup) return (map.events.set(src, dup.id), null);
      return insert(t, row, { cam });
    }
    if (t === 'analyses') {
      const ev = posInt(row.event_id) ? map.events.get(row.event_id) : undefined;
      if (ev === undefined || typeof row.provider !== 'string') return null;
      if (one('SELECT 1 AS x FROM analyses WHERE event_id = ? AND provider = ?', ev, row.provider)) return null;
      const image = usable(row.image, ['analytics']);
      const final = join(d.dataDir, 'analytics', cam, `${ev}.jpg`);
      const keep = image !== null && !referenced(final);
      const id = insert(t, row, { event_id: ev, image: keep ? final : null });
      if (id !== null && keep) place(image, final);
      return id;
    }
    if (t === 'clips') {
      if (typeof row.start_ts !== 'number' || one('SELECT 1 AS x FROM clips WHERE cam = ? AND start_ts = ?', cam, row.start_ts)) return null;
      const path = usable(row.path, ['clips']);
      if (!path) return null;
      return insert(t, row, { cam, path, snapshot: usable(row.snapshot, ['clips']) });
    }
    if (t === 'still_checks') {
      if (typeof row.still_ts !== 'number' || typeof row.provider !== 'string') return null;
      if (one('SELECT 1 AS x FROM still_checks WHERE cam = ? AND still_ts = ? AND provider = ?', cam, row.still_ts, row.provider)) return null;
      const image = usable(row.image, ['still-checks']);
      const id = insert(t, row, { cam, image: null });
      if (id !== null && image) {
        const final = join(d.dataDir, 'still-checks', cam, `check-${id}.jpg`);
        place(image, final);
        db.prepare('UPDATE still_checks SET image = ? WHERE id = ?').run(final, id);
      }
      return id;
    }
    // archive: its folder archive/<cam>/<id>/ (clip.mp4 required)
    if (typeof row.created_at !== 'number' || typeof row.name !== 'string') return null;
    if (one('SELECT 1 AS x FROM archive WHERE cam = ? AND created_at = ? AND name = ?', cam, row.created_at, row.name)) return null;
    const base = `archive/${cam}/${src}`;
    const clip = usable(`${base}/clip.mp4`, ['archive']);
    if (!clip) return null;
    const id = insert(t, row, { cam });
    if (id === null) return null;
    const folder = join(d.dataDir, 'archive', cam, String(id));
    rmSync(folder, { recursive: true, force: true }); // a leftover of an id rolled back before
    place(clip, join(folder, 'clip.mp4'));
    const thumb = usable(`${base}/thumb.jpg`, ['archive']);
    if (thumb) place(thumb, join(folder, 'thumb.jpg'));
    const created = db.prepare('SELECT * FROM archive WHERE id = ?').get(id) as unknown as ArchiveRow;
    writeFileSync(join(folder, 'meta.json'), JSON.stringify(metadataJson(created), null, 2));
    return id;
  };

  const undo = (from: number) => {
    for (const m of moved.splice(from).reverse()) {
      try {
        renameSync(m.to, m.from);
      } catch {
        /* left where it is: re-downloaded on the next try */
      }
    }
  };
  db.exec('BEGIN');
  try {
    for (const t of TABLES) {
      for (const tr of rows.filter((x) => x.table === t)) {
        for (const raw of tr.rows) {
          const row = raw as Record<string, unknown>;
          const src = row?.id;
          const known = posInt(src) && map[t].has(src);
          let id: number | null = null;
          if (!known && row && typeof row === 'object') {
            // One row at a time: a row that can't be stored is skipped, the others go on.
            const mark = moved.length;
            db.exec('SAVEPOINT move_row');
            try {
              id = handle(t, row);
              db.exec('RELEASE move_row');
            } catch {
              db.exec('ROLLBACK TO move_row');
              db.exec('RELEASE move_row');
              undo(mark);
              failed++;
              id = null;
            }
          }
          if (id === null) {
            skipped++;
            continue;
          }
          map[t].set(src as number, id);
          // The key as stored: an analysis names its event by the target's id.
          fresh[t].push([src as number, id, rowKey(t, t === 'analyses' ? { ...row, event_id: map.events.get(row.event_id as number) } : row)]);
          inserted++;
        }
      }
    }
    db.exec('COMMIT');
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* SQLite rolled back already (a failed COMMIT can) */
    }
    undo(0);
    throw err;
  }
  const out: ImportMap = {};
  for (const t of TABLES) {
    const all = [...(prev[t] ?? []), ...fresh[t]];
    if (all.length) out[t] = all;
  }
  return { inserted, skipped, failed, map: out };
}
