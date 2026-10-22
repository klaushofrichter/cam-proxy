import { appendFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'fs';
import { dirname, join, sep } from 'path';
import type { Archive } from '../archive/service';
import { CAM_ID } from '../archive/paths';
import type { Catalog } from '../catalog/db';
import type { Storage } from '../storage';
import { allChunkParts } from './chunk-parts';
import { relOk, rowKey } from './import';
import { isMoveId, type MoveRecord } from './journal';
import type { MoveKind } from './types';
import { MOVE_KINDS } from './types';

// What a finished move deletes from the source (S §11): every row and file of
// one camera, nothing of another. Content folders count per kind (P6): stills =
// stills + previews, clips = clip files + snapshots, events = analysis images,
// checks = still-check images, archive = archive folders. The recordings cache
// goes too but is not counted, nor are the rows of stream_log, analytics_usage,
// clip_arrivals and annotations (rebuilt or not content, B49/X13).
export type Purged = Record<MoveKind, { files: number; bytes: number }>;
export interface PurgeDeps {
  catalog: Catalog;
  dataDir: string;
  storage: Pick<Storage, 'recount'>;
  archive: Pick<Archive, 'store'>;
}

const FOLDERS: Record<MoveKind, string[]> = { stills: ['stills', 'previews'], clips: ['clips'], events: ['analytics'], checks: ['still-checks'], archive: ['archive'] };
const UNCOUNTED_FOLDERS = ['recordings'];

// Files and bytes under a folder (links are not followed, counted as a file).
function measure(dir: string): { files: number; bytes: number } {
  const out = { files: 0, bytes: 0 };
  if (!existsSync(dir)) return out;
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else {
        out.files++;
        out.bytes += lstatSync(p).size;
      }
    }
  };
  walk(dir);
  return out;
}

// Idempotent: a camera already purged answers zeros. The rows go in one
// transaction (an event's analyses with it), then the folders, then the
// storage units are recounted.
export function purgeCamera(d: PurgeDeps, cam: string): { deleted: Purged } {
  if (!CAM_ID.test(cam)) throw new Error('purgeCamera: not a camera id');
  const deleted = Object.fromEntries(MOVE_KINDS.map((k) => [k, { files: 0, bytes: 0 }])) as Purged;
  for (const k of MOVE_KINDS) {
    for (const folder of FOLDERS[k]) {
      const m = measure(join(d.dataDir, folder, cam));
      deleted[k].files += m.files;
      deleted[k].bytes += m.bytes;
    }
  }
  const db = d.catalog.db;
  const archiveIds = (db.prepare('SELECT id FROM archive WHERE cam = ?').all(cam) as { id: number }[]).map((r) => r.id);
  db.exec('BEGIN');
  try {
    // analyses go with their event (ON DELETE CASCADE).
    for (const t of ['events', 'annotations', 'clips', 'still_checks', 'archive', 'stream_log', 'analytics_usage', 'clip_arrivals']) db.prepare(`DELETE FROM ${t} WHERE cam = ?`).run(cam);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  for (const id of archiveIds) d.archive.store.removeFolder({ cam, id });
  for (const folder of [...Object.values(FOLDERS).flat(), ...UNCOUNTED_FOLDERS]) rmSync(join(d.dataDir, folder, cam), { recursive: true, force: true });
  d.storage.recount();
  return { deleted };
}

// ---- What one move brought to the target (Task 10 fix round 1) ----
//
// A cancel with copied `delete` removes only what the move imported, never
// what the target captured itself after the switch-over: the rows of the
// journal's per-chunk import maps with their files (id-named images and
// Archive folders, clip files and snapshots), and the files the copier landed
// at their own paths (stills, previews, clips), which it lists one per line in
// <dataDir>/admin/moves/<moveId>.landed (600) right after each one is linked:
// never a file of that name the target had (the link refuses it). A file
// landed but not yet listed (a crash in between) stays and ages out.

const LANDED_FOLDERS = ['stills', 'previews', 'clips'];
const FOLDER_KIND: Record<string, MoveKind> = { stills: 'stills', previews: 'stills', clips: 'clips' };

export function landedLog(dataDir: string, moveId: string): string {
  if (!isMoveId(moveId)) throw new Error('invalid move id');
  return join(dataDir, 'admin', 'moves', `${moveId}.landed`);
}

export function noteLanded(dataDir: string, moveId: string, rel: string): void {
  const path = landedLog(dataDir, moveId);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  appendFileSync(path, `${rel}\n`, { mode: 0o600 });
}

export function landedFiles(dataDir: string, moveId: string): Set<string> {
  try {
    return new Set(readFileSync(landedLog(dataDir, moveId), 'utf8').split('\n').filter(Boolean));
  } catch {
    return new Set();
  }
}

export function removeLanded(dataDir: string, moveId: string): void {
  rmSync(landedLog(dataDir, moveId), { force: true });
}

// Rows by id from the import maps (the move's chunk parts, chunk-parts.ts),
// each only while its natural key still matches the one imported (an id the
// target's retention freed and SQLite gave to a row of its own is not the
// move's, final review 3); files of the camera only (never a path outside
// <dataDir>/<folder>/<cam>/). Idempotent; counts what it removed.
export function removeImported(d: { catalog: Catalog; dataDir: string; storage: Pick<Storage, 'recount'> }, r: MoveRecord): { deleted: Purged } {
  const cam = r.camera;
  if (!CAM_ID.test(cam)) throw new Error('removeImported: not a camera id');
  const deleted = Object.fromEntries(MOVE_KINDS.map((k) => [k, { files: 0, bytes: 0 }])) as Purged;
  const inside = (p: unknown, folder: string): p is string => typeof p === 'string' && p.startsWith(join(d.dataDir, folder, cam) + sep) && !p.split(sep).includes('..');
  const files = new Map<string, MoveKind>();
  for (const rel of landedFiles(d.dataDir, r.id)) if (relOk(cam, rel, LANDED_FOLDERS)) files.set(join(d.dataDir, ...rel.split('/')), FOLDER_KIND[rel.split('/')[0]]);
  const ids: Record<'events' | 'analyses' | 'clips' | 'still_checks' | 'archive', number[]> = { events: [], analyses: [], clips: [], still_checks: [], archive: [] };
  const db = d.catalog.db;
  const KEY_SQL: Record<keyof typeof ids, string> = {
    events: 'SELECT start_ts, source, kind FROM events WHERE id = ? AND cam = ?',
    analyses: 'SELECT a.event_id, a.provider FROM analyses a JOIN events e ON e.id = a.event_id WHERE a.id = ? AND e.cam = ?',
    clips: 'SELECT start_ts FROM clips WHERE id = ? AND cam = ?',
    still_checks: 'SELECT still_ts, provider FROM still_checks WHERE id = ? AND cam = ?',
    archive: 'SELECT created_at, name FROM archive WHERE id = ? AND cam = ?',
  };
  for (const part of allChunkParts(d.dataDir, r.id)) {
    for (const t of Object.keys(ids) as (keyof typeof ids)[]) {
      for (const pair of part.imported?.[t] ?? []) {
        const [, id, key] = pair;
        if (!Number.isSafeInteger(id) || typeof key !== 'string') continue;
        const now = db.prepare(KEY_SQL[t]).get(id, cam) as Record<string, unknown> | undefined;
        if (now && rowKey(t, now) === key) ids[t].push(id);
      }
    }
  }
  const pick = <T>(sql: string, id: number) => db.prepare(sql).get(id, cam) as T | undefined;
  const folders: string[] = [];
  // The files the rows name (an imported event's analyses go with it, cascade, and are imported too).
  for (const id of ids.clips) {
    const row = pick<{ path: string | null; snapshot: string | null }>('SELECT path, snapshot FROM clips WHERE id = ? AND cam = ?', id);
    for (const p of [row?.path, row?.snapshot]) if (inside(p, 'clips')) files.set(p, 'clips');
  }
  for (const id of ids.analyses) {
    const row = pick<{ image: string | null }>('SELECT a.image FROM analyses a JOIN events e ON e.id = a.event_id WHERE a.id = ? AND e.cam = ?', id);
    if (inside(row?.image, 'analytics')) files.set(row.image, 'events');
  }
  for (const id of ids.events) {
    for (const a of db.prepare('SELECT a.image FROM analyses a JOIN events e ON e.id = a.event_id WHERE e.id = ? AND e.cam = ?').all(id, cam) as { image: string | null }[]) if (inside(a.image, 'analytics')) files.set(a.image, 'events');
  }
  for (const id of ids.still_checks) {
    const row = pick<{ image: string | null }>('SELECT image FROM still_checks WHERE id = ? AND cam = ?', id);
    if (inside(row?.image, 'still-checks')) files.set(row.image, 'checks');
  }
  for (const id of ids.archive) if (pick('SELECT 1 AS x FROM archive WHERE id = ? AND cam = ?', id)) folders.push(join(d.dataDir, 'archive', cam, String(id)));
  db.exec('BEGIN');
  try {
    const del = (t: string, list: number[]) => {
      const st = db.prepare(`DELETE FROM ${t} WHERE id = ? AND cam = ?`);
      for (const id of list) st.run(id, cam);
    };
    const an = db.prepare('DELETE FROM analyses WHERE id = ? AND event_id IN (SELECT id FROM events WHERE cam = ?)');
    for (const id of ids.analyses) an.run(id, cam);
    del('events', ids.events);
    del('clips', ids.clips);
    del('still_checks', ids.still_checks);
    del('archive', ids.archive);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  for (const [p, kind] of files) {
    try {
      const st = lstatSync(p);
      if (!st.isFile()) continue;
      rmSync(p, { force: true });
      deleted[kind].files++;
      deleted[kind].bytes += st.size;
    } catch {
      /* gone already */
    }
  }
  for (const f of folders) {
    const m = measure(f);
    rmSync(f, { recursive: true, force: true });
    deleted.archive.files += m.files;
    deleted.archive.bytes += m.bytes;
  }
  d.storage.recount();
  return { deleted };
}
