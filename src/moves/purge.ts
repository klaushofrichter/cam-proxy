import { appendFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync } from 'fs';
import { dirname, join, resolve, sep } from 'path';
import { metadataJson, withMoveNote } from '../archive/json';
import type { ArchiveMoveNote } from '../archive/metadata';
import type { Archive } from '../archive/service';
import { CAM_ID } from '../archive/paths';
import { archiveById } from '../catalog/archive';
import type { Catalog } from '../catalog/db';
import { logger } from '../log';
import type { Storage } from '../storage';
import { allChunkParts } from './chunk-parts';
import { relOk, rowKey } from './import';
import { cameraItems, chunkDay, CONTENT_FOLDERS, listChunks, type ItemFilter } from './inventory';
import { isMoveId, type MoveRecord } from './journal';
import type { KeepList, MoveKind } from './types';
import { MOVE_KINDS } from './types';

// What a finished move deletes from the source (S §11; step 4 Task 6): every
// row and file of one camera, nothing of another, except what the receiving
// side reported to keep and every Archive item not shown copied. Content
// folders count per kind (P6): stills = stills + previews, clips = clip files
// + snapshots, events = analysis images, checks = still-check images, archive
// = archive folders. The recordings cache goes whole and is not counted, nor
// are the rows of stream_log, analytics_usage, clip_arrivals and annotations
// (rebuilt or not content, B49/X13).
export type Purged = Record<MoveKind, { files: number; bytes: number }>;
export interface PurgeDeps {
  catalog: Catalog;
  dataDir: string;
  storage: Pick<Storage, 'recount'>;
  archive: Pick<Archive, 'store'>;
}

const FOLDERS: Record<MoveKind, string[]> = { stills: ['stills', 'previews'], clips: ['clips'], events: ['analytics'], checks: ['still-checks'], archive: ['archive'] };
const UNCOUNTED_FOLDERS = ['recordings'];

// Regular files below a folder (links are not followed: removed, counted as a file).
function filesIn(dir: string): { path: string; bytes: number }[] {
  const out: { path: string; bytes: number }[] = [];
  if (!existsSync(dir)) return out;
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push({ path: p, bytes: lstatSync(p).size });
    }
  };
  walk(dir);
  return out;
}

// Empty folders below `dir` removed (bottom up), `dir` itself too when empty.
function pruneEmpty(dir: string): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) if (e.isDirectory()) pruneEmpty(join(dir, e.name));
  try {
    rmdirSync(dir);
  } catch {
    /* not empty */
  }
}

const zeros = (): Purged => Object.fromEntries(MOVE_KINDS.map((k) => [k, { files: 0, bytes: 0 }])) as Purged;

export interface PurgeExcept {
  // The receiver's keep list (chunk id -> paths | 'all'); null: no outcome
  // arrived (the target away at an ended-early move, ruling 5): every
  // Archive item stays, the rest goes.
  keep: KeepList | null;
  // The chunk ids the source listed for the move (its manifest).
  listed: Set<string>;
  // For the "Kept here" note of a kept Archive item.
  note: { moveId: string; to: { proxyId: string; name: string }; at: number };
  // Archive paths the receiver found still missing (reason `missing`).
  missing?: Iterable<string>;
  // The Archive chunks the receiver copied, as listed then: an Archive item
  // goes only when its chunk is listed, reported copied with exactly the
  // listing the source has now, and not kept.
  copied?: Record<string, { files: number; bytes: number; rows: number }>;
}

// The selective purge. Non-Archive: an item (a clip with its snapshot, an
// event with its analyses, a still check, a still pack) stays with its rows
// when its chunk is kept 'all' or a kept path is one of its files; any other
// kept path stays as a file. Archive: an item stays whole (row, folder, a
// "Kept here" note in its metadata and meta.json) unless it is shown copied
// (see `copied`) and not kept; reason `missing` when a missing path is one of
// its files, `failed` when the receiver copied its chunk but kept it,
// `not_copied` otherwise. Idempotent; a camera already purged answers zeros.
// The rows go in one transaction, then the files, then storage is recounted.
export function purgeExcept(d: PurgeDeps, cam: string, o: PurgeExcept): { deleted: Purged; kept: Purged } {
  if (!CAM_ID.test(cam)) throw new Error('purgeExcept: not a camera id');
  const deleted = zeros();
  const kept = zeros();
  // Item paths are resolved (inventory.ts); so are these.
  const root = resolve(d.dataDir);
  const abs = (rel: string) => join(root, ...rel.split('/'));
  const keepFiles = new Set<string>();
  for (const v of Object.values(o.keep ?? {})) if (Array.isArray(v)) for (const p of v) if (relOk(cam, p)) keepFiles.add(abs(p));
  const missing = new Set([...(o.missing ?? [])].filter((p) => relOk(cam, p, FOLDERS.archive)).map(abs));
  const keepIds: Record<'clips' | 'events' | 'still_checks' | 'archive', number[]> = { clips: [], events: [], still_checks: [], archive: [] };
  const notes: { id: number; reason: NonNullable<ArchiveMoveNote['reason']> }[] = [];
  // The source's Archive chunks as they are now (compared with `copied`).
  const now = new Map(listChunks(d, cam, ['archive']).map((c) => [c.id, c]));
  for (const kind of MOVE_KINDS) {
    for (const it of cameraItems(d, cam, kind)) {
      const id = `${kind}:${chunkDay(it.ts)}`;
      const entry = o.keep?.[id];
      let stays: boolean;
      if (kind === 'archive') {
        const c = now.get(id);
        const was = o.copied?.[id];
        const copied = !!c && !!was && was.files === c.files && was.bytes === c.bytes && was.rows === c.rows;
        const named = entry === 'all' || (Array.isArray(entry) && it.files.some((f) => keepFiles.has(f)));
        stays = o.keep === null || !o.listed.has(id) || !copied || named;
        const rowId = Number((it.rows[0]?.row as { id?: unknown } | undefined)?.id);
        if (stays && Number.isSafeInteger(rowId)) notes.push({ id: rowId, reason: it.files.some((f) => missing.has(f)) ? 'missing' : copied && named ? 'failed' : 'not_copied' });
      } else stays = entry === 'all' || (Array.isArray(entry) && it.files.some((f) => keepFiles.has(f)));
      if (!stays) continue;
      for (const f of it.files) keepFiles.add(f);
      for (const { table, row } of it.rows) {
        const rid = Number((row as { id?: unknown }).id);
        if (table in keepIds && Number.isSafeInteger(rid)) keepIds[table as keyof typeof keepIds].push(rid);
      }
    }
  }
  const db = d.catalog.db;
  db.exec('BEGIN');
  try {
    // analyses go with their event (ON DELETE CASCADE).
    for (const t of ['annotations', 'stream_log', 'analytics_usage', 'clip_arrivals']) db.prepare(`DELETE FROM ${t} WHERE cam = ?`).run(cam);
    for (const t of Object.keys(keepIds) as (keyof typeof keepIds)[]) {
      const keepSet = new Set(keepIds[t]);
      const st = db.prepare(`DELETE FROM ${t} WHERE id = ? AND cam = ?`);
      for (const r of db.prepare(`SELECT id FROM ${t} WHERE cam = ?`).all(cam) as { id: number }[]) if (!keepSet.has(r.id)) st.run(r.id, cam);
    }
    for (const n of notes) {
      const row = archiveById(d.catalog, n.id);
      if (!row || row.cam !== cam) continue;
      db.prepare('UPDATE archive SET metadata = ? WHERE id = ? AND cam = ?').run(withMoveNote(row.metadata, { moveId: o.note.moveId, to: { ...o.note.to }, at: o.note.at, kept: true, reason: n.reason }), n.id, cam);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  // meta.json of a kept item follows its row (the note in the file too).
  for (const n of notes) {
    const row = archiveById(d.catalog, n.id);
    if (!row || row.cam !== cam) continue;
    try {
      d.archive.store.writeMeta(row, JSON.stringify(metadataJson(row), null, 2));
    } catch (err) {
      logger.warn({ err: (err as Error).message, id: n.id }, 'archive_meta_write_failed');
    }
  }
  for (const kind of MOVE_KINDS) {
    for (const folder of FOLDERS[kind]) {
      const dir = join(root, folder, cam);
      for (const f of filesIn(dir)) {
        const tally = keepFiles.has(f.path) ? kept : deleted;
        tally[kind].files++;
        tally[kind].bytes += f.bytes;
        if (tally === deleted) rmSync(f.path, { force: true });
      }
      pruneEmpty(dir);
    }
  }
  for (const folder of UNCOUNTED_FOLDERS) rmSync(join(d.dataDir, folder, cam), { recursive: true, force: true });
  d.storage.recount();
  return { deleted, kept };
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
//
// An imported event that has an analysis made here (not in the import maps:
// asked for on this proxy after the switch-over) stays whole with its
// analyses (step 4 Task 11): deleting the event would take that analysis with
// it (ON DELETE CASCADE), and it exists nowhere else; the copy back leaves it
// out (an imported event is not this proxy's capture). It ages out with the
// retention here; `kept` counts its analysis images.
export function removeImported(d: { catalog: Pick<Catalog, 'db'>; dataDir: string; storage: Pick<Storage, 'recount'> }, r: MoveRecord): { deleted: Purged; kept: Purged } {
  const cam = r.camera;
  if (!CAM_ID.test(cam)) throw new Error('removeImported: not a camera id');
  const deleted = zeros();
  const kept = zeros();
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
  // An imported event with an analysis of this proxy's own: it stays, with every analysis of it.
  const importedAnalyses = new Set(ids.analyses);
  const keptEvents = new Set<number>();
  for (const id of ids.events) {
    const all = db.prepare('SELECT a.id, a.image FROM analyses a JOIN events e ON e.id = a.event_id WHERE e.id = ? AND e.cam = ?').all(id, cam) as { id: number; image: string | null }[];
    if (!all.some((a) => !importedAnalyses.has(a.id))) continue;
    keptEvents.add(id);
    for (const a of all) {
      importedAnalyses.delete(a.id);
      if (!inside(a.image, 'analytics')) continue;
      try {
        const st = lstatSync(a.image);
        if (st.isFile()) {
          kept.events.files++;
          kept.events.bytes += st.size;
        }
      } catch {
        /* gone */
      }
    }
  }
  ids.events = ids.events.filter((id) => !keptEvents.has(id));
  ids.analyses = ids.analyses.filter((id) => importedAnalyses.has(id));
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
    const m = filesIn(f);
    rmSync(f, { recursive: true, force: true });
    deleted.archive.files += m.length;
    deleted.archive.bytes += m.reduce((n, x) => n + x.bytes, 0);
  }
  d.storage.recount();
  return { deleted, kept };
}

// ---- What a finished copy back deletes on the new proxy (step 4 Task 11) ----
//
// The return's items (the camera's content this proxy captured itself, as
// `filter` picks it: captured.ts capturedFilter, by natural key and the
// cancel's high water, never by camera id alone) of the chunks the return
// listed (`r.manifest`) and the original fetched (`r.served`, the chunk
// listings served to it), minus what the original reported to keep (`r.keep`,
// the outcome route). Never without that report: a return whose original
// never reported (no keep list) deletes none of them, everything is `kept`.
// An item stays whole (rows and files) when its chunk is kept 'all' or a kept
// path is one of its files; an Archive item also unless the original reported
// its chunk copied with exactly the listing this proxy serves now (as
// purgeExcept: Archive is never deleted un-copied); an event also when it has
// an analysis the return did not list (asked for after the cancel: the cascade
// would take it). Rows go by id and camera in one transaction, then the files;
// storage recounted. Idempotent (a deleted item is no longer listed).
export function removeReturned(d: { catalog: Pick<Catalog, 'db'>; dataDir: string; storage: Pick<Storage, 'recount'> }, r: MoveRecord, filter: ItemFilter): { deleted: Purged; kept: Purged } {
  const cam = r.camera;
  if (!CAM_ID.test(cam)) throw new Error('removeReturned: not a camera id');
  const deleted = zeros();
  const kept = zeros();
  const root = resolve(d.dataDir);
  const abs = (rel: string) => join(root, ...rel.split('/'));
  const keepFiles = new Set<string>();
  for (const v of Object.values(r.keep ?? {})) if (Array.isArray(v)) for (const p of v) if (relOk(cam, p)) keepFiles.add(abs(p));
  const listed = new Set((r.manifest ?? []).map((c) => c.id));
  // Only chunks the original fetched (review M1): a report (or a forged one)
  // never deletes items of a chunk the original did not even list.
  const served = new Set(r.served ?? []);
  const nowArchive = new Map(listChunks(d, cam, ['archive'], filter).map((c) => [c.id, c]));
  const copiedSame = (id: string) => {
    const c = nowArchive.get(id);
    const was = r.keepCopied?.[id];
    return !!c && !!was && was.files === c.files && was.bytes === c.bytes && was.rows === c.rows;
  };
  const db = d.catalog.db;
  const rows: Record<'clips' | 'events' | 'analyses' | 'still_checks' | 'archive', number[]> = { clips: [], events: [], analyses: [], still_checks: [], archive: [] };
  const files: { path: string; kind: MoveKind }[] = [];
  const folders: string[] = [];
  const tally = (t: Purged, kind: MoveKind, path: string) => {
    try {
      const st = lstatSync(path);
      if (!st.isFile()) return false;
      t[kind].files++;
      t[kind].bytes += st.size;
      return true;
    } catch {
      return false;
    }
  };
  for (const kind of MOVE_KINDS) {
    for (const it of cameraItems(d, cam, kind, filter)) {
      const id = `${kind}:${chunkDay(it.ts)}`;
      const entry = r.keep?.[id];
      let stays = !r.keep || !listed.has(id) || !served.has(id) || entry === 'all' || (Array.isArray(entry) && it.files.some((f) => keepFiles.has(f)));
      if (!stays && kind === 'archive') stays = !copiedSame(id);
      if (!stays && kind === 'events') {
        const evId = Number((it.rows[0]?.row as { id?: unknown }).id);
        const listedAnalyses = new Set(it.rows.filter((x) => x.table === 'analyses').map((x) => Number((x.row as { id?: unknown }).id)));
        const all = db.prepare('SELECT a.id FROM analyses a JOIN events e ON e.id = a.event_id WHERE e.id = ? AND e.cam = ?').all(evId, cam) as { id: number }[];
        stays = all.some((a) => !listedAnalyses.has(a.id));
      }
      if (stays) {
        for (const f of it.files) tally(kept, kind, f);
        continue;
      }
      for (const { table, row } of it.rows) {
        const rid = Number((row as { id?: unknown }).id);
        if (table in rows && Number.isSafeInteger(rid)) rows[table as keyof typeof rows].push(rid);
      }
      if (kind === 'archive') {
        const rid = Number((it.rows[0]?.row as { id?: unknown }).id);
        if (Number.isSafeInteger(rid)) folders.push(join(root, 'archive', cam, String(rid)));
      }
      for (const f of it.files) files.push({ path: f, kind });
    }
  }
  db.exec('BEGIN');
  try {
    const an = db.prepare('DELETE FROM analyses WHERE id = ? AND event_id IN (SELECT id FROM events WHERE cam = ?)');
    for (const id of rows.analyses) an.run(id, cam);
    for (const t of ['events', 'clips', 'still_checks', 'archive'] as const) {
      const st = db.prepare(`DELETE FROM ${t} WHERE id = ? AND cam = ?`);
      for (const id of rows[t]) st.run(id, cam);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  for (const f of files) if (tally(deleted, f.kind, f.path)) rmSync(f.path, { force: true });
  for (const f of folders) rmSync(f, { recursive: true, force: true });
  for (const folder of CONTENT_FOLDERS) pruneEmpty(join(root, folder, cam));
  d.storage.recount();
  return { deleted, kept };
}
